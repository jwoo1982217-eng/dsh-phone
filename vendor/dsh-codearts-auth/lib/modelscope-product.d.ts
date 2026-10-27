/**
 * ModelScope（魔搭，阿里达摩院）产品配置与错误分类。
 *
 * ## 这个 provider 从哪来（与上游其余 provider 的关系）
 *
 * 本仓库是 gitee `iJetLi/deepseek-harness-codearts` 的 fork。上游 0.2.0-rc.3
 * **没有** modelscope / chatanywhere 两个 provider —— 它们是**本地 fork 独有的
 * 反代上游**（旧实现见 `dsh-codearts-auth@0.1.0` 的 `src/proxy/remote-upstream.ts`，
 * 由一个端口 8787 的 OpenAI 兼容反代按 priority 轮换）。2026-10-09 切到上游后
 * 这两个能力整体消失，本文件把 modelscope 一路按上游的**标准 provider 模式**
 * 补回来（而不是把旧 fork 的整套反代搬回来）。
 *
 * ## 数据来源（逐条可追溯）
 *
 * | 事实 | 取值 | 出处 |
 * |---|---|---|
 * | base URL | `https://api-inference.modelscope.cn/v1` | 旧 fork `src/proxy/upstream-config.ts:51` |
 * | chat 路径 | `/chat/completions` | 旧 fork `src/proxy/remote-upstream.ts:429` |
 * | models 路径 | `/models` | 旧 fork `src/proxy/remote-upstream.ts:268` |
 * | 鉴权头 | `Authorization: Bearer <apiKey>` | 旧 fork `src/proxy/remote-upstream.ts:238` |
 * | 请求内容类型 | `Content-Type: application/json` | 同上 L236 |
 * | 流式 | `stream: true` 恒开，SSE | 旧 fork `src/proxy/remote-upstream.ts:376` |
 * | 模型名 | 带命名空间前缀，如 `deepseek-ai/DeepSeek-V4.1-Flash` | 旧 fork `src/domain/models/catalog.ts:277` |
 * | 关思考参数 | `reasoning_effort: "none"` / `enable_thinking: false` / `thinking: {type:"disabled"}` | 旧 fork `src/proxy/remote-upstream.ts:77` |
 * | 视觉能力 | `deepseek-v4.1-flash` 实测可收图 | 旧 fork `src/proxy/remote-upstream.ts:87-91` |
 * | 额度 | 平台**无余额 API**，余额只在登录后的网页上 | 旧 fork `src/overview.ts:70-76` |
 *
 * ## ⚠️ 一个已实测的 400（本 provider 最容易踩的坑）
 *
 * 旧 fork 曾把 DSH 的扁平工具 schema `{name, description, parameters}` **原样**
 * 转发给 modelscope，结果**每次请求都被 400 拒绝**：
 *
 * ```
 * upstream: modelscope  status: 400
 * {"error":{"code":"invalid_parameter_error",
 *           "message":"'type' is a required property - 'tools.0'"}}
 * ```
 *
 * 后果极隐蔽：反代把它当「上游不可用」静默跳过，魔搭积分**一次都没消耗**，
 * 用户完全看不出来（见旧 fork `src/proxy/remote-upstream.ts:386-395` 与
 * `src/proxy/openai-map.ts:242`）。
 * ⇒ 本实现必须走 `{type:'function', function:{…}}` 包装（见
 * `src/modelscope-messages.ts`），与仓库其余 OpenAI 兼容 provider 同口径。
 *
 * @module src/modelscope-product.ts
 */
/** ModelScope 的产品配置（字段全部围绕它的 OpenAI 兼容协议）。 */
export interface ModelscopeProduct {
    readonly id: 'modelscope';
    /**
     * 展示名。
     *
     * ⚠️ 必须与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 里
     * `modelscope` 那条的 `label` **逐字一致** —— 跨文件一致性由
     * `tests/unit/modelscope-client-panel.spec.ts` 锁死（与 raccoon / opencode /
     * gemini 同款约定）。
     */
    readonly displayName: string;
    /** OpenAI 兼容 base URL，**含 `/v1`**，且**不带**尾斜杠。 */
    readonly baseUrl: string;
    /** 对话端点（拼在 baseUrl 之后）。 */
    readonly chatPath: string;
    /** 模型目录端点（拼在 baseUrl 之后）。 */
    readonly modelsPath: string;
    /** 等首个 token 的空闲超时（毫秒）。 */
    readonly chatHeaderTimeoutMs: number;
    /** 两次 chunk 之间的空闲超时（毫秒）。 */
    readonly chunkTimeoutMs: number;
    /** 模型目录请求超时（毫秒）。 */
    readonly catalogTimeoutMs: number;
    /**
     * **魔粒余额**端点的完整 URL（2026-10-17 带真实 Key 实测）。
     *
     * ⚠️⚠️ **刻意是完整 URL 而非「拼在 baseUrl 之后」的 path**：它**不在**
     *    `baseUrl`（`api-inference.modelscope.cn/v1`）那个 host 上，而在
     *    `www.modelscope.cn` 的 **`/openapi/v1/`** 前缀下 ⇒ 用 path 拼装会得到
     *    一个 404 的错误地址。
     *
     * 实测（三条认证形态各验一次，这是本仓库「目录能读 ≠ 凭据有效」纪律的同款要求）：
     * | 认证 | 结果 |
     * |---|---|
     * | `Authorization: Bearer <ms-key>` | **200**，返回 `total_balance` |
     * | 网页会话 cookie | 200，同一数值 |
     * | 无凭据 | **401 `InvalidAuthentication`** |
     * ⇒ 它**真的在校验凭据**（不是公开端点），且**API Key 就够**。
     *
     * ⚠️ 找它的过程值得留档：本仓库与 PR 作者都曾判定「魔搭没有额度查询 API」，
     *    那批探测只试过 `/api/` 与 `/v1/` 两个前缀，而真端点在 **`/openapi/`**；
     *    它还**不在**前端主 bundle 的静态路径表里（藏在按需 chunk）⇒ 只能靠
     *    抓真实网络请求（CDP）定位。详见 `docs/agent-notes/providers-modelscope.md`。
     */
    readonly balanceUrl: string;
    /** 余额请求超时（毫秒）。 */
    readonly balanceTimeoutMs: number;
    /**
     * 单凭据回退 ref。
     *
     * ⚠️ **不再是旧 fork 的 `PROXY_UPSTREAM_MODELSCOPE`**。那个前缀属于旧 fork 的
     * 「反代上游」命名空间（`credentialRefForUpstream()` 的机械推导），在上游
     * 0.2.0-rc.3 里**整套反代都不存在**（`git grep PROXY_UPSTREAM upstream/master`
     * 零命中），保留它只会凭空造出一个『同时支持两种模式』的假象。
     * 取 `MODELSCOPE_ACCESS_TOKEN` 的理由见 `tests/unit/modelscope-credential-ref.spec.ts`。
     */
    readonly defaultCredentialRef: string;
}
export declare const MODELSCOPE: ModelscopeProduct;
/** 兜底模型目录条目。 */
export interface ModelscopeFallbackModel {
    /** 上游真实模型 id（**带命名空间前缀**，如 `deepseek-ai/…`）。 */
    id: string;
    /** 展示名（缺省时用 id）。 */
    name: string;
    /**
     * 上下文窗口（DSH 以它 × 0.8 作压缩阈值）。
     *
     * ⚠️ `0` 是「**不知道**」哨兵，**不是**合法窗口 —— `resolveModel` 判
     * `> 0` 才下发 `context`，因为 DSH 的自动压缩会拿它算阈值，0 会抛
     * `TargetPressureConfigError`（与 opencode 的同款缺陷同因）。
     */
    contextWindow: number;
    /** 是否支持图片输入（**声明支持就必须真支持**，本仓库硬约定）。 */
    supportsImage: boolean;
    /** 支持的思考档位（上游 wire 值）；**为空时不声明 `reasoning`**。 */
    efforts?: readonly string[];
}
/**
 * 兜底模型表。
 *
 * ## 它解决什么（2026-10-17 实测后大幅扩表）
 *
 * 魔搭的 `/v1/models` **只下发 4 个字段**（实测：`id` / `object` / `owned_by` /
 * `created`）—— **既没有 `context_window`，也没有 `modalities.input`**：
 *
 *     远端条目的全部字段: id, object, owned_by, created
 *     窗口相关字段: （无 —— 远端不下发任何窗口信息）
 *
 * ⇒ 原先只登记 2 个模型的后果是：**其余 34 个模型的 `contextWindow` 全落成 0**
 * （0 是「不知道」哨兵，`resolveModel` 判 `> 0` 才下发 `context`）
 * ⇒ 用户看到 34 个模型「没有上下文窗口信息」，而 DSH 的自动压缩阈值算不出来。
 * ⇒ 故按 2026-10-17 用户指示扩表到**远端实测的 36 个**。
 *
 * ## ⚠️⚠️ 每个窗口值的**出处分两类**（不许混为一谈）
 *
 * | 类别 | 取值 | 依据 |
 * |---|---|---|
 * | **① 仓库已有实测** | `1_048_576` / `1_000_000` | 本仓库其它渠道对**同一模型**的实测结论（见各项注释里的出处） |
 * | **② 无先例** | `512_000` | **未实测**的保守占位（用户 2026-10-17 指示） |
 *
 * ⚠️ **②类不是实测值**：魔搭上游不返回窗口字段，而逐个实测 17 个模型的真实
 * 上限成本过高（用户明示「没实测也不用测了」）⇒ 取一个**偏保守**的中间值，
 * 宁可低估窗口（提前触发压缩）也不要高估（DSH 以为能装 1M、实际被上游截断）。
 *
 * ⚠️ **实测旁证（仅对 V4.1 Flash）**：喂约 **100 万 tokens** 输入返回 200
 * （`finish_reason: length` 只是**输出**被截断，不是输入超限）⇒ 原来的
 * `128_000` 明显偏保守。⚠️ 但这**不是**「服务端声明的官方上限」，只是
 * 「这个量级能用」。
 *
 * ## 远端可用时**完全采信远端**
 *
 * 不做 Buddy 那样的「以兜底表为准」裁剪 —— 魔搭的模型池由平台侧随时增删，
 * 本地表必然滞后。⚠️ 本表只在**远端拉取失败**时生效。
 */
export declare const MODELSCOPE_FALLBACK_MODELS: readonly ModelscopeFallbackModel[];
/** 该模型是否为本地兜底表里登记过的（远端目录爆炸时的收敛依据）。 */
export declare function isKnownModelscopeModel(id: string): boolean;
export type ModelscopeErrorKind = 'rate_limit' | 'quota' | 'auth' | 'server' | 'transport' | 'invalid_request' | 'context_window';
export interface ModelscopeErrorInfo {
    kind: ModelscopeErrorKind;
    /** 服务端要求的等待时长（毫秒）；仅在限流类错误上产出。 */
    retryAfterMs?: number;
    /** 面向用户的可读描述（**禁止**裸 JSON）。 */
    detail: string;
}
/**
 * 把一次失败的 HTTP 响应归类为语义化错误。
 *
 * ## ⚠️ 顺序即优先级（三条都来自本项目真实缺陷）
 *
 * 1. **限流/额度必须排在 auth 之前**：魔搭与同源的 chatanywhere 在额度耗尽时
 *    可能回 401/403 而不是 429（旧 fork `src/proxy/upstream.ts` 的
 *    `NON_RETRYABLE_CODES` 与 key-pool 的 `isQuotaLikeError` 就是为这个形态写的）。
 *    若先判状态码，用户看到的会是「API key 失效」——而他的唯一有效动作
 *    （等窗口恢复 / 换一个 key）被完全掩盖。
 * 2. **400 单独归 `invalid_request`**：魔搭对请求体形状极严格（见模块头的
 *    工具包装事故），把它归成 server/可重试会让 harness 白重试 5 次、
 *    每次都拿到同一个 400。
 * 3. `retry-after` 由**响应头**给出，解析实现收敛在 `src/retry-after.ts`
 *    （0 是合法值，判空必须用 `=== undefined`）。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export declare function classifyModelscopeError(status: number, body: string, headers?: Readonly<Record<string, string>>): ModelscopeErrorInfo;
//# sourceMappingURL=modelscope-product.d.ts.map