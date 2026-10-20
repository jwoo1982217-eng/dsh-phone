/**
 * 「零内容块响应必须报 `EMPTY_RESPONSE`（可重试）」的回归测试。
 *
 * ## 真实缺陷链
 *
 * 1. 用户报障：UI 上出现**空的思考（Think）块**。控制方实证：模型
 *    `deepseek-v4.1-flash` 偶发**只输出一个空格当思考**（实测 2233 次，
 *    `usage.reasoningTokens = 1`）。
 * 2. Task 1/2 修掉了空块（`createBlankReasoningSuppressor`，6 个发射点接入）。
 * 3. **压制后出现新的退化形态**（Task 2 审查 Important 1，控制方独立实测证实）：
 *    若某次响应**本来只有那个空白 reasoning 块**（无 text、无 tool-call），
 *    就会产出「**零块 + `finish: stop`**」。
 *
 * DSH 的 `EMPTY_RESPONSE` 契约（`dsh-llm/lib/types/error.d.ts`）明确禁止这种输出：
 *
 * > Providers occasionally emit a degenerate completion (a terminal stop with zero
 * > output); adapters classify it as this failure instead of yielding an empty
 * > assistant message, because **an empty message silently ends the turn with
 * > nothing for the user or the loop to act on**. The attempt produced nothing
 * > durable, so retry policy treats it as safe to repeat.
 *
 * 官方适配器 `dsh-llm-deepseek` 的权威范本（`lib/index.js` 的 `translate()`）：
 *
 * ```js
 * const reason = pendingFinish ?? { kind: 'stop' }
 * yield { type: 'finish', reason: reason.kind === 'stop' && order.length === 0
 *   ? { kind: 'error', failure: { message: '…no content', code: EMPTY_RESPONSE_CODE } }
 *   : reason }
 * ```
 *
 * 实测真实频率 **1 / 30404**（`scripts/quantify-empty-response-risk.ts`），
 * 与本项目已两次踩过的同族坑（空名 `tool_call`、思考死循环）完全同型：
 * 都表现为「`finish` 报 `stop` ⇒ 任务静默中断」。
 *
 * ## 本文件的两组判据
 *
 * - **A 组（纯函数）**：锁定 `resolveEmptyResponseReason` 的判据本身，
 *   尤其「**只在 `kind === 'stop'` 时才改写**」（不得覆盖 max-tokens / tool-calls）。
 * - **B 组（适配器级）**：用**真实适配器 + 真实 SSE 帧**验证**接线**正确 ——
 *   即 `blockCount` 取的是「**实际会发出的 `block-end` 数量**」，而不是
 *   `blocks.length`（后者含被压制的空 reasoning 块 / 被清洗成空的块）。
 */
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveEmptyResponseReason, isCourseLeakStripEnabled } from '../../src/sse.js'
import { consumeOpenAiSse } from '../../src/openai-compat.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import { WORKBUDDY } from '../../src/product.js'
import { buildQoderCredential, parseQoderTokenPayload } from '../../src/qoder.js'
import type { CodeArtsCredential } from '../../src/types.js'
import type { FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 期望的 `EMPTY_RESPONSE` finish chunk（官方范本的逐字文案与 code）。 */
const EMPTY_RESPONSE_FINISH = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      message: 'model returned a completed response with no content',
      code: 'EMPTY_RESPONSE',
    },
  },
}

// ────────────────────────────────────────────────────────────────────────────
// A 组：纯函数判据
// ────────────────────────────────────────────────────────────────────────────

describe('resolveEmptyResponseReason（零块判据）', () => {
  it('({kind:stop}, 0) → error/EMPTY_RESPONSE', () => {
    expect(resolveEmptyResponseReason({ kind: 'stop' }, 0)).toEqual({
      kind: 'error',
      failure: {
        message: 'model returned a completed response with no content',
        code: 'EMPTY_RESPONSE',
      },
    })
  })

  it('({kind:stop}, 1) → 原样（有块就不改写）', () => {
    expect(resolveEmptyResponseReason({ kind: 'stop' }, 1)).toEqual({ kind: 'stop' })
  })

  it('({kind:stop}, 3) → 原样', () => {
    expect(resolveEmptyResponseReason({ kind: 'stop' }, 3)).toEqual({ kind: 'stop' })
  })

  // ⚠️ 这两条是本判据的**边界**：max-tokens / tool-calls 本身语义更具体
  // （前者「被截断、可续写」，后者「有工具待执行」），绝不能被泛化的零块
  // 判据覆盖成 EMPTY_RESPONSE —— 那会把一条明确信号降级成泛化重试。
  it('({kind:max-tokens}, 0) → 原样（不得被零块判据覆盖）', () => {
    expect(resolveEmptyResponseReason({ kind: 'max-tokens' }, 0)).toEqual({ kind: 'max-tokens' })
  })

  it('({kind:tool-calls}, 0) → 原样（不得被零块判据覆盖）', () => {
    expect(resolveEmptyResponseReason({ kind: 'tool-calls' }, 0)).toEqual({ kind: 'tool-calls' })
  })

  it('不改写其它 finish 形态（aborted 等）', () => {
    // ⚠️ 必须显式标注 `FinishReason`：收紧签名后，对象字面量的 `kind` 会被
    // 推断成 `string`，无法赋给 `{kind:'aborted'|…}` 的联合（这正是收紧带来的
    // 编译期保护 —— 拼错 kind 现在拦得住，见 Important 3）。
    const aborted: FinishReason = { kind: 'aborted', failure: { message: 'x', code: 'ABORTED' } }
    // 原样返回**同一引用**（不是重建对象）。
    expect(resolveEmptyResponseReason(aborted, 0)).toBe(aborted)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B 组：适配器接线（真实适配器 + 真实 SSE 帧）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 五个线上真实退化形态 + 一个「不得被覆盖」的对照。
 *
 * | 场景 | 上游产出 | 期望 finish |
 * |---|---|---|
 * | `blank` | 只有一个空格的 reasoning | **error/EMPTY_RESPONSE** |
 * | `blank+text` | 空格 reasoning + 正文 | `stop`（有块，不得误判） |
 * | `blank+tool` | 空格 reasoning + 工具调用 | `tool-calls` |
 * | `normal` | 正常（非空白）思考 | `stop` |
 * | `course-leak` | reasoning 恰为泄漏 token `课`（**会建块**，但收尾被清洗成空串） | **error/EMPTY_RESPONSE** |
 * | `length` | 空格 reasoning + `finish_reason: length` | `max-tokens`（既存优先级） |
 *
 * ⚠️ `blank` 与 `course-leak` 都期望 `EMPTY_RESPONSE`，但**判别力完全不同**：
 *
 * - `blank` 上游是纯空白，`suppressor` **压根没建块** ⇒ 实发块数 = `blocks.length` = 0，
 *   故 `blockCount` 与 `blocks.length` **无法区分**（把实现改成 `blocks.length`
 *   这条用例照样通过）；
 * - `course-leak` 上游是**非空白**的 `课`，`suppressor` **会建块**
 *   （`'课'.trim() !== ''` ⇒ 转正、发 `block-start` + `reasoning-delta`），
 *   但收尾 `stripCourseLeakIfEnabled('课')` 把它洗成 `''` ⇒ **不发 `block-end`**。
 *   于是 **实发块数 = 0 而 `blocks.length` = 1** —— 这正是 `blockCount` 存在的
 *   唯一理由。用 `blocks.length` 会认为「有 1 块」而落到 `stop`（静默结束）。
 *
 * `课` 不是杜撰的输入：它是本项目已证实的**真实泄漏 token**
 * （实测 3362 次、长度恰为 1，见 `stripCourseLeak` 的文档与
 * `scripts/verify-blockcount-vs-blocks-length.ts`）。
 */
type Scenario = 'blank' | 'blank+text' | 'blank+tool' | 'normal' | 'course-leak' | 'length'

/** 各场景期望的末 chunk。 */
const EXPECTED: Record<Scenario, unknown> = {
  'blank': EMPTY_RESPONSE_FINISH,
  'blank+text': { type: 'finish', reason: { kind: 'stop' } },
  'blank+tool': { type: 'finish', reason: { kind: 'tool-calls' } },
  'normal': { type: 'finish', reason: { kind: 'stop' } },
  'course-leak': EMPTY_RESPONSE_FINISH,
  'length': { type: 'finish', reason: { kind: 'max-tokens' } },
}

/** 场景对应的上游 finish_reason。 */
function finishReasonOf(scenario: Scenario): 'stop' | 'tool_calls' | 'length' {
  if (scenario === 'blank+tool') return 'tool_calls'
  if (scenario === 'length') return 'length'
  return 'stop'
}

/**
 * 场景对应的 reasoning_content。
 *
 * - `blank` 系一律是**单个空格**（即实测形态，`reasoningTokens = 1`）；
 * - `normal` 是正常思考；
 * - `course-leak` 是**行首泄漏 token `课`**（真实形态，长度恰为 1）。
 */
function reasoningOf(scenario: Scenario): string | undefined {
  if (scenario === 'normal') return '我先读一下这个文件。'
  if (scenario === 'course-leak') return '课'
  return ' '
}

/** 场景是否带正文。 */
function hasText(scenario: Scenario): boolean {
  return scenario === 'blank+text'
}

/** 场景是否带工具调用。 */
function hasTool(scenario: Scenario): boolean {
  return scenario === 'blank+tool'
}

/** 一个 OpenAI 兼容的 tool-call 分片（首片即带 name，故会被正常发射）。 */
function openAiToolCallDelta(): unknown {
  return {
    tool_calls: [{
      index: 0,
      id: 'call_read_1',
      function: { name: 'read', arguments: '{"file_path":"a.ts"}' },
    }],
  }
}

/** OpenAI 兼容 SSE（buddy / workbuddy / lobsterai / codearts 的帧形态）。 */
function openAiFrames(scenario: Scenario): string {
  const frames: string[] = []
  const reasoning = reasoningOf(scenario)
  if (reasoning !== undefined) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`)
  }
  if (hasText(scenario)) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: '这是回答。' } }] })}\n\n`)
  }
  if (hasTool(scenario)) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: openAiToolCallDelta() }] })}\n\n`)
  }
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReasonOf(scenario) }] })}\n\n`)
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

/** TRAE 的 SOLO 自定义事件形态（**不能**复用 OpenAI 帧）。 */
function traeFrames(scenario: Scenario): string {
  const events: string[] = []
  const reasoning = reasoningOf(scenario)
  if (reasoning !== undefined) {
    events.push(`event:output\ndata:${JSON.stringify({ reasoning_content: reasoning })}\n\n`)
  }
  if (hasText(scenario)) {
    events.push(`event:output\ndata:${JSON.stringify({ response: '这是回答。' })}\n\n`)
  }
  if (hasTool(scenario)) {
    events.push(`event:output\ndata:${JSON.stringify({
      tool_calls: [{ index: 0, id: 'call_read_1', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } }],
    })}\n\n`)
  }
  events.push(`event:done\ndata:${JSON.stringify({ finish_reason: finishReasonOf(scenario) })}\n\n`)
  return events.join('')
}

/**
 * qoder 的**加密端点信封**形态：每帧多一层 `{headers, body, statusCode}`，
 * 内层 `body` 是标准 OpenAI chunk 的 **JSON 字符串**（未加密）。
 *
 * ⚠️ 内层必须含 `"choices"`，否则 `unwrapQoderEnvelopeStream` 会把整帧
 * 当成业务错误（见 `src/qoder-envelope.ts` 的判据）。
 */
function qoderEnvelopeFrames(scenario: Scenario): string {
  const inner: string[] = []
  const reasoning = reasoningOf(scenario)
  if (reasoning !== undefined) {
    inner.push(JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] }))
  }
  if (hasText(scenario)) {
    inner.push(JSON.stringify({ choices: [{ delta: { content: '这是回答。' } }] }))
  }
  if (hasTool(scenario)) {
    inner.push(JSON.stringify({ choices: [{ delta: openAiToolCallDelta() }] }))
  }
  inner.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReasonOf(scenario) }] }))
  return inner
    .map((body) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('') + 'data: [DONE]\n\n'
}

/** 收集异步 chunk 流。 */
async function drain(stream: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of stream) out.push(chunk as unknown as Record<string, unknown>)
  return out
}

/** 每帧一次 `pull` 的响应：`reader.read()` 逐帧到达（与线上一致）。 */
function streamedResponse(sse: string): Response {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(sse)
  let offset = 0
  // 每 256 字节一帧，模拟真实分片（而非一次性到达）。
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(offset, offset + 256))
      offset += 256
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** qoder：真实 `QoderAdapter`（加密推理路径 → `consumeOpenAiSse`）。 */
function collectQoder(sse: string): Promise<Array<Record<string, unknown>>> {
  const adapter = new QoderAdapter({
    credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
    resolveCredential: async () => buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
      { machineId: 'm-1' },
    ),
    refresh: async () => {},
    product: QODER,
    fetchImpl: (async () => streamedResponse(sse)) as never,
  })
  return drain(adapter.stream({
    // ⚠️ qoder 的目录 key `qfmodel` 即 **Qwen3.8-Flash**（模型名认的是目录 key）。
    model: 'qfmodel',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as never))
}

/** buddy / workbuddy：真实 `BuddyAdapter`（用户实际报障路径）。 */
function collectBuddy(sse: string): Promise<Array<Record<string, unknown>>> {
  const adapter = new BuddyAdapter({
    credentialRef: 'TEST_REF' as never,
    resolveCredential: async () => ({ access_token: 'stub', refresh_token: 'stub', expires_at: 0 }) as never,
    refresh: async () => {},
    product: WORKBUDDY,
    fetchImpl: (async () => streamedResponse(sse)) as never,
  })
  return drain(adapter.stream({
    model: 'deepseek-v4.1-flash', messages: [], reasoningEffort: 'high', maxTokens: 128_000,
  } as never))
}

/** lobsterai：真实 `LobsteraiAdapter`（OpenAI 格式，帧形态同上）。 */
function collectLobsterai(sse: string): Promise<Array<Record<string, unknown>>> {
  const adapter = new LobsteraiAdapter({
    credentialRef: 'LOBSTERAI_ACCOUNT_TEST' as never,
    resolveCredential: async () => ({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1', user_id: 'yid-1', nickname: '测试账号', uuid: 'uuid-1',
      first_keyfrom: '1700000000000', latest_keyfrom: '1700000000000',
    }) as never,
    refresh: async () => {},
    fetchImpl: (async () => streamedResponse(sse)) as never,
    resolveClientVersion: async () => '2026.9.4',
    product: LOBSTERAI,
  })
  return drain(adapter.stream({
    provider: 'lobsterai', model: 'glm-5.2', messages: [{ role: 'user', content: '你好' }],
  } as unknown as GenerateOptions))
}

/**
 * codearts：真实 `CodeArtsAdapter`。
 *
 * 凭据用**永不过期**的桩值（否则 `stream()` 会先走 `refresh()` 拿到
 * `undefined` 凭据并抛 MISSING_CREDENTIAL）。模型取 `deepseek-v4.1-flash`
 * —— 即本次报障的那个模型。
 */
function collectCodeArts(sse: string): Promise<Array<Record<string, unknown>>> {
  const adapter = new CodeArtsAdapter({
    credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
    resolveCredential: async () => ({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2099-01-01T00:00:00Z',
    }) as CodeArtsCredential,
    refresh: async () => {},
    fetchImpl: (async () => streamedResponse(sse)) as never,
  })
  return drain(adapter.stream({
    model: 'deepseek-v4.1-flash',
    messages: [],
    signal: new AbortController().signal,
  } as never))
}

/** trae：真实 `TraeAdapter`（SOLO 自定义 SSE 事件形态）。 */
function collectTrae(sse: string): Promise<Array<Record<string, unknown>>> {
  const responses: Response[] = [streamedResponse(sse)]
  const adapter = new TraeAdapter({
    credentialRef: 'TRAE_ACCESS_TOKEN' as never,
    resolveCredential: async () => ({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1', nickname: '测试账号',
      machine_id: 'a'.repeat(32), device_id: 'c'.repeat(32),
    }) as never,
    refresh: async () => {},
    fetchImpl: (async () => {
      const next = responses.shift()
      if (next === undefined) throw new Error('unexpected fetch call')
      return next
    }) as never,
    product: TRAE,
  })
  return drain(adapter.stream({
    model: 'glm-5.2', messages: [{ role: 'user', content: '你好' }],
  } as unknown as GenerateOptions))
}

/** 五个适配器各自「用真实帧跑一次并收集 chunk」的入口。 */
const ADAPTERS: ReadonlyArray<{
  name: string
  collect: (scenario: Scenario) => Promise<Array<Record<string, unknown>>>
}> = [
  { name: 'qoder / openai-compat', collect: (s) => collectQoder(qoderEnvelopeFrames(s)) },
  { name: 'buddy / workbuddy', collect: (s) => collectBuddy(openAiFrames(s)) },
  { name: 'lobsterai', collect: (s) => collectLobsterai(openAiFrames(s)) },
  { name: 'codearts', collect: (s) => collectCodeArts(openAiFrames(s)) },
  { name: 'trae', collect: (s) => collectTrae(traeFrames(s)) },
]

describe.each(ADAPTERS)('零内容块响应报 EMPTY_RESPONSE（$name）', ({ collect }) => {
  // 核心缺陷：压制空白思考后，只剩空块可发的响应会落到「零块 + stop」，
  // 即 DSH 契约明令禁止的静默结束。必须是可重试的 EMPTY_RESPONSE。
  it('仅一个空格的 reasoning → 末 chunk 是 error/EMPTY_RESPONSE', async () => {
    const chunks = await collect('blank')
    expect(chunks.at(-1)).toEqual(EMPTY_RESPONSE_FINISH)
    // 判别力：必须**真的**没有任何块产出（否则「零块」这条前提不成立，
    // 上一条断言就可能是被别的路径凑巧满足的）。
    expect(chunks.filter((c) => c.type === 'block-end')).toEqual([])
  })

  // 反向判据：有正文时**不得**被误判成零块（blockCount 必须真的算到 1）。
  it('空思考 + 正文 → 末 chunk 仍是 stop（不得误判为零块）', async () => {
    const chunks = await collect('blank+text')
    expect(chunks.at(-1)).toEqual(EXPECTED['blank+text'])
    // 判别力：确实产出了 1 个 text 块。
    expect(chunks.filter((c) => c.type === 'block-end')).toHaveLength(1)
  })

  // 反向判据：有工具调用时不得被误判 —— 且 finish 必须是 tool-calls
  // （`resolveEmptyResponseReason` 对非 stop 一律原样返回）。
  it('空思考 + 工具调用 → 末 chunk 仍是 tool-calls', async () => {
    const chunks = await collect('blank+tool')
    expect(chunks.at(-1)).toEqual(EXPECTED['blank+tool'])
    expect(chunks.filter((c) => c.type === 'block-end')).toHaveLength(1)
    expect((chunks.find((c) => c.type === 'block-end')!.block as { name?: string }).name).toBe('read')
  })

  // 反向判据：正常思考（非空白）不受影响。
  it('正常思考 → 末 chunk 仍是 stop', async () => {
    const chunks = await collect('normal')
    expect(chunks.at(-1)).toEqual(EXPECTED['normal'])
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(reasoningEnd).toBeDefined()
    expect((reasoningEnd!.block as { text?: string }).text).toBe('我先读一下这个文件。')
  })

  /**
   * ★ `blockCount` 与 `blocks.length` 的**分歧形态**（审查 Important 1）。
   *
   * 这是本文件里**唯一**能钉住「必须用实发块数、不能用 `blocks.length`」的用例：
   *
   * | 量 | 值 | 为什么 |
   * |---|---|---|
   * | `blocks.length` | **1** | `'课'.trim() !== ''` ⇒ `suppressor` 转正并建块 |
   * | 实发 `block-end` | **0** | 收尾 `stripCourseLeakIfEnabled('课')` ⇒ `''` ⇒ 不发 |
   *
   * 把任一适配器的 `blockCount` 改成 `blocks.length` 后，`blocks.length = 1 > 0`
   * ⇒ 判「有块」⇒ 末 chunk 变成 `{kind:'stop'}` ⇒ **本用例必然失败**。
   *
   * ⚠️ 上游确实产出了一个 reasoning 块（`block-start` + `reasoning-delta` 都发过），
   * 所以本用例**只**断言 `block-end` 为空 —— 即「块被建了、但没有一块真正落地」。
   * 这正是「零内容块响应」的定义（对照 `blank`：那里连块都没建）。
   */
  it('reasoning 被清洗成空串 ⇒ 实发零块 ⇒ EMPTY_RESPONSE', async () => {
    // 前提：清洗开关默认开启（判据依赖它把 `课` 洗成空串）。
    expect(isCourseLeakStripEnabled()).toBe(true)
    const chunks = await collect('course-leak')
    // 判别力 ①：一个 block-end 都没有（块被建过，但被清洗成空串后不发）。
    expect(chunks.filter((c) => c.type === 'block-end')).toEqual([])
    // 判别力 ②：末 chunk 必须是可重试的 EMPTY_RESPONSE。
    // 若实现用了 `blocks.length`（=1），这里会是 `{kind:'stop'}` 而失败。
    expect(chunks.at(-1)).toEqual(EMPTY_RESPONSE_FINISH)
  })

  // 既存优先级不得被覆盖：`finish_reason: length` → max-tokens，
  // 即便本次实际块数为 0（`resolveEmptyResponseReason` 只在 `stop` 时改写）。
  it('finish_reason=length 且零块 → 仍是 max-tokens（既存优先级保留）', async () => {
    const chunks = await collect('length')
    expect(chunks.at(-1)).toEqual(EXPECTED['length'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 既存判据一并对拍（改写 `reason` 之前就已算好的判据不得被打乱）
// ────────────────────────────────────────────────────────────────────────────

describe('既存 finish 判据不被本判据打乱（openai-compat / qoder）', () => {
  /** 直接跑共享层，便于精确构造「无名 tool-call」这类形态。 */
  async function collectRaw(sse: string): Promise<Array<Record<string, unknown>>> {
    return drain(consumeOpenAiSse(streamedResponse(sse), {}, {
      label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
    }))
  }

  it('丢弃无名 tool-call 且无可用调用 → max-tokens（不得降级成 EMPTY_RESPONSE）', async () => {
    const unnamed = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 2, id: 'call_bad', function: { arguments: '' } }] } }],
    })}\n\n`
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    const chunks = await collectRaw(`${unnamed}${finish}data: [DONE]\n\n`)
    // 零块 ⇒ 若判据顺序写反，会被零块判据改写成 EMPTY_RESPONSE 而丢失
    // 「模型本意调工具」这条更具体的信号。
    expect(chunks.filter((c) => c.type === 'block-end')).toEqual([])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('连接被掐断（无 finish_reason 且无 [DONE]）且零块 → max-tokens', async () => {
    const chunks = await collectRaw('')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('一个无名 + 一个合法调用 → tool-calls（坏块不连累好块）', async () => {
    const mixed = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_bad', function: { arguments: '{}' } },
        { index: 1, id: 'call_good', function: { name: 'pwsh', arguments: '{"command":"ls"}' } },
      ] } }],
    })}\n\n`
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
    const chunks = await collectRaw(`${mixed}${finish}data: [DONE]\n\n`)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})
