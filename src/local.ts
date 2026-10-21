import { chmod, lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WecomError } from './errors.js';

export const dataDir = resolve(process.env.WECOM_MCP_DATA_DIR || fileURLToPath(new URL('../.local/', import.meta.url)));
export const statePath = join(dataDir, 'state.json');
export const profilePath = join(dataDir, 'profile');

export async function privateDirectory(path = dataDir) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WecomError('LOCAL_SECURITY_ERROR', '本地数据目录不能是符号链接。');
  await chmod(path, 0o700);
  return path;
}

export async function saveState(value: unknown) {
  await privateDirectory();
  const temp = join(dataDir, `state-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temp, statePath);
}

export function documentUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new WecomError('INVALID_URL', '需要企业微信智能表格的 HTTPS 链接。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'doc.weixin.qq.com' || url.port || url.username || url.password) {
    throw new WecomError('INVALID_URL', '仅接受 https://doc.weixin.qq.com 上的智能表格链接。');
  }
  const match = /^\/smartsheet\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) throw new WecomError('UNSUPPORTED_TYPE', '第一版只支持企业微信智能表格，不支持普通文档、电子表格或收集表。');
  const canonical = new URL(`/smartsheet/${match[1]}`, url.origin);
  for (const key of ['scode', 'tab', 'viewId']) {
    const value = url.searchParams.get(key);
    if (value) canonical.searchParams.set(key, value);
  }
  return { id: match[1], url: canonical };
}
