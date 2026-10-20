import { describe, expect, it } from 'vitest'
import {
  MinimaxAdapter,
  minimaxReasoningInfo,
  registerMinimaxLlm,
} from '../../src/minimax-adapter.js'
import { fallbackToEntry, type MinimaxModelEntry } from '../../src/minimax.js'
import { MINIMAX } from '../../src/minimax-product.js'

const [M31, M3, HS, M27] = MINIMAX.fallbackModels.map(fallbackToEntry)

function makeAdapter(): MinimaxAdapter {
  return new MinimaxAdapter({
    credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
    resolveCredential: async () => undefined,
    refresh: async () => {},
    fetchRemoteModels: async () => [M31, M3, HS, M27],
    product: MINIMAX,
  })
}

describe('minimaxReasoningInfo', () => {
  it('⚠️ M3.1-Flash-Preview 有 6 个档位，默认 default', () => {
    const info = minimaxReasoningInfo(M31)
    expect(info?.efforts.map((e) => e.id)).toEqual([
      'default', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(info?.defaultEffort).toBe('default')
  })

  it('⚠️ 展示名用原文字面量（官方 IDE 就是英文，无 i18n）', () => {
    const info = minimaxReasoningInfo(M31)
    expect(info?.efforts.map((e) => e.name)).toEqual([
      'default', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
  })

  it('⚠️ forced_on 且无 effortOptions 的模型返回 undefined（不编造档位）', () => {
    // ⚠️ 这里**只**列 forced_on 的两个 M2.7 —— 它们既没有档位、也关不掉思考
    //（实测传 disabled 被**静默忽略**，仍有思考块）。
    // ⚠️ M3 **不在此列**：它是 `switchable`，可以关思考，故有 `['none']` 档。
    //（初版把 M3 也算作 undefined，那是**功能缺失** —— 见下一条用例。）
    expect(minimaxReasoningInfo(HS)).toBeUndefined()
    expect(minimaxReasoningInfo(M27)).toBeUndefined()
  })

  // ⚠️ **本轮修复的真实功能缺口**（2026-09-29）：
  // M3 是 `switchable`，实测**不发 thinking 时默认「不思考」**（两轮各 0 字符），
  // `adaptive` 则 2785+ 字符。初版只看 `effort_options`（M3 没有）
  // ⇒ 声明成「无推理等级」⇒ 用户**既不能开也不能关**。
  it('⚠️ M3（switchable）必须声明「开启思考」与「关闭思考」**两档**', () => {
    const info = minimaxReasoningInfo(M3)
    // ⚠️ 只给 none 是**不够的**（我第一版就只给了 none）——
    // 那样用户只能关、无法开，而 M3 默认恰恰是不思考。
    expect(info?.efforts.map((e) => e.id)).toEqual(['on', 'none'])
    expect(info?.efforts.map((e) => e.name)).toEqual(['开启思考', '关闭思考'])
    // ⚠️ M3 远端没有 `default_effort` ⇒ 不设 defaultEffort ⇒ 保持服务端默认
    //（实测 = 不思考）。**不要**擅自设成 'on'，那会改变用户既有行为。
    expect(info?.defaultEffort).toBeUndefined()
  })

  it('⚠️ forced_on 的模型**绝不**追加开关档（给了选项却是空转，比不给更糟）', () => {
    // M3.1 传 disabled 会**硬 400**；M2.7 会被**静默忽略**。
    const m31 = minimaxReasoningInfo(M31)
    expect(m31?.efforts.map((e) => e.id)).not.toContain('none')
    expect(m31?.efforts.map((e) => e.id)).not.toContain('on')
    expect(minimaxReasoningInfo(HS)).toBeUndefined()
  })

  it('⚠️ 既无档位、thinkingMode 也未知 ⇒ 不声明（不猜）', () => {
    expect(minimaxReasoningInfo({ ...M3, thinkingMode: undefined })).toBeUndefined()
  })

  it('⚠️ switchable **且**有 effortOptions 时，两档追加在末尾（不重复）', () => {
    const info = minimaxReasoningInfo({
      ...M31,
      thinkingMode: 'switchable',
      effortOptions: ['low', 'high'],
    })
    expect(info?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'on', 'none'])
    // 远端若哪天自己下了这些名字，不重复追加
    const withBoth = minimaxReasoningInfo({
      ...M31,
      thinkingMode: 'switchable',
      effortOptions: ['low', 'on', 'none'],
    })
    expect(withBoth?.efforts.map((e) => e.id)).toEqual(['low', 'on', 'none'])
  })

  it('⚠️ defaultEffort 不在 efforts 内时不发该字段', () => {
    const info = minimaxReasoningInfo({
      ...M31,
      effortOptions: ['low', 'high'],
      defaultEffort: 'max',
    })
    expect(info?.efforts.map((e) => e.id)).toEqual(['low', 'high'])
    expect(info?.defaultEffort).toBeUndefined()
  })

  it('⚠️ effortOptions 为空数组时返回 undefined（不是「声明 0 个档位」）', () => {
    // ⚠️ brief 的三条「无档位」用例传的是**键缺失**的条目
    //（`fallbackToEntry` 对无档位模型整个不产出该键），因此
    // `options.length === 0` 这个判据**没有被任何 brief 用例覆盖** ——
    // 只判 `options === undefined` 也能全绿。空数组必须与「键缺失」同解，
    // 否则会向 DSH 声明一个 `efforts: []` 的空档位表。
    expect(minimaxReasoningInfo({ ...M31, effortOptions: [] })).toBeUndefined()
  })
})

describe('resolveModel', () => {
  it('⚠️ 窗口取档位表最大档（1M），不是 limit.context（512K）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('minimax', 'MiniMax-M3.1-Flash-Preview')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })

  it('M2.7 系窗口 200K 且不声明 reasoning', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('minimax', 'MiniMax-M2.7')
    expect(resolved.context?.contextWindow).toBe(200_000)
    expect(resolved.reasoning).toBeUndefined()
  })

  it('M3.1 声明 reasoning', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('minimax', 'MiniMax-M3.1-Flash-Preview')
    expect(resolved.reasoning?.efforts).toHaveLength(6)
  })

  it('声明 defaultMaxTokens = 128000', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('minimax', 'MiniMax-M3')
    expect(resolved.defaultMaxTokens).toBe(128_000)
  })

  it('⚠️ 未知模型不编造窗口', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('minimax', 'no-such-model')
    expect(resolved.context).toBeUndefined()
    expect(resolved.reasoning).toBeUndefined()
  })
})

describe('listModels', () => {
  it('列出 4 个模型', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('minimax')
    expect(models.map((m) => m.id)).toEqual([
      'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7',
    ])
  })

  it('M3.1 声明 text+image，M2.7 只有 text', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('minimax')
    expect(models[0]?.inputModalities).toEqual(['text', 'image'])
    expect(models[3]?.inputModalities).toEqual(['text'])
  })
})

describe('stream', () => {
  /*
   * ⚠️ 2026-09-29：原用例断言「抛 推理/余额 错误」（推理未实现的临时状态）。
   * 推理已实现并真实请求验证通过，故改为锁**推理路径的真实契约**。
   */
  it('⚠️ 无可用凭据时抛 MISSING_CREDENTIAL（不再抛「推理未启用」）', async () => {
    const adapter = makeAdapter()
    const iterator = adapter.stream({ model: 'MiniMax-M3', messages: [] } as never)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('⚠️ 有凭据时真的发请求：走 Anthropic Messages 端点与 adaptive 形态', async () => {
    const calls: Array<{ url: string; body: string; auth: string | null }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        body: String(init?.body ?? ''),
        auth: headers.get('Authorization'),
      })
      // 返回一个最小可用的 SSE 流
      const sse = [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收到"}}',
        '',
        'data: {"type":"content_block_stop","index":0}',
        '',
      ].join('\n')
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const adapter = new MinimaxAdapter({
        credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'a'.repeat(60), token_type: 'Bearer',
        }),
        refresh: async () => {},
        fetchRemoteModels: async () => [M31, M3, HS, M27],
        product: MINIMAX,
      })
      const chunks: unknown[] = []
      for await (const c of adapter.stream({
        model: 'MiniMax-M3.1-Flash-Preview',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) chunks.push(c)

      // ① 端点与鉴权
      expect(calls[0]?.url).toBe(`${MINIMAX.apiHost}/mavis/api/v1/llm/v1/messages`)
      expect(calls[0]?.auth).toBe(`Bearer ${'a'.repeat(60)}`)
      // ② 请求体：M3.1 **必须** adaptive（传 disabled 服务端会 400）
      const body = JSON.parse(calls[0]?.body ?? '{}')
      expect(body.model).toBe('MiniMax-M3.1-Flash-Preview')
      expect(body.stream).toBe(true)
      expect(body.thinking).toEqual({ type: 'adaptive' })
      // ③ 文本真的流出来了
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '收到' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('⚠️ 402 归为 QUOTA_EXCEEDED（余额不足必须原样透出，不能归 SERVER）', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      '{"type":"error","error":{"type":"insufficient_balance_error"}}',
      { status: 402 },
    )) as typeof fetch
    try {
      const adapter = new MinimaxAdapter({
        credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'a'.repeat(60), token_type: 'Bearer',
        }),
        refresh: async () => {},
        fetchRemoteModels: async () => [M31, M3, HS, M27],
        product: MINIMAX,
      })
      await expect(adapter.stream({ model: 'MiniMax-M3', messages: [] } as never).next())
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('⚠️ 只有 M3.1 前缀才发 adaptive（M3 不带 thinking 字段）', async () => {
    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}',
        '',
      ].join('\n'), { status: 200 })
    }) as typeof fetch
    try {
      const adapter = new MinimaxAdapter({
        credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'a'.repeat(60), token_type: 'Bearer',
        }),
        refresh: async () => {},
        fetchRemoteModels: async () => [M31, M3, HS, M27],
        product: MINIMAX,
      })
      for await (const _ of adapter.stream({ model: 'MiniMax-M3', messages: [] } as never)) void _
      const body = JSON.parse(bodies[0] ?? '{}')
      // ⚠️ M3 **不是** M3.1：不该命中 adaptive 前缀（实测它不需要）
      expect(body.thinking).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ===== 以下为**追加**用例（brief 之外），用于消除同义反复、锁死反向验证 =====
//
// ## 为什么必须追加
//
// brief 的 fixture 直接取兜底表，若某处断言与**实现内另一条路径**取值巧合相同，
// 断言就成了同义反复（Task 3 已踩过这类风险）。逐条核对后发现**两处真实风险**：
//
// 1. 「窗口取档位表最大档（1M），不是 limit.context（512K）」这条**名不副实**：
//    `makeAdapter()` 的 `fetchRemoteModels` 直接返回 `fallbackToEntry(...)`，
//    而兜底表的 `contextWindow` 就是 **1_000_000**。实现若**完全忽略** `entry.contextWindow`
//    而改用一个硬编码常量 `1_000_000`，这条断言照样通过 —— 它没有证明
//    「窗口来自条目」。
// 2. 「M2.7 系窗口 200K」同理：兜底表 `MiniMax-M2.7` 的 `contextWindow` 正是 200_000，
//    把判据（`> 0`）整个删掉、恒声明一个 200_000 也能过。
//
// ⇒ 追加用例**刻意把条目里的窗口改成与兜底表不同的值**（777_777 / 333_333），
// 这样「窗口来自条目」才真正被证明。

/** 用给定条目重建适配器（覆盖 `fetchRemoteModels`，产品仍为 MINIMAX）。 */
function adapterWithEntries(entries: readonly MinimaxModelEntry[]): MinimaxAdapter {
  return new MinimaxAdapter({
    credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
    resolveCredential: async () => undefined,
    refresh: async () => {},
    fetchRemoteModels: async () => entries,
    product: MINIMAX,
  })
}

describe('resolveModel（判别力：值必须来自条目，不能是巧合常量）', () => {
  it('⚠️ 窗口取自条目本身（777777），不是硬编码的 1M / 兜底表值', async () => {
    const adapter = adapterWithEntries([{ ...M31, contextWindow: 777_777 }])
    const resolved = await adapter.resolveModel('minimax', 'MiniMax-M3.1-Flash-Preview')
    expect(resolved.context?.contextWindow).toBe(777_777)
  })

  it('⚠️ contextWindow = 0（未知哨兵）时不声明 context', async () => {
    // 判据 `entry.contextWindow > 0` 的**唯一**能区分 0 与正数的用例：
    // 条目存在（故 entry !== undefined），但窗口是哨兵 0。
    const adapter = adapterWithEntries([{ ...M31, contextWindow: 0 }])
    const resolved = await adapter.resolveModel('minimax', 'MiniMax-M3.1-Flash-Preview')
    expect(resolved.context).toBeUndefined()
  })

  it('⚠️ 非法 maxTokens（0 / 负数 / NaN / 缺失）一律不声明 defaultMaxTokens', async () => {
    // brief 只覆盖了「合法值 128000 被声明」，没锁「非法值被过滤」。
    // 不锁的话把判据改成直接赋值 `resolved.defaultMaxTokens = entry.maxTokens`
    // 也能过 brief 的全部用例。
    const zero = adapterWithEntries([{ ...M3, maxTokens: 0 }])
    expect((await zero.resolveModel('minimax', 'MiniMax-M3')).defaultMaxTokens).toBeUndefined()

    const negative = adapterWithEntries([{ ...M3, maxTokens: -1 }])
    expect((await negative.resolveModel('minimax', 'MiniMax-M3')).defaultMaxTokens).toBeUndefined()

    const nan = adapterWithEntries([{ ...M3, maxTokens: Number.NaN }])
    expect((await nan.resolveModel('minimax', 'MiniMax-M3')).defaultMaxTokens).toBeUndefined()

    const missing = adapterWithEntries([{ id: 'x', name: 'x', contextWindow: 1_000, supportsImage: false }])
    expect((await missing.resolveModel('minimax', 'x')).defaultMaxTokens).toBeUndefined()
  })

  it('⚠️ maxTokens 为小数时不声明（isSafeInteger 判据，非「> 0」）', async () => {
    const adapter = adapterWithEntries([{ ...M3, maxTokens: 1_000.5 }])
    expect((await adapter.resolveModel('minimax', 'MiniMax-M3')).defaultMaxTokens).toBeUndefined()
  })
})

describe('listModels（判别力与门控）', () => {
  it('⚠️ 无已登录账号时返回 []（不抛错，否则多一条 provider 报错）', async () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => [M31, M3, HS, M27],
      product: MINIMAX,
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    await expect(adapter.listModels('minimax')).resolves.toEqual([])
  })

  it('有已登录账号时正常列出（门控不能恒为假）', async () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => [M31, M3, HS, M27],
      product: MINIMAX,
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    expect(await adapter.listModels('minimax')).toHaveLength(4)
  })

  it('黑名单模型被剔除，且 listAllModels 不受黑名单影响', async () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => [M31, M3, HS, M27],
      product: MINIMAX,
      accountPool: {
        disabledModelsFor: () => new Set(['MiniMax-M3']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const listed = await adapter.listModels('minimax')
    expect(listed.map((m) => m.id)).not.toContain('MiniMax-M3')
    expect(listed).toHaveLength(3)
    // ⚠️ `listAllModels()` 必须**同步**返回数组（不是 Promise）——
    // 与 8 个既有适配器一致，且 `jet-hub-rpc.ts` 的两处消费者都不 await
    //（`:2041` `[...all]` / `:2125` `all.map(...)`）。
    // 早期写成 `async` 会在这两处抛 `TypeError: not iterable`。
    // 这里显式断言它不是 Promise（若退回 `async` 立即变红）。
    const all = adapter.listAllModels()
    expect(all).not.toBeInstanceOf(Promise)
    expect(Array.isArray(all)).toBe(true)
    expect(all.map((m) => m.id)).toContain('MiniMax-M3')
  })

  it('⚠️ 远端目录非空时不回退兜底表（窗口随远端变化）', async () => {
    // 只留一条远端条目、窗口刻意取兜底表没有的值 ⇒ 证明走的是远端而非兜底表。
    const adapter = adapterWithEntries([{ ...M31, contextWindow: 333_333 }])
    const listed = await adapter.listModels('minimax')
    expect(listed.map((m) => m.id)).toEqual(['MiniMax-M3.1-Flash-Preview'])
    const resolved = await adapter.resolveModel('minimax', 'MiniMax-M3.1-Flash-Preview')
    expect(resolved.context?.contextWindow).toBe(333_333)
  })

  it('远端失败时回退兜底表（4 条）', async () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => { throw new Error('boom') },
      product: MINIMAX,
    })
    expect(await adapter.listModels('minimax')).toHaveLength(4)
  })
})

describe('providerInfo / prepareCall / registerMinimaxLlm', () => {
  it('providerInfo 回填产品 id 与展示名', () => {
    const adapter = makeAdapter()
    expect(adapter.providerInfo('minimax')).toEqual({ id: 'minimax', name: 'MiniMax Code' })
    // 空串回填产品 id（照实现）
    expect(adapter.providerInfo('')).toEqual({ id: 'minimax', name: 'MiniMax Code' })
  })

  it('prepareCall 的 stream 走同一条推理路径（不能只锁 stream() 本身）', async () => {
    const adapter = makeAdapter()
    const prepared = await adapter.prepareCall('minimax', 'MiniMax-M3')
    expect(prepared.model.id).toBe('MiniMax-M3')
    // ⚠️ makeAdapter 的 resolveCredential 恒返回 undefined ⇒ MISSING_CREDENTIAL。
    // 关键是它与 `stream()` **同源**（不是某条旁路）。
    await expect(prepared.stream({ model: 'MiniMax-M3' } as never).next())
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('registerMinimaxLlm 只注册适配器，不声明可配置 provider（设置页不留行）', async () => {
    // ⚠️ 2026-10-01（用户要求）：账号、模型开关与模型目录都在 Jet Hub 设置页管理，
    // 声明只会在「设置 → 模型 → 提供商」留下无人使用的行。机制与代价评估见
    // src/llm-register-compat.ts 模块头。
    const registered: unknown[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: (entries: unknown) => { registered.push(entries) },
        registerAdapter: (routes: unknown, adapter: unknown) => { registered.push([routes, adapter]) },
      },
      settings: undefined,
      logger: undefined,
    }
    const adapter = registerMinimaxLlm(ctx as never, {
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => [M31, M3, HS, M27],
      product: MINIMAX,
    })
    expect(adapter).toBeInstanceOf(MinimaxAdapter)
    // 唯一一次登记就是 adapter 路由：configurable 目录一次都没碰。
    expect(registered).toHaveLength(1)
    expect(registered[0]).toEqual([['minimax'], adapter])
  })
})

/**
 * ⚠ **目录缓存不得被兜底表污染**（全仓同型缺陷，2026-08 起长期存在）。
 *
 * 原实现 `this.remoteModels = fallback; return fallback` 把兜底表当成「已加载」
 * 记下 ⇒ 一次瞬时失败就让它**整个进程生命周期**都只剩兜底模型：用户看不到自己的
 * 模型，且无从触发重试（`if (this.remoteModels !== undefined) return` 永远短路），
 * 只能重启 DSH。同批修好的还有 loomy / raccoon / zcode。
 *
 * 另见 `tests/unit/remote-catalog-gate.spec.ts`（并发去重 + 失败冷却）。
 */
describe('MinimaxAdapter 目录缓存语义（★ 兜底表不进缓存）', () => {
  function makeEager(fetchRemoteModels: () => Promise<readonly MinimaxModelEntry[]>): MinimaxAdapter {
    return new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels,
      product: MINIMAX,
    })
  }

  it('★ 远端抛错时不把兜底表写进 remoteModels', async () => {
    const adapter = makeEager(async () => { throw new Error('network down') })
    expect((await adapter.listModels('minimax')).length).toBeGreaterThan(0)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('★ 远端返回空目录时不落缓存，且只拉一次（不被每个模型的 resolveModel 放大）', async () => {
    let calls = 0
    const adapter = makeEager(async () => { calls += 1; return [] })
    expect((await adapter.listModels('minimax')).length).toBeGreaterThan(0)
    expect((await adapter.listModels('minimax')).length).toBeGreaterThan(0)
    await adapter.resolveModel('minimax', M31!.id)
    expect(calls).toBe(1)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('远端成功时缓存生效（不破坏既有「成功即缓存」约定）', async () => {
    let calls = 0
    const adapter = makeEager(async () => { calls += 1; return [M31!] })
    await adapter.listModels('minimax')
    await adapter.listModels('minimax')
    expect(calls).toBe(1)
  })
})

/*
 * ⚠️ 2026-09-29：原本这里有一条「stream() 抛 UNSUPPORTED_CONTENT」的用例，
 * 它锁的是**推理未实现**这个临时状态。推理已实现（真实请求验证通过），
 * 该用例与 `MINIMAX_INFERENCE_NOT_READY_MESSAGE` 常量一并删除 ——
 * 留着会让「实现推理」这件事被测试判为回归。
 * 推理的回归用例见 `tests/unit/minimax-messages.spec.ts`。
 */
