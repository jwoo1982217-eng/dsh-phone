/**
 * `dsml-calls-alias.spec.ts` —— 防回归：DSML 开标签的**别名形态**必须被兼容。
 *
 * ## 两次事故（必须留档）
 *
 * - **第一次（`fc028ea`，已修）**：适配器既不发 `tools` 也不注入 DSML 提示，
 *   模型零协议指引下臆造 `<｜DSML｜ calls>`。修法：注入 `buildDsmlSystemPrompt`。
 * - **第二次（本文件，2026-10-13 18:33 用户截图实证）**：提示注入了、
 *   `DsmlContentExtractor` 也接进 `consumeOpenAiSse` 了，**照样泄漏**。
 *   两个独立缺陷叠加：
 *
 *   1. **`needsDsmlToolMode` 大小写敏感**。正则全小写，而模型在 UI / 部分
 *      调用链里以**显示名**流转（`DeepSeek-V4.1-Flash`，见 `OFFICEACE_MODELS`
 *      的 `name` 字段）。显示名一律不匹配 ⇒ `dsmlMode = false` ⇒
 *      **既不注入提示，也不建提取器**（`dsmlExtractor` 仅在
 *      `dsmlToolMode === true` 时创建）⇒ 模型继续臆造 `calls`。
 *   2. **提取器只认规范开标签**。`indexOf(DSML_TOOL_CALLS_OPEN)` 对
 *      `<｜DSML｜ calls>` 零命中 ⇒ 整段当正文。
 *
 *   即：光「教」不够，光「解」也不够 —— 判据必须先放行，解析器再容错。
 *
 * 本文件锁的就是这两半的**成对性**。
 */

import { describe, expect, it } from 'vitest'
import {
  DsmlContentExtractor,
  DSML_TOOL_CALLS_CLOSE,
  DSML_TOOL_CALLS_OPEN,
  isDeepseekV4Model,
  needsDsmlToolMode,
} from '../../src/dsml.js'

/** 拼一个规范的 DSML 块。 */
function block(body: string): string {
  return `${DSML_TOOL_CALLS_OPEN}${body}${DSML_TOOL_CALLS_CLOSE}`
}
const INVOKE = `<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter></｜DSML｜invoke>`

describe('模型判定：大小写不敏感（第二次事故的根因之一）', () => {
  it('① 无版本号的显示名形态由 isDeepseekV4Model 认领', () => {
    // OFFICEACE_MODELS 的 name 字段就是这些形态
    expect(isDeepseekV4Model('DeepSeek-V4-Flash')).toBe(true)
    expect(isDeepseekV4Model('DeepSeek-V4-Pro')).toBe(true)
  })

  it('①b 带 .N 版本号的形态由 needsDsmlToolMode 的第二个正则认领', () => {
    // 注意：`DeepSeek-V4.1-Flash` 不属于 isDeepseekV4Model（那只认无版本号形），
    // 但 needsDsmlToolMode 必须放行 —— 少这一条就等于漏掉 OfficeAce 主力模型。
    expect(isDeepseekV4Model('DeepSeek-V4.1-Flash')).toBe(false)
    expect(needsDsmlToolMode('DeepSeek-V4.1-Flash', ['bash'])).toBe(true)
  })

  it('② needsDsmlToolMode 对显示名同样放行', () => {
    expect(needsDsmlToolMode('DeepSeek-V4.1-Flash', ['bash'])).toBe(true)
    expect(needsDsmlToolMode('DeepSeek-V4-Flash', ['bash'])).toBe(true)
    expect(needsDsmlToolMode('DeepSeek-V4-Pro', ['bash'])).toBe(true)
  })

  it('③ 原有小写 id 形态不受影响', () => {
    expect(needsDsmlToolMode('deepseek-v4.1-flash', ['bash'])).toBe(true)
    expect(needsDsmlToolMode('deepseek-v4-flash', ['bash'])).toBe(true)
    expect(needsDsmlToolMode('deepseek-v4-pro', ['bash'])).toBe(true)
  })

  it('④ 非 v4 模型仍不得被误伤', () => {
    for (const m of ['kimi-k2.6', 'glm-5.3', 'qwen3-32b', 'hy4-preview-f', 'step-5-preview']) {
      expect(needsDsmlToolMode(m, ['bash']), m).toBe(false)
    }
  })
})

describe('提取器：开标签别名归一（第二次事故的根因之二）', () => {
  it('⑤ `<｜DSML｜ calls>`（少 tool_ 前缀）必须解析出调用', () => {
    const ex = new DsmlContentExtractor()
    const r = ex.feed(`<｜DSML｜ calls>${INVOKE}</｜DSML｜ calls>`)
    expect(r.toolCalls).toEqual([{ name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) }])
    expect(r.text).toBe('')
  })

  it('⑥ `<｜DSML｜calls>`（无空格）同样兼容', () => {
    const ex = new DsmlContentExtractor()
    const r = ex.feed(`<｜DSML｜calls>${INVOKE}</｜DSML｜calls>`)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.text).toBe('')
  })

  it('⑦ `<｜DSML｜ tool_calls>`（多余空白）归一为规范形', () => {
    const ex = new DsmlContentExtractor()
    const r = ex.feed(`<｜DSML｜ tool_calls>${INVOKE}</｜DSML｜ tool_calls>`)
    expect(r.toolCalls).toHaveLength(1)
  })

  it('⑧ 规范形不受影响（阳性对照）', () => {
    const ex = new DsmlContentExtractor()
    const r = ex.feed(block(INVOKE))
    expect(r.toolCalls).toEqual([{ name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) }])
  })

  it('⑨ 别名**拆帧到达**也必须拼齐后解析（不能漏放行）', () => {
    const ex = new DsmlContentExtractor()
    const whole = `<｜DSML｜ calls>${INVOKE}</｜DSML｜ calls>`
    const calls: unknown[] = []
    let text = ''
    // 逐字符喂，最苛刻的拆法
    for (const ch of whole) {
      const r = ex.feed(ch)
      text += r.text
      calls.push(...r.toolCalls)
    }
    const tail = ex.flush()
    text += tail.text
    expect(calls).toHaveLength(1)
    expect(text).toBe('')
  })

  it('⑩ 别名前面的正文不得被吞', () => {
    const ex = new DsmlContentExtractor()
    const r = ex.feed(`我先看看目录。<｜DSML｜ calls>${INVOKE}</｜DSML｜ calls>`)
    expect(r.text).toBe('我先看看目录。')
    expect(r.toolCalls).toHaveLength(1)
  })

  it('⑪ 幂等：规范形再过一遍归一化不变', () => {
    const ex = new DsmlContentExtractor()
    const first = ex.feed(block(INVOKE))
    // 第二帧再喂同一规范块，应同样解析（而非被二次改写坏）
    const second = ex.feed(block(INVOKE))
    expect(first.toolCalls).toHaveLength(1)
    expect(second.toolCalls).toHaveLength(1)
  })

  it('⑫ 普通文本里的 "calls" 一词不得被误改', () => {
    const ex = new DsmlContentExtractor()
    const r = ex.feed('This function calls another one. No tool calls here.')
    expect(r.text).toBe('This function calls another one. No tool calls here.')
    expect(r.toolCalls).toEqual([])
  })
})
