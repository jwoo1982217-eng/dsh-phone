/**
 * Gemini **配额窗口**查询单测。
 *
 * ## 守的是什么
 *
 * Gemini 免费线给的是**配额窗口**（5 小时 / 周两个窗口的剩余比例），不是充值积分。
 * 这里锁死三件容易"顺手改坏"的事：
 *
 * 1. **`bucketId` 是唯一判据** —— 响应里还有 `3p-*`（Claude/GPT 产品线）的桶，
 *    按 `displayName` / `window` 匹配会把别家产品的额度显示成 Gemini 的。
 * 2. **`resetTime` 不可解析 ⇒ 整条丢弃** —— 编一个空串会让面板显示一个
 *    "永远不过期"的窗口，比少一个包更误导。
 * 3. **未授权不是错误** —— 没登录时返回 `{balance: null, error:'尚未授权 Google 账号'}`，
 *    抛异常会让账号卡片显示成故障。
 *
 * ⚠️ `total` 取两窗口的**平均**而不是 min（见 `gemini-credits.ts` 的口径注释）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GEMINI_BUCKET_FIVE_HOUR,
  GEMINI_BUCKET_WEEKLY,
  GEMINI_UNAUTHORIZED_MESSAGE,
  GEMINI_WINDOW_LABEL_FIVE_HOUR,
  GEMINI_WINDOW_LABEL_WEEKLY,
  clearGeminiCreditCache,
  fetchGeminiCreditBalance,
  parseGeminiQuotaWindow,
  parseGeminiQuotaWindows,
  toGeminiCreditBalance,
} from '../../src/gemini-credits.js'
import {
  GEMINI,
  GEMINI_DEFAULT_PROJECT,
  GEMINI_ENDPOINT_SANDBOX,
  GEMINI_QUOTA_PATH,
  type GeminiCredential,
} from '../../src/gemini.js'

const RESET_5H = '2026-10-03T18:00:00Z'
const RESET_WEEKLY = '2026-10-06T00:00:00Z'

function credential(token = 'AT'): GeminiCredential {
  return { access_token: token, refresh_token: 'RT' }
}

/** 上游真实形状：两组桶，第二组属于别家产品线。 */
function upstreamPayload(fiveHour = 0.99, weekly = 0.99): unknown {
  return {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: GEMINI_BUCKET_WEEKLY, window: 'weekly', resetTime: RESET_WEEKLY, remainingFraction: weekly },
          { bucketId: GEMINI_BUCKET_FIVE_HOUR, window: '5h', resetTime: RESET_5H, remainingFraction: fiveHour },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-5h', window: '5h', resetTime: RESET_5H, remainingFraction: 0.5 },
          { bucketId: '3p-weekly', window: 'weekly', resetTime: RESET_WEEKLY, remainingFraction: 0.5 },
        ],
      },
    ],
  }
}

/**
 * 让 fetch 返回给定响应，并记录**配额端点**的调用。
 *
 * ⚠️ 只记录配额端点：同一次调用还会并行发 `loadCodeAssist`（取账号规格），
 * 若把它也记进来，下面所有 `expect(calls).toHaveLength(n)` 都要跟着翻倍 ——
 * 那些断言守的是配额查询的次数与形状，与档位无关。档位请求这里一律回 404。
 */
function stubQuota(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('loadCodeAssist')) return new Response('', { status: 404 })
    calls.push({ url, init: init ?? {} })
    return response()
  }))
  return calls
}

function jsonOk(payload: unknown): () => Response {
  return () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  clearGeminiCreditCache()
  vi.unstubAllGlobals()
})

describe('parseGeminiQuotaWindow 的硬约束', () => {
  it('完整字段正常解析；window 缺失退化为空串（仅诊断用，不参与匹配）', () => {
    expect(parseGeminiQuotaWindow({
      bucketId: GEMINI_BUCKET_FIVE_HOUR,
      window: '5h',
      resetTime: RESET_5H,
      remainingFraction: 0.42,
    })).toEqual({
      bucketId: GEMINI_BUCKET_FIVE_HOUR,
      window: '5h',
      resetTime: RESET_5H,
      remainingFraction: 0.42,
    })
    expect(parseGeminiQuotaWindow({
      bucketId: GEMINI_BUCKET_WEEKLY, resetTime: RESET_WEEKLY, remainingFraction: 1,
    })?.window).toBe('')
  })

  it('bucketId / remainingFraction / resetTime 任一不合规即整条丢弃；非对象输入返 undefined', () => {
    const base = { bucketId: GEMINI_BUCKET_FIVE_HOUR, resetTime: RESET_5H, remainingFraction: 0.5 }
    expect(parseGeminiQuotaWindow({ resetTime: RESET_5H, remainingFraction: 0.5 })).toBeUndefined()
    expect(parseGeminiQuotaWindow({ ...base, bucketId: '' })).toBeUndefined()
    expect(parseGeminiQuotaWindow({ ...base, remainingFraction: Number.NaN })).toBeUndefined()
    expect(parseGeminiQuotaWindow({ ...base, remainingFraction: '0.5' })).toBeUndefined()
    // ⚠️ resetTime 不可解析时**整条丢弃**，不编造一个永不过期的窗口。
    expect(parseGeminiQuotaWindow({
      bucketId: GEMINI_BUCKET_FIVE_HOUR, remainingFraction: 0.5, resetTime: '不是时间',
    })).toBeUndefined()
    expect(parseGeminiQuotaWindow(null)).toBeUndefined()
    expect(parseGeminiQuotaWindow('x')).toBeUndefined()
  })
})

describe('parseGeminiQuotaWindows 的选取口径', () => {
  it('按 bucketId 挑出两个桶，忽略别家产品的桶（displayName 改文案不影响识别）', () => {
    const { fiveHour, weekly } = parseGeminiQuotaWindows(upstreamPayload())
    expect(fiveHour?.bucketId).toBe(GEMINI_BUCKET_FIVE_HOUR)
    expect(weekly?.bucketId).toBe(GEMINI_BUCKET_WEEKLY)
    expect(fiveHour?.remainingFraction).toBe(0.99)
  })

  it('形状完全不对 → 空对象（由调用方判成失败，不伪造 100%）', () => {
    expect(parseGeminiQuotaWindows(null)).toEqual({})
    expect(parseGeminiQuotaWindows({ groups: 'x' })).toEqual({})
    expect(parseGeminiQuotaWindows({ groups: [{ buckets: 'x' }] })).toEqual({})
  })
})

describe('toGeminiCreditBalance 的口径', () => {
  it('两个窗口各一个包：单位百分比、总额 100、总额减剩余即已用；汇总取平均', () => {
    const { fiveHour, weekly } = parseGeminiQuotaWindows(upstreamPayload(0.8, 0.6))
    const balance = toGeminiCreditBalance(fiveHour, weekly)
    expect(balance.packages[0]).toEqual({
      name: GEMINI_WINDOW_LABEL_FIVE_HOUR,
      unit: '%',
      remaining: 80,
      total: 100,
      used: 20,
      active: true,
      cycleStartTime: '',
      cycleEndTime: RESET_5H,
      expiredTime: '',
    })
    expect(balance.packages[1]?.name).toBe(GEMINI_WINDOW_LABEL_WEEKLY)
    // ⚠️ 汇总取**平均**（80 与 60 → 70），不是 min（会显示成 60，误导成快用完了）。
    expect(balance.total).toBe(70)
    expect(balance.expiredTotal).toBe(0)
  })

  it('只剩一个窗口时汇总就是那一个；都没有时是空余额（不是 100）', () => {
    const { fiveHour } = parseGeminiQuotaWindows(upstreamPayload(0.42, 0.42))
    expect(toGeminiCreditBalance(fiveHour, undefined).total).toBe(42)
    expect(toGeminiCreditBalance(undefined, undefined)).toEqual({
      total: 0, packages: [], expiredTotal: 0,
    })
  })

  it('比例越界被收敛（上游给 1.5 / -0.2 也不能显示成 150% / -20%）', () => {
    const high = { bucketId: GEMINI_BUCKET_FIVE_HOUR, window: '5h', resetTime: RESET_5H, remainingFraction: 1.5 }
    const low = { bucketId: GEMINI_BUCKET_WEEKLY, window: 'weekly', resetTime: RESET_WEEKLY, remainingFraction: -0.2 }
    const balance = toGeminiCreditBalance(high, low)
    expect(balance.packages[0]?.remaining).toBe(100)
    expect(balance.packages[1]?.remaining).toBe(0)
    expect(balance.total).toBe(50)
  })
})

describe('fetchGeminiCreditBalance', () => {
  it('未授权 → 返回文案而不是抛错，且**不发请求**', async () => {
    const calls = stubQuota(jsonOk({}))
    expect(await fetchGeminiCreditBalance({ access_token: '' }))
      .toEqual({ balance: null, error: GEMINI_UNAUTHORIZED_MESSAGE })
    expect(calls).toHaveLength(0)
  })

  it('POST 到 sandbox 配额端点，带 project 请求体与身份头；正常响应产出两个包', async () => {
    const calls = stubQuota(jsonOk(upstreamPayload(0.99, 0.98)))
    const result = await fetchGeminiCreditBalance(credential())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${GEMINI_ENDPOINT_SANDBOX}${GEMINI_QUOTA_PATH}`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBe(JSON.stringify({ project: GEMINI_DEFAULT_PROJECT }))
    const headers = calls[0]!.init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer AT')
    expect(headers.get('x-client-name')).toBe('antigravity')
    expect(headers.get('x-machine-id')).toBe('cmdc-pak')

    expect(result.error).toBeUndefined()
    expect(result.balance?.packages).toHaveLength(2)
    expect(result.balance?.total).toBe(98.5)
  })

  it('缓存 60 秒、按 access_token 分键、force 跳过、失败也进缓存（避免面板刷爆上游）', async () => {
    const now = 1_000_000
    const ok = stubQuota(jsonOk(upstreamPayload()))
    await fetchGeminiCreditBalance(credential('AT-CACHE'), GEMINI, { now: () => now })
    await fetchGeminiCreditBalance(credential('AT-CACHE'), GEMINI, { now: () => now + 59_000 })
    await fetchGeminiCreditBalance(credential('AT-CACHE'), GEMINI, { now: () => now + 61_000 })
    // 换号不会读到别人的配额
    await fetchGeminiCreditBalance(credential('AT-OTHER'), GEMINI, { now: () => now })
    // force 跳过缓存（面板「刷新」按钮）
    await fetchGeminiCreditBalance(credential('AT-CACHE'), GEMINI, { now: () => now + 61_000, force: true })
    expect(ok).toHaveLength(4)

    clearGeminiCreditCache()
    const bad = stubQuota(() => new Response('boom', { status: 500 }))
    const first = await fetchGeminiCreditBalance(credential('AT-ERR'), GEMINI, { now: () => now })
    const second = await fetchGeminiCreditBalance(credential('AT-ERR'), GEMINI, { now: () => now + 1_000 })
    expect(first.error).toBeDefined()
    expect(second).toEqual(first)
    expect(bad).toHaveLength(1)
  })

  it('失败文案如实区分：网络失败 / 401 带 reason / 其他 HTTP 带正文 / 非 JSON / 认不出 Gemini 桶', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect((await fetchGeminiCreditBalance(credential())).error).toMatch(/配额查询网络失败/)

    clearGeminiCreditCache()
    stubQuota(() => new Response('unauthorized', { status: 401 }))
    expect((await fetchGeminiCreditBalance(credential('AT-401'))).error)
      .toBe('配额查询被拒（HTTP 401）：unauthorized')

    clearGeminiCreditCache()
    stubQuota(() => new Response('<html>502</html>', { status: 200 }))
    expect((await fetchGeminiCreditBalance(credential('AT-HTML'))).error)
      .toBe('配额响应不是 JSON（HTTP 200）')

    // ⚠️ 认不出任何 Gemini 桶时**不伪造 100%**。
    clearGeminiCreditCache()
    stubQuota(jsonOk({ groups: [{ buckets: [{ bucketId: '3p-5h', resetTime: RESET_5H, remainingFraction: 0.5 }] }] }))
    const empty = await fetchGeminiCreditBalance(credential('AT-EMPTY'))
    expect(empty.balance).toBeNull()
    expect(empty.error).toBe('配额响应里没有 Gemini 配额桶')

    // 只有周窗口也算成功（不要求两个桶都在）。
    clearGeminiCreditCache()
    stubQuota(jsonOk({
      groups: [{ buckets: [{ bucketId: GEMINI_BUCKET_WEEKLY, resetTime: RESET_WEEKLY, remainingFraction: 0.5 }] }],
    }))
    const weeklyOnly = await fetchGeminiCreditBalance(credential('AT-WEEKLY-ONLY'))
    expect(weeklyOnly.error).toBeUndefined()
    expect(weeklyOnly.balance?.total).toBe(50)
  })
})
