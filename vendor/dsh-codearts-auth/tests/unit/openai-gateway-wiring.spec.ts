import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountOpenAiGateway } from '../../src/openai-gateway/index.js'
import { disposeGatewayRuntime } from '../../src/openai-gateway/runtime.js'

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
})
