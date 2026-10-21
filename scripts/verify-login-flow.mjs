import assert from 'node:assert/strict';
import { dataDir, documentUrl } from '../dist/local.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { access, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

process.umask(0o077);
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-login-flow.mjs <private-target.json> [--browser]');
const target = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { url, fields } = target;
const doc = documentUrl(url);
const sheetId = target.sheet_id || doc.url.searchParams.get('tab');
if (process.argv.includes('--browser') && (typeof sheetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sheetId)
  || !Array.isArray(fields) || fields.length === 0 || fields.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)))) {
  throw new Error('私有 target.json 必须提供 url、sheet_id（或 URL 的 tab）及非空 fields 数组；请从结构工具取得真实 ID。');
}
const temporary = await mkdtemp(join(dataDir, 'login-flow-'));
const results = [];
async function open(dataDir, action, protocol = 'legacy') {
  let questions = 0;
  const client = new Client({ name: 'wecom-login-flow-verifier', version: '0.2.0' }, {
    capabilities: action ? { elicitation: { form: {} } } : {},
    versionNegotiation: { mode: protocol === 'legacy' ? 'legacy' : { pin: protocol } },
  });
  if (action) client.setRequestHandler('elicitation/create', async request => {
    questions++;
    assert.equal(request.params.mode, 'form');
    assert.deepEqual(Object.keys(request.params.requestedSchema.properties), ['confirm']);
    console.log(JSON.stringify({ elicitation: action, fields: ['confirm'] }));
    return action === 'confirm_false' ? { action: 'accept', content: { confirm: false } }
      : action === 'accept' ? { action: 'accept', content: { confirm: true } } : { action };
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')],
    env: { ...process.env, WECOM_MCP_DATA_DIR: dataDir }, stderr: 'pipe' }));
  return { client, questions: () => questions };
}
async function cancelled(action, protocol) {
  const dir = join(temporary, `${protocol}-${action}`);
  await mkdir(dir, { mode: 0o700 });
  const { client, questions } = await open(dir, action, protocol);
  try {
    const result = await client.callTool({ name: 'wecom_table_structure', arguments: { url } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'LOGIN_CANCELLED');
    assert.equal(questions(), 1);
    await assert.rejects(access(join(dir, 'profile')));
    results.push(`${protocol}:${action}`);
  } finally { await client.close(); }
}
try {
  for (const protocol of ['legacy', '2026-07-28']) {
    for (const action of ['decline', 'cancel', 'confirm_false']) await cancelled(action, protocol);
  }
  if (process.argv.includes('--browser')) {
    const dir = join(temporary, 'accepted');
    await mkdir(dir, { mode: 0o700 });
    // 复制本任务专用 profile，但不复制 state.json。真实浏览器恢复会话，原登录态不变。
    await cp(join(dataDir, 'profile'), join(dir, 'profile'), { recursive: true, force: false });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
    const { client, questions } = await open(dir, 'accept', '2026-07-28');
    try {
      const calls = await Promise.all([
        client.callTool({ name: 'wecom_table_structure', arguments: { url } }, { timeout: 1200000 }),
        client.callTool({ name: 'wecom_read_records', arguments: { url, sheet_id: sheetId, page_size: 1, fields } }, { timeout: 1200000 }),
      ]);
      assert.ok(calls.every(result => !result.isError), '登录恢复后的结构或记录读取失败。');
      assert.ok(calls[0].structuredContent.sheets.length > 0);
      assert.equal(calls[1].structuredContent.returned_count, 1);
      assert.deepEqual(calls[1].structuredContent.columns.map(c => c.id).sort(), fields.toSorted());
      assert.ok(questions() >= 1 && questions() <= 2);
      await access(join(dir, 'state.json'));
      const previous = questions();
      await client.callTool({ name: 'wecom_table_structure', arguments: { url } }, { timeout: 120000 });
      assert.equal(questions(), previous, 'valid session must not ask again');
      results.push('expired_session_browser_login', 'parallel_original_requests_resumed', 'valid_session_no_prompt');

      // 在隔离会话中取消一个正在启动的真实浏览器登录请求。
      await writeFile(join(dir, 'state.json'), JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
      const controller = new AbortController();
      const cancelled = client.callTool({ name: 'wecom_table_structure', arguments: { url } }, { signal: controller.signal, timeout: 120000 });
      const outcome = cancelled.then(() => false, () => true);
      const lock = join(dir, 'profile', 'SingletonLock');
      const deadline = Date.now() + 20000;
      while (!(await lstat(lock).then(() => true, () => false))) {
        if (Date.now() > deadline) throw new Error('real login browser did not start');
        await new Promise(r => setTimeout(r, 50));
      }
      controller.abort();
      assert.equal(await outcome, true);
      while (await lstat(lock).then(() => true, () => false)) {
        if (Date.now() > deadline) throw new Error('cancelled login browser did not close');
        await new Promise(r => setTimeout(r, 50));
      }
      results.push('request_cancel_closes_real_browser');
    } finally { await client.close(); }

    // 两个独立 MCP 进程不能同时占用同一专用 profile，应明确失败且可取消。
    const busy = join(temporary, 'busy');
    await mkdir(busy, { mode: 0o700 });
    const owner = await open(busy, 'accept');
    const second = await open(busy, 'accept');
    const controller = new AbortController();
    const ownerRequest = owner.client.callTool({ name: 'wecom_table_structure', arguments: { url } }, { signal: controller.signal, timeout: 120000 });
    const ownerResult = ownerRequest.then(() => false, () => true);
    try {
      const lock = join(busy, 'profile', 'SingletonLock');
      const deadline = Date.now() + 30000;
      while (!(await lstat(lock).then(() => true, () => false))) {
        if (Date.now() > deadline) throw new Error('login conflict browser did not start');
        await new Promise(r => setTimeout(r, 50));
      }
      const result = await second.client.callTool({ name: 'wecom_table_structure', arguments: { url } }, { timeout: 60000 });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'LOGIN_BROWSER_FAILED');
      results.push('occupied_profile_returns_controlled_error');
    } finally {
      controller.abort();
      await ownerResult;
      await Promise.all([owner.client.close(), second.client.close()]);
    }
  }
  await writeFile(join(dataDir, 'login-flow-report.json'), JSON.stringify({ verified: true, results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ verified: true, results }));
} finally { await rm(temporary, { recursive: true, force: true }); }
