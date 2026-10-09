import { createServer, request } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createGzip, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { MAX_BODY } from './protocol.mjs';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const HOP = new Set(['host', 'connection', 'upgrade', 'transfer-encoding', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'cookie', 'set-cookie', 'origin', 'referer', 'sec-fetch-site', 'accept-encoding', 'content-length']);
export function cleanHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([k, v]) => !HOP.has(k.toLowerCase()) && !k.toLowerCase().startsWith('sec-websocket-') && (typeof v === 'string' || Array.isArray(v))));
}
function safePath(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) throw Error('Invalid path');
  return new URL(value, 'http://127.0.0.1').pathname + new URL(value, 'http://127.0.0.1').search;
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const comboPath = path => path.startsWith('/plugins/??') && /&rev=[a-f0-9]{12}$/.test(path) && path.length <= 8192;
export function createPeerProxy(tunnel, { role, webPort = 3080, localWebPort, uiHeaders = async () => ({}), gatewayPort = 8326, gatewayKey = async () => undefined, allowGateway = () => true, transformHtml = html => html, assets = new Map(), reusableScripts = [] } = {}) {
  const reusable = new Map(reusableScripts.filter(bytes => Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BODY / 2).slice(0, 1).map(bytes => [digest(bytes), bytes]));
  const outgoing = new Map(), incoming = new Map(), localWs = new Map(), remoteWs = new Map();
  // Bound all response chunks together, including concurrent asset downloads.
  // A small window avoids paying a full WAN round trip for every 48 KiB.
  let chunkCalls = 0;
  const chunkWaiters = [];
  let preloads;
  const localResponse = async path => {
    const headers = await uiHeaders();
    return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: localWebPort, path, method: 'GET', headers }, resolve);
    req.once('error', reject); req.setTimeout(2000, () => req.destroy(Error('Local asset unavailable'))); req.end();
    });
  };
  const localAsset = async (req, res) => {
    if (role !== 'phone' || !localWebPort || req.method !== 'GET') return false;
    const hashed = /^\/assets\/[\w.-]+-[\w-]{8}\.(?:js|css)$/.test(req.url);
    const sdk = /^\/plugins\/@deepseek-ai\/dsh-client-(?:modules|runtime)\/client\.js\?rev=[a-f0-9]{12}$/.test(req.url) ||
      (req.url.startsWith('/plugins/??') && /&rev=[a-f0-9]{12}$/.test(req.url) && req.url.length <= 8192);
    if (!hashed && !sdk) return false;
    try {
      if (sdk) {
        preloads ??= (async () => {
          const response = await localResponse('/'); let html = '';
          for await (const bytes of response) { html += bytes.toString(); if (html.length > MAX_BODY) { response.destroy(); throw Error('Local document too large'); } }
          return new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => {
            const url = new URL(match[1].replaceAll('&amp;', '&'), `http://127.0.0.1:${localWebPort}/`);
            return url.origin === `http://127.0.0.1:${localWebPort}` ? url.pathname + url.search : '';
          }));
        })().catch(() => new Set());
        // The full revision must match, so mobile SDK overlays cannot replace
        // a different desktop build. Computer APIs always use the tunnel.
        if (!(await preloads).has(req.url)) return false;
      }
      const response = await localResponse(req.url);
      if (response.statusCode !== 200 || !/(?:javascript|text\/css)/.test(String(response.headers['content-type']))) { response.resume(); return false; }
      res.writeHead(200, cleanHeaders(response.headers));
      res.on('close', () => response.destroy()); response.on('error', () => res.destroy()); response.pipe(res);
      return true;
    } catch { return false; }
  };
  const sendChunk = async (id, bytes) => {
    if (chunkCalls >= 16) await new Promise(resolve => chunkWaiters.push(resolve)); else chunkCalls++;
    try {
      if (!incoming.has(id)) throw Error('Stream cancelled');
      return await tunnel.call('http.chunk', { id, data: bytes.toString('base64') });
    } finally { const next = chunkWaiters.shift(); if (next) next(); else chunkCalls--; }
  };
  const target = service => {
    if (service === 'ui' && role === 'computer') return webPort;
    if (service === 'gateway' && role === 'phone' && allowGateway()) return gatewayPort;
    throw Error('Peer service is not shared');
  };
  const finishHttp = async (id, stream) => {
    stream.req.end();
    try {
      const response = await stream.wait; stream.response = response;
      const headers = cleanHeaders(response.headers);
      let bodySource = response, reused;
      if (stream.reuse && response.statusCode === 200 && !headers['content-encoding'] && /javascript/.test(String(headers['content-type']))) {
        const chunks = [], iterator = response[Symbol.asyncIterator](); let size = 0, complete = false;
        while (size <= MAX_BODY) {
          const next = await iterator.next();
          if (next.done) { complete = true; break; }
          chunks.push(next.value); size += next.value.length;
        }
        if (complete) {
          const body = Buffer.concat(chunks), offset = body.indexOf(stream.reuse.bytes);
          if (offset >= 0) {
            reused = { hash: stream.reuse.hash, offset, size: stream.reuse.bytes.length, fullSize: body.length, fullHash: digest(body) };
            bodySource = Readable.from([body.subarray(0, offset), body.subarray(offset + reused.size)]);
          } else bodySource = Readable.from([body]);
        } else bodySource = Readable.from((async function* () {
          yield* chunks;
          for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; }
        })());
      }
      const compressed = stream.compress && response.statusCode === 200 && !headers['content-encoding'] && /(?:javascript|text\/css|image\/svg)/.test(String(headers['content-type']));
      if (compressed) {
        headers['content-encoding'] = 'gzip'; delete headers.etag;
        headers.vary = headers.vary ? headers.vary + ', Accept-Encoding' : 'Accept-Encoding';
      }
      const source = compressed ? bodySource.pipe(createGzip({ level: 6 })) : bodySource;
      bodySource.once('error', error => source.destroy(error));
      response.once('error', error => source.destroy(error));
      const iterator = source[Symbol.asyncIterator]();
      const prefix = [];
      if (stream.inline && response.statusCode === 200 && /(?:javascript|text\/css|text\/html|image\/svg)/.test(String(headers['content-type']))) {
        let size = 0;
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            incoming.delete(id);
            return { status: response.statusCode, headers, ...(reused ? { reused } : {}), inlineBody: Buffer.concat(prefix).toString('base64') };
          }
          prefix.push(next.value); size += next.value.length;
          if (size > 196608) break;
        }
      }
      setImmediate(async () => {
        const jobs = new Set();
        try {
          async function* chunks() {
            yield* prefix;
            for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; }
          }
          for await (const bytes of chunks()) for (let i = 0; i < bytes.length; i += 49152) {
            const job = sendChunk(id, bytes.subarray(i, i + 49152)); jobs.add(job);
            job.then(() => jobs.delete(job), () => {});
            if (jobs.size >= 8) await Promise.race(jobs);
          }
          await Promise.all(jobs);
          await tunnel.call('http.done', { id });
        } catch {
          source.destroy(); response.destroy();
          try { await tunnel.call('http.done', { id, error: true }); } catch {}
        } finally { await Promise.allSettled(jobs); incoming.delete(id); }
      });
      return { status: response.statusCode, headers, ...(reused ? { reused } : {}) };
    } catch (e) { incoming.delete(id); stream.req.destroy(); throw e; }
  };
  const httpAction = async (action, value) => {
    const id = value?.id;
    if (typeof id !== 'string' || id.length > 64) throw Error('Invalid stream');
    if (action === 'http.begin') {
      if (incoming.size >= 16 || incoming.has(id)) throw Error('Too many requests');
      const port = target(value.service), url = safePath(value.url);
      if (value.service === 'gateway' && !/^\/v1\/(models|chat\/completions)(\?|$)/.test(url)) throw Error('Gateway path not shared');
      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].includes(value.method)) throw Error('Invalid method');
      const headers = cleanHeaders(value.headers); headers.origin = `http://127.0.0.1:${port}`;
      // The phone adds its own presentation to documents. The computer's ETag
      // cannot validate that transformed HTML after a phone UI upgrade.
      if (value.service === 'ui' && value.method === 'GET' &&
          (/text\/html/.test(headers.accept || '') || /(?:\/|\.html)$/.test(url.split('?')[0]))) {
        delete headers['if-none-match']; delete headers['if-modified-since'];
      }
      if (value.service === 'ui') Object.assign(headers, await uiHeaders());
      if (value.service === 'gateway') { const key = await gatewayKey(); if (key) headers.authorization = `Bearer ${key}`; }
      const req = request({ hostname: '127.0.0.1', port, path: url, method: value.method, headers });
      // New DSH combines scripts at /plugins/??a/client.js,b/client.js&rev=…
      // MIME verification in finishHttp decides which responses may compress.
      const stream = { req, response: null, size: 0, wait: null, inline: value.service === 'ui' && value.method === 'GET' && value.fast === true && value.inline === true, compress: value.service === 'ui' && value.method === 'GET' && value.compress === true };
      if (value.service === 'ui' && value.method === 'GET' && value.fast === true && comboPath(url) &&
          typeof value.reuse?.hash === 'string' && reusable.get(value.reuse.hash)?.length === value.reuse.size) {
        stream.reuse = { hash: value.reuse.hash, bytes: reusable.get(value.reuse.hash) };
      }
      stream.wait = new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
      // Upload or cancellation may fail before http.end attaches its await.
      stream.wait.catch(() => {}); incoming.set(id, stream);
      req.setTimeout(600000, () => req.destroy(Error('Upstream timed out')));
      if (value.fast === true && ['GET', 'HEAD'].includes(value.method)) return finishHttp(id, stream);
      return {};
    }
    if (action === 'http.chunk' || action === 'http.done') {
      const stream = outgoing.get(id); if (!stream) return {};
      await stream.head;
      if (action === 'http.done') {
        outgoing.delete(id);
        if (value.error) stream.res.destroy(Error('Remote stream interrupted')); else stream.res.end();
      } else {
        const bytes = Buffer.from(value.data, 'base64');
        if (bytes.length > 65536) throw Error('Chunk too large');
        if (!stream.res.destroyed && !stream.res.write(bytes)) await Promise.race([once(stream.res, 'drain'), once(stream.res, 'close')]);
      }
      return {};
    }
    const stream = incoming.get(id); if (!stream) throw Error('Stream no longer active');
    if (action === 'http.cancel') { incoming.delete(id); stream.req.destroy(); stream.response?.destroy(); return {}; }
    if (action === 'http.upload') {
      const bytes = Buffer.from(value.data, 'base64'); stream.size += bytes.length;
      if (bytes.length > 65536 || stream.size > MAX_BODY) { incoming.delete(id); stream.req.destroy(); throw Error('Request body too large'); }
      if (!stream.req.write(bytes)) await Promise.race([once(stream.req, 'drain'), once(stream.req, 'close')]);
      return {};
    }
    if (action !== 'http.end') throw Error('Invalid HTTP operation');
    return finishHttp(id, stream);
  };
  const wsAction = async (action, value) => {
    const id = value?.id;
    if (typeof id !== 'string' || id.length > 64) throw Error('Invalid socket');
    if (action === 'ws.open') {
      if (remoteWs.size >= 8 || remoteWs.has(id)) throw Error('Too many sockets');
      const port = target('ui'), url = safePath(value.url);
      if (!['/api/events.mux', '/api/events.host', '/api/remote.mux'].includes(url)) throw Error('Socket path not shared');
      const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`, { origin: `http://127.0.0.1:${port}`, headers: await uiHeaders(), maxPayload: 1024 * 1024, perMessageDeflate: false });
      ws.allowUplink = url === '/api/remote.mux';
      remoteWs.set(id, ws); ws.on('error', () => {});
      let ready = false, queuedSize = 0; const queued = [];
      const forward = (data, binary) => { try { tunnel.send({ type: 'ws.data', id, binary, data: data.toString('base64') }); } catch { ws.terminate(); } };
      // DSH sends an initial state snapshot immediately on upgrade. Retain
      // it until the mobile browser has completed its own local upgrade.
      ws.on('message', (data, binary) => {
        if (ready) forward(data, binary);
        else { queuedSize += data.length; if (queuedSize > 4 * 1024 * 1024) ws.terminate(); else queued.push([data, binary]); }
      });
      ws.activate = () => { ready = true; for (const frame of queued) forward(...frame); queued.length = 0; };
      ws.on('close', () => { remoteWs.delete(id); try { tunnel.send({ type: 'ws.close', id }); } catch {} });
      let timer;
      try { await new Promise((resolve, reject) => {
        ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(Error('Upstream socket closed')));
        timer = setTimeout(() => { ws.terminate(); reject(Error('Upstream socket timed out')); }, 15000); timer.unref();
      }); } catch (e) { remoteWs.delete(id); ws.terminate(); throw e; } finally { clearTimeout(timer); }
      return {};
    }
    if (action === 'ws.ready') { const ws = remoteWs.get(id); if (!ws || ws.readyState !== WebSocket.OPEN) throw Error('Socket disconnected'); ws.activate(); return {}; }
    if (action === 'ws.close') { remoteWs.get(id)?.terminate(); remoteWs.delete(id); return {}; }
    throw Error('Invalid socket operation');
  };
  const packet = m => {
    if (m.type === 'ws.uplink') {
      const upstream = remoteWs.get(m.id);
      if (!upstream?.allowUplink || upstream.readyState !== WebSocket.OPEN) return;
      if (typeof m.data !== 'string' || m.data.length > Math.ceil(1024 * 1024 / 3) * 4 || upstream.bufferedAmount > 4 * 1024 * 1024) { upstream.terminate(); return; }
      const bytes = Buffer.from(m.data, 'base64');
      if (bytes.length > 1024 * 1024) { upstream.terminate(); return; }
      upstream.send(bytes, { binary: m.binary === true });
      return;
    }
    const ws = localWs.get(m.id);
    if (m.type === 'ws.close') { ws?.close(); localWs.delete(m.id); }
    if (m.type === 'ws.data' && ws?.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 4 * 1024 * 1024) ws.terminate(); else ws.send(Buffer.from(m.data, 'base64'), { binary: m.binary === true });
    }
  };
  tunnel.on('packet', packet);
  const disconnected = () => {
    for (const stream of outgoing.values()) { stream.resolveHead(); stream.res.destroy(); }
    outgoing.clear(); for (const stream of incoming.values()) { stream.req.destroy(); stream.response?.destroy(); } incoming.clear();
    for (const ws of [...localWs.values(), ...remoteWs.values()]) ws.terminate(); localWs.clear(); remoteWs.clear();
  };
  tunnel.on('offline', disconnected);
  const browserTrust = req => {
    if (!loopback(req.socket.remoteAddress)) return false;
    const host = req.headers.host;
    if (!host || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    return !req.headers.origin || new URL(req.headers.origin).host === host;
  };
  function serverFor(service) {
    const server = createServer(async (req, res) => {
      let id, stream;
      try {
        if (!browserTrust(req)) { res.writeHead(403).end(); return; }
        if (service === 'ui' && assets.has(req.url)) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(assets.get(req.url)); return; }
        if (!tunnel.online) {
          if (service === 'gateway') {
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { code: 'PEER_OFFLINE', type: 'server_error', message: '手机模型网关离线，请保持手机 DSH 运行并检查两端连接；请求没有自动重发。' } }));
          } else {
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' }); res.end('<meta name="viewport" content="width=device-width"><p>电脑离线或连接中。请保持家里电脑和 DSH 运行。</p><a href="http://127.0.0.1:3080/">返回手机本机</a>');
          }
          return;
        }
        if (service === 'ui' && await localAsset(req, res)) return;
        id = randomUUID();
        stream = { res, resolveHead: null, head: null }; stream.head = new Promise(resolve => { stream.resolveHead = resolve; }); outgoing.set(id, stream);
        res.on('close', () => { if (outgoing.delete(id)) { stream.resolveHead(); void tunnel.call('http.cancel', { id }).catch(() => {}); } });
        const fast = ['GET', 'HEAD'].includes(req.method) && !req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0');
        const offer = service === 'ui' && fast && req.method === 'GET' && comboPath(req.url) ? [...reusable].map(([hash, bytes]) => ({ hash, size: bytes.length }))[0] : undefined;
        let head = await tunnel.call('http.begin', { id, service, method: req.method, url: req.url, headers: cleanHeaders(req.headers), fast, inline: service === 'ui' && fast, ...(offer ? { reuse: offer } : {}), compress: /\bgzip\b/.test(req.headers['accept-encoding'] || '') });
        let length = 0;
        for await (const bytes of req) {
          length += bytes.length;
          if (length > MAX_BODY) { const e = Error('远程上传最多 16 MB'); e.status = 413; throw e; }
          for (let i = 0; i < bytes.length; i += 49152) await tunnel.call('http.upload', { id, data: bytes.subarray(i, i + 49152).toString('base64') });
        }
        // Older peers return an empty begin reply; retain compatibility.
        if (!head?.status) head = await tunnel.call('http.end', { id }, 600000);
        const html = service === 'ui' && String(head.headers['content-type']).includes('text/html');
        if (head.reused) {
          const reused = head.reused, local = reusable.get(reused.hash);
          if (!offer || !local || reused.hash !== offer.hash || reused.size !== local.length ||
              !Number.isSafeInteger(reused.offset) || reused.offset < 0 || !Number.isSafeInteger(reused.fullSize) ||
              reused.fullSize > MAX_BODY || reused.offset + reused.size > reused.fullSize ||
              !/^[a-f0-9]{64}$/.test(reused.fullHash) || !/javascript/.test(String(head.headers['content-type']))) throw Error('Invalid UI reuse receipt');
          const encoding = head.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'gzip') throw Error('Unsupported UI encoding');
          delete head.headers['content-encoding']; delete head.headers['content-length'];
          const parts = []; let size = 0;
          const originalWrite = res.write.bind(res), originalEnd = res.end.bind(res);
          res.write = bytes => { size += bytes.length; if (size > MAX_BODY) throw Error('UI reuse body too large'); parts.push(Buffer.from(bytes)); return true; };
          res.end = () => {
            res.write = originalWrite; res.end = originalEnd;
            try {
              let transferred = Buffer.concat(parts);
              if (encoding === 'gzip') transferred = gunzipSync(transferred, { maxOutputLength: MAX_BODY });
              if (transferred.length + local.length !== reused.fullSize) throw Error('UI reuse size mismatch');
              const body = Buffer.concat([transferred.subarray(0, reused.offset), local, transferred.subarray(reused.offset)]);
              if (digest(body) !== reused.fullHash) throw Error('UI reuse content mismatch');
              originalEnd(body);
            } catch { res.destroy(); }
          };
        }
        if (html) {
          delete head.headers.etag; delete head.headers['last-modified'];
          head.headers['cache-control'] = 'no-store';
          const parts = []; let size = 0;
          // Intercept only documents. Assets and streamed task/API responses
          // retain their original transport and completion semantics.
          const originalWrite = res.write.bind(res), originalEnd = res.end.bind(res);
          res.write = bytes => { size += bytes.length; if (size > MAX_BODY) throw Error('Document too large'); parts.push(Buffer.from(bytes)); return true; };
          res.end = () => { res.write = originalWrite; res.end = originalEnd; originalEnd(transformHtml(Buffer.concat(parts).toString())); };
          delete head.headers['content-security-policy'];
        }
        res.writeHead(head.status, head.headers); stream.resolveHead();
        if (head.inlineBody !== undefined) {
          if (typeof head.inlineBody !== 'string' || head.inlineBody.length > 262144) throw Error('Inline response too large');
          const bytes = Buffer.from(head.inlineBody, 'base64');
          if (bytes.length > 196608) throw Error('Inline response too large');
          outgoing.delete(id); res.write(bytes); res.end();
        }
      } catch (e) {
        stream?.resolveHead(); if (id) { outgoing.delete(id); void tunnel.call('http.cancel', { id }).catch(() => {}); }
        if (res.headersSent) res.destroy();
        else if (service === 'gateway') {
          res.writeHead(e.status ?? 502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 'PEER_UNAVAILABLE', type: 'server_error', message: '手机模型网关连接未完成，请检查两端服务和网络；请求没有自动重发。' } }));
        } else { res.writeHead(e.status ?? 502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('远程连接不可用，请检查两端服务；请求没有自动重发。'); }
      }
    });
    if (service === 'ui') {
      const acceptor = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
      server.on('upgrade', async (req, socket, head) => {
        try {
          if (!browserTrust(req) || !tunnel.online) throw Error();
          const id = randomUUID(); await tunnel.call('ws.open', { id, url: req.url });
          if (socket.destroyed) { void tunnel.call('ws.close', { id }).catch(() => {}); return; }
          acceptor.handleUpgrade(req, socket, head, ws => {
            localWs.set(id, ws); ws.on('error', () => {});
            ws.on('message', (data, binary) => {
              if (req.url !== '/api/remote.mux') { ws.close(1008, 'downlink only'); return; }
              if (data.length > 1024 * 1024) { ws.close(1009, 'frame too large'); return; }
              try { tunnel.send({ type: 'ws.uplink', id, binary, data: data.toString('base64') }); }
              catch { ws.terminate(); }
            });
            ws.on('close', () => { localWs.delete(id); void tunnel.call('ws.close', { id }).catch(() => {}); });
            void tunnel.call('ws.ready', { id }).catch(() => ws.terminate());
          });
        } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
      });
    }
    return server;
  }
  return {
    ui: serverFor('ui'), gateway: serverFor('gateway'),
    action: (action, value) => action.startsWith('http.') ? httpAction(action, value) : wsAction(action, value),
    close() { disconnected(); tunnel.off('packet', packet); tunnel.off('offline', disconnected); },
  };
}
