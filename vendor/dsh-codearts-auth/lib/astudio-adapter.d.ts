/**
 * AStudio（讯飞 AstronStudio）模型适配器 —— dsh-llm `LlmAdapter` 的**推理面**实现。
 *
 * ## 本文件只干三件事（协议判据一律来自 `astudio.ts`，不在此重复）
 *
 * 1. **发请求**：`POST {maasBaseUrl}{chatPath}`
 *    （实测 = `https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/chat/completions`）。
 *    请求体**一律**交给 {@link buildAstudioChatRequest}，本文件绝不自己拼 body ——
 *    那函数已把三条实测取舍固化在纯函数层（裸 slug、空值省键、`stream_options.include_usage`），
 *    在这里再拼一遍就是第二处实现，必然漂移。
 * 2. **解析流**：复用仓库共享件 {@link consumeOpenAiSse}（`reasoning_content` 独立成块、
 *    `tool_calls` 按 index 合并、`finish_reason` 映射、**HTTP 200 + SSE 内嵌错误帧**归为
 *    `LlmError`）。本家实测是**标准 OpenAI 增量**，故不需要「累积全文→增量 diff」；
 *    但仍套一层 {@link astudioWrapIncremental} 作**防御**（幂等透传，上游哪天改形态不至于把
 *    正文拼成三份）。
 * 3. **凭据**：全部经 `astudio-auth.ts` 注入（磁盘快路径 + 401 触发的权威重取）。
 *    本文件**不读磁盘、不拼 Cookie、不自己发凭据请求**。
 *
 * ## 401 的唯一处理路径（硬约束：只重取一次，禁止循环重试）
 *
 * 判据入口只有 {@link astudioAuthRetryPlan}：`401 → refresh-and-retry → 再 401 → terminal`。
 * ⚠️ 磁盘上没有任何 TTL/expiresAt，本地**无法**预判到期，所以「先检查再请求」这种写法
 * 在本家不存在；反过来说，**传输层失败绝不能被读成 401**（{@link astudioStatusOf} 无状态时
 * 故意返回 `0`，就是为了不让你在断网时白撞一次远端重取）。
 *
 * ## 错误码（与 harness 名单对齐后的定案）
 *
 * `astudio.ts` 的分类器产出 `RATE_LIMITED` / `NETWORK`，而 dsh-llm 的
 * `DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`
 * 用的是 **`RATE_LIMIT` / `TRANSPORT`** —— 照抄分类器字面量会让一次 429 与一次断流
 * **都不被重试**（静默少一层恢复能力）。{@link astudioLlmErrorCode} 就是这唯一一次改名，
 * 其余码值保持原样：`QUOTA_EXCEEDED` / `PERMISSION_DENIED` 都在
 * `dead-model-store.ts` 的 `IGNORED_CODES` 里（不会被误记成「模型已下架」），不必动。
 *
 * ## 思考档位（实测：非法值**不报错**、按最大档跑）
 *
 * ⇒ 必须由 {@link astudioEffortForRequest} 在**本地**拦截，被判丢弃时**发出去的是
 * 「不带该键」**，并留一条 warn（静默丢弃是本仓库明令禁止的）。档位声明只取远端下发的
 * `supported_reasoning_levels`，未知模型不臆造。
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { type AstudioProduct } from './astudio-product.js';
import { type AstudioCatalogModel, type AstudioCredential } from './astudio.js';
import { type AstudioAuth, type AstudioRefreshOutcome } from './astudio-auth.js';
/** 本适配器拥有的 provider 路由名（= `ASTUDIO.id`，纯小写无连字符）。 */
export declare const PROVIDER = "astudio";
/** {@link ASTUDIO_LLM_CODE_RENAMES} 的取值入口（导出供单测逐格断言）。 */
export declare function astudioLlmErrorCode(kind: string): string;
/** {@link AstudioAdapter} 的构造选项（**单测与接线都靠这几个替身注入**，不碰真实凭据/网络）。 */
export interface AstudioAdapterOptions {
    /** 产品配置；缺省 {@link ASTUDIO}。 */
    product?: AstudioProduct;
    /** 注入的 fetch；缺省全局 `fetch`。 */
    fetchImpl?: typeof fetch;
    /**
     * 认证服务（`ctx.astudioAuth`）。注入后三个回调都有默认实现；
     * 单测可以完全不传它，改用下面三个显式回调。
     */
    auth?: AstudioAuth;
    /** 取当前凭据；缺省 `auth.currentCredential()`。 */
    resolveCredential?: () => Promise<AstudioCredential | undefined>;
    /** 401 后的**一次**权威重取；缺省 `auth.refreshOnce()`。 */
    refresh?: () => Promise<AstudioRefreshOutcome | undefined>;
    /** 读远端模型目录；缺省 `auth.fetchCatalogModels()`（GET model-manager/models）。 */
    fetchRemoteModels?: () => Promise<readonly AstudioCatalogModel[]>;
    /** 目录落地后通知客户端重读（`registerAstudioLlm` 注入唯一广播实现）。 */
    onCatalogLoaded?: () => void;
    /** 告警出口；缺省 `console.warn`。**丢弃档位等副作用必须留痕**。 */
    warn?: (message: string) => void;
    /**
     * 目录新鲜度用的时钟（**只**用于 `isCatalogFresh`，不参与任何业务判定）。
     *
     * ⚠️ 判据只有一份：`model-catalog.ts` 的 `isCatalogFresh`（周期 20 分钟）。
     *    注入点存在的唯一理由是**单测要能推进 TTL**，不必真等 20 分钟
     *    （与 loomy / minimax / raccoon / zcode 的 `now` 同款约定）。
     */
    now?: () => number;
    /**
     * 账号池（**黑名单过滤与「供应商整体关闭」的唯一数据源**）。
     *
     * ⚠️⚠️ **本字段曾经缺失，是一个静默缺陷**（Gitee issue IKP8OF 审计发现）：
     * 本家是唯一把 `createModelCatalog` 的 deps 传成 `{}` 的适配器（其余各家都传
     * `{ accountPool }`）⇒ 骨架里 `deps.accountPool?.disabledModelsFor(...)` 与
     * `providerClosedFor?.(...)` 全部因 `?.` **静默跳过** ⇒
     * **用户在 Jet Hub 里关掉的模型照样出现在选择器里**、关闭整个供应商也无效。
     * 症状与 modelscope 那次「接线层漏实参」逐字相同：字段与消费点都在，只缺实参。
     *
     * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤」，与修复前逐字节一致 ——
     *    但**生产接线必须传**（由 `index.ts` 负责，且有守卫用例逐家点名）。
     */
    accountPool?: import('./account-pool.js').AccountPool;
}
/** AStudio 适配器：Chat Completions 通道（实测上游原生兼容 OpenAI）。 */
export declare class AstudioAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    private readonly warnImpl;
    private readonly resolveCredentialImpl;
    private readonly refreshImpl;
    private readonly fetchRemoteModelsImpl;
    /** 远端目录（**已按可见性过滤**）；未拉取/拉取失败时为 undefined ⇒ 用兜底表。 */
    private remoteModels;
    /** 在途目录请求（并发去重：多个入口同时 `listModels` 只发一次）。 */
    private catalogInFlight;
    /** 失败冷却截止时刻（与目录 TTL **同一份**可注入时钟，见 {@link AstudioAdapterOptions.now}）。 */
    private catalogCooldownUntil;
    /**
     * 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
     *
     * ⚠️ **只在成功时写**：失败写时刻会把「上游没恢复」这件事掩盖整整 20 分钟。
     *    判据由 `model-catalog.ts` 的 `isCatalogFresh` **唯一**持有。
     */
    private catalogAt;
    /** 目录新鲜度用的时钟（可注入，见 {@link AstudioAdapterOptions.now}）。 */
    private readonly nowImpl;
    private readonly catalog;
    constructor(options?: AstudioAdapterOptions);
    /** 描述本适配器拥有的 provider 路由（对非字符串入参回退本家 id，见 loomy 同款防御）。 */
    providerInfo(provider: string): LlmProviderInfo;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 同步全量目录（Jet Hub 显示列表用；`ctx.llm` 不透传自定义方法，故须持有实例）。 */
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    /**
     * 兼容旧版 dsh-llm 的 `prepareCall` shim（PR !66 要求必须包）：
     * 解析出的 model 与本次 stream 属于**同一代**目录，重读动态连接事实没有意义。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 全部条目（远端 ?? 兜底表），**同一形状**（`astudioCatalogToFallback` 负责归一）。 */
    private catalogSource;
    private toCatalogEntry;
    /**
     * 思考档位声明（`resolveModel().reasoning`）。
     *
     * 三条口径：① 顺序**原样取远端**（服务端下发即展示顺序）；② `defaultEffort` 必须落在
     * `efforts` 内（DSH 会直接拿它发请求，给个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，
     * 比不给更糟）；③ 远端未声明档位 ⇒ **不声明** `reasoning`（否则 UI 出空选择器）。
     * 判据本身在 `astudio.ts` 的 {@link astudioCatalogReasoningOf}，这里只做**品牌转换**。
     */
    private reasoningFor;
    private syncCatalogEntries;
    /**
     * 读远端目录并转成中间结构（**并发去重 + 失败冷却**）。
     *
     * ⚠️ 失败**不抛**：返回兜底表，让「目录接口挂了」不至于变成「模型不能选」。
     * 可见性过滤（剔 `visibility:hide` 的内部别名）在这里做 —— 只暴露 6 个裸 slug。
     */
    private loadCatalogEntries;
    private loadModels;
    /**
     * 强制重读远端目录（接线里的「同步模型」按钮用；失败回兜底表）。
     *
     * ## ⚠️ 下面两条清腿**互为冗余**（2026-10-18 变异实测，如实登记）
     *
     * `loadModels` 的 gate 是**合取**：`remoteModels !== undefined &&
     * isCatalogFreshFor(…)`，而 `isCatalogFresh` 对 `at === 0` **恒判陈旧**
     * （`model-catalog.ts:255`）⇒ 两条清腿**任一条**都足以让 gate 失效：
     *
     * | 注入的变异 | 实测结果（`astudio-catalog-effort.spec.ts`） |
     * |---|---|
     * | 只删 `catalogAt = 0` | **12 passed**（行为逐例不变） |
     * | 只删 `remoteModels = undefined` | **12 passed**（行为逐例不变） |
     * | **两条都删** | **1 failed**（点「同步模型」看不到变化 —— 真回归） |
     *
     * ⇒ 本方法的**不变式是「至少清一条」**，而不是「必须清某一条」。
     *    两条都留着是**防御**（与新加的 `createModelCatalog` 的 `refresh` 回调同款写法），
     *    但**不得把任一条单独说成承重腿** —— 那是假因果（本仓库明令的失效形态）。
     *    ⚠️ 同型但**结构不同**的真实缺陷在 `aggregate-adapter.ts` 的 `refreshCatalog`：
     *    那边的 gate 只判 TTL（无「remoteModels 已置空」这一腿），
     *    故「不传 force ⇒ 点刷新看不到任何变化」在那里是真缺陷。
     */
    refreshCatalog(): Promise<readonly LlmModelInfo[]>;
    /**
     * ★ **后台目录刷新器入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`，
     * 每 20 分钟一轮；用户改设置时的立即失效走 `invalidateCatalogCache`）。
     *
     * ⚠️⚠️ 存在的理由（2026-10-18 审计发现）：`createCatalogRefresher` 遍历
     * `modelAdapters` 并调 `adapter.refresh?.()`，**返回 `undefined` 即静默跳过**。
     * 而 `refresh` 是 `createModelCatalog` 返回的 **catalog 实例**上的成员
     * （`model-catalog.ts` 的 `ModelCatalog.refresh`），**不会自动变成适配器的成员**
     * ⇒ 不在类上显式转发的话，「模型目录刷新器已武装」的日志为真、实际**一家都不刷**。
     *    （该缺口已实测：本仓库 12 家适配器的原型上**都没有** `refresh` 成员，
     *    而 `catalog-refresher-wiring.spec.ts` 只断言了武装日志、
     *    没有任何一条断言「真的刷了某家」。）
     *
     * ⚠️ 与 `options.refresh` **不是同一件事**：那个是 HTTP 401 之后的**凭据**重取，
     * 本方法是**目录**强制重拉。两者同名纯属巧合，**不得合并**。
     */
    refresh(): Promise<void>;
    /**
     * 一次推理（**只发 `stream:true`**：harness 要的是 `StreamChunk`，而本家流式是标准
     * OpenAI 增量 + `[DONE]`，末 chunk 带 usage —— 实测 `stream_options.include_usage`
     * 不带时流里没有 usage 帧，计费与统计双缺，故该键由 `buildAstudioChatRequest` 恒补）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 401 后**重取一次并重发一次**（唯一的自愈路径）。
     *
     * 三条实测驱动的取舍：
     * - **不轮换就不重发**：本家 `modelBearerToken` 幂等不轮换，`changed === false`
     *   意味着再发一次必然还是同一个 401 —— 白烧一次请求，还会把错误文案推远。
     * - **终态直接放弃**：`terminal`（含 `code=80000`「登录异常，请重新登录」）表示
     *   只能人工重登，定时/循环刷新都救不回来。
     * - **绝不循环**：最多两次 `send`（首次 + 重发一次），由 `astudioAuthRetryPlan`
     *   的 `attemptedRefresh` 语义保证；这里不再自己加次数以外的重试。
     *
     * 返回 `undefined` = 「没救」（刷新失败/终态/凭据没变/重发后仍非 2xx 由调用方归类）。
     */
    private retryAfterRefresh;
}
/**
 * 在 `ctx.llm` 上注册 AStudio 路由与适配器。
 *
 * ⚠️ **本函数不改任何热点文件** —— 谁调用它属于接线意图（`index.ts` /
 * `provider-registry.ts` 等 8 处），这里只提供入口。
 *
 * 返回适配器实例：Jet Hub 显示列表要 `listAllModels()`，而 `ctx.llm` 不透传自定义方法，
 * 故调用方须持有引用（与 loomy / accio 同一约定）。
 */
export declare function registerAstudioLlm(ctx: Context, options?: AstudioAdapterOptions): AstudioAdapter;
//# sourceMappingURL=astudio-adapter.d.ts.map