/**
 * OpenAI 兼容协议层的共享实现：消息序列化 + SSE 消费 + 错误归类。
 *
 * ## 为什么单独成模块
 *
 * `src/buddy-adapter.ts` 与 `src/lobsterai-adapter.ts` 各自内联了一套**完全同源**
 * 的逻辑（消息序列化约 200 行、SSE 消费约 230 行），差异只在 URL、请求头与
 * 少数厂商特有字段上。第三个 OpenAI 兼容 provider（qoder）若再复制一份，
 * 这三份实现会在后续修 bug 时逐渐分叉 —— 而它们处理的都是
 * **OpenAI 协议层的通用陷阱**（工具配对、null 字段、分片合并），与厂商无关。
 *
 * 因此本模块把这部分抽出来给 **qoder 适配器**使用。
 *
 * ⚠️ **既有适配器（buddy / lobsterai）刻意不改用它**：那两份实现已被大量
 * 单测与线上流量验证过，重构它们属于与本任务无关的高风险改动。若将来要
 * 统一，应作为独立任务并配以逐条对拍测试。
 *
 * ## 本模块承载的实测教训（逐条都有真实缺陷背景）
 *
 * - **`typeof x === 'string'` 而非 `!== undefined`**：真实 SSE 里一个模型要么走
 *   `content`、要么走 `reasoning_content`，**另一侧恒为 `null`**。只判 undefined
 *   会让 `.length` 在 null 上崩溃（表现为每轮对话第一帧就报
 *   `Cannot read properties of null`）。
 * - **思考字段有两个名字**：`reasoning_content`（Qoder / buddy）与
 *   `reasoning`（**Cline**，实测形如
 *   `{"delta":{"reasoning":"The","reasoning_details":[…]}}`）。只认前者会让
 *   Cline 的思考内容被静默丢弃（表现为「模型不思考」）。两者语义相同，
 *   由同一分支经 `??` 合并处理。
 * - **工具配对剔除**：孤儿 tool_call / tool_result 会让后端 400，且坏历史被每次
 *   请求原样重放 —— 会话彻底报废。发出前剔除可让会话自愈。
 * - **`function.name` 只允许非空覆盖**：后续分片带空串 `""` 会清空已解析出的
 *   工具名 → `unknown tool ""`。
 * - **残缺参数不补 `{}`**：那会伪造出合法外观，让 harness 报 schema 错误而非
 *   重试；正确做法是判 `max-tokens` 让 dsh 重试。
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
/** 将消息内容载荷展平为纯文本字符串。 */
export declare function contentToText(content: unknown): string;
/** 工具结果内嵌图片的载体文本（与 buddy / lobsterai 适配器同名同义）。 */
export declare const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";
/**
 * 把 harness 内容块转成 OpenAI 多模态 parts。
 *
 * 图片必须转成 `{type:'image_url', image_url:{url}}` —— 这是服务端**唯一**接受的
 * 形态：`{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。
 *
 * 返回 `undefined` 表示「无图」；只要出现过图片块就一定返回数组（即便字节
 * 解析失败也留 `[image unavailable]` 占位符），以免图片被静默吞掉。
 *
 * 与 {@link collectImages} 对称地**递归**处理 `tool-result` 内层：收集侧是任意
 * 深度，序列化侧若只走一层，深层图片会被收进 refs 却在序列化时静默丢弃。
 */
export declare function userContentParts(content: readonly unknown[], imageUrls: ReadonlyMap<string, string>): Array<Record<string, unknown>> | undefined;
/** 收集消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
export declare function collectImages(content: readonly unknown[], refs: Map<string, unknown>): void;
/**
 * 将 harness 对话消息序列化为 OpenAI chat-completions 传输格式。
 *
 * 保留的**通用协议要求**：
 * - 孤儿工具调用清理（见 `resolveToolPairing` 的说明，后端会 400）；
 * - 正文为空且有 `tool_calls` 时 `content` 必须为 `null`（OpenAI 规范）；
 * - 工具结果内嵌图片不能留在 `role:'tool'` 消息里（该角色 content 只能是
 *   字符串，且必须紧跟其 assistant tool_call，中间插消息会 400），
 *   故提升为其后的独立 user 消息。
 *
 * 图片：`imageUrls` 为 `undefined` 表示整个请求没有图片；非 undefined
 * （**含空 Map**）时把 user 消息升级为多模态 parts。空 Map 不能降级为
 * undefined —— 那会让「图片存在但字节读取失败」的 `[image unavailable]`
 * 占位符也被跳过，图片静默消失。
 *
 * ⚠️ 入口先做 **DSH 0.1.7 消息形状归一化**（见 `message-shape.ts`）：0.1.7 把工具
 * 结果改为一等 `role:'tool'` 消息，若不归一化，下面的 `type === 'tool-result'`
 * 判据恒不命中 → 工具调用被 `resolveToolPairing` 整体剔除。
 */
export declare function serializeMessages(messages: readonly {
    role: string;
    content: unknown;
}[], imageUrls?: ReadonlyMap<string, string>): Array<Record<string, unknown>>;
/** 安全读取 Error.message。 */
export declare function errorMessage(error: unknown): string;
/** 从错误体提取可读 detail 文本。 */
export declare function errorDetail(body: string): string;
/** 将 HTTP 状态码映射为 harness 错误码。 */
export declare function httpErrorCode(status: number): string;
/**
 * **模型排队**（Qoder 业务码 `10605`）—— 从 SSE 错误帧里透出来的专用错误。
 *
 * ## 为什么需要它（真实缺陷，用户报障 2026-09-27）
 *
 * Qoder 的排队错误有**两种**下发形态，第一版修复只覆盖了第一种：
 *
 * | 形态 | 第一版 | 说明 |
 * |---|---|---|
 * | HTTP **403** + 排队 JSON | ✅ 已覆盖 | 在适配器的 HTTP 状态分支里识别 |
 * | HTTP **200** + **SSE 内嵌** `{code:"10605",…}` | ❌ **漏掉** | 走 `consumeOpenAiSse`，被一律归为 `SERVER` 抛出 |
 *
 * 真实症状：`失败原因：qoder: {"code":"10605",…} (403)` + harness 以
 * `500/1000/2000/4000/8000`（约 15.5 秒）重试 5 次 —— 而服务端要求等 30 秒，
 * 于是**永远等不到**。
 *
 * ⚠️ 该模块是**共享**的（qoder 适配器在用），故这里只**认码并透出信息**，
 * 不在此处等待 —— 等待策略属于各 provider（只有 qoder 有排队语义）。
 * 消费方捕获本类后自行按 `retryAfterMs` 内部重试。
 *
 * ⚠️ `code` 故意用 `'QUEUE'`（**不是** `SERVER`）：harness 的
 * `DEFAULT_RETRYABLE_CODES` 不含 `QUEUE`，这样万一没人捕获，它会**直接失败**
 * 并把「排队」这一语义暴露给用户，而不是被 harness 当作 `SERVER` 静默快重试。
 */
export declare class ModelQueuedError extends LlmError {
    /** 解析出的排队信息（`isQueued` / `serviceAvailable` / `waitTime` 等）。 */
    readonly queueInfo: Readonly<Record<string, unknown>>;
    /** 服务端要求的等待时长（毫秒）；无法解析时为 undefined。 */
    readonly retryAfterMs: number | undefined;
    constructor(message: string, options: {
        queueInfo: Readonly<Record<string, unknown>>;
        retryAfterMs?: number;
    });
}
/**
 * 判断是否为传输级错误（可重试的 TRANSPORT）。
 *
 * 半开连接与 TCP 重置都会以这些特征出现。
 */
export declare function isTransportError(error: unknown): boolean;
/** {@link consumeOpenAiSse} 的选项。 */
export interface ConsumeOpenAiSseOptions {
    /** provider 标签，仅用于错误消息前缀（如 `qoder`）。 */
    label: string;
    /** 等待首 token 的空闲超时（毫秒）。 */
    firstTokenTimeoutMs: number;
    /** 两次 chunk 之间的空闲超时（毫秒）。 */
    chunkTimeoutMs: number;
    /**
     * 本次请求的输出额度（token），用于死循环错误文案里的「还剩多少」。
     *
     * ⚠️ **可选，且拿不到时绝不编造数字**（与 `maxOutputTokens` 的口径一致）：
     * 文案会退化成「额度没有占满，可以直接继续」而不给具体数值。
     */
    maxTokens?: number;
    /**
     * 每解析成功一帧就回调一次（**旁路观测**，不得影响流本身）。
     *
     * Cline 用它取网关下发的路由元数据（真正服务这笔请求的上游渠道），
     * 见 `src/cline-routing.ts`。做成回调查而不是把字段塞进 `StreamChunk`：
     * 那是**展示用的旁路信息**，不该污染 DSH 的 chunk 契约（也不该被
     * 其它复用本消费器的 provider 无意中看到）。
     *
     * ⚠️ 回调**抛错会被吞掉**：观测失败绝不能把一次正常推理打死。
     */
    onFrame?: (data: Record<string, unknown>) => void;
}
/**
 * 消费 OpenAI 兼容的 SSE 响应并产出 `StreamChunk`。
 *
 * 三处兼容处理（都来自实测）：
 * 1. **容忍 `data:` 后无空格** —— 靠 `line.slice(5).trim()` 天然兼容两种形态；
 * 2. `reasoning_content` 单独成块；
 * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
 *
 * 另外两条防坑规则（见模块头注释）：
 * - `function.name` 只允许非空覆盖；
 * - `finish_reason` 映射：`length` / 中途断流 / 参数残缺一律归为 `max-tokens`。
 */
export declare function consumeOpenAiSse(response: Response, options: {
    signal?: AbortSignal;
}, config: ConsumeOpenAiSseOptions): AsyncIterable<StreamChunk>;
//# sourceMappingURL=openai-compat.d.ts.map