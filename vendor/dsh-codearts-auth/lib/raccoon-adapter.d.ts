/**
 * Raccoon Work LLM 适配器。
 *
 * ## 为什么复用 `openai-compat.ts`
 *
 * 实测 `POST /api/web/llm/v2/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`，无加密、无信封、无格式转换），
 * 与 Qoder / Loomy 同形，正是 `openai-compat.ts` 的适用场景。
 *
 * ⚠️ **不改 `openai-compat.ts` 的内部逻辑** —— 它当前服务 qoder 与 loomy；
 * raccoon 是第三个消费者。若实测发现字段形态不符，应在**本文件**内做局部适配，
 * 而不是改共享层（那会影响另外两个 provider 的既有行为）。
 *
 * ## 两个必须真的做到的点
 *
 * 1. **`tools` 必须下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型
 *    在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。
 * 2. **`listAllModels()` 必须实现** —— 设置页要显示被关闭的模型及其倍率；
 *    缺了它会退化为裸 id（AGENTS.md 记录的真实缺陷）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
import { type ImageRequestTarget } from './image-budget.js';
/** 本适配器注册的 provider 路由名（等价于 `RACCOON.id`）。 */
export declare const PROVIDER = "raccoon";
/**
 * 把 DSH 的档位 id 映射成请求体的 `extra_body.thinking` 字段。
 *
 * ## 为什么是这个形态（实测确证，别改）
 *
 * 唯一**有效**的思考控制通道是 **`extra_body.thinking`**（Anthropic 风格对象），
 * 服务端报错原文确认其枚举：``expected one of `adaptive`, `enabled`, `disabled` ``。
 *
 * 实测（判据为服务端上报的 `reasoning_tokens`）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** → 真关闭 |
 * | `extra_body.thinking={type:'enabled'}` | 均值 218 ≈ 基线 222 → 与默认等价 |
 *
 * ⚠️ **`reasoning_effort` 虽然被服务端接受（8 个枚举值），但实测无效果** ——
 * 8 轮配对实验里 `max - minimal` 正差 4 次 / 负差 4 次（纯随机），
 * 且 `none` 不关闭思考（均值 301 vs `disabled` 的 0）。
 * 故**不用它**表达档位，详见 `raccoon-product.ts` 的常量注释。
 *
 * ⚠️ **无效的写法**（都实测过）：`extra_body.enable_thinking`、
 * 双层 `extra_body.extra_body.*`、把 `thinking` 放**顶层**（不在 `extra_body` 内）、
 * `thinking.budget_tokens`（仅被格式校验）。
 *
 * ## 语义
 *
 * - 档位为 `off` → `{ thinking: { type: 'disabled' } }`（真的不产生思考内容）
 * - 其余（含 `on`）→ `{ thinking: { type: 'enabled' } }`
 *
 * ⚠️ **不传档位时返回 `undefined`**（不发该字段），保持服务端默认行为 ——
 * 实测默认就是开启，故与 `on` 等价，但**少发一个字段**更稳。
 *
 * @returns 要写进 `extra_body` 的对象；`undefined` 表示不发该字段。
 */
export declare function raccoonThinkingExtraBody(effort: string | undefined): {
    thinking: {
        type: 'enabled' | 'disabled';
    };
} | undefined;
/**
 * 该模型在 UI 上可选的思考档位。
 *
 * ⚠️ **所有模型都返回同样两档** —— 实测 `extra_body.thinking` 是 **provider 级
 * 方言**，与模型无关。故不做 per-model 分派（那会是凭空猜测）。
 *
 * ⚠️ `defaultEffort` 必须落在 `efforts` 内 —— DSH 会直接拿它发请求，
 * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`。
 */
export declare function raccoonReasoningInfo(): {
    efforts: Array<{
        id: ReturnType<typeof ReasoningEffortId>;
        name: string;
    }>;
    defaultEffort: ReturnType<typeof ReasoningEffortId>;
};
/** 远端模型条目（已归一）。 */
export interface RaccoonRemoteModel {
    id: string;
    /** **已规范化**的展示名（含倍率）。 */
    name: string;
    contextWindow: number;
    maxTokens: number;
    supportsImage: boolean;
}
/** {@link RaccoonAdapter} 的构造选项。 */
export interface RaccoonAdapterOptions {
    /** 单凭据回退 ref（无账号池时）。 */
    credentialRef: CredentialRef;
    /** 解析当前可用凭据。 */
    resolveCredential: (modelId?: string) => Promise<RaccoonCredential | undefined>;
    /** 凭据失效时的处理（raccoon 有 refresh 端点，会真续期）。 */
    refresh: () => Promise<void>;
    /** 拉取远端模型目录；失败时适配器回退兜底表。 */
    fetchRemoteModels?: () => Promise<RaccoonRemoteModel[]>;
    /** 读取图片附件的原始字节（内联为 data URL 用）。 */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /**
     * 读取图片附件的**请求版本**（按字节目标缩放后的字节）。
     *
     * ⚠️ 与 {@link readImage} 的错误契约相反：**不可用时要返回 `undefined`**
     * 而不是抛错，适配器据此回退原图。理由与桥接实现见
     * `src/index.ts` 的 `makeReadImageRequest`、`src/image-budget.ts` 的
     * `projectRequestImage`。
     *
     * 背景（issue !IKITT9 的 raccoon 变体）：该网关按**请求体字节**设限，
     * 实测 `HTTP_413: request body exceeds 10MB` —— 两张 2560×1600 的截图
     *（base64 后各 ≈3.9 MB）再加别的内容就可能被拒。
     */
    readImageRequest?: (attachment: unknown, target: ImageRequestTarget) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 账号池（目录门控与黑名单）。 */
    accountPool?: AccountPool;
    /** 产品配置；默认 {@link RACCOON}。 */
    product?: RaccoonProduct;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
}
/**
 * raccoon 的失败类别。**「要不要换号」与「要不要写冷却」是两件事**，
 * 由本分类分别决定（混为一谈曾酿成事故，见下）。
 *
 * | 类别 | 判据 | 换号？ | 写冷却？ |
 * |---|---|---|---|
 * | `quota` | `14018` / `Credits exhausted` / `insufficient` / 「积分·额度·余额 + 不足·耗尽」/ `quota exceeded`；HTTP 402 | ✅ | ✅ 24h（日配额） |
 * | `rate` | HTTP 429 | ✅ | ✅ 1h |
 * | `auth` | HTTP 401 / 403（如 `code=200003 authorization_verify_error`） | ✅ | ❌ **绝不写** |
 * | `other` | 其余 4xx（400 参数错等） | ❌ | ❌ |
 *
 * ## 为什么 `auth` 必须「换号但不写冷却」（真实事故，2026-10-06 凌晨）
 *
 * 上游网关对**全池**回 `401 + authorization_verify_error`（网关侧授权校验故障，
 * 与某个号的额度无关）。当时的实现把 401 也当「可换号」，且冷却时长写成
 * `status === 429 ? 1h : 24h` ⇒ 401 落到 **24h**，于是一次请求内的换号循环
 * 连试 6 个号、给每个都写了 24 小时 ⇒ 池内候选筛空 ⇒
 * **整个 provider 被封一天**（下一次请求报 `no usable credential; log in first`）。
 *
 * buddy 的既有实现正是分开的：只有限流类写标记，认证类只 `continue` 换号。
 * 认证失败是**账号态**（凭据失效），不是「该模型冷却」；写标记会让池把无辜
 * 账号长期排除，且把网关侧故障放大成全池不可用。
 */
export type RaccoonFailureClass = 'quota' | 'rate' | 'auth' | 'other';
/**
 * 判定失败类别（文案 + 状态码双通道，与 `isRateLimited` 同构）。
 *
 * ## ⚠️ 401/403 **必须先判**（PR !71 审计）
 *
 * 早期实现把文案判定放在状态码之前，于是 `403 + "insufficient permissions to
 * access this resource"` 被判成 `quota` ⇒ **给一个只是没权限的账号写 24 小时
 * 冷却**。这与 {@link RaccoonFailureClass} 记的 2026-10-06「全池被封」事故
 * **同型**（那次触发词是 `authorization_verify_error`，这次是
 * `insufficient permissions`）：认证类只换号、绝不写标记，是那次事故换来的
 * 不变式，不能被文案判据绕过。
 *
 * ⚠️ 顺序不能调换回去：把「先按文案判门禁、再解析」当通则会静默误伤 ——
 * 401/403 与额度文案并存时（网关侧故障常在报文里带余额提示）必须以状态码为准。
 *
 * ⚠️ **本函数与 `classifyLoomyFailure`（`src/loomy-adapter.ts`）是同一张判据表的
 * 两个实现，必须逐格同构**。真实教训（2026-10-06，**同型复发**）：本函数在
 * `7b524ff` 收窄后 loomy 那份**未同步**，于是同一报文
 * （`403 + insufficient permissions` / `403 + 积分不足` / `401 + 余额不足`）
 * 在 loomy 上仍判 `quota` ⇒ **给无辜账号写 24h 冷却**，在 raccoon 上判 `auth`。
 * 改动任一侧都必须同步另一侧，并跑 `tests/unit/loomy-adapter.spec.ts` 的
 * 「与 raccoon 对拍」段（同一批真实报文喂两个分类器，分叉即红）。
 */
export declare function classifyRaccoonFailure(errorText: string, status: number): RaccoonFailureClass;
/**
 * 该失败是否值得「换下一个账号」重试。
 *
 * 可换：额度耗尽、限流、认证（另一号的 token 可能有效）。
 * 不可换：其余 4xx（400 参数错、404 路由错等）——换号无益，请求本身有问题，
 * 换谁都会失败；按原错误抛，避免吞成「均不可用」。
 */
export declare function shouldRotateRaccoonAccount(errorText: string, status: number): boolean;
/**
 * 该类别是否要写冷却标记。
 *
 * ⚠️ `auth` 不在其中 —— 见 {@link RaccoonFailureClass} 的事故说明。
 */
export declare function recordsRaccoonRateLimit(cls: RaccoonFailureClass): boolean;
/** Raccoon Work 模型适配器。 */
export declare class RaccoonAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 兜底模型索引（id → 条目）。 */
    private readonly fallbackIndex;
    /** 远端模型缓存；未拉取时为 undefined。 */
    private remoteModels;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
    private readonly catalogGate;
    constructor(options: RaccoonAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串，直接回退到本产品的 id。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 完整目录（**不套黑名单**），带最终展示名。
     *
     * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
     * 补回，而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
     */
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
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法。与其余适配器同款 shim。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * 在 `ctx.llm` 上注册 raccoon provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export declare function registerRaccoonLlm(ctx: Context, options: RaccoonAdapterOptions): RaccoonAdapter;
//# sourceMappingURL=raccoon-adapter.d.ts.map