/**
 * `dsml-label-forms.spec.ts` —— DSML **标签形态**守卫（2026-10-13 四次事故的收口）。
 *
 * ## 为什么单独一个文件
 *
 * 已有的三个 DSML spec 各自覆盖一块，但都**没有**覆盖本文件锁的这条：
 *
 * | 已有 spec | 覆盖 | 未覆盖 |
 * |---|---|---|
 * | `dsml-marker-normalizer.spec.ts` | 双竖线（`sse.ts` 流式层） | `dsml.ts` 自己的归一；`invoke`/`parameter` 空白 |
 * | `dsml-parse-roundtrip.spec.ts` | 规范形端到端 + 二分帧 | 别名/空白/双竖线的**组合**形态 |
 * | `dsml-consume-wiring.spec.ts` | `consumeOpenAiSse` 接线行为 | `llm-adapter`（codearts）主路径 |
 *
 * ## 本文件锁的四条真缺陷（均有真实会话取证 + 反向验证）
 *
 * 1. **`｜DSML｜` 后带空白的 `invoke` / `parameter` ⇒ 内容凭空消失**
 *    现场 `session-bac90b72` seq=47（`codearts/deepseek-v4.1-flash`）：
 *    模型逐字输出 `<｜DSML｜ invoke name="pwsh">`、`<｜DSML｜ parameter …>`，
 *    而归一只覆盖 `tool_calls` / `calls` 一种名字 ⇒
 *    `indexOf(DSML_INVOKE_OPEN_PREFIX)` 恒不命中 ⇒
 *    `parseDsmlToolCalls` 返回**空数组** ⇒ `feed()` 把它当「解析成功但无调用」
 *    ⇒ 整段工具调用被静默丢弃 ⇒ 用户看到「模型很快就结束了，没有原因」
 *    （reasoning 在、正文只剩一句、`finish=stop`、零 tool-call、usage 全 0）。
 *
 * 2. **`parseDsmlToolCalls` 的空数组被当成「成功」**
 *    同一条现场的另一切面。空数组与「解析出一个调用」在旧实现里走同一支
 *    （`toolCalls.push(...parsed)`，空数组 push 0 个）⇒ 静默丢弃。
 *
 * 3. **`parseDsmlInvoke` 在整块上搜 `name=` ⇒ 误匹配 parameter 名**
 *    模型漏写 invoke 的 name 时（`<｜DSML｜invoke>`），第一个 `name=` 命中
 *    的是 `<｜DSML｜parameter name="command" …>` ⇒ 工具名变成 `command` ⇒
 *    `unknown tool "command"`。
 *
 * 4. **`fixDsmlMarkers` 的 `DSML` 后前视漏了字母 ⇒ 右侧双竖线修不掉**
 *    原前视 `(?=｜|\s|>|\/|$)` 遇到 `<｜DSML｜｜invoke` 的 `i` 就跳过 ⇒
 *    留下半修形态 `<｜DSML｜invoke`，比不修更糟。
 *
 * ## 测试策略
 *
 * **二分帧 + 逐字符穷举**是本文件的灵魂：所有坏形态都来自分词器保真度问题，
 * 而上游可把标签切成任意片段。只测整帧的用例**挡不住**拆帧形态
 * （本仓库的 think 标签与 DSML 双竖线都实测过这个教训）。
 */

import { describe, expect, it } from 'vitest'
import {
  DsmlContentExtractor,
  DSML_TOOL_CALLS_CLOSE,
  DSML_TOOL_CALLS_OPEN,
  normalizeDsmlLabel,
  normalizeDsmlText,
  parseDsmlToolCalls,
} from '../../src/dsml.js'
import { createDsmlMarkerNormalizer, fixDsmlMarkers } from '../../src/sse.js'

const BAR = '\uFF5C'
const OPEN = `<${BAR}DSML${BAR}`
const CLOSE = `</${BAR}DSML${BAR}`

/**
 * 现场逐字样本（`session-bac90b72` seq=47 的 `text` 块原文，2026-10-13）。
 *
 * ⚠️ 这是**真实日志**而非自造 fixture：自造样本曾在真实数据上失效
 * （本仓库 `session-replay.spec.ts` 的建立理由），故直接抄会话原文。
 * 三个坏形态同时在场：`calls` 缺 `tool_`、`invoke` / `parameter` 带空格、
 * 标签之间夹换行。
 */
const REAL_SESSION_BLOCK = [
  '<｜DSML｜ calls>',
  '<｜DSML｜ invoke name="pwsh">',
  '<｜DSML｜ parameter name="command" string="true">git log --oneline -1; git log --oneline --all | Measure-Object -Line</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="description" string="true">Check repo HEAD and commit count</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="workdir" string="true">D:\\jet\\code\\js\\dsh-codearts</｜DSML｜ parameter>',
  '</｜DSML｜ invoke>',
  '<｜DSML｜ invoke name="grep">',
  '<｜DSML｜ parameter name="pattern" string="true">aggregate</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="path" string="true">D:\\jet\\code\\js\\dsh-codearts</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="include" string="true">*.md</｜DSML｜ parameter>',
  '</｜DSML｜ invoke>',
  '</｜DSML｜ calls>',
].join('\n')

/** 把文本按所有可能的切分点二分帧喂给提取器，返回 { calls, text }。 */
function feedByAllSplits(text: string): Array<{ cut: number; calls: number; text: string }> {
  const out: Array<{ cut: number; calls: number; text: string }> = []
  for (let cut = 0; cut <= text.length; cut++) {
    const ex = new DsmlContentExtractor()
    const r1 = ex.feed(text.slice(0, cut))
    const r2 = ex.feed(text.slice(cut))
    const f = ex.flush()
    out.push({
      cut,
      calls: r1.toolCalls.length + r2.toolCalls.length,
      text: r1.text + r2.text + f.text + f.reasoning,
    })
  }
  return out
}

describe('normalizeDsmlLabel（标签空白归一）', () => {
  it('① `｜DSML｜` 后的空白从任意标签名上压掉', () => {
    expect(normalizeDsmlLabel(`${OPEN} invoke name="pwsh">`)).toBe(`${OPEN}invoke name="pwsh">`)
    expect(normalizeDsmlLabel(`${OPEN} parameter name="command" string="true">`))
      .toBe(`${OPEN}parameter name="command" string="true">`)
    expect(normalizeDsmlLabel(`${CLOSE} parameter>`)).toBe(`${CLOSE}parameter>`)
    expect(normalizeDsmlLabel(`${OPEN} tool_calls>`)).toBe(DSML_TOOL_CALLS_OPEN)
  })

  it('② 空白长度无上限（\\t / U+3000 / 换行 / 40 空格全覆盖）', () => {
    // ⚠️ 本函数只压空白、**不改标签名**（`calls` 仍是 `calls`）——
    //    别名归一（`calls` → `tool_calls`）是 `normalizeDsmlText` 的职责，
    //    两个函数分工不同，别把断言写串。
    for (const blank of ['  ', '\t', '\u3000', '\n', ' '.repeat(40)]) {
      expect(normalizeDsmlLabel(`${OPEN}${blank}calls>`), `blank=${JSON.stringify(blank)}`)
        .toBe(`${OPEN}calls>`)
      expect(normalizeDsmlLabel(`${OPEN}${blank}invoke name="x">`), `blank=${JSON.stringify(blank)}`)
        .toBe(`${OPEN}invoke name="x">`)
    }
  })

  it('③ 两侧竖线各自独立伸缩（单/双/混合都归一到单竖线）', () => {
    expect(normalizeDsmlLabel(`<${BAR}${BAR}DSML${BAR}${BAR}invoke name="x">`))
      .toBe(`${OPEN}invoke name="x">`)
    expect(normalizeDsmlLabel(`<${BAR}${BAR}DSML${BAR}invoke name="x">`))
      .toBe(`${OPEN}invoke name="x">`)
    expect(normalizeDsmlLabel(`<${BAR}DSML${BAR}${BAR}invoke name="x">`))
      .toBe(`${OPEN}invoke name="x">`)
  })

  it('④ 幂等（规范形再过一遍逐字节不变）', () => {
    const canonical = `${OPEN}invoke name="bash">${OPEN}parameter name="c" string="true">ls${CLOSE}parameter>${CLOSE}invoke>`
    expect(normalizeDsmlLabel(canonical)).toBe(canonical)
    expect(normalizeDsmlLabel(normalizeDsmlLabel(canonical))).toBe(canonical)
  })

  it('⑤ 无关的全角竖线不受影响（不得篡改合法正文）', () => {
    const text = '可选值：A｜｜B（这里讨论的就是双竖线本身）'
    expect(normalizeDsmlLabel(text)).toBe(text)
    expect(normalizeDsmlLabel('a | b')).toBe('a | b')
  })
})

describe('normalizeDsmlText（协议级整段归一）', () => {
  it('⑥ 三种笔误一次做完：双竖线 + 别名 + 空白', () => {
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR} calls><${BAR}${BAR}DSML${BAR}${BAR} invoke name="pwsh"><${BAR}${BAR}DSML${BAR}${BAR} parameter name="c" string="true">ls</${BAR}${BAR}DSML${BAR}${BAR} parameter></${BAR}${BAR}DSML${BAR}${BAR} invoke></${BAR}${BAR}DSML${BAR}${BAR} calls>`
    expect(normalizeDsmlText(broken)).toBe(
      `${DSML_TOOL_CALLS_OPEN}${OPEN}invoke name="pwsh">${OPEN}parameter name="c" string="true">ls${CLOSE}parameter>${CLOSE}invoke>${DSML_TOOL_CALLS_CLOSE}`,
    )
  })

  it('⑦ 与 sse.ts 的 fixDsmlMarkers 判据同源（两份正则不得漂移）', () => {
    // ⚠️ 两份实现是不得已的分叉（dsml.ts 服务累积 buffer，sse.ts 服务逐帧流）。
    //    ⚠️ **只对「双竖线」这一条判据要求逐字同源**：`normalizeDsmlText`
    //    额外多做别名归一（`calls` → `tool_calls`）与标签空白归一，那是
    //    `fixDsmlMarkers` 刻意不做的（它只管竖线）⇒ 对拍必须用**既无别名
    //    也无空白**的样本，否则比的是两份函数的职责差异而非判据差异。
    const samples = [
      `<${BAR}${BAR}DSML${BAR}${BAR}tool_calls>`,
      `<${BAR}${BAR}DSML${BAR}${BAR}invoke name="pwsh">`,
      `<${BAR}${BAR}DSML${BAR}${BAR}parameter name="c">`,
      `</${BAR}${BAR}DSML${BAR}${BAR}tool_calls>`,
      `<${BAR}DSML${BAR}${BAR}tool_calls>`,
      `<${BAR}${BAR}DSMLX 这不是标记`,
      `工具名 DSML${BAR}${BAR}Xyz 也不是标记`,
      `正文<${BAR}${BAR}DSML${BAR}${BAR}invoke>更多`,
    ]
    for (const s of samples) {
      expect(normalizeDsmlText(s), `样本 ${JSON.stringify(s)}`).toBe(fixDsmlMarkers(s))
    }
  })
})

describe('fixDsmlMarkers：DSML 后前视必须含协议标签名首字母', () => {
  it('⑧ 右侧双竖线后紧跟字母也要修（否则留下半修形态）', () => {
    // ⚠️ 真缺陷：原前视 `(?=｜|\s|>|\/|$)` 遇到 `invoke` 的 `i` 就跳过
    //    ⇒ 只修左侧、留下 `<｜DSML｜invoke` 这种半修形态（比不修更糟）。
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML${BAR}${BAR}invoke name="x">`))
      .toBe(`${OPEN}invoke name="x">`)
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML${BAR}${BAR}parameter name="c">`))
      .toBe(`${OPEN}parameter name="c">`)
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML${BAR}${BAR}tool_calls>`))
      .toBe(DSML_TOOL_CALLS_OPEN)
    expect(fixDsmlMarkers(`<${BAR}${BAR}DSML${BAR}${BAR}calls>`))
      .toBe(`${OPEN}calls>`)
  })

  it('⑨ 收紧不得变成漏判：`DSML` 后无合法边界时仍不动', () => {
    // 与 ⑧ 互为边界：首字母白名单只放行协议标签名，不泛化成「任意字母」
    const discussing = `<${BAR}${BAR}DSMLX 这不是标记，只是文字`
    expect(fixDsmlMarkers(discussing), 'DSMLX 不是标记，原样保留').toBe(discussing)
    const rightSide = `工具名 DSML${BAR}${BAR}Xyz 也不是标记`
    expect(fixDsmlMarkers(rightSide), '右侧也无边界时不改').toBe(rightSide)
  })
})

describe('parseDsmlToolCalls：空数组不得被当成「解析成功」', () => {
  it('⑩ 零 invoke 的块返回空数组（调用方必须放行原文）', () => {
    expect(parseDsmlToolCalls(`${DSML_TOOL_CALLS_OPEN}${DSML_TOOL_CALLS_CLOSE}`)).toEqual([])
  })

  it('⑪ 入口自保归一：带空格的块直接调用也能解析', () => {
    // ⚠️ 本函数是**导出**的，除 feed() 外还有别处直接调用。
    //    旧实现假定调用方已归一 ⇒ 同一形态经 feed() 修得好、直接进却得 []。
    const block = `${DSML_TOOL_CALLS_OPEN}${OPEN} invoke name="pwsh">${OPEN} parameter name="c" string="true">ls${CLOSE} parameter>${CLOSE} invoke>${DSML_TOOL_CALLS_CLOSE}`
    expect(parseDsmlToolCalls(block))
      .toEqual([{ name: 'pwsh', arguments: JSON.stringify({ c: 'ls' }) }])
  })

  it('⑫ invoke 漏写 name 时返回 undefined（不得误用 parameter 名当工具名）', () => {
    // ⚠️ 真缺陷：旧实现在**整块**上搜第一个 `name=`，命中 parameter 名
    //    ⇒ 工具名变成 `command` ⇒ `unknown tool "command"`。
    const noName = `${DSML_TOOL_CALLS_OPEN}${OPEN}invoke>${OPEN}parameter name="command" string="true">ls${CLOSE}parameter>${CLOSE}invoke>${DSML_TOOL_CALLS_CLOSE}`
    expect(parseDsmlToolCalls(noName)).toBeUndefined()
    // 对照组：正常带 name 的必须照常解析
    const withName = noName.replace(`${OPEN}invoke>`, `${OPEN}invoke name="pwsh">`)
    expect(parseDsmlToolCalls(withName)?.[0].name).toBe('pwsh')
  })

  it('⑬ parameter 未闭合时返回空数组而非误报调用', () => {
    const truncated = `${DSML_TOOL_CALLS_OPEN}${OPEN}invoke name="pwsh">${OPEN}parameter name="c" string="true">ls`
    expect(parseDsmlToolCalls(truncated)).toEqual([])
  })
})

describe('DsmlContentExtractor：坏形态不得让内容凭空消失', () => {
  it('⑭ 真实会话样本（calls 别名 + invoke/parameter 带空格）整帧可解析', () => {
    const ex = new DsmlContentExtractor()
    const r = ex.feed(REAL_SESSION_BLOCK)
    expect(r.toolCalls.map((c) => c.name)).toEqual(['pwsh', 'grep'])
    expect(r.toolCalls[0].arguments).toContain('git log --oneline -1')
    expect(r.toolCalls[1].arguments).toContain('aggregate')
    // 标签与残片都不得泄漏进正文
    expect(r.text).toBe('')
  })

  it('⑮ 真实会话样本**逐字符拆帧**仍解析（最苛刻切分）', () => {
    const ex = new DsmlContentExtractor()
    let calls = 0
    let text = ''
    for (const ch of REAL_SESSION_BLOCK) {
      const r = ex.feed(ch)
      calls += r.toolCalls.length
      text += r.text
    }
    const f = ex.flush()
    text += f.text + f.reasoning
    expect(calls, '逐字符拆帧下工具调用丢失（这正是用户报障的形态）').toBe(2)
    expect(text, '标签泄漏进正文').toBe('')
  })

  it('⑯ 真实会话样本**二分帧穷举**：任一切分点都不丢调用、不泄漏标签', () => {
    const bad = feedByAllSplits(REAL_SESSION_BLOCK).filter(
      (r) => r.calls !== 2 || r.text !== '',
    )
    expect(
      bad,
      `${bad.length}/${REAL_SESSION_BLOCK.length + 1} 种切法失败`
      + `（切分点: ${bad.slice(0, 20).map((b) => b.cut).join(',')}）`,
    ).toEqual([])
  })

  it('⑰ 零 invoke 的坏块：整块作为正文放行，绝不静默吞掉', () => {
    // ⚠️ 这是「模型很快就结束了，没有原因」的直接根因：旧实现把 []
    //    当解析成功 ⇒ 整块丢弃 ⇒ 用户只看到一句正文 + finish=stop。
    const empty = `${DSML_TOOL_CALLS_OPEN}${DSML_TOOL_CALLS_CLOSE}`
    const ex = new DsmlContentExtractor()
    const r = ex.feed(empty)
    expect(r.toolCalls).toEqual([])
    expect(r.text, '空块内容凭空消失（用户看不到任何东西）').toBe(DSML_TOOL_CALLS_CLOSE)
  })

  it('⑱ 坏形态（invoke 带空格但无 name）：整块放行而非吞掉', () => {
    const broken = `${DSML_TOOL_CALLS_OPEN}${OPEN} invoke>${OPEN} parameter name="c" string="true">ls${CLOSE} parameter>${CLOSE} invoke>${DSML_TOOL_CALLS_CLOSE}`
    // 期望正文 = 原文去掉开标签，且空白被压掉（feed() 的归一职责）
    const expected = broken
      .slice(DSML_TOOL_CALLS_OPEN.length)
      .replace(`${OPEN} invoke>`, `${OPEN}invoke>`)
      .replace(`${OPEN} parameter`, `${OPEN}parameter`)
      .replace(`${CLOSE} parameter>`, `${CLOSE}parameter>`)
      .replace(`${CLOSE} invoke>`, `${CLOSE}invoke>`)
    for (let cut = 0; cut <= broken.length; cut++) {
      const ex = new DsmlContentExtractor()
      const r1 = ex.feed(broken.slice(0, cut))
      const r2 = ex.feed(broken.slice(cut))
      const f = ex.flush()
      const text = r1.text + r2.text + f.text
      const calls = r1.toolCalls.length + r2.toolCalls.length
      expect(calls, `切分点 ${cut} 不该解析出调用（无 name）`).toBe(0)
      expect(text, `切分点 ${cut} 坏块内容被静默吞掉`).toBe(expected)
    }
  })

  it('⑲ 双竖线坏标记整帧与逐字符都能解析', () => {
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR}tool_calls><${BAR}${BAR}DSML${BAR}${BAR}invoke name="pwsh"><${BAR}${BAR}DSML${BAR}${BAR}parameter name="c" string="true">ls</${BAR}${BAR}DSML${BAR}${BAR}parameter></${BAR}${BAR}DSML${BAR}${BAR}invoke></${BAR}${BAR}DSML${BAR}${BAR}tool_calls>`
    const whole = new DsmlContentExtractor().feed(broken)
    expect(whole.toolCalls).toEqual([{ name: 'pwsh', arguments: JSON.stringify({ c: 'ls' }) }])
    const perChar = new DsmlContentExtractor()
    let calls = 0
    for (const ch of broken) calls += perChar.feed(ch).toolCalls.length
    expect(calls, '逐字符拆帧下双竖线标记解析失败').toBe(1)
  })

  it('⑳ 双竖线 + 多空白别名组合（拆帧穷举）', () => {
    const blank = '  '
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR}${blank}calls><${BAR}${BAR}DSML${BAR}${BAR}${blank}invoke name="pwsh"><${BAR}${BAR}DSML${BAR}${BAR}${blank}parameter name="c" string="true">ls</${BAR}${BAR}DSML${BAR}${BAR}${blank}parameter></${BAR}${BAR}DSML${BAR}${BAR}${blank}invoke></${BAR}${BAR}DSML${BAR}${BAR}${blank}calls>`
    for (let cut = 0; cut <= broken.length; cut++) {
      const ex = new DsmlContentExtractor()
      const r1 = ex.feed(broken.slice(0, cut))
      const r2 = ex.feed(broken.slice(cut))
      const f = ex.flush()
      const calls = r1.toolCalls.length + r2.toolCalls.length
      const text = r1.text + r2.text + f.text
      expect(calls, `切分点 ${cut} 未解析出调用`).toBe(1)
      expect(text, `切分点 ${cut} 标签泄漏`).toBe('')
    }
  })
})

describe('正文里引用协议标签：不得误扣、不得泄漏', () => {
  it('㉑ 正文出现开标签字样时原样放行', () => {
    const text = `正在思考 ${OPEN}invoke 是什么语法，然后继续。`
    for (const split of [1, 2, 3, 5, 7, 11]) {
      const ex = new DsmlContentExtractor()
      let out = ''
      for (let i = 0; i < text.length; i += split) out += ex.feed(text.slice(i, i + split)).text
      out += ex.flush().text
      expect(out, `split=${split} 正文被篡改`).toBe(text)
    }
  })

  it('㉒ 正文出现闭标签字样时原样放行（不得扣进缓冲再泄漏）', () => {
    const text = `协议里写作 ${CLOSE}invoke> 表示结束。`
    for (const split of [1, 2, 3, 5, 7, 11]) {
      const ex = new DsmlContentExtractor()
      let out = ''
      for (let i = 0; i < text.length; i += split) out += ex.feed(text.slice(i, i + split)).text
      out += ex.flush().text
      expect(out, `split=${split} 正文被篡改`).toBe(text)
    }
  })
})

describe('openai-compat 链路：dsmlFix + feed 组合', () => {
  it('㉓ 流式归一后再进提取器，多空白别名不泄漏（二分帧穷举）', () => {
    // ⚠️ 这条是 `consumeOpenAiSse` 的真实链路（先 dsmlFix.push 再 feed）。
    //    曾因 isDsmlLabelPrefix 写成 `｜{2,}`（只认双竖线）而漏掉规范单竖线
    //    形态 ⇒ 标签被提前放行 ⇒ 整段当正文（dsml-consume-wiring ⑤ 实测变红）。
    const blanks = ['  ', '\t', '\u3000', '\n', ' '.repeat(40)]
    for (const blank of blanks) {
      const whole = `${OPEN}${blank}calls>${OPEN}invoke name="pwsh">${OPEN}parameter name="c" string="true">ls${CLOSE}parameter>${CLOSE}invoke>${CLOSE}${blank}calls>`
      for (let cut = 0; cut <= whole.length; cut++) {
        const fix = createDsmlMarkerNormalizer()
        const ex = new DsmlContentExtractor()
        let calls = 0
        let leaked = ''
        for (const piece of [whole.slice(0, cut), whole.slice(cut)]) {
          const pushed = fix.push(piece)
          const r = ex.feed(pushed)
          calls += r.toolCalls.length
          leaked += r.text
        }
        const tail = fix.flush()
        const rTail = ex.feed(tail)
        calls += rTail.toolCalls.length
        leaked += rTail.text
        const f = ex.flush()
        leaked += f.text + f.reasoning
        expect(calls, `blank=${JSON.stringify(blank)} 切分点 ${cut} 未解析出调用`).toBe(1)
        expect(leaked, `blank=${JSON.stringify(blank)} 切分点 ${cut} 标签泄漏`).toBe('')
      }
    }
  })
})
