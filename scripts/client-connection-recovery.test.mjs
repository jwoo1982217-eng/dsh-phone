import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const fixed = await readFile(new URL('../runtime/overlays/@deepseek-ai/dsh-client-connection/lib/client.js', import.meta.url), 'utf8');
const originalWatcher = await readFile(new URL('./fixtures/client-connection-network-0.2.1.js', import.meta.url), 'utf8');
const start = fixed.indexOf('\t\tfunction watchBrowserNetwork(');
const end = fixed.indexOf('\n\t\t/**\n\t\t* Install one Context-owned', start);
assert.ok(start > 0 && end > start);
const original = fixed.slice(0, start) + originalWatcher + fixed.slice(end);

function eventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign(extra, {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) { for (const listener of [...(listeners.get(type) || [])]) listener(event); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  });
}

function fixture(source, hostname, online = false) {
  const browser = eventTarget({ navigator: { onLine: online } });
  const document = eventTarget({ visibilityState: 'visible' });
  let plugin;
  browser.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => { throw Error('Unexpected dependency'); }); } };
  vm.runInNewContext(source, { window: browser, document, console, setTimeout, clearTimeout, AbortController, AbortSignal, URL, DOMException });
  let connection;
  plugin.installConnection({ provide(name, service) { assert.equal(name, 'connection'); connection = service; } }, {
    location: { hostname }, transport: { rpc: { call() { throw Error('Recovery must not resend prompts'); } } },
    recovery: { backoffBaseMs: 2, backoffMaxMs: 4, generationReadyWarnMs: 100, generationReadyTimeoutMs: 200 },
  });
  let calls = 0, aborts = 0, lose;
  connection.registerGenerationSource(async (signal, ready) => {
    calls++; ready({ home: '/fixture' });
    await new Promise(resolve => { lose = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { aborts++; resolve(); }, { once: true }); });
  });
  const loop = connection.start({});
  return { browser, document, connection, stop: () => loop.stop(), get calls() { return calls; }, get aborts() { return aborts; }, lose: () => lose() };
}

async function until(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'Connection did not recover');
}

test('reproduces the shipped loopback connection staying suspended while WebView reports offline', async t => {
  const f = fixture(original, '127.0.0.1'); t.after(f.stop);
  await delay(15); assert.equal(f.calls, 0); assert.equal(f.connection.state.getSnapshot(), 'disconnected');
});

test('local DSH connects and recovers carrier loss despite an offline internet hint', async t => {
  const f = fixture(fixed, '127.0.0.1'); t.after(f.stop);
  await until(() => f.connection.state.getSnapshot() === 'connected');
  f.browser.dispatch('offline'); await delay(10); assert.equal(f.calls, 1); assert.equal(f.aborts, 0);
  f.lose(); await until(() => f.calls === 2 && f.connection.state.getSnapshot() === 'connected');
});

test('localhost and IPv6 loopback have the same local-server recovery', async t => {
  for (const hostname of ['localhost', '[::1]', '127.2.3.4']) {
    const f = fixture(fixed, hostname); t.after(f.stop);
    await until(() => f.connection.state.getSnapshot() === 'connected');
  }
});

test('remote web hosts still suspend on offline and resume when online', async t => {
  const f = fixture(fixed, 'dsh.example.test'); t.after(f.stop);
  await delay(10); assert.equal(f.calls, 0);
  f.browser.dispatch('online'); await until(() => f.connection.state.getSnapshot() === 'connected');
  f.browser.dispatch('offline'); await until(() => f.connection.state.getSnapshot() === 'disconnected');
  assert.equal(f.calls, 1);
});

test('returning a cached page renews the generation, preserves RPC, and releases lifecycle listeners on stop', async () => {
  const f = fixture(fixed, '127.0.0.1');
  try {
    await until(() => f.connection.state.getSnapshot() === 'connected');
    const rpc = f.connection.rpc;
    f.browser.dispatch('pageshow', { persisted: false }); f.document.dispatch('visibilitychange');
    await delay(10); assert.equal(f.calls, 1, 'Healthy foreground connection must stay intact');
    f.browser.dispatch('pageshow', { persisted: true });
    await until(() => f.calls === 2 && f.connection.state.getSnapshot() === 'connected');
    assert.equal(f.connection.rpc, rpc); assert.equal(f.aborts, 1);
  } finally { f.stop(); }
  assert.equal(f.browser.listenerCount(), 0); assert.equal(f.document.listenerCount(), 0);
  f.browser.dispatch('pageshow', { persisted: true }); await delay(10); assert.equal(f.calls, 2);
});
