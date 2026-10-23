import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dataDir, statePath } from '../dist/local.js';

process.umask(0o077);
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node scripts/verify-write.mjs <private-write-config.json>');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.allow_test_writes !== true || typeof config.title !== 'string' || !config.title.startsWith('MCP 写入验收 ')) {
  throw new Error('Config requires allow_test_writes: true and an explicitly authorized title starting with MCP 写入验收 .');
}
const reportPath = join(dirname(resolve(configPath)), `write-report-${Date.now()}.json`);
const report = { status: 'running', url: config.url, checks: [], fields: [], retained_records: [], removed_records: [] };
const client = new Client({ name: 'wecom-write-verifier', version: '0.4.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env: { WECOM_MCP_DATA_DIR: dataDir }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', data => { stderr += data; });
const passed = check => { report.checks.push(check); console.log(JSON.stringify({ check, passed: true })); };
async function call(name, args, errorCode) {
  const result = await client.callTool({ name, arguments: args });
  const data = result.structuredContent;
  if (errorCode) {
    assert.equal(result.isError, true);
    assert.equal(data?.error?.code, errorCode);
    return data;
  }
  if (result.isError || !data) {
    report.last_error = { tool: name, error: data?.error || { code: 'NO_STRUCTURED_RESULT' } };
    throw new Error('MCP_WRITE_CHECK_FAILED');
  }
  return data;
}
let sheetId, revision;
async function change(name, args) {
  const result = await call(name, { url: report.url, sheet_id: sheetId, expected_revision: revision, ...args });
  assert.equal(result.status, 'verified');
  assert.equal(result.previous_revision, revision);
  assert.equal(result.committed_revision, revision + 1);
  revision = result.revision;
  return result;
}
async function readAll(fields) {
  const records = new Map();
  let cursor;
  do {
    const page = await call('wecom_read_records', { url: report.url, sheet_id: sheetId, page_size: 200, ...(fields ? { fields } : {}), ...(cursor ? { cursor } : {}) });
    assert.equal(page.revision, revision);
    for (const row of page.records) { assert.ok(!records.has(row.id)); records.set(row.id, row); }
    cursor = page.next_cursor;
    if (!cursor) assert.equal(records.size, page.total_records);
  } while (cursor);
  return records;
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  for (const name of ['create_table', 'update_records', 'add_records', 'delete_records', 'add_fields', 'delete_fields']) {
    assert.equal(tools.find(t => t.name === `wecom_${name}`)?.annotations?.readOnlyHint, false);
  }
  let structure;
  if (report.url) structure = await call('wecom_table_structure', { url: report.url });
  else {
    const created = await call('wecom_create_table', { title: config.title });
    assert.equal(created.status, 'verified');
    report.url = created.url;
    structure = created;
    passed('create_table_and_read_back');
  }
  assert.equal(structure.title, config.title);
  const sheet = structure.sheets[0];
  assert.ok(sheet);
  sheetId = sheet.id;
  revision = sheet.revision;
  report.sheet_id = sheetId;
  report.initial_records = sheet.total_records_in_table;
  const types = ['TEXT', 'NUMBER', 'CHECKBOX', 'DATE_TIME', 'IMAGE', 'ATTACHMENT', 'USER', 'URL', 'MULTIPLE_SELECT', 'PROGRESS', 'PHONE', 'EMAIL', 'SINGLE_SELECT'];
  const suffix = Date.now().toString(36);
  const addedFields = await change('wecom_add_fields', { fields: types.map(type => ({ name: `MCP ${type} ${suffix}`, type,
    ...(['SINGLE_SELECT', 'MULTIPLE_SELECT'].includes(type) ? { options: ['待办', '完成'] } : {}) })) });
  report.fields = addedFields.fields;
  const field = type => addedFields.fields.find(f => f.type === type);
  passed('add_13_column_types_and_select_options');
  const source = { TEXT: 'MCP 新增验收', NUMBER: 12.5, CHECKBOX: true, DATE_TIME: Date.UTC(2026, 9, 23), PROGRESS: 0.5,
    PHONE: '13800000000', EMAIL: 'qa@example.com', SINGLE_SELECT: [field('SINGLE_SELECT').options[0].id],
    MULTIPLE_SELECT: field('MULTIPLE_SELECT').options.map(o => o.id) };
  const values = Object.fromEntries(Object.entries(source).map(([type, value]) => [field(type).id, value]));
  const added = await change('wecom_add_records', { records: [values, {}] });
  const [sample, blank] = added.record_ids;
  report.retained_records = added.record_ids;
  passed('add_typed_record_and_blank_record');

  await call('wecom_update_records', { url: report.url, sheet_id: sheetId, expected_revision: revision - 1,
    records: [{ record_id: sample, values: { [field('TEXT').id]: '不得写入的旧版本内容' } }] }, 'STALE_REVISION');
  const before = (await readAll([field('TEXT').id])).get(sample);
  assert.equal(before.fields[field('TEXT').id].text, source.TEXT);
  passed('stale_revision_rejected_without_write');

  await change('wecom_update_records', { records: [{ record_id: sample, values: {
    [field('TEXT').id]: 'MCP 修改验收', [field('NUMBER').id]: 0, [field('CHECKBOX').id]: false,
    [field('PROGRESS').id]: 0, [field('SINGLE_SELECT').id]: [field('SINGLE_SELECT').options[1].id],
  } }] });
  let records = await readAll();
  assert.equal(records.get(sample).fields[field('DATE_TIME').id].value, String(source.DATE_TIME));
  assert.equal(records.get(sample).fields[field('NUMBER').id].value, 0);
  assert.equal(records.get(sample).fields[field('CHECKBOX').id].value, false);
  passed('partial_update_preserves_other_values_and_zero_false');

  await change('wecom_update_records', { records: [{ record_id: sample, values: Object.fromEntries(Object.keys(values).map(id => [id, null])) }] });
  await change('wecom_update_records', { records: [{ record_id: sample, values }] });
  passed('clear_9_value_types_and_restore');

  const batches = [];
  for (let batch = 0; batch < 2; batch++) {
    const result = await change('wecom_add_records', { records: Array.from({ length: 100 }, (_, i) => ({ [field('TEXT').id]: `MCP 分页 ${batch * 100 + i}` })) });
    batches.push(result.record_ids);
    report.retained_records.push(...result.record_ids);
  }
  records = await readAll([field('TEXT').id]);
  assert.equal(records.size, report.initial_records + 202);
  for (const batch of [...batches].reverse()) {
    await change('wecom_delete_records', { record_ids: batch });
    report.removed_records.push(...batch);
    report.retained_records = report.retained_records.filter(id => !batch.includes(id));
  }
  passed('add_and_delete_across_200_record_page_boundary');
  await change('wecom_delete_records', { record_ids: [blank] });
  report.removed_records.push(blank);
  report.retained_records = [sample];
  passed('delete_blank_record');

  const removedFields = [field('PHONE').id, field('EMAIL').id];
  await change('wecom_delete_fields', { field_ids: removedFields });
  report.removed_field_ids = removedFields;
  passed('delete_columns_containing_values');
  const primary = sheet.fields.find(f => f.is_primary);
  assert.ok(primary);
  await call('wecom_delete_fields', { url: report.url, sheet_id: sheetId, expected_revision: revision, field_ids: [primary.id] }, 'PRIMARY_FIELD');
  await call('wecom_update_records', { url: report.url, sheet_id: sheetId, expected_revision: revision,
    records: [{ record_id: sample, values: { [field('NUMBER').id]: '错误的数字' } }] }, 'INVALID_CELL_VALUE');
  await call('wecom_update_records', { url: report.url, sheet_id: sheetId, expected_revision: revision,
    records: [{ record_id: sample, values: { [field('SINGLE_SELECT').id]: ['id_example_unknown_option'] } }] }, 'UNKNOWN_OPTION');
  passed('primary_column_invalid_type_and_unknown_option_rejected');

  const competing = ['MCP 并发 A', 'MCP 并发 B'];
  const outcomes = await Promise.all(competing.map(text => client.callTool({ name: 'wecom_update_records', arguments: {
    url: report.url, sheet_id: sheetId, expected_revision: revision, records: [{ record_id: sample, values: { [field('TEXT').id]: text } }],
  } })));
  report.concurrency_outcomes = outcomes.map(result => ({ isError: result.isError, status: result.structuredContent?.status, error: result.structuredContent?.error, revision: result.structuredContent?.revision }));
  assert.equal(outcomes.filter(r => !r.isError).length, 1);
  assert.equal(outcomes.find(r => r.isError).structuredContent.error.code, 'STALE_REVISION');
  const winner = outcomes.findIndex(r => !r.isError);
  revision = outcomes[winner].structuredContent.revision;
  assert.equal((await readAll([field('TEXT').id])).get(sample).fields[field('TEXT').id].text, competing[winner]);
  passed('same_process_concurrent_writes_serialized');

  const final = await call('wecom_table_structure', { url: report.url });
  assert.equal(final.sheets[0].revision, revision);
  assert.equal(final.sheets[0].total_records_in_table, report.initial_records + 1);
  assert.equal(final.sheets[0].fields.length, sheet.fields.length + 11);
  report.final_revision = revision;
  report.status = 'passed';
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(!state.cookies.some(c => c.value.length >= 12 && (JSON.stringify(report) + stderr).includes(c.value)), 'credential leak');
  assert.equal(stderr, '');
} catch (error) {
  report.status = 'failed';
  if (error?.code === 'ERR_ASSERTION') report.assertion = { operator: error.operator, actual: error.actual, expected: error.expected };
  console.error(JSON.stringify({ write_verification: 'failed', code: report.last_error?.error?.code || 'ASSERTION_FAILED' }));
  process.exitCode = 1;
} finally {
  await client.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report_path: reportPath }));
}
