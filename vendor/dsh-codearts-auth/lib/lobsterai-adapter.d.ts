/**
 * LobsterAI（有道龙虾）LLM 适配器。
 *
 * 骨架取自 `src/buddy-adapter.ts`（本插件已验证的实现），但**协议差异全部重写**：
 * LobsterAI 与腾讯系只在「OpenAI 兼容 + SSE」这一层相同，其余没有一处能照抄。
 *
 * ## 与 `BuddyAdapter` 的关键差异（逐条对应计划文档 §3.5-C）
 *
 * | 项 | 处理 |
 * |---|---|
 * | URL | `${product.apiBase}/api/proxy/v1/chat/completions` |
 * | 请求头 | 只设 `Authorization` / `Content-Type` / `Accept` / `User-Agent` / `X-LobsterAI-Client-*`；**不设**腾讯系归属头 |
 * | `stream` | **恒为 `true`** —— 上游只支持 SSE，`stream:false` 返回 500 |
 * | `tool_choice` | **不适用**：DSH 的 `GenerateOptions` 无该字段，且 body 由本适配器自建，天然不会出现（Go 桥接层要归一化是因为它转发客户端的原始 body） |
 * | `prompt_cache_key` | **不发** —— 那是腾讯后端的前缀缓存机制，此处未实测支持 |
 * | 思考等级 | **不照抄** buddy 的 deepseek 补档逻辑（那是针对腾讯后端实测的）；仅透传 |
 * | 图片 | **不支持**，`inputModalities` 恒为 `['text']` |
 *
 * 可以原样复用的是 `src/sse.ts` 的三个工具函数（`readWithIdleTimeout` /
 * `resolveToolPairing` / `normalizeToolArguments` / `isTruncatedArguments`）——
 * 它们处理的是 **OpenAI 协议层的通用陷阱**，与具体厂商无关。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type LobsteraiCredential } from './lobsterai.js';
import { type LobsteraiProduct } from './lobsterai-product.js';
import { type ImageRequestTarget } from './image-budget.js';
/** 本适配器注册的 provider 路由名（历史常量，等价于 `LOBSTERAI.id`）。 */
export declare const PROVIDER = "lobsterai";
/**
 * 远端 `thinkingConfig.options[]` 中的一档。
 *
 * **两个字段语义不同，不可混用**：
 * - `level`：**产品侧档位名**（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`），
 *   用于 UI 展示与 `defaultLevel` 引用；
 * - `openclawLevel`：**发给服务端的 wire 值**（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`
 *   —— **没有 `max`**），即 `reasoning_effort` 的取值。
 *
 * 实测（2026-09-17，真实凭据）：远端把 `level: 'max'` 映射到
 * `openclawLevel: 'xhigh'`。直接发 `reasoning_effort: 'max'` 与不带参数无差异
 * （走服务端默认），发 `'xhigh'` 才真正触发最高档 —— 因此必须用 `openclawLevel`。
 */
export interface LobsteraiThinkingOption {
    /** 产品侧档位名（`defaultLevel` 引用的是这个值）。 */
    level: string;
    /** 发给服务端的 `reasoning_effort` 取值。 */
    openclawLevel: string;
}
/** 远端 `thinkingConfig`：可选档位与默认档位。 */
export interface LobsteraiThinkingConfig {
    options: readonly LobsteraiThinkingOption[];
    /** 默认档位（产品侧 `level` 值，需再经 `options` 映射成 wire 值）。 */
    defaultLevel: string;
}
/**
 * LobsterAI 远端模型条目。
 *
 * 除 `id`/`name` 外，还承载远端下发的**模型参数**（2026-09-17 实测）：
 * `contextWindow`（多数为 1000000）、`supportsImage`、`supportsThinking`、
 * `thinkingConfig`、`requestCapabilities`、`maxTokens`、`description`。
 * 这些是 `listModels` / `resolveModel` 的权威依据，优先于产品兜底表的估值。
 *
 * **可选字段缺失一律留 `undefined`，绝不填 0/false 之类的「假值」**：
 * 「远端说该模型不支持图片」与「远端没说」是两回事，前者可以据此拒绝图片
 * 输入，后者只能保守按不支持处理 —— 填 false 会让将来新增的视觉模型被
 * 静默误判。
 *
 * `runtimeProfile` / `supportsToolCalling` / `agenticReady`
 * 等字段**当前不消费**：它们是 IDE 内置 agent 内核（OpenClaw）的编排概念，
 * 本插件只做 OpenAI 兼容转发，没有对应语义。
 *
 * `costMultiplier` **消费**（2026-09-19 起）：它是计费倍率，展示在模型选择器里。
 */
export interface LobsteraiRemoteModel {
    id: string;
    name: string;
    /** 上下文窗口（远端权威值；缺失时由兜底表补位）。 */
    contextWindow?: number;
    /**
     * 计费倍率（`data.costMultiplier`）。
     *
     * ⚠️ 与 buddy 系的 `credits` **形态完全不同**：本处是**裸数字**（实测 `0.05`），
     * 而 buddy 是字符串 `"x0.05"`。不要共用解析函数。
     */
    costMultiplier?: number;
    /** 是否接受图片输入。 */
    supportsImage?: boolean;
    /** 是否支持思考（无 `thinkingConfig` 时无可选档位，仅作展示参考）。 */
    supportsThinking?: boolean;
    /** 可选思考档位与默认档位。 */
    thinkingConfig?: LobsteraiThinkingConfig;
    /** 该模型声明的请求能力（如 `lobsterai-options-v1`）。 */
    requestCapabilities?: readonly string[];
    /** 单次输出上限。 */
    maxTokens?: number;
    /** 远端提供的模型描述（用于模型选择器）。 */
    description?: string;
}
/**
 * 解析 `thinkingConfig`；结构不符时返回 `undefined`（丢弃而非解析出半截数据）。
 *
 * 严格性对齐 IDE 的 `parseModelThinkingConfig`（`modelThinking.js`）：
 * - `options` 必须是非空数组，每项都要有合法的 `level` 与 `openclawLevel`；
 * - 两者的「是否 off」必须一致（避免 `off` 配一个非 off 的 wire 值）；
 * - 不允许重复档位；
 * - `defaultLevel` 必须存在且落在 `options` 里 —— 否则 DSH 会拿一个
 *   不存在的档位去请求，比不声明更糟。
 *
 * 只有 `off` 一档时视为无档位可选（等价于不支持配置思考），返回 `undefined`。
 */
export declare function parseLobsteraiThinkingConfig(value: unknown): LobsteraiThinkingConfig | undefined;
/**
 * 从响应中提取模型数组，兼容上游**两种**形状。
 *
 * 这两种形状在真实服务端上都出现过，必须都认：
 *
 * - **单层**（2026-09-17 实测的真实形态）：
 *   `{code:0, message:'success', data:[{modelId,...}]}` —— `data` 直接是数组；
 * - **双层**（`internal/upstream/client.go:254-278` 记录的形态）：
 *   `{code:0, msg:'OK', data:{data:[{modelId,...}]}}` —— 数组嵌在 `data.data`。
 *
 * **刻意不复用 {@link parseLobsteraiEnvelope}**：那个信封要求 `data` 必须是
 * 对象（用于把「凭据失效返回 `data:null`」判成失败，见其注释），而本端点的
 * 真实 `data` 恰恰是**数组**。复用它会让信封恒定返回 `ok:false`，进而使整个
 * 模型列表恒为空数组，适配器再静默回退到静态兜底表 ——
 * 症状就是「远端已上线的新模型在面板里看不到」，且不报任何错。
 *
 * `code !== 0` 或结构不符时返回空数组，由调用方回退兜底目录。
 */
export declare function readLobsteraiModelArray(body: unknown): readonly unknown[];
/**
 * 解析 `GET /api/models/available` 的响应。
 *
 * 取 `modelId`/`modelName` 与模型参数（见 {@link LobsteraiRemoteModel}）。
 * `provider`/`apiFormat`/`runtimeProfile` 等字段不取：前者是上游内部字段，
 * 后者是 IDE 内置 agent 内核的编排概念，对 OpenAI 兼容转发没有意义。
 *
 * 形状兼容性见 {@link readLobsteraiModelArray}。
 */
export declare function parseLobsteraiModels(body: unknown): LobsteraiRemoteModel[];
/**
 * 构造模型列表请求的 query 串（keyfrom 身份载荷）。
 *
 * 注意**不含 `refreshToken`** —— `client.go:229-241` 只用了 `KeyfromBody()`
 * 的字段（firstKeyfrom/latestKeyfrom/version/uuid/userId）。
 * 把 refreshToken 放进 query 既是信息泄露（会进服务端访问日志），
 * 也不是该端点的预期输入。
 */
export declare function buildLobsteraiModelsQuery(credential: LobsteraiCredential, clientVersion: string): string;
/** `LobsteraiAdapter` 的构造选项。 */
export interface LobsteraiAdapterOptions {
    credentialRef: CredentialRef;
    /** 从凭据存储解析凭据。 */
    resolveCredential: (modelId?: string) => Promise<LobsteraiCredential | undefined>;
    /** 静默续期凭据。 */
    refresh: () => Promise<void>;
    /** 动态拉取远端模型列表；失败时回退到 `product.fallbackModels`。 */
    fetchRemoteModels?: () => Promise<LobsteraiRemoteModel[]>;
    /** 解析当前客户端版本号（chat 与模型列表都要带）。 */
    resolveClientVersion?: () => Promise<string>;
    fetchImpl?: typeof fetch;
    /** 多账号池（用于限流时切换账号）。 */
    accountPool?: AccountPool;
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
     * 背景（issue !IKITT9）：LobsterAI 撞的是**请求体体积**（实测 12 张原图能过、
     * 13 张 ≈50 MiB 回 `SERVER code=500`），不是腾讯那道图片 token 预算。
     */
    readImageRequest?: (attachment: unknown, target: ImageRequestTarget) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link LOBSTERAI}。 */
    product?: LobsteraiProduct;
}
/** LobsterAI 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export declare class LobsteraiAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    private remoteModels;
    /**
     * 目录加载闸门：并发去重 + 失败/空结果冷却。
     * 依据见 `src/remote-catalog-gate.ts`（首屏「加载模型巨长」的实测归因）。
     */
    private readonly catalogGate;
    /** 远端下发的模型元数据（id → 条目），listModels/resolveModel 共用。 */
    private remoteMeta;
    /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
    private readonly fallbackIndex;
    constructor(options: LobsteraiAdapterOptions);
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
     * 懒加载远端模型目录（仅拉取一次）。
     *
     * `listModels` 与 `resolveModel` 共用：`resolveModel` 可能先于 `listModels`
     * 被调用（如直接从历史会话进入），此时同样需要触发一次拉取。
     */
    private ensureRemoteModels;
    /**
     * 模型接受的输入模态。
     *
     * 远端 `supportsImage` 是权威来源（实测 26 个模型里 19 个为 true）。
     * 远端未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
     * 也不要报一个服务端不认的模态（请求会以 400 失败）。
     */
    private inputModalitiesFor;
    /**
     * 模型的上下文窗口：远端权威值优先，兜底表估值次之。
     *
     * 兜底表统一写 131072，而实测远端多数模型返回 1000000 —— 采信估值会让
     * DSH 在远未用满窗口时就触发上下文压缩。
     */
    private contextWindowFor;
    /**
     * 模型可选的思考档位。
     *
     * ## `id` 与 `name` 的来源**不同**（这是本方法最容易搞错的地方）
     *
     * - **`id` = `openclawLevel`（wire 值）**：DSH 会把选中的 id 原样写进请求体的
     *   `reasoning_effort`，故必须是服务端认的取值。⚠️ wire 侧**没有 `max`** ——
     *   实测直接发 `reasoning_effort: 'max'` 与不带参数**无差异**（走服务端默认），
     *   发 `'xhigh'` 才真正触发最高档。
     * - **`name` = `level`（产品侧档位名）**：纯展示。远端把 `level: 'max'` 映射到
     *   `openclawLevel: 'xhigh'`，用户在产品侧看到的就是 **Max**。
     *
     * ⚠️ **历史缺陷**（用户报障 / Issue #IKHCZF）：早期用 `openclawLevel` 同时查
     * 展示名表，于是最强档显示成 **XHigh**，与产品侧命名 **Max** 不一致 ——
     * 用户按 IDE 里的「Max」找，界面上却只有「XHigh」。
     * 根因是把「wire 值」与「展示名」当成同一个概念。
     *
     * 无 `thinkingConfig` 的模型不声明 `reasoning`，UI 显示「当前模型未提供推理等级」，
     * 而不是给一个发了也没用的档位。
     */
    private reasoningFor;
    /**
     * 静态兜底模型目录。
     *
     * **不做 buddy 那样的「以兜底表为准」裁剪**（`reconcileWithFallback`）：
     * LobsterAI 的远端接口是**权威的**（产品兜底表本身就是从它实测抄来的），
     * 远端可用时应完全采信，兜底只在远端整体失败时顶替。
     *
     * ⚠️ 兜底表**不含 `costMultiplier`**：它是编译期快照，而价格会变；
     * 远端整体失败时拿不到权威倍率，此时**不显示**倍率（不猜）。
     */
    private staticFallbackModels;
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` 同款 shim。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 解析客户端版本号（未注入时用兜底值）。 */
    private clientVersion;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
    /**
     * 消费 SSE 响应并产出 `StreamChunk`。
     *
     * 上游返回标准 OpenAI SSE。移植了 Go 侧 `Aggregate` 的三处兼容处理：
     * 1. **容忍 `data:` 后无空格**（`sse.go:37-39` 注释写明「龙虾上游实测无空格」）——
     *    这里靠 `line.slice(5).trim()` 天然兼容两种形态；
     * 2. `reasoning_content` 单独成块（`sse.go:74-76`）；
     * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
     *
     * 额外保留 buddy 适配器里两条实测得出的防坑规则（与厂商无关，属协议层）：
     * - **`function.name` 只允许非空覆盖**：后续分片带空串 `""`，
     *   直接覆盖会清空已解析出的工具名 → `unknown tool ""`；
     * - **`finish_reason` 映射顺序**：`length` / 中途断流 / 参数残缺一律归为
     *   `max-tokens`，否则 harness 会执行残缺 JSON 参数并污染会话历史。
     */
    private consumeSse;
}
/**
 * 在 `ctx.llm` 上注册 LobsterAI provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `lobsterai`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export declare function registerLobsteraiLlm(ctx: Context, options: LobsteraiAdapterOptions): LobsteraiAdapter;
/** 构造远端模型列表请求的完整 URL（供 auth 服务与测试复用）。 */
export declare function buildLobsteraiModelsUrl(product: LobsteraiProduct, credential: LobsteraiCredential, clientVersion: string): string;
/** 模型列表请求超时（与其它控制面请求一致）。 */
export declare const LOBSTERAI_MODELS_TIMEOUT_MS = 30000;
//# sourceMappingURL=lobsterai-adapter.d.ts.map