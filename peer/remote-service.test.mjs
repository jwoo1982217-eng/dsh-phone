import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RemoteService } from './remote-service.mjs';
import { newPair, pairCode, parsePair, shareLink } from './protocol.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const store = () => { const values = new Map(); return { values, resolve: async key => values.has(key) ? { value: values.get(key) } : undefined, set: async (key, value) => values.set(key, value) }; };
async function fixture(t) {
  const calls = [], rooms = new Map(); let mode = 'ready';
  const server = createServer(async (req, res) => {
    const body = []; for await (const chunk of req) body.push(chunk);
    calls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: Buffer.concat(body).toString() });
    if (mode === 'timeout') return;
    if (mode === 'failed') { res.writeHead(503).end('private error must not escape'); return; }
    if (req.url === '/health') { res.writeHead(200).end('ready'); return; }
    if (req.headers.authorization !== 'Bearer synthetic-admin-key-32-characters') { res.writeHead(401).end(); return; }
    if (req.method === 'POST' && req.url === '/admin/rooms') {
      const { room, proof } = JSON.parse(Buffer.concat(body));
      const previous = rooms.get(room);
      if (previous && previous !== proof) { res.writeHead(409).end(); return; }
      rooms.set(room, proof); res.writeHead(previous ? 200 : 201).end(); return;
    }
    if (req.method === 'DELETE' && req.url.startsWith('/admin/rooms/')) { rooms.delete(req.url.split('/').at(-1)); res.writeHead(200).end(); return; }
    res.writeHead(404).end();
  });
  const port = await listen(server), credentials = store(), service = new RemoteService(credentials, { timeoutMs: 250 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await service.init();
  return { service, credentials, calls, rooms, relay: `ws://127.0.0.1:${port}/relay`, mode(value) { mode = value; } };
}

test('managed registration is persistent and idempotent; public status never discloses either capability', async t => {
  const f = await fixture(t); await f.service.configure({ relay: f.relay, adminKey: 'synthetic-admin-key-32-characters' });
  const pair = newPair(f.relay);
  await f.service.register(pair); await f.service.register(pair);
  assert.equal(f.rooms.size, 1);
  const restarted = new RemoteService(f.credentials); await restarted.init();
  assert.equal(restarted.matches(pair), true);
  assert.deepEqual(restarted.status(), { ready: true, hostname: '127.0.0.1', phase: 'ready', errorCode: '' });
  const status = JSON.stringify(restarted.status());
  assert.equal(status.includes('synthetic-admin'), false); assert.equal(status.includes(pair.secret), false); assert.equal(status.includes(pair.room), false);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
  assert.ok(f.calls.every(call => !call.url.includes('key') && !call.url.includes('proof')));
  await restarted.revoke(pair); assert.equal(f.rooms.size, 0);
});

test('invalid or unreachable configuration preserves previous private config; calls time out without error leakage', async t => {
  const f = await fixture(t); await f.service.configure({ relay: f.relay, adminKey: 'synthetic-admin-key-32-characters' });
  const before = [...f.credentials.values];
  await assert.rejects(f.service.configure({ relay: f.relay + '?secret=x', adminKey: 'replacement-private-key-value' }));
  assert.deepEqual([...f.credentials.values], before);
  f.mode('timeout');
  await assert.rejects(f.service.configure({ relay: f.relay, adminKey: 'replacement-private-key-value' }), { code: 'PEER_SERVICE_TIMEOUT' });
  assert.deepEqual([...f.credentials.values], before);
  const pair = newPair(f.relay);
  await assert.rejects(f.service.register(pair), { code: 'PEER_SERVICE_TIMEOUT' });
  assert.equal(f.service.matches(pair), true);
  assert.equal(JSON.stringify(f.service.status()).includes('replacement'), false);
});

test('revoke fails visibly and preserves local capability when admission service is unavailable', async t => {
  const f = await fixture(t); await f.service.configure({ relay: f.relay, adminKey: 'synthetic-admin-key-32-characters' });
  const pair = newPair(f.relay); await f.service.register(pair); f.mode('failed');
  await assert.rejects(f.service.revoke(pair), { code: 'PEER_SERVICE_UNAVAILABLE' });
  assert.equal(f.rooms.has(pair.room), true); assert.equal(f.service.matches(pair), true);
  f.mode('ready'); await f.service.revoke(pair); assert.equal(f.rooms.has(pair.room), false);
});

test('HTTPS share bridge preserves v1 pairing and rejects different origin, query secrets, and foreign paths', () => {
  const pair = newPair('wss://relay.example.invalid/relay');
  const link = shareLink(pair); assert.equal(link, 'https://relay.example.invalid/connect#' + pairCode(pair));
  assert.deepEqual(parsePair(link), pair);
  assert.throws(() => parsePair(link.replace('https://relay.example.invalid/', 'https://other.invalid/')));
  assert.throws(() => parsePair(link.replace('/connect#', '/connect?key=forbidden#')));
  assert.throws(() => parsePair(link.replace('/connect#', '/other#')));
});
