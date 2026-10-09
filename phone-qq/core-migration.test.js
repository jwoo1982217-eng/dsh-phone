import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { migratePhoneCore } from './core-migration.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-core-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = path.join(root, 'tree'), home = path.join(root, 'home');
  const profile = path.join(home, 'profiles/phone');
  async function pkg(base, name, version, source = '') {
    const dir = path.join(base, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }));
    await writeFile(path.join(dir, 'index.js'), source);
  }
  await pkg(tree, '@deepseek-ai/dsh', '0.2.1-alpha.1');
  await pkg(tree, '@deepseek-ai/dsh-llm', '0.2.1-alpha.1', 'export const ToolCallId = id => id;');
  await pkg(profile, '@deepseek-ai/dsh-llm', '0.1.0-rc.8', 'export const CallId = id => id;');
  await pkg(profile, '@deepseek-ai/user-plugin', '1.0.0', 'export const custom = true;');
  await pkg(profile, 'user-plugin', '1.0.0', 'export const custom = true;');
  const probe = path.join(profile, 'probe.mjs');
  await writeFile(probe, "import { ToolCallId } from '@deepseek-ai/dsh-llm'; console.log(ToolCallId('works'));");
  await symlink(path.join(tree, 'node_modules'), path.join(home, 'node_modules'), 'dir');
  const personal = ['profiles/phone/package.json', 'credentials.json', 'sessions/history', 'peer/paired.json'];
  for (const file of personal) {
    const target = path.join(home, file); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ marker: 'preserve ' + file }));
  }
  return { tree, home, profile, probe, personal };
}

test('an existing rc.8 profile resolves the shipped SDK after upgrade; data and user plugins survive', async t => {
  const f = await fixture(t);
  assert.throws(() => execFileSync(process.execPath, [f.probe], { stdio: 'pipe' }), /ToolCallId/);
  const result = await migratePhoneCore(f.tree, f.home);
  assert.deepEqual(result.migrated, ['@deepseek-ai/dsh-llm']);
  assert.equal(execFileSync(process.execPath, [f.probe], { encoding: 'utf8' }).trim(), 'works');
  for (const file of f.personal) assert.equal(await readFile(path.join(f.home, file), 'utf8'), JSON.stringify({ marker: 'preserve ' + file }));
  for (const name of ['user-plugin', '@deepseek-ai/user-plugin']) assert.ok((await lstat(path.join(f.profile, 'node_modules', name))).isDirectory());
  const backups = await readdir(path.join(f.home, '.phone-core-backups'));
  const saved = path.join(f.home, '.phone-core-backups', backups[0], 'profiles/phone/node_modules/@deepseek-ai/dsh-llm');
  assert.equal(JSON.parse(await readFile(path.join(saved, 'package.json'))).version, '0.1.0-rc.8');
  assert.deepEqual((await migratePhoneCore(f.tree, f.home)).migrated, []);
  assert.deepEqual(await readdir(path.join(f.home, '.phone-core-backups')), backups);
});

test('a malformed official package aborts migration before any package is moved', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm/package.json'), JSON.stringify({ name: 'user-replacement', version: '1' }));
  await assert.rejects(migratePhoneCore(f.tree, f.home), /Cannot safely migrate/);
  assert.ok((await lstat(path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm'))).isDirectory());
  await assert.rejects(readdir(path.join(f.home, '.phone-core-backups')), { code: 'ENOENT' });
});

test('a clean installation requires no profile SDK copies or backup', async t => {
  const f = await fixture(t);
  await rm(path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm'), { recursive: true });
  assert.deepEqual((await migratePhoneCore(f.tree, f.home)).migrated, []);
  assert.equal(execFileSync(process.execPath, [f.probe], { encoding: 'utf8' }).trim(), 'works');
});

test('an old shared profiles SDK is upgraded even when the active profile has no SDK copies', async t => {
  const f = await fixture(t);
  const local = path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm');
  const shared = path.join(f.home, 'profiles/node_modules/@deepseek-ai/dsh-llm');
  await mkdir(path.dirname(shared), { recursive: true });
  await rename(local, shared);
  assert.throws(() => execFileSync(process.execPath, [f.probe], { stdio: 'pipe' }), /ToolCallId/);
  const result = await migratePhoneCore(f.tree, f.home);
  assert.deepEqual(result.migrated, ['@deepseek-ai/dsh-llm']);
  assert.deepEqual(result.locations, ['profiles/node_modules/@deepseek-ai/dsh-llm']);
  assert.equal(execFileSync(process.execPath, [f.probe], { encoding: 'utf8' }).trim(), 'works');
  assert.deepEqual((await migratePhoneCore(f.tree, f.home)).migrated, []);
});

test('physical home dependencies and shared copies are both migrated with separate recoverable backups', async t => {
  const f = await fixture(t);
  await rm(path.join(f.home, 'node_modules'));
  const local = path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm');
  for (const base of [path.join(f.home, 'profiles'), f.home]) {
    const directory = path.join(base, 'node_modules/@deepseek-ai/dsh-llm');
    await mkdir(directory, { recursive: true });
    for (const file of ['package.json', 'index.js']) await writeFile(path.join(directory, file), await readFile(path.join(local, file)));
  }
  const custom = path.join(f.home, 'node_modules/user-root-plugin');
  await mkdir(custom); await writeFile(path.join(custom, 'marker'), 'user plugin stays');
  const result = await migratePhoneCore(f.tree, f.home);
  assert.equal(result.locations.length, 3);
  const [snapshot] = await readdir(path.join(f.home, '.phone-core-backups'));
  for (const location of result.locations) {
    assert.equal(JSON.parse(await readFile(path.join(f.home, '.phone-core-backups', snapshot, location, 'package.json'))).version, '0.1.0-rc.8');
  }
  assert.equal(await readFile(path.join(custom, 'marker'), 'utf8'), 'user plugin stays');
  assert.equal(execFileSync(process.execPath, [f.probe], { encoding: 'utf8' }).trim(), 'works');
});

test('a broken old SDK projection is repaired while a current canonical link needs no backup', async t => {
  const f = await fixture(t), local = path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm');
  await rm(local, { recursive: true });
  await symlink(path.join(f.home, 'removed-old-runtime/dsh-llm'), local, 'dir');
  assert.deepEqual((await migratePhoneCore(f.tree, f.home)).migrated, ['@deepseek-ai/dsh-llm']);
  assert.equal(execFileSync(process.execPath, [f.probe], { encoding: 'utf8' }).trim(), 'works');
  assert.deepEqual((await migratePhoneCore(f.tree, f.home)).migrated, []);
});

test('a mixed deployment SDK is refused before any old profile dependency moves', async t => {
  const f = await fixture(t), canonical = path.join(f.tree, 'node_modules/@deepseek-ai/dsh-llm/package.json');
  const metadata = JSON.parse(await readFile(canonical)); metadata.version = '0.1.0-rc.8';
  await writeFile(canonical, JSON.stringify(metadata));
  await assert.rejects(migratePhoneCore(f.tree, f.home), /Phone SDK version mismatch/);
  assert.ok((await lstat(path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm'))).isDirectory());
  await assert.rejects(readdir(path.join(f.home, '.phone-core-backups')), { code: 'ENOENT' });
});

test('two ancestor paths sharing one scope migrate its entries only once', async t => {
  const f = await fixture(t), shared = path.join(f.home, 'profiles/node_modules');
  await mkdir(shared);
  await symlink(path.join(f.profile, 'node_modules/@deepseek-ai'), path.join(shared, '@deepseek-ai'), 'dir');
  const result = await migratePhoneCore(f.tree, f.home);
  assert.deepEqual(result.locations, ['profiles/phone/node_modules/@deepseek-ai/dsh-llm']);
  assert.equal(execFileSync(process.execPath, [f.probe], { encoding: 'utf8' }).trim(), 'works');
});

test('an SDK scope pointing outside the phone home is left untouched', async t => {
  const f = await fixture(t), scope = path.join(f.profile, 'node_modules/@deepseek-ai');
  const outside = path.join(f.tree, 'user-external-sdk');
  await rename(scope, outside); await symlink(outside, scope, 'dir');
  await assert.rejects(migratePhoneCore(f.tree, f.home), /outside phone home/);
  assert.equal(JSON.parse(await readFile(path.join(outside, 'dsh-llm/package.json'))).version, '0.1.0-rc.8');
});

for (const upgraded of [false, true]) {
  test(`the absolute CLI entrypoint works through a directory alias on ${upgraded ? 'upgrade' : 'fresh install'}`, async t => {
    const f = await fixture(t);
    if (!upgraded) await rm(path.join(f.profile, 'node_modules/@deepseek-ai/dsh-llm'), { recursive: true });
    await writeFile(path.join(f.tree, 'core-migration.mjs'), await readFile(new URL('./core-migration.js', import.meta.url)));
    const alias = path.join(path.dirname(f.tree), 'tree-alias');
    await symlink(f.tree, alias, 'dir');
    const output = execFileSync(process.execPath, [path.join(alias, 'core-migration.mjs')], {
      cwd: alias, env: { ...process.env, DSH_HOME: f.home }, encoding: 'utf8'
    });
    const report = JSON.parse(output).phoneCoreMigration;
    assert.equal(report.version, '0.2.1-alpha.1');
    assert.deepEqual(report.migrated, upgraded ? ['@deepseek-ai/dsh-llm'] : []);
    assert.equal(execFileSync(process.execPath, [f.probe], { encoding: 'utf8' }).trim(), 'works');
  });
}

test('a directory alias cannot silently bypass CLI SDK validation', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.tree, 'core-migration.mjs'), await readFile(new URL('./core-migration.js', import.meta.url)));
  await writeFile(path.join(f.tree, 'node_modules/@deepseek-ai/dsh-llm/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.1.0-rc.8' }));
  const alias = path.join(path.dirname(f.tree), 'tree-alias');
  await symlink(f.tree, alias, 'dir');
  assert.throws(() => execFileSync(process.execPath, [path.join(alias, 'core-migration.mjs')], {
    cwd: alias, env: { ...process.env, DSH_HOME: f.home }, stdio: 'pipe'
  }), /Phone SDK version mismatch/);
});
