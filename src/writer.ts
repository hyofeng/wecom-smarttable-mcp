import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { WecomClient } from './client.js';
import { documentReference, documentUrl } from './local.js';
import { WecomError, requireData } from './errors.js';
import { type Chunk, type Schema } from './protocol.js';
import { parseDocumentRole, parseRecyclePage } from './document-protocol.js';
import { acknowledgedClears, addColumnMutations, appendRank, columnViewsMatch, deleteColumnMutations, mutation, newId, uniqueIds, updateMutations, valuesMatch,
  type CellValue, type ColumnInput, type Mutation, type RecordInput } from './mutations.js';

type Raw = Record<string, any>;
interface Target {
  doc: ReturnType<typeof documentUrl>; sheetId: string; chunk: Chunk; schema: Schema; user: Raw; uid: string;
  dver: string; pver: number; recordMode: boolean;
}
const DOC = 'https://doc.weixin.qq.com';

export class WriteQueue {
  private pending = new Map<string, Promise<unknown>>();
  async run<T>(url: string, action: () => Promise<T>): Promise<T> {
    const key = documentUrl(url).id;
    const previous = this.pending.get(key);
    const current = (previous || Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(key, current);
    try { return await current; }
    finally { if (this.pending.get(key) === current) this.pending.delete(key); }
  }
}

export class WecomWriter {
  constructor(private client: WecomClient, private signal: AbortSignal) {}

  private cancelled() {
    if (this.signal.aborted) throw new WecomError('WRITE_CANCELLED', '请求已取消，尚未发出写入。');
  }

  // 写请求独立于只读路径清单；发送后发生的错误均不进入登录后的自动重试。
  private async post(path: '/webdisk/create' | '/dop-api/commitchanges' | '/webdisk/file_mgr', params: Record<string, string>, form: Record<string, string>, intent: Raw) {
    this.cancelled();
    if (Buffer.byteLength(new URLSearchParams(form).toString()) > 1024 * 1024) throw new WecomError('WRITE_TOO_LARGE', '编码后的写入请求超过 1 MiB，请减小批量大小；尚未提交。');
    const url = new URL(path, DOC);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const cancel = () => { void this.client.context.dispose().catch(() => {}); };
    this.signal.addEventListener('abort', cancel, { once: true });
    let response;
    try {
      response = await this.client.context.post(url.href, { form, headers: { Referer: `${DOC}/`, Accept: 'application/json' }, maxRedirects: 0, maxRetries: 0 });
      if (!response.ok() || !response.headers()['content-type']?.includes('application/json')) throw new Error('unconfirmed response');
      const result = await response.json();
      const code = result.retcode ?? result.head?.ret;
      if (typeof code !== 'number') throw new Error('missing result code');
      if (code !== 0) throw new WecomError('WRITE_REJECTED', '企业微信拒绝了写入；没有自动重试。请先重新读取目标，再决定是否重试。', { ...intent, business_code: code, automatic_retry: false });
      return result as Raw;
    } catch (error) {
      if (error instanceof WecomError) throw error;
      throw new WecomError('WRITE_RESULT_UNKNOWN', '写入请求已发出，但无法确认结果；可能已经生效。请先读取核对，不能直接重复新增或删除。', { ...intent, may_have_written: true, automatic_retry: false });
    } finally {
      this.signal.removeEventListener('abort', cancel);
      await response?.dispose().catch(() => {});
    }
  }

  private async prepare(input: string, sheetId: string, revision: number): Promise<Target> {
    this.cancelled();
    const { doc, open, directory } = await this.client.openDocument(input);
    const vars = open.clientVars;
    if (vars.privilegeAttribute?.can_edit !== 1) throw new WecomError('WRITE_ACCESS_DENIED', '当前账号没有此文档的编辑权限。');
    if (!directory.some(s => s.id === sheetId && s.type === 'smartsheet')) throw new WecomError('UNKNOWN_SHEET', '子表 ID 不属于此智能表格。');
    const chunk = await this.client.chunk(doc.id, sheetId, 0, 200);
    if (chunk.revision !== revision) throw new WecomError('STALE_REVISION', '表格版本已变化；请重新读取并基于新内容决定修改，尚未写入。', { expected_revision: revision, current_revision: chunk.revision });
    const schema = await this.client.schema(doc.id, chunk);
    const collab = vars.collab_client_vars;
    requireData(typeof vars.uin === 'string' && typeof vars.userInfo?.fullName === 'string'
      && typeof collab.dver === 'string' && Number.isInteger(collab.pver), '网页写入所需的账号或版本元数据不完整。');
    if (collab.smartsheetPermissionInvalid) throw new WecomError('WRITE_ACCESS_DENIED', '智能表格内容权限无效，尚未写入。');
    return { doc, sheetId, chunk, schema, uid: vars.uin, user: { '1': vars.uin, '2': vars.userInfo.fullName },
      dver: collab.dver, pver: collab.pver, recordMode: vars.optimizedVer >= 4 };
  }

  private async records(target: Target, first: Chunk, wanted?: Set<string>) {
    const rows = new Map<string, { id: string; raw: Raw }>();
    let page = first;
    for (;;) {
      this.cancelled();
      if (page.revision !== first.revision || page.total !== first.total) throw new WecomError('DOCUMENT_CHANGED', '核对记录期间表格版本变化，无法确认完整结果。');
      for (const row of page.records) rows.set(row.id, row);
      if (wanted && [...wanted].every(id => rows.has(id))) break;
      const next = page.end + 1;
      if (next >= first.total) break;
      requireData(next > page.start, '记录分页没有前进。');
      page = await this.client.chunk(target.doc.id, target.sheetId, next, 200);
    }
    return rows;
  }

  private async requireRecords(target: Target, ids: string[]) {
    uniqueIds(ids, '记录列表');
    const rows = await this.records(target, target.chunk, new Set(ids));
    const missing = ids.filter(id => !rows.has(id));
    if (missing.length) throw new WecomError('UNKNOWN_RECORD', '记录不存在或不可读取，尚未写入。', { record_ids: missing });
    return rows;
  }

  private async apply(target: Target, mutations: Mutation[], operation: string, affected: Raw,
    verify: (chunk: Chunk, schema: Schema, clears: ReadonlyMap<string, Set<string>>) => Promise<boolean>) {
    const intent = { document_id: target.doc.id, sheet_id: target.sheetId, operation, ...affected };
    const current = await this.client.chunk(target.doc.id, target.sheetId, 0, 1);
    if (current.revision !== target.chunk.revision) throw new WecomError('STALE_REVISION', '准备修改期间表格已变化，尚未提交；请重新读取后决定修改。', { expected_revision: target.chunk.revision, current_revision: current.revision });
    const taskId = randomInt(1, 2 ** 48 - 1);
    const revision = target.chunk.revision;
    const payload = {
      common: { need_optimize: true, once_mode: true, type: 'USER_CHANGES', curRev: revision, offlineMsg: true,
        docid: target.doc.id, uid: target.uid, dver: target.dver, base_rev: revision, code_ver: 0, session_type: 0,
        gray: 0, pver: target.pver, uuId: randomUUID() },
      respective: [{ task_id: taskId, subId: target.sheetId, oSubId: false, head: false, keydata: false,
        changeSetCount: 1, changeset: JSON.stringify([mutations]) + '\n', changesetType: 'smartsheet' }],
    };
    const response = await this.post('/dop-api/commitchanges', { padId: target.doc.id, xsrf: this.client.cookie('TOK') }, { data: JSON.stringify(payload) }, intent);
    let committedRevision: number | undefined;
    try {
      const matches = response.Data?.respective?.filter((r: Raw) => r.commitId === taskId);
      requireData(Array.isArray(matches) && matches.length === 1, '写入响应缺少当前请求的唯一确认。');
      const accepted = matches[0];
      requireData(accepted.subId === target.sheetId && accepted.revert === false && accepted.need === false
        && Number.isSafeInteger(accepted.newRev) && accepted.newRev > revision, '写入确认的子表、状态或版本无效。');
      committedRevision = accepted.newRev;
      if (committedRevision !== revision + 1) throw new WecomError('WRITE_CONFLICT', '提交期间出现其他版本变化，需要重新核对。');
      const after = await this.client.chunk(target.doc.id, target.sheetId, 0, 200);
      requireData(after.revision === committedRevision, '回读版本与提交确认不一致，需要重新核对并发变化。');
      const schema = await this.client.schema(target.doc.id, after);
      if (!await verify(after, schema, acknowledgedClears(mutations, accepted.changeset))) throw new WecomError('WRITE_MISMATCH', '重新读取的结果与请求不一致。');
      return { ...intent, status: 'verified', previous_revision: revision, committed_revision: committedRevision, revision: after.revision };
    } catch (error) {
      throw new WecomError('WRITE_NOT_VERIFIED', '服务端已返回写入响应，但回读未能完整核对；请先检查目标，不能直接重复提交。', {
        ...intent, committed_revision: committedRevision, reason_code: error instanceof WecomError ? error.code : 'LOCAL_ERROR',
        ...(error instanceof WecomError ? { reason_message: error.message } : {}),
        may_have_written: true, automatic_retry: false,
      });
    }
  }

  async updateRecords(url: string, sheetId: string, revision: number, rows: RecordInput[]) {
    const target = await this.prepare(url, sheetId, revision);
    const commands = updateMutations(sheetId, target.schema, rows, target.user, target.recordMode);
    const ids = rows.map(r => r.record_id);
    await this.requireRecords(target, ids);
    return this.apply(target, commands, 'update_records', { record_ids: ids }, async (after, schema, clears) => {
      const actual = await this.records(target, after, new Set(ids));
      return rows.every(row => actual.has(row.record_id) && valuesMatch(schema, actual.get(row.record_id)!, row.values, clears.get(row.record_id)));
    });
  }

  async addRecords(url: string, sheetId: string, revision: number, values: Record<string, CellValue>[]) {
    const target = await this.prepare(url, sheetId, revision);
    const existing = await this.records(target, target.chunk);
    const rows = values.map(value => ({ record_id: newId('r'), values: value }));
    uniqueIds(rows.map(r => r.record_id), '新记录列表');
    if (rows.some(row => existing.has(row.record_id))) throw new WecomError('ID_COLLISION', '新记录 ID 已存在，尚未提交。');
    const maxRank = target.schema.raw.k16?.k3;
    requireData(typeof maxRank === 'string', '缺少表尾顺序标识，尚未新增记录。');
    const inserts = rows.map((row, index) => mutation(3010, { '1': sheetId, '3': { '1': row.record_id,
      '3': target.uid, '4': Date.now(), '7': { '1': appendRank(maxRank, index + 1), '2': {} } }, '4': target.user }));
    const filled = rows.filter(r => Object.keys(r.values).length);
    const updates = filled.length ? updateMutations(sheetId, target.schema, filled, target.user, target.recordMode) : [];
    const ids = rows.map(r => r.record_id);
    return this.apply(target, [...inserts, ...updates], 'add_records', { record_ids: ids }, async (after, schema, clears) => {
      if (after.total !== target.chunk.total + rows.length) return false;
      const actual = await this.records(target, after, new Set(ids));
      return rows.every(row => actual.has(row.record_id) && valuesMatch(schema, actual.get(row.record_id)!, row.values, clears.get(row.record_id)));
    });
  }

  async deleteRecords(url: string, sheetId: string, revision: number, ids: string[]) {
    const target = await this.prepare(url, sheetId, revision);
    await this.requireRecords(target, ids);
    const command = mutation(3035, { '1': sheetId, '2': ids.map(id => ({ '1': id })) });
    return this.apply(target, [command], 'delete_records', { record_ids: ids }, async after => {
      if (after.total !== target.chunk.total - ids.length) return false;
      const actual = await this.records(target, after);
      return ids.every(id => !actual.has(id));
    });
  }

  async addFields(url: string, sheetId: string, revision: number, columns: ColumnInput[]) {
    const target = await this.prepare(url, sheetId, revision);
    const { fields, mutations } = addColumnMutations(sheetId, target.schema, columns);
    return this.apply(target, mutations, 'add_fields', { fields }, async (_after, schema) => columnViewsMatch(target.schema, schema, fields.map(f => f.id), []) && fields.every(field => {
      const actual = schema.fields.find(f => f.id === field.id);
      return actual?.name === field.name && actual.type_code === field.type_code && (!field.options ||
        (actual.options?.length === field.options.length && field.options.every(o => actual.options?.some(a => a.id === o.id && a.name === o.name))));
    }));
  }

  async deleteFields(url: string, sheetId: string, revision: number, ids: string[]) {
    const target = await this.prepare(url, sheetId, revision);
    const commands = deleteColumnMutations(sheetId, target.schema, ids);
    return this.apply(target, commands, 'delete_fields', { field_ids: ids }, async (_after, schema) => columnViewsMatch(target.schema, schema, [], ids) && ids.every(id => !schema.fields.some(f => f.id === id)));
  }

  async createTable(title: string) {
    this.cancelled();
    await this.client.checkSession();
    const response = await this.post('/webdisk/create', { sid: this.client.cookie('wedoc_sid'), wedoc_xsrf: this.client.cookie('low_login_enable') },
      { func: '16', name: title, space_id: '', father_id: '', add_to_open_list: 'true' }, { operation: 'create_table', title });
    let url: string | undefined;
    try {
      requireData(response.head?.ret === 0 && typeof response.body?.file_info?.doc_url === 'string', '新建响应缺少智能表格链接。');
      const doc = documentUrl(response.body.file_info.doc_url);
      url = new URL(`/smartsheet/${doc.id}`, DOC).href;
      const structure = await this.client.structure(url);
      requireData(structure.title === title && structure.sheets.length > 0, '新建智能表格的名称或子表未通过回读核对。');
      return { operation: 'create_table', status: 'verified', url, ...structure };
    } catch (error) {
      throw new WecomError('WRITE_NOT_VERIFIED', '新建请求已返回，但无法完整核对新表；请先检查已创建的表，避免重复新建。', {
        operation: 'create_table', title, ...(url ? { url } : {}), may_have_written: true, automatic_retry: false,
        reason_code: error instanceof WecomError ? error.code : 'LOCAL_ERROR',
        ...(error instanceof WecomError ? { reason_message: error.message } : {}),
      });
    }
  }

  private async documentRole(documentId: string) {
    const result = await this.client.desktopRead('/diskauth/get_auth_info', { func: '5', doc_ids: documentId, from: 'mydoc' });
    return parseDocumentRole(result, documentId);
  }

  private async inRecycleBin(fileId: string) {
    let cursor = '';
    const seen = new Set<string>();
    for (;;) {
      this.cancelled();
      const page = parseRecyclePage(await this.client.desktopRead('/diskfile/recycle_list', {
        func: '7', skip_file: 'false', sync_key: cursor, return_user_name: 'true', skip_album: 'true',
      }), fileId);
      if (page.found) return true;
      if (page.finished) return false;
      if (page.cursor === cursor || seen.has(page.cursor)) throw new WecomError('PARSE_ERROR', '回收站分页没有前进，无法核对删除结果。');
      seen.add(page.cursor);
      cursor = page.cursor;
    }
  }

  async deleteTable(reference: { url?: string; document_id?: string }, checkOnly = false) {
    this.cancelled();
    const doc = documentReference(reference);
    await this.client.checkSession();
    const role = await this.documentRole(doc.id);
    const fileId = role.fileId;
    const identity = { operation: 'delete_table', document_id: doc.id, url: new URL(`/smartsheet/${doc.id}`, DOC).href, file_id: fileId, title: role.title };
    if (await this.inRecycleBin(fileId)) return { ...identity, status: 'verified', state: 'recycle_bin', permanent: false,
      checked_only: checkOnly, already_in_recycle_bin: true, recycle_verified: true };
    const { open } = await this.client.openDocument(doc.url.href);
    if (checkOnly) return { ...identity, status: 'verified', state: 'active', checked_only: true, title: open.clientVars.title };
    // 网页操作权限 23 = 删除，25 = 永久删除；此处只使用 23 和 file_mgr 的移入回收站操作。
    if (!role.canDelete) throw new WecomError('DELETE_ACCESS_DENIED', '当前账号没有此智能表格文档的删除权限，尚未提交。', { document_id: doc.id });
    const response = await this.post('/webdisk/file_mgr', { sid: this.client.cookie('wedoc_sid'), wedoc_xsrf: this.client.cookie('low_login_enable') },
      { func: '4', selectAll: 'false', async: 'true', timestamp: String(Date.now()), doc_id: doc.id }, identity);
    let taskId: string | undefined;
    try {
      requireData(response.head?.ret === 0 && typeof response.body?.task_id === 'string' && response.body.task_id.length > 0, '删除响应缺少异步任务 ID。');
      taskId = response.body.task_id;
      const deadline = Date.now() + 30000;
      let finished = false;
      while (Date.now() < deadline) {
        this.cancelled();
        const task = await this.client.desktopRead('/diskfile/querytaskresult', { task_id: taskId! });
        if (task.finish === true) {
          if (task.err_code !== 0) throw new WecomError('DELETE_TASK_FAILED', '删除任务返回失败。');
          finished = true;
          break;
        }
        requireData(task.finish === undefined || task.finish === false, '删除任务完成状态的结构无效。');
        await setTimeout(200, undefined, { signal: this.signal });
      }
      if (!finished) throw new WecomError('DELETE_TASK_TIMEOUT', '删除任务在核对时限内尚未完成。');
      requireData(await this.inRecycleBin(fileId), '回收站未确认目标文件，不能只凭提交成功断言已删除。');
      return { ...identity, title: open.clientVars.title, status: 'verified', state: 'recycle_bin', permanent: false,
        checked_only: false, already_in_recycle_bin: false, recycle_verified: true, task_id: taskId };
    } catch (error) {
      throw new WecomError('WRITE_NOT_VERIFIED', '删除已提交，但未完整确认移入回收站；请使用 check_only: true 核对，不要重复提交删除。', {
        ...identity, ...(taskId ? { task_id: taskId } : {}), may_have_written: true, automatic_retry: false,
        reason_code: error instanceof WecomError ? error.code : 'LOCAL_ERROR',
        ...(error instanceof WecomError ? { reason_message: error.message } : {}),
        verification: { tool: 'wecom_delete_table', document_id: doc.id, check_only: true },
      });
    }
  }
}
