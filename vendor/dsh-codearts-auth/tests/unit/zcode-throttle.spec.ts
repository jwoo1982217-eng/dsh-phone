/**
 * ZCode 的**限流分流**与**额度切号**单测（吸收自 `dsh-free-glm`，2026-09-30）。
 *
 * ## 本文件锁住三件事
 *
 * 1. **两种 429 必须分开**：`3009` 并发限流（退避重试）vs `1005`/`1113`
 *    额度用尽（换账号）。混为一谈的两个方向都是真实缺陷：
 *    - 把额度错误当限流 ⇒ 确定性错误被白重试（qoder 那边记过：`SERVER` 在
 *      harness 的可重试集合里，白退避 5 次约 15.5 秒）；
 *    - 把限流当额度 ⇒ **误标一个完全可用的账号**（当日用不了）。
 * 2. **需要 captcha 时，重试前必须重新 mint**（一次性，沿用旧的必 `3007`）。
 *    ⚠ 2026-10-01 起 mint 是**条件式**的（先探后取，见
 *    `tests/unit/zcode-captcha-lazy.spec.ts`），故这条用例先注入需求记忆，
 *    让两轮都落在「需要」那一侧 —— 规则本身没变。
 * 3. **秒回空 = 无权益 ⇒ 换账号**；而**慢回空**是链路故障，不换号。
 *
 * ## 反向验证（别写成同义反复）
 *
 * - 把 `isZcodeQuotaExhausted` 开头的「先排除并发限流」那行删掉 ⇒
 *   第 2 条纯函数用例变红（3009 会被判成额度错误）。
 * - 把内层循环里的 `mintCaptcha` 提到循环外 ⇒ 第 1 条行为用例变红
 *   （mint 只调 1 次）。
 * - 去掉 `emitted` 闸 ⇒ 第 5 条行为用例变红（已产出内容后仍去切号）。
 */
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import {
  ZCODE_FAST_EMPTY_MS,
  ZcodeAdapter,
  isFastEntitlementMiss,
  isZcodeConcurrencyLimited,
  isZcodeQuotaExhausted,
  withToolCacheBreakpoint,
  zcodeConcurrencyRetryDelayMs,
  zcodeEntitlementErrorMessage,
} from '../../src/zcode-adapter.js'
import {
  captchaRequirementKey,
  clearCaptchaRequirement,
  noteCaptchaRequired,
} from '../../src/captcha-requirement.js'
import { ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'

/* ────────────────────────── 桩 ────────────────────────── */

/** 一个能正常结束的 Anthropic SSE 响应。 */
function okSse(): Response {
  const text = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 200 但**一个内容块都没有**（「秒回空」的形态 —— 上游立刻回了个空 message）。 */
function emptySse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 先吐一点内容、随后**链路报错**（用于验证「已产出内容后不再切号」）。 */
function halfSse(): Response {
  const head = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}',
    '',
  ].join('\n\n')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(head))
        setTimeout(() => controller.error(new Error('upstream boom')), 0)
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 上游业务错误（HTTP 状态 + 业务码正文）。 */
function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface StubPoolCall {
  accountId: string
  modelId: string
  resetAtMs: number
}

/** 账号池桩：记录标记与「取号时传进来的 tried」。 */
function stubPool(options: {
  next?: { id: string; credential: Record<string, unknown> } | null
  marks?: StubPoolCall[]
  triedSeen?: Array<ReadonlySet<string>>
}): unknown {
  return {
    updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
      options.marks?.push({ accountId, modelId, resetAtMs })
    },
    getAvailableAccount: async (_provider: string, _modelId: string, tried?: ReadonlySet<string>) => {
      if (tried !== undefined) options.triedSeen?.push(tried)
      const next = options.next ?? null
      if (next === null || next === undefined) return null
      return { entry: { id: next.id }, credential: next.credential }
    },
  }
}

/** 构造适配器；记录每次请求的 Authorization 与请求体。 */
function makeAdapter(options: {
  fetchImpl: (call: number, init: RequestInit) => Promise<Response>
  pool?: unknown
  currentAccountId?: () => string | undefined
  extra?: Record<string, unknown>
}): { adapter: ZcodeAdapter; calls: () => number; auths: string[]; bodies: string[] } {
  let call = 0
  const auths: string[] = []
  const bodies: string[] = []
  const adapter = new ZcodeAdapter({
    credentialRef: 'R' as never,
    resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A' }),
    refresh: async () => {},
    mintCaptcha: async () => `param-${Date.now()}`,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      call += 1
      const headers = (init.headers ?? {}) as Record<string, string>
      auths.push(headers['Authorization'] ?? '')
      bodies.push(typeof init.body === 'string' ? init.body : '')
      return await options.fetchImpl(call, init)
    }) as never,
    // 闸门与退避都注入「不真等」的实现 —— 用例必须毫秒级完成。
    gate: new ModelGate({ sleep: async () => {} }),
    sleep: async () => {},
    product: ZCODE,
    ...(options.pool === undefined ? {} : { accountPool: options.pool as never }),
    ...(options.currentAccountId === undefined
      ? {}
      : { currentAccountId: options.currentAccountId }),
    ...options.extra,
  })
  return { adapter, calls: () => call, auths, bodies }
}

/** 一轮最小可用的 `stream()` 参数。 */
function streamOptions(): never {
  return {
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hi' }],
  } as never
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of iterable) out.push(item)
  return out
}

/* ────────────────────── 一、判据纯函数 ────────────────────── */

describe('ZCode 限流判据（两种 429 必须分开）', () => {
  it('并发限流：429 + code 3009 才算', () => {
    expect(isZcodeConcurrencyLimited(429, '{"code":3009,"msg":"model concurrency limit exceeded"}'))
      .toBe(true)
    expect(isZcodeConcurrencyLimited(429, '{"code":1005,"msg":"exceed quota limit"}')).toBe(false)
    expect(isZcodeConcurrencyLimited(500, 'boom')).toBe(false)
    // 正文里带 3009 但状态码不是 429（网关用别的码包裹）也要认。
    expect(isZcodeConcurrencyLimited(403, '{"code":3009}')).toBe(true)
  })

  it('★ 额度用尽：1005/1113/文案兜底 都算，但 **3009 必须排除**', () => {
    expect(isZcodeQuotaExhausted(429, '{"code":1005,"msg":"exceed quota limit"}')).toBe(true)
    expect(isZcodeQuotaExhausted(429, '{"code":1113,"message":"[1113][余额不足或无可用资源包]"}'))
      .toBe(true)
    expect(isZcodeQuotaExhausted(429, '{"msg":"exceed quota limit"}')).toBe(true)

    /**
     * ★ 这条是**误伤防线**：并发限流同样是 429，若被判成额度用尽，
     * 就会把一个完全可用的账号标记成「当日用尽」。
     */
    expect(isZcodeQuotaExhausted(429, '{"code":3009,"msg":"model concurrency limit exceeded"}'))
      .toBe(false)
  })

  it('并发限流退避：线性递增，非法 base 回落 1500ms', () => {
    expect(zcodeConcurrencyRetryDelayMs(0, 1_500)).toBe(1_500)
    expect(zcodeConcurrencyRetryDelayMs(1, 1_500)).toBe(3_000)
    expect(zcodeConcurrencyRetryDelayMs(0, 0)).toBe(1_500)
    expect(zcodeConcurrencyRetryDelayMs(-3, 1_500)).toBe(1_500)
  })

  it('★ tools 缓存断点只打最后一个（前缀式缓存 ⇒ 一个点覆盖 system + 全部 tools）', () => {
    const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    const marked = withToolCacheBreakpoint(tools) as Array<Record<string, unknown>>
    expect(marked).toHaveLength(3)
    expect(marked[0]?.['cache_control']).toBeUndefined()
    expect(marked[1]?.['cache_control']).toBeUndefined()
    expect(marked[2]?.['cache_control']).toEqual({ type: 'ephemeral' })
    // 不修改入参（纯函数）。
    expect((tools[2] as Record<string, unknown>)['cache_control']).toBeUndefined()
    expect(withToolCacheBreakpoint([])).toEqual([])
  })

  it('秒回空 = 无权益；慢回空 = 链路故障（两者判据必须分开）', () => {
    const empty = new LlmError('no content', EMPTY_RESPONSE_CODE)
    expect(isFastEntitlementMiss(empty, 200)).toBe(true)
    expect(isFastEntitlementMiss(empty, ZCODE_FAST_EMPTY_MS - 1)).toBe(true)
    expect(isFastEntitlementMiss(empty, ZCODE_FAST_EMPTY_MS)).toBe(false)
    expect(isFastEntitlementMiss(empty, 180_000)).toBe(false)
    // 非 EMPTY_RESPONSE 的错误（如 TIMEOUT）一律不算无权益。
    expect(isFastEntitlementMiss(new LlmError('timeout', 'TIMEOUT'), 100)).toBe(false)
    expect(isFastEntitlementMiss(new Error('boom'), 100)).toBe(false)
  })
})

/* ────────────────── 二、适配器行为（重试与切号） ────────────────── */

describe('ZCode 并发限流重试（3009）', () => {
  it('★ 429+3009 → 退避重试，且**需要 captcha 时每轮都换新 param**', async () => {
    let minted = 0
    let inner = 0
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A' }),
      refresh: async () => {},
      mintCaptcha: async () => {
        minted += 1
        return `param-${minted}`
      },
      fetchImpl: (async () => {
        inner += 1
        return inner === 1
          ? errorResponse(429, { code: 3009, msg: 'model concurrency limit exceeded' })
          : okSse()
      }) as never,
      sleep: async () => {},
      gate: new ModelGate({ sleep: async () => {} }),
      product: ZCODE,
    })

    /**
     * ★ 前提：**本任务把「每请求必 mint」改成了「先探后取」**（见
     * `src/captcha-requirement.ts` 与 `zcode-adapter.ts` 内层循环）。这条用例测的
     * 规则是「**重试不许复用 param**」，它只在「上游要验证」时才有意义 ⇒ 先注入
     * 一条需求记忆，让两轮都落在「需要」一侧。
     *
     * ⚠ 这条用例**没有**因此变弱（`minted` 仍精确等于 2、`inner` 仍等于 2）；
     * 「未建记忆时先探、3009 那轮白 mint 才是错」这一侧由
     * `tests/unit/zcode-captcha-lazy.spec.ts` 的行为段覆盖，两条合起来才是完整规则。
     *
     * ⚠ 键里的账号是 `undefined`（本用例没有 `currentAccountId`），
     * `captchaRequirementKey` 把它归一成 `-`；记忆是**进程级**的 ⇒ 用完必须清，
     * 否则会把同文件后面的用例也拖成「需要 captcha」。
     */
    const requirementKey = captchaRequirementKey(undefined, 'GLM-5.3-Flash')
    noteCaptchaRequired(requirementKey, Date.now())
    let chunks: unknown[]
    try {
      chunks = await drain(adapter.stream(streamOptions()))
    } finally {
      clearCaptchaRequirement(requirementKey)
    }
    expect(chunks.length).toBeGreaterThan(0)
    expect(inner).toBe(2)
    // ★ 关键：重试必须**重新 mint**（captcha 一次性，沿用旧的必 3007）。
    expect(minted).toBe(2)
  })

  it('3009 重试到上限后如实抛出（不无限重试）', async () => {
    let inner = 0
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A' }),
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => {
        inner += 1
        return errorResponse(429, { code: 3009 })
      }) as never,
      sleep: async () => {},
      gate: new ModelGate({ sleep: async () => {} }),
      product: ZCODE,
    })

    await expect(drain(adapter.stream(streamOptions()))).rejects.toThrow(/concurrency|并发|limit/i)
    // 首次 + 2 次重试 = 3（`ZCODE.concurrencyRetryMax === 2`）。
    expect(inner).toBe(ZCODE.concurrencyRetryMax + 1)
  })
})

describe('ZCode 额度用尽 → 标记并切号（1005/1113）', () => {
  it('★ 429+1005 → 标记「该账号 + 该模型」到 UTC+8 当日 24:00，并换下一个账号重发', async () => {
    const marks: StubPoolCall[] = []
    const triedSeen: Array<ReadonlySet<string>> = []
    const pool = stubPool({
      next: { id: 'acct-B', credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } },
      marks,
      triedSeen,
    })
    const { adapter, calls, auths } = makeAdapter({
      pool,
      currentAccountId: () => 'acct-A',
      fetchImpl: async (call) =>
        call === 1 ? errorResponse(429, { code: 1005, msg: 'exceed quota limit' }) : okSse(),
    })

    const chunks = await drain(adapter.stream(streamOptions()))
    expect(chunks.length).toBeGreaterThan(0)
    expect(calls()).toBe(2)

    // ① 标记的是**失败的那个账号 + 该模型**。
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('acct-A')
    expect(marks[0]?.modelId).toBe('GLM-5.3-Flash')
    // 重置时间落在「未来 24 小时内」（UTC+8 日界）。
    const resetIn = (marks[0]?.resetAtMs ?? 0) - Date.now()
    expect(resetIn).toBeGreaterThan(0)
    expect(resetIn).toBeLessThanOrEqual(86_400_000)

    // ② 第二次请求用的是**新账号的凭据**。
    expect(auths[0]).toContain('jwt-A')
    expect(auths[1]).toContain('jwt-B')

    // ③ ★ 取号时必须把 `tried` 传下去（否则池会把刚失败的账号又给回来）。
    expect(triedSeen.length).toBeGreaterThan(0)
    expect(triedSeen[0]?.has('acct-A')).toBe(true)
  })

  it('★ 没有账号可切 → 抛 QUOTA_EXCEEDED（不可重试，不白退避 15 秒）', async () => {
    const marks: StubPoolCall[] = []
    const pool = stubPool({ next: null, marks })
    const { adapter, calls } = makeAdapter({
      pool,
      currentAccountId: () => 'acct-A',
      fetchImpl: async () => errorResponse(429, { code: 1005, msg: 'exceed quota limit' }),
    })

    await expect(drain(adapter.stream(streamOptions()))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    })
    expect(calls()).toBe(1)
    expect(marks).toHaveLength(1) // 仍要标记，避免下次又选中它
  })

  it('★ 并发限流**不**切号也不标记（换谁都一样撞，标了就是误伤）', async () => {
    const marks: StubPoolCall[] = []
    const pool = stubPool({
      next: { id: 'acct-B', credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } },
      marks,
    })
    let inner = 0
    const { adapter } = makeAdapter({
      pool,
      currentAccountId: () => 'acct-A',
      fetchImpl: async () => {
        inner += 1
        return inner === 1 ? errorResponse(429, { code: 3009 }) : okSse()
      },
    })

    await drain(adapter.stream(streamOptions()))
    expect(marks).toHaveLength(0)
  })

  it('★ 秒回空（200 + 无内容 + <3s）→ 视为无权益并切号', async () => {
    const marks: StubPoolCall[] = []
    const pool = stubPool({
      next: { id: 'acct-B', credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } },
      marks,
    })
    const { adapter, calls, auths } = makeAdapter({
      pool,
      currentAccountId: () => 'acct-A',
      fetchImpl: async (call) => (call === 1 ? emptySse() : okSse()),
    })

    const chunks = await drain(adapter.stream(streamOptions()))
    expect(chunks.length).toBeGreaterThan(0)
    expect(calls()).toBe(2)
    expect(auths[1]).toContain('jwt-B')
    expect(marks).toHaveLength(1)
  })

  it('★ 已产出内容后再出错**不得**切号（否则用户看到两份输出）', async () => {
    const marks: StubPoolCall[] = []
    const pool = stubPool({
      next: { id: 'acct-B', credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } },
      marks,
    })
    const { adapter, calls } = makeAdapter({
      pool,
      currentAccountId: () => 'acct-A',
      fetchImpl: async () => halfSse(),
    })

    await expect(drain(adapter.stream(streamOptions()))).rejects.toThrow(/boom/)
    expect(calls()).toBe(1)
    expect(marks).toHaveLength(0)
  })

  it('★ tools 的缓存断点真的进了请求体（每步省下工具 schema 的 prefill）', async () => {
    const { adapter, bodies } = makeAdapter({
      fetchImpl: async () => okSse(),
    })

    await drain(adapter.stream({
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
        { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } },
      ],
    } as never))

    const sent = JSON.parse(bodies[0] ?? '{}') as {
      tools?: Array<Record<string, unknown>>
    }
    expect(sent.tools).toHaveLength(2)
    expect(sent.tools?.[0]?.['cache_control']).toBeUndefined()
    expect(sent.tools?.[1]?.['cache_control']).toEqual({ type: 'ephemeral' })
  })
})

/**
 * 额度用尽时的**错误文案与错误码**（用户报障，2026-10-01）。
 *
 * ## 用户看到的原文
 *
 * > 本轮运行失败　`zcode: 模型返回了空响应（无任何 text / thinking / tool 内容）`
 * > `EMPTY_RESPONSE`
 *
 * 两处都不对：
 * 1. **文案**说的是现象（没收到内容），**没说原因**（额度用尽）——
 *    用户无从判断该等额度、换模型还是加账号。
 * 2. **错误码** `EMPTY_RESPONSE` **在** harness 的可重试集合里 ⇒
 *    确定性错误被白退避重试 5 次（截图里的「已重试模型请求 (5/5)」）。
 *
 * ## 上游为什么回「空」而不是报错
 *
 * 额度耗尽时请求**根本没送达模型**（对照那边的实测：`provider runtime headers`
 * 请求从未出现），网关直接回 HTTP 200 + 空内容 —— 所以它**看起来**像空响应，
 * 实际是权益问题。这个「秒回空」判据我们早就有（`isFastEntitlementMiss`），
 * 只是此前只用它决定「要不要切号」，从未用在文案上。
 */
describe('ZCode 额度用尽：文案必须说出真实原因、错误码必须不可重试', () => {
  it('★ 无账号可切时：抛 QUOTA_EXCEEDED 且文案点明「额度已用尽或没有可用权益」', async () => {
    // 没有账号池 ⇒ 无法切号 ⇒ 直接走「如实说出原因」那条分支。
    const { adapter, calls } = makeAdapter({
      fetchImpl: async () => emptySse(),
    })

    const result = await drain(adapter.stream(streamOptions())).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    const error = result.error as { code?: string; message?: string }
    // ① 错误码必须**不可重试**（否则会白重试 5 次）。
    expect(error.code).toBe('QUOTA_EXCEEDED')
    // ② 文案必须含真实原因与可操作建议，而不是那句通用的「空响应」。
    expect(error.message).toContain('额度已用尽或没有可用权益')
    expect(error.message).toContain('GLM-5.3-Flash')
    // ③ 不得再出现那句误导性的通用文案。
    expect(error.message).not.toContain('无任何 text / thinking / tool 内容')
    // ④ 只发一次请求 —— 不可重试意味着不在这里白转。
    expect(calls()).toBe(1)
  })

  it('★ 慢回空（≥3s）**不得**被误判成额度问题（那是链路故障，该重试）', async () => {
    /**
     * 用 `isFastEntitlementMiss` 的纯函数形态守这条边界：
     * 同一个 `EMPTY_RESPONSE` 错误，耗时不同 ⇒ 结论相反。
     *
     * ⚠ 这条是**防误伤**：若把慢回空也归成额度问题，
     * 用户会被引向「换账号」这个**无效方向**（那边实测的教训）。
     */
    const silent = new LlmError(
      'zcode: 模型返回了空响应（无任何 text / thinking / tool 内容）',
      EMPTY_RESPONSE_CODE,
    )
    expect(isFastEntitlementMiss(silent, 200)).toBe(true)
    expect(isFastEntitlementMiss(silent, 180_000)).toBe(false)
  })

  it('文案在尝试过多个账号时才提账号数（只试过一个提了会误导）', () => {
    const single = zcodeEntitlementErrorMessage('GLM-5.3', 1)
    expect(single).not.toContain('已尝试')
    const multi = zcodeEntitlementErrorMessage('GLM-5.3', 3)
    expect(multi).toContain('已尝试 3 个账号')
  })

  /**
   * ★ HTTP `body === null` 那条分支（真实缺口，会话实证后补上）。
   *
   * ## 为什么单独守这一条
   *
   * 「额度用尽」在 wire 上有**两种**表现，而我上一轮的修复**只覆盖了一种**：
   *
   * | 形态 | 分支 | 修复前 |
   * |---|---|---|
   * | 200 + 空 SSE 流（0 帧） | `consumeAnthropicSse` 的 `!sawAny` | 已覆盖 |
   * | 200 + **`body === null`** | `zcode-adapter.ts` 的 `response.body === null` | ❌ 抛裸 `EMPTY_RESPONSE` |
   *
   * 后者**跳过了整个 SSE 消费** —— 所以哪怕前者修好了，走这条路径的用户
   * 仍会看到通用文案 + 白重试 5 次。
   */
  it('★ HTTP body 为 null（跳过 SSE 消费）也必须报额度原因、且不可重试', async () => {
    const { adapter, calls } = makeAdapter({
      // `new Response(null)` 的 `.body` 就是 null —— 正是要覆盖的形态。
      fetchImpl: async () => new Response(null, { status: 200 }),
    })

    const result = await drain(adapter.stream(streamOptions())).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    const error = result.error as { code?: string; message?: string }
    expect(error.code).toBe('QUOTA_EXCEEDED')
    expect(error.message).toContain('额度已用尽或没有可用权益')
    // 不得再是那句裸的「上游返回了空响应体」。
    expect(error.message).not.toContain('空响应体')
    expect(calls()).toBe(1)
  })

  it('★ HTTP body 为 null 时也先尝试换账号（有池就先切，而不是直接报错）', async () => {
    const marks: StubPoolCall[] = []
    const pool = stubPool({
      next: { id: 'acct-B', credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } },
      marks,
    })
    const { adapter, calls, auths } = makeAdapter({
      pool,
      currentAccountId: () => 'acct-A',
      fetchImpl: async (call) => (call === 1 ? new Response(null, { status: 200 }) : okSse()),
    })

    const chunks = await drain(adapter.stream(streamOptions()))
    expect(chunks.length).toBeGreaterThan(0)
    expect(calls()).toBe(2)
    // 切到新账号后用的是它的凭据。
    expect(auths[1]).toContain('jwt-B')
    // 失败的那个账号被标记（当日 24:00 前不再选它）。
    expect(marks).toHaveLength(1)
    expect(marks[0]?.accountId).toBe('acct-A')
  })
})
