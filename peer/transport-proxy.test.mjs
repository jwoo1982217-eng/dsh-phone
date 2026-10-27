import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transportOptions, environmentRoute, nativeProxySupported, runtimeRoute } from './transport-proxy.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function proxyFixture(t) {
  const target = http.createServer(), sockets = new WebSocketServer({ server: target });
  sockets.on('connection', socket => socket.on('message', data => socket.send('received:' + data)));
  const targetPort = await listen(target), routed = [], connections = new Set();
  const proxy = http.createServer();
  const tunnel = (req, socket, head, connect) => {
    routed.push({ path: req.url, host: req.headers.host }); connections.add(socket); socket.on('close', () => connections.delete(socket));
    const upstream = net.connect(targetPort, '127.0.0.1'); connections.add(upstream); upstream.on('close', () => connections.delete(upstream));
    upstream.on('connect', () => {
      if (connect) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      else { const url = new URL(req.url, 'http://' + req.headers.host); upstream.write(`${req.method} ${url.pathname + url.search} HTTP/1.1\r\n${Object.entries(req.headers).map(([key,value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`); }
      if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  };
  proxy.on('upgrade', (req, socket, head) => tunnel(req, socket, head, false));
  proxy.on('connect', (req, socket, head) => tunnel(req, socket, head, true));
  const port = await listen(proxy);
  t.after(async () => { for (const socket of sockets.clients) socket.terminate(); for (const socket of connections) socket.destroy(); await new Promise(resolve => sockets.close(resolve)); await Promise.all([new Promise(resolve => target.close(resolve)), new Promise(resolve => proxy.close(resolve))]); });
  return { proxy: `http://127.0.0.1:${port}`, routed };
}

test('selected proxy routes a real WebSocket for an unresolvable public host without changing global agents', async t => {
  const f = await proxyFixture(t), originalHttp = http.globalAgent, originalHttps = https.globalAgent;
  let translated;
  const options = await transportOptions('ws://synthetic-peer.invalid/relay?room=synthetic', { routeFor: async url => { translated = url.protocol; return { proxied: true, proxy: f.proxy }; } });
  t.after(options.release);
  const ws = new WebSocket('ws://synthetic-peer.invalid/relay?room=synthetic', { agent: options.agent });
  t.after(() => ws.terminate());
  await once(ws, 'open'); const message = once(ws, 'message'); ws.send('opaque-bytes');
  assert.equal((await message)[0].toString(), 'received:opaque-bytes');
  assert.equal(translated, 'http:'); assert.equal(f.routed.length, 1); assert.match(f.routed[0].host, /synthetic-peer.invalid/);
  assert.equal(http.globalAgent, originalHttp); assert.equal(https.globalAgent, originalHttps);
});

test('loopback bypass, old-runtime guard, and environment fallback do not silently select direct for an explicit proxy', async () => {
  const options = await transportOptions('ws://127.0.0.1:1/relay', { routeFor: () => { throw Error('loopback must bypass'); } }); options.release();
  await assert.rejects(transportOptions('wss://synthetic.invalid/relay', { nodeVersion: '22.20.0', routeFor: url => { assert.equal(url.protocol, 'https:'); return { proxied: true, proxy: 'http://127.0.0.1:9' }; } }), { code: 'PEER_PROXY_UNSUPPORTED' });
  await assert.rejects(transportOptions('wss://synthetic.invalid/relay', { routeFor: () => ({ proxied: true, proxy: 'socks5://127.0.0.1:9' }) }), { code: 'PEER_PROXY_INVALID' });
  for (const version of ['22.21.0','24.5.0','26.0.0']) assert.equal(nativeProxySupported(version), true);
  assert.deepEqual(environmentRoute(new URL('https://outside.invalid'), { HTTPS_PROXY: 'http://127.0.0.1:9' }), { proxied: true, proxy: 'http://127.0.0.1:9' });
  assert.deepEqual(environmentRoute(new URL('https://inside.example.invalid'), { HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '.example.invalid' }), { proxied: false });
});

test('SDK matcher snapshot routes WebSockets even after process environment changes', async t => {
  let sdk;
  try { sdk = await import('@deepseek-ai/dsh-http-proxy'); } catch {}
  if (typeof sdk?.proxyRouteFor !== 'function') { t.skip('Pinned alpha.1 has no SDK matcher; environment fallback is covered separately'); return; }
  const f = await proxyFixture(t);
  const env = { HTTP_PROXY: f.proxy, HTTPS_PROXY: f.proxy };
  const restore = await sdk.installProxyFromEnvironment({ get: name => env[name] ? { value: env[name] } : undefined }, () => {});
  t.after(restore);
  const previous = process.env.HTTP_PROXY; delete process.env.HTTP_PROXY;
  t.after(() => { if (previous === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous; });
  const options = await transportOptions('ws://synthetic-peer.invalid/relay'); t.after(options.release);
  const ws = new WebSocket('ws://synthetic-peer.invalid/relay', { agent: options.agent }); t.after(() => ws.terminate());
  await once(ws, 'open'); const message = once(ws, 'message'); ws.send('sdk-route');
  assert.equal((await message)[0].toString(), 'received:sdk-route'); assert.equal(f.routed.length, 1);
});


test('older SDK without the optional matcher uses environment proxy selection instead of a direct fallback', async () => {
  const url = new URL('https://synthetic-peer.invalid/relay'), env = { HTTPS_PROXY: 'http://127.0.0.1:9' };
  assert.deepEqual(await runtimeRoute(url, { env, loadSdk: async () => ({}) }), { proxied: true, proxy: env.HTTPS_PROXY });
  assert.deepEqual(await runtimeRoute(url, { env, loadSdk: async () => { throw Object.assign(Error('module absent'), { code: 'ERR_MODULE_NOT_FOUND' }); } }), { proxied: true, proxy: env.HTTPS_PROXY });
});

test('WSS uses a real HTTP CONNECT proxy with normal certificate verification and rejects an untrusted certificate', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'peer-wss-ca-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'openssl.cnf'), key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=synthetic-peer.invalid\n[extensions]\nsubjectAltName=DNS:synthetic-peer.invalid\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const certificate = await readFile(cert, 'utf8'), originalCAs = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...originalCAs, certificate]); t.after(() => tls.setDefaultCACertificates(originalCAs));
  const server = https.createServer({ key: await readFile(key), cert: certificate }), sockets = new WebSocketServer({ server });
  sockets.on('connection', ws => ws.on('message', value => ws.send('secure:' + value)));
  const targetPort = await listen(server), connections = new Set(), requests = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    requests.push(req.url); connections.add(client); client.on('close', () => connections.delete(client));
    const upstream = net.connect(targetPort, '127.0.0.1'); connections.add(upstream); upstream.on('close', () => connections.delete(upstream));
    upstream.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
  });
  const proxyPort = await listen(proxy), url = `wss://synthetic-peer.invalid:${targetPort}/relay`, routeFor = () => ({ proxied: true, proxy: `http://127.0.0.1:${proxyPort}` });
  t.after(async () => { for (const ws of sockets.clients) ws.terminate(); for (const socket of connections) socket.destroy(); await new Promise(resolve => sockets.close(resolve)); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]); });
  const options = await transportOptions(url, { routeFor }); t.after(options.release);
  const ws = new WebSocket(url, { agent: options.agent }); t.after(() => ws.terminate());
  await once(ws, 'open'); assert.equal(ws._socket.authorized, true);
  const message = once(ws, 'message'); ws.send('opaque-ciphertext'); assert.equal((await message)[0].toString(), 'secure:opaque-ciphertext');
  assert.equal(requests[0], `synthetic-peer.invalid:${targetPort}`);
  tls.setDefaultCACertificates(originalCAs);
  const untrustedOptions = await transportOptions(url, { routeFor }); t.after(untrustedOptions.release);
  const untrusted = new WebSocket(url, { agent: untrustedOptions.agent }); t.after(() => untrusted.terminate());
  await assert.rejects(once(untrusted, 'open'), /self.signed|unable to verify|certificate/i);
  assert.equal(requests.length, 2);
});
