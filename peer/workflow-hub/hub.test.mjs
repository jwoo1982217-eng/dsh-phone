import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from './store.mjs';
import { PluginCenter } from './plugins.mjs';
import { catalog, workflowDefinition, readinessFor, applyWorkflowHub } from './index.mjs';
const exec = promisify(execFile);
async function temp(t) { const dir = await mkdtemp(path.join(tmpdir(), 'dsh-workflow-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('workflow toggle survives restart, rejects stale writers and rolls back a failed registration', async t => {
  const home = await temp(t), store = new WorkflowStore(home, catalog); await store.init();
  const id = catalog[0].id, observed = [];
  await store.change(id, false, 0, async enabled => observed.push(enabled));
  const saved = await readFile(store.file);
  await assert.rejects(store.change(id, true, 0, async () => {}), /另一页面/);
  await assert.rejects(store.change(id, true, 1, async () => { throw Error('runtime rejected'); }), /runtime rejected/);
  assert.deepEqual(await readFile(store.file), saved);
  const restart = new WorkflowStore(home, catalog); assert.deepEqual(await restart.init(), store.status());
  await restart.change(id, true, 1, async enabled => observed.push(enabled)); assert.deepEqual(observed, [false, true]);
});

test('filesystem commit failure restores previous runtime selection', async t => {
  const home = await temp(t), store = new WorkflowStore(home, catalog); await store.init();
  await mkdir(store.file, { recursive: true }); const changes = [];
  await assert.rejects(store.change(catalog[0].id, false, 0, async enabled => changes.push(enabled)));
  assert.deepEqual(changes, [false, true]); assert.equal(store.status().revision, 0);
});

test('curated source and all nine complete skill resources retain pinned provenance', async () => {
  const source = JSON.parse(await readFile(new URL('./source.json', import.meta.url)));
  assert.equal(catalog.length, 7); assert.equal(catalog.flatMap(x => x.skills).length, 9);
  for (const file of source.files) {
    const data = await readFile(new URL('./presets/' + file.path, import.meta.url));
    assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256, file.path);
  }
});

test('native preset uses current persona API, scoped skills, phone paths and explicit missing tools', async () => {
  for (const row of catalog) {
    const readiness = await readinessFor(row, 'phone', { resolve: async () => undefined });
    const definition = workflowDefinition(row, 'phone', readiness);
    assert.ok(definition.plugins[0].config.prefix); assert.equal(definition.plugins[0].config.text, undefined);
    assert.equal(definition.plugins[1].config.includeDefaultRoots, false);
    assert.ok(path.isAbsolute(definition.plugins[1].config.customSkillDirs[0]));
    assert.match(definition.plugins[0].config.prefix, /角色卡/);
    if (row.runtime === 'content-imagegen') { assert.ok(readiness.missing.length); assert.equal(definition.plugins.length, 2); }
    if (row.runtime === 'feishu') { assert.equal(readiness.missing.length, 3); assert.equal(definition.plugins.length, 2); }
  }
});

test('actual motion-deck tool builds, verifies and rejects invalid input without replacing the valid artifact', async t => {
  const home = await temp(t), project = path.join(home, 'generated/test-deck'); await mkdir(path.join(project, 'input'), { recursive: true });
  const outline = { deck: { title: '姐姐的新工作流', brand: '小甜桃' }, slides: Array.from({ length: 8 }, (_, i) => ({ section: '阶段 ' + i, title: '步骤 ' + i, summary: '验证真实输入与成果', points: ['输入', '执行', '验收'] })) };
  await writeFile(path.join(project, 'input/outline.json'), JSON.stringify(outline));
  const script = fileURLToPath(new URL('./presets/fufan-ppt-office/preset/runtime/motion-deck/source/generate-deck.mjs', import.meta.url));
  const run = (action, more = []) => exec(process.execPath, [script, action, '--workspace', home, '--project', 'generated/test-deck', ...more]);
  assert.equal(JSON.parse((await run('render', ['--theme', 'ocean', '--focus', 'result'])).stdout).pages, 8);
  assert.equal(JSON.parse((await run('verify')).stdout).ok, true);
  const valid = await readFile(path.join(project, 'output/index.html'));
  outline.slides.pop(); await writeFile(path.join(project, 'input/outline.json'), JSON.stringify(outline));
  await assert.rejects(run('render', ['--theme', 'ocean', '--focus', 'result']));
  assert.deepEqual(await readFile(path.join(project, 'output/index.html')), valid);
});

function setup({ role = 'computer', running = false } = {}) {
  const calls = [], bundle = { name: 'dsh-fixture', version: '1.0.0', enabled: true, removable: true };
  const manager = { listBundles: async () => [bundle], listPlugins: async () => [], inspect: async () => ({ status: 'accepted', bundle: true }),
    installBundle: async (...args) => { calls.push(['install', ...args]); return { application: 'applied' }; },
    setBundleEnabled: async (...args) => { calls.push(['toggle', ...args]); return { application: 'applied' }; },
    removeBundle: async (...args) => { calls.push(['remove', ...args]); return { application: 'applied' }; } };
  const ctx = { get: name => name === 'pluginManager' ? manager : name === 'agents' ? { list: () => [{ status: running ? 'running' : 'idle' }] } : undefined };
  const manifest = { name: 'dsh-fixture', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh': '0.2.1-alpha.1' } };
  return { calls, manager, center: new PluginCenter(ctx, role, '/unused', { fetchImpl: async () => new Response(JSON.stringify(manifest)) }) };
}
test('desktop checks a fixed bundle before installation; one-use tickets and protected components are enforced', async () => {
  const { center, calls } = setup();
  assert.equal((await center.manage({ action: 'status' })).bundles.length, 1);
  const plan = await center.manage({ action: 'inspect', name: 'dsh-fixture', version: '1.0.0' });
  await center.manage({ action: 'install', name: plan.name, ticket: plan.ticket }); assert.equal(calls[0][1], 'dsh-fixture@1.0.0');
  await assert.rejects(center.manage({ action: 'install', name: plan.name, ticket: plan.ticket }), /过期/);
  await assert.rejects(center.manage({ action: 'toggle', name: 'dsh-peer', enabled: false }), /受保护/);
  await center.manage({ action: 'toggle', name: 'dsh-fixture', enabled: false }); await center.manage({ action: 'remove', name: 'dsh-fixture' });
  assert.deepEqual(calls.map(x => x[0]), ['install', 'toggle', 'remove']);
});
test('phone preserves native backup installation and both targets defer mutations until conversations are idle', async () => {
  await assert.rejects(setup({ role: 'phone' }).center.manage({ action: 'inspect', name: 'dsh-fixture', version: '1.0.0' }), /原生备份/);
  const { center, calls } = setup({ running: true });
  await assert.rejects(center.manage({ action: 'remove', name: 'dsh-fixture' }), /对话正在执行/); assert.equal(calls.length, 0);
});

test('Feishu configuration stays in credential storage, never returns secrets, and restores partial failures', async t => {
  const home = await temp(t), previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; });
  const refs = new Map(), handlers = new Map(), definitions = new Map(); let fail = false;
  const key = ref => typeof ref === 'string' ? ref : ref.key ?? ref.name ?? String(ref);
  const credentials = { resolve: async ref => refs.has(key(ref)) ? { value: refs.get(key(ref)) } : undefined,
    set: async (ref, value) => { if (fail && value === 'failure-fixture') throw Error('write failed'); refs.set(key(ref), value); }, unset: async ref => { refs.delete(key(ref)); } };
  const effects = [];
  const ctx = { credentials, get: () => undefined, effect: fn => { effects.push(fn()); },
    webServer: { register: () => () => {} }, connection: { rpc: { handle: (route, handler, options) => { assert.equal(options.authority, 'loopback'); handlers.set(route, handler); } } } };
  ctx.inject = (_names, fn) => fn({ effect: ctx.effect, agentPresets: { register: async def => { definitions.set(def.id, def); return async () => { definitions.delete(def.id); }; }, list: async () => [...definitions.values()].map(def => ({ id: def.id })) } });
  await applyWorkflowHub(ctx, 'computer');
  const manage = payload => handlers.get('/workflow-hub')('manage', payload);
  await manage({ action: 'status' });
  const result = await manage({ action: 'configure-feishu', values: { FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-private', FEISHU_DEFAULT_OPEN_ID: 'fixture-owner' } });
  assert.equal(result.ok, true); assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
  assert.equal(definitions.get('studio-feishu-digital-employee').plugins.filter(x => x.name === '@deepseek-ai/dsh-mcp-client').length, 2);
  const before = [...refs]; fail = true;
  const failed = await manage({ action: 'configure-feishu', values: { FEISHU_APP_ID: 'new-app', FEISHU_APP_SECRET: 'failure-fixture', FEISHU_DEFAULT_OPEN_ID: 'new-owner' } });
  assert.equal(failed.ok, false); assert.deepEqual([...refs], before);
  for (const dispose of effects) if (typeof dispose === 'function') await dispose();
});
