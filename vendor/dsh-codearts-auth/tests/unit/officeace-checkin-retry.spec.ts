/**
 * `officeace-checkin-retry.spec.ts` —— 每日签到**失败必须留痕、且必须允许重试**。
 *
 * ## 真实报障（2026-10-18，用户）

 * 「重新登录了还是没有每日积分」
 *
 * ## 修前的两处静默（都在 `src/officeace-auth.ts`）
 *
 * ```ts
 * } catch { return [] }                      // ① 零日志：失败原因彻底消失
 * lastClaimAt.set(ref, hourKey)              // ② 先占坑
 * return claimDailyBonus(c).catch(() => [])  //    失败也不撤销 ⇒ 本小时被钉死
 * ```
 *
 * 后果链条（实测）：当日签到桶 1000 分 **23:59:59 作废** ⇒ 凭据过期后
 * **连续三天**每天白丢 1000 分，日志与面板**一个字都没有**，
 * 用户只能从「临期桶不见了」反推；而登录是**异步**写凭据库的，
 * 面板刷新与 `login.poll` 会赛跑 —— 刷新若抢在落盘之前拿到旧凭据 ⇒ 401
 * ⇒ 静默失败 ⇒ **该小时后续刷新全部跳过**，直到下一小时才可能领到。
 *
 * ## 守的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 失败返回 `ok:false` **带原因**，不是空数组 | 静默丢分，无从排查 |
 * | 2 | `maybeClaimBonus` 失败时**撤销占坑** ⇒ 同小时内下一次刷新会重试 | 一次赛跑失败 ⇒ 当天 1000 分永久损失 |
 * | 3 | 成功时占坑**保留** ⇒ 同小时不重复打服务端 | 面板每开一次就多发请求 |
 * | 4 | 失败要 `console.warn` 留痕（仓库约定：不允许静默吞） | 用户无从察觉 |
 * | 5 | 凭据缺失 ⇒ `ok:false`，**不发起网络请求** | 无谓请求 + 仍是静默 |
 * | 6 | 签到失败**不改变**「不阻断余额查询」的既有行为 | 修 A 坏 B |
 *
 * ⚠️ 不发真实网络：桩掉全局 `fetch`（`signAndRequest` 走它）。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OfficeAceCredential } from '../../src/officeace-auth.js'

/** 最小可用凭据（字段齐全即可，`signAndRequest` 只做签名不发真请求）。 */
const CRED: OfficeAceCredential = {
  modelAppKey: 'k',
  modelAppSecret: 's',
  maasBaseUrl: 'https://officeace.example',
  access: 'HSTAEXAMPLE',
  secret: 'secret',
  securityToken: 'token',
  projectId: 'cn-southwest-2',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: 'r',
  dpopPrivateJwk: { kty: 'EC', x: 'x', y: 'y', crv: 'P-256', d: 'd' },
}

/** 签到成功响应（`bonus_skus` 形状）。 */
const OK_BODY = JSON.stringify({
  bonus_skus: [{ activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: 1000 }],
})

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** 统计打到签到端点的次数。 */
function stubFetch(respond: () => Response) {
  let claimCalls = 0
  const spy = vi.fn((url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/v1/subscription/bonus/claim')) claimCalls += 1
    return Promise.resolve(respond())
  })
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return { get calls() { return claimCalls } }
}

describe('OfficeAce 每日签到：失败必须留痕且允许重试', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('① 失败返回 ok:false 且**带原因**（不是空数组 —— 静默丢分的根源）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    stubFetch(() => jsonResponse('{"error":"unauthorized"}', 401))
    const result = await claimDailyBonus(CRED)
    expect(result.ok, '失败必须能被识别（原实现返回 []，与「没有可领的」同形）').toBe(false)
    if (!result.ok) {
      expect(result.reason.length, '原因不得为空 —— 空字符串等于没说').toBeGreaterThan(0)
      expect(result.reason).toContain('401')
    }
  })

  it('② 成功返回 ok:true + 活动桶（形状与旧实现一致）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    stubFetch(() => jsonResponse(OK_BODY))
    const result = await claimDailyBonus(CRED)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skus).toEqual([
        { activityId: 'bonus-daily-checkin-2026', activityName: '每日签到有礼', points: 1000 },
      ])
    }
  })

  it('⑤ 凭据缺失 ⇒ ok:false 且**零网络请求**（不发无谓请求、也不是静默）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    const stub = stubFetch(() => jsonResponse(OK_BODY))
    const result = await claimDailyBonus({ ...CRED, access: '', securityToken: '' })
    expect(result.ok).toBe(false)
    expect(stub.calls, '凭据缺失不该发起签到请求').toBe(0)
  })

  /**
   * ⚠️ 核心用例：`maybeClaimBonus` 是模块私有函数，通过
   * `fetchSubscriptionSummary` 的**真实路径**驱动（它在查余额前会先调签到）。
   */
  it('★② 失败撤销占坑 ⇒ 同小时内**下一次**刷新会重试（一次赛跑失败不再钉死当天）', async () => {
    const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
    // 第一次签到 401（模拟登录异步落盘前抢跑），之后成功。
    let n = 0
    const stub = stubFetch(() => {
      n += 1
      return n === 1 ? jsonResponse('{"error":"unauthorized"}', 401) : jsonResponse(OK_BODY)
    })
    // 其余云侧请求一律失败 ⇒ 走缓存/未登录路径，但签到已在最前面发生。
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const warnSpy = vi.mocked(console.warn)

    const cred = CRED
    await fetchSubscriptionSummary(48, 'REF_A', cred).catch(() => undefined)
    const afterFirst = stub.calls
    await fetchSubscriptionSummary(48, 'REF_A', cred).catch(() => undefined)

    expect(afterFirst, '第一次必须真的发了签到请求').toBe(1)
    expect(stub.calls, '★ 失败后同小时的第二次刷新必须重试（原实现被占坑钉死 ⇒ 当天 1000 分白丢）')
      .toBeGreaterThan(afterFirst)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('每日签到失败')),
      '★ 失败必须 console.warn 留痕（原实现零日志）').toBe(true)
  })

  it('★③ 成功占坑保留 ⇒ 同一小时内**不重复**打服务端（节流仍然有效）', async () => {
    const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
    const stub = stubFetch(() => jsonResponse(OK_BODY))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await fetchSubscriptionSummary(48, 'REF_B', CRED).catch(() => undefined)
    await fetchSubscriptionSummary(48, 'REF_B', CRED).catch(() => undefined)
    await fetchSubscriptionSummary(48, 'REF_B', CRED).catch(() => undefined)

    expect(stub.calls, '成功后重复刷新不该重复打签到端点').toBe(1)
  })

  it('⑥ 签到失败**不阻断**余额查询（既有行为不得被修坏）', async () => {
    const { claimDailyBonus } = await import('../../src/officeace-auth.js')
    stubFetch(() => jsonResponse('{"error":"boom"}', 500))
    await expect(claimDailyBonus(CRED)).resolves.toMatchObject({ ok: false })
    // ⚠️ 关键：不抛错 —— 调用方 `await maybeClaimBonus(...)` 之后照常查余额。
  })
})
