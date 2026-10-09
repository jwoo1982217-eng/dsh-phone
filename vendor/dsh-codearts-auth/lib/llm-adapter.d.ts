import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import type { CodeArtsCredential } from './types.js';
export declare const CHAT_API_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2";
export declare const PROVIDER = "codearts";
export interface CodeArtsAdapterOptions {
    credentialRef: CredentialRef;
    resolveCredential: () => Promise<CodeArtsCredential | undefined>;
    refresh: () => Promise<void>;
    /** 动态拉取远端模型列表；失败时调用方回退到静态列表。 */
    fetchRemoteModels?: () => Promise<Array<{
        id: string;
        name: string;
    }>>;
    fetchImpl?: typeof fetch;
    chatId?: string;
    sessionId?: string;
    /** 多账号池（用于限流时切换账号） */
    accountPool?: AccountPool;
}
/**
 * 将 harness 对话消息序列化为 CodeArts chat-completions 的传输
 * 格式。助手的 `tool-call` 块转换为 `tool_calls` 字段；`reasoning`
 * 块折叠为 `reasoning_content` 字段（deepseek-v4 等推理模型的后端
 * 校验要求 assistant 消息必须携带该字段，缺失会报 "Missing
 * `reasoning_content` field"）；工具结果（搭载在 harness 用户消息中）
 * 展开为独立的 `{role: 'tool'}` 消息，使模型能看到其调用的返回值。
 * 其余非文本块（图片）被丢弃，与端点接受的格式一致。
 *
 * ⚠️ 入口先做 **DSH 0.1.7 消息形状归一化**（见 `message-shape.ts`）：0.1.7 把工具
 * 结果改为一等 `role:'tool'` 消息，若不归一化，下面的 `type === 'tool-result'`
 * 判据恒不命中 → 工具调用被 `resolveToolPairing` 整体剔除。
 */
export declare function serializeMessages(messages: readonly {
    role: string;
    content: unknown;
}[]): Array<Record<string, unknown>>;
/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export declare const QUEUE_STATUS_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status";
/**
 * 把「距重置还有多久」格式化成中文短句。
 *
 * 用户需求（2026-10-02）：「其它渠道限额到了会提示多少时间后会解除限额，
 * 这个 codearts 的也加上吧」—— 其它渠道（buddy / workbuddy）由**服务端**
 * 在错误文案里给出重置时刻，故 `parseRateLimitError` 能解析；CodeArts 的
 * benefit 额度报文里**没有**任何时间字段（实测 `InferHub.4291.200` 的
 * `details` 只有 requestId / timestamps / modelId / traceId），因此按
 * **UTC+8 自然日**自行推算（见 {@link codeartsQuotaExhaustedMessage}）。
 *
 * @param resetAtMs - 解禁时刻（UTC 毫秒）。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export declare function formatResetIn(resetAtMs: number, nowMs?: number): string;
/**
 * 额度用尽时给用户看的完整说明（**含解禁时间**，这是用户明确要求的）。
 *
 * ## 为什么按「UTC+8 次日 00:00」推算
 *
 * CodeArts 的 benefit（免费额度）模型（`glm-5.3-flash` / `deepseek-v4.1-flash`）
 * 额度按**自然日**结算（IDE 模型卡标注「每日 1000 万免费 Tokens」），而
 * `InferHub.4291.200` 的报文里**不给重置时刻**。故与 `qoder` / `zcode` 的
 * 额度处理同款：复用 {@link nextUtc8DayStartMs} 取 UTC+8 当日 24:00，
 * **不能**复用 `parseRateLimitError`（它解析不到时间时退回「1 小时后」，
 * 对按日结算的额度会让标记过早失效，用户 1 小时后再撞一次同样的墙）。
 *
 * ⚠️ 措辞对「这是我们的推算」保持诚实：写「预计」，不谎称是服务端给的时间。
 *
 * @param model - 请求的模型 id（用户据此决定换哪个）。
 * @param resetAtMs - 推算出的解禁时刻。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export declare function codeartsQuotaExhaustedMessage(model: string, resetAtMs: number, nowMs?: number): string;
/** CodeArts 后端返回的一次排队状态响应。 */
export interface CodeArtsQueueStatus {
    readonly status: 'waiting' | 'working' | 'error' | 'queue_full';
    readonly queuePosition: number;
    readonly message: string;
}
/**
 * 判断 SSE 流内返回的 error_code 是否属于**可重试**的排队/限流错误。
 *
 * CodeArts 以 HTTP 200 + SSE 内嵌 `error_code` 返回这类错误（例如
 * `InferHub.ModelArts.81111.429` TPM 每分钟 token 超限），而不是 4xx——
 * 适配器把它们当成排队处理：延迟后重试整个 chat 请求，与 TM.00001041
 * 行为一致，避免"思考后无输出"。
 *
 * ## ⚠️ 判据必须锚定「429」这个**独立数字**，不能用裸子串（真实缺陷）
 *
 * 原实现写作 `/81111|TPM|429|rate.?limit|…/`，其中 `429` 是**无边界子串**匹配，
 * 于是额度耗尽码 `InferHub.4291.200` 里的 `4291` **命中了 `429` 前缀** ——
 * 被误判成「可重试的排队限流」，进入每 10 秒重试、上限 180 次（30 分钟）的
 * 静默重试循环。
 *
 * 实测（2026-10-02，用户在本机真实凭据上的会话）：
 * ```
 * isSseQueueErrorCode('InferHub.4291.200') === true    ← 误判
 * 匹配到的子串: "429"
 * ```
 * 后果是**界面完全无输出**：`stream()` 在排队期间刻意不产出任何内容块
 * （见下方排队循环的长注释），而它误以为自己"在排队"。实测真实适配器
 * 25 秒内发出 4 次 chat 请求 + 3 次排队探测、**产出 0 个 chunk**，最终由
 * 用户手动中止（会话记录里是 `turn/end aborted` + `stream: []`，**没有任何
 * error 事件** —— 因为错误根本没被抛出）。这正是用户报障的「CodeArts Agent
 * 没反应」。
 *
 * ⇒ 现在 `429` 用 `(^|[^0-9])429([^0-9]|$)` 锚定为独立数字：`…81111.429`（结尾）
 * 与 `429 Too Many Requests`（后接空格）仍命中，而 `4291` 不再命中。
 * 额度耗尽的 `4291` 由 {@link isSseQuotaExhaustedErrorCode} 单独识别。
 *
 * 导出仅供单测直接锁定「`429` 的边界」这一判据本身 —— 若只靠调用点的先后顺序
 * （额度判据排在排队判据之前）来兜住 `4291`，那么把边界改回裸子串时**任何**
 * 端到端用例都不会变红（实测确认过），边界就成了没人守的装饰。
 */
export declare function isSseQueueErrorCode(code: string): boolean;
/**
 * 判断 SSE 流内返回的 error_code 是否表示**额度已用尽**（不可重试）。
 *
 * 实测报文（2026-10-02，真实凭据）：
 * ```
 * HTTP 200  data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota",
 *                 "details":[…requestId…timestamps…modelId: deepseek-v4.1-flash…traceId…]}
 * ```
 * 同账号的 `deepseek-v4-flash`（非 benefit 通道）仍正常出流 —— 故这是
 * 「该模型 + 该账号的免费额度用尽」，不是账号欠费（同期 `statistics/plugin`
 * 显示积分余额仍有 8499.84）。
 *
 * 与「排队/限流」是**本质不同**的两件事，绝不可合并（同 `qoder` 的
 * `10605` 排队 vs `110` 额度那次教训，见 `AGENTS.md`）：
 *
 * | | 排队/TPM 限流 | 额度用尽 |
 * |---|---|---|
 * | 语义 | **暂时**受阻，等一会儿就通 | **额度真的没了**，重试无意义 |
 * | 处理 | 内部等待后重试 | **立即失败**并如实告知 |
 *
 * 判据用**子串** `4291`（而非全等）是刻意的：该码由服务端下发，本地产物里
 * 没有硬编码（同 `qoder` 的 `110`），若上游改用 `InferHub.4291.xxx` 的其它
 * 尾号表达同一语义，只认全等会漏判。`4291` 与排队族的 `81111` / 独立的
 * `429` 均不冲突。
 *
 * 文案兜底（`insufficient quota`）不可省：万一上游换了码值，序列化后的
 * detail 文本仍能命中 —— 与 `zcode` / `qoder` 的既有做法一致。
 */
export declare function isSseQuotaExhaustedErrorCode(code: string, message: string): boolean;
/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export declare class CodeArtsAdapter extends LlmAdapter {
    private readonly options;
    private readonly fetchImpl;
    private readonly chatId;
    private readonly sessionId;
    constructor(options: CodeArtsAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
     * 入参异常时回退到 PROVIDER 常量，避免客户端抛
     * `undefined.toUpperCase is not a function`。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    private remoteModels;
    /**
     * 目录加载闸门：并发去重 + 失败冷却。
     *
     * ⚠ **不能省**：DSH 的 `buildModelCatalog` 对每个 provider `await listModels()`
     * 后再对每个模型 `await resolveModelInfo()`，两处都会走到这里。原实现失败
     * 直接返回（不落缓存）⇒ 一次网络故障被放大成「每模型重试一次」，每次顶着
     * 10s 超时（`src/models.ts:55 FETCH_TIMEOUT_MS`），首屏因此长时间空转。
     */
    private readonly catalogGate;
    /**
     * 懒加载远端模型目录。resolveModel 可能先于 listModels 被调用
     * （如直接进入会话），此时同样触发远端拉取。
     */
    private ensureRemoteModels;
    /**
     * 完整模型目录（**不应用用户黑名单**）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。CodeArts 目录虽无倍率，但同样
     * 需要正确的 `name`（否则关闭项显示 `deepseek-v4-flash` 这类裸 id）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 消费一个 HTTP 200 的 SSE chat 响应并产出 StreamChunk。
     *
     * CodeArts 后端有时以 HTTP 200 + SSE 内嵌错误事件的形式返回排队/限流
     * （如 `InferHub.ModelArts.81111.429` TPM 超限，事件形如
     * `{"text":"[DONE]","error_code":"...","error_msg":"..."}`），而不是
     * 4xx——这类错误若直接当成流结束会被静默吞掉（表现为"思考后无输出"）。
     * 本方法解析每个 SSE 事件的 `error_code`/`error_msg`：可重试的排队/限流
     * 错误抛 {@link SseQueueRetryError} 让外层重试循环按 TM.00001041 同等
     * 处理（10s 间隔重试整个 chat 请求）；不可重试错误抛普通 LlmError。
     */
    private consumeSse;
    /**
     * 查询某个会话的 CodeArts 并发队列状态。该端点
     * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
     * @param credential - 用于签名请求的 AK/SK/SecurityToken。
     * @param model - 模型 id，作为 `model` 查询参数回传。
     * @param signal - 状态请求的取消信号。
     * @returns 解析后的排队状态，或当端点不可达
     *   或返回无法识别的载荷时返回 `undefined`。
     */
    private queryQueueStatus;
}
/** 在 ctx.llm 上注册 codearts 提供商路由和适配器。 */
export declare function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): CodeArtsAdapter;
/**
 * 腾讯网关「**模型饱和**」业务码（HTTP 429）。
 *
 * ## 它必须与额度限流（6004）分开（真实报障，2026-10-05）
 *
 * 用户第一次用 `buddy/space-bunny` 就报「模型 space-bunny 所有账号均受限」。
 * 直连实测（`scripts/probe-buddy-error-catalog.mjs`）逼出了服务端原话：
 * ```json
 * {"code":14003,"msg":"too many requests",
 *  "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 *  "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},
 *  "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
 * ```
 *
 * ⚠️ **它自己就说明了「这不是账号问题」**（注意 `actions` 里根本没有换号的选项，
 * 只有 `SWITCH_MODEL`）。但 `isRateLimited` 对 **429 无条件返回 true** ⇒
 * 适配器把每个账号都写上「1 小时限流」标记（报文无「将在…重置」，
 * 故取 `RATE_LIMIT_FALLBACK_MS` 兜底）⇒ 4 个独立账号在 20 秒内**全部**被锁
 * ⇒ 用户等到 1 小时也不能用，且**期间连别的模型都受影响**（同一个账号池）。
 *
 * 实测证据（同型缺陷的判据来源）：
 * | 观测 | 结果 |
 * |---|---|
 * | 4 个不同腾讯 uid 的账号 | 20 秒内**全部**被标记 `space-bunny` |
 * | 标记解禁时刻 | 全部等于「写入 + 整 1 小时」= 兜底值，**非**服务端给的时刻 |
 * | 4 MB 输入 | 稳定逼出 `429 / 14003`（46~111 秒才返回） |
 * | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s —— 上游是**时变**背压 |
 *
 * ⇒ 「4 个互不相干的账号同时中招」在账号级限流下无法解释，**只能**是模型级。
 * 与 zcode `3009 model concurrency limit exceeded` 同型（那边结论同样是
 * 「退避重试，**不换号、不标记**」）。
 *
 * ⚠️ **不许把 14003 并进 `RATE_LIMIT_BUSINESS_CODE`**：两者的正确动作相反 ——
 * 6004 是「这个账号在这模型上的额度用完了」（换号有效、必须标记）；
 * 14003 是「这个模型此刻整体饱和」（换号**无益**、**不许**标记）。
 */
export declare const MODEL_SATURATION_BUSINESS_CODE = 14003;
/**
 * 判断一次失败是否为**模型饱和**（上游背压），而非账号级额度限流。
 *
 * ## 为什么这个区分是**行为分叉**而不是措辞问题
 *
 * | | 额度限流 `6004` | 模型饱和 `14003` |
 * |---|---|---|
 * | 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
 * | 换号 | **有效**（别的账号有独立额度） | **无益**（所有账号撞同一堵墙） |
 * | 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会把整池锁 1 小时） |
 * | 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |
 *
 * 实测 `actions` 字段本身就写着 `SWITCH_MODEL` 而**没有**换号选项 ——
 * 服务端与我们的结论一致。
 *
 * ⚠️ **必须先于 `status === 429` 的无条件判定**：14003 恰恰是 429，
 * 若先判状态码就永远走不到这里（这正是缺陷的成因，见常量注释）。
 *
 * @param status - HTTP 状态码。为 `undefined`（只有文案可判）时仍检查业务码；
 *   但**文案分支要求状态码 ≥ 400** —— 否则一段正常正文里出现「模型繁忙」
 *   就会被判成错误。
 * @param body - 响应体（可能为空串）。
 */
export declare function isModelSaturationError(status: number | undefined, body: string): boolean;
/**
 * 判断错误文本是否为频率限制错误。
 *
 * @param body - 响应体（可能为空串）
 * @param status - HTTP 状态码（可选，但**手里有 Response 就必须传**）。为 `429`
 *   时无条件判为限流，即使响应体为空、不含任何可识别文案。
 *
 * ⚠️ **`status` 判据是真实缺陷的修复，不是可选便利**：本函数原先只接收响应体，
 * 而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的 429 —— 此时
 * `hasRateLimitBusinessCode` 与 `RATE_LIMIT_PATTERN` **双双不命中**，函数返回
 * `false`，于是适配器里整段「记录重置时间 + 切换账号」逻辑被**整体跳过**，
 * 把一个本可自愈的限流直接抛给用户（表现为「账号池里明明还有可用账号，插件却
 * 报错且不换号」）。
 *
 * 判据顺序刻意是「状态码优先」：429 是 HTTP 语义上**唯一**的限流信号，无需也不应
 * 再去猜文案；下面的文案 / 业务码兜底只服务于「状态码不是 429、但正文表达了限流」
 * 的场景（业务码 6004、SSE 流内错误、网关包装过的 200/400）。
 *
 * ⚠️ 反向的约束同样重要：**非 429 绝不能因为「有状态码」就判为限流** ——
 * 404「模型不存在」这类换号无益的错误若被识别成限流，会被吞成「所有账号均受限」，
 * 用户既看不到真实原因、插件还会白试一遍全池账号。
 */
export declare function isRateLimited(body: string, status?: number): boolean;
/**
 * 限流文案里解析不出重置时刻时的**兜底时长**（1 小时）。
 *
 * 为什么需要兜底而不是「解析不到就不记标记」：网关 / CDN 返回的 429 常常既没有
 * 重置时间、甚至**没有响应体**，而标记是 UI「限额重置」徽章与「重测 / 重置」
 * 两条人工解禁路径的**唯一**依据 —— 静默跳过记录会让用户既看不到限流、也无从操作。
 *
 * ⚠️ 1 小时是**快照式**兜底（标记可被重测刷新），与 `BUDDY_POLICY_BLOCK_COOLDOWN_MS`
 * 的 30 分钟**语义不同**（那是「安全策略拦截」的本地冷却，报文里根本没有时间字段），
 * 也与 Qoder「按自然日 24:00」不同（那是按日的额度结算）。三者不要合并成一个常量。
 *
 * 导出是给 `buddy-adapter` 用的：它需要在**没拿到可解析体**时也能写出标记，
 * 且必须与这里 `parseRateLimitError` 的兜底**同值**，否则两处口径会漂。
 */
export declare const RATE_LIMIT_FALLBACK_MS = 3600000;
/**
 * 从限流错误中提取重置时间；体里没有时间时返回 {@link RATE_LIMIT_FALLBACK_MS} 兜底。
 *
 * @param status - HTTP 状态码（可选）。为 `429` 时即使**体为空、或无任何可识别文案**
 *   也按兜底时长返回一条，避免调用方「识别出限流却没有标记可写」（见
 *   {@link RATE_LIMIT_FALLBACK_MS} 的说明）。
 */
export declare function parseRateLimitError(body: string, currentModel: string, status?: number): {
    modelId: string;
    resetTimeMs: number;
} | null;
//# sourceMappingURL=llm-adapter.d.ts.map