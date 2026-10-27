/**
 * Qoder「账号尚未开通每日领取」判据的回归用例。
 *
 * ## 判据演进（两代缺陷）
 *
 * ### 第一代（2026-09-26）：判据取 `addOnQuota` 缺失
 * 用本插件经 GitHub 授权**新注册**的 Qoder 账号，一键签到显示「当前没有可领取
 * 的活动」，用户以为是我们没做对。实测证明不是设备身份问题，而是该账号在 Qoder
 * 侧确实没有每日领取活动。于是判据定为「无 `CLAIM_BENEFIT` 且 `addOnQuota` 缺失」。
 *
 * ### 第二代（2026-10-07，Issue IKJSHK）：`addOnQuota` 不可靠 → 改用活动列表
 * 用户报障：`qoder` / `qodercn` 11 个账号里 **7 个**已开通账号也被判「未开通」。
 * 维护者复核确认：**已开通账号也常常没有 `addOnQuota`**（只有 `userQuota`），
 * 且**同一份响应形状**曾同时被判成「真未开通」与「误报」——`addOnQuota` 分不开
 * 这两类账号。故判据改为**只看服务端活动列表**（`/sash/api/v1/me/campaigns`）：
 *
 * | 活动列表形态 | 判定 |
 * |---|---|
 * | 含任意 `CLAIM_BENEFIT`（可领或已领） | 已开通 → false |
 * | `showCampaign:true` 且无 `CLAIM_BENEFIT`（只剩 `VIEW_DETAILS`） | 未开通 → true |
 * | 空列表 / `showCampaign:false` / 未取到 / **缺 machine 头** | 无法判定 → false（保守不误报） |
 *
 * ### 第三代（PR !117 审计 P0-1）：补第三腿「机器头是否齐全」
 * 上表第二行原本**与「缺 machine 头」逐项同形**（两者都是
 * `showCampaign:true` + 非空 + 无 `CLAIM_BENEFIT`），而缺头是**纯插件用户的
 * 常态** ⇒ 未装 Qoder 客户端的机器上全部账号被误判「未开通」并被前端渲染成
 * 「请先用官方客户端登录」。判据新增 `machineHeadersPresent` 参数
 * （由 `loadCampaigns` 从 `creditsHeaders` 的返回值算出，零额外请求）。
 *
 * ### ⚠️ 两处**如实登记的未验证边界**（不要在修 bug 时顺手「优化」掉）
 *
 * 1. **漏报（未修，待真机取证）**：判据读的是「含**任意** `CLAIM_BENEFIT`」，
 *    而文案宣称的是「**已开通每日领取**」。仓库两份 `CLAIM_BENEFIT` 抓包样本
 *    **都是每日领取那一条**，无证据证明未开通账号不会下发**非每日**福利；
 *    且 `campaignKey` 全仓只用于填 `activityName`，**没有分流能力**。
 *    ⇒ 真发生该组合时：当天 100 Credits 静默漏领且**零出路提示**。
 * 2. **`!showCampaign` 那条腿曾无牙**：删掉该半句后本文件当时 9 条断言全绿
 *    （对抗审计实测）。现已由 `CAMPAIGNS_NONEMPTY_SHOW_FALSE` 夹具锁死。
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetQoderMachineIdentityCache } from '../../src/qoder-machine.js'

/** 有 CLAIM_BENEFIT 且已领（已开通账号的「今天已领」形态，真实抓包 CAMPAIGNS_AFTER_CLAIM）。 */
const CAMPAIGNS_BENEFIT_CLAIMED: QoderCampaigns = {
  showCampaign: true,
  claimable: false,
  campaigns: [
    { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' },
    { campaignId: 'c2', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' },
  ],
}

/** 有 CLAIM_BENEFIT 且可领（已开通账号的「可领」形态，真实抓包 CAMPAIGNS_BODY）。 */
const CAMPAIGNS_BENEFIT_CLAIMABLE: QoderCampaigns = {
  showCampaign: true,
  claimable: true,
  campaigns: [
    { campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' },
  ],
}

/** 只有 VIEW_DETAILS（未开通账号的实测形态，结构见 CAMPAIGNS_ONLY_VIEW）。 */
const CAMPAIGNS_ONLY_VIEW: QoderCampaigns = {
  showCampaign: true,
  claimable: true,
  campaigns: [{ campaignId: 'c1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMABLE' }],
}

/**
 * 缺 machine 头时服务端的真实响应（逐项消融表，见 `src/qoder-machine.ts`）。
 *
 * ⚠️⚠️ 与 `CAMPAIGNS_ONLY_VIEW` **逐项同形**，只差「头有没有发出去」——
 * 这正是 P1-1 的要害：响应本身分不开「未开通」与「头不全」这两种账号，
 * 判据必须自己带上「机器头是否齐全」这条**插件侧已知**的信息。
 */
const CAMPAIGNS_NO_MACHINE_HEADER: QoderCampaigns = {
  showCampaign: true,
  claimable: false,
  campaigns: [{ campaignId: 'c-view', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }],
}

/**
 * 空列表。
 *
 * ⚠️ 该形态来自 **CLI 身份**（`Cosy-ClientType:'5'`）或「今天已领」，
 * 与「未开通」**不可区分** ⇒ 必须判 false（不误报）。
 * ⚠️ 缺 machine 头产生**不是**这个形态，而是上面的
 * `CAMPAIGNS_NO_MACHINE_HEADER`（非空 + `showCampaign:true`）。
 */
const CAMPAIGNS_EMPTY: QoderCampaigns = { showCampaign: false, claimable: false, campaigns: [] }

/** `showCampaign:true` 但活动数组为空（另一条瞬时形态）。 */
const CAMPAIGNS_SHOW_BUT_EMPTY: QoderCampaigns = { showCampaign: true, claimable: false, campaigns: [] }

/** 非空但 `showCampaign:false`（锁 `!showCampaign` 那条腿 —— 它曾被变异验证判为无牙）。 */
const CAMPAIGNS_NONEMPTY_SHOW_FALSE: QoderCampaigns = {
  showCampaign: false,
  claimable: false,
  campaigns: [{ campaignId: 'c1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }],
}

describe('isQoderNotActivated（判据读活动列表 + 机器头是否齐全）', () => {
  /** 实测的未开通形态：只有 VIEW_DETAILS，无任何 CLAIM_BENEFIT（且机器头齐全）。 */
  it('只有 VIEW_DETAILS（无 CLAIM_BENEFIT、机器头齐全）→ 判为未开通', () => {
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW, true)).toBe(true)
  })

  /**
   * ⚠️⚠️ **P1-1 回归（PR !117 审计）**：缺 machine 头时服务端的响应形态是
   * `showCampaign:true, claimable:false` + **1 条 `VIEW_DETAILS`**
   * ——与「未开通」**逐项同形**。本机拿不到机器身份时（未装 Qoder 桌面端且无
   * `machine_token.json`），若不设这道闸，**每个**账号都会被判「未开通」并被
   * 前端渲染成「请先用官方客户端登录一次」——而装了客户端也不解决头缺失。
   */
  it('缺 machine 头（哪怕响应形态与未开通同形）→ 不判「未开通」', () => {
    expect(isQoderNotActivated(CAMPAIGNS_NO_MACHINE_HEADER, false)).toBe(false)
    // 同一份响应，机器头齐全时才判「未开通」—— 差别来自头而非响应形状
    expect(isQoderNotActivated(CAMPAIGNS_NO_MACHINE_HEADER, true)).toBe(true)
  })

  /** ⚠️ 省略「机器头是否齐全」这一参时**保守判 false**（无法证明头齐全就不下结论）。 */
  it('未传机器头信息 ⇒ 保守 false（不因缺参而误报）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_ONLY_VIEW)).toBe(false)
  })

  /** ⚠️ 锁 `!showCampaign` 那条腿：非空列表 + `showCampaign:false` 同样不得判未开通。 */
  it('非空列表但 showCampaign:false → 保守 false（该腿曾被变异验证判为无牙）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_NONEMPTY_SHOW_FALSE, true)).toBe(false)
  })

  /**
   * ⚠️⚠️ **第二代核心回归（Issue IKJSHK）**：已开通账号**只要有 CLAIM_BENEFIT**
   * 就绝不能被判「未开通」—— 即便它的用量响应里 `addOnQuota` 缺失（旧判据正是在
   * 这里误报 7/11 账号）。本判据根本不看用量响应，故此形态恒为 false。
   */
  it('有 CLAIM_BENEFIT 一律算已开通（与 addOnQuota 有无无关）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_BENEFIT_CLAIMED, true)).toBe(false)
    expect(isQoderNotActivated(CAMPAIGNS_BENEFIT_CLAIMABLE, true)).toBe(false)
  })

  /**
   * ⚠️ 空列表 / showCampaign:false / 活动数组为空 → **保守 false**。
   *
   * 这两种形态来自 CLI 身份（`Cosy-ClientType:'5'`）或「今天已领」，
   * 与「未开通」不可区分。
   */
  it('空列表 / showCampaign:false / 未取到 → 保守返回 false（不误报）', () => {
    expect(isQoderNotActivated(CAMPAIGNS_EMPTY, true)).toBe(false)
    expect(isQoderNotActivated(CAMPAIGNS_SHOW_BUT_EMPTY, true)).toBe(false)
    expect(isQoderNotActivated(undefined, true)).toBe(false)
  })

  /** 只有非领分类活动（VIEW_DETAILS 之外还有别的 actionType）也按「无 CLAIM_BENEFIT」判未开通。 */
  it('有其它 actionType 但无 CLAIM_BENEFIT → 判为未开通', () => {
    const campaigns: QoderCampaigns = {
      showCampaign: true,
      claimable: false,
      campaigns: [{ campaignId: 'c1', actionType: 'SOMETHING_ELSE', claimStatus: 'CLAIMED' }],
    }
    expect(isQoderNotActivated(campaigns, true)).toBe(true)
  })
})

/**
 * ⚠️ **`actionRequired` 字段的回归（2026-09-26 用户报障）**。
 *
 * 用户指出：不该让前端靠**文案**去猜「这条提示要不要单独展示」，应该改造
 * `ClaimOutcome` 让语义显式。故加了可选字段 `actionRequired?: boolean`
 * （`CheckinStatus` 同步）。
 *
 * 本组用例锁死：**未开通时必须置位**，且**已开通/已领/普通无活动时不得置位**
 * —— 置错会误导用户去官方客户端白跑一趟。
 */
describe('actionRequired 置位规则（走真实产品函数）', () => {
  const cred: QoderCredential = buildQoderCredential(
    parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' },
  )

  /** 按 URL 分派的假 fetcher：只服务活动列表端点（判据已不查用量）。 */
  function fetcherFor(campaigns: unknown) {
    return (async (url: unknown) => {
      const href = String(url)
      const body = href.includes('/campaigns') ? campaigns : {}
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  /**
   * 在「machine 身份可控」的环境下跑断言。
   *
   * ⚠️ **判据新增了「机器头是否齐全」这条腿**，所以这些用例必须显式控制它 ——
   * 否则测试机恰好没装 Qoder 桌面端时，「未开通」那几条会因拿不到机器身份
   * 而被保守判 false（这正是 P1-1 修复的**预期行为**，不是缺陷）。
   * 同型夹具见 `qoder-claim.spec.ts` 的 `withControlledMachineIdentity`。
   */
  async function withMachineIdentity(body: () => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'qoder-notact-mach-'))
    const file = join(dir, 'machine_token.json')
    writeFileSync(file, JSON.stringify({ token: 'tok-abc', type: 'type-xyz' }))
    const prevFile = process.env.QODER_MACHINE_TOKEN_PATH
    const prevExe = process.env.QODER_RUNTIME_INFO
    process.env.QODER_MACHINE_TOKEN_PATH = file
    process.env.QODER_RUNTIME_INFO = join(dir, 'no-such-runtime-info')
    resetQoderMachineIdentityCache()
    try {
      await body()
    } finally {
      if (prevFile === undefined) delete process.env.QODER_MACHINE_TOKEN_PATH
      else process.env.QODER_MACHINE_TOKEN_PATH = prevFile
      if (prevExe === undefined) delete process.env.QODER_RUNTIME_INFO
      else process.env.QODER_RUNTIME_INFO = prevExe
      resetQoderMachineIdentityCache()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** 在「本机拿不到机器身份」的环境下跑断言（缺 machine 头的真实场景）。 */
  async function withoutMachineIdentity(body: () => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'qoder-notact-nomach-'))
    const prevFile = process.env.QODER_MACHINE_TOKEN_PATH
    const prevExe = process.env.QODER_RUNTIME_INFO
    process.env.QODER_MACHINE_TOKEN_PATH = join(dir, 'no-such-machine-token.json')
    process.env.QODER_RUNTIME_INFO = join(dir, 'no-such-runtime-info')
    resetQoderMachineIdentityCache()
    try {
      await body()
    } finally {
      if (prevFile === undefined) delete process.env.QODER_MACHINE_TOKEN_PATH
      else process.env.QODER_MACHINE_TOKEN_PATH = prevFile
      if (prevExe === undefined) delete process.env.QODER_RUNTIME_INFO
      else process.env.QODER_RUNTIME_INFO = prevExe
      resetQoderMachineIdentityCache()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('未开通（只有 VIEW_DETAILS）→ inactive 且 actionRequired=true（提示去官方客户端）', async () => {
    await withMachineIdentity(async () => {
      const outcome = await claimQoderDailyCheckin(
        cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW),
      )
      expect(outcome.kind).toBe('inactive')
      expect(outcome).toMatchObject({ actionRequired: true })
      expect(String((outcome as { message: string }).message)).toContain('官方客户端')
    })
  })

  /**
   * ⚠️⚠️ **P1-1 端到端回归**：本机拿不到机器身份时（未装 Qoder 桌面端且无
   * `machine_token.json`），服务端回的响应形态与「未开通」逐项同形——
   * 此时**绝不能**提示「未开通，请先用官方客户端登录一次」，因为真正缺的
   * 是机器头，用户装了客户端也可能依旧拿不到（`qoder-machine.ts` 自己就
   * 记录了 exe 定位失败这条路 2026-09-25 复发过一次），按指引走是白跑一趟。
   */
  it('缺 machine 头 → 不得输出「未开通、需去官方客户端登录」指引', async () => {
    await withoutMachineIdentity(async () => {
      const outcome = await claimQoderDailyCheckin(
        cred, QODER, fetcherFor(CAMPAIGNS_NO_MACHINE_HEADER),
      )
      expect(outcome.kind).toBe('inactive')
      expect(outcome).not.toHaveProperty('actionRequired')
      expect(String((outcome as { message: string }).message)).not.toContain('官方客户端')
    })
  })

  /** 普通「暂时没活动」（空列表）→ inactive 但**不得**置位（形同瞬时/头不全）。 */
  it('空列表（无法判定）→ inactive 且不置 actionRequired', async () => {
    await withMachineIdentity(async () => {
      const outcome = await claimQoderDailyCheckin(
        cred, QODER, fetcherFor(CAMPAIGNS_EMPTY),
      )
      expect(outcome.kind).toBe('inactive')
      expect(outcome).not.toHaveProperty('actionRequired')
    })
  })

  /** 今天已领 → already-claimed，与未开通无关。 */
  it('今天已领 → already-claimed（不涉及 actionRequired）', async () => {
    await withMachineIdentity(async () => {
      const outcome = await claimQoderDailyCheckin(
        cred, QODER,
        fetcherFor(CAMPAIGNS_BENEFIT_CLAIMED),
        // ⚠️ 注入「已过 10:00（UTC+8）」的固定时刻：那条 CLAIMED 痕迹在刷新前
        // 属于昨天，会被判成「还没刷新」而不是「今天已领」（见 qoder-claim.spec.ts）。
        Date.UTC(2026, 8, 21, 6, 0, 0),
      )
      expect(outcome.kind).toBe('already-claimed')
      expect(outcome).not.toHaveProperty('actionRequired')
    })
  })

  /** `CheckinStatus` 同步带该字段（判据与领取路径同源）。 */
  it('状态查询：未开通 → actionRequired=true', async () => {
    await withMachineIdentity(async () => {
      const status = await fetchQoderCheckinStatus(
        cred, QODER, fetcherFor(CAMPAIGNS_ONLY_VIEW),
      )
      expect(status).toMatchObject({ active: true, todayCheckedIn: false, actionRequired: true })
    })
  })

  it('状态查询：已开通（有 CLAIM_BENEFIT）→ 不置 actionRequired', async () => {
    await withMachineIdentity(async () => {
      const status = await fetchQoderCheckinStatus(
        cred, QODER, fetcherFor(CAMPAIGNS_BENEFIT_CLAIMED), Date.UTC(2026, 8, 21, 6, 0, 0),
      )
      expect(status).not.toHaveProperty('actionRequired')
    })
  })

  /** ⚠️ 状态查询路径同样不得在缺机器头时误报「未开通」。 */
  it('状态查询：缺 machine 头 → 不置 actionRequired', async () => {
    await withoutMachineIdentity(async () => {
      const status = await fetchQoderCheckinStatus(
        cred, QODER, fetcherFor(CAMPAIGNS_NO_MACHINE_HEADER),
      )
      expect(status).not.toHaveProperty('actionRequired')
    })
  })
})
