import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync, gunzipSync } from 'node:zlib';

const MAX_BYTES = 64 * 1024 * 1024;
const patterns = [
  ['personal_path', /\/(?:Users|home)\/[^/\s"'<>]+\//],
  ['personal_path', /[A-Za-z]:\\Users\\[^\\\s"'<>]+\\/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['access_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,})/],
  ['credential_url', /https?:\/\/[^\s/]+:[^\s/@]+@/],
  ['share_or_download_secret', /[?&](?:scode|access_token|token|signature|auth_key|agent_code)=[^\s"&]{4,}/i],
  ['session_cookie', /(?:wedoc_sid|low_login_enable|TOK)\s*[=:]\s*["']?[A-Za-z0-9_%+-]{12,}/],
];
const safeFixtureStrings = new Set(['smartsheet', 'sheet', 'folder', 'SS_File', 'Wedrive', 'pdf', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp']);

export function inspectPublicFile(path, input) {
  const findings = [];
  const add = (category, line = 1) => {
    if (!findings.some(f => f.category === category && f.line === line)) findings.push({ path, line, category });
  };
  const parts = path.split('/');
  const name = parts.at(-1);
  if (parts.some(p => ['.local', '.backups', 'profile', 'downloads', 'node_modules', 'dist'].includes(p))
    || (name.startsWith('.env') && name !== '.env.example')
    || /^(?:state(?:-.*)?\.(?:json|tmp)|storage-state.*\.json|cookies?.*\.json|target(?:-.*)?\.json|\.npmrc)$/.test(name)
    || /\.(?:pem|key|p12|pfx|bundle)$/.test(name)) add('private_file');
  if (input.length > MAX_BYTES) { add('file_too_large_to_scan'); return findings; }
  if (input.includes(0)) { add('binary_requires_private_review'); return findings; }
  const scanText = text => {
    for (const [category, expression] of patterns) {
      const match = expression.exec(text);
      if (match) add(category, text.slice(0, match.index).split('\n').length);
    }
  };
  const fixture = /^tests\/fixtures\/.*\.json$/.test(path);
  const visit = (value, depth = 0) => {
    if (depth > 32) { add('nested_payload_too_deep'); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'cookies' && Array.isArray(item) && item.length) add('session_state');
        if (fixture && /^[fr][A-Za-z0-9]{5}$/.test(key)) add('unredacted_fixture_identifier');
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof value !== 'string') return;
    scanText(value);
    try {
      const nested = JSON.parse(value);
      if (nested && typeof nested === 'object') { visit(nested, depth + 1); return; }
    } catch {}
    if (value.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(value)) {
      const bytes = Buffer.from(value, 'base64');
      if (bytes[0] === 0x78 || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
        try {
          const decoded = (bytes[0] === 0x78 ? inflateSync : gunzipSync)(bytes, { maxOutputLength: MAX_BYTES }).toString('utf8');
          scanText(decoded);
          visit(JSON.parse(decoded), depth + 1);
        } catch { add('compressed_payload_unreadable'); }
        return;
      }
    }
    if (fixture && !safeFixtureStrings.has(value)
      && !/^(?:id_example_|value_example_|file-example-)/.test(value)
      && !/^https:\/\/(?:wdcdn\.qpic\.cn|doc\.weixin\.qq\.com|drive\.weixin\.qq\.com)\/redacted\//.test(value)
      && !/^\*ss\*\[redacted-reference-/.test(value)
      && !/^#[0-9a-f]{6,8}$/i.test(value)) add('unredacted_fixture_value');
  };
  const text = input.toString('utf8');
  scanText(text);
  try { visit(JSON.parse(text)); }
  catch { if (fixture) add('fixture_json_unreadable'); }
  return findings;
}

function git(args) {
  return execFileSync('git', args, { maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--history', '--staged'].includes(arg)) || args.length > 1) throw new Error('Usage: node scripts/check-public-files.mjs [--history|--staged]');
  const history = args.includes('--history');
  const staged = args.includes('--staged');
  const findings = [];
  const seen = new Set();
  const revisions = history ? git(['rev-list', '--all']).toString().trim().split('\n').filter(Boolean) : [null];
  for (const revision of revisions) {
    if (revision) {
      const [author, committer] = git(['show', '-s', '--format=%ae%n%ce', revision]).toString().trim().split('\n');
      if (![author, committer].every(email => email.endsWith('@users.noreply.github.com'))) findings.push({ revision: revision.slice(0, 8), category: 'commit_email_not_noreply' });
      const message = git(['show', '-s', '--format=%B', revision]);
      findings.push(...inspectPublicFile('commit-message.txt', message).map(f => ({ ...f, revision: revision.slice(0, 8) })));
    }
    const entries = git(revision ? ['ls-tree', '-r', '-z', revision] : ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
    for (const entry of entries) {
      const [metadata, path] = entry.split('\t');
      const [mode, , treeHash] = metadata.split(' ');
      const hash = revision ? treeHash : metadata.split(' ')[1];
      if (mode === '120000') { findings.push({ path, category: 'tracked_symlink', ...(revision ? { revision: revision.slice(0, 8) } : {}) }); continue; }
      if (!revision && !staged && lstatSync(path).isSymbolicLink()) { findings.push({ path, category: 'tracked_symlink' }); continue; }
      const key = `${path}:${hash}`;
      if (revision && seen.has(key)) continue;
      seen.add(key);
      const data = revision || staged ? git(['cat-file', 'blob', hash]) : readFileSync(path);
      findings.push(...inspectPublicFile(path, data).map(f => revision ? { ...f, revision: revision.slice(0, 8) } : f));
    }
  }
  if (findings.length) {
    // 只输出类别与相对位置，不输出匹配到的凭据、路径值或业务内容。
    process.stderr.write(`${JSON.stringify({ public_file_check: 'failed', findings }, null, 2)}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${JSON.stringify({ public_file_check: 'passed', history, staged, revisions: revisions.length, blobs: seen.size })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch { process.stderr.write('Public file check could not complete; no scan success is claimed.\n'); process.exitCode = 1; }
}
