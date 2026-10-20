import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const compat = await readFile(new URL('../app/src/main/assets/dsh-phone.compat.js', import.meta.url), 'utf8');
const runtime = createRequire(new URL('../desktop-runtime/package.json', import.meta.url));
const client = await readFile(runtime.resolve('@deepseek-ai/dsh-client-ui-settings-models/client'), 'utf8');
const start = client.indexOf('const PROBE_ROUTE =');
const end = client.indexOf('//#endregion', start);
assert.ok(start > 0 && end > start, 'The pinned Models store must be available for this regression test');
const store = client.slice(start, end);

function legacyRealm() {
  const context = vm.createContext({});
  vm.runInContext(`
    delete globalThis.structuredClone;
    delete Array.prototype.toSorted;
    delete Array.prototype.findLast;
    delete Array.prototype.findLastIndex;
    delete Promise.withResolvers;
  `, context);
  return context;
}

const draftStart = client.indexOf('function draftAt(');
const draftEnd = client.indexOf('\n\t\t/**', draftStart);
assert.ok(draftStart > 0 && draftEnd > draftStart);
const editorDraft = client.slice(draftStart, draftEnd);

test('the actual Models editor crashes on edit without structuredClone, then opens an independent draft with compatibility', () => {
  const context = legacyRealm();
  vm.runInContext(`${editorDraft}\nconst namespace = { user: { route: { models: [{ id: 'fixture' }], retries: 0, enabled: false } } }; const schema = { getPath: (value, path) => path.reduce((v, k) => v[k], value) };`, context);
  assert.throws(() => vm.runInContext('draftAt(schema, namespace, ["route"])', context), /structuredClone/);
  vm.runInContext(compat, context);
  assert.equal(vm.runInContext(`(() => { const draft = draftAt(schema, namespace, ['route']); draft.models[0].id = 'edited'; return namespace.user.route.models[0].id === 'fixture' && draft.retries === 0 && draft.enabled === false; })()`, context), true);
});

test('configuration cloning keeps circular graphs, container aliases and shared binary buffers', () => {
  const context = legacyRealm(); vm.runInContext(compat, context);
  assert.equal(vm.runInContext(`(() => {
    const shared = { value: undefined, huge: 123n }, date = new Date(42), buffer = new ArrayBuffer(8);
    const source = { a: shared, b: shared, date, dateAgain: date, map: new Map(), set: new Set(), bytes: new Uint8Array(buffer), view: new DataView(buffer), sparse: new Array(3) };
    source.map.set(shared, source); source.set.add(source); source.bytes[0] = 7; source.self = source;
    Object.defineProperty(source, '__proto__', { enumerable: true, value: { literal: true } });
    const copy = structuredClone(source); copy.bytes[0] = 9;
    return copy !== source && copy.self === copy && copy.a === copy.b && copy.a !== shared && copy.a.huge === 123n && 'value' in copy.a
      && copy.map.get(copy.a) === copy && copy.set.has(copy) && copy.date === copy.dateAgain && copy.date.getTime() === 42
      && copy.bytes.buffer === copy.view.buffer && copy.view.getUint8(0) === 9 && source.bytes[0] === 7
      && copy.sparse.length === 3 && !(0 in copy.sparse) && Object.getPrototypeOf(copy) === Object.prototype && copy.__proto__.literal;
  })()`, context), true);
});

test('unsupported clones fail explicitly and repeated compatibility keeps an existing clone implementation', () => {
  const context = legacyRealm(); vm.runInContext(compat, context);
  for (const expression of ['({ callback() {} })', 'Symbol("x")', 'new WeakMap()', 'Promise.resolve(1)']) {
    assert.throws(() => vm.runInContext(`structuredClone(${expression})`, context), error => error.name === 'DataCloneError');
  }
  assert.throws(() => vm.runInContext('structuredClone(new ArrayBuffer(2), { transfer: [new ArrayBuffer(1)] })', context), error => error.name === 'DataCloneError');
  vm.runInContext('const retainedClone = structuredClone;', context); vm.runInContext(compat, context);
  assert.equal(vm.runInContext('retainedClone === structuredClone', context), true);
  const native = vm.createContext({ structuredClone: globalThis.structuredClone }); vm.runInContext(compat, native);
  assert.equal(native.structuredClone, globalThis.structuredClone);
});

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
