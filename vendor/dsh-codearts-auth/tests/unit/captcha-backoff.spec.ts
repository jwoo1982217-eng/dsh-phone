/**
 * captcha **产出失败退避**的单测（2026-10-01，会话实证驱动）。
 *
 * ## 为什么加它（真实证据）
 *
 * `session-eced01ed`（provider=`zcode`，我们的插件）：额度耗尽后连续
 * **12 次**空响应失败（6 次请求 × 2 个 turn），而**每次重试都重新 mint
 * 一个 captcha** —— 在注定失败的情况下白耗 12 个配额。
 *
 * 更严重的后果有**同期旁证**：同一分钟（相差约 1 分钟）另一个 session
 * `session-b0e4eb3f`（provider=`zcode-bridge`，dsh-free-glm）报的是
 * **`502 Failed to mint auth material`** —— 两个插件在同一台设备上
 * 抢同一份 captcha 信誉，而失败本身会扣信誉。
 *
 * 那边的注释原话：**「继续请求不会让信誉恢复，只会更糟」**。
 *
 * ## 反向验证
 *
 * 把 `CaptchaBackoff.remainingMs()` 里到点清零的逻辑去掉 ⇒
 * 「冷却到点后恢复」（第 4 条）会一直判冷却中而变红。
 */
import { describe, expect, it } from 'vitest'

import {
  CAPTCHA_CONFIG_TTL_MS,
  CaptchaBackoff,
  captchaBackoffConfigFromEnv,
  captchaQueueEnabledFromEnv,
} from '../../src/captcha-backoff.js'

describe('ZCode captcha 产出失败退避', () => {
  it('★ 未达阈值不冷却（单次失败不该立刻闸住，那会误伤偶发抖动）', () => {
    const backoff = new CaptchaBackoff({ threshold: 3 })
    expect(backoff.noteFailure()).toBe(0)
    expect(backoff.noteFailure()).toBe(0)
    expect(backoff.remainingMs()).toBe(0)
    expect(backoff.failureStreak()).toBe(2)
  })

  it('★ 达阈值进入冷却：首次 1 分钟，之后指数翻倍', () => {
    let nowMs = 1_000_000
    const backoff = new CaptchaBackoff({
      threshold: 3,
      baseMs: 60_000,
      maxMs: 30 * 60_000,
      now: () => nowMs,
    })

    backoff.noteFailure()
    backoff.noteFailure()
    // 第 3 次失败 = 达阈值 ⇒ 冷却 60 秒
    expect(backoff.noteFailure()).toBe(nowMs + 60_000)
    expect(backoff.remainingMs()).toBe(60_000)

    /**
     * ⚠ 关键断言：`steps` 用 `streak - threshold`，故**首次冷却是最短的**。
     * 若误写成按 `streak` 算，第 3 次失败会直接等到 `base × 8`（8 分钟）——
     * 与「起步 1 分钟」的语义相反（这正是反向验证要守的点）。
     */
    expect(backoff.noteFailure()).toBe(nowMs + 120_000)
    expect(backoff.noteFailure()).toBe(nowMs + 240_000)
  })

  it('冷却有上限（不会无限增长到「永久不可用」）', () => {
    let nowMs = 0
    const backoff = new CaptchaBackoff({
      threshold: 1,
      baseMs: 60_000,
      maxMs: 30 * 60_000,
      now: () => nowMs,
    })
    for (let i = 0; i < 40; i += 1) backoff.noteFailure()
    expect(backoff.remainingMs()).toBe(30 * 60_000)
  })

  it('★ 冷却到点后自动恢复（否则一次失败就永久闸死）', () => {
    let nowMs = 0
    const backoff = new CaptchaBackoff({ threshold: 3, baseMs: 60_000, now: () => nowMs })
    backoff.noteFailure(); backoff.noteFailure(); backoff.noteFailure()
    expect(backoff.remainingMs()).toBe(60_000)

    nowMs += 60_001
    expect(backoff.remainingMs()).toBe(0)
    // 冷却清零，但**连续失败次数保留** —— 否则退避会重新从 1 分钟起步，
    // 达不到「指数」的效果。
    expect(backoff.failureStreak()).toBe(3)
  })

  it('★ 一次成功清零全部状态（信誉恢复即放行）', () => {
    const backoff = new CaptchaBackoff({ threshold: 3 })
    backoff.noteFailure(); backoff.noteFailure(); backoff.noteFailure()
    expect(backoff.remainingMs()).toBeGreaterThan(0)

    backoff.noteSuccess()
    expect(backoff.remainingMs()).toBe(0)
    expect(backoff.failureStreak()).toBe(0)
    // 清零后要重新积攒到阈值才会再冷却。
    expect(backoff.noteFailure()).toBe(0)
  })

  it('关闭时既不冷却也不计数（回到引入前行为）', () => {
    const backoff = new CaptchaBackoff({ enabled: false, threshold: 1 })
    expect(backoff.noteFailure()).toBe(0)
    expect(backoff.remainingMs()).toBe(0)
    // 关闭态下 streak 不增长（`noteFailure` 提前返回）。
    expect(backoff.failureStreak()).toBe(0)
  })

  it('环境变量：未设置=开、显式 0=关', () => {
    expect(captchaBackoffConfigFromEnv({}).enabled).toBe(true)
    expect(captchaBackoffConfigFromEnv({ DSH_ZCODE_CAPTCHA_BACKOFF: '0' }).enabled).toBe(false)
    expect(captchaBackoffConfigFromEnv({ DSH_ZCODE_CAPTCHA_BACKOFF: '1' }).enabled).toBe(true)
  })
})

/**
 * captcha **产出串行队列**与**配置 TTL**的接线开关（2026-10-01）。
 *
 * ## 依据（官方闭源版渲染层产物）
 *
 * - 队列：`wnn` + `jnn()` —— 官方把 captcha 产出**链在一条全局 promise 上**，
 *   同一时刻只产一个。而阿里云按**同设备每小时 150 次**限流，
 *   并发产出是纯浪费。
 * - 配置：`f3()` 的 `expiresAt: t + 6e4` —— **60 秒** TTL。
 */
describe('ZCode captcha 护栏的开关与默认值（对齐官方）', () => {
  it('★ 串行队列**默认启用**（官方就是串行的）；显式 0 才关', () => {
    expect(captchaQueueEnabledFromEnv({})).toBe(true)
    expect(captchaQueueEnabledFromEnv({ DSH_ZCODE_CAPTCHA_QUEUE: '1' })).toBe(true)
    expect(captchaQueueEnabledFromEnv({ DSH_ZCODE_CAPTCHA_QUEUE: '0' })).toBe(false)
    // 空串按「未设置」处理（不是关闭）。
    expect(captchaQueueEnabledFromEnv({ DSH_ZCODE_CAPTCHA_QUEUE: '  ' })).toBe(true)
  })

  it('★ 配置 TTL 取官方同值 60 秒（`t + 6e4`）', () => {
    expect(CAPTCHA_CONFIG_TTL_MS).toBe(60_000)
  })
})
