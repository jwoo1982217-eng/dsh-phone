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
    /**
     * 「目标收下请求却零输出」的目标级冷却表（issue IKJW31 的 B 方案）。
     *
     * ⚠️ **纯内存、进程内、不落盘**：它优化的是「本次运行内别再三连撞同一堵墙」，
     * 重启后重新试探是**正确**行为 —— 用户可能已升级插件、上游可能已扩容，
     * 落盘只会让一次误判跨重启生效。
     * ⚠️ 语义与账号池的 `modelRateLimits` **不同**：那些记在**账号**上，本表记在
     * **目标**（provider + model）上 —— 越墙换账号无用（账号无关），换目标才有用。
     */
    private zeroOutputCooldowns;
    constructor(ctx: Context, options: AutoAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 最近一次**实际发出**的目标（含带图改道）；未发过任何请求时为 `undefined`。
     *
     * ⚠️ 上游 `ba10f4f` 重写 aggregate 时把本字段与 {@link lastExpiryAt} 一并删掉了，
     * 于是 `usage.badge` 对 `jet-hub-auto` 的改写逻辑（宿主端）失去数据来源、
     * 整块被删 ⇒ **旧 auto 的用量徽标彻底消失**（用户报障 2026-10-08：「也没胶囊了？」）。
     * 这里补回来。消费方是 `jet-hub-rpc.ts` 的 `usage.badge`（经 `autoAdapter` 注入）。
     */
    private lastDispatch;
    /** 最近一次选型胜者的失效时刻（毫秒）—— 徽标的临期倒计时用。 */
    private lastExpiryAt;
    /**
     * 「渠道 + 模型 → 倍率」的临时表 —— 由 {@link firstModelOf} 在**已经算过**倍率的
     * 那一轮目录循环里顺带写入（零额外请求）。
     *
     * ## ⚠️ 为什么要有它（用户报障 2026-10-08「没倍率显示？」）
     *
     * auto 是**跨渠道**的单一模型名，它自己没有倍率：倍率取决于**本次选中谁**。
     * 而模型选择器显示的是 `listModels` 的**静态**名字（对所有请求都一样），
     * 往那里写死一个倍率就是**编造**（`buddy.ts:494` 的既有判据：编造倍率比不显示更糟）。
     * ⇒ 倍率只能显示在**胶囊**里（那里显示的正是「这次实际用了谁」），
     *   而胶囊的数据来自 `lastDispatch`，故倍率必须在分发时可得。
     *
     * ## 为什么用表而不是在分发时重查目录
     *
     * `firstModelOf` 已经为了「挑最便宜的模型」把整个目录读了一遍并算出了倍率
     *（`priceFactorFromName`）；重查一次等于**再打一轮上游目录接口**，纯粹浪费。
     *
     * ⚠️ 只做缓存用途，**不参与任何选型判据**（选型只看 `price` 的排序结果，
     *   见 `firstModelOf` 的 `best`）。表项无上限问题：键是「渠道 + 模型」，
     *   而渠道数与模型数都是目录级的小常量。
     */
    private readonly priceByModel;
    /** 记下某渠道某模型的倍率（键含渠道，避免同名模型跨渠道串价）。 */
    private rememberPrice;
    /**
     * 查已记下的倍率；查不到回 `undefined`（**不猜、不重查**）。
     *
     * ⚠️ 查不到是**正常**情形：宿主刚重启、还没走过选型时表是空的。
     *    调用方（`usage.badge`）必须能接受「没有倍率」而不是显示一个编造的值。
     */
    priceOf(provider: string, model: string): number | undefined;
    /**
     * 交给 RPC 层的**自包含状态入口**（`usage.badge` 对 `jet-hub-auto` 的改写用）。
     *
     * ## ⚠️ 为什么是一个聚合方法，而不是把三个成员直接暴露出去
     *
     * `jet-hub-rpc.ts` 只需经 `modelAdapters['jet-hub-auto']` 拿到一个**结构化**接口
     * （它不该 import 具体适配器类，见 `ModelCatalogSource` 的注释）。这里把
     * 「真实历史 / 预测 / 倍率」三件事收成一个方法，好处是：
     *
     * 1. **位置参数不动**：`registerJetHubRpc` 是位置传参且有一条派生式不变量
     *    （「客户端 `PROVIDERS` 条数 + 1 == 形参个数」）—— 加第 17 个位置参数会打破它
     *    （实测 10 条接线断言同时变红）。走 `modelAdapters` 表则只加一个键。
     * 2. **不会误用新建实例**：`selectProvider` 是**绑定在 this 上**的箭头闭包，
     *    调用方拿不到「new 一个适配器」的机会 —— 而那正是本仓库记录过的真实缺陷
     *    （两份探针缓存 ⇒ 同一渠道被折算两次）。
     *
     * ⚠️ `selectProvider` 刻意**不接受参数**：`modelOf` 必须固定为 `firstModelOf`
     *   （那才是「该 provider 能否实际被调用」的判据，见 `selectProvider` 的注释），
     *   暴露给调用方只会让它传错。
     */
    autoState(): {
        lastDecision: {
            provider: string;
            model: string;
            viaImageFallback: boolean;
            expiryAt?: number;
        } | null;
        readonly lastWinnerExpiryAt?: number;
        selectProvider(): Promise<{
            provider: string;
            model: string;
        } | undefined>;
        priceOf(provider: string, model: string): number | undefined;
    };
    /** 最近一次真实发出的目标（未发过任何请求时为 `undefined`）。 */
    get lastDecision(): {
        provider: string;
        model: string;
        at: number;
        viaImageFallback: boolean;
        expiryAt?: number;
    } | undefined;
    /** 最近一次选型胜者的失效时刻（徽标倒计时用；未选过型时为 `undefined`）。 */
    get lastWinnerExpiryAt(): number | undefined;
    /** 目录里永远只有一个 auto（真实模型由选型决定，不在此暴露）。 */
    listModels(): Promise<readonly LlmModelInfo[]>;
    /**
     * **不套黑名单**的全量目录 —— 与其余适配器的同名方法同约定。
     *
     * ⚠️ auto 只有**一个**模型且它不参与用户黑名单（黑名单针对的是各渠道的真实
     * 模型，auto 的目标由选型决定），故两个方法的返回值**相同**。
     * 存在的理由是**契约**：`jet-hub-rpc.ts` 的 `ModelCatalogSource` 要求本方法，
     * 而 auto 现在要经 `modelAdapters` 表把 `autoState()` 交给 RPC 层
     * （见 `ModelCatalogSource.autoState` 的注释：不能加位置参数）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 解析 `auto` 的能力元数据。
     *
     * 尽量借用「当前选型目标」的真实 context / 档位（让 harness 的请求校验贴近实际），
     * 但**身份必须改回 auto**：DSH 的 `normalizeModelInfo` 会拒掉 provider/id 与请求
     * 路由不符的元数据。选型不可用时退回到一份保守的通用元数据（不声明档位，任何
     * reasoningEffort 都会被 harness 判为不支持 —— 故这里连 reasoning 字段都不带）。
     *
     * ## ⚠️ 已知代价（**产品取舍，不是缺陷修复**，本轮刻意不改行为）
     *
     * ### 代价 #1：选择器首次不显示档位与积分倒计时
     *
     * 冷缓存时本方法只回保守元数据，而真实 context / 档位要等 `prepareCall` 把缓存
     * 写好后才有 —— 那是用**实测 70 秒**的目录加载换来的两个小号信息，用户明确
     * 选择放弃（报障「模型选择列表加载了 1 分多钟」）。
     *
     * ### ⚠️⚠️ 代价 #2：OpenAI 网关冷缓存**首轮**会静默丢弃 `reasoning_effort`
     *
     * 链路（逐跳已核实，**不改** `messages.ts` 也不改网关行为 —— 那超出本次范围）：
     *
     * 1. `src/openai-gateway/server.ts:372`（`/v1/chat/completions`）与 `:411`
     *    （`/v1/responses`）先 `resolveModelInfo` → `adapter.resolveModel()`；
     * 2. 冷缓存 ⇒ 走本方法下面的**降级元数据**，它**不带 `reasoning`**；
     * 3. `src/openai-gateway/messages.ts:221`：`if (declared.length === 0) return null`
     *    ⇒ **明确不下发**该字段；
     * 4. 于是 `withTranslatedEffort`（见本文件约 `:745`）拿到 `requested === undefined`
     *    ⇒ 原样返回 ⇒ **档位彻底丢失**。
     *
     * 触发面：进程启动后 **第一个** `jet-hub-auto` 网关请求（之后 `prepareCall` 已写好
     * 缓存，后续请求带真实档位）。**无报错、无日志** —— 这正是「静默降级」那一类，
     * 故在此**如实登记**：用户若发现网关首轮档位不生效，先看这里。
     *
     * ## 为什么是**零参**签名
     *
     * 基类 `LlmAdapter.resolveModel(provider, model, signal?)`（`llm-adapter.ts:1127`）
     * 与其余适配器都是三参，宿主也**实际按三参调用**；本类**刻意**把它们全忽略 ——
     * auto 只有一个对外模型 `auto`，真实目标由内部选型决定，入参里的 provider/model
     * 恒是 `jet-hub-auto` / `auto`，没有任何可用的信息。TS 允许覆写时少声明参数
     * （函数形参「少了可以、多了不行」），所以这既是事实（方法体一个参数都不用），
     * 也让**调用方**多传参数变成编译错误。⚠️ 单测必须按零参调用 —— 传 3 参是
     * `TS2554: Expected 0 arguments, but got 3`。
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
     * 按目标 provider 转发一次请求，**先翻译思考档位**；并观测「收下请求却零输出」
     * 的失败形态，命中时**顺位改道下一个 provider 重发一次**（issue IKJW31 的 B 方案）。
     *
     * ## 为什么要翻译档位（真实缺陷，用户报障 2026-10-05）
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
     *
     * ## ★ 零输出撞墙的改道（B 方案）
     *
     * 判据在 `zero-output-guard.ts`（**唯一权威**）：`max-tokens` **且零输出**。
     * ⚠️ 必须同时要求零输出 —— 有输出的 `max-tokens` 是「正常答到半截撞了输出
     * 上限」，那时换目标会**丢掉已产出的正文**（与 `aggregate-adapter.ts` 的
     * 「已吐内容就不许切换」是同一个安全方向）。
     *
     * ⚠️ **已透出帧的处理**：零输出意味着 `textDelta` 从未出现，而
     * `block-start` 只在有内容时才发（`openai-compat.ts`）⇒ 这一轮唯一
     * 可能已透出的只有 `usage` 帧，而它对 `BlockAssembler` 是**覆盖式**赋值
     * ⇒ 重发安全。故这里**不必缓冲整个流**（那会把透传改成带前瞻的缓冲，属更大的
     * 改动面，与 `aggregate-adapter.ts` 里「延迟 block-start」那条已知代价同类）。
     * 一旦某天有适配器在零内容时也发 `block-start`，本条注释的前提即失效 ——
     * 那时必须先缓冲再改道。
     */
    private dispatch;
    /**
     * 零输出撞墙后顺位选下一个目标；无候选时返回 `undefined`。
     *
     * ⚠️ 复用 {@link selectProvider}（**同一套临期/可用性/冷却判据**）而不是在这里
     * 另写一份「挑下一个」—— 那会是同一语义两套实现（本仓库红线），且必然漂移。
     */
    private replaceAfterZeroOutput;
    /**
     * 按目标档位表翻译 `reasoningEffort`，返回可交给 `ctx.llm.stream` 的选项。
     *
     * ⚠️ 抽成独立方法是为了让 `dispatch` 的观测/改道逻辑与档位翻译**分开**：
     * 后者是纯函数式的选项改写（既有行为，逐字节不变），前者是新增的失败恢复。
     */
    private withTranslatedEffort;
    /** 注入的当前时刻（与选型缓存共用同一时钟，便于单测控制冷却边界）。 */
    private now;
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
     * 同步读「新鲜的选型缓存」，**绝不触发任何网络**。
     *
     * ## 与 `ensureChoice` 的差别是决定性的
     *
     * `ensureChoice` 在缓存未命中时会**同步探测全池**（实测 70 秒：每个渠道一次
     * 余额查询），而本方法在未命中时一律返回 `undefined` —— 让调用方走
     * 「保守元数据」，把选型留给真正需要它的 `prepareCall`。
     *
     * ## ⚠️ 冷却中的缓存项视为过期（复用同款判据）
     *
     * 判据与 `ensureChoice` 的缓存分支**逐格同构**：「缓存时长」+「目标是否在冷却中」
     * 两个条件，任一条不满足即视为过期。缓存时长是 `AUTO_CHOICE_TTL_MS`（默认 60 秒；
     * **数字随常量变化，改常量时同改本注释**），而目标级冷却 10 分钟 —— 不复核则冷却
     * 形同虚设（`resolveModel` 会把一个**已确认撞墙**的目标当成正常目标播报给宿主）。
     *
     * ⚠️⚠️ **改本处的 TTL 语义必须同步改 `ensureChoice` 的缓存分支**（以及本注释），
     *    两处是「同一份新鲜度判据」的**两份实现**：只改一处 ⇒ `resolveModel` 与
     *    `prepareCall` 对「同一份缓存是否新鲜」给出相反结论（选择器播报目标 A、
     *    实际派发 B）。单测第 5 条（TTL 半零守卫）守的正是这条同步要求。
     *
     * ⚠️ 判据复用 `isTargetCoolingDown`（**唯一权威**在 `zero-output-guard.ts`），
     *    不在这里另写一份时刻比较（本仓库红线：同一语义不得两套实现）。
     *
     * ⚠️ 时刻取 `this.options.now?.()`（与 `ensureChoice` / `dispatch` 同一注入时钟），
     *    否则单测无法精确控制 TTL 与冷却的边界。
     */
    private cachedChoiceFresh;
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
     *
     * ## ⚠️⚠️ 还必须按 `modelOf` 返回的**真实模型**复核账号可用性（真实缺陷，2026-10-07）
     *
     * 「额度耗尽」在账号池里是**按 modelId 记账**的
     *（`entry.modelRateLimits[modelId]`；codearts 的 benefit 免费额度耗尽就写在那里，
     * `llm-adapter.ts`），而折算取号用的模型键**未必等于**这里要派发的模型：
     *
     * | 消费者 | 折算取号用的键 | 实际派发 |
     * |---|---|---|
     * | `AutoAdapter` 自建探针（单测/未注入时） | `firstModelOf`（按倍率挑最便宜） | 同一个 ✓ |
     * | **生产装配**（`index.ts` 注入 `sharedExpiryProbe`） | **`models[0]?.id`** | **`firstModelOf`** ✗ |
     *
     * ⚠️ 生产装配下两者**不同**：共享探针的 `firstModelIdOf` 是「取目录第一个」
     *（见 `index.ts` 那段「共享带来的语义松弛」注释），而 `firstModelOf` 是
     * 「按倍率挑最便宜」。实测（探针，2026-10-07）：目录为
     * `[glm-5.3-flash, Deepseek-V4.1-Flash · x0.1]`、账号在 `deepseek-v4.1-flash`
     * 上额度已尽时，auto 仍选中 `codearts/deepseek-v4.1-flash` —— 因为折算问的是
     * `glm-5.3-flash`（未被标记），按 modelId 的过滤**整体失效**。
     *
     * ⚠️ 这**推翻**了 `index.ts` 那句「共享的松弛已核实无害」：该注释
     * 假设「`probeModel` 不参与折算结果、故与派发无关」，但它**参与账号池的
     * 限流过滤** —— 而那正是「这个模型还能不能用」的判据。故这里必须显式复核。
     */
    selectProvider(signal?: AbortSignal, modelOf?: (provider: string) => Promise<string | undefined>, 
    /**
     * 已尝试过、本次请求内**不得再选**的目标（`` `${provider}\u0000${model}` ``）。
     *
     * ⚠️ B 方案的改道（`stream` 闭包里的零输出重试）用它顺位换下一个 provider。
     * 默认空集 ⇒ 既有调用方行为**逐字节不变**。
     */
    exclude?: ReadonlySet<string>): Promise<AutoChoice | undefined>;
    /**
     * 该 provider 在**指定模型**上是否还有可用账号（额度未耗尽 / 未在限流中）。
     *
     * ⚠️ 判据交给账号池（`getAvailableAccount` 按 `modelRateLimits[modelId]` 过滤）
     * —— 不在这里另写一份「额度是否耗尽」的判据（那会是同一语义两套实现，
     * 本仓库对此有明确红线）。
     *
     * ⚠️ 三条边界（与 `aggregate-adapter.ts` 的 `filterByModelAvailability` **逐格同构**）：
     * - 池未实现该方法 ⇒ **视为可用**（跳过过滤）：大量既有单测桩只实现
     *   `disabledModelsFor`，判成不可用会让所有桩用例「零候选」。宁可少筛一层，
     *   不可把整池误剔除。
     * - 查询抛错 ⇒ **视为可用**：一次池查询异常不该让渠道整体消失。
     * - ⚠️ **中止必须原样逃逸**：判据取**四条**（与 `aggregate-adapter.ts` 的
     *   `isAbortLike` 同构）—— `signal.aborted` / `name === 'AbortError'` /
     *   `code === 'ABORTED'` / 🔴 `message` 含 `aborted request|HTTP_?499`（上游
     *   网关 499 口径，2026-10-11 与 aggregate 侧同步补——同族判据必须逐格同构）。
     *
     *   ⚠️⚠️ **不要只判 `name`**（我上一版正是这么写的，注释还声称「同口径」，
     *   被对抗审计实测证伪）：`aggregate-adapter.ts` 的 `abortError()` 会**同时**
     *   设 `name` 与 `code`，但别的调用方可能只设 `code` —— 那时只判 `name` 会把
     *   中止**吞成「视为可用」并继续发请求**，正是本仓库反复记录的那类缺陷。
     *   （当前生产装配下该形态不可达，但「同族判据必须逐格同构」是硬要求。）
     */
    private hasUsableAccountFor;
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
     * （`account-pool.ts`），而候选顺序就是**用户的手动顺序**
     * （手动序即候选数组的返回序）⇒ 空串取回的是「手动序第一个启用账号」，**哪怕它此刻正在限流**。
     * 本仓库在 `index.ts` 已为同一坑留下过成文警告，这里是同一个缺陷的第二实例。
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
/** 「auto 现在会选谁」的预测结果（供用量徽标在**尚无真实历史**时兜底显示）。 */
export interface CurrentAutoWinner {
    provider: string;
    model: string;
    /** 胜者额度的失效时刻（`Infinity` = 只有长期积分）。 */
    expiryAt: number;
}
/**
 * 「auto 现在会选谁」——按临期判据算出当前胜者（供用量徽标等外部消费）。
 *
 * ⚠️ 与 {@link AutoAdapter.selectProvider} 是**同一套判据**（每个 provider 用
 * `getAvailableAccount` 确认可用性 + 各家余额端点折算最早失效时刻），但走的是
 * **独立实例**：徽标轮询不该与选型缓存互相踩（选型有 60 秒缓存且随请求刷新，
 * 徽标是 60 秒轮询、隐藏页跳过 —— 两者的节奏本来就该解耦）。
 *
 * ## ⚠️ 用途：**只在「还没有真实历史」时**兜底
 *
 * 本函数是**预测**语义，且**有自己的网络成本**（会对每个候选渠道打一次余额接口）。
 * ⇒ `usage.badge` 的调用序必须是：**先**读 `AutoAdapter.lastDecision`（真实历史，
 * 零成本、零误差），只有它 `undefined`（插件刚重启、还没发过任何请求）时才回退到这里。
 *
 * ⚠️ 绝不可以在有历史时也用它：预测的胜者可能因上游失败/带图改道而被换掉，
 * 于是「预测的渠道」与「实际用的渠道」不同 —— 徽标是止损工具，显示错人比
 * 不显示更危险（用户原话「以为在用 A，实际在烧 B」）。
 *
 * ## ⚠️⚠️ 聚合 provider 的用量徽标**不用本函数**（2026-10-07 定，规格 §6.5）
 *
 * 聚合徽标取的是**真实历史** —— `AggregateAdapter` 在**实际转发成功时**记下的
 * 渠道（`activeProvider()`，纯内存读）。若要给聚合徽标接线，用
 * `aggregate.activeProvider`，**不要**改成调本函数。
 */
export declare function pickCurrentAutoProvider(ctx: Context, options: AutoAdapterOptions): Promise<CurrentAutoWinner | undefined>;
//# sourceMappingURL=auto-adapter.d.ts.map