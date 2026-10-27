/**
 * OpenCode Zen 模型能力元数据（**读共享缓存**，不再自己直连）。
 *
 * ## 数据源：models.dev 的 `opencode` 条目，**经共享本地缓存**
 *
 * `/zen/v1/models` **只返回 4 个字段**（`id` / `object` / `created` /
 * `owned_by`，实测 85 条全如此），**不含任何能力信息**。能力在 models.dev
 * （`https://models.dev/api.json` 的 `opencode` 键，实测 127 个模型），官方
 * CLI 自己就用它（`packages/core/src/models-dev.ts`）。
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `modalities.input` | 能力主源：`['text']` / `['text','image']` … |
 * | `cost.input` / `cost.output` | **免费判定的权威来源**（0 = 免费） |
 * | `limit.context` / `limit.output` | 上下文窗口与输出上限 |
 * | `reasoning_options` | 思考档位（见 {@link OpencodeModelCapability.efforts}） |
 * | **`provider.api`** | **协议可达性**（见下方「为什么必须采它」） |
 *
 * ## ⚠️⚠️ 读取路径：只读共享缓存，**永不**自己 fetch（用户 2026-10-17）
 *
 * 本模块改前**自己** `fetch('https://models.dev/api.json')`，并维护独立的
 * TTL / 在飞去重 / 磁盘缓存（与 `cline-models-dev.ts` 各一套，那是本仓库
 * 明令禁止的「一文件两套同义判据」形态）。那份数据**解压后 ~5 MB**、实测
 * 「要么 ~2 秒、要么整段挂死」，而本仓库已有一次真机事故：渲染路径上 await
 * 这个拉取 ⇒ **模型选择器一直空白**（2026-10-02）。
 *
 * ⇒ 现在一切取数都走 `src/models-dev-cache.ts`：**本模块不再持有 URL，
 * 也不发起任何请求**；`readProviderModelsSync()` 只做 `readFileSync`。
 * 「全仓唯一直读点」由 `tests/unit/models-dev-cache.spec.ts` 的扫描用例守住。
 *
 * ## ⚠️ 为什么必须采 `provider.api`（Issue IKM9LR 的根因）
 *
 * 改前 `opencode-product.ts` 的 `OPENCODE_FALLBACK_MODELS` 兜底表**同时**当
 * 「网络失败的兜底目录」与「协议可达性白名单」两个职责，而后者是硬编码的
 * ⇒ Zen 新上线的模型（issue 里的 `deepseek-v4.1-flash-free` /
 * `glm-5.3-flash-free`）**远端 `/v1/models` 明明下发了，却被本地表挡掉**，
 * 用户在选择器里根本看不到（症状与「上游没这模型」完全同形）。
 *
 * models.dev 的 `provider.api` 正是**协议端点**的权威字段。实测按它分组与
 * 「我们实现了哪些协议」逐格吻合（`openai/v1` 56 条 / `anthropic/v1` 17 条 /
 * `google/v1beta` 8 条 / 无条目 4 条），且改前的 14 条兜底表条目**全部**落在
 * `openai/v1` 内、零反例。
 *
 * ⚠️ 它**不能**替代的三样（目录层无从预知，只能靠运行时错误分类兜）：
 * ① 地域封锁（`beam-free` 的 api 就是 openai/v1，实测 403 RegionError）；
 * ② 上游不稳定（`glm-5.3-flash-free` 约 2/5 概率 429）；
 * ③ 废弃（`mimo-v2.5-free` 回 410，但只要远端还下发，目录层就挡不住）。
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
    /**
     * ⚠️ **协议可达性**（issue IKM9LR）：该模型是否走本插件实现的
     * OpenAI-chat 协议（`provider.api` 指向 {@link OPENCODE_CHAT_PROTOCOL_API}）。
     *
     * `undefined` = **不知道**（条目缺 `provider.api`，实测 `jev-1.13-free`
     * 连 models.dev 条目都没有）⇒ 调用方**不得**据此判不可达 ——
     * 那是本仓库反复踩过的「把没读到说成不支持」。
     */
    chatProtocol: boolean | undefined;
}
/**
 * 档位 id → 展示名（**无官方中文时回退到 id 本身**，不猜译名）。
 *
 * 导出给适配器用：`resolveModel()` 要给 `efforts[].name` 填中文，
 * 而客户端**直接渲染**该字段。
 */
export declare function opencodeEffortName(id: string): string;
/**
 * **同步**读当前已知的能力表（渲染路径唯一入口）。
 *
 * ⚠️ 刻意**不是** async：调用方在渲染路径上（listModels / resolveModel），
 * await 网络会卡住模型选择器（真机事故 2026-10-02）。
 *
 * ⚠️⚠️ 冷启动首次调用会**同步**读共享缓存文件（`readFileSync`）—— 不是网络 IO，
 * 代价可忽略，却能保证 `resolveModel` 第一次被调用就拿到完整能力表。
 * 少了这一步，内核的 `prompt` 准入校验会读到 `inputModalities: ['text']`
 * 而拒绝图片（2026-10-02 的事故，见 `models-dev-cache.ts` 的同款记录）。
 */
export declare function getOpencodeCapabilitiesSync(): readonly OpencodeModelCapability[];
/**
 * 作废归一缓存（外部刷新了共享缓存时调用）。
 *
 * ⚠️ **必须真的作废**：归一是按「共享缓存里 provider 块的对象身份」记忆化的，
 * 而成功刷新会**整体换掉**那块对象 —— 所以正常路径靠身份变化自动失效。
 * 但显式作废是**第二道防线**：万一将来缓存改成增量更新（复用同一个对象），
 * 身份判据就会静默失效，症状是「改了没用，重启才好」。
 */
export declare function invalidateOpencodeCapabilities(): void;
/**
 * 启动期预热（**保持旧签名**以免改动接线层语义）。
 *
 * ⚠️ 现在它**只**触发共享缓存的后台刷新，自身不再读任何文件
 * —— 同步读已在 `readNormalized()` 里做掉了。多一条 async 读链只会让
 * 「是否读到缓存」出现两个判据（本仓库红线：同一语义两套判据）。
 */
export declare function primeOpencodeCapabilities(): void;
/**
 * 后台刷新能力表（**保持旧签名**以免改动接线层语义）。
 *
 * ⚠️ 实际动作发生在共享缓存里；本函数只把 `onUpdated` 转交给它。
 * 保留这一层是因为**广播时机**是本渠道的事（能力表一变就要让客户端重读目录），
 * 而拉取细节已不该由本模块掌握。
 */
export declare function refreshOpencodeCapabilities(onUpdated?: () => void, force?: boolean, warn?: (message: string) => void): void;
/** 清空内存与磁盘缓存（单测用）。 */
export declare function clearOpencodeCapabilitiesCache(): Promise<void>;
/** 某模型是否接受图片输入（未知模型按纯文本处理）。 */
export declare function supportsOpencodeImage(capability: OpencodeModelCapability | undefined): boolean;
/**
 * ⚠️ 该模型是否走**本插件实现的** chat 协议（issue IKM9LR）。
 *
 * ## 判据口径（三格，缺一不可）
 *
 * | 能力表 | 结论 |
 * |---|---|
 * | `chatProtocol === true` | **可达** |
 * | `chatProtocol === false` | **不可达**（`provider.api` 指向 anthropic/google 等未实现的协议） |
 * | **条目不存在**（`undefined`） | **不知道** ⇒ 交给调用方按本地兜底表决定 |
 *
 * ⚠️ 第三格是刻意的：`jev-1.13-free` 连 models.dev 条目都没有，而实测它回
 * `400 ModelProtocolUnsupported` —— 但「这条实测结论」只属于**那个模型**，
 * 不能推广成「无条目的都不可达」。判成不可达会让未来新上线的模型凭空消失。
 */
export declare function isOpencodeChatReachable(id: string): boolean | undefined;
//# sourceMappingURL=opencode-capability.d.ts.map