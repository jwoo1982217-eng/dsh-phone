import { describe, expect, it } from 'vitest'
import {
  LOOMY_BALANCE_TIER,
  rankLoomyAccountsByBalance,
  type LoomyAccountBalance,
} from '../../src/loomy-balance-rank.js'

/**
 * Loomy 账号按余额分档排序（负载均衡策略的核心纯函数）。
 *
 * ## 为什么需要它
 *
 * **实测**（2026-09-26）：Loomy 的今日赠送额度（每天 5000）耗尽后，
 * 服务端会**继续扣永久积分且不报错** —— 即「耗尽」不是错误而是静默降级。
 * 而本插件既有的「限流 → 换号」机制只在服务端返回限流错误时触发，
 * 故对 Loomy **完全无效**：会一直消耗同一个号（用户报障）。
 *
 * 策略（用户指定）：
 *   1. 优先在**有今日余额**（`dailyBalance > 0`）的账号中选；
 *   2. 都没有时，在**有永久积分**（`balance > 0`）的账号中选；
 *   3. 查询失败/都无余额 → 最后一档。
 *
 * ⚠️ 档内**保持传入顺序**（= 用户在 Jet Hub 拖拽的手动顺序），
 * 不重排 —— 与 `getAvailableAccount` 的既有语义一致（用户明确选择）。
 */
describe('rankLoomyAccountsByBalance', () => {
  const acct = (id: string, daily: number | undefined, permanent: number | undefined): LoomyAccountBalance => ({
    id,
    dailyBalance: daily,
    permanentBalance: permanent,
  })

  it('有今日余额的排在有永久积分的之前', () => {
    const ranked = rankLoomyAccountsByBalance([
      acct('only-permanent', 0, 5000),
      acct('has-daily', 3000, 100),
    ])
    expect(ranked.map((a) => a.id)).toEqual(['has-daily', 'only-permanent'])
  })

  it('档内保持传入顺序（= 手动拖拽顺序）', () => {
    const ranked = rankLoomyAccountsByBalance([
      acct('a', 100, 0),
      acct('b', 200, 0),
      acct('c', 300, 0),
    ])
    // 不按余额大小排，保持 a, b, c
    expect(ranked.map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('三档齐全时按 今日 > 永久 > 无 排列', () => {
    const ranked = rankLoomyAccountsByBalance([
      acct('none', 0, 0),
      acct('permanent', 0, 5000),
      acct('daily', 5000, 0),
    ])
    expect(ranked.map((a) => a.id)).toEqual(['daily', 'permanent', 'none'])
  })

  /**
   * ⚠️ 用户明确要求：**查询失败归入最后一档**（不是第一档）。
   * 理由：宁可把请求发给能确认余额的号；查不到的号排后面。
   */
  it('查询失败（undefined）归入最后一档', () => {
    const ranked = rankLoomyAccountsByBalance([
      acct('unknown', undefined, undefined),
      acct('has-daily', 1, 0),
      acct('has-permanent', 0, 1),
    ])
    expect(ranked.map((a) => a.id)).toEqual(['has-daily', 'has-permanent', 'unknown'])
  })

  it('只缺一个字段时按另一个判档（daily 缺但 permanent 有 → 第二档）', () => {
    const ranked = rankLoomyAccountsByBalance([
      acct('unknown', undefined, undefined),
      acct('partial', undefined, 500),
    ])
    expect(ranked.map((a) => a.id)).toEqual(['partial', 'unknown'])
  })

  it('负数/NaN 视为无余额（防御远端脏数据）', () => {
    const ranked = rankLoomyAccountsByBalance([
      acct('negative', -1, -1),
      acct('nan', Number.NaN, Number.NaN),
      acct('good', 0, 10),
    ])
    expect(ranked.map((a) => a.id)).toEqual(['good', 'negative', 'nan'])
  })

  it('空数组返回空数组', () => {
    expect(rankLoomyAccountsByBalance([])).toEqual([])
  })

  it('不修改传入数组（纯函数）', () => {
    const input = [acct('b', 0, 100), acct('a', 100, 0)]
    const snapshot = input.map((a) => a.id)
    rankLoomyAccountsByBalance(input)
    expect(input.map((a) => a.id)).toEqual(snapshot)
  })

  it('tier 常量可供调用方判断（诊断/日志用）', () => {
    expect(LOOMY_BALANCE_TIER.daily).toBeDefined()
    expect(LOOMY_BALANCE_TIER.permanent).toBeDefined()
    expect(LOOMY_BALANCE_TIER.none).toBeDefined()
  })
})

describe('分档函数本身（loomyBalanceTier）', () => {
  it('daily > 0 → daily 档（优先于 permanent）', async () => {
    const { loomyBalanceTier } = await import('../../src/loomy-balance-rank.js')
    expect(loomyBalanceTier({ dailyBalance: 1, permanentBalance: 0 })).toBe(LOOMY_BALANCE_TIER.daily)
  })

  it('daily = 0 且 permanent > 0 → permanent 档', async () => {
    const { loomyBalanceTier } = await import('../../src/loomy-balance-rank.js')
    expect(loomyBalanceTier({ dailyBalance: 0, permanentBalance: 1 })).toBe(LOOMY_BALANCE_TIER.permanent)
  })

  it('都无 → none 档', async () => {
    const { loomyBalanceTier } = await import('../../src/loomy-balance-rank.js')
    expect(loomyBalanceTier({ dailyBalance: 0, permanentBalance: 0 })).toBe(LOOMY_BALANCE_TIER.none)
    expect(loomyBalanceTier({})).toBe(LOOMY_BALANCE_TIER.none)
  })
})

/**
 * ⚠️ **锁定永久积分**（用户需求）。
 *
 * 锁定后**只允许消耗今日赠送额度**，永久积分不参与选号 ——
 * 只剩永久积分的账号在锁定期间**等同于不可用**。
 *
 * 用户原话：「锁定永久积分后没有临时积分后找可用账号就是没有可用账号，
 * 解锁以后才能再没有临时积分的时候找到有永久积分的账号」。
 */
describe('锁定永久积分（allowPermanent: false）', () => {
  const acct = (id: string, daily: number | undefined, permanent: number | undefined): LoomyAccountBalance => ({
    id,
    dailyBalance: daily,
    permanentBalance: permanent,
  })

  it('只剩永久积分的账号落入 none 档（不是 permanent 档）', async () => {
    const { loomyBalanceTier } = await import('../../src/loomy-balance-rank.js')
    expect(loomyBalanceTier({ dailyBalance: 0, permanentBalance: 9999 }, { allowPermanent: false }))
      .toBe(LOOMY_BALANCE_TIER.none)
  })

  it('有今日额度的账号仍可用（锁定不影响它）', async () => {
    const { loomyBalanceTier } = await import('../../src/loomy-balance-rank.js')
    expect(loomyBalanceTier({ dailyBalance: 100, permanentBalance: 0 }, { allowPermanent: false }))
      .toBe(LOOMY_BALANCE_TIER.daily)
  })

  it('排序时只剩永久积分的与「无余额」同档（都在 none）', async () => {
    const ranked = rankLoomyAccountsByBalance([
      acct('only-permanent', 0, 9999),
      acct('has-daily', 10, 0),
      acct('empty', 0, 0),
    ], { allowPermanent: false })
    // has-daily 第一；only-permanent 与 empty 同为 none 档，按传入顺序
    expect(ranked.map((a) => a.id)).toEqual(['has-daily', 'only-permanent', 'empty'])
  })

  it('loomyTierUsable：daily/permanent 可用，none 不可用', async () => {
    const { loomyTierUsable } = await import('../../src/loomy-balance-rank.js')
    expect(loomyTierUsable(LOOMY_BALANCE_TIER.daily)).toBe(true)
    expect(loomyTierUsable(LOOMY_BALANCE_TIER.permanent)).toBe(true)
    expect(loomyTierUsable(LOOMY_BALANCE_TIER.none)).toBe(false)
  })

  it('allowPermanent 缺省为 true（不改变既有行为）', async () => {
    const { loomyBalanceTier } = await import('../../src/loomy-balance-rank.js')
    expect(loomyBalanceTier({ dailyBalance: 0, permanentBalance: 5 })).toBe(LOOMY_BALANCE_TIER.permanent)
    expect(loomyBalanceTier({ dailyBalance: 0, permanentBalance: 5 }, {})).toBe(LOOMY_BALANCE_TIER.permanent)
  })
})
