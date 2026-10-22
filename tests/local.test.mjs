import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('默认资料目录在仓库外，显式配置仍然生效', async t => {
  const env = { ...process.env };
  delete env.WECOM_MCP_DATA_DIR;
  const code = `import {dataDir} from './dist/local.js';import {homedir} from 'node:os';import {join} from 'node:path';console.log(JSON.stringify({matchesDefault:dataDir===join(homedir(),'.local','share','wecom-smarttable-mcp'),insideRepo:dataDir.startsWith(process.cwd()+'/')}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }));
  assert.deepEqual(result, { matchesDefault: true, insideRepo: false });
  const dir = await mkdtemp(join(tmpdir(), 'wecom-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configured = execFileSync(process.execPath, ['--input-type=module', '-e', `import {dataDir} from './dist/local.js';console.log(dataDir===process.env.WECOM_MCP_DATA_DIR);`],
    { env: { ...env, WECOM_MCP_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(configured.trim(), 'true');
});
