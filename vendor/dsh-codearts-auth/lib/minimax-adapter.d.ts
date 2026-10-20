/**
 * MiniMax Code 模型适配器。
 *
 * ## 推理已实现（2026-09-29，真实请求验证）
 *
 * 走 **Anthropic Messages** 协议（`POST {apiHost}/mavis/api/v1/llm/v1/messages`），
 * 请求体构造与 SSE 消费在 `src/minimax-messages.ts`。
 *
 * 实测（4 个模型全部 HTTP 200，文本 / 思考 / 工具调用均正常）：
 * - `MiniMax-M3.1-Flash-Preview`：**必须** `thinking.type='adaptive'`，
 *   档位走 `output_config.effort`；传 `disabled` ⇒ `400 ... (2013)`。
 * - `M3` / `M2.7` / `M2.7-highspeed`：**不发 thinking 即接受**，
 *   且服务端默认会思考（M2.7 实测 `thinking_tokens: 250`）。
 *
 * ## 两个必须记住的口径
 *
 * 1. **窗口取档位表最大档**：`MiniMax-M3.1-Flash-Preview` 的 `limit.context`
 *    是 512000，但 `context_window_options` 是 `[512000, 1000000]`。
 *    填 512K 会让 DSH 远早于官方能力触发压缩（与 Qoder 同口径）。
 * 2. **只有 M3.1-Flash-Preview 有档位**：其余三个远端没有 `effort_options`。
 *    给它们编档位就是凭空猜测（Qoder 同型教训）。
 *
 * ## ⚠️ 未实现：图片
 *
 * `MiniMax-M3.1` / `M3` 的目录条目声明支持图片（`supportsImage: true`，
 * 用于 `inputModalities` 播报），但**带图请求未实测**，
 * 故 `serializeMinimaxMessages` 遇到 image 块**显式抛错**（不静默丢弃）。
 * 静默丢弃会让用户以为图片被模型看到了。
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AccountPool } from './account-pool.js';
import { type MinimaxProduct } from './minimax-product.js';
import { type MinimaxCredential, type MinimaxModelEntry } from './minimax.js';
/**
 * 由模型条目构造 DSH 的思考档位声明。
 *
 * ⚠️ 返回 `undefined` 表示**不声明** `reasoning` —— DSH 的档位选择器会显示
 * 「当前模型未提供推理等级」（对应官方 IDE 的「不支持」）。
 *
 * ## ⚠️ 两种能力都要表达（2026-09-29 补的真实缺口）
 *
 * 远端 `thinking_config.mode` 实测三种值，**语义完全不同**：
 *
 * | 模型 | `mode` | `effort_options` | 实测行为 |
 * |---|---|---|---|
 * | M3.1-Flash-Preview | `forced_on` | ✅ 6 档 | 传 `disabled` **硬 400**（2013） |
 * | **M3** | **`switchable`** | ❌ 无 | 不传/`disabled` → **0 思考块**；`adaptive` → 有 |
 * | M2.7 / M2.7-highspeed | `forced_on` | ❌ 无 | 传 `disabled` **静默忽略**（仍有思考） |
 *
 * ⚠️ **初版只看了 `effort_options`，于是 M3 被声明成「无推理等级」**
 * —— 而它**实际可以开关思考**（真机实测）。那是**功能缺失**：
 * 用户在 UI 上无法为 M3 关闭思考。
 *
 * 修法（照 Qoder `qoderEffortsFor` 的既有口径）：
 * - `efforts` 取远端 `effort_options`（只有 M3.1 有）；
 * - `thinkingMode === 'switchable'` 时**追加 `none`**（= 「关闭思考」档）
 *   —— DSH 的 `LlmModelReasoningInfo` **没有** `supportsDisable` 字段，
 *   「可关闭」就是靠 `efforts` 里出现 `none` 表达的；
 * - 两者皆无 ⇒ `undefined`（不声明）。
 *
 * ⚠️ `forced_on` 的模型**绝不**追加 `none`：M3.1 会硬 400，
 * M2.7 会被静默忽略（那会让用户以为关掉了、实际没关 —— 比不给选项更糟）。
 *
 * 修法（照客户端 `thinking.js` 的**权威词汇**）：
 * - `efforts` 取远端 `effort_options`（只有 M3.1 有）；
 * - `thinkingMode === 'switchable'` 时给出**开/关两态**：
 *   `on`（→ `thinking:{type:'adaptive'}`）与 `none`（→ `{type:'disabled'}`）。
 *   ⚠️ 客户端用的就是 `on` / `off` 这两个词
 *   （`isMiniMaxM3ThinkingMode`：`value === 'on' || value === 'off'`），
 *   `off` 在 DSH 侧的惯用名是 `none`（Qoder 的「关闭思考」也用 `none`）；
 * - 两者皆无 ⇒ `undefined`（不声明）。
 *
 * ⚠️⚠️ **必须给 `on`，不能只给 `none`**（我第一版就只给了 `none`）：
 * 实测 M3 **不发 `thinking` 时默认「不思考」**（两轮各 0 字符），
 * 而 `adaptive` 有 **2785 / 2797** 字符。若只声明 `none`，用户**只能关、无法开**
 * —— 那比不给选项更糟（把模型的强项藏起来了）。
 *
 * ⚠️ `forced_on` 的模型**绝不**追加任何开关：M3.1 会硬 400，
 * M2.7 会被静默忽略（那会让用户以为关掉了、实际没关）。
 *
 * ⚠️ **展示名**：远端档位用原文字面量（官方 IDE 就是 `default` / `low` / …），
 * 但 `on` / `none` 是我们**追加**的（远端没有这两个名字），给中文名
 * 「开启思考」/「关闭思考」以免用户看不懂。
 */
export declare function minimaxReasoningInfo(entry: MinimaxModelEntry): LlmModelReasoningInfo | undefined;
/** {@link MinimaxAdapter} 的构造选项。 */
export interface MinimaxAdapterOptions {
    /** 单凭据回退 ref（无账号池时）。 */
    credentialRef: CredentialRef;
    /** 解析当前可用凭据。 */
    resolveCredential: (modelId?: string) => Promise<MinimaxCredential | undefined>;
    /** 凭据失效时的处理。 */
    refresh: () => Promise<void>;
    /** 拉取远端模型目录；失败时适配器回退兜底表。 */
    fetchRemoteModels?: () => Promise<readonly MinimaxModelEntry[]>;
    /** 账号池（目录门控与黑名单）。 */
    accountPool?: AccountPool;
    /**
     * 内联一张图片为**裸 base64**（由调用方桥接 `ctx.attachments.readImage`）。
     *
     * ⚠️ 未提供时收到图片会**报错**而不是静默丢图 —— 静默丢图会让用户以为
     * 图片被模型看到了（与 cline / lobsterai 的既有契约一致）。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link MINIMAX}。 */
    product?: MinimaxProduct;
}
/** MiniMax Code 模型适配器。 */
export declare class MinimaxAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private remoteModels;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
    private readonly catalogGate;
    constructor(options: MinimaxAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
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
    /**
     * 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。
     *
     * ⚠️ **必须同步返回数组，不能是 `async`**（真实缺陷，2026-09-29 修正）。
     *
     * 本插件 8 个既有适配器的 `listAllModels()` 全是同步返回 `readonly {...}[]`
     * （见 `llm-adapter.ts:789`、`raccoon-adapter.ts:229` 等），
     * `jet-hub-rpc.ts` 的接口（`:587` / `:641` 的 `ModelCatalogSource`）也是同步，
     * 且两处消费者**都不 await**：
     * - `:2041` `catalog = [...all]`
     * - `:2125` `ids = all.map((model) => model.id)`
     *
     * 早期这里写成 `async`，返回的是 Promise —— Promise **不是** `undefined`，
     * 故两处都会走进 `all !== undefined` 分支并抛
     * `TypeError: all is not iterable` / `TypeError: all.map is not a function`
     * ⇒「显示列表」与「关闭全部」两个功能同时崩。
     *
     * 当时未被发现，是因为 minimax 尚未接入 `src/index.ts` 的 `modelAdapters`
     * （无调用方），一旦接线即爆发。
     *
     * ⚠️ 读缓存而非 `await loadModels()` 是**正确**的：RPC 路径在调用本方法**之前**
     * 已先 `await llm.listModels(provider)`（`jet-hub-rpc.ts:2011`），
     * 而 `listModels` 内部会 `await this.loadModels()` 落缓存。
     * 与 `raccoon-adapter.ts:229-232` 逐字同构。
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
    /**
     * 走 **Anthropic Messages** 协议发一次流式请求。
     *
     * ⚠️ 凭据过期先静默续期一次（与其余九个适配器同款）。
     *
     * ⚠️ **错误必须抛错**，不静默返回空流（Qoder 早期同型缺陷）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** 在 `ctx.llm` 上注册 minimax provider 路由与适配器。 */
export declare function registerMinimaxLlm(ctx: Context, options: MinimaxAdapterOptions): MinimaxAdapter;
//# sourceMappingURL=minimax-adapter.d.ts.map