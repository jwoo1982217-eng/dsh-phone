import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LoomyAdapter, classifyLoomyFailure, parseLoomyRemoteModels, recordsLoomyRateLimit,
} from '../../src/loomy-adapter.js'
import { classifyRaccoonFailure } from '../../src/raccoon-adapter.js'
import type { LoomyCredential } from '../../src/loomy.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '13011112222',
}

/** 实测的远端模型条目（2026-09-26 GET /api/v1/models 的真实形状）。 */
function remoteEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'MiniMax-M3',
    name: 'MiniMax M3 （x4.0）',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_048_576,
    max_output_tokens: 512_000,
    capabilities: {
      reasoning: true, vision: true, function_calling: true,
      input_modalities: ['text', 'image', 'video'], output_modalities: ['text'],
    },
    ...over,
  }
}

function makeAdapter(over: Partial<ConstructorParameters<typeof LoomyAdapter>[0]> = {}) {
  return new LoomyAdapter({
    credentialRef: credentialRef('LOOMY_ACCOUNT_TEST'),
    resolveCredential: async () => CRED,
    refresh: async () => {},
    ...over,
  })
}

describe('parseLoomyRemoteModels', () => {
  it('只保留 type=chat，并把倍率规范化进 name', () => {
    const models = parseLoomyRemoteModels({
      object: 'list',
      data: [
        remoteEntry(),
        remoteEntry({ id: 'Hy-Image-3.5-preview', name: 'Hy image 3.5 preview', type: 'image' }),
      ],
    })
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('MiniMax-M3')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
    expect(models[0]!.contextWindow).toBe(1_048_576)
    expect(models[0]!.supportsImage).toBe(true)
    expect(models[0]!.supportsThinking).toBe(true)
  })

  it('接受裸数组与 {data:[]} 两种形态', () => {
    expect(parseLoomyRemoteModels([remoteEntry()])).toHaveLength(1)
    expect(parseLoomyRemoteModels({ data: [remoteEntry()] })).toHaveLength(1)
  })

  it('畸形输入返回空数组（不抛）', () => {
    expect(parseLoomyRemoteModels(null)).toEqual([])
    expect(parseLoomyRemoteModels('x')).toEqual([])
    expect(parseLoomyRemoteModels({ data: 'x' })).toEqual([])
  })

  it('input_modalities 不含 image 时 supportsImage 为 false', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731（x3.0）',
        capabilities: { reasoning: true, input_modalities: ['text'] },
      })],
    })
    expect(models[0]!.supportsImage).toBe(false)
  })
})

describe('LoomyAdapter.listModels', () => {
  it('远端可用时用远端（带倍率）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry(), remoteEntry({ id: 'spark-x', name: 'Spark X2.5（x0.1）' })],
      }),
    })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(2)
    expect(models[0]!.provider).toBe('loomy')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
  })

  it('远端失败时回退兜底表（8 个，兜底表名已含倍率）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(8)
    expect(models.map((m) => m.id)).toContain('qwen3.8-flash')
  })

  /**
   * ⚠ **兜底表不得被当成缓存**（真实缺陷，2026-08 起长期存在）。
   *
   * 原实现是 `this.remoteModels = fallback; return fallback`：一次瞬时失败会把
   * 兜底表写进 `remoteModels`，此后 `if (this.remoteModels !== undefined)` 永远短路
   * ⇒ 该 provider **整个进程生命周期**都只剩兜底模型，用户看不到自己的模型，
   * 也无从触发重试，只能重启 DSH。
   *
   * 修好之后：兜底表每次现算，`remoteModels` 只装**真实远端目录**。
   * 恢复时机由 `RemoteCatalogGate` 的冷却窗口决定（30s，见
   * `tests/unit/remote-catalog-gate.spec.ts`），这里只锁「缓存没被污染」。
   */
  it('★ 远端失败后**不**把兜底表写进 remoteModels', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    expect(await adapter.listModels('loomy')).toHaveLength(8)
    const cache = (adapter as unknown as { remoteModels: unknown }).remoteModels
    expect(cache, '兜底表不得进缓存 —— 否则远端恢复后也永远看不到真实目录').toBeUndefined()
  })

  it('★ 远端返回空目录同样不落缓存（空结果也会被冷却挡住，不会每模型重试一次）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { calls += 1; return [] },
    })
    expect(await adapter.listModels('loomy')).toHaveLength(8)
    // ⚠ 只应拉一次：`buildModelCatalog` 会为每个模型各调一次 resolveModel，
    // 不去重/不冷却的话这里会变成 N 次串行请求。
    expect(await adapter.listModels('loomy')).toHaveLength(8)
    expect(await adapter.resolveModel('loomy', 'qwen3.8-flash')).toBeDefined()
    expect(calls).toBe(1)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('★ 远端成功时缓存生效：后续调用不再打网络', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { calls += 1; return parseLoomyRemoteModels({ data: [remoteEntry()] }) },
    })
    await adapter.listModels('loomy')
    await adapter.listModels('loomy')
    await adapter.listModels('loomy')
    expect(calls).toBe(1)
  })

  it('无账号池时目录可见（headless/单测保守放行）', async () => {
    const adapter = makeAdapter()
    expect((await adapter.listModels('loomy')).length).toBeGreaterThan(0)
  })

  it('有账号池但未登录时返回空数组（不抛错）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect(await adapter.listModels('loomy')).toEqual([])
  })

  it('黑名单里的模型被过滤', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const ids = (await adapter.listModels('loomy')).map((m) => m.id)
    expect(ids).not.toContain('spark-x')
    expect(ids.length).toBe(7)
  })
})

describe('LoomyAdapter.listAllModels', () => {
  it('不套黑名单，且带最终展示名', () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const all = adapter.listAllModels()
    // 被关闭的 spark-x 也必须出现（否则用户无法重新打开）
    expect(all.map((m) => m.id)).toContain('spark-x')
    expect(all.find((m) => m.id === 'spark-x')!.name).toBe('Spark X2.5 · x0.1')
  })
})

describe('LoomyAdapter.resolveModel', () => {
  it('name 不带倍率（价格只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'spark-x')
    expect(resolved.name).toBe('Spark X2.5')
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('未知模型不编造 context', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'nope')
    expect(resolved.context).toBeUndefined()
  })
})

/**
 * ⚠️ **思考档位**（用户报障：「loomy ide 中可以设置思考档位，我们现在没法设置」）。
 *
 * 根因与 Qoder 那次**完全同型**（见 AGENTS.md 2.2 节）：`resolveModel`
 * **只声明 `context`，从不声明 `reasoning`** —— 而 DSH 的思考强度选择器
 * **只会**从 `resolveModel().reasoning` 渲染，故档位选择器从来没出现过，
 * 尽管远端早就下发了 `reasoning_efforts`。
 *
 * 用户要求「如果能从远端得到配置中直接生成是最好的」—— 正是本实现的做法。
 */
describe('LoomyAdapter 思考档位', () => {
  /** 实测的档位（8 个 chat 模型完全一致）。 */
  const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

  it('parseLoomyRemoteModels 读出 reasoning_efforts 与默认档', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
    })
    expect(models[0]!.efforts).toEqual(EFFORTS)
    expect(models[0]!.defaultEffort).toBe('low')
  })

  it('远端未下发档位时不写这两个键（而非写空数组）', () => {
    const models = parseLoomyRemoteModels({ data: [remoteEntry()] })
    expect(models[0]!.efforts).toBeUndefined()
    expect(models[0]!.defaultEffort).toBeUndefined()
  })

  it('非法档位项被丢弃，且去重', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ reasoning_efforts: ['low', 42, null, 'low', 'high', ''] })],
    })
    expect(models[0]!.efforts).toEqual(['low', 'high'])
  })

  it('resolveModel 声明 reasoning（远端档位直接生成，含官方中文名）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
    // 中文名与官方 IDE 一致（DSH 直接渲染 name，不本地化）
    expect(resolved.reasoning?.efforts.map((e) => e.name))
      .toEqual(['关闭思考', '低', '中', '高', '极高'])
  })

  /**
   * ⚠️ **默认档用本插件自己的 `high`，不采信远端的 `low`**（用户要求）。
   *
   * 依据：DSH 的 `effectiveEffort = state.current?.reasoningEffort
   * ?? reasoning?.defaultEffort` —— 「用户没选时发哪个档」完全由适配器声明的
   * `defaultEffort` 决定，沿用远端的 `low` 会让默认思考偏浅。
   *
   * ⚠️ 反向断言：**绝不能**等于远端声明的 `low`（否则等于没改）。
   */
  it('默认档是 high，不是远端声明的 low（用户要求）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.defaultEffort).toBe('high')
    expect(resolved.reasoning?.defaultEffort).not.toBe('low')
  })

  /**
   * ⚠️ `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
   * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟。
   *
   * 这里造一个**不含 `high`** 的模型（远端目录变化时真会发生），
   * 期望**不下发默认档**（退回 DSH 的「服务商默认」），而不是硬发 `high`。
   */
  it('模型不提供 high 档时不下发默认档（但档位照常给出）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'medium'], default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'medium'])
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
  })

  /**
   * ⚠️ 远端某模型**未下发**档位、但它在兜底表里有档位时，**仍给出档位**。
   *
   * 这是**有意为之**：`loadModels()` 在远端返回非空时采信远端，但
   * `reasoningFor` 会回退到兜底表 —— 因为「远端这一条没带档位」不等于
   * 「该模型不支持档位」（可能是上游某次下发的字段缺失）。
   * 而兜底表的档位是**实测值**，给出它比让选择器凭空消失更好。
   */
  it('远端该模型未带档位时回退兜底表档位（不凭空消失）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({ data: [remoteEntry()] }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
  })

  /** 真正「不提供档位」的是**兜底表也没有**的模型（如远端新上线的模型）。 */
  it('远端与兜底表都没有档位时不声明 reasoning', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        // 一个兜底表里没有的新模型，且未下发档位
        data: [remoteEntry({ id: 'brand-new-model', name: 'Brand New' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'brand-new-model')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('远端整体失败时用兜底表的档位', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const resolved = await adapter.resolveModel('loomy', 'qwen3.8-flash')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
    // ⚠️ 兜底路径的默认档也必须与远端路径一致（都是 high），
    // 否则「远端可用/不可用」会让默认档悄悄变化。
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('未登记的中文名回退到 id 本身（新档位上线时不至于空白）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'ultra'] })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['低', 'ultra'])
  })
})

describe('LoomyAdapter 请求体里的 reasoning_effort', () => {
  const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

  /** 造一个 SSE 响应并捕获请求体。 */
  function makeFetch(captured: { body?: Record<string, unknown> }) {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]
      return new Response(frames.join(''), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  async function drain(adapter: LoomyAdapter, effort?: string) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy',
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
      ...effort !== undefined ? { reasoningEffort: effort as never } : {},
    })) {
      // 只为把请求发出去
    }
  }

  it('用户选了档位时下发 reasoning_effort', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    await drain(adapter, 'high')
    expect(captured.body?.reasoning_effort).toBe('high')
  })

  it('未选档位时不下发该字段（让服务端用默认档）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS })],
      }),
    })
    await drain(adapter)
    expect(captured.body).not.toHaveProperty('reasoning_effort')
  })

  /**
   * ⚠️ **安全约束**：档位不在该模型声明的 `efforts` 内时**静默不下发**。
   *
   * 给一个远端不认的值比不给更糟（可能被拒，或行为未定义）。DSH 会把用户选的
   * 档位直接透传，故这里必须自己校验。
   */
  it('档位不在该模型的 efforts 内时不下发', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'high'] })],
      }),
    })
    await drain(adapter, 'xhigh')
    expect(captured.body).not.toHaveProperty('reasoning_effort')
  })

  it('远端整体失败时用兜底表档位校验（xhigh 在表内 → 下发）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    await drain(adapter, 'xhigh')
    expect(captured.body?.reasoning_effort).toBe('xhigh')
  })
})

describe('LoomyAdapter.providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    expect(makeAdapter().providerInfo('loomy')).toEqual({ id: 'loomy', name: 'Loomy (讯飞)' })
  })

  it('provider 非法时回退到产品 id（避免 undefined.toUpperCase 崩）', () => {
    expect(makeAdapter().providerInfo(undefined as never).id).toBe('loomy')
  })
})

/**
 * `classifyLoomyFailure` 判据（loomy ↔ raccoon **同型复发**，2026-10-06）。
 *
 * ## 缺陷形态
 *
 * loomy 的分类器初版与 raccoon 的**修复前**版本逐字同形（文案先判 +
 * `insufficient` 单独出现即算额度）。raccoon 已在 `7b524ff` 收窄，loomy 未同步
 * ⇒ 同一报文在两个 provider 上被判成**不同类别**，且危险方向恒定朝 loomy：
 * `quota` 会走 `recordsLoomyRateLimit` ⇒ **给账号写 24h 模型冷却**。
 *
 * 实测（临时探针，已删）三例 —— 403 + `insufficient permissions`、
 * 403 + 积分不足、401 + 余额不足：loomy 判 quota 并写冷却，raccoon 判 auth 不写。
 * 前两例与 2026-10-06「全池被封」事故同型（那次触发词是
 * `authorization_verify_error`），只是触发词换成了文案判据。
 */
describe('classifyLoomyFailure 判据（与 raccoon 逐格同构）', () => {
  it('★ 真实额度形态仍归 quota（含 PR 报障的 400 + insufficient_points）', () => {
    expect(classifyLoomyFailure('{"code":"insufficient_points"}', 400)).toBe('quota')
    expect(classifyLoomyFailure('insufficient_points', 402)).toBe('quota')
    expect(classifyLoomyFailure('14018 Credits exhausted', 400)).toBe('quota')
    expect(classifyLoomyFailure('积分不足', 400)).toBe('quota')
    expect(classifyLoomyFailure('余额不足', 400)).toBe('quota')
  })

  /**
   * ★★ `insufficient` 单独出现**不得**判成 quota（raccoon 侧 PR !71 审计实测
   * 误伤 5 类）。误判后果同样是**封一个只是上下文超长的账号 24h**。
   */
  it('★★ 上下文/数据类 insufficient 不判 quota（不写 24h 冷却）', () => {
    expect(classifyLoomyFailure('the context window is insufficient for this model', 400)).toBe('other')
    expect(classifyLoomyFailure('input length is insufficient', 400)).toBe('other')
    expect(classifyLoomyFailure('insufficient data to complete the request', 400)).toBe('other')
  })

  /**
   * ★★★ 401/403 必须归 **auth**（不是 quota）—— 即使报文里带额度文案。
   *
   * 认证类是 2026-10-06 事故换来的不变式：**只换号、绝不写冷却标记**。
   * 上游网关对全池回 401 时常在报文里捎带余额提示，若按文案判 quota，
   * 一个请求内每个号各被封 24h ⇒ 整个 provider 死一天。
   */
  it('★★★ 401/403 恒归 auth（含 insufficient permissions / 积分不足 / 余额不足）', () => {
    expect(classifyLoomyFailure('insufficient permissions to access this resource', 403)).toBe('auth')
    expect(classifyLoomyFailure('积分不足，请充值', 403)).toBe('auth')
    expect(classifyLoomyFailure('余额不足', 401)).toBe('auth')
    expect(classifyLoomyFailure('{"code":200003,"message":"authorization_verify_error"}', 401)).toBe('auth')
    // 状态码与额度文案并存时，仍以状态码为准。
    expect(classifyLoomyFailure('14018 Credits exhausted', 401)).toBe('auth')
    // 且必须**不写冷却**（这才是事故的真正触发点）。
    expect(recordsLoomyRateLimit(classifyLoomyFailure('余额不足', 401))).toBe(false)
  })

  it('429 与 402 按状态码归类', () => {
    expect(classifyLoomyFailure('', 429)).toBe('rate')
    expect(classifyLoomyFailure('', 402)).toBe('quota')
    expect(classifyLoomyFailure('param is invalid', 400)).toBe('other')
  })

  /**
   * ★★★ **对拍**：同一批真实报文喂 loomy 与 raccoon 两个分类器，逐条必须同结论。
   *
   * 这是本缺陷的**同型复发**防线 —— 单看 loomy 自己的用例，未来任何一次
   * 单方面改动（哪怕方向是"更严"）都会让两侧再次分叉，而两侧各自的用例
   * 都能过。对拍用例把「必须逐格一致」这件事本身锁进测试。
   *
   * ⚠️ 报文集刻意混合「两家共有的额度形态」与「只在一边被误判的文案」，
   * 且**含状态码维度**（403/401 的优先级只有靠状态码才能验证）。
   */
  it('★★★ 与 raccoon 对拍：同一报文集逐条同结论（同型复发防线）', () => {
    const corpus: Array<[string, number]> = [
      ['insufficient permissions to access this resource', 403],
      ['积分不足，请充值', 403],
      ['余额不足', 401],
      ['额度已耗尽', 402],
      ['14018 Credits exhausted', 401],
      ['the context window is insufficient for this model', 400],
      ['insufficient data to complete the request', 400],
      ['{"code":"insufficient_points"}', 400],
      ['14018 Credits exhausted', 402],
      ['积分不足', 400],
      ['quota exceeded', 400],
      ['', 429],
      ['param is invalid', 400],
    ]
    const diverged = corpus
      .map(([text, status]) => ({
        text,
        status,
        loomy: classifyLoomyFailure(text, status),
        raccoon: classifyRaccoonFailure(text, status),
      }))
      .filter((row) => row.loomy !== row.raccoon)
    expect(
      diverged,
      `loomy 与 raccoon 的分类结论出现分叉（同型复发）：${JSON.stringify(diverged)}`,
    ).toEqual([])
  })
})

/**
 * 请求级账号轮换（★ 2026-10-05，用户报障「余额用完一个号就卡死」）。
 *
 * ## 为什么余额选号器救不了
 *
 * `loomy-balance-selector` 只在**取号时**按余额分档；余额查询与实际扣费是
 * 两个时刻——查询时有钱、推理时上游报 `14018`，错误直接抛 harness，
 * 下次取号还是同一个号 ⇒ 「卡死在一个号上」。
 *
 * 本 describe 锁定：HTTP 层额度耗尽 → 标记坏号该模型 24h → `tried` 换下一个
 * → 重发成功；全部耗尽才报错且带最后一次真实原因；非额度类 4xx 不换号。
 * 语义与 raccoon / buddy 三处对齐（同一张判据形状，各家用各家的词表）。
 */
describe('LoomyAdapter 请求级账号轮换（余额耗尽无感切号）', () => {
  const CRED_A: LoomyCredential = { access_token: 'tok-A', userid: 'ua', phone: '13800000001' }
  const CRED_B: LoomyCredential = { access_token: 'tok-B', userid: 'ub', phone: '13800000002' }

  function makePoolStub() {
    const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const picks: Array<ReadonlySet<string> | undefined> = []
    const accounts = [
      { id: 'loomy-A', cred: CRED_A },
      { id: 'loomy-B', cred: CRED_B },
    ]
    const pool = {
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marks.push({ accountId, modelId, resetAtMs })
      },
      getAvailableAccount: async (_provider: string, _model: string, exclude?: ReadonlySet<string>) => {
        picks.push(exclude)
        for (const a of accounts) {
          if (exclude?.has(a.id)) continue
          return { entry: { id: a.id }, credential: a.cred }
        }
        return null
      },
      findAccountIdByCredential: async (_provider: string, identity: string) =>
        accounts.find((a) => a.cred.access_token === identity)?.id ?? '',
    }
    return { pool, marks, picks }
  }

  const sseOk = () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"从二号账号返回"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

  it('★ 一号额度耗尽（14018）→ 标记该模型 + 切二号重发成功', async () => {
    const { pool, marks, picks } = makePoolStub()
    const seenAuth: string[] = []
    let call = 0
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      seenAuth.push(String(new Headers(init?.headers).get('Authorization') ?? ''))
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 })
      }
      return sseOk()
    }) as unknown as typeof fetch

    const adapter = makeAdapter({
      // 首发凭据 = 池的第一号（对齐生产：resolveCredential 从池选号）。
      resolveCredential: async () => CRED_A,
      accountPool: pool as never,
      fetchImpl: fetcher,
    })
    const chunks: unknown[] = []
    for await (const c of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(c)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(seenAuth[0]).toContain('tok-A')
    expect(seenAuth[1]).toContain('tok-B')
    expect(chunks.some((c) => (c as { type?: string }).type === 'text-delta')).toBe(true)
    expect(marks.some((m) => m.accountId === 'loomy-A' && m.modelId === 'MiniMax-M3')).toBe(true)
    expect(picks[0]?.has('loomy-A') ?? false).toBe(true)
  })

  it('★ 两号都耗尽 → 报「所有账号均不可用」并带最后一次的真实原因', async () => {
    const { pool } = makePoolStub()
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '')
      return new Response(
        JSON.stringify({ error: { message: `14018 exhausted (${auth.includes('tok-B') ? 'B' : 'A'})` } }),
        { status: 402 },
      )
    }) as unknown as typeof fetch

    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const error = await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('所有账号')
    expect((error as Error).message).toContain('B')
  })

  it('非额度类 4xx（400 参数错）不换号', async () => {
    const { pool, picks } = makePoolStub()
    const fetcher = (async () =>
      new Response('{"error":{"message":"param is invalid"}}', { status: 400 })) as unknown as typeof fetch
    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const error = await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch((e: unknown) => e)

    expect((error as Error).message).toContain('param is invalid')
    // 不换号：pool 的取号一次都没被调用（stream 里轮换块整体跳过；
    // findAccountIdByCredential 会被调一次——那是记账键反查，不是换号）。
    expect(picks.length).toBe(0)
  })

  /**
   * ★ 认证类（401/403）**换号但不写冷却标记** —— 真实事故回归（2026-10-06）。
   *
   * 上游网关对全池回 `401 + authorization_verify_error`（网关侧授权故障）。
   * 旧实现把 401 也写 24h 冷却 ⇒ 一个请求连试 6 个号、每个封 24h ⇒
   * **整个 provider 被封一天**，下一次请求报 `no usable credential; log in first`。
   * 语义对齐 buddy：只有限流类写标记，认证类只换号。
   */
  it('★ 401 授权失败：换号但绝不写冷却标记（全池失败也不写）', async () => {
    const { pool, marks } = makePoolStub()
    let call = 0
    const fetcher = vi.fn(async () => {
      call += 1
      // 一号 401；二号正常
      if (call === 1) {
        return new Response(JSON.stringify({ code: 200003, message: 'authorization_verify_error' }), { status: 401 })
      }
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"二号正常"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const chunks: unknown[] = []
    for await (const c of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(c)

    expect(fetcher.mock.calls.length).toBeGreaterThan(1)
    expect(chunks.some((c) => (c as { type?: string }).type === 'text-delta')).toBe(true)
    expect(marks).toEqual([])
  })

  it('★ 401 打遍全池：不留任何标记（池保持可用）', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = (async () =>
      new Response(JSON.stringify({ code: 200003, message: 'authorization_verify_error' }), { status: 401 })) as unknown as typeof fetch
    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const error = await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect(marks).toEqual([])
  })

  /**
   * ★★ 「**最后一个**失败账号必须被标记」（PR !71 审计发现的真实缺陷）。
   *
   * ## 缺陷与为什么两条账号的用例测不到
   *
   * 旧实现把写标记放在 `for` 循环**开头**。于是**迭代次数 = 标记次数**，
   * 而最后一次失败发生在循环体的**末尾**、不会再有下一次迭代 ⇒ **末号漏记**。
   *
   * ⚠️ 这正是同族 PR !71 在 raccoon 上修的同一个缺陷（loomy 未同步修）。
   * ⚠️ **两条账号的用例是同义反复、测不到它**：循环跑 2 次、写 2 个标记，
   * 修复前后输出完全一样。缺陷只在**轮换预算恰好用尽**（池里账号数 ≥
   * `LOOMY_MAX_ROTATE`）或**末号之后 `getAvailableAccount` 返回 null** 时暴露。
   */
  it('★★ 8 账号全耗尽（轮换预算恰好用尽）→ 8 个号全部被标记，末号不漏', async () => {
    const marks: Array<{ accountId: string }> = []
    const ids = Array.from({ length: 8 }, (_, i) => `loomy-${i + 1}`)
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      getAvailableAccount: async (_p: string, _m: string, exclude?: ReadonlySet<string>) => {
        for (const id of ids) {
          if (exclude?.has(id)) continue
          return { entry: { id }, credential: { ...CRED_A, access_token: `tok-${id}` } }
        }
        return null
      },
      findAccountIdByCredential: async (_p: string, identity: string) =>
        ids.find((id) => `tok-${id}` === identity) ?? '',
    }
    const fetcher = (async () => new Response(
      JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
    )) as unknown as typeof fetch

    const adapter = makeAdapter({
      resolveCredential: async () => ({ ...CRED_A, access_token: 'tok-loomy-1' }),
      accountPool: pool as never,
      fetchImpl: fetcher,
    })
    await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch(() => null)

    // 8 个号每个都必须留下冷却标记（修复前只有 7 个，末号漏记 ⇒ 下次又被选中）。
    expect(marks.map((m) => m.accountId)).toEqual(ids)
  })

  /** ★ 末号之后池已空（`getAvailableAccount` 返回 null）→ 末号同样必须被标记。 */
  it('★★ 末号失败后池已空 → 末号仍被标记（不因「没有下一个号」而漏记）', async () => {
    const marks: Array<{ accountId: string }> = []
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      // 单账号池：首号失败后没有下一个候选
      getAvailableAccount: async () => null,
      findAccountIdByCredential: async () => 'loomy-A',
    }
    const fetcher = (async () => new Response(
      JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
    )) as unknown as typeof fetch

    const adapter = makeAdapter({
      resolveCredential: async () => CRED_A,
      accountPool: pool as never,
      fetchImpl: fetcher,
    })
    await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch(() => null)

    expect(marks.map((m) => m.accountId)).toEqual(['loomy-A'])
  })

  /**
   * ★★ 401 续期后**必须重新反查账号 id**（与 raccoon 的 `51ded6a` 同款缺陷，
   * loomy 当时未同步修）。
   *
   * `options.resolveCredential` 是**池优先 + 余额分档**的（`src/index.ts` 的
   * loomy 分支先 `loomyBalanceSelector.select()` 再解析该号的 ref），而
   * `refresh()` 续期/探测的是**池当前默认账号**。⇒ 续期后取回的凭据
   * **可能属于另一个账号**，而 `activeAccountId` 仍停在刷新前的那个号上。
   *
   * 旧实现不更新它 ⇒ 冷却标记**记在没发这次请求的号头上**：没耗尽的号被封 24h，
   * 而真该封的号下次仍被选中（本段要修的「卡死在一个号上」照旧）。
   * 与 AGENTS.md 记的 Qoder「标记用了会变的回调导致标错账号」同型。
   */
  it('★★ 401 续期后凭据换成了别的账号 → 标记记在**真正耗尽的那个号**上', async () => {
    const marks: Array<{ accountId: string }> = []
    // ⚠️ 桩必须自洽：id ↔ token 一一对应，否则 `findAccountIdByCredential`
    // 与 `getAvailableAccount` 会互相认错号（raccoon 侧写这条时踩过：
    // 取号发的是 `tok-raccoon-B`、而续期后是 `tok-B`，反查得到另一个 id）。
    const byToken: Record<string, string> = { 'tok-A': 'loomy-A', 'tok-B': 'loomy-B' }
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      getAvailableAccount: async (_p: string, _m: string, exclude?: ReadonlySet<string>) => {
        for (const token of ['tok-A', 'tok-B']) {
          const id = byToken[token]!
          if (exclude?.has(id)) continue
          return { entry: { id }, credential: { access_token: token, userid: id, phone: '13800000000' } }
        }
        return null
      },
      findAccountIdByCredential: async (_p: string, identity: string) => byToken[identity] ?? '',
    }
    // 第 1 次解析 = A 的凭据；续期后 = B 的凭据（生产语义：refresh 探测的是
    // 池当前默认账号，随后 resolveCredential 又按余额分档取号）。
    let resolves = 0
    const adapter = makeAdapter({
      resolveCredential: async () => (++resolves === 1
        ? { access_token: 'tok-A', userid: 'loomy-A', phone: '13800000001' }
        : { access_token: 'tok-B', userid: 'loomy-B', phone: '13800000002' }),
      accountPool: pool as never,
      // A 返回 401（触发续期）；此后无论哪个号都额度耗尽。
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const auth = String(new Headers(init.headers).get('Authorization') ?? '')
        if (auth.includes('tok-A')) {
          return new Response('{"code":200003}', { status: 401 })
        }
        return new Response(
          JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
        )
      }) as unknown as typeof fetch,
    })
    await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch(() => null)

    // 真正耗尽的是 B —— A 只返回了 401（认证类，本就不该写标记）。
    expect(marks.map((m) => m.accountId)).toEqual(['loomy-B'])
  })
})
