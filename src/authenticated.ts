import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, createRequestStateCodec, inputRequired, inputResponse,
  type ClientCapabilities, type InputRequiredResult, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { WecomClient } from './client.js';
import { WecomError } from './errors.js';
import { documentUrl } from './local.js';
import { BrowserLogin } from './login-browser.js';

const confirmationSchema = z.strictObject({ confirm: z.boolean() });
const confirmationKey = 'wecom_login';
interface LoginIntent { requestHash: string }

export class AuthenticatedRequests {
  private readonly browser = new BrowserLogin();
  private readonly codec = createRequestStateCodec<LoginIntent>({ key: randomBytes(32), ttlSeconds: 1200 });
  readonly verifyState = this.codec.verify;

  private async execute<T>(action: (client: WecomClient) => Promise<T>) {
    const client = await WecomClient.create();
    try { return await action(client); } finally { await client.close(); }
  }

  async run<T>(server: McpServer, ctx: ServerContext, tool: string, args: { url?: string; [key: string]: unknown }, action: (client: WecomClient) => Promise<T>): Promise<T | InputRequiredResult> {
    if (args.url !== undefined) documentUrl(args.url);
    const requestHash = createHash('sha256').update(JSON.stringify([tool, args])).digest('hex');
    const answer = inputResponse(ctx.mcpReq.inputResponses, confirmationKey);
    let approved = false;
    if (answer.kind !== 'missing') {
      const intent = ctx.mcpReq.requestState<LoginIntent>();
      if (intent?.requestHash !== requestHash) throw new WecomError('LOGIN_REQUEST_CHANGED', '登录确认与原请求不匹配，请重新发起操作。');
      if (answer.kind !== 'elicit') throw new WecomError('LOGIN_RESPONSE_INVALID', '登录确认不是有效的表单响应。');
      if (answer.action !== 'accept') throw new WecomError('LOGIN_CANCELLED', '已取消登录，未打开浏览器或继续原操作。');
      const content = acceptedContent(ctx.mcpReq.inputResponses, confirmationKey, confirmationSchema);
      if (!content) throw new WecomError('LOGIN_RESPONSE_INVALID', '登录确认缺少有效的确认选项。');
      if (!content.confirm) throw new WecomError('LOGIN_CANCELLED', '未同意打开登录窗口，未继续原操作。');
      approved = true;
    }
    try { return await this.execute(action); }
    catch (error) {
      if (!(error instanceof WecomError) || !['LOGIN_REQUIRED', 'AUTH_EXPIRED'].includes(error.code)) throw error;
      if (!approved) {
        const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities> | undefined;
        const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] || server.server.getClientCapabilities();
        const elicitation = capabilities?.elicitation;
        const supportsForm = elicitation && (elicitation.form !== undefined || Object.keys(elicitation).length === 0);
        if (!supportsForm) throw new WecomError(error.code, '需要登录，但当前客户端不支持 MCP 表单确认。请让 Codex 启动本机登录助手后重试；无需提供 Cookie。', {
          interactive_login_available: false, login_helper: fileURLToPath(new URL('./login.js', import.meta.url)),
        });
        return inputRequired({
          requestState: await this.codec.mint({ requestHash }),
          inputRequests: { [confirmationKey]: inputRequired.elicit({
            message: '企业微信尚未登录或登录已过期。是否打开本机专用 Chrome 窗口？请手动扫码或登录，成功后会自动继续刚才的智能表格请求。登录态只保存在本机，无需填写 Cookie 或 Token。',
            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: '打开企业微信登录窗口', default: true } }, required: ['confirm'] },
          }) },
        });
      }
    }
    await this.browser.login(args.url, ctx.mcpReq.signal);
    // 只重试原操作一次；权限、协议或再次过期错误均按实际错误返回。
    return this.execute(action);
  }

  close() { this.browser.close(); }
}
