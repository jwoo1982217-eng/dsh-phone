import { describe, expect, it } from 'vitest'
import { buildOpencodePayload, buildOpencodeTools, ensureFreeLaneShape } from '../../src/opencode-messages.js'

const namesOf = (payload: Record<string, unknown>): string[] =>
  (payload.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)

const base = { model: 'big-pickle', messages: [{ role: 'user', content: '你好' }] }

describe('buildOpencodeTools', () => {
  it('DSH 工具映射为 OpenAI function 形态，schema 不改写', () => {
    const parameters = { type: 'object' }
    expect(buildOpencodeTools([{ name: 'read', description: '读文件', parameters }]))
      .toEqual([{ type: 'function', function: { name: 'read', description: '读文件', parameters } }])
  })
  it('无工具时返回空数组', () => {
    expect(buildOpencodeTools(undefined)).toEqual([])
  })
  it('空描述不填空串', () => {
    expect(buildOpencodeTools([{ name: 'x', description: '', parameters: {} }])[0]!.function.description).toBeUndefined()
  })
})

describe('OpenCode V2 门禁', () => {
  it('只补 read 门禁，不注入 shell/bash 或显式 tool_choice:none', () => {
    const payload = buildOpencodePayload(base)
    expect(namesOf(payload)).toEqual(['read'])
    expect(payload.tool_choice).toBeUndefined()
    expect(payload.stream).toBe(true)
    expect(payload.stream_options).toEqual({ include_usage: true })
  })
  it('read 门禁保留参数 schema，描述只提示禁止调用', () => {
    const tools = buildOpencodePayload(base).tools as Array<{ function: { name: string; description: string; strict: boolean; parameters: { required: string[]; properties: Record<string, { type: string; minimum?: number }>; additionalProperties: boolean } } }>
    const fn = tools.find((tool) => tool.function.name === 'read')!.function
    expect(fn.description).toBe('Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.')
    expect(fn.parameters.required).toEqual(['path'])
    expect(fn.parameters.properties.path!.type).toBe('string')
    expect(fn.parameters.properties.offset).toMatchObject({ type: 'integer', minimum: 0 })
    expect(fn.parameters.properties.limit).toMatchObject({ type: 'integer', minimum: 0 })
    expect(Object.keys(fn.parameters.properties)).toEqual(['path', 'offset', 'limit'])
    expect(fn.parameters.additionalProperties).toBe(false)
    expect(fn.strict).toBe(false)
  })
  it('全部客户端工具使用别名，保留原 schema 与描述', () => {
    const parameters = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
    const tools = ['read', 'shell', 'edit', 'write', 'glob', 'grep'].map((name) => ({ name, description: '客户端工具', parameters }))
    const payload = buildOpencodePayload({ ...base, tools })
    const wire = payload.tools as Array<{ function: { name: string; parameters: unknown; description: string } }>
    expect(namesOf(payload)).toEqual([...tools.map((tool) => `dsh_${tool.name}`), 'read'])
    for (const fn of wire.slice(0, tools.length).map((tool) => tool.function)) {
      expect(fn.parameters).toBe(parameters)
      expect(fn.description).toContain('客户端工具')
    }
    expect(payload.tool_choice).toBeUndefined()
  })
  it('长名字、规范化重名和已有别名不会碰撞', () => {
    const tools = ['read', 'dsh_read', 'dsh_read_1', 'a.b', 'a_b', 'x'.repeat(64), 'x'.repeat(63) + 'y']
      .map((name) => ({ name, description: '' }))
    const names = namesOf(buildOpencodePayload({ ...base, tools }))
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('dsh_read_2')
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })
  it('历史调用同步改名，调用 id、参数和结果正文保持原样，不修改入参', () => {
    const messages = [
      { role: 'user', content: 'read' },
      { role: 'assistant', tool_calls: [{ id: 'A', type: 'function', function: { name: 'read', arguments: '{"file_path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'A', content: 'read: file content' },
      { role: 'assistant', function_call: { name: 'read', arguments: '{}' } },
      { role: 'function', name: 'read', content: 'legacy result' },
    ]
    const input = { ...base, messages, tools: [{ name: 'read', description: '' }] }
    const snapshot = JSON.stringify(input)
    const payload = buildOpencodePayload(input)
    expect(payload.messages).toEqual([
      messages[0],
      { ...messages[1], tool_calls: [{ id: 'A', type: 'function', function: { name: 'dsh_read', arguments: '{"file_path":"a"}' } }] },
      messages[2],
      { role: 'assistant', function_call: { name: 'dsh_read', arguments: '{}' } },
      { role: 'function', name: 'dsh_read', content: 'legacy result' },
    ])
    expect(JSON.stringify(input)).toBe(snapshot)
  })
  it('指定工具与 allowed_tools 选择同步改名', () => {
    const tools = [{ type: 'function', function: { name: 'read' } }]
    const next = ensureFreeLaneShape({ messages: [], tools, tool_choice: { type: 'function', function: { name: 'read' } } })
    expect(next.tool_choice).toEqual({ type: 'function', function: { name: 'dsh_read' } })
    const allowed = ensureFreeLaneShape({ messages: [], tools, tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read' }] } })
    expect(allowed.tool_choice).toEqual({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'dsh_read' }] })
  })
  it('显式 none 移除客户端工具，不透传 none，响应层负责禁用语义', () => {
    const payload = ensureFreeLaneShape({ messages: [], tools: [{ type: 'function', function: { name: 'read' } }], tool_choice: 'none' })
    expect(namesOf(payload)).toEqual(['read'])
    expect(payload.tool_choice).toBeUndefined()
  })
  it('非 chat body 不改写', () => {
    const payload = { input: [] }
    expect(ensureFreeLaneShape(payload)).toBe(payload)
  })
})

describe('业务字段', () => {
  it('无工具、无 system 时 messages 保持原引用', () => {
    const payload = buildOpencodePayload(base)
    expect(payload.model).toBe(base.model)
    expect(payload.messages).toBe(base.messages)
    expect(payload.system).toBeUndefined()
  })
  it('DSH system 写成 chat 协议的 system 消息，不用被忽略的顶层字段', () => {
    const payload = buildOpencodePayload({ ...base, system: '系统提示' })
    expect(payload.messages).toEqual([{ role: 'system', content: '系统提示' }, ...base.messages])
    expect(payload.system).toBeUndefined()
  })
  it('不擅自填默认输出预算，非法 maxTokens 不下发', () => {
    for (const maxTokens of [undefined, 0, -5, Number.NaN]) {
      expect(buildOpencodePayload({ ...base, maxTokens }).max_tokens).toBeUndefined()
    }
    expect(buildOpencodePayload({ ...base, maxTokens: 4096 }).max_tokens).toBe(4096)
  })
})
