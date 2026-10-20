import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { makeCipher, relayProof, MAX_FRAME } from './protocol.mjs';

export class ToolTunnel extends EventEmitter {
  constructor(pair, role, { reconnectMs = 1000 } = {}) {
    super(); Object.assign(this, { pair, role, reconnectMs });
    this.pending = new Map(); this.stopped = false; this.online = false; this.remote = null; this.activeCalls = 0;
  }
  start() {
    if (this.stopped) return;
    this.socket = new WebSocket(this.pair.relay, { maxPayload: MAX_FRAME, perMessageDeflate: false });
    const ws = this.socket;
    this.handshakeCipher = makeCipher(this.pair, this.role);
    this.sessionCipher = null; this.challenge = null; this.remoteChallenge = null;
    const sendHandshake = m => ws.send(JSON.stringify({ phase: 'handshake', frame: JSON.parse(this.handshakeCipher.seal(m)) }));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room: this.pair.room, proof: relayProof(this.pair), role: this.role })));
    ws.on('error', () => {});
    ws.on('message', bytes => {
      try {
        const raw = JSON.parse(bytes.toString());
        // Relay signals only trigger a fresh encrypted handshake. They cannot
        // authorize a request, change an identity, or forge an RPC response.
        if (raw.type === 'peer-online') {
          this.disconnected(); this.challenge = randomBytes(16).toString('hex'); this.remoteChallenge = null;
          sendHandshake({ type: 'hello', role: this.role, challenge: this.challenge }); return;
        }
        if (raw.type === 'peer-offline') { this.disconnected(); this.challenge = null; return; }
        if (raw.type === 'joined') { this.emit('connected'); return; }
        if (raw.phase === 'handshake') {
          const m = this.handshakeCipher.open(JSON.stringify(raw.frame));
          if (!this.challenge || m.role !== (this.role === 'phone' ? 'computer' : 'phone') || !/^[a-f0-9]{32}$/.test(m.challenge)) throw Error();
          if (m.type === 'hello') {
            if (this.online) throw Error();
            this.remoteChallenge = m.challenge;
            sendHandshake({ type: 'hello-ack', role: this.role, challenge: this.challenge, replyTo: m.challenge }); return;
          }
          if (m.type !== 'hello-ack' || m.replyTo !== this.challenge || (this.remoteChallenge && this.remoteChallenge !== m.challenge)) throw Error();
          this.remoteChallenge = m.challenge;
          const session = this.role === 'phone' ? this.challenge + m.challenge : m.challenge + this.challenge;
          this.sessionCipher = makeCipher(this.pair, this.role, session);
          this.online = true; this.remote = m.role; this.emit('online'); return;
        }
        // A fresh challenge from both endpoints binds every data packet to
        // this connection. Captures cannot be replayed after either restarts.
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
          const reply = result => { if (this.sessionCipher === sessionCipher && this.online) this.send({ type: 'reply', id: m.id, ...result }); };
          Promise.resolve().then(() => this.handler?.(m.action, m.value)).then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error?.publicMessage || '工具请求失败，请在手机查看状态' })).catch(() => {}).finally(() => this.activeCalls--);
        } else this.emit('packet', m);
      } catch { ws.close(1008, 'invalid encrypted packet'); }
    });
    ws.on('close', () => { this.disconnected(); if (!this.stopped) { this.retry = setTimeout(() => this.start(), this.reconnectMs); this.retry.unref(); } });
  }
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw Error('远程设备未连接');
    if (this.socket.bufferedAmount > MAX_FRAME * 4) throw Error('远程连接拥堵，请稍后重试');
    if (!this.online || !this.sessionCipher) throw Error('远程设备未连接');
    this.socket.send(JSON.stringify({ phase: 'session', frame: JSON.parse(this.sessionCipher.seal(message)) }));
  }
  call(action, value, timeout = 30000) {
    if (!this.online) return Promise.reject(Error('远程设备离线，请保持手机服务和工具连接器运行'));
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
  stop() { this.stopped = true; clearTimeout(this.retry); this.disconnected(); this.socket?.terminate(); }
}
