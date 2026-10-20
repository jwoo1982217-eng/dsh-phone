/**
 * **正文**（text 通道）死循环守卫的回归测试。
 *
 * ## 真实缺陷（用户报障，2026-09-25）
 *
 * 唯一活动 session（`lilishop-go`，`workbuddy/hy4-preview-f`）出现**正文**循环。
 * 排查确认：
 *
 * - 现有守卫（`createReasoningLoopDetector`）在**全部 6 个落点只喂 reasoning
 *   增量**，正文分支从不调用 `observe` → 正文循环**完全看不见**；
 * - 不是「循环不够长」：用**真实检测器**回放该会话正文，三段全部命中 ——
 *
 *   | seq | 正文长度 | 非空行 | 去重行 | 去重率 | 检测器 |
 *   |---|---|---|---|---|---|
 *   | 34752 | 4,641 | 486 | 20 | 0.0412 | HIT，cutAt=752 |
 *   | 34768 | 8,875 | 416 | 39 | 0.0938 | HIT，cutAt=880 |
 *   | 34823 | 34,406 | 2,711 | 473 | 0.1745 | HIT，cutAt=3256 |
 *
 *   阈值是「去重率 < 0.35 且持续 ≥ 2000 字符」，三段全部大幅达标。
 *
 * ## 为什么不能照搬思考守卫的 `cancel()`
 *
 * ⚠️ **这是本次实现最关键的一条约束。** 思考死循环时模型**不产出工具调用**
 * （思考停不下来 = 正文零产出），故命中即可 `reader.cancel()` 止损。
 *
 * 但正文循环**不一样**：实测三段的 wire 帧顺序恒为
 *
 * ```
 * block-start(text) → text-chunks(循环正文) → block-start(tool-call)
 *   → tool-call-chunks → usage → block-end(tool-call) → block-end(text) → finish
 * ```
 *
 * 即**工具调用在循环正文之后才到达**，且三段都是 `finish: tool-calls` ——
 * 模型最终仍产出了有效调用、任务能继续。若在文本循环命中时立即 `cancel()`，
 * 会把这些**有效的工具调用整块丢掉**，把一个「能继续的任务」变成
 * 「什么都不做就结束」—— 比循环本身更糟。
 *
 * 故正文守卫的语义是：**只截断重复正文，绝不中止上游、绝不丢弃工具调用**。
 */
import { describe, expect, it } from 'vitest'
import { consumeOpenAiSse } from '../../src/openai-compat.js'

/** 构造 OpenAI SSE 帧：正文增量。 */
function textFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

/** 构造 OpenAI SSE 帧：工具调用增量。 */
function toolFrame(name: string, args: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: args } }] } }],
  })}\n\n`
}

/** 与 `reasoning-loop.txt` 同型的正文循环体：极低去重率的重复短行。 */
function proseLoop(chars: number): string {
  const units = ['让me.\n\n', 'Let me.\n\n', 'Let me grep.\n\n', '让me check.\n\n']
  let out = ''
  let i = 0
  while (out.length < chars) { out += units[i++ % units.length] }
  return out
}

/** 收集全部 chunk。 */
async function collect(sse: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeOpenAiSse(
    new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    {},
    { label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000 },
  )) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

/** 取最终正文块文本。 */
function textBlockOf(chunks: Array<Record<string, unknown>>): string | undefined {
  const end = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'text')
  return end === undefined ? undefined : String((end.block as { text?: string }).text ?? '')
}

/** 取全部工具调用块。 */
function toolBlocksOf(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return chunks
    .filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
    .map((c) => c.block as Record<string, unknown>)
}

describe('正文死循环守卫', () => {
  it('正文循环被截断，只保留循环前的干净前缀', async () => {
    const loop = proseLoop(20_000)
    const sse = textFrame('开始做正事。\n\n') + textFrame(loop)
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    const text = textBlockOf(chunks)
    expect(text).toBeDefined()
    // 必须明显短于喂入量（截断生效）。
    expect(text!.length).toBeLessThan(loop.length / 2)
    // 且保留了循环前的干净前缀。
    expect(text!.startsWith('开始做正事。')).toBe(true)
  })

  // ⚠️ 本文件最核心的一条：正文循环命中时**不得丢弃工具调用**。
  // 实测三段的 wire 顺序是「循环正文 → 工具调用」，照搬思考守卫的
  // `reader.cancel()` 会把有效调用整块丢掉。
  it('正文循环命中后仍完整保留其后的工具调用（不得中止上游）', async () => {
    const loop = proseLoop(20_000)
    const sse = textFrame('开始做正事。\n\n') + textFrame(loop)
      + toolFrame('grep', '{"pattern":"ValidateGoodsOperationFromMaps","path":"internal"}')
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    const tools = toolBlocksOf(chunks)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('grep')
    // ⚠️ `arguments` 是**裁剪后的 JSON 字符串**（不是对象）—— 与
    // `normalizeToolArguments` 的契约一致，见 qoder-adapter.spec.ts:358。
    expect(tools[0].arguments).toBe('{"pattern":"ValidateGoodsOperationFromMaps","path":"internal"}')
    // finish 仍须是 tool-calls —— 调用可用，任务能继续。
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('正常长正文零误报（代码块 / 列表 / 表格）', async () => {
    const normal = [
      '# 实施计划\n\n',
      '## 第 1 节 目标\n\n本文说明重构范围与验收标准，覆盖库存、订单与商品三个模块。\n\n',
      '```go\nfunc main() {\n\tfmt.Println("hello")\n}\n```\n\n',
      '| 模块 | 状态 | 负责人 |\n|---|---|---|\n| 库存 | 进行中 | 甲 |\n| 订单 | 待开始 | 乙 |\n\n',
      '- 第一项说明\n- 第二项说明\n- 第三项说明\n\n',
      '## 第 2 节 风险\n\n并发写入需要加锁；跨表事务需确认隔离级别。\n\n',
    ].join('')
    const sse = textFrame(normal)
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    // 完整保留、逐字节一致。
    expect(textBlockOf(chunks)).toBe(normal)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('开关关闭时不干预正文（行为与现状一致）', async () => {
    process.env.DSH_REASONING_LOOP_GUARD = '0'
    try {
      const loop = proseLoop(20_000)
      const sse = textFrame(loop)
        + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
        + 'data: [DONE]\n\n'
      const chunks = await collect(sse)
      expect(textBlockOf(chunks)).toBe(loop)
    } finally {
      delete process.env.DSH_REASONING_LOOP_GUARD
    }
  })

  // 思考守卫与正文守卫必须是**两个独立实例**：共用会让两条通道的文本
  // 互相污染同一个 3000 字符窗口，使任一判据的「持续体量」失真。
  it('思考与正文各自独立判定：正文正常时不因思考循环而误截正文', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const reasoningLoop = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'reasoning-loop.txt'), 'utf8')
    const frames: string[] = []
    for (let i = 0; i < reasoningLoop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningLoop.slice(i, i + 256) } }] })}\n\n`)
    }
    // 思考在循环，但正文是一段正常的话。
    const normalText = '这是正常的正文结论，不受思考循环影响。'
    frames.push(textFrame(normalText))
    frames.push('data: [DONE]\n\n')
    const chunks = await collect(frames.join(''))
    // 正文必须完整保留（若两个守卫共用实例，正文会被思考循环的 cutAt 误伤）。
    expect(textBlockOf(chunks)).toBe(normalText)
  })
})

/**
 * `</think:hex>` 泄漏归位（适配器层）。
 *
 * ## 真实缺陷（用户报障，2026-09-25）
 *
 * `workbuddy/hy4-preview-f` 把**思考**写进 `content`（正文）通道，只在思考段
 * 末尾留一个闭标签。实测 155 会话中 28 步如此，且**开标签恒为 0**。
 *
 * 归位后：
 *  - 标签**前**的内心独白 → `reasoning` 块（用户不再看到它冒充正文）；
 *  - 标签**后**的真正文 → `text` 块。
 */
describe('think 标签泄漏归位', () => {
  /** 取最终 reasoning 块文本。 */
  function reasoningBlockOf(chunks: Array<Record<string, unknown>>): string | undefined {
    const end = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning')
    return end === undefined ? undefined : String((end.block as { text?: string }).text ?? '')
  }

  it('标签前归入思考、标签后归入正文', async () => {
    const raw = '让me check callers.\n\n让me grep.\n\n让me verify.</think:6124c78e>让me确认校验函数名并检查其调用者。'
    const sse = textFrame(raw)
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    expect(reasoningBlockOf(chunks)).toBe('让me check callers.\n\n让me grep.\n\n让me verify.')
    expect(textBlockOf(chunks)).toBe('让me确认校验函数名并检查其调用者。')
  })

  it('标签跨帧到达也能归位（不能逐帧判定）', async () => {
    // 闭标签被切在帧中间：`</think:61` + `24c78e>`。
    const sse = textFrame('内心独白。</think:61') + textFrame('24c78e>真正文。')
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    expect(reasoningBlockOf(chunks)).toBe('内心独白。')
    expect(textBlockOf(chunks)).toBe('真正文。')
  })

  it('无标签时正文与思考分块行为完全不变', async () => {
    const sse = textFrame('普通正文。')
      + `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '普通思考。' } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    expect(textBlockOf(chunks)).toBe('普通正文。')
    expect(reasoningBlockOf(chunks)).toBe('普通思考。')
  })

  it('反引号包裹的标签是"引用"而非泄漏：正文保持完整、不产生思考块', async () => {
    const raw = '正文里残留了 `</think:6124c78e>` 闭标签，但开标签 0 个。'
    const sse = textFrame(raw)
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    expect(textBlockOf(chunks)).toBe(raw)
    expect(reasoningBlockOf(chunks)).toBeUndefined()
  })

  it('标签与结构化思考同时存在时不丢内容（思考段并入既有 reasoning 块）', async () => {
    // 实测有 3 步同时具备两者（workbuddy/deepseek-v4.1-flash）。
    const sse = textFrame('泄漏的独白。</think:6124c78e>真正文。')
      + `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '结构化思考。' } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await collect(sse)
    const reasoning = reasoningBlockOf(chunks)
    // 两段都必须在（顺序：结构化思考在前、泄漏段在后，与到达顺序一致）。
    expect(reasoning).toContain('结构化思考。')
    expect(reasoning).toContain('泄漏的独白。')
    expect(textBlockOf(chunks)).toBe('真正文。')
  })
})
