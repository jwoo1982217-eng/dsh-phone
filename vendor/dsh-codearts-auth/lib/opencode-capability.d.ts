/**
 * OpenCode Zen 模型能力元数据（远端下发 + 磁盘缓存 + **非阻塞**读取）。
 *
 * ## 数据源：models.dev 的 `opencode` 条目
 *
 * `/zen/v1/models` **只返回 4 个字段**（`id` / `object` / `created` /
 * `owned_by`，实测 85 条全如此），**不含任何能力信息**。能力在 models.dev
 * （`https://models.dev/api.json` 的 `opencode` 键，实测 115 个模型），官方
 * CLI 自己就用它（`packages/core/src/models-dev.ts`）。
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `modalities.input` | 能力主源：`['text']` / `['text','image']` … |
 * | `cost.input` / `cost.output` | **免费判定的权威来源**（0 = 免费） |
 * | `limit.context` / `limit.output` | 上下文窗口与输出上限 |
 *
 * ## ⚠️⚠️ 为什么读取**必须非阻塞**（真机事故 2026-10-02）
 *
 * `https://models.dev/api.json` 实测 **5.05 MB / 首字节 720ms / 下载 1.4s**
 * （轻量端点 `api/v1/opencode.json` 返回的是 HTML 404 页，不可用）。
 *
 * 我最初在 `listModels` / `resolveModel` 里**直接 await** 这个拉取，于是
 * DSH 的模型选择器必须等 1.4s+ 才能拿到列表 → **点开是一片空白**，
 * 用户报障「选择模型还是点击没弹出列表」。
 *
 * ⇒ 三条硬约定（改动前先读）：
 * 1. **渲染路径上只能读同步缓存**，永不 await 网络；
 * 2. 磁盘缓存落 `$DSH_HOME/cache/opencode-capabilities.json`，冷启动直接命中；
 * 3. 拉取在**后台**进行，完成后广播 `llm/adapters-updated` 让 DSH 重读目录。
 *
 * 缓存拿不到时**保守回退纯文本**（声明支持就必须真支持），徽标与图片能力
 * 会在后台刷新后自动补上。
 */
/** 归一后的模型能力条目。 */
export interface OpencodeModelCapability {
    id: string;
    name: string;
    /** 输入模态（已归一到 DSH 支持的 text/image；video/audio/pdf 一律降级为 text）。 */
    modalities: readonly ('text' | 'image')[];
    /** 上下文窗口（0 = 未知，不编造）。 */
    contextWindow: number;
    /**
     * 模型单次输出上限（0 = 未知）。
     *
     * ⚠️ **刻意不下发给 DSH 的 `defaultMaxTokens`**（issue IKJJ68）。
     * 它是**上限**而非「合理的默认输出预算」：DSH 会在用户未指定 `max_tokens` 时
     * 直接拿它填请求，于是每轮都按上限走 —— 而 `space-bunny-free` 的上限是
     * **524288**、`nemotron-3-ultra-free` 是 128000，作为「默认」明显荒谬。
     *
     * ⚠️ 实测 2026-10-02 澄清了两件事（别再凭猜写这里的注释）：
     *   ① 给到这些值**不会被服务端拒绝**（big-pickle 32000 / nemotron 128000 /
     *      space-bunny 524288 全部 200）—— 「免费通道会拒」的说法**不成立**；
     *   ② **不给** `max_tokens` 时服务端用自己的默认值，实测 667 tokens 且
     *      `finish=stop`（自然结束，非截断）—— 现有「不下发」的行为就是好的。
     * 采下来是为了**留档**，以及将来按渠道实测出安全默认值。
     */
    maxOutputTokens: number;
    /** 是否支持思考推理（**仅表示「支持」**；档位见 {@link efforts}）。 */
    reasoning: boolean;
    /**
     * 思考档位 id（**原序**来自 models.dev 的 `reasoning_options`）。
     *
     * ⚠️ **空数组 = 不声明 `reasoning`**（选择器不出现），而不是「支持但无档位」。
     * 依据是 DSH 的渲染逻辑（`dsh-api-session-controller/lib/types/catalog.js`）：
     * `resolved.reasoning === undefined ? undefined : { efforts: … }` ——
     * 声明了空数组会让 UI 出现一个**没有任何档位**的空选择器。
     * （issue IKJJ0V）
     */
    efforts: readonly string[];
    /** 是否支持工具调用。 */
    toolCall: boolean;
    /**
     * 是否**免费**（`cost.input` 与 `cost.output` 同时为 0）。
     *
     * ⚠️ 这是免费判定的**权威来源**（Zen 匿名通道按此放行），
     * 不依赖本地硬编码表 —— 后者会在上游调整定价后静默失准。
     */
    isFree: boolean;
}
/**
 * 档位 id → 展示名（**无官方中文时回退到 id 本身**，不猜译名）。
 *
 * 导出给适配器用：`resolveModel()` 要给 `efforts[].name` 填中文，
 * 而客户端**直接渲染**该字段。
 */
export declare function opencodeEffortName(id: string): string;
/**
 * 后台刷新能力表（**永不阻塞**调用方）。
 *
 * @param onUpdated 刷新成功后的回调（接线层用它广播 `llm/adapters-updated`，
 *                  让 DSH 重读目录并按新能力重渲染）。
 * @param force 忽略 TTL 强制刷新（「刷新目录」按钮用）。
 */
export declare function refreshOpencodeCapabilities(onUpdated?: () => void, force?: boolean): void;
/**
 * **同步**读当前已知的能力表。
 *
 * ⚠️ 刻意**不是** async：调用方在渲染路径上（listModels / resolveModel），
 * await 网络会卡住模型选择器（真机事故）。
 *
 * ⚠️⚠️ 首次调用会**同步**读磁盘缓存（`readFileSync`，~19KB）—— 不是网络 IO，
 * 代价可忽略，却能保证 `resolveModel` 第一次被调用就拿到完整能力表。
 * 少了这一步，内核的 `prompt` 准入校验会读到 `inputModalities: ['text']`
 * 而拒绝图片（详见 {@link loadDiskCacheSync} 的事故记录）。
 */
export declare function getOpencodeCapabilitiesSync(): readonly OpencodeModelCapability[];
/** 首次调用：读磁盘缓存（非阻塞，fire-and-forget）。 */
export declare function primeOpencodeCapabilities(): void;
/** 清空内存与磁盘缓存（单测用）。 */
export declare function clearOpencodeCapabilitiesCache(): Promise<void>;
/** 某模型是否接受图片输入（未知模型按纯文本处理）。 */
export declare function supportsOpencodeImage(capability: OpencodeModelCapability | undefined): boolean;
//# sourceMappingURL=opencode-capability.d.ts.map