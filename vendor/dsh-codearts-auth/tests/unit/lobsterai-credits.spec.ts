import { describe, expect, it, vi } from 'vitest'
import {
  LOBSTERAI_ACTIVITY_SLOT_PATH,
  LOBSTERAI_PROFILE_SUMMARY_PATH,
  LOBSTERAI_SLOT_CONTAINER_API_VERSION,
  LOBSTERAI_SLOT_PLACEMENT,
  LOBSTERAI_SLOT_PLATFORM,
  claimLobsteraiDailyCheckin,
  fetchLobsteraiActivityContext,
  fetchLobsteraiActivitySlot,
  fetchLobsteraiCreditBalance,
} from '../../src/lobsterai-credits.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

const CLIENT_VERSION = '2026.9.4'

function makeCredential(): LobsteraiCredential {
  return {
    access_token: 'AT', refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    uid: 'uid-1', user_id: 'yid-1', nickname: '测试',
    uuid: 'uuid-1', first_keyfrom: '1700000000000', latest_keyfrom: '1700000000000',
  }
}

/** 记录请求并按 URL 分派的 stub fetch。 */
function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** 槽位可用 + 可签到的标准响应集。 */
function happyPath(overrides: {
  slot?: Record<string, unknown>
  /** 覆盖 context 响应的 `data.state`（如 `{claimedToday:true}`）。 */
  state?: Record<string, unknown>
  /** 覆盖 context 响应的 `data.actions`。 */
  actions?: string[]
  claim?: Record<string, unknown>
} = {}) {
  return (url: string) => {
    if (url.includes('/slot')) {
      return new Response(JSON.stringify({
        code: 0, msg: 'OK',
        data: { slotState: 'available', activity: { activityCode: 'act-1', configRevision: 7 }, ...overrides.slot },
      }), { status: 200 })
    }
    if (url.includes('/actions/check_in')) {
      return new Response(JSON.stringify({
        code: 0, msg: 'OK', data: { result: { creditsGranted: 100 }, ...overrides.claim },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      code: 0, msg: 'OK',
      data: {
        // state 与 actions 分别覆盖：claimedToday 嵌在 state 里，
        // 把它摊平到 data 层会让实现读不到（实现读 data.state.claimedToday）。
        state: { claimedToday: false, ...overrides.state },
        actions: overrides.actions ?? ['check_in'],
      },
    }), { status: 200 })
  }
}

describe('LobsterAI 签到端点常量', () => {
  it('路径与协议一致', () => {
    expect(LOBSTERAI_ACTIVITY_SLOT_PATH).toBe('/api/client-activities/slot')
    expect(LOBSTERAI_PROFILE_SUMMARY_PATH).toBe('/api/user/profile-summary')
  })

  it('槽位固定参数照抄 sigin.py（含 platform=win32 的客户端伪装）', () => {
    expect(LOBSTERAI_SLOT_PLACEMENT).toBe('desktop_sidebar')
    expect(LOBSTERAI_SLOT_CONTAINER_API_VERSION).toBe('2')
    // 即使运行在非 Windows 上也照发 win32：这是伪装客户端形态，与运行环境无关。
    expect(LOBSTERAI_SLOT_PLATFORM).toBe('win32')
  })
})

describe('fetchLobsteraiActivitySlot', () => {
  it('带四个 query 参数（placement / clientVersion / containerApiVersion / platform）', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchLobsteraiActivitySlot(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/api/client-activities/slot')
    expect(url.searchParams.get('placement')).toBe('desktop_sidebar')
    expect(url.searchParams.get('clientVersion')).toBe(CLIENT_VERSION)
    expect(url.searchParams.get('containerApiVersion')).toBe('2')
    expect(url.searchParams.get('platform')).toBe('win32')
  })

  it('解析 slotState 与 activityCode / configRevision', async () => {
    const { fetcher } = stubFetch(happyPath())
    expect(await fetchLobsteraiActivitySlot(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toEqual({ slotState: 'available', activityCode: 'act-1', configRevision: 7 })
  })

  it('请求带 Bearer 且**不含**腾讯系归属头', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchLobsteraiActivitySlot(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer AT')
    for (const banned of ['X-Domain', 'X-Product', 'X-Product-Code', 'X-Enterprise-Id']) {
      expect(headers, banned).not.toHaveProperty(banned)
    }
  })

  it('网络失败返回 null（与「无可用活动」区分）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await fetchLobsteraiActivitySlot(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)).toBeNull()
  })

  it('信封 code 非 0 返回 null', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 200 }))
    expect(await fetchLobsteraiActivitySlot(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)).toBeNull()
  })

  it('data 为 null（凭据失效形态）返回 null', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 0, data: null }), { status: 200 }))
    expect(await fetchLobsteraiActivitySlot(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)).toBeNull()
  })

  it('缺 activity 字段时容错为空值（不抛异常）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { slotState: 'unavailable' },
    }), { status: 200 }))
    expect(await fetchLobsteraiActivitySlot(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toEqual({ slotState: 'unavailable', activityCode: '', configRevision: 0 })
  })
})

describe('fetchLobsteraiActivityContext', () => {
  const slot = { slotState: 'available', activityCode: 'act-1', configRevision: 7 }

  it('请求路径含 activityCode 且带 configRevision', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchLobsteraiActivityContext(makeCredential(), LOBSTERAI, slot, fetcher)
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/api/client-activities/act-1/context')
    expect(url.searchParams.get('configRevision')).toBe('7')
  })

  it('解析 claimedToday 与 actions', async () => {
    const { fetcher } = stubFetch(happyPath())
    expect(await fetchLobsteraiActivityContext(makeCredential(), LOBSTERAI, slot, fetcher))
      .toEqual({ claimedToday: false, actions: ['check_in'] })
  })

  it('activityCode 被 URL 编码（防止路径注入）', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchLobsteraiActivityContext(
      makeCredential(), LOBSTERAI,
      { ...slot, activityCode: 'a/b?c' }, fetcher,
    )
    expect(calls[0]!.url).toContain('/api/client-activities/a%2Fb%3Fc/context')
  })

  it('缺 state 时 claimedToday 视为 false、actions 视为空数组', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
    expect(await fetchLobsteraiActivityContext(makeCredential(), LOBSTERAI, slot, fetcher))
      .toEqual({ claimedToday: false, actions: [] })
  })

  it('网络失败返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    expect(await fetchLobsteraiActivityContext(makeCredential(), LOBSTERAI, slot, fetcher)).toBeNull()
  })
})

describe('claimLobsteraiDailyCheckin', () => {
  it('成功时返回 claimed 与积分，且走完整三步', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    expect(await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toEqual({ kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false })
    expect(calls).toHaveLength(3)
    expect(calls[0]!.url).toContain('/slot')
    expect(calls[1]!.url).toContain('/context')
    expect(calls[2]!.url).toContain('/actions/check_in')
  })

  it('签到请求带 configRevision / idempotencyKey / payload', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
    const body = JSON.parse(String(calls[2]!.init?.body)) as Record<string, unknown>
    expect(body.configRevision).toBe(7)
    expect(body.payload).toEqual({})
    // 客户端幂等键（对齐 sigin.py:63 的 uuid4）。
    expect(String(body.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('每次签到的 idempotencyKey 都不同', async () => {
    const keys: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const { fetcher, calls } = stubFetch(happyPath())
      await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
      keys.push(String((JSON.parse(String(calls[2]!.init?.body)) as { idempotencyKey: string }).idempotencyKey))
    }
    expect(keys[0]).not.toBe(keys[1])
  })

  it('签到用 POST，前两步用 GET', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[1]!.init?.method).toBe('GET')
    expect(calls[2]!.init?.method).toBe('POST')
  })

  it('slotState 非 available 时返回 inactive 且不发后续请求', async () => {
    const { fetcher, calls } = stubFetch(happyPath({ slot: { slotState: 'unavailable' } }))
    const outcome = await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
    expect(outcome.kind).toBe('inactive')
    expect(calls).toHaveLength(1)
  })

  it('无 activityCode 时返回 inactive', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { slotState: 'available', activity: {} },
    }), { status: 200 }))
    const outcome = await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
    expect(outcome.kind).toBe('inactive')
  })

  it('今天已签到返回 already-claimed 且不发签到请求', async () => {
    const { fetcher, calls } = stubFetch(happyPath({ state: { claimedToday: true } }))
    expect(await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toEqual({ kind: 'already-claimed', message: '今天已签到' })
    expect(calls).toHaveLength(2)
  })

  it('actions 不含 check_in 时返回 inactive（活动存在但当前不可签）', async () => {
    const { fetcher, calls } = stubFetch(happyPath({ actions: ['view'] }))
    expect(await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toEqual({ kind: 'inactive', message: '当前不可签到' })
    expect(calls).toHaveLength(2)
  })

  it('积分字段三级回退：creditsGranted → rewardCredits → credits', async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ creditsGranted: 100 }, 100],
      [{ rewardCredits: 50 }, 50],
      [{ credits: 30 }, 30],
      [{}, 0],
    ]
    for (const [fields, expected] of cases) {
      const { fetcher } = stubFetch(happyPath({ claim: { result: fields } }))
      const outcome = await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher)
      expect(outcome, JSON.stringify(fields)).toMatchObject({ kind: 'claimed', credit: expected })
    }
  })

  it('领取响应带 message 时作为 delayedMessage 透出', async () => {
    const { fetcher } = stubFetch(happyPath({ claim: { result: { creditsGranted: 10, message: '积分稍后到账' } } }))
    expect(await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toMatchObject({ kind: 'claimed', delayedMessage: '积分稍后到账' })
  })

  it('槽位查询失败返回 failed（与 inactive 区分）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    expect(await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toMatchObject({ kind: 'failed', code: -1 })
  })

  it('上下文查询失败返回 failed', async () => {
    const { fetcher } = stubFetch((url) => {
      if (url.includes('/slot')) {
        return new Response(JSON.stringify({
          code: 0, data: { slotState: 'available', activity: { activityCode: 'a', configRevision: 1 } },
        }), { status: 200 })
      }
      throw new Error('down')
    })
    expect(await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toMatchObject({ kind: 'failed' })
  })

  it('领取请求信封失败返回 failed 并带上服务端原因', async () => {
    const { fetcher } = stubFetch((url) => {
      if (url.includes('/slot')) {
        return new Response(JSON.stringify({
          code: 0, data: { slotState: 'available', activity: { activityCode: 'a', configRevision: 1 } },
        }), { status: 200 })
      }
      if (url.includes('/actions/check_in')) {
        return new Response(JSON.stringify({ code: 40001, msg: '活动已结束' }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { state: { claimedToday: false }, actions: ['check_in'] } }), { status: 200 })
    })
    expect(await claimLobsteraiDailyCheckin(makeCredential(), LOBSTERAI, CLIENT_VERSION, fetcher))
      .toEqual({ kind: 'failed', code: 40001, message: '活动已结束' })
  })
})

describe('fetchLobsteraiCreditBalance', () => {
  it('请求 profile-summary（**不是** quota —— 后者不含活动积分）', async () => {
    const { fetcher, calls } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: 347.87, creditItems: [] },
    }), { status: 200 }))
    await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(calls[0]!.url).toBe('https://lobsterai-server.youdao.com/api/user/profile-summary')
    expect(calls[0]!.url).not.toContain('/quota')
  })

  it('解析 totalCreditsRemaining', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: 5297.72 },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.total).toBe(5297.72)
  })

  it('把 creditItems 映射为 packages（结构对齐 CodeBuddy 的 CreditBalance）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 150,
        creditItems: [
          { type: 'free', creditsRemaining: 100, expiresAt: '2099-01-01 00:00:00' },
          { type: 'campaign', creditsRemaining: 50, expiresAt: '' },
        ],
      },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.packages).toHaveLength(2)
    expect(balance?.packages[0]).toMatchObject({ name: 'free', remaining: 100, active: true })
    expect(balance?.packages[1]).toMatchObject({ name: 'campaign', remaining: 50, active: true })
  })

  /**
   * 用户报障：账号 hover 列表显示「100 / 0」，期望「100 / 100」。
   *
   * 实测真实响应（2026-09-29 抓包）里**没有**面值字段，只有
   * `creditsRemaining` + `expiresAt`；「每日登录奖励」的面值恒为 100，
   * 没用过的包剩余量 = 面值。⇒ 取「同组有效包剩余量最大值」推断面值。
   */
  it('包名优先用 label（人读的名字）而非 type（机器分类码）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 692.73,
        creditItems: [
          { type: 'campaign', label: '每日登录奖励', creditsRemaining: 92.73, expiresAt: '2026-10-23T01:21:23' },
        ],
      },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.packages[0]!.name).toBe('每日登录奖励')
  })

  it('面值推断：同组有效包的最大剩余量充当 total（100/0 → 100/100）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 692.73,
        creditItems: [
          { type: 'campaign', label: '每日登录奖励', creditsRemaining: 92.73, expiresAt: '2026-10-23T01:21:23' },
          ...Array.from({ length: 6 }, (_, i) => ({
            type: 'campaign', label: '每日登录奖励',
            creditsRemaining: 100, expiresAt: `2026-10-2${i + 4}T00:00:00`,
          })),
        ],
      },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    // 6 个没用过的包：100 / 100
    for (const pkg of balance!.packages.slice(1)) {
      expect(pkg.total).toBe(100)
      expect(pkg.used).toBe(0)
    }
    // 用过的包按同组面值显示：92.73 / 100（used = 7.27）
    expect(balance!.packages[0]).toMatchObject({ remaining: 92.73, total: 100, used: 7.27 })
  })

  it('面值推断不越界：只有被用过的包（无没用过的参照）时如实显示 ?', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 50,
        creditItems: [
          { type: 'campaign', label: '每日登录奖励', creditsRemaining: 50, expiresAt: '2026-10-23T01:21:23' },
        ],
      },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    // 只有一个包且它就是最大值 → total=50 是「这个包自己的剩余量」，
    // 显示 50/50 虽然可能低估面值，但比 50/0 好 —— 用户不再看到分母 0。
    expect(balance!.packages[0]).toMatchObject({ remaining: 50, total: 50 })
  })

  it('已过期的包标 active: false 并计入 expiredTotal（不并入 total）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 100,
        creditItems: [
          { type: 'valid', creditsRemaining: 100, expiresAt: '2099-01-01 00:00:00' },
          { type: 'expired', creditsRemaining: 40, expiresAt: '2000-01-01 00:00:00' },
        ],
      },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.packages[1]!.active).toBe(false)
    expect(balance?.expiredTotal).toBe(40)
  })

  it('无 type 的条目回退为「积分包」', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: 10, creditItems: [{ creditsRemaining: 10 }] },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.packages[0]!.name).toBe('积分包')
  })

  it('余额为 0 且有明细时返回 0（与「查不到」区分）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: 0, creditItems: [{ type: 'free', creditsRemaining: 0 }] },
    }), { status: 200 }))
    expect((await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher))?.total).toBe(0)
  })

  it('既无总额也无明细时返回 null（不把解析失败伪装成 0 积分）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
    expect(await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)).toBeNull()
  })

  it('网络失败返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    expect(await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)).toBeNull()
  })

  it('信封失败返回 null', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 200 }))
    expect(await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)).toBeNull()
  })

  it('多包浮点相加规整为两位小数', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 655.67000031,
        creditItems: [{ type: 'a', creditsRemaining: 1 }],
      },
    }), { status: 200 }))
    expect((await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher))?.total).toBe(655.67)
  })
})
