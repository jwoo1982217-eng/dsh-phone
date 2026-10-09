/**
 * 本机网关的 **OpenAI Responses API** 出口（`POST /v1/responses`）。
 *
 * ## 为什么要有它
 *
 * 网关最初只有 `/v1/chat/completions`。而新一代客户端（Codex CLI、以及各家
 * 「只认 Responses」的 agent）**不发** `messages` / `max_tokens`，而是发
 * `input` / `instructions` / `max_output_tokens`，并且只解析 Responses 的
 * SSE 事件（`response.output_text.delta` / `response.output_item.done` /
 * `response.completed`）。协议外壳不同，往里塞 Chat Completions 是塞不进的。
 *
 * ⚠️ **两个端点同时可用，不做「格式开关」**（用户 2026-10-03 明确要求）：
 * 客户端用哪套协议由它自己请求的 URL 决定。做成互斥开关只会让「另一个协议的
 * 客户端在切换后突然失效」，而网关这边本来就没有任何互斥的理由 ——
 * 两者共用同一份 provider 路由、账号池与图片入站。
 *
 * ## 与 `/v1/chat/completions` 的**有意差异**（改这个文件前先读）
 *
 * 1. **文本以 `block-end` 的组装块为权威**（见 {@link applyItemChunk}）。
 *    DSH 的 `block-end` 是**权威覆盖**（`openai-compat.ts` / `buddy-adapter.ts`
 *    的注释与 `scripts/verify-blockend-override.ts` 都写明这一点：死循环截断、
 *    泄漏清洗都只在 block-end 上生效），而 delta 累积只是「过程量」。
 *    Chat 路径忽略 block-end、只累加 delta，于是在上游触发正文死循环截断时
 *    会把重复正文一并交给客户端；本模块按协议本意取 block-end。
 *    ⚠️ 代价：同一个上游响应，两个端点在「正文死循环被截断」这种少数情况下
 *    会给出不同的文本。**这是本端点更正确**，不是缺陷；Chat 路径保持原样是
 *    因为「不顺手改既有端点的行为」。
 * 2. **`usage` 的字段口径与 Chat 路径一致**（`input_tokens` 是**含缓存命中**
 *    的总输入，命中部分单列在 `input_tokens_details.cached_tokens`）。
 *    这正是 OpenAI 官方口径，也是 Codex 的判据（它算 `input_tokens - cached`
 *    得未命中量，见 `usage.ts`）。
 *    ⚠️ **这里曾经写反过**：初版刻意发 DSH 的互斥口径（`input_tokens` 只含
 *    未命中），理由是「同一请求在两个端点上的数字必须能直接对比」。方向没错
 *    —— 错在**统一到了错误的那一边**：OpenAI 官方 `input_tokens` 本就含缓存，
 *    发不含缓存的会让标准客户端（Codex）把缓存量当成负输入而夹到 0，
 *    上下文占用被少算上百倍，自动压缩永不触发。
 *    现在两端都统一到**官方口径**，可对比性同样成立。
 *    完整事故记录与实测数据见 `usage.ts` 文件头。
 *
 * ## 明确**接受但不生效**的字段
 *
 * `store` / `include` / `prompt_cache_key` / `metadata` / `user` /
 * `truncation` / `service_tier` / `safety_identifier` / `parallel_tool_calls`：
 * 网关是**无状态转发**，既没有可存储的响应（`GET /v1/responses/{id}` 一律 404），
 * 也没有跨请求缓存通道，故这些字段接受并忽略。
 *
 * ⚠️ 但**语义会变**的字段绝不静默忽略 —— 那种「用户以为设置生效了」的失败在
 * 本仓库是被明令禁止的（见 `messages.ts` 的 `normalizeReasoningEffort` 同款
 * 教训）。故 `previous_response_id` / `background` / `text.format`（结构化输出）/
 * `top_p`（非 1 时）一律**明确报 400**。
 *
 * ## 工具：能表达的就摊平，表达不了的就丢弃并记日志（**不是报错**）
 *
 * Codex 0.142+ 用私有的 Responses 扩展声明工具：`{type:'namespace', …}` 分组
 * 容器、`{type:'custom'}` 自由文法工具、`{type:'tool_search'}` 延迟加载检索。
 * 这批形状在第三方网关上普遍翻车（ollama / llama.cpp / xAI 都有对应 issue），
 * 也正是本文件第一版**报错**的地方 —— 用户看到的是一句
 * `tool type namespace is not supported`，代价却是**整轮对话不可用**。
 *
 * 现在的口径（与 sub2api / cc-switch 的成熟做法一致）：
 * - `namespace` 里的 **function 子工具摊平**成 `<namespace>__<child>`
 *   （见 {@link flatNamespaceToolName}），响应侧再把 `function_call` 还原成
 *   `{name, namespace}`（见 {@link responsesNamespaceToolMap}）；
 * - `custom` / `tool_search` / `web_search` 等**无法**用 DSH 的 `ToolSchema`
 *   表达的类型：丢弃 + warning（调用方通过 `onDrop` 接），**绝不让请求失败**。
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { type AttachmentBridge, type ImageLimits } from './images.js';
import { type SuggestionHook } from './stream.js';
/** 请求体形状（只声明我们用到的字段；其余原样忽略）。 */
export interface OpenAiResponsesRequest {
    model?: unknown;
    input?: unknown;
    instructions?: unknown;
    stream?: unknown;
    temperature?: unknown;
    top_p?: unknown;
    max_output_tokens?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
    reasoning?: unknown;
    text?: unknown;
    previous_response_id?: unknown;
    background?: unknown;
    parallel_tool_calls?: unknown;
    metadata?: unknown;
    truncation?: unknown;
    user?: unknown;
    store?: unknown;
    [key: string]: unknown;
}
/**
 * 取出 `reasoning.effort` 的**原始请求值**，交给
 * {@link import('./messages.js').normalizeReasoningEffort} 归一化。
 *
 * ⚠️ 这里只做**形状**校验，不做档位判定：档位是否被该模型支持要看
 * `resolveModelInfo()` 的结果，那是 server 层的事（与 Chat 路径同一分工）。
 * 返回 `undefined` 表示「用户没给」—— `normalizeReasoningEffort` 的三态契约
 * 依赖这个区分。
 */
export declare function responsesReasoningEffort(body: OpenAiResponsesRequest): unknown;
/**
 * 取出并校验 `max_output_tokens`（Responses 版的 `max_tokens`）。
 *
 * ⚠️ `null` 按「没给」处理：SDK 把「未设置」序列化成 `null` 是常见形态，
 * 为此回 400 只会让用户莫名其妙。
 */
export declare function responsesMaxOutputTokens(body: OpenAiResponsesRequest): number | undefined;
/**
 * namespace 子工具的**扁平名**。
 *
 * Codex 0.142+ 用它私有的 Responses 扩展声明 MCP / 插件工具：
 * `{type:'namespace', name:'mcp__files__', tools:[{type:'function', name:'read', …}]}`
 * —— namespace 只是一个**分组容器**，真正能被模型调用的仍是里面的 function。
 * 而 DSH 的工具表是**扁平**的（`ToolSchema = {name, description, parameters}`），
 * 故必须把它摊平成 `<namespace>__<child>`。
 *
 * ⚠️ **必须确定性**：请求侧摊平（{@link toChatTools}）与响应侧还原
 * （{@link responsesNamespaceToolMap}）各自独立算这个名字，两边算法不一致就会
 * 「上游按 A 名字调用、网关却按 B 名字还原」，客户端配不上任何工具。故只有这一份实现。
 * ⚠️ 命名法 `namespace__child` 与 Codex 自己（PR #29602「Flatten namespace tools
 * for providers without wrappers」）以及各家代理（sub2api、cc-switch）一致。
 * ⚠️ 超过 64 字符时截断 + 8 位 sha256 后缀：OpenAI 兼容端点的 function name
 * 上限普遍是 64，纯截断会让长名字之间互相碰撞（碰撞的两条用例在 cc-switch 里
 * 是直接报错的，这里靠后缀避免）。
 */
export declare function flatNamespaceToolName(namespace: string, name: string): string;
/**
 * 从请求体算出「扁平名 → `{namespace, name}`」的还原表。
 *
 * ⚠️ 与摊平**同源**：两者都走 {@link flattenResponsesTools} 这**一次遍历**。
 * 早先这里是独立重算的，于是两边的清洗口径一旦不同就会漂移（见
 * {@link normalizeToolName} 的注释）；现在连「谁占了哪个名字」的判定也是同一份，
 * 不会出现「顶层工具占了名字、子工具被丢弃，还原表却仍把它映射回 namespace」。
 * 不靠跨函数状态传递：响应侧要还原 `function_call` 的名字，而它拿到的只有请求体，
 * 重算一遍比让 server 把 map 一路穿进来更不容易漏（cc-switch 的成熟实现也是这个思路）。
 */
export declare function responsesNamespaceToolMap(body: OpenAiResponsesRequest): Map<string, {
    namespace: string;
    name: string;
}>;
/** 摊平后仍无法表达、因而被丢弃的工具（供调用方记日志）。 */
export interface DroppedTool {
    type: string;
    name?: string;
}
/**
 * Responses 请求 → DSH `GenerateOptions`。
 *
 * @param reasoningEffortOverride 网关归一化后的档位（三态，见
 *   `messages.ts` 的 `normalizeReasoningEffort`）。
 * @param maxTokensOverride 已归一化的输出预算（`normalizeMaxTokens` 的结果）。
 * @param onDrop 无法表达、已被丢弃的工具类型（调用方据此记一条 warning ——
 *   丢弃是**有意**的降级，不能连日志都没有）。
 */
export declare function toResponsesGenerateOptions(body: OpenAiResponsesRequest, signal: AbortSignal, reasoningEffortOverride?: string | null, maxTokensOverride?: number, images?: {
    bridge?: AttachmentBridge;
    limits?: ImageLimits;
}, onDrop?: (tool: DroppedTool) => void): Promise<GenerateOptions>;
/**
 * 非流式：把整条流收成一个 Responses 对象。
 *
 * ⚠️ 逐帧判定必须与 {@link toResponsesSse} 保持一致（项的类型由**帧类型**决定、
 * `block-end` 是权威覆盖、`block-start` 负责收尾）。两者共用
 * {@link applyItemChunk} / {@link applyStateChunk}，只有「怎么把项交给调用方」
 * 不同 —— 这里是攒进数组，那里是发 SSE。
 */
export declare function collectResponsesResult(chunks: AsyncIterable<StreamChunk>, responseId: string, model: string, request: OpenAiResponsesRequest, suggest?: SuggestionHook): Promise<Record<string, unknown>>;
/**
 * 流式：按 Responses 的事件序列产出 SSE 文本。
 *
 * 事件顺序（与官方一致，客户端按 `output_index` 归位）：
 * `response.created` → `response.in_progress` → 每个输出项的
 * `output_item.added` + 各自的 part/delta/done → `response.completed`
 * （截断时是 `response.incomplete`，失败时是 `response.failed`）。
 *
 * ⚠️ **不发 `data: [DONE]`**：那是 Chat Completions 的收尾约定；Responses 的流
 * 以 `response.completed` / `response.failed` 结束（官方 SDK 依此判定结束）。
 */
export declare function toResponsesSse(chunks: AsyncIterable<StreamChunk>, responseId: string, model: string, request: OpenAiResponsesRequest, suggest?: SuggestionHook): AsyncIterable<string>;
//# sourceMappingURL=responses.d.ts.map