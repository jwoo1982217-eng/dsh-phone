/**
 * Qoder「账号尚未开通每日领取」判据的回归用例。
 *
 * ## 真实缺陷（用户报障，2026-09-26）
 *
 * 用本插件经 GitHub 授权**新注册**的 Qoder 账号，一键签到显示
 * 「当前没有可领取的活动」。用户以为是我们没做对，判断道：
 * 「需要 qoder 登录后在 `~\.qoder` 下建立对应用户的 … 才能正确领取，
 * 我们需要这种情况下**提醒用户用 qoder 登录账号**」。
 *
 * 实测证明**不是设备身份问题**（4 个 uid 经 `runtime-info.exe` 产出**完全相同**
 * 的 token/type，即身份是设备级），而是**该账号在 Qoder 侧确实没有每日领取
 * 活动**。对照数据（2026-09-26，同机同时刻，两个信号 4/4 命中）：
 *
 * | 账号 | 来源 | `~/.qoder/.models/<uid>` | `addOnQuota` | `CLAIM_BENEFIT` |
 * |---|---|---|---|---|
 *
 * ⚠️ 判据取**服务端信号**（`addOnQuota` 字段缺失），不读本机文件 ——
 * 本机目录信号虽也 4/4 命中，但清过缓存或换机器时会误报。
 */

import { describe, expect, it } from 'vitest'
import {
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
  isQoderNotActivated,
  type QoderCampaigns,
} from '../../src/qoder-credits.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

/** 已开通账号的用量响应（`addOnQuota` 存在）。 */
const USAGE_ACTIVATED = {
  qoderUsage: {
    userType: 'personal_standard',
    userQuota: { total: 0, used: 0, remaining: 0 },
    addOnQuota: { total: 100, used: 0, remaining: 100 },
  },
}

/** 未开通账号的用量响应（**完全没有 `addOnQuota` 字段** —— 实测形状）。 */
const USAGE_NOT_ACTIVATED = {
  qoderUsage: {
    userType: 'personal_standard',
    isQuotaExceeded: true,
    userQuota: { total: 0, used: 0, remaining: 0 },
  },
}

/** 有 CLAIM_BENEFIT 的活动列表。 */
const CAMPAIGNS_WITH_BENEFIT: QoderCampaigns = {
  showCampaign: true,
  claimable: false,
  campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' }],
}

/** 只有 VIEW_DETAILS 的活动列表（未开通账号的实测形状）。 */
const CAMPAIGNS_ONLY_VIEW: QoderCampaigns = {
  showCampaign: true,
  claimable: true,
  campaigns: [{ campaignId: 'c1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMABLE' }],
}

/** 空列表。 */
const CAMPAIGNS_EMPTY: QoderCampaigns = { showCampaign: false, claimable: false, campaigns: [] }

describe('isQoderNotActivated', () => {
  /** 实测的未开通形态：无 CLAIM_BENEFIT + addOnQuota 缺失。 */
  it('无 CLAIM_BENEFIT 且 addOnQuota 缺失 → 判为未开通', () => {
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, USAGE_NOT_ACTIVATED)).toBe(true)
    expect(isQoderNotActivated(CAMPAIGNS_EMPTY, USAGE_NOT_ACTIVATED)).toBe(true)
  })

  /** 实测的已开通形态：老账号 `addOnQuota` 总在（哪怕额度用尽）。 */
  it('addOnQuota 存在即视为已开通（即使额度为 0）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, USAGE_ACTIVATED)).toBe(false)
    // ⚠️ 关键反例：额度用尽的**老**账号 addOnQuota 仍在（remaining=0），
    // 若判据写成「remaining === 0」就会把这类账号误报成「未开通」。
    const exhausted = { qoderUsage: { addOnQuota: { total: 100, used: 100, remaining: 0 } } }
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, exhausted)).toBe(false)
  })

  it('有 CLAIM_BENEFIT 时一律不算未开通（哪怕 addOnQuota 缺失）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_WITH_BENEFIT, USAGE_NOT_ACTIVATED)).toBe(false)
  })

  /**
   * ⚠️ 取不到数据时**保守判 false**（不提示）。
   *
   * 宁可少提示，也不能把「网络抖动没查到」误报成「你的账号没开通」——
   * 后者会让用户白跑一趟官方客户端。
   */
  it('活动列表或用量取不到时保守返回 false（不误报）', () => {
    expect(isQoderNotActivated(undefined, USAGE_NOT_ACTIVATED)).toBe(false)
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, undefined)).toBe(false)
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, null)).toBe(false)
    // 形状非法
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, {})).toBe(false)
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, { qoderUsage: null })).toBe(false)
  })
})

/**
 * ⚠️ **`actionRequired` 字段的回归（2026-09-26 用户报障）**。
 *
 * 用户指出：不该让前端靠**文案**去猜「这条提示要不要单独展示」，
 * 应该改造 `ClaimOutcome` 让语义显式。故加了可选字段
 * `actionRequired?: boolean`（`CheckinStatus` 同步）。
 *
 * 本组用例锁死：**未开通时必须置位**，且**已开通/已领/普通无活动时不得置位**
 * —— 置错会误导用户去官方客户端白跑一趟。
 */
describe('actionRequired 置位规则（走真实产品函数）', () => {
  const cred: QoderCredential = buildQoderCredential(
    parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' },
  )

  /** 按 URL 分派的假 fetcher：活动列表与用量各给一份。 */
  function fetcherFor(campaigns: unknown, usage: unknown) {
    return (async (url: unknown) => {
      const href = String(url)
      const body = href.includes('/campaigns') ? campaigns : usage
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  it('未开通 → inactive 且 actionRequired=true（提示用户去官方客户端登录）', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW, USAGE_NOT_ACTIVATED),
    )
    expect(outcome.kind).toBe('inactive')
    expect(outcome).toMatchObject({ actionRequired: true })
    expect(String((outcome as { message: string }).message)).toContain('官方客户端')
  })

  /** 已开通但今天真的没活动 → **不得**置位（否则用户白跑一趟）。 */
  it('已开通但暂无可领 → inactive 且不置 actionRequired', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW, USAGE_ACTIVATED),
    )
    expect(outcome.kind).toBe('inactive')
    expect(outcome).not.toHaveProperty('actionRequired')
  })

  /** 今天已领 → already-claimed，与未开通无关。 */
  it('今天已领 → already-claimed（不涉及 actionRequired）', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER,
      fetcherFor(
        { showCampaign: true, claimable: false, campaigns: [{ campaignId: 'c', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' }] },
        USAGE_NOT_ACTIVATED,
      ),
      // ⚠️ 注入「已过 10:00（UTC+8）」的固定时刻：那条 CLAIMED 痕迹在刷新前
      // 属于昨天，会被判成「还没刷新」而不是「今天已领」（见 qoder-claim.spec.ts）。
      Date.UTC(2026, 8, 21, 6, 0, 0),
    )
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).not.toHaveProperty('actionRequired')
  })

  /** `CheckinStatus` 同步带该字段（判据与领取路径同源）。 */
  it('状态查询：未开通 → actionRequired=true', async () => {
    const status = await fetchQoderCheckinStatus(
      cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW, USAGE_NOT_ACTIVATED),
    )
    expect(status).toMatchObject({ active: true, todayCheckedIn: false, actionRequired: true })
  })

  it('状态查询：已开通 → 不置 actionRequired（保持既有响应形状）', async () => {
    const status = await fetchQoderCheckinStatus(
      cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW, USAGE_ACTIVATED),
    )
    expect(status).not.toHaveProperty('actionRequired')
  })
})
