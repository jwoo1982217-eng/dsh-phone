/**
 * TRAE 错误分类单元测试。
 *
 * 覆盖 `src/trae-errors.ts` 的 `classifyTraeError` 判定顺序与三个策略函数。
 * 判定顺序是本模块的核心契约（对齐 Go 端 `Classify` + `SOLOStreamError.Kind`），
 * 顺序错了会让「配额耗尽」被误判成可重试错误而反复重试一个永远不会成功的账号。
 */

import { describe, expect, it } from 'vitest'
import {
  classifyTraeError,
  isTraeTerminalError,
  recordsTraeRateLimit,
  shouldRotateTraeAccount,
} from '../../src/trae-errors.js'
import { traeCooldownFor } from '../../src/trae-cooldown-table.js'

describe('TRAE 错误分类', () => {
  it('body 含 1005 + plan 判为 hard-plan（权益不足）', () => {
    expect(classifyTraeError(400, '{"code":1005,"msg":"plan limit reached"}')).toBe('hard-plan')
    expect(classifyTraeError(200, '1005 plan')).toBe('hard-plan')
  })

  it('仅出现 1005 但不含 plan 字样时不判 hard-plan', () => {
    // 避免把无关的 code 1005 误判成权益不足。
    expect(classifyTraeError(400, '{"code":1005}')).toBe('client')
  })

  it('body 含 4008 判为 quota-exceeded（ide_credits 耗尽）', () => {
    expect(classifyTraeError(400, '{"code":4008}')).toBe('quota-exceeded')
    expect(classifyTraeError(200, 'Your requests have exceeded the quota')).toBe('quota-exceeded')
  })

  it('body 含 4011 判为 soft-rate（请求频率超限）', () => {
    expect(classifyTraeError(400, '{"code":4011}')).toBe('soft-rate')
  })

  it('quota-exceeded 优先于 4011（4008 更严重）', () => {
    expect(classifyTraeError(400, '4008 4011')).toBe('quota-exceeded')
  })

  it('HTTP 401 判为 session-dead（需重新登录）', () => {
    expect(classifyTraeError(401, '')).toBe('session-dead')
    expect(classifyTraeError(401, 'token invalid')).toBe('session-dead')
    expect(classifyTraeError(401, 'please login again')).toBe('session-dead')
  })

  it('HTTP 429 判为 soft-rate', () => {
    expect(classifyTraeError(429, 'too many requests')).toBe('soft-rate')
  })

  it('HTTP 404 判为 not-found', () => {
    expect(classifyTraeError(404, '')).toBe('not-found')
  })

  it('5xx 判为 server', () => {
    expect(classifyTraeError(500, '')).toBe('server')
    expect(classifyTraeError(503, 'service unavailable')).toBe('server')
  })

  it('其他 4xx 判为 client', () => {
    expect(classifyTraeError(400, 'bad param')).toBe('client')
    expect(classifyTraeError(403, '')).toBe('client')
  })

  it('2xx/3xx 判为 none', () => {
    expect(classifyTraeError(200, '')).toBe('none')
    expect(classifyTraeError(204, '')).toBe('none')
  })

  it('body 关键词优先于状态码（上游用 400 + 文案表达配额耗尽）', () => {
    // 若先按状态码判，400 会落到 client，于是反复重试一个永远不会成功的账号。
    expect(classifyTraeError(400, '4008')).toBe('quota-exceeded')
    expect(classifyTraeError(400, '1005 plan')).toBe('hard-plan')
  })
})

describe('TRAE 换号策略', () => {
  it('除 none 外每一类都换号（对齐 Go 每个分支都以 continue 结尾）', () => {
    for (const kind of ['hard-plan', 'soft-rate', 'session-dead', 'quota-exceeded', 'not-found', 'server', 'client'] as const) {
      expect(shouldRotateTraeAccount(kind), kind).toBe(true)
    }
    expect(shouldRotateTraeAccount('none')).toBe(false)
  })

  it('只有真正需要冷却的类别才记限流标记', () => {
    // session-dead / server / client 不是限流，记徽章会显示虚假信息。
    expect(recordsTraeRateLimit('hard-plan')).toBe(true)
    expect(recordsTraeRateLimit('soft-rate')).toBe(true)
    expect(recordsTraeRateLimit('not-found')).toBe(true)
    expect(recordsTraeRateLimit('quota-exceeded')).toBe(true)
    expect(recordsTraeRateLimit('session-dead')).toBe(false)
    expect(recordsTraeRateLimit('server')).toBe(false)
    expect(recordsTraeRateLimit('client')).toBe(false)
    expect(recordsTraeRateLimit('none')).toBe(false)
  })

  it('只有 session-dead 是终态（重试无意义）', () => {
    // 用途：TraeAuth.refresh 据此抛 RefreshTokenExpiredError 停止续期。
    // 网络抖动/5xx 必须走可重试路径，否则一次瞬时故障就让用户重新登录。
    expect(isTraeTerminalError('session-dead')).toBe(true)
    for (const kind of ['hard-plan', 'soft-rate', 'quota-exceeded', 'not-found', 'server', 'client', 'none'] as const) {
      expect(isTraeTerminalError(kind), kind).toBe(false)
    }
  })

  /**
   * ★ 冷却表**精确值断言**（PR #64 复审「剩余 1」，2026-10-06）。
   *
   * 维护者反向验证发现：`soft-rate` 60s→7天、`hard-plan` 12h→30天 时
   * **没有任何用例变红**（当时唯一的冷却断言只覆盖 4008 的 24h 区间）——
   * 上一版 `soft-rate` 误设 1h（比正确值大 60 倍）正是这样溜进来的。
   * 表是 `export const` ⇒ 直接精确断言，把三个争议值全部钉死；
   * 未知类别回落 1 小时兜底也一并锁定。
   */
  describe('traeCooldownFor 冷却表精确值（PR #64 复审锁定）', () => {
    it('三个争议类别的精确值', () => {
      // quota-exceeded（4008）：日配额（签到积分，余额 API 实测）⇒ 24h
      expect(traeCooldownFor('quota-exceeded')).toBe(24 * 3_600_000)
      // hard-plan（1005）：trae-errors.ts 既有权威定义 ⇒ 12h
      expect(traeCooldownFor('hard-plan')).toBe(12 * 3_600_000)
      // soft-rate（4011）：频率超限分钟级恢复 ⇒ 60s
      expect(traeCooldownFor('soft-rate')).toBe(60_000)
    })
    it('非争议类别与未知类别兜底', () => {
      expect(traeCooldownFor('not-found')).toBe(3_600_000)
      expect(traeCooldownFor('server')).toBe(3_600_000)
      expect(traeCooldownFor('client')).toBe(3_600_000)
      expect(traeCooldownFor('session-dead')).toBe(0)
      expect(traeCooldownFor('none')).toBe(0)
      // 未知类别回落 1 小时兜底
      expect(traeCooldownFor('unheard-of')).toBe(3_600_000)
    })
  })
})
