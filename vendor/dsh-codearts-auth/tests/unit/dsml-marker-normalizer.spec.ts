/**
 * `dsml-marker-normalizer.spec.ts` —— DSML 标记归一化守卫（流式安全）。
 *
 * ## 背景（2026-10-13 实测）
 *
 * 部分模型把工具调用标记写坏成双竖线：`<｜｜DSML｜｜ invoke …>`（规范是
 * `<｜DSML｜invoke …>`，竖线 U+FF5C）。宿主解析器不认 ⇒ 工具调用整段当
 * 正文显示，模型「停住不动」。实测受害：deepseek-v4.1-flash（OfficeAce）、
 * step-5-preview（CodeBuddy）；正常模型（GLM-5.3-Flash）不受影响。
 *
 * ## 测试策略
 *
 * **二分帧穷举**是本文件的灵魂：标记被上游切成任意片段，逐帧 replace 必漏
 * （think 标签当年的实测教训：二分帧 7/11 种切法漏判）。故对每个用例穷举
 * **所有**切分点，任何一种切法结果不对即红 —— 这是不变量，不是抽查。
 */

import { describe, expect, it } from 'vitest'
import { createDsmlMarkerNormalizer, fixDsmlMarkers } from '../../src/sse.js'

const BAR = '\uFF5C'
const BAD_OPEN_INVOKE = `<${BAR}${BAR}DSML${BAR}${BAR} invoke name="write">`
const GOOD_OPEN_INVOKE = `<${BAR}DSML${BAR} invoke name="write">`
const BAD_CLOSE_PARAM = `</${BAR}${BAR}DSML${BAR}${BAR} parameter>`
const GOOD_CLOSE_PARAM = `</${BAR}DSML${BAR} parameter>`
const BAD_OPEN_CALLS = `<${BAR}${BAR}DSML${BAR}${BAR} calls>`
const GOOD_OPEN_CALLS = `<${BAR}DSML${BAR} calls>`

/** 把 text 按所有可能的切分点二分帧喂给归一化器，返回结果数组。 */
function feedByAllSplits(text: string): string[] {
  const results: string[] = []
  for (let cut = 0; cut <= text.length; cut++) {
    const n = createDsmlMarkerNormalizer()
    let out = n.push(text.slice(0, cut))
    out += n.push(text.slice(cut))
    out += n.flush()
    results.push(out)
  }
  return results
}

describe('fixDsmlMarkers（整串）', () => {
  it('① 开标签双竖线 → 单竖线', () => {
    expect(fixDsmlMarkers(BAD_OPEN_INVOKE)).toBe(GOOD_OPEN_INVOKE)
  })
  it('② 闭标签双竖线 → 单竖线', () => {
    expect(fixDsmlMarkers(BAD_CLOSE_PARAM)).toBe(GOOD_CLOSE_PARAM)
  })
  it('③ 单侧双竖线也修（左双右单 / 左单右双）', () => {
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML${BAR} calls>`)).toBe(GOOD_OPEN_CALLS)
    expect(fixDsmlMarkers(`<${BAR}DSML${BAR}${BAR} calls>`)).toBe(GOOD_OPEN_CALLS)
  })
  it('④ 规范输入逐字节不变（幂等）', () => {
    const canonical = `前言 ${GOOD_OPEN_INVOKE}正文${GOOD_CLOSE_PARAM} 后记`
    expect(fixDsmlMarkers(canonical)).toBe(canonical)
    expect(fixDsmlMarkers(fixDsmlMarkers(canonical))).toBe(canonical)
  })
  it('⑤ 无关的全角竖线不受影响（正常中文内容）', () => {
    const text = '可选值：A｜｜B（这里讨论的就是双竖线本身）'
    expect(fixDsmlMarkers(text)).toBe(text)
  })
  it('⑥ 三根竖线也收敛到一根', () => {
    expect(fixDsmlMarkers(`<${BAR}${BAR}${BAR}DSML${BAR}${BAR}${BAR} calls>`)).toBe(GOOD_OPEN_CALLS)
  })

  /**
   * ⚠️⚠️ **`DSML` 后必须有分隔边界**（2026-10-13 审计修正）。
   *
   * 原判据只要求「`<` + 双竖线 + `DSML`」，**不要求后面跟什么** ⇒ 正文里任何
   * 以 `DSML` 开头的普通词（如讨论 DSML 协议的助手输出、代码片段、日志转储）
   * 都会被无声改掉一个竖线。这是**篡改用户的合法正文**。
   *
   * 方向遵循仓库元规则「**宁可漏判不可误伤**」：宁可放过一个真坏标记，
   * 也不可改坏一段正常文本。合法边界 = 竖线 / 空白 / `>` / `/` / 字符串结尾。
   */
  it('⑦ `DSML` 后无分隔边界时**不动**（不得篡改合法正文）', () => {
    // 讨论 DSML 协议本身 —— 极易被过宽判据误伤
    const discussing = `<${BAR}${BAR}DSMLX 这不是标记，只是文字`
    expect(fixDsmlMarkers(discussing), 'DSMLX 不是标记，原样保留').toBe(discussing)
    // 右侧同理
    const rightSide = `工具名 DSML${BAR}${BAR}Xyz 也不是标记`
    expect(fixDsmlMarkers(rightSide), '右侧也无边界时不改').toBe(rightSide)
  })

  it('⑧ `DSML` 后有分隔边界时**仍要修**（收紧不得变成漏判）', () => {
    // 五种合法边界逐一验过：收紧判据的目的是「少误伤」而非「不修」
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML${BAR} calls>`)).toBe(GOOD_OPEN_CALLS)
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML calls>`)).toBe(`<${BAR}DSML calls>`)
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML>`)).toBe(`<${BAR}DSML>`)
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML`)).toBe(`<${BAR}DSML`)
    expect(fixDsmlMarkers(`</${BAR}${BAR}DSML${BAR} param>`)).toBe(`</${BAR}DSML${BAR} param>`)
  })
})

describe('createDsmlMarkerNormalizer（流式安全）', () => {
  it('⑦ **二分帧穷举**：坏标记任意切分，结果全部等于整串修复', () => {
    const expected = GOOD_OPEN_INVOKE + '一些正文' + GOOD_CLOSE_PARAM
    const broken = BAD_OPEN_INVOKE + '一些正文' + BAD_CLOSE_PARAM
    const results = feedByAllSplits(broken)
    const bad = results.map((r, i) => ({ r, i })).filter(({ r }) => r !== expected)
    expect(
      bad,
      `有 ${bad.length}/${results.length} 种切法结果不对（切分点: ${bad.map(b => b.i).join(',')}）`,
    ).toEqual([])
  })

  it('⑧ **二分帧穷举**：真实坏样本（会话日志原文，run_code 形态）', () => {
    // 取自 2026-10-13 会话日志的逐字样本（step-5-preview 经 CodeBuddy 输出）
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR} calls> <${BAR}${BAR}DSML${BAR}${BAR} invoke name="run_code"> <${BAR}${BAR}DSML${BAR}${BAR} parameter name="code" string="true">const r = 1</${BAR}${BAR}DSML${BAR}${BAR} parameter> </${BAR}${BAR}DSML${BAR}${BAR} invoke> </${BAR}${BAR}DSML${BAR}${BAR} calls>`
    const expected = broken.replaceAll(`${BAR}${BAR}DSML`, `${BAR}DSML`).replaceAll(`DSML${BAR}${BAR}`, `DSML${BAR}`)
    const results = feedByAllSplits(broken)
    const bad = results.filter((r) => r !== expected)
    expect(bad, `${bad.length}/${results.length} 种切法失败`).toEqual([])
    expect(expected).toContain(GOOD_OPEN_INVOKE.replace('write', 'run_code'))
  })

  it('⑨ 规范输入任意切分逐字节不变（不得误伤正常流）', () => {
    const canonical = `思考一下。${GOOD_OPEN_CALLS}\\n${GOOD_OPEN_INVOKE}参数${GOOD_CLOSE_PARAM}\\n</${BAR}DSML${BAR}invoke>${GOOD_OPEN_CALLS.replace(' calls', ' tool_calls')}`
    const results = feedByAllSplits(canonical)
    const bad = results.filter((r) => r !== canonical)
    expect(bad, `${bad.length} 种切法改变了规范输出`).toEqual([])
  })

  it('⑩ 跨帧粘合：前帧尾 + 后帧头拼成模式（流式安全的核心场景）', () => {
    // 切点正好在模式中间的典型形态
    const n = createDsmlMarkerNormalizer()
    const out1 = n.push('回答正文 <' + BAR)
    const out2 = n.push(BAR + 'DSML' + BAR + BAR + ' invoke name="pwsh">')
    const out3 = n.flush()
    expect(out1 + out2 + out3).toBe('回答正文 ' + GOOD_OPEN_INVOKE.replace('write', 'pwsh'))
  })

  it('⑪ 无图穷举反面：正文里的孤立 DSML 词不被吞（延迟后必须如数下发）', () => {
    const text = '这个仓库里有 DSML 文档，还有 DSML｜ 记号'
    const results = feedByAllSplits(text)
    const bad = results.filter((r) => r !== text)
    expect(bad, `${bad.length} 种切法改变了普通文本`).toEqual([])
  })

  it('⑫ flush 后归一化器可丢弃（无跨流状态泄漏 —— 每流一实例的契约由调用方保证）', () => {
    const n = createDsmlMarkerNormalizer()
    n.push(BAD_OPEN_CALLS.slice(0, 5))
    n.flush()
    // 新 push 从空缓冲开始（不残留上一流的尾巴）
    expect(n.push('普通文本')).toBe('普通文本')
    expect(n.flush()).toBe('')
  })
})
