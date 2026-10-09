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
  findDailyPool,
  formatExpirySplitLine,
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

describe('splitCreditsByExpiry（前端分桶）', () => {
  it('14 天内到期算临时，更久算永久', () => {
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 9 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 100, permanent: 0 })
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 3008 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 0, permanent: 100 })
  })

  it('恰好 15 天归永久（判据是"不足 15 天"）', () => {
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 15 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 0, permanent: 100 })
  })

  it('失效包与零余额包不计入', () => {
    expect(splitCreditsByExpiry([
      pkg({ active: false, remaining: 999, deductionEndTime: NOW + DAY }),
      pkg({ remaining: 0 }),
      pkg({ remaining: 100, deductionEndTime: NOW + 20 * DAY }),
    ], WINDOW_DAYS, NOW)).toEqual({ expiring: 0, permanent: 100 })
  })

  it('到期时间未知归永久（保守方向）', () => {
    expect(splitCreditsByExpiry([
      pkg({ deductionEndTime: undefined }),
      pkg({ deductionEndTime: 0 }),
      pkg({ deductionEndTime: Number.NaN }),
    ], WINDOW_DAYS, NOW)).toEqual({ expiring: 0, permanent: 300 })
  })

  /**
   * ⚠️ 窗口不可用时**必须返回 null**（而不是 0/0）：调用方据此不渲染分类行。
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
    expect(split).toEqual({ expiring: 100, permanent: 0 })
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
      expect(splitCreditsByExpiry(packages, days, NOW)).toEqual(backendSplit(packages, days, NOW))
    })
  }

  /**
   * 时间流动也要一致：同一份 fixture 在不同 now 下，两侧必须同步改判。
   * （面板渲染时传 Date.now()，选号时传 selector 的 now —— 两者可能相差几十秒。）
   */
  it('时间前进后两侧同步越线', () => {
    const packages = [pkg({ remaining: 100, deductionEndTime: NOW + 15 * DAY + 30_000 })]
    expect(splitCreditsByExpiry(packages, WINDOW_DAYS, NOW))
      .toEqual(backendSplit(packages, WINDOW_DAYS, NOW))
    // 40 秒后越过 15 天线
    const later = NOW + 40_000
    expect(splitCreditsByExpiry(packages, WINDOW_DAYS, later)).toEqual({ expiring: 100, permanent: 0 })
    expect(splitCreditsByExpiry(packages, WINDOW_DAYS, later))
      .toEqual(backendSplit(packages, WINDOW_DAYS, later))
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
   * 500 落在 15 天内 ⇒ 临时；三个 150 都在 15 天外 ⇒ 长期。
   */
  it('TRAE 真实数据分桶：9/30 到期的 500 是临时、三个 10/28+ 的 150 是长期', () => {
    const base = NOW // 2026-10-01 前后的固定时刻由文件顶部的 NOW 提供
    const traePackages = [
      pkg({ name: '每月登录赠送', remaining: 500, deductionEndTime: base + 1 * DAY }),
      pkg({ name: '签到奖励', remaining: 150, deductionEndTime: base + 28 * DAY }),
      pkg({ name: '签到奖励', remaining: 150, deductionEndTime: base + 29 * DAY }),
      pkg({ name: '签到奖励', remaining: 150, deductionEndTime: base + 30 * DAY }),
    ]
    expect(splitCreditsByExpiry(traePackages, WINDOW_DAYS, base))
      .toEqual({ expiring: 500, permanent: 450 })
    expect(formatExpirySplitLine(splitCreditsByExpiry(traePackages, WINDOW_DAYS, base), v => String(v)))
      .toBe('长期 450 · 临时 500')
    // 与后端同规则（TRAE 复用 buddy 的分桶判据，不存在第二套标准）
    expect(splitCreditsByExpiry(traePackages, WINDOW_DAYS, base))
      .toEqual(backendSplit(traePackages, WINDOW_DAYS, base))
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
   * ⚠️ **长期在前、临时在后**（用户 2026-09-29 要求），且用词是「长期」不是
   * 「永久」（用户 2026-09-29 纠正：buddy / TRAE 的积分都有到期日，只是较远）。
   *
   * 小数按两位显示（`100.50`）—— 与卡片上**总额**用的 `formatCredits` 同一口径，
   * 服务端精确值本就带小数（实测 `74.61000076`），这里不另立规则。
   */
  it('长期在前、临时在后', () => {
    expect(formatExpirySplitLine({ expiring: 250, permanent: 100.5 }, format))
      .toBe('长期 100.50 · 临时 250')
    expect(formatExpirySplitLine({ expiring: 74.61, permanent: 0 }, format))
      .toBe('长期 0 · 临时 74.61')
  })

  it('分类不可用时返回 null（调用方据此不渲染）', () => {
    expect(formatExpirySplitLine(null, format)).toBeNull()
  })

  /**
   * 全 0 也要显示 —— 「临时 0」正是「锁定永久积分后为什么没有可用账号」的答案
   * （实测中国版那个号就是长期 10064 · 临时 0：明明有分却全被判长期）。
   * 隐藏它会让用户对着有余额的卡片困惑。
   */
  it('两桶皆 0 仍显示（这是锁定失效的线索）', () => {
    expect(formatExpirySplitLine({ expiring: 0, permanent: 0 }, format)).toBe('长期 0 · 临时 0')
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

