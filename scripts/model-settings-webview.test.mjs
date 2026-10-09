import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const compat = await readFile(new URL('../phone-qq/browser-compat.js', import.meta.url), 'utf8');
const runtime = createRequire(new URL('../desktop-runtime/package.json', import.meta.url));
const client = await readFile(runtime.resolve('@deepseek-ai/dsh-client-ui-settings-models/client'), 'utf8');
const start = client.indexOf('const PROBE_ROUTE =');
const end = client.indexOf('//#endregion', start);
assert.ok(start > 0 && end > start, 'The pinned Models store must be available for this regression test');
const store = client.slice(start, end);

function legacyRealm() {
  const context = vm.createContext({});
  vm.runInContext(`
    delete Array.prototype.toSorted;
    delete Array.prototype.findLast;
    delete Array.prototype.findLastIndex;
    delete Promise.withResolvers;
  `, context);
  return context;
}

function models(context) {
  // Exercise the shipped upstream store with a fresh profile's available
  // adapters and empty credentials. No provider network or paid model call.
  vm.runInContext(`
    const _deepseek_ai_dsh_client_store = {
      createSnapshotStore(snapshot) { return { getSnapshot: () => snapshot, update: fn => fn(snapshot) }; }
    };
    ${store}
    const controller = new ModelsSettingsStore({ remote: {
      llm: {
        listProviders: async () => ({ ok: true, value: [{ id: 'deepseek-official', name: 'DeepSeek' }] }),
        listConfigurableProviders: async () => ({ ok: true, value: [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }] })
      },
      credentials: { describe: async () => ({ ok: true, value: { DEEPSEEK_API_KEY: { configured: false, writable: true } } }) }
    } }, { getPath: value => value, hasPath: () => false }, {
      ensure: async () => {},
      getSnapshot: () => ({ view: { writable: true, namespaces: [
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, base: {}, user: {} },
        { ns: 'llm-pi-ai', value: { providers: {} }, base: {}, user: {} }
      ] } })
    });
    globalThis.modelsController = controller;
  `, context);
  return context.modelsController;
}

test('reproduces the empty Models page when the WebView lacks copying sort', async () => {
  const controller = models(legacyRealm());
  await assert.rejects(controller.load(), /toSorted is not a function/);
  assert.equal(controller.store.getSnapshot().status, 'loading');
  assert.equal(controller.store.getSnapshot().rows.length, 0);
});

test('the shipped Models store finishes with configuration and Add available on an older WebView', async () => {
  const context = legacyRealm();
  vm.runInContext(compat, context);
  const controller = models(context);
  await controller.load();
  const snapshot = controller.store.getSnapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.writable, true);
  assert.equal(snapshot.rows[0].entry.provider, 'deepseek-official');
  assert.equal(snapshot.rows[0].configured, true);
  assert.equal(snapshot.rows[0].credential.configured, false);
  assert.ok(snapshot.namespaces.has('llm-pi-ai'), 'the custom API Add card is offered');
});

test('copying sort preserves the source, densifies holes and handles array-like values', () => {
  const context = legacyRealm();
  vm.runInContext(compat, context);
  const result = vm.runInContext(`(() => {
    const input = [3, , 1], output = input.toSorted((a, b) => a - b);
    const generic = Array.prototype.toSorted.call({ 0: 'b', 1: 'a', length: 2 });
    const sparse = [,]; sparse[Symbol.iterator] = () => { throw Error('must not use iterator'); };
    const copied = sparse.toSorted();
    return { input, output, generic, copied, dense: 2 in output, enumerable: Object.keys(Array.prototype).includes('toSorted') };
  })()`, context);
  assert.equal(1 in result.input, false);
  assert.deepEqual(Array.from(result.output), [1, 3, undefined]);
  assert.deepEqual(Array.from(result.generic), ['a', 'b']);
  assert.equal(0 in result.copied, true);
  assert.equal(result.dense, true);
  assert.equal(result.enumerable, false);
  assert.throws(() => vm.runInContext('[1].toSorted(null)', context), /comparison/);
  assert.throws(() => vm.runInContext('Array.prototype.toSorted.call(null)', context), /array-like/);
});

test('chat history search visits holes in reverse and uses the supplied predicate receiver', () => {
  const context = legacyRealm();
  vm.runInContext(compat, context);
  const result = vm.runInContext(`(() => {
    const visited = [], receiver = { expected: undefined };
    const index = [1, , 3].findLastIndex(function(value, index, array) {
      visited.push([value, index, array.length]); return value === this.expected;
    }, receiver);
    return { index, visited, value: [1, 2, 3].findLast(value => value < 3), absent: [].findLastIndex(() => true) };
  })()`, context);
  assert.equal(result.index, 1);
  assert.equal(result.value, 2);
  assert.equal(result.absent, -1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.visited)), [[3, 2, 3], [null, 1, 3]]);
});

test('approval promises resolve, reject and retain Promise subclass behavior', async () => {
  const context = legacyRealm();
  vm.runInContext(compat, context);
  const deferred = vm.runInContext('Promise.withResolvers()', context);
  deferred.resolve('approved');
  assert.equal(await deferred.promise, 'approved');
  const rejected = vm.runInContext('Promise.withResolvers()', context);
  rejected.reject(Error('declined'));
  await assert.rejects(rejected.promise, /declined/);
  assert.equal(vm.runInContext('class Subclass extends Promise {}; Subclass.withResolvers().promise instanceof Subclass', context), true);
});

test('native methods are kept intact and compatibility setup is repeatable', () => {
  const context = vm.createContext({});
  const before = vm.runInContext('[Array.prototype.toSorted, Array.prototype.findLast, Array.prototype.findLastIndex, Promise.withResolvers]', context);
  vm.runInContext(compat, context);
  vm.runInContext(compat, context);
  const after = vm.runInContext('[Array.prototype.toSorted, Array.prototype.findLast, Array.prototype.findLastIndex, Promise.withResolvers]', context);
  for (let i = 0; i < before.length; i++) assert.equal(after[i], before[i]);
});
