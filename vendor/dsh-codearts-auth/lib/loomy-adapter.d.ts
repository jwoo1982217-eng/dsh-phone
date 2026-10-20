/**
 * Loomy LLM 适配器。
 *
 * ## 协议
 *
 * 实测（2026-09-26）`POST {apiBase}/chat/completions` 是**标准 OpenAI 兼容
 * + 标准 SSE**：`data:` 帧 + 空 `data:` 终止帧，思考在 `delta.reasoning_content`，
 * **无加密、无信封、无格式转换**。与 qoder 同形，故消息序列化与 SSE 消费
 * 直接复用 `src/openai-compat.ts` —— 那是为这种形态抽的共享层，
 * **新增** provider 用它正是其设计意图（AGENTS.md 只禁止拿它去重构
 * buddy/lobsterai 的既有实现）。
 *
 * ⚠️ **认证头与业务端点不同**：chat 端点**只认** `Authorization: Bearer`，
 * 而 `/models`、`/points/*` 只认 `token`。故 `stream()` 用
 * `loomyChatHeaders()`（两个都发），`listModels()` 用 `loomyBusinessHeaders()`。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type LoomyCredential } from './loomy.js';
import { type LoomyProduct } from './loomy-product.js';
/** 本适配器注册的 provider 路由名（等价于 `LOOMY.id`）。 */
export declare const PROVIDER = "loomy";
/** 远端模型条目（已归一）。 */
export interface LoomyRemoteModel {
    id: string;
    /** **已规范化**的展示名（含倍率）。 */
    name: string;
    contextWindow: number;
    supportsImage: boolean;
    supportsThinking: boolean;
    /**
     * 可选思考档位（远端 `reasoning_efforts`，如 `['none','low','medium','high','xhigh']`）。
     *
     * ⚠️ **取自远端而非硬编码** —— 服务端 `GET /models` 直接下发了这两个字段，
     * 且带 `reasoning_catalog_version`（catalog 版本哈希），故档位随服务端更新，
     * 无需改代码。
     *
     * 缺失（`undefined`）表示**该模型不提供档位选择**，此时不声明 `reasoning`，
     * UI 显示「当前模型未提供推理等级」—— 而不是给一个发了也没用的档位。
     */
    efforts?: string[];
    /** 远端声明的默认档位（`default_reasoning_effort`）。 */
    defaultEffort?: string;
}
/**
 * 解析远端 `GET /models` 响应，只保留 `type === 'chat'` 的条目。
 *
 * ⚠️ 过滤判据是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
 * 模型的输入模态含 `image`（能看图），那不是生图模型。
 * ⚠️ 展示名经 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 */
export declare function parseLoomyRemoteModels(payload: unknown): LoomyRemoteModel[];
/** {@link LoomyAdapter} 的构造选项。 */
export interface LoomyAdapterOptions {
    /** 单凭据回退 ref（无账号池时）。 */
    credentialRef: CredentialRef;
    /**
     * 解析当前可用凭据。
     *
     * ⚠️ 入参是**本轮要用的模型 id**：Loomy 的选号策略要按「该模型是否受限」
     * 先过滤账号（限流是**按模型**记的），再按余额分档。实现**必须**把它透传给
     * `AccountPool.getAvailableAccount` 的 `modelId` —— 早期实现传空串
     * （等于不按模型过滤），会让模型级限流失效。
     */
    resolveCredential: (modelId?: string) => Promise<LoomyCredential | undefined>;
    /**
     * 凭据失效时的处理。
     *
     * ⚠️ Loomy **没有 refresh 端点**，故实现只做**有效性探测**并在失效时抛错，
     * 不会（也无法）续期。
     */
    refresh: () => Promise<void>;
    /** 拉取远端模型目录；失败时适配器回退兜底表。 */
    fetchRemoteModels?: () => Promise<LoomyRemoteModel[]>;
    /** 读取图片附件的原始字节（内联为 data URL 用）。 */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 账号池（目录门控与黑名单）。 */
    accountPool?: AccountPool;
    /** 产品配置；默认 {@link LOOMY}。 */
    product?: LoomyProduct;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
}
/**
 * Loomy 的失败类别。**「要不要换号」与「要不要写冷却」是两件事**——
 * 认证类（401/403）只换号、**绝不写冷却**。
 *
 * ⚠️ 真实事故（2026-10-06 凌晨，raccoon 同型实现上暴露）：上游网关对**全池**
 * 回 `401 + authorization_verify_error`（网关侧授权校验故障）。当时把 401 也算
 * 「可换号」且在换号前写冷却、时长取 `status === 429 ? 1h : 24h` ⇒ 一个请求内
 * 连试 6 个号、每个写 24h ⇒ 池内候选筛空 ⇒ **整个 provider 被封一天**
 * （下一次请求报 `no usable credential; log in first`）。
 * buddy 的既有实现是分开的：只有限流类写标记，认证类只 `continue`。
 */
export type LoomyFailureClass = 'quota' | 'rate' | 'auth' | 'other';
/**
 * 判定失败类别（与 {@link RaccoonFailureClass} 同构——raccoon 与 loomy 的额度
 * 错误形态同族：`14018 Credits exhausted`，HTTP 层无专用状态码，文案是主通道；
 * 词表限「积分/额度/余额 + 不足/耗尽」的确定性组合，避免误伤正文里恰好讨论
 * 「余额」的 4xx）。
 *
 * ## ⚠️ 401/403 **必须先判**（同型复发，2026-10-06）
 *
 * 本函数初版与 raccoon 的**修复前**版本逐字同形：文案先判、且 `insufficient`
 * **单独出现**即算额度。raccoon 已在 `7b524ff` 收窄，loomy 未同步 ⇒ 同一报文
 * 在两个 provider 上被判成**不同类别**，且危险方向恒定朝 loomy（多写冷却）：
 *
 * | 报文（实测，见 tests 的「与 raccoon 对拍」段） | loomy 修复前 | raccoon 已修 |
 * |---|---|---|
 * | `403 + insufficient permissions to access this resource` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `403 + 积分不足` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `401 + 余额不足` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `401 + 14018 Credits exhausted`（网关故障通常带余额提示） | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `400 + the context window is insufficient for this model` | `quota` ⇒ 写 24h | `other` ⇒ 不换号 |
 *
 * 前四行正是 {@link LoomyFailureClass} 记的 2026-10-06「全池被封」事故形态
 * （那次触发词是 `authorization_verify_error`，这次是 `insufficient permissions`
 * / 「不足」类文案）：**认证类是账号态、不是模型冷却**，写标记会把网关侧的
 * 授权故障放大成「整个 provider 被封 24h」。
 *
 * 两处修法（与 raccoon 逐字一致，方向都是「宁可漏判不可误伤」）：
 * 1. **401/403 优先**按认证类处理 —— 状态码与额度文案并存时以状态码为准；
 * 2. `insufficient` 须与邻近的「钱」义词（point/credit/balance/quota/token）
 *    **共现**才算额度；上下文超长 / 数据不足等与额度无关。
 *
 * ⚠️ 两家的判据必须**逐格同构**：`classifyLoomyFailure` 与
 * `classifyRaccoonFailure` 是同一张表的两个实现，任一侧单方面改动都会造成
 * 本文件记的这起「同型复发」。回归用例用同一批真实报文喂两个分类器对拍。
 */
export declare function classifyLoomyFailure(errorText: string, status: number): LoomyFailureClass;
/**
 * 该失败是否值得「换下一个账号」重试。
 *
 * 导出仅供单测锁定判据本身——只靠调用点顺序兜不住边界（`isRateLimited`
 * 的 429 边界那次已验证过）。
 */
export declare function shouldRotateLoomyAccount(errorText: string, status: number): boolean;
/** 该类别是否要写冷却标记（`auth` 不在其中，见 {@link LoomyFailureClass}）。 */
export declare function recordsLoomyRateLimit(cls: LoomyFailureClass): boolean;
/** Loomy 模型适配器。chat 端点用 Bearer，业务端点用 token。 */
export declare class LoomyAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 兜底模型索引（id → 条目）。 */
    private readonly fallbackIndex;
    /** 远端模型缓存（含展示名与能力）；未拉取时为 undefined。 */
    private remoteModels;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
    private readonly catalogGate;
    constructor(options: LoomyAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
     * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /** 完整目录（**不套黑名单**），带最终展示名。设置页需要它渲染被关闭的模型。 */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 取远端模型目录；**失败时不把兜底表写进缓存**。
     *
     * ⚠ 原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成
     * 「已加载」记下，于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩
     * 兜底模型（用户看不到自己的模型，且无从触发重试，只能重启）。
     * 改为：只缓存**真实远端目录**，兜底表每次现算（纯本地、零成本），
     * 并用 {@link RemoteCatalogGate} 的冷却挡住「每模型重试一次」的放大。
     */
    private loadModels;
    private inputModalitiesFor;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 该模型的思考档位（`resolveModel` 的 `reasoning` 字段）。
     *
     * ⚠️ **此前根本不声明** —— DSH 的思考强度选择器**只会**从
     * `resolveModel().reasoning` 渲染，故两个站点从来没出现过档位选择器，
     * 尽管远端早就下发了 `reasoning_efforts`。这与 Qoder 那次（AGENTS.md 2.2 节）
     * 是**完全同型**的缺陷。
     *
     * 三条口径：
     * 1. `efforts` **原样取远端顺序**（服务端下发的就是展示顺序）；
     * 2. `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
     *    给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟；
     * 3. 远端未下发档位时不声明 `reasoning`（UI 显示「当前模型未提供推理等级」）。
     */
    private reasoningFor;
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
}
/**
 * 在 `ctx.llm` 上注册 Loomy provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export declare function registerLoomyLlm(ctx: Context, options: LoomyAdapterOptions): LoomyAdapter;
//# sourceMappingURL=loomy-adapter.d.ts.map