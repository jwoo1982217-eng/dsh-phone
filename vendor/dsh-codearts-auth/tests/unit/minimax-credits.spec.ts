import { describe, expect, it, vi } from 'vitest'
import {
  claimMinimaxDailyCheckin,
  fetchMinimaxCreditBalance,
  fetchMinimaxSigninStatus,
  minimaxPanelToCheckinStatus,
  parseMinimaxSigninPanel,
  resolveMinimaxTimezoneId,
} from '../../src/minimax-credits.js'
import type { MinimaxCredential } from '../../src/minimax.js'

const CRED: MinimaxCredential = { access_token: 'a'.repeat(60), token_type: 'Bearer' }

/** 造一个合法的 7 天面板。 */
function makePanel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const days = Array.from({ length: 7 }, (_, i) => ({
    day_no: i + 1,
    points: 800,
    bonus_points: 400,
    status: i === 0 ? 2 : 1,
    is_today: i === 0,
  }))
  return { data: { scene: 1, days, ...overrides }, base_resp: { status_code: 0, status_msg: 'ok' } }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('resolveMinimaxTimezoneId', () => {
  it('返回合法 IANA 名', () => {
    const tz = resolveMinimaxTimezoneId()
    expect(tz.length).toBeGreaterThan(0)
    expect(tz).not.toContain(' ')
  })

  it('Intl 抛错时回退 UTC', () => {
    expect(resolveMinimaxTimezoneId(() => { throw new Error('boom') })).toBe('UTC')
  })
})

describe('parseMinimaxSigninPanel —— 7 天契约', () => {
  it('解析合法面板', () => {
    const panel = parseMinimaxSigninPanel(makePanel().data)
    expect(panel?.days).toHaveLength(7)
    expect(panel?.days[0]?.points).toBe(800)
    expect(panel?.days[0]?.bonusPoints).toBe(400)
  })

  it('⚠️ days 不是 7 条时返回 undefined', () => {
    const panel = makePanel()
    ;(panel.data as { days: unknown[] }).days = (panel.data as { days: unknown[] }).days.slice(0, 6)
    expect(parseMinimaxSigninPanel(panel.data)).toBeUndefined()
  })

  it('⚠️ 超过 1 条 is_today 时返回 undefined', () => {
    const panel = makePanel()
    for (const day of (panel.data as { days: { is_today: boolean }[] }).days) day.is_today = true
    expect(parseMinimaxSigninPanel(panel.data)).toBeUndefined()
  })

  it('⚠️ 超过 1 条 Claimable 时返回 undefined', () => {
    const panel = makePanel()
    for (const day of (panel.data as { days: { status: number }[] }).days) day.status = 2
    expect(parseMinimaxSigninPanel(panel.data)).toBeUndefined()
  })

  it('day_no 重复时返回 undefined', () => {
    const panel = makePanel()
    ;(panel.data as { days: { day_no: number }[] }).days[1]!.day_no = 1
    expect(parseMinimaxSigninPanel(panel.data)).toBeUndefined()
  })
})

describe('minimaxPanelToCheckinStatus', () => {
  it('⚠️ dailyCredit === points（800），不是 points + bonus_points（1200）', () => {
    const panel = parseMinimaxSigninPanel(makePanel().data)!
    const status = minimaxPanelToCheckinStatus(panel)
    expect(status.dailyCredit).toBe(800)
  })

  it('⚠️ active 恒 true（拿到响应即 true）', () => {
    const panel = parseMinimaxSigninPanel(makePanel().data)!
    expect(minimaxPanelToCheckinStatus(panel).active).toBe(true)
  })

  it('⚠️ 今日已领判据是 is_today && status===3', () => {
    const panel = makePanel()
    ;(panel.data as { days: { status: number }[] }).days[0]!.status = 3
    const status = minimaxPanelToCheckinStatus(parseMinimaxSigninPanel(panel.data)!)
    expect(status.todayCheckedIn).toBe(true)
  })

  it('⚠️ 「没有 Claimable」不得反推为已领', () => {
    const panel = makePanel()
    // 全部 upcoming（既没 Claimable 也没 Claimed）
    for (const day of (panel.data as { days: { status: number }[] }).days) day.status = 1
    const status = minimaxPanelToCheckinStatus(parseMinimaxSigninPanel(panel.data)!)
    expect(status.todayCheckedIn).toBe(false)
  })

  it('isStreakDay = bonus_points > 0', () => {
    const panel = parseMinimaxSigninPanel(makePanel().data)!
    expect(minimaxPanelToCheckinStatus(panel).isStreakDay).toBe(true)
  })

  // ===== 以下 4 条为**判别力加固**（实施者补，2026-09-28）=====
  // 上一条用例里今日 `points:800` 与 `bonus_points:400` **同时 > 0**，
  // 于是「`bonusPoints > 0`」与「`points > 0`」结果相同 ⇒ 恒真，杀不掉变异。
  // 本条的 fixture 让**只有 `points` > 0**，两种口径才分道扬镳。
  it('⚠️ isStreakDay 判别力：bonus_points=0（points 仍 >0）必须是 false', () => {
    const panel = makePanel()
    ;(panel.data as { days: { bonus_points: number }[] }).days[0]!.bonus_points = 0
    const status = minimaxPanelToCheckinStatus(parseMinimaxSigninPanel(panel.data)!)
    expect(status.isStreakDay).toBe(false)
  })

  // ⚠️ 上一条 `active` 用例的今日恰好是 **Claimable**，
  // 于是「恒 true」与「有可领项才 true」结果相同 ⇒ 恒真。
  // 本条构造**零可领项**（今日已领）—— 这正是 Qoder 那个同型缺陷的现场：
  // 把「今天已领」误报成「签到活动未开启」。
  it('⚠️ active 判别力：零可领项（今日已领）时仍须恒 true', () => {
    const panel = makePanel()
    for (const day of (panel.data as { days: { status: number }[] }).days) day.status = 3
    const status = minimaxPanelToCheckinStatus(parseMinimaxSigninPanel(panel.data)!)
    expect(status.active).toBe(true)
    expect(status.todayCheckedIn).toBe(true)
  })

  // ⚠️ 上一条「今日已领」用例里今日是**唯一** status===3 的一天，
  // 于是「`is_today && status===3`」与「存在任意一天 status===3」结果相同 ⇒ 恒真。
  // 本条让**别的天**已领、今日未领，两种判据才分道扬镳。
  it('⚠️ todayCheckedIn 判别力：别的天已领不算今天已领', () => {
    const panel = makePanel()
    const days = (panel.data as { days: { status: number }[] }).days
    days[0]!.status = 1 // 今日：未领
    days[3]!.status = 3 // 第 4 天：已领（非今日）
    const status = minimaxPanelToCheckinStatus(parseMinimaxSigninPanel(panel.data)!)
    expect(status.todayCheckedIn).toBe(false)
  })
})

describe('fetchMinimaxSigninStatus', () => {
  it('⚠️ timezone_id 必须在 query（放头里会 invalid timezone_id）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(makePanel()))
    await fetchMinimaxSigninStatus(CRED, fetcher as never)
    const url = String(fetcher.mock.calls[0]?.[0])
    expect(url).toContain('timezone_id=')
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('X-Timezone-Id')).toBeNull()
  })

  it('⚠️ HTTP 200 + base_resp.status_code 非 0 必须判失败（invalid timezone_id 也是 200）', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({ base_resp: { status_code: 1406010011, status_msg: 'invalid timezone_id' } }),
    )
    expect(await fetchMinimaxSigninStatus(CRED, fetcher as never)).toBeNull()
  })

  it('网络失败返回 null（不抛错）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await fetchMinimaxSigninStatus(CRED, fetcher as never)).toBeNull()
  })
})

describe('claimMinimaxDailyCheckin', () => {
  const claimBody = {
    data: {
      claim_id: 'c1',
      claim_result: 1,
      day_no: 1,
      points: 800,
      expire_at_ms: Date.now() + 86400_000,
      panel: (makePanel().data as { days: unknown[]; scene: number }),
    },
    base_resp: { status_code: 0 },
  }

  it('⚠️ claim_result===1 → claimed，credit === points（800）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(claimBody))
    const outcome = await claimMinimaxDailyCheckin(CRED, fetcher as never)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(800)
  })

  it('⚠️ claim_result===2 → already-claimed（幂等判据不是 HTTP 状态码）', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({ ...claimBody, data: { ...claimBody.data, claim_result: 2 } }),
    )
    const outcome = await claimMinimaxDailyCheckin(CRED, fetcher as never)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('⚠️ 业务码非 0 → failed', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({ base_resp: { status_code: 1406010011, status_msg: 'invalid timezone_id' } }),
    )
    const outcome = await claimMinimaxDailyCheckin(CRED, fetcher as never)
    expect(outcome.kind).toBe('failed')
  })

  it('⚠️ claim 也必须带 timezone_id', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(claimBody))
    await claimMinimaxDailyCheckin(CRED, fetcher as never)
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('timezone_id=')
  })

  // ===== 以下 2 条为判别力 / 防线加固（实施者补，2026-09-28）=====

  // ⚠️ 上一条 `credit` 用例里响应的 `points`（800）与面板首日的 `points`（800）
  // **恰好相等**，于是「取响应 `data.points`」与「取面板里的 points」结果相同
  // ⇒ 恒真。本条把两者**刻意错开**，只有真正读响应字段才通过。
  it('⚠️ credit 取响应体的 points（而非面板首日 points）', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({ ...claimBody, data: { ...claimBody.data, points: 300 } }),
    )
    const outcome = await claimMinimaxDailyCheckin(CRED, fetcher as never)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(300)
  })

  // ⚠️ **TRAE 同型缺陷的防线**：`claim_result` 缺失/非法时**必须 `failed`**，
  // 不得虚报成功。TRAE 的 claim 对「已签到」幂等、与真领取无法区分，
  // 早期它在已签到时被报成「领取成功」但 **+0 积分**（用户报障）。
  // 本条覆盖三种非法形态：缺失、null、越界值。
  it.each([
    ['缺失', 'missing'],
    ['null', 'null'],
    ['越界（3）', 'out-of-range'],
    ['字符串', 'string'],
  ])('⚠️ claim_result %s 时必须 failed（不虚报成功）', async (_label, mode) => {
    // ⚠️ 「缺失」必须**真的删键**，不能靠 `{...data, ...{}}` ——
    // 展开空对象**不会删除**已存在的字段（写这条用例时实测踩到：
    // 它仍带着 `claim_result:1` 从而通过，是**假绿**）。
    const data: Record<string, unknown> = {
      claim_id: claimBody.data.claim_id,
      day_no: claimBody.data.day_no,
      points: claimBody.data.points,
      panel: claimBody.data.panel,
    }
    if (mode === 'null') data.claim_result = null
    else if (mode === 'out-of-range') data.claim_result = 3
    else if (mode === 'string') data.claim_result = '1'
    const fetcher = vi.fn().mockResolvedValue(
      json({ data, base_resp: { status_code: 0 } }),
    )
    const outcome = await claimMinimaxDailyCheckin(CRED, fetcher as never)
    expect(outcome.kind).toBe('failed')
  })
})

describe('fetchMinimaxCreditBalance', () => {
  it('⚠️ 空明细（无 details 字段）当空数组，total 为 0', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({ total_count: 0, base_resp: { status_code: 0 } }),
    )
    const balance = await fetchMinimaxCreditBalance(CRED, fetcher as never)
    expect(balance?.total).toBe(0)
    expect(balance?.packages).toEqual([])
  })

  // ⚠️ **本轮修复的回归防线**（2026-09-29）。
  //
  // 初版把 `total_count`（**记录条数**）当成余额。之所以没被发现：余额为 0 时
  // `details` 缺失且 `total_count` 也是 0 —— 「条数 0」与「余额 0」**偶然重合**，
  // 上一条用例因此是同义反复。领取 800 积分后两者分叉（条数 1 / 余额 800）。
  it('⚠️ 有余额时 total 取 details[].remaining_amount 之和（不是 total_count 条数）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      // 真实响应形状（本机领取 800 后实测）
      details: [{
        remaining_amount: '800.00',
        consumed_amount: '0.00',
        granted_amount: '800.00',
        credit_type: 2,
        granted_at_ms: 1790645562328,
        expire_at_ms: 1793203200000,
      }],
      total_count: 1,
      base_resp: { status_code: 0, status_msg: 'ok' },
    }))
    const balance = await fetchMinimaxCreditBalance(CRED, fetcher as never)
    // 关键：是 800（remaining_amount），**不是** 1（total_count 条数）
    expect(balance?.total).toBe(800)
  })

  it('多包按 remaining_amount 累加（字符串与数字都接受）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      details: [
        { remaining_amount: '300.50' },
        { remaining_amount: 99.5 }, // 上游若改回数字形态也不该失效
      ],
      total_count: 2,
      base_resp: { status_code: 0 },
    }))
    expect((await fetchMinimaxCreditBalance(CRED, fetcher as never))?.total).toBe(400)
  })

  it('⚠️ details 存在但条目缺 remaining_amount ⇒ 该项记 0，不编造', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      details: [{ credit_type: 2 }, { remaining_amount: '150.00' }],
      total_count: 2,
      base_resp: { status_code: 0 },
    }))
    expect((await fetchMinimaxCreditBalance(CRED, fetcher as never))?.total).toBe(150)
  })

  it('业务码非 0 返回 null', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ base_resp: { status_code: 1 } }))
    expect(await fetchMinimaxCreditBalance(CRED, fetcher as never)).toBeNull()
  })

  it('响应形状完全不对（无 details 也无 total_count）返回 null（不编造 0）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ base_resp: { status_code: 0 } }))
    expect(await fetchMinimaxCreditBalance(CRED, fetcher as never)).toBeNull()
  })
})
