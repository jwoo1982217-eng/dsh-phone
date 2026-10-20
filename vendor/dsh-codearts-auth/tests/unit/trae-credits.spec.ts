/**
 * `src/trae-credits.ts` 的单元测试。
 *
 * 全部用桩 fetcher，**不发任何真实网络请求**。
 *
 * ⚠️ 新实现（对齐 trae-mate）的关键行为变更：
 * - 9074 **不再重试**（设备身份基于 user_id 确定性派生，天然独立，不需要轮换）
 * - claim body 改为 `{}`，而非 `{"req_source":2}`
 * - 请求头使用完整客户端头（约 20 个），而非简化的 Ug 头
 * - 错误分类 + 冷却信息通过 `errorType` / `cooldownSecs` 返回
 */

import { describe, expect, it } from 'vitest'
import {
  TRAE_CHECKIN_BUSY_CODE,
  claimTraeDailyCheckin,
  fetchTraeCheckinStatus,
  fetchTraeCreditBalance,
  classifyTraeCheckinError,
} from '../../src/trae-credits.js'
import { TRAE } from '../../src/trae-product.js'
import { BuddyBalanceSelector, pickBuddyAccount } from '../../src/buddy-balance-selector.js'
import type { TraeCredential } from '../../src/trae.js'

function makeCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'uid-1',
    nickname: '测试账号',
    machine_id: 'a'.repeat(32),
    device_id: 'c'.repeat(32),
    ...overrides,
  }
}

/** 桩 fetcher：按调用次序返回给定的响应体，并记录调用次数。 */
function stubFetcher(payloads: unknown[]): { fetcher: typeof fetch; calls: number } {
  let calls = 0
  const fetcher = (async () => {
    calls++
    const next = payloads.shift()
    if (next === undefined) throw new Error('unexpected fetch call')
    return new Response(JSON.stringify(next), { status: 200 })
  }) as unknown as typeof fetch
  return { fetcher, calls: calls }
}

/** 返回 { success, errorType, cooldownSecs } 辅助断言。 */
function failedWith(outcome: unknown): { errorType?: string; cooldownSecs?: number } {
  const o = outcome as Record<string, unknown>
  return { errorType: o.errorType as string, cooldownSecs: o.cooldownSecs as number }
}

describe('claimTraeDailyCheckin · 对齐 trae-mate', () => {
  /**
   * ⚠️ **claim 响应不含积分数**（真实缺陷回归）。
   *
   * 实测（2026-09-20）claim 的完整响应就是 `{"code":0,"message":"success"}` ——
   * 没有任何 credits 字段。早期实现读 `body.credits`，于是**恒为 0**，界面显示
   * 「1 个账号领取成功（+0 积分）」而 IDE 里明明写着 150（用户报障）。
   *
   * 真实数值只在 **status 端点**的 `credits` 字段里（实测 `credits:150`，与积分
   * 余额中「签到奖励」包的 `credits_limit:150` 完全吻合）。故领取成功后补查一次
   * 状态。桩按调用次序返回：第 1 次 claim、第 2 次 status。
   */
  it('成功时从 status 补查真实所得（claim 响应本身没有数量）', async () => {
    const { fetcher } = stubFetcher([
      { code: 0, message: 'success' },                        // claim
      { code: 0, checked_in: true, credits: 150, streak_days: 3, enable: true }, // status
    ])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150, streakDays: 3 })
  })

  it('补查失败时 credit 为 0，但仍是 claimed（不因补查而判失败）', async () => {
    // status 返回非 0 业务码 → fetchTraeCheckinStatus 返回 null → credit 兜底 0。
    const { fetcher } = stubFetcher([
      { code: 0, message: 'success' },
      { code: 500, message: 'oops' },
    ])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 0 })
  })

  it('⚠️ 不再从 claim 响应读 credits（那是恒 0 的旧缺陷）', async () => {
    // 即便 claim 响应**伪造**一个 credits，也不该采信 —— 真实协议里没有该字段。
    const { fetcher } = stubFetcher([
      { code: 0, message: 'success', credits: 999 },
      { code: 0, checked_in: true, credits: 150, enable: true },
    ])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150 })
  })

  it('9074 不再重试（基于 user_id 确定性派生设备身份，天然独立）', async () => {
    const { fetcher } = stubFetcher([{ code: TRAE_CHECKIN_BUSY_CODE, message: 'too many users' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'failed', code: TRAE_CHECKIN_BUSY_CODE })
    // 只有一次请求（不再做设备轮换重试）
  })

  it('9074 返回 BusinessError + 300s 冷却', async () => {
    const { fetcher } = stubFetcher([{ code: TRAE_CHECKIN_BUSY_CODE, message: 'too many users' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(failedWith(outcome)).toMatchObject({ errorType: 'BusinessError', cooldownSecs: 300 })
  })

  it('其它业务码如实回报（不重试）', async () => {
    const { fetcher } = stubFetcher([{ code: 9004, message: 'device required' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'failed', code: 9004, message: 'device required' })
  })

  it('⚠️ 字符串形态的 "9074" 也要被正确识别', async () => {
    const { fetcher } = stubFetcher([{ code: '9074', message: 'too many users' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'failed', code: 9074 })
  })

  it('HTTP 失败时报 failed', async () => {
    const fetcher = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(-1)
  })
})

describe('classifyTraeCheckinError（对齐 trae-mate cooldown.rs）', () => {
  it('200 + code=1005 → PlanLimit, 43200s', () => {
    expect(classifyTraeCheckinError(200, 1005)).toMatchObject({ type: 'PlanLimit', cooldownSecs: 43200 })
  })
  it('429 → SoftRate, 60s', () => {
    expect(classifyTraeCheckinError(429, undefined)).toMatchObject({ type: 'SoftRate', cooldownSecs: 60 })
  })
  it('401 → SessionDead, 永久', () => {
    expect(classifyTraeCheckinError(401, undefined)).toMatchObject({ type: 'SessionDead', cooldownSecs: -1 })
  })
  it('404 → NotFound, 60s', () => {
    expect(classifyTraeCheckinError(404, undefined)).toMatchObject({ type: 'NotFound', cooldownSecs: 60 })
  })
  it('5xx → Server, 600s', () => {
    expect(classifyTraeCheckinError(502, undefined)).toMatchObject({ type: 'Server', cooldownSecs: 600 })
  })
  it('4xx → Client, 600s', () => {
    expect(classifyTraeCheckinError(400, 1000)).toMatchObject({ type: 'Client', cooldownSecs: 600 })
  })
  it('业务码非0 → BusinessError, 300s', () => {
    expect(classifyTraeCheckinError(200, 1000)).toMatchObject({ type: 'BusinessError', cooldownSecs: 300 })
  })
  it('code=0 或 undefined → Unknown, 0s', () => {
    expect(classifyTraeCheckinError(200, 0)).toMatchObject({ type: 'Unknown', cooldownSecs: 0 })
    expect(classifyTraeCheckinError(200, undefined)).toMatchObject({ type: 'Unknown', cooldownSecs: 0 })
  })
})

describe('fetchTraeCheckinStatus / fetchTraeCreditBalance', () => {
  it('状态查询读 checked_in / credits / enable', async () => {
    const { fetcher } = stubFetcher([{ checked_in: true, credits: 100, enable: true }])
    const status = await fetchTraeCheckinStatus(makeCredential(), TRAE, fetcher)
    expect(status).toMatchObject({ todayCheckedIn: true, dailyCredit: 100, active: true })
  })

  it('余额按 pack 累加 credits_limit - credits_amount', async () => {
    const { fetcher } = stubFetcher([{
      user_entitlement_pack_list: [
        { entitlement_base_info: { quota: { credits_limit: 500 } }, usage: { credits_amount: 120 } },
        { entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 0 } },
        { entitlement_base_info: { quota: { credits_limit: 0 } }, usage: { credits_amount: 0 } },
      ],
    }])
    const balance = await fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)
    expect(balance?.total).toBe(480)
  })

  it('无资源包时返回 0 余额（不是 null）—— 区分「真没钱」与「查不到」', async () => {
    // ⚠️ 2026-10-06 PR !68 审计修正：本 provider **没有独立的总额字段**，
    // `total` 完全由 `packList` 累加而来 ⇒ 空列表**确凿等于 0 余额**。
    // 早先把空列表也 `return null`，于是「锁定永久积分 + 账号真没钱」会落到
    // 选号器的「查询失败」分支，报成「无法确认是否有可用账号…请检查凭据是否失效」
    // —— 用户明明是没钱，却被引导去查凭据（与 qoder 110 / 排队 10605 同型误报）。
    const { fetcher } = stubFetcher([{ user_entitlement_pack_list: [] }])
    const balance = await fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)
    expect(balance).not.toBeNull()
    expect(balance?.total).toBe(0)
    expect(balance?.packages).toEqual([])
  })

  it('★ 字段缺失 / 不是数组时仍返回 null（结构异常 = 真的查不到）', async () => {
    // 这一侧**必须**与「空列表」分开：拿不到列表就无法确认余额是 0 还是查询失败。
    const missing = stubFetcher([{}])
    expect(await fetchTraeCreditBalance(makeCredential(), TRAE, missing.fetcher)).toBeNull()
    const notArray = stubFetcher([{ user_entitlement_pack_list: 'oops' }])
    expect(await fetchTraeCreditBalance(makeCredential(), TRAE, notArray.fetcher)).toBeNull()
  })

  it('★ 空列表在锁定时必须报「已用尽」而不是「查不到」（真实链路回归）', async () => {
    // 走选择器 → 编排的**真实链路**，断言用户可见的文案分叉。
    const selector = new BuddyBalanceSelector({
      product: TRAE,
      resolveCredential: async () => makeCredential(),
      fetchBalance: async () => {
        const { fetcher } = stubFetcher([{ user_entitlement_pack_list: [] }])
        return fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)
      },
    })
    const picked = await pickBuddyAccount(
      selector,
      [{ id: 'a1', credentialRef: 'a1' }],
      { allowPermanent: false, resolveCredential: async () => makeCredential() },
    )
    expect(picked.kind).toBe('locked')
    // 'exhausted' ⇒ 报「积分都已用尽」；'unknown' ⇒ 报「无法确认…检查凭据」（误报）
    expect(picked.kind === 'account' ? 'account' : picked.reason?.kind).toBe('exhausted')
  })

  /**
   * 用户报障：hover 显示 500 和 3 个 150 都是「永久」，但 500 明明 9/30 到期
   * （15 天窗口内）。
   *
   * 2026-09-29 抓包取证：服务端在**条目级**直接下发 `expire_time`
   * （**秒级** Unix 时间戳，1790783999 = 2026-09-30 23:59:59），包名在
   * `display_desc`（"每月登录赠送"/"签到奖励"）而非 `base.name`（实测 undefined）。
   * 早前"起始日期+31天"的推断方案被推翻 —— 不需要推断，直接读真值。
   */
  it('到期读条目级 expire_time（秒→毫秒），包名读 display_desc', async () => {
    const { fetcher } = stubFetcher([{
      user_entitlement_pack_list: [
        {
          entitlement_base_info: {
            display_desc: '每月登录赠送',
            quota: { credits_limit: 500 },
            start_time: 1788192000, end_time: 1790783999,
          },
          expire_time: 1790783999,
          usage: {},
        },
        {
          entitlement_base_info: { display_desc: '签到奖励', quota: { credits_limit: 150 } },
          expire_time: 1793119698,
          usage: {},
        },
        { // expire_time 缺失/为 0 → 不设置 deductionEndTime（前端显示"永久"）
          entitlement_base_info: { display_desc: '签到奖励', quota: { credits_limit: 150 } },
          expire_time: 0,
          usage: {},
        },
      ],
    }])
    const balance = await fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)
    expect(balance?.packages[0]).toMatchObject({
      name: '每月登录赠送',
      deductionEndTime: 1790783999_000, // 秒 → 毫秒
    })
    expect(balance?.packages[1]).toMatchObject({ name: '签到奖励', deductionEndTime: 1793119698_000 })
    expect(balance?.packages[2]!.deductionEndTime).toBeUndefined()
  })

  it('base.name 缺失时（实测为 undefined）回退 entry.display_desc，再回退「资源包」', async () => {
    const { fetcher } = stubFetcher([{
      user_entitlement_pack_list: [
        { entitlement_base_info: { quota: { credits_limit: 100 } } }, // 全都没给
      ],
    }])
    const balance = await fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)
    expect(balance?.packages[0]!.name).toBe('资源包')
  })
})
