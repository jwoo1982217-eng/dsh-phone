/**
 * `dsml-consume-wiring.spec.ts` —— **行为级**守卫：`consumeOpenAiSse` 的
 * DSML 接线必须真的把正文里的 DSML 块变成结构化 tool-call。
 *
 * ## 为什么必须另立一份（2026-10-13 审计教训）
 *
 * `dsml-parse-roundtrip.spec.ts` 的 ⑥⑦⑧⑨ 是**源码字符串 grep**
 * （`expect(source).toContain('dsmlToolMode')`）—— 它们只能证明
 * 「那行字还在文件里」，**不能证明接线生效**。实测反向验证：
 *
 * | 变异 | 入库用例结果 |
 * |---|---|
 * | 删掉 `if (dsmlExtractor !== undefined) { … }` **整块**（保留构造那行）| **全绿**，只有 ⑨ 靠正则钉住构造行才红 |
 * | 删掉构造行 | ⑨ 红，⑥⑧ 仍绿（注释里就有那两个 token）|
 *
 * 即：**接线零行为守卫**。本文件补上真正喂 SSE 流、断言 chunk 的用例，
 * 并逐条做过反向验证（见每个用例的 `⚠️ 反向验证` 注）。
 */
import { describe, expect, it } from 'vitest'
import { consumeOpenAiSse } from '../../src/openai-compat.js'
import {
  DSML_INVOKE_CLOSE,
  DSML_PARAM_CLOSE,
  DSML_TOOL_CALLS_CLOSE,
  DSML_TOOL_CALLS_OPEN,
} from '../../src/dsml.js'

const P_OPEN = '<\uFF5CDSML\uFF5Cparameter'
const I_OPEN = '<\uFF5CDSML\uFF5Cinvoke'
const INVOKE = `${I_OPEN} name="bash">${P_OPEN} name="command" string="true">ls -la${DSML_PARAM_CLOSE}${DSML_INVOKE_CLOSE}`
const BLOCK = `${DSML_TOOL_CALLS_OPEN}${INVOKE}${DSML_TOOL_CALLS_CLOSE}`

const DONE = 'data: [DONE]\n\n'
function textFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}
function finishFrame(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`
}

async function collect(
  sse: string,
  config: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeOpenAiSse(
    new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    {},
    { label: 'officeace', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000, ...config } as never,
  )) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}
function toolBlocksOf(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return chunks
    .filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
    .map((c) => c.block as Record<string, unknown>)
}
function textOf(chunks: Array<Record<string, unknown>>): string | undefined {
  const e = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'text')
  return e === undefined ? undefined : String((e.block as { text?: string }).text ?? '')
}
function reasoningOf(chunks: Array<Record<string, unknown>>): string | undefined {
  const e = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning')
  return e === undefined ? undefined : String((e.block as { text?: string }).text ?? '')
}
function finishOf(chunks: Array<Record<string, unknown>>): unknown {
  return chunks.find((c) => c.type === 'finish')?.reason
}
/** 块序号集合（用于「孤儿 block-start」判据）。 */
function orphanStarts(chunks: Array<Record<string, unknown>>): number[] {
  const starts = chunks.filter((c) => c.type === 'block-start').map((c) => c.index as number)
  const ends = chunks.filter((c) => c.type === 'block-end').map((c) => c.index as number)
  return starts.filter((i) => !ends.includes(i))
}

describe('consumeOpenAiSse × DSML：接线行为（核心，缺此则「接线零守卫」）', () => {
  it('① dsmlToolMode 开启时，正文里的 DSML 块被解析成 tool-call', async () => {
    // ⚠️ 反向验证：删掉 `if (dsmlExtractor !== undefined) {…}` 整块 → 本用例变红
    //    （实测：tool 块数 1 → 0、正文回吐整段标签）。
    const chunks = await collect(textFrame(`我先看看。${BLOCK}`) + finishFrame('tool_calls') + DONE, {
      dsmlToolMode: true,
    })
    const tools = toolBlocksOf(chunks)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('bash')
    expect(JSON.parse(String(tools[0].arguments))).toEqual({ command: 'ls -la' })
    // 标签不得泄漏进可见正文
    expect(textOf(chunks)).toBe('我先看看。')
    expect(finishOf(chunks)).toEqual({ kind: 'tool-calls' })
  })

  it('② 未开启 dsmlToolMode 时逐字节保持旧行为（不误伤普通通道）', async () => {
    // ⚠️ 反向验证：把 `config.dsmlToolMode === true` 改成恒真 → 本用例变红
    //    （实测：tools 0 → 1、正文不再含标签）。
    const chunks = await collect(textFrame(`我先看看。${BLOCK}`) + finishFrame('stop') + DONE)
    expect(toolBlocksOf(chunks)).toHaveLength(0)
    expect(textOf(chunks)).toBe(`我先看看。${BLOCK}`)
  })

  it('③ 逐字符分帧（最苛刻切分）仍能解析 —— 标签必然跨帧', async () => {
    const sse = [...`我先看看。${BLOCK}`].map((ch) => textFrame(ch)).join('') + finishFrame('tool_calls') + DONE
    const chunks = await collect(sse, { dsmlToolMode: true })
    expect(toolBlocksOf(chunks)).toHaveLength(1)
    expect(textOf(chunks)).toBe('我先看看。')
  })

  it('④ `<｜DSML｜ calls>` 别名端到端可解析（少 tool_ 前缀）', async () => {
    const bad = '<\uFF5CDSML\uFF5C calls>'
    const badClose = '</\uFF5CDSML\uFF5C calls>'
    const chunks = await collect(textFrame(`${bad}${INVOKE}${badClose}`) + finishFrame('tool_calls') + DONE, {
      dsmlToolMode: true,
    })
    expect(toolBlocksOf(chunks)).toHaveLength(1)
  })

  it('⑤ 别名带**多空白**（`\\s*` 的真正覆盖面）拆帧也须解析', async () => {
    // ⚠️ 真实缺陷（2026-10-13 对抗性审计，已实测复现）：别名正则用 `\s*`
    //    允许任意空白，但 `longestOpenPrefixTail` 的保留候选曾是**枚举**
    //    的三个固定串（只含单空格）⇒ `<｜DSML｜  calls>`（两个空格）逐字符
    //    拆帧时标签被**提前放行**，整段当正文、工具永不执行。
    //    `\t` / U+3000 同型。**整帧到达时不复现**，故必须按字符拆帧测。
    //    ⚠️ 空白长度**无上限**（`\s*`），故还须覆盖「长到超出任何固定窗口」
    //    的形态 —— 用固定长度回看窗口的实现会被它绕过。
    const blanks = ['  ', '\t', '\u3000', '\n', ' '.repeat(40)]
    for (const blank of blanks) {
      const open = `<\uFF5CDSML\uFF5C${blank}calls>`
      const close = `</\uFF5CDSML\uFF5C${blank}calls>`
      const whole = `${open}${INVOKE}${close}`
      const sse = [...whole].map((ch) => textFrame(ch)).join('') + finishFrame('tool_calls') + DONE
      const chunks = await collect(sse, { dsmlToolMode: true })
      expect(toolBlocksOf(chunks), `空白=${JSON.stringify(blank)} 未解析出调用`).toHaveLength(1)
      // 标签不得泄漏
      expect(textOf(chunks), `空白=${JSON.stringify(blank)} 标签泄漏`).toBe(undefined)
    }
  })

  it('⑤b 正文通道里**已写完的闭标签**原样留在正文，不被误扣', async () => {
    // ⚠️ 本用例只是**本通道**的完整性对照，**不是** 2026-10-13 那条回归的
    //    主守卫 —— 那条发生在**推理通道**（`llm-adapter.ts` 的
    //    `dsmlReasoningExtractor`），由既有的
    //    `llm-adapter.spec.ts`「does not leak DSML tags from reasoning to
    //    text via visible fallback」锁死（实测：把 `isDsmlLabelPrefix` 改回
    //    接受前导 `/` → 那条**变红**）。此处仅确认正文通道无同型问题。
    const text = '说明如下：</\uFF5CDSML\uFF5Ctool_calls>结尾'
    const sse = [...text].map((ch) => textFrame(ch)).join('') + finishFrame('stop') + DONE
    const chunks = await collect(sse, { dsmlToolMode: true })
    expect(textOf(chunks)).toBe(text)
    expect(toolBlocksOf(chunks)).toHaveLength(0)
  })

  it('⑥ `<thought>` 内容归位到 reasoning，**不得凭空消失**', async () => {
    // ⚠️ 反向验证：删掉 `yield* emitReasoningDelta(extracted.reasoning)` →
    //    本用例变红（实测 reasoning 为 undefined、内容消失）。
    const chunks = await collect(textFrame('<thought>内心独白</thought>正文') + finishFrame('stop') + DONE, {
      dsmlToolMode: true,
    })
    expect(reasoningOf(chunks)).toBe('内心独白')
    expect(textOf(chunks)).toBe('正文')
  })

  it('⑦ `<thought>` 未闭合（截断）时内容仍须放行，不得整段消失', async () => {
    // ⚠️ 真实缺陷：`flush()` 以 `reasoning` 返回残留，旧实现只放行 `text`
    //    ⇒ 整段回复**凭空消失**（用户看到空响应）。
    const chunks = await collect(textFrame('<thought>未闭合的独白') + finishFrame('stop') + DONE, {
      dsmlToolMode: true,
    })
    expect(reasoningOf(chunks)).toBe('未闭合的独白')
  })

  it('⑧ 正文死循环命中后到达的 DSML 调用**仍须执行**（与标准 tool_calls 同策）', async () => {
    // ⚠️⚠️ **真缺陷**（2026-10-13 对抗性审计实测）：DSML 解析曾被放在
    //    `if (!proseLoopDetected)` **内部**，而标准 `delta?.tool_calls` 在
    //    外部 —— 命中正文循环后 DSML 调用被**整体丢弃**（tools=0、无报错），
    //    与文件自身注释「工具调用在循环正文之后到达且有效」直接矛盾。
    //    对照组：同一场景下标准 tool_calls 能照常执行。
    const units = ['让me.\n\n', 'Let me.\n\n', 'Let me grep.\n\n', '让me check.\n\n']
    let loop = ''
    let i = 0
    while (loop.length < 6000) loop += units[i++ % units.length]
    const sse = textFrame(loop) + textFrame(BLOCK) + finishFrame('tool_calls') + DONE
    const chunks = await collect(sse, { dsmlToolMode: true })
    // ⚠️ 反向验证：把 DSML 解析移回 `if (!proseLoopDetected)` 内 → 本用例变红
    //    （实测 tools 1 → 0，且 finish 从 tool-calls 退化为 max-tokens）。
    expect(toolBlocksOf(chunks)).toHaveLength(1)
    expect(finishOf(chunks)).toEqual({ kind: 'tool-calls' })
  })

  it('⑨ 纯 DSML 响应不得留下孤儿 `block-start(text)`（空块污染会话）', async () => {
    // ⚠️ 真实缺陷：旧实现先无条件建 text 块再解析，纯 DSML 响应于是留下
    //    只有 `block-start` 没有 `block-end` 的 text 块，宿主
    //    `BlockAssembler` 会用 `partial.text`（空串）组装成空块。
    const chunks = await collect(textFrame(BLOCK) + finishFrame('tool_calls') + DONE, { dsmlToolMode: true })
    expect(toolBlocksOf(chunks)).toHaveLength(1)
    expect(orphanStarts(chunks)).toEqual([])
    expect(textOf(chunks)).toBe(undefined)
  })

  it('⑩ 上游不合规的 `index:-1` 不得与 DSML 的负数下标撞车', async () => {
    // ⚠️ 真实缺陷：DSML 用 -1/-2… 做 Map 键，上游真发 `{index:-1}` 时会撞
    //    同一个键 ⇒ callId 被覆盖、参数被拼成 `{…}{…}` 非法 JSON ⇒
    //    `isTruncatedArguments` 判真 ⇒ 误报 max-tokens 触发重试。
    const upstream = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: -1, id: 'call_neg', function: { name: 'read', arguments: '{"file_path":"a.txt"}' } }] } }],
    })}\n\n`
    const chunks = await collect(textFrame(BLOCK) + upstream + finishFrame('tool_calls') + DONE, {
      dsmlToolMode: true,
    })
    const tools = toolBlocksOf(chunks)
    // 两个调用都必须**各自独立、参数各自完整**
    expect(tools).toHaveLength(2)
    const args = tools.map((t) => String(t.arguments))
    expect(args.some((a) => a === '{"command":"ls -la"}')).toBe(true)
    expect(args.some((a) => a === '{"file_path":"a.txt"}')).toBe(true)
    // 不得出现两段拼在一起的非法 JSON
    for (const a of args) expect(a).not.toContain('}{')
  })

  it('⑪ 名字不可用的 DSML 调用一个 chunk 都不发（不污染会话）', async () => {
    const badInvoke = `${I_OPEN} name="">${P_OPEN} name="command" string="true">ls${DSML_PARAM_CLOSE}${DSML_INVOKE_CLOSE}`
    const chunks = await collect(
      textFrame(`${DSML_TOOL_CALLS_OPEN}${badInvoke}${DSML_TOOL_CALLS_CLOSE}`) + finishFrame('stop') + DONE,
      { dsmlToolMode: true },
    )
    expect(toolBlocksOf(chunks)).toHaveLength(0)
    // 本步否则会以 `stop` 静默收场 ⇒ 必须报 max-tokens 让 harness 重试
    expect(finishOf(chunks)).toEqual({ kind: 'max-tokens' })
  })
})
