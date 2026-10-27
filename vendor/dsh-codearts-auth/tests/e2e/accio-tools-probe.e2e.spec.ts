/**
 * Accio（阿里）**工具调用 + 思考链分离**探针 —— **消耗积分**。
 *
 * ## 为什么必须有这个探针
 *
 * AGENTS.md 记录过两次**同型真实缺陷**（Qoder、TRAE）：适配器没把 `tools`
 * 发出去，模型只能在**正文里用 XML 文本**臆造工具调用，harness 认不出 ⇒ 任务终止。
 * 两次的根因都**不是「服务端不支持」**，而是**插件没把 tools 发出去**。
 * ⇒ 判据必须落在**结构化 `tool_calls`** 上，而不是「模型在正文里说它想调用某工具」
 * —— 后者恰恰是缺陷的形态。
 *
 * Accio 还有**第三个**独有风险（`src/accio-adapter.ts` 文件头第 2 条）：
 * 上游把**一次**调用拆成多帧（首帧 `{id,name}` 无参数，后续帧**重复完整的**
 * `args_json`），而共享消费者对每个 `functionCall` part 各产出一个**独立**块
 * ⇒ 不合并就是「一次调用变成 N 个块、harness 执行 N 次，首个参数还是 `{}`」。
 * 合并由 `accioToolCallMergeTransform` 承担 ⇒ 本探针**必须**断言合并真的生效：
 * **同一个 id 只允许出现一个块，且参数不是空对象**。
 *
 * ## 四组判据
 *
 * 1. **工具往返**：带 `tools` 的请求返回结构化 `tool-call` 块；把结果回传后
 *    能拿到最终正文（第二次请求）；
 * 2. **⚠️ 合并生效**：同一次调用**恰好一个**块，且 `arguments` 解析出的对象
 *    **带上了期望的键**（未合并会得到「多块 + 首块 `{}`」）；
 * 3. **不是正文里的 XML**：可见正文里不得出现 `<tool_call>` / `<function` 之类
 *    的伪工具调用文本；
 * 4. **思考链分离**：原始帧里 `thought: true` 的 part 必须**只**进 `reasoning`，
 *    非 `thought` 的 part 必须**只**进正文 —— 两侧逐字对账（不是「都非空」这种弱断言）。
 *
 * ## ⚠️⚠️ 判「成功」不能只看 HTTP 200
 *
 * 与 `accio-chat-probe` 同款：实测认证/额度失败是
 * `HTTP 200` + 流内 `{"error_code":"402","error_message":"unauthorized"}`。
 * ⇒ 每条判据都**先**查「原始帧里没有非 `'200'` 的 `error_code`」，**再**查内容；
 * 且**不 catch** `consumeAccioSse` 抛出的 `LlmError`（流内 402 抛的是字面量码
 * `'QUOTA_EXCEEDED'`）—— 让它带着原文冒出来。
 *
 * 闸门：`DSH_ACCIO_TOOLS_E2E=1` **且** `DSH_ACCIO_TOOLS_E2E_CONFIRM=yes`。
 * 模型选型与「付费保护」沿用 `accio-chat-probe`（默认最低倍率 `x0.013`，
 * 可用 `ACCIO_PROBE_MODEL` 覆盖，倍率超 x0.2 需 `ACCIO_PROBE_ALLOW_EXPENSIVE=1`）。
 *
 * ⚠️ 本文件刻意**自带**一份与 chat 探针同款的小工具（凭据读取 / 原始帧解析 /
 * 两条共用判据），而**不** import 另一个 spec —— 跨 spec 的 import 会把对方的
 * `describe` 一起注册进本次运行（`vitest run <本文件>` 时会多出一组不属于它的用例）。
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
import { accioToolCallMergeTransform, toAccioWireMessages } from '../../src/accio-adapter.js'
// ⚠️ 复用既有的通用凭据读取（见 `accio-probe.e2e.spec.ts` 的同一段说明）。
import { credentialFor, enabledAccountRef } from './image-probe-shared.js'

const RUN = process.env.DSH_ACCIO_TOOLS_E2E === '1'
  && process.env.DSH_ACCIO_TOOLS_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 实测全目录最低倍率的模型。 */
const CHEAPEST: AccioFallbackModel = ACCIO.fallbackModels[0]!
/** 不经额外 opt-in 就允许请求的倍率上限（最便宜的是 0.013）。 */
const EXPENSIVE_MULTIPLE = 0.2
const ALLOW_EXPENSIVE = process.env.ACCIO_PROBE_ALLOW_EXPENSIVE === '1'
const PROBE_UTDID = 'accio-e2e-probe-tools'

/** 一个明显的工具：模型没理由不用它回答问题。 */
const WEATHER_TOOL = {
  name: 'get_weather',
  description: '查询指定城市的当前天气。回答天气问题前必须先调用它。',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名，如「北京」' } },
    required: ['city'],
  },
} as const

/** 解析被测模型（未知 id 直接拒绝；高倍率需显式 opt-in）。 */
function resolveProbeModel(): AccioFallbackModel {
  const override = process.env.ACCIO_PROBE_MODEL
  if (override === undefined || override === '') return CHEAPEST
  const known = ACCIO.fallbackModels.find((m) => m.id === override)
  expect(
    known,
    `ACCIO_PROBE_MODEL=${override} 不在已知模型表里（id 非人类可读，写错会得到与账号无关的 404）。`,
  ).toBeDefined()
  const model = known!
  if ((model.multiple ?? 0) > EXPENSIVE_MULTIPLE) {
    expect(
      ALLOW_EXPENSIVE,
      `⚠️ ACCIO_PROBE_MODEL=${override} 的倍率是 x${String(model.multiple)}`
      + `（最便宜的只有 x${String(CHEAPEST.multiple)}）。确实要按这个价测，`
      + '请显式设置 ACCIO_PROBE_ALLOW_EXPENSIVE=1。',
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

/** 一帧原始报文里与「成功 / 失败 / 思考分离」有关的部分。 */
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
      // 非 JSON 帧（实测不存在）：忽略。
    }
  }
  return frames
}

/**
 * 两条**共用**的流内判据（与 `accio-chat-probe` 逐条同款）。
 *
 * ⚠️ 判据必须在**读内容之前**跑：流内错误帧没有 `content`，先断言内容会得到
 * 一句「模型没吐正文」，把真正的额度/认证失败埋掉。
 */
function assertNoInStreamError(frames: RawFrame[], error: unknown): void {
  // ⚠️ **先判消费器抛出的错误**：流内 402 抛的是 `LlmError`，**码是字面量
  // `'QUOTA_EXCEEDED'`**（不是 harness 的 `QUOTA_EXCEEDED_CODE`，其字面值是
  // `'QUOTA'`，会被客户端换成固定文案 ⇒ 丢掉上游原文）。
  // ⚠️ **绝不 catch-and-rewrap**：重包会丢掉额度语义。这里**断言码的字面量**
  // （让「额度失败」与「其它失败」在报告里可区分），再原样抛出。
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

/** 消费器产出的一个内容块（只取本探针要判的两种）。 */
type ProbeBlock =
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: string }

/**
 * 发一次推理请求，走**真实的生产链路**（`accioToolCallMergeTransform` +
 * `consumeAccioSse`），同时用 `tee` 留下一份**原始帧**。
 *
 * ⚠️ 一个 HTTP 请求两条证据链，不额外花额度。
 */
async function callOnce(options: {
  credential: AccioCredential
  model: string
  messages: readonly unknown[]
  tools?: readonly unknown[]
  maxOutputTokens: number
}): Promise<{
  frames: RawFrame[]
  text: string
  reasoning: string
  blocks: ProbeBlock[]
  finishKind: string
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
    tools: toAccioTools((options.tools ?? []).map((tool) => {
      const t = tool as { name: string; description: string; parameters: Record<string, unknown> }
      return { type: 'function' as const, function: t }
    })),
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
  const blocks: ProbeBlock[] = []
  let finishKind = ''
  let error: unknown
  try {
    // ⚠️ **必须**经过合并变换：这是生产链路（`AccioAdapter.stream`）的形状。
    const merged = forConsumer.pipeThrough(accioToolCallMergeTransform())
    for await (const chunk of consumeAccioSse({ body: merged })) {
      if (chunk.type === 'text-delta') text.push(chunk.text)
      else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
      else if (chunk.type === 'block-end') blocks.push(chunk.block as ProbeBlock)
      else if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
  } catch (caught) {
    // ⚠️ 刻意不吞：流内 402 的 `LlmError`（码 `'QUOTA_EXCEEDED'`）由调用方断言。
    error = caught
  }
  const rawText = await rawPromise
  return {
    frames: parseRawFrames(rawText),
    text: text.join(''),
    reasoning: reasoning.join(''),
    blocks,
    finishKind,
    error,
  }
}

/** 取出全部工具调用块。 */
function toolCallBlocks(blocks: readonly ProbeBlock[]): Array<Extract<ProbeBlock, { type: 'tool-call' }>> {
  return blocks.filter(
    (b): b is Extract<ProbeBlock, { type: 'tool-call' }> => b.type === 'tool-call',
  )
}

/**
 * 正文里**不得**出现伪工具调用文本。
 *
 * 这正是 Qoder / TRAE 缺陷的形态：模型在正文里写 XML 说它想调用工具。
 * 判据刻意放宽到「标签名」级别（不同模型写法不同），只要求不出现这些标记。
 */
function assertNoXmlToolCall(text: string): void {
  const markers = ['<tool_call', '<tool_calls', '<function_call', '<function=', '</tool_call']
  const hit = markers.filter((m) => text.includes(m))
  expect(hit, `⚠️ 正文里出现伪工具调用文本 ${hit.join(' / ')}（Qoder/TRAE 缺陷的形态）`)
    .toEqual([])
}

suite('Accio 工具调用 + 思考链分离探针（消耗积分；默认最低倍率模型）', () => {
  it('工具往返：结构化 tool-call（合并后恰好一个，参数非空）+ 回传后拿到正文', async () => {
    const credential = storedCredential()
    expect(
      credential,
      '未找到 Accio 凭据。请先在 Jet Hub 的 Accio 面板登录一个账号。',
    ).toBeDefined()
    if (credential === undefined) return

    const model = resolveProbeModel()
    console.log(`[accio-tools] model=${model.id}（x${String(model.multiple)}）`)

    // ── 第一次请求：带 tools ──
    const first = await callOnce({
      credential,
      model: model.id,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '北京今天天气怎么样？请调用工具查询，不要凭记忆回答。' }],
      }],
      tools: [WEATHER_TOOL],
      maxOutputTokens: 512,
    })

    // ⚠️ 判据顺序：先查流内错误（错误帧没有 content），再查内容。
    assertNoInStreamError(first.frames, first.error)

    const calls = toolCallBlocks(first.blocks)
    console.log(`[accio-tools] 第一次请求：finish=${first.finishKind}`
      + ` 工具调用块=${calls.length}`
      + ` ${calls.map((c) => `${c.name}(${c.arguments.slice(0, 60)})`).join(' | ')}`
      + ` 正文=${JSON.stringify(first.text.slice(0, 60))} 思考=${first.reasoning.length} 字`)

    expect(
      calls.length,
      '❌ 端点未返回结构化 tool-call 块。\n'
      + '  若正文里出现 XML/标签，那正是 Qoder/TRAE 缺陷的形态（模型在正文里臆造工具调用）——\n'
      + '  不要采用「system prompt 注入 + 正文 XML 解析」的回退方案。\n'
      + `  正文实测：${first.text.slice(0, 300)}`,
    ).toBeGreaterThan(0)
    assertNoXmlToolCall(first.text)

    const call = calls[0]!
    expect(call.name, 'tool-call 缺工具名').toBe(WEATHER_TOOL.name)
    expect(call.id, 'tool-call 缺 id').toBeTruthy()

    // ── ⚠️ 合并生效的两条判据（`accioToolCallMergeTransform` 的存在理由）──
    // ① 同一个 id 只允许一个块：未合并时上游的分片会让它变成 2~3 个块，
    //    harness 于是**执行同一个工具 N 次**。
    const sameId = calls.filter((c) => c.id === call.id)
    expect(
      sameId.length,
      `⚠️ 同一个 tool-call id 出现了 ${sameId.length} 个块 —— 分片没被合并，`
      + 'harness 会把同一个工具执行多次（每个块一次）。',
    ).toBe(1)
    // ② 参数必须**不是空对象**：未合并时首块（无 `args_json` 的那帧）会落成 `{}`。
    const args = JSON.parse(call.arguments) as Record<string, unknown>
    expect(
      Object.keys(args).length,
      `⚠️ tool-call 的参数是空对象（${call.arguments}）—— 正是「首帧无参数」未被合并的形态。`,
    ).toBeGreaterThan(0)
    expect(args.city, `参数里应带 city（实测参数：${call.arguments}）`).toBeTruthy()

    // ── 第二次请求：把工具结果回传（走 DSH 0.1.7 的一等 `role:'tool'` 形状）──
    const second = await callOnce({
      credential,
      model: model.id,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '北京今天天气怎么样？请调用工具查询，不要凭记忆回答。' }],
        },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          }],
        },
        {
          role: 'tool',
          toolCallId: call.id,
          content: '{"city":"北京","weather":"晴","temperature_c":24}',
        },
      ],
      tools: [WEATHER_TOOL],
      maxOutputTokens: 512,
    })
    assertNoInStreamError(second.frames, second.error)
    assertNoXmlToolCall(second.text)
    console.log(`[accio-tools] 回传后：finish=${second.finishKind}`
      + ` 正文=${JSON.stringify(second.text.slice(0, 120))}`)
    expect(
      second.text.length,
      '⚠️ 回传工具结果后没有拿到最终正文 —— 工具**往返**（functionResponse 按 name 配对）没走通。',
    ).toBeGreaterThan(0)
  }, 240_000)

  it('⚠️ 思考链分离：thought part 只进 reasoning，其余只进正文（逐字对账）', async () => {
    const credential = storedCredential()
    if (credential === undefined) return
    const model = resolveProbeModel()

    const result = await callOnce({
      credential,
      model: model.id,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '先想一下再回答：3 加 4 等于几？只回复数字。' }],
      }],
      maxOutputTokens: 512,
    })
    assertNoInStreamError(result.frames, result.error)

    // 从**原始帧**里分别收集 thought / 非 thought 的文本。
    const parts = result.frames.flatMap((f) => f.content?.parts ?? [])
    const thoughtText = parts
      .filter((p) => p.thought === true)
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
    const visibleText = parts
      .filter((p) => p.thought !== true)
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')

    console.log(`[accio-tools] 思考分离：原始 thought=${thoughtText.length} 字`
      + ` 原始正文=${visibleText.length} 字`
      + ` 消费器 reasoning=${result.reasoning.length} 字 正文=${result.text.length} 字`)

    // ⚠️ 逐字对账（不是「两侧都非空」这种弱断言）：若归一化层把 thought 的语义
    // 写错，思考会**混进正文**（用户看到模型把内心独白当回答）。
    expect(
      result.reasoning,
      '⚠️ 消费器产出的 reasoning 与原始 thought part 的文本不一致 —— 思考被错分或丢失。',
    ).toBe(thoughtText)
    expect(
      result.text,
      '⚠️ 消费器产出的正文与原始非 thought part 的文本不一致 —— 思考混进了正文。',
    ).toBe(visibleText)

    // ⚠️ **不得断言「thought 一定非空」**：上游是否下发思考取决于模型与提示词
    // （实测同一模型不同提示词都可能不同）。断言它会得到随机失败的假阴性。
    // 真正有区分度的是上面两条**对账**：只要任一侧有内容，错分就会被抓到。
    expect(
      result.text.length + result.reasoning.length,
      '正文与思考都为空（既没内容也没思考 ⇒ 这条对账是空洞的）',
    ).toBeGreaterThan(0)
  }, 120_000)
})
