import { describe, expect, it } from 'vitest'
import { buildOpencodePayload, buildOpencodeTools, ensureFreeLaneShape } from '../../src/opencode-messages.js'

describe('buildOpencodeTools', () => {
  it('DSH 工具映射为 OpenAI function 形态', () => {
    const tools = buildOpencodeTools([{ name: 'bash', description: '跑命令', parameters: { type: 'object' } }])
    expect(tools[0]).toEqual({ type: 'function', function: { name: 'bash', description: '跑命令', parameters: { type: 'object' } } })
  })
  it('无工具时返回空数组（不返回 undefined）', () => {
    expect(buildOpencodeTools(undefined)).toEqual([])
  })
  it('空 description 时不下发该键（不填空串）', () => {
    const tools = buildOpencodeTools([{ name: 'x', description: '', parameters: {} }])
    expect('description' in tools[0]!.function).toBe(false)
  })
})

describe('ensureFreeLaneShape（FreeTier 门禁）', () => {
  it('缺 bash/read 时注入两个桩工具', () => {
    const next = ensureFreeLaneShape({ messages: [], tools: [] })
    const names = (next.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toContain('bash')
    expect(names).toContain('read')
  })
  it('原本无任何工具时补 tool_choice=none（模型不得调用桩工具）', () => {
    const next = ensureFreeLaneShape({ messages: [], tools: [] })
    expect(next.tool_choice).toBe('none')
  })
  it('已有真实工具时不覆盖用户自选的 tool_choice', () => {
    const next = ensureFreeLaneShape({
      messages: [],
      tools: [{ type: 'function', function: { name: 'bash' } }, { type: 'function', function: { name: 'read' } }],
      tool_choice: 'auto',
    })
    expect(next.tool_choice).toBe('auto')
  })
  it('已有 bash/read 但带 tool_choice=none 时保持原样', () => {
    const body = { messages: [], tools: [{ type: 'function', function: { name: 'bash' } }, { type: 'function', function: { name: 'read' } }], tool_choice: 'none' }
    expect(ensureFreeLaneShape(body)).toBe(body)
  })
  it('幂等：已含 bash/read 时原样返回同一引用（不重写 body）', () => {
    const body = { messages: [], tools: [{ type: 'function', function: { name: 'bash' } }, { type: 'function', function: { name: 'read' } }] }
    expect(ensureFreeLaneShape(body)).toBe(body)
  })
  it('只缺一个时只补那一个（不重复注入）', () => {
    const next = ensureFreeLaneShape({ messages: [], tools: [{ type: 'function', function: { name: 'bash' } }] })
    const names = (next.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names.filter((n) => n === 'bash')).toHaveLength(1)
    expect(names).toContain('read')
  })
  it('非 chat body（无 messages 数组）原样返回', () => {
    const body = { input: [] }
    expect(ensureFreeLaneShape(body)).toBe(body)
  })
  it('畸形 tool 条目不会让门禁崩溃（跳过并补齐）', () => {
    const next = ensureFreeLaneShape({ messages: [], tools: [null, 42, { function: null }] })
    // 断言只取合法 tool 条目的名字：畸形项被**原样保留**（我们不替用户清洗
    // 工具数组，那会改变模型看到的东西），但门禁判断必须跳过它们。
    const names = (next.tools as unknown[])
      .filter((t): t is { function: { name: string } } =>
        typeof t === 'object' && t !== null && typeof (t as { function?: unknown }).function === 'object'
        && (t as { function: { name?: unknown } }).function !== null)
      .map((t) => t.function.name)
    expect(names).toContain('bash')
    expect(names).toContain('read')
  })
})

describe('buildOpencodePayload', () => {
  const base = { model: 'big-pickle', messages: [{ role: 'user', content: '你好' }] }

  it('恒带 stream:true（门禁的一半）', () => {
    expect(buildOpencodePayload(base).stream).toBe(true)
  })
  it('强制经过门禁注入：始终含 bash 与 read', () => {
    const payload = buildOpencodePayload(base)
    const names = (payload.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toContain('bash')
    expect(names).toContain('read')
  })
  it('⚠️ options.tools 真的下发到顶层（qoder 同型教训：不发则模型臆造工具调用）', () => {
    const payload = buildOpencodePayload({ ...base, tools: [{ name: 'grep', description: '搜', parameters: {} }] })
    const names = (payload.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toContain('grep')
    expect(names).toContain('bash')
    expect(names).toContain('read')
  })
  it('⚠️ 有真实工具时不得补 tool_choice=none（会把用户工具全禁掉）', () => {
    const payload = buildOpencodePayload({ ...base, tools: [{ name: 'grep', description: '搜', parameters: {} }] })
    expect(payload.tool_choice).toBeUndefined()
  })
  it('system 缺省时不下发该键（不传 null）', () => {
    expect('system' in buildOpencodePayload(base)).toBe(false)
  })
  it('system 空串同样不下发', () => {
    expect('system' in buildOpencodePayload({ ...base, system: '' })).toBe(false)
  })
  it('maxTokens 非法值（0/负/NaN）不下发（否则 DSH 抛 INVALID_MODEL_MAX_TOKENS）', () => {
    expect('max_tokens' in buildOpencodePayload({ ...base, maxTokens: 0 })).toBe(false)
    expect('max_tokens' in buildOpencodePayload({ ...base, maxTokens: -5 })).toBe(false)
    expect('max_tokens' in buildOpencodePayload({ ...base, maxTokens: Number.NaN })).toBe(false)
  })
  it('合法 maxTokens 透传', () => {
    expect(buildOpencodePayload({ ...base, maxTokens: 4096 }).max_tokens).toBe(4096)
  })
  it('model 与 messages 原样带上', () => {
    const payload = buildOpencodePayload(base)
    expect(payload.model).toBe('big-pickle')
    expect(payload.messages).toBe(base.messages)
  })
})
