import { describe, expect, it } from 'vitest'
import {
  CLINE_HISTORY_LIMIT,
  clineRequestHistorySize,
  clineUpstreamOf,
  readClineRequestHistory,
  recordClineRequest,
  resetClineRequestHistory,
} from '../../src/cline-request-log.js'

/** 每条用例前清空:模块级可变状态会在用例间泄漏。 */
function seed(entries: Array<Parameters<typeof recordClineRequest>[0]>): void {
  resetClineRequestHistory()
  for (const entry of entries) recordClineRequest(entry)
}

const OK_A = {
  model: 'cline-pass/deepseek-v4.1-flash',
  accountId: 'acc-1',
  usageReported: true,
  inputTokens: 100,
  outputTokens: 25,
  ttftMs: 320,
  totalMs: 4200,
}

describe('recordClineRequest / readClineRequestHistory', () => {
  it('记录后按「最新在前」读出', () => {
    seed([OK_A, { ...OK_A, accountId: 'acc-2', model: 'cline-free/gemini-3.8-flash' }])
    const rows = readClineRequestHistory()
    expect(rows).toHaveLength(2)
    expect(rows[0]!.accountId).toBe('acc-2')
    expect(rows[1]!.accountId).toBe('acc-1')
  })

  it('成功行没有 error 字段;失败行 error 有值且截断到 200 字', () => {
    seed([
      OK_A,
      { ...OK_A, accountId: 'acc-2', error: 'x'.repeat(500) },
    ])
    // 记录是「最新在前」:后记的 acc-2(失败行)排在最前
    const rows = readClineRequestHistory()
    expect(rows[0]!.error).toHaveLength(200)
    expect(rows[1]!.error).toBeUndefined()
  })

  it('reasoningTokens 为 0/缺失时省略(不为 0 伪造)', () => {
    seed([{ ...OK_A, reasoningTokens: 89 }])
    expect(readClineRequestHistory()[0]!.reasoningTokens).toBe(89)
    seed([OK_A])
    expect(readClineRequestHistory()[0]!.reasoningTokens).toBeUndefined()
  })

  it('cacheReadTokens 为 0/缺失时省略(与 reasoningTokens 同口径)', () => {
    seed([{ ...OK_A, cacheReadTokens: 1_200 }])
    expect(readClineRequestHistory()[0]!.cacheReadTokens).toBe(1200)
    seed([{ ...OK_A, cacheReadTokens: 0 }])
    expect(readClineRequestHistory()[0]!.cacheReadTokens).toBeUndefined()
    seed([OK_A])
    expect(readClineRequestHistory()[0]!.cacheReadTokens).toBeUndefined()
  })

  /**
   * ⚠️ 展示层据 `usageReported` 决定 TOKEN 列显示 `—` 还是数字：
   * 只有**严格 true** 才算「收到过 usage 帧」，任何垃圾值都必须落到 false
   * （否则「网关没发用量」会被显示成 0，读起来像「没花 token」）。
   */
  it('usageReported 只认严格 true(垃圾值一律当「没收到 usage」)', () => {
    const truthy = [1, 'true', 'yes', {}, []] as unknown[]
    for (const value of truthy) {
      seed([{ ...OK_A, usageReported: value as boolean }])
      expect(readClineRequestHistory()[0]!.usageReported, String(value)).toBe(false)
    }
    seed([{ ...OK_A, usageReported: true }])
    expect(readClineRequestHistory()[0]!.usageReported).toBe(true)
  })

  /**
   * ⚠️ `effort` 的空串是**有意义的缺省**（= 本次没指定档位），
   * 展示层据此整行不渲染；截断则防止一条超长档位名把表格撑宽。
   */
  it('effort 缺省为空串、有值则截断到 32 字', () => {
    seed([OK_A])
    expect(readClineRequestHistory()[0]!.effort).toBe('')
    seed([{ ...OK_A, effort: 'high' }])
    expect(readClineRequestHistory()[0]!.effort).toBe('high')
    seed([{ ...OK_A, effort: 'x'.repeat(200) }])
    expect(readClineRequestHistory()[0]!.effort).toHaveLength(32)
  })

  /**
   * ⚠️ `upstream` 的空串是**有意义的缺省**（= 网关本次没报路由），
   * 展示层据此回落到模型命名空间；截断防止异常长的渠道名撑宽表格。
   */
  it('upstream 缺省为空串、有值则截断到 64 字', () => {
    seed([OK_A])
    expect(readClineRequestHistory()[0]!.upstream).toBe('')
    seed([{ ...OK_A, upstream: 'alibaba' }])
    expect(readClineRequestHistory()[0]!.upstream).toBe('alibaba')
    seed([{ ...OK_A, upstream: 'x'.repeat(200) }])
    expect(readClineRequestHistory()[0]!.upstream).toHaveLength(64)
  })

  /**
   * ⚠️ `ttfcMs` 是「首个**正文**块」耗时，与 `ttftMs`（首个任意块，可能是
   * 思考增量）**必须分开存**：展示层的输出速率 = 正文 token ÷
   * (`totalMs − ttfcMs`)，缺了它分子分母会跨阶段（用户报障 11814.8 t/s）。
   */
  it('ttfcMs 缺省为 0（= 没有正文块）、有值则保留', () => {
    seed([OK_A])
    expect(readClineRequestHistory()[0]!.ttfcMs).toBe(0)
    seed([{ ...OK_A, ttftMs: 320, ttfcMs: 1800 }])
    expect(readClineRequestHistory()[0]!.ttfcMs).toBe(1800)
    // 负数/垃圾值钳到 0（与 ttftMs 同口径）
    seed([{ ...OK_A, ttfcMs: -5 }])
    expect(readClineRequestHistory()[0]!.ttfcMs).toBe(0)
  })

  it('按 accountId 过滤(面板用同一个翻页索引切记录)', () => {
    seed([
      { ...OK_A, accountId: 'acc-1' },
      { ...OK_A, accountId: 'acc-2' },
      { ...OK_A, accountId: 'acc-1' },
    ])
    const rows = readClineRequestHistory({ accountId: 'acc-1' })
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.accountId === 'acc-1')).toBe(true)
  })

  it('limit 截断且不超过上限', () => {
    seed(Array.from({ length: 10 }, (_, i) => ({ ...OK_A, accountId: `acc-${i}` })))
    expect(readClineRequestHistory({ limit: 3 })).toHaveLength(3)
  })

  it('超过上限时淘汰最旧的记录', () => {
    seed(Array.from({ length: CLINE_HISTORY_LIMIT + 20 }, (_, i) => ({
      ...OK_A,
      accountId: `acc-${i}`,
    })))
    const rows = readClineRequestHistory()
    expect(rows).toHaveLength(CLINE_HISTORY_LIMIT)
    // 最新的保留(acc-119 是最后记录的),最旧的 acc-0 被淘汰
    expect(rows[0]!.accountId).toBe(`acc-${CLINE_HISTORY_LIMIT + 19}`)
    expect(rows.some(r => r.accountId === 'acc-0')).toBe(false)
  })

  it('负数/非有限 token 钳制为 0(不产生 NaN)', () => {
    seed([{ ...OK_A, inputTokens: -5, outputTokens: Number.NaN }])
    const row = readClineRequestHistory()[0]!
    expect(row.inputTokens).toBe(0)
    expect(row.outputTokens).toBe(0)
  })

  /**
   * ⚠️ **记录绝不抛错**:record() 由适配器在流结束/失败时调用,
   * 抛错会把记账失败反噬成推理失败 —— 那是比丢一条记录严重得多的故障。
   */
  it('垃圾输入不抛错且不产生 NaN', () => {
    for (const bad of [undefined, null, 'str', 42, {}] as unknown[]) {
      expect(() => recordClineRequest(bad as never), String(bad)).not.toThrow()
    }
    for (const row of readClineRequestHistory()) {
      expect(Number.isFinite(row.inputTokens)).toBe(true)
      expect(Number.isFinite(row.outputTokens)).toBe(true)
      expect(Number.isFinite(row.ttftMs)).toBe(true)
      expect(Number.isFinite(row.totalMs)).toBe(true)
    }
  })

  it('上限常量与参考实现一致(100 条)', () => {
    expect(CLINE_HISTORY_LIMIT).toBe(100)
  })
})

describe('clineUpstreamOf', () => {
  it('取模型 id 的「/ 前缀」作为上游', () => {
    expect(clineUpstreamOf('cline-pass/deepseek-v4.1-flash')).toBe('cline-pass')
    expect(clineUpstreamOf('cline-free/gemini-3.8-flash')).toBe('cline-free')
  })

  it('无前缀时返回空串(不编造)', () => {
    expect(clineUpstreamOf('deepseek-v4.1-flash')).toBe('')
    expect(clineUpstreamOf('')).toBe('')
  })
})

describe('clineRequestHistorySize / resetClineRequestHistory', () => {
  it('reset 清空并归零计数', () => {
    seed([OK_A, OK_A])
    expect(clineRequestHistorySize()).toBe(2)
    resetClineRequestHistory()
    expect(clineRequestHistorySize()).toBe(0)
    expect(readClineRequestHistory()).toEqual([])
  })
})
