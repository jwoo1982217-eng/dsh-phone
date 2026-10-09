/**
 * OpenCode Zen 产品配置与错误分类。
 *
 * ## 数据来源（设计文档 §0）
 *
 * 1. 端点 / 免费模型清单：官方 docs https://opencode.ai/docs/zen/ （2026-10-01 采集）
 * 2. 错误类型名：opencode 官方源码 `packages/opencode/src/session/retry.ts`
 *    （`FreeUsageLimitError` / `GoUsageLimitError` + `retry-after` 头）
 *
 * ## ⚠️ 为什么按「错误类型名」而不是「状态码」分类
 *
 * 本仓库 qoder 曾因「用错误码的默认归类代替业务语义判断」把确定性的额度耗尽
 * 当成可重试的 SERVER 而白重试 5 次；minimax 也曾把 402 归 AUTH 让用户
 * 看不到「去充值」这个唯一有效动作。Zen 的额度错误可能带 400/401/403/429
 * 任一状态码，唯一稳定的信号是**响应体里的错误类型名**。
 *
 * ## ⚠️ 身份结论（本 provider 设计的基石）
 *
 * opencode CLI 发往 Zen 的请求**没有任何机器级指纹**（1.18.22 源码逐行核对：
 * 无 machine-id / deviceId / 安装 ID / 遥测）。身份只有三个维度：
 * **出口 IP、API key（账号）、随机会话 id**。
 * ⇒ 「换一台 PC」在协议层等价于「换一个 key 或换一个出口 IP」，
 * 指纹派生的作用是**防关联**与满足形状门禁，不是换配额桶。
 */
export interface OpencodeProduct {
    readonly id: 'opencode';
    readonly displayName: string;
    readonly baseUrl: string;
    readonly chatPath: string;
    readonly modelsPath: string;
    readonly chatHeaderTimeoutMs: number;
    readonly chatChunkTimeoutMs: number;
    readonly anonymousKey: string;
    readonly defaultUserAgent: string;
    /**
     * 模型能力元数据源（**远端**，能力的主来源）。
     *
     * ⚠️ 不是 `/zen/v1/models` —— 实测它只返回 `id`/`object`/`created`/
     * `owned_by` 四个字段，**不含任何能力信息**（85 条全如此）。
     * 能力在 **models.dev** 的 `opencode` 条目里，官方 CLI 自己就用它
     * （`packages/core/src/models-dev.ts`）。见 `opencode-capability.ts`。
     */
    readonly modelsDevUrl: string;
    /** 能力表缓存 TTL（与官方 CLI 的 60 分钟同档）。 */
    readonly modelsDevTtlMs: number;
}
export declare const OPENCODE: OpencodeProduct;
export declare const OPENCODE_MODELS_DEV_URL: string;
export declare const OPENCODE_MODELS_DEV_TTL_MS: number;
/** 兜底模型目录条目。 */
export interface OpencodeFallbackModel {
    id: string;
    name: string;
    /** 是否为官方定价表标注的免费模型（匿名槽只能选这些）。 */
    isFree: boolean;
    /** 上下文窗口（DSH 以它 × 0.8 作压缩阈值）。 */
    contextWindow: number;
}
/**
 * 兜底模型表（**以真机实测为准**，2026-10-01）。
 *
 * ⚠️ 每条都对应 `docs/superpowers/specs/2026-10-02-opencode-zen-endpoint-matrix.md`
 * 里一次成功的真实请求。`isFree` 的含义是「**匿名通道**（`Bearer public`）
 * 能否使用」，不是官方定价表的 Free 标记 —— 这是本插件唯一关心的维度。
 *
 * ⚠️ `ling-3.0-flash-fin-free` **已移除**：官方 docs 说它走 `/v1/messages`
 * （Anthropic），而该端点当前对匿名与付费 key 都返回 500（与 body 形态无关），
 * chat 端点则是 404 路由不存在 ⇒ 它在两条通道上都不可用，留在目录里只会
 * 让用户点到一个必然失败的模型。
 */
export declare const OPENCODE_FALLBACK_MODELS: readonly OpencodeFallbackModel[];
/**
 * 该模型是否属免费（匿名槽只接受免费模型）。
 *
 * ⚠️ **未知模型返回 false**：远端目录可能含表外的新免费模型，
 * 但在未实测前把它们放给匿名槽只会换来 403/500；宁可要求用户加一个付费账号。
 */
export declare function isFreeOpencodeModel(id: string): boolean;
/**
 * 该模型在我们**已实现并实测可达**的通道里是否存在。
 *
 * ## 为什么远端目录必须过这道闸（真实报障 2026-10-01）
 *
 * `GET /v1/models` 返回全部 84 个模型，且**不含任何协议信息**
 * （字段只有 id/object/created/owned_by）。若直接把它们交给 DSH，
 * 用户会在选择器里看到 `ling-3.0-flash-fin-free`、`claude-*`、
 * `gpt-*` 等模型 —— 点下去只会拿到 404/401/500。
 *
 * ⇒ 目录**只暴露本表内的模型**；表外的新模型要等实测确认端点后再加进来。
 * （表本身也来自实测：见 `2026-10-02-opencode-zen-endpoint-matrix.md`。）
 */
export declare function isReachableOpencodeModel(id: string): boolean;
export type OpencodeErrorKind = 'free_usage_limit' | 'go_usage_limit' | 'rate_limit' | 'free_tier' | 'quota' | 'auth' | 'server' | 'transport';
export interface OpencodeErrorInfo {
    kind: OpencodeErrorKind;
    /** 服务端要求的等待时长（毫秒）；仅在限流类错误上产出。 */
    retryAfterMs?: number;
    /** 面向用户的可读描述（禁止裸 JSON）。 */
    detail: string;
}
/**
 * 把一次失败的 HTTP 响应归类为语义化的错误。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export declare function classifyOpencodeError(status: number, body: string, headers?: Readonly<Record<string, string>>): OpencodeErrorInfo;
//# sourceMappingURL=opencode-product.d.ts.map