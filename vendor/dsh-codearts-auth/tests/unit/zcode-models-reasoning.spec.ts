/**
 * ZCode **模型目录（远端）** 与 **思考档位** 的回归测试。
 *
 * ## 守的是用户报障的真实缺陷
 *
 * 「使用 zcode 的 glm-5.3-flash 没法选中思考档位，而 ZCode 自己可以设置」
 *
 * 两层根因，本文件都守：
 *
 * 1. **模型列表不是远端获取的** —— `ZcodeAuth.fetchModels()` 直接照抄本地
 *    兜底表，一个网络请求都不发。于是窗口/输出上限是估值（`200_000`/`32_768`，
 *    上游实为 `1_000_000`/`128_000`），且**档位字段本地表里根本没有**。
 * 2. **`resolveModel()` 从不声明 `reasoning`** —— DSH 的档位选择器**只**从
 *    `resolveModel().reasoning` 渲染（`dsh-client-ui-model-selection`：
 *    `reasoning === undefined ? [] : …efforts`）。这与本仓库 qoder 那次
 *    （`AGENTS.md` 2.2 节）是**完全同型**的缺陷。
 *
 * 外加第三点：档位要在**请求体**里真下发，且协议名是上游给的
 * `output_config.effort`（**不是** `reasoning_effort`）。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { fetchZcodeModels } from '../../src/zcode-upstream.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import type { ZcodeRemoteModel } from '../../src/zcode-adapter.js'
import { ZCODE } from '../../src/zcode-product.js'

/** 上游 `client/configs` 的真实响应形状（实测 2026-09-29）。 */
const REAL_CONFIGS = {
  data: {
    configs: { captcha: { region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' } },
    // ⚠ 是**对象**不是数组（键为序号字串）—— 实测如此。
    builtinModels: {
      0: {
        modelId: 'GLM-5.3',
        name: 'GLM-5.3',
        contextWindow: 1_000_000,
        maxCompletionTokens: 128_000,
        capabilities: {},
        // ⚠ 插入序是 low → max → high，而 IDE 展示序是 low → high → max。
        reasoning: {
          levels: {
            low: { anthropic: { set: [{ path: ['output_config', 'effort'], value: 'low' }] } },
            max: { anthropic: { set: [{ path: ['output_config', 'effort'], value: 'max' }] } },
            high: { anthropic: { set: [{ path: ['output_config', 'effort'], value: 'high' }] } },
          },
          defaultLevel: 'max',
        },
        modalities: {},
      },
      1: {
        modelId: 'GLM-5.3-Flash',
        name: 'GLM-5.3-Flash',
        contextWindow: 1_000_000,
        maxCompletionTokens: 128_000,
        capabilities: { vision: true },
        reasoning: {
          levels: { low: {}, max: {}, high: {} },
          defaultLevel: 'max',
        },
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      },
    },
  },
}

/** 最小凭据（形状够用）。 */
const CRED = {
  zcode_jwt: 'a.b.c',
  device_mid: '11111111-1111-1111-1111-111111111111',
} as never

/**
 * 内存凭据存储。
 *
 * ⚠ 凭据**只有插件自存这一条来源**（`ctx.credentials`）：2026-10-05 起不再读本机
 * 官方客户端文件，也**不再有** `ZcodeAuthOptions.readCredential` 测试注入点 ⇒
 * 想给某个用例一份凭据，只能把它写进这个存储。
 * 样板见 `tests/unit/zcode-credential-resolution.spec.ts`。
 */
class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/**
 * 造一个 ctx。
 *
 * ⚠ 返回的存储**初始为空** —— 「有凭据」与「无凭据」两条用例的差别就体现在
 * 调用方有没有 `set` 那一步上（无凭据场景真的什么都不写）。
 */
function makeCtx(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

describe('远端模型目录：必须真拉上游（不是照抄本地表）', () => {
  it('★ 从 builtinModels 解析出模型（且是对象形态）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(REAL_CONFIGS), { status: 200 }))
    const models = await fetchZcodeModels(CRED, fetcher as never)
    expect(models).toBeDefined()
    // ⚠ builtinModels 是对象 —— 用 Array.isArray 判定会得到「0 个」的假阴性。
    expect(models).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('★ 上下文窗口与输出上限取上游值（不是兜底表估值）', async () => {
    const fetcher = async () => new Response(JSON.stringify(REAL_CONFIGS), { status: 200 })
    const models = await fetchZcodeModels(CRED, fetcher as never)
    const flash = models?.find((m) => m.id === 'GLM-5.3-Flash')
    expect(flash?.contextWindow).toBe(1_000_000)
    expect(flash?.maxTokens).toBe(128_000)
  })

  it('★ 档位来自上游，且按 IDE 展示序排列（low → high → max）', async () => {
    const fetcher = async () => new Response(JSON.stringify(REAL_CONFIGS), { status: 200 })
    const models = await fetchZcodeModels(CRED, fetcher as never)
    for (const m of models ?? []) {
      // ⚠ 上游 JSON 的键序是 low/max/high，直接用 Object.keys 会得到错顺序。
      expect(m.reasoningLevels).toEqual(['low', 'high', 'max'])
      expect(m.defaultReasoningLevel).toBe('max')
    }
  })

  it('★ vision 按上游 capabilities 判定（GLM-5.3 无 vision）', async () => {
    const fetcher = async () => new Response(JSON.stringify(REAL_CONFIGS), { status: 200 })
    const models = await fetchZcodeModels(CRED, fetcher as never)
    expect(models?.find((m) => m.id === 'GLM-5.3-Flash')?.supportsImage).toBe(true)
    // ⚠ 我此前按「同族应该一样」把它标成 true —— 上游 capabilities 是空对象。
    expect(models?.find((m) => m.id === 'GLM-5.3')?.supportsImage).toBe(false)
  })

  it('上游失败时返回 undefined（由调用方回退兜底表）', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED') }
    expect(await fetchZcodeModels(CRED, fetcher as never)).toBeUndefined()
  })

  it('上游返回 500 时返回 undefined', async () => {
    const fetcher = async () => new Response('', { status: 500 })
    expect(await fetchZcodeModels(CRED, fetcher as never)).toBeUndefined()
  })

  it('builtinModels 为空对象时返回 undefined（不返回空数组当成功）', async () => {
    const fetcher = async () => new Response(JSON.stringify({ data: { builtinModels: {} } }), { status: 200 })
    expect(await fetchZcodeModels(CRED, fetcher as never)).toBeUndefined()
  })

  it('缺少 modelId 的条目被跳过', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      data: { builtinModels: { 0: { name: 'no id' }, 1: { modelId: 'ok', contextWindow: 10, maxCompletionTokens: 5 } } },
    }), { status: 200 })
    const models = await fetchZcodeModels(CRED, fetcher as never)
    expect(models).toHaveLength(1)
    expect(models?.[0].id).toBe('ok')
  })
})

describe('ZcodeAuth.fetchModels() 走远端', () => {
  it('★ 有凭据时向上游拉，而不是照抄本地表', async () => {
    const { ctx, credentials } = makeCtx()
    // ⚠ 凭据只有插件自存一条来源 ⇒ 「有凭据」就是把值写进 `ctx.credentials`。
    await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(CRED))
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      // 只该请求 client/configs。
      expect(String(url)).toContain('/client/configs')
      return new Response(JSON.stringify(REAL_CONFIGS), { status: 200 })
    })
    const auth = new ZcodeAuth(ctx, { fetchImpl: fetcher as never })
    const models = await auth.fetchModels()
    expect(fetcher).toHaveBeenCalled()
    expect(models.find((m) => m.id === 'GLM-5.3-Flash')?.contextWindow).toBe(1_000_000)
  })

  it('无凭据时回退兜底表（不发网络请求，不抛错）', async () => {
    // ⚠ 这里**刻意一个字都不写**进存储：`current()` 读不到 ⇒ 才能走到兜底表那条路。
    const { ctx } = makeCtx()
    const fetcher = vi.fn(async () => new Response('', { status: 500 }))
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: fetcher as never,
    })
    const models = await auth.fetchModels()
    expect(models.length).toBeGreaterThan(0)
    // 兜底表的值也应当与上游对齐（否则离线用户看到错值）。
    expect(models.find((m) => m.id === 'GLM-5.3-Flash')?.contextWindow).toBe(1_000_000)
  })
})

describe('resolveModel 声明思考档位（选择器的唯一来源）', () => {
  /** 造一个带远端目录的适配器。 */
  function makeAdapter(): ZcodeAdapter {
    return new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
      fetchRemoteModels: async () => [{
        id: 'GLM-5.3-Flash',
        name: 'GLM-5.3-Flash',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        supportsImage: true,
        reasoningLevels: ['low', 'high', 'max'],
        defaultReasoningLevel: 'max',
      }],
    })
  }

  it('★ reasoning 必须被声明（否则档位选择器根本不出现）', async () => {
    const info = await makeAdapter().resolveModel('zcode', 'GLM-5.3-Flash')
    expect(info.reasoning).toBeDefined()
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
  })

  it('★ 展示名首字母大写（Low/High/Max），而 id 保持小写', async () => {
    const info = await makeAdapter().resolveModel('zcode', 'GLM-5.3-Flash')
    expect(info.reasoning?.efforts.map((e) => e.name)).toEqual(['Low', 'High', 'Max'])
    /**
     * ⚠ **id 必须是小写** —— 它是要发给上游的协议值
     * （`output_config.effort`），官方 configs 里就是小写。
     * 若把 id 也改成大写，上游会认不出档次（通常静默忽略整个字段）。
     */
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
    // 默认档的 id 同样必须是小写。
    expect(info.reasoning?.defaultEffort).toBe('max')
  })

  it('未知档位原样首字母大写（上游加新档位时不显示成空白）', async () => {
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
      fetchRemoteModels: async () => [{
        id: 'M', name: 'M', contextWindow: 100, maxTokens: 10, supportsImage: false,
        reasoningLevels: ['low', 'turbo'],
      }],
    })
    const info = await adapter.resolveModel('zcode', 'M')
    expect(info.reasoning?.efforts.map((e) => e.name)).toEqual(['Low', 'Turbo'])
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'turbo'])
  })

  it('★ defaultEffort 落在 efforts 内', async () => {
    const info = await makeAdapter().resolveModel('zcode', 'GLM-5.3-Flash')
    const ids = info.reasoning?.efforts.map((e) => e.id) ?? []
    expect(ids).toContain(info.reasoning?.defaultEffort)
  })

  it('★ 窗口与输出上限来自远端目录', async () => {
    const info = await makeAdapter().resolveModel('zcode', 'GLM-5.3-Flash')
    expect(info.context?.contextWindow).toBe(1_000_000)
    expect(info.defaultMaxTokens).toBe(128_000)
  })

  it('defaultReasoningLevel 不在档位里时**不发** defaultEffort', async () => {
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
      fetchRemoteModels: async () => [{
        id: 'M', name: 'M', contextWindow: 100, maxTokens: 10, supportsImage: false,
        reasoningLevels: ['low'], defaultReasoningLevel: 'max', // ← 不在 levels 内
      }],
    })
    const info = await adapter.resolveModel('zcode', 'M')
    // 指向不存在的档位会让选择器显示空白。
    expect(info.reasoning?.defaultEffort).toBeUndefined()
    expect(info.reasoning?.efforts).toHaveLength(1)
  })

  it('无档位的模型不声明 reasoning（UI 显示「未提供推理等级」）', async () => {
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
      fetchRemoteModels: async () => [{
        id: 'M', name: 'M', contextWindow: 100, maxTokens: 10, supportsImage: false,
      }],
    })
    const info = await adapter.resolveModel('zcode', 'M')
    expect(info.reasoning).toBeUndefined()
  })

  it('兜底表也带档位（离线时同样能选）', async () => {
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
      // 不给 fetchRemoteModels → 走 product.fallbackModels
    })
    const info = await adapter.resolveModel('zcode', 'GLM-5.3-Flash')
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
  })
})

describe('思考档位下发为 output_config.effort（协议名是上游给的）', () => {
  /** 发一次请求，捕获请求体。 */
  async function captureBody(reasoningEffort?: string): Promise<Record<string, unknown>> {
    let body = ''
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchRemoteModels: async () => [{
        id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash',
        contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: true,
        reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'max',
      }],
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = String(init?.body ?? '')
        return new Response(
          'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }) as never,
    })
    for await (const _ of adapter.stream({
      provider: 'zcode', model: 'GLM-5.3-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      ...reasoningEffort !== undefined ? { reasoningEffort } : {},
    } as never)) { /* 消费 */ }
    return JSON.parse(body) as Record<string, unknown>
  }

  it('★ 选了档位 → body.output_config.effort（不是 reasoning_effort）', async () => {
    const body = await captureBody('low')
    expect(body.output_config).toEqual({ effort: 'low' })
    // ⚠ 协议名是上游 reasoning.levels[].anthropic.set 里给的，别自己发明。
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('★★ 高/最高档同样下发', async () => {
    expect((await captureBody('high')).output_config).toEqual({ effort: 'high' })
    expect((await captureBody('max')).output_config).toEqual({ effort: 'max' })
  })

  it('★ 不选档位时不写该字段（让上游用自己的默认值）', async () => {
    const body = await captureBody()
    expect(body.output_config).toBeUndefined()
  })

  it('★ 模型不认识的档位不下发（避免整个请求被拒）', async () => {
    const body = await captureBody('xhigh') // 上游只给 low/high/max
    expect(body.output_config).toBeUndefined()
  })
})

/**
 * ⚠ **目录缓存不得被兜底表污染**（全仓同型缺陷，2026-08 起长期存在）。
 *
 * 原实现 `this.remoteModels = fallback; return fallback` 把兜底表当成「已加载」
 * 记下 ⇒ 一次瞬时失败就让它**整个进程生命周期**都只剩兜底模型：用户看不到自己的
 * 模型（ZCode 的远端目录才带正确窗口/输出上限与档位），且无从触发重试
 * （`if (this.remoteModels !== undefined) return` 永远短路），只能重启 DSH。
 * 同批修好的还有 loomy / minimax / raccoon。
 *
 * 另见 `tests/unit/remote-catalog-gate.spec.ts`（并发去重 + 失败冷却）。
 */
describe('ZcodeAdapter 目录缓存语义（★ 兜底表不进缓存）', () => {
  function makeEager(fetchRemoteModels: () => Promise<ZcodeRemoteModel[]>): ZcodeAdapter {
    return new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
      fetchRemoteModels,
    })
  }

  it('★ 远端抛错时不把兜底表写进 remoteModels', async () => {
    const adapter = makeEager(async () => { throw new Error('network down') })
    expect((await adapter.listModels('zcode')).length).toBeGreaterThan(0)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('★ 远端返回空目录时不落缓存，且只拉一次（不被每个模型的 resolveModel 放大）', async () => {
    let calls = 0
    const adapter = makeEager(async () => { calls += 1; return [] })
    expect((await adapter.listModels('zcode')).length).toBeGreaterThan(0)
    expect((await adapter.listModels('zcode')).length).toBeGreaterThan(0)
    await adapter.resolveModel('zcode', 'GLM-5.3-Flash')
    expect(calls).toBe(1)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('远端成功时缓存生效（不破坏既有「成功即缓存」约定）', async () => {
    let calls = 0
    const adapter = makeEager(async () => {
      calls += 1
      return [{
        id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000,
        maxTokens: 128_000, supportsImage: true,
        reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'max',
      }]
    })
    await adapter.listModels('zcode')
    await adapter.listModels('zcode')
    expect(calls).toBe(1)
  })
})
