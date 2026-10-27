/**
 * Accio（阿里）**对话**探针 —— 真发一条极小请求，**消耗积分**。
 *
 * ## 验证什么（单测证明不了的远端事实）
 *
 * 1. 令牌（放在 **body 的 `token` 字段**）在 `/api/adk/llm/generateContent` 上有效；
 * 2. 响应是 **Accio 自定义 SSE**（顶层 `content.parts` + `usage_metadata`）；
 * 3. ⚠️⚠️ **`consumeAccioSse` 能识别流内错误帧**（`error_code` 非 `'200'`）；
 * 4. 端到端能拿到**非空正文**（`content.parts[].text`）。
 *
 * 闸门：`DSH_ACCIO_CHAT_E2E=1` **且** `DSH_ACCIO_CHAT_E2E_CONFIRM=yes`
 * （双重闸门 —— 本用例**会消耗积分**）。
 *
 * ## ⚠️⚠️ 判「成功」不能只看 HTTP 200（本文件最重要的一条）
 *
 * 实测：把 token 放进 `Authorization` 头而不是 body 时，上游**恒**回
 * `HTTP 200` + 流内 `{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}`。
 * 只看状态码会把**认证/额度失败**读成「成功但模型没吐字」。
 *
 * ⇒ 本探针**三条判据同时成立**才算通过：
 *   ① HTTP 200；
 *   ② 原始帧里**有** `content.parts` 且其中有非空 `text`；
 *   ③ 原始帧里**没有**任何非 `'200'` 的 `error_code`（`'200'` 是成功哨兵，实测正常帧也带）。
 *
 * 并且**不 catch** `consumeAccioSse` 抛出的 `LlmError`：`src/accio-messages.ts`
 * 对流内 402 抛的是字面量码 `'QUOTA_EXCEEDED'`，让它传播出去、断言它的码，
 * 而不是吞掉它 —— 吞掉就把「额度/认证失败」降级成「模型没返回内容」。
 *
 * ## ⚠️ 模型选型：必须是最便宜的那个
 *
 * 默认 `ACCIO.fallbackModels[0]`（`1Drift-N8kP2Q7wR5mX`，倍率 **0.013**，
 * 实测全目录最低）。可用 `ACCIO_PROBE_MODEL` 覆盖，但：
 * - **未知 id 直接拒绝**（id 形如 `1Drift-N8kP2Q7wR5mX`，非人类可读，写错会得到
 *   一个与账号无关的 404，把「模型名不对」与「账号不可用」混成一条报错）；
 * - 倍率高于 `EXPENSIVE_MULTIPLE`（x0.2）的模型需要**额外显式 opt-in**
 *   （`ACCIO_PROBE_ALLOW_EXPENSIVE=1`）—— 沿用 cline 探针的「付费保护」形态。
 *
 * ## ⚠️ 为什么 `maxOutputTokens` 不压到 64
 *
 * Accio **关不掉思考**（实测 `includeThoughts` / `thinkingBudget` / `thinkingLevel` /
 * `reasoningEffort` 四类字段全部无效，见 `src/accio-adapter.ts` 文件头）。
 * 实测短回答的思考约 150 token ⇒ 预算 64 会被思考**吃满**、正文零产出
 * （正是 `session-title.ts` 记录的那个缺陷形态，会得到**假阴性**）。
 * ⇒ 取 256：思考够用 + 正文几个字，已是「尽量小」的实用下限。
 */

import { describe, expect, it } from 'vitest'
import {
  ACCIO,
  ACCIO_LLM_PATH,
  ACCIO_REQUEST_TIMEOUT_MS,
  type AccioFallbackModel,
} from '../../src/accio-product.js'
import {
  accioHeaders,
  accioRequestId,
  accioSgK,
  buildAccioBody,
  type AccioCredential,
} from '../../src/accio.js'
import { consumeAccioSse, serializeAccioMessages, toAccioTools } from '../../src/accio-messages.js'
import { accioModelIdOf, toAccioWireMessages } from '../../src/accio-adapter.js'
// ⚠️ 复用既有的通用凭据读取（见 `accio-probe.e2e.spec.ts` 的同一段说明）。
import { credentialFor, enabledAccountRef } from './image-probe-shared.js'

const RUN = process.env.DSH_ACCIO_CHAT_E2E === '1'
  && process.env.DSH_ACCIO_CHAT_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 实测全目录最低倍率的模型（`ACCIO.fallbackModels[0]`）。 */
const CHEAPEST: AccioFallbackModel = ACCIO.fallbackModels[0]!

/**
 * 允许不经额外 opt-in 就请求的倍率上限。
 *
 * 最便宜的是 0.013；0.2 已是它的 **15 倍**，再往上就该由人显式确认了。
 */
const EXPENSIVE_MULTIPLE = 0.2

/** 显式允许请求高倍率模型（沿用 cline 探针的 opt-in 形态）。 */
const ALLOW_EXPENSIVE = process.env.ACCIO_PROBE_ALLOW_EXPENSIVE === '1'

/** 设备标识：实测上游不校验它。 */
const PROBE_UTDID = 'accio-e2e-probe-chat'

/**
 * 解析被测模型：默认最便宜的那个；覆盖值必须是**已知模型**，
 * 且倍率超限时要显式 opt-in。
 *
 * ⚠️ **覆盖值同时接受「对外 id（slug）」与「上游 `modelCode`」**（2026-10-13）：
 * 对外 id 自该日起改成了 slug（`qwen-3-8-27b`），而本探针**自己发裸 fetch**、
 * 上行必须用 `modelCode` ⇒ 两种写法都在这里认掉，避免用户照着模型选择器里的
 * 名字（slug）写进来却被拒。
 */
function resolveProbeModel(): AccioFallbackModel {
  const override = process.env.ACCIO_PROBE_MODEL
  if (override === undefined || override === '') return CHEAPEST
  const known = ACCIO.fallbackModels.find(
    (m) => m.id === override || accioModelIdOf(m) === override,
  )
  // ⚠️ 拒绝未知 id（不是「回落到默认」）：静默回落会让「我想测 A」变成「其实测了 B」，
  // 而两者的倍率可能差 200 倍。
  expect(
    known,
    `ACCIO_PROBE_MODEL=${override} 不在已知模型表里（写错会得到与账号无关的 404）。`
    + `可写对外 id（${ACCIO.fallbackModels.map((m) => accioModelIdOf(m)).join(', ')}）`
    + `或上游 modelCode（${ACCIO.fallbackModels.map((m) => m.id).join(', ')}）。`,
  ).toBeDefined()
  const model = known!
  const multiple = model.multiple ?? 0
  if (multiple > EXPENSIVE_MULTIPLE) {
    expect(
      ALLOW_EXPENSIVE,
      `⚠️ ACCIO_PROBE_MODEL=${override} 的倍率是 x${multiple}（最便宜的只有 `
      + `x${CHEAPEST.multiple}）。确实要按这个价测，请显式设置 `
      + 'ACCIO_PROBE_ALLOW_EXPENSIVE=1。',
    ).toBe(true)
  }
  return model
}

/** 读取账号池里已登录的 Accio 凭据；**惰性**（见 accio-probe 的同名说明）。 */
let cachedStored: AccioCredential | undefined | null = null

function storedCredential(): AccioCredential | undefined {
  if (cachedStored === null) {
    try {
      const parsed = credentialFor(enabledAccountRef(ACCIO.id)) as unknown as AccioCredential
      cachedStored = typeof parsed.access_token === 'string' && parsed.access_token !== ''
        ? parsed
        : undefined
    } catch {
      cachedStored = undefined
    }
  }
  return cachedStored
}

/** 一帧原始报文里与「成功 / 失败」有关的部分。 */
interface RawFrame {
  error_code?: unknown
  error_message?: unknown
  content?: { parts?: Array<{ text?: unknown; thought?: unknown }> }
}

/** 解析原始 SSE 文本成帧（跳过注释心跳与 `[DONE]`）。 */
function parseRawFrames(text: string): RawFrame[] {
  const frames: RawFrame[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      frames.push(JSON.parse(payload) as RawFrame)
    } catch {
      // 非 JSON 帧（实测不存在）：忽略，不影响两条核心判据。
    }
  }
  return frames
}

/**
 * 发一次推理请求，同时拿到**原始帧**与**消费器产出**。
 *
 * `response.body.tee()` 让同一次请求既被原样读下来（供「有无 error_code /
 * 有无 content.parts 文本」两条判据用），又走真实的 `consumeAccioSse`
 * —— **一个 HTTP 请求，两条证据链**，不额外花额度。
 */
async function chatOnce(options: {
  credential: AccioCredential
  model: string
  messages: readonly unknown[]
  tools?: readonly unknown[]
  maxOutputTokens: number
}): Promise<{
  frames: RawFrame[]
  text: string
  reasoning: string
  /** `usage` chunk 的用量（上游未下发时是 `undefined`）。 */
  usage: unknown
  error: unknown
}> {
  const requestId = accioRequestId()
  const wire = toAccioWireMessages(
    options.messages as readonly { role: string; content?: unknown }[],
  )
  const { contents, systemInstruction } = serializeAccioMessages(wire)
  const body = buildAccioBody({
    model: options.model,
    accessToken: options.credential.access_token,
    contents,
    systemInstruction,
    tools: toAccioTools(options.tools ?? []),
    maxOutputTokens: options.maxOutputTokens,
    utdid: PROBE_UTDID,
    requestId,
  })
  const response = await fetch(
    `${ACCIO.gatewayBaseUrl}${ACCIO_LLM_PATH}?sg_k=${accioSgK(requestId)}`,
    {
      method: 'POST',
      headers: accioHeaders({
        utdid: PROBE_UTDID,
        ...options.credential.sgcookie === undefined ? {} : { sgcookie: options.credential.sgcookie },
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
    },
  )
  expect(response.status, `HTTP ${response.status}`).toBe(200)
  expect(response.body, '响应没有 body').not.toBeNull()

  // ⚠️ 两条分支必须**同时**读：tee 的一支不读会因背压把另一支卡死。
  const [forConsumer, forRaw] = response.body!.tee()
  const rawPromise = new Response(forRaw).text()

  const text: string[] = []
  const reasoning: string[] = []
  let usage: unknown
  let error: unknown
  try {
    for await (const chunk of consumeAccioSse({ body: forConsumer })) {
      if (chunk.type === 'text-delta') text.push(chunk.text)
      else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
      else if (chunk.type === 'usage') usage = chunk.usage
    }
  } catch (caught) {
    // ⚠️ 这里**刻意不吞**：流内 402 抛的是 `LlmError`（码为字面量
    // `'QUOTA_EXCEEDED'`），由调用方断言它的码。吞掉就把它降级成
    // 「模型没返回内容」，正是本探针要防的误判。
    error = caught
  }
  const rawText = await rawPromise
  return {
    frames: parseRawFrames(rawText),
    text: text.join(''),
    reasoning: reasoning.join(''),
    usage,
    error,
  }
}

/**
 * 两条**共用**的流内判据（chat 与 tools 两个探针同款，防止只改一侧）。
 *
 * @param frames - 原始帧。
 * @param error - `consumeAccioSse` 抛出物（正常为 `undefined`）。
 */
function assertNoInStreamError(frames: RawFrame[], error: unknown): void {
  // ⚠️ **先判消费器抛出的错误**：流内 402 抛的是 `LlmError`，**码是字面量
  // `'QUOTA_EXCEEDED'`**（不是 harness 的 `QUOTA_EXCEEDED_CODE`，其字面值是
  // `'QUOTA'`，会被客户端换成固定文案 ⇒ 丢掉上游原文）。
  //
  // ⚠️ **绝不 catch-and-rewrap**：重包会丢掉额度语义、把它降级成「模型没返回内容」。
  // 这里**断言码的字面量**（让「额度失败」与「其它失败」在报告里可区分），再原样抛出。
  //
  // ⚠️ **必须是字面量比对，不能用 `toBeTruthy()`**：`toBeTruthy()` 对**任何**码都通过
  // （含被误改成 harness 常量 `'QUOTA'` 的那种），恰好漏掉本条判据要抓的缺陷
  // （见 `src/accio-messages.ts` 的 `ACCIO_QUOTA_EXCEEDED_CODE`，其字面值即
  // `'QUOTA_EXCEEDED'`，已在源码中核对）。
  if (error !== undefined) {
    const code = (error as { code?: unknown }).code
    const message = error instanceof Error ? error.message : String(error)
    expect(
      String(code),
      `⚠️ 消费器抛出的错误码必须是字面量 'QUOTA_EXCEEDED'（harness 常量 QUOTA_EXCEEDED_CODE 的字面值是 'QUOTA'，`
      + `会被客户端换成固定文案、丢掉上游原文）。服务端原文：${message}`,
    ).toBe('QUOTA_EXCEEDED')
    // 断言过了 ⇒ 码正是额度码 ⇒ 原样抛出，保留 `LlmError` 的全部语义（含服务端原文）。
    throw error
  }
  const offenders = frames.filter(
    (f) => f.error_code !== undefined && String(f.error_code) !== '200',
  )
  expect(
    offenders.map((f) => `error_code=${String(f.error_code)} ${String(f.error_message ?? '')}`),
    '⚠️ 流内错误帧（HTTP 200 但业务失败 —— 只判状态码会误读成「成功但没内容」）',
  ).toEqual([])
}

/** 断言原始帧里**确实**有 `content.parts` 且有非空 `text`。 */
function assertWireHasText(frames: RawFrame[]): void {
  const textParts = frames
    .flatMap((f) => f.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && p.text !== '')
  expect(
    textParts.length,
    '原始帧里没有 `content.parts[].text`（模型没吐正文）',
  ).toBeGreaterThan(0)
}

suite('Accio 对话探针（消耗积分；默认最低倍率模型）', () => {
  it('发一条极小请求：拿到正文，且流内无 error_code', async () => {
    const credential = storedCredential()
    expect(
      credential,
      '未找到 Accio 凭据。请先在 Jet Hub 的 Accio 面板登录一个账号。',
    ).toBeDefined()
    if (credential === undefined) return

    const model = resolveProbeModel()
    console.log(`[accio-chat] model=${model.id}（${model.name}，x${String(model.multiple)}）`
      + `${model.id === CHEAPEST.id ? ' ← 全目录最低倍率' : ' ⚠️ 非最低倍率（ACCIO_PROBE_MODEL 覆盖）'}`)

    const result = await chatOnce({
      credential,
      model: model.id,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '只回复两个字：收到' }],
      }],
      // 见文件头：Accio 关不掉思考，64 会被思考吃满 ⇒ 256 是实用下限。
      maxOutputTokens: 256,
    })

    // ── 判据 ② ③：原始帧必须有正文、且不得有非 200 的 error_code ──
    assertNoInStreamError(result.frames, result.error)
    assertWireHasText(result.frames)

    // ── 判据：消费器端到端产出非空正文 ──
    expect(
      result.text.length,
      `消费器没有产出可见正文（思考 ${result.reasoning.length} 字）。`
      + '若思考把预算吃满，会表现为正文为空 —— 那是预算问题而非协议问题。',
    ).toBeGreaterThan(0)

    console.log(`[accio-chat] 正文=${JSON.stringify(result.text.slice(0, 40))}`
      + ` 思考=${result.reasoning.length} 字 原始帧=${result.frames.length}`
      + ` usage=${result.usage === undefined ? '（未下发）' : JSON.stringify(result.usage)}`)
  }, 120_000)
})
