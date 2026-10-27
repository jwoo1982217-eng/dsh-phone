import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRelay } from './relay.mjs';
import { PeerTunnel } from './tunnel.mjs';
import { newPair, pairCode, relayProof } from './protocol.mjs';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const waitFor = async (condition, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw Error('Expected connection state was not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const options = { reconnectMs: 20, maxReconnectMs: 80, handshakeTimeoutMs: 150,
  heartbeatIntervalMs: 50, heartbeatTimeoutMs: 100 };

async function connectedPeers(t) {
  const relay = createRelay(), port = await listen(relay.server);
  const pair = newPair(`ws://127.0.0.1:${port}/relay`);
  const phone = new PeerTunnel(pair, 'phone', options);
  const computer = new PeerTunnel(pair, 'computer', options);
  t.after(async () => { phone.stop(); computer.stop(); await relay.close(); });
  phone.start(); computer.start();
  await waitFor(() => phone.online && computer.online);
  return { relay, pair, phone, computer };
}

test('starting the same saved tunnel twice creates one socket and authenticates fixed relay admission', async t => {
  const relay = createRelay(), port = await listen(relay.server), upgrades = [];
  relay.server.on('upgrade', request => upgrades.push({
    url: request.url, authorization: request.headers.authorization,
  }));
  const pair = newPair(`ws://127.0.0.1:${port}/relay`);
  const phone = new PeerTunnel(pair, 'phone', options);
  t.after(async () => { phone.stop(); await relay.close(); });
  phone.start(); phone.start();
  await waitFor(() => upgrades.length > 0);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(upgrades.length, 1, 'Repeated start must not create competing device sockets');
  const url = new URL(upgrades[0].url, 'http://localhost');
  assert.equal(url.searchParams.get('room'), pair.room);
  assert.equal(upgrades[0].authorization, `Bearer ${relayProof(pair)}`);
  assert.equal(url.searchParams.has('proof'), false);
  assert.equal(pair.relay, `ws://127.0.0.1:${port}/relay`, 'Saved fixed address stays unchanged');
});

test('an accepted websocket that never acknowledges join is replaced within a bounded wait', async t => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let connections = 0;
  sockets.on('connection', () => { connections++; });
  const port = await listen(server);
  const peer = new PeerTunnel(newPair(`ws://127.0.0.1:${port}/relay`), 'phone', options);
  t.after(async () => {
    peer.stop(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  peer.start();
  await waitFor(() => connections >= 2, 1200);
  assert.equal(peer.online, false);
});

test('silent network loss rejects a pending edit without replay and reconnects using the same pair', async t => {
  const { relay, pair, phone, computer } = await connectedPeers(t);
  const originalCode = pairCode(pair), originalSocket = phone.socket;
  let edits = 0, release;
  computer.handler = action => {
    if (action === 'edit') { edits++; return new Promise(resolve => { release = resolve; }); }
    return { name: 'same-computer' };
  };
  const pending = phone.call('edit', { file: 'synthetic.txt' }, 1800);
  const rejected = assert.rejects(pending, /断开|离线|连接/, 'A disconnected write must not remain successful');
  await waitFor(() => edits === 1);
  const staleServerSocket = relay.rooms.get(pair.room).phone;
  staleServerSocket._socket.pause();
  t.after(() => staleServerSocket._socket?.resume());
  await rejected;
  await waitFor(() => phone.online && phone.socket !== originalSocket);
  release({ written: true });
  assert.deepEqual(await phone.call('identity', {}), { name: 'same-computer' });
  assert.equal(edits, 1, 'Transport recovery must never submit the previous edit again');
  assert.equal(pairCode(phone.pair), originalCode);
});

test('foreground reconnect retains pairing and stopping cancels all future reconnection', async t => {
  const { pair, phone, computer, relay } = await connectedPeers(t);
  computer.handler = () => ({ name: 'same-computer' });
  const code = pairCode(pair), previous = phone.socket;
  phone.reconnect();
  await waitFor(() => phone.online && phone.socket !== previous);
  assert.deepEqual(await phone.call('identity', {}), { name: 'same-computer' });
  assert.equal(pairCode(phone.pair), code);
  phone.stop();
  const stoppedSocket = phone.socket;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(phone.online, false);
  assert.equal(phone.socket, stoppedSocket);
  assert.equal(relay.rooms.get(pair.room)?.phone ?? null, null);
});

test('relay admission without encrypted peer acknowledgement has a bounded handshake deadline', async t => {
  const server = createServer(), sockets = new WebSocketServer({ server }); let connections = 0;
  sockets.on('connection', ws => { connections++; ws.on('message', value => { if (JSON.parse(value).type === 'join') { ws.send(JSON.stringify({ type: 'joined' })); ws.send(JSON.stringify({ type: 'peer-online' })); } }); });
  const port = await listen(server), peer = new PeerTunnel(newPair(`ws://127.0.0.1:${port}/relay`), 'phone', options);
  t.after(async () => { peer.stop(); for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  peer.start(); await waitFor(() => connections >= 2, 1200); assert.equal(peer.online, false);
});

test('stop invalidates an asynchronous proxy route decision before any socket can be created', async () => {
  let release, started = false;
  const peer = new PeerTunnel(newPair('wss://synthetic-peer.invalid/relay'), 'phone', { ...options, routeFor: () => { started = true; return new Promise(resolve => { release = resolve; }); } });
  peer.start(); await waitFor(() => started); peer.stop(); release({ proxied: false });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(peer.socket, undefined); assert.equal(peer.attempt, null); assert.equal(peer.retry, null); assert.equal(peer.phase, 'stopped');
});
