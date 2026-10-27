import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { apply } from './index.mjs';
import { createRelay } from './relay.mjs';
import { ConfigSync } from './config-sync.mjs';
import { parsePair, pairCode } from './protocol.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => { const s = createServer(); const p = await listen(s); await new Promise(resolve => s.close(resolve)); return p; };
const waitFor = async fn => { const deadline = Date.now() + 2500; while (!await fn()) { if (Date.now() > deadline) throw Error('state timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } };
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'peer-managed-')), originalHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(async () => { if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome; await rm(home, { recursive: true, force: true }); });
  const relay = createRelay(), calls = [], admissions = new Set(); let fail = '', failWrite = false, failWriteCountdown = 0, dropPost = false;
  relay.server.removeAllListeners('request');
  relay.server.on('request', async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, path: req.url });
    if (fail === req.method || fail === '*') { res.writeHead(503).end('secret service detail'); return; }
    if (req.url === '/health') { res.writeHead(200).end(); return; }
    if (req.headers.authorization !== 'Bearer synthetic-private-admin-credential') { res.writeHead(401).end(); return; }
    if (req.method === 'POST') { admissions.add(JSON.parse(Buffer.concat(chunks)).room); if (dropPost) { req.socket.destroy(); return; } res.writeHead(201).end(); return; }
    if (req.method === 'DELETE') { admissions.delete(req.url.split('/').at(-1)); res.writeHead(200).end(); return; }
    res.writeHead(404).end();
  });
  const port = await listen(relay.server), relayUrl = `ws://127.0.0.1:${port}/relay`;
  t.after(() => relay.close());
  const map = new Map(), writes = [];
  const credentials = { resolve: async ref => map.has(String(ref)) ? { value: map.get(String(ref)) } : undefined,
    set: async (ref, value) => { if (String(ref) === 'DSH_PEER_PAIR_V1' && (failWrite || (failWriteCountdown > 0 && --failWriteCountdown === 0))) { failWrite = false; throw Error('synthetic disk failure'); } map.set(String(ref), value); writes.push(String(ref)); } };
  async function device(role, deviceCredentials = credentials) {
    const rpc = new Map(), disposers = [], hooks = new Map(), services = new Map();
    const registration = () => {}; registration.replace = () => {};
    const ctx = { credentials: deviceCredentials, settings: { describe: () => [] }, llm: { registerAdapter: () => registration }, systemPrompt: { variable() {}, context() {} },
      connection: { rpc: { handle(path, handler, guard) { assert.equal(guard.authority, 'loopback'); rpc.set(path, handler); } } },
      webServer: { register() { return () => {}; } },
      get(name) { return services.get(name) ?? this[name]; }, provide(name, value) { services.set(name, value); },
      inject(names, fn) { if (names.every(name => this.get(name) !== undefined)) return fn(this); },
      effect(fn) { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); },
      on(name, fn) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
    };
    await apply(ctx, { role, proxyPort: await freePort(), sharedGatewayPort: await freePort() });
    const call = (action, extra = {}) => rpc.get('/phone-peer')('manage', { action, ...extra });
    const manage = async (action, extra) => { const result = await call(action, extra); assert.equal(result.ok, true, result.error?.message); return result.value; };
    t.after(async () => { for (const fn of hooks.get('dispose') ?? []) await fn(); for (const fn of disposers.reverse()) await fn(); });
    return { manage, call, hooks };
  }
  const computer = await device('computer');
  return { computer, device, credentials, map, writes, calls, admissions, relay: relayUrl, fail(method) { fail = method; }, failNextWrite() { failWrite = true; }, failPairWriteAfter(count) { failWriteCountdown = count; }, dropPostResponses(value) { dropPost = value; } };
}

test('one-click prepare and reconnect retain saved pair; same-pair phone connection is idempotent and does not replay edits', async t => {
  const f = await fixture(t);
  await f.computer.manage('remote.configure', { relay: f.relay, adminKey: 'synthetic-private-admin-credential' });
  const first = await f.computer.manage('prepare'), second = await f.computer.manage('prepare');
  assert.equal(first.code, second.code); assert.equal(f.admissions.size, 1);
  const phoneMap = new Map(), phoneWrites = [];
  const phone = await f.device('phone', { resolve: async ref => phoneMap.has(String(ref)) ? { value: phoneMap.get(String(ref)) } : undefined,
    set: async (ref, value) => { phoneMap.set(String(ref), value); phoneWrites.push(String(ref)); } });
  await phone.manage('pair', { code: first.link });
  await waitFor(async () => (await phone.manage('status')).connected);
  const writes = phoneWrites.length;
  await phone.manage('pair', { code: first.code });
  assert.equal(phoneWrites.length, writes, 'Repeated use of the same saved pair performs no state write');
  const before = f.map.get('DSH_PEER_PAIR_V1');
  const reconnect = await phone.manage('reconnect');
  assert.equal(Object.hasOwn(reconnect, 'code'), false); assert.equal(Object.hasOwn(reconnect, 'link'), false);
  await waitFor(async () => (await phone.manage('status')).connected);
  assert.equal(f.map.get('DSH_PEER_PAIR_V1'), before);
  assert.equal(pairCode(parsePair(first.link)), first.code);
  const status = JSON.stringify(await f.computer.manage('status'));
  assert.equal(status.includes('synthetic-private'), false); assert.equal(status.includes(parsePair(first.link).secret), false);
});

test('failed new registration and failed credential save leave the existing pair and admission intact', async t => {
  const f = await fixture(t); await f.computer.manage('remote.configure', { relay: f.relay, adminKey: 'synthetic-private-admin-credential' });
  const first = await f.computer.manage('prepare'), before = f.map.get('DSH_PEER_PAIR_V1'), room = parsePair(first.code).room;
  f.fail('POST'); const rejected = await f.computer.call('create'); assert.equal(rejected.ok, false);
  assert.equal(f.map.get('DSH_PEER_PAIR_V1'), before); assert.deepEqual([...f.admissions], [room]);
  assert.equal(f.calls.some(call => call.method === 'DELETE' && call.path.endsWith(room)), false, 'Failed registration must not revoke the existing primary room');
  f.fail(''); f.failNextWrite(); const unsaved = await f.computer.call('create'); assert.equal(unsaved.ok, false);
  assert.equal(f.map.get('DSH_PEER_PAIR_V1'), before); assert.deepEqual([...f.admissions], [room]);
  assert.equal((await f.computer.manage('prepare')).code, first.code);
});

test('failed revoke retains pair; partially completed rotation journals cleanup privately and retry returns only after old admission is removed', async t => {
  const f = await fixture(t); await f.computer.manage('remote.configure', { relay: f.relay, adminKey: 'synthetic-private-admin-credential' });
  const first = await f.computer.manage('prepare'), before = f.map.get('DSH_PEER_PAIR_V1'), oldRoom = parsePair(first.code).room;
  f.fail('DELETE'); const disconnect = await f.computer.call('disconnect'); assert.equal(disconnect.ok, false);
  assert.equal(f.map.get('DSH_PEER_PAIR_V1'), before); assert.equal(f.admissions.has(oldRoom), true);
  const rotation = await f.computer.call('create'); assert.equal(rotation.ok, false); assert.equal(rotation.error.code, 'PEER_REVOKE_PENDING');
  assert.equal(rotation.value, undefined);
  const pending = JSON.parse(f.map.get('DSH_PEER_PAIR_V1')); assert.equal(pending.pendingRevocations.length, 1);
  const status = await f.computer.manage('status'); assert.equal(status.pendingRevocations, 1); assert.equal(JSON.stringify(status).includes(oldRoom), false);
  f.fail(''); const completed = await f.computer.manage('prepare'); assert.notEqual(completed.code, first.code);
  assert.equal(f.admissions.has(oldRoom), false); assert.equal(f.admissions.size, 1);
  assert.equal((await f.computer.manage('status')).pendingRevocations, 0);
  await f.computer.manage('disconnect'); assert.equal(f.admissions.size, 0); assert.equal((await f.computer.manage('status')).paired, false);
});

test('disconnect storage failure re-admits the saved pair and a restarted manager resumes private rotation cleanup', async t => {
  const f = await fixture(t); await f.computer.manage('remote.configure', { relay: f.relay, adminKey: 'synthetic-private-admin-credential' });
  const first = await f.computer.manage('prepare'), oldRoom = parsePair(first.code).room, before = f.map.get('DSH_PEER_PAIR_V1');
  f.failNextWrite(); const rejected = await f.computer.call('disconnect'); assert.equal(rejected.ok, false);
  assert.equal(f.map.get('DSH_PEER_PAIR_V1'), before); assert.equal(f.admissions.has(oldRoom), true);
  f.fail('DELETE'); assert.equal((await f.computer.call('create')).ok, false);
  const restarted = await f.device('computer');
  assert.equal((await restarted.manage('status')).pendingRevocations, 1);
  f.fail(''); const completed = await restarted.manage('prepare');
  assert.notEqual(completed.code, first.code); assert.equal(f.admissions.has(oldRoom), false); assert.equal(f.admissions.size, 1);
});

test('failed save plus failed cleanup journals the unshared admission in credentials and recovers to the old saved pair', async t => {
  const f = await fixture(t); await f.computer.manage('remote.configure', { relay: f.relay, adminKey: 'synthetic-private-admin-credential' });
  const first = await f.computer.manage('prepare'); f.failPairWriteAfter(2); f.fail('DELETE');
  const rejected = await f.computer.call('create'); assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'PEER_CLEANUP_PENDING'); assert.equal(rejected.value, undefined);
  const saved = JSON.parse(f.map.get('DSH_PEER_PAIR_V1'));
  assert.equal(pairCode(saved.pair), first.code); assert.equal(saved.pendingRevocations.length, 1); assert.equal(f.admissions.size, 2);
  const status = JSON.stringify(await f.computer.manage('status')); assert.equal(status.includes(saved.pendingRevocations[0].secret), false); assert.equal(status.includes(saved.pendingRevocations[0].room), false);
  f.fail(''); const restarted = await f.device('computer'); assert.equal((await restarted.manage('prepare')).code, first.code); assert.equal(f.admissions.size, 1);
});


test('API auto-sync remains off by default and opted-in reconnect uses keep mode without replaying task operations', async t => {
  const f = await fixture(t); await f.computer.manage('remote.configure', { relay: f.relay, adminKey: 'synthetic-private-admin-credential' });
  const pair = await f.computer.manage('prepare'), modes = [], original = ConfigSync.prototype.commit;
  ConfigSync.prototype.commit = function(token, mode) { modes.push(mode); return original.call(this, token, mode); };
  t.after(() => { ConfigSync.prototype.commit = original; });
  const values = new Map();
  const phone = await f.device('phone', { resolve: async ref => values.has(String(ref)) ? { value: values.get(String(ref)) } : undefined, set: async (ref, value) => values.set(String(ref), value) });
  await phone.manage('pair', { code: pair.code }); await waitFor(async () => (await phone.manage('status')).connected);
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(modes.length, 0);
  await phone.manage('preferences', { autoSync: true }); await waitFor(() => modes.length === 1);
  await phone.manage('reconnect'); await waitFor(() => modes.length === 2); assert.deepEqual(modes, ['keep', 'keep']);
  await phone.manage('preferences', { autoSync: false }); await phone.manage('reconnect');
  await waitFor(async () => (await phone.manage('status')).connected);
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(modes.length, 2);
});


test('lost registration response retains candidate intent before POST and restart cleans it without sharing a new capability', async t => {
  const f = await fixture(t); await f.computer.manage('remote.configure', { relay: f.relay, adminKey: 'synthetic-private-admin-credential' });
  const first = await f.computer.manage('prepare'); f.dropPostResponses(true); f.fail('DELETE');
  const failed = await f.computer.call('create'); assert.equal(failed.ok, false); assert.equal(failed.error.code, 'PEER_CLEANUP_PENDING'); assert.equal(failed.value, undefined);
  const saved = JSON.parse(f.map.get('DSH_PEER_PAIR_V1')); assert.equal(pairCode(saved.pair), first.code); assert.equal(saved.pendingRevocations.length, 1);
  assert.equal(f.admissions.has(saved.pendingRevocations[0].room), true); assert.equal(f.admissions.size, 2);
  const restarted = await f.device('computer'); f.dropPostResponses(false); f.fail('');
  const recovered = await restarted.manage('prepare'); assert.equal(recovered.code, first.code); assert.equal(f.admissions.size, 1); assert.equal((await restarted.manage('status')).pendingRevocations, 0);
});
