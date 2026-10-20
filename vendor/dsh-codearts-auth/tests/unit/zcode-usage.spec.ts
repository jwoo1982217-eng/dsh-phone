/**
 * ZCode **usage / finish 解析**的回归测试。
 *
 * ## 守的是用户报障的真实缺陷
 *
 * 「对话下面只显示 x 轮 y 步，后面没有 tps、token 用量、缓存命中、
 * 上下文窗口占用」—— 根因是我在 `consumeAnthropicSse` 里**显式忽略了**
 * `message_start` / `message_delta`，而 Anthropic 的 usage 正分在这两处：
 *
 * | 事件 | 携带 |
 * |---|---|
 * | `message_start` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
 * | `message_delta` | `output_tokens` + `stop_reason` |
 *
 * ⇒ **只读一处必然缺字段**（早读没 output、晚读没 input）。
 * 本文件的用例之一专门守这一点。
 *
 * 同理 `finish` 也完全没发 —— DSH 无法区分「答完了」/「被截断」/「去调工具」。
 */
import { describe, expect, it } from 'vitest'
import { consumeAnthropicSse } from '../../src/zcode-anthropic.js'

/** 把若干 SSE 帧包成 ReadableStream。 */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const text = frames.join('\n\n') + '\n\n'
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** 一次最小可用的响应（有正文，故不会触发 EMPTY_RESPONSE）。 */
function framesWith(options: {
  usageStart?: Record<string, unknown>
  usageDelta?: Record<string, unknown>
  stopReason?: string
  text?: string
}): string[] {
  const frames: string[] = [
    'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: 'm1', type: 'message', role: 'assistant',
        ...options.usageStart !== undefined ? { usage: options.usageStart } : {},
      },
    }),
    'event: content_block_start\ndata: ' + JSON.stringify({
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }),
    'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: options.text ?? '你好' },
    }),
    'event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }),
  ]
  if (options.usageDelta !== undefined || options.stopReason !== undefined) {
    frames.push('event: message_delta\ndata: ' + JSON.stringify({
      type: 'message_delta',
      ...options.usageDelta !== undefined ? { usage: options.usageDelta } : {},
      delta: { stop_reason: options.stopReason ?? 'end_turn' },
    }))
  }
  frames.push('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }))
  return frames
}

/** 跑一遍，收集 chunk。 */
async function collect(frames: string[]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeAnthropicSse(sseStream(frames), { label: 'zcode', model: 'GLM-5.3-Flash' })) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('ZCode usage 解析（用户报障：没有 token / 缓存 / 上下文指标）', () => {
  it('★ 两处 usage 都要读：input 在 message_start、output 在 message_delta', async () => {
    const chunks = await collect(framesWith({
      usageStart: { input_tokens: 784, cache_read_input_tokens: 0, cache_creation_input_tokens: 12 },
      usageDelta: { output_tokens: 116 },
      stopReason: 'end_turn',
    }))
    const usage = chunks.find((c) => c.type === 'usage')?.usage as Record<string, number> | undefined
    expect(usage).toBeDefined()
    // ★ 这一条是关键：只读一处会缺其中一个。
    expect(usage?.inputTokens).toBe(784)
    expect(usage?.outputTokens).toBe(116)
    expect(usage?.totalTokens).toBe(784 + 116 + 0 + 12)
    expect(usage?.cacheReadTokens).toBe(0)
    expect(usage?.cacheWriteTokens).toBe(12)
  })

  it('★ 后到的 message_delta 不得冲掉先到的 input_tokens', async () => {
    // message_delta 只带 output_tokens —— 若实现用直接赋值，input 会变 undefined。
    const chunks = await collect(framesWith({
      usageStart: { input_tokens: 500 },
      usageDelta: { output_tokens: 20 },
    }))
    const usage = chunks.find((c) => c.type === 'usage')?.usage as Record<string, number> | undefined
    expect(usage?.inputTokens).toBe(500)
    expect(usage?.outputTokens).toBe(20)
  })

  it('只有 message_start（无 message_delta）时也发 usage', async () => {
    const chunks = await collect(framesWith({ usageStart: { input_tokens: 300 } }))
    const usage = chunks.find((c) => c.type === 'usage')?.usage as Record<string, number> | undefined
    expect(usage?.inputTokens).toBe(300)
    // outputTokens 是必填字段 —— 缺失时兜 0（但只要有一个数就发）。
    expect(usage?.outputTokens).toBe(0)
  })

  it('★ 完全没有 usage 时不发 usage chunk（不显示成 0）', async () => {
    const chunks = await collect(framesWith({}))
    // 全 undefined 的 usage 会让 UI 显示 0 而不是「无数据」—— 那更误导。
    expect(chunks.find((c) => c.type === 'usage')).toBeUndefined()
  })

  it('缓存字段缺失时不产生该键（不伪装成 0）', async () => {
    const chunks = await collect(framesWith({
      usageStart: { input_tokens: 100 },
      usageDelta: { output_tokens: 10 },
    }))
    const usage = chunks.find((c) => c.type === 'usage')?.usage as Record<string, unknown>
    expect(usage).not.toHaveProperty('cacheReadTokens')
    expect(usage).not.toHaveProperty('cacheWriteTokens')
  })

  it('usage 的字段名与 Anthropic 一致（cache_read / cache_creation）', async () => {
    // ⚠ 用官方的字段名，别照 OpenAI 的 prompt_tokens_details 猜。
    const chunks = await collect(framesWith({
      usageStart: { input_tokens: 10, cache_read_input_tokens: 99, cache_creation_input_tokens: 7 },
      usageDelta: { output_tokens: 5 },
    }))
    const usage = chunks.find((c) => c.type === 'usage')?.usage as Record<string, number>
    expect(usage.cacheReadTokens).toBe(99)
    expect(usage.cacheWriteTokens).toBe(7)
  })

  it('★ 缓存命中部分不计入 inputTokens（否则命中率显示偏大）', async () => {
    const chunks = await collect(framesWith({
      usageStart: { input_tokens: 100, cache_read_input_tokens: 900 },
      usageDelta: { output_tokens: 10 },
    }))
    const usage = chunks.find((c) => c.type === 'usage')?.usage as Record<string, number>
    // inputTokens 保持上游给的值（它本身就只含未命中部分）。
    expect(usage.inputTokens).toBe(100)
    expect(usage.cacheReadTokens).toBe(900)
  })
})

describe('ZCode finish 解析（此前完全不发）', () => {
  it('★ 默认以 finish 收尾（stop）', async () => {
    const chunks = await collect(framesWith({ text: '你好' }))
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
    expect((finish?.reason as { kind: string }).kind).toBe('stop')
  })

  it('stop_reason=max_tokens → max-tokens', async () => {
    const chunks = await collect(framesWith({ text: 'x', stopReason: 'max_tokens' }))
    const finish = chunks.find((c) => c.type === 'finish')
    expect((finish?.reason as { kind: string }).kind).toBe('max-tokens')
  })

  it('stop_reason=tool_use → tool-calls', async () => {
    const chunks = await collect(framesWith({ text: 'x', stopReason: 'tool_use' }))
    const finish = chunks.find((c) => c.type === 'finish')
    expect((finish?.reason as { kind: string }).kind).toBe('tool-calls')
  })

  it('★ stop_reason 缺失但有 tool-call 块 → 仍报 tool-calls（否则循环会停）', async () => {
    // 上游偶尔不给 stop_reason；此时必须以「有没有工具块」兜底 ——
    // 报成 stop 会让 harness 不再执行工具，用户看到「说要调工具但没动静」。
    const frames = [
      'event: message_start\ndata: {"type":"message_start"}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"read"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]
    const chunks = await collect(frames)
    const finish = chunks.find((c) => c.type === 'finish')
    expect((finish?.reason as { kind: string }).kind).toBe('tool-calls')
  })

  it('finish 在两处 usage 都有值时正确收尾', async () => {
    const chunks = await collect(framesWith({
      usageStart: { input_tokens: 1 }, usageDelta: { output_tokens: 2 }, stopReason: 'end_turn',
    }))
    expect(chunks.find((c) => c.type === 'usage')).toBeDefined()
    expect((chunks.find((c) => c.type === 'finish')?.reason as { kind: string }).kind).toBe('stop')
  })
})
