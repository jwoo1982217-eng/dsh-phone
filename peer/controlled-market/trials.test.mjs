import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { ControlledMarket } from './catalog.mjs';
import { TrialPlans, checkManifest, artifactUrl } from './trials.mjs';
import { installTrial, runPackageManager } from './install-trial.mjs';

const plugin = { name: 'fixture-trial', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } };
const row = { name: 'fixture', npm: plugin.name, version: plugin.version, url: 'https://github.com/example/fixture' };
const dist = { tarball: 'https://registry.npmjs.org/fixture-trial/-/fixture-trial-1.0.0.tgz', integrity: 'sha512-' + 'A'.repeat(86) + '==' };
async function temporary(t) { const home = await mkdtemp(path.join(tmpdir(), 'dsh-trial-')); t.after(() => rm(home, { recursive: true, force: true })); return home; }
test('trial defaults off, persists explicit allowance, pins catalog version and has one-use expiring tickets', async t => {
  const home = await temporary(t), market = new ControlledMarket({ role: 'phone', home });
  market.cache = { fetchedAt: Date.now(), catalog: { plugins: [row] } };
  let now = Date.now(), requested;
  const trials = new TrialPlans(market, { now: () => now, fetchImpl: async (url, options) => { requested = url; assert.deepEqual(Object.keys(options.headers), ['accept']); return new Response(JSON.stringify({ ...plugin, dist })); } });
  await assert.rejects(trials.manage({ action: 'trial-prepare', ...row }), /主动开启/);
  await trials.manage({ action: 'trial-allow', enabled: true }); assert.equal(await new TrialPlans(market).enabled(), true);
  await assert.rejects(trials.manage({ action: 'trial-prepare', name: 'evil', url: row.url }), /不在当前目录/);
  const plan = await trials.manage({ action: 'trial-prepare', ...row, version: '9.9.9', download: 'file:///evil' });
  assert.equal(requested, 'https://registry.npmjs.org/fixture-trial/1.0.0'); assert.equal(plan.version, '1.0.0');
  assert.equal((await trials.manage({ action: 'trial-view', ticket: plan.ticket })).version, plan.version);
  assert.ok(trials.tickets.has(plan.ticket));
  assert.equal((await trials.manage({ action: 'trial-claim', ticket: plan.ticket })).name, plugin.name);
  await assert.rejects(trials.manage({ action: 'trial-claim', ticket: plan.ticket }), /过期/);
  const stale = await trials.manage({ action: 'trial-prepare', ...row }); now += 600001;
  await assert.rejects(trials.manage({ action: 'trial-claim', ticket: stale.ticket }), /过期/);
  await trials.manage({ action: 'trial-allow', enabled: false }); assert.equal(await trials.enabled(), false);
});
test('GitHub source is pinned to a commit and target policy cannot be supplied by callers', async t => {
  const market = new ControlledMarket({ role: 'phone', home: await temporary(t) });
  market.cache = { fetchedAt: Date.now(), catalog: { plugins: [{ ...row, npm: null, version: null }] } };
  const seen = [], sha = 'a'.repeat(40);
  const trials = new TrialPlans(market, { fetchImpl: async url => { seen.push(url); return new Response(JSON.stringify(url.includes('/commits/') ? { sha } : plugin)); } });
  await trials.manage({ action: 'trial-allow', enabled: true });
  const plan = await trials.manage({ action: 'trial-prepare', ...row, target: 'computer' });
  assert.equal(plan.commit, sha); assert.equal(plan.download, 'https://codeload.github.com/example/fixture/tar.gz/' + sha); assert.ok(seen[1].includes('/' + sha + '/'));
  market.role = 'computer'; await assert.rejects(trials.manage({ action: 'trial-allow', enabled: true }), /不能安装到电脑/);
});
test('known platform and SDK conflicts, invalid bundles and core replacement stay blocked', () => {
  checkManifest(plugin, '0.2.1-alpha.1');
  for (const os of [['darwin'], ['!android']]) assert.throws(() => checkManifest({ ...plugin, os }), /不支持/);
  assert.throws(() => checkManifest({ ...plugin, name: 'dsh-peer' }), /核心/);
  assert.throws(() => checkManifest({ ...plugin, name: 'dsh-phone-control' }), /核心/);
  assert.throws(() => checkManifest({ ...plugin, peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0-rc.8' } }), /不匹配/);
  assert.throws(() => checkManifest({ ...plugin, engines: { dsh: '>=0.3.0' } }), /不匹配/);
  assert.throws(() => checkManifest({ ...plugin, dsh: { bundle: { patch: '../escape' } } }), /入口/);
  assert.throws(() => artifactUrl('https://registry.npmjs.org@evil.test/x.tgz', 'npm'), /地址/);
});
test('real bundled pnpm installs a fixed JS artifact without running install hooks or replacing accounts/core', async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (!existsSync(path.join(root, 'runtime/tools/pnpm/dist/pnpm.cjs'))) { t.skip('Bundled Android installer is tested in the phone repository'); return; }
  const base = await temporary(t), home = path.join(base, 'home'), tree = path.join(base, 'tree'), profile = path.join(home, 'profiles/phone');
  await mkdir(profile, { recursive: true }); await mkdir(tree);
  await symlink(path.join(root, 'runtime/node_modules'), path.join(tree, 'node_modules'), 'dir');
  await symlink(path.join(root, 'runtime/tools'), path.join(tree, 'tools'), 'dir');
  await symlink(path.join(tree, 'node_modules'), path.join(home, 'node_modules'), 'dir');
  const original = { private: true, dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'existing'] } } };
  const manifestFile = path.join(profile, 'package.json'); await writeFile(manifestFile, JSON.stringify(original));
  await writeFile(path.join(home, '.credentials.yaml'), 'latest login'); await mkdir(path.join(home, 'sessions')); await writeFile(path.join(home, 'sessions/latest'), 'latest reply');
  const pkg = path.join(base, 'package'); await mkdir(pkg);
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ ...plugin, dependencies: { '@deepseek-ai/dsh-llm': '^0.2.0' }, scripts: { postinstall: 'node -e "throw Error(\'hooks ran\')"' } }));
  await writeFile(path.join(pkg, 'cordis.patch.yml'), '- insert: []\n');
  const tgz = path.join(base, 'plugin.tgz'); execFileSync('tar', ['-czf', tgz, '-C', base, 'package']);
  const archive = await readFile(tgz), plan = { source: 'npm', name: plugin.name, version: plugin.version, hostVersion: '0.2.1-alpha.1', download: dist.tarball, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') };
  const result = await installTrial(plan, { home, tree, fetchImpl: async () => new Response(archive) });
  assert.equal(result.name, plugin.name); const next = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.deepEqual(next.dsh.profile.bundles, [...original.dsh.profile.bundles, plugin.name]); assert.equal(next.dependencies.existing, '1.0.0');
  const installed = await realpath(path.join(profile, 'node_modules', plugin.name));
  assert.ok(installed.startsWith(path.join(await realpath(profile), 'market-plugins')));
  assert.equal(await realpath(path.join(path.dirname(installed), '@deepseek-ai/dsh-llm')), await realpath(path.join(tree, 'node_modules/@deepseek-ai/dsh-llm')));
  assert.equal(await readFile(path.join(home, '.credentials.yaml'), 'utf8'), 'latest login'); assert.equal(await readFile(path.join(home, 'sessions/latest'), 'utf8'), 'latest reply');
  const stable = await readFile(manifestFile, 'utf8');
  await assert.rejects(installTrial({ ...plan, integrity: dist.integrity }, { home, tree, fetchImpl: async () => new Response(archive) }), /校验失败/);
  assert.equal(await readFile(manifestFile, 'utf8'), stable);
  await assert.rejects(installTrial({ ...plan, name: 'dsh-peer' }, { home, tree }), /计划无效/);
});
test('package-manager timeout terminates its process group before a restore can begin', async t => {
  const stage = await temporary(t), cli = path.join(stage, 'wait.cjs');
  await writeFile(cli, 'setInterval(() => {},1000)');
  await assert.rejects(runPackageManager(process.execPath, cli, stage, {}, 100), /超时/);
});
