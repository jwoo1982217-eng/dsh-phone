/**
 * 「**纯空白思考时，适配器一个 chunk 都不发**」的适配器级回归测试。
 *
 * ## 为什么已有的两个 spec 锁不住这条行为
 *
 * - `blank-reasoning.spec.ts` 锁的是 **helper 语义**（`createBlankReasoningSuppressor`
 *   的 `feed()` / `text()` 返回值），**不碰适配器接线**；
 * - `empty-response.spec.ts` 锁的是 **finish 归类**，其中「仅一个空格的 reasoning」
 *   那一条只断言末 chunk 是 `error/EMPTY_RESPONSE`、且 `block-end` 为空。
 *
 * 于是存在一个**真实可回归的形态**：有人把接线退回「发 `block-start` 但不发
 * `block-end`」。此时
 *
 * 1. `empty-response.spec.ts` 的那条用例**仍然通过** —— 它的 finish 判据看的是
 *    `blockCount`，而 `blockCount` 只在 `block-end` 发射点自增，故仍为 0；
 * 2. 缺陷却已经回来了：DSH 的 `BlockAssembler.assemble()` 对**没有 `block-end`**
 *    的 partial 同样会组装出块 ——
 *    ```js
 *    assemble(partial, index) {
 *      if (partial.block) return partial.block                  // 有 block-end → 用它
 *      case "reasoning": return { type: "reasoning", text: partial.text }  // 无 → 用累积文本
 *    ```
 *    于是那个空格照样被组装成一个**空 Think 块**，正是本任务要根除的 UI 缺陷。
 *    （控制方已用 DSH 真身 `assembleAssistantStream` 实测，见
 *    `scripts/verify-empty-reasoning-fix.ts`。）
 *
 * 本文件因此**只断言块 / chunk 层面**的形态：`block-start`（尤其
 * `blockType === 'reasoning'`）、`reasoning-delta`、`block-end` 的有无与内容。
 * finish 归类不在此重复（`empty-response.spec.ts` 已覆盖 5 适配器 × 6 场景），
 * 仅 F 用例附带一条 `tool-calls` 作为辅助判据。
 *
 * ## 六个场景（五个适配器全部参数化）
 *
 * | 场景 | 上游产出 | 期望的块层面形态 |
 * |---|---|---|
 * | A | `reasoning_content: ' '` + `finish_reason: stop` | **零 chunk**（连 `block-start` 都不发） |
 * | B | `[' ', ' ', '  ']` 三片空白 | **零 chunk** |
 * | C | `[' ', '我需要确认契约。']` | 1 个 reasoning `block-start`；`block-end.text` **恰为 `' 我需要确认契约。'`**（含前导空格） |
 * | D | `'我需要确认契约。'`（正常思考） | 1 个 reasoning `block-start` + 1 个 reasoning `block-end`，文本原样 |
 * | E | 空白思考 **+** `content: '正文内容'` | 正文 `block-end.text` 恰为 `'正文内容'`；**无** reasoning `block-start` |
 * | F | 空白思考 **+** 合法 `tool_call` | 工具 `block-end` 正常、`finish` 为 `tool-calls`；**无** reasoning `block-start` |
 *
 * 模型：五个适配器统一用 `deepseek-v4.1-flash`（本次报障模型）；qoder 用它自己的
 * 目录 key `qfmodel` —— 那**就是** Qwen3.8-Flash（加密端点的 `model` 字段只认目录 key，
 * 传通用名 `qwen3.8-flash` 会被判 `Unsupported model`）。
 *
 * ## 判别力（已用变异测试自证，见提交说明）
 *
 * A/B 的核心断言是「`block-start` 总数为 0」而**不只是**「reasoning 的
 * `block-start` 为 0」—— 后者会被「空块借 text / tool-call 的 blockType 混入」
 * 蒙混过关。C/D 用 `toBe` 精确相等而非 `toContain`，因为 `toContain` 抓不到
 * 「前导空格丢失」这个正是补发语义要保证的点。
 */
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { buildQoderCredential, parseQoderTokenPayload } from '../../src/qoder.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import { WORKBUDDY } from '../../src/product.js'
import type { CodeArtsCredential } from '../../src/types.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 收集到的单个 chunk（结构见 `StreamChunk`，测试按需窄化）。 */
type Chunk = Record<string, unknown>

// ────────────────────────────────────────────────────────────────────────────
// 场景定义
// ────────────────────────────────────────────────────────────────────────────

type Scenario = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

/** 一个场景对应的上游产出。 */
interface Upstream {
  /**
   * 逐片 `reasoning_content`。
   *
   * ⚠️ 必须是**逐片**（而不是一整串）：纯空白抑制的判据落在「整块迄今是否非空白」，
   * 只有分成多片才能真正覆盖「多片空白后转正」与「相邻空白片都不发」两条路径。
   */
  readonly reasoning: readonly string[] | undefined
  /** 正文（`content` / trae 的 `response`）；`undefined` 表示无正文。 */
  readonly text: string | undefined
  /** 是否带一个合法（首片即含 name）的 tool_call。 */
  readonly tool: boolean
  /** 上游 `finish_reason`。 */
  readonly finish: 'stop' | 'tool_calls'
}

/** 正常思考文本（C/D 用）。C 期望它在**补发**时带上前导空格。 */
const REASONING_TEXT = '我需要确认契约。'
/** C 场景期望的最终 reasoning 文本（**含**上方那片空格）。 */
const REASONING_TEXT_WITH_LEADING_BLANK = ` ${REASONING_TEXT}`

const UPSTREAM: Record<Scenario, Upstream> = {
  // A：本任务的核心形态 —— 模型只输出一个空格当思考（实测 2233 次、
  // `usage.reasoningTokens = 1`）。
  A: { reasoning: [' '], text: undefined, tool: false, finish: 'stop' },
  // B：连续多片空白（真实流里 single-space 常被拆成多帧）。
  B: { reasoning: [' ', ' ', '  '], text: undefined, tool: false, finish: 'stop' },
  // C：空白之后转正 —— 必须**补发已累积文本**（含前导空格）。
  C: { reasoning: [' ', REASONING_TEXT], text: undefined, tool: false, finish: 'stop' },
  // D：对照组 —— 正常思考行为不得被本次修复改变。
  D: { reasoning: [REASONING_TEXT], text: undefined, tool: false, finish: 'stop' },
  // E：空白思考与正文**共存**（同一响应不同字段）—— 正文不受影响。
  E: { reasoning: [' '], text: '正文内容', tool: false, finish: 'stop' },
  // F：空白思考与工具调用共存 —— 工具不受影响。
  F: { reasoning: [' '], text: undefined, tool: true, finish: 'tool_calls' },
}

// ────────────────────────────────────────────────────────────────────────────
// 五种 wire 形态的「真实 SSE 帧」构造
// ────────────────────────────────────────────────────────────────────────────

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

/** OpenAI 兼容 SSE（qoder 信封内层 / buddy / workbuddy / lobsterai / codearts）。 */
function openAiFrames(upstream: Upstream): string {
  const frames: string[] = []
  for (const piece of upstream.reasoning ?? []) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: piece } }] })}\n\n`)
  }
  if (upstream.text !== undefined) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: upstream.text } }] })}\n\n`)
  }
  if (upstream.tool) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: openAiToolCallDelta() }] })}\n\n`)
  }
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: upstream.finish }] })}\n\n`)
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

/**
 * codearts **出口①** 的帧形态：`delta.content` 里带 `<thought>…</thought>`。
 *
 * ⚠️ **为什么必须单独一套帧**：codearts 有**两条** reasoning 出口
 * （`src/llm-adapter.ts:1113-1123` 自己把这条列为「漏一条就等于漏一条路径」）：
 * - **出口①**：`delta.content` → `DsmlContentExtractor` 解析 `<thought>` →
 *   `emitDsmlFeed(text, reasoning, …)`（`:1317-1318`）；
 * - **出口②**：`delta.reasoning_content` → `dsmlReasoningExtractor` → `thinking`
 *   （`:1328`）。
 *
 * `openAiFrames` 只发 `reasoning_content` ⇒ **只覆盖出口②**。
 * 若出口① 的接线退回朴素写法，「空 Think 块」会从这条路径静默回归，
 * 而所有既有 spec（含本文件的出口② 用例）**全部通过**。
 *
 * ⚠️ 注意 `visible` 回退：出口① 的非空内容会**同时**产出 reasoning 块与 text 块
 * （`<thought>` 之外没有正文时，回退用推理文本填正文）—— 断言须区分两者。
 */
function codeartsThoughtFrames(thoughts: readonly string[]): string {
  const frames: string[] = []
  // 每个 thought 走一帧 `delta.content`（真实流里 `<thought>` 可跨帧，这里分帧喂入）。
  for (const thought of thoughts) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: `<thought>${thought}</thought>` } }] })}\n\n`)
  }
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

/** TRAE 的 SOLO 自定义事件形态（**不能**复用 OpenAI 帧）。 */
function traeFrames(upstream: Upstream): string {
  const events: string[] = []
  for (const piece of upstream.reasoning ?? []) {
    events.push(`event:output\ndata:${JSON.stringify({ reasoning_content: piece })}\n\n`)
  }
  if (upstream.text !== undefined) {
    events.push(`event:output\ndata:${JSON.stringify({ response: upstream.text })}\n\n`)
  }
  if (upstream.tool) {
    events.push(`event:output\ndata:${JSON.stringify({
      tool_calls: [{
        index: 0,
        id: 'call_read_1',
        function: { name: 'read', arguments: '{"file_path":"a.ts"}' },
      }],
    })}\n\n`)
  }
  events.push(`event:done\ndata:${JSON.stringify({ finish_reason: upstream.finish })}\n\n`)
  return events.join('')
}

/**
 * qoder 的**加密端点信封**形态：每帧多一层 `{headers, body, statusCode…}`，
 * 内层 `body` 是标准 OpenAI chunk 的 **JSON 字符串**（未加密）。
 *
 * ⚠️ 内层必须含 `"choices"`，否则 `unwrapQoderEnvelopeStream` 会把整帧
 * 当成业务错误（见 `src/qoder-envelope.ts` 的判据）。
 */
function qoderEnvelopeFrames(upstream: Upstream): string {
  const inner: string[] = []
  for (const piece of upstream.reasoning ?? []) {
    inner.push(JSON.stringify({ choices: [{ delta: { reasoning_content: piece } }] }))
  }
  if (upstream.text !== undefined) {
    inner.push(JSON.stringify({ choices: [{ delta: { content: upstream.text } }] }))
  }
  if (upstream.tool) {
    inner.push(JSON.stringify({ choices: [{ delta: openAiToolCallDelta() }] }))
  }
  inner.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: upstream.finish }] }))
  return inner
    .map((body) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('') + 'data: [DONE]\n\n'
}

// ────────────────────────────────────────────────────────────────────────────
// 真实适配器
// ────────────────────────────────────────────────────────────────────────────

/** 收集异步 chunk 流。 */
async function drain(stream: AsyncIterable<unknown>): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const chunk of stream) out.push(chunk as Chunk)
  return out
}

/** 每帧一次 `pull` 的响应：`reader.read()` 逐帧到达（与线上一致，含跨读拆帧）。 */
function streamedResponse(sse: string): Response {
  const bytes = new TextEncoder().encode(sse)
  let offset = 0
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
function collectQoder(sse: string): Promise<Chunk[]> {
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
    // ⚠️ 目录 key `qfmodel` 即 **Qwen3.8-Flash**（加密端点认的是目录 key）。
    model: 'qfmodel',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as never))
}

/** buddy / workbuddy：真实 `BuddyAdapter`（用户实际报障路径）。 */
function collectBuddy(sse: string): Promise<Chunk[]> {
  const adapter = new BuddyAdapter({
    credentialRef: 'TEST_REF' as never,
    resolveCredential: async () => ({ access_token: 'stub', refresh_token: 'stub', expires_at: 0 }) as never,
    refresh: async () => {},
    product: WORKBUDDY,
    fetchImpl: (async () => streamedResponse(sse)) as never,
  })
  return drain(adapter.stream({ model: 'deepseek-v4.1-flash', messages: [] } as never))
}

/** lobsterai：真实 `LobsteraiAdapter`（OpenAI 格式，帧形态同上）。 */
function collectLobsterai(sse: string): Promise<Chunk[]> {
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
    provider: 'lobsterai', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '你好' }],
  } as unknown as GenerateOptions))
}

/**
 * codearts：真实 `CodeArtsAdapter`。
 *
 * 凭据用**永不过期**的桩值（否则 `stream()` 会先走 `refresh()` 拿到
 * `undefined` 凭据并抛 MISSING_CREDENTIAL）。
 */
function collectCodeArts(sse: string): Promise<Chunk[]> {
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
function collectTrae(sse: string): Promise<Chunk[]> {
  const adapter = new TraeAdapter({
    credentialRef: 'TRAE_ACCESS_TOKEN' as never,
    resolveCredential: async () => ({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1', nickname: '测试账号',
      machine_id: 'a'.repeat(32), device_id: 'c'.repeat(32),
    }) as never,
    refresh: async () => {},
    fetchImpl: (async () => streamedResponse(sse)) as never,
    product: TRAE,
  })
  return drain(adapter.stream({
    model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '你好' }],
  } as unknown as GenerateOptions))
}

/** 五个适配器各自的帧形态 + 收集入口。 */
const ADAPTERS: ReadonlyArray<{
  name: string
  frames: (upstream: Upstream) => string
  collect: (sse: string) => Promise<Chunk[]>
}> = [
  { name: 'qoder / openai-compat', frames: qoderEnvelopeFrames, collect: collectQoder },
  { name: 'buddy / workbuddy', frames: openAiFrames, collect: collectBuddy },
  { name: 'lobsterai', frames: openAiFrames, collect: collectLobsterai },
  { name: 'codearts', frames: openAiFrames, collect: collectCodeArts },
  { name: 'trae', frames: traeFrames, collect: collectTrae },
]

// ────────────────────────────────────────────────────────────────────────────
// chunk 层面的窄化工具（全部按「会真的落进 assistant 消息」的形态取）
// ────────────────────────────────────────────────────────────────────────────

/** 全部 `block-start`（不论 `blockType`）。 */
function blockStarts(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((chunk) => chunk.type === 'block-start')
}

/**
 * reasoning 的 `block-start`。
 *
 * 这正是「空 Think 块」的**起点**：只要发了它，`BlockAssembler` 就会为这个
 * `index` 建 partial；即便后续一个 `block-end` 都没有，收尾 `assemble()` 也会
 * 用 `partial.text`（那个空格）组装出块。
 */
function reasoningStarts(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning')
}

/** 全部 `reasoning-delta`（UI 里流式滚动的思考文本）。 */
function reasoningDeltas(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((chunk) => chunk.type === 'reasoning-delta')
}

/** 全部 `block-end`，不论块类型。 */
function blockEnds(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((chunk) => chunk.type === 'block-end')
}

/** 指定块类型的 `block-end` 的 `block` 载荷。 */
function finishedBlocks(chunks: readonly Chunk[], blockType: 'text' | 'reasoning' | 'tool-call'): Chunk[] {
  const out: Chunk[] = []
  for (const chunk of chunks) {
    if (chunk.type !== 'block-end') continue
    const block = chunk.block
    if (typeof block !== 'object' || block === null) continue
    const record = block as Chunk
    if (record.type === blockType) out.push(record)
  }
  return out
}

/**
 * 纯空白思考的**完整判据**：整个 chunk 列表里不得出现任何「会形成块」的 chunk。
 *
 * 四条缺一不可：
 * 1. reasoning `block-start` 为空 —— 本任务的核心；
 * 2. **`block-start` 总数为 0** —— 否则空块可以借 text / tool-call 的
 *    `blockType` 混进来（只断言 ① 抓不到这种混入）；
 * 3. `reasoning-delta` 为空 —— 不能让思考文本以「无块增量」的形式漏出；
 * 4. `block-end` 为空 —— 空的 reasoning 块不得被显式收尾。
 */
function expectZeroChunks(chunks: readonly Chunk[]): void {
  // 先钉住「流确实跑完了」：否则一个什么都不产的适配器会让下面四条断言
  // 全部**空真**（vacuous）—— 那是恒真断言，不是回归保护。
  expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  expect(reasoningStarts(chunks)).toEqual([])
  expect(blockStarts(chunks)).toEqual([])
  expect(reasoningDeltas(chunks)).toEqual([])
  expect(blockEnds(chunks)).toEqual([])
}

// ────────────────────────────────────────────────────────────────────────────
// 用例
// ────────────────────────────────────────────────────────────────────────────

describe.each(ADAPTERS)('纯空白思考零 chunk（$name）', ({ frames, collect }) => {
  /** 用该适配器的真实帧形态跑一个场景。 */
  const run = (scenario: Scenario): Promise<Chunk[]> => collect(frames(UPSTREAM[scenario]))

  /**
   * A：**本任务的核心判据**。上游只给了一个空格当思考。
   *
   * 变异测试自证：把任一适配器的接线退回「发 `block-start` 但不发 `block-end`」
   * （即绕过 suppressor、直接把原始增量当 emit），本用例**必然失败** ——
   * 而 `empty-response.spec.ts` 里那条「仅一个空格」的用例**仍然通过**
   * （它只断言 `block-end` 为空与末 chunk 的 finish）。本用例存在的唯一理由
   * 就是补上这个缺口。
   */
  it('A. 仅一个空格的 reasoning → 零 chunk（连 block-start 都不发）', async () => {
    expectZeroChunks(await run('A'))
  })

  /**
   * B：多片空白（`[' ', ' ', '  ']`）。
   *
   * 与 A 的差别在**判据路径**：A 只有一次 `feed`，B 会走三次「迄今仍空白 ⇒
   * 不发射」的分支。若把 suppressor 的 `emitting` 状态写错（例如第一片之后
   * 就置为 true），B 会失败而 A 不一定。
   */
  it('B. 多片纯空白 reasoning 累积 → 仍然零 chunk', async () => {
    expectZeroChunks(await run('B'))
  })

  /**
   * C：空白之后**转正** —— 必须补发已累积文本（含前导空格）。
   *
   * ⚠️ 用 `toBe` 精确相等，不用 `toContain`：后者抓不到「前导空格丢失」，
   * 而补发语义的全部意义正在于「此前一片都没发过，必须把整段补上」。
   *
   * ⚠️ 本用例**也会**被「吞掉所有思考」类变异打掉（它断言 start 恰好为 1）——
   * 故它**不能**与 D 互相替代：C 覆盖「前导空白被保留」，D 覆盖
   * 「首片即非空白时原样不改」（详见 D 的注释里那张实测表）。
   */
  it('C. 空白后转正 → 补发已累积文本（含前导空格）', async () => {
    const chunks = await run('C')
    // 判别力①：恰好一个 reasoning block-start（不能是 0 —— 那就把正常思考也吞了）。
    expect(reasoningStarts(chunks)).toHaveLength(1)
    // 判别力②：增量文本就是**已累积的全部文本**（补发，而非只发本片）。
    const deltas = reasoningDeltas(chunks)
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe(REASONING_TEXT_WITH_LEADING_BLANK)
    // 判别力③：落块的文本与前导空格完全一致（`toContain` 会漏掉丢空格的情形）。
    const blocks = finishedBlocks(chunks, 'reasoning')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(REASONING_TEXT_WITH_LEADING_BLANK)
  })

  /**
   * D：对照组 —— 正常（非空白）思考的**行为不变**。
   *
   * ⚠️ **本注释只写实测事实**（先前两版论证均被实验证伪，记录如下以免重蹈）：
   *
   * | 曾被写进注释的断言 | 变异 | 实测 | 结论 |
   * |---|---|---|---|
   * | 「没有 D，把 `feed` 写成永远返回 `undefined` 也能让 A/B/C 全绿」 | `feed` 恒返回 `undefined` | `C:5 D:5` | ❌ **C 也失败**（C 断言「恰好 1 个 block-start」） |
   * | 「首片即非空白也拒发 ⇒ 只有 D 失败」 | `feed` 首片一律拒发 | `C:5 D:5` | ❌ **C 也失败** |
   * | 「转正文本写错 ⇒ 只有 D 失败」 | 转正返回多前导/尾随空格 | `C:5~6 D:5~6` | ❌ **C 也失败** |
   *
   * **规律**：C（`[' ', '我需要确认契约。']`）与 D（`['我需要确认契约。']`）
   * **都经过 `feed` 的「转正」分支**（C 的第二片、D 的首片），
   * 故对 `feed` 的任何语义变异都会**同时**打掉两者 ——
   * 本项目用四次变异实测确认：**无法构造只打 D 的变异**。
   *
   * 那 D 为何仍不可删？它锁的是**契约的另一面**：
   * C 只覆盖「前导空白**被保留**」（`' ' + 文本`），而 D 覆盖
   * 「首片即非空白时**不做任何增删**」（`文本` 原样）。
   * 若将来有人把「首片非空白」与「转正补发」拆成两条分支并把首片语义改错
   * （例如误加前导空格 / 误 trim），**D 会失败而 C 不一定** ——
   * 因为 C 的首片是空白、不走首片非空白那条新分支。
   * 这正是「断言写足值、不用 `toContain`」的价值：`toContain` 抓不到增删。
   */
  it('D. 正常思考 → 1 个 block-start + 1 个 block-end，文本原样', async () => {
    const chunks = await run('D')
    expect(reasoningStarts(chunks)).toHaveLength(1)
    // 首片即非空白 ⇒ 增量就是本片原文（不补发、不裁剪）。
    const deltas = reasoningDeltas(chunks)
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe(REASONING_TEXT)
    const blocks = finishedBlocks(chunks, 'reasoning')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(REASONING_TEXT)
  })

  /**
   * E：空白思考与正文**共存** —— 正文一个字符都不能少。
   *
   * 钉的是「压制只作用于 reasoning 通道，绝不外溢到 text 通道」：
   * `delta.content` 与 `delta.reasoning_content` 在同一次响应里是独立字段，
   * 若把 suppress 的判据误用在正文分片上，正文会被整段吞掉。
   */
  it('E. 空白思考 + 正文共存 → 正文完整、无 reasoning 块', async () => {
    const chunks = await run('E')
    const texts = finishedBlocks(chunks, 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0].text).toBe('正文内容')
    // 空思考既不得建块，也不得留下任何 reasoning 痕迹。
    expect(reasoningStarts(chunks)).toEqual([])
    expect(reasoningDeltas(chunks)).toEqual([])
    expect(finishedBlocks(chunks, 'reasoning')).toEqual([])
  })

  /**
   * F：空白思考与工具调用**共存** —— 工具不受影响。
   *
   * `finish` 为 `tool-calls` 只是辅助判据（归类本身由 `empty-response.spec.ts`
   * 覆盖）；这里真正的判据是「工具 `block-end` 正常」+「无 reasoning 块」——
   * 若抑制逻辑误伤 tool-call 分支（例如 `continue` 落错位置、或把工具块当成
   * 待抑制的块），harness 会收到一个不可执行的空工具调用。
   */
  it('F. 空白思考 + 工具调用共存 → 工具正常、无 reasoning 块', async () => {
    const chunks = await run('F')
    const tools = finishedBlocks(chunks, 'tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('read')
    expect(tools[0].arguments).toBe('{"file_path":"a.ts"}')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    // 工具存在**不是**放弃核心判据的理由：空白思考照样不许建块。
    expect(reasoningStarts(chunks)).toEqual([])
    expect(finishedBlocks(chunks, 'reasoning')).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// codearts 的**第二条** reasoning 出口（出口①：`<thought>` → `emitDsmlFeed`）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 上面那组 `describe.each(ADAPTERS)` 对 codearts 走的是 `openAiFrames`
 * ⇒ **只覆盖出口②**（`delta.reasoning_content`）。
 *
 * 本组专门补**出口①**（`delta.content` 里的 `<thought>`）。审查（C1）实测：
 * 出口① 若退回「无条件建块 + 发 chunk」的朴素接线，`<thought> </thought>`
 * 会产出 `block-start(reasoning) + delta(' ') + block-end(' ')`，
 * 经 `BlockAssembler` 组装成
 * `[{reasoning,text:' '},{text,text:' '}]` —— **空 Think 块回来了**，
 * 而 `blank-reasoning-adapter.spec.ts`（当时的版本）、`empty-response.spec.ts`、
 * `llm-adapter.spec.ts`、`reasoning-loop-adapter.spec.ts` **全部静默通过**。
 *
 * 项目自身把出口① 视为必须单列的路径 —— 见
 * `tests/unit/reasoning-loop-adapter.spec.ts` 里为它专写的用例。
 */
describe('codearts 出口①（<thought>）的纯空白思考', () => {
  /**
   * A'：`<thought> </thought>` —— 出口① 的「一个空格当思考」形态。
   *
   * 与 A 同判据（`expectZeroChunks` 的四条），但走的是**另一条代码路径**：
   * A 由 `delta.reasoning_content` 分支处理，A' 由 `DsmlContentExtractor`
   * 解析后再进 `emitDsmlFeed` 的 `reasoning` 参数。
   */
  it("A'. 空 <thought> → 零 chunk（连 block-start 都不发）", async () => {
    expectZeroChunks(await collectCodeArts(codeartsThoughtFrames([' '])))
  })

  /** B'：多片空 `<thought>`（跨帧）—— 同 A' 的判据，覆盖多次 `feed`。 */
  it("B'. 多片空 <thought> → 仍然零 chunk", async () => {
    expectZeroChunks(await collectCodeArts(codeartsThoughtFrames([' ', '  '])))
  })

  /**
   * C'：空白后转正 —— 必须补发已累积文本（含前导空格）。
   *
   * ⚠️ 出口① 的「转正」形态里，`<thought>` 之外没有正文，故 `visible` 回退
   * 会把推理文本也填进 text 块（既有设计）—— 因此本用例**只断言 reasoning
   * 那一路**，不涉及 text 块的数量，避免把回退行为当成缺陷。
   */
  it("C'. 空 <thought> 后转正 → 补发已累积文本（含前导空格）", async () => {
    const chunks = await collectCodeArts(codeartsThoughtFrames([' ', REASONING_TEXT]))
    expect(reasoningStarts(chunks)).toHaveLength(1)
    const deltas = reasoningDeltas(chunks)
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe(REASONING_TEXT_WITH_LEADING_BLANK)
    const blocks = finishedBlocks(chunks, 'reasoning')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(REASONING_TEXT_WITH_LEADING_BLANK)
  })

  /** D'：对照组 —— 出口① 的正常思考行为不得被本次修复改变。 */
  it("D'. 正常 <thought> → 1 个 block-start，文本原样", async () => {
    const chunks = await collectCodeArts(codeartsThoughtFrames([REASONING_TEXT]))
    expect(reasoningStarts(chunks)).toHaveLength(1)
    const deltas = reasoningDeltas(chunks)
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe(REASONING_TEXT)
    const blocks = finishedBlocks(chunks, 'reasoning')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(REASONING_TEXT)
  })
})
