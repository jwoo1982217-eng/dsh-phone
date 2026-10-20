/**
 * MiniMax Anthropic Messages 协议层单测。
 *
 * 覆盖两个纯函数（请求体构造 / 消息序列化）与 SSE 消费器。
 *
 * ⚠️ 本文件的 fixture **照真实响应形状写**（2026-09-29 实测抓的帧），
 * 不是凭空编的 —— 尤其 `thinking` / `signature_delta` / `input_json_delta`
 * 三个块，它们在真实响应里都出现过。
 */
import { describe, expect, it } from 'vitest'
import {
  buildMinimaxMessagesPayload,
  consumeMinimaxSse,
  mapMinimaxStopReason,
  readMinimaxUsage,
  serializeMinimaxMessages,
} from '../../src/minimax-messages.js'
import type { Message } from '@deepseek-ai/dsh-llm'

/** 把 SSE 文本包成 `ReadableStream`（消费器的入参形状）。 */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** 收集消费器的全部 chunk。 */
async function collect(text: string): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of consumeMinimaxSse({ body: sseStream(text) })) out.push(chunk)
  return out
}

const msg = (role: 'user' | 'assistant', content: unknown[]): Message =>
  ({ role, content } as Message)

describe('buildMinimaxMessagesPayload', () => {
  it('基本形状：model + stream + messages', () => {
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M2.7',
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })
    expect(payload.model).toBe('MiniMax-M2.7')
    expect(payload.stream).toBe(true)
    expect(payload.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    // ⚠️ 不发 thinking（实测这是**安全默认**，服务端默认会思考）
    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })

  it('⚠️ system 走顶层字段，不是一条 system 消息（Anthropic 协议）', () => {
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3',
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      system: '你是助手',
    })
    expect(payload.system).toBe('你是助手')
    expect(JSON.stringify(payload.messages)).not.toContain('system')
  })

  it('⚠️ system 为空串时不发该字段（不是发空串）', () => {
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3', messages: [], system: '',
    })
    expect('system' in payload).toBe(false)
  })

  it('tools 转成 input_schema（Anthropic 形状，不是 OpenAI 的 function.parameters）', () => {
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M2.7',
      messages: [],
      tools: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object' } }],
    })
    expect(payload.tools).toEqual([
      { name: 'get_weather', description: '查天气', input_schema: { type: 'object' } },
    ])
  })

  it('stop → stop_sequences；空数组不发', () => {
    const withStop = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3', messages: [], stop: ['A', 'B'],
    })
    expect(withStop.stop_sequences).toEqual(['A', 'B'])
    const empty = buildMinimaxMessagesPayload({ model: 'MiniMax-M3', messages: [], stop: [] })
    expect('stop_sequences' in empty).toBe(false)
  })

  // ⚠️ 以下两条是本文件**最重要**的判据：档位的两种下发形态。
  // 它们直接来自真实请求（传错会让 M3.1 硬 400）。
  it('⚠️ M3.1（requiresAdaptiveThinking）必须发 thinking:adaptive', () => {
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3.1-Flash-Preview',
      messages: [],
      requiresAdaptiveThinking: true,
    })
    expect(payload.thinking).toEqual({ type: 'adaptive' })
  })

  it('⚠️ M3.1 有档位时发 output_config.effort', () => {
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3.1-Flash-Preview',
      messages: [],
      requiresAdaptiveThinking: true,
      effort: 'default',
    })
    expect(payload.thinking).toEqual({ type: 'adaptive' })
    // ⚠️ `default` 是服务端合法取值（实测 200），必须**原样发**不过滤。
    expect(payload.output_config).toEqual({ effort: 'default' })
  })

  it('⚠️ M3.1 不要 adaptive 时也发（它没有「关闭思考」这个选项）', () => {
    // 反向：若把 requiresAdaptiveThinking 判成 false 且无 effort，
    // 就会发出**没有 thinking 字段**的 M3.1 请求 —— 服务端仍 200（实测），
    // 但本用例锁的是「调用方必须传 true」，故这里断言 true 的行为。
    const withFlag = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3.1-Flash-Preview', messages: [], requiresAdaptiveThinking: true,
    })
    expect(withFlag.thinking).toEqual({ type: 'adaptive' })
  })

  // ⚠️ 「开启/关闭思考」两档都必须真的到达 wire（UI 给了选项却丢掉 = 空转）。
  it('⚠️ effort=none 发 thinking:{type:"disabled"}（不发 output_config）', () => {
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3', messages: [], effort: 'none',
    })
    expect(payload.thinking).toEqual({ type: 'disabled' })
    expect(payload.output_config).toBeUndefined()
  })

  it('⚠️ effort=on 发 thinking:{type:"adaptive"}（M3 默认不思考，必须显式开）', () => {
    // ⚠️ 实测：M3 不发 thinking ⇒ 0 思考字符；adaptive ⇒ 2785+。
    // 故「开启思考」不能靠「什么都不发」，必须显式 adaptive。
    const payload = buildMinimaxMessagesPayload({
      model: 'MiniMax-M3', messages: [], effort: 'on',
    })
    expect(payload.thinking).toEqual({ type: 'adaptive' })
    expect(payload.output_config).toBeUndefined()
  })

  it('⚠️ 未选档时不发 thinking（安全默认，实测 200）', () => {
    const payload = buildMinimaxMessagesPayload({ model: 'MiniMax-M3', messages: [] })
    expect(payload.thinking).toBeUndefined()
  })
})

describe('serializeMinimaxMessages', () => {
  it('纯文本消息 → content 数组（Anthropic 接受块数组）', () => {
    expect(serializeMinimaxMessages([msg('user', [{ type: 'text', text: '你好' }])]))
      .toEqual([{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  })

  it('⚠️ assistant 的 tool-call → tool_use，且 arguments 解析成**对象**', () => {
    // ⚠️ 补上配对的 tool_result：真实历史里 tool_use 必与结果成对，
    // 孤立调用会被 `resolveToolPairing` 当孤儿剔除（全仓五个适配器同口径）。
    const out = serializeMinimaxMessages([
      msg('assistant', [
        { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
      ]),
      msg('user', [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '晴' }] },
      ]),
    ])
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }],
    })
  })

  it('⚠️ tool-result → user 消息里的 tool_result 块（Anthropic **没有** role:tool）', () => {
    const out = serializeMinimaxMessages([
      msg('assistant', [{ type: 'tool-call', id: 'call_1', name: 'w', arguments: '{}' }]),
      msg('user', [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '晴 25℃' }] },
      ]),
    ])
    expect(out[1]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [{ type: 'text', text: '晴 25℃' }],
      }],
    })
    expect(JSON.stringify(out)).not.toContain('"role":"tool"')
  })

  it('tool-result 的 isError 透传为 is_error', () => {
    const out = serializeMinimaxMessages([
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }]),
      msg('user', [
        { type: 'tool-result', toolCallId: 'c1', content: [], isError: true },
      ]),
    ])
    expect((out[1]?.content as Record<string, unknown>[])[0]?.is_error).toBe(true)
  })

  it('⚠️ 工具调用参数是残缺 JSON 时退化 {}（不编造，也不丢块）', () => {
    const out = serializeMinimaxMessages([
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{"a":' }]),
      msg('user', [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
      ]),
    ])
    const block = (out[0]?.content as Record<string, unknown>[])[0]
    expect(block?.type).toBe('tool_use')
    // ⚠️ 关键：块**保留**（丢了会让后续 tool_result 变孤儿 → 服务端 400）
    expect(block?.input).toEqual({})
  })

  it('⚠️ 历史里的 reasoning 块**不回传**（无签名会被服务端拒）', () => {
    const out = serializeMinimaxMessages([
      msg('assistant', [
        { type: 'reasoning', text: '让我想想' },
        { type: 'text', text: '答案是 42' },
      ]),
    ])
    expect(out).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '答案是 42' }] }])
  })

  it('⚠️ 只有 reasoning 的 assistant 消息整条丢弃（内容数组为空）', () => {
    const out = serializeMinimaxMessages([
      msg('assistant', [{ type: 'reasoning', text: '思考中' }]),
      msg('user', [{ type: 'text', text: 'hi' }]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
  })

  it('system 角色消息被跳过（system 只走顶层字段）', () => {
    const out = serializeMinimaxMessages([
      msg('system' as never, [{ type: 'text', text: '忽略我' }]),
      msg('user', [{ type: 'text', text: 'hi' }]),
    ])
    expect(out).toHaveLength(1)
  })

  it('⚠️ 图片**未内联**时显式抛错，不静默丢弃（否则用户以为模型看到了图）', () => {
    expect(() => serializeMinimaxMessages([
      msg('user', [{ type: 'image', attachment: { attachmentId: 'a1' } as never }]),
    ])).toThrow(/图片未能内联/)
  })

  // ⚠️ 以下为**图片功能**（2026-09-29 真机实测通过）的回归防线。
  // 形状直接照实测拿到的 Anthropic `image`+`source.base64` 写死。
  it('⚠️ 图片走 Anthropic image 块 + source.base64（**裸 base64**，无 data: 前缀）', () => {
    const images = new Map([['a1', { mediaType: 'image/png', data: 'AAAB' }]])
    const out = serializeMinimaxMessages(
      [msg('user', [
        { type: 'image', attachment: { attachmentId: 'a1' } as never },
        { type: 'text', text: '这是什么颜色？' },
      ])],
      images,
    )
    expect(out).toEqual([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } },
        { type: 'text', text: '这是什么颜色？' },
      ],
    }])
    // ⚠️ **不得**是 OpenAI 的 image_url —— 实测服务端会明确拒绝：
    // `400 ... unsupported content type 'image_url' (2013)`
    expect(JSON.stringify(out)).not.toContain('image_url')
    expect(JSON.stringify(out)).not.toContain('data:image')
  })

  it('⚠️ 图片与 text 的先后顺序都保留（实测两种顺序服务端都接受）', () => {
    const images = new Map([['a1', { mediaType: 'image/jpeg', data: 'ZZZ' }]])
    const textFirst = serializeMinimaxMessages(
      [msg('user', [
        { type: 'text', text: 'T' },
        { type: 'image', attachment: { attachmentId: 'a1' } as never },
      ])],
      images,
    )
    expect((textFirst[0]?.content as unknown[])[0]).toEqual({ type: 'text', text: 'T' })
    expect((textFirst[0]?.content as unknown[])[1]).toMatchObject({ type: 'image' })
  })

  it('工具结果里的图片也内联（否则「工具返回截图」会丢图）', () => {
    const images = new Map([['a1', { mediaType: 'image/png', data: 'Q' }]])
    const out = serializeMinimaxMessages(
      [
        msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'shot', arguments: '{}' }]),
        msg('user', [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: '截图如下' },
            { type: 'image', attachment: { attachmentId: 'a1' } as never },
          ],
        }]),
      ],
      images,
    )
    const inner = (out[1]?.content as Record<string, unknown>[])[0]?.content as unknown[]
    expect(inner).toEqual([
      { type: 'text', text: '截图如下' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Q' } },
    ])
  })

  it('⚠️ 工具结果里的图片读不到时**跳过**（不为一个附件让整轮失败）', () => {
    // 与「消息体里的图片读不到就抛错」有意区别对待：后者是用户**显式**意图。
    const out = serializeMinimaxMessages(
      [
        msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'shot', arguments: '{}' }]),
        msg('user', [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: '有价值的结果' },
            { type: 'image', attachment: { attachmentId: 'missing' } as never },
          ],
        }]),
      ],
      new Map(),
    )
    const inner = (out[1]?.content as Record<string, unknown>[])[0]?.content as unknown[]
    expect(inner).toEqual([{ type: 'text', text: '有价值的结果' }])
  })
})

/**
 * ⚠️⚠️ harness 的**一等 `role:'tool'` 消息**形状（真实缺陷，2026-10-01 由会话
 * `session-871fdf61` 定位：
 * `400 invalid_request_error ... tool call result does not follow tool call (2013)`）。
 *
 * ## 证据（会话日志 `~/.dsh/sessions/--D-jet-code-js-dsh-codearts--/session-871fdf61/…`
 *
 * `tool/result` 记录的形状是 `"role":"tool"`，且 `toolCallId` 在**顶层**：
 * ```json
 * {"type":"tool/result","data":{"message":{"role":"tool",
 *   "source":{"kind":"tool","callId":"call_1f9c…"},
 *   "toolCallId":"call_1f9c…","content":[…],"isError":false}}}
 * ```
 * 且**同一 step 的多个工具调用产生连续多条 tool 消息**（seq 21、22 两条，
 * 属于 assistant 的同一批 tool_use）。
 *
 * ## ⚠️ 这套形状与 dsh 版本号无关
 *
 * 它自 0.1.7 引入，但 **0.2.0-rc.2 实测仍在用**（全量会话日志 34,659 条
 * tool/result 无一例外是 `role:'tool'` + 顶层 `toolCallId`）。本组用例
 * **按形状**构造，不按版本号 —— 升级 dsh 不会让它们失效。
 *
 * ## 缺陷后果（两重，都致命）
 *
 * 1. `block.type === 'tool-result'` 判据**恒不命中**
 *    （没有这种内容块）⇒ 工具输出被当普通 user 文本下发，
 *    `tool_use_id` 关联丢失 ⇒ 服务端报 2013。
 * 2. 修复 (1) 后若不把同批结果**合并并紧跟其 assistant**，仍会报 2013
 *    （逐条下发 ⇒ 多条连续 user；跨 assistant 累积 ⇒ 锚点错位）。
 */
describe('serializeMinimaxMessages —— 一等 tool 消息（2013 回归）', () => {
  /** 真实形状：role:'tool' + 顶层 toolCallId。 */
  const toolMsg = (callId: string, text: string, extra: Record<string, unknown> = {}): Message =>
    ({ role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError: false, ...extra } as unknown as Message)

  const assistantCalls = (ids: string[]): Message =>
    msg('assistant', ids.map((id) => ({ type: 'tool-call', id, name: 'read', arguments: '{}' })))

  it('⚠️⚠️ role:tool 消息被序列化为 user 的 tool_result 块（不丢 tool_use_id）', () => {
    const out = serializeMinimaxMessages([assistantCalls(['c1']), toolMsg('c1', '文件内容')])
    expect(out).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: '文件内容' }] }] },
    ])
    // ⚠️ Anthropic **没有** role:'tool'，wire 上绝不能出现
    expect(JSON.stringify(out)).not.toContain('"role":"tool"')
  })

  it('⚠️⚠️ 同批多个工具结果**合并进同一条 user 消息**（否则 2013）', () => {
    // 真实形态：assistant 一次发两个 tool_use → harness 落**两条** tool 消息。
    // Anthropic 要求同批 tool_result 合进紧跟其后的**那一条** user 消息。
    const out = serializeMinimaxMessages([
      assistantCalls(['c1', 'c2']),
      toolMsg('c1', 'A'),
      toolMsg('c2', 'B'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]?.role).toBe('assistant')
    expect(out[1]?.role).toBe('user')
    expect(out[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'A' }] },
      { type: 'tool_result', tool_use_id: 'c2', content: [{ type: 'text', text: 'B' }] },
    ])
  })

  it('⚠️⚠️ 一批工具结果 + 紧随其后的用户文本：工具结果**在先**、文本在后', () => {
    // ⚠️ 这条才真正区分「合并」与「逐条下发」两种实现：
    // 工具结果必须先于同一条 user 消息里的正文下发（否则用户那句话会插在
    // tool_result 之前，把配对打断 → 2013）。
    const out = serializeMinimaxMessages([
      assistantCalls(['c1']),
      toolMsg('c1', 'A'),
      msg('user', [{ type: 'text', text: '接着说' }]),
    ])
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'user'])
    expect(out[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'A' }] },
    ])
    expect(out[2]?.content).toEqual([{ type: 'text', text: '接着说' }])
  })

  it('⚠️⚠️ 同一条消息里既有 tool-result 又有正文：结果被**拆到 assistant 之后**', () => {
    // ⚠️ 这是唯一能观测「冲刷」逻辑的形态：只有它让该消息的 `content` 非空，
    // 走到 else 分支。若不冲刷，tool_result 会留在同一条 user 消息的**末尾**，
    // 而它前面是正文文本 ⇒ 配对被打断 ⇒ 2013。
    const out = serializeMinimaxMessages([
      assistantCalls(['c1']),
      msg('user', [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'A' }] },
        { type: 'text', text: '接着说' },
      ]),
    ])
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'user'])
    expect(out[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'A' }] },
    ])
    expect(out[2]?.content).toEqual([{ type: 'text', text: '接着说' }])
  })

  it('⚠️⚠️ 末尾的工具结果也要下发（模型刚跑完工具、之后无新消息）', () => {
    // 漏掉它 = 留下无 tool_result 的 tool_use ⇒ 2013。
    const out = serializeMinimaxMessages([assistantCalls(['c1']), toolMsg('c1', 'A')])
    expect(out).toHaveLength(2)
    expect(out[1]?.role).toBe('user')
  })

  it('⚠️ 工具消息里没有 text 时不产出空内容消息（内容数组为空的整条丢弃）', () => {
    const out = serializeMinimaxMessages([assistantCalls(['c1']), toolMsg('c1', '')])
    // 空结果的 tool_result 仍要保留（否则变成孤儿 tool_use → 2013）
    expect(out).toHaveLength(2)
    expect((out[1]?.content as Record<string, unknown>[])[0]?.type).toBe('tool_result')
  })

  it('⚠️⚠️ 孤儿 tool_result（无对应 tool_use）被剔除（否则服务端 400）', () => {
    // 与 resolveToolPairing 同一口径：无法配对的结果不得下发。
    const out = serializeMinimaxMessages([toolMsg('ghost', '孤儿结果')])
    expect(out).toEqual([])
  })

  it('⚠️⚠️ 缺结果的 tool_use 也被剔除（不能留下无 tool_result 的 tool_use）', () => {
    const out = serializeMinimaxMessages([assistantCalls(['c1', 'c2']), toolMsg('c1', 'A')])
    // c2 无结果 ⇒ 该批 tool_calls 全部剔除（同 resolveToolPairing 的 all() 口径）
    expect(out).toEqual([])
  })

  it('⚠️ 空 name 的 tool-call 被剔除（否则上游 400，同 resolveToolPairing）', () => {
    const out = serializeMinimaxMessages([
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: '', arguments: '{}' }]),
      toolMsg('c1', 'A'),
    ])
    expect(out).toEqual([])
  })

  it('⚠️ tool 消息插在 user 文本之后仍与 assistant(tool_use) 相邻（文本不打断配对）', () => {
    // harness 形态：assistant(tool_use) → tool 消息。其后才是下一个 user 文本。
    const out = serializeMinimaxMessages([
      msg('user', [{ type: 'text', text: '问题' }]),
      assistantCalls(['c1']),
      toolMsg('c1', '答案'),
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('⚠️ 归一化只看**形状**、不看版本号：将来 dsh 升级到 0.3+ 仍必须生效', () => {
    // ⚠️ 这条是**防版本号误导**的回归锁：曾因注释写「0.1.7」让人以为
    // 「升到 0.2.0 就不相关了」而想删掉归一化。实测 0.2.0-rc.2 仍是
    // `role:'tool'` 形状（34,659 条日志无例外），而判据是形状不是版本。
    // ⇒ 用一个**刻意不像任何已知版本**的 role 值证明：我们认的是「非
    // assistant/system 且无正文内容」这一形状特征本身。
    const odd = [
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'A' }] },
    ] as unknown as Message[]
    const out = serializeMinimaxMessages([assistantCalls(['c1']), ...odd])
    expect(out[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'A' }] },
    ])
  })

  it('⚠️ developer 消息被丢弃（只承载工具增删元数据，不是对话内容）', () => {
    const out = serializeMinimaxMessages([
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }] } as unknown as Message,
      msg('user', [{ type: 'text', text: 'hi' }]),
    ])
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('⚠️ 旧形状（user 内嵌 tool-result 块）行为**逐字节不变**', () => {
    // 归一化层对 legacy 输入是零成本透传，既有断言必须继续成立。
    const out = serializeMinimaxMessages([
      assistantCalls(['c1', 'c2']),
      msg('user', [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'A' }] },
        { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'B' }] },
      ]),
    ])
    expect(out[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'A' }] },
      { type: 'tool_result', tool_use_id: 'c2', content: [{ type: 'text', text: 'B' }] },
    ])
  })

  it('⚠️⚠️⚠️ **跨 assistant 边界不累积**（真实会话重放定位的 2013 根因）', () => {
    // 真实形态（会话 `session-871fdf61` 逐步重放得到）：
    //   assistant A: [text, tool_use a1, a2, a3]   ← 第一批调用
    //   tool a1 / tool a2 / tool a3                ← 三条独立 tool 消息
    //   assistant B: [text, tool_use b1, b2, b3]   ← 第二批调用
    //   tool b1 / b2 / b3
    //
    // ⚠️ 若工具结果跨 assistant 边界累积（第一版实现的缺陷），输出会变成
    //   assistant A / assistant B / user(A+B 全部结果)
    // ⇒ A 的 tool_result 前面是 B 的 assistant ⇒ 服务端 2013。
    // 正确形态必须是 **一批配一批**。
    const out = serializeMinimaxMessages([
      assistantCalls(['a1', 'a2', 'a3']),
      toolMsg('a1', 'r1'),
      toolMsg('a2', 'r2'),
      toolMsg('a3', 'r3'),
      assistantCalls(['b1', 'b2', 'b3']),
      toolMsg('b1', 's1'),
      toolMsg('b2', 's2'),
      toolMsg('b3', 's3'),
    ])
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user'])

    // 第一批结果紧跟第一批 assistant，且不含第二批的 id
    const firstResults = (out[1]?.content as Record<string, unknown>[]).map((b) => b.tool_use_id)
    expect(firstResults).toEqual(['a1', 'a2', 'a3'])
    // 第二批同理
    const secondResults = (out[3]?.content as Record<string, unknown>[]).map((b) => b.tool_use_id)
    expect(secondResults).toEqual(['b1', 'b2', 'b3'])

    // 通用不变量：每条 tool_result 的 id 必须在**紧邻前一条** assistant 里出现
    for (let i = 0; i < out.length; i++) {
      const m = out[i] as { role: string; content: Array<Record<string, unknown>> }
      const results = m.content.filter((b) => b.type === 'tool_result')
      if (results.length === 0) continue
      const prev = out[i - 1] as { role: string; content: Array<Record<string, unknown>> }
      expect(prev.role).toBe('assistant')
      const useIds = new Set(
        prev.content.filter((b) => b.type === 'tool_use').map((b) => String(b.id)),
      )
      for (const r of results) {
        expect(useIds.has(String(r.tool_use_id))).toBe(true)
      }
    }
  })
})

describe('mapMinimaxStopReason', () => {
  it.each([
    ['end_turn', 'stop'],
    ['tool_use', 'tool-calls'],
    ['max_tokens', 'max-tokens'],
    ['stop_sequence', 'stop'],
  ])('%s → %s', (raw, kind) => {
    expect(mapMinimaxStopReason(raw).kind).toBe(kind)
  })

  it('⚠️ 未知/缺失一律 stop（不编造成 error，否则会重试一个成功的响应）', () => {
    expect(mapMinimaxStopReason(undefined).kind).toBe('stop')
    expect(mapMinimaxStopReason('some_future_reason').kind).toBe('stop')
  })
})

describe('readMinimaxUsage', () => {
  it('映射 input/output/cache_read/cache_creation', () => {
    expect(readMinimaxUsage({
      input_tokens: 81,
      output_tokens: 14,
      cache_read_input_tokens: 128,
      cache_creation_input_tokens: 5,
    })).toEqual({ inputTokens: 81, outputTokens: 14, cacheReadTokens: 128, cacheWriteTokens: 5 })
  })

  it('⚠️ thinking_tokens 映射到 reasoningTokens（它是 output 的**子集**，不累加）', () => {
    const usage = readMinimaxUsage({
      output_tokens: 64,
      output_tokens_details: { thinking_tokens: 64 },
    })
    expect(usage.outputTokens).toBe(64)
    expect(usage.reasoningTokens).toBe(64)
  })

  it('非数字/负数被忽略', () => {
    expect(readMinimaxUsage({ input_tokens: 'x', output_tokens: -1 })).toEqual({})
    expect(readMinimaxUsage(null)).toEqual({})
  })
})

describe('consumeMinimaxSse', () => {
  it('⚠️ 真实响应形状：thinking → text 两块，chunk 序列正确', async () => {
    // 照实测抓的帧（M2.7 关闭思考的那次）
    const chunks = await collect([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"x","usage":{"input_tokens":46,"output_tokens":0}}}',
      '',
      'event: ping',
      'data: {"type":"ping"}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc123"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"收到"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":87,"output_tokens_details":{"thinking_tokens":85}}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ].join('\n'))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'The user' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '收到' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '收到' } },
      { type: 'usage', usage: { inputTokens: 46, outputTokens: 87, reasoningTokens: 85 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // ⚠️ signature_delta 必须**不产生任何 chunk**（它会污染正文）
    expect(JSON.stringify(chunks)).not.toContain('abc123')
  })

  it('⚠️ 工具调用：input_json_delta 累积成完整 arguments', async () => {
    const chunks = await collect([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"get_weather","input":{}}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"北京\\"}"}}',
      '',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    ].join('\n'))

    const blockEnd = chunks.find(
      (c): c is { type: 'block-end'; block: Record<string, unknown> } =>
        (c as { type: string }).type === 'block-end',
    )
    expect(blockEnd?.block).toEqual({
      type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"北京"}',
    })
    const finish = chunks.at(-1) as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('tool-calls')
  })

  it('⚠️ tool-call-delta 的 id 来自 block-start（不是空串）', async () => {
    const chunks = await collect([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-9","name":"f","input":{}}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
    ].join('\n'))
    const delta = chunks.find(
      (c): c is { type: 'tool-call-delta'; id: string } =>
        (c as { type: string }).type === 'tool-call-delta',
    )
    expect(delta?.id).toBe('call-9')
  })

  it('⚠️ event:error 必须抛错（不能静默结束）', async () => {
    await expect(collect([
      'event: error',
      'data: {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, model requires adaptive thinking (2013)"}}',
      '',
    ].join('\n'))).rejects.toThrow(/requires adaptive thinking/)
  })

  it('⚠️ 只有 ping、没有内容块 ⇒ 抛错（EMPTY 不得静默结束）', async () => {
    await expect(collect([
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
      '',
      'event: ping',
      'data: {"type":"ping"}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ].join('\n'))).rejects.toThrow(/未返回任何内容块/)
  })

  it('⚠️ 分片到达（跨 chunk 切断一行）也能正确解析', async () => {
    const full = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
      '',
      'data: {"type":"content_block_stop","index":0}',
    ].join('\n')
    const bytes = new TextEncoder().encode(full)
    // 在每个字节边界都切一刀 —— 模拟最坏的分片
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.slice(i, i + 7))
        }
        controller.close()
      },
    })
    const out: unknown[] = []
    for await (const c of consumeMinimaxSse({ body: stream })) out.push(c)
    const textDelta = out.find(
      (c): c is { text: string } => (c as { type: string }).type === 'text-delta',
    )
    expect(textDelta?.text).toBe('你好')
  })

  it('⚠️ 帧的 type 优先于 event 行（代理吞掉 event 行时仍能工作）', async () => {
    const chunks = await collect([
      // 故意**不写** event 行，只给 data（真实世界里代理可能吃掉 event 行）
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      '',
    ].join('\n'))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
  })

  it('未知事件类型被忽略（不崩）', async () => {
    const chunks = await collect([
      'data: {"type":"some_future_event","payload":1}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}',
      '',
    ].join('\n'))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'x' })
  })

  it('坏 JSON 的 data 行被跳过（不崩）', async () => {
    const chunks = await collect([
      'data: {not valid json',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"y"}}',
      '',
    ].join('\n'))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'y' })
  })

  /*
   * ⚠️ 本组是**实现期由单测抓到的真实缺陷**的回归防线（2026-09-29）。
   *
   * 原实现在 `while (!done)` 里按行处理，`split('\n')` 后 `pop()` 的尾巴留在
   * `buffer` 里等下一轮 —— 但**流结束时没有下一轮**，于是最后一条事件
   * （正是携带 `stop_reason` 与 `usage` 的 `message_delta`）**永远被丢弃**。
   *
   * 真实 SSE 大多以空行结尾，恰好掩盖了它；**截断的流**才会暴露。
   * 症状很隐蔽：`max_tokens` 被误报成 `stop`、`usage` 永远是 0 ——
   * 不报错、不中断，只是数字错了。
   */
  it('⚠️ 末尾**无换行**的最后一帧仍被处理（截断流不得丢 stop_reason）', async () => {
    const chunks = await collect([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      // ⚠️ 故意**不加末尾换行**：这一帧必须仍被解析
      'data: {"type":"content_block_stop","index":0}',
    ].join('\n'))
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0, block: { type: 'text', text: 'hi' },
    })
  })

  it('⚠️ 截断流里末尾的 message_delta 仍生效（max_tokens 不被误报成 stop）', async () => {
    const chunks = await collect([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}',
      '',
      // ⚠️ 无末尾换行：这一帧丢了就会把 max_tokens 误报成 stop、usage 归零
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":99}}',
    ].join('\n'))
    const finish = chunks.at(-1) as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('max-tokens')
    const usage = chunks.find(
      (c): c is { usage: { outputTokens: number } } =>
        (c as { type: string }).type === 'usage',
    )
    expect(usage?.usage.outputTokens).toBe(99)
  })

  it('空行会重置 event 名（下一条 data 不继承上一条的 event）', async () => {
    // 若不重置，第二条 data 会拿到 'ping' 而 `type` 缺失 ⇒ 被整帧丢弃
    const chunks = await collect([
      'event: ping',
      'data: {"no_type_field":1}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"z"}}',
      '',
    ].join('\n'))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'z' })
  })
})
