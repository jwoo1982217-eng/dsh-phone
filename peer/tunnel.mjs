import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { makeCipher, relayProof, MAX_FRAME } from './protocol.mjs';
import { transportOptions } from './transport-proxy.mjs';

export class PeerTunnel extends EventEmitter {
  constructor(pair, role, { reconnectMs = 1000, maxReconnectMs = 30000, handshakeTimeoutMs = 15000,
    heartbeatIntervalMs = 20000, heartbeatTimeoutMs = 10000, routeFor } = {}) {
    super(); Object.assign(this, { pair, role, reconnectMs, maxReconnectMs, handshakeTimeoutMs, heartbeatIntervalMs, heartbeatTimeoutMs, routeFor });
    this.pending = new Map(); this.stopped = false; this.online = false; this.remote = null; this.activeCalls = 0;
    this.generation = 0; this.attempts = 0; this.phase = 'idle'; this.errorCode = '';
  }
  status(phase, errorCode = '') { this.phase = phase; this.errorCode = errorCode; this.emit('state', { phase, errorCode }); }
  start() {
    if (this.stopped || this.attempt || this.retry) return;
    const generation = ++this.generation;
    const a = this.attempt = { generation, timers: new Set(), ws: null, release: null, joined: false };
    const current = () => !this.stopped && this.attempt === a && generation === this.generation;
    const timer = (fn, delay) => { const id = setTimeout(() => { a.timers.delete(id); if (current()) fn(); }, delay); id.unref(); a.timers.add(id); return id; };
    const cancel = id => { clearTimeout(id); a.timers.delete(id); };
    const fail = code => { if (current()) this.retire(code, true); };
    this.status('connecting');
    // Covers proxy resolution, HTTP upgrade, and the relay's initial joined ack.
    a.deadline = timer(() => fail('PEER_JOIN_TIMEOUT'), this.handshakeTimeoutMs);
    void (async () => {
      const options = await transportOptions(this.pair.relay, { routeFor: this.routeFor });
      if (!current()) { options.release(); return; }
      a.release = options.release;
      const url = new URL(this.pair.relay); url.searchParams.set('room', this.pair.room);
      const ws = a.ws = this.socket = new WebSocket(url, { agent: options.agent, headers: { Authorization: `Bearer ${relayProof(this.pair)}` }, maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: this.handshakeTimeoutMs });
      const handshakeCipher = makeCipher(this.pair, this.role);
      let challenge = null, remoteChallenge = null, cryptoDeadline;
      const sendHandshake = m => ws.send(JSON.stringify({ phase: 'handshake', frame: JSON.parse(handshakeCipher.seal(m)) }));
      const heartbeat = () => {
        if (!current()) return;
        a.pongDeadline = timer(() => fail('PEER_HEARTBEAT_TIMEOUT'), this.heartbeatTimeoutMs);
        try { ws.ping(); } catch { fail('PEER_NETWORK'); }
      };
      ws.on('pong', () => { if (!current()) return; cancel(a.pongDeadline); cancel(a.nextPing); a.nextPing = timer(heartbeat, this.heartbeatIntervalMs); });
      ws.on('open', () => { if (current()) ws.send(JSON.stringify({ type: 'join', room: this.pair.room, proof: relayProof(this.pair), role: this.role })); });
      ws.on('error', error => fail(error.code === 'ENOTFOUND' ? 'PEER_DNS' : error.code === 'ECONNREFUSED' ? 'PEER_CONNECTION_REFUSED' : 'PEER_NETWORK'));
      ws.on('message', bytes => {
        if (!current()) return;
        try {
          const raw = JSON.parse(bytes.toString());
          if (raw.type === 'joined') {
            if (a.joined) throw Error();
            a.joined = true; cancel(a.deadline); this.status('waiting'); this.emit('connected'); a.nextPing = timer(heartbeat, this.heartbeatIntervalMs); return;
          }
          if (!a.joined) throw Error();
          // Relay signals only trigger an encrypted handshake, never business calls.
          if (raw.type === 'peer-online') {
            this.disconnected(); cancel(cryptoDeadline); challenge = randomBytes(16).toString('hex'); remoteChallenge = null;
            this.status('handshaking'); cryptoDeadline = timer(() => fail('PEER_HANDSHAKE_TIMEOUT'), this.handshakeTimeoutMs);
            sendHandshake({ type: 'hello', role: this.role, challenge }); return;
          }
          if (raw.type === 'peer-offline') { cancel(cryptoDeadline); this.disconnected(); challenge = null; this.status('waiting'); return; }
          if (raw.phase === 'handshake') {
            const m = handshakeCipher.open(JSON.stringify(raw.frame));
            if (!challenge || m.role !== (this.role === 'phone' ? 'computer' : 'phone') || !/^[a-f0-9]{32}$/.test(m.challenge)) throw Error();
            if (m.type === 'hello') {
              if (this.online) throw Error();
              remoteChallenge = m.challenge;
              sendHandshake({ type: 'hello-ack', role: this.role, challenge, replyTo: m.challenge }); return;
            }
            if (m.type !== 'hello-ack' || m.replyTo !== challenge || (remoteChallenge && remoteChallenge !== m.challenge)) throw Error();
            remoteChallenge = m.challenge;
            const session = this.role === 'phone' ? challenge + m.challenge : m.challenge + challenge;
            this.sessionCipher = makeCipher(this.pair, this.role, session);
            cancel(cryptoDeadline); this.attempts = 0; this.online = true; this.remote = m.role; this.status('online'); this.emit('online'); return;
          }
          if (!this.online) return;
          if (raw.phase !== 'session') throw Error();
          const m = this.sessionCipher.open(JSON.stringify(raw.frame));
          if (m.type === 'reply') {
            const p = this.pending.get(m.id); if (!p) return;
            this.pending.delete(m.id); clearTimeout(p.timer);
            if (m.ok) p.resolve(m.value); else p.reject(Error(m.error || '远程操作失败'));
          } else if (m.type === 'call') {
            if (this.activeCalls >= 64 || typeof m.id !== 'string' || m.id.length > 64 || typeof m.action !== 'string') throw Error();
            this.activeCalls++; const sessionCipher = this.sessionCipher;
            const reply = result => { if (current() && this.sessionCipher === sessionCipher && this.online) this.send({ type: 'reply', id: m.id, ...result }); };
            Promise.resolve().then(() => this.handler?.(m.action, m.value)).then(value => reply({ ok: true, value }), () => reply({ ok: false, error: '远程操作失败，请检查连接和配置' })).catch(() => {}).finally(() => this.activeCalls--);
          } else this.emit('packet', m);
        } catch { fail('PEER_PROTOCOL'); }
      });
      ws.on('close', () => fail('PEER_CLOSED'));
    })().catch(error => fail(['PEER_PROXY_UNSUPPORTED', 'PEER_PROXY_INVALID'].includes(error.code) ? error.code : 'PEER_START_FAILED'));
  }
  retire(code, retry) {
    const a = this.attempt; this.attempt = null; ++this.generation;
    if (a) { for (const id of a.timers) clearTimeout(id); a.ws?.terminate(); a.release?.(); }
    this.disconnected();
    if (retry && !this.stopped) {
      this.status('retrying', code);
      const cap = Math.min(this.maxReconnectMs, this.reconnectMs * 2 ** Math.min(this.attempts++, 20));
      const delay = Math.max(1, Math.round(cap * (0.5 + Math.random() * 0.5)));
      this.retry = setTimeout(() => { this.retry = null; this.start(); }, delay); this.retry.unref();
    }
  }
  reconnect() {
    if (this.stopped) return;
    clearTimeout(this.retry); this.retry = null; this.retire('', false); this.start();
  }
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.online || !this.sessionCipher) throw Error('远程设备未连接');
    if (this.socket.bufferedAmount > MAX_FRAME * 4) throw Error('远程连接拥堵，请稍后重试');
    this.socket.send(JSON.stringify({ phase: 'session', frame: JSON.parse(this.sessionCipher.seal(message)) }));
  }
  call(action, value, timeout = 30000) {
    if (!this.online) return Promise.reject(Error('远程设备离线，请保持两端 DSH 运行'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('远程请求超时')); }, timeout); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: 'call', id, action, value }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  disconnected() {
    const wasOnline = this.online; this.online = false; this.remote = null; this.sessionCipher = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('远程连接已断开，请重试；未自动重复提交任务')); }
    this.pending.clear(); if (wasOnline) this.emit('offline');
  }
  stop() { this.stopped = true; clearTimeout(this.retry); this.retry = null; this.retire('', false); this.status('stopped'); }
}
