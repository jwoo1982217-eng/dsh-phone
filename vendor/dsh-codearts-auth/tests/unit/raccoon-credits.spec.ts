import { describe, expect, it } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonOnboardingStatus,
} from '../../src/raccoon-credits.js'
import type { RaccoonCredential } from '../../src/raccoon.js'

const CRED: RaccoonCredential = { access_token: 't', refresh_token: 'r' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchRaccoonCreditBalance', () => {
  it('把 available_points 映射成 total，各池作 package', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        available_points: 6300,
        daily_points: 300,
        monthly_points: 0,
        reward_points: 6000,
        topup_points: 0,
      },
    })
    const balance = await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)
    expect(balance).not.toBeNull()
    expect(balance?.total).toBe(6300)
    const names = balance?.packages.map((p) => p.name)
    expect(names).toContain('奖励积分')
    expect(names).toContain('每日积分')
    expect(names).toContain('充值积分')
  })

  it('请求路径与鉴权头正确', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url)
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
      return jsonResponse({ code: 0, data: { available_points: 1 } })
    }
    await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.pointsApiPrefix}/balance`)
    expect(seenAuth).toBe('Bearer t')
  })

  it('code 非 0 时返回 null（显示原因，不是 0）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 200003, message: 'auth fail' }, 401)
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })

  it('缺 available_points 时返回 null（不编造数字）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: {} })
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })

  it('网络异常时返回 null（不抛错，避免批量查询被单个账号中断）', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })
})

describe('claimRaccoonLoginReward', () => {
  it('granted:true 时返回 claimed 与积分数', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: true, popup: { source: 'desktop_login', points: 3000 } },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(3000)
    }
  })

  it('granted:false 时返回 already-claimed（幂等，不是失败）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: false, popup: null },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('必须带 X-Client-Platform（缺了会被服务端拒）', async () => {
    let seenPlatform = ''
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      seenPlatform = String((init?.headers as Record<string, string> | undefined)?.['X-Client-Platform'] ?? '')
      return jsonResponse({ code: 0, data: { granted: false } })
    }
    await claimRaccoonLoginReward(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenPlatform).toBe(RACCOON.clientPlatform)
    expect(seenPlatform).toMatch(/^desktop-(windows|macos|linux)$/)
  })

  it('请求路径与方法是 POST', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url)
      seenMethod = String(init?.method ?? '')
      return jsonResponse({ code: 0, data: { granted: false } })
    }
    await claimRaccoonLoginReward(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.desktopApiPrefix}/login/points/grant`)
    expect(seenMethod).toBe('POST')
  })

  it('失败时返回 failed 且带原因（不抛错，保证批量领取不中断）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 100006, message: 'boom' }, 400)
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.message.length).toBeGreaterThan(0)
    }
  })

  it('网络异常时返回 failed', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('granted:true 但 popup 缺 points 时用 3000 兜底', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: true },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(3000)
    }
  })
})

describe('fetchRaccoonOnboardingStatus', () => {
  it('账单里已有「桌面端登录奖励」时判为已领', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [
          { event_name: '桌面端登录奖励', biz_type: 'reward_grant', points: 3000 },
          { event_name: '每日积分发放', biz_type: 'daily_grant', points: 300 },
        ],
        paging: { offset: 0, limit: 20, total: 0 },
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(true)
    expect(status.points).toBe(3000)
  })

  it('账单里没有该记录时判为未领', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [{ event_name: '每日积分发放', biz_type: 'daily_grant', points: 300 }],
        paging: { offset: 0, limit: 20, total: 0 },
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('「新人注册礼包」不算作登录奖励（两者是不同来源）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [{ event_name: '新人注册礼包', biz_type: 'reward_grant', points: 3000 }],
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('查询失败时保守判为未领（宁可让用户多点一次）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 1, message: 'err' }, 500)
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
    expect(status.points).toBe(3000)
  })

  it('网络异常时保守判为未领', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('items 非数组时不抛错', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: { items: 'bad' } })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })
})
