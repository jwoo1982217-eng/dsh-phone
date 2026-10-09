import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { adaptPhonePlugins, adaptWhaleGirlSource, adaptWhaleGirlClient } from './plugin-compat.js';

async function fixture(t, version = '0.2.1-alpha.1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-pet-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = path.join(root, 'tree'), home = path.join(root, 'home');
  await mkdir(path.join(tree, 'node_modules/@deepseek-ai/dsh-jobs'), { recursive: true });
  await writeFile(path.join(tree, 'node_modules/@deepseek-ai/dsh-jobs/package.json'), JSON.stringify({ version }));
  await mkdir(path.join(home, 'profiles/phone/node_modules'), { recursive: true });
  return { root, tree, home };
}

test('different SDKs and phones without the optional pet stay unchanged', async t => {
  const f = await fixture(t);
  assert.deepEqual(await adaptPhonePlugins(f.tree, f.home), { adapted: [], skipped: [] });
  await writeFile(path.join(f.tree, 'node_modules/@deepseek-ai/dsh-jobs/package.json'), '{"version":"next"}');
  assert.equal((await adaptPhonePlugins(f.tree, f.home)).skipped.length, 1);
});

test('unknown release contents are preserved, even with the adapter marker', async t => {
  const f = await fixture(t), pet = path.join(f.home, 'profiles/phone/node_modules/whale-girl');
  await mkdir(path.join(pet, 'lib'), { recursive: true });
  await writeFile(path.join(pet, 'package.json'), '{"name":"whale-girl","version":"0.1.0"}');
  for (const source of ['user modified content', '// DSH phone whale-girl jobs adapter v1\nuser modified content']) {
    await writeFile(path.join(pet, 'lib/index.mjs'), source);
    const result = await adaptPhonePlugins(f.tree, f.home);
    assert.equal(result.adapted.length, 0); assert.equal(result.skipped.length, 1);
    assert.equal(await readFile(path.join(pet, 'lib/index.mjs'), 'utf8'), source);
  }
});

test('a pet linked outside user home is not modified', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external');
  await mkdir(external);
  await symlink(external, path.join(f.home, 'profiles/phone/node_modules/whale-girl'), 'dir');
  assert.deepEqual((await adaptPhonePlugins(f.tree, f.home)).adapted, []);
  assert.match((await adaptPhonePlugins(f.tree, f.home)).skipped[0], /outside/);
});

test('partial or duplicate old API matches fail before producing a patch', () => {
  const a = '    for (const snapshot of jobs.list(agent)) {';
  const b = '      ctx.jobs.onJobDone((snapshot) => {';
  for (const source of [a, b, a + a + b, a + b + b]) assert.throws(() => adaptWhaleGirlSource(source), /does not match/);
});

test('unknown and duplicated client menu implementations are not guessed', () => {
  const source = '    menu.style.display = next ? "flex" : "none";\n    if (next) {';
  assert.throws(() => adaptWhaleGirlClient('user menu'), /does not match/);
  assert.throws(() => adaptWhaleGirlClient(source + source), /does not match/);
});
