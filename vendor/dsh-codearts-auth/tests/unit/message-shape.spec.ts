import { describe, expect, it } from 'vitest'
import {
  detectMessageShape,
  normalizeHarnessMessages,
} from '../../src/message-shape.js'

/** 0.1.5 形状：工具结果包裹在 user 消息的 `tool-result` 块里。 */
function legacyMessages(): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"p":"a"}' },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'A' }], isError: false }],
    },
  ]
}

/** 0.1.7 形状：工具结果是一等 `role:'tool'` 消息，callId/isError 在顶层。 */
function toolRoleMessages(): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"p":"a"}' },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_a',
      content: [{ type: 'text', text: 'A' }],
      isError: false,
      source: { kind: 'tool', callId: 'call_a' },
    },
  ]
}

describe('detectMessageShape', () => {
  it('reports legacy for messages carrying wrapped tool-result blocks', () => {
    expect(detectMessageShape(legacyMessages())).toBe('legacy')
  })

  it('reports tool-role for 0.1.7 first-class tool messages', () => {
    expect(detectMessageShape(toolRoleMessages())).toBe('tool-role')
  })

  it('reports none when the conversation has no tool results at all', () => {
    expect(detectMessageShape([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ])).toBe('none')
  })

  it('prefers tool-role when both shapes appear in one history', () => {
    // 升级期会话可能同时含两种形态；一等 tool 消息是权威判据。
    expect(detectMessageShape([...legacyMessages(), ...toolRoleMessages().slice(3)])).toBe('tool-role')
  })
})

describe('normalizeHarnessMessages', () => {
  // 核心契约：归一化后必须与 0.1.5 形状逐字节等价，
  // 这样五个既有序列化实现无需任何改动即可正确工作。
  it('converts 0.1.7 tool messages into the legacy wrapped shape', () => {
    const normalized = normalizeHarnessMessages(toolRoleMessages())
    expect(normalized).toEqual(legacyMessages())
  })

  it('returns the identical array reference for legacy input (zero-cost passthrough)', () => {
    // 0.1.5 路径必须完全不受影响：连数组身份都不能变。
    const input = legacyMessages()
    expect(normalizeHarnessMessages(input)).toBe(input)
  })

  it('returns the identical array reference when no tool results exist', () => {
    const input = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    expect(normalizeHarnessMessages(input)).toBe(input)
  })

  it('drops developer messages that carry no conversation content', () => {
    // 0.1.7 的 developer 消息只承载工具增删元数据；插件不声明 toolUpdate
    // 能力时 harness 会自行剥离，此处兜底避免其被当成用户输入下发。
    const input = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }] },
    ]
    const normalized = normalizeHarnessMessages(input)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]!.role).toBe('user')
  })

  it('preserves tool-result content arrays verbatim, including nested images', () => {
    // 既有实现依赖内嵌图片块做图片提升；归一化不得压平 content。
    const image = { type: 'image', attachment: { attachmentId: 'img-1' } }
    const normalized = normalizeHarnessMessages([
      {
        role: 'tool',
        toolCallId: 'call_a',
        content: [{ type: 'text', text: 'A' }, image],
        isError: true,
      },
    ])
    expect(normalized).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'A' }, image], isError: true }],
      },
    ])
  })

  it('omits isError when the source message omits it', () => {
    const normalized = normalizeHarnessMessages([
      { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: 'A' }] },
    ])
    const block = (normalized[0]!.content as Array<Record<string, unknown>>)[0]!
    expect('isError' in block).toBe(false)
  })

  it('is idempotent: normalizing legacy output again changes nothing', () => {
    const once = normalizeHarnessMessages(toolRoleMessages())
    expect(normalizeHarnessMessages(once)).toBe(once)
  })

  it('keeps string user content untouched', () => {
    const input = [{ role: 'user', content: 'plain string' }]
    expect(normalizeHarnessMessages(input)).toBe(input)
  })

  // 真实 session（session-54cbd95c）迁移后的字段全貌：0.1.7 的 tool 消息带
  // `source.callId` 与 `id` 两个伴随字段。fixture 用真实字段名，防止只在
  // 自造的精简形状上通过、却在真实数据上失效。
  it('handles the real 0.1.7 tool message field layout', () => {
    const normalized = normalizeHarnessMessages([{
      role: 'tool',
      source: { kind: 'tool', callId: 'call_00_Cow4laxB9D4vdipbJ6aH8033' },
      toolCallId: 'call_00_Cow4laxB9D4vdipbJ6aH8033',
      content: [{ type: 'text', text: 'Path\n----\nD:\\jet\\code\\pg\\rdeveco-code' }],
      isError: false,
      id: '2f80db70-9ce2-415b-afd3-73acaf05f652',
    }])
    expect(normalized).toEqual([{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_00_Cow4laxB9D4vdipbJ6aH8033',
        content: [{ type: 'text', text: 'Path\n----\nD:\\jet\\code\\pg\\rdeveco-code' }],
        isError: false,
      }],
    }])
  })

  it('falls back to source.callId when the top-level toolCallId is absent', () => {
    // 顶层 `toolCallId` 是主判据；`source.callId` 是 0.1.7 的伴随字段。
    // 只要有其一就不该丢 id —— 丢了会让工具结果变成无法配对的孤儿。
    const normalized = normalizeHarnessMessages([{
      role: 'tool',
      source: { kind: 'tool', callId: 'call_from_source' },
      content: [{ type: 'text', text: 'X' }],
    }])
    const block = (normalized[0]!.content as Array<Record<string, unknown>>)[0]!
    expect(block.toolCallId).toBe('call_from_source')
  })

  it('leaves assistant and system messages untouched', () => {
    const input = toolRoleMessages()
    const normalized = normalizeHarnessMessages(input)
    expect(normalized[0]).toBe(input[0])
    expect(normalized[1]).toBe(input[1])
    expect(normalized[2]).toBe(input[2])
  })
})
