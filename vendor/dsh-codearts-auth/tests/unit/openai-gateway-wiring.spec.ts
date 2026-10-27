const alternateLoopback = process.platform === 'darwin' ? '::1' : '127.0.0.2'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountOpenAiGateway } from '../../src/openai-gateway/index.js'
import { disposeGatewayRuntime } from '../../src/openai-gateway/runtime.js'

/**
 * 从指定 host 连一次，返回状态码或错误码。
 *
 * ⚠️ 存在的理由：`gatewayAddress()` 只回传**配置字符串**，它证明不了内核真的
 * 绑在那张网卡上（独立审计 M6 实测：`listen()` 写死 `127.0.0.1` 时，
 * 只断言 `address()` 的用例照样全绿）。只有真实 HTTP 往返能锁住绑定面。
 */
function probeHost(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host, port, path: '/v1/models', method: 'GET', timeout: 2000 }, (res) => {
      res.resume()
      resolve(`HTTP ${res.statusCode ?? 0}`)
    })
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
    req.on('timeout', () => { req.destroy(); resolve('timeout') })
    req.end()
  })
}

/**
 * 网关的插件接线（`src/index.ts` 的 `mountOpenAiGateway(ctx)` 一行）的回归锁。
 *
 * 核心约束（对应 P0 缺陷）：网关是**插件的旁路功能**，它的任何初始化失败
 * （端口 env 写错、DSH home 不可写、key 生成失败……）都**只允许**降级为
 * 一条日志，绝不允许把异常抛回 `apply()`——那会让整个 `codearts-auth`
 * 插件加载失败，12 个 provider 的登录/积分/模型全部不可用。
 */

interface FakeContext {
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
  llm: unknown
  effect(fn: () => unknown, name?: string): unknown
  /**
   * ⚠️ 必须提供：`mountOpenAiGateway()` 会经 `ctx.get('attachments')` 桥接附件服务
   * （见 `makeGatewayAttachmentBridge`）。**缺了它整条启动链会在这一步抛**
   * —— 而那条抛错被刻意 catch 成一条日志（网关是旁路功能），于是用例会
   * 「通过」但**从未真的启动过网关**：任何「host/端口真的生效了吗」的断言都
   * 得不到验证（本文件新增的 IKL7UN 用例正是这么发现的）。
   */
  get(name: string): unknown
}

function makeContext(): { ctx: FakeContext; cleanups: Array<() => unknown>; logs: string[] } {
  const cleanups: Array<() => unknown> = []
  const logs: string[] = []
  const ctx: FakeContext = {
    logger: {
      info: (m) => { logs.push(`info:${m}`) },
      warn: (m) => { logs.push(`warn:${m}`) },
      error: (m) => { logs.push(`error:${m}`) },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      stream: () => { throw new Error('not used in wiring tests') },
    },
    // 附件服务缺失：网关的文本能力不受影响（这是真实支持的降级路径）。
    get: () => undefined,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  return { ctx, cleanups, logs }
}

const ENV_KEYS = [
  'DSH_OPENAI_GATEWAY_PORT',
  'DSH_OPENAI_GATEWAY_HOST',
  'DSH_OPENAI_GATEWAY_API_KEY',
  'DSH_OPENAI_GATEWAY_ENABLED',
  'DSH_JET_HUB_STATE_DIR',
] as const
let saved: Record<string, string | undefined>
let home: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  home = mkdtempSync(join(tmpdir(), 'dsh-gateway-wiring-'))
  process.env.DSH_JET_HUB_STATE_DIR = home
  process.env.DSH_OPENAI_GATEWAY_API_KEY = 'wiring-test-key'
  delete process.env.DSH_OPENAI_GATEWAY_PORT
  delete process.env.DSH_OPENAI_GATEWAY_HOST
  delete process.env.DSH_OPENAI_GATEWAY_ENABLED
})

afterEach(async () => {
  // runtime 是模块级单例：必须复位，否则一个用例启动的 server 会漏给下一个。
  await disposeGatewayRuntime()
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** 让出若干个微任务轮次，等 `applyGatewayDesiredState()` 这条异步链走完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/**
 * 在 `127.0.0.1` 上挑一个当前空闲的端口。
 *
 * ⚠️ 存在的理由：本文件的阴性对照要断言「`127.0.0.1:PORT` 连不上」，而
 * 并发跑的其它测试进程可能正好占着默认端口 8326 ⇒ 那条断言会拿到 401 而
 * **假失败**（实测在并发跑全量套件时踩到）。显式挑空闲端口即可消除这个耦合。
 */
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

describe('网关的插件接线', () => {
  it('端口环境变量非法时不得把异常抛回插件 apply()', async () => {
    const { ctx, logs } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_PORT = 'abc'

    expect(() => mountOpenAiGateway(ctx)).not.toThrow()
    await settle()
    expect(logs.some((line) => line.startsWith('error:'))).toBe(true)
  })

  it('DSH home 不可写时不得把异常抛回插件 apply()', async () => {
    const { ctx, logs } = makeContext()
    delete process.env.DSH_OPENAI_GATEWAY_API_KEY
    // 让 home 指向一个「已存在但不是目录」的路径，其下的 mkdir 必然失败。
    process.env.DSH_JET_HUB_STATE_DIR = join(home, 'not-a-dir')
    writeFileSync(join(home, 'not-a-dir'), 'file, not a directory')

    expect(() => mountOpenAiGateway(ctx)).not.toThrow()
    await settle()
    expect(logs.some((line) => line.startsWith('error:'))).toBe(true)
  })

  it('正常启动时注册恰好一个清理回调（apply() 只创建一次网关）', () => {
    const { ctx, cleanups } = makeContext()

    mountOpenAiGateway(ctx)

    expect(cleanups).toHaveLength(1)
  })

  it('env 显式停用时不启动网关，且必须留痕（否则用户无法排障）', async () => {
    const { ctx, logs } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'

    mountOpenAiGateway(ctx)
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
    expect(logs.some((line) => line.includes('DSH_OPENAI_GATEWAY_ENABLED'))).toBe(true)
  })

  it('持久化开关为关闭时不启动网关（设置页的期望状态优先于默认）', async () => {
    const { ctx } = makeContext()

    mountOpenAiGateway(ctx, { gatewayEnabled: () => false })
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
  })

  it('env 停用优先于持久化开关：显式停用就是停用', async () => {
    const { ctx } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_ENABLED = 'off'

    mountOpenAiGateway(ctx, { gatewayEnabled: () => true })
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
  })

  /**
   * Issue IKL7UN 的**接线**锁：host 必须从 env 一路走到内核绑定的网卡上。
   *
   * ⚠️ 与 `openai-gateway-host-binding.spec.ts` 的分工：那里直接调
   * `createOpenAiGateway()`（验证 server 用了 host），这里走**插件真实入口**
   * `mountOpenAiGateway()` + 模块级 runtime 单例（验证 env → 配置 → 工厂 → start
   * 这条链没断）。少了这一层，「工厂里把 host 丢掉」这种改动不会被发现。
   *
   * ⚠️⚠️ **`gatewayAddress()` 的断言是弱判据**（独立审计 M6/M7 实测）：它返回的是
   * `config.host` 这个**字符串**，不是内核实际绑定的地址。把 `server.listen()`
   * 改回写死 `'127.0.0.1'`（即把缺陷原样放回去）时，下面那条 `address()` 断言
   * **照样通过** —— 因为配置字符串仍然是对的。
   * ⇒ 故这里**必须再做一次真连**：从 127.0.0.2 连得上、且 127.0.0.1 连不上。
   * 光靠 `address()` 会给人虚假的安全感（这条用例的「★」标记曾经就名不副实）。
   */
  it('★ DSH_OPENAI_GATEWAY_HOST 经插件入口生效（含真实连通性，不只是配置字符串）', async () => {
    const { ctx } = makeContext()
    // 127.0.0.2 是 Linux/macOS/Windows 上都存在的另一个回环地址（实测可绑），
    // 用它就不必占用真实网卡，也不会与「只绑 127.0.0.1」的实现混淆。
    process.env.DSH_OPENAI_GATEWAY_HOST = alternateLoopback
    // ⚠️ **必须显式挑一个在 127.0.0.1 上空闲的端口**，不能用默认 8326：
    // 下面的阴性对照要断言「127.0.0.1 连不上」，而 `127.0.0.2:PORT` 的绑定
    // **不保留** `127.0.0.1:PORT`（不同地址、互不冲突）。若端口恰好被别的进程
    // 或**并发跑的另一个测试进程**占用在 127.0.0.1 上，阴性对照就会拿到 401
    // 而不是 ECONNREFUSED —— 实测在并发跑全量套件时假失败过。
    const port = await freePort()
    process.env.DSH_OPENAI_GATEWAY_PORT = String(port)

    mountOpenAiGateway(ctx)
    await settle()

    const { isGatewayRunning, gatewayAddress } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(true)
    expect(gatewayAddress()?.host).toBe(alternateLoopback)
    expect(gatewayAddress()?.port).toBe(port)

    // ⚠️ 物理判据：真的绑在 127.0.0.2 上（401 = HTTP 往返成功、未带 key）。
    expect(await probeHost(alternateLoopback, port)).toBe('HTTP 401')
    // 阴性对照：写死 127.0.0.1 的实现会让这条变成 HTTP 401。
    expect(await probeHost('127.0.0.1', port)).toBe('ECONNREFUSED')
  })

  it('★ 非法 host（通配地址）只降级为日志，绝不抛回 apply()', async () => {
    const { ctx, logs } = makeContext()
    process.env.DSH_OPENAI_GATEWAY_HOST = '0.0.0.0'

    // 与端口非法同一条契约：网关是旁路功能，它配错不能拖垮整个插件。
    expect(() => mountOpenAiGateway(ctx)).not.toThrow()
    await settle()

    const { isGatewayRunning } = await import('../../src/openai-gateway/runtime.js')
    expect(isGatewayRunning()).toBe(false)
    const text = logs.join('\n')
    expect(text).toContain('DSH_OPENAI_GATEWAY_HOST')
    // ⚠️ 日志必须说明「未启动」而不是只留一句环境变量名 —— 用户要能据此知道
    // 网关没在跑（否则会以为只是没生效而反复重启）。
    expect(text).toContain('未启动')
  })
})


describe('网关启动晚于或早于附件服务都可收图', () => {
  it('先启动文本网关，附件服务晚到或替换后两种图片协议均使用当前服务', async () => {
    const probe = createServer()
    const port = await new Promise<number>((resolve) => probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number }; probe.close(() => resolve(address.port))
    }))
    process.env.DSH_OPENAI_GATEWAY_PORT = String(port)
    let store: { saveImage(input: unknown): Promise<unknown> } | undefined
    let calls = 0, saves = 0
    const { ctx } = makeContext()
    const live = Object.assign(ctx, {
      get: (name: string) => name === 'attachments' ? store : undefined,
      llm: {
        listProviders: () => [{ id: 'fixture' }],
        listModels: async () => [{ provider: 'fixture', id: 'vision', name: '本地模型' }],
        resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
        async *stream(options: { messages: Array<{ content: Array<{ type: string }> }> }) {
          calls += 1
          yield { type: 'text-delta', index: 0, text: options.messages[0].content.map(b => b.type).join(',') }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    })
    mountOpenAiGateway(live)
    const { applyGatewayDesiredState } = await import('../../src/openai-gateway/runtime.js')
    await applyGatewayDesiredState()
    const send = (path: string, body: unknown) => new Promise<{ status: number; value: any }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: 'Bearer wiring-test-key', 'content-type': 'application/json' } }, response => {
        let text = ''; response.on('data', bytes => { text += String(bytes) }); response.on('end', () => resolve({ status: response.statusCode!, value: JSON.parse(text) }))
      }); req.on('error', reject); req.end(JSON.stringify(body))
    })
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    const chat = { model: 'fixture/vision', messages: [{ role: 'user', content: [image] }] }
    expect((await send('/v1/chat/completions', chat)).status).toBe(400)
    expect(calls).toBe(0)
    expect((await send('/v1/chat/completions', { model: 'fixture/vision', messages: [{ role: 'user', content: '文字' }] })).status).toBe(200)
    store = { async saveImage() { saves += 1; return { attachmentId: 'sha256:local-fixture', mediaType: 'image/png' } } }
    const accepted = await send('/v1/chat/completions', chat)
    expect(accepted.status).toBe(200)
    expect(accepted.value.choices[0].message.content).toBe('image')
    store = { async saveImage() { throw new Error('本地保存失败') } }
    expect((await send('/v1/chat/completions', chat)).status).toBe(400)
    store = { async saveImage() { saves += 1; return { attachmentId: 'sha256:replacement', mediaType: 'image/png' } } }
    const response = await send('/v1/responses', { model: 'fixture/vision', input: [{ role: 'user', content: [{ type: 'input_image', image_url: image.image_url.url }] }] })
    expect(response.status).toBe(200)
    expect(response.value.output[0].content[0].text).toBe('image')
    expect(saves).toBe(2)
    expect(calls).toBe(3)
  })
})
