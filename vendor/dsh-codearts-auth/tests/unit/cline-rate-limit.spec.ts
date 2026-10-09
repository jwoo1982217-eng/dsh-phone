import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clineExhaustedAdvice,
  clineRateLimitResetAt,
  parseClineRateLimitHint,
  parseClineWaitMs,
  recordsClineRateLimit,
} from '../../src/cline-rate-limit.js'

/**
 * ⚠️ **实测原文**（2026-10-03 23:10 直连 `POST /api/v1/chat/completions`，
 * 模型 `cline-free/deepseek-v4.1-flash`，见 `probe-cline-live.mjs`）：
 *
 * ```
 * HTTP 429   no-retry: true   （没有任何 retry-after 头）
 * {"error":{"code":"INFERENCE_CAP_ERROR",
 *   "message":"Error 429: Daily free limit reached on model
 *              deepseek/deepseek-v4.1-flash. Try again in 19h 39m"}}
 * ```
 *
 * 这份原文是所有用例的地基 —— **不要**用「构造一份更好解析的报文」代替它，
 * 那正好会绕过本次要修的缺陷（用户第一次报障后我们只读了 `retry-after` 头，
 * 于是在真实报文下仍然写 60 分钟）。
 */
const REAL_DAILY_FREE_BODY = JSON.stringify({
  error: {
    code: 'INFERENCE_CAP_ERROR',
    message: 'Error 429: Daily free limit reached on model deepseek/deepseek-v4.1-flash. Try again in 19h 39m',
  },
})

/** 造一个只有响应头的 Response（body 由调用方单独传）。 */
function responseWith(headers: Record<string, string> = {}): Response {
  return new Response('', { status: 429, headers })
}

describe('Cline 等待时长解析（Try again in 19h 39m）', () => {
  it('★ 实测报文：读出 19 小时 39 分，并认出「当日免费额度」', () => {
    const hint = parseClineRateLimitHint(REAL_DAILY_FREE_BODY)
    expect(hint.waitMs).toBe(((19 * 60) + 39) * 60_000)
    expect(hint.dailyFree).toBe(true)
    expect(hint.code).toBe('INFERENCE_CAP_ERROR')
    expect(hint.message).toContain('Daily free limit reached')
  })

  it('单位可省略：39m / 45s / 1h', () => {
    expect(parseClineWaitMs('39m')).toBe(39 * 60_000)
    expect(parseClineWaitMs('45s')).toBe(45_000)
    expect(parseClineWaitMs('1h')).toBe(3_600_000)
    expect(parseClineWaitMs('Try again in 2h')).toBe(2 * 3_600_000)
  })

  it('多段累加：1h 30m / 2 hours 5 minutes', () => {
    expect(parseClineWaitMs('1h 30m')).toBe(90 * 60_000)
    expect(parseClineWaitMs('2 hours 5 minutes')).toBe((2 * 60 + 5) * 60_000)
  })

  it('⚠️ 单位单词不会被重复计数（`2 minutes` 只能是 2 分钟）', () => {
    // 时长 token 的正则里 `minutes?` 与 `m` 两个分支都能匹配同一段，
    // 少了尾部 `(?![a-z])` 就会把 2 分钟算成 4 分钟 —— 倒计时直接翻倍。
    expect(parseClineWaitMs('2 minutes')).toBe(120_000)
    expect(parseClineWaitMs('30 seconds')).toBe(30_000)
  })

  it('`0s` 是「立即解除」，返回 0 而不是 undefined', () => {
    // 判空一律用 `=== undefined`：0 若被当成「没解析到」，就会退回 1 小时兜底
    //（与 `retry-after: 0` 同款陷阱，见 retry-after.ts）。
    expect(parseClineWaitMs('0s')).toBe(0)
    expect(parseClineRateLimitHint('Error: Try again in 0s').waitMs).toBe(0)
  })

  it('句末的无关数字不算进时长', () => {
    const hint = parseClineRateLimitHint(JSON.stringify({
      error: { message: 'Rate limited. Try again in 5m. Upgrade to Pro for 10x limits' },
    }))
    expect(hint.waitMs).toBe(300_000)
  })

  it('报文里没有时长时不编造（waitMs 为 undefined）', () => {
    const hint = parseClineRateLimitHint(JSON.stringify({ error: { message: 'Rate limit exceeded' } }))
    expect(hint.waitMs).toBeUndefined()
    expect(hint.dailyFree).toBe(false)
  })

  it('非 JSON 的纯文本报文同样能解析（HTML/网关包装页）', () => {
    const hint = parseClineRateLimitHint('429 Too Many Requests. Try again in 15m')
    expect(hint.waitMs).toBe(900_000)
    expect(hint.message).toContain('Too Many Requests')
  })

  it('`{error:"字串"}` 外壳也认（不止 `{error:{message}}`）', () => {
    const hint = parseClineRateLimitHint(JSON.stringify({ error: 'Daily free limit reached. Try again in 1h 2m' }))
    expect(hint.waitMs).toBe(62 * 60_000)
    expect(hint.dailyFree).toBe(true)
  })

  it('空报文 / 垃圾输入不抛错', () => {
    expect(parseClineRateLimitHint('')).toEqual({ dailyFree: false })
    expect(parseClineRateLimitHint('{ broken json').dailyFree).toBe(false)
    expect(parseClineWaitMs('没有任何数字')).toBeUndefined()
  })
})

describe('clineRateLimitResetAt：取值优先级', () => {
  const model = 'cline-free/deepseek-v4.1-flash'
  const DAILY_WAIT_MS = ((19 * 60) + 39) * 60_000

  /** 断言「距现在约等于 expectMs」（±1 秒，只容忍调用耗时）。 */
  function expectWaitNear(resetAt: number, expectMs: number): void {
    const diff = resetAt - Date.now()
    expect(diff).toBeGreaterThanOrEqual(expectMs - 1_000)
    expect(diff).toBeLessThanOrEqual(expectMs + 1_000)
  }

  it('★ 没有 retry-after 头时用报文里的时长（本次报障的正面用例）', () => {
    // 原实现只看响应头 + 通用绝对时刻句式，两者在这份实测报文下都拿不到，
    // 于是一律退回「1 小时」—— 用户等满一小时再试，当然还是 429。
    expectWaitNear(clineRateLimitResetAt(responseWith(), REAL_DAILY_FREE_BODY, model), DAILY_WAIT_MS)
  })

  it('retry-after 头优先于报文里的时长', () => {
    expectWaitNear(
      clineRateLimitResetAt(responseWith({ 'retry-after': '600' }), REAL_DAILY_FREE_BODY, model),
      600_000,
    )
  })

  it('两者都没有时才用通用的绝对时刻句式', () => {
    const body = JSON.stringify({ msg: '您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置' })
    expect(clineRateLimitResetAt(responseWith(), body, model))
      .toBe(Date.parse('2026-09-11 18:08:17 UTC+8'))
  })

  it('什么都没有才退到 1 小时快照兜底（与 buddy 同口径）', () => {
    const body = JSON.stringify({ error: 'too many requests' })
    const fallback = clineRateLimitResetAt(responseWith(), body, model)
    expectWaitNear(fallback, 3_600_000)
    // ⚠️ 必须与「实测报文」那条在**量级**上区分开，否则这个用例根本证明不了
    // 「读了报文」还是「退回兜底」—— 那正是第一次修完仍然报 60 分钟的原因。
    const parsed = clineRateLimitResetAt(responseWith(), REAL_DAILY_FREE_BODY, model)
    expect(parsed - Date.now()).toBeGreaterThan((fallback - Date.now()) * 10)
  })

  it('只有 429 记限流徽章（402 是充值问题，等多久都不会好）', () => {
    expect(recordsClineRateLimit(429, REAL_DAILY_FREE_BODY)).toBe(true)
    expect(recordsClineRateLimit(402, JSON.stringify({ error: 'Insufficient credits' }))).toBe(false)
  })
})

describe('clineExhaustedAdvice：三种 429/402 的动作必须分开说', () => {
  /**
   * ⚠ 下面两条把时钟**钉死**（2026-10-04 修复）。
   *
   * 原因：`clineExhaustedAdvice` → `formatResetIn(resetAtMs)` 内部取**真实**
   * `Date.now()`，而 `resetAt` 是硬编码的**绝对时刻**。两者之差随「什么时候跑
   * 这条用例」变化，于是文案在三种形态之间跳：
   *
   * | 距 `resetAt` | `formatResetIn` 输出 | 原断言 `/预计 \d+(\.\d)? 小时后重置/` |
   * |---|---|---|
   * | > 1 小时 | `1.8 小时` | ✅ |
   * | 1 分钟 ~ 1 小时 | `43 分钟` | ❌ |
   * | ≤ 0 | `即将重置` | ❌ |
   *
   * ⇒ 原用例**只在 UTC 09:49 之前的那个窗口里成立**，之后永久变红
   * （实测 2026-10-04 10:06 UTC：`expected '…预计 43 分钟后重置…'`）。
   * **与被测代码无关**，是脚手架把「当前时刻」当成了常量。
   *
   * ⚠ 用 `vi.setSystemTime` 而不是把 `resetAt` 改成 `Date.now() + N`：
   * 后者会让断言**跟着实现漂**（`N` 取多少都能过），且丢掉「跨过 1 小时
   * 分界会换措辞」这个真正需要锁住的行为。
   */
  afterEach(() => {
    vi.useRealTimers()
  })

  it('★ 当日免费额度：说清「等不到头」并给出立刻可用的通道', () => {
    // 钉在距重置 1 小时 49 分 ⇒ 走「小时」分支。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T09:00:00.000Z'))
    const hint = parseClineRateLimitHint(REAL_DAILY_FREE_BODY)
    const resetAt = Date.parse('2026-10-04T10:49:00.000Z')
    const advice = clineExhaustedAdvice(429, hint, resetAt)
    expect(advice).toContain('当日免费额度')
    // ⚠️ 必须点出**按天结算**：否则用户仍会以为「再等等就好」。
    expect(advice).toContain('按天结算')
    // ⚠️ 必须点出**按模型单独计**：实测同一时刻 mimo / muse-spark 仍 200，
    // 故「换另一个免费模型」是真的可用动作。
    expect(advice).toContain('按模型单独计')
    expect(advice).toContain('其它免费模型')
    // ⚠️ **绝不能**建议 cline-pass：那是**订阅**通道，本账号实测
    // 403 ENTITLEMENT_ERROR（有余额但没订阅计划）。
    expect(advice).not.toContain('cline-pass')
    // 解禁时刻要写出来，用户不必自己猜（本地时钟形态；具体时区随机器）。
    expect(advice).toMatch(/\d{4}\/\d{1,2}\/\d{1,2}/)
    expect(advice).toMatch(/预计 \d+(\.\d)? 小时后重置/)
    // ⚠️ 不得复述上游英文原文：用户 2026-10-03 报障「比其它供应商长太多」，
    // 病根就是把这句话和我们的中文解释各说了一遍。
    expect(advice).not.toContain('Daily free limit')
    expect(advice).not.toMatch(/Try again in/)
    // ⚠️ 不得出现 markdown 加粗：错误气泡**不渲染 markdown**，星号会原样显示
    // （用户截图里就是 `**当日免费额度**`）。
    expect(advice).not.toContain('**')
    // 长度上限：与其它 provider 的额度文案同量级（用户明确要求「改简短点」）。
    expect(advice.length).toBeLessThan(100)
  })

  it('★ 距重置不足 1 小时时改说「N 分钟」（分界另一侧也要锁）', () => {
    /**
     * ⚠ 这条是上面那条的**另一半**：只锁「小时」分支的话，把 1 小时的分界
     * 改掉（比如 `3_600_000` → `7_200_000`）不会有任何用例变红。
     * 两个分支都必须锁，阈值才是被测行为而不是实现细节。
     */
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T10:20:00.000Z'))
    const advice = clineExhaustedAdvice(
      429,
      parseClineRateLimitHint(REAL_DAILY_FREE_BODY),
      Date.parse('2026-10-04T10:49:00.000Z'),
    )
    expect(advice).toMatch(/预计 29 分钟后重置/)
    // ⚠ 分钟分支同样不得退化成 markdown / 复述原文（与上面那条同款约束）。
    expect(advice).not.toContain('**')
    expect(advice).not.toContain('Daily free limit')
    expect(advice.length).toBeLessThan(100)
  })

  it('已过解禁时刻时说「即将重置」，不报负数时长', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T11:00:00.000Z'))
    const advice = clineExhaustedAdvice(
      429,
      parseClineRateLimitHint(REAL_DAILY_FREE_BODY),
      Date.parse('2026-10-04T10:49:00.000Z'),
    )
    expect(advice).toContain('即将重置')
    expect(advice).not.toMatch(/预计 -\d/)
  })

  it('普通 429（短时限流）仍是「等一会儿 / 换账号」，且不丢原文（未识别语义才附）', () => {
    const hint = parseClineRateLimitHint(JSON.stringify({ error: { message: 'Rate limit exceeded' } }))
    const advice = clineExhaustedAdvice(429, hint)
    expect(advice).toContain('限流')
    // 这一支**没有**识别出专门语义，原文必须保留（排障线索）。
    expect(advice).toContain('Rate limit exceeded')
    expect(advice).not.toContain('cline-pass')
  })

  it('402 建议充值（与 429 完全不同的动作）', () => {
    const advice = clineExhaustedAdvice(402, parseClineRateLimitHint('Insufficient credits'))
    expect(advice).toContain('402')
    expect(advice).toContain('充值')
  })

  it('没有 hint 时退到最保守的说法，不凭空断言「按天」', () => {
    const advice = clineExhaustedAdvice(429)
    expect(advice).toContain('限流')
    expect(advice).not.toContain('当日免费额度')
  })
})
