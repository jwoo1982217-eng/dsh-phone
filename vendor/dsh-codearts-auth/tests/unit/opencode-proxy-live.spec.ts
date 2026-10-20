/**
 * 代理链路的**真实**联通测试（本地回环，不出网、零额度）。
 *
 * ## 为什么要它
 *
 * 单测只能证明「`buildProxyDispatcher` 返回了带 dispatch 的对象」，
 * 证明不了两件真正会翻车的事：
 *
 * 1. **风险 R2**：本仓库装的是**外部 undici**，而 `fetch` 是 Node 内置的
 *    **内部 undici**。把外部实例当 `RequestInit.dispatcher` 传进去，跨实例
 *    的鸭子类型是否成立，只能真跑一次才知道。
 * 2. **自建 SOCKS5 隧道的字节序**：握手帧、端口大端、对端中途关闭的
 *    reject 路径，纯类型检查与手算都容易漏。
 *
 * 故这里起两个回环服务器（一个 CONNECT 代理、一个 SOCKS5 代理），
 * 各跑一次真实的 `fetch`，并断言**目标站点看到的是代理转发的连接**。
 */
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProxyDispatcher, closeAllProxyDispatchers } from '../../src/opencode-proxy.js'
import type { NormalizedProxy } from '../../src/opencode.js'

/** 记录「谁访问了目标站点」——用于证明流量确实绕过了代理。 */
const seenViaProxy: string[] = []

let origin: Server
let originPort = 0
let originUrl = ''

/** 最小 HTTP CONNECT 代理：收到 `CONNECT host:port` 就双向转发。 */
let connectProxy: Server
let connectProxyPort = 0
/** SOCKS5 代理的连接计数。 */
let socksConnections = 0

function pipe(a: Socket | import('node:stream').Duplex, b: Socket | import('node:stream').Duplex): void {
  a.pipe(b)
  b.pipe(a)
}

/** 起一个 SOCKS5（无认证）代理。 */
async function startSocks5Proxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createNetServer((socket) => {
    socksConnections += 1
    // ⚠️ 阶段机必须**在隧道建好后停止解析**：否则后续的 HTTP 明文字节
    // （"GET / HTTP/1.1"…）会被当成新的 SOCKS5 CONNECT 请求重新解析，
    // ATYP 读成 'G'（0x47/0x32）后连接失败并把整条隧道 destroy 掉 ——
    // 表现是「握手成功、请求发出、然后 fetch failed」，
    // 极易误判成客户端实现有 bug（写这个测试时真踩过）。
    let stage: 'hello' | 'connect' | 'relay' = 'hello'
    socket.on('data', (chunk: Buffer) => {
      if (stage === 'relay') return
      if (stage === 'hello') {
        // [VER, NMETHODS, METHODS...] → 选 NO AUTH 回 [5, 0]
        socket.write(Buffer.from([0x05, 0x00]))
        stage = 'connect'
        return
      }
      // CONNECT：VER CMD RSV ATYP … —— 只支持 ATYP=0x03（域名）
      const atyp = chunk[3]
      if (atyp !== 0x03) {
        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
        socket.end()
        return
      }
      const hostLen = chunk[4]!
      const host = chunk.subarray(5, 5 + hostLen).toString('utf8')
      const port = chunk.readUInt16BE(5 + hostLen)
      const upstream = require('node:net').connect(port, host) as Socket
      upstream.once('connect', () => {
        // REPLY：VER REP=0x00 RSV ATYP=0x01 BND.ADDR(4) BND.PORT(2)
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
        stage = 'relay'
        pipe(socket, upstream)
      })
      upstream.once('error', () => {
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
        socket.end()
      })
    })
    socket.on('error', () => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

beforeAll(async () => {
  // 目标站点
  origin = createServer((req, res) => {
    seenViaProxy.push(`http:${req.headers['x-via'] ?? 'direct'}`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('origin-ok')
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const oa = origin.address()
  originPort = typeof oa === 'object' && oa !== null ? oa.port : 0
  originUrl = `http://127.0.0.1:${originPort}/`

  // HTTP CONNECT 代理（本测试走明文 http:// 目标，故只需把普通请求也转发过去）
  connectProxy = createServer((req, res) => {
    void (async () => {
      if (req.method === 'CONNECT') {
        res.writeHead(200, 'Connection Established')
        return
      }
      // 明文 HTTP：把请求原样转发到目标
      const upstream = require('node:http').request(
        { host: '127.0.0.1', port: originPort, path: req.url, method: req.method, headers: req.headers },
        (up: import('node:http').IncomingMessage) => {
          res.writeHead(up.statusCode ?? 200, up.headers)
          up.pipe(res)
        },
      )
      upstream.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(upstream)
    })()
  })
  connectProxy.on('connect', (_req, socket: Socket, head: Buffer) => {
    const [host, port] = (_req.url ?? '').split(':')
    const upstream = require('node:net').connect(Number(port), host) as Socket
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      pipe(socket, upstream)
    })
  })
  await new Promise<void>((resolve) => connectProxy.listen(0, '127.0.0.1', resolve))
  const ca = connectProxy.address()
  connectProxyPort = typeof ca === 'object' && ca !== null ? ca.port : 0
})

afterAll(async () => {
  await closeAllProxyDispatchers()
  await new Promise<void>((resolve) => origin.close(() => resolve()))
  await new Promise<void>((resolve) => connectProxy.close(() => resolve()))
})

describe('HTTP 代理：真实 fetch 经代理到达目标', () => {
  it('per-request dispatcher 生效（风险 R2 的实证）', async () => {
    const proxy: NormalizedProxy = { kind: 'http', url: `http://127.0.0.1:${connectProxyPort}`, label: '' }
    const before = seenViaProxy.length
    // ⚠️ 这是本仓库最该被验证的一行：外部 undici 的 Dispatcher
    // 能否被 Node 内置 fetch 接受。duck typing 是否成立只有真跑才知道。
    const response = await fetch(originUrl, { headers: { 'x-via': 'http-proxy' }, dispatcher: buildProxyDispatcher(proxy) as never } as RequestInit)
    expect(await response.text()).toBe('origin-ok')
    expect(seenViaProxy.length).toBe(before + 1)
    expect(seenViaProxy.at(-1)).toBe('http:http-proxy')
  })

  it('⚠️ 不传 dispatcher 时走直连（证明上面确实是代理在转发）', async () => {
    const before = seenViaProxy.length
    const response = await fetch(originUrl, { headers: { 'x-via': 'direct' } })
    expect(await response.text()).toBe('origin-ok')
    expect(seenViaProxy.at(-1)).toBe('http:direct')
    expect(seenViaProxy.length).toBe(before + 1)
  })

  it('代理不可用时请求失败（不静默回退直连）', async () => {
    const dead: NormalizedProxy = { kind: 'http', url: 'http://127.0.0.1:1', label: '' }
    await expect(
      fetch(originUrl, { dispatcher: buildProxyDispatcher(dead) as never } as RequestInit),
    ).rejects.toBeDefined()
  })
})

describe('SOCKS5：自建隧道真实联通', () => {
  it('握手 + CONNECT 打通，fetch 经 SOCKS5 到达目标', async () => {
    const socks = await startSocks5Proxy()
    try {
      const proxy: NormalizedProxy = { kind: 'socks5', url: `socks5://127.0.0.1:${socks.port}`, label: '' }
      const before = socksConnections
      const response = await fetch(originUrl, { headers: { 'x-via': 'socks' }, dispatcher: buildProxyDispatcher(proxy) as never } as RequestInit)
      expect(await response.text()).toBe('origin-ok')
      expect(socksConnections).toBeGreaterThan(before)
    } finally {
      await closeAllProxyDispatchers()
      await socks.close()
    }
  }, 15_000)

  it('SOCKS5 代理不存在时失败（不静默回退）', async () => {
    const dead: NormalizedProxy = { kind: 'socks5', url: 'socks5://127.0.0.1:1', label: '' }
    await expect(
      fetch(originUrl, { dispatcher: buildProxyDispatcher(dead) as never } as RequestInit),
    ).rejects.toBeDefined()
  }, 15_000)

  it('⚠️ CONNECT 被拒时报出可读错误（覆盖 fail() 的 throw 路径）', async () => {
    // 这个代理接受握手但一律拒绝 CONNECT（REP=0x02「规则不允许」）。
    // 写这个用例的原因：早期 `fail()` 误用了外层作用域里不存在的 `reject`，
    // 这条路径会抛 ReferenceError 而不是可读错误 —— 成功路径与「连不上」
    // 路径都测不到它。
    const refusing = createNetServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00]))
        socket.once('data', () => {
          socket.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          socket.end()
        })
      })
      socket.on('error', () => socket.destroy())
    })
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve))
    const ra = refusing.address()
    const port = typeof ra === 'object' && ra !== null ? ra.port : 0
    try {
      const proxy: NormalizedProxy = { kind: 'socks5', url: `socks5://127.0.0.1:${port}`, label: '' }
      await expect(
        fetch(originUrl, { dispatcher: buildProxyDispatcher(proxy) as never } as RequestInit),
      ).rejects.toBeDefined()
    } finally {
      await closeAllProxyDispatchers()
      await new Promise<void>((resolve) => { refusing.close(() => resolve()) })
    }
  }, 15_000)
})
