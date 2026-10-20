/**
 * Gemini（Cloud Code Assist）模型适配器。
 *
 * 协议实现（信封构造、SSE 消费）在 `gemini-messages.ts`，
 * 认证在 `gemini-auth.ts`，配额在 `gemini-credits.ts`。
 *
 * ## ⚠️ 本适配器独有的四件事（照 `docs/GEMINI-PORT-PLAN.md` §3.1/§3.2）
 *
 * 1. **两层救场**：先换端点（廉价兜底），再换账号（主救场）。
 *    ⚠️ 端点差异**未获实验支持**（404 / project 两类错误两端点行为完全一致），
 *    换端点零成本无害，但**不能当 quota 的有效解法**。
 * 2. **签名回填 + 去签重试**：`functionCall` 上的 `thoughtSignature` 由
 *    `gemini-sigstore.ts` 落盘缓存，下一轮按「工具名 + 规范化参数」回填；
 *    上游仍拒签名时**去签重试一次**。
 * 3. **图片两跳**：先 `projectRequestImage`（插件侧缩放，640,000 px），
 *    拿不到才 `readImage`（原图）。两者都拿不到**抛错**，绝不静默丢图。
 * 4. **`toolChoice` 恒 AUTO**：`@deepseek-ai/dsh-llm` 的 `GenerateOptions`
 *    **没有** `toolChoice` 字段（实测 `lib/types/types.d.ts:380-416`），
 *    故不传；`translateGeminiRequest` 内部默认走 `AUTO`。
 */
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type AccountPool } from './account-pool.js';
import { type GeminiCredential, type GeminiProduct } from './gemini.js';
import type { GeminiSigStore } from './gemini-sigstore.js';
/**
 * 判定「签名被上游拒绝」（原版 `IsSignatureError` 的口径）。
 *
 * ⚠️ 必须**宽**：上游对签名问题的报错文案不统一（`thought_signature`、
 * `Invalid signature`、`signature is required`…），而漏判的后果是
 * 用户看到一次莫名其妙的 400；误判的后果只是多发一次不带签名的请求
 * （那条路径本来就要试）。
 */
export declare function isGeminiSignatureError(text: string): boolean;
/**
 * 判定「上游的**服务端会话**累计输入超过 1M」。
 *
 * ## 为什么单独成一类
 *
 * 上游按 `sessionId` 在服务端累计对话输入；长工具循环会把累计推过 1M，
 * 此后该 sessionId 的**每个**请求都 400
 * `The input token count exceeds the maximum number of tokens allowed 1048576`，
 * 直到该服务端会话过期。**削本地历史没用**（累计在服务端、按 sessionId 计），
 * 原地重试/换端点也没用 —— 唯一出路是**升代换一个全新 sessionId**。
 *
 * ⚠️ 判据逐字抄自 `Antigravity-Manager` 的 `[FIX session-1M]`
 * （`proxy/handlers/gemini.rs:983`）：`status == 400 && 正文含
 * "exceeds the maximum number of tokens"`。这是三家唯一给出**具体触发条件**的
 * 实现，且 wb 独立撞上同一现象（`SessionOverflowBump`）。
 *
 * ⚠️ 必须**先于** {@link isGeminiQuotaText} 判定：该文案里的 "exceeds" 不含
 * `isGeminiQuotaText` 的关键词 `"exceeded"`，但真出现 `exceeded` 变体时不能被
 * 误判成「配额耗尽」而触发换号 —— 换号解决不了服务端会话累计。
 */
export declare function isGeminiSessionOverflow(text: string): boolean;
/** {@link GeminiAdapter} 的构造选项。 */
export interface GeminiAdapterOptions {
    /** 单凭据回退 ref（无账号池时）。 */
    credentialRef: CredentialRef;
    /** 解析当前可用凭据。 */
    resolveCredential: (modelId?: string) => Promise<GeminiCredential | undefined>;
    /** 凭据失效时的处理（续期或换号，由接线侧决定）。 */
    refresh: () => Promise<void>;
    /** 账号池（目录门控、黑名单、限流切号）。 */
    accountPool?: AccountPool;
    /**
     * 内联一张图片为**原始字节**（由调用方桥接 `ctx.attachments.readImage`）。
     *
     * ⚠️ 契约与 `buddy-adapter.ts:195` 一致：**读不到必须抛错**，不得返回空。
     * 静默丢图会让用户以为图片被模型看到了（与 cline / lobsterai 同口径）。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
    /**
     * 取**请求版本**图片（附件服务按目标尺寸缩放）。
     *
     * ⚠️ 契约与 `readImage` **相反**：不可用时返回 `undefined`（不是抛错）——
     * 缩放是优化，拿不到就发原图（见 `image-budget.ts:151`）。
     */
    readImageRequest?: (attachment: unknown, target: {
        width: number;
        height: number;
        maxBytes: number;
    }) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** `thoughtSignature` 缓存（未提供则每轮都不带签名）。 */
    sigStore?: GeminiSigStore;
    /**
     * 覆盖上行会话 id。
     *
     * ⚠️ 缺省**不传**（走内容派生：`project` + 首条 user 文本 + `sessionLane`）。
     * 只有复刻历史抓包/联调才钉固定值 —— 恒定值会让所有对话共用一个会话。
     */
    sessionId?: string;
    /**
     * 会话派生标签。推理路径用 {@link GEMINI_SESSION_LANE_INFER}（缺省），
     * 冒烟/探测路径用 {@link GEMINI_SESSION_LANE_SMOKE}。
     */
    sessionLane?: string;
    /**
     * 覆盖信封里的 `project`（缺省**自动探测**，见 `gemini-project.ts`）。
     *
     * ⚠️ 缺省不是「恒为 `aicode-consumers`」—— 那是探测为空时的兜底。
     * 只有联调/复刻历史抓包才显式钉值。
     */
    project?: string;
    /**
     * 项目号探测结果缓存（键 = 凭据身份）。
     *
     * ⚠️ 由接线侧**长期持有并复用**（不要每次调用现造）—— 现造等于没有跨请求缓存，
     * 每轮推理都会多打一次 `loadCodeAssist`。不传则退化为单次请求内缓存。
     */
    projectCache?: Map<string, string>;
    /** 探测用的 fetch（测试注入；缺省全局 `fetch`）。 */
    projectFetcher?: typeof fetch;
    /**
     * 把探测到的项目号回写凭据（跨启动缓存，best-effort）。
     *
     * ⚠️ 只回写**探测到的真值**，不回写兜底串 —— 理由见 `persistGeminiProject`。
     */
    persistProject?: (value: string) => Promise<void>;
    /** 回写失败时的告警出口（可选）。 */
    logger?: {
        warn(message: string): void;
    };
    /** 产品配置；默认 {@link GEMINI}。 */
    product?: GeminiProduct;
}
/** Gemini（Cloud Code Assist）模型适配器。 */
export declare class GeminiAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    constructor(options: GeminiAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 静态模型表（用户拍板：不拉远端目录）。
     *
     * ⚠️ 静态表**每次现算**（纯本地、零成本），不做任何缓存 —— 缓存只会带来
     * 「表被改过但进程还拿着旧值」这一种故障。
     */
    private loadModels;
    /**
     * 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。
     *
     * ⚠️ **必须同步返回数组，不能是 `async`**（`minimax-adapter.ts:218-242`
     * 记录的同类缺陷：写成 async 会让 `jet-hub-rpc.ts:2041 [...all]` 与
     * `:2125 all.map` 抛 `TypeError: all is not iterable`）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    private inputModalitiesFor;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 兼容 0.1.1-rc.2 的 `prepareCall` shim（与其余适配器同款）。 */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 图片两跳的第一跳（缩放版）；返回 `undefined` 表示「该发原图」。 */
    private projectImage;
    /**
     * 收集并内联本次请求涉及的全部图片。
     *
     * ⚠️ 两跳都失败时**必须抛错**（`buddy-adapter.ts:1239-1285` 的权威写法）：
     * 静默丢弃会表现为「图片凭空消失、模型答非所问」，是最难排查的一类问题。
     */
    private collectInlineImages;
    /**
     * 走 **Cloud Code 流式推理** 发一次请求。
     *
     * 控制流（计划 §3.1 的完整实现）：
     * 1. 签名被拒 → 去签重试一次（同账号同端点）；
     * 2. 403/404、400(quota|permission|unsupported|project) → 先换端点一次；
     * 3. 429 第一次 → 先换端点（廉价尝试），第二次 → 换账号（主救场）；
     * 4. 401 → 先续期一次，续不动 → 换账号；
     * 5. 换账号用**局部可变**的 `currentAccountId`，`tried` 集合跨轮保留；
     * 6. 全部试完 → 抛 `QUOTA_EXCEEDED`（不无限切）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * HTTP 失败 → {@link LlmError}。
     *
     * ⚠️ 归类必须拆细（计划 §3.1）：把 quota 归成 `SERVER` 会让 harness
     * 白重试 5 次（500/1000/2000/4000/8000 ≈ 15.5 秒），而 `QUOTA_EXCEEDED`
     * **不在** `DEFAULT_RETRYABLE_CODES` 里，会立刻把控制权交还用户。
     */
    private classifyFailure;
}
/** 在 `ctx.llm` 上注册 gemini provider 路由与适配器。 */
export declare function registerGeminiLlm(ctx: Context, options: GeminiAdapterOptions): GeminiAdapter;
/** 供接线侧构造档位 id（避免各处重复 `as ReasoningEffortId`）。 */
export declare function geminiEffortId(id: string): ReasoningEffortId;
//# sourceMappingURL=gemini-adapter.d.ts.map