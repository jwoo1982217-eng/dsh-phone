import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installDesktopPocket } from './install-desktop-pocket.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-pocket-install-'));
  const profile = path.join(directory, 'profile'), modules = path.join(directory, 'modules');
  await mkdir(path.join(profile, 'node_modules'), { recursive: true });
  await mkdir(modules);
  await symlink(path.resolve('desktop-runtime/node_modules/dsh-pocket'), path.join(modules, 'dsh-pocket'));
  const manifest = JSON.stringify({ dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: ['existing'] } } });
  await writeFile(path.join(profile, 'package.json'), manifest);
  await writeFile(path.join(profile, 'credentials-marker'), 'keep');
  t.after(async () => { await chmod(profile, 0o700); await rm(directory, { recursive: true, force: true }); });
  return { profile, modules, manifest };
}

test('fresh Pocket install uses the pinned real package and preserves other settings', async t => {
  const { profile, modules } = await fixture(t);
  assert.equal((await installDesktopPocket(profile, modules)).version, '2.10.6');
  const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['existing', 'dsh-pocket']);
  assert.equal(manifest.dependencies.existing, '1.0.0');
  assert.equal(await readFile(path.join(profile, 'credentials-marker'), 'utf8'), 'keep');
  assert.equal(await realpath(path.join(profile, 'node_modules/dsh-pocket')), await realpath(path.join(modules, 'dsh-pocket')));
});

test('reinstall preserves an existing Pocket version and disabled Cordis entry', async t => {
  const { profile, modules } = await fixture(t);
  const target = path.join(profile, 'node_modules/dsh-pocket');
  await mkdir(target); await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'dsh-pocket', version: '2.10.7' }));
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pocket': '2.10.7' }, dsh: { profile: { bundles: ['dsh-pocket'] } } }));
  const patch = '- id: dsh-pocket\n  disabled: true\n';
  await writeFile(path.join(profile, 'cordis.patch.yml'), patch);
  const before = await readFile(path.join(profile, 'package.json'), 'utf8');
  assert.equal((await installDesktopPocket(profile, modules)).preserved, true);
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), patch);
});

test('missing runtime package leaves profile and previous plugin untouched', async t => {
  const { profile, modules, manifest } = await fixture(t);
  await mkdir(path.join(profile, 'node_modules/dsh-pocket'));
  await writeFile(path.join(profile, 'node_modules/dsh-pocket/old'), 'original');
  await rm(path.join(modules, 'dsh-pocket'));
  await assert.rejects(installDesktopPocket(profile, modules), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(path.join(profile, 'node_modules/dsh-pocket/old'), 'utf8'), 'original');
});

test('manifest write failure restores replaced Pocket and a retry succeeds', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { profile, modules, manifest } = await fixture(t);
  const target = path.join(profile, 'node_modules/dsh-pocket');
  await mkdir(target); await writeFile(path.join(target, 'old'), 'original');
  await chmod(profile, 0o500);
  await assert.rejects(installDesktopPocket(profile, modules), { code: 'EACCES' });
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(path.join(target, 'old'), 'utf8'), 'original');
  await chmod(profile, 0o700);
  assert.equal((await installDesktopPocket(profile, modules)).version, '2.10.6');
});
