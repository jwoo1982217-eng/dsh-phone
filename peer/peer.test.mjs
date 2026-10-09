import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { newPair, pairCode, connectionLink, parsePair, makeCipher, relayProof, relayUrl } from './protocol.mjs';
import { createRelay } from './relay.mjs';
import { PeerTunnel } from './tunnel.mjs';
import { createPeerProxy } from './proxy.mjs';
import { ConfigSync } from './config-sync.mjs';
import { browserSessionHeaders } from './browser-session.mjs';

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const waitFor = async condition => { const deadline = Date.now() + 5000; while (!condition()) { if (Date.now() > deadline) throw Error('Condition timed out'); await new Promise(r => setTimeout(r, 10)); } };
async function peers(t) {
  const relay = createRelay(), port = await listen(relay.server), pair = newPair(`ws://127.0.0.1:${port}/relay`);
  const phone = new PeerTunnel(pair, 'phone', { reconnectMs: 20 }), computer = new PeerTunnel(pair, 'computer', { reconnectMs: 20 });
  t.after(async () => { phone.stop(); computer.stop(); await relay.close(); });
  phone.start(); computer.start(); await waitFor(() => phone.online && computer.online);
  return { relay, pair, phone, computer };
}

test('pairing roundtrip, encrypted direction/session binding, tamper and replay rejection', () => {
  const p = newPair('wss://example.invalid/relay'); assert.deepEqual(parsePair(pairCode(p)), p);
  const link = connectionLink(p), url = new URL(link);
  assert.equal(url.search, ''); assert.equal(url.pathname, '/connect');
  assert.deepEqual(parsePair(link), p);
  assert.throws(() => parsePair(link.replace('/connect#', '/other#')));
  assert.throws(() => parsePair(link.replace('peer/', 'peer:3080/')));
  assert.throws(() => relayUrl('ws://example.invalid/relay'));
  assert.throws(() => relayUrl('wss://user:secret@example.invalid/relay'));
  assert.throws(() => parsePair('arbitrary'));
  const writer = makeCipher(p, 'phone', 'fresh'), reader = makeCipher(p, 'computer', 'fresh');
  const raw = writer.seal({ apiKey: 'fixture-private-secret' }); assert.ok(!raw.includes('fixture-private-secret'));
  assert.deepEqual(reader.open(raw), { apiKey: 'fixture-private-secret' }); assert.throws(() => reader.open(raw), /replayed/);
  assert.throws(() => makeCipher(p, 'phone', 'fresh').open(raw));
  assert.throws(() => makeCipher(p, 'computer', 'previous').open(raw));
  const corrupt = JSON.parse(writer.seal({ action: 'edit' })); corrupt.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => reader.open(JSON.stringify(corrupt)));
});

test('WAN asset downloads compress, preserve bytes and use a bounded concurrent acknowledgement window', async t => {
  const f = await proxyFixture(t), original = randomBytes(700000).toString('base64');
  f.ui.on('request', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript', etag: '"fixture"' }); res.end(original);
  });
  const call = f.computer.call.bind(f.computer);
  let active = 0, peak = 0;
  f.computer.call = async (action, value, timeout) => {
    if (action !== 'http.chunk') return call(action, value, timeout);
    active++; peak = Math.max(peak, active);
    try {
      const result = await call(action, value, timeout);
      await new Promise(resolve => setTimeout(resolve, 25)); return result;
    } finally { active--; }
  };
  const begins = [], phoneCall = f.phone.call.bind(f.phone);
  f.phone.call = (action, value, timeout) => { begins.push(action); return phoneCall(action, value, timeout); };
  await Promise.all([1, 2, 3].map(async n => {
    const response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/assets/fixture-${n}.js`);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('etag'), null);
    assert.equal(await response.text(), original);
  }));
  assert.ok(peak > 1, 'Downloads must not wait one WAN RTT per chunk');
  assert.ok(peak <= 16, 'All parallel downloads share the memory/backpressure limit');
  assert.equal(begins.filter(action => action === 'http.begin').length, 3);
  assert.equal(begins.filter(action => action === 'http.end').length, 0);
});

test('small static replies take one tunnel call; larger bodies preserve every byte', async t => {
  const f = await proxyFixture(t), small = '<body>small document</body>', large = randomBytes(500000).toString('base64');
  f.ui.on('request', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url === '/small' ? small : large);
  });
  let chunks = 0, done = 0;
  const call = f.computer.call.bind(f.computer);
  f.computer.call = (action, ...args) => { chunks += action === 'http.chunk'; done += action === 'http.done'; return call(action, ...args); };
  const response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/small`);
  assert.equal(await response.text(), '<body>small document<aside>电脑模式</aside></body>');
  assert.equal(chunks, 0); assert.equal(done, 0);
  const big = await fetch(`http://127.0.0.1:${f.uiProxyPort}/big`);
  assert.equal(await big.text(), large); assert.ok(chunks > 1); assert.equal(done, 1);
  // Old callers do not request inline bodies and keep the streamed protocol.
  const legacy = await f.phone.call('http.begin', { id: 'legacy-static', service: 'ui', url: '/small', method: 'GET', fast: true, headers: {} });
  assert.equal(legacy.inlineBody, undefined);
});

test('matching shipped UI bytes are reused while the complete computer script is verified', async t => {
  const shared = randomBytes(900000), rest = randomBytes(400000);
  const body = Buffer.concat([Buffer.from('computer-prefix'), shared, rest]);
  const f = await proxyFixture(t, { reusableScripts: [shared], computerReusableScripts: [shared] });
  f.ui.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(body); });
  let transferred = 0;
  const call = f.computer.call.bind(f.computer);
  f.computer.call = (action, value, ...args) => {
    if (action === 'http.chunk') transferred += Buffer.from(value.data, 'base64').length;
    return call(action, value, ...args);
  };
  const response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/plugins/??fixture/client.js&rev=0123456789ab`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-encoding'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  assert.ok(transferred < 450000, 'Shared bytes must not cross the relay');
});

test('different UI builds remain remote and inline reusable scripts preserve exact bytes', async t => {
  const shared = Buffer.from('large-shipped-registration;\n'.repeat(30000));
  const body = Buffer.concat([Buffer.from('before;'), shared, Buffer.from('after;')]);
  const f = await proxyFixture(t, { reusableScripts: [shared], computerReusableScripts: [shared] });
  f.ui.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(req.url.includes('different') ? Buffer.from('different computer build') : body); });
  const matched = await fetch(`http://127.0.0.1:${f.uiProxyPort}/plugins/??fixture/client.js&rev=0123456789ab`);
  assert.deepEqual(Buffer.from(await matched.arrayBuffer()), body);
  const different = await fetch(`http://127.0.0.1:${f.uiProxyPort}/plugins/??different/client.js&rev=0123456789ab`);
  assert.equal(await different.text(), 'different computer build');
  assert.equal(different.headers.get('content-encoding'), 'gzip');
});

test('an invalid full-script checksum cannot return reconstructed UI code', async t => {
  const shared = Buffer.from('local-registration;'.repeat(1000));
  const f = await proxyFixture(t, { reusableScripts: [shared], computerReusableScripts: [shared] });
  f.ui.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(shared); });
  const call = f.phone.call.bind(f.phone);
  f.phone.call = async (action, ...args) => {
    const reply = await call(action, ...args);
    if (action === 'http.begin' && reply.reused) reply.reused.fullHash = '0'.repeat(64);
    return reply;
  };
  await assert.rejects(async () => {
    const response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/plugins/??fixture/client.js&rev=0123456789ab`);
    await response.arrayBuffer();
  });
});

test('combined plugin URLs use compression; streamed API responses remain incremental', async t => {
  const f = await proxyFixture(t), script = 'export const fixture = "compress me";\n'.repeat(20000);
  f.ui.on('request', (req, res) => {
    if (req.url.startsWith('/plugins/??')) {
      res.writeHead(200, { 'content-type': 'text/javascript', etag: '"fixture-combined"' }); res.end(script);
    } else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: fixture\n\n'); }
  });
  const response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/plugins/??a/client.js,b/client.js&rev=0123456789ab`);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(await response.text(), script);
  const api = await fetch(`http://127.0.0.1:${f.uiProxyPort}/api/events`);
  assert.equal(api.headers.get('content-encoding'), null);
  assert.equal(await api.text(), 'data: fixture\n\n');
});

test('real relay, fresh handshake, RPC, wrong proof and duplicate device', async t => {
  const { relay, pair, phone, computer } = await peers(t);
  computer.handler = (action, value) => ({ action, value });
  assert.deepEqual(await phone.call('fixture', { n: 3 }), { action: 'fixture', value: { n: 3 } });
  for (const proof of ['0'.repeat(64), relayProof(pair)]) {
    const denied = new WebSocket(pair.relay); await once(denied, 'open');
    denied.send(JSON.stringify({ type: 'join', role: 'phone', room: pair.room, proof }));
    assert.equal((await once(denied, 'close'))[0], 1008);
  }
  assert.equal(relay.rooms.size, 1); assert.equal(phone.online, true);
});

test('disconnect rejects pending mutation and reconnect never repeats it; stale ciphertext cannot execute', async t => {
  const { pair, phone, computer } = await peers(t); let count = 0, release;
  computer.handler = async () => { count++; await new Promise(r => release = r); return {}; };
  let captured; const send = phone.socket.send.bind(phone.socket);
  phone.socket.send = data => { if (JSON.parse(data).phase === 'session') captured = data; return send(data); };
  const pending = phone.call('mutation', {}); await waitFor(() => count === 1);
  phone.socket.terminate(); await assert.rejects(pending, /未自动重复/);
  await waitFor(() => phone.online && computer.online); release();
  assert.equal(count, 1);
  const stale = new PeerTunnel(pair, 'phone'); // Stand-in for a complete process restart.
  stale.stop();
  phone.socket.send(captured);
  await waitFor(() => !computer.online); assert.equal(count, 1);
});

async function proxyFixture(t, { computerHeaders, computerReusableScripts = [], ...options } = {}) {
  const f = await peers(t), ui = createServer(), gateway = createServer();
  const webPort = await listen(ui), gatewayPort = await listen(gateway);
  let allowed = true;
  const phoneProxy = createPeerProxy(f.phone, { role: 'phone', gatewayPort, allowGateway: () => allowed, gatewayKey: async () => 'fixture-gateway-key', transformHtml: html => html.replace('</body>', '<aside>电脑模式</aside></body>'), ...options });
  const computerProxy = createPeerProxy(f.computer, { role: 'computer', webPort, reusableScripts: computerReusableScripts, uiHeaders: computerHeaders });
  f.phone.handler = phoneProxy.action; f.computer.handler = computerProxy.action;
  const uiProxyPort = await listen(phoneProxy.ui), remoteGatewayPort = await listen(computerProxy.gateway);
  t.after(async () => { phoneProxy.close(); computerProxy.close(); await Promise.all([ui, gateway, phoneProxy.ui, computerProxy.gateway].map(closeServer)); });
  return { ...f, ui, gateway, uiProxyPort, remoteGatewayPort, webPort, phoneProxy, computerProxy, denyGateway() { allowed = false; } };
}

test('phone reuses only immutable matching UI assets; different SDK revisions and computer APIs stay remote', async t => {
  const localRequests = [], remoteRequests = [];
  const sdk = '/plugins/@deepseek-ai/dsh-client-runtime/client.js?rev=0123456789ab';
  const combined = '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js,@deepseek-ai/dsh-client-ui-schedule/client.js&rev=abcdef012345';
  const local = createServer((req, res) => {
    localRequests.push(req.url);
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end(`<script src="${sdk}"></script><link rel="modulepreload" href="${combined.slice(1).replaceAll('&', '&amp;')}">`); return; }
    res.writeHead(200, { 'content-type': 'text/javascript' }).end('matching local UI');
  });
  const localWebPort = await listen(local); t.after(() => closeServer(local));
  const f = await proxyFixture(t, { localWebPort });
  f.ui.on('request', (req, res) => { remoteRequests.push(req.url); res.writeHead(200, { 'content-type': 'text/javascript' }).end('computer response'); });
  const get = async path => (await fetch(`http://127.0.0.1:${f.uiProxyPort}${path}`)).text();
  assert.equal(await get('/assets/vendor-ABCDEFGH.js'), 'matching local UI');
  assert.equal(await get(sdk), 'matching local UI');
  assert.equal(await get(combined), 'matching local UI');
  const other = sdk.replace('0123456789ab', 'aaaaaaaaaaaa');
  assert.equal(await get(other), 'computer response');
  const otherCombined = combined.replace('abcdef012345', 'bbbbbbbbbbbb');
  assert.equal(await get(otherCombined), 'computer response');
  assert.equal(await get('/api'), 'computer response');
  assert.deepEqual(remoteRequests, [other, otherCombined, '/api']);
  assert.ok(!localRequests.includes('/api'));
});

test('real encrypted HTTP uploads, HTML adaptation, SSE incremental response and gateway auth', async t => {
  const f = await proxyFixture(t); let body = '';
  f.ui.on('request', async (req, res) => {
    assert.equal(req.headers.host, `127.0.0.1:${f.webPort}`);
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end('<body>fixture</body>'); return; }
    const parts = []; for await (const chunk of req) parts.push(chunk); body = Buffer.concat(parts).toString();
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ length: body.length }));
  });
  const page = await fetch(`http://127.0.0.1:${f.uiProxyPort}/`); assert.ok((await page.text()).includes('电脑模式'));
  const payload = '代码'.repeat(100000);
  const uploaded = await fetch(`http://127.0.0.1:${f.uiProxyPort}/api`, { method: 'POST', body: payload });
  assert.equal(uploaded.status, 201); assert.equal((await uploaded.json()).length, payload.length); assert.equal(body, payload);
  let finish;
  f.gateway.on('request', (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-gateway-key');
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
    finish = () => res.end('data: [DONE]\n\n');
  });
  const response = await fetch(`http://127.0.0.1:${f.remoteGatewayPort}/v1/chat/completions`, { method: 'POST', body: '{}' });
  const reader = response.body.getReader(); const first = await reader.read();
  assert.ok(new TextDecoder().decode(first.value).includes('first')); finish();
  let rest = ''; while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
  assert.ok(rest.includes('[DONE]'));
});

test('shared model gateway returns actionable JSON when offline or a peer request fails', async t => {
  const f = await proxyFixture(t);
  f.denyGateway();
  const unavailable = await fetch(`http://127.0.0.1:${f.remoteGatewayPort}/v1/models`);
  assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).error.code, 'PEER_UNAVAILABLE');
  f.phone.stop(); await waitFor(() => !f.computer.online);
  const offline = await fetch(`http://127.0.0.1:${f.remoteGatewayPort}/v1/models`);
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).error.code, 'PEER_OFFLINE');
});

test('WebSocket retains immediate DSH snapshot, streams updates and denies client writes', async t => {
  const f = await proxyFixture(t), events = new WebSocketServer({ server: f.ui }); t.after(() => events.close());
  events.on('connection', ws => { ws.send('initial snapshot'); setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send('task progress'); }, 30); });
  const ws = new WebSocket(`ws://127.0.0.1:${f.uiProxyPort}/api/events.mux`); const messages = [];
  ws.on('message', data => messages.push(data.toString())); t.after(() => ws.terminate());
  await once(ws, 'open'); await waitFor(() => messages.length === 2);
  assert.deepEqual(messages, ['initial snapshot', 'task progress']); ws.send('unauthorized upstream');
  assert.equal((await once(ws, 'close'))[0], 1008);
});

test('proxy rejects cross-origin access, arbitrary targets, forbidden ws, revoked gateway and cancels stream', async t => {
  const f = await proxyFixture(t);
  const denied = await fetch(`http://127.0.0.1:${f.uiProxyPort}/`, { headers: { origin: 'https://example.invalid' } }); assert.equal(denied.status, 403);
  await assert.rejects(f.phone.call('http.begin', { id: 'ssrf', service: 'ui', method: 'GET', url: '//example.invalid/', headers: {} }));
  await assert.rejects(f.computer.call('http.begin', { id: 'otherpath', service: 'gateway', method: 'POST', url: '/phone-account', headers: {} }));
  await assert.rejects(f.phone.call('ws.open', { id: 'badws', url: '/api/execute' }));
  f.denyGateway(); await assert.rejects(f.computer.call('http.begin', { id: 'revoked', service: 'gateway', method: 'GET', url: '/v1/models', headers: {} }));
  let cancelled = false;
  f.ui.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); res.on('close', () => cancelled = true); });
  const controller = new AbortController(), response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/stream`, { signal: controller.signal });
  await response.body.getReader().read(); controller.abort(); await waitFor(() => cancelled);
});

function stores(values) {
  const descriptors = structuredClone(values), secrets = new Map();
  const settings = { describe: () => structuredClone(descriptors), async mutate(ns, ops, revision) {
    const d = descriptors.find(d => d.ns === ns); assert.equal(d.revision, revision);
    for (const op of ops) { if (!op.path.length) { d.user = structuredClone(op.value); d.value = structuredClone(op.value); } else { d.user ??= {}; d.user.providers ??= {}; d.user.providers[op.path[1]] = structuredClone(op.value); d.value.providers[op.path[1]] = structuredClone(op.value); } }
    d.revision++;
  }, async replace(ns, user, revision) { const d = descriptors.find(d => d.ns === ns); assert.equal(d.revision, revision); d.user = structuredClone(user); d.value = structuredClone(user); d.revision++; } };
  const credentials = { async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref) } : undefined; }, async set(ref, value) { secrets.set(ref, value); }, async unset(ref) { secrets.delete(ref); } };
  return { settings, credentials, descriptors, secrets };
}
const pi = providers => ({ ns: 'llm-pi-ai', value: { providers }, user: { providers }, revision: 0 });
const route = (id, extra = {}) => ({ ns: 'llm-pi-ai', id, config: { baseURL: 'https://api.example.invalid/v1', displayName: id, apiKeyEnv: 'PHONE_KEY', models: [{ id: 'fixture-model' }], headers: { 'x-custom': 'fixture-header' }, ...extra }, secret: 'fixture-secret' });

test('config snapshot selects ordinary APIs and excludes local routes, absent keys and account credentials', async () => {
  const s = stores([pi({ custom: route('custom').config, local: { baseURL: 'http://127.0.0.1:8326/v1' }, missing: { apiKeyEnv: 'ABSENT' } }), { ns: 'chatgpt-account', value: { token: 'oauth-secret' }, revision: 0 }]);
  s.secrets.set('PHONE_KEY', 'fixture-secret'); const snapshot = await new ConfigSync(s.settings, s.credentials).snapshot();
  assert.deepEqual(snapshot.routes.map(r => r.id), ['custom']); assert.equal(snapshot.routes[0].secret, 'fixture-secret');
  assert.deepEqual(snapshot.skipped, ['local', 'missing']); assert.ok(!JSON.stringify(snapshot).includes('oauth-secret'));
});

test('sync preview hides secrets and headers; keep/replace merges with independent credential references', async () => {
  const s = stores([pi({ existing: { baseURL: 'https://desktop.invalid', apiKeyEnv: 'DESKTOP_KEY' } })]); s.secrets.set('DESKTOP_KEY', 'desktop-secret');
  const sync = new ConfigSync(s.settings, s.credentials), snapshot = { version: 1, routes: [route('existing'), route('new')], skipped: [] };
  const preview = sync.preview(snapshot); assert.equal(preview.routes[0].conflict, true);
  assert.ok(!JSON.stringify(preview).includes('fixture-secret')); assert.ok(!JSON.stringify(preview).includes('fixture-header'));
  assert.deepEqual(await sync.commit(preview.token), { imported: ['new'], retained: ['existing'] });
  assert.equal(s.descriptors[0].value.providers.existing.apiKeyEnv, 'DESKTOP_KEY');
  const config = s.descriptors[0].value.providers.new; assert.match(config.apiKeyEnv, /^DSH_SYNC_/); assert.equal(s.secrets.get(config.apiKeyEnv), 'fixture-secret');
  await sync.commit(sync.preview(snapshot).token, 'replace'); assert.equal(s.secrets.get('DESKTOP_KEY'), 'desktop-secret');
  assert.equal(s.descriptors[0].value.providers.existing.baseURL, route('existing').config.baseURL);
});

test('sync rejects stale previews, malformed routes, and expiry without writing credentials', async () => {
  const s = stores([pi({})]), sync = new ConfigSync(s.settings, s.credentials), snapshot = { version: 1, routes: [route('new')] };
  const p = sync.preview(snapshot); s.descriptors[0].revision++;
  await assert.rejects(sync.commit(p.token), /配置已变化/); assert.equal(s.secrets.size, 0);
  for (const bad of [route('__proto__'), { ...route('new'), ns: 'credentials' }, route('new', { baseURL: 'http://localhost:3080' })]) assert.throws(() => sync.preview({ version: 1, routes: [bad] }));
  const expired = sync.preview(snapshot); sync.previews.get(expired.token).at = 0;
  await assert.rejects(sync.commit(expired.token), /过期/); assert.equal(s.secrets.size, 0);
});

test('failed multi-namespace sync rolls back and cleans new keys; concurrent edits are preserved', async () => {
  const s = stores([pi({}), { ns: 'llm-deepseek', value: {}, user: {}, revision: 0 }]);
  const original = s.settings.mutate; s.settings.mutate = async (ns, ...args) => { if (ns === 'llm-deepseek') throw Error('fixture-secret must not appear'); return original(ns, ...args); };
  const sync = new ConfigSync(s.settings, s.credentials), snapshot = { version: 1, routes: [route('new'), { ns: 'llm-deepseek', id: 'deepseek', config: {}, secret: 'fixture-secret' }] };
  await assert.rejects(sync.commit(sync.preview(snapshot).token, 'replace'), /已恢复/); assert.deepEqual(s.descriptors[0].user, { providers: {} }); assert.equal(s.secrets.size, 0);
  s.settings.mutate = async (ns, ...args) => { if (ns === 'llm-deepseek') { s.descriptors[0].revision++; s.descriptors[0].user.marker = 'concurrent'; throw Error(); } return original(ns, ...args); };
  await assert.rejects(sync.commit(sync.preview(snapshot).token, 'replace'), /并发修改/); assert.equal(s.descriptors[0].user.marker, 'concurrent'); assert.ok(s.secrets.size > 0);
});


test('new browser authentication stays on desktop and remote.mux preserves live snapshots', async t => {
  let bootstrap = 0;
  let auth;
  const f = await proxyFixture(t, { computerHeaders: () => auth() });
  auth = browserSessionHeaders({ authenticatedUrl: root => root + '?token=fixture-only' }, f.webPort);
  f.ui.on('request', (req, res) => {
    if (req.url === '/?token=fixture-only') {
      bootstrap++; res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-fixture_-1=fixture-cookie; HttpOnly; SameSite=Strict' }).end(); return;
    }
    if (req.headers.cookie !== 'dsh-auth-fixture_-1=fixture-cookie') { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'private-do-not-forward=1' }).end('<body>authenticated desktop</body>');
  });
  assert.equal((await fetch(`http://127.0.0.1:${f.webPort}/`)).status, 401);
  const response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/`, { headers: { cookie: 'untrusted-phone-cookie=1' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /authenticated desktop/);
  const events = new WebSocketServer({ server: f.ui }); t.after(() => events.close());
  events.on('connection', (ws, req) => {
    assert.equal(req.url, '/api/remote.mux');
    assert.equal(req.headers.cookie, 'dsh-auth-fixture_-1=fixture-cookie');
    ws.on('message', (value, binary) => { assert.equal(binary, false); ws.send('subscription accepted: '+value.toString()); });
    ws.send('initial V4 snapshot');
    setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send('live update'), 30);
  });
  const ws = new WebSocket(`ws://127.0.0.1:${f.uiProxyPort}/api/remote.mux`), messages = [];
  t.after(() => ws.terminate()); ws.on('message', value => messages.push(value.toString()));
  await once(ws, 'open'); await waitFor(() => messages.length === 2);
  assert.deepEqual(messages, ['initial V4 snapshot', 'live update']);
  ws.send('open-session-stream'); await waitFor(() => messages.length === 3);
  assert.equal(messages[2], 'subscription accepted: open-session-stream');
  assert.equal(bootstrap, 1);
});

test('remote HTML revalidation cannot retain an older mobile presentation', async t => {
  const f = await proxyFixture(t);
  f.ui.on('request', (req, res) => {
    if (req.headers['if-none-match'] || req.headers['if-modified-since']) {
      res.writeHead(304, {etag:'"computer-document"'}).end(); return;
    }
    res.writeHead(200, { 'content-type':'text/html', etag:'"computer-document"',
      'last-modified':'Sun, 04 Oct 2026 00:00:00 GMT', 'cache-control':'max-age=3600' }).end('<body>new document</body>');
  });
  const response = await fetch(`http://127.0.0.1:${f.uiProxyPort}/`, { headers: {
    'if-none-match':'"computer-document"', 'if-modified-since':'Sun, 04 Oct 2026 00:00:00 GMT', accept:'text/html',
  }});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('last-modified'), null);
  assert.match(await response.text(), /new document.*电脑模式/);
});
