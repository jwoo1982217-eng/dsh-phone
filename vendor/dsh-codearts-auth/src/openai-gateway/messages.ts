import { randomUUID } from 'node:crypto'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_IMAGE_LIMITS,
  parseImageDataUrl,
  toImageBlock,
  type AttachmentBridge,
  type ImageLimits,
} from './images.js'
import { isThinkingOffEffort, translateReasoningEffort } from '../reasoning-ladder.js'
// ⚠️ 复用 `src/sse.ts` 的**同一份**「工具名是否可用」判据（各适配器的
// `resolveToolPairing` 用的是它）。自己再写一条 `length > 0` 必然漂移 —— 那正是
// 本仓库首条红线「同一语义两套判据」，也正是 issue IKLRIK 的成因。
import { hasUsableToolName } from '../sse.js'
import { rewriteTencentContentFingerprints } from './tencent-fingerprint.js'

export class OpenAiGatewayError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly type = 'invalid_request_error',
    readonly code = 'invalid_request',
  ) {
    super(message)
    this.name = 'OpenAiGatewayError'
  }
}

export interface OpenAiToolCall {
  id?: unknown
  type?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

/**
 * 网关自有的消息来源标识。
 *
 * ⚠️ 0.2.0 的 `MessageSourceMap` **删除了共享的 `plugin` 包装**，改为由每个
 * 生产者自己声明 kind（见 `packages/llm/llm/src/message.ts` 的注释：
 * 「no shared catch-all `plugin` kind」）。网关正是一个生产者，故如实署名。
 *
 * ⚠️ 网关造出的消息**只进 `llm.stream()`**（`server.ts`），**不落盘**
 * （没有 `session.append` 调用），故这个 kind 不会出现在会话日志里。
 */
export const GATEWAY_SOURCE_KIND = 'openai-gateway'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 由 OpenAI 兼容网关（`/v1/chat/completions`、`/v1/responses`）合成的入站消息。 */
    'openai-gateway': { readonly kind: 'openai-gateway' }
  }
}

/**
 * 造一个网关自用的**工具结果包裹块**。
 *
 * ⚠️⚠️ `'tool-result'` 是 ≤0.1.6 的历史块形状，**0.2.0 的 `ContentBlockMap`
 * 已把它删除**（工具结果改为一等 `role:'tool'` 消息）。但网关**刻意继续产出
 * 这个包裹形状**，因为它正是本插件内部的规范形状：`message-shape.ts` 的
 * `normalizeHarnessMessages` 会把一等 `tool` 消息**降级**成它，五个适配器
 * （`llm-adapter` / `openai-compat` / `buddy` / `lobsterai` / `trae`）都按
 * `type === 'tool-result'` 识别工具结果。网关按同一形状产出，归一化因此是
 * **零成本透传**；而包裹块的 `content` 正是工具结果内嵌图片的挂载点
 * （`collectImages` / `userContentParts`）。
 *
 * ⇒ 升级前后**行为完全一致**，变的只是类型可见性（该块不再在全局块表里）。
 * 故把断言集中在**这一处**并写明理由，而不是把全局 `ContentBlockMap` 改回去
 * —— 那会让所有生产者（含 `stream()` 的 chunk）都能产出它，并顺手掩盖
 * `gemini-messages.ts` / `minimax-messages.ts` 里真实的类型收窄。
 *
 * @param toolCallId - 该结果回答的工具调用 id。
 * @param content - 结果的内层块（可含图片）。
 * @returns 可按 `ContentBlock` 使用的包裹块。
 */
export function gatewayToolResultBlock(
  toolCallId: string,
  content: readonly ContentBlock[],
): ContentBlock {
  return { type: 'tool-result', toolCallId, content } as unknown as ContentBlock
}

export interface OpenAiChatMessage {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

/**
 * 档位归一化时发生的一件**用户看不出来**的事，交给调用方记日志。
 *
 * ⚠️ 必须能被记下来：翻译是**有意**的降级（客户端表达不出模型的私有 id），
 * 但没有日志的话，「用户选了 ultra、实际只跑 high」这件事事后无从解释。
 */
export interface ReasoningEffortNotice {
  /** 客户端要的档位（原样）。 */
  requested: string
  /** `translated` = 就近落到模型声明的一档；`unexpressible` = 模型没有这一族 → 不下发。 */
  outcome: 'translated' | 'unexpressible'
  /** 实际下发的 id（`unexpressible` 时缺省）。 */
  applied?: string
}

export interface OpenAiChatRequest {
  model?: unknown
  messages?: unknown
  stream?: unknown
  temperature?: unknown
  max_tokens?: unknown
  max_completion_tokens?: unknown
  stop?: unknown
  reasoning_effort?: unknown
  tools?: unknown
  tool_choice?: unknown
}

/**
 * CodeArts 单次输出的安全上限。
 *
 * ⚠️ 依据是 `llm-adapter.ts` 的实测（参考实现 e2e：65536 可用，
 * **131072** 反而触发空流被后端拒绝），**不是**「拒绝 128000」——
 * 后者在 CodeArts 语境下没有任何实测记录（README 那张 128000/131072 表
 * 属于 buddy/workbuddy；`deepseek-v4.1-flash` 两个 provider 都有该 id，
 * 别张冠李戴）。
 */
export const CODEARTS_MAX_OUTPUT_TOKENS = 65_536

/**
 * 受该上限约束的 CodeArts 模型（小写形态）。
 *
 * ⚠️ **判据必须忽略大小写**：codearts 目录本身大小写混用（`GLM-5.2` 大写
 * 与 `glm-5.3-flash` 小写并存），而 `parseModelRoute` 是纯字符串切片、
 * **不做任何归一化**。用户照着真实存在的 `GLM-5.2` 拼出 `GLM-5.3-Flash`
 * 完全现实；更关键的是 `CodeArtsAdapter.resolveModel` 对目录外模型走
 * `remoteModel?.name ?? model` —— **原样放行、从不拒绝**（dsh-llm 的
 * `normalizeModelInfo` 同样只校验字段类型，注释明写 catalog membership
 * is advisory），故网关不会提前 404，绕过判据的值会真的发往上游。
 * 判据不归一化 ⇒ 这条路径上没有任何防线。
 *
 * ⚠️ 保持**白名单**式列举，不要改成前缀/模糊匹配：钳制是把用户要的输出
 * 预算**往下压**，误伤一个本可输出长文的模型比漏压更糟
 * （同 `clampClineMaxTokens` 的取��原则）。
 */
const CODEARTS_OUTPUT_CAPPED_MODELS: ReadonlySet<string> = new Set([
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'glm-5.2', 'glm-5.3-flash', 'deepseek-v4.1-flash',
])

export function normalizeMaxTokens(value: number | undefined, provider: string, model: string): number | undefined {
  if (value === undefined) return undefined
  if (provider === 'codearts' && CODEARTS_OUTPUT_CAPPED_MODELS.has(model.toLowerCase())) {
    return Math.min(value, CODEARTS_MAX_OUTPUT_TOKENS)
  }
  return value
}
/**
 * 把 OpenAI 的 `reasoning_effort` 归一化成本模型**真正支持**的档位。
 *
 * ## 「未声明」与「不支持」必须区别对待
 *
 * 实机报障：ZCode 经网关调 `lobsterai/MiniMax-M3.1-Flash-Preview` 报
 * `provider "lobsterai" model "..." does not support reasoning effort "high"`。
 * 该模型没有 `thinkingConfig` ⇒ 适配器不声明 reasoning ⇒ `supported` 为空。
 * 初版在这里**原样透传**了 `high`，于是 DSH 侧校验拒绝，整轮请求失败。
 *
 * 正确处理是**不下发**该参数：模型没有这组档位，硬塞一个只会换来错误，
 * 而「静默按模型默认走」至少不会让用户的整轮对话失败。
 * （与本仓库「不参与模型请求、不伪造 provider 行为」的既有约定一致。）
 *
 * ## 第二类失败：客户端只认识通用档位名，模型用的是私有 id
 *
 * 各 provider 的档位 id 是**上游 wire 值**：TRAE 是 `light`/`high`/`extra_high`、
 * LobsterAI 是 `off`/`high`/`xhigh`（界面上叫 Max）、Cline 是 `…`/`max`（界面上叫
 * Extra）、Raccoon 是 `on`/`off`。而走 OpenAI 协议的客户端**只有固定 8 档词汇**
 * （Codex 与为它生成模型目录的 CC Switch 都是 `none…ultra`），它**表达不出**
 * 那些私有值 —— 用户照着 DSH 界面上的名字填，`max` 撞 `xhigh`、`xhigh` 撞 `max`，
 * 换来的是一句 400 和**整轮对话不可用**，而两端都看不出为什么。
 *
 * 这正是本仓库已经吃过一次的教训（工具类型不认识就让整轮失败，见 `responses.ts`
 * 文件头）：**拒绝的收益（让用户知道某档没生效）远小于代价（整轮不可用，
 * 且用户无从修复 —— 客户端根本没有能表达私有 id 的写法）**。
 * 故改为**翻译**：见 {@link translateReasoningEffort}，按强度序就近落到模型声明的
 * 同族档位上，并把这件事通过 `onNotice` 交给调用方记日志。
 *
 * ⚠️ 但**完全不认识的值仍然 400**（例如拼错的 `banana`）：那不是「名字不通用」，
 * 是调用方写错了。静默翻译会让拼写错误变成「档位悄悄不生效」。
 *
 * ⚠️ **CodeArts 例外**：该 provider 只有开/关两态（适配器把档位阶梯拍平了，
 * 见 `llm-adapter.ts`），任何档位名都等价，故一律二值化、永不报错。
 *
 * ## 返回值是**三态**，不可混用
 *
 * - `string`：归一化后的档位，下发它；
 * - `undefined`：**用户没传** `reasoning_effort`；
 * - `null`：**用户传了，但本模型不适用** → 明确不下发。
 *
 * ⚠️ `null` 与 `undefined` 必须分开：`toGenerateOptions` 以 `!== undefined`
 * 判定「调用方是否给了值」。若这里用 `undefined` 表示「不下发」，它会被当成
 * 「没给」而回退读 `body.reasoning_effort` —— 归一化的结论被原样抵消，
 * 于是报障原句又回来了。**这是本缺陷第二轮的复发形态**（首轮是原样透传，
 * 二轮是「修好了却被下游回退吃掉」）。
 */
export function normalizeReasoningEffort(
  requested: unknown,
  modelInfo: unknown,
  provider?: string,
  model?: string,
  onNotice?: (notice: ReasoningEffortNotice) => void,
): string | null | undefined {
  if (requested === undefined) return undefined
  const value = String(requested)
  if (provider === 'codearts' && model !== undefined) {
    return isThinkingOffEffort(value) ? 'off' : 'on'
  }
  const record = modelInfo as { reasoning?: { efforts?: readonly { id?: unknown }[] } } | undefined
  const declared = (record?.reasoning?.efforts ?? [])
    .map((effort) => String((effort as { id?: unknown } | undefined)?.id))
  // 模型未声明档位（declared 为空）：明确**不下发**，而不是原样透传。
  // modelInfo 为 undefined 也走这里 —— 那不是「没有限制」，是「不知道」。
  if (declared.length === 0) return null
  const result = translateReasoningEffort(value, declared)
  if (result.kind === 'exact') return result.effort
  if (result.kind === 'mapped') {
    onNotice?.({ requested: value, outcome: 'translated', applied: result.effort })
    return result.effort
  }
  if (result.kind === 'unexpressible') {
    onNotice?.({ requested: value, outcome: 'unexpressible' })
    return null
  }
  // 既没被声明、也不在强度序里 —— 调用方写错了。报错要顺带把**可用档位**说清，
  // 否则用户只能靠试。
  throw new OpenAiGatewayError(
    `reasoning effort ${JSON.stringify(value)} is not supported by the selected DSH model`
    + `（该模型可用的档位：${declared.join(', ')}）`,
    400,
    'unsupported_parameter',
    'unsupported_reasoning_effort',
  )
}

/**
 * 把 OpenAI 的 `content` 转成 DSH 的内容块数组。
 *
 * ⚠️ 图片走 `image_url` → 附件 → `ImageBlock`（见 `./images.ts`），**异步**。
 * 附件服务缺失时（`bridge` 为 undefined）必须抛错而不是静默丢图：静默丢弃会让
 * 用户以为模型看到了图，而答案其实是基于文本生成的。
 *
 * ⚠️ 本函数同时被 `/v1/responses` 复用（`responses.ts` 把 Responses 的内容块
 * 转成 Chat 形状后调它）—— **图片入站只有这一份实现**，两套协议各写一份必然
 * 漂移成「Chat 端能收图、Responses 端报错」。
 */
export async function partsFromContent(
  content: unknown,
  bridge: AttachmentBridge | undefined,
  limits: ImageLimits,
): Promise<readonly ContentBlock[]> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content === null || content === undefined) return []
  if (!Array.isArray(content)) {
    throw new OpenAiGatewayError('message.content must be a string or an array of content parts')
  }
  // ⚠️ 0.2.0 起 `Message.content` 是 readonly，故用**本地可变数组**累积、
  // 返回时即为不可变面 —— 不能像升级前那样往 `Message['content']` 上 push。
  const blocks: ContentBlock[] = []
  const used = { count: 0, bytes: 0 }
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      throw new OpenAiGatewayError('message.content contains an invalid part')
    }
    const item = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } }
    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
      continue
    }
    if (item.type === 'image_url') {
      if (bridge === undefined) {
        throw new OpenAiGatewayError(
          '当前 profile 未装载附件服务（@deepseek-ai/dsh-attachment-local），无法接收图片。',
          400,
          'unsupported_content',
          'unsupported_content',
        )
      }
      try {
        blocks.push(await toImageBlock(item.image_url?.url, bridge, limits, used))
      } catch (error) {
        // 转成 OpenAI 风格错误，让客户端能识别是「内容问题」而非服务端故障。
        throw new OpenAiGatewayError(
          error instanceof Error ? error.message : String(error),
          400,
          'unsupported_content',
          'unsupported_content',
        )
      }
      used.count += 1
      // 字节数按解析后的实际值累计，用于整条消息的总量限制。
      const parsed = parseImageDataUrl(item.image_url?.url)
      used.bytes += parsed?.data.length ?? 0
      continue
    }
    throw new OpenAiGatewayError('message.content contains an unsupported part')
  }
  return blocks
}

/**
 * 提取纯文本（仅用于需要字符串的场景；带图的 content 走 partsFromContent）。
 *
 * ⚠️ 同样被 `/v1/responses` 复用（`responses.ts` 的 `outputText`）—— 「工具结果
 * 不能带图」这条判据必须两个端点一致。
 */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (!Array.isArray(content)) {
    throw new OpenAiGatewayError('message.content must be a string or an array of text parts')
  }
  return content.map((part) => {
    if (!part || typeof part !== 'object') {
      throw new OpenAiGatewayError('message.content contains an invalid part')
    }
    const item = part as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') return item.text
    // ⚠️ 图片由 `partsFromContent` 异步处理（user 消息与 **工具结果**都走它）。
    // 仍会走到这里的只有 assistant / system —— 这两种角色的 content 本就**没有**
    // 图片通道（适配器只声明文本输出），故明确拒绝而不是静默压成空串。
    if (item.type === 'image_url') {
      throw new OpenAiGatewayError(
        'assistant / system 消息的内容不能包含图片（只有 user 消息与工具结果支持图片）',
        400,
        'unsupported_content',
        'unsupported_content',
      )
    }
    throw new OpenAiGatewayError('message.content contains an unsupported part')
  }).join('')
}

/**
 * 造一条 DSH 消息。
 *
 * ⚠️ **导出**给 `responses.ts` 用：两个端点造出来的消息必须同形（同样的 id/source
 * 构造），否则同一份历史在两个端点上的来源标记不同，排查时会误导。
 *
 * ⚠️ 0.2.0 起 `Message.content` 是 **`readonly ContentBlock[]`**，故调用方**不得**
 * 在事后 `push`（`responses.ts` 的 assistant 合并改为先累积再一次性构造）。
 */
export function createGatewayMessage(
  role: Message['role'],
  content: readonly ContentBlock[],
  source: Message['source'],
): Message {
  if (role === 'tool' && source.kind !== 'tool') {
    throw new OpenAiGatewayError('tool messages require a tool source')
  }
  return { id: randomUUID() as Message['id'], role, content, source,
    ...(role === 'tool' && source.kind === 'tool' ? { toolCallId: source.callId } : {}),
  } as Message
}

/** 工具调用id的不透明字节判据。 */
export function isUsableToolCallId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Chat 形状的 `assistant.tool_calls` → DSH 的 `tool-call` 块。
 *
 * ## ⚠️ 名字不可用的调用是**剔除**，不是 400（Issue IKLRIK）
 *
 * 历史里 `function.name` 为空串的调用**不是参数错误，而是可剔除的坏数据**：
 * 下游每一层（`sse.ts` 的 `resolveToolPairing`，九个适配器都调它）对同一份坏数据
 * 都是「剔除并继续」，判词见 `src/sse.ts`：「宁可丢失一轮工具上下文，也好过整条
 * 会话死亡」。而网关原先站在所有这些剔除防线**之前**，直接回 400
 * （`assistant.tool_calls contains an invalid function call`）—— 坏块被客户端
 * 每轮原样重放 ⇒ **整条会话永久不可用**。
 *
 * 位置决定了取舍：网关是最后一道防线（消费者是「把历史全部回传」的 Codex /
 * Claude 系客户端，它们没法自愈），故这里必须与下游同取「剔除」。
 *
 * ⚠️ **只剔除名字不可用的那一条，同批其余调用不受影响**（与
 * `resolveToolPairing` 的「一批里可用的那些各自独立」同款）。
 *
 * ⚠️ `id` / `arguments` 缺失**仍报错**：那两样是真·形状错误，且剔除一条
 * **名字可用**的调用会静默丢掉模型真实发起的工具调用（用户看不到任何提示）。
 * 判据只放宽「名字」这一格 —— 它正是本缺陷里客户端反复重放的那个字段。
 *
 * ⚠️ **本函数不负责「剔除集合」**（故**没有** `dropped` 参数）：哪些 id 因坏调用
 * 而失去配对，由 {@link collectCallAvailability} **预扫**统一算出 —— 配对的
 * `role:'tool'` 消息可能排在本条之后，此处无从知道。两处共用
 * {@link isUsableToolCallId} 与 `hasUsableToolName`，故判据只有一份。
 */
function convertToolCalls(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('assistant.tool_calls must be an array')
  const blocks: ContentBlock[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') throw new OpenAiGatewayError('tool call must be an object')
    const call = value as OpenAiToolCall
    const id = isUsableToolCallId(call.id) ? call.id : undefined
    const args = typeof call.function?.arguments === 'string' ? call.function.arguments : undefined
    // ⚠️ 判据用共享的 `hasUsableToolName`（trim 后非空），**不**自己写
    // `length > 0`：后者会把空白名放过去，而上游同样拒它。
    if (!hasUsableToolName(call.function?.name)) continue
    // 名字**原样**保留（不 trim）：它必须与 `tools` 侧声明的名字逐字符一致，
    // 而 `convertTools` 不 trim（见 `responses.ts` 的 `normalizeToolName` 注释
    // 里同一类事故）。判据与取值分开，是刻意的。
    const name = call.function.name
    if (id === undefined || args === undefined) throw new OpenAiGatewayError('assistant.tool_calls contains an invalid function call')
    blocks.push({ type: 'tool-call' as const, id: id as never, name, arguments: args })
  }
  return blocks
}

/**
 * 预扫历史，按 id 分出工具调用的可用性。
 *
 * ## ⚠️ 为什么必须同时给出 `kept`（真实回归，对抗审计实测打穿）
 *
 * 第一版只收集**坏**调用的 id，再按「结果 id 在该集合里」剔除结果。当**同一个
 * `call_id` 上既有坏调用、又有好调用**时，该判据无法区分两者 ⇒ 好调用的回执被
 * **连带剔掉** ⇒ 留下**孤儿 `tool-call`**（上游照样拒）。实测
 * `tool-calls = ["dup"]`、`results = []`。
 *
 * ⇒ 剔除条件必须是「**该 id 上没有任何可用调用**」（`dropped && !kept`），与下游
 * `resolveToolPairing` 的既有语义**同一份**（它先算 `keepCallIds`，结果「只在对应
 * 调用被保留时才保留」）。故这里同时算两个集合。
 *
 * ⚠️ 必须在转换**之前**扫一遍：配对的 `role:'tool'` 消息可能排在后面，
 * 单条转换时已经无从知道前面哪些调用被剔除了。
 *
 * ⚠️ 本函数与 {@link convertToolCalls} **共用** {@link isUsableToolCallId} 与
 * `hasUsableToolName` 两个判据 —— 「坏不坏」的定义只有一份，故两处不可能对同一条
 * 调用给出不同结论（那正是修法本身最容易引入的静默缺陷）。
 */
function collectCallAvailability(messages: unknown): { dropped: Set<string>; kept: Set<string> } {
  const dropped = new Set<string>()
  const kept = new Set<string>()
  if (!Array.isArray(messages)) return { dropped, kept }
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const value = raw as OpenAiChatMessage
    if (value.role !== 'assistant' || value.tool_calls === undefined) continue
    if (!Array.isArray(value.tool_calls)) continue
    for (const call of value.tool_calls) {
      if (!call || typeof call !== 'object') continue
      const record = call as OpenAiToolCall
      if (!isUsableToolCallId(record.id)) continue
      if (hasUsableToolName(record.function?.name)) kept.add(record.id)
      else dropped.add(record.id)
    }
  }
  return { dropped, kept }
}

/**
 * 单条 OpenAI 消息 → DSH `Message`。
 *
 * ⚠️ **异步**：`user` 消息的 content 可能是多模态数组，图片要经附件服务落盘
 * （`saveImage` 是异步的），故这里整体异步化，由 {@link toGenerateOptions} 串行 await。
 *
 * ⚠️ 返回 `undefined` = **该条整条剔除**（目前唯一的来源是「配对的 tool_call
 * 名字不可用」且**该 id 上没有别的可用调用**，见 {@link convertToolCalls}）。
 * 调用方必须 filter 掉它。
 */
async function convertMessage(
  raw: unknown,
  provider: string,
  model: string,
  bridge: AttachmentBridge | undefined,
  limits: ImageLimits,
  // 工具调用的可用性（按 id 分「有可用调用的」与「只被坏调用引用的」）。
  // 判据见 {@link collectCallAvailability}；本参数**只读**。
  callIds: { readonly dropped: ReadonlySet<string>; readonly kept: ReadonlySet<string> },
): Promise<Message | undefined> {
  if (!raw || typeof raw !== 'object') throw new OpenAiGatewayError('messages entries must be objects')
  const value = raw as OpenAiChatMessage
  const role = value.role
  if (role === 'system') {
    // ⚠️ 腾讯系（`buddy` / `workbuddy`）后端有**内容级**风控：客户端自带的
    // 模板句（如 ZCode 的 gitStatus 注入）会让整轮请求 400 + 11128。
    // 改写只作用于 system、且只改腾讯系 —— 依据见 ./tencent-fingerprint.ts。
    return createGatewayMessage('system', [{
      type: 'text',
      text: rewriteTencentContentFingerprints(textFromContent(value.content), provider),
    }], {
      kind: 'system-prompt',
    })
  }
  if (role === 'user') {
    // ⚠️ user 消息走 parts：图片在这里被真正接收（其它角色不接受图片）。
    return createGatewayMessage('user', await partsFromContent(value.content, bridge, limits), { kind: 'user' })
  }
  if (role === 'assistant') {
    // ⚠️ assistant **正文**也在腾讯系风控的扫描范围内（实测 400/11128，依据见
    // ./tencent-fingerprint.ts 的表）。只改这一处文本；`tool_calls` 的
    // `arguments` 实测不拦，故原样传递（改它会破坏「工具调用参数是要回读的证据」）。
    const text = rewriteTencentContentFingerprints(textFromContent(value.content), provider)
    // ⚠️ 先累积再构造（0.2.0 的 content 是 readonly，不能事后 push）。
    const content: ContentBlock[] = text.length > 0 ? [{ type: 'text', text }] : []
    if (value.tool_calls !== undefined) {
      const calls = convertToolCalls(value.tool_calls)
      content.push(...calls)
      // ⚠️⚠️ **tool_calls 全被剔光 ⇒ 整条 assistant 消息也剔除**（独立审计实测指出）。
      //
      // 历史里只有坏调用时，「剔除坏调用」会把这条 assistant 留成 **content 为空的
      // 助手消息**。它会被送到上游、成为 wire 上的**开头发言**（实测：经
      // `openai-compat.serializeMessages` 产出 `[{"role":"assistant","content":""}]`，
      // 且**没有任何 user 消息**）—— 这类形状对 OpenAI 兼容端点是典型的
      // `model_param_invalid` 400 ⇒ **400 只是从网关挪到了上游**，问题没解决。
      //
      // ⚠️ 判据必须同时看 `text.length === 0`：**正文非空**的 assistant（模型的
      // 真实发言）即使调用被剔光也要留下 —— 那是用户在界面上真的看到的内容，
      // 剔掉会让助手的话从历史里消失。
      //
      // ⚠️ 边界如实标注：**无** `tool_calls` 的空 assistant（`content:''`）在改前
      // 也产出同形，故这**不是本次引入的回归**；但本次修法把它从「罕见」变成
      // 「坏块会话的必经路径」（坏块会话一定会走到这里），故一并堵上。
      if (calls.length === 0 && text.length === 0) return undefined
    }
    return createGatewayMessage('assistant', content, { kind: 'model', provider, model })
  }
  if (role === 'tool') {
    if (typeof value.tool_call_id !== 'string' || value.tool_call_id.length === 0) {
      throw new OpenAiGatewayError('tool messages require tool_call_id')
    }
    if (callIds.dropped.has(value.tool_call_id) && !callIds.kept.has(value.tool_call_id)) return undefined
    return { ...createGatewayMessage('tool', await partsFromContent(value.content, bridge, limits),
      { kind: 'tool', callId: value.tool_call_id as never }), toolCallId: value.tool_call_id } as Message
  }
  throw new OpenAiGatewayError(`unsupported message role: ${String(role)}`)
}

/**
 * Chat 形状的 tools → DSH 的 ToolSchema。
 *
 * ⚠️ 被 `/v1/responses` 复用：`responses.ts` 先把 Responses 的**扁平**工具定义
 * 改写成 Chat 的嵌套形状，再交给这里做校验。工具 schema 的校验口径只有这一份。
 */
export function convertTools(raw: unknown): ToolSchema[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('tools must be an array')
  return raw.map((value) => {
    if (!value || typeof value !== 'object') throw new OpenAiGatewayError('tool must be an object')
    const tool = value as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }
    if (tool.type !== 'function' || typeof tool.function?.name !== 'string') {
      throw new OpenAiGatewayError('only function tools are supported')
    }
    const parameters = tool.function.parameters
    if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) {
      throw new OpenAiGatewayError('tool function.parameters must be a JSON object')
    }
    return {
      name: tool.function.name,
      description: typeof tool.function.description === 'string' ? tool.function.description : '',
      parameters: (parameters ?? {}) as Record<string, unknown>,
    }
  })
}

export function parseModelRoute(value: unknown): { provider: string; model: string } {
  if (typeof value !== 'string') throw new OpenAiGatewayError('model must be a string')
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    throw new OpenAiGatewayError('model must use provider/model format')
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/**
 * 正整数字段的校验（`max_tokens` / `max_completion_tokens` / `max_output_tokens`）。
 *
 * ⚠️ 被 `/v1/responses` 复用（`responsesMaxOutputTokens`），三个字段的判据必须
 * 完全一致，否则「同一个数字在 Chat 端合法、在 Responses 端报错」会被当成缺陷。
 */
export function tokenValue(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new OpenAiGatewayError(`${name} must be a positive integer`)
  }
  return value
}

/**
 * @param reasoningEffortOverride 网关归一化后的档位。**三态**：
 * - `string`：用它；
 * - `null`：**明确不下发**（模型未声明思考档位，硬塞只会让 DSH 侧报
 *   `UNSUPPORTED_REASONING_EFFORT`）；
 * - `undefined`：调用方没给 → 回退读 `body.reasoning_effort`（直连调用的老行为）。
 * @param images 图片入站依赖。`bridge` 为 undefined 时收到图片会明确报错而非
 *   静默丢图；`limits` 缺省用附件服务的实测默认值。
 *
 * ⚠️ **本函数是异步的**（图片要经附件服务落盘）。若外部有同步调用方需注意。
 */
export async function toGenerateOptions(
  body: OpenAiChatRequest,
  signal: AbortSignal,
  reasoningEffortOverride?: string | null,
  maxTokensOverride?: number,
  images: { bridge?: AttachmentBridge; limits?: ImageLimits } = {},
): Promise<GenerateOptions> {
  const { provider, model } = parseModelRoute(body.model)
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new OpenAiGatewayError('messages must be a non-empty array')
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
    throw new OpenAiGatewayError('only tool_choice auto and none are supported')
  }
  const maxTokens = maxTokensOverride ?? (body.max_completion_tokens !== undefined
    ? tokenValue(body.max_completion_tokens, 'max_completion_tokens')
    : tokenValue(body.max_tokens, 'max_tokens'))
  const stop = body.stop === undefined
    ? undefined
    : typeof body.stop === 'string' ? [body.stop]
      : Array.isArray(body.stop) && body.stop.every(item => typeof item === 'string') ? body.stop
        : (() => { throw new OpenAiGatewayError('stop must be a string or string array') })()
  const temperature = body.temperature === undefined ? undefined
    : typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature
      : (() => { throw new OpenAiGatewayError('temperature must be a finite number') })()

  const tools = convertTools(body.tools)
  if (body.tool_choice === 'none' && tools !== undefined && tools.length > 0) {
    throw new OpenAiGatewayError('tool_choice none with tools cannot be represented by DSH', 400, 'unsupported_parameter', 'unsupported_parameter')
  }
  // ⚠️ 这里用 `!== undefined` 而**不是** `??`：三态必须区分开。
  // - `undefined`：调用方没给（未传）→ 回退到 body 里的值（直连调用的老行为）；
  // - `null`：调用方**明确决定不下发**（模型未声明思考档位）→ 必须原样保留，
  //   否则 `??` 会把它当成「没给」而从 body 捞回原值，让归一化的结论被抵消 ——
  //   实测正是这样：归一化返回 undefined 后，body 里的 'high' 又被塞回请求，
  //   DSH 侧继续抛 UNSUPPORTED_REASONING_EFFORT。
  const reasoningEffort = reasoningEffortOverride !== undefined
    ? reasoningEffortOverride
    : (body.reasoning_effort === undefined ? undefined : String(body.reasoning_effort))
  const limits = images.limits ?? DEFAULT_IMAGE_LIMITS
  // ⚠️ 必须在转换**之前**预扫一次：被剔除的调用所配对的 `role:'tool'` 消息可能
  // 排在其后，逐条转换时已无从知道该剔除谁（见 `collectCallAvailability`）。
  // ⚠️ 必须同时拿到 `dropped` **与** `kept` 两个集合（见该函数的注释）。
  const callIds = collectCallAvailability(body.messages)
  // ⚠️ **串行**而非 Promise.all：多张图会并发打附件服务，串行既让限额累计
  // 判定准确（`used` 是逐张累加的），也避免一次性压垮附件服务的并发额度。
  const messages: Message[] = []
  for (const message of body.messages) {
    const converted = await convertMessage(message, provider, model, images.bridge, limits, callIds)
    // 整条剔除（配对的 tool_call 名字不可用）—— 绝不 push 一条空消息充数。
    if (converted !== undefined) messages.push(converted)
  }
  return {
    provider,
    model,
    messages,
    ...tools === undefined ? {} : { tools },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...temperature === undefined ? {} : { temperature },
    ...stop === undefined ? {} : { stop },
    // ⚠️ 判据是 `== null`（同时排除 undefined 与 null）：`null` = 明确不下发，
    // 两者都不能写进请求。写成 `=== undefined` 会把 null 塞进
    // `ReasoningEffortId(null)`，等于又发了一个非法档位。
    ...reasoningEffort == null ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    signal,
  }
}
