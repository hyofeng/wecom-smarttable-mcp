import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { request } from 'playwright';
import { streamResponseToFile, downloadHeaders, acceptDownloadCookies } from '../dist/download.js';

// 本机真实 HTTP 字节流和真实 Cookie 上下文；不替换或模拟企业微信接口。
async function byteServer(t) {
  const small = Buffer.alloc(65536, 0x61);
  const sent = new Map();
  const server = createServer((req, res) => {
    if (req.url === '/small') { res.end(small); return; }
    if (req.url === '/declared') res.setHeader('Content-Length', '1048576');
    let count = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return;
      count += 4096;
      sent.set(req.url, count);
      res.write(Buffer.alloc(4096, 0x62));
      if (count >= 1048576) { clearInterval(timer); res.end(); }
    }, 4);
    res.on('close', () => clearInterval(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, small, sent };
}

test('真实网络流按字节写盘并计算哈希，文件权限为 600', async t => {
  const { url, small } = await byteServer(t);
  const dir = await mkdtemp(join(tmpdir(), 'wecom-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'download.bin');
  const result = await streamResponseToFile(await fetch(`${url}/small`), path);
  assert.deepEqual(await readFile(path), small);
  assert.equal(result.size, small.length);
  assert.equal(result.sha256, createHash('sha256').update(small).digest('hex'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('无 Content-Length 的真实分块响应超限时断开连接且删除部分文件', async t => {
  const { url, sent } = await byteServer(t);
  const dir = await mkdtemp(join(tmpdir(), 'wecom-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'download.bin');
  await assert.rejects(streamResponseToFile(await fetch(`${url}/chunked`), path, 12288), e => e.code === 'FILE_TOO_LARGE');
  await assert.rejects(stat(path), e => e.code === 'ENOENT');
  assert.ok(sent.get('/chunked') < 1048576);
});

test('声明长度超限时不创建文件并取消响应', async t => {
  const { url } = await byteServer(t);
  const dir = await mkdtemp(join(tmpdir(), 'wecom-declared-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'download.bin');
  await assert.rejects(streamResponseToFile(await fetch(`${url}/declared`), path, 12288), e => e.code === 'FILE_TOO_LARGE');
  await assert.rejects(stat(path), e => e.code === 'ENOENT');
});

test('取消真实下载会结束写入并删除部分文件', async t => {
  const { url } = await byteServer(t);
  const dir = await mkdtemp(join(tmpdir(), 'wecom-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'download.bin');
  const controller = new AbortController();
  const response = await fetch(`${url}/abort`, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(streamResponseToFile(response, path, 1048576, controller.signal), e => e.code === 'DOWNLOAD_FAILED'); }
  finally { clearTimeout(timer); }
  await assert.rejects(stat(path), e => e.code === 'ENOENT');
});

test('下载不能覆盖或删除已有文件', async t => {
  const { url } = await byteServer(t);
  const dir = await mkdtemp(join(tmpdir(), 'wecom-existing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'existing.bin');
  await writeFile(path, 'keep-existing-file');
  await assert.rejects(streamResponseToFile(await fetch(`${url}/small`), path), e => e.code === 'DOWNLOAD_FAILED');
  assert.equal(await readFile(path, 'utf8'), 'keep-existing-file');
});

test('真实 Playwright Cookie 选择保持域和路径隔离，CDN 不获得凭据', async () => {
  const context = await request.newContext();
  try {
    await context.addCookies([
      { name: 'doc_example', value: 'example-a', domain: 'doc.weixin.qq.com', path: '/', secure: true },
      { name: 'scoped_example', value: 'example-b', domain: 'doc.weixin.qq.com', path: '/webdisk', secure: true },
      { name: 'drive_example', value: 'example-c', domain: 'drive.weixin.qq.com', path: '/', secure: true },
    ]);
    const first = await downloadHeaders(context, new URL('https://doc.weixin.qq.com/webdisk/download'));
    assert.ok(first.get('Cookie').includes('doc_example=example-a'));
    assert.ok(first.get('Cookie').includes('scoped_example=example-b'));
    assert.ok(!first.get('Cookie').includes('drive_example'));
    const root = await downloadHeaders(context, new URL('https://doc.weixin.qq.com/diskagent/download'));
    assert.ok(!root.get('Cookie').includes('scoped_example'));
    for (const target of ['https://wdcdn.qpic.cn/file', 'https://doc.weixin.qq.com.evil.example/file', 'http://doc.weixin.qq.com/file']) {
      assert.equal((await downloadHeaders(context, new URL(target))).get('Cookie'), null);
    }
  } finally { await context.dispose(); }
});

test('Set-Cookie 经真实解析和上下文更新，拒绝越域并执行过期删除', async () => {
  const context = await request.newContext();
  const url = new URL('https://doc.weixin.qq.com/webdisk/download');
  try {
    const headers = new Headers();
    headers.append('Set-Cookie', 'download_example=example; Path=/; Secure; HttpOnly; SameSite=Strict');
    headers.append('Set-Cookie', 'foreign_example=example; Domain=evil.example; Path=/');
    await acceptDownloadCookies(context, url, headers);
    const cookies = await context.cookies(url.href);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, 'download_example');
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].sameSite, 'Strict');
    await acceptDownloadCookies(context, new URL('https://wdcdn.qpic.cn/file'), new Headers({ 'Set-Cookie': 'cdn_example=example; Path=/' }));
    assert.equal((await context.cookies()).length, 1);
    await acceptDownloadCookies(context, url, new Headers({ 'Set-Cookie': 'download_example=gone; Path=/; Max-Age=0' }));
    assert.equal((await context.cookies(url.href)).length, 0);
  } finally { await context.dispose(); }
});
