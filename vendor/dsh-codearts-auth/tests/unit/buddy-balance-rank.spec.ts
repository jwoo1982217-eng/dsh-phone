/**
 * CodeBuddy / WorkBuddy 的「按积分何时作废」分档（`src/buddy-balance-rank.ts`）。
 *
 * ## 本文件锁死什么
 *
 * 1. **15 天这条线**（用户 2026-09-29 定的判据）：距扣费截止 < 15 天算临时、
 *    ≥ 15 天算永久。边界必须钉住 —— 判错一天就会把「马上作废」的积分当永久
 *    供起来（结果白白过期），或反过来提前烧掉长期积分。
 * 2. **口径是 `remaining`（本计费周期剩余）**，不是终身剩余。实测 CodeBuddy
 *    体验版套餐终身剩 500 而本周期剩 0 —— 那 500 实际扣不到，算进可用余额会
 *    让账号「看起来有钱却用不了」。
 * 3. **失效包（`active: false`）不参与**。
 * 4. **到期时间未知归永久**（保守方向：宁可少用一个号，不可误烧长期积分）。
 * 5. **锁定永久积分**时只剩永久积分的账号 → `none`（不可用）。
 * 6. 档内保持传入顺序（= Jet Hub 拖拽的手动顺序）。
 */
import { describe, expect, it } from 'vitest'
import {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  BUDDY_EXPIRING_WINDOW_MS,
  buddyBalanceTier,
  buddyExpiringWindowDays,
  buddyExpiringWindowMs,
  buddyTierUsable,
  describeBuddyCreditSplit,
  rankBuddyAccountsByBalance,
  splitBuddyCreditsByExpiry,
} from '../../src/buddy-balance-rank.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'

const DAY = 24 * 60 * 60 * 1000
/** 固定「当前时刻」，避免用例随真实时间漂移（也便于精确测边界）。 */
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

/** 造一个资源包。默认「有效 + 本周期还有 100 + 30 天后到期」。 */
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

function balance(...packages: CreditPackage[]): CreditBalance {
  return { total: 0, packages, expiredTotal: 0 }
}

describe('窗口常量', () => {
  it('15 天（用户定的判据）与毫秒换算一致', () => {
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
    expect(BUDDY_EXPIRING_WINDOW_MS).toBe(15 * DAY)
  })
})

/**
 * 窗口的运行时解析（`DSH_BUDDY_EXPIRING_WINDOW_DAYS`）。
 *
 * ## 为什么需要这道逃生门（真实数据）
 *
 * 实测 2026-09-29：15 天这条线在两站效果差别极大 —— WorkBuddy 的 Bonus Pack
 * 是 8～9 天（锁定后 5 个号里 4 个仍可用），而 CodeBuddy 中国版的裂变包按 30 天
 * 发放、剩余密集落在 **17～30 天** ⇒ 整池都被判成永久，锁定后**立刻无可用账号**。
 * 判据没错，但那类池想用小窗口就必然踩空，故允许显式放宽（如 31）。
 */
describe('buddyExpiringWindowDays（环境变量覆盖）', () => {
  const KEY = 'DSH_BUDDY_EXPIRING_WINDOW_DAYS'

  it('未设置时用默认的 15 天', () => {
    expect(buddyExpiringWindowDays({})).toBe(15)
    expect(buddyExpiringWindowDays({ [KEY]: '' })).toBe(15)
    expect(buddyExpiringWindowDays({ [KEY]: '   ' })).toBe(15)
  })

  it('给出正数时生效（可放宽到 31 天）', () => {
    expect(buddyExpiringWindowDays({ [KEY]: '31' })).toBe(31)
    expect(buddyExpiringWindowDays({ [KEY]: ' 7 ' })).toBe(7)
    expect(buddyExpiringWindowDays({ [KEY]: '15.5' })).toBe(15.5)
  })

  /**
   * ⚠️ **0 必须被当作合法值**：它的语义是「没有临时积分」⇒ 锁定期间整池不可用。
   * 写成 `parseInt(raw) || 默认值` 会让 0 被静默换成 15（本仓库在 Qoder
   * 排队超时上踩过同一个坑）。
   */
  it('0 是合法值（不被默认值吞掉）', () => {
    expect(buddyExpiringWindowDays({ [KEY]: '0' })).toBe(0)
    expect(buddyExpiringWindowMs({ [KEY]: '0' })).toBe(0)
  })

  it('非法值回落默认（配置写错不能让插件起不来）', () => {
    for (const bad of ['abc', '-1', 'NaN', 'Infinity', '15d', '{}']) {
      expect(buddyExpiringWindowDays({ [KEY]: bad }), bad).toBe(15)
    }
  })

  it('毫秒换算与天数一致', () => {
    expect(buddyExpiringWindowMs({ [KEY]: '2' })).toBe(2 * DAY)
    expect(buddyExpiringWindowMs({})).toBe(BUDDY_EXPIRING_WINDOW_MS)
  })

  /** 端到端：窗口放宽后，原本算永久的包应改判临时。 */
  it('窗口可注入到拆分函数（31 天时 17 天的包算临时）', () => {
    const split = splitBuddyCreditsByExpiry(
      balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      NOW,
      31 * DAY,
    )
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })
})

describe('splitBuddyCreditsByExpiry（按到期时间拆分两桶）', () => {
  it('距到期 14 天 → 临时桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + 14 * DAY })), NOW)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })

  it('距到期 9 天（实测 WorkBuddy Bonus Pack 的形状）→ 临时桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({
      name: 'Bonus Pack',
      deductionEndTime: NOW + 9 * DAY,
      remaining: 250,
    })), NOW)
    expect(split).toEqual({ expiring: 250, permanent: 0 })
  })

  it('距到期 3008 天（实测两站套餐的形状）→ 永久桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({
      name: 'Free Plan Subscription',
      deductionEndTime: NOW + 3008 * DAY,
      remaining: 100,
    })), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 100 })
  })

  /**
   * ⚠️ 边界：**恰好 15 天**算永久（判据是「不足 15 天才算临时」）。
   * 反向写（<=）会把「还有 15 天」的包归入临时 —— 实测中国版裂变包的到期分布
   * 正好密集落在 17～30 天，边界方向错一档就会让大量账号被误判成「有临时积分」。
   */
  it('恰好 15 天 → 永久桶（不足才叫临时）', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + BUDDY_EXPIRING_WINDOW_MS })), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 100 })
  })

  it('差 1 毫秒满 15 天 → 临时桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + BUDDY_EXPIRING_WINDOW_MS - 1 })), NOW)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })

  it('同一账号的两类包分别入桶并累加', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY }),
      pkg({ name: '裂变包', remaining: 100, deductionEndTime: NOW + 17 * DAY }),
      pkg({ name: '裂变包', remaining: 300, deductionEndTime: NOW + 208 * DAY }),
    ), NOW)
    expect(split).toEqual({ expiring: 250, permanent: 400 })
  })

  it('本周期口径：只算 remaining，不算终身余额', () => {
    // 实测 CodeBuddy 体验版：remaining(本周期)=0 而 CapacityRemain(终身)=500
    const split = splitBuddyCreditsByExpiry(balance(pkg({
      name: 'CodeBuddy个人体验版',
      remaining: 0,
      total: 500,
      deductionEndTime: NOW + 3008 * DAY,
    })), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 0 })
  })

  it('失效包（active: false）不参与，即使还剩余额', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ active: false, remaining: 999, deductionEndTime: NOW + 3 * DAY }),
      pkg({ remaining: 100, deductionEndTime: NOW + 20 * DAY }),
    ), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 100 })
  })

  /**
   * ⚠️ 到期时间缺失 / 非法 → 归**永久**桶（保守）。
   * 反过来归临时会让「服务端没给到期时间」的包在锁定期间被消耗掉 ——
   * 而它可能是不会作废的长期积分，属于不可逆损失。
   */
  it('到期时间未知归永久桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ deductionEndTime: undefined }),
      pkg({ deductionEndTime: 0 }),
      pkg({ deductionEndTime: Number.NaN }),
    ), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 300 })
  })

  it('已经过期（扣费截止在过去）但服务端仍说有效的包 → 临时桶（马上就没）', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW - DAY })), NOW)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })

  /**
   * ⚠️ 拆分结果**不做规整**（服务端精确值带浮点尾数，如 `74.61000076`）：
   * 分档只比较大小，规整只会引入误差；要给人看时才 round
   * （见 `describeBuddyCreditSplit`）。这里断言「累加到 200」用近似口径。
   */
  it('小数累加保留原始精度（不在拆分时规整）', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ remaining: 74.61000076, deductionEndTime: NOW + 9 * DAY }),
      pkg({ remaining: 125.39, deductionEndTime: NOW + 10 * DAY }),
    ), NOW)
    expect(split!.expiring).toBeCloseTo(200, 5)
    expect(split!.permanent).toBe(0)
    // 展示层才规整到两位小数
    expect(describeBuddyCreditSplit(split)).toBe('15 天内到期 200 · 永久 0')
  })

  it('脏余额（负数 / NaN）不计入', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ remaining: -5 }),
      pkg({ remaining: Number.NaN }),
      pkg({ remaining: 10 }),
    ), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 10 })
  })

  it('null / undefined（余额查询失败）返回 undefined，与「两桶都为 0」严格区分', () => {
    expect(splitBuddyCreditsByExpiry(null, NOW)).toBeUndefined()
    expect(splitBuddyCreditsByExpiry(undefined, NOW)).toBeUndefined()
    // 空包列表是「真的没钱」，不是「查不到」
    expect(splitBuddyCreditsByExpiry(balance(), NOW)).toEqual({ expiring: 0, permanent: 0 })
  })

  it('窗口可覆盖（单测与未来调整用）', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + 20 * DAY })), NOW, 30 * DAY)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })
})

describe('buddyBalanceTier（档位判定）', () => {
  it('有临时积分 → expiring（优先），即使同时有大量永久积分', () => {
    expect(buddyBalanceTier({ expiringBalance: 1, permanentBalance: 99999 }))
      .toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('只剩永久积分（未锁定）→ permanent', () => {
    expect(buddyBalanceTier({ expiringBalance: 0, permanentBalance: 100 }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
  })

  it('两桶都为 0 → none', () => {
    expect(buddyBalanceTier({ expiringBalance: 0, permanentBalance: 0 }))
      .toBe(BUDDY_BALANCE_TIER.none)
  })

  it('查询失败（字段 undefined）→ none', () => {
    expect(buddyBalanceTier({})).toBe(BUDDY_BALANCE_TIER.none)
  })
})

/**
 * ⚠️ **锁定永久积分**（用户需求：CodeBuddy 与 WorkBuddy 各加一个开关）。
 *
 * 锁定后**只允许消耗会近期作废的积分**，永久积分不参与选号 ——
 * 只剩永久积分的账号在锁定期间**等同于不可用**。
 *
 * 用户原话（与 Loomy 那次相同）：「锁定永久积分后没有临时积分后找可用账号就是
 * 没有可用账号，解锁以后才能再没有临时积分的时候找到有永久积分的账号」。
 */
describe('锁定永久积分（allowPermanent: false）', () => {
  it('只剩永久积分（含 30 天后到期的包）→ 不可用', () => {
    expect(buddyBalanceTier(
      { expiringBalance: 0, permanentBalance: 5000 },
      { allowPermanent: false },
    )).toBe(BUDDY_BALANCE_TIER.none)
  })

  it('有临时积分的账号不受锁定影响', () => {
    expect(buddyBalanceTier(
      { expiringBalance: 250, permanentBalance: 0 },
      { allowPermanent: false },
    )).toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('allowPermanent 缺省为 true（不改变既有行为）', () => {
    expect(buddyBalanceTier({ expiringBalance: 0, permanentBalance: 100 }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
  })

  it('none 档不可用，其余可用', () => {
    expect(buddyTierUsable(BUDDY_BALANCE_TIER.none)).toBe(false)
    expect(buddyTierUsable(BUDDY_BALANCE_TIER.expiring)).toBe(true)
    expect(buddyTierUsable(BUDDY_BALANCE_TIER.permanent)).toBe(true)
  })
})

describe('rankBuddyAccountsByBalance（稳定分档排序）', () => {
  it('临时积分的号排在只剩永久的号之前', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'a', expiringBalance: 0, permanentBalance: 100 },
      { id: 'b', expiringBalance: 250, permanentBalance: 0 },
    ])
    expect(ranked.map(a => a.id)).toEqual(['b', 'a'])
  })

  it('档内保持传入顺序（= 用户手动拖拽的顺序，不重排）', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'a', expiringBalance: 10, permanentBalance: 0 },
      { id: 'b', expiringBalance: 999, permanentBalance: 0 },
      { id: 'c', expiringBalance: 5, permanentBalance: 0 },
    ])
    expect(ranked.map(a => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('查询失败的号排最后（宁可发给能确认余额的号）', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'broken' },
      { id: 'ok', expiringBalance: 1 },
      { id: 'permanent', permanentBalance: 100 },
    ])
    expect(ranked.map(a => a.id)).toEqual(['ok', 'permanent', 'broken'])
  })

  it('锁定时把只剩永久积分的号降到最后一档', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'permanent-only', expiringBalance: 0, permanentBalance: 100 },
      { id: 'has-expiring', expiringBalance: 100, permanentBalance: 0 },
      { id: 'nothing' },
    ], { allowPermanent: false })
    expect(ranked.map(a => a.id)).toEqual(['has-expiring', 'permanent-only', 'nothing'])
    // 首位可用、其余不可用 —— 选号器据此判定「有没有可用账号」
    expect(buddyTierUsable(buddyBalanceTier(ranked[0]!, { allowPermanent: false }))).toBe(true)
    expect(buddyTierUsable(buddyBalanceTier(ranked[1]!, { allowPermanent: false }))).toBe(false)
  })

  it('不修改入参数组', () => {
    const input = [
      { id: 'a', expiringBalance: 0, permanentBalance: 1 },
      { id: 'b', expiringBalance: 1, permanentBalance: 0 },
    ]
    const ranked = rankBuddyAccountsByBalance(input)
    expect(ranked).not.toBe(input)
    expect(input.map(a => a.id)).toEqual(['a', 'b'])
  })
})

describe('describeBuddyCreditSplit（展示文案）', () => {
  it('两桶都给出，并带上窗口天数', () => {
    expect(describeBuddyCreditSplit({ expiring: 250, permanent: 100.5 }))
      .toBe('15 天内到期 250 · 永久 100.5')
  })

  it('都为 0 时说「无可用积分」而不是两个 0', () => {
    expect(describeBuddyCreditSplit({ expiring: 0, permanent: 0 })).toBe('无可用积分')
  })

  it('查询失败说清楚', () => {
    expect(describeBuddyCreditSplit(undefined)).toBe('余额查询失败')
  })
})
