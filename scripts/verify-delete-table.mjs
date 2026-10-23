import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dataDir, statePath } from '../dist/local.js';

process.umask(0o077);
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node scripts/verify-delete-table.mjs <private-delete-config.json>');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.allow_test_delete !== true || typeof config.title !== 'string' || !config.title.startsWith('MCP 删除验收 ')) {
  throw new Error('Config requires allow_test_delete: true and an explicitly authorized title starting with MCP 删除验收 .');
}
if (config.check_only === true && !config.url) throw new Error('check_only requires an existing URL and never creates a test document.');
const reportPath = join(dirname(resolve(configPath)), `delete-table-report-${Date.now()}.json`);
const report = { status: 'running', url: config.url, checks: [] };
const client = new Client({ name: 'wecom-delete-table-verifier', version: '0.4.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env: { WECOM_MCP_DATA_DIR: dataDir }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', data => { stderr += data; });
const passed = check => { report.checks.push(check); console.log(JSON.stringify({ check, passed: true })); };
async function call(name, args, errorCode) {
  const result = await client.callTool({ name, arguments: args });
  if (errorCode) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error?.code, errorCode);
    return result.structuredContent;
  }
  if (result.isError || !result.structuredContent) {
    report.last_error = { tool: name, error: result.structuredContent?.error || { code: 'NO_STRUCTURED_RESULT' } };
    throw new Error('MCP_DELETE_CHECK_FAILED');
  }
  return result.structuredContent;
}

try {
  await client.connect(transport);
  if (!report.url) {
    const created = await call('wecom_create_table', { title: config.title });
    assert.equal(created.status, 'verified');
    report.url = created.url;
    passed('create_dedicated_delete_test_table');
  }
  const initial = config.check_only === true
    ? await call('wecom_delete_table', { url: report.url, check_only: true })
    : await call('wecom_table_structure', { url: report.url });
  assert.equal(initial.title, config.title);
  report.document_id = initial.document_id;
  const preserved = config.preserve_urls || [];
  for (const url of preserved) {
    const other = await call('wecom_table_structure', { url });
    assert.notEqual(other.document_id, report.document_id);
  }
  if (config.check_only !== true) {
    const active = await call('wecom_delete_table', { document_id: report.document_id, check_only: true });
    assert.equal(active.state, 'active');
    assert.equal(active.checked_only, true);
    passed('document_id_check_only_leaves_table_active');
    await call('wecom_delete_table', { url: report.url, document_id: 'id_example_different_document', check_only: false }, 'DOCUMENT_ID_MISMATCH');
    assert.equal((await call('wecom_table_structure', { url: report.url })).document_id, report.document_id);
    passed('mismatched_url_and_id_rejected_without_delete');

    // 本脚本唯一一次实际删除；失败或结果不确定时保存报告并退出，绝不重放。
    report.result = await call('wecom_delete_table', { url: report.url, document_id: report.document_id });
    assert.equal(report.result.status, 'verified');
    assert.equal(report.result.state, 'recycle_bin');
    assert.equal(report.result.permanent, false);
    assert.equal(report.result.recycle_verified, true);
    assert.equal(report.result.already_in_recycle_bin, false);
    passed('move_exact_document_to_recycle_bin');
  } else {
    assert.equal(initial.state, 'recycle_bin');
    report.result = initial;
    passed('verify_existing_deletion_without_submission');
  }
  const checked = await call('wecom_delete_table', { document_id: report.document_id, check_only: true });
  assert.equal(checked.state, 'recycle_bin');
  assert.equal(checked.checked_only, true);
  const repeated = await call('wecom_delete_table', { url: report.url, ...(config.check_only === true ? { check_only: true } : {}) });
  assert.equal(repeated.already_in_recycle_bin, true);
  passed('verify_recycle_status_and_avoid_repeat_submission');
  for (const url of preserved) await call('wecom_table_structure', { url });
  passed('retained_documents_remain_readable');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(!state.cookies.some(c => c.value.length >= 12 && (JSON.stringify(report) + stderr).includes(c.value)), 'credential leak');
  assert.equal(stderr, '');
  report.status = 'passed';
} catch {
  report.status = 'failed';
  console.error(JSON.stringify({ delete_table_verification: 'failed', code: report.last_error?.error?.code || 'ASSERTION_FAILED' }));
  process.exitCode = 1;
} finally {
  await client.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report_path: reportPath }));
}
