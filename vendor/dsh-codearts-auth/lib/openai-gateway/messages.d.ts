import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm';
import { type AttachmentBridge, type ImageLimits } from './images.js';
export declare class OpenAiGatewayError extends Error {
    readonly status: number;
    readonly type: string;
    readonly code: string;
    constructor(message: string, status?: number, type?: string, code?: string);
}
export interface OpenAiToolCall {
    id?: unknown;
    type?: unknown;
    function?: {
        name?: unknown;
        arguments?: unknown;
    };
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
export declare const GATEWAY_SOURCE_KIND = "openai-gateway";
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** 由 OpenAI 兼容网关（`/v1/chat/completions`、`/v1/responses`）合成的入站消息。 */
        'openai-gateway': {
            readonly kind: 'openai-gateway';
        };
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
export declare function gatewayToolResultBlock(toolCallId: string, content: readonly ContentBlock[]): ContentBlock;
export interface OpenAiChatMessage {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
}
/**
 * 档位归一化时发生的一件**用户看不出来**的事，交给调用方记日志。
 *
 * ⚠️ 必须能被记下来：翻译是**有意**的降级（客户端表达不出模型的私有 id），
 * 但没有日志的话，「用户选了 ultra、实际只跑 high」这件事事后无从解释。
 */
export interface ReasoningEffortNotice {
    /** 客户端要的档位（原样）。 */
    requested: string;
    /** `translated` = 就近落到模型声明的一档；`unexpressible` = 模型没有这一族 → 不下发。 */
    outcome: 'translated' | 'unexpressible';
    /** 实际下发的 id（`unexpressible` 时缺省）。 */
    applied?: string;
}
export interface OpenAiChatRequest {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
    temperature?: unknown;
    max_tokens?: unknown;
    max_completion_tokens?: unknown;
    stop?: unknown;
    reasoning_effort?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
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
export declare const CODEARTS_MAX_OUTPUT_TOKENS = 65536;
export declare function normalizeMaxTokens(value: number | undefined, provider: string, model: string): number | undefined;
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
export declare function normalizeReasoningEffort(requested: unknown, modelInfo: unknown, provider?: string, model?: string, onNotice?: (notice: ReasoningEffortNotice) => void): string | null | undefined;
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
export declare function partsFromContent(content: unknown, bridge: AttachmentBridge | undefined, limits: ImageLimits): Promise<readonly ContentBlock[]>;
/**
 * 提取纯文本（仅用于需要字符串的场景；带图的 content 走 partsFromContent）。
 *
 * ⚠️ 同样被 `/v1/responses` 复用（`responses.ts` 的 `outputText`）—— 「工具结果
 * 不能带图」这条判据必须两个端点一致。
 */
export declare function textFromContent(content: unknown): string;
/**
 * 造一条 DSH 消息。
 *
 * ⚠️ **导出**给 `responses.ts` 用：两个端点造出来的消息必须同形（同样的 id/source
 * 构造），否则同一份历史在两个端点上的来源标记不同，排查时会误导。
 *
 * ⚠️ 0.2.0 起 `Message.content` 是 **`readonly ContentBlock[]`**，故调用方**不得**
 * 在事后 `push`（`responses.ts` 的 assistant 合并改为先累积再一次性构造）。
 */
export declare function createGatewayMessage(role: Message['role'], content: readonly ContentBlock[], source: Message['source']): Message;
/** 工具调用id的不透明字节判据。 */
export declare function isUsableToolCallId(value: unknown): value is string;
/**
 * Chat 形状的 tools → DSH 的 ToolSchema。
 *
 * ⚠️ 被 `/v1/responses` 复用：`responses.ts` 先把 Responses 的**扁平**工具定义
 * 改写成 Chat 的嵌套形状，再交给这里做校验。工具 schema 的校验口径只有这一份。
 */
export declare function convertTools(raw: unknown): ToolSchema[] | undefined;
export declare function parseModelRoute(value: unknown): {
    provider: string;
    model: string;
};
/**
 * 正整数字段的校验（`max_tokens` / `max_completion_tokens` / `max_output_tokens`）。
 *
 * ⚠️ 被 `/v1/responses` 复用（`responsesMaxOutputTokens`），三个字段的判据必须
 * 完全一致，否则「同一个数字在 Chat 端合法、在 Responses 端报错」会被当成缺陷。
 */
export declare function tokenValue(value: unknown, name: string): number | undefined;
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
export declare function toGenerateOptions(body: OpenAiChatRequest, signal: AbortSignal, reasoningEffortOverride?: string | null, maxTokensOverride?: number, images?: {
    bridge?: AttachmentBridge;
    limits?: ImageLimits;
}): Promise<GenerateOptions>;
//# sourceMappingURL=messages.d.ts.map