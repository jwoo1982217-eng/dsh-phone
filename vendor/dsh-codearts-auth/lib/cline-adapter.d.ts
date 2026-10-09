/**
 * Cline LLM 适配器。
 *
 * ## 与既有 provider 的差异
 *
 * Cline 的推理端点是**标准 OpenAI 兼容**的
 * （`POST {apiBase}/api/v1/chat/completions`，实测标准 SSE），
 * 故 OpenAI 协议层（消息序列化 / SSE 消费 / 错误归类）**完全复用**
 * `src/openai-compat.ts` —— 与 Qoder 同做法。
 *
 * 差异只有三处：
 *
 * 1. **鉴权头是 `Bearer workos:<jwt>`**（前缀不可剥，见 `src/cline.ts`）；
 * 2. **思考字段是 `delta.reasoning`**（不是 `delta.reasoning_content`）——
 *    已由 `consumeOpenAiSse` 同时兼容；
 * 3. **模型目录来自两个端点**（`recommended-models` 给 free 集合、
 *    `/models` 给全量 id），见 `src/cline-models.ts`。
 *
 * ## 免费标注
 *
 * 免费模型在 `name` 里拼 ` · 免费`。⚠️ **必须写进 `name` 而非 `description`**：
 * composer 的模型切换菜单只渲染 `name`（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`）。
 * 这是被用户报障纠正过的结论。
 *
 * ⚠️ 免费资格是**服务端动态下发**的（`recommended-models` 的 `free` 数组），
 * 故本适配器**不硬编码任何免费模型名** —— 与 CodeArts benefit 集合同约定。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type ClineCredential } from './cline.js';
import { type ClineModel, type ClineRemoteModels } from './cline-models.js';
import { type ClineProduct } from './cline-product.js';
import { type ImageRequestTarget } from './image-budget.js';
import { type ClineModelsDevEntry } from './cline-models-dev.js';
/** 本适配器注册的 provider 路由名（等价于 `CLINE.id`）。 */
export declare const PROVIDER = "cline";
/**
 * 清洗工具参数 schema 里的 `enum`（递归）。
 *
 * ## 为什么必须清洗（实测 400，用户报障 2026-09-25）
 *
 * harness 下发的工具集里，某些参数的 `enum` 含**空字符串**成员。Gemini 系模型
 * （经 `google` / `vertex` provider）对此**严格校验**，直接拒绝整个请求：
 *
 * ```
 * GenerateContentRequest.tools[0].function_declarations[34]
 *   .parameters.properties[permission].enum[3]: cannot be empty
 * ```
 *
 * ⚠️ 该错误**只在部分 provider 上暴露**：上游一次请求会依次尝试多个 provider，
 * 实测命中 vertex 时报「maxOutputTokens 越界」、命中 google 时报上述 enum 错误。
 * 两者是**两个独立根因**，都要修，否则路由一漂移就复发。
 *
 * ⚠️ 本适配器**从不自己造 enum** —— `stream()` 原样透传
 * `options.tools[].parameters`，故脏数据来自上游 harness。但请求是我们发的，
 * 只能在我们这一侧拦住。
 *
 * ## 三条边界（都要守）
 *
 * - **只删空字符串**（含纯空白），其余成员原样保留 —— `enum` 可能是数字/布尔
 *   数组，按「只留字符串」过滤会把合法的数值枚举整段丢掉；
 * - 过滤后为空则**整个 `enum` 键丢弃**（空 `enum` 同样非法），而非留下 `[]`；
 * - **递归下钻**：`properties` / `items` 等嵌套层里的 `enum` 同罪。
 */
export declare function sanitizeClineToolParameters(value: unknown): unknown;
/** `ClineAdapter` 的构造选项。 */
export interface ClineAdapterOptions {
    /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
    credentialRef: CredentialRef;
    /** 从凭据存储解析凭据。 */
    resolveCredential: (modelId?: string) => Promise<ClineCredential | undefined>;
    /** 静默续期凭据。 */
    refresh: () => Promise<void>;
    /** 多账号池（用于限流时切换账号与模型黑名单）。 */
    accountPool?: AccountPool;
    /**
     * 「本次实际使用的是哪个**账号池账号**」（池 id，如 `cline-bb211a53`）。
     *
     * ⚠️ **请求记录的「账号」列必须用池 id，不能用凭据里的 `account_id`**：
     * 面板拿 `cline.quota` 下发的**池 id** 去过滤记录，两个 id 空间不一致时
     * 过滤恒为空 → 表格**永远空白**（真实缺陷，用户报障「请求记录中数据空白」）。
     *
     * ⚠️ 回调**只用于首次确定起点**（与 `QoderAdapterOptions.currentAccountId` 同因）：
     * 它返回「池当前会给出的那个账号」，适配器内部换号后**不会跟着变**，
     * 故换号后必须用局部变量跟进。
     */
    currentAccountId?: () => string | undefined;
    /**
     * 读取图片附件的原始字节（内联为 data URL 用）。
     *
     * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
     * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /**
     * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
     *
     * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
     * 而不是抛错。判据与回退都在共享的 `projectRequestImage` 里。
     *
     * 背景（issue !IKITT9）：Cline 撞的是**请求体体积**（实测 24 张原图全过、
     * 32 张 ≈122 MiB 才 `TRANSPORT`），不是腾讯那道图片 token 预算 ——
     * 但解法同样是缩放，且阈值余量最小，所以配一个宽松的字节目标。
     */
    readImageRequest?: (attachment: unknown, target: ImageRequestTarget) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link CLINE}。 */
    product?: ClineProduct;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /**
     * 模型目录加载器覆盖（测试用）。
     *
     * 默认走 `loadClineModels`（两次远端请求）。注入后单测可完全离线。
     */
    loadModels?: (options: {
        credential?: ClineCredential;
    }) => Promise<{
        models: ClineModel[];
        warnings: string[];
        /**
         * 远端原始结果（判「这次到底拿到目录没有」用）。
         *
         * ⚠ 注入式加载器（单测）可以不传：此时退回用 `models.length > 0` 判断，
         * 而默认的 `loadClineModels` **一定**会传（因为 `models` 里永远并着兜底表，
         * 用长度判断是死代码 —— 见 `hasClineRemoteModels` 的注释）。
         */
        remote?: ClineRemoteModels;
    }>;
    /**
     * models.dev 目录加载器覆盖（测试用）。
     *
     * 默认走 `makeClineModelsDevLoader`（拉 models.dev，带 TTL 缓存）。
     * 它同时补**名字/上下文窗口/图片能力**，见 `src/cline-models-dev.ts`。
     * ⚠️ 注入后单测可完全离线 —— 与 `loadModels` 同款理由。
     */
    loadModelsDev?: () => Promise<Map<string, ClineModelsDevEntry>>;
}
/**
 * Cline 模型适配器。
 *
 * 使用 `Bearer workos:<jwt>` 鉴权，仅支持 SSE（与官方客户端一致）。
 */
export declare class ClineAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 远端模型目录缓存（首次成功后填充）。 */
    private remoteModels;
    /** 正在进行中的目录加载（避免并发重复请求）。 */
    private loading;
    /**
     * models.dev 目录（`模型 id → 条目`，含名字/窗口/图片能力）。
     *
     * ⚠️ `undefined` = **还没读到**（不是「空目录」）：读不到时目录照常工作，
     * 只是少了它补的那几条。这条区分是整个模块的要点 ——
     * 把「没读到」当「不支持」正是「支持图片的模型发不了图」那个缺陷的形态。
     */
    private modelsDev;
    /** 正在进行中的 models.dev 加载（并发去重）。 */
    private modelsDevLoading;
    /** models.dev 加载器。 */
    private readonly loadModelsDev;
    /**
     * 目录加载闸门：并发去重 + 失败/空结果冷却。
     *
     * 此前这里只有 in-flight 去重（`private loading`），失败后立刻允许重试 ⇒
     * `buildModelCatalog` 的「每模型一次 resolveModel」会把一次失败放大成 N 次。
     * 详见 `src/remote-catalog-gate.ts` 的实测依据。
     */
    private readonly catalogGate;
    constructor(options: ClineAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
     * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 模型接受的输入模态。
     *
     * 两级判据（**顺序不能颠倒**）：
     * 判据是**目录条目上的 `supportsImage`**，而它有两个来源（优先级即顺序）：
     * 1. **本地兜底表/内嵌目录**（`product.fallbackModels` 的策展条目）——
     *    从官方客户端内嵌目录提取的，比社区目录权威；显式 `false` 也照样赢。
     * 2. **models.dev**（`src/cline-models-dev.ts` 补进目录）—— 补前者覆盖不到的
     *    模型（`cline-pass/*` 等）。
     *
     * ⚠️ **这是「支持图片的模型发不了图」的修复点**：修复前只看第 1 级，而它
     * 全表只有寥寥几条 `cline-free/*` 条目 ⇒ `cline-pass/*` 等**全部**被播报成
     * 纯文本 ⇒ DSH 根本不把图片送进来。详见 `src/cline-models-dev.ts`。
     *
     * ⚠️ 没有结论时保守报 `text`（宁可少报能力，也不要报一个服务端不认的模态）
     * —— 注意这与「明确读到不支持」是两回事，但外部行为一致。
     */
    private inputModalitiesFor;
    /**
     * 懒加载远端模型目录。
     *
     * `resolveModel` 可能先于 `listModels` 被调用（如直接进入会话），
     * 此时同样触发远端拉取。
     *
     * ⚠️ **并发去重**：`listModels` 与 `resolveModel` 会在启动时被 DSH 并发调用，
     * 不去重会打出多份重复的远端请求（两个端点各一次，乘以并发数）。
     */
    private ensureRemoteModels;
    /**
     * 懒加载 models.dev 目录，并发去重。
     *
     * ⚠️ **失败只记日志、返回空表**：拿不到就相当于「这一层没有补充」，
     * 目录与图片能力都退回本地兜底表；下一次调用会重试（`TtlCache` 不缓存失败）。
     * 它是**补充**信息，不能因为一次抖动就让整个 provider 不可用。
     *
     * @returns 读到的条目；失败返回空 Map（调用方无需区分）。
     */
    private ensureModelsDev;
    /** 兜底目录（远端不可用时的静态表，含 5 个免费模型）。 */
    private fallbackCatalog;
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（免费标记）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     *
     * ⚠️ 本方法是**同步**的（与 RPC 层 `ModelCatalogSource` 契约一致），
     * 故它只能读已缓存的目录。首次调用若缓存为空会触发一次**后台**加载，
     * 由下一次调用（或 DSH 的目录刷新）拿到结果 —— 而 `model.list` 端点
     * 之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
     * 故实际使用中不会读到空目录。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree: boolean;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` / `QoderAdapter` 同款 shim。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 消费 OpenAI 兼容 SSE 并**记录请求流水**（「订阅额度」面板的请求记录，
     * 见 `src/cline-request-log.ts`）。
     *
     * 记录字段对齐参考实现（`github.com/codeOct/dsh-cline-pass` 的请求记录部分）：
     * 总延迟、**首个内容块耗时（ttft）**、token 用量（含**思考 token** ——
     * 它是解释「为什么等了这么久才出字」的关键数字：这个网关不流式输出思考内容，
     * 思考量只出现在 usage 里）、失败原因。
     *
     * ⚠️ 与参考实现的**差异及理由**：
     * - 不记 `ttfb`（响应体首字节）：本适配器只有单一网关、无 upstream 路由，
     *   响应头到达与首块之间没有独立的「选路」阶段，展示位只剩两个 ——
     *   表格显示「首块 / 总延迟」两个数即可。
     * - 换号过程**不逐笔记**：只记**最终结果**一笔。参考实现会把 AUTH/QUOTA
     *   的每次 attempt 都记成失败行；本适配器的 429 换号风暴（最多 3 轮）
     *   会把 100 条上限刷满，而用户真正要看的是「这笔请求成了没、花了多少」，
     *   「所有账号均不可用」这行已包含换号语义。
     *
     * ⚠️ **失败也必须记**：失败的请求是排查「为什么没回复」的第一线索
     * （429 / 11140 安全策略 / 网络错误各是不同的原因）。记录本身绝不抛错
     * （`recordClineRequest` 已兜底），记账失败不得反噬推理。
     *
     * @param meta - `accountId` 是**最终服务的那笔**账号（换号后即最后一个）。
     */
    private consumeWithLog;
    /** 消费 OpenAI 兼容 SSE（共享实现）。 */
    private consume;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
}
/**
 * 该失败是否值得**换号重试**。
 *
 * 判据与 buddy 系一致：429（频率限制）与 402（额度耗尽）。
 * 其余错误（400 请求格式错、5xx 服务端故障）换号也无用 ——
 * 5xx 是所有账号共用的服务端问题，400 是请求本身的问题。
 *
 * ⚠️ 限流标记该写多长、以及给用户什么建议，都在 `src/cline-rate-limit.ts`
 * （那里有 Cline 专属的等待时长解析：它把时长写在**英文句子**里，
 * 既没有 `retry-after` 头、也没有绝对时刻）。
 */
export declare function isClineRotatableFailure(status: number, body: string): boolean;
/**
 * 额度/限流文案标记。
 *
 * 中英双通道：Cline 是国际产品，但用户账号可能是中文界面，
 * 且网关在不同层可能给出不同文案。
 */
export declare const CLINE_CREDIT_MARKERS: readonly string[];
/**
 * 该失败是否是**与凭据无关的访问限制**（地域封锁 / 模型未开通）。
 *
 * ## 为什么必须单独识别（真实缺陷，用户报障 2026-09-25）
 *
 * Cline 对「该地区不可用」的模型返回 **403**，而 401/403 在本适配器里原本一律
 * 被当作「凭据过期」：触发续期 → 重试 → 仍 403 → 最终 `httpErrorCode(403)`
 * 归成 `AUTH` → DSH 渲染成「**API 密钥无效**」。
 *
 * 实测 `cline-free/muse-spark-1.3-contributor`：
 *
 * ```
 * 403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
 *       is not available in your region","success":false}
 * ```
 *
 * 后果有两个：① 真实原因（地域限制）被完全掩盖，用户以为要去重新登录；
 * ② 每次请求都白跑一次续期（续期还会成功，所以不会提前报错，纯属浪费）。
 *
 * ⚠️ **不能按状态码一刀切**：同一批 403 里既有真的凭据问题，也有地域限制，
 * 只能靠**响应体文案**区分。认三种表述（上游措辞可能微调，故取特征词）：
 * `not available in your region` / `access forbidden` / `region not supported`。
 *
 * ⚠️ 命中时**跳过续期**，并让错误文案带出真实原因 —— 续期在这里永远无用，
 * 反而拖慢失败反馈。
 */
export declare function isClineRegionForbidden(status: number, body: string): boolean;
/**
 * 在 `ctx.llm` 上注册 Cline provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `cline`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export declare function registerClineLlm(ctx: Context, options: ClineAdapterOptions): ClineAdapter;
//# sourceMappingURL=cline-adapter.d.ts.map