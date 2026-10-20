import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REFRESH_ABNORMAL_NETWORK_RETRY_MS, REFRESH_LEAD_MS, REFRESH_RETRY_MS,
  RefreshScheduler, computeFirstRefreshDelayMs,
} from '../../src/refresh.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('computeFirstRefreshDelayMs (对齐真实插件 getFirstRefreshTime)', () => {
  it('returns 0 when expiry is within the 1h lead window', () => {
    const now = Date.parse('2026-08-14T12:00:00Z')
    expect(computeFirstRefreshDelayMs(now + REFRESH_LEAD_MS - 1, now)).toBe(0)
    expect(computeFirstRefreshDelayMs(now, now)).toBe(0)
  })

  it('schedules at now + 1h with a random seconds offset when expiry is further out', () => {
    const now = Date.parse('2026-08-14T12:00:00Z')
    // 过期在 24h 后：触发点应为 [now+1h, now+1h+60s)。
    const expires = now + 24 * 3_600_000
    for (let i = 0; i < 20; i++) {
      const delay = computeFirstRefreshDelayMs(expires, now)
      expect(delay).toBeGreaterThanOrEqual(REFRESH_LEAD_MS)
      expect(delay).toBeLessThan(REFRESH_LEAD_MS + 60_000)
    }
  })
})

describe('RefreshScheduler', () => {
  it('fires refresh immediately when within the lead window', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => {})
    const scheduler = new RefreshScheduler(refresh)
    scheduler.arm(Date.now() + 120_000) // 距过期 2 分钟 < 1h → 立即触发
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('schedules at the computed first-refresh delay', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => {})
    const scheduler = new RefreshScheduler(refresh)
    const now = Date.now()
    scheduler.arm(now + 24 * 3_600_000, now) // 24h 后过期 → 约 1h 后触发
    await vi.advanceTimersByTimeAsync(REFRESH_LEAD_MS + 61_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('retries after 10 minutes on ordinary failure and reports via onError', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => { throw new Error('network down') })
    const onError = vi.fn()
    const scheduler = new RefreshScheduler(refresh, onError)
    scheduler.arm(Date.now() - 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('stops scheduling on RefreshTokenExpiredError', async () => {
    vi.useFakeTimers()
    const { RefreshTokenExpiredError } = await import('../../src/oauth.js')
    const refresh = vi.fn(async () => { throw new RefreshTokenExpiredError('expired') })
    const onError = vi.fn()
    const scheduler = new RefreshScheduler(refresh, onError)
    scheduler.arm(Date.now() - 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    // 失效后不再重试：再推进 30 分钟仍只有 1 次调用。
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('retries after 1 minute on abnormal-network failure', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => { throw new Error('fetch failed') })
    const scheduler = new RefreshScheduler(refresh)
    scheduler.arm(Date.now() - 1)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(REFRESH_ABNORMAL_NETWORK_RETRY_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('stop() cancels the retry scheduled after an in-flight refresh fails', async () => {
    vi.useFakeTimers()
    let rejectRefresh!: (error: Error) => void
    const refresh = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject
    }))
    const scheduler = new RefreshScheduler(refresh)
    scheduler.arm(Date.now() - 1) // 立即触发
    await vi.advanceTimersByTimeAsync(0) // 进入在途
    expect(refresh).toHaveBeenCalledTimes(1)
    scheduler.stop() // 模拟登出/取消：清除旧 timer 并推进代号
    rejectRefresh(new Error('network down'))
    await vi.advanceTimersByTimeAsync(0) // 让 in-flight 失败路径执行
    // 登出后失败的刷新不应再武装重试：推进 30 分钟仍只有 1 次调用。
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('re-arm during an in-flight run discards the old retry and keeps the new timer', async () => {
    vi.useFakeTimers()
    let rejectOld!: (error: Error) => void
    const refresh = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectOld = reject
    }))
    const scheduler = new RefreshScheduler(refresh)
    const now = Date.now()
    scheduler.arm(now - 1, now) // 立即触发
    await vi.advanceTimersByTimeAsync(0) // 进入在途
    expect(refresh).toHaveBeenCalledTimes(1)
    scheduler.arm(now + 24 * 3_600_000, now) // 在途期间重新 arm（约 1h 后触发新 timer）
    rejectOld(new Error('network down'))
    await vi.advanceTimersByTimeAsync(0) // 旧 run 失败路径执行
    // 旧 run 的失败不应再武装重试：重试窗口内无额外调用。
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS - 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    // 新 timer（约 1h 后）触发一次。
    await vi.advanceTimersByTimeAsync(REFRESH_LEAD_MS + 61_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    // 新 timer 未被旧 retry 覆盖，也无计划外第二次触发。
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
