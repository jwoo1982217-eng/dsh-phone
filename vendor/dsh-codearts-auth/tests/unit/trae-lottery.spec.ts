/**
 * TRAE 1024 打卡抽奖 —— 判据守卫（2026-10-20 真机取证）
 *
 * ## 本文件守什么（每条都有实测依据）
 *
 * 1. **`grantable` / `granted` 是字符串 `"true"` / `"false"`** —— 客户端自己的
 *    `_transformCommercialActivityInfo` 写 `o.grantable === true`，对字符串**恒假**
 *    （客户端自身缺陷）。我们**两种形态都接受**，否则会把「可领」判成「不可领」。
 * 2. **`activity/info` 必须带 `req_source` + `version_code`** —— 实测空 body 只回 6 个
 *    通用活动，带齐回 8 个（多出 `checkin_1024`）⇒ 缺参数会把「有资格」误判成「没这活动」。
 * 3. **判据顺序：先 `granted` 再 `grantable`** —— 已抽过的日子 `grantable` 通常也变 false，
 *    先判 grantable 会把「今天已抽」误报成「不可参与」，用户看不出自己抽过了。
 * 4. **前置闸门不过 ⇒ 一个请求都不发**（写操作不可逆，不能盲发）。
 * 5. **不重试**（客户端对 `checkin_1024` 显式 `retry: 0`）。
 * 6. **读不到积分别臆造 0**（本仓库「领取成功 +0 积分」已报障三次）。
 *
 * ⚠️ 判据一律打在**行为**上（真调函数、看发出去的请求），不用源码文本断言。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  decideTraeLottery,
  extractTraeCommercialActivities,
  fetchTraeLotteryActivities,
  isTraeActivityInWindow,
  participateTraeLottery,
  readLotteryCredits,
  readTraeBooleanish,
  readTraeLotteryPrize,
  describeTraeLotteryPrize,
  TRAE_CHECKIN_LOTTERY_ACTIVITY_ID,
  type TraeCommercialActivity,
} from '../../src/trae-lottery.js'
// ⚠️ 接线守卫要真跑签到主流程（抽奖挂在它的成功分支里）—— 它在 `trae-credits.js`，
//    不在 `trae-lottery.js`（放错模块会得到 `not a function`）。
import { claimTraeDailyCheckin } from '../../src/trae-credits.js'
import { TRAE } from '../../src/trae-product.js'
import type { TraeCredential } from '../../src/trae.js'

const CRED = { access_token: 'jwt-x', refresh_token: 'rt', uid: 'uid-1234567890ab' } as TraeCredential

/** 实测的真实活动形状（`checkin_1024`，`work_extra` 全是**字符串**布尔）。 */
const MEASURED_1024_RAW = {
  Enabled: true,
  activity_id: 'checkin_1024',
  activity_type: 108,
  // ⚠️ **窗口必须覆盖「现在」**：这三个用例都传 `Date.now()` 作为 now
  //    ⇒ 若照抄实测的真实时间戳（2026-10-19~24），用例只在活动期内通过，
  //    过了 10-24 18:00 就会**假失败**（本仓库明令禁止的「时间依赖用例」形态）。
  //    窗口判据本身另有专门用例（`isTraeActivityInWindow` + 下面的窗口用例）覆盖。
  start_time_ms: Date.now() - 24 * 3600_000,
  end_time_ms: Date.now() + 24 * 3600_000,
  work_extra: { eligible: true, grantable: 'true', granted: 'false' },
}

/** 造一个按 URL + body 分派的假 fetcher，并记录所有请求。 */
function makeFetcher(handlers: {
  activities?: unknown
  action?: unknown
  actionStatus?: number
}) {
  const sent: Array<{ url: string; body: unknown }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    sent.push({ url: u, body })
    if (u.includes('/activity/action')) {
      return new Response(JSON.stringify(handlers.action ?? { code: 0, message: 'success' }), {
        status: handlers.actionStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(handlers.activities ?? { commercial_activities: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, sent }
}

// ════════════════════════════════════════════════════════════════════════
describe('★ 布尔判据：`"true"` / `"false"` 字符串必须被认（客户端自身在这格有缺陷）', () => {
  it('★★ 字符串 "true"/"false" 与布尔 true/false 等价', () => {
    expect(readTraeBooleanish('true')).toBe(true)
    expect(readTraeBooleanish('false')).toBe(false)
    expect(readTraeBooleanish(true)).toBe(true)
    expect(readTraeBooleanish(false)).toBe(false)
  })

  it('★ 大小写 / 空白容错', () => {
    expect(readTraeBooleanish(' TRUE ')).toBe(true)
    expect(readTraeBooleanish(' False')).toBe(false)
  })

  it('⚠️ 认不出来必须回 `undefined`，**不得**回 false（"不知道" ≠ "不行"）', () => {
    for (const v of [undefined, null, 'yes', '1', 1, {}, []]) {
      expect(readTraeBooleanish(v), `${JSON.stringify(v)} 不该被读成布尔`).toBeUndefined()
    }
  })

  it('★★ 实测形状（work_extra 全是字符串）⇒ grantable 必须读成 true', () => {
    const acts = extractTraeCommercialActivities({ commercial_activities: [MEASURED_1024_RAW] })
    expect(acts, '应当解析出活动').toHaveLength(1)
    const a = acts![0]!
    expect(a.activityId).toBe('checkin_1024')
    expect(a.enabled).toBe(true)
    expect(a.eligible).toBe(true)
    expect(a.grantable, '⚠️ 字符串 "true" 必须读成 true（客户端在此恒假）').toBe(true)
    expect(a.granted, '⚠️ 字符串 "false" 必须读成 false').toBe(false)
  })

  it('★ 反向：布尔形态（上游哪天改成真布尔）也必须认', () => {
    const acts = extractTraeCommercialActivities({
      commercial_activities: [{
        ...MEASURED_1024_RAW,
        work_extra: { eligible: true, grantable: true, granted: false },
      }],
    })
    expect(acts![0]!.grantable).toBe(true)
    expect(acts![0]!.granted).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('★★ 判据顺序与 fail-closed', () => {
  const base: TraeCommercialActivity = {
    activityId: TRAE_CHECKIN_LOTTERY_ACTIVITY_ID,
    activityType: 108,
    enabled: true,
    eligible: true,
    grantable: true,
    granted: false,
  }

  it('★★ 已抽过（granted=true）必须报 `already`，**即使** grantable 也是 false', () => {
    // ⚠️ 这就是顺序判据：真实场景里抽完之后 grantable 通常也变 false。
    //    若先判 grantable，用户只会看到「当前不可参与」，看不出自己今天已经抽过。
    expect(decideTraeLottery([{ ...base, granted: true, grantable: false }]).kind).toBe('already')
  })

  it('全部满足 ⇒ participate', () => {
    expect(decideTraeLottery([base]).kind).toBe('participate')
  })

  it('⚠️ fail-closed：缺 eligible / grantable ⇒ 一律 unavailable（不得当可参与）', () => {
    const { eligible: _e, ...noEligible } = base
    const { grantable: _g, ...noGrantable } = base
    expect(decideTraeLottery([noEligible as TraeCommercialActivity]).kind).toBe('unavailable')
    expect(decideTraeLottery([noGrantable as TraeCommercialActivity]).kind).toBe('unavailable')
  })

  it('⚠️ disabled / 无该活动 / 形状不认识 ⇒ unavailable（且原因各不相同）', () => {
    expect(decideTraeLottery([{ ...base, enabled: false }]).kind).toBe('unavailable')
    expect(decideTraeLottery([]).kind).toBe('unavailable')
    expect(decideTraeLottery(undefined).kind).toBe('unavailable')
    // ⚠️ 文案必须区分「活动期外不出现」与「形状不认识」——前者是正常情况，不是错误。
    expect(decideTraeLottery([]).reason).not.toBe(decideTraeLottery(undefined).reason)
  })

  it('★ 窗口判据：开始前 / 结束后都不在窗口内', () => {
    const win = { startTimeMs: 1000, endTimeMs: 2000 }
    expect(isTraeActivityInWindow(win, 500)).toBe(false)
    expect(isTraeActivityInWindow(win, 1500)).toBe(true)
    expect(isTraeActivityInWindow(win, 2500)).toBe(false)
    // ⚠️ 缺窗口字段 ⇒ 视为在窗口内（不臆造过期）
    expect(isTraeActivityInWindow({}, 999999)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('★★ 请求契约：`req_source` 是数字 1、且必须带 `version_code`', () => {
  it('★★ activity/info 的 body 必须含 req_source:1 与 version_code（缺了看不到 1024）', async () => {
    const { fetcher, sent } = makeFetcher({ activities: { commercial_activities: [MEASURED_1024_RAW] } })
    await fetchTraeLotteryActivities(CRED, TRAE, { fetcher, versionCode: '3.5.2' })
    const info = sent.find((s) => s.url.includes('/activity/info'))
    expect(info, '必须请求 activity/info').toBeDefined()
    expect(info!.body).toMatchObject({ req_source: 1, version_code: '3.5.2' })
    // ⚠️ `req_source` 必须是**数字**：字符串 '1' 与客户端的 `t?2:1` 不同源。
    expect(typeof (info!.body as Record<string, unknown>)['req_source']).toBe('number')
  })

  it('★ 抽奖 body 只含 activity_id + req_source（与客户端逐字段一致，不伪造额外字段）', async () => {
    const { fetcher, sent } = makeFetcher({ activities: { commercial_activities: [MEASURED_1024_RAW] } })
    const result = await participateTraeLottery(CRED, TRAE, { fetcher }, undefined, Date.now())
    expect(result.kind).toBe('ok')
    const action = sent.find((s) => s.url.includes('/activity/action'))
    expect(action, '必须请求 activity/action').toBeDefined()
    expect(action!.body).toEqual({ activity_id: 'checkin_1024', req_source: 1 })
  })

  it('★★ 前置闸门不过 ⇒ **一个 action 请求都不发**（写操作不可逆）', async () => {
    // 已抽过的形状
    const already = { ...MEASURED_1024_RAW, work_extra: { eligible: true, grantable: 'false', granted: 'true' } }
    const { fetcher, sent } = makeFetcher({ activities: { commercial_activities: [already] } })
    const result = await participateTraeLottery(CRED, TRAE, { fetcher }, undefined, Date.now())
    expect(result.kind).toBe('skipped')
    expect(
      sent.some((s) => s.url.includes('/activity/action')),
      '⚠️ 判定为不该发时，绝不能发写请求',
    ).toBe(false)
  })

  it('★★ 不重试：action 失败后**只发过一次**（客户端 retry:0）', async () => {
    const { fetcher, sent } = makeFetcher({
      activities: { commercial_activities: [MEASURED_1024_RAW] },
      action: { code: 50001, message: '今日已参与' },
      actionStatus: 500,
    })
    const result = await participateTraeLottery(CRED, TRAE, { fetcher }, undefined, Date.now())
    expect(result.kind).toBe('failed')
    const actions = sent.filter((s) => s.url.includes('/activity/action'))
    expect(actions, '⚠️ 写操作绝不重试（重试可能白烧当天机会）').toHaveLength(1)
  })

  it('★ 服务端业务码非 0 ⇒ failed 且**如实透传** message（那是唯一线索）', async () => {
    const { fetcher } = makeFetcher({
      activities: { commercial_activities: [MEASURED_1024_RAW] },
      action: { code: 50001, message: '今日已参与抽奖' },
    })
    const result = await participateTraeLottery(CRED, TRAE, { fetcher }, undefined, Date.now())
    expect(result.kind).toBe('failed')
    expect(result.code).toBe(50001)
    expect(result.message, '服务端文案必须透传，不得替换成通用话术').toContain('今日已参与')
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('★ 积分读取：读不到就 `undefined`，**绝不臆造 0**', () => {
  it('★★ 无积数字段 ⇒ undefined（0 会被读成「没抽到」，与「不知道」是两件事）', () => {
    expect(readLotteryCredits({ code: 0, message: 'success' })).toBeUndefined()
    expect(readLotteryCredits({ code: 0, credits: 0 }), '0 也不当成「抽到了」').toBeUndefined()
  })

  it('★ 顶层与 data 内两种位置都要认', () => {
    expect(readLotteryCredits({ credits: 88 })).toBe(88)
    expect(readLotteryCredits({ data: { credits: 888 } })).toBe(888)
    expect(readLotteryCredits({ data: { granted_credits: '88' } })).toBe(88)
  })

  it('★ 反向：字符串数字要能解析（上游可能下发字符串）', () => {
    expect(readLotteryCredits({ prize_credits: '888' })).toBe(888)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('★★ 奖品如实转述：抽到**券**时不得退化成「所得未知」（真机实测打穿第一版）', () => {
  /**
   * **真机实测的响应原文**（2026-10-20，一次真实参与得到的奖品）。
   *
   * ⚠️ 它是本组用例存在的理由：这份响应**没有 `credits` 字段**，
   *    第一版只用 `readLotteryCredits` ⇒ 返回 `undefined` ⇒ 提示退化成
   *    「所得以 IDE 面板为准」，把 `prize_text` 与券面额这两条**已知**信息白丢。
   */
  const MEASURED_COUPON = {
    work_extra: {
      coupon_face_amount_fen: 1000,
      eligible: true,
      grantable: false,
      granted: true,
      prize_text: 'AI Build 专属抵扣券',
      prize_type: 2,
    },
  }

  it('★★ 实测券响应 ⇒ 必须读出奖品文案与面额（不得返回 undefined）', () => {
    const prize = readTraeLotteryPrize(MEASURED_COUPON)
    expect(prize, '⚠️ 抽到券时必须能读出奖品，否则等于知情不报').toBeDefined()
    expect(prize!.text).toBe('AI Build 专属抵扣券')
    expect(prize!.couponFaceAmountFen).toBe(1000)
    expect(prize!.type, 'prize_type=2 实测为券').toBe(2)
    expect(prize!.credits, '券不是积分 ⇒ 不得凭空产出积分数').toBeUndefined()
  })

  it('★★ 描述文案：券要显示「元」，且不得与积分混算', () => {
    const text = describeTraeLotteryPrize(readTraeLotteryPrize(MEASURED_COUPON))
    expect(text).toContain('AI Build 专属抵扣券')
    expect(text, '1000 分 ⇒ 10 元（换算只在展示处做）').toContain('10 元')
    // ⚠️ 单位红线：券与积分不可相加/互换。
    expect(text).not.toContain('积分')
  })

  it('★ 积分奖仍要照常报积分（反向：不得只顾券）', () => {
    const prize = readTraeLotteryPrize({ work_extra: { prize_text: '积分', credits: 88 } })
    expect(prize!.credits).toBe(88)
    expect(describeTraeLotteryPrize(prize)).toContain('88 积分')
  })

  it('⚠️ 什么奖品字段都没有 ⇒ `undefined`（不臆造「没抽到」）', () => {
    expect(readTraeLotteryPrize({ work_extra: { eligible: true, granted: true } })).toBeUndefined()
    expect(readTraeLotteryPrize({})).toBeUndefined()
  })

  it('★★ 端到端（走真实钩子）：抽到券 ⇒ 提示必须带上奖品，不得说「所得未知」', async () => {
    // ⚠️ 2026-10-20 起抽奖**不再挂在 `claimTraeDailyCheckin` 内部**（那条路对
    //    「今天已签到」根本不执行）⇒ 本用例改走真实挂点 `afterClaimNote`。
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits() as Record<string, {
      afterClaimNote?: (c: unknown) => Promise<string | undefined>
    } | undefined>
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
      if (u.includes('/activity/action')) return json(MEASURED_COUPON)
      if (u.includes('/activity/info')) {
        return json({
          commercial_activities: [{
            Enabled: true, activity_id: 'checkin_1024', activity_type: 108,
            start_time_ms: Date.now() - 3600_000, end_time_ms: Date.now() + 3600_000,
            work_extra: { eligible: true, grantable: 'true', granted: 'false' },
          }],
        })
      }
      return json({})
    }) as unknown as typeof fetch
    try {
      const note = await table['trae']!.afterClaimNote!(CRED)
      expect(note, '★ 钩子必须给出提示').toBeDefined()
      expect(note, '★ 必须转述奖品名').toContain('AI Build 专属抵扣券')
      expect(note, '⚠️ 不得退化成「所得以 IDE 面板为准」（那是已知却不报）')
        .not.toContain('以 IDE 面板为准')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════
describe('★★ 钩子契约：`runTraeLotteryForUi` 经 `afterClaimNote`（覆盖 claimed 与 already-claimed）', () => {
  /**
   * 直接测**真实挂点**（`provider-credits` 的 `afterClaimNote`）。
   *
   * ⚠️ 2026-10-20 之前这里测的是「`claimTraeDailyCheckin` 内部触发抽奖」，
   *    而那正是**报障的根因**：本家 `precheckStatus: true` ⇒ 「今天已签到」时
   *    `credits.claimAll` 先查状态、**根本不调 claim** ⇒ 抽奖永不触发。
   *    故判据必须改成「钩子存在且行为正确」，而不是「claim 内有调用」。
   */
  async function callHook(fetchImpl: typeof fetch): Promise<string | undefined> {
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits() as Record<string, {
      afterClaimNote?: (c: unknown) => Promise<string | undefined>
    } | undefined>
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      return await table['trae']!.afterClaimNote!(CRED)
    } finally {
      globalThis.fetch = original
    }
  }

  /** 造一个应付 activity/info 与 activity/action 的 fetcher。 */
  function makeChain(options: {
    activityAction?: unknown
    activityActionStatus?: number
    granted?: boolean
    grantable?: boolean
  } = {}) {
    const urls: string[] = []
    const fetcher = vi.fn(async (url: unknown) => {
      const u = String(url)
      urls.push(u)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
        status, headers: { 'Content-Type': 'application/json' },
      })
      if (u.includes('/activity/action')) {
        return json(options.activityAction ?? { code: 0, message: 'success' }, options.activityActionStatus ?? 200)
      }
      if (u.includes('/activity/info')) {
        return json({
          commercial_activities: [{
            Enabled: true,
            activity_id: 'checkin_1024',
            activity_type: 108,
            start_time_ms: Date.now() - 3600_000,
            end_time_ms: Date.now() + 3600_000,
            // ⚠️ 实测是**字符串**布尔；这里也顺便让两种形态都被覆盖。
            work_extra: {
              eligible: true,
              grantable: String(options.grantable ?? true),
              granted: String(options.granted ?? false),
            },
          }],
        })
      }
      return json({})
    }) as unknown as typeof fetch
    return { fetcher, urls }
  }

  it('★★ 可抽时 ⇒ 真的发 `/activity/action` 并返回提示', async () => {
    const { fetcher, urls } = makeChain()
    const note = await callHook(fetcher)
    expect(urls.some((u) => u.includes('/activity/action')), '★ 必须真的发抽奖请求').toBe(true)
    expect(note, '★ 必须返回一条提示').toBeDefined()
  })

  it('★★ 今日已抽（granted=true）⇒ **零 action 请求**且**返回 undefined**（无噪声）', async () => {
    // ⚠️ 这格是「本来就不该抽」：报出来只是噪声。
    const { fetcher, urls } = makeChain({ granted: true, grantable: false })
    const note = await callHook(fetcher)
    expect(urls.some((u) => u.includes('/activity/action')), '⚠️ 不该抽时零写请求').toBe(false)
    expect(note, '⚠️ 不该抽时不得产出提示').toBeUndefined()
  })

  it('★★ 服务端业务失败 ⇒ 文案**如实透传**（那是唯一线索），且钩子不抛', async () => {
    const { fetcher } = makeChain({ activityAction: { code: 50001, message: '今日已参与抽奖' } })
    const note = await callHook(fetcher)
    expect(note, '★ 失败也要给一句话').toBeDefined()
    expect(note).toContain('今日已参与抽奖')
  })

  it('★★ HTTP 500 ⇒ 钩子仍不抛，返回可读提示', async () => {
    const { fetcher } = makeChain({ activityAction: { code: 1 }, activityActionStatus: 500 })
    const note = await callHook(fetcher)
    expect(note, '★ 失败要给可读提示，而不是抛').toBeDefined()
  })

  it('⚠️ 活动读取失败（网络炸）⇒ 钩子**不抛**且返回 `undefined`', async () => {
    const boom = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    await expect(callHook(boom)).resolves.toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('★★ 钩子挂点：`afterClaimNote` 必须存在（覆盖「今天已签到」那条路）', () => {
  it('★★ trae 的 `afterClaimNote` 必须提供 —— 挂在 claim 内则「已签到」永不触发抽奖', async () => {
    // ⚠️⚠️ 2026-10-20 用户报障的根因：第一版把抽奖挂在 `claimTraeDailyCheckin` 内部，
    //    而本家 `precheckStatus: true` ⇒ `credits.claimAll` **先查状态**，
    //    今天已签到就直接回 `already-claimed`、**根本不调 claim** ⇒ 抽奖永不触发
    //    （用户实测：4 个账号全显示「今天已签到」，一条抽奖信息都没有）。
    //    ⇒ 必须挂在 `afterClaimNote`（对 claimed **与** already-claimed 都跑）。
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits() as Record<string, { afterClaimNote?: unknown } | undefined>
    expect(table['trae'], 'trae 必须在能力表里').toBeDefined()
    expect(
      typeof table['trae']!.afterClaimNote,
      '⚠️ trae 必须提供 afterClaimNote；挂在 claim 内的话「今天已签到」不会触发抽奖',
    ).toBe('function')
  })

  it('★ 契约：钩子永不抛，且读不到活动时返回 `undefined`（不产生噪声）', async () => {
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits() as Record<string, {
      afterClaimNote?: (c: unknown) => Promise<string | undefined>
    } | undefined>
    // ⚠️ 用一个**没有可达上游**的假凭据：内部会 `skipped` ⇒ 必须回 `undefined`
    //    （既不抛，也不给一条误导文案）。这同时验证「永不抛」这条契约。
    const note = await table['trae']!.afterClaimNote!({ access_token: 'x', refresh_token: 'r', uid: 'u' })
    expect(note, '读不到活动状态 ⇒ 不该产出任何提示').toBeUndefined()
  })
})
