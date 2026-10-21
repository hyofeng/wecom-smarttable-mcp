import { McpServer, isInputRequiredResult, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { WecomClient } from './client.js';
import { downloadAsset } from './assets.js';
import { failure, WecomError } from './errors.js';
import { AuthenticatedRequests } from './authenticated.js';

process.umask(0o077);
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const url = z.string().max(4096).describe('你有权限的 https://doc.weixin.qq.com/smartsheet/ 链接；不要传 Cookie 或 Token。');
const locator = z.strictObject({ document_id: id, sheet_id: id, record_id: id,
  chunk_start: z.number().int().min(0), chunk_size: z.number().int().min(1).max(200), field_id: id, asset_id: z.string().min(1).max(1024) });
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function toolRunner(server: McpServer, authentication: AuthenticatedRequests) {
  return async (tool: string, args: { url: string }, ctx: ServerContext,
    action: (client: WecomClient) => Promise<{ result: any; image?: { type: 'image'; data: string; mimeType: string } }>) => {
    try {
      const outcome = await authentication.run(server, ctx, tool, args, action);
      if (isInputRequiredResult(outcome)) return outcome;
      const { result, image } = outcome;
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 1024 * 1024) throw new WecomError('RESULT_TOO_LARGE', '本页结果超过 1 MiB，请减小 page_size 或选择更少字段；没有静默截断。');
      return { content: [{ type: 'text' as const, text }, ...(image ? [image] : [])], structuredContent: result };
    } catch (error) {
      const result = { error: failure(error) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  };
}

serveStdio(() => {
  const authentication = new AuthenticatedRequests();
  const server = new McpServer({ name: 'wecom-smarttable', version: '0.2.0' }, {
    requestState: { verify: authentication.verifyState },
    instructions: '只读访问当前用户已有权限的企业微信智能表格。直接传入用户本次给出的链接，自动复用本机登录态。未登录或过期时通过 MCP 表单请求用户确认，确认后打开专用浏览器，扫码完成自动继续原请求；不要索要 Cookie。先 structure，再按需分页读取；范围始终是整张子表，不应用 URL 视图筛选。只有 download 才下载文件。文字链接不是附件。未计算的派生字段明确标记。',
  });
  const run = toolRunner(server, authentication);
  process.stdin.once('end', () => authentication.close());
  server.registerTool('wecom_table_structure', { description: '读取智能表格的所有子表、字段、真实类型 ID、视图及个人筛选元数据；同时显示每张子表真实记录总数。', annotations,
    inputSchema: z.strictObject({ url }) }, (args, ctx) => run('wecom_table_structure', args, ctx, async client => ({ result: await client.structure(args.url) })));
  server.registerTool('wecom_read_records', { description: '按子表读取整表范围的一页记录，保留字段映射及图片/附件的完整 locator。支持字段 ID 选择和游标分页；不应用 URL 的视图筛选，不下载文件。', annotations,
    inputSchema: z.strictObject({ url, sheet_id: id, page_size: z.number().int().min(1).max(200).default(50),
      fields: z.array(id).min(1).max(500).optional(), cursor: z.string().max(16384).optional() }) },
    (args, ctx) => run('wecom_read_records', args, ctx, async client => ({ result: await client.readRecords(args.url, args.sheet_id, args.page_size, args.fields, args.cursor) })));
  server.registerTool('wecom_download_asset', { description: '按记录读取结果中的 locator 下载一张原图或原始附件到本机，并核验记录/字段归属。可返回 MCP 图片供 Codex 查看；不会下载任意正文链接。',
    annotations: { ...annotations, readOnlyHint: false },
    inputSchema: z.strictObject({ url, locator, inline_image: z.boolean().default(true) }) },
    (args, ctx) => run('wecom_download_asset', args, ctx, client => downloadAsset(client, args.url, args.locator, args.inline_image)));
  return server;
}, { onerror: () => { process.stderr.write('[wecom-smarttable] MCP transport error\n'); } });
