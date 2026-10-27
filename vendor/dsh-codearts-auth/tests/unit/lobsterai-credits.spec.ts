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

  it('总额字段在但是 0 且无明细 → 返回 0（余额真的为空，2026-10-10 彻查）', async () => {
    // 实测 5/6 账号：profile-summary 200 + totalCreditsRemaining:0 + creditItems:[]。
    // 旧实现返回 null ⇒ 面板「余额查询失败」，用户误读成账号失效（调用层当天 0 错误）。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: 0, creditItems: [] },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.total).toBe(0)
    expect(balance?.packages).toHaveLength(0)
    expect(balance?.expiredTotal).toBe(0)
  })

  it('既无总额也无明细时返回 null（不把解析失败伪装成 0 积分）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
    expect(await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)).toBeNull()
  })

  /**
   * ★★ 判据必须是「**能不能解析成数字**」，不能是「键存不存在」。
   *
   * 真实缺陷（2026-10-12 实测）：`envelope.data.totalCreditsRemaining === undefined`
   * 只挡住「键缺失」，于是**非数字**的值会被当成「服务端明确下发 0」——
   * 把「解析失败」伪装成「余额 0」，正是上面那条注释想防的事，只换了入口。
   *
   * ⚠️ 这三条**必须能抓到该差异**（每条都做过变异验证：把判据退回
   * `=== undefined` ⇒ 三条全红；放宽成 `'in data'` ⇒ 第三条红）。
   */
  it('★ 总额字段值为 null 且无明细 → 仍返回 null（非数字不算「明确下发」）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: null, creditItems: [] },
    }), { status: 200 }))
    expect(
      await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher),
      'null 被当成了「明确下发 0」',
    ).toBeNull()
  })

  it('★ 总额字段为非数字串且无明细 → 仍返回 null', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: 'abc', creditItems: [] },
    }), { status: 200 }))
    expect(
      await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher),
      '非数字串被当成了「明确下发 0」',
    ).toBeNull()
  })

  it('★ 超长数字串（溢出成 Infinity）→ 归「解析失败」而非「明确下发」', async () => {
    // ⚠️ 正则 `/^-?\d+(\.\d+)?$/` 只保证「长得像定点数字」，**不保证落在
    //    double 范围内** —— 401 位纯数字串能过正则，而 `Number(...)` 得到
    //    `Infinity`。少了 `Number.isFinite`，这里会透出 `total: Infinity`
    //    （JSON 序列化成 `null`，卡片显示异常）。
    const huge = '9'.repeat(401)
    expect(Number(huge)).toBe(Number.POSITIVE_INFINITY) // 前提：确实溢出
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: huge, creditItems: [] },
    }), { status: 200 }))
    expect(await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)).toBeNull()
  })

  it('★ 反例：字符串 "0" 与正常范围字符串仍照常解析（守卫不得误伤）', async () => {
    for (const [raw, want] of [['0', 0], ['123.45', 123.45]] as const) {
      const { fetcher } = stubFetch(() => new Response(JSON.stringify({
        code: 0, data: { totalCreditsRemaining: raw, creditItems: [] },
      }), { status: 200 }))
      expect(
        (await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher))?.total,
        `字符串 ${JSON.stringify(raw)} 应解析为 ${want}`,
      ).toBe(want)
    }
  })

  /**
   * ★★ **`Number.isFinite` 不够**：还要卡上界（2026-10-12 审计实测）。
   *
   * `Number.isFinite` 只排除 `Infinity`/`NaN`，**不排除「有限但下游会溢出」
   * 的值**：下游 `roundCredits(v) = Math.round(v * 100) / 100` 里 `v * 100`
   * 在 `|v| > Number.MAX_VALUE / 100 ≈ 1.797e306` 时**自己溢出**。
   * ⇒ 308 位串与 JSON 合法字面量 `1e308` 都能骗过 `Number.isFinite`，
   *   却在 `roundCredits` 里变成 `Infinity`（JSON 序列化成 `null`）。
   *
   * ⚠️ 上一版只测了 401 位串 —— 那**恰好**是 `Number.isFinite` 挡得住的那一点，
   * 于是「已挡住 Infinity」这个结论**看起来成立**，实际漏了真正能绕过的路径。
   */
  it('★★ 308 位数字串（有限但下游会溢出）→ 必须归「解析失败」', async () => {
    const s308 = '9'.repeat(308)
    // 前提：确实「有限」（否则测的就不是上界这条腿了）
    expect(Number.isFinite(Number(s308)), '前提：308 位串应是有限数').toBe(true)
    // 且下游 roundCredits 确实会溢出（证明上界守卫是必要的）
    expect(Math.round(Number(s308) * 100) / 100).toBe(Number.POSITIVE_INFINITY)
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: s308, creditItems: [] },
    }), { status: 200 }))
    expect(await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)).toBeNull()
  })

  it('★★ JSON 合法字面量 1e308（数字形态）→ 同样必须归「解析失败」', async () => {
    // ⚠️ 这条走**数字分支**（不是字符串），证明两个分支的上界守卫都在。
    expect(Number.isFinite(1e308), '前提：1e308 是有限数').toBe(true)
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { totalCreditsRemaining: 1e308, creditItems: [] },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance).toBeNull()
  })

  it('★★ 上界不得误伤：1e15 与以内的真实量级照常解析', async () => {
    for (const [raw, want] of [[1e15, 1e15], [999999999.99, 999999999.99], ['1e6', undefined]] as const) {
      const { fetcher } = stubFetch(() => new Response(JSON.stringify({
        code: 0, data: { totalCreditsRemaining: raw, creditItems: [] },
      }), { status: 200 }))
      const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
      if (want === undefined) {
        // ⚠️ `'1e6'` 是**字符串**科学计数 —— 正则不认，如实归「解析失败」。
        //    这里**不是**上界守卫的功劳，而是「只认定点写法」的既有口径。
        expect(balance, `字符串 ${JSON.stringify(raw)} 不在定点写法内`).toBeNull()
      } else {
        expect(balance?.total, `${raw} 不应被上界误伤`).toBe(want)
      }
    }
  })

  /**
   * ★★ **有明细时同样不得把非法 total 伪装成 0**（2026-10-12 审计实测）。
   *
   * 旧判据 `if (!hasTotal && packages.length === 0) return null` 只在**无明细**
   * 时生效 ⇒ `packages.length > 0` 时 `total` 仍是 `readNumber` 的兜底 0，
   * 于是「解析失败」照样伪装成「余额 0」—— 与本次要修的是同一件事，
   * 只是发生在另一条分支上。上一版的 4 条测试全部用 `creditItems: []`，
   * **系统性避开了这条路径**。
   */
  it('★★ 有明细 + total 为 null → 用明细合计兜底，不得伪装成 0', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: null,
        creditItems: [{ creditsRemaining: 50, expiresAt: '2099-01-01 00:00:00' }],
      },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance, '有明细时不该返回 null').not.toBeNull()
    expect(balance?.total, '应取明细里有效包的合计（50），而不是伪造 0').toBe(50)
  })

  it('★★ 有明细 + total 为 308 位溢出串 → 同样用明细合计兜底', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: '9'.repeat(308),
        creditItems: [{ creditsRemaining: 77, expiresAt: '2099-01-01 00:00:00' }],
      },
    }), { status: 200 }))
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.total, '非法 total 时应回落到明细合计').toBe(77)
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
