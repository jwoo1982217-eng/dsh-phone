/** OneBot v11 WebSocket transport: forward client and reverse server, echo-based API calls. */

import http from 'node:http'
import { EventEmitter } from 'node:events'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { ConnectionConfig } from './config.js'
import type { OneBotActionPayload, OneBotApiResponse, OneBotEvent } from './types.js'

const MAX_RECONNECT_DELAY_MS = 60_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Port parsed from a ws://…:port URL (reverse mode binds it; forward mode dials it). */
export function urlPort(url: string, fallback: number): number {
  try {
    return Number(new URL(url).port) || fallback
  } catch {
    return fallback
  }
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null
  private reverseServer: http.Server | null = null
  private pending = new Map<string, PendingRequest>()
  private echoSeq = 0
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastPongAt = Date.now()
  private closed = false
  selfId: number | null = null

  constructor(
    private readonly connection: ConnectionConfig,
    private readonly accessToken: string | undefined,
    private readonly log: (line: string) => void,
  ) {
    super()
  }

  start(): void {
    this.closed = false
    if (this.connection.mode === 'reverse') {
      this.startReverseServer(urlPort(this.connection.url, 8082))
    } else {
      this.connectForward()
    }
  }

  stop(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.clearPending(new Error('channel stopped'))
    this.ws?.close(1000, 'channel stopped')
    this.ws = null
    this.reverseServer?.close()
    this.reverseServer = null
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** One OneBot API call; resolves with `data` on ok, rejects on failure or timeout. */
  async call(action: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    // Brief reconnect grace: a dropped socket usually comes back within a few
    // seconds (NapCat re-dials the reverse server). Wait up to 12s instead of
    // failing the agent's action on the first blip.
    if (!this.isConnected()) {
      const deadline = Date.now() + 12_000
      while (!this.isConnected() && Date.now() < deadline && !this.closed) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    if (!this.isConnected()) throw new Error(`QQ not connected (action ${action} dropped)`)
    const echo = `dsh-qq-${Date.now()}-${this.echoSeq++}`
    const payload: OneBotActionPayload = { action, params, echo }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`QQ API ${action} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      this.ws!.send(JSON.stringify(payload))
    })
  }

  private handleFrame(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const payload = parsed as Partial<OneBotApiResponse> & Partial<OneBotEvent>
    if (typeof payload.echo === 'string' && this.pending.has(payload.echo)) {
      const entry = this.pending.get(payload.echo)!
      this.pending.delete(payload.echo)
      clearTimeout(entry.timer)
      if (payload.status === 'ok' || payload.retcode === 0) entry.resolve(payload.data)
      else entry.reject(new Error(`QQ API failed: ${payload.msg ?? payload.wording ?? `retcode ${payload.retcode}`}`))
      return
    }
    if ((payload as OneBotEvent).post_type === 'meta_event') return // heartbeats & lifecycle bookkeeping
    this.emit('event', parsed as OneBotEvent)
  }

  private bindSocket(ws: WebSocket, label: string): void {
    this.ws = ws
    this.reconnectAttempts = 0
    this.log(`${label} connected`)
    this.emit('connect')
    ws.on('pong', () => {
      this.lastPongAt = Date.now()
    })
    ws.on('message', (data: RawData) => {
      this.lastPongAt = Date.now()
      this.handleFrame(data.toString())
    })
    ws.on('close', (code, reason) => {
      this.log(`${label} closed: code=${code} reason=${reason.toString() || 'none'}`)
      // A replaced socket's close must not clear the live replacement.
      if (this.ws !== ws) return
      if (this.connection.mode === 'reverse') {
        this.ws = null
        this.clearPending(new Error('QQ socket closed'))
        this.emit('disconnect')
        this.log('waiting for NapCat to reconnect…')
      } else {
        this.scheduleReconnect()
      }
    })
    ws.on('error', (err: Error) => {
      this.log(`${label} error: ${err.message}`)
    })
  }

  private connectForward(): void {
    if (this.closed) return
    const headers: Record<string, string> = {}
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    this.log(`dialling NapCat at ${this.connection.url}`)
    const ws = new WebSocket(this.connection.url, { headers })
    ws.on('open', () => {
      this.bindSocket(ws, 'forward WS')
      this.startHeartbeat()
    })
    ws.on('error', () => this.scheduleReconnect())
  }

  private startReverseServer(port: number): void {
    if (this.reverseServer) return
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end()
    })
    const wss = new WebSocketServer({ server, perMessageDeflate: false })
    wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress ?? 'unknown'
      if (this.accessToken && req.headers.authorization !== `Bearer ${this.accessToken}`) {
        this.log(`reverse WS auth failed from ${ip}`)
        ws.close(1008, 'Unauthorized')
        return
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'replaced by a newer connection')
      this.bindSocket(ws, `reverse WS (${ip})`)
      this.startHeartbeat()
    })
    wss.on('error', (err: Error) => this.log(`reverse WS server error: ${err.message}`))
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.log(`port ${port} busy; retrying in 2s`)
        setTimeout(() => {
          if (!this.closed) {
            this.reverseServer = null
            this.startReverseServer(port)
          }
        }, 2_000)
        return
      }
      this.log(`reverse WS http error: ${err.message}`)
    })
    // Bind dual-stack (no host): NapCat dials `ws://localhost:8082`, which may
    // resolve to ::1 or 127.0.0.1 depending on DNS order; both must answer.
    server.listen(port, new URL(this.connection.url).hostname.replace(/^\[|\]$/g, ''))
    this.reverseServer = server
    this.log(`reverse WS server listening on ${this.connection.url} (NapCat should dial this)`)
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    // TCP half-open guard: NapCat's socket can die without a FIN (sleep,
    // network switch). Track pongs; a silent socket gets torn down so the
    // reverse server accepts a fresh dial instead of holding a zombie.
    this.lastPongAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > 65_000) {
        this.log('heartbeat: no pong for 65s, tearing down dead socket')
        try { this.ws.terminate() } catch { /* closing anyway */ }
        return
      }
      this.ws.ping()
    }, 30_000)
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts++, MAX_RECONNECT_DELAY_MS)
    this.log(`reconnecting in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectForward()
    }, delay)
  }

  private clearPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
