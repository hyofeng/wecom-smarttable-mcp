import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';
import { parseChunk, assetsFor, cellsFor, presentRecord } from '../dist/protocol.js';
import { documentUrl } from '../dist/local.js';
import { validatedDownloadUrl } from '../dist/download.js';
import { parseDrivePermission } from '../dist/wedrive.js';

const fixture = async name => JSON.parse(await readFile(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));

test('真实第一页保留字段、记录及每张图片的归属', async () => {
  const input = await fixture('images-first-page');
  const c = parseChunk(input.data, 'id_example_000004', 0, 30);
  assert.equal(c.total, 171);
  assert.equal(c.records.length, 31);
  assert.equal(c.schema.fields.length, 13);
  assert.equal(c.schema.fields.find(f => f.id === 'id_example_000024').type, 'IMAGE');
  const row = c.records.find(r => r.id === 'id_example_000071');
  const result = presentRecord(c, c.schema, row, '[redacted-document]', ['id_example_000024']);
  assert.deepEqual(Object.keys(result.fields), ['id_example_000024']);
  const image = result.fields.id_example_000024.assets[0];
  assert.equal(image.width, 113);
  assert.equal(image.height, 938);
  assert.equal(image.locator.record_id, 'id_example_000071');
  assert.equal(image.locator.field_id, 'id_example_000024');
  assert.equal(image.locator.chunk_start, 0);
  assert.equal(image.locator.chunk_size, 31);
  assert.equal('url' in image, false);
});

test('真实末页只含剩余的 16 条，不把 end_row_index 当作返回数量', async () => {
  const input = await fixture('images-last-page');
  const c = parseChunk(input.data, 'id_example_000004', 155, 185);
  assert.equal(c.records.length, 16);
  assert.equal(c.total, 171);
  assert.equal(c.schema, undefined);
});

test('缺失一条真实记录时拒绝成功，暴露遗漏', async () => {
  const input = await fixture('images-first-page');
  const text = input.data.initialAttributedText.text[0];
  const commands = JSON.parse(inflateSync(Buffer.from(text.smartsheet, 'base64')).toString());
  const delta = commands.flat().find(c => c.t === 3028).c.k2;
  delete delta.k1[Object.keys(delta.k1)[0]];
  text.smartsheet = deflateSync(Buffer.from(JSON.stringify(commands))).toString('base64');
  assert.throws(() => parseChunk(input.data, 'id_example_000004', 0, 30), e => e.code === 'INCOMPLETE_DATA');
});

test('真实微盘附件保留源类型、文件 ID、大小和扩展名', async () => {
  const input = await fixture('wedrive-attachment');
  const c = parseChunk(input.data, 'id_example_000270', 0, 199);
  assert.equal(c.records.length, 190);
  const row = c.records.find(r => r.id === 'id_example_000252');
  const [file] = assetsFor(cellsFor(row.raw).id_example_000030);
  assert.equal(file.kind, 'attachment');
  assert.equal(file.source, 'Wedrive');
  assert.equal(file.size, 1004934);
  assert.equal(file.extension, 'pdf');
  assert.equal(file.id, 'id_example_000006');
  assert.deepEqual(assetsFor({ k30: 1, k1: [{ k1: 'text', k2: file.url }] }), []);
});

test('未返回的图片单元格不会声明为空', async () => {
  const input = await fixture('images-first-page');
  const c = parseChunk(input.data, 'id_example_000004', 0, 30);
  const row = c.records.find(r => !cellsFor(r.raw).id_example_000024);
  assert.ok(row);
  assert.equal(presentRecord(c, c.schema, row, '[redacted-document]', ['id_example_000024']).fields.id_example_000024.status, 'not_returned');
});

test('真实 SS_File 附件引用保持不透明，不当作任意 URL 返回', async () => {
  const input = await fixture('wedrive-attachment');
  const c = parseChunk(input.data, 'id_example_000270', 0, 199);
  const row = c.records.find(r => r.id === 'id_example_000186');
  const files = assetsFor(cellsFor(row.raw).id_example_000030);
  assert.equal(files.length, 6);
  assert.ok(files.every(f => f.source === 'SS_File' && f.url.startsWith('*ss*')));
  assert.equal(files[0].size, 1595247);
  assert.equal(files[0].extension, 'pptx');
  const result = presentRecord(c, c.schema, row, '[redacted-document]', ['id_example_000030']);
  assert.equal(JSON.stringify(result).includes('*ss*'), false);
  assert.equal(result.fields.id_example_000030.assets.length, 6);
});

test('真实微盘拒绝页的 Boolean/Number 静态状态可解析', async () => {
  const html = await readFile(new URL('fixtures/wedrive-denied.html', import.meta.url), 'utf8');
  assert.deepEqual(parseDrivePermission(html), { has_login: true, apply_status: 0, err_code: 0 });
});

test('文档与下载地址精确校验，拒绝伪造域名、非 HTTPS、普通表格和任意附件地址', () => {
  for (const value of ['https://doc.weixin.qq.com.evil.example/smartsheet/x', 'https://doc.weixin.qq.com@evil.example/smartsheet/x', 'http://doc.weixin.qq.com/smartsheet/x']) {
    assert.throws(() => documentUrl(value), e => e.code === 'INVALID_URL');
  }
  assert.throws(() => documentUrl('https://doc.weixin.qq.com/sheet/x'), e => e.code === 'UNSUPPORTED_TYPE');
  for (const value of ['https://wdcdn.qpic.cn.evil.example/file', 'http://wdcdn.qpic.cn/file', 'https://localhost/file', 'file:///etc/passwd', 'https://wdcdn.qpic.cn:1234/file']) {
    assert.throws(() => validatedDownloadUrl(value), e => e.code === 'UNSAFE_DOWNLOAD_URL');
  }
  const firstParty = new URL('https://doc.weixin.qq.com/webdisk/download');
  firstParty.search = new URLSearchParams({ func: '10', doc_id: 'redacted', store_id: '*ss*[redacted]' }).toString();
  assert.throws(() => validatedDownloadUrl(firstParty.href), e => e.code === 'UNSAFE_DOWNLOAD_URL');
  assert.equal(validatedDownloadUrl(firstParty.href, true).hostname, 'doc.weixin.qq.com');
  firstParty.searchParams.append('func', '3');
  assert.throws(() => validatedDownloadUrl(firstParty.href, true), e => e.code === 'UNSAFE_DOWNLOAD_URL');
});
