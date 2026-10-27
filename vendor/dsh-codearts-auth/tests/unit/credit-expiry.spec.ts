/**
 * 面板展示用的「临时 / 长期」分桶与**资源包列表排序**
 * （`plugin-src/client/credit-expiry.js`）。
 *
 * ## 本文件最重要的职责：与后端**对账**
 *
 * 判据的权威实现在后端 `src/buddy-balance-rank.ts`（选号用它），前端这份是
 * 展示侧的同规则复刻。两者一旦漂移，用户就会看到「面板说还有 250 临时积分，
 * 选号却说没号可用」——而这类不一致**没有任何一条单侧用例能发现**。
 *
 * 故下面用同一组 fixture（含边界与脏值）喂两侧，逐条断言结果相同。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  daysUntilExpiry,
  expiryBucketLabel,
  expiryCountdown,
  expirySplitParts,
  findDailyPool,
  formatExpirySplitLine,
  formatNamedPoolLine,
  formatPackageExpiry,
  formatPackageTooltip,
  formatPoolSplitLine,
  packageExpiryMs,
  splitCreditsByExpiry,
} from '../../plugin-src/client/credit-expiry.js'
import { supportsCreditPackageList } from '../../plugin-src/client/credits-capabilities.js'
import { splitBuddyCreditsByExpiry } from '../../src/buddy-balance-rank.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)
const WINDOW_DAYS = 15

function pkg(overrides: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name: 'Bonus Pack',
    unit: 'credits',
    remaining: 100,
    total: 100,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime: NOW + 30 * DAY,
    ...overrides,
  }
}

/** 后端签名：吃整份 CreditBalance + windowMs；前端：吃 packages + windowDays。 */
function backendSplit(packages: CreditPackage[], windowDays = WINDOW_DAYS, now = NOW) {
  return splitBuddyCreditsByExpiry(
    { total: 0, packages, expiredTotal: 0 } as CreditBalance,
    now,
    windowDays * DAY,
  )
}

/**
 * 把前端**三档**归约成后端的**两档**口径。
 *
 * ⚠️ 这是 2026-10-12 引入三档展示后的**必要适配**，不是放宽断言：
 * 后端 `splitBuddyCreditsByExpiry` 是**选号判据**（只关心「会不会近期作废」，
 * 故只有 `expiring` / `permanent` 两桶）；前端 `splitCreditsByExpiry` 是
 * **展示口径**（用户要求把「真永久」与「到期还远」分开着色，故三桶）。
 *
 * 两者的**共同维度**是 `expiring`（必须逐分不差）；而前端的
 * `permanent + longTerm` 恰好等于后端的 `permanent`（同一个集合的两种切法）。
 * 故对账时按此归约 —— 这样「前端多算/少算临时积分」这类真实漂移仍会被抓住。
 */
function reduceFrontendToBackend(frontend: { expiring: number; longTerm: number; permanent: number }) {
  return { expiring: frontend.expiring, permanent: frontend.permanent + frontend.longTerm }
}

describe('splitCreditsByExpiry（前端三档分桶）', () => {
  it('15 天内到期算临期，更久算长期，无到期时间算永久', () => {
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 9 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 100, longTerm: 0, permanent: 0, earliestExpiringAt: NOW + 9 * DAY, earliestExpiringAmount: 100 })
    // ⚠️ 3008 天有**明确到期时间** ⇒ 长期（黄），不是永久（绿）。
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 3008 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 0, longTerm: 100, permanent: 0, earliestExpiringAt: null, earliestExpiringAmount: 0 })
    // 只有**服务端没给到期时间**才是真·永久。
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: undefined })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 0, longTerm: 0, permanent: 100, earliestExpiringAt: null, earliestExpiringAmount: 0 })
  })

  it('恰好 15 天归长期（判据是"不足 15 天"）', () => {
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 15 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 0, longTerm: 100, permanent: 0, earliestExpiringAt: null, earliestExpiringAmount: 0 })
  })

  it('失效包与零余额包不计入', () => {
    expect(splitCreditsByExpiry([
      pkg({ active: false, remaining: 999, deductionEndTime: NOW + DAY }),
      pkg({ remaining: 0 }),
      pkg({ remaining: 100, deductionEndTime: NOW + 20 * DAY }),
    ], WINDOW_DAYS, NOW)).toEqual({ expiring: 0, longTerm: 100, permanent: 0, earliestExpiringAt: null, earliestExpiringAmount: 0 })
  })

  it('到期时间未知归永久（保守方向）', () => {
    expect(splitCreditsByExpiry([
      pkg({ deductionEndTime: undefined }),
      pkg({ deductionEndTime: 0 }),
      pkg({ deductionEndTime: Number.NaN }),
    ], WINDOW_DAYS, NOW)).toEqual({ expiring: 0, longTerm: 0, permanent: 300, earliestExpiringAt: null, earliestExpiringAmount: 0 })
  })

  /**
   * ⚠️ 临期桶要带回**最早**的作废时刻 —— 它是倒计时的数据源（用户 2026-10-12 要求
   * 「临期 100（倒计时）」）。多个临期包时取最早的那个：那才是用户真正会先失去的额度。
   */
  it('临期桶带最早作废时刻（多包取最早）', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 50, deductionEndTime: NOW + 9 * DAY }),
      pkg({ remaining: 30, deductionEndTime: NOW + 2 * DAY }),
      pkg({ remaining: 20, deductionEndTime: NOW + 12 * DAY }),
    ], WINDOW_DAYS, NOW)
    expect(split?.expiring).toBe(100)
    expect(split?.earliestExpiringAt).toBe(NOW + 2 * DAY)
  })

  /**
   * ⚠️⚠️ **临期段的数字必须与倒计时指向同一批**（2026-10-20 用户报障
   * 「怎么可能全都同一天到期」）。
   *
   * 形态（autoclaw 真机）：窗口内有三批，分别在 5 / 6 / 7 天后到期。
   * 原实现把三批加总成「临期 20856（4 天 20 小时）」⇒ 用户读成
   * 「这 20856 会在 4 天 20 小时后一起掉」，而实际只有最早那批 19656 会掉。
   *
   * ⇒ `earliestExpiringAmount` 必须是**最早那批的量**（不是窗口内总额），
   *    它与 `earliestExpiringAt` 配对，才不会把不同批次的时间混成一个。
   */
  it('★ 临期段数字 = 最早那批的量（不是窗口内所有批次之和）', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 19656, deductionEndTime: NOW + 5 * DAY }),  // 最早那批
      pkg({ remaining: 500, deductionEndTime: NOW + 6 * DAY }),
      pkg({ remaining: 700, deductionEndTime: NOW + 7 * DAY }),
    ], WINDOW_DAYS, NOW)
    // 窗口内总额：三批都算
    expect(split?.expiring).toBe(20856)
    // 倒计时指向最早那批
    expect(split?.earliestExpiringAt).toBe(NOW + 5 * DAY)
    // ★ 数字必须只反映最早那批 —— 这才是「4 天 20 小时后会掉多少」
    expect(split?.earliestExpiringAmount, '★ 用总额会让「N 天后掉 X」读成全部同时到期')
      .toBe(19656)
    // 渲染侧：临期文本取 earliestExpiringAmount
    const parts = expirySplitParts(split, (v) => String(v), NOW)
    const expiringPart = parts.find((p) => p.key === 'expiring')
    expect(expiringPart?.text).toBe('临期 19656')
  })

  it('★ 同一到期时刻的多个包 ⇒ earliestExpiringAmount 累加（同批）', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 100, deductionEndTime: NOW + 3 * DAY }),
      pkg({ remaining: 200, deductionEndTime: NOW + 3 * DAY }),   // 同刻 = 同一批
    ], WINDOW_DAYS, NOW)
    expect(split?.earliestExpiringAmount, '同刻并列属于同一批，量要相加').toBe(300)
  })

  /**
   * ⚠️⚠️ **乱序夹具：最早那批排在数组最后**（2026-10-20 审计补，关键）。
   *
   * ## 为什么必须乱序（原用例是夹具盲区型假绿）
   *
   * 上一条「临期段数字 = 最早那批的量」的夹具把最早那批排在**第一位**：
   *
   * ```
   * [19656@5d, 500@6d, 700@7d]
   * ```
   *
   * 于是「取第一个临期包的 `remaining`」与「取最早那批的 `remaining`」
   * 在这个夹具上**逐字节同值** ⇒ 审计实测：把实现改成
   * `earliestExpiringAmount = expiring`（= 要修的 bug 本身）后 **76 条全绿**。
   *
   * 而生产输入来自 `credits.balances` 的 `packages` 数组，顺序**无任何保证**
   * （`parseAutoclawLedgerBatches` 只对 `byExpiry` 排序，钱包包是上游原序）
   * ⇒ 那条守卫在真实顺序下会漏掉整整一半的错误实现。
   *
   * 审计实测的判别力对照（同一组三批，只改数组顺序）：
   *
   * | 顺序 | 修复态 | 变异态 `= expiring` |
   * |---|---|---|
   * | asc（最早在前） | 19656 | 19656 ← **不可区分** |
   * | desc（最早在后） | 19656 | 20856 ← **可区分** |
   *
   * ⇒ 本用例取 desc 顺序。
   */
  it('★ 乱序输入（最早那批在数组最后）⇒ 仍取最早那批的量，不是总额', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 700, deductionEndTime: NOW + 7 * DAY }),
      pkg({ remaining: 500, deductionEndTime: NOW + 6 * DAY }),
      pkg({ remaining: 19656, deductionEndTime: NOW + 5 * DAY }), // 最早，但在最后
    ], WINDOW_DAYS, NOW)
    expect(split?.expiring).toBe(20856)
    expect(split?.earliestExpiringAt).toBe(NOW + 5 * DAY)
    expect(
      split?.earliestExpiringAmount,
      '★ 乱序下若实现取「第一个临期包」或「总额」，这里会得 700 / 20856',
    ).toBe(19656)
  })

  it('★ 乱序 + 同刻并列：仍按时刻取最早那批，并把同刻的量相加', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 700, deductionEndTime: NOW + 7 * DAY }),
      pkg({ remaining: 120, deductionEndTime: NOW + 5 * DAY }),  // 最早（同刻之一）
      pkg({ remaining: 880, deductionEndTime: NOW + 5 * DAY }),  // 最早（同刻之二）
    ], WINDOW_DAYS, NOW)
    expect(split?.earliestExpiringAt).toBe(NOW + 5 * DAY)
    expect(
      split?.earliestExpiringAmount,
      '★ 最早那批（同刻并列）的量 = 120 + 880，既不是 700 也不是总额 1700',
    ).toBe(1000)
  })

  /**
   * ⚠️⚠️ **已过期的包不得当选「最早作废时刻」**（2026-10-13 审计修正）。
   *
   * 取最早时不约束 `> now`，则「一个已过期但 `active` 仍为 true 的包」会
   * **恒定当选**（它比任何未来时刻都早）⇒ `expiryCountdown` 拿到过去时刻、
   * 返回空串 ⇒ **整段倒计时消失**，尽管桶里还有一笔钱几天后作废。
   *
   * ⚠️ 可达性不是假设：TRAE 的 `active` 是**硬编码 true**
   * （`src/trae-credits.ts`），压根不反映是否过期；buddy 系也会在
   * 「解析时刻算 `active`、渲染时刻算分桶」之间跨过到期点时出现。
   */
  it('临期桶里的已过期包不参与「最早」选举（否则倒计时整段消失）', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 100, deductionEndTime: NOW - 5 * DAY }), // 已过期但 active 仍为 true
      pkg({ remaining: 50, deductionEndTime: NOW + 3 * DAY }),
    ], WINDOW_DAYS, NOW)
    expect(split?.expiring, '两笔都计入临期桶（它确实会作废）').toBe(150)
    // ⚠️ 关键：取未过期那笔，而不是那个 5 天前的。
    expect(split?.earliestExpiringAt, '已过期包会让倒计时恒空，必须被排除').toBe(NOW + 3 * DAY)
  })

  /** 窗口不可用时**必须返回 null**（而不是 0/0）：调用方据此不渲染分类行。
   * 把"不知道窗口"渲染成"临时 0 · 永久 0"是在说谎 —— 非 buddy provider 的
   * 积分根本没有这个维度（后端不给它们带 windowDays，于是这里是 undefined/null；
   * 而 `Number(null) === 0`，不显式挡住就会被当成"窗口 0 天"）。
   */
  it('窗口缺省或非法时返回 null，不编造分类', () => {
    const packages = [pkg()]
    for (const bad of [undefined, null, NaN, -1, 'abc']) {
      expect(splitCreditsByExpiry(packages, bad as never, NOW), String(bad)).toBeNull()
    }
  })

  it('packages 非数组时返回 null（响应形状异常不崩）', () => {
    expect(splitCreditsByExpiry(undefined as never, WINDOW_DAYS, NOW)).toBeNull()
    expect(splitCreditsByExpiry('nope' as never, WINDOW_DAYS, NOW)).toBeNull()
  })

  it('now 非法时退回当前时间而不是算出 NaN', () => {
    const split = splitCreditsByExpiry([pkg({ deductionEndTime: Date.now() + 9 * DAY })], WINDOW_DAYS, NaN)
    expect(split?.expiring).toBe(100)
    expect(split?.longTerm).toBe(0)
    expect(split?.permanent).toBe(0)
  })
})

/**
 * ⚠️ **对账**：同一组 fixture 喂前后端，两桶必须逐分不差。
 * 这是本文件存在的核心理由 —— 见文件头。
 */
describe('与后端 splitBuddyCreditsByExpiry 对账', () => {
  const fixtures: Array<[string, CreditPackage[], number?]> = [
    ['9 天的 Bonus Pack', [pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })]],
    ['3008 天的套餐', [pkg({ name: 'Free Plan Subscription', remaining: 100, deductionEndTime: NOW + 3008 * DAY })]],
    ['恰好 15 天线', [pkg({ deductionEndTime: NOW + 15 * DAY })]],
    ['差 1 毫秒满 15 天', [pkg({ deductionEndTime: NOW + 15 * DAY - 1 })]],
    ['差 1 毫秒不足 15 天', [pkg({ deductionEndTime: NOW + 15 * DAY + 1 })]],
    ['临时与永久混合', [
      pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY }),
      pkg({ name: '裂变包', remaining: 100, deductionEndTime: NOW + 17 * DAY }),
      pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY }),
    ]],
    ['失效包', [pkg({ active: false, remaining: 500, deductionEndTime: NOW + DAY })]],
    ['本周期余额为 0（终身还有钱的套餐）', [pkg({ remaining: 0, total: 500 })]],
    ['到期时间未知', [pkg({ deductionEndTime: undefined })]],
    ['到期时间已越过', [pkg({ remaining: 30, deductionEndTime: NOW - DAY })]],
    ['脏余额', [pkg({ remaining: -5 }), pkg({ remaining: Number.NaN }), pkg({ remaining: 7.5 })]],
    ['浮点尾数', [
      pkg({ remaining: 74.61000076, deductionEndTime: NOW + 9 * DAY }),
      pkg({ remaining: 125.39, deductionEndTime: NOW + 10 * DAY }),
    ]],
    ['空列表', []],
    ['窗口放宽到 31 天', [pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })], 31],
  ]

  for (const [label, packages, windowDays] of fixtures) {
    const days = windowDays ?? WINDOW_DAYS
    it(label, () => {
      // ⚠️ 前端三档归约成后端两档后比对（见 `reduceFrontendToBackend` 的说明）：
      // 共同维度是 `expiring`，且 permanent+longTerm 必须等于后端的 permanent。
      const frontend = splitCreditsByExpiry(packages, days, NOW)
      expect(frontend).not.toBeNull()
      expect(reduceFrontendToBackend(frontend!)).toEqual(backendSplit(packages, days, NOW))
    })
  }

  /**
   * 时间流动也要一致：同一份 fixture 在不同 now 下，两侧必须同步改判。
   * （面板渲染时传 Date.now()，选号时传 selector 的 now —— 两者可能相差几十秒。）
   */
  it('时间前进后两侧同步越线', () => {
    const packages = [pkg({ remaining: 100, deductionEndTime: NOW + 15 * DAY + 30_000 })]
    const before = splitCreditsByExpiry(packages, WINDOW_DAYS, NOW)
    expect(reduceFrontendToBackend(before!)).toEqual(backendSplit(packages, WINDOW_DAYS, NOW))
    // 40 秒后越过 15 天线
    const later = NOW + 40_000
    const after = splitCreditsByExpiry(packages, WINDOW_DAYS, later)
    expect(after).toEqual({ expiring: 100, longTerm: 0, permanent: 0, earliestExpiringAt: NOW + 15 * DAY + 30_000, earliestExpiringAmount: 100 })
    expect(reduceFrontendToBackend(after!)).toEqual(backendSplit(packages, WINDOW_DAYS, later))
  })

  /**
   * ⚠️ **TRAE 真实数据**（用户报障的那个号，2026-09-29 抓包）：
   * 「每月登录赠送 500」（`expire_time` 1790783999 = 2026-09-30 23:59:59）
   * 与三个「签到奖励 150」（10/28·29·30 到期，各 +31 天）。
   *
   * 用户报障原文：「trae的积分没按长期、临时分开显示」。根因是 TRAE 分支
   * **不回传 `windowDays`**，前端 `splitCreditsByExpiry` 拿不到窗口就返回 null、
   * 不渲染分类行（那道门禁本身是对的：防止给"没有作废维度"的 provider
   * 凭空渲染假分类行）。
   *
   * 这里锁死「TRAE 的真实到期数据 + 窗口 → 正确分桶」：
   * 500 落在 15 天内 ⇒ 临期（红）；三个 150 都在 15 天外 ⇒ 长期（黄）。
   * ⚠️ 2026-10-12 起分**三档**：这三个 150 有明确到期日 ⇒ 长期（不是永久），
   * 只有服务端不给到期时间才是永久。
   */
  it('TRAE 真实数据分桶：9/30 到期的 500 是临期、三个 10/28+ 的 150 是长期', () => {
    const base = NOW // 2026-10-01 前后的固定时刻由文件顶部的 NOW 提供
    const traePackages = [
      pkg({ name: '每月登录赠送', remaining: 500, deductionEndTime: base + 1 * DAY }),
      pkg({ name: '签到奖励', remaining: 150, deductionEndTime: base + 28 * DAY }),
      pkg({ name: '签到奖励', remaining: 150, deductionEndTime: base + 29 * DAY }),
      pkg({ name: '签到奖励', remaining: 150, deductionEndTime: base + 30 * DAY }),
    ]
    expect(splitCreditsByExpiry(traePackages, WINDOW_DAYS, base))
      .toEqual({ expiring: 500, longTerm: 450, permanent: 0, earliestExpiringAt: base + 1 * DAY, earliestExpiringAmount: 500 })
    expect(formatExpirySplitLine(splitCreditsByExpiry(traePackages, WINDOW_DAYS, base), v => String(v)))
      .toBe('长期 450 · 临期 500')
    // 与后端同规则（TRAE 复用 buddy 的分桶判据，不存在第二套标准）——
    // 前端三档归约成后端两档后必须逐分不差。
    const frontend = splitCreditsByExpiry(traePackages, WINDOW_DAYS, base)
    expect(reduceFrontendToBackend(frontend!)).toEqual(backendSplit(traePackages, WINDOW_DAYS, base))
  })
})

describe('daysUntilExpiry / expiryBucketLabel', () => {
  it('给出距到期天数；无到期时间返回 null', () => {
    expect(daysUntilExpiry(pkg({ deductionEndTime: NOW + 9 * DAY }), NOW)).toBeCloseTo(9, 6)
    expect(daysUntilExpiry(pkg({ deductionEndTime: undefined }), NOW)).toBeNull()
    expect(daysUntilExpiry(pkg({ deductionEndTime: 0 }), NOW)).toBeNull()
  })

  it('窗口内标「N 天内到期」，窗口外标「还有 N 天」', () => {
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 9 * DAY }), WINDOW_DAYS, NOW))
      .toBe('9 天内到期')
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 3008 * DAY }), WINDOW_DAYS, NOW))
      .toBe('还有 3008 天')
    // 不足 1 天向上取整为 1，避免出现「0 天内到期」
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 60_000 }), WINDOW_DAYS, NOW))
      .toBe('1 天内到期')
    expect(expiryBucketLabel(pkg({ deductionEndTime: undefined }), WINDOW_DAYS, NOW))
      .toBe('到期时间未知')
  })

  /**
   * 拿不到窗口时返回 **null**，让调用方降级 —— 这是有意的：分类标签（「N 天内
   * 到期」）需要窗口才有意义，而客观天数由 `formatPackageLine` 自己拼出来
   * （「距到期 9 天」），不依赖窗口。用一个"假装是分类"的字符串会误导。
   */
  it('拿不到窗口时返回 null，由调用方降级为只显示天数', () => {
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 9 * DAY }), null, NOW)).toBeNull()
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 9 * DAY }), undefined, NOW)).toBeNull()
    // 但到期时间未知仍给确定文案（它不依赖窗口）
    expect(expiryBucketLabel(pkg({ deductionEndTime: undefined }), null, NOW)).toBe('到期时间未知')
  })
})

describe('formatExpirySplitLine（卡片那一行）', () => {
  const format = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

  /**
   * ⚠️ **三档顺序固定：永久 → 长期 → 临期**（用户 2026-10-12 定），用词是
   * 「长期」不是「永久」——只有**服务端没给到期时间**的才叫永久（用户
   * 2026-09-29 纠正过：buddy / TRAE 的积分都有到期日，只是较远）。
   *
   * 小数按两位显示（`100.50`）—— 与卡片上**总额**用的 `formatCredits` 同一口径。
   */
  it('永久在前、长期居中、临期在后', () => {
    expect(formatExpirySplitLine({ permanent: 3852, longTerm: 3753, expiring: 100 }, format))
      .toBe('永久 3852 · 长期 3753 · 临期 100')
    expect(formatExpirySplitLine({ permanent: 0, longTerm: 100.5, expiring: 250 }, format))
      .toBe('长期 100.50 · 临期 250')
    expect(formatExpirySplitLine({ permanent: 0, longTerm: 0, expiring: 74.61 }, format))
      .toBe('临期 74.61')
  })

  it('分类不可用时返回 null（调用方据此不渲染）', () => {
    expect(formatExpirySplitLine(null, format)).toBeNull()
  })

  /**
   * ⚠️ 三档全 0 时返回 `null`（**不渲染**）—— 与两档时代的「长期 0 · 临时 0」
   * 不同：现在 0 值桶**不参与拼接**（0 值进文案只让一行变长而无信息）。
   * 「锁定永久积分后为什么没有可用账号」这个线索由**账号卡片整体**给出
   * （余额为 0 的那一行），不需要靠分桶行里的一串 0。
   */
  it('三档皆 0 返回 null（不渲染空行）', () => {
    expect(formatExpirySplitLine({ permanent: 0, longTerm: 0, expiring: 0 }, format)).toBeNull()
  })
})

/**
 * 三档**带色分段**（`expirySplitParts`）—— 用户 2026-10-12 明确要求
 * 「永久（绿）/ 长期（黄）/ 临期（红 + 倒计时）」。
 *
 * ⚠️ 为什么不用 `formatExpirySplitLine` 的字符串：那个只能整体一个颜色，
 * 而三档要各带各的色。React 侧必须拿到**结构化分段**才能逐段设 `data-tone`。
 */
describe('expirySplitParts（三档带色分段）', () => {
  const format = (v: number) => String(Math.round(v))
  const NOW_MS = Date.UTC(2026, 9, 12, 0, 0, 0)

  it('三档各自带色：永久 ok（绿）/ 长期 warn（黄）/ 临期 error（红）', () => {
    const parts = expirySplitParts(
      { permanent: 3852, longTerm: 3753, expiring: 100, earliestExpiringAt: NOW_MS + 2 * DAY },
      format,
      NOW_MS,
    )
    expect(parts).toEqual([
      { key: 'permanent', text: '永久 3852', tone: 'ok' },
      { key: 'longTerm', text: '长期 3753', tone: 'warn' },
      { key: 'expiring', text: '临期 100', tone: 'error', countdown: '2 天 0 小时' },
    ])
  })

  it('临期段带倒计时（用户要的「倒计时」）', () => {
    const parts = expirySplitParts(
      { permanent: 0, longTerm: 0, expiring: 50, earliestExpiringAt: NOW_MS + 5 * 3600_000 + 20 * 60_000 },
      format,
      NOW_MS,
    )
    expect(parts).toEqual([
      { key: 'expiring', text: '临期 50', tone: 'error', countdown: '5 小时 20 分钟' },
    ])
  })

  it('零值桶不出现（不占版面）', () => {
    expect(expirySplitParts({ permanent: 100, longTerm: 0, expiring: 0, earliestExpiringAt: null }, format, NOW_MS))
      .toEqual([{ key: 'permanent', text: '永久 100', tone: 'ok' }])
  })

  it('分类不可用 / 全 0 时返回空数组', () => {
    expect(expirySplitParts(null, format, NOW_MS)).toEqual([])
    expect(expirySplitParts({ permanent: 0, longTerm: 0, expiring: 0, earliestExpiringAt: null }, format, NOW_MS))
      .toEqual([])
  })

  /**
   * ⚠️ 倒计时缺失时**不编造**：`earliestExpiringAt` 拿不到就只给金额，
   * 不显示「已过期」这类噪音（与 `quotaCountdown` 同款约定）。
   */
  it('最早作废时刻缺失/已过期时不给倒计时', () => {
    expect(expirySplitParts({ permanent: 0, longTerm: 0, expiring: 50, earliestExpiringAt: null }, format, NOW_MS))
      .toEqual([{ key: 'expiring', text: '临期 50', tone: 'error' }])
    expect(expirySplitParts({ permanent: 0, longTerm: 0, expiring: 50, earliestExpiringAt: NOW_MS - DAY }, format, NOW_MS))
      .toEqual([{ key: 'expiring', text: '临期 50', tone: 'error' }])
  })
})

describe('expiryCountdown（临期倒计时）', () => {
  const base = Date.UTC(2026, 9, 12, 0, 0, 0)
  it('粗粒度：天 / 小时 / 分钟', () => {
    expect(expiryCountdown(base + 3 * DAY + 4 * 3600_000, base)).toBe('3 天 4 小时')
    expect(expiryCountdown(base + 5 * 3600_000 + 20 * 60_000, base)).toBe('5 小时 20 分钟')
    expect(expiryCountdown(base + 9 * 60_000, base)).toBe('9 分钟')
    // 不足 1 分钟也至少显示 1 分钟（不出现「0 分钟」）
    expect(expiryCountdown(base + 30_000, base)).toBe('1 分钟')
  })
  it('已过期 / 非法值返回空串（不显示噪音）', () => {
    expect(expiryCountdown(base - 1000, base)).toBe('')
    expect(expiryCountdown(base, base)).toBe('')
    expect(expiryCountdown(0, base)).toBe('')
    expect(expiryCountdown(Number.NaN, base)).toBe('')
    expect(expiryCountdown(undefined as never, base)).toBe('')
  })

  /**
   * ⚠️⚠️ **「还没过期」与「已过期」必须分道**（2026-10-13 审计修正）。
   *
   * 原实现用 `Math.round((at-ref)/60000)`：剩余 29 秒时 round 出 0 ⇒ 命中
   * `minutes <= 0` 返回空串 ⇒ 用户看到倒计时一路数到「1 分钟」后**整段突然
   * 消失**，而「马上就作废」恰恰是最该看到的信号。
   *
   * 改用**向上取整**：只要 `at > ref` 就至少给 1 分钟，绝不静默消失。
   */
  it('剩余不足 1 分钟时仍显示倒计时（不得静默消失）', () => {
    expect(expiryCountdown(base + 1, base)).toBe('1 分钟')
    expect(expiryCountdown(base + 29_000, base)).toBe('1 分钟')
    expect(expiryCountdown(base + 59_999, base)).toBe('1 分钟')
    // 恰好 1 分钟整 —— 与「不足 1 分钟」同为 1 分钟（粗粒度刻意的设计）
    expect(expiryCountdown(base + 60_000, base)).toBe('1 分钟')
    // ⚠️ 61 秒必须是 2 分钟：向上取整不能把「超过 1 分钟」也压成 1
    expect(expiryCountdown(base + 61_000, base)).toBe('2 分钟')
  })
})

/**
 * 「当日刷新池」的分池展示（Loomy / Raccoon）。
 *
 * 用户 2026-09-29 要求：「Raccoon 我看有当日积分？那应该按照 loomy 那样显示」。
 *
 * 与 `formatExpirySplitLine` 的区别：那个按**到期时间**分桶（buddy / TRAE /
 * LobsterAI 的包带 `deductionEndTime`），这个按**池名**分（Loomy / Raccoon 的池
 * 是服务端按语义分开下发的，没有到期字段）。两者互斥。
 */
describe('formatPoolSplitLine（当日池单独显示）', () => {
  const format = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

  /** Loomy 的真实形态：`makePackage('永久积分', …)` + `makePackage('每日赠送', …)`。 */
  it('Loomy：永久在前、每日在后', () => {
    const packages = [
      pkg({ name: '永久积分', remaining: 15000 }),
      pkg({ name: '每日赠送', remaining: 4992 }),
    ]
    expect(formatPoolSplitLine(packages, format, '永久')).toBe('永久 15000 · 每日 4992')
  })

  /**
   * ⚠️ Raccoon 的池是按「服务端给了哪个字段」**动态 push** 的
   * （`daily_points` 缺失时就没有这一项），故必须按**池名**识别，不能用下标。
   * 这里把每日池放在**第二个**位置，锁死这一点。
   */
  it('Raccoon：按池名识别（每日积分在第二位也能找到）', () => {
    const packages = [
      pkg({ name: '奖励积分', remaining: 100 }),
      pkg({ name: '每日积分', remaining: 500 }),
      pkg({ name: '充值积分', remaining: 2000 }),
    ]
    // 其余池求和：100 + 2000 = 2100
    expect(formatPoolSplitLine(packages, format, '长期')).toBe('长期 2100 · 每日 500')
  })

  it('没有当日池时返回 null（调用方据此不渲染，退回到期分桶）', () => {
    expect(formatPoolSplitLine([pkg({ name: '奖励积分', remaining: 100 })], format)).toBeNull()
    expect(formatPoolSplitLine([], format)).toBeNull()
    expect(formatPoolSplitLine(undefined as never, format)).toBeNull()
  })

  it('findDailyPool 认得两个已知池名，认不出别的', () => {
    expect(findDailyPool([pkg({ name: '每日赠送', remaining: 1 })])?.name).toBe('每日赠送')
    expect(findDailyPool([pkg({ name: '每日积分', remaining: 1 })])?.name).toBe('每日积分')
    expect(findDailyPool([pkg({ name: 'Bonus Pack', remaining: 1 })])).toBeNull()
  })

  /** 失效包不计入「其余池」合计（那部分扣不到），与 splitCreditsByExpiry 同口径。 */
  it('其余池求和跳过失效包', () => {
    const packages = [
      pkg({ name: '每日积分', remaining: 500 }),
      pkg({ name: '奖励积分', remaining: 100 }),
      pkg({ name: '充值积分', remaining: 999, active: false }),
    ]
    expect(formatPoolSplitLine(packages, format, '长期')).toBe('长期 100 · 每日 500')
  })
})

/**
 * **逐命名池全列**（Accio 的三类桶）。
 *
 * ## 为什么需要它，而不是复用 `formatPoolSplitLine`
 *
 * `formatPoolSplitLine` 是**两桶**形状（「长期 X · 每日 Y」）—— 它把「每日池之外
 * 的**全部**池」求和成一个 `longTermLabel`。对 Loomy（永久 + 每日）与
 * Raccoon（奖励/会员/充值 + 每日）都成立，但 Accio 的桶是**三类语义并列**
 * （`每日积分` / `每月积分` / `推荐积分`），每月与推荐**都不该被笼统求和成
 * 「长期」** —— 用户 2026-10-13 要求「完全改成 loomy 那样」，而 loomy 的展示
 * 恰恰是**逐池列名**（`永久 15000 · 每日 4992`），不是「长期 = 其余之和」。
 *
 * ⇒ 新增本函数，**逐池按服务端下发的名字列出**。
 *
 * ⚠️ **刻意不改 `formatPoolSplitLine`**：它的输出是既有契约
 * （`'长期 2100 · 每日 500'` / `'永久 15000 · 每日 4992'`，见上面那组用例），
 * 而 loomy / raccoon 走的就是它 —— 改它等于同时改两家已验收的显示。
 */
describe('formatNamedPoolLine（逐命名池全列，Accio）', () => {
  const format = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

  it('Accio：三个池按服务端下发的顺序逐个列出（不求和、不归类）', () => {
    const packages = [
      pkg({ name: '每日积分', remaining: 199 }),
      pkg({ name: '每月积分', remaining: 0 }),
      pkg({ name: '推荐积分', remaining: 0 }),
    ]
    expect(formatNamedPoolLine(packages, format)).toBe('每日 199 · 每月 0 · 推荐 0')
  })

  /** ⚠️ 池名去掉「积分」后缀做短标签（版面上「每日积分 199」重复且长）。 */
  it('去掉「积分」后缀做短标签', () => {
    expect(formatNamedPoolLine([pkg({ name: '每日积分', remaining: 5 })], format)).toBe('每日 5')
  })

  it('认不出的池名原样使用（不猜、不丢）', () => {
    expect(formatNamedPoolLine([pkg({ name: 'Bonus Pack', remaining: 7 })], format))
      .toBe('Bonus Pack 7')
  })

  /** 失效包不列出（扣不到的东西显示出来会让用户以为还有）。 */
  it('失效包不列出', () => {
    const packages = [
      pkg({ name: '每日积分', remaining: 10 }),
      pkg({ name: '每月积分', remaining: 999, active: false }),
    ]
    expect(formatNamedPoolLine(packages, format)).toBe('每日 10')
  })

  it('一个都没有时返回 null（调用方据此不渲染该行）', () => {
    expect(formatNamedPoolLine([], format)).toBeNull()
    expect(formatNamedPoolLine(undefined as never, format)).toBeNull()
    expect(formatNamedPoolLine([pkg({ name: '每月积分', remaining: 1, active: false })], format)).toBeNull()
  })

  /** 数字格式化失败（拿到非有限值）时**整个返回 null**，不产出半截文案。 */
  it('格式化失败时返回 null（不产出半截文案）', () => {
    expect(formatNamedPoolLine([pkg({ name: '每日积分', remaining: 1 })], () => null as never)).toBeNull()
  })
})

/**
 * 账号名 hover 的资源包列表（用户 2026-09-29 要求：显示「剩余/总量」与到期时间，
 * 没有到期时间显示「长期」）。
 */
describe('formatPackageExpiry（单个包的到期列）', () => {
  it('有到期时间：绝对日期 + 相对天数', () => {
    expect(formatPackageExpiry(pkg({ deductionEndTime: NOW + 8 * DAY }), NOW))
      .toBe('2026-10-09（8 天后）')
  })

  /** ⚠️ 用户明确要求的降级：拿不到到期时间显示「长期」。 */
  it('无到期时间显示「长期」', () => {
    for (const bad of [undefined, 0, Number.NaN, null]) {
      expect(formatPackageExpiry(pkg({ deductionEndTime: bad as never }), NOW), String(bad)).toBe('长期')
    }
  })

  it('已过期不显示「-3 天后」', () => {
    expect(formatPackageExpiry(pkg({ deductionEndTime: NOW - 3 * DAY }), NOW))
      .toBe('2026-09-28（已过期）')
  })

  /** 不足 1 天向上取整为 1，避免出现「0 天后」。 */
  it('剩余不足 1 天显示 1 天后', () => {
    expect(formatPackageExpiry(pkg({ deductionEndTime: NOW + 60_000 }), NOW))
      .toBe('2026-10-01（1 天后）')
  })
})

describe('formatPackageTooltip（包列表）', () => {
  it('每行含名称、剩余/总量、到期时间', () => {
    const text = formatPackageTooltip(
      [pkg({ name: 'Bonus Pack', remaining: 250, total: 500, deductionEndTime: NOW + 8 * DAY })],
      { format: v => String(v), now: NOW },
    )
    expect(text).toBe('Bonus Pack  250 / 500  2026-10-09（8 天后）')
  })

  it('无到期时间的包那一行显示「长期」', () => {
    const text = formatPackageTooltip(
      [pkg({ name: '拉新权益包', remaining: 100, deductionEndTime: undefined })],
      { format: v => String(v), now: NOW },
    )
    expect(text).toContain('长期')
    expect(text).toBe('拉新权益包  100 / 100  长期')
  })

  /**
   * ⚠️ **只列还能用的包**（用户 2026-09-29 要求）：
   * 「已经消耗为0的过滤掉，已经过期的过滤掉」。
   *
   * 三条过滤规则：`remaining <= 0` / 到期时刻已过 / `active === false`。
   */
  it('已消耗为 0 的包不显示', () => {
    const text = formatPackageTooltip([
      pkg({ name: '有余额', remaining: 100, deductionEndTime: NOW + 8 * DAY }),
      pkg({ name: '已用完', remaining: 0, deductionEndTime: NOW + 8 * DAY }),
    ], { format: v => String(v), now: NOW })!
    expect(text).toContain('有余额')
    expect(text).not.toContain('已用完')
    expect(text.split('\n')).toHaveLength(1)
  })

  /** 负余额（服务端计量回滚等异常）同样过滤 —— 它不可能"还能用"。 */
  it('负余额的包不显示', () => {
    const text = formatPackageTooltip([
      pkg({ name: '正常', remaining: 10 }),
      pkg({ name: '负数', remaining: -5 }),
    ], { format: v => String(v), now: NOW })!
    expect(text).not.toContain('负数')
  })

  /**
   * ⚠️ **已过期必须按 `now` 现算，不能只判 `active`**：实测各 provider 的
   * `active` 口径不一致 —— TRAE / Qoder 的 `active` **恒为 true**，
   * 只判它会让已过期的包继续显示成"（已过期）"。
   */
  it('已过期的包不显示（即使 active 仍为 true）', () => {
    const text = formatPackageTooltip([
      pkg({ name: '还有效', remaining: 100, deductionEndTime: NOW + 8 * DAY }),
      pkg({ name: '已过期但active为true', remaining: 100, active: true, deductionEndTime: NOW - 1 }),
    ], { format: v => String(v), now: NOW })!
    expect(text).toContain('还有效')
    expect(text).not.toContain('已过期但active为true')
  })

  it('被标记失效的包不显示', () => {
    const text = formatPackageTooltip([
      pkg({ name: '有效包', remaining: 10 }),
      pkg({ name: '失效包', active: false, remaining: 10 }),
    ], { format: v => String(v), now: NOW })!
    expect(text).toContain('有效包')
    expect(text).not.toContain('失效包')
  })

  /**
   * ⚠️ 全部被过滤掉时返回 **null**（不是空串）：调用方据此不挂 title，
   * 否则用户 hover 会看到一个空浮层。
   */
  it('全部不可用时返回 null（不挂空 title）', () => {
    const opts = { format: (v: number) => String(v), now: NOW }
    expect(formatPackageTooltip([pkg({ name: '用完', remaining: 0 })], opts)).toBeNull()
    expect(formatPackageTooltip([pkg({ name: '过期', remaining: 5, deductionEndTime: NOW - 1 })], opts)).toBeNull()
    expect(formatPackageTooltip([pkg({ name: '失效', active: false, remaining: 5 })], opts)).toBeNull()
  })

  /**
   * ⚠️ **主排序键 = 到期时刻升序**（用户 2026-09-29 要求）：
   * 「最快到期的排到最上面，最晚到期的排到最下面」。
   *
   * 本函数是所有挂了包列表的 provider（buddy / workbuddy / lobsterai /
   * qoder / qodercn / trae）**共用**的，故此用例同时锁死了那六家的行为。
   */
  it('按到期时间升序：最快到期在最上、最晚到期在最下', () => {
    const text = formatPackageTooltip([
      pkg({ name: '最晚', remaining: 100, deductionEndTime: NOW + 300 * DAY }),
      pkg({ name: '最快', remaining: 100, deductionEndTime: NOW + 2 * DAY }),
      pkg({ name: '中间', remaining: 100, deductionEndTime: NOW + 30 * DAY }),
    ], { format: v => String(v), now: NOW })!
    const lines = text.split('\n')
    expect(lines[0]).toContain('最快')
    expect(lines[1]).toContain('中间')
    expect(lines[2]).toContain('最晚')
  })

  /**
   * ⚠️ 到期时间**未知**的包必须**沉底**（视为最晚到期）。
   * 它们是「长期」那一档 —— 若按 0 处理会跑到最上面，恰好说反。
   */
  it('到期时间未知的沉底（它不是"最快到期"）', () => {
    const text = formatPackageTooltip([
      pkg({ name: '无到期', remaining: 999, deductionEndTime: undefined }),
      pkg({ name: '30天', remaining: 1, deductionEndTime: NOW + 30 * DAY }),
      pkg({ name: '2天', remaining: 1, deductionEndTime: NOW + 2 * DAY }),
    ], { format: v => String(v), now: NOW })!
    const lines = text.split('\n')
    expect(lines[0]).toContain('2天')
    expect(lines[1]).toContain('30天')
    expect(lines[2]).toContain('无到期')
    expect(lines[2]).toContain('长期')
  })

  /** 次级键：同一到期时刻内按剩余量降序（保留"先看还有钱的包"）。 */
  it('同一到期时刻内按剩余量降序', () => {
    const same = NOW + 5 * DAY
    const text = formatPackageTooltip([
      pkg({ name: '少', remaining: 10, deductionEndTime: same }),
      pkg({ name: '多', remaining: 900, deductionEndTime: same }),
      pkg({ name: '中', remaining: 100, deductionEndTime: same }),
    ], { format: v => String(v), now: NOW })!
    const lines = text.split('\n')
    expect(lines[0]).toContain('多')
    expect(lines[1]).toContain('中')
    expect(lines[2]).toContain('少')
  })

  /** 到期时刻相同时也必须结果确定（不能依赖引擎的稳定排序）。 */
  it('全部无到期时间时退化为剩余量降序', () => {
    const text = formatPackageTooltip([
      pkg({ name: 'A', remaining: 1 }),
      pkg({ name: 'B', remaining: 500 }),
      pkg({ name: 'C', remaining: 50 }),
    ], { format: v => String(v), now: NOW })!
    expect(text.split('\n').map(l => l[0])).toEqual(['B', 'C', 'A'])
  })

  /**
   * ⚠️ 过滤与排序都按**渲染时刻**现算：同一份数据在不同 `now` 下结果不同。
   * （宿主长期开着，时间只向前流 —— 一个 1 秒后到期的包，下一秒就该消失。）
   */
  it('过滤与排序随时间推进而改变', () => {
    const packages = [
      pkg({ name: '30秒后到期', remaining: 100, deductionEndTime: NOW + 30_000 }),
      pkg({ name: '长期包', remaining: 200, deductionEndTime: NOW + 300 * DAY }),
    ]
    const before = formatPackageTooltip(packages, { format: v => String(v), now: NOW })!
    expect(before.split('\n')[0]).toContain('30秒后到期')
    // 40 秒后：那个包已过期，应当消失
    const after = formatPackageTooltip(packages, { format: v => String(v), now: NOW + 40_000 })!
    expect(after).not.toContain('30秒后到期')
    expect(after).toContain('长期包')
  })

  /**
   * ⚠️ 真实场景：实测 CodeBuddy 中国版一个账号有 **105 个资源包**。
   * 不截断的话 tooltip 会长到无法阅读，所以取前 N 个，其余汇总成一行并给出
   * **合计剩余**（不丢总量信息）。
   * ⚠️ 截断发生在**排序之后** —— 被截掉的是"最晚到期"的那批，
   * 用户最该关心的"快过期了"永远在最上面。
   */
  it('包数超过 maxRows 时截断并汇总剩余合计（截掉的是最晚到期的）', () => {
    const many = Array.from({ length: 20 }, (_, i) => pkg({
      name: `包${i}`,
      remaining: 100,
      total: 100,
      // 包0 最快到期（1 天），包19 最晚（20 天）
      deductionEndTime: NOW + (i + 1) * DAY,
    }))
    const text = formatPackageTooltip(many, { format: v => String(v), now: NOW, maxRows: 12 })!
    const lines = text.split('\n')
    expect(lines).toHaveLength(13)
    // 到期升序：包0 在最上，包11 是第 12 个（最后一个显示的）
    expect(lines[0]).toContain('包0')
    expect(lines[11]).toContain('包11')
    // 被截掉的是包12..包19（8 个），各 100 ⇒ 合计 800
    expect(lines[12]).toBe('…另有 8 个包，合计剩余 800')
  })

  /**
   * ⚠️ 过滤发生在**截断之前**：不可用的包不占 `maxRows` 名额，
   * 也不会被算进「另有 N 个包」。
   */
  it('不可用的包既不显示、也不占 maxRows 名额、也不计入汇总', () => {
    const many = [
      ...Array.from({ length: 12 }, (_, i) => pkg({
        name: `有效${i}`, remaining: 100, deductionEndTime: NOW + (i + 1) * DAY,
      })),
      // 这三个都不可用 —— 若不过滤，它们会挤掉「有效13」并把汇总数字搞错
      pkg({ name: '失效', remaining: 50, active: false, deductionEndTime: NOW + 100 * DAY }),
      pkg({ name: '用完', remaining: 0, deductionEndTime: NOW + 100 * DAY }),
      pkg({ name: '过期', remaining: 50, deductionEndTime: NOW - DAY }),
      pkg({ name: '有效13', remaining: 50, deductionEndTime: NOW + 101 * DAY }),
    ]
    const text = formatPackageTooltip(many, { format: v => String(v), now: NOW, maxRows: 12 })!
    const lines = text.split('\n')
    // 可用包共 13 个 ⇒ 显示 12 个 + 汇总 1 个
    expect(lines).toHaveLength(13)
    expect(text).not.toContain('失效')
    expect(text).not.toContain('用完')
    expect(text).not.toContain('过期')
    // 被截掉的只有「有效13」一个
    expect(lines[12]).toBe('…另有 1 个包，合计剩余 50')
  })

  it('空或非数组返回 null（调用方据此不挂 title）', () => {
    const opts = { format: (v: number) => String(v), now: NOW }
    expect(formatPackageTooltip([], opts)).toBeNull()
    expect(formatPackageTooltip(undefined as never, opts)).toBeNull()
  })
})

/**
 * ⚠️ **能力门控**：只有余额真由多个资源包构成的 provider 才挂包列表。
 *
 * 这不是"避免冗余"，而是**防止显示错误信息**：loomy 的 packages 是后端合成的
 * 两个条目（`makePackage('永久积分')` / `makePackage('每日赠送')`），它们
 * **没有** `deductionEndTime` ⇒ 按降级规则会被标成「永久」。于是 loomy 卡片上
 * 会出现「每日赠送 4992 / 4992 永久」—— 而那笔恰恰**当天就作废**，说反了。
 */
describe('supportsCreditPackageList 的门控', () => {
  it('buddy 系 + lobsterai + qoder/qodercn + trae 为真', () => {
    for (const p of ['buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae']) {
      expect(supportsCreditPackageList(p), p).toBe(true)
    }
  })

  /** 关键：loomy 虽支持「锁定永久积分」，但**不能**挂包列表。 */
  it('loomy 为假（它的两个池是合成的、无到期字段，列出会把每日赠送标成永久）', () => {
    expect(supportsCreditPackageList('loomy')).toBe(false)
  })

  it('其余 provider 与未知值一律为假（默认关闭）', () => {
    for (const p of ['codearts', 'cline', 'raccoon', '', undefined]) {
      expect(supportsCreditPackageList(p as never), String(p)).toBe(false)
    }
  })
})

/**
 * ⚠️ **排序必须对所有 provider 生效**（用户 2026-09-29 要求）：
 * 「有资源包列表显示的provider都要做这个」。
 *
 * 保证方式是「只有**一个**排序实现」—— `formatPackageTooltip` 内部按到期升序排，
 * 而前端所有 provider 共用同一个 `packageTooltip` 计算点。若有人给某个 provider
 * 另写排序（或把排序挪到调用点），本用例会变红。
 */
describe('包列表排序的覆盖面（源码级）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const hubSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
  const expirySource = readFileSync(resolve(here, '../../plugin-src/client/credit-expiry.js'), 'utf8')

  it('排序只在 formatPackageTooltip 内部实现一次', () => {
    // 排序键用 packageExpiryMs（与显示同一个判据来源）
    const tooltipBody = expirySource.slice(expirySource.indexOf('export function formatPackageTooltip'))
    expect(tooltipBody).toContain('packageExpiryMs')
    // 未知到期沉底（不能按 0 处理，否则跑到最上面）
    expect(tooltipBody).toMatch(/=== null \? Infinity/)
  })

  it('前端只有一处调 formatPackageTooltip，且不按 provider 分支', () => {
    const calls = hubSource.match(/formatPackageTooltip\(/g) ?? []
    // 一处 import 处不会带括号调用，故调用点应为 1
    expect(calls).toHaveLength(1)
    // 调用点不得出现 provider 判断（那意味着某家走了别的排序）
    const callIndex = hubSource.indexOf('formatPackageTooltip(')
    const around = hubSource.slice(Math.max(0, callIndex - 400), callIndex + 200)
    expect(around).not.toMatch(/provider ===/)
  })
})


