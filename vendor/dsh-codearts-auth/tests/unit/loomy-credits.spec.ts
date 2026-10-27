import { describe, expect, it, vi } from 'vitest'
import { LOOMY } from '../../src/loomy-product.js'
import {
  claimLoomyDailyQuota,
  fetchLoomyCreditBalance,
  fetchLoomyCreditDetail,
} from '../../src/loomy-credits.js'
import type { LoomyCredential } from '../../src/loomy.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '13011112222',
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: '000000', desc: '成功', trace_id: 't', data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}
function bizError(code: string, desc: string): Response {
  return new Response(JSON.stringify({ code, desc, trace_id: 't', data: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** 实测的 points/records 响应（2026-09-26 本机账号）。 */
const RECORDS = {
  balance: 15000,
  dailyBalance: 4992,
  availableBalance: 19992,
  pageNo: 1, pageSize: 1, total: 17,
  list: [{ ledgerId: 'pl_x', direction: 'credit', pointsActual: 5000, description: '注册奖励' }],
}

/** 实测的 first-login 响应（2026-09-26 本机账号）。 */
const FIRST_LOGIN = {
  alreadyProcessed: true,
  currentBalance: 19992,
  permanentBalance: 15000,
  dailyBalance: 4992,
  dailyQuota: 5000,
  dailyConsumed: 8,
  dailyCycleDate: '2026-09-26',
  registerReward: 0, inviteeReward: 0, inviterReward: 0,
}

describe('fetchLoomyCreditDetail', () => {
  it('从 points/records 读出两个池（只读，不发写请求）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope(RECORDS))
    const detail = await fetchLoomyCreditDetail(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(detail).toEqual({
      permanent: 15000,
      daily: 4992,
      total: 19992,
      // points/records **不返回** dailyQuota —— 只有 first-login 才有
      dailyQuota: undefined,
      dailyConsumed: undefined,
      dailyCycleDate: undefined,
    })

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).token).toBe(CRED.access_token)
  })

  it('响应缺字段时返回 null（不编造 0）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ pageNo: 1 }))
    expect(await fetchLoomyCreditDetail(CRED, LOOMY, fetcher as unknown as typeof fetch)).toBeNull()
  })

  /**
   * ★★ **只有两个池都读不到才判失败**（issue IKMCOO 缺陷 4，2026-10-16）。
   *
   * 原判据是 `if (permanent === undefined) return null`（只看 `balance`），
   * 而同一函数内 `daily` 缺失却按 0 宽容处理 —— 两种口径自相矛盾。
   *
   * ## 为什么是真缺陷而不是风格问题
   *
   * 选号口径（`loomy-balance-rank.ts`）在**锁定永久积分时只看 `daily`**：
   * 上游省略 `balance` 时，一个**今日额度可用**的号会被判成「查询失败」
   * → 落入 `none` 档 → 锁定时被踢出候选 ⇒ 症状与「用户明明有今日额度
   * 却不可用」完全同型（正是本 issue 的核心症状）。
   *
   * ⚠️ 本机 2026-10-16 实测 4 个账号两字段都在 ⇒ 该缺陷**当时未触发**，
   *   但它结构上可达。**如实登记：这是「修好口径」，不是「修好实测故障」。**
   */
  it('★★ 缺 `balance` 但有 `dailyBalance` ⇒ 仍算查到了（不判整体失败）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ dailyBalance: 4992, pageNo: 1 }))
    const detail = await fetchLoomyCreditDetail(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(detail, '★★ 有今日额度就不该判查询失败').not.toBeNull()
    expect(detail!.daily).toBe(4992)
    // ⚠️ `permanent` 必须是 `undefined`（**不是 0**）：「上游没给」与
    //   「真的是 0」是不同事实，折叠成 0 会让面板显示「永久积分 0」。
    expect(detail!.permanent, '★ 缺失不得编造成 0').toBeUndefined()
  })

  it('★ 缺 `balance` 时 total 仍按「已知的那一池」算（不得整笔丢失）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ dailyBalance: 4992 }))
    const detail = await fetchLoomyCreditDetail(CRED, LOOMY, fetcher as unknown as typeof fetch)
    // 无 availableBalance ⇒ 用 (permanent ?? 0) + daily
    expect(detail!.total).toBe(4992)
  })

  it('★ 两池都有值时行为与旧版逐字节一致（本次只修「缺字段」这一格）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope(RECORDS))
    const detail = await fetchLoomyCreditDetail(CRED, LOOMY, fetcher as unknown as typeof fetch)
    expect(detail!.permanent).toBe(15000)
    expect(detail!.daily).toBe(4992)
    expect(detail!.total).toBe(19992)
  })

  it('100002 时返回 null（卡片显示原因而非 0）', async () => {
    const fetcher = vi.fn().mockResolvedValue(bizError('100002', '登录已失效，请重新登录'))
    expect(await fetchLoomyCreditDetail(CRED, LOOMY, fetcher as unknown as typeof fetch)).toBeNull()
  })
})

describe('fetchLoomyCreditBalance', () => {
  it('把两池映射成 CreditBalance（永久 + 每日各一个 package）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope(RECORDS))
    const balance = await fetchLoomyCreditBalance(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(balance).not.toBeNull()
    // total 用 availableBalance（永久 + 每日）
    expect(balance!.total).toBe(19992)
    expect(balance!.packages).toHaveLength(2)
    expect(balance!.packages[0]!.name).toBe('永久积分')
    expect(balance!.packages[0]!.remaining).toBe(15000)
    expect(balance!.packages[1]!.name).toBe('每日赠送')
    expect(balance!.packages[1]!.remaining).toBe(4992)
    // 两池都算有效，没有失效额度
    expect(balance!.expiredTotal).toBe(0)
    expect(balance!.packages.every((p) => p.active)).toBe(true)
  })

  /**
   * ★ 缺 `balance` 时**不得**造一个「永久积分 0」的包（issue IKMCOO 缺陷 4）。
   *
   * ⚠️ 造出来会让面板显示「永久积分 0」，而事实是「**上游没报这个池**」——
   *    用户会以为永久积分被烧光了。
   */
  it('★ 缺 `balance` 时不造「永久积分 0」的包', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ dailyBalance: 4992 }))
    const balance = await fetchLoomyCreditBalance(CRED, LOOMY, fetcher as unknown as typeof fetch)
    expect(balance!.packages.map((p) => p.name), '★ 只有上游真给了才渲染那个池')
      .toEqual(['每日赠送'])
  })
})

/**
 * 「一键签到」= `POST /points/first-login`。
 *
 * ⚠️ 语义不是「+5000 积分」，而是**触发每日额度重置**：实测
 * `dailyBalance = dailyQuota - dailyConsumed`（4992 = 5000 - 8），
 * 消耗后不回补。故文案不能写成「+5000 积分」。
 */
describe('claimLoomyDailyQuota', () => {
  it('首次处理返回 claimed（带每日额度）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ ...FIRST_LOGIN, alreadyProcessed: false }))
    const outcome = await claimLoomyDailyQuota(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(outcome.kind).toBe('claimed')
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://loomyad.xunfei.cn/api/v1/points/first-login')
    expect(init.method).toBe('POST')
  })

  it('alreadyProcessed=true 时返回 already-claimed（幂等，不当成失败）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope(FIRST_LOGIN))
    const outcome = await claimLoomyDailyQuota(CRED, LOOMY, fetcher as unknown as typeof fetch)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('100002 时返回 failed 并带服务端文案', async () => {
    const fetcher = vi.fn().mockResolvedValue(bizError('100002', '登录已失效，请重新登录'))
    const outcome = await claimLoomyDailyQuota(CRED, LOOMY, fetcher as unknown as typeof fetch)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message).toContain('登录已失效')
  })

  it('网络失败时返回 failed（不抛，保证批量领取不中断）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const outcome = await claimLoomyDailyQuota(CRED, LOOMY, fetcher as unknown as typeof fetch)
    expect(outcome.kind).toBe('failed')
  })
})
