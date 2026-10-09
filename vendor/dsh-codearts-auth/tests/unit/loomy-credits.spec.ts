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
