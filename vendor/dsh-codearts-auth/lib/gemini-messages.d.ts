/**
 * Gemini 协议层：DSH 消息 → 上游 `contents`，以及上游 SSE/响应 → DSH `StreamChunk`。
 *
 * ## 为什么单独一个文件
 *
 * 与 `minimax-messages.ts` 同一理由：本层是**纯函数 + 纯翻译**，与网络、凭据、
 * 账号池无关，拆开后可用单测逐字节锁死形状（`tests/unit/gemini-payload.spec.ts`
 * 与 `gemini-stream.spec.ts` 就吃这一层）。
 *
 * 逐点移植自 `cmdc-pak-align-wb/internal/upstream/gemini/translate.go`
 * 与 `stream.go`。**不做**「通用 Gemini 层」抽象 —— 目前只有一个消费者。
 *
 * ## 三条必须保留的上游对齐细节
 *
 * 1. **role 只有 `user` / `model`**（assistant → `model`，其余 → `user`）。
 * 2. **历史里的 thinking 块不回传**，但它的 `thoughtSignature` 要**搬到**
 *    同一消息内后续的 `functionCall` part 上（Gemini 的签名机制要求签名挂在
 *    functionCall 上，而不是独立 thinking part 上）。见 {@link translateGeminiRequest}。
 * 3. **`functionResponse` 的 `name` 必须来自对应 `tool_use` 的 name**（上游按
 *    name 而非 id 配对），故先扫全消息建映射。
 *
 * ## ⚠️ SSE 收尾余量必须按整行再走一遍
 *
 * 与 `consumeMinimaxSse` 同一个真实缺陷（2026-09-29 由单测抓到）：只在
 * `while (!done)` 里按行处理时，**流结束时 buffer 里残留的最后一条事件永远
 * 不会被处理**。真实 SSE 大多以空行结尾（恰好掩盖它），但被截断的流会让携带
 * `finishReason` 与 `usageMetadata` 的末帧被静默丢弃。故 `processFrame` 抽成
 * 嵌套生成器，收尾时把余量按整行再走一遍。
 */
import type { ContentBlock, FinishReason, RequestMessage as Message, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { GeminiInlineImage, GeminiModelSpec } from './gemini.js';
/** 一个 `part`。字段名与上游逐字一致。 */
export interface GeminiPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: {
        name: string;
        args?: Record<string, unknown>;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    inlineData?: {
        mimeType: string;
        data: string;
    };
}
/** 一条 `content`（role + parts）。 */
export interface GeminiContent {
    role: string;
    parts: GeminiPart[];
}
/** 上游 `usageMetadata`。 */
export interface GeminiUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
}
/** 上游响应壳里的 `candidate`。 */
export interface GeminiCandidate {
    content?: {
        role?: string;
        parts?: GeminiPart[];
    };
    finishReason?: string;
}
/** 上游 `Response`（信封内层）。 */
export interface GeminiResponse {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
    modelVersion?: string;
    responseId?: string;
}
/** 请求信封（`Envelope`）。 */
export interface GeminiEnvelope {
    model: string;
    project: string;
    request: {
        contents: GeminiContent[];
        systemInstruction?: {
            role: string;
            parts: GeminiPart[];
        };
        tools?: Array<{
            functionDeclarations: Array<Record<string, unknown>>;
        }>;
        toolConfig?: Record<string, unknown>;
        generationConfig?: Record<string, unknown>;
        sessionId: string;
    };
    requestId: string;
    userAgent: string;
}
/** 签名查表回调（命中返回签名）。 */
export type GeminiSignatureLookup = (name: string, argsJson: string) => string | undefined;
/** 签名收集回调（上游下发了签名时调用）。 */
export type GeminiSignatureSink = (name: string, argsJson: string, signature: string) => void;
/**
 * 参数规范化：按键名升序的紧凑 JSON。
 *
 * ⚠️ 签名键 = `SigKey("tool:"+name, canonicalArgs)`，故**两侧必须用同一个
 * 规范化**——回填时若用不同序列化算出不同的键，签名永远查不中（表现为
 * 「每轮都要去签重试」）。
 */
export declare function canonicalArgs(args: unknown): string;
/** {@link translateGeminiRequest} 的入参。 */
export interface TranslateGeminiRequestOptions {
    modelId: string;
    spec: GeminiModelSpec;
    messages: readonly Message[];
    system?: string;
    tools?: readonly ToolSchema[];
    toolChoice?: unknown;
    temperature?: number;
    maxTokens?: number;
    /**
     * 覆盖信封里的 `sessionId`。
     *
     * ⚠️ 缺省时走**内容派生**（`project` + 首条 user 文本 + `sessionLane`），
     * 不是常量 —— 见 `deriveGeminiSessionId`。要复刻历史抓包才显式钉住。
     */
    sessionId?: string;
    /** 会话派生标签（推理 / 冒烟），缺省 {@link GEMINI_SESSION_LANE_INFER}。 */
    sessionLane?: string;
    /**
     * 取该**基础 sessionId 的当前代数**（会话升代自愈用）。
     *
     * ⚠️ 只有未显式传 `sessionId` 时才参与。返回值 ≤ 0 表示不升代。
     * 见 `deriveGeminiSessionId` 的 `generation` 段。
     */
    sessionGeneration?: (baseSessionId: string) => number;
    project?: string;
    requestId: string;
    /** 已内联的图片（attachmentId → base64）。缺失时遇图**抛错**。 */
    images?: ReadonlyMap<string, GeminiInlineImage>;
    /** 签名查表（回填 functionCall 的 `thoughtSignature`）。 */
    lookupSignature?: GeminiSignatureLookup;
}
/**
 * 取信封里**第一条 user 消息的首个文本 part**（sessionId 派生的输入之一）。
 *
 * ⚠️ 实测口径（2026-10-05 对照实验，6 个样本全部自洽）：只有 `contents[0]`
 * 参与，且只看其中的文本 part —— `["AAA"]` 与 `["AAA","ZZZ"]` 同值、
 * `["ZZZ","AAA"]` 与 `["ZZZ"]` 同值（后续文本不进哈希）。
 */
export declare function geminiFirstUserText(contents: readonly GeminiContent[]): string;
/**
 * 把 DSH 请求翻译成上游信封。
 *
 * ⚠️ 返回的是**字母序已排好的普通对象**；序列化必须走
 * `marshalAlphabetical`（`gemini.ts`），否则与上游看到的字节不同。
 */
export declare function translateGeminiRequest(options: TranslateGeminiRequestOptions): GeminiEnvelope;
/** {@link translateGeminiResponse} 的入参。 */
export interface TranslateGeminiResponseOptions {
    response: GeminiResponse;
    /** 签名收集（上游下发了签名时调用）。 */
    onSignature?: GeminiSignatureSink;
}
/** 非流式响应 → DSH 的块列表 + 结束原因 + 用量。 */
export interface TranslatedGeminiResponse {
    blocks: ContentBlock[];
    reason: FinishReason;
    usage: Partial<TokenUsage>;
}
/** 把上游非流式响应翻成 DSH 形状。 */
export declare function translateGeminiResponse(options: TranslateGeminiResponseOptions): TranslatedGeminiResponse;
/**
 * 上游 `finishReason` → DSH 的 {@link FinishReason}。
 *
 * ⚠️ 未知/缺失一律 `stop`：不能编造成 `error`（那会让 harness 重试一个其实
 * 成功的响应）。有工具调用时以 `tool-calls` 为准。
 */
export declare function mapGeminiFinish(reason: unknown, toolCalls: number): FinishReason;
/**
 * 上游 `usageMetadata` → DSH 的 {@link TokenUsage}。
 *
 * ⚠️ DSH 的计数**互斥**：`inputTokens` 只含**未缓存**输入，缓存走
 * `cacheReadTokens`（计费输入 = 两者之和）。上游的 `promptTokenCount` 是
 * **含缓存**的总量，故要减掉 `cachedContentTokenCount` —— 否则缓存命中的
 * 那部分会被**双重计费**。
 * ⚠️ `thoughtsTokenCount` 是 output 的**子集**，映射到 `reasoningTokens`，
 * **不加**到 `outputTokens` 上。
 */
export declare function readGeminiUsage(raw: GeminiUsageMetadata | undefined): Partial<TokenUsage>;
/** {@link consumeGeminiSse} 的入参。 */
export interface ConsumeGeminiSseOptions {
    /** SSE 字节流（`response.body`）。 */
    body: ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    /** 签名收集（thought / functionCall part 上带签名时调用）。 */
    onSignature?: GeminiSignatureSink;
    /**
     * 空闲超时（毫秒）。缺省用 {@link GEMINI_IDLE_TIMEOUT_MS}。
     *
     * ⚠️ **必须主动掐**：上游在生成大 functionCall 参数期间可能长时间不 flush
     * 任何字节，裸 `reader.read()` 会**无限期挂起** —— 适配器的 generator
     * 永不返回，harness 当前步骤既不出结果也不报错（见 `src/sse.ts:1-10`）。
     */
    idleTimeoutMs?: number;
    /** 首 token 单独的超时（缺省同 `idleTimeoutMs`）。 */
    firstTokenTimeoutMs?: number;
}
/**
 * 消费上游 SSE，产出 DSH 的 {@link StreamChunk}。
 *
 * ⚠️ 上游每帧是 `{"response":{...}}` **或**裸 `Response`，且**只有
 * `candidates` 非空才算内容帧** —— 纯 `usageMetadata` 的收尾帧要继续读
 * （原版 `SSEReader.Event()` 的口径）。
 * ⚠️ `data: [DONE]` 结束。
 * ⚠️ 用量取「见过的**最大** `totalTokenCount` 的那一份」—— 上游会在多个帧里
 * 重复播报 usage，早期帧的数字偏小。
 */
export declare function consumeGeminiSse(options: ConsumeGeminiSseOptions): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=gemini-messages.d.ts.map