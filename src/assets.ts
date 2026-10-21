import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sanitize from 'sanitize-filename';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { WecomClient } from './client.js';
import { WecomError, requireData } from './errors.js';
import { documentUrl, dataDir, privateDirectory } from './local.js';
import { assetsFor, cellsFor, type Asset, type Locator } from './protocol.js';
import { resolveWedrive } from './wedrive.js';

const MAX_BYTES = 100 * 1024 * 1024;
const INLINE_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(['wdcdn.qpic.cn']);

export function validatedDownloadUrl(input: string, allowFirstParty = false) {
  let url: URL;
  try { url = new URL(input); } catch { throw new WecomError('UNSAFE_DOWNLOAD_URL', '文件地址无效。'); }
  const keys = [...url.searchParams.keys()];
  const singleKeys = new Set(keys).size === keys.length;
  const documentDownload = allowFirstParty && singleKeys && url.hostname === 'doc.weixin.qq.com' && (
    (url.pathname === '/webdisk/download' && url.searchParams.get('func') === '10'
      && Boolean(url.searchParams.get('doc_id')) && url.searchParams.get('store_id')?.startsWith('*ss*')
      && keys.every(k => ['func', 'doc_id', 'store_id', 'name'].includes(k))) ||
    (url.pathname === '/diskagent/download' && url.searchParams.get('scene') === 'web' && Boolean(url.searchParams.get('agent_code'))
      && keys.every(k => ['scene', 'agent_code'].includes(k))));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (!DOWNLOAD_HOSTS.has(url.hostname) && !documentDownload)) {
    throw new WecomError('UNSAFE_DOWNLOAD_URL', '文件或重定向目标不在已实测的 HTTPS 下载域名清单中。');
  }
  return url;
}

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

async function downloadBytes(client: WecomClient, input: string, allowFirstParty: boolean): Promise<{ bytes: Buffer; contentType: string }> {
  let url = validatedDownloadUrl(input, allowFirstParty);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.hostname === 'doc.weixin.qq.com') {
      let response;
      try { response = await client.context.get(url.href, { maxRedirects: 0 }); }
      catch { throw new WecomError('DOWNLOAD_FAILED', '鉴权附件下载连接失败或超时。'); }
      try {
        if (response.status() >= 300 && response.status() < 400) {
          const location = response.headers().location;
          requireData(location, '附件下载重定向缺少目标。');
          url = validatedDownloadUrl(new URL(location, url).href, allowFirstParty);
          continue;
        }
        if (response.status() === 401) throw new WecomError('AUTH_EXPIRED', '附件下载时登录态已过期，请重新登录。');
        if (response.status() === 403) throw new WecomError('ATTACHMENT_ACCESS_DENIED', '当前账号没有该附件的下载权限。');
        if (response.status() === 410) throw new WecomError('DOWNLOAD_EXPIRED', '附件下载链接已失效。');
        if (!response.ok()) throw new WecomError('DOWNLOAD_FAILED', '鉴权附件下载返回 HTTP 错误。', { http_status: response.status() });
        const contentType = (response.headers()['content-type'] || 'application/octet-stream').split(';')[0];
        if (contentType === 'text/html' || contentType === 'application/json') throw new WecomError('DOWNLOAD_FAILED', '附件下载返回了网页或业务错误响应，没有保存为原始文件。');
        if (Number(response.headers()['content-length'] || 0) > MAX_BYTES) throw new WecomError('FILE_TOO_LARGE', '文件超过第一版 100 MiB 下载上限。');
        const bytes = await response.body();
        if (bytes.length > MAX_BYTES) throw new WecomError('FILE_TOO_LARGE', '文件超过第一版 100 MiB 下载上限。');
        return { bytes, contentType };
      } finally { await response.dispose(); }
    }
    let response: Response;
    try { response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) }); }
    catch { throw new WecomError('DOWNLOAD_FAILED', '文件下载连接失败或超时。'); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new WecomError('DOWNLOAD_FAILED', '文件重定向缺少目标地址。');
      url = validatedDownloadUrl(new URL(location, url).href, allowFirstParty);
      continue;
    }
    if ([403, 410].includes(response.status)) { await response.body?.cancel(); throw new WecomError('DOWNLOAD_EXPIRED', '文件下载地址失效或被拒绝。'); }
    if (!response.ok) { await response.body?.cancel(); throw new WecomError('DOWNLOAD_FAILED', '文件下载返回 HTTP 错误。', { http_status: response.status }); }
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await response.body?.cancel(); throw new WecomError('FILE_TOO_LARGE', '文件超过第一版 100 MiB 下载上限。'); }
    const parts: Buffer[] = [];
    let size = 0;
    requireData(response.body, '下载响应没有正文。');
    for await (const part of response.body) {
      size += part.length;
      if (size > MAX_BYTES) { await response.body.cancel().catch(() => {}); throw new WecomError('FILE_TOO_LARGE', '文件超过第一版 100 MiB 下载上限。'); }
      parts.push(Buffer.from(part));
    }
    const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    if (contentType === 'text/html') throw new WecomError('DOWNLOAD_FAILED', '下载返回了登录页或预览网页，没有保存为文件。');
    return { bytes: Buffer.concat(parts), contentType };
  }
  throw new WecomError('DOWNLOAD_FAILED', '文件重定向次数过多。');
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

export async function downloadAsset(client: WecomClient, input: string, locator: Locator, inlineImage: boolean) {
  await client.checkSession();
  let asset = await freshAsset(client, input, locator);
  if (asset.size !== null && asset.size > MAX_BYTES) throw new WecomError('FILE_TOO_LARGE', '文件超过第一版 100 MiB 下载上限。');
  let sourceUrl = await resolveAssetUrl(client, asset, locator);
  let download;
  try { download = await downloadBytes(client, sourceUrl, asset.source === 'SS_File'); }
  catch (error) {
    if (!(error instanceof WecomError) || error.code !== 'DOWNLOAD_EXPIRED') throw error;
    asset = await freshAsset(client, input, locator);
    sourceUrl = await resolveAssetUrl(client, asset, locator);
    download = await downloadBytes(client, sourceUrl, asset.source === 'SS_File');
  }
  const { bytes, contentType } = download;
  const detected = await fileTypeFromBuffer(bytes);
  const mimeType = detected?.mime || contentType;
  if (asset.kind === 'image' && !detected?.mime.startsWith('image/')) throw new WecomError('DOWNLOAD_FAILED', '图片字段返回的内容不是可识别的原始图片。');
  const dimensions = detected?.mime.startsWith('image/') ? imageSize(bytes) : undefined;
  if ((asset.width && dimensions?.width !== asset.width) || (asset.height && dimensions?.height !== asset.height)) {
    throw new WecomError('IMAGE_NOT_ORIGINAL', '下载尺寸与字段中的原图尺寸不一致；未作为原图交付。', { expected_width: asset.width, expected_height: asset.height, actual_width: dimensions?.width, actual_height: dimensions?.height });
  }
  if (asset.size !== null && bytes.length !== asset.size) throw new WecomError('INCOMPLETE_DOWNLOAD', '下载文件大小与附件元数据不符。', { expected: asset.size, actual: bytes.length });
  const parent = await privateDirectory(join(dataDir, 'downloads'));
  const dir = await mkdtemp(join(parent, 'asset-'));
  const path = join(dir, sanitize(asset.name) || `file.${detected?.ext || 'bin'}`);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const inline = inlineImage && bytes.length <= INLINE_BYTES && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType);
  return { result: { locator, kind: asset.kind, name: asset.name, local_path: path, mime_type: mimeType, size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    ...(asset.kind === 'image' ? { original_dimensions_verified: Boolean(asset.width && asset.height) } : {}), inline_image: inline,
    ...(!inline && detected?.mime.startsWith('image/') ? { view_instruction: '使用 Codex 的 view_image 打开 local_path 查看原图。' } : {}) },
    image: inline ? { type: 'image' as const, data: bytes.toString('base64'), mimeType } : undefined };
}
