/** OneBot v11 WebSocket transport: forward client and reverse server, echo-based API calls. */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
const MAX_RECONNECT_DELAY_MS = 60_000;
/** Port parsed from a ws://…:port URL (reverse mode binds it; forward mode dials it). */
export function urlPort(url, fallback) {
    try {
        return Number(new URL(url).port) || fallback;
    }
    catch {
        return fallback;
    }
}
export class OneBotClient extends EventEmitter {
    connection;
    accessToken;
    log;
    ws = null;
    reverseServer = null;
    pending = new Map();
    echoSeq = 0;
    reconnectAttempts = 0;
    reconnectTimer = null;
    heartbeatTimer = null;
    lastPongAt = Date.now();
    closed = false;
    selfId = null;
    constructor(connection, accessToken, log) {
        super();
        this.connection = connection;
        this.accessToken = accessToken;
        this.log = log;
    }
    start() {
        this.closed = false;
        if (this.connection.mode === 'reverse') {
            this.startReverseServer(urlPort(this.connection.url, 8082));
        }
        else {
            this.connectForward();
        }
    }
    stop() {
        this.closed = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.clearPending(new Error('channel stopped'));
        this.ws?.close(1000, 'channel stopped');
        this.ws = null;
        this.reverseServer?.close();
        this.reverseServer = null;
    }
    isConnected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }
    /** One OneBot API call; resolves with `data` on ok, rejects on failure or timeout. */
    async call(action, params = {}, timeoutMs = 30_000) {
        // Brief reconnect grace: a dropped socket usually comes back within a few
        // seconds (NapCat re-dials the reverse server). Wait up to 12s instead of
        // failing the agent's action on the first blip.
        if (!this.isConnected()) {
            const deadline = Date.now() + 12_000;
            while (!this.isConnected() && Date.now() < deadline && !this.closed) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        if (!this.isConnected())
            throw new Error(`QQ not connected (action ${action} dropped)`);
        const echo = `dsh-qq-${Date.now()}-${this.echoSeq++}`;
        const payload = { action, params, echo };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new Error(`QQ API ${action} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(echo, { resolve, reject, timer });
            this.ws.send(JSON.stringify(payload));
        });
    }
    handleFrame(raw) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return;
        }
        const payload = parsed;
        if (typeof payload.echo === 'string' && this.pending.has(payload.echo)) {
            const entry = this.pending.get(payload.echo);
            this.pending.delete(payload.echo);
            clearTimeout(entry.timer);
            if (payload.status === 'ok' || payload.retcode === 0)
                entry.resolve(payload.data);
            else
                entry.reject(new Error(`QQ API failed: ${payload.msg ?? payload.wording ?? `retcode ${payload.retcode}`}`));
            return;
        }
        if (payload.post_type === 'meta_event')
            return; // heartbeats & lifecycle bookkeeping
        this.emit('event', parsed);
    }
    bindSocket(ws, label) {
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.log(`${label} connected`);
        this.emit('connect');
        ws.on('pong', () => {
            this.lastPongAt = Date.now();
        });
        ws.on('message', (data) => {
            this.lastPongAt = Date.now();
            this.handleFrame(data.toString());
        });
        ws.on('close', (code, reason) => {
            this.log(`${label} closed: code=${code} reason=${reason.toString() || 'none'}`);
            // A replaced socket's close must not clear the live replacement.
            if (this.ws !== ws)
                return;
            if (this.connection.mode === 'reverse') {
                this.ws = null;
                this.clearPending(new Error('QQ socket closed'));
                this.emit('disconnect');
                this.log('waiting for NapCat to reconnect…');
            }
            else {
                this.scheduleReconnect();
            }
        });
        ws.on('error', (err) => {
            this.log(`${label} error: ${err.message}`);
        });
    }
    connectForward() {
        if (this.closed)
            return;
        const headers = {};
        if (this.accessToken)
            headers.Authorization = `Bearer ${this.accessToken}`;
        this.log(`dialling NapCat at ${this.connection.url}`);
        const ws = new WebSocket(this.connection.url, { headers });
        ws.on('open', () => {
            this.bindSocket(ws, 'forward WS');
            this.startHeartbeat();
        });
        ws.on('error', () => this.scheduleReconnect());
    }
    startReverseServer(port) {
        if (this.reverseServer)
            return;
        const server = http.createServer((_req, res) => {
            res.writeHead(404).end();
        });
        const wss = new WebSocketServer({ server, perMessageDeflate: false });
        wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress ?? 'unknown';
            if (this.accessToken && req.headers.authorization !== `Bearer ${this.accessToken}`) {
                this.log(`reverse WS auth failed from ${ip}`);
                ws.close(1008, 'Unauthorized');
                return;
            }
            if (this.ws && this.ws.readyState === WebSocket.OPEN)
                this.ws.close(1000, 'replaced by a newer connection');
            this.bindSocket(ws, `reverse WS (${ip})`);
            this.startHeartbeat();
        });
        wss.on('error', (err) => this.log(`reverse WS server error: ${err.message}`));
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                this.log(`port ${port} busy; retrying in 2s`);
                setTimeout(() => {
                    if (!this.closed) {
                        this.reverseServer = null;
                        this.startReverseServer(port);
                    }
                }, 2_000);
                return;
            }
            this.log(`reverse WS http error: ${err.message}`);
        });
        // Bind dual-stack (no host): NapCat dials `ws://localhost:8082`, which may
        // resolve to ::1 or 127.0.0.1 depending on DNS order; both must answer.
        const host = new URL(this.connection.url).hostname.replace(/^\[|\]$/g, '');
        server.listen(port, host === 'localhost' ? '127.0.0.1' : host);
        this.reverseServer = server;
        this.log(`reverse WS server listening on ${this.connection.url} (NapCat should dial this)`);
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        // TCP half-open guard: NapCat's socket can die without a FIN (sleep,
        // network switch). Track pongs; a silent socket gets torn down so the
        // reverse server accepts a fresh dial instead of holding a zombie.
        this.lastPongAt = Date.now();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState !== WebSocket.OPEN)
                return;
            if (Date.now() - this.lastPongAt > 65_000) {
                this.log('heartbeat: no pong for 65s, tearing down dead socket');
                try {
                    this.ws.terminate();
                }
                catch { /* closing anyway */ }
                return;
            }
            this.ws.ping();
        }, 30_000);
    }
    scheduleReconnect() {
        if (this.closed || this.reconnectTimer)
            return;
        const delay = Math.min(1_000 * 2 ** this.reconnectAttempts++, MAX_RECONNECT_DELAY_MS);
        this.log(`reconnecting in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectForward();
        }, delay);
    }
    clearPending(error) {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }
}
