import { load } from 'cheerio';
import { parse } from 'acorn';
import { WecomClient } from './client.js';
import { WecomError, requireData } from './errors.js';
import type { Asset } from './protocol.js';

const DRIVE_PATHS = new Set(['/s', '/disk/apply_page']);
export function parseDrivePermission(html: string): Record<string, any> | null {
  const $ = load(html);
  const script = $('script').map((_, e) => $(e).text()).get().find(s => /var\s+xd_global_applyInitDate\s*=/.test(s));
  if (!script) return null;
  let ast: any;
  try { ast = parse(script, { ecmaVersion: 'latest' }); }
  catch { throw new WecomError('PARSE_ERROR', '微盘权限数据解析失败；没有执行网页脚本。'); }
  const declaration = ast.body.filter((n: any) => n.type === 'VariableDeclaration')
    .flatMap((n: any) => n.declarations).find((n: any) => n.id.name === 'xd_global_applyInitDate');
  requireData(declaration?.init?.type === 'ObjectExpression', '微盘权限页的静态数据结构变化。');
  const result: Record<string, unknown> = {};
  for (const property of declaration.init.properties) {
    requireData(property.type === 'Property' && property.key, '微盘静态对象出现未经验证的属性。');
    const key = property.key.value || property.key.name;
    if (!['has_login', 'apply_status', 'err_code'].includes(key)) continue;
    const node = property.value;
    if (node.type === 'Literal') result[key] = node.value;
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['Number', 'Boolean'].includes(node.callee.name)
      && node.arguments.length === 1 && node.arguments[0].type === 'Literal') {
      result[key] = node.callee.name === 'Number' ? Number(node.arguments[0].value) : Boolean(node.arguments[0].value);
    }
    else throw new WecomError('PARSE_ERROR', '微盘权限状态不是可验证的静态值。');
  }
  requireData(typeof result.has_login === 'boolean' && Number.isFinite(result.apply_status), '微盘权限数据缺少登录或授权状态。');
  return result;
}

export async function resolveWedrive(client: WecomClient, asset: Asset): Promise<string> {
  let source: URL;
  try { source = new URL(asset.url); } catch { throw new WecomError('PARSE_ERROR', '微盘附件来源不是已验证的 URL 格式。'); }
  if (source.protocol !== 'https:' || source.hostname !== 'drive.weixin.qq.com' || source.pathname !== '/s' || source.port || source.username || source.password) {
    throw new WecomError('UNSUPPORTED_ATTACHMENT_SOURCE', '第一版尚未验证此附件来源。', { source: asset.source || 'unknown' });
  }
  let url = source;
  for (let hops = 0; hops <= 6; hops++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hostname !== 'drive.weixin.qq.com' || !DRIVE_PATHS.has(url.pathname)) {
      throw new WecomError('UNSAFE_DOWNLOAD_URL', '微盘预览入口重定向到未经验证的目标，已阻止。');
    }
    let response;
    try { response = await client.context.get(url.href, { maxRedirects: 0 }); }
    catch { throw new WecomError('API_ERROR', '微盘附件入口连接失败或超时。'); }
    try {
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers().location;
        requireData(location, '微盘重定向缺少地址。');
        url = new URL(location, url);
        continue;
      }
      if (response.status() === 401) throw new WecomError('ATTACHMENT_LOGIN_REQUIRED', '微盘登录态无效或已过期。');
      if (response.status() === 403) throw new WecomError('ATTACHMENT_ACCESS_DENIED', '当前微盘账号未获该文件下载权限。');
      if (!response.ok()) throw new WecomError('API_ERROR', '微盘附件入口返回 HTTP 错误。', { http_status: response.status() });
      const permission = parseDrivePermission(await response.text());
      if (permission) {
        if (!permission.has_login) throw new WecomError('ATTACHMENT_LOGIN_REQUIRED', '文档登录态有效，但微盘还需要在本机单独登录。');
        if (permission.apply_status === 0) throw new WecomError('ATTACHMENT_ACCESS_DENIED', '已登录微盘，但该文件需要单独授权；不会申请权限或绕过授权。', { name: asset.name, size_bytes: asset.size });
        throw new WecomError('UNSUPPORTED_ATTACHMENT_RESPONSE', '微盘权限页返回尚未验证的授权状态；没有当作文件下载成功。');
      }
      throw new WecomError('UNSUPPORTED_ATTACHMENT_RESPONSE', '微盘原始下载响应尚未完成真实样本验证；没有将预览网页作为原始文件。');
    } finally { await response.dispose(); }
  }
  throw new WecomError('API_ERROR', '微盘附件入口重定向次数过多。');
}
