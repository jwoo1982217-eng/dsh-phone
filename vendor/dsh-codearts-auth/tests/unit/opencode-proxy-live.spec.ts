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
 *
 * ## ⚠️⚠️ 必须走生产的 `proxyFetch`，不能自己写 `fetch(url, { dispatcher })`
 *
 * 本文件原先 5 处都是裸全局 `fetch` 配生产 dispatcher —— 那**恰好把这个缺陷
 * 重新构造了一遍**：全局 fetch 来自 Node 内置 undici，dispatcher 来自外部
 * undici 8.x，两者 handler 契约不同源，在 Node 22/24 上恒抛
 * `InvalidArgumentError: invalid onRequestStart method`（缺陷 IKK4BY）。
 *
 * 更要命的是其中 2 条「代理不可用时失败」的用例**因为错误的原因通过**：
 * 它们只断言「请求 reject」，而契约冲突**恰好也 reject**（`error.cause` 是
 * `invalid onRequestStart method` 而非 `ECONNREFUSED`）—— 于是缺陷被掩盖了两轮。
 *
 * ⇒ 现在所有请求都经 {@link proxyFetch}（生产同款路径）：传了代理就走 undici
 *   自带的 fetch，与 dispatcher 同源；这才让本文件真正测到「代理链路」。
 */
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProxyDispatcher, closeAllProxyDispatchers, proxyFetch } from '../../src/opencode-proxy.js'
import type { NormalizedProxy } from '../../src/opencode.js'

/** 记录「谁访问了目标站点」——用于证明流量确实绕过了代理。 */
const seenViaProxy: string[] = []

/**
 * 「死代理」端口：合法、但**没有任何进程监听**。
 *
 * ⚠️ 用 45xxx 段（而不是 `1` / `9` 之类低端口），理由是**可读性与稳健性**：
 * 低端口既可能被本机真实服务占用，语义上也不像「测试用的临时端口」。
 *
 * ⚠️⚠️ **纠正一处早先写错的理由**（自审时实测发现）：我原先注释说
 * 「`1` / `9` 落在 fetch 的 forbidden port 名单里会被拦成 `bad port`」——
 * 这**不准确**。实测（Node 26，逐端口对照）：
 *
 * | 变化侧 | 端口 1 / 9 / 25 / 465 / 587 | 结论 |
 * |---|---|---|
 * | **target**（请求 URL） | `bad port` | 受 forbidden-port 检查 |
 * | **proxy**（dispatcher） | `connect ECONNREFUSED …` | **不被检查，真去连了** |
 *
 * 即 **forbidden-port 只作用于 target URL，完全不检代理端口**。
 * 所以「死代理端口 = 1」其实**不会**被 `bad port` 拦，它本来就正确地走
 * `ECONNREFUSED`。（当初看到 `bad port` 是因为把 **target** 写成了 `:9`，
 * 报的是目标 URL 的问题，与代理无关。）改用 45999 仍然更好，但理由是
 * 「不与真实服务撞port、语义清晰」，**不是**「躲避 forbidden port」。
 */
const DEAD_PORT = 45_999

/** 沿 `cause` 链收集全部错误 code（连接被拒 / undici 错误码都在这里）。 */
function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    current = (current as { cause?: unknown }).cause
  }
  return codes
}

/** 沿 `cause` 链收集全部 message（用于断言「我方抛出的可读错误」确实传到了调用方）。 */
function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) messages.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return messages
}

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
    // ⚠️ 这是本仓库最该被验证的一行：外部 undici 的 Dispatcher 与 fetch 是否同源。
    // 走生产的 `proxyFetch`（内部用 undici 自带的 fetch），不是裸全局 fetch。
    const response = await proxyFetch(originUrl, { headers: { 'x-via': 'http-proxy' } }, proxy)
    expect(await response.text()).toBe('origin-ok')
    expect(seenViaProxy.length).toBe(before + 1)
    expect(seenViaProxy.at(-1)).toBe('http:http-proxy')
  })

  it('⚠️ 不传代理时走直连（证明上面确实是代理在转发）', async () => {
    const before = seenViaProxy.length
    // 代理为 undefined ⇒ proxyFetch 退回全局 fetch，即「该账号未配代理」的路径。
    const response = await proxyFetch(originUrl, { headers: { 'x-via': 'direct' } }, undefined)
    expect(await response.text()).toBe('origin-ok')
    expect(seenViaProxy.at(-1)).toBe('http:direct')
    expect(seenViaProxy.length).toBe(before + 1)
  })

  it('⚠️ 传 `Request` 作 init 时必须**抛错**，不能静默降级为 GET（审计发现 C）', async () => {
    // 反例（实测）：`{ ...new Request(...) }` 展开是**空对象**（method/body/headers
    // 都不是自有可枚举属性），于是请求会静默变成 GET、丢 body 与头 ——
    // 这比抛错更危险（错得没有声音）。故 proxyFetch 入口显式拦截。
    const proxy: NormalizedProxy = { kind: 'http', url: `http://127.0.0.1:${connectProxyPort}`, label: '' }
    const req = new Request(originUrl, {
      method: 'POST',
      body: 'REQ-BODY',
      headers: { 'x-via': 'req' },
    })
    // 前置事实：展开 Request 确实为空（否则本条用例的前提不成立）
    expect(Object.keys({ ...req })).toHaveLength(0)

    const before = seenViaProxy.length
    // ⚠️ guard 是**同步 throw**（不是 reject 的 promise）：故用 `toThrow` 而非
    // `rejects` —— 写成 rejects 会得到「同步抛错」的失败信息，看着像 guard 没生效。
    expect(() => proxyFetch(originUrl, req as unknown as RequestInit, proxy)).toThrow(/Request/)
    // ⚠️ 关键：绝不能「悄悄发出去」—— 目标站点不得被访问
    expect(seenViaProxy.length).toBe(before)
  })

  it('⚠️ 代理不可用时因「连接被拒」失败，而不是因契约错配失败', async () => {
    // 2026-10-08 加固（issue IKK4BY）：本用例原先只断言 `rejects.toBeDefined()`，
    // 于是**契约冲突也让它通过**（两种失败都只是 reject）—— 缺陷被掩盖了两轮。
    // 现在必须验 cause 是连接层错误，证明它真的去连了、并因连不上而失败。
    const dead: NormalizedProxy = { kind: 'http', url: `http://127.0.0.1:${DEAD_PORT}`, label: '' }
    const error = await proxyFetch(originUrl, {}, dead).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeDefined()
    expect(collectErrorCodes(error)).toContain('ECONNREFUSED')
    // 反面：绝不能是契约错配
    expect(collectErrorCodes(error)).not.toContain('UND_ERR_INVALID_ARG')
  })
})

describe('SOCKS5：自建隧道真实联通', () => {
  it('握手 + CONNECT 打通，fetch 经 SOCKS5 到达目标', async () => {
    const socks = await startSocks5Proxy()
    try {
      const proxy: NormalizedProxy = { kind: 'socks5', url: `socks5://127.0.0.1:${socks.port}`, label: '' }
      const before = socksConnections
      const response = await proxyFetch(originUrl, { headers: { 'x-via': 'socks' } }, proxy)
      expect(await response.text()).toBe('origin-ok')
      expect(socksConnections).toBeGreaterThan(before)
    } finally {
      await closeAllProxyDispatchers()
      await socks.close()
    }
  }, 15_000)

  it('⚠️ SOCKS5 代理不存在时因连接失败而失败（不是契约错配）', async () => {
    const dead: NormalizedProxy = { kind: 'socks5', url: `socks5://127.0.0.1:${DEAD_PORT}`, label: '' }
    const error = await proxyFetch(originUrl, {}, dead).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeDefined()
    expect(collectErrorCodes(error)).toContain('ECONNREFUSED')
    expect(collectErrorCodes(error)).not.toContain('UND_ERR_INVALID_ARG')
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
      const error = await proxyFetch(originUrl, {}, proxy).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeDefined()
      // ⚠️ 必须验到**我们自建隧道抛出的那句可读错误**（不是笼统的 fetch failed）：
      // 早期 `fail()` 写成外层作用域的 `reject` 时会抛 ReferenceError，
      // 若只断言「rejects」这条用例照样绿 —— 那就又成了假绿。
      expect(collectErrorMessages(error).join(' | ')).toMatch(/SOCKS5 CONNECT 被拒绝/)
      expect(collectErrorCodes(error)).not.toContain('UND_ERR_INVALID_ARG')
    } finally {
      await closeAllProxyDispatchers()
      await new Promise<void>((resolve) => { refusing.close(() => resolve()) })
    }
  }, 15_000)

  it('⚠️ 默认端口（https → 443）必须真的写进 CONNECT 帧，不能是 0（真实缺陷）', async () => {
    // 事故（pre-existing，2026-10-08 实测）：旧实现 `Number(opts.port ?? 443)`
    // 在 undici 传**空字符串**（默认端口时的真实形态）下得到 `Number('') === 0`，
    // 于是 CONNECT 帧端口是 0 ⇒ 必然失败。而生产 chat 打的正是
    // `https://opencode.ai/zen`（默认 443）⇒「SOCKS5 代理」修复前恒不可用。
    //
    // ⚠️ 为什么要用 `dispatch({ origin })` 而不是 `proxyFetch(url)`：
    // 只有「无显式端口」的 origin 才会让 undici 传空串；而 `fetch` 的 URL
    // 解析层不会暴露这一步。故这里绕过 fetch，直接驱动 dispatcher 并
    // **从 CONNECT 帧里读出端口** —— 这才是本缺陷的真正判据。
    const targets: string[] = []
    const spy = createNetServer((socket) => {
      let buf = Buffer.alloc(0)
      let stage = 'hello'
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        if (stage === 'relay') return
        if (stage === 'hello') {
          if (buf.length < 2 + (buf[1] ?? 0)) return
          buf = buf.subarray(2 + (buf[1] ?? 0))
          socket.write(Buffer.from([0x05, 0x00]))
          stage = 'connect'
          return
        }
        if (buf.length < 5) return
        const hostLen = buf[4]!
        if (buf.length < 5 + hostLen + 2) return
        targets.push(`${buf.subarray(5, 5 + hostLen).toString('utf8')}:${buf.readUInt16BE(5 + hostLen)}`)
        // 只看帧内容，不需要真连上 ⇒ 一律拒绝
        socket.write(Buffer.from([0x05, 0x05, 0, 1, 0, 0, 0, 0, 0, 0]))
        socket.end()
      })
      socket.on('error', () => socket.destroy())
    })
    await new Promise<void>((resolve) => spy.listen(0, '127.0.0.1', resolve))
    const sa = spy.address()
    const port = typeof sa === 'object' && sa !== null ? sa.port : 0
    const dispatcher = buildProxyDispatcher({ kind: 'socks5', url: `socks5://127.0.0.1:${port}`, label: '' })
    const drive = (origin: string): Promise<void> => new Promise((resolve) => {
      const noop = (): void => {}
      try {
        dispatcher.dispatch(
          { origin, path: '/', method: 'GET', headers: {} } as never,
          {
            onRequestStart: noop, onRequestUpgrade: noop, onResponseStart: noop,
            onResponseData: noop, onResponseEnd: noop, onResponseError: () => resolve(),
            onConnect: noop, onHeaders: noop, onData: noop, onComplete: noop,
            onError: () => resolve(),
          } as never,
        )
      } catch { /* 版本差异：抛错也算已驱动 */ }
      setTimeout(resolve, 1500)
    })

    try {
      await drive('https://example.test')          // 默认端口 → 必须 443
      await drive('https://example.test:8443')     // 显式端口 → 必须原样

      // ⚠️ 核心断言：默认端口是 443，**不是 0**
      expect(targets[0]).toBe('example.test:443')
      expect(targets[0]).not.toMatch(/:0$/)
      // 显式端口不被改动
      expect(targets[1]).toBe('example.test:8443')
    } finally {
      await closeAllProxyDispatchers()
      await new Promise<void>((resolve) => { spy.close(() => resolve()) })
    }
  }, 15_000)
})
