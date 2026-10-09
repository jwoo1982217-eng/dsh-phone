/**
 * captcha 需求记忆的单测（配合 spec 第 5 节的四态状态机）。
 *
 * ## 本文件锁住四件事
 * 1. **默认「不需要」**：未知键一律先探（这是省下全部 mint 的那一半收益）；
 * 2. **记忆按 `账号|模型` 两维隔离**：串了就会把一个模型的验证结论套到另一个模型；
 * 3. **TTL 边界**：119s 命中、第 120 秒整点即过期、121s 仍是先探（写死 2 分钟，照抄
 *    `52b6389`），外加一条 `ttlMs` 入参生效（默认值不是唯一路径）；
 * 4. **成功即清**：上游不要了必须立刻清掉，否则会在不需要验证的窗口里持续白产。
 *
 * ## 反向验证（别写成同义反复）
 * - 把 `isCaptchaKnownRequired` 改成恒 `true` ⇒ 「默认不需要」与「TTL 边界」变红；
 * - 把过期判定 `until <= now` 写成 `until < now` ⇒ 「TTL 边界」变红（整点那条）；
 * - 让 `noteCaptchaRequired` 忽略 `ttlMs`（恒用默认 2 分钟）⇒ 「ttlMs 入参生效」变红；
 * - 把 key 退化成只用 `model` ⇒ 「两维隔离」变红；
 * - 删掉 `clearCaptchaRequirement` 调用点（Task 4 的行为用例）⇒ 「成功即清」变红。
 * ⚠ 实现里「过期即 `delete`」那行**没有**用例看守，也不该有：它是惰性内存回收，
 *   删掉后过期条目继续被查询同样只返回 false（故本文件只声称「幂等」，不声称回收）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  CAPTCHA_REQUIRED_TTL_MS,
  captchaRequirementKey,
  captchaRequirementObservability,
  clearCaptchaRequirement,
  isCaptchaKnownRequired,
  noteCaptchaRequired,
  noteKnownRequiredHit,
  noteProbeFirst,
  resetCaptchaRequirementMemory,
} from '../../src/captcha-requirement.js'

const T0 = 1_700_000_000_000

describe('captcha 需求记忆', () => {
  beforeEach(() => {
    resetCaptchaRequirementMemory()
  })

  it('未知键默认「不需要」——这就是省下 mint 的那一半收益', () => {
    expect(isCaptchaKnownRequired(captchaRequirementKey('acct-A', 'GLM-5.3-Flash'), T0)).toBe(false)
  })

  it('★ 记忆按「账号 × 模型」隔离：换账号或换模型都必须回到先探', () => {
    const keyA = captchaRequirementKey('acct-A', 'GLM-5.3-Flash')
    noteCaptchaRequired(keyA, T0)
    expect(isCaptchaKnownRequired(keyA, T0 + 1_000)).toBe(true)
    // 同账号、换模型
    expect(isCaptchaKnownRequired(captchaRequirementKey('acct-A', 'GLM-5.2'), T0 + 1_000)).toBe(false)
    // 同模型、换账号
    expect(isCaptchaKnownRequired(captchaRequirementKey('acct-B', 'GLM-5.3-Flash'), T0 + 1_000)).toBe(false)
  })

  it('TTL 边界：119s 仍命中，TTL 整点即过期，之后回落到先探', () => {
    const key = captchaRequirementKey('acct-A', 'm')
    noteCaptchaRequired(key, T0)
    expect(isCaptchaKnownRequired(key, T0 + 119_000)).toBe(true)
    // 精确边界：实现是 `until <= now`，故第 120 秒整点就判过期（改成 `<` 这条变红）
    expect(isCaptchaKnownRequired(key, T0 + CAPTCHA_REQUIRED_TTL_MS)).toBe(false)
    // 过期判定是幂等的（重复查询仍为 false）
    expect(isCaptchaKnownRequired(key, T0 + 121_000)).toBe(false)
  })

  it('ttlMs 入参生效：传入的短 TTL 覆盖默认 2 分钟', () => {
    const key = captchaRequirementKey('acct-A', 'm')
    noteCaptchaRequired(key, T0, 1_000)
    expect(isCaptchaKnownRequired(key, T0 + 1_500)).toBe(false)
  })

  it('★ 不带 captcha 也成功 ⇒ 上游又不要了，清记忆回到最省路径', () => {
    const key = captchaRequirementKey('acct-A', 'm')
    noteCaptchaRequired(key, T0)
    clearCaptchaRequirement(key)
    expect(isCaptchaKnownRequired(key, T0 + 1_000)).toBe(false)
  })

  it('没有账号 id 时不能拼出 `undefined|m`（会与「真的叫 undefined 的账号」混淆）', () => {
    expect(captchaRequirementKey(undefined, 'm')).toBe(captchaRequirementKey('', 'm'))
    expect(captchaRequirementKey(undefined, 'm')).toBe('-|m')
  })

  it('TTL 常量取 2 分钟（对齐 52b6389，不随手改）', () => {
    expect(CAPTCHA_REQUIRED_TTL_MS).toBe(2 * 60_000)
  })

  it('计数可观测：先探次数与命中次数分开统计', () => {
    noteProbeFirst()
    noteProbeFirst()
    noteKnownRequiredHit()
    expect(captchaRequirementObservability()).toEqual({
      probeFirstCount: 2,
      knownRequiredCount: 1,
    })
  })
})
