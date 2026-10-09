import { describe, expect, it } from 'vitest'
import { parseRetryAfterMs, retryAfterMsFromRecord, retryAfterMsFromResponse } from '../../src/retry-after.js'

/**
 * `retry-after` 头的解析。
 *
 * 这份实现原先在本仓库有**两处**几乎逐字相同的私有副本（`opencode-adapter.ts`
 * 与 `opencode-product.ts`），Cline 又需要它（真实缺陷：Cline 在 429 上会给出
 * 真实等待时长，而适配器把整个头丢掉、写死「1 小时后」）—— 故收敛成一份。
 */
const NOW = 1_791_009_000_000

describe('parseRetryAfterMs', () => {
  it('秒数 → 毫秒（官方文档的形态）', () => {
    expect(parseRetryAfterMs('600', NOW)).toBe(600_000)
    expect(parseRetryAfterMs('0', NOW)).toBe(0)
    expect(parseRetryAfterMs('1.5', NOW)).toBe(1500)
  })

  it('★ `0` 是合法值「立即解除」，不是「未知」', () => {
    // ⚠️ 判空必须用 `=== undefined`：任何 falsy 判据都会把 0 当成「未知」，
    // 于是一个刚被限流的账号会被白白锁上一小时。
    expect(parseRetryAfterMs('0', NOW)).toBe(0)
    expect(parseRetryAfterMs('0', NOW)).not.toBeUndefined()
  })

  it('HTTP 日期 → 相对当前时刻的毫秒数', () => {
    const when = new Date(NOW + 120_000).toUTCString()
    expect(parseRetryAfterMs(when, NOW)).toBe(120_000)
  })

  it('已过去的 HTTP 日期抹成 0（而不是负数）', () => {
    const when = new Date(NOW - 60_000).toUTCString()
    expect(parseRetryAfterMs(when, NOW)).toBe(0)
  })

  it('★ 纯数字必须走「秒」分支，不能落到 Date.parse', () => {
    // `Date.parse('900')` 是 1970 年的时刻 → 差值巨大负数 → 被抹成 0（=立即解除）
    // → 额度刚用尽的账号马上被重选，形成无限空转。
    expect(parseRetryAfterMs('900', NOW)).toBe(900_000)
    expect(parseRetryAfterMs('900', NOW)).not.toBe(0)
  })

  it('缺失 / 空串 / 垃圾值一律 undefined（**服务端没声明**，与 0 不同）', () => {
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined()
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined()
    expect(parseRetryAfterMs('', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('soon', NOW)).toBeUndefined()
  })

  it('★ 负数按「无效」处理，**不能**被抹成 0（否则畸形头会让账号立刻被重选）', () => {
    // `Date.parse('-5')` 是合法的（当成 ISO 年份），若不拦住就会得到
    // 「巨大负数 → Math.max(0, …) → 0 → 立即解除」——被限流的账号马上又被选中。
    expect(parseRetryAfterMs('-5', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('-1', NOW)).not.toBe(0)
  })
})

describe('两种取头方式（fetch Headers / 普通记录）', () => {
  it('从 Headers 形态取', () => {
    expect(retryAfterMsFromResponse(new Headers({ 'retry-after': '600' }), NOW)).toBe(600_000)
    expect(retryAfterMsFromResponse(new Headers(), NOW)).toBeUndefined()
    expect(retryAfterMsFromResponse(null, NOW)).toBeUndefined()
    expect(retryAfterMsFromResponse(undefined, NOW)).toBeUndefined()
  })

  it('从记录形态取，且大小写两种键都认', () => {
    expect(retryAfterMsFromRecord({ 'retry-after': '600' }, NOW)).toBe(600_000)
    expect(retryAfterMsFromRecord({ 'Retry-After': '600' }, NOW)).toBe(600_000)
    expect(retryAfterMsFromRecord({}, NOW)).toBeUndefined()
    expect(retryAfterMsFromRecord(undefined, NOW)).toBeUndefined()
  })

  it('两种形态对同一个值给同一个答案（不能各算一套）', () => {
    const when = new Date(NOW + 300_000).toUTCString()
    expect(retryAfterMsFromResponse(new Headers({ 'retry-after': when }), NOW))
      .toBe(retryAfterMsFromRecord({ 'retry-after': when }, NOW))
  })
})
