/**
 * OpenCode Zen 模型适配器（账号槽 + 匿名槽平权混合池）。
 *
 * ## 平权轮换语义（设计文档 §5）
 *
 * 槽序列 = `[账号槽…（账号池手动顺序）] + [匿名槽（固定末位）]`。
 * 免费模型下**全序列**参与轮换；收费模型只由账号槽承载（匿名槽被剔除）。
 * 匿名殿后**只是位置，不是特权降级** —— 判据见 {@link pickSlot}。
 *
 * ## 身份即 key + IP + 随机会话
 *
 * opencode CLI 发往 Zen 的请求**没有机器指纹**（1.18.22 源码逐行核对），
 * 故「换一台 PC」在协议层等价于「换一个 key（账号）或换一个出口 IP（代理）」；
 * 指纹派生的作用是**防关联**与满足形状门禁，不参与配额计算。
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { type OpencodeErrorKind, type OpencodeFallbackModel } from './opencode-product.js';
import { listIdentitySlots, type IdentitySlot } from './opencode-auth.js';
/** 目录条目（远端与兜底共用的输出形状）。 */
export interface OpencodeCatalogEntry extends OpencodeFallbackModel {
}
/** 清空目录缓存（RPC 的「刷新目录」与单测隔离用）。 */
export declare function clearOpencodeCatalogCache(): void;
/** 远端目录拉取（注入以便单测离线）。 */
export type OpencodeCatalogFetcher = (slot: IdentitySlot, signal?: AbortSignal) => Promise<Response>;
/**
 * 拉取远端目录，失败回退静态兜底。
 *
 * @param ttlMs 命中内存缓存的窗口；测试传 0 强制每次都拉。
 *
 * ⚠️ 缓存按**槽 id** 分开存：不同账号的目录可能不同（付费可见性、
 * 地区封锁），共用一份缓存会让新加的账号迟迟看不到付费模型。
 */
export declare function loadOpencodeCatalog(fetchCatalog: OpencodeCatalogFetcher, slot: IdentitySlot, ttlMs?: number): Promise<readonly OpencodeCatalogEntry[]>;
export interface OpencodeAdapterOptions {
    /** 取当前槽序列（账号池顺序 + 匿名槽末位）。 */
    identitySlots: () => Promise<readonly IdentitySlot[]>;
    isLimited?: (slotId: string, modelId: string) => boolean;
    /** 拉远端目录；缺省时直接用兜底表。 */
    fetchRemoteCatalog?: OpencodeCatalogFetcher;
    /** 用户模型黑名单。 */
    disabledModels?: () => ReadonlySet<string>;
    /** 记录受限的副作用（切槽时由接线层提供）。 */
    markLimited?: (slotId: string, modelId: string, resetAtMs: number) => Promise<void>;
    /** 诊断日志。 */
    warn?: (message: string) => void;
    /**
     * 附件字节读取。**只有声明了 image 模态的模型才需要**。
     *
     * ⚠️ 缺省时带图请求会抛 `UNSUPPORTED_CONTENT`（见 `resolveImageUrls`），
     * 而不是把图片静默丢掉（Qoder 图片丢失事故的教训）。
     */
    readImage?: (ref: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
}
/**
 * 按「平权」规则选一个可用槽。
 *
 * ⚠️ **收费模型跳过匿名槽**：匿名凭证（字面量 `public`）只被服务端认作
 * 免费通道，送付费模型必然 401/403。
 *
 * @param excluded 已试过的槽 id（`tried` 集合）——保证每个槽最多试一次。
 */
export declare function pickSlot(slots: readonly IdentitySlot[], modelId: string, excluded: ReadonlySet<string>): IdentitySlot | undefined;
/**
 * 把「错误语义 + 服务端给的延迟」换算成该槽该模型的受限时长（相对 now 的毫秒数）。
 *
 * ⚠️ **服务端给了就用它的**，且 **0 是合法值**（「立即解除」而非「未知」）：
 * 必须用 `retryAfterMs === undefined` 判空，写成 `?? default` 之外的任何
 * falsy 判据都会把 0 静默换成 1 小时 —— 那会让刚恢复的账号继续被跳过。
 * ⚠️ 没给才退避：`free_usage_limit` 按当日 24h（与 qoder 的「当日额度」同思路），
 * `rate_limit` 指数退避并封顶 30 分钟（否则单次阻塞可能数小时，UI 无法区分
 * 「在等」与「卡死」）。
 */
export declare function opencodeRetryAfterMs(kind: OpencodeErrorKind, retryAfterMs: number | undefined, attempt: number): number;
export declare class OpencodeAdapter extends LlmAdapter {
    private readonly options;
    private lastSlot?;
    constructor(options: OpencodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    private catalog;
    /**
     * 完整目录（**同步**返回数组）。
     *
     * ⚠️ **绝不能写成 async**：`jet-hub-rpc.ts` 的 `ModelCatalogSource`
     * 接口是同步的且消费者**不 await**（`catalog = [...all]`），
     * 返回 Promise 会抛 `TypeError: all is not iterable`
     * （minimax 的同款真实缺陷，见 `minimax-adapter.ts` 的注释）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 平权轮换：失败按「语义」标记该槽 → 换下一槽重发。
     *
     * ⚠️ 三条硬规则（每条都对应一类真实缺陷）：
     *
     * 1. `tried` **跨迭代保留** —— 每次迭代重置会让两个槽之间无限来回
     *    （qoder 实测：标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
     * 2. **已交付内容的流不重放** —— 重放会让用户看到重复输出。
     * 3. 收费模型**不经匿名槽**（匿名凭证只认免费模型，见 `pickSlot`）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 解析消息里的图片附件为 data URL。
     *
     * ⚠️ **模型不支持图片时直接抛 UNSUPPORTED_CONTENT**（而不是静默丢弃）——
     * 静默丢弃会让用户以为模型看到了图（Qoder 图片事故的教训）。
     * ⚠️ 附件字节读不出来时写入**空 Map**：`openai-compat` 的
     * `userContentParts` 遇到缺失会产出 `[image unavailable]` 占位，
     * 至少让模型知道「这里本该有张图但没拿到」，而不是消息里凭空少一块。
     */
    private resolveImageUrls;
    /** 用指定槽发一次请求（轮换循环的复用单元）。 */
    protected streamVia(slot: IdentitySlot, options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** 在 `ctx.llm` 上注册 opencode 路由。 */
export declare function registerOpencodeLlm(ctx: Context, options: OpencodeAdapterOptions): OpencodeAdapter;
export { listIdentitySlots };
//# sourceMappingURL=opencode-adapter.d.ts.map