/**
 * AutoClaw LLM 适配器。
 *
 * 把 DSH 的 `LlmAdapter` 调用转发到智谱 AutoClaw 桌面端代理网关。
 * 遵循 OpenAI Chat Completions 协议，并实施必要的 406 绕过前缀校验与动态签名。
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { type AutoclawProduct } from './autoclaw-product.js';
import { type AutoclawCredential } from './autoclaw.js';
export interface AutoclawAdapterOptions {
    /** 凭据获取函数。支持按模型选号。 */
    resolveCredential?: (modelId?: string) => Promise<AutoclawCredential | undefined>;
    /** 凭据获取函数（旧兼容）。 */
    credentialProvider?: () => Promise<AutoclawCredential | undefined>;
    /** 探测凭据函数。 */
    probeCredential?: () => Promise<AutoclawCredential | undefined>;
    /** 覆盖默认的 fetch（测试注入）。 */
    fetchImpl?: typeof fetch;
    /** 凭据刷新回调。 */
    refresh?: () => Promise<void>;
    /** 黑名单模型过滤。 */
    disabledModels?: () => ReadonlySet<string>;
    /**
     * 「该供应商**整体关闭**」探测（Gitee issue IKP8OF）。
     *
     * ⚠️ **与 {@link disabledModels} 是两条腿，不可互相替代**：
     * 后者是「这些具体 id 被关着」（有界集合），而本回调回答的是
     * 「用户要求整个供应商关着吗」—— 它能覆盖**关闭之后才出现的模型**，
     * 那些 id 从未进过黑名单，`disabledModels` 永远看不到它们。
     *
     * 本家不走共享骨架（`model-catalog.ts`），故必须在这里显式判一次；
     * 缺失时按「未整体关闭」处理（老接线 / 单测替身的行为逐字不变）。
     */
    providerClosed?: () => boolean;
    /**
     * 读取图片附件字节（**图片通路必需**，2026-10-17 审计 P0 修复）。
     *
     * ⚠️ `zai_auto-fast` 的 `supportsImage: true` 有实测依据
     * （`docs/autoclaw-models.md:42`：AutoClaw 体系内唯一支持图文多模态的通道），
     * 而 `resolveModel` 已据此向宿主声明 `['text','image']` ⇒ 宿主**不投影**
     * 图片、**原样**下发（`dsh-llm/lib/index.js:2311`）⇒ 适配器必须真能收图，
     * 否则用户贴图后必然失败（**声明即承诺**）。
     *
     * ⚠️ **缺省时带图请求抛 `UNSUPPORTED_CONTENT`**（与 modelscope / opencode /
     *   loomy 同约定）：不静默丢图，否则用户以为模型看到了图。
     *   `src/index.ts` 必须注入，否则这条路径恒抛。
     */
    readImage?: (ref: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 目录加载完成通知。 */
    onCatalogLoaded?: () => void;
    /**
     * 告警出口（2026-10-18 审计 P0 新增，与 `astudio-adapter.ts` 同型）。
     *
     * ⚠️ 存在的理由是**丢弃思考档位必须留痕**：上游对非法档位回 200 并按最贵
     * 那档跑，若静默丢弃，用户付了 `max` 的钱却在 UI 上看到「未思考」——
     * 没有日志就等于把账算到模型头上。
     */
    warn?: (message: string) => void;
    /** 产品配置。 */
    product?: AutoclawProduct;
}
export declare class AutoclawAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly warnImpl;
    private announced;
    /**
     * 远端模型规格缓存（2026-10-17 审计 P1 修复）。
     *
     * ⚠️ **必须有**：修复前远端只在 `listModels` 里被读一次，而
     *   `resolveModel`（宿主每次请求前都调、也是**能力声明的唯一来源**）
     *   读的是编译期兜底表 ⇒ 远端值算出来就被丢掉。
     * ⚠️ 缓存失效判据用 **`undefined` 表示「已知无远端信息」** 而非「未取过」，
     *   避免远端挂掉时每次请求都重打一次（那会让上游限流）。
     */
    private remoteMeta;
    private remoteMetaFetched;
    private remoteMetaInFlight;
    constructor(options?: AutoclawAdapterOptions);
    private resolveCredential;
    private probeCredential;
    /**
     * 取远端模型规格（**带进程内缓存 + 在飞去重**）。
     *
     * ⚠️ 为什么必须缓存（2026-10-17 审计 P1 修复）：`resolveModel` 是宿主
     *   **每次请求前**都调的（能力声明的唯一来源），若每次都打远端 ⇒ 每轮会话
     *   多一个上游往返，且远端一限流就把全部请求拖慢。
     * ⚠️ 在飞去重是必需的：`resolveModel` 与 `listModels` 会被并发调用
     *   （宿主预热目录时），没有它就会同时打两个请求。
     */
    private loadRemoteMeta;
    /**
     * 把远端校正值套到兜底表的一条上（**只覆盖远端确实给了的字段**）。
     *
     * ⚠️ 拿不到远端信息时**原样返回兜底条目** —— 绝不编造数值（本仓库红线）。
     */
    private entryOf;
    get provider(): string;
    getProviderInfo(id: string): Promise<{
        id: string;
        name: string;
    }>;
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 拉取并解析远端模型规格（**失败/形状不认识一律返回 `undefined`**）。
     *
     * ⚠️ **永不抛错**：目录是只读展示面，远端挂掉不该让它整个失败 ——
     *   回落兜底表即可（与原实现的可用性一致）。
     */
    private fetchRemoteModelMeta;
    private announceLater;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 解析消息里的图片附件为 data URL（2026-10-17 审计 P0 修复新增）。
     *
     * ⚠️ **按模型判定，不是按 provider 一刀切**（原实现是 provider 级拒绝）：
     *   `zai_auto-fast` 的 `supportsImage: true` 有实测依据
     *   （`docs/autoclaw-models.md:42`），其余三个是纯文本 ⇒ 同一 provider 内
     *   **必须**存在两条通路。判据与 `resolveModel` 同源（`inputModalitiesOf`），
     *   杜绝「声明与实现各说一套」。
     *
     * ⚠️ **模型不支持图片时抛 `UNSUPPORTED_CONTENT`** 而不是静默丢弃 ——
     *   静默丢图会让用户以为模型看到了图（本仓库 Qoder 图片事故的教训）。
     *   ⚠️ 抛**带码**的 `LlmError`（原写法是裸 `Error` ⇒ 宿主归 `'UNKNOWN'`）。
     *
     * ⚠️ 附件字节读不出来时**不写入该条**：`serializeMessages` 遇到缺失会产出
     *   `[image unavailable]` 占位，至少让模型知道「这里本该有张图但没拿到」。
     */
    private resolveImageUrls;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
}
/**
 * 在 `ctx.llm` 上注册 AutoClaw provider 路由与适配器。
 */
export declare function registerAutoclawLlm(ctx: Context, options: AutoclawAdapterOptions): AutoclawAdapter;
//# sourceMappingURL=autoclaw-adapter.d.ts.map