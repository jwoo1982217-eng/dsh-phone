import { describe, expect, it } from 'vitest'
import {
  MinimaxAdapter,
  classifyMinimaxFailure,
  minimaxReasoningInfo,
  recordsMinimaxRateLimit,
  registerMinimaxLlm,
  shouldRotateMinimaxAccount,
} from '../../src/minimax-adapter.js'
import { fallbackToEntry, type MinimaxCredential, type MinimaxModelEntry } from '../../src/minimax.js'
import { MINIMAX, MINIMAX_INTL } from '../../src/minimax-product.js'

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
  it('⚠️ M3（switchable）必须声明「关闭思考」与「开启思考」**两档**（强度序）', () => {
    const info = minimaxReasoningInfo(M3)
    // ⚠️ 只给 none 是**不够的**（我第一版就只给了 none）——
    // 那样用户只能关、无法开，而 M3 默认恰恰是不思考。
    // ⚠️ **顺序 = 强度序（弱 → 强）**（Issue IKLIDV）：`none`(rank 0) 在 `on`(rank 5)
    // 之前。DSH 把该数组当**展示顺序**、客户端直接 `map` 不排序 ⇒ 原写法
    // `['on','none']` 会让「开启」落在横向档位轴的最左（左强右弱）。
    expect(info?.efforts.map((e) => e.id)).toEqual(['none', 'on'])
    expect(info?.efforts.map((e) => e.name)).toEqual(['关闭思考', '开启思考'])
    // ⚠️ M3 远端没有 `default_effort` ⇒ 不设 defaultEffort ⇒ 保持服务端默认
    //（实测 = 不思考）。**不要**擅自设成 'on'，那会改变用户既有行为。
    // ⚠️ 这一条同时锁住「默认档与数组位置无关」：顺序换了，默认档仍必须是
    // **不设**（若实现改成「拿首项当默认档」，这里会冒出 `none` 而变红）。
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
    // ⚠️ 追加的两档按**强度序**（`none` 在 `on` 前，Issue IKLIDV）；
    // 远端那段 `effortOptions` **保持原序**（如实镜像上游，不重排）。
    expect(info?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'none', 'on'])
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

  /**
   * ⚠️⚠️ **地理路由不得吞掉 402 的语义**（2026-10-17 自查发现的真实缺陷）。
   *
   * 实测反例链路：`307 → 402 insufficient_balance_error`。
   *
   * 初版在 `throwCurrent` 里对 `geoRouted` **无条件**改错误码为 `SERVER`
   * ⇒ 402 的 `QUOTA_EXCEEDED` 被覆盖 ⇒ 用户看到「去填 IP / 走代理」，
   * 而**「去充值」这个唯一有效动作消失**（他会一直折腾网络）。
   *
   * 判据：**错误码**必须仍是 `QUOTA_EXCEEDED`，同时**文案**要能解释地理路由。
   */
  it('★★★ 307 → 402 时错误码仍是 QUOTA_EXCEEDED（地理路由不得覆盖余额语义）', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://agent.minimaxi.com/mavis/api/v1/llm/v1/messages' },
        })
      }
      return new Response(
        '{"type":"error","error":{"type":"insufficient_balance_error"}}',
        { status: 402 },
      )
    }) as typeof fetch
    try {
      const adapter = new MinimaxAdapter({
        credentialRef: 'MINIMAXINTL_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'a'.repeat(60), token_type: 'Bearer',
        }),
        refresh: async () => {},
        fetchRemoteModels: async () => [M31, M3, HS, M27],
        product: MINIMAX_INTL,
      })
      const error = await adapter.stream({ model: 'MiniMax-M3', messages: [] } as never)
        .next().catch((e: unknown) => e as { code?: string; message?: string })
      expect(error?.code, '402 必须仍是 QUOTA_EXCEEDED —— 否则用户不知道要去充值')
        .toBe('QUOTA_EXCEEDED')
      // 文案仍要解释地理路由（两者共存，不是互相覆盖）
      expect(error?.message).toContain('X-Forwarded-For')
      // 且必须带上真实业务错误原文
      expect(error?.message).toContain('insufficient_balance_error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  /**
   * ⚠️⚠️ **地理路由不得用 `SERVER` 码**（自查发现的真缺陷）。
   *
   * DSH 的 `dsh-llm/lib/types/retry-policy.js`：
   * `DEFAULT_RETRYABLE_CODES` 含 `'SERVER'`，`DEFAULT_MAX_RETRIES = 5`
   * ⇒ `dsh-llm-retry` 会把 `SERVER` **自动重试 5 次**（指数退避 ≈ 15s）。
   *
   * 而地理路由是**确定性失败**：出口 IP 不会因重试而变 ⇒ 每次重试都重新选号、
   * 重新 307、重新 401。用户白等，日志凭空多一串失败请求。
   *
   * ⇒ 判据：地理路由的错误码**不得**出现在 DSH 默认可重试集合里，
   * 且不得是会被文案替换的 `QUOTA` / `AUTH`。
   */
  it('★★★ 地理路由的错误码不可重试（SERVER 会被 DSH 自动重试 5 次）', async () => {
    const originalFetch = globalThis.fetch
    // 一直 307 → 中国站 → 401（确定性失败，没有 XFF 或 XFF 被忽略）
    globalThis.fetch = (async (_url: unknown, init?: { redirect?: string }) => {
      if (init?.redirect === 'manual') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://agent.minimaxi.com/mavis/api/v1/llm/v1/messages' },
        })
      }
      return new Response('{"error":"invalid access token"}', { status: 401 })
    }) as typeof fetch
    try {
      const adapter = new MinimaxAdapter({
        credentialRef: 'MINIMAXINTL_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'a'.repeat(60), token_type: 'Bearer',
        }),
        refresh: async () => {},
        fetchRemoteModels: async () => [M31, M3, HS, M27],
        product: MINIMAX_INTL,
      })
      const error = await adapter.stream({ model: 'MiniMax-M3', messages: [] } as never)
        .next().catch((e: unknown) => e as { code?: string; message?: string })

      // ★★★ DSH 默认可重试集合（retry-policy.js）：EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT
      const RETRYABLE = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
      expect(RETRYABLE, `地理路由用了可重试码 ${error?.code} ⇒ 会被自动重试 5 次`)
        .not.toContain(error?.code)
      // 也不能是被 harness 替换文案的档（会吞掉唯一指路的说明）
      expect(['QUOTA', 'AUTH']).not.toContain(error?.code)
      // 文案仍要给出两条出路
      expect(error?.message).toContain('X-Forwarded-For')
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
    // ⚠️ 2026-10-15：展示名加了「(中国版)」括注 —— 加国际站后两站并列，
    //    不带括注用户分不清哪个是国内站（与 `Qoder (中国版)` 同风格）。
    expect(adapter.providerInfo('minimax')).toEqual({ id: 'minimax', name: 'MiniMax Code (中国版)' })
    // 空串回填产品 id（照实现）
    expect(adapter.providerInfo('')).toEqual({ id: 'minimax', name: 'MiniMax Code (中国版)' })
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

// ===== 请求级账号轮换（issue IKJW32，2026-10-11）=====
//
// ## 背景（issue 原文的代码取证）
//
// 本适配器原先**全文件零命中** `updateModelRateLimit` / `getAvailableAccount`
// —— 14 家里唯一没有换号与冷却的一家。失败处理只有「直接 throw LlmError」，
// 于是首号额度耗尽就把硬失败抛给用户；`resolveCredential` 下次仍按池的手动
// 顺序取回**同一个号**（池排序不因失败而变）⇒「卡死在一个号上」。
// 用户环境实测：池里 4 个 minimax 账号中 3 个余额为 0。
//
// ## 语义表抄自 loomy / raccoon（见 `src/minimax-adapter.ts` 文件头）
//
// | 类别 | 判据 | 换号 | 写冷却 |
// |---|---|---|---|
// | `quota` | 402 / 额度文案 / `insufficient_balance_error` | ✅ | ✅ 24h |
// | `rate` | 429 / `rate_limit_error` / `overloaded_error` | ✅ | ✅ 1h |
// | `auth` | 401 / 403 / `authentication_error` | ✅ | ❌ **绝不写** |
// | `other` | 其余 4xx（400 参数错等） | ❌ | ❌ |
//
// ⚠️ 认证类「只换号、绝不写标记」是 2026-10-06「全池被封 24h」事故换来的
// 不变式，本 describe 有两条用例（全池 401 / 8 号全耗尽）专门锁它。
describe('classifyMinimaxFailure 判据（状态码 / 自报类别 / 文案三通道）', () => {
  it('★ 状态码通道：401/403 认证、402 额度、429 限流，且**状态码优先于文案**', () => {
    expect(classifyMinimaxFailure('', 401)).toBe('auth')
    expect(classifyMinimaxFailure('', 403)).toBe('auth')
    expect(classifyMinimaxFailure('', 402)).toBe('quota')
    expect(classifyMinimaxFailure('', 429)).toBe('rate')
    // ⚠️ 实测 401 的体是 `{"code":401,"message":"auth failed"}`（自家信封，不是
    //    Anthropic 形状）；网关故障常在报文里捎带余额提示 ⇒ **以状态码为准**。
    expect(classifyMinimaxFailure('{"code":401,"message":"insufficient balance"}', 401)).toBe('auth')
  })

  it('★ 自报类别通道：Anthropic `error.type`（实测 400 的错误体就是这个形状）', () => {
    expect(classifyMinimaxFailure(
      '{"type":"error","error":{"type":"insufficient_balance_error","message":"x"}}', 0,
    )).toBe('quota')
    expect(classifyMinimaxFailure('{"error":{"type":"rate_limit_error"}}', 0)).toBe('rate')
    expect(classifyMinimaxFailure('{"error":{"type":"overloaded_error"}}', 0)).toBe('rate')
    expect(classifyMinimaxFailure('{"error":{"type":"authentication_error"}}', 0)).toBe('auth')
    // ⚠️ 参数错（实测 `invalid_request_error … (2013)`）不是可换类别 —— 换号无益。
    expect(classifyMinimaxFailure('{"error":{"type":"invalid_request_error","message":"… (2013)"}}', 0))
      .toBe('other')
  })

  it('★★ 权限类文案归 auth，绝不因含 `insufficient` 被判额度（loomy / raccoon 的同款教训）', () => {
    expect(classifyMinimaxFailure('insufficient permissions to access this resource', 400)).toBe('auth')
    // ⚠️ 上下文窗口超长与「钱」无关 ⇒ other（误判会封可用账号 24h）
    expect(classifyMinimaxFailure('the context window is insufficient for this model', 400))
      .toBe('other')
    // ⚠️ 顺序判别力：额度**文案**与权限文案**共现**时必须以权限为准（否则写 24h）。
    expect(classifyMinimaxFailure('insufficient permissions; quota exceeded', 400)).toBe('auth')
  })

  it('★★ `insufficient` × `max_tokens` 不得判额度（否则每个轮换到的号各写 24h）', () => {
    /**
     * 真实形态（Anthropic Messages）：`max_tokens` / `input_tokens` /
     * `budget_tokens` 是**一等字段名**，与「钱」毫无关系。
     * 初版的钱义词表含裸 `token` ⇒ 这条 400 参数错会被判 `quota` ⇒ 整池封一天。
     */
    expect(classifyMinimaxFailure(
      '{"error":{"type":"invalid_request_error","message":"insufficient max_tokens for the requested thinking budget"}}',
      400,
    )).toBe('other')
    expect(classifyMinimaxFailure('insufficient input_tokens', 400)).toBe('other')
    // ⚠️ 反过来，「token 配额不足」这种**真额度**措辞仍要判 quota（词边界匹配）。
    expect(classifyMinimaxFailure('insufficient tokens remaining', 400)).toBe('quota')
  })

  it('★ 英文低余额文案（不含 `insufficient`）必须判 quota —— 否则换号静默失效', () => {
    expect(classifyMinimaxFailure('Your credit balance is too low to access the API', 400)).toBe('quota')
    expect(classifyMinimaxFailure('{"error":{"code":1004,"message":"balance not enough"}}', 0)).toBe('quota')
    expect(classifyMinimaxFailure('out of credits', 400)).toBe('quota')
  })

  it('★★ 自家信封的 `code` 是确定性通道（实测 401 体就是自家信封，不是 Anthropic 形状）', () => {
    // ⚠️ 这几个都是 status=0（200 + 流内错误 / 非 SSE 的 200），状态码通道全失效。
    expect(classifyMinimaxFailure('minimax: 流内错误：balance not enough（code=402）', 0)).toBe('quota')
    expect(classifyMinimaxFailure('{"code":402,"message":"balance not enough"}', 0)).toBe('quota')
    expect(classifyMinimaxFailure('{"code":429,"message":"too many requests"}', 0)).toBe('rate')
    // ⚠️ 无 message 文案、只有码：仍要能判 auth（文案腿单独锁一条，见下）。
    expect(classifyMinimaxFailure('{"code":401}', 0)).toBe('auth')
    expect(classifyMinimaxFailure('{"code":401,"message":"auth failed"}', 0)).toBe('auth')
    // ⚠️ 只认这四个码，其余码不猜。
    expect(classifyMinimaxFailure('{"code":1004,"message":"something else"}', 0)).toBe('other')
    /**
     * ⚠️ `auth failed` 是一条**纯文案腿**（报文既无码、也无 auth 类 `error.type`）——
     * 它此前**零覆盖**：删掉它没有任何用例变红（变异验证实测）。
     * 真实价值：401 报文**不带 `code` 字段**时它是唯一的 auth 线索。
     */
    expect(classifyMinimaxFailure('{"type":"error","error":{"message":"auth failed"}}', 0)).toBe('auth')
  })

  it('★ 5xx 只信确定性通道：服务端故障携带额度文案时**不得**写 24h', () => {
    expect(classifyMinimaxFailure('insufficient balance', 500)).toBe('other')
    expect(classifyMinimaxFailure('{"code":402,"message":"insufficient balance"}', 500)).toBe('quota')
    // ⚠️ `overloaded_error` 走自报类别通道 ⇒ rate（1h），不受 5xx 判据影响。
    expect(classifyMinimaxFailure('{"error":{"type":"overloaded_error"}}', 529)).toBe('rate')
  })

  it('★ 文案通道：中英文额度与限流措辞（裸 `rate limit` 不再判 rate）', () => {
    expect(classifyMinimaxFailure('余额不足，请充值', 400)).toBe('quota')
    expect(classifyMinimaxFailure('积分耗尽', 400)).toBe('quota')
    expect(classifyMinimaxFailure('insufficient quota', 400)).toBe('quota')
    expect(classifyMinimaxFailure('Too many requests', 400)).toBe('rate')
    /**
     * ⚠️ 实测形态：`400 + invalid_request_error: rate limit field invalid`
     * —— 它是**字段名**不是限流。裸 `rate limit` 判 rate 会白写 1h 冷却
     *（方向与「宁可漏判不可误伤」相反）。
     */
    expect(classifyMinimaxFailure(
      '{"error":{"type":"invalid_request_error","message":"rate limit field invalid"}}', 400,
    )).toBe('other')
  })

  it('★ 只有 quota / rate 写冷却；auth 与 other 都不写', () => {
    expect(recordsMinimaxRateLimit('quota')).toBe(true)
    expect(recordsMinimaxRateLimit('rate')).toBe(true)
    expect(recordsMinimaxRateLimit('auth')).toBe(false)
    expect(recordsMinimaxRateLimit('other')).toBe(false)
    // ⚠️ 入参是**已判定的类别**（不是原文 + 状态码）：同一个判据只能有一处实现。
    expect(shouldRotateMinimaxAccount('auth')).toBe(true)
    expect(shouldRotateMinimaxAccount('quota')).toBe(true)
    expect(shouldRotateMinimaxAccount('rate')).toBe(true)
    expect(shouldRotateMinimaxAccount('other')).toBe(false)
  })
})

describe('MinimaxAdapter 请求级账号轮换（余额耗尽无感切号）', () => {
  const CRED_A: MinimaxCredential = { access_token: 'tok-A', token_type: 'Bearer' }
  const CRED_B: MinimaxCredential = { access_token: 'tok-B', token_type: 'Bearer' }

  interface StubAccount {
    id: string
    cred: MinimaxCredential
  }

  function makePoolStub(accounts: StubAccount[] = [
    { id: 'minimax-A', cred: CRED_A },
    { id: 'minimax-B', cred: CRED_B },
  ]) {
    const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const picks: Array<{ model: string; exclude: ReadonlySet<string> | undefined }> = []
    const pool = {
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marks.push({ accountId, modelId, resetAtMs })
      },
      getAvailableAccount: async (_provider: string, model: string, exclude?: ReadonlySet<string>) => {
        // ⚠️ **存快照**而不是活引用：`tried` 在循环里持续增长，存引用时断言读到的
        // 是「全部结束后」的集合，证明不了**调用当时**排除了谁。
        picks.push({ model, exclude: exclude === undefined ? undefined : new Set(exclude) })
        for (const account of accounts) {
          if (exclude?.has(account.id) === true) continue
          return { entry: { id: account.id }, credential: account.cred }
        }
        return null
      },
      findAccountIdByCredential: async (_provider: string, identity: string) =>
        accounts.find((account) => account.cred.access_token === identity)?.id ?? '',
    }
    return { pool, marks, picks }
  }

  const sseOk = (): Response => new Response([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"从二号账号返回"}}',
    '',
    'data: {"type":"content_block_stop","index":0}',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })

  /** 402 + Anthropic 额度错误体（`insufficient_balance_error`）。 */
  const quotaResponse = (who: string): Response => new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'insufficient_balance_error', message: `insufficient balance (${who})` },
    }),
    { status: 402 },
  )

  /**
   * HTTP **200** + 流内错误帧（MiniMax 系「200 + 业务码」的既有习惯）。
   *
   * ⚠️ `message` 用 `request rejected` —— 它**不含**任何额度/限流措辞，也**不是**
   * `MINIMAX_QUOTA_PHRASES` 里的短语：于是只有 `error.type`
   *（`insufficient_balance_error`）这一条通道能把它判成 `quota`。
   * 这样就同时锁住两件事：① `minimax-messages.ts` 必须把 `error.type` 带进文案；
   * ② 适配器的自报类别通道真的接上了。
   *（早先这里用 `balance not enough`，在加了英文短语通道之后**失去判别力** ——
   *  变异验证实测：把 `kind` 置空后该用例仍绿。）
   */
  const sseQuotaError = (): Response => new Response([
    'event: error',
    'data: {"type":"error","error":{"type":"insufficient_balance_error","message":"request rejected"}}',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })

  /** HTTP 200 + **自家信封**流内错误（只有业务码，没有任何文案线索）。 */
  const sseEnvelopeQuota = (): Response => new Response([
    'event: error',
    'data: {"code":402,"message":"request rejected"}',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })

  function makeRotateAdapter(options: {
    resolveCredential: () => Promise<MinimaxCredential | undefined>
    accountPool?: unknown
    refresh?: () => Promise<void>
  }): MinimaxAdapter {
    return new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: options.resolveCredential,
      refresh: options.refresh ?? (async () => {}),
      fetchRemoteModels: async () => [M31, M3, HS, M27],
      ...options.accountPool === undefined ? {} : { accountPool: options.accountPool as never },
      product: MINIMAX,
    })
  }

  /** 临时替换全局 fetch（本适配器**没有** `fetchImpl` 选项，与既有用例同款）。 */
  async function withFetch<T>(impl: typeof fetch, body: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = impl
    try {
      return await body()
    } finally {
      globalThis.fetch = original
    }
  }

  const request = { model: 'MiniMax-M3', messages: [] }

  /** 收集全部 chunk；抛错时返回错误对象（用例自行断言）。 */
  async function collect(adapter: MinimaxAdapter): Promise<{ chunks: unknown[]; error: unknown }> {
    const chunks: unknown[] = []
    try {
      for await (const chunk of adapter.stream(request as never)) chunks.push(chunk)
      return { chunks, error: null }
    } catch (error) {
      return { chunks, error }
    }
  }

  const textDelta = (chunks: unknown[]): boolean =>
    chunks.some((chunk) => (chunk as { type?: string }).type === 'text-delta')

  it('★ 一号额度耗尽（402 insufficient_balance_error）→ 标记该模型 + 切二号重发成功', async () => {
    const { pool, marks, picks } = makePoolStub()
    const seenAuth: string[] = []
    let call = 0
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      seenAuth.push(String(new Headers(init?.headers).get('Authorization') ?? ''))
      return call === 1 ? quotaResponse('A') : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks } = await withFetch(fetcher, () => collect(adapter))

    // ⚠️ 判别力在**第二发的 Authorization**：换号若不生效会是 tok-A。
    expect(seenAuth[0]).toContain('tok-A')
    expect(seenAuth[1]).toContain('tok-B')
    expect(textDelta(chunks)).toBe(true)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('minimax-A')
    // ⚠️ 限流是**按模型**记的：modelId 传空串会让池的模型级过滤失效。
    expect(marks[0]?.modelId).toBe('MiniMax-M3')
    expect(picks[0]?.model).toBe('MiniMax-M3')
    expect(picks[0]?.exclude?.has('minimax-A')).toBe(true)
    // 额度类是 24h 档（不是 1h、更不是「现在」）
    expect((marks[0]?.resetAtMs ?? 0) - Date.now()).toBeGreaterThan(23 * 3_600_000)
  })

  it('★ 两号都耗尽 → 报「所有账号均不可用」并带**最后一次**的真实原因', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '')
      return quotaResponse(auth.includes('tok-B') ? 'B-真实原因' : 'A')
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { error } = await withFetch(fetcher, () => collect(adapter))

    expect((error as Error).message).toContain('所有账号')
    // ⚠️ 笼统的「均不可用」会丢掉服务端真正说的东西（buddy 的同款教训）
    expect((error as Error).message).toContain('B-真实原因')
    expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(marks.map((mark) => mark.accountId)).toEqual(['minimax-A', 'minimax-B'])
  })

  it('非额度类 4xx（400 参数错）不换号，按原错误抛出', async () => {
    const { pool, picks } = makePoolStub()
    const fetcher = (async () => new Response(
      '{"type":"error","error":{"type":"invalid_request_error","message":"param is invalid (2013)"}}',
      { status: 400 },
    )) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { error } = await withFetch(fetcher, () => collect(adapter))

    expect((error as Error).message).toContain('2013')
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
    // 换号一次都没发生（`findAccountIdByCredential` 是记账键反查，不进 picks）。
    expect(picks).toHaveLength(0)
  })

  it('★ 401 授权失败：先续期一次、再换号，且**绝不写冷却标记**', async () => {
    const { pool, marks, picks } = makePoolStub()
    let refreshCalls = 0
    const seenAuth: string[] = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '')
      seenAuth.push(auth)
      // A 恒 401（网关侧授权故障），B 正常
      return auth.includes('tok-A')
        ? new Response('{"code":401,"message":"auth failed"}', { status: 401 })
        : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({
      resolveCredential: async () => CRED_A,
      accountPool: pool,
      refresh: async () => { refreshCalls += 1 },
    })
    const { chunks } = await withFetch(fetcher, () => collect(adapter))

    expect(refreshCalls).toBe(1)
    // A(401) → 续期一次后仍拿 A 重发(401) → 换到 B
    expect(seenAuth.map((auth) => auth.includes('tok-B'))).toEqual([false, false, true])
    expect(textDelta(chunks)).toBe(true)
    // ⚠️⚠️ 认证类**绝不写标记**：写了会把网关侧的授权故障放大成「全池封 24h」。
    expect(marks).toHaveLength(0)
    expect(picks[0]?.exclude?.has('minimax-A')).toBe(true)
  })

  it('★★ 401 打遍全池：不留任何标记（池保持可用）', async () => {
    const { pool, marks, picks } = makePoolStub()
    const fetcher = (async () =>
      new Response('{"code":401,"message":"auth failed"}', { status: 401 })) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { error } = await withFetch(fetcher, () => collect(adapter))

    expect((error as Error).message).toContain('所有账号')
    expect(error).toMatchObject({ code: 'AUTH' })
    expect(marks).toHaveLength(0)
    // A →（续期后仍是 A）→ B →（池已无候选）。⚠️ 第二次取号返回 null 也要算一次
    // 「问过池」——断言长度 2 才能同时锁住「B 被真的试过」与「不会拿回同一个号」。
    expect(picks).toHaveLength(2)
    expect(picks[0]?.exclude?.has('minimax-A')).toBe(true)
    expect(picks[1]?.exclude?.has('minimax-A')).toBe(true)
    expect(picks[1]?.exclude?.has('minimax-B')).toBe(true)
  })

  it('★★ 8 账号全耗尽（轮换预算恰好用尽）→ 8 个号全部被标记，末号不漏', async () => {
    const accounts: StubAccount[] = Array.from({ length: 8 }, (_, index) => ({
      id: `minimax-${index + 1}`,
      cred: { access_token: `tok-${index + 1}`, token_type: 'Bearer' },
    }))
    const { pool, marks } = makePoolStub(accounts)
    const fetcher = (async () => quotaResponse('all')) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => accounts[0]!.cred, accountPool: pool })
    const { error } = await withFetch(fetcher, () => collect(adapter))

    expect((error as Error).message).toContain('所有账号')
    // ⚠️ 记账必须**每次失败后立刻**做：挪到循环开头会让末号永远漏记，
    //    下次请求又选中它 —— 正是本 issue 要修的「卡死在一个号上」。
    expect(marks.map((mark) => mark.accountId)).toEqual(accounts.map((account) => account.id))
  })

  it('★★ 401 续期后凭据换成了另一个账号 → 冷却标记记在**真正耗尽的那个号**上', async () => {
    const { pool, marks } = makePoolStub()
    let resolveCalls = 0
    // 复刻生产语义：首次取号 = A；`refresh()`（`src/index.ts`）续的是池内**第一个
    // 可用账号**，续期后 `resolveCredential` 可能返回**另一个账号** B 的凭据。
    const resolveCredential = async (): Promise<MinimaxCredential> => {
      resolveCalls += 1
      return resolveCalls === 1 ? CRED_A : CRED_B
    }
    let sent = 0
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent += 1
      if (sent === 1) return new Response('{"code":401,"message":"auth failed"}', { status: 401 })
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '')
      return quotaResponse(auth.includes('tok-B') ? 'B' : 'A')
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential, accountPool: pool })
    await withFetch(fetcher, () => collect(adapter))

    // ⚠️ 若不重新反查账号 id，第一条标记会落在「只是授权失败」的 A 上，
    //    而真正额度耗尽的 B 逍遥法外（loomy / raccoon 的 `51ded6a` 同款缺陷）。
    expect(marks[0]?.accountId).toBe('minimax-B')
  })

  it('★ HTTP 200 + 流内额度错误帧（零输出）同样换号（MiniMax 系「200 + 业务码」习惯）', async () => {
    const { pool, marks } = makePoolStub()
    let call = 0
    const fetcher = (async () => {
      call += 1
      return call === 1 ? sseQuotaError() : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks } = await withFetch(fetcher, () => collect(adapter))

    expect(call).toBe(2)
    expect(textDelta(chunks)).toBe(true)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('minimax-A')
  })

  it('★ 已产出内容后的流内错误**不换号重发**（否则用户看到重复内容）', async () => {
    const { pool, picks } = makePoolStub()
    let call = 0
    const fetcher = (async () => {
      call += 1
      return new Response([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"前半段"}}',
        '',
        'event: error',
        'data: {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance"}}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks, error } = await withFetch(fetcher, () => collect(adapter))

    expect(call).toBe(1)               // 不重发
    expect(picks).toHaveLength(0)      // 不换号
    expect(textDelta(chunks)).toBe(true)  // 已产出的内容照常交给 harness
    expect((error as Error).message).toContain('流内错误')
  })

  it('★★ 已产出内容后失败**仍要记账**（否则该号永不被冷却，下次又选中它）', async () => {
    const { pool, marks, picks } = makePoolStub()
    const fetcher = (async () => new Response([
      // ⚠️ 只有 `content_block_start`（没有任何 text-delta）：`yieldedAny` 仍是真，
      //    故不能重发 —— 但该账号已明确额度耗尽，**必须**写冷却。
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: error',
      'data: {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance"}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { error } = await withFetch(fetcher, () => collect(adapter))

    expect((error as Error).message).toContain('流内错误')
    expect(picks).toHaveLength(0)      // 不换号（不能重发）
    expect(marks).toHaveLength(1)      // ←★ 但冷却必须写上
    expect(marks[0]?.accountId).toBe('minimax-A')
    expect(marks[0]?.modelId).toBe('MiniMax-M3')
  })

  it('★★ 429 走 **1 小时**档（rate），不是 24 小时档（quota）', async () => {
    // ⚠️ 语义表里 `rate` 与 `quota` 的冷却时长不同，但此前的行为用例**只跑过 402**
    //    ⇒ 把 rate 分支的常量换成 quota 的（429 也记 24h）不会有任何用例变红。
    const { pool, marks, picks } = makePoolStub()
    let call = 0
    const fetcher = (async () => {
      call += 1
      return call === 1
        ? new Response('{"type":"error","error":{"type":"rate_limit_error","message":"too many requests"}}', {
            status: 429,
            headers: { 'content-type': 'application/json' },
          })
        : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks } = await withFetch(fetcher, () => collect(adapter))

    expect(call).toBe(2)
    expect(textDelta(chunks)).toBe(true)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('minimax-A')
    const remaining = (marks[0]?.resetAtMs ?? 0) - Date.now()
    expect(remaining).toBeGreaterThan(50 * 60_000)      // ≈1h
    expect(remaining).toBeLessThan(2 * 3_600_000)
    expect(picks[0]?.exclude?.has('minimax-A')).toBe(true)
  })

  it('★★ 池内第 2 个号凭据损坏（`{}`）时**不掐断轮换**，仍能轮到第 3 个号', async () => {
    /**
     * ⚠️ `AccountPool.getAvailableAccount` 对凭据只做裸 `JSON.parse`、**零形状校验**
     *（该文件把「手工编辑过的备份」列为可达输入）。初版写
     * `nextCredential.access_token.length` + `break` ⇒ 抛 `TypeError`（非 LlmError）
     * 并**放弃整池**，后面的好号永远轮不到。⇒ 坏号跳过（`continue`）。
     */
    const broken = { access_token: undefined } as unknown as MinimaxCredential
    const accounts: StubAccount[] = [
      { id: 'minimax-A', cred: CRED_A },
      { id: 'minimax-BROKEN', cred: broken },
      { id: 'minimax-C', cred: { access_token: 'tok-C', token_type: 'Bearer' } as MinimaxCredential },
    ]
    const { pool, marks } = makePoolStub(accounts)
    const seenAuth: string[] = []
    let call = 0
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      seenAuth.push(String(new Headers(init?.headers).get('Authorization') ?? ''))
      return call === 1 ? quotaResponse('A') : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks, error } = await withFetch(fetcher, () => collect(adapter))

    expect(error).toBeNull()                            // 不再抛 TypeError
    expect(seenAuth[1]).toContain('tok-C')              // 坏号被跳过，直接轮到 C
    expect(textDelta(chunks)).toBe(true)
    expect(marks.map((mark) => mark.accountId)).toEqual(['minimax-A'])
  })

  it('★ HTTP 200 + `application/json` 自家信封（额度）同样换号（不是「未返回任何内容块」）', async () => {
    /**
     * ⚠️ MiniMax 系有「HTTP 200 + 业务码」的既有习惯（签到 / `timezone_id` 都是 200）。
     * 这种响应**一个 SSE 帧都没有**，若只交给 `consumeMinimaxSse`，只会得到
     * 「模型未返回任何内容块」⇒ 额度信息整段丢失 ⇒ 判 other ⇒ 不换号。
     */
    const { pool, marks } = makePoolStub()
    let call = 0
    const fetcher = (async () => {
      call += 1
      return call === 1
        ? new Response('{"code":402,"message":"balance not enough"}', {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks } = await withFetch(fetcher, () => collect(adapter))

    expect(call).toBe(2)
    expect(textDelta(chunks)).toBe(true)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('minimax-A')
  })

  it('★ content-type 缺失但实为 SSE 的 200 不得被当成错误体（否则正常回答整轮失败）', async () => {
    const { pool } = makePoolStub()
    const fetcher = (async () => new Response([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"正常回答"}}',
      '',
    // ⚠️ 刻意**不带** content-type：`new Response(string)` 会给出 `text/plain`，
    //    网关也可能这么转发。判据必须只认「明确非流式」（json / html）。
    ].join('\n'), { status: 200 })) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks, error } = await withFetch(fetcher, () => collect(adapter))

    expect(error).toBeNull()
    expect(textDelta(chunks)).toBe(true)
  })

  it('★ 401 报文**无任何可判线索**时仍判 auth（锁住状态码腿，不靠文案/码腿）', async () => {
    /**
     * ⚠️ 报文刻意是 `{}`：**没有** auth 文案、**没有** `code` 字段
     *（早先这里用 `{"code":401}` —— 那会被**自家信封码腿**判 auth，
     * 于是删掉状态码腿它照样绿，用例名不副实；变异验证实测出来了）。
     */
    const { pool, marks, picks } = makePoolStub()
    const seenAuth: string[] = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '')
      seenAuth.push(auth)
      return auth.includes('tok-A')
        ? new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
        : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks } = await withFetch(fetcher, () => collect(adapter))

    // A(401) → 续期后仍拿 A 重发(401) → 换到 B
    expect(seenAuth.map((auth) => auth.includes('tok-B'))).toEqual([false, false, true])
    expect(textDelta(chunks)).toBe(true)
    expect(marks).toHaveLength(0)      // ⚠️ 认证类绝不写冷却
    expect(picks[0]?.exclude?.has('minimax-A')).toBe(true)
  })

  it('★ SSE 自家信封（只有 `code`，无文案线索）同样换号', async () => {
    // ⚠️ 锁的是 `minimax-messages.ts` 真的把 `code=` 带进了错误文案：
    //    置空后这条帧只剩「未知错误」⇒ 判 other ⇒ 不换号。
    const { pool, marks } = makePoolStub()
    let call = 0
    const fetcher = (async () => {
      call += 1
      return call === 1 ? sseEnvelopeQuota() : sseOk()
    }) as typeof fetch

    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A, accountPool: pool })
    const { chunks } = await withFetch(fetcher, () => collect(adapter))

    expect(call).toBe(2)
    expect(textDelta(chunks)).toBe(true)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('minimax-A')
  })

  it('★ 200 + `application/json` 且不可换号时：错误形状是「非 SSE 响应」而不是「未返回任何内容块」', async () => {
    /**
     * ⚠️ 锁 `isDefinitelyNotSse` 的**正腿**（json / html）：把它改成 `return false`
     * 后，JSON 体会被当 SSE 消费、零帧，错误退化成 `consumeMinimaxSse` 的
     * 「模型未返回任何内容块」—— 换号结果碰巧相同（原文样本兜住了分类），
     * 但**用户看到的错误形状与错误码变了**，此前无人锁。
     */
    const fetcher = (async () => new Response('{"code":402,"message":"request rejected"}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })) as typeof fetch

    // ⚠️ 不给账号池 ⇒ 不换号，直接抛。
    const adapter = makeRotateAdapter({ resolveCredential: async () => CRED_A })
    const { error } = await withFetch(fetcher, () => collect(adapter))

    expect((error as Error).message).toContain('非 SSE 响应')
    expect((error as Error).message).toContain('request rejected')
    /**
     * ⚠️ 这条断言原先写的是 `code: 'SERVER'` —— 它只是**顺带记录当时的实现**，
     * 不是本用例要守的东西（本用例的判据是上面那两条 message 断言：错误形状）。
     *
     * 2026-10-17 审计发现 `SERVER` 在 DSH 侧**可重试**
     *（`DEFAULT_RETRYABLE_CODES` 含 `'SERVER'`，`maxRetries=5`），
     * 而「网关给了非 SSE 的 200」是**确定性失败** ⇒ 已改为 `INVALID_REQUEST`。
     * 故这里同步更新为「**不在**可重试集合里」，把它变成一条**有意义的守卫**。
     */
    const RETRYABLE = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
    expect(RETRYABLE, '非 SSE 是确定性失败，用可重试码会被自动重试 5 次')
      .not.toContain((error as { code?: string }).code)
  })
})
