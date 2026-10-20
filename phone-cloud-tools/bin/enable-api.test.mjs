import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enableApi } from './enable-api.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
test('API helper keeps model credentials, backs up original env and reuses a strong connection key', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'hermes-api-config-')); t.after(() => rm(home, {recursive:true,force:true}));
  const original = '# existing provider\nMY_MODEL_KEY=private-fixture-key\nAPI_SERVER_KEY=short\nAPI_SERVER_HOST=0.0.0.0\n';
  await writeFile(path.join(home,'config.yaml'),'model:\n  provider: custom\n'); await writeFile(path.join(home,'.env'),original);
  const result = await enableApi(home); assert.equal(await readFile(result.backup,'utf8'),original); const env = await readFile(result.file,'utf8');
  assert.match(env,/MY_MODEL_KEY=private-fixture-key/); assert.match(env,/API_SERVER_HOST=127.0.0.1/); assert.match(env,/API_SERVER_KEY=[a-f0-9]{64}/);
  await enableApi(home); assert.equal(await readFile(result.file,'utf8'),env); assert.equal((await stat(result.file)).mode&0o777,0o600);
  assert.ok(!JSON.stringify(result).includes('private-fixture-key'));
});
test('API helper refuses unconfigured profiles and symlinks without modifying targets', async t => {
  const home = await mkdtemp(path.join(tmpdir(),'hermes-api-boundary-')); t.after(() => rm(home,{recursive:true,force:true}));
  await assert.rejects(enableApi(home)); await writeFile(path.join(home,'config.yaml'),'model: {}'); const target = path.join(home,'private'); await writeFile(target,'original'); await symlink(target,path.join(home,'.env'));
  await assert.rejects(enableApi(home)); assert.equal(await readFile(target,'utf8'),'original');
});

test('CLI accepts paths with spaces and preserves a quoted, existing bearer key', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'hermes profile ')); t.after(() => rm(home, { recursive:true, force:true }));
  const key = 'existing.key.with.dots.and.plus+0123456';
  await writeFile(path.join(home, 'config.yaml'), 'model: {}'); await writeFile(path.join(home, '.env'), 'API_SERVER_KEY="' + key + '"\nMODEL_KEY=unchanged\n');
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./enable-api.mjs', import.meta.url)), home]);
  assert.match(await readFile(path.join(home, '.env'), 'utf8'), /MODEL_KEY=unchanged/);
  assert.ok((await readFile(path.join(home, '.env'), 'utf8')).includes('API_SERVER_KEY=' + key)); assert.ok(!result.stdout.includes(key));
});
