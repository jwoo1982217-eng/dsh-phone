import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  hasUsableToolName,
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  resolveToolPairing,
} from '../../src/sse.js'

/** 构造一个永不产出数据的流（模拟半开的 SSE 连接）。 */
function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() { /* 永不 enqueue / close */ } })
}

/** 构造一个立即产出指定数据后结束的流。 */
function oneShotStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('readWithIdleTimeout', () => {
  // 回归：后端掐断 SSE 连接后若对端既不发数据也不关连接（半开连接），
  // 裸 reader.read() 会永久挂起，generator 永不返回，harness 当前步骤
  // 既不出结果也不报错——web 端发送按钮置灰、后续"继续"指令无响应。
  it('rejects with a retryable TIMEOUT instead of hanging forever', async () => {
    const reader = hangingStream().getReader()
    const error = await readWithIdleTimeout(reader, 20, 'buddy').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('TIMEOUT')
    expect(String((error as LlmError).message)).toContain('buddy: sse chunk timeout')
  })

  it('labels the first-token phase distinctly from the chunk phase', async () => {
    const reader = hangingStream().getReader()
    const error = await readWithIdleTimeout(reader, 20, 'buddy', undefined, 'first-token')
      .catch((e: unknown) => e)
    expect(String((error as LlmError).message)).toContain('first-token timeout')
  })

  it('passes data through when the stream delivers promptly', async () => {
    const reader = oneShotStream(['hello', ' world']).getReader()
    const first = await readWithIdleTimeout(reader, 1_000, 'buddy')
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toBe('hello')
    const second = await readWithIdleTimeout(reader, 1_000, 'buddy')
    expect(second.done).toBe(false)
    expect(new TextDecoder().decode(second.value)).toBe(' world')
    expect((await readWithIdleTimeout(reader, 1_000, 'buddy')).done).toBe(true)
  })

  // 用户取消必须优先于超时：否则中断任务时会被误报成 TIMEOUT 并触发重试。
  it('surfaces user abort over the timeout', async () => {
    const controller = new AbortController()
    const reader = hangingStream().getReader()
    controller.abort(new Error('user cancelled'))
    const error = await readWithIdleTimeout(reader, 1_000, 'buddy', controller.signal)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('user cancelled')
  })
})

describe('isTruncatedArguments', () => {
  // 空串是**合法**的无参数调用，不是截断。
  it('treats an empty payload as a legitimate no-argument call', () => {
    expect(isTruncatedArguments('')).toBe(false)
    expect(isTruncatedArguments('   ')).toBe(false)
  })

  // 并行工具调用丢分片时剩下的路径中段/尾部——必须判定为截断以触发重试。
  it('detects argument fragments lost mid-stream', () => {
    expect(isTruncatedArguments('\\deveco-code-rust\\crates\\deveco')).toBe(true)
    expect(isTruncatedArguments('o-llm\\src\\provider\\buddy.rs"}')).toBe(true)
    expect(isTruncatedArguments('{"command": "ls -')).toBe(true)
  })

  it('accepts complete JSON payloads', () => {
    expect(isTruncatedArguments('{}')).toBe(false)
    expect(isTruncatedArguments('{"file_path":"a.rs"}')).toBe(false)
  })

  // 能解析但类型不对属于模型输出有误，交给 schema 校验回传，不应触发重试。
  it('does not flag parseable non-object payloads as truncated', () => {
    expect(isTruncatedArguments('null')).toBe(false)
    expect(isTruncatedArguments('[1,2]')).toBe(false)
    expect(isTruncatedArguments('42')).toBe(false)
  })
})

describe('resolveToolPairing', () => {
  // 回归（严重）：工具执行失败后结果从未写回，孤儿 tool_calls 随每次请求
  // 重放，导致后端对之后**每一条**用户消息都返回 400——整条会话报废。
  it('drops a tool call that never received a result', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Grep', arguments: '' }] },
      { role: 'user', content: 'continue' },
    ])
    expect(keepCallIds.has('c1')).toBe(false)
    expect(keepResultIds.has('c1')).toBe(false)
  })

  it('drops the whole batch when only some calls got results', () => {
    const { keepCallIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
    ])
    expect(keepCallIds.has('c1')).toBe(false)
    expect(keepCallIds.has('c2')).toBe(false)
  })

  it('keeps a fully answered round-trip', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
      ] },
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'c1', content: [] },
        { type: 'tool-result', toolCallId: 'c2', content: [] },
      ] },
    ])
    expect(keepCallIds.has('c1')).toBe(true)
    expect(keepCallIds.has('c2')).toBe(true)
    expect(keepResultIds.has('c1')).toBe(true)
    expect(keepResultIds.has('c2')).toBe(true)
  })

  // 孤儿结果（没有对应 tool_call）同样会让后端 400，必须剔除。
  it('drops a result whose tool call is missing', () => {
    const { keepResultIds } = resolveToolPairing([
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [] }] },
    ])
    expect(keepResultIds.has('ghost')).toBe(false)
  })

  it('tolerates sessions without any tool traffic', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    expect(keepCallIds.size).toBe(0)
    expect(keepResultIds.size).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 回归（真实缺陷，2026-09-23 用户报障）：**名称为空的 tool_call** 必须剔除。
  //
  // 根因链（全部有实测证据，见 `resolveToolPairing` 的注释与
  // `scripts/confirm-empty-tool-name.ts`）：
  //   ① qoder 偶发一个**完全没有 name 字段**的 tool-call 分片；
  //   ② 适配器早期把它落成 `name:''` 的块，harness 执行得到 `unknown tool ""`，
  //      并把这条坏块**持久化进会话历史**；
  //   ③ 用户切到 workbuddy 后，坏块被每次请求原样重放 →
  //      **HTTP 400 code 11133 model_param_invalid**，会话彻底报废。
  //
  // 实测最小复现（wire 上的 `function.name` → 结果）：
  //   `"read"` / `"unknown_tool"` → 200（上游**只校验非空，不校验存在性**）
  //   `""` / `null` / 缺失          → **400 code 11133**
  // ─────────────────────────────────────────────────────────────────────────
  it('drops a tool call whose name is an empty string', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'bad', name: '', arguments: '{}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'bad', content: [] }] },
    ])
    expect(keepCallIds.has('bad')).toBe(false)
    expect(keepResultIds.has('bad')).toBe(false)
  })

  it('drops a tool call whose name is missing or null', () => {
    const { keepCallIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'a', arguments: '{}' },
        { type: 'tool-call', id: 'b', name: null, arguments: '{}' },
        { type: 'tool-call', id: 'c', name: '   ', arguments: '{}' },
      ] },
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'a', content: [] },
        { type: 'tool-result', toolCallId: 'b', content: [] },
        { type: 'tool-result', toolCallId: 'c', content: [] },
      ] },
    ])
    expect([...keepCallIds]).toEqual([])
  })

  // 关键：一个坏块**不得连累**同批的合法调用 —— 实测线上形态正是
  // 「一个无名 call + 一个合法 pwsh」，若整批丢弃会白白损失一次有效调用。
  it('keeps usable calls in a batch that also contains an unnamed one', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'bad', name: '', arguments: '{}' },
        { type: 'tool-call', id: 'good', name: 'pwsh', arguments: '{"command":"ls"}' },
      ] },
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'bad', content: [] },
        { type: 'tool-result', toolCallId: 'good', content: [] },
      ] },
    ])
    expect(keepCallIds.has('bad')).toBe(false)
    expect(keepCallIds.has('good')).toBe(true)
    expect(keepResultIds.has('bad')).toBe(false)
    expect(keepResultIds.has('good')).toBe(true)
  })
})

describe('hasUsableToolName', () => {
  // ⚠️ 这条判据**不能**写成 `String(name).length > 0`：`undefined` / `null`
  // 经 String() 会变成 `"undefined"` / `"null"` 这类**非空**字符串，
  // 于是「缺名字」被误判成「有名字」，原样发给上游照样 400。
  it('rejects every value that is not a non-empty string', () => {
    expect(hasUsableToolName('read')).toBe(true)
    expect(hasUsableToolName('')).toBe(false)
    expect(hasUsableToolName('   ')).toBe(false)
    expect(hasUsableToolName(undefined)).toBe(false)
    expect(hasUsableToolName(null)).toBe(false)
    expect(hasUsableToolName(42)).toBe(false)
    expect(hasUsableToolName({})).toBe(false)
  })
})

describe('normalizeToolArguments', () => {
  // 回归：无参数工具（如 list_dir）只下发一个空 arguments 分片，拼接结果
  // 为空串，harness 解析时报 `"arguments" must be an object` 并卡住会话。
  it('turns an empty argument payload into an empty object', () => {
    expect(normalizeToolArguments('')).toBe('{}')
    expect(normalizeToolArguments('   ')).toBe('{}')
  })

  // 回归：SSE 流被截断时只收到半截 JSON，同样必须归一化为 {}。
  it('turns truncated JSON into an empty object', () => {
    expect(normalizeToolArguments('{"command": "ls -')).toBe('{}')
    expect(normalizeToolArguments('{"a":')).toBe('{}')
  })

  it('rejects non-object JSON payloads', () => {
    expect(normalizeToolArguments('null')).toBe('{}')
    expect(normalizeToolArguments('[1, 2]')).toBe('{}')
    expect(normalizeToolArguments('42')).toBe('{}')
    expect(normalizeToolArguments('"a string"')).toBe('{}')
  })

  // 关键区分：不可解析的残缺 JSON 不能被 normalizeToolArguments 当成"空参数"
  // 补成 {}——那会伪造合法外观，掩盖真正的分片丢失。它由 isTruncatedArguments
  // 单独识别，交由 max-tokens 触发重试。
  it('leaves truncated JSON for the truncation detector rather than faking {}', () => {
    const truncated = '\\deveco-code-rust\\crates\\deveco'
    expect(normalizeToolArguments(truncated)).toBe('{}')
    // 因此必须由截断检测器单独判定，不能只看归一化结果。
    expect(isTruncatedArguments(truncated)).toBe(true)
  })

  it('preserves well-formed object arguments verbatim', () => {
    expect(normalizeToolArguments('{"command": "ls -la"}')).toBe('{"command": "ls -la"}')
    expect(normalizeToolArguments('{}')).toBe('{}')
    // 嵌套对象与数组值都应保留。
    expect(normalizeToolArguments('{"files": ["a.ts", "b.ts"], "opts": {"depth": 2}}'))
      .toBe('{"files": ["a.ts", "b.ts"], "opts": {"depth": 2}}')
  })
})
