/**
 * Jet Hub「自动」适配器 —— 一个模型名用整池，按临期优先。
 *
 * ## 它解决什么
 *
 * 对标 OmniRoute 的 `auto`：模型选择器里只挂一个 `jet-hub-auto/auto`，请求进来时现场
 * 从多个 provider 的账号池里挑「积分最快作废」的那个 provider 发出去。临期的先烧、
 * 长期的留着 —— 这正是用户要的「当天/临期过期的优先使用」。
 *
 * ## 为什么只选 provider、不选账号
 *
 * 每个 provider 的适配器**自己**就会按临期/限流在它的账号间轮转（buddy/loomy 走
 * `*-balance-selector`，其余走 `getAvailableAccount` + 429 换号）。auto 若再替它们
 * 选账号，等于把同一件事做两遍、还要往账号池里塞「强制账号」的旁路（易与手动顺序、
 * 永久积分锁定打架）。所以 auto 只做**跨 provider** 的那一层：谁最快作废用谁。
 *
 * ## 临期判据（每个 provider 折算成一个「最早失效时刻」，升序取最小）
 *
 * | provider | 有可用余额时的失效时刻 |
 * |---|---|
 * | codearts | **`Infinity`（长期）** —— 接口不下发到期时间，见下 |
 * | loomy | 有今日赠送 → 当日 24:00；只剩永久 → Infinity |
 * | zcode | 各桶 `expiresAt` 的最小值；无桶但有可领 → 当日 24:00 |
 * | buddy / workbuddy | 有效资源包 `deductionEndTime` 的最小值 |
 *
 * ⚠️⚠️ **codearts 一栏已从「当日额度，UTC+8 当日 24:00」改为「长期（Infinity）」**
 * （2026-10-07，用户报障）。旧口径是**臆造**：实测 `statistics/plugin` 对资源包的
 * `cycleStartTime` / `cycleEndTime` / `expiredTime` **三个字段全为空**
 *（`codearts-credits.ts` 的注释也写明「不下发……不臆造一个到期时间」），
 * 而官方文档说的是签到积分「自发放起 30 天内有效」—— 两者都不是「今天 24:00」。
 * 后果是 codearts 在排序里**永远排最前**，抢走真正临期的额度。
 * 详见 `aggregate-expiry.ts` 的 `codeArtsExpiry` 注释。
 *
 * 只有永久/长期积分的 provider 折算成 `Infinity`（排最后，但不剔除 —— 没有临期号时
 * 仍要用它）。查询失败 / 无启用账号的 provider 折算成 `-1`（**剔除**，不参与排序）。
 *
 * ## 缓存与失效
 *
 * 一次「选 provider」的结果缓存 {@link AUTO_CHOICE_TTL_MS}（默认 60 秒，与既有余额
 * 缓存同量级）：跨 provider 的余额探测有网络成本，每分钟一次足够。⚠️ 这不破坏
 * 「临期优先」的语义 —— 一分钟内积分不会凭空作废；而 provider **内部**换号不受本
 * 缓存影响（那是各适配器每次请求现做的）。
 *
 * @module src/auto-adapter.ts
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountPool } from './account-pool.js';
export { pickSoonestProvider, priceFactorFromName } from './aggregate-core.js';
import { createExpiryProbe } from './aggregate-expiry.js';
/** 注册到 ctx.llm 的 provider 路由，也是 providerInfo().id（DSH 校验二者相等）。 */
export declare const AUTO_PROVIDER = "jet-hub-auto";
/** 对外的唯一模型名。 */
export declare const AUTO_MODEL = "auto";
/** 一次跨 provider 选型的缓存时长（毫秒）。 */
export declare const AUTO_CHOICE_TTL_MS = 60000;
/**
 * v1 接入的 provider（顺序即「并列最早失效时」的兜底优先级）。
 *
 * 其余 provider（qoder / trae / cline / …）结构上留好接口但不接入：它们没有跨账号
 * 的到期余额探测端点，接进来只能算成 Infinity 永远垫底，不如先不放。
 */
export declare const AUTO_PROVIDERS: readonly ["codearts", "loomy", "zcode", "buddy", "workbuddy"];
/** 一次选型的结果：目标 provider + 目标模型 id。 */
interface AutoChoice {
    provider: string;
    model: string;
}
export interface AutoAdapterOptions {
    accountPool: AccountPool;
    /** 注入的当前时刻（测试用）。 */
    now?: () => number;
    /** 选型缓存时长（测试用）。 */
    ttlMs?: number;
    /**
     * 临期折算的缓存时长（测试用）。
     *
     * ⚠️ 既有单测依赖「每次调用都真探」的语义（它们断言 `getAvailableAccount` 的
     * 调用次数），故那里传 `0` 关掉缓存。**生产不传** ⇒ 用默认
     * `EXPIRY_CACHE_TTL_MS`（60 秒）。
     */
    expiryTtlMs?: number;
    /**
     * **共享**的临期探针（装配层建一个，aggregate 与 auto 共用）。
     *
     * ## ⚠️ 为什么需要它（真实缺陷，对抗审计实测证伪）
     *
     * 初版 `AutoAdapter` 内部**自己建一个** probe，而 `index.ts` 又为 aggregate
     * 建了**另一个** ⇒ 两份独立缓存：① 同一渠道被折算两次（白打两次上游）；
     * ② 缓存失效要清两次，漏一次就让「刚登录的账号最长 60 秒对路由不可见」。
     *
     * ⚠️ 不传时仍自建（保持既有单测/独立使用可用）。
     */
    expiryProbe?: ReturnType<typeof createExpiryProbe>;
}
/** Jet Hub 自动适配器。 */
export declare class AutoAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /** 缓存的一次选型结果（含计算时刻）。 */
    private cached;
    /** 缓存的「auto 借用目标能力」的元数据（与 choice 同生命周期）。 */
    private cachedInfo;
    /**
     * 惰性建的临期探针（**复用同一实例** ⇒ 折算缓存跨调用生效）。
     *
     * ⚠️ 旧实现在 `expiryOf` 里每次新建 ⇒ 缓存永不命中 ⇒ 每次请求都重打上游。
     */
    private expiryProbeInstance;
    constructor(ctx: Context, options: AutoAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /** 目录里永远只有一个 auto（真实模型由选型决定，不在此暴露）。 */
    listModels(): Promise<readonly LlmModelInfo[]>;
    /**
     * 解析 `auto` 的能力元数据。
     *
     * 尽量借用「当前选型目标」的真实 context / 档位（让 harness 的请求校验贴近实际），
     * 但**身份必须改回 auto**：DSH 的 `normalizeModelInfo` 会拒掉 provider/id 与请求
     * 路由不符的元数据。选型不可用时退回到一份保守的通用元数据（不声明档位，任何
     * reasoningEffort 都会被 harness 判为不支持 —— 故这里连 reasoning 字段都不带）。
     */
    resolveModel(): Promise<LlmResolvedModelInfo>;
    /**
     * 绑定「一次选型」到本次分发。
     *
     * 返回的 `stream` 闭包把请求改写为目标 provider/model 后交给 `ctx.llm.stream` ——
     * 走公开路径，目标适配器照常做它自己的选号 / 限流换号 / 续期。
     *
     * ## 图片感知选型（真实缺陷修复：为什么不能只用 ensureChoice 的缓存）
     *
     * 对外 auto 声明支持图片（整池里有能看图的 provider，声明纯文本会让宿主在
     * **进入请求前**就拒绝带图消息 ——「当前模型不支持图片」正是这样来的）。
     * 但**临期胜者不一定能看图**（如 codearts 的模型全是纯文本）。故这里在分发时
     * 检查本次消息是否真的带图：带图而胜者不支持 → 改发「支持图片的 provider 里
     * 临期最早」的那个。无图请求完全不受影响，仍走 60 秒缓存。
     *
     * ⚠️ 覆盖目标用 `llm.stream`（公开路径）而非「再挑一个模型直接发给它的适配器」：
     * 只有走公开路径，目标适配器的选号 / 续期 / 限流换号才全部照常生效。
     */
    prepareCall(_provider: string, _model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 解析一个转发目标：**连同该模型声明的思考档位**。
     *
     * 档位必须在这里取（而非分发时）—— `stream` 闭包是同步的，而取档位要
     * `await resolveModelInfo`。解析失败按「无档位」处理（转发时不下发该字段），
     * 不影响其余能力。
     */
    private dispatchTargetOf;
    /**
     * 按目标 provider 转发一次请求，**先翻译思考档位**。
     *
     * ## 为什么要翻译（真实缺陷，用户报障 2026-10-05）
     *
     * auto 借用的 `reasoning.efforts` 来自**本次选中的目标模型**（如 zcode 的
     * `low` / `high` / `max`），但请求里的 `reasoningEffort` 是 harness 依据
     * **上一次对话**留下的值，可能带着**别的模型族**的档位名（如 TRAE 的
     * `xhigh`、LobsterAI 的 `light`）。原样转发会被 DSH 按 id 严格校验拦下：
     *
     * ```
     * provider "zcode" model "GLM-5.3-Flash" does not support reasoning effort "xhigh"
     *   UNSUPPORTED_REASONING_EFFORT
     * ```
     *
     * 改道（带图）或换号后同理 —— 目标换了，档位语义也就跟着变。
     *
     * 修法复用仓库既有的 {@link translateReasoningEffort}（本网关
     * `openai-gateway/messages.ts` 一直在用同一套口径）：
     * - `exact` → 原样下发；
     * - `mapped` → 就近落到目标声明的同族档位（**同距取更强**，与仓库口径一致）
     *   并记一条 warn —— 这是「静默降级」与「静默改语义」之间唯一的区别；
     * - `unexpressible` → 目标根本没这一族（如要 `off` 而它只声明 `high`）→ **不
     *   下发**该字段（让上游走它自己的默认），而不是硬塞一个错的；
     * - `unknown` → 请求值是未登记的怪名字，**删掉该字段**并 warn：让上游按默认
     *   走，比抛错打断整轮对话更可取（用户改个档位不该让整个任务失败）。
     */
    private dispatch;
    /**
     * 该 provider 的目录里是否存在**未被彻底关闭**且支持图片的模型。
     *
     * 读各适配器 `listModels()` 播报的 `inputModalities`（它内部已应用隐藏/关闭表），
     * 不看账号余额 —— 余额是 {@link expiryOf} 的事，这里只回答「能不能收图」。
     */
    private providerSupportsImages;
    /** auto 从不直接被 stream（总是先经 prepareCall）；兜底抛错而非静默。 */
    stream(): AsyncIterable<StreamChunk>;
    /**
     * 取选型（命中缓存直接回；否则重新探测全池）。
     *
     * 与 {@link resolveModel} / {@link prepareCall} 共用同一份缓存，保证「本轮能力」与
     * 「本轮实际发往的 provider」出自同一次决策 —— 分裂会让 harness 用 A 的能力校验、
     * 却发往 B。
     */
    private ensureChoice;
    /**
     * 探测各 provider 的最早失效时刻并选出胜者。
     *
     * ⚠️ `modelOf` 是「该 provider 能否**实际被调用**」的判据（PR !69 审计实测）：
     * 一个 provider 余额充足、但目录为空或模型被用户全关时，仍**不能**当选 ——
     * 初版会让它拿到请求再发出一个必然 404 的模型 id。故排序时就把这类 provider
     * 当作 `UNUSABLE` 剔除，顺位让给下一个候选（而不是整体放弃 auto）。
     */
    selectProvider(signal?: AbortSignal, modelOf?: (provider: string) => Promise<string | undefined>): Promise<AutoChoice | undefined>;
    /**
     * 某 provider「一个代表账号」的最早失效时刻（毫秒）。
     *
     * ⚠️ 本方法现在**委托** `createExpiryProbe`（`aggregate-expiry.ts`）—— 折算口径
     * 的**唯一权威**在那里，本处只提供 auto 的取号方式（`firstModelOf`）。
     * 早期这里是独立实现，与聚合层的探针构成两份同义逻辑；Task 7 已合并。
     *
     * 取一个启用账号做代表：它同时确认了「这个 provider 现在有没有可用账号」
     * （取不到即 UNUSABLE）。⚠️ 探测的是代表账号的余额，provider 内部换号由各适配器
     * 每次请求现做，不依赖这里。
     *
     * ⚠️⚠️ **必须带真实 modelId 取号，不能传空串**（真实缺陷，PR !69 审计实测）：
     * `getAvailableAccount` 对空 modelId 直接 `return true` 跳过限流过滤
     * （`account-pool.ts:1049-1055`），而候选顺序就是**用户的手动顺序**
     * （`:1057`）⇒ 空串取回的是「手动序第一个启用账号」，**哪怕它此刻正在限流**。
     * 本仓库在 `index.ts:598-600` 已为同一坑留下过成文警告，这里是同一个缺陷的第二实例。
     *
     * 后果是多账号池的真实场景：手动序第一个号额度已烧完（折算 `NEVER`）、第二个号还有
     * 9 天后作废的额度 ⇒ auto 只看到第一个号 ⇒ 该 provider 被判成「无临期」而排到最后，
     * **临期额度被完全忽略**，与「临期优先」的价值主张相反。
     *
     * ⇒ 委托时把 `firstModelOf` 传进去（它内部先从目录拿一个真实 modelId），
     * 让限流过滤真正生效。
     */
    expiryOf(provider: string, signal?: AbortSignal): Promise<number>;
    /**
     * 目标 provider 里选一个**未被彻底关闭**的模型 —— **同 provider 内按倍率升序**
     * （限时折扣 / 免费优先），倍率解析自目录展示名（`Space-Bunny · x0.03` 这类，
     * 各 provider 的目录名都带；带「免费」按 0 算）。没有倍率标注的模型视为
     * `Infinity`，排在任何有标注的之后。
     *
     * ## 返回 `undefined` 的含义（真实缺陷修复，PR !69 审计实测）
     *
     * `undefined` = **该 provider 目录里没有可调用的模型**（目录为空 / 读取失败 /
     * 用户把模型全关了）。调用方必须把该 provider **退出候选**，绝不能发请求。
     *
     * ⚠️ 初版在这里回落到硬编码 `AUTO_FALLBACK_MODELS[provider]`，而触发回落的前提
     * 恰恰是「目录为空或**全被关闭**」—— 此时那个 id 正是用户明确关掉的模型。
     * 实测（真实链路探针）：用户关掉 zcode 全部模型后，auto 仍选中 zcode 并发出
     * **`zcode/auto`**（字符串 `'auto'` 被当成 zcode 的模型名）⇒ 必然 404，且请求
     * 打到了一个用户已禁用的 provider。这违反本文件自己的注释「关闭即不可调用」。
     *
     * ## 为什么按倍率选（真实缺陷，用户报障 2026-10-05）
     *
     * 原实现取目录第一个 —— CodeBuddy 目录首个是 `hy4-preview`（x0.29），而同池的
     * `Space-Bunny` 正在限时折扣（x0.03）。大任务跑了前者，等于同样的活多花约十倍
     * 积分。auto 既然定位是「省钱烧临期」，同 provider 内当然该挑最便宜的。
     *
     * ⚠️ 必须跳过被关闭的模型（`disabledModelsFor`）—— 关闭即「不可调用」，
     * auto 不能把请求路由过去。
     */
    firstModelOf(provider: string): Promise<string | undefined>;
}
/** 在 ctx.llm 上注册 auto 路由（幂等，见 `llm-register-compat.ts`）。 */
export declare function registerAutoLlm(ctx: Context, options: AutoAdapterOptions): AutoAdapter;
/**
 * 「auto 现在会选谁」——按临期判据算出当前胜者（供用量徽标等外部消费）。
 *
 * ⚠️ 与 {@link AutoAdapter.selectProvider} 是**同一套判据**（每个 provider 用
 * `getAvailableAccount` 确认可用性 + 各家余额端点折算最早失效时刻），但走的是
 * **独立实例**：徽标轮询不该与选型缓存互相踩（选型有 60 秒缓存且随请求刷新，
 * 徽标是 60 秒轮询、隐藏页跳过 —— 两者的节奏本来就该解耦）。
 *
 * ## ⚠️⚠️ 聚合 provider 的用量徽标**不用本函数**（2026-10-07 定，规格 §6.5）
 *
 * 本函数是**预测**语义（预检余额、算临期胜者），且**有自己的网络成本**。
 * 而聚合徽标取的是**真实历史** —— `AggregateAdapter` 在**实际转发成功时**记下的
 * 渠道（`activeProvider()`，纯内存读）。两者在以下情况会**不一致**：
 * 预测的胜者可能因上游失败而被切换掉，于是「预测的渠道」与「实际用的渠道」不同。
 * 用户明确选择了真实历史（显示一个错的渠道比不显示更误导）。
 *
 * ⇒ 全仓**零调用方**是本函数的现状，**保留它是有意的**（不删，避免越界改动
 * PR !69 的成果）。若要给聚合徽标接线，用 `aggregate.activeProvider`，
 * **不要**改成调本函数。
 */
export declare function pickCurrentAutoProvider(ctx: Context, options: AutoAdapterOptions): Promise<string | undefined>;
//# sourceMappingURL=auto-adapter.d.ts.map