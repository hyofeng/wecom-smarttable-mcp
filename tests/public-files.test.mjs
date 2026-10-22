import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';
import { inspectPublicFile } from '../scripts/check-public-files.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('私有文件与凭据被阻止，诊断不返回匹配值', () => {
  const token = ['ghp_', 'example'.repeat(5)].join('');
  const findings = inspectPublicFile('state.json', Buffer.from(JSON.stringify({ value: token })));
  assert.ok(findings.some(f => f.category === 'private_file'));
  assert.ok(findings.some(f => f.category === 'access_token'));
  assert.equal(JSON.stringify(findings).includes(token), false);
  assert.deepEqual(inspectPublicFile('.env.example', Buffer.from('EXAMPLE_VALUE=replace_me\n')), []);
});

test('检查解压后的真实夹具及嵌套 JSON，不把 Base64 当成脱敏', async () => {
  const input = JSON.parse(await readFile(new URL('fixtures/images-first-page.json', import.meta.url), 'utf8'));
  assert.deepEqual(inspectPublicFile('tests/fixtures/example.json', Buffer.from(JSON.stringify(input))), []);
  const block = input.data.initialAttributedText.text[0];
  const decoded = JSON.parse(inflateSync(Buffer.from(block.smartsheet, 'base64')));
  const privatePath = ['/', 'Users', '/', 'example-account', '/', 'private-file'].join('');
  decoded[0][0].privacy_check = JSON.stringify({ private_path: privatePath });
  block.smartsheet = deflateSync(Buffer.from(JSON.stringify(decoded))).toString('base64');
  const findings = inspectPublicFile('tests/fixtures/example.json', Buffer.from(JSON.stringify(input)));
  assert.ok(findings.some(f => f.category === 'personal_path'));
  assert.equal(JSON.stringify(findings).includes(privatePath), false);
});

test('业务标签和未匿名化标识不能重新进入真实夹具', () => {
  const input = { sheetId: ['real', '-business-id'].join(''), label: 'private-business-label' };
  assert.ok(inspectPublicFile('tests/fixtures/example.json', Buffer.from(JSON.stringify(input)))
    .some(f => f.category === 'unredacted_fixture_value'));
});

test('真实 Git 索引与历史检查：不混淆未暂存内容，并检查作者邮箱', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-public-git-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const script = fileURLToPath(new URL('../scripts/check-public-files.mjs', import.meta.url));
  const check = option => spawnSync(process.execPath, [script, option], { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.name', 'example']);
  git(['config', 'user.email', 'example@users.noreply.github.com']);
  await writeFile(join(dir, 'example.txt'), 'safe example\n');
  git(['add', '--', 'example.txt']);
  assert.equal(check('--staged').status, 0);
  const token = ['ghp_', 'example'.repeat(5)].join('');
  await writeFile(join(dir, 'example.txt'), token);
  assert.equal(check('--staged').status, 0, '暂存检查只读取真正待提交的内容');
  git(['add', '--', 'example.txt']);
  const blocked = check('--staged');
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stderr.includes(token), false);
  await writeFile(join(dir, 'example.txt'), 'safe example\n');
  git(['add', '--', 'example.txt']);
  git(['commit', '-qm', 'safe example']);
  assert.equal(check('--history').status, 0);
  git(['-c', 'user.email=example@example.invalid', 'commit', '--allow-empty', '-qm', 'email boundary']);
  const history = check('--history');
  assert.equal(history.status, 1);
  assert.ok(history.stderr.includes('commit_email_not_noreply'));
  assert.equal(history.stderr.includes('example@example.invalid'), false);
});
