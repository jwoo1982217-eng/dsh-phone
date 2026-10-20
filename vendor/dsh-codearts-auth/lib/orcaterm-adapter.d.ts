/**
 * 腾讯 OrcaTerm（遨驰终端）LLM adapter。
 *
 * 把腾讯云 ligai 网关的 ACP 协议（`/assistant/chat`）投影成 harness 的 provider 合约。
 * 与仓库里其余 adapter 的差异集中在三处，全部由 {@link ORCATerm} 的字段驱动：
 *
 * 1. **凭据不是 bearer token**，而是腾讯云网页登录态 cookie（`uin`/`skey`）或桌面
 *    `ot_session` JWT。两者请求头不同：网页形态**只带 Cookie**，补一个
 *    `Authorization: Bearer` 会被上游按 ot_session 校验并返回 `code=10050000`；
 *    桌面形态则必须同时带 Bearer 与 Cookie。{@link authHeaders} 是唯一的裁决点。
 * 2. **请求体是 ACP 信封**：`input.input` 是 `{"_format":"acp-prompt",…}` 的**字符串**，
 *    不是 `messages` 数组；模型 id 必须上游全名，短名会被静默吞掉。
 * 3. **流式不是纯文本增量**：上游 SSE 的 `content` 字段拼起来是整个响应信封
 *    JSON（`{action,thinking,taskCompletion}`），答案文本本身以 JSON 转义形态分帧到达。
 *    {@link OrcaTermEnvelopeParser} 负责在任意帧切点上增量解码。
 *
 * @module orcaterm-adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm';
/** 从账号池取到的一件凭据。两种形态互斥，由 `kind` 区分。 */
export type OrcaTermCredential = {
    kind: 'web';
    uin: string;
    skey: string;
    userId: string;
} | {
    kind: 'desktop';
    otSession: string;
};
/** 网页 cookie 串形态（`uin=…; skey=…; userId=…`）。 */
export declare function webCookieString(credential: Extract<OrcaTermCredential, {
    kind: 'web';
}>): string;
/**
 * 请求头裁决点。
 *
 * ⚠️ 网页形态**刻意不加** `Authorization`：实测给它补 Bearer 会让上游按
 * ot_session 校验并失败（`code=10050000 Invalid or expired AccessToken`），
 * 而只带 Cookie 时 HTTP 200 正常出字。
 */
export declare function authHeaders(credential: OrcaTermCredential): Record<string, string>;
/** 从 ot_session JWT 的 payload 取 userId（不验签）。 */
export declare function userIdFromJwt(jwt: string): string;
/** 账号 userId：网页形态用 cookie 里的 userId，回退 uin 去 `o` 前缀。 */
export declare function credentialUserId(credential: OrcaTermCredential): string;
/** ACP 信封字符串（放进 `input.input`）。 */
export declare function acpPrompt(text: string): string;
/** 上游请求体。 */
export declare function buildRequestBody(credential: OrcaTermCredential, text: string, model: string, stream: boolean, emphasisPrompt?: string): Record<string, unknown>;
/**
 * 把 harness 消息折叠成本次输入文本。
 *
 * 单条用户消息原样发送；多条压成 `【角色】正文` 转写，保证上下文不丢。
 */
export declare function composeInputText(options: GenerateOptions): string;
/** 上游响应信封的解析结果。 */
export interface OrcaTermResult {
    action: string;
    text: string;
    thinking: string;
    tool?: {
        name?: unknown;
        args?: unknown;
    };
    truncated?: boolean;
}
/** 上游错误，`code` 供 harness 的重试策略判定。 */
export declare class OrcaTermError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/** 鉴权失效判定：上游 HTTP 200 但信封 code 非 0，或裸 HTTP 500 NEED_UIN_AND_SKEY。 */
export declare function isAuthFailure(code: number, message: string): boolean;
/** 从信封 data 取结果。 */
export declare function readEnvelope(data: Record<string, unknown>): OrcaTermResult;
/**
 * 上游 SSE 信封的增量解码器。
 *
 * 上游 `stream:true` 时推 `data: {"content":"…"}`，`content` 拼起来是**整个**响应信封
 * JSON 的原文（含 JSON 转义）。本类边收边解出目标字段（`taskCompletion` / `question`）
 * 的明文增量，并在任意帧切点保持正确：
 *
 * - 转义符被帧边界切断（`\` 结尾）→ 等下一帧；
 * - `\uXXXX` 只收到一半 → 等下一帧；
 * - 结构键还没到齐 → 保持 `fieldStart = -1`，下一帧重试。
 *
 * ⚠️ 用「解出全 ASCII」当凭据正确性的判据，错误的 key 不会产出可打印明文。
 */
export declare class OrcaTermEnvelopeParser {
    private readonly allowMixedReview;
    constructor(allowMixedReview?: boolean);
    private accum;
    private action;
    private actionEnd;
    private fieldStart;
    private out;
    private closed;
    private thinkingOut;
    private plain;
    get currentAction(): string | null;
    get text(): string;
    get thinking(): string;
    /** 喂入一个 content 增量，返回新解出的明文增量（可能为空串）。 */
    feed(delta: string): string;
    /** 信封原文（收尾整包解析用）。 */
    rawEnvelope(): string;
    /** 服务端可能在 review 后继续追加另一个动作；只取完整的第一个动作对象。 */
    firstResult(): OrcaTermResult | undefined;
    /** 完整响应优先解析动作对象；正常 JSON/代码/纯文本答案保持原样。 */
    result(truncated?: boolean): OrcaTermResult;
    private detectAction;
    private ensureField;
}
/** 非流式一轮。 */
export declare function completeOnce(credential: OrcaTermCredential, text: string, model: string, signal?: AbortSignal): Promise<OrcaTermResult>;
/** 流式一轮；`onDelta` 收到明文增量。 */
export declare function completeStreamed(credential: OrcaTermCredential, text: string, model: string, signal: AbortSignal | undefined, onDelta: (delta: string) => void, channel?: {
    emphasisPrompt?: string;
    onThinking?: (delta: string) => void;
    tools?: readonly ToolSchema[];
    discoveredTools?: ReadonlySet<string>;
}): Promise<OrcaTermResult>;
type StreamEvent = StreamChunk;
/** OrcaTerm provider adapter。 */
export declare class OrcaTermAdapter {
    private readonly deps;
    constructor(deps: {
        /** 取该 provider 的可用账号（账号池 + 凭据解析）。 */
        resolveCredential: (modelId: string) => Promise<OrcaTermCredential | undefined>;
        /** 记录一次用量（失败也要记），供面板展示。 */
        recordUsage?: (record: {
            at: number;
            model: string;
            ok: boolean;
            input: number;
            output: number;
        }) => void;
        /** 最近一次失败原因，面板展示。 */
        warn?: (message: string) => void;
    });
    imageRequestPricing(): undefined;
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    /** 上游只有 500/网络类错误值得重试；AUTH 要用户重新登录。 */
    providerRetryPolicy(): Record<string, unknown>;
    /**
     * 全量目录（**同步**，不套失效黑名单）。
     *
     * ⚠️ 契约要求同步：`modelAdapters` 表的类型是
     * `{ listAllModels(): readonly {id,name}[] }`，Jet Hub RPC 在「关闭整个
     * provider」时用它的长度当分母算 `closed = total>0 && disabled===total`。
     * 返回 Promise 会让该判据恒假 ⇒ provider 显示已关闭但模型仍可选。
     *
     * 目录是静态表（上游不接受动态列举，只有全名有效），故无需 async。
     */
    listAllModels(): ReadonlyArray<{
        id: string;
        name: string;
    }>;
    listModels(provider: string): Promise<Array<Record<string, unknown>>>;
    resolveModel(provider: string, model: string): Promise<Record<string, unknown>>;
    prepareCall(provider: string, model: string): Promise<Record<string, unknown>>;
    /** 包装成可中止的 async iterator（与其余 adapter 同款）。 */
    stream(options: GenerateOptions): AsyncIterableIterator<StreamEvent> & {
        [Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent>;
    };
    private runStream;
}
/**
 * 注册 OrcaTerm 适配器。
 *
 * @param ctx cordis 上下文
 * @param options 账号池接线：凭据解析、用量记账、告警
 * @returns adapter 实例（供 index.ts 记录与 `pruned()` 查询）
 */
export declare function registerOrcaTermLlm(ctx: Context, options: {
    resolveCredential: (modelId: string) => Promise<OrcaTermCredential | undefined>;
    recordUsage?: (record: {
        at: number;
        model: string;
        ok: boolean;
        input: number;
        output: number;
    }) => void;
    warn?: (message: string) => void;
}): OrcaTermAdapter;
export {};
//# sourceMappingURL=orcaterm-adapter.d.ts.map