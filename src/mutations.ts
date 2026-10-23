import { randomInt } from 'node:crypto';
import { WecomError, requireData } from './errors.js';
import { cellsFor, parseJson, type Field, type Schema } from './protocol.js';

type Raw = Record<string, any>;
export type CellValue = string | number | boolean | string[] | null;
export interface RecordInput { record_id: string; values: Record<string, CellValue> }
export const columnTypes = {
  TEXT: 1, NUMBER: 2, CHECKBOX: 3, DATE_TIME: 4, IMAGE: 5, ATTACHMENT: 6, USER: 7, URL: 8,
  MULTIPLE_SELECT: 9, PROGRESS: 14, PHONE: 15, EMAIL: 16, SINGLE_SELECT: 17,
} as const;
export interface ColumnInput { name: string; type: keyof typeof columnTypes; options?: string[] }
export interface Mutation { t: number; v: number; c: Raw; r: number; o: number }

export function newId(prefix: 'r' | 'f' | 'o') {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  return prefix + Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export function mutation(t: number, c: Raw): Mutation { return { t, v: 5, c, r: -1, o: 0 }; }

export function uniqueIds(ids: string[], label: string) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new WecomError('INVALID_ARGUMENT', `${label}不能为空或包含重复 ID。`);
}

export function encodeCell(field: Field, value: CellValue): Raw {
  const type = field.type_code;
  const invalid = (): never => { throw new WecomError('INVALID_CELL_VALUE', '值不符合字段类型；文本/电话/邮箱用字符串，数字和进度用数字，勾选用布尔值，日期用毫秒时间戳，单选/多选用已有选项 ID 数组，null 表示清空。', { field_id: field.id, field_type: field.type }); };
  if (![1, 2, 3, 4, 9, 14, 15, 16, 17].includes(type)) throw new WecomError('UNSUPPORTED_WRITE_TYPE', '此字段类型尚未验证单元格写入，不会转换或覆盖其内容。', { field_id: field.id, field_type: field.type });
  let encoded: unknown = value;
  if (value !== null) {
    if ([1, 15, 16].includes(type)) {
      if (typeof value !== 'string') invalid();
      if (type === 1) encoded = value === '' ? [] : [{ '1': 'text', '2': value, '4': {} }];
    } else if ([2, 14].includes(type)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
      if (type === 14 && ((value as number) < 0 || (value as number) > 1)) invalid();
    } else if (type === 3) {
      if (typeof value !== 'boolean') invalid();
    } else if (type === 4) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) invalid();
      encoded = String(value);
    } else {
      if (!Array.isArray(value) || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) invalid();
      const selected = value as string[];
      if (type === 17 && selected.length > 1) invalid();
      if (selected.some(id => !field.options?.some(option => option.id === id))) throw new WecomError('UNKNOWN_OPTION', '选项 ID 不属于此字段；先读取结构，不会按名称猜测或自动新增选项。', { field_id: field.id });
    }
  }
  return { '30': type, [String(type)]: encoded };
}

export function updateMutations(sheetId: string, schema: Schema, rows: RecordInput[], user: Raw, recordMode: boolean) {
  uniqueIds(rows.map(r => r.record_id), '记录列表');
  return rows.map(row => {
    if (!Object.keys(row.values).length) throw new WecomError('INVALID_ARGUMENT', '每条记录至少需要一个待修改字段。');
    const delta = Object.fromEntries(Object.entries(row.values).map(([id, value]) => {
      const field = schema.fields.find(f => f.id === id);
      if (!field) throw new WecomError('UNKNOWN_FIELD', '待写入的字段 ID 不存在或不可读取。', { field_id: id });
      if (field.type_code === 14 && value !== null) {
        const config = schema.raw.k3[id].k14;
        const range = config?.k5;
        if (config?.k4 !== 0 || !Array.isArray(range) || !(range.length === 0 || (range.length === 2 && range[0] === 0 && range[1] === 1))) {
          throw new WecomError('UNSUPPORTED_FIELD_CONFIG', '进度写入仅验证了默认 0–1 格式；此字段使用其他配置，尚未写入。', { field_id: id });
        }
      }
      return [id, encodeCell(field, value)];
    }));
    return mutation(3013, { '1': sheetId, '3': row.record_id, '4': delta, '5': user, '7': recordMode });
  });
}

export function acknowledgedClears(requests: Mutation[], changeset: string) {
  const requested = requests.filter(m => m.t === 3013 && Object.values(m.c['4']).some((cell: any) => {
    const value = cell[String(cell['30'])];
    return value === null || value === '' || (Array.isArray(value) && value.length === 0);
  }));
  const clears = new Map<string, Set<string>>();
  if (!requested.length) return clears;
  const groups = parseJson(changeset, '已提交的修改命令');
  requireData(Array.isArray(groups) && groups.every(Array.isArray), '提交确认的命令分组无效。');
  const commands = groups.flat();
  for (const request of requested) {
    for (const [id, input] of Object.entries(request.c['4']) as [string, Raw][]) {
      const value = input[String(input['30'])];
      if (!(value === null || value === '' || (Array.isArray(value) && value.length === 0))) continue;
      const confirmed = commands.some(command => {
        const cell = command.c?.['4']?.[id];
        const actual = cell?.[String(input['30'])];
        return command.t === 3013 && command.c?.['1'] === request.c['1'] && command.c?.['3'] === request.c['3']
          && cell?.['30'] === input['30'] && (actual == null || actual === '' || (Array.isArray(actual) && actual.length === 0));
      });
      if (confirmed) {
        if (!clears.has(request.c['3'])) clears.set(request.c['3'], new Set());
        clears.get(request.c['3'])!.add(id);
      }
    }
  }
  return clears;
}

export function valuesMatch(schema: Schema, row: { raw: Raw }, values: Record<string, CellValue>, confirmedClears?: ReadonlySet<string>) {
  const cells = cellsFor(row.raw);
  return Object.entries(values).every(([id, expected]) => {
    const field = schema.fields.find(f => f.id === id);
    if (!field) return false;
    const cell = cells[id];
    // 读接口省略单元格不等于空；仅有当前提交的明确清空确认时才接受这种回读形式。
    if (!cell) return (expected === null || expected === '' || (Array.isArray(expected) && expected.length === 0)) && confirmedClears?.has(id) === true;
    if (cell.k30 !== field.type_code) return false;
    const actual = cell[`k${field.type_code}`];
    if (expected === null) return actual === null || (actual === undefined && confirmedClears?.has(id) === true) || (Array.isArray(actual) && actual.length === 0);
    if (field.type_code === 1) return Array.isArray(actual) && actual.every(p => typeof p.k2 === 'string') && actual.map(p => p.k2).join('') === expected;
    if (field.type_code === 4) return actual === String(expected);
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every(id => actual.includes(id));
    return actual === expected;
  });
}

// 网页 Rank.add 使用 base36 整数，步长 2^20；仅在表尾追加，不使用界面行号。
export function appendRank(rank: string, count: number) {
  if (!/^[0-9a-z]{11}$/.test(rank)) throw new WecomError('UNSUPPORTED_RANK', '此表尾顺序标识不属于已验证的 11 位 base36 格式，尚未新增记录。');
  let value = 0n;
  for (const character of rank) value = value * 36n + BigInt(parseInt(character, 36));
  const next = (value + BigInt(count) * 1048576n).toString(36).padStart(rank.length, '0');
  if (next.length !== 11) throw new WecomError('UNSUPPORTED_RANK', '追加记录需要扩展顺序标识，尚未提交。');
  return next;
}

export function columnOrders(schema: Schema): Record<string, string[]> {
  return Object.fromEntries(schema.raw.k4.map((view: Raw) => {
    const fields = view[`k${view.k32}`]?.k2;
    requireData(Array.isArray(fields) && fields.every(id => schema.fields.some(f => f.id === id)), '此视图的列顺序协议尚未验证，未修改列。');
    return [view.k30, [...fields]];
  }));
}

export function columnViewsMatch(before: Schema, after: Schema, added: string[], removed: string[]) {
  const expected = Object.fromEntries(Object.entries(columnOrders(before)).map(([view, fields]) =>
    [view, [...fields.filter(id => !removed.includes(id)), ...added]]));
  const actual = columnOrders(after);
  return Object.keys(expected).length === Object.keys(actual).length
    && Object.entries(expected).every(([view, fields]) => JSON.stringify(actual[view]) === JSON.stringify(fields));
}

export function addColumnMutations(sheetId: string, schema: Schema, columns: ColumnInput[]) {
  const names = columns.map(c => c.name);
  if (new Set(names).size !== names.length || names.some(name => schema.fields.some(f => f.name === name))) throw new WecomError('DUPLICATE_FIELD_NAME', '新列名称重复或与已有字段重名。');
  const indexes = Object.fromEntries(Object.entries(columnOrders(schema)).map(([id, fields]) => [id, fields.length]));
  const fields = columns.map(column => {
    const id = newId('f');
    if (schema.fields.some(f => f.id === id)) throw new WecomError('ID_COLLISION', '随机字段 ID 与已有字段重复，尚未提交。');
    const type = columnTypes[column.type];
    if (!type) throw new WecomError('UNSUPPORTED_WRITE_TYPE', '此类型尚未验证创建列。');
    if (column.options && ![9, 17].includes(type)) throw new WecomError('INVALID_ARGUMENT', '仅单选和多选列可以设置 options。');
    if (column.options && new Set(column.options).size !== column.options.length) throw new WecomError('INVALID_ARGUMENT', '选项名称不能重复。');
    return { id, name: column.name, type_code: type, type: column.type,
      ...([9, 17].includes(type) ? { options: (column.options || []).map(name => ({ id: newId('o'), name })) } : {}) };
  });
  uniqueIds(fields.map(f => f.id), '新字段列表');
  for (const field of fields) if (field.options?.length) uniqueIds(field.options.map(option => option.id), '新选项列表');
  const mutations = fields.flatMap((field, offset) => {
    const insert = mutation(3014, { '1': sheetId, '3': { '1': field.id, '2': field.type_code, '3': field.name,
      '4': Object.fromEntries(Object.entries(indexes).map(([id, index]) => [id, index + offset])) } });
    if (!field.options) return [insert];
    const property = { '1': field.type_code === 9, '2': true,
      '3': field.options.map((option, index) => ({ '1': option.id, '2': option.name, '3': [11, 13, 15][index % 3] })), '9': { [String(field.type_code)]: null } };
    return [insert, mutation(3017, { '1': sheetId, '3': field.id, '4': { '31': field.type_code, [String(field.type_code)]: property }, '5': null })];
  });
  return { fields, mutations };
}

export function deleteColumnMutations(sheetId: string, schema: Schema, fieldIds: string[]) {
  uniqueIds(fieldIds, '字段列表');
  requireData(typeof schema.raw.k9 === 'string' && schema.fields.some(field => field.id === schema.raw.k9), '未明确识别标题列，尚未删除字段。');
  const orders = columnOrders(schema);
  return fieldIds.map(id => {
    const field = schema.fields.find(f => f.id === id);
    if (!field) throw new WecomError('UNKNOWN_FIELD', '待删除的字段 ID 不存在或不可读取。', { field_id: id });
    if (schema.raw.k9 === id) throw new WecomError('PRIMARY_FIELD', '标题列不能直接删除；请保留标题列。', { field_id: id });
    if (!Object.values(columnTypes).some(type => type === field.type_code)) throw new WecomError('UNSUPPORTED_WRITE_TYPE', '关联或派生列的删除协议尚未验证，未删除此字段。', { field_id: id });
    const indexes = Object.fromEntries(Object.entries(orders).flatMap(([view, fields]) => {
      const index = fields.indexOf(id);
      if (index < 0) return [];
      fields.splice(index, 1);
      return [[view, index]];
    }));
    return mutation(3015, { '1': sheetId, '3': id, '4': { '1': indexes }, '5': null, '8': false });
  });
}
