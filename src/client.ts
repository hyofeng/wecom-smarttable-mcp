import { request, type APIRequestContext } from 'playwright';
import { lstat, readFile } from 'node:fs/promises';
import { WecomError, requireData } from './errors.js';
import { documentUrl, statePath } from './local.js';
import { parseChunk, parseJson, presentRecord, type Chunk, type Schema } from './protocol.js';

const DOC = 'https://doc.weixin.qq.com';
const READ_PATHS = new Set(['/cgi-bin/online_docs/user_info', '/dop-api/opendoc', '/dop-api/get/sheet', '/api/smartsheet/reader/fetch_view_filter_spec']);
type Raw = Record<string, any>;

export class WecomClient {
  private constructor(public readonly context: APIRequestContext, private cookies: { name: string; value: string; domain: string }[]) {}
  private schemas = new Map<string, { revision: number; schema: Schema }>();

  static async create() {
    let state: any;
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new WecomError('LOCAL_SECURITY_ERROR', '登录态必须是当前本机权限为 600 的普通文件。');
      state = JSON.parse(await readFile(statePath, 'utf8'));
      requireData(Array.isArray(state.cookies), '登录态文件结构错误。');
    } catch (error) {
      if (error instanceof WecomError) throw error;
      throw new WecomError('LOGIN_REQUIRED', '尚无可读取的本地登录态。请运行 npm run login -- "智能表格链接"。');
    }
    const context = await request.newContext({ storageState: state, timeout: 30000, ignoreHTTPSErrors: false });
    return new WecomClient(context, state.cookies);
  }

  cookie(name: string) {
    return this.cookies.find(c => {
      const domain = c.domain.replace(/^\./, '');
      return c.name === name && ('doc.weixin.qq.com' === domain || 'doc.weixin.qq.com'.endsWith(`.${domain}`));
    })?.value || '';
  }

  async json(path: string, params: Record<string, unknown> = {}, data?: unknown): Promise<Raw> {
    if (!READ_PATHS.has(path)) throw new WecomError('LOCAL_SECURITY_ERROR', '请求路径不在已验证的只读接口清单中。');
    const url = new URL(path, DOC);
    for (const [k, v] of Object.entries({ ...params, xsrf: this.cookie('TOK') })) if (v !== undefined) url.searchParams.set(k, String(v));
    let response;
    try {
      response = await this.context.fetch(url.href, { method: data === undefined ? 'GET' : 'POST', data,
        headers: { Referer: `${DOC}/`, Accept: 'application/json' }, maxRedirects: 0 });
    } catch { throw new WecomError('API_ERROR', '企业微信接口连接失败或超时。', { endpoint: path }); }
    try {
      if (response.status() === 401) throw new WecomError('AUTH_EXPIRED', '网页登录态已过期，请重新运行登录助手。');
      if (response.status() === 403) throw new WecomError('ACCESS_DENIED', '当前账号无权读取此文档或接口。');
      if (response.status() >= 300 && response.status() < 400) throw new WecomError('AUTH_REDIRECT', '接口重定向已被阻止，请重新确认登录态。');
      if (!response.ok()) throw new WecomError('API_ERROR', '企业微信接口返回 HTTP 错误。', { endpoint: path, http_status: response.status() });
      if (!response.headers()['content-type']?.includes('application/json')) throw new WecomError('PARSE_ERROR', '接口返回了网页或非 JSON 内容，没有当作文档数据。', { endpoint: path });
      const json = parseJson(await response.text(), '接口响应');
      const code = json.retcode ?? json.head?.ret ?? json.cgicode;
      if ([-20002, 12100].includes(code)) throw new WecomError('AUTH_EXPIRED', '网页登录态无效或已过期，请重新运行登录助手。');
      if (code !== undefined && code !== 0) throw new WecomError('API_ERROR', '企业微信接口返回业务错误。', { endpoint: path, business_code: code });
      return json;
    } finally { await response.dispose(); }
  }

  async checkSession() {
    const result = await this.json('/cgi-bin/online_docs/user_info', {}, {});
    if (result.retcode !== 0 || result.login !== true || result.expired !== 0) throw new WecomError('AUTH_EXPIRED', '网页登录态未通过真实用户接口验证。');
  }

  async chunk(docId: string, sheetId: string, start: number, count: number): Promise<Chunk> {
    const json = await this.json('/dop-api/get/sheet', {
      padId: docId, subId: sheetId, startrow: start, endrow: start + count - 1,
      outformat: 1, normal: 1, nowb: 1, needSheetState: 2, optimizedVer: 2,
      chunkCellSize: 15000, enableChunkRank: 1, enablePermOpt: 0,
    });
    requireData(json.retcode === 0, '读取记录响应缺少明确的成功码。');
    const chunk = parseChunk(json.data, sheetId, start, start + count - 1);
    if (chunk.schema) this.schemas.set(`${docId}/${sheetId}`, { revision: chunk.revision, schema: chunk.schema });
    return chunk;
  }

  async schema(docId: string, chunk: Chunk): Promise<Schema> {
    const cached = this.schemas.get(`${docId}/${chunk.sheetId}`);
    if (cached?.revision === chunk.revision) return cached.schema;
    const first = await this.chunk(docId, chunk.sheetId, 0, 1);
    if (first.revision !== chunk.revision) throw new WecomError('DOCUMENT_CHANGED', '读取期间表格发生变化，请从第一页重新读取。');
    requireData(first.schema, '首页未提供字段结构。');
    return first.schema;
  }

  async structure(input: string) {
    const doc = documentUrl(input);
    await this.checkSession();
    const params: Raw = { id: doc.id, normal: 1, noEscape: 1, outformat: 1, startrow: 0, endrow: 0,
      supportOptimizedVer: 2, enableSmartsheetSplit: 1, enableChunkRank: 1 };
    for (const key of ['scode', 'tab', 'viewId']) if (doc.url.searchParams.has(key)) params[key] = doc.url.searchParams.get(key);
    const open = await this.json('/dop-api/opendoc', params);
    if (open.clientVars?.privilegeAttribute?.can_read === 0) throw new WecomError('ACCESS_DENIED', '当前账号没有此文档的读取权限。');
    if (typeof open.padType === 'string' && open.padType !== 'smartsheet') throw new WecomError('UNSUPPORTED_TYPE', '服务端确认该文档不是智能表格。');
    requireData(open.padType === 'smartsheet', '服务端响应未确认文档类型。');
    requireData(open.clientVars?.privilegeAttribute?.can_read === 1, '文档响应未明确授予读取权限。');
    const directory = open.clientVars?.collab_client_vars?.header?.[0]?.d;
    requireData(Array.isArray(directory) && directory.every((s: Raw) => typeof s.id === 'string' && typeof s.type === 'string'), '缺少完整的子表目录。');
    const filterResponse = await this.json('/api/smartsheet/reader/fetch_view_filter_spec', {
      sid: this.cookie('wedoc_sid'), wedoc_xsrf: this.cookie('low_login_enable'),
    }, { pad_id: doc.id, ret_all: true, view_items: [] });
    requireData(filterResponse.retcode === 0 && Array.isArray(filterResponse.result?.view_items), '个人视图筛选响应不完整。');
    const filters = filterResponse.result.view_items.map((v: Raw) => ({ sheetId: v.sub_id, viewId: v.view_id,
      filter: v.data ? parseJson(Buffer.from(v.data, 'base64').toString('utf8'), '个人视图筛选') : null }));
    const sheets = [];
    for (const entry of directory.filter((s: Raw) => s.type === 'smartsheet')) {
      const chunk = await this.chunk(doc.id, entry.id, 0, 1);
      const schema = await this.schema(doc.id, chunk);
      sheets.push({ id: entry.id, name: entry.name, type: entry.type, parent_id: entry.parentid || null, hidden: entry.hidden,
        revision: chunk.revision, total_records_in_table: chunk.total, fields: schema.fields,
        views: schema.views.map(v => ({ ...v, personal_filter: filters.find((f: Raw) => f.sheetId === entry.id && f.viewId === v.id)?.filter || null })) });
    }
    return { document_id: doc.id, title: open.clientVars.title || open.clientVars.padTitle,
      record_scope: 'whole_table_accessible_to_current_user', view_filter_applied: false,
      note: '记录工具按整张子表读取；URL 中的 viewId 及个人/保存的视图筛选不作用于记录结果。服务端内容权限仍有效。',
      sheets, other_entries: directory.filter((s: Raw) => s.type !== 'smartsheet').map((s: Raw) => ({ id: s.id, name: s.name, type: s.type })) };
  }

  async readRecords(input: string, sheetId: string, pageSize: number, fields?: string[], cursor?: string) {
    const doc = documentUrl(input);
    let position: Raw | undefined;
    if (cursor) {
      position = parseJson(Buffer.from(cursor, 'base64url').toString('utf8'), '分页游标');
      if (position?.v !== 1 || position.document_id !== doc.id || position.sheet_id !== sheetId || !Number.isSafeInteger(position.offset) || position.offset < 1 || !Number.isSafeInteger(position.revision) || !Array.isArray(position.fields)) {
        throw new WecomError('INVALID_CURSOR', '游标不属于此文档和子表，或游标格式无效。');
      }
      if (fields && JSON.stringify(fields) !== JSON.stringify(position.fields)) throw new WecomError('INVALID_CURSOR', '后续页的字段选择必须与第一页一致。');
    }
    await this.checkSession();
    const chunk = await this.chunk(doc.id, sheetId, position?.offset || 0, pageSize);
    if (position && position.revision !== chunk.revision) throw new WecomError('STALE_CURSOR', '分页期间表格版本变化，请重新从第一页读取，避免漏行或重复行。');
    const schema = await this.schema(doc.id, chunk);
    const selected: string[] = fields || position?.fields || schema.fields.map(f => f.id);
    if (selected.some(id => !schema.fields.some(f => f.id === id))) throw new WecomError('UNKNOWN_FIELD', '字段选择包含不存在或不可读取的真实字段 ID。');
    const records = chunk.records.map(row => presentRecord(chunk, schema, row, doc.id, selected));
    const nextOffset = Math.min(chunk.end + 1, chunk.total);
    const hasMore = nextOffset < chunk.total;
    return { document_id: doc.id, sheet_id: sheetId, sheet_name: chunk.workbook.find(s => s.id === sheetId)?.name,
      revision: chunk.revision, scope: 'whole_table_accessible_to_current_user', view_filter_applied: false,
      ignored_url_view_id: doc.url.searchParams.get('viewId'), total_records: chunk.total,
      range: { start_index: chunk.start, end_index_exclusive: chunk.start + records.length }, ordering: 'server_chunk_order_not_ui_row_number', returned_count: records.length,
      columns: schema.fields.filter(f => selected.includes(f.id)), records, has_more: hasMore,
      next_cursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, document_id: doc.id, sheet_id: sheetId,
        offset: nextOffset, revision: chunk.revision, fields: selected })).toString('base64url') : null,
      limitations: ['第一版不执行视图筛选或自定义筛选。', '标记 unresolved 的派生字段尚未计算；没有用空值冒充计算结果。', 'not_returned 表示接口未返回该单元格，不能单凭此状态断言为空或排除内容权限影响。', '字段选择发生在本机，网页分块接口仍会返回该页的全部字段。'] };
  }

  async close() { await this.context.dispose(); }
}
