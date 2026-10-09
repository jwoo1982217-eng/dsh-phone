/**
 * MiniMax **Anthropic Messages** 协议层：请求体构造 + SSE 消费。
 *
 * ## 为什么单独一个文件
 *
 * 本 provider 是本插件**唯一**使用 Anthropic Messages 协议族的成员
 *（其余九个都是 OpenAI 兼容族或各自的自定义协议），故**不复用**
 * `openai-compat.ts`（那是 OpenAI 形状，硬套会把 `tools`/`tool_calls`/
 * `input_json_delta` 全部翻译错）。
 *
 * ⚠️ 但也**不做**「通用 Anthropic 层」的抽象 —— 目前只有一个消费者，
 * 抽象会凭空多一层间接（Qoder 的教训是「同族第二个产品出现时再抽」）。
 *
 * ## 实测确认的协议事实（2026-09-29，真实请求）
 *
 * 端点 `POST {apiHost}/mavis/api/v1/llm/v1/messages`，`stream: true`：
 *
 * | 事件 | 用途 |
 * |---|---|
 * | `message_start` | `usage.input_tokens`、`cache_read_input_tokens` |
 * | `ping` | 保活（**必须忽略**） |
 * | `content_block_start` | `content_block.type` ∈ `thinking` / `text` / `tool_use` |
 * | `content_block_delta` | `thinking_delta` / `text_delta` / `signature_delta` / `input_json_delta` |
 * | `content_block_stop` | 该块结束 |
 * | `message_delta` | `stop_reason`、`usage.output_tokens`（含 `thinking_tokens`） |
 * | `message_stop` | 结束 |
 * | `error` | `{type:'error', error:{type,message}}` |
 *
 * ⚠️ **`signature_delta` 必须忽略**（那是 thinking 块的签名，不是正文）；
 * 把它当文本会往回答里注入一串十六进制。
 *
 * ⚠️ **`thinking` 块要映射成 `reasoning` 块**（DSH 的 `ReasoningBlock`），
 * 否则思考内容会污染正文。
 *
 * ## ⚠️ 思考档位：`effort` 的两种下发形态（实测）
 *
 * - `MiniMax-M3.1-Flash-Preview`：**必须** `thinking.type='adaptive'`；
 *   传 `disabled` 会被服务端拒：
 *   `400 invalid_request_error ... requires adaptive thinking; thinking.type="disabled"
 *   (including reasoning.effort=none) is not allowed (2013)`。
 *   档位通过 **`output_config.effort`** 下发（客户端 `requestPatch` 同款）。
 * - M3 / M2.7 / M2.7-highspeed：**不传 `thinking` 即接受**（实测 200），
 *   且服务端**默认就会思考**（M2.7 实测 `thinking_tokens: 250`）。
 *   它们没有 `effort_options`，故不发 `output_config`。
 *
 * ⚠️ **所以「不发 thinking」是安全默认**（实测 200），
 * 不要为了「显式关闭」而发 `disabled` —— 那对 M3.1 是**硬 400**。
 *
 * ## ⚠️ 图片（2026-09-29 真机实测通过）
 *
 * Anthropic 形状的 `image` 块 + `source.base64`，**裸 base64**（无 data: 前缀）。
 * 实测 M3.1 / M3 都能正确识图（自造 40x40 纯红 PNG → 模型答「红色」）。
 * ⚠️ OpenAI 的 `image_url` 形状被服务端**明确拒绝**（见 `serializeMinimaxMessages`）。
 * ⚠️ 内联由调用方完成（适配器读附件服务），本文件保持**纯函数**。
 */
import type { FinishReason, RequestMessage as Message, StreamChunk, ToolSchema, TokenUsage } from '@deepseek-ai/dsh-llm';
/**
 * 构造 Anthropic Messages 请求体。
 *
 * ⚠️ 纯函数（不碰网络），便于单测锁死形状 —— 与 `buildQoderInferPayload` 同思路。
 *
 * ⚠️ **`system` 走顶层 `system` 字段**（Anthropic 协议），**不是**一条
 * `{role:'system'}` 消息 —— Anthropic Messages 端点不接受 system 角色消息。
 */
export declare function buildMinimaxMessagesPayload(options: {
    model: string;
    messages: readonly Message[];
    system?: string;
    tools?: readonly ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    stop?: readonly string[];
    /** 已解析的思考档位；`undefined` 表示不发（服务端默认行为）。 */
    effort?: string;
    /** 该模型是否**必须** adaptive thinking（只有 M3.1-Flash-Preview 是）。 */
    requiresAdaptiveThinking?: boolean;
    /** 已内联的图片（attachmentId → base64）。缺失时遇图**抛错**。 */
    images?: ReadonlyMap<string, MinimaxInlineImage>;
}): Record<string, unknown>;
/** 已内联的图片（attachmentId → base64 与 mediaType）。 */
export interface MinimaxInlineImage {
    mediaType: string;
    /** **裸 base64**（不含 `data:` 前缀）—— Anthropic `source.data` 要的就是它。 */
    data: string;
}
/**
 * 把 DSH 消息序列化为 Anthropic Messages 形状。
 *
 * ⚠️ **两个必须保留的东西**（Qoder 在那里踩过**三个同型缺陷**，
 * 这次一开始就做对）：
 *
 * 1. **assistant 的 `tool-call` 块 → `tool_use` 块**（带 `id` / `name` / `input`）；
 * 2. **`tool-result` 块 → `user` 消息里的 `tool_result` 块**（带 `tool_use_id`）。
 *    Anthropic 协议**没有 `role:'tool'`** —— 工具结果必须作为 user 消息的
 *    `tool_result` 内容块回传。丢掉它模型会反复重调同一工具或编造结果。
 *
 * ⚠️ **`input` 要解析成对象**（Anthropic 收 JSON 对象，不是字符串）；
 * 解析失败退化为 `{}` —— **不编造参数**，但也不能因此丢掉整条 tool_use
 * （丢了会让后续 `tool_result` 变成孤儿块，服务端 400）。
 *
 * ⚠️ **图片走 Anthropic 的 `image` 块**（2026-09-29 真机实测）：
 * ```json
 * { "type": "image",
 *   "source": { "type": "base64", "media_type": "image/png", "data": "<裸base64>" } }
 * ```
 * ⚠️ **不是** OpenAI 的 `{type:'image_url', image_url:{url:'data:...'}}` ——
 * 实测该形状被**明确拒绝**：
 * `400 ... messages.0.content.0: unsupported content type 'image_url' (2013)`。
 * ⚠️ `data` 是**裸 base64**（不带 `data:image/png;base64,` 前缀）。
 * ⚠️ 实测图片可与 `thinking:{type:'adaptive'}` 共存、`text` 在 `image` 前后均可。
 *
 * ⚠️ 图片**必须**由调用方先内联好（`images` 映射）：本函数是**纯函数**，
 * 不允许触碰附件服务（与 `buildQoderTools` 同思路，便于单测锁死形状）。
 * 调用方没内联成功时**不静默丢图** —— 那会让用户以为图片被模型看到了。
 */
export declare function serializeMinimaxMessages(messages: readonly Message[], images?: ReadonlyMap<string, MinimaxInlineImage>): Array<Record<string, unknown>>;
/** 把 Anthropic 的 `stop_reason` 映射为 DSH 的 {@link FinishReason}。 */
export declare function mapMinimaxStopReason(reason: unknown): FinishReason;
/** 解析 `usage` 字段（`message_start` 与 `message_delta` 各带一半）。 */
export declare function readMinimaxUsage(raw: unknown): Partial<TokenUsage>;
/** {@link consumeMinimaxSse} 的入参。 */
export interface ConsumeMinimaxSseOptions {
    /** SSE 字节流（`response.body`）。 */
    body: ReadableStream<Uint8Array>;
    /** 外部中止信号。 */
    signal?: AbortSignal;
}
/**
 * 消费 Anthropic Messages SSE，产出 DSH 的 {@link StreamChunk}。
 *
 * ⚠️ **错误必须抛错**，不能静默结束 —— 服务端用 `event: error` 下发错误
 * （实测形状 `{type:'error', error:{type,message}}`），
 * 早期 Qoder 因为只认 OpenAI 的 `{error:{message}}`，把错误帧当「正常结束、
 * 无内容」，UI 表现为「干净地停止、无任何报错」。
 *
 * ⚠️ 块的 `index` 直接用**服务端下发的 `index`**（不自己计数）：
 * 服务端从 0 开始为每个 content block 分配，重排会与 `block-end` 对不上。
 */
export declare function consumeMinimaxSse(options: ConsumeMinimaxSseOptions): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=minimax-messages.d.ts.map