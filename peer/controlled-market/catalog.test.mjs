import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlledMarket, CATALOG_URL, normalizeCatalog, repositoryUrl } from './catalog.mjs';
const fixture = { updated: 'fixture-date', categories: { memory: { zh: '记忆' } }, plugins: [
  { name: 'fixture', owner: 'author', url: 'https://github.com/example/fixture', description: { zh: '记忆插件' }, npm: 'fixture', version: '1.2.3', category: 'memory', stars: 2,
    androidCompatible: true, reviewed: true, install: 'evil shell; command', canInstall: true },
  { name: '<img onerror=evil()>', url: 'https://github.com/example/theme', npm: 'bad; command', version: '1.2.3;rm', category: 'theme', stars: 1 },
] };
async function setup(t, role = 'phone', fetchImpl = async () => new Response(JSON.stringify(fixture))) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-market-control-')); t.after(() => rm(home, { recursive: true, force: true }));
  return new ControlledMarket({ role, home, fetchImpl });
}
test('catalog labels never grant Android installation authority or trust catalog install text', async t => {
  let called = 0;
  const market = await setup(t, 'phone', async (url, options) => { called++; assert.equal(url, CATALOG_URL); assert.deepEqual(Object.keys(options.headers), ['accept']); assert.equal(options.redirect, 'error'); return new Response(JSON.stringify(fixture)); });
  const result = await market.manage({ action: 'catalog', target: 'computer' });
  assert.equal(result.role, 'phone'); assert.equal(result.approvedExternalVersions, 0);
  assert.ok(result.plugins.every(x => x.canInstall === false && x.command === null)); assert.equal(called, 1);
  for (const action of ['install', 'update', 'enable', 'execute', 'restore']) await assert.rejects(market.manage({ action, reviewed: true, target: 'computer' }), /不执行/);
  assert.equal(called, 1); assert.ok(!JSON.stringify(result).includes('evil shell'));
});
test('search, classification, pagination and cached offline catalog are honest and preserve labels', async t => {
  const market = await setup(t); const result = await market.manage({ action: 'catalog', query: '记忆', category: 'memory' });
  assert.equal(result.total, 1); assert.equal(result.plugins[0].name, 'fixture'); assert.equal(result.stale, false);
  const saved = JSON.parse(await readFile(market.cacheFile, 'utf8')); saved.fetchedAt = 1;
  const offline = new ControlledMarket({ role: 'phone', home: market.home, now: () => 600000, fetchImpl: async () => { throw Error('offline'); } });
  const { writeFile } = await import('node:fs/promises'); await writeFile(market.cacheFile, JSON.stringify(saved));
  const value = await offline.manage({ action: 'catalog' }); assert.equal(value.stale, true); assert.equal(value.categories.memory, '记忆'); assert.equal(value.total, 2);
});
test('computer commands use pinned validated npm/version fields; phone target cannot be overridden', async t => {
  const market = await setup(t, 'computer'); const result = await market.manage({ action: 'catalog', target: 'phone' });
  assert.equal(result.role, 'computer'); assert.equal(result.plugins[0].command, 'dsh plugin --profile web add fixture@1.2.3');
  assert.equal(result.plugins[1].command, null); assert.ok(result.plugins.every(x => !x.canInstall));
  for (const url of ['javascript:alert(1)', 'file:///sdcard/x', 'https://github.com@127.0.0.1/evil', 'https://github.com/example/fixture?command=evil', 'https://github.com/example/../fixture']) assert.equal(repositoryUrl(url), null);
  assert.throws(() => normalizeCatalog({ plugins: 'bad' }), /格式/);
});
test('oversized and unavailable catalog never becomes installable and does not execute content', async t => {
  const market = await setup(t, 'phone', async () => new Response('x'.repeat(16 * 1024 * 1024 + 1)));
  await assert.rejects(market.manage({ action: 'catalog' }), /目录加载失败/); await assert.rejects(market.manage({ action: 'install' }), /不执行/);
});
test('adapted built-ins never offer a community command that would replace the tested version', async t => {
  const catalog = { ...fixture, plugins: [{ ...fixture.plugins[0], npm: '@zseven-w/dsh-noema' }] };
  for (const role of ['phone', 'computer']) {
    const market = await setup(t, role, async () => new Response(JSON.stringify(catalog)));
    const row = (await market.manage({ action: 'catalog' })).plugins[0];
    assert.equal(row.command, null); assert.equal(row.canInstall, false); assert.match(row.policy, /内置组件受保护/);
  }
});

test('a stale catalog stays searchable during one slow refresh, then exposes the new directory', async t => {
  let finish, calls = 0;
  const waiting = new Promise(resolve => { finish = resolve; });
  const market = await setup(t, 'phone', () => { calls++; return waiting; });
  market.cache = { fetchedAt: 1, catalog: normalizeCatalog(fixture) };
  const first = await market.manage({ action: 'catalog' });
  assert.equal(first.refreshing, true); assert.equal(first.total, 2);
  const search = await market.manage({ action: 'catalog', query: '记忆', refresh: true });
  assert.equal(search.total, 1); assert.equal(search.refreshing, true); assert.equal(calls, 1);
  const job = market.pending;
  finish(new Response(JSON.stringify({ ...fixture, updated: 'new-date', plugins: [fixture.plugins[0]] })));
  await job;
  const latest = await market.manage({ action: 'catalog' });
  assert.equal(latest.catalogUpdated, 'new-date'); assert.equal(latest.total, 1);
  assert.equal(latest.refreshing, false); assert.equal(latest.stale, false); assert.equal(calls, 1);
});

test('a failed refresh preserves the cache and ends polling; a cold failure remains explicit', async t => {
  const market = await setup(t, 'phone', async () => { throw Error('offline'); });
  market.cache = { fetchedAt: 1, catalog: normalizeCatalog(fixture) };
  const value = await market.manage({ action: 'catalog' }); assert.equal(value.total, 2);
  await market.pending;
  const retry = await market.manage({ action: 'catalog' });
  assert.equal(retry.total, 2); assert.equal(retry.stale, true); assert.equal(retry.refreshing, false);
  const cold = await setup(t, 'phone', async () => { throw Error('offline'); });
  await assert.rejects(cold.manage({ action: 'catalog' }), /目录加载失败/);
});
