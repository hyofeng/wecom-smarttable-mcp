import { loginWithBrowser } from './login-browser.js';
import { failure } from './errors.js';

process.umask(0o077);
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
console.error('请在专用 Chrome 窗口中手动扫码或登录；无需复制 Cookie。此工具不会操作文档内容。');
loginWithBrowser(process.argv[2] || '', controller.signal)
  .then(() => console.error('登录态已保存，并通过真实用户接口验证。可以使用 MCP。'))
  .catch(error => { console.error(JSON.stringify(failure(error))); process.exitCode = 1; })
  .finally(() => { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); });
