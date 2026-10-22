import type { APIRequestContext } from 'playwright';
import { CookieJar } from 'tough-cookie';
import { open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { WecomError, requireData } from './errors.js';

export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(['wdcdn.qpic.cn']);

export function validatedDownloadUrl(input: string, allowFirstParty = false) {
  let url: URL;
  try { url = new URL(input); } catch { throw new WecomError('UNSAFE_DOWNLOAD_URL', '文件地址无效。'); }
  const keys = [...url.searchParams.keys()];
  const singleKeys = new Set(keys).size === keys.length;
  const documentDownload = allowFirstParty && singleKeys && url.hostname === 'doc.weixin.qq.com' && (
    (url.pathname === '/webdisk/download' && url.searchParams.get('func') === '10'
      && Boolean(url.searchParams.get('doc_id')) && url.searchParams.get('store_id')?.startsWith('*ss*')
      && keys.every(k => ['func', 'doc_id', 'store_id', 'name'].includes(k))) ||
    (url.pathname === '/diskagent/download' && url.searchParams.get('scene') === 'web' && Boolean(url.searchParams.get('agent_code'))
      && keys.every(k => ['scene', 'agent_code'].includes(k))));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (!DOWNLOAD_HOSTS.has(url.hostname) && !documentDownload)) {
    throw new WecomError('UNSAFE_DOWNLOAD_URL', '文件或重定向目标不在已实测的 HTTPS 下载域名清单中。');
  }
  return url;
}

/** Cookie 由现有 Playwright 会话按域、路径及有效期选择，不转发给 CDN。 */
export async function downloadHeaders(context: APIRequestContext, url: URL) {
  const headers = new Headers({ 'Accept-Encoding': 'identity' });
  if (url.hostname === 'doc.weixin.qq.com' && url.protocol === 'https:') {
    const cookies = await context.cookies(url.href);
    if (cookies.length) headers.set('Cookie', cookies.map(c => `${c.name}=${c.value}`).join('; '));
  }
  return headers;
}

/** 保留原请求上下文对 Set-Cookie 的处理；解析器校验来源域、路径和到期时间。 */
export async function acceptDownloadCookies(context: APIRequestContext, url: URL, headers: Headers) {
  if (url.hostname !== 'doc.weixin.qq.com' || url.protocol !== 'https:') return;
  const jar = new CookieJar(undefined, { prefixSecurity: 'strict' });
  for (const header of headers.getSetCookie()) {
    // 浏览器同样不接受无效或越域 Cookie，不将它们降格为其他域的凭据。
    const cookie = await jar.setCookie(header, url.href, { ignoreError: true });
    if (!cookie?.domain || !cookie.path) continue;
    const expires = cookie.expiryTime();
    await context.addCookies([{
      name: cookie.key, value: cookie.value,
      domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`, path: cookie.path,
      expires: expires === undefined || expires === Infinity ? -1 : Math.max(0, Math.floor(expires / 1000)),
      httpOnly: cookie.httpOnly, secure: cookie.secure,
      sameSite: cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite === 'none' ? 'None' : 'Lax',
    }]);
  }
}

/** 从真实 Response 流写入新文件；计数和哈希不积累完整文件内容。 */
export async function streamResponseToFile(response: Response, path: string, maxBytes = MAX_DOWNLOAD_BYTES, signal?: AbortSignal) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(maxBytes)) {
      throw new WecomError('FILE_TOO_LARGE', '文件超过下载大小上限，已中止传输。');
    }
    requireData(response.body, '下载响应没有正文。');
    file = await open(path, 'wx', 0o600);
    let size = 0;
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) return callback(new WecomError('FILE_TOO_LARGE', '文件超过下载大小上限，已中止传输。'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as ReadableStream), meter, file.createWriteStream(), { signal });
    return { size, sha256: hash.digest('hex') };
  } catch (error) {
    if (file) {
      await file.close();
      await rm(path, { force: true });
    }
    if (error instanceof WecomError) throw error;
    throw new WecomError('DOWNLOAD_FAILED', '文件传输、写入失败或请求已取消；未保留部分文件。');
  } finally {
    await file?.close();
    await response.body?.cancel().catch(() => {});
  }
}

export async function downloadToFile(context: APIRequestContext, input: string, allowFirstParty: boolean, path: string, signal?: AbortSignal) {
  let url = validatedDownloadUrl(input, allowFirstParty);
  const timeout = AbortSignal.timeout(60000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let redirects = 0; redirects <= 5; redirects++) {
    let response: Response;
    try {
      response = await fetch(url, { headers: await downloadHeaders(context, url), redirect: 'manual', signal: deadline });
    } catch { throw new WecomError('DOWNLOAD_FAILED', '文件下载连接失败、超时或请求已取消。'); }
    try {
      await acceptDownloadCookies(context, url, response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        requireData(location, '附件下载重定向缺少目标。');
        url = validatedDownloadUrl(new URL(location, url).href, allowFirstParty);
        continue;
      }
      if (url.hostname === 'doc.weixin.qq.com' && response.status === 401) throw new WecomError('AUTH_EXPIRED', '附件下载时登录态已过期，请重新登录。');
      if (url.hostname === 'doc.weixin.qq.com' && response.status === 403) throw new WecomError('ATTACHMENT_ACCESS_DENIED', '当前账号没有该附件的下载权限。');
      if ([403, 410].includes(response.status)) throw new WecomError('DOWNLOAD_EXPIRED', '文件下载地址失效或被拒绝。');
      if (!response.ok) throw new WecomError('DOWNLOAD_FAILED', '文件下载返回 HTTP 错误。', { http_status: response.status });
      const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      if (contentType === 'text/html' || contentType === 'application/json') throw new WecomError('DOWNLOAD_FAILED', '下载返回了网页或业务错误，没有保存为原始文件。');
      return { ...await streamResponseToFile(response, path, MAX_DOWNLOAD_BYTES, deadline), contentType };
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  throw new WecomError('DOWNLOAD_FAILED', '文件重定向次数过多。');
}
