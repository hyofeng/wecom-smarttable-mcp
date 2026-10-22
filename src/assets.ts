import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sanitize from 'sanitize-filename';
import { fileTypeFromFile } from 'file-type';
import { imageSizeFromFile } from 'image-size/fromFile';
import { WecomClient } from './client.js';
import { WecomError } from './errors.js';
import { documentUrl, dataDir, privateDirectory } from './local.js';
import { assetsFor, cellsFor, type Asset, type Locator } from './protocol.js';
import { resolveWedrive } from './wedrive.js';
import { downloadToFile, MAX_DOWNLOAD_BYTES } from './download.js';

const INLINE_BYTES = 4 * 1024 * 1024;

async function freshAsset(client: WecomClient, input: string, locator: Locator): Promise<Asset> {
  const doc = documentUrl(input);
  if (doc.id !== locator.document_id) throw new WecomError('INVALID_ASSET_LOCATOR', '附件定位不属于此智能表格。');
  const chunk = await client.chunk(doc.id, locator.sheet_id, locator.chunk_start, locator.chunk_size);
  const record = chunk.records.find(r => r.id === locator.record_id);
  if (!record) throw new WecomError('STALE_ASSET_LOCATOR', '来源页已不包含该记录，请重新读取记录获取附件定位。');
  const field = cellsFor(record.raw)[locator.field_id];
  const asset = assetsFor(field).find(a => a.id === locator.asset_id);
  if (!asset) throw new WecomError('ASSET_NOT_FOUND', '这条记录的指定字段中已不存在该图片或附件。');
  return asset;
}

async function resolveAssetUrl(client: WecomClient, asset: Asset, locator: Locator): Promise<string> {
  if (asset.kind === 'image') return asset.url;
  if (asset.source === 'SS_File') {
    if (!asset.url.startsWith('*ss*')) throw new WecomError('PARSE_ERROR', '直接上传附件没有返回已验证的存储引用格式。');
    const url = new URL('https://doc.weixin.qq.com/webdisk/download');
    // 网页预览组件实际用于 SS_File 的只读下载请求；func 固定为 10。
    Object.entries({ func: '10', doc_id: locator.document_id, store_id: asset.url, name: asset.name }).forEach(([k, v]) => url.searchParams.set(k, v));
    return url.href;
  }
  if (asset.source === 'Wedrive') return resolveWedrive(client, asset);
  throw new WecomError('UNSUPPORTED_ATTACHMENT_SOURCE', '尚未验证该附件来源的原始下载方式。', { source: asset.source || 'unknown' });
}

export async function downloadAsset(client: WecomClient, input: string, locator: Locator, inlineImage: boolean, signal?: AbortSignal) {
  await client.checkSession();
  let asset = await freshAsset(client, input, locator);
  if (asset.size !== null && asset.size > MAX_DOWNLOAD_BYTES) throw new WecomError('FILE_TOO_LARGE', '文件超过 100 MiB 下载上限。');
  await privateDirectory();
  const parent = await privateDirectory(join(dataDir, 'downloads'));
  const dir = await mkdtemp(join(parent, 'asset-'));
  const temporary = join(dir, 'payload.part');
  try {
    let sourceUrl = await resolveAssetUrl(client, asset, locator);
    let download;
    try { download = await downloadToFile(client.context, sourceUrl, asset.source === 'SS_File', temporary, signal); }
    catch (error) {
      if (!(error instanceof WecomError) || error.code !== 'DOWNLOAD_EXPIRED') throw error;
      asset = await freshAsset(client, input, locator);
      sourceUrl = await resolveAssetUrl(client, asset, locator);
      download = await downloadToFile(client.context, sourceUrl, asset.source === 'SS_File', temporary, signal);
    }
    const detected = await fileTypeFromFile(temporary);
    const mimeType = detected?.mime || download.contentType;
    if (asset.kind === 'image' && !detected?.mime.startsWith('image/')) throw new WecomError('DOWNLOAD_FAILED', '图片字段返回的内容不是可识别的原始图片。');
    let dimensions;
    if (detected?.mime.startsWith('image/')) {
      try { dimensions = await imageSizeFromFile(temporary); }
      catch { throw new WecomError('IMAGE_METADATA_UNSUPPORTED', '无法在 512 KiB 文件头范围内确认图片尺寸，未作为原图交付。'); }
    }
    if ((asset.width && dimensions?.width !== asset.width) || (asset.height && dimensions?.height !== asset.height)) {
      throw new WecomError('IMAGE_NOT_ORIGINAL', '下载尺寸与字段中的原图尺寸不一致；未作为原图交付。', { expected_width: asset.width, expected_height: asset.height, actual_width: dimensions?.width, actual_height: dimensions?.height });
    }
    if (asset.size !== null && download.size !== asset.size) throw new WecomError('INCOMPLETE_DOWNLOAD', '下载文件大小与附件元数据不符。', { expected: asset.size, actual: download.size });
    const path = join(dir, sanitize(asset.name) || `file.${detected?.ext || 'bin'}`);
    await rename(temporary, path);
    const inline = inlineImage && download.size <= INLINE_BYTES && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType);
    const bytes = inline ? await readFile(path) : undefined;
    return { result: { locator, kind: asset.kind, name: asset.name, local_path: path, mime_type: mimeType, size_bytes: download.size,
      sha256: download.sha256, ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      ...(asset.kind === 'image' ? { original_dimensions_verified: Boolean(asset.width && asset.height) } : {}), inline_image: inline,
      ...(!inline && detected?.mime.startsWith('image/') ? { view_instruction: '确认需要查看后，使用本机图片工具打开 local_path。' } : {}) },
      image: bytes ? { type: 'image' as const, data: bytes.toString('base64'), mimeType } : undefined };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
