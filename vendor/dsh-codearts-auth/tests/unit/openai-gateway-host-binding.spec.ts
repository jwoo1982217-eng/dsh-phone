import { createServer, request, Agent } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAiGateway } from '../../src/openai-gateway/server.js'
import { disposeGatewayRuntime } from '../../src/openai-gateway/runtime.js'
import { gatewayHttpUrl } from '../../src/openai-gateway/config.js'

/**
 * Issue IKL7UN 的**端到端**回归：`DSH_OPENAI_GATEWAY_HOST` 必须真的改变内核
 * 绑定的网卡，而不只是让 `resolveGatewayConfig()` 返回一个新字符串。
 *
 * ⚠️ 为什么必须有这一层：`config` 层的用例只证明「解析出的 host 是那个值」，
 * 一个「解析对了但 server.ts 仍写死 `listen(port, '127.0.0.1')`」的实现能让
 * 那批用例全绿 —— 而那正是本 issue 的形态（配置可改、wire 不变）。
 *
 * ⚠️ **判据必须包含阴性对照**：只断言「绑 127.0.0.2 后 127.0.0.2 可达」是不够的
 * ——绑 `0.0.0.0`（或任何绑全部网卡的实现）同样能满足它。故同时断言
 * `127.0.0.1` **连不上**（实测：绑 127.0.0.2 时 127.0.0.1 得到 ECONNREFUSED，
 * 反之亦然；两者是同一回环网段里的**不同**地址）。
 */

const alternateLoopback = process.platform === 'darwin' ? '::1' : '127.0.0.2'
const ENV = (host: string, port: number) => ({
  DSH_OPENAI_GATEWAY_HOST: host,
  DSH_OPENAI_GATEWAY_PORT: String(port),
  DSH_OPENAI_GATEWAY_API_KEY: 'test-key',
})

const llm = {
  listProviders: () => [],
  listModels: async () => [],
  resolveModelInfo: async () => ({}),
  stream: () => { throw new Error('not used') },
}

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * ⚠️ **必须显式传 agent**（Issue IKM3UI）：`node:http` 的 `request()` 在
 * `NODE_USE_ENV_PROXY=1` 时会按 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 决定是否
 * 走代理。`NO_PROXY` 通常含 `127.0.0.1`/`::1` 但**不含** `127.0.0.2` ⇒ 阴性对照
 * `probe('127.0.0.2')` 被送去本机代理、拿到代理的 `HTTP 503` 而非内核的
 * `ECONNREFUSED`（实测 `proxy-connection` 头即代理签名）⇒ 判据退化成「代理转不到」，
 * 与「内核是否绑定」不再等价。
 *
 * 显式 agent 只作用于这条探针、不改全局环境：**不要**改用「往 `NO_PROXY` 里加地址」
 * 或「关掉 `NODE_USE_ENV_PROXY`」来绕（前者是开发者机器上的隐性前置条件、后者会把
 * 同进程里其它本该走代理的请求一起改掉）。
 */
const directAgent = new Agent()

/** 从指定 host 连过去，返回 'ok' 或错误码（用来观察**内核**的绑定面）。 */
function probe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = request(
      { host, port, path: '/v1/models', method: 'GET', timeout: 2000, agent: directAgent },
      (response) => {
        response.resume()
        resolve(`HTTP ${response.statusCode ?? 0}`)
      },
    )
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
    req.on('timeout', () => { req.destroy(); resolve('timeout') })
    req.end()
  })
}

const started: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const gateway of started.splice(0)) await gateway.close()
  await disposeGatewayRuntime()
})

describe('Issue IKL7UN：网关监听地址可配', () => {
  it('★ 绑 127.0.0.2 时该地址可达，而 127.0.0.1 连不上（阴性对照）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: ENV(alternateLoopback, port) })
    started.push(gateway)
    await gateway.start()

    expect(gateway.address()).toEqual({ host: alternateLoopback, port })
    // 真绑上了用户指定的网卡（401 = 未带 key，说明 HTTP 往返成功）。
    expect(await probe(alternateLoopback, port)).toBe('HTTP 401')
    // ⚠️ 阴性对照：若实现改成绑全部网卡，这一条会变成 HTTP 401 ⇒ 用例失败。
    expect(await probe('127.0.0.1', port)).toBe('ECONNREFUSED')
  })

  it('★ 默认（不设 host env）仍是只绑 127.0.0.1，行为零变化', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: { DSH_OPENAI_GATEWAY_API_KEY: 'test-key', DSH_OPENAI_GATEWAY_PORT: String(port) } })
    started.push(gateway)
    await gateway.start()

    expect(gateway.address()).toEqual({ host: '127.0.0.1', port })
    expect(await probe('127.0.0.1', port)).toBe('HTTP 401')
    expect(await probe(alternateLoopback, port)).toBe('ECONNREFUSED')
  })

  it('★ 通配地址必须在 listen 之前就被拒（不能先绑上去再报错）', () => {
    // 关键：`createOpenAiGateway()` 是**同步**构造的，非法 host 在这里即抛，
    // 于是「网关被通配地址静默暴露」这件事在架构上不可能发生 ——
    // 这正是拒绝通配这条判据的价值所在（只 warn 不拦的实现在这里会绿）。
    expect(() => createOpenAiGateway({ llm, home: undefined, env: ENV('0.0.0.0', 8326) })).toThrow(/DSH_OPENAI_GATEWAY_HOST/)
  })

  /**
   * ⚠️⚠️ **第三轮审计的方法学结论：纯函数绿 ≠ 安全。**
   *
   * 审计实测 `isWildcardHost('0。0。0。0') === false`（判据放行）**而内核真的绑了
   * 全部网卡**（从局域网 IP 反连得到 `HTTP 401`）。⇒ 光断言纯函数不够，
   * 必须有**真实入口 + 真 bind + 局域网反连**这一层。
   *
   * 本用例锁的是「这些写法在**构造期**就被拒」（`createOpenAiGateway` 是同步的，
   * 非法 host 在这里即抛 ⇒ 架构上不可能先绑上去再报错）。
   */
  it('★★ 非 ASCII 分隔符的 host 必须在构造期被拒（真实入口，非纯函数断言）', () => {
    // Linux 上 glibc 会把下列分隔符当 `.`：实测真 bind 全部得到 `0.0.0.0`。
    const bypasses = [
      '0\u30020\u30020\u30020',  // U+3002 表意句号
      '0\uff610\uff610\uff610',  // U+FF61 半角表意句号
      '0\u18060\u18060\u18060',  // U+1806 蒙古文破折号
      '0\u20240\u20240\u20240',  // U+2024 一点前导符
      '0\ufe520\ufe520\ufe520',  // U+FE52 小句点
      '\uff10.\uff10.\uff10.\uff10',
    ]
    for (const host of bypasses) {
      expect(() => createOpenAiGateway({ llm, home: undefined, env: ENV(host, 8326) }), JSON.stringify(host))
        .toThrow(/DSH_OPENAI_GATEWAY_HOST/)
    }
  })

  it('★ 监听日志印的是完整可达 URL（IPv6 也要能抄）', async () => {
    const logs: string[] = []
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm,
      home: undefined,
      env: ENV(alternateLoopback, port),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    })
    started.push(gateway)
    await gateway.start()

    // ⚠️ 不能是 `http://${host}:${port}` 的朴素插值：host 为 IPv6 时会拼出
    // `http://::1:8326/v1`（非法 URL，抄不走）。
    expect(logs.join('\n')).toContain(`已监听 ${gatewayHttpUrl(alternateLoopback, port, '/v1')}`)
    expect(gatewayHttpUrl('::1', 8326, '/v1')).toBe('http://[::1]:8326/v1')
  })

  /**
   * ★★ IPv6 host 的**内核绑定**覆盖（红队审计实测出的假绿空间）。
   *
   * ⚠️ 原先只有 IPv4（`127.0.0.2`）的真连断言。红队把 `listen()` 变异成
   * `host.includes(':') ? '127.0.0.1' : host`（**IPv6 用户仍然连不上 = 缺陷保留**），
   * 四个相关 spec **123 条全绿** —— 即新增的 IPv6 方括号处理当时只有纯函数断言。
   *
   * ⚠️ 判据同样带**阴性对照**：绑 `::1` 后必须 `::1` 可达、且 `127.0.0.1`
   * 连不上（证明没有退化成「绑全部网卡」）。`::1` 在 Windows 与 Linux 上都是
   * 默认存在的回环地址，故不需要额外环境假设。
   */
  it('★★ 绑 IPv6 host（::1）时该地址可达，且没有退化成绑全部网卡', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: ENV('::1', port) })
    started.push(gateway)
    await gateway.start()

    // `address()` 必须回传裸 IPv6（不是 `[::1]`）—— 它是 listen 的入参形态。
    expect(gateway.address()).toEqual({ host: '::1', port })
    expect(await probe('::1', port)).toBe('HTTP 401')
    // 阴性对照：绑 ::1 时 IPv4 回环连不上（若实现改成绑全部网卡，这条会变 401）。
    expect(await probe('127.0.0.1', port)).toBe('ECONNREFUSED')
  })

  /**
   * ⚠️ 带方括号的 IPv6（用户从浏览器地址栏复制的形态）必须与裸形态等价。
   * 直接把它交给 `listen()` 会得到必然的 `EADDRNOTAVAIL`。
   */
  it('★ 带方括号的 [::1] 等价于 ::1（否则复制粘贴必失败）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: ENV('[::1]', port) })
    started.push(gateway)
    await gateway.start()

    expect(gateway.address()).toEqual({ host: '::1', port })
    expect(await probe('::1', port)).toBe('HTTP 401')
  })
})
