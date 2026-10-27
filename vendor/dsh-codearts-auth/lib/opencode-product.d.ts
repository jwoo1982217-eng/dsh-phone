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
     *
     * ⚠️ **本字段已不再被本模块使用**（用户 2026-10-17）：models.dev 的直连与
     * 缓存收敛到 `src/models-dev-cache.ts` 全仓唯一直读点，此处保留字面量
     * 只为「文档上说得清」—— 真要改地址**改那一个模块**，别改这里。
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
 * ⚠️ 本插件实现的**唯一**模型协议：OpenAI chat completions。
 *
 * models.dev 的 `provider.api` 正是**协议端点**的权威字段，而实测按它分组与
 * 「我们实现了哪些协议」逐格吻合（2026-10-17 实测 85 条远端目录）：
 *
 * | `provider.api` | 条数 | 本插件 |
 * |---|---|---|
 * | `…/inference/openai/v1` | 56 | ✅ 已实现 |
 * | `…/inference/anthropic/v1` | 17 | ❌ 未实现（实测 `/v1/messages` 恒 500） |
 * | `…/inference/google/v1beta` | 8 | ❌ 未实现（Gemini 原生协议） |
 * | （无该字段） | 4 | ⚠️ 不知道 ⇒ 交本地兜底表决定 |
 *
 * ⚠️ **比较必须逐字相等**：models.dev 给的是**带域名**的绝对 URL，而上面
 * 表格里的短形态只是文档缩写。写成 `endsWith('/inference/openai/v1')` 也能过，
 * 但那会让「未来新增一个同后缀的第三方端点」被误判成可达。
 */
export declare const OPENCODE_CHAT_PROTOCOL_API = "https://opencode.ai/inference/openai/v1";
/**
 * 兜底模型表（**以真机实测为准**，2026-10-01 / 2026-10-17 更新）。
 *
 * ## ⚠️⚠️ 它的职责已经收窄为**只在能力表不可用时**兜底（Issue IKM9LR）
 *
 * 改前这张表**同时**是「网络失败的兜底目录」与「协议可达性白名单」，而后者
 * 意味着**每上一个新模型都要手工加一行** —— Zen 于 2026-10 上线
 * `deepseek-v4.1-flash-free` / `glm-5.3-flash-free` 时，远端 `/v1/models`
 * **明明下发了**，却因为不在表里被过滤掉，用户在选择器里完全看不到
 * （症状与「上游没有这个模型」同形，极难自查）。
 *
 * ⇒ 现在「可达性」由 models.dev 的 `provider.api` 决定（见
 * {@link isReachableOpencodeModel}），这张表退回它本来的职责：**兜底**。
 * 表外模型在**能力表可用时**照常出现；只有能力表也拿不到时才回落到这里。
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
 * 注册「读能力表」的动作（由 `opencode-capability.ts` 在模块加载时调用）。
 *
 * ⚠️ **必须是模块加载期注册**，不能等到第一次归一 —— 否则冷启动首帧
 * （能力表尚未被任何路径读过）钩子还没注册，判据会退回本地表。
 */
export declare function setOpencodeCapabilityHook(hook: () => void): void;
/**
 * 注入远端可达性表（**唯一定义处**在 `opencode-capability.ts`）。
 *
 * ⚠️ 传 `undefined` 表示「远端不可用」，调用方会退回本地表 —— 这是**刻意的**：
 * 能力表来自 5 MB 的外部站点，读不到是高频状态而非理论边界，而退回本地表
 * 得到的目录「少几个新模型但都能用」，严格优于「一个都不显示」。
 */
export declare function setRemoteOpencodeReachability(table: ReadonlyMap<string, boolean> | undefined): void;
/**
 * 该模型是否属免费（匿名槽只接受免费模型）。
 *
 * ## ⚠️ 判据优先级：**远端 models.dev 的 cost > 本地表**（Issue IKM9LR）
 *
 * 改前只看本地表，于是 Zen 新上线的免费模型（issue 里的
 * `deepseek-v4.1-flash-free` / `glm-5.3-flash-free`）在能力表里明明
 * `cost: {input: 0, output: 0}`，却被判成「收费」⇒ 匿名用户看不到它们
 * （判据的第二个 bug，与可达性那个同源但独立）。
 *
 * ⚠️ 仍保留**未知即 false**：表外且远端也没有判据时，不放给匿名槽 ——
 * 那是保守方向，宁可要求用户加一个付费账号，也不能给一个必然 403 的模型。
 */
export declare function isFreeOpencodeModel(id: string): boolean;
/**
 * 该模型在我们**已实现**的通道里是否存在（协议可达）。
 *
 * ## ⚠️⚠️ 判据改成**远端优先、本地兜底**（Issue IKM9LR 的主缺陷）
 *
 * ### 改前：只有本地表
 *
 * `GET /v1/models` 返回全部 85 个模型，且**不含任何协议信息**（字段只有
 * id/object/created/owned_by）。改前靠 `REACHABLE_IDS` 这张硬编码表来挡
 * `claude-*` / `gemini-*` 等我们**未实现协议**的模型（否则用户点下去只会拿到
 * 404/401/500）—— 但**同一张表也把新上线的免费模型挡掉了**。
 *
 * 真实报障（IKM9LR）：`deepseek-v4.1-flash-free` 与 `glm-5.3-flash-free`
 * 已被 Zen 官方公告免费提供、远端 `/v1/models` **确实下发**，
 * 本插件却因不在表里而在选择器里**完全消失** —— 与「上游没这个模型」同形。
 *
 * ### 改后：models.dev 的 `provider.api` 才是权威
 *
 * 实测（2026-10-17）按 `provider.api` 分组与「我们实现了哪些协议」逐格吻合：
 * `openai/v1` 56 条 ✅ / `anthropic/v1` 17 条 ❌（实测 `/v1/messages` 恒 500）/
 * `google/v1beta` 8 条 ❌（Gemini 原生协议）/ 无该字段 4 条 ⚠️不知道；
 * 而改前那 14 条本地表条目**全部**落在 `openai/v1` 内、零反例。
 *
 * ### 三格语义（缺一不可）
 *
 * | 远端 `provider.api` | 结论 |
 * |---|---|
 * | `openai/v1` | **可达** |
 * | 其它协议 | **不可达** |
 * | **条目缺失** | ⚠️ 不知道 ⇒ **退回本地表**（不是「不可达」） |
 *
 * ⚠️ 第三格是刻意的：`jev-1.13-free` 无条目且实测回
 * `400 ModelProtocolUnsupported`，但**那是一条属于那个模型的实测结论**，
 * 推广成「无条目即不可达」会让未来所有新模型凭空消失。
 *
 * ### ⚠️ 这道闸**管不了**的三样（只能靠运行时错误分类兜）
 *
 * ① 地域封锁：`beam-free` 的 `provider.api` 就是 `openai/v1`，实测 403
 * `RegionError`（按出口 IP 判，目录层无从预知）；
 * ② 上游不稳定：`glm-5.3-flash-free` 实测约 2/5 概率 429；
 * ③ 废弃：`mimo-v2.5-free` 回 410，只要远端还下发就挡不住。
 */
export declare function isReachableOpencodeModel(id: string): boolean;
/** 注入远端免费判定表（见 {@link setRemoteOpencodeReachability} 的口径）。 */
export declare function setRemoteOpencodeFreeFlags(table: ReadonlyMap<string, boolean> | undefined): void;
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