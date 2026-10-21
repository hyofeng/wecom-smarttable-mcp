import { inflateSync } from 'node:zlib';
import { requireData, WecomError } from './errors.js';

// 将已实测网页协议的数字键解析集中在此；MCP 入口使用语义化参数。
type Raw = Record<string, any>;
export const fieldTypes: Record<number, string> = {
  1: 'TEXT', 2: 'NUMBER', 3: 'CHECKBOX', 4: 'DATE_TIME', 5: 'IMAGE', 6: 'ATTACHMENT',
  7: 'USER', 8: 'URL', 9: 'MULTIPLE_SELECT', 10: 'CREATED_USER', 11: 'MODIFIED_USER',
  12: 'CREATED_TIME', 13: 'MODIFIED_TIME', 14: 'PROGRESS', 15: 'PHONE', 16: 'EMAIL',
  17: 'SINGLE_SELECT', 18: 'LINK_RECORDS', 19: 'FORMULA', 20: 'LOOKUP', 21: 'TWO_WAY_LINK_RECORDS',
};
export interface Field { id: string; name: string; type_code: number; type: string; options?: { id: string; name: string }[] }
export interface Schema { fields: Field[]; views: Raw[]; raw: Raw }
export interface Chunk {
  sheetId: string; revision: number; total: number; start: number; end: number;
  records: { id: string; raw: Raw }[]; schema?: Schema; workbook: Raw[]; raw: Raw;
}
export interface Locator { document_id: string; sheet_id: string; record_id: string; chunk_start: number; chunk_size: number; field_id: string; asset_id: string }
export interface Asset {
  kind: 'image' | 'attachment'; id: string; name: string; url: string;
  size: number | null; width?: number; height?: number; extension?: string; source?: string;
}

export function parseJson(input: string, label: string): any {
  try { return JSON.parse(input); } catch { throw new WecomError('PARSE_ERROR', `${label}不是有效 JSON；没有使用截断文本代替。`); }
}

export function schemaFromRaw(raw: Raw): Schema {
  requireData(raw && raw.k3 && Array.isArray(raw.k4), '智能表格字段或视图结构不完整。');
  const fields: Field[] = Object.entries(raw.k3).map(([id, value]) => {
    const field = value as Raw;
    requireData(typeof field.k30 === 'string' && Number.isInteger(field.k31), '字段缺少名称或真实类型。');
    const type = field.k31;
    const options = field[`k${type}`]?.k3;
    return { id, name: field.k30, type_code: type, type: fieldTypes[type] || `UNKNOWN_${type}`,
      ...([9, 17].includes(type) && Array.isArray(options) ? { options: options.map((v: Raw) => ({ id: v.k1, name: v.k2 })) } : {}) };
  });
  const views = raw.k4.map((v: Raw) => {
    requireData(typeof v.k30 === 'string' && typeof v.k31 === 'string' && Number.isInteger(v.k32), '视图元数据不完整。');
    const properties = v[`k${v.k32}`];
    const filter = properties?.k8;
    if (filter) requireData(Array.isArray(filter.k2), '保存的视图筛选结构发生变化。');
    return { id: v.k30, name: v.k31, type_code: v.k32, records_scope_supported: 'table_only',
      saved_filter: filter ? { conjunction_code: filter.k1, conditions: filter.k2.map((c: Raw) => ({
        field_id: c.k30, field_name: fields.find(f => f.id === c.k30)?.name || null,
        field_type_code: c.k31, operator_code: c.k32, value: c[`k${c.k31}`] ?? null })) } : null,
      sort: (properties?.k9 || []).map((s: Raw) => ({ field_id: s.k1, descending: Boolean(s.k2) })),
      group: (properties?.k7 || []).map((s: Raw) => ({ field_id: s.k1, descending: Boolean(s.k2) })) };
  });
  return { fields, views, raw };
}

export function parseChunk(data: Raw, sheetId: string, requestedStart: number, requestedEnd: number): Chunk {
  requireData(data && data.padType === 'smartsheet', '响应没有确认智能表格类型。');
  if (data.dataIniting) throw new WecomError('DATA_NOT_READY', '网页接口仍在初始化数据，请稍后重新读取。');
  requireData(data.sheetId === sheetId && Number.isInteger(data.rev), '响应子表 ID 或版本不匹配。');
  const texts = data.initialAttributedText?.text;
  requireData(Array.isArray(texts) && texts.length === 1, '分块数量变化；拒绝遗漏额外数据块。');
  const text = texts[0];
  requireData(typeof text.smartsheet === 'string' && typeof text.workbook === 'string', '缺少智能表格压缩内容或子表目录。');
  let decoded: string;
  try { decoded = inflateSync(Buffer.from(text.smartsheet, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'); }
  catch { throw new WecomError('PARSE_ERROR', '智能表格内容解压失败或超过 64 MiB 安全上限。'); }
  const groups = parseJson(decoded, '智能表格压缩内容');
  requireData(Array.isArray(groups) && groups.every(Array.isArray), '智能表格命令分组结构发生变化。');
  const commands: Raw[] = groups.flat();
  requireData(commands.every(c => c.v === 5 && [3005, 3028].includes(c.t) && c.c?.k1 === sheetId), '存在未支持的智能表格命令或版本；没有静默跳过。');
  const initial = commands.filter(c => c.t === 3005);
  const deltas = commands.filter(c => c.t === 3028);
  requireData(initial.length <= 1 && deltas.length <= 1, '出现重复的表格或记录分块命令。');
  const schema = initial.length ? schemaFromRaw(initial[0].c.k3) : undefined;
  const delta = deltas[0]?.c.k2;
  const map = delta?.k1 || {};
  const ranks = delta?.k6?.k1 || initial[0]?.c.k3?.k16?.k1 || {};
  const ids = Object.keys(map);
  requireData(ids.every(id => typeof ranks[id] === 'string'), '记录缺少行顺序，不能可靠定位附件。');
  ids.sort((a, b) => ranks[a] < ranks[b] ? -1 : ranks[a] > ranks[b] ? 1 : 0);
  const { total_record_count: total, start_row_index: start, end_row_index: end } = text;
  requireData(Number.isInteger(total) && total >= 0 && Number.isInteger(start) && Number.isInteger(end), '缺少真实总数或分页范围。');
  requireData(start === requestedStart && end <= requestedEnd, '接口返回的分页范围与请求不一致。');
  const expected = Math.max(0, Math.min(end + 1, total) - start);
  if (ids.length !== expected) throw new WecomError('INCOMPLETE_DATA', '记录数量与分页范围不符；未把不完整结果作为成功返回。', { expected, actual: ids.length, start, end, total });
  const workbook = parseJson(text.workbook, '子表目录');
  requireData(Array.isArray(workbook) && workbook.every(v => typeof v.id === 'string' && typeof v.name === 'string' && typeof v.type === 'string'), '子表目录结构无效。');
  return { sheetId, revision: data.rev, total, start, end, schema, workbook, raw: delta || {}, records: ids.map(id => ({ id, raw: map[id] })) };
}

export function cellsFor(record: Raw): Raw {
  requireData(record.k1 && typeof record.k1 === 'object' && !Array.isArray(record.k1), '分块接口的记录字段映射发生变化。');
  return record.k1;
}

export function assetsFor(cell: Raw | undefined): Asset[] {
  if (!cell || ![5, 6].includes(cell.k30)) return [];
  const list = cell[`k${cell.k30}`];
  if (list === undefined) return [];
  requireData(Array.isArray(list), '图片或附件字段不是数组，无法证明文件完整性。');
  return list.map((f: Raw): Asset => {
    if (cell.k30 === 5) {
      requireData(typeof f.k1 === 'string' && typeof f.k2 === 'string' && typeof f.k3 === 'string', '图片缺少真实 ID、文件名或地址。');
      return { kind: 'image', id: f.k1, name: f.k2, url: f.k3, size: null,
        ...(typeof f.k4 === 'number' ? { width: f.k4 } : {}), ...(typeof f.k5 === 'number' ? { height: f.k5 } : {}) };
    }
    requireData(typeof f.k4 === 'string' && typeof f.k1 === 'string' && typeof f.k6 === 'string', '附件缺少真实文件 ID、文件名或来源地址。');
    return { kind: 'attachment', id: f.k4, name: f.k1, url: f.k6, size: typeof f.k2 === 'number' ? f.k2 : null,
      extension: f.k3, source: f.k7 };
  });
}

export function presentRecord(chunk: Chunk, schema: Schema, row: { id: string; raw: Raw }, docId: string, selected: string[]) {
  const cells = cellsFor(row.raw);
  requireData(Object.keys(cells).every(id => schema.fields.some(f => f.id === id)), '记录中出现字段定义未包含的字段，拒绝静默遗漏。');
  const values: Raw = {};
  for (const field of schema.fields.filter(f => selected.includes(f.id))) {
    const cell = cells[field.id];
    if (cell) requireData(cell.k30 === field.type_code, '记录字段类型与字段定义不一致。');
    if ([5, 6].includes(field.type_code)) {
      values[field.id] = { status: cell ? 'present' : 'not_returned', assets: assetsFor(cell).map(asset => {
        const { url: _privateUrl, ...publicAsset } = asset;
        return { ...publicAsset, locator: { document_id: docId, sheet_id: chunk.sheetId, record_id: row.id,
          chunk_start: chunk.start, chunk_size: chunk.end - chunk.start + 1, field_id: field.id, asset_id: asset.id } satisfies Locator };
      }) };
    } else if (field.type_code === 10) {
      const created = chunk.raw.k2?.[row.id];
      values[field.id] = { status: created ? 'present' : 'unavailable', value: created?.k2 || null };
    } else if (field.type_code === 1) {
      const fragments = cell?.k1;
      if (fragments !== undefined) requireData(Array.isArray(fragments) && fragments.every(v => typeof v.k2 === 'string'), '文本片段结构变化。');
      const text = (fragments || []).map((v: Raw) => v.k2).join('');
      values[field.id] = { status: cell ? 'present' : 'not_returned', text, fragments: fragments || [],
        text_links: [...new Set<string>(text.match(/https?:\/\/[^\s<>]+/g) || [])].map(url => ({ url, kind: 'text_link', downloadable_as_attachment: false })) };
    } else {
      const value = cell?.[`k${field.type_code}`];
      values[field.id] = { status: value !== undefined ? 'present' : cell ? 'unresolved' : 'not_returned', value: value ?? null,
        ...([9, 17].includes(field.type_code) && Array.isArray(value) ? { options: value.map(id => ({ id, name: field.options?.find(o => o.id === id)?.name || null })) } : {}),
        ...(cell?.k3601 ? { computed_result: parseJson(cell.k3601, '派生字段结果') } : {}) };
    }
  }
  return { id: row.id, fields: values };
}
