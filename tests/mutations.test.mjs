import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { schemaFromRaw } from '../dist/protocol.js';
import { acknowledgedClears, addColumnMutations, appendRank, columnOrders, columnViewsMatch,
  deleteColumnMutations, encodeCell, updateMutations, valuesMatch } from '../dist/mutations.js';
import { parseDocumentRole, parseRecyclePage } from '../dist/document-protocol.js';
import { documentReference } from '../dist/local.js';

const input = JSON.parse(await readFile(new URL('fixtures/write-protocol.json', import.meta.url), 'utf8'));
const schema = schemaFromRaw(input.schema);
const deletion = JSON.parse(await readFile(new URL('fixtures/delete-table.json', import.meta.url), 'utf8'));

test('文本修改命令与真实已提交请求的脱敏样本一致', () => {
  const request = input.update;
  const fieldId = Object.keys(request.c['4'])[0];
  const text = request.c['4'][fieldId]['1'][0]['2'];
  assert.deepEqual(updateMutations(request.c['1'], schema, [{ record_id: request.c['3'], values: { [fieldId]: text } }], input.user, false), [request]);
});

test('新列插入位置及协议与真实新增列请求一致', () => {
  const expected = structuredClone(input.insert_field);
  const result = addColumnMutations(expected.c['1'], schemaFromRaw(input.initial_schema), [{ name: expected.c['3']['3'], type: 'NUMBER' }]);
  expected.c['3']['1'] = result.fields[0].id;
  assert.deepEqual(result.mutations, [expected]);
});

test('批量删除相邻列会调整后续索引，并保留原始视图顺序', () => {
  const phone = schema.fields.find(f => f.type_code === 15);
  const email = schema.fields.find(f => f.type_code === 16);
  const before = columnOrders(schema);
  const [first, second] = deleteColumnMutations(input.update.c['1'], schema, [phone.id, email.id]);
  for (const [view, fields] of Object.entries(before)) {
    assert.equal(fields.indexOf(email.id), fields.indexOf(phone.id) + 1);
    assert.equal(first.c['4']['1'][view], fields.indexOf(phone.id));
    assert.equal(second.c['4']['1'][view], fields.indexOf(phone.id));
  }
  assert.deepEqual(columnOrders(schema), before);
  const afterRaw = structuredClone(input.schema);
  delete afterRaw.k3[phone.id];
  delete afterRaw.k3[email.id];
  for (const view of afterRaw.k4) view[`k${view.k32}`].k2 = view[`k${view.k32}`].k2.filter(id => ![phone.id, email.id].includes(id));
  assert.equal(columnViewsMatch(schema, schemaFromRaw(afterRaw), [], [phone.id, email.id]), true);
  afterRaw.k4[0].k1.k2.push(email.id);
  assert.throws(() => columnViewsMatch(schema, schemaFromRaw(afterRaw), [], [phone.id, email.id]), e => e.code === 'PARSE_ERROR');
});

test('清空后的省略单元格仅在真实提交确认明确清空时通过', () => {
  const request = input.clear;
  const fieldId = Object.keys(request.c['4'])[0];
  const clears = acknowledgedClears([request], JSON.stringify(input.clear_ack));
  assert.equal(clears.get(request.c['3']).has(fieldId), true);
  assert.equal(valuesMatch(schema, input.cleared_record, { [fieldId]: null }), false);
  assert.equal(valuesMatch(schema, input.cleared_record, { [fieldId]: null }, clears.get(request.c['3'])), true);
  assert.equal(valuesMatch(schema, input.cleared_record, { [fieldId]: 'value_example_nonempty' }, clears.get(request.c['3'])), false);
  const changed = structuredClone(input.clear_ack);
  changed[0][0].c['3'] = 'id_example_other_record';
  assert.equal(acknowledgedClears([request], JSON.stringify(changed)).size, 0);
});

test('字段值严格匹配类型，保留零与 false，拒绝派生替代和未知选项', () => {
  const field = type => schema.fields.find(f => f.type_code === type);
  assert.equal(encodeCell(field(2), 0)['2'], 0);
  assert.equal(encodeCell(field(3), false)['3'], false);
  assert.equal(encodeCell(field(4), 0)['4'], '0');
  assert.throws(() => encodeCell(field(2), '12'), e => e.code === 'INVALID_CELL_VALUE');
  assert.throws(() => encodeCell(field(7), []), e => e.code === 'UNSUPPORTED_WRITE_TYPE');
  assert.throws(() => encodeCell(field(17), ['id_example_unknown_option']), e => e.code === 'UNKNOWN_OPTION');
  const primary = schema.fields.find(f => f.is_primary);
  assert.throws(() => deleteColumnMutations(input.update.c['1'], schema, [primary.id]), e => e.code === 'PRIMARY_FIELD');
  const unknownPrimary = structuredClone(schema);
  delete unknownPrimary.raw.k9;
  assert.throws(() => deleteColumnMutations(input.update.c['1'], unknownPrimary, [field(2).id]), e => e.code === 'PARSE_ERROR');
});

test('追加顺序与网页 Rank.add 的实际结果一致，不猜测未知格式', () => {
  assert.equal(appendRank('e0000034dfk', 1), 'e000003quio');
  assert.equal(appendRank('e0000034dfk', 2), 'e000004dbls');
  assert.throws(() => appendRank('unknown', 1), e => e.code === 'UNSUPPORTED_RANK');
});

test('删除文档必须用一致的 URL/document_id，不能用标题或伪造域名', () => {
  const id = 'id_example_document';
  assert.equal(documentReference({ document_id: id }).id, id);
  assert.equal(documentReference({ url: `https://doc.weixin.qq.com/smartsheet/${id}`, document_id: id }).id, id);
  assert.throws(() => documentReference({ url: `https://doc.weixin.qq.com/smartsheet/${id}`, document_id: 'id_example_other' }), e => e.code === 'DOCUMENT_ID_MISMATCH');
  assert.throws(() => documentReference({}), e => e.code === 'INVALID_ARGUMENT');
  assert.throws(() => documentReference({ url: `https://doc.weixin.qq.com.evil.example/smartsheet/${id}` }), e => e.code === 'INVALID_URL');
});

test('删除权限来自精确文档映射和操作 23，永久删除权限不能代替', () => {
  const role = parseDocumentRole(deletion.role, 'id_example_document');
  assert.equal(role.canDelete, true);
  assert.equal(role.fileId, 'id_example_file');
  const changed = structuredClone(deletion.role);
  changed.file_roles[0].role_info.allow_operations = [25];
  assert.equal(parseDocumentRole(changed, 'id_example_document').canDelete, false);
  changed.file_roles[0].file_info.doc_id = 'id_example_other';
  assert.throws(() => parseDocumentRole(changed, 'id_example_document'), e => e.code === 'PARSE_ERROR');
});

test('真实回收站 ID 后缀、删除状态和分页结束均被核对', () => {
  assert.equal(parseRecyclePage(deletion.recycle, 'id_example_file').found, true);
  assert.equal(parseRecyclePage(deletion.recycle, 'id_example_fil').found, false);
  assert.equal(parseRecyclePage(deletion.recycle, 'id_example_other_file').found, false);
  assert.equal(parseRecyclePage(deletion.last, 'id_example_file').finished, true);
  const changed = structuredClone(deletion.recycle);
  changed.list[0].status = 1;
  assert.throws(() => parseRecyclePage(changed, 'id_example_file'), e => e.code === 'PARSE_ERROR');
});
