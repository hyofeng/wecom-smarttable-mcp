import assert from 'node:assert/strict';
import { dataDir, documentUrl } from '../dist/local.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

process.umask(0o077);
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-codex-login.mjs <private-target.json>');
const target = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { url, fields } = target;
const doc = documentUrl(url);
const sheetId = target.sheet_id || doc.url.searchParams.get('tab');
if (typeof url !== 'string' || typeof sheetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sheetId)
  || !Array.isArray(fields) || fields.length === 0 || fields.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id))) {
  throw new Error('私有 target.json 必须提供 url、sheet_id（或 URL 的 tab）及非空 fields 数组；请从结构工具取得真实 ID。');
}
const root = process.cwd();
const dir = await mkdtemp(join(dataDir, 'codex-login-'));
await cp(join(dataDir, 'profile'), join(dir, 'profile'), { recursive: true, force: false });
const quote = JSON.stringify;
const configuration = `mcp_servers={wecom_smarttable={command=${quote(process.execPath)},args=[${quote(resolve('dist/server.js'))}],cwd=${quote(root)},tool_timeout_sec=1200,env={WECOM_MCP_DATA_DIR=${quote(dir)}}}}`;
const child = spawn('codex', ['-c', configuration, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume(); // 不把用户原生客户端的诊断日志写入项目报告。
const pending = new Map();
let nextId = 0;
let confirmations = 0;
let thread;
const lines = createInterface({ input: child.stdout });
const write = message => child.stdin.write(JSON.stringify(message) + '\n');
function request(method, params, timeout = 120000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
}
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'mcpServer/elicitation/request') {
    try {
      assert.equal(message.params.serverName, 'wecom_smarttable');
      assert.equal(message.params.mode, 'form');
      assert.deepEqual(Object.keys(message.params.requestedSchema.properties), ['confirm']);
      confirmations++;
      console.log(JSON.stringify({ native_codex_elicitation: true, mode: message.params.mode }));
      // 这是测试客户端对真实 Codex 表单事件的明确确认；没有替换网页响应。
      write({ id: message.id, result: { action: 'accept', content: { confirm: true } } });
    } catch { write({ id: message.id, result: { action: 'cancel' } }); }
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(new Error(`Codex RPC error: ${message.error.code}`)) : p.resolve(message.result);
  }
});
try {
  await request('initialize', { clientInfo: { name: 'wecom-native-verifier', version: '0.2.0' }, capabilities: { experimentalApi: true } });
  write({ method: 'initialized', params: {} });
  const started = await request('thread/start', { cwd: root, ephemeral: true });
  thread = started.thread.id;
  const args = { url, sheet_id: sheetId, page_size: 1, fields };
  const result = await request('mcpServer/tool/call', { threadId: thread, server: 'wecom_smarttable', tool: 'wecom_read_records', arguments: args }, 1200000);
  assert.ok(!result.isError, '登录恢复后的记录读取失败。');
  const data = result.structuredContent;
  assert.equal(data.document_id, doc.id);
  assert.equal(data.sheet_id, args.sheet_id);
  assert.equal(data.returned_count, 1);
  assert.deepEqual(data.columns.map(c => c.id).sort(), args.fields.toSorted());
  assert.equal(confirmations, 1);
  const next = await request('mcpServer/tool/call', { threadId: thread, server: 'wecom_smarttable', tool: 'wecom_read_records', arguments: args });
  assert.ok(!next.isError);
  assert.equal(confirmations, 1);
  const report = { native_codex_verified: true, confirmations, original_request_resumed: true, valid_session_no_prompt: true };
  await writeFile(join(dataDir, 'codex-login-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  if (thread) await request('thread/unsubscribe', { threadId: thread }, 10000).catch(() => {});
  child.stdin.end();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 10000))]);
  for (const p of pending.values()) clearTimeout(p.timer);
  lines.close();
  if (child.exitCode !== null) await rm(dir, { recursive: true, force: true });
}
