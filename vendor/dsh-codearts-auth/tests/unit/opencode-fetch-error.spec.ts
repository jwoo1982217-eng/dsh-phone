/**
 * `describeFetchError` 的行为用例（issue IKK4BY 第 2 点）。
 *
 * ## 为什么单独一份
 *
 * Node 的 fetch 在传输层失败时 `error.message` **恒为** `'fetch failed'`，
 * 真因只在 `error.cause` 上。只取 message 的后果是「所有故障都显示同一句话」，
 * 用户与排障者都无从下手 —— 本 issue 的报障正是这个形态
 * （「固定显示测试失败 fetch failed，耗时 0 到 1 毫秒」）。
 *
 * 故这里逐类锁死：单层 cause、多层 cause、带 code、无 cause、非 Error。
 */
import { describe, expect, it } from 'vitest'
import { describeFetchError } from '../../src/opencode-rpc.js'

/** 造一个带 cause 链的错误。 */
function chain(...specs: Array<{ message: string; code?: string }>): Error {
  let next: Error | undefined
  for (const spec of [...specs].reverse()) {
    const error = new Error(spec.message) as Error & { code?: string; cause?: unknown }
    if (spec.code !== undefined) error.code = spec.code
    if (next !== undefined) error.cause = next
    next = error
  }
  return next as Error
}

describe('describeFetchError：把真正的根因带出来', () => {
  it('⚠️ 单层 cause：不丢 `fetch failed` 之外的真因', () => {
    const error = chain({ message: 'fetch failed' }, { message: 'connect ECONNREFUSED 127.0.0.1:45999', code: 'ECONNREFUSED' })
    const text = describeFetchError(error)
    expect(text).toContain('ECONNREFUSED')
    expect(text).toContain('127.0.0.1:45999')
    // 顶层那句无信息量的 `fetch failed` 在有 cause 时应被省略（避免噪音）
    expect(text).not.toContain('fetch failed')
  })

  it('⚠️ 契约冲突（本 issue 的真因）能被完整带出', () => {
    const error = chain(
      { message: 'fetch failed' },
      { message: 'invalid onRequestStart method', code: 'UND_ERR_INVALID_ARG' },
    )
    const text = describeFetchError(error)
    expect(text).toContain('invalid onRequestStart method')
    expect(text).toContain('UND_ERR_INVALID_ARG')
  })

  it('多层 cause 逐层展开（最多 3 层，防止病态长链撑爆日志）', () => {
    const error = chain(
      { message: 'fetch failed' },
      { message: 'socket hang up' },
      { message: 'TLS handshake failed', code: 'ERR_SSL_WRONG_VERSION_NUMBER' },
    )
    const text = describeFetchError(error)
    expect(text).toContain('socket hang up')
    expect(text).toContain('TLS handshake failed')
    expect(text).toContain('ERR_SSL_WRONG_VERSION_NUMBER')
  })

  it('⚠️ 没有 cause 时保留 `fetch failed`（否则会报出一句空话）', () => {
    const text = describeFetchError(new Error('fetch failed'))
    expect(text).toBe('fetch failed')
  })

  it('非 Error 值也能安全转字符串', () => {
    expect(describeFetchError('boom')).toBe('boom')
    expect(describeFetchError(undefined)).toBe('undefined')
  })

  it('普通错误（非 fetch）原样带出', () => {
    expect(describeFetchError(new Error('代理地址为空'))).toBe('代理地址为空')
  })

  it('⚠️ code 已包含在 message 里时不重复追加（避免 `X (X)` 的冗余）', () => {
    const error = new Error('connect ECONNREFUSED') as Error & { code?: string }
    error.code = 'ECONNREFUSED'
    expect(describeFetchError(error)).toBe('connect ECONNREFUSED')
  })

  /**
   * 以下三条来自**对抗性审计**发现的边界（审计员实测 + 我复核），
   * 修完各自锁一条：它们都是「报错变得更没用」的退化，不是崩溃，故容易漏。
   */
  it('⚠️ 无信息量层不得吃掉输出预算，把根因挤出窗口（审计发现 D）', () => {
    // 反例：outer → mid → `fetch failed`（无信息量）→ 真正的根因。
    // 旧实现用同一个 depth 计数兼任「遍历上限」与「输出条数上限」，
    // 噪音层占掉一格后只剩 3 格，根因被截掉 —— 实测输出 `outer ← mid`。
    const root = new Error('connect ECONNREFUSED 127.0.0.1:45999')
    const withNoise = (() => {
      const a = new Error('outer-layer') as Error & { cause?: unknown }
      const b = new Error('mid-layer') as Error & { cause?: unknown }
      const c = new Error('fetch failed') as Error & { cause?: unknown }
      a.cause = b; b.cause = c; c.cause = root
      return a
    })()
    const text = describeFetchError(withNoise)
    expect(text).toContain('outer-layer')
    expect(text).toContain('mid-layer')
    // ⚠️ 关键断言：真正的根因必须在，且噪音层被跳过
    expect(text).toContain('ECONNREFUSED')
    expect(text).not.toContain('fetch failed')
  })

  it('⚠️ `cause = null` 与 `cause = undefined` 必须一视同仁（审计发现 D）', () => {
    // 旧判据只写 `cause === undefined`，于是 `null` 走进「无 cause」分支，
    // 输出带 `Error: ` 前缀的噪音（实测 `Error: fetch failed`）。
    expect(describeFetchError(Object.assign(new Error('fetch failed'), { cause: null }))).toBe('fetch failed')
    expect(describeFetchError(Object.assign(new Error('fetch failed'), { cause: undefined }))).toBe('fetch failed')
  })

  it('⚠️ 空 message 不能输出空串（否则 UI 显示「测试失败：」后什么都没有）', () => {
    // 实测：`new Error('')` 会让 parts 变成 `['']`，join 后是空字符串。
    const text = describeFetchError(new Error(''))
    expect(text.length).toBeGreaterThan(0)
    // 有 cause 时，空 message 层应被跳过，直接给出根因
    const withCause = Object.assign(new Error(''), { cause: new Error('connect ECONNREFUSED') })
    expect(describeFetchError(withCause)).toBe('connect ECONNREFUSED')
  })

  it('⚠️ 自引用 / 环形 cause 不得死循环（遍历有硬上限）', () => {
    const self = new Error('self') as Error & { cause?: unknown }
    self.cause = self
    expect(describeFetchError(self)).toBeDefined()
    const a = new Error('A') as Error & { cause?: unknown }
    const b = new Error('B') as Error & { cause?: unknown }
    a.cause = b; b.cause = a
    expect(describeFetchError(a)).toBeDefined()
  })
})
