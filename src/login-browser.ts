import { chromium } from 'playwright';
import { documentUrl, privateDirectory, profilePath, saveState } from './local.js';
import { WecomError } from './errors.js';
import { WecomClient } from './client.js';

export async function loginWithBrowser(input: string, signal?: AbortSignal) {
  const target = documentUrl(input);
  if (signal?.aborted) throw new WecomError('LOGIN_CANCELLED', '登录请求已取消。');
  await privateDirectory();
  await privateDirectory(profilePath);
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chrome', headless: false, acceptDownloads: false, serviceWorkers: 'block',
    });
  } catch {
    throw new WecomError('LOGIN_BROWSER_FAILED', '无法启动专用 Chrome 登录窗口。请确认已安装 Chrome，且该专用窗口未被其他进程占用。');
  }
  const page = context.pages()[0] || await context.newPage();
  let settled = false;
  let verifying = false;
  let timer: NodeJS.Timeout;
  let complete: (error?: unknown) => void;
  const finish = new Promise<void>((resolve, reject) => {
    complete = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    timer = setTimeout(() => complete(new WecomError('LOGIN_TIMEOUT', '15 分钟内未确认登录完成，请重新发起读取。')), 15 * 60 * 1000);
  });
  const cancel = () => complete(new WecomError('LOGIN_CANCELLED', '登录已取消，未继续读取原请求。'));
  context.once('close', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  page.on('response', async response => {
    const url = new URL(response.url());
    if (settled || verifying || url.hostname !== 'doc.weixin.qq.com' || url.pathname !== '/cgi-bin/online_docs/user_info') return;
    const data = await response.json().catch(() => null);
    // 登录属于账号；文档权限由恢复后的原操作独立检查。
    if (data?.retcode !== 0 || data.login !== true || data.expired !== 0) return;
    verifying = true;
    try {
      const state = await context.storageState();
      const domains = new Set(['doc.weixin.qq.com', 'drive.weixin.qq.com', 'work.weixin.qq.com', 'weixin.qq.com']);
      await saveState({ cookies: state.cookies.filter(c => domains.has(c.domain.replace(/^\./, ''))), origins: [] });
      const client = await WecomClient.create();
      try { await client.checkSession(); } finally { await client.close(); }
      complete();
    } catch (error) { complete(error); }
  });
  try {
    if (signal?.aborted) cancel();
    const navigation = settled ? Promise.resolve() : page.goto(target.url.href, { waitUntil: 'domcontentloaded' })
      .catch(() => { throw new WecomError('LOGIN_NAVIGATION_FAILED', '登录页面无法加载，请重新发起读取。'); });
    await Promise.all([finish, navigation]);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', cancel);
    context.removeListener('close', cancel);
    await context.close();
  }
}

/** 同一 MCP 进程的并发请求共用一个登录窗口；所有等待者取消时关闭窗口。 */
export class BrowserLogin {
  private pending?: { promise: Promise<void>; controller: AbortController; waiters: number };

  async login(url: string, signal: AbortSignal) {
    if (signal.aborted) throw new WecomError('LOGIN_CANCELLED', '登录请求已取消。');
    if (!this.pending) {
      const controller = new AbortController();
      const operation = { controller, waiters: 0, promise: Promise.resolve() };
      operation.promise = loginWithBrowser(url, controller.signal).finally(() => {
        if (this.pending === operation) this.pending = undefined;
      });
      this.pending = operation;
    }
    const operation = this.pending;
    operation.waiters++;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', cancel);
        operation.waiters--;
        if (this.pending === operation && operation.waiters === 0) operation.controller.abort();
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new WecomError('LOGIN_CANCELLED', '登录请求已取消。'));
      signal.addEventListener('abort', cancel, { once: true });
      operation.promise.then(() => finish(), finish);
      if (signal.aborted) cancel();
    });
  }

  close() { this.pending?.controller.abort(); }
}
