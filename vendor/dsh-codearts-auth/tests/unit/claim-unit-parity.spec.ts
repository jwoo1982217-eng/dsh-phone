/**
 * ★ 「一键签到」把 ZCode 的 **token** 当成**积分**显示 —— 回归（真实报障，2026-10-04）。
 *
 * ## 报障原文
 * > 插件的这个一键签到，Zcode 获得的是 token 数量，但是这里显示成获得积分。
 * > 正文「…ZCode（智谱）+100000000（共 +100000100）」
 * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
 *
 * ## 根因（不是文案，是数据模型）
 *
 * `computeClaimSummary` 的 `totalCredit` 是**跨单位求和**的标量：ZCode 的
 * 1 亿 token 与其余渠道的 100 积分加在一起得 `100000100`。单位信息在这一层
 * 就丢了，下游无论怎么写文案都只能标一个「积分」。
 *
 * 故修法是**让单位一路传到渲染层**（`totalByUnit`），而不是在文案里猜。
 *
 * ## 本文件守四件事
 * 1. 宿主 `computeClaimSummary` 产出 `totalByUnit`（单位不丢）
 * 2. 宿主与客户端的格式化**逐字等价**（同一件事不能有两个写法）
 * 3. 用户给出的期望文案**逐字**成立（这是验收判据，不是描述）
 * 4. 其余 11 个渠道行为逐字不变（不带 unit ⇒ 仍按积分）
 */
import { describe, expect, it } from 'vitest'
import { computeClaimSummary } from '../../src/jet-hub-rpc.js'
import { formatClaimGains, formatUnitAmount } from '../../src/credits.js'
import { describeChannel, describeRun } from '../../src/auto-checkin.js'
import { formatClaimGains as clientFormatClaimGains } from '../../plugin-src/client/credits-format.js'
import type { ClaimOutcome } from '../../src/credits.js'

/** ZCode 一次领取（`toClaimOutcome` 会带 `unit: 'token'` 与真实额度）。 */
const ZCODE_CLAIM: ClaimOutcome = {
  kind: 'claimed', credit: 100_000_000, streakDays: 0, isStreakDay: false, unit: 'token',
}
/** CodeArts 一次领取（普通积分）。 */
const CODEARTS_CLAIM: ClaimOutcome = {
  kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false,
}

describe('★ 报障复现：token 不得被当成积分', () => {
  it('★★ 用户给出的期望文案逐字成立（验收判据）', () => {
    // 逐渠道：`ZCode（智谱）+100Mtoken`
    const zcode = computeClaimSummary([ZCODE_CLAIM])
    expect(describeChannel(zcode)).toBe('1 个 +100.00MToken')

    // 汇总：`共 +100Mtoken, +100积分`（token 与积分分列，**不求和**）
    const codearts = computeClaimSummary([CODEARTS_CLAIM])
    const totals = {
      providers: 2,
      claimed: zcode.claimed + codearts.claimed,
      // ⚠️ 标量仍在（保留既有契约），但展示路径不得用它
      totalCredit: zcode.totalCredit + codearts.totalCredit,
      totalByUnit: {
        token: zcode.totalByUnit.token + codearts.totalByUnit.token,
        credit: zcode.totalByUnit.credit + codearts.totalByUnit.credit,
      },
      alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 2,
    }
    expect(describeRun(totals)).toBe('2 个渠道：2 个账号领取成功（+100.00MToken, +100积分）')
    // 标量确实是那个**误导性**的数 —— 锁死「为什么不能用它」
    expect(totals.totalCredit).toBe(100_000_100)
  })

  it('★ 旧行为（跨单位求和 + 标成积分）必须已被消除', () => {
    const summary = computeClaimSummary([ZCODE_CLAIM, CODEARTS_CLAIM])
    const text = describeRun({
      providers: 1, claimed: summary.claimed, totalCredit: summary.totalCredit,
      totalByUnit: summary.totalByUnit, alreadyClaimed: 0, inactive: 0,
      failed: 0, skipped: 0, errors: 0, coversToday: 2,
    })
    // 报障里那串数字不得再出现
    expect(text).not.toContain('100000100')
    expect(text).not.toContain('+100000000')
    // 单位必须如实出现
    expect(text).toContain('Token')
    expect(text).toContain('积分')
  })

  it('★ token 才压缩，积分不压缩（积分要与官方界面核对）', () => {
    expect(formatUnitAmount(100_000_000, 'token')).toBe('100.00MToken')
    expect(formatUnitAmount(94_539_275, 'token')).toBe('94.54MToken')
    expect(formatUnitAmount(945, 'token')).toBe('945Token')
    // ⚠️ 积分保持原样：压成 `123.46K` 会让用户无法与 IDE 顶部的 123456.78 核对
    expect(formatUnitAmount(123_456.78, 'credit')).toBe('123456.78积分')
    expect(formatUnitAmount(800, 'credit')).toBe('800积分')
  })
})

describe('★ 宿主与客户端格式化逐字等价（同一件事不能有两个写法）', () => {
  /**
   * ⚠️ 客户端 bundle 不能 import 宿主代码（esbuild 的客户端产物没有 Node 依赖），
   * 故只能各写一份 —— 这个用例就是那份「必须逐字等价」的契约。
   *
   * 等价性一旦破了，**同一轮签到**在 Jet Hub 设置页（宿主产出的落盘文字）与
   * 用量徽标（客户端现场拼）会显示成两种写法。
   */
  const CASES: Array<Record<string, number> | undefined> = [
    { token: 100_000_000, credit: 100 },
    { token: 94_539_275, credit: 0 },
    { token: 0, credit: 800 },
    { token: 0, credit: 123_456.78 },
    { token: 945, credit: 0 },
    { token: 0, credit: 0 },
    {},
    undefined,
  ]

  it('formatClaimGains 两侧逐项一致', () => {
    for (const input of CASES) {
      expect(clientFormatClaimGains(input), JSON.stringify(input)).toBe(formatClaimGains(input))
    }
  })

  it('顺序固定 token 在前（不依赖对象键序）', () => {
    // 故意把 credit 写在前面：输出仍须 token 在前
    expect(formatClaimGains({ credit: 100, token: 100_000_000 })).toBe('+100.00MToken, +100积分')
    expect(clientFormatClaimGains({ credit: 100, token: 100_000_000 })).toBe('+100.00MToken, +100积分')
  })

  it('每个单位各带一个 +（不是整段共用一个）', () => {
    const text = formatClaimGains({ token: 100_000_000, credit: 100 })
    expect(text?.match(/\+/g)).toHaveLength(2)
  })

  it('全为零 / 无字段 ⇒ null（调用方据此整段不渲染，而不是渲染空括号）', () => {
    expect(formatClaimGains({ token: 0, credit: 0 })).toBeNull()
    expect(formatClaimGains({})).toBeNull()
    expect(formatClaimGains(undefined)).toBeNull()
    expect(clientFormatClaimGains({ token: 0, credit: 0 })).toBeNull()
    expect(clientFormatClaimGains(undefined)).toBeNull()
  })

  it('非数值 / 负数被忽略（脏数据不渲染出 NaN）', () => {
    expect(formatClaimGains({ token: Number.NaN, credit: 100 })).toBe('+100积分')
    expect(formatClaimGains({ token: -5, credit: 100 })).toBe('+100积分')
    expect(clientFormatClaimGains({ token: Number.NaN, credit: 100 })).toBe('+100积分')
  })
})

describe('★ 其余渠道行为逐字不变（不带 unit ⇒ 仍按积分）', () => {
  it('未声明 unit 的领取只落进 credit 分组', () => {
    const summary = computeClaimSummary([CODEARTS_CLAIM])
    expect(summary.totalByUnit).toEqual({ token: 0, credit: 100 })
    expect(summary.totalCredit).toBe(100)
  })

  it('多个积分渠道仍合并成**一个**数（不是每渠道一段）', () => {
    const summary = computeClaimSummary([
      { kind: 'claimed', credit: 800, streakDays: 1, isStreakDay: false },
      { kind: 'claimed', credit: 100, streakDays: 2, isStreakDay: true },
    ])
    expect(formatClaimGains(summary.totalByUnit)).toBe('+900积分')
  })
})
