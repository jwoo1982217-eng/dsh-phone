import { describe, expect, it } from 'vitest'
import {
  LOBSTERAI_HARD_CREDIT_MARKERS,
  LOBSTERAI_SESSION_DEAD_MARKERS,
  classifyLobsteraiError,
  isLobsteraiTerminalError,
  recordsLobsteraiRateLimit,
  shouldRotateLobsteraiAccount,
} from '../../src/lobsterai-errors.js'

describe('LobsterAI 错误分类', () => {
  it('HTTP 402 直接判为余额不足', () => {
    expect(classifyLobsteraiError(402, '')).toBe('hard-credit')
  })

  it('body 含英文余额不足关键词时判为 hard-credit（不区分大小写）', () => {
    expect(classifyLobsteraiError(400, 'Insufficient Credit')).toBe('hard-credit')
    expect(classifyLobsteraiError(200, 'QUOTA EXCEEDED')).toBe('hard-credit')
    expect(classifyLobsteraiError(400, 'free credits used')).toBe('hard-credit')
  })

  it('body 含中文余额不足关键词时判为 hard-credit', () => {
    // LobsterAI 是网易有道系产品，同一后端在不同场景返回中文或英文文案，
    // 任一漏匹配都会让「余额耗尽」被误判成可重试错误而反复重试。
    for (const text of ['积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分', '积分耗尽']) {
      expect(classifyLobsteraiError(400, `请求失败：${text}`), text).toBe('hard-credit')
    }
  })

  it('body 关键词优先于状态码（上游用 400 + 中文文案表达余额耗尽）', () => {
    // 若先按状态码判，400 会落到 client（不换号），于是反复重试一个
    // 永远不会成功的账号 —— 这是本判定顺序存在的全部理由。
    expect(classifyLobsteraiError(400, '你的积分不足')).toBe('hard-credit')
  })

  it('存在空白字符的英文关键词仍可命中（词间无换行但大小写混杂）', () => {
    expect(classifyLobsteraiError(400, 'Error: Not Enough Credit')).toBe('hard-credit')
  })

  it('会话终止标记 40100 / 40101 判为 session-dead', () => {
    expect(classifyLobsteraiError(401, '{"code":40100}')).toBe('session-dead')
    expect(classifyLobsteraiError(401, '{"code":40101}')).toBe('session-dead')
    expect(classifyLobsteraiError(400, 'token rejected')).toBe('session-dead')
    expect(classifyLobsteraiError(400, 'refresh token was rejected')).toBe('session-dead')
  })

  it('会话终止优先于 429 / 404（已死的会话换号也没意义）', () => {
    expect(classifyLobsteraiError(429, 'code 40101')).toBe('session-dead')
    expect(classifyLobsteraiError(404, 'token rejected')).toBe('session-dead')
  })

  it('余额不足优先于会话终止（两者同时出现时以余额为准）', () => {
    expect(classifyLobsteraiError(402, '40101')).toBe('hard-credit')
  })

  it('429 判为 soft-rate', () => {
    expect(classifyLobsteraiError(429, 'too many requests')).toBe('soft-rate')
  })

  it('404 判为 not-found', () => {
    expect(classifyLobsteraiError(404, 'not found')).toBe('not-found')
  })

  it('5xx 判为 server', () => {
    expect(classifyLobsteraiError(500, '')).toBe('server')
    expect(classifyLobsteraiError(503, 'unavailable')).toBe('server')
  })

  it('其他 4xx 判为 client', () => {
    expect(classifyLobsteraiError(400, 'bad request')).toBe('client')
    expect(classifyLobsteraiError(403, 'forbidden body')).toBe('client')
  })

  it('成功响应判为 none', () => {
    expect(classifyLobsteraiError(200, '{}')).toBe('none')
    expect(classifyLobsteraiError(204, '')).toBe('none')
  })

  it('空 body 不抛异常', () => {
    expect(() => classifyLobsteraiError(429, '')).not.toThrow()
  })
})

describe('错误分类的派生谓词', () => {
  it('**所有**非成功类别都可换号（对齐 handler.go:218-243 每个分支都 continue）', () => {
    // 曾经只对 hard-credit / soft-rate 换号，并错误地声称 Go 对 client 类
    // 也不换号 —— 实际 NoteError 之后紧跟的就是 continue。
    expect(shouldRotateLobsteraiAccount('hard-credit')).toBe(true)
    expect(shouldRotateLobsteraiAccount('soft-rate')).toBe(true)
    expect(shouldRotateLobsteraiAccount('not-found')).toBe(true)
    expect(shouldRotateLobsteraiAccount('server')).toBe(true)
    expect(shouldRotateLobsteraiAccount('client')).toBe(true)
    expect(shouldRotateLobsteraiAccount('session-dead')).toBe(true)
  })

  it('成功不换号', () => {
    expect(shouldRotateLobsteraiAccount('none')).toBe(false)
  })

  it('只有 session-dead 属终态', () => {
    // 终态判定比 Go 版精确：Go 只判「响应里有没有 accessToken」，
    // 会把网络抖动也当成终态而停止续期。
    expect(isLobsteraiTerminalError('session-dead')).toBe(true)
    for (const kind of ['none', 'hard-credit', 'soft-rate', 'not-found', 'server', 'client'] as const) {
      expect(isLobsteraiTerminalError(kind), kind).toBe(false)
    }
  })

  it('只有 Go 里真正 Cooldown 的三类记限流徽章', () => {
    expect(recordsLobsteraiRateLimit('hard-credit')).toBe(true)
    expect(recordsLobsteraiRateLimit('soft-rate')).toBe(true)
    expect(recordsLobsteraiRateLimit('not-found')).toBe(true)
    // session-dead 走 Disable、default 走 NoteError，都不写冷却时间。
    expect(recordsLobsteraiRateLimit('session-dead')).toBe(false)
    expect(recordsLobsteraiRateLimit('server')).toBe(false)
    expect(recordsLobsteraiRateLimit('client')).toBe(false)
  })
})

describe('关键词表完整性', () => {
  it('中英双通道覆盖（中文关键词不含 ASCII 大写，英文全为小写）', () => {
    const chinese = LOBSTERAI_HARD_CREDIT_MARKERS.filter((m) => /[\u4e00-\u9fff]/.test(m))
    const english = LOBSTERAI_HARD_CREDIT_MARKERS.filter((m) => !/[\u4e00-\u9fff]/.test(m))
    expect(chinese.length).toBeGreaterThan(0)
    expect(english.length).toBeGreaterThan(0)
    for (const marker of english) {
      expect(marker, marker).toBe(marker.toLowerCase())
    }
  })

  it('会话终止标记含两个业务码', () => {
    expect(LOBSTERAI_SESSION_DEAD_MARKERS).toContain('40100')
    expect(LOBSTERAI_SESSION_DEAD_MARKERS).toContain('40101')
  })
})
