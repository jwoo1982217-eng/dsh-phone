/**
 * 聚合 provider：**一个规范模型名，多渠道候选**，按临期积分自动选渠道。
 *
 * ## 与 `jet-hub-auto` 的分工
 *
 * | | `jet-hub-auto/auto` | `aggregate/auto` | `aggregate/<规范模型>` |
 * |---|---|---|---|
 * | 候选来源 | 5 个渠道的所有模型 | 所有渠道的所有模型 | **该虚拟模型**的候选表 |
 * | 渠道内选模型 | 按倍率挑最便宜 | 同左 | 固定 realId，无选择 |
 * | 用途 | 不挑模型，谁临期烧谁 | 同左 | 锁定模型质量，渠道间轮询 |
 *
 * 两者**共用** `aggregate-core` 的排序与哨兵口径（见该模块头：两份实现必然漂移）。
 *
 * ## 目录是**动态**的
 *
 * 虚拟模型表由各渠道的**当前**目录推导（`buildVirtualModels`）⇒ 用户新增/关闭
 * 渠道模型后，下次 `listModels` 自动反映，无需重启。⚠️ 故**不缓存**目录，
 * 只缓存「一次选型」的结果（见 {@link AggregateAdapterOptions.ttlMs}）。
 *
 * ## DSH 的两条硬约束（违反即报错）
 *
 * 1. `listModels` 每条必须 `provider === 注册路由`、id/name 非空且**id 不重复**
 *    （否则 `INVALID_CATALOG`）；
 * 2. `resolveModel` 返回的 `provider`/`id` 必须与请求**逐字相符**
 *    （否则 `INVALID_MODEL_INFO`）—— 这是「多虚拟模型」必须按入参回填的原因。
 *
 * @module src/aggregate-adapter.ts
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountPool } from './account-pool.js';
import type { AggregateAllowedMap, AggregateOrderMap, AggregateRejectionMap } from './jet-hub-store.js';
import { type VirtualModel } from './aggregate-catalog.js';
import { type CandidateGate, type ExpiryProbe } from './aggregate-core.js';
/** 注册到 `ctx.llm` 的路由，也是 `providerInfo().id`（DSH 校验二者相等）。 */
export declare const AGGREGATE_PROVIDER = "aggregate";
/** 「不挑模型」的虚拟模型 id。 */
export declare const AGGREGATE_AUTO_MODEL = "auto";
/**
 * 临期探针的类型 `ExpiryProbe` 定义在 **`aggregate-core.ts`**（纯类型、零 IO）——
 * 实现是 `aggregate-expiry.ts` 的 `createExpiryProbe`，`auto-adapter.ts` 的
 * `expiryOf` 也复用它（薄委托）。
 *
 * ⚠️ **未接入的 provider 必须返回 `UNUSABLE`** —— 返回 `NEVER` 会让一个我们对其
 * 余额一无所知的渠道以「永久积分」身份参与轮换（见 `aggregate-expiry.ts` 的
 * 逐渠道判据表与长注释）。
 */
/** 聚合层的选型缓存时长（与 auto 同量级）。 */
export declare const AGGREGATE_TTL_MS = 60000;
/** 目录推导的缓存时长。
 *
 * ⚠️ **必须有这个缓存**：`refreshCatalog` 要向**每一个**渠道调 `listModels`，
 * 而其中数家会**发网络请求**取远端目录（buddy / workbuddy / lobsterai / trae /
 * cline / zcode）。而模型选择器会频繁问目录 ⇒ 没有缓存时，每打开一次选择器都会
 * 扇出十几次上游请求。
 *
 * ⚠️ 但**不能缓存太久**：用户新增/关闭渠道模型后，聚合目录要跟着变（这正是
 * 「目录是动态的」那条设计）。60 秒与各家自己的目录缓存同量级。
 */
export declare const AGGREGATE_CATALOG_TTL_MS = 60000;
/**
 * 后台那一轮目录刷新的**放弃等待**预算（毫秒）。
 *
 * ## ⚠️⚠️ 为什么必须有它（`catalogRefreshInFlight` 的单向门，2026-10-18 复审实测）
 *
 * `startBackgroundCatalogRefresh` 的单飞标记只在 `.finally` 里清 —— 那假设了
 * 「一轮刷新**总会结束**」。而上游会**永不 resolve**（实测：`loomy` 的目录读取
 * 卡住时 `ctx.llm.listModels` 既不 resolve 也不 reject）⇒ `.finally` 永不执行
 * ⇒ 标记永不清 ⇒ 此后**所有** `listModels` 都不再起后台刷新 ⇒ 目录**永久冻在
 * 冷帧**，且**零报错**（单向门形态）。
 *
 * ⚠️ 修的必须是「**放弃等待**」而不是「取消」：`LlmRuntime.listModels(provider)`
 * **只接受一个参数、没有 signal 通道**（`dsh-llm/lib/index.js` 的
 * `async listModels(provider)`）⇒ 正在挂住的那次读取**无法中断**，`AbortSignal`
 * 对它无效（`throwIfAborted` 只能在它**返回之后**生效）。故用
 * {@link withBackgroundDeadline}：到点就 reject、清标记、**保留旧目录**，
 * 被放弃的那一轮若日后真的落地，仍会正常写入并广播（不丢结果）。
 *
 * ⚠️ 取值与目录 TTL 同量级（60 秒）：正常一轮刷新的实测最坏值是 7 秒级
 * （`provider=aggregate` 逐渠道读取之和），60 秒足够宽；而它同时是
 * 「上游挂死后，用户最多等多久才能再触发一次后台读取」。
 */
export declare const AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS = 60000;
/**
 * **单个候选**能力解析（`resolveModelInfo`）的超时预算（毫秒）。
 *
 * ## ⚠️⚠️ 为什么必须逐候选设预算（用户报障 2026-10-20 实测）
 *
 * 报障现象：`aggregate/deepseek-v4-1-flash` 有 **21%** 的请求在**到达上游之前**
 * 就等了 55–239 秒（同模型**直连** workbuddy 只有 1%）。用严格一对一配对测得：
 *
 * ```
 * aggregate/deepseek-v4-1-flash   n=336  中位=60.3s  p90=83.0s  ≥55s=231 (68.5%)
 * workbuddy/deepseek-v4.1-flash   n=265  中位= 0.8s  p90= 1.1s  ≥55s=  0 ( 0.0%)
 * ```
 *
 * 根因不是余额折算（43 个账号全串行实测 11.2 秒）、不是目录刷新（20 分钟 TTL），
 * 而是**候选池里只要有一个渠道的 `resolveModelInfo` 会挂住/失败**，就每轮都要
 * 重新等它一次 —— 因为失败结果不进 `capabilityCache`（见那里的注释），而
 * `contextWindowFor` 又要求「全部候选都成功」才记忆化（见那里的注释）。
 *
 * 实测复现（`autoclaw` 的目录端点在 DNS/TCP 层 ETIMEDOUT，`AbortController`
 * 管不到它自己的 8 秒 timer）：
 * ```
 * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
 * contextWindowCache 命中? ★否 —— 永不记忆化
 * ```
 * 而 `buildModelCatalog` 会对目录里**每个虚拟模型**各调一次 `resolveModelInfo`
 * ⇒ 1/5/10 个虚拟模型 = 508/2551/5102 ms，**严格线性放大**。
 *
 * ## 为什么是 3 秒
 *
 * 各渠道的 `resolveModelInfo` 绝大多数是**纯本地查表**（`createModelCatalog` 的
 * `loadCatalog`，实测 1–17ms）；只有少数会在目录未就绪时真发网络，正常也在
 * 100–800ms 量级。3 秒是「健康路径的 3–30 倍余量、坏候选的 1/7」——
 * 既不会误伤慢但正常的渠道，也不会让一个挂住的候选吃掉整轮预算。
 *
 * ⚠️ **超时不等于取消**：这里放弃的只是一次**能力元数据**解析（窗口/档位/图片），
 * 不涉及用户请求本身。放弃后按保守方向回落（无档位 / 不支持图片 / 无窗口），
 * 由 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW} 兜住窗口，行为与「解析失败」完全一致。
 */
export declare const AGGREGATE_CAPABILITY_TIMEOUT_MS = 3000;
/**
 * **失败**的能力解析结果的缓存时长（毫秒），远小于目录 TTL（60 秒）。
 *
 * ## ⚠️⚠️ 这是「不缓存失败」与「每轮重试坏候选」之间的折中
 *
 * `capabilityCache` 的注释明确禁止把失败缓存 60 秒 —— 那会把**瞬时**故障
 * 固化成单向门（`AGENTS.md` 反复记录的缺陷形态）。但「完全不缓存」在候选池里
 * 存在**持续**故障的渠道时走向另一个极端：每一轮请求、每一次目录构建都要
 * 重新等它超时（实测 8–21 秒 × 每轮）。
 *
 * ⇒ 取 30 秒：比一次用户交互长（同轮内的多次 `capabilityOf` 调用全部命中缓存，
 * `buildModelCatalog` 的线性放大随之消失），又比目录 TTL 短一半（上游恢复后
 * 最迟 30 秒自动重试成功，不需要重启插件）。
 *
 * ⚠️ **恢复即清**：解析成功时立刻 `delete` 该键的失败记录，不必等 TTL 到期。
 */
export declare const AGGREGATE_CAPABILITY_FAILURE_TTL_MS = 30000;
/**
 * **退化**的窗口判决（有候选没解析成功）的缓存时长（毫秒）。
 *
 * ## ⚠️⚠️ 为什么退化判决也必须记忆化（用户报障 2026-10-20 实测）
 *
 * 原实现是「只有**每一个**候选都解析成功时才记忆化」（见
 * {@link AggregateAdapter.contextWindowFor} 的长注释）。那条判据的**动机是对的**
 * （不能把瞬时故障固化成 60 秒的单向门），但**手段过强**：
 *
 * ```
 * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
 * contextWindowCache 命中? ★否 —— 永不记忆化
 * ```
 *
 * 候选池里只要有一个渠道持续故障，该虚拟模型的窗口声明就**永不进缓存** ⇒
 * 每一轮请求、每一次 `buildModelCatalog` 都要把全部候选重新解析一遍。
 *
 * ⇒ 改为「退化判决也记忆化，但只记 30 秒」：既不再每轮重试，又比目录 TTL
 * （60 秒）短一半 —— 上游恢复后最迟 30 秒自动拿到完整判决，不需要重启插件。
 * ⚠️⚠️ **退化期间声明的窗口方向是「可能偏大」，不是「偏保守」**（2026-10-20 对抗审计实测证伪）：
 *
 * | 情形 | 声明值 | 与真实窗口比 | 后果 |
 * |---|---|---|---|
 * | 有候选解析成功 | 已成功那部分的最大值 | **≤** 真实最大值 | 保守（提前压缩） |
 * | **全部候选都失败** | `AGGREGATE_FALLBACK_CONTEXT_WINDOW`（200_000） | 可能 **>** 真实值 | **偏大** ⇒ 压缩阈值推后 ⇒ 上游 `CONTEXT_WINDOW_EXCEEDED` |
 *
 * 实测：唯一候选真实窗口 131_072（128K）而解析失败 ⇒ 声明 **200_000**（大 52%）。
 * 同文件的**冷帧**常量 `AGGREGATE_COLD_CONTEXT_WINDOW`=131_072 才是真保守 ⇒
 * 两个「保守兜底」方向相反（该取值是**既有行为**，master 上同样是 200_000，
 * 不是本 PR 引入；本 PR 引入的只是那句写错方向的注释）。
 */
export declare const AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS = 30000;
/**
 * **冷帧**（目录尚未推导出来）时 `resolveModel` 声明的上下文窗口。
 *
 * ## ⚠️⚠️ 这不是「聚合模型的窗口」，是「此刻我们还不知道」时的**保守声明**
 *
 * `DSH` 要求每个可路由模型都声明一个**正整数**窗口：`dsh-compaction-basic` 在
 * `info.context === undefined` 时**抛** `TargetPressureConfigError`。故冷帧也必须给值。
 *
 * 取 **131072（128K）**，即本仓库各渠道已声明窗口里的**下界量级**
 * （`llm-adapter.ts` 的 `CONTEXT_WINDOWS` 最小档、`buddy` 的 `glm-5.1` 等 200K
 * 之下的保守端）。方向是刻意的：窗口声明**偏小**的后果只是「压缩阈值提前触发」
 * （多发一次压缩、多花一点 token），而**偏大**的后果是上下文超限被上游拒绝
 * （整轮失败）。未知时宁可偏小。
 *
 * ⚠️ 与 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW}（200_000，候选窗口**都取不到**时
 * 的语义兜底）**刻意分开**：两者是**不同的状态** —— 那个是「候选在、但没声明窗口」，
 * 这个是「候选表还没读到」。混用会让排障者无法区分冷帧与「渠道没声明窗口」。
 * ⇒ 它同时是冷帧元数据的**可辨识特征**（见 {@link AggregateAdapter.coldModelInfo}）。
 */
export declare const AGGREGATE_COLD_CONTEXT_WINDOW = 131072;
/**
 * 取不到任何候选窗口时的**兜底**声明值。
 *
 * ## ⚠️⚠️ 这不是「聚合模型的窗口」，只是「我们不知道」时的占位
 *
 * 真实缺陷（用户报障 2026-10-07）：本适配器的 `resolveModel` 把这个值当成
 * **所有**虚拟模型的窗口硬编码下发（`context: { contextWindow: 200_000 }`，
 * `auto` 与具名虚拟模型两处），于是 `aggregate/deepseek-v4-1-flash` 在界面上
 * 只显示 `~x / 200k` —— 而同一个模型**直连** buddy / codearts 时声明的都是
 * **1M**（`product.ts` 的兜底表 1_000_000、`llm-adapter.ts` 的
 * `CONTEXT_WINDOWS` 1_000_000）。
 *
 * 设计文档 §4.1 写的口径是「ctx / 图片 / 档位取**候选集的能力并集**」，
 * 档位与图片都按该口径落地了（见 {@link aggregateReasoningInfo} 与
 * `capabilityOf`），**只有 ctx 这一项**留在了 P1 的写死占位值上。
 *
 * ## 两个真实消费者（所以它不只是展示问题）
 *
 * | 消费者 | 位置 | 后果 |
 * |---|---|---|
 * | 自动压缩阈值 | `dsh-compaction-basic/lib/index.js` 读 `info.context.contextWindow` 算 `thresholdTokens` | 上下文涨到 `200k × ratio` 就触发压缩，**永远吃不到 1M** |
 * | 上下文占用指示器 | `dsh-client-ui-conversation` 读 `pressure.contextWindow` | 界面显示 `~x / 200k` |
 *
 * ## ⚠️ 为什么不能「不声明」
 *
 * `dsh-compaction-basic` 在 `info.context === undefined` 时**抛**
 * `TargetPressureConfigError: no context capacity for …; configure contextWindow
 * on that adapter model`。即 DSH 要求每个可路由的模型都声明一个**正整数**窗口
 * ⇒ 兜底值必须存在且为正，这不是可选的美化。
 *
 * ⇒ 正确口径见 {@link AggregateAdapter.contextWindowFor}：**取候选集的最大值**；
 * 本常量只在「一个候选的窗口都取不到」时使用（如候选渠道全部未登录、
 * 或该渠道的 `resolveModel` 不声明窗口 —— zcode 之外的多数渠道都有可能）。
 */
export declare const AGGREGATE_FALLBACK_CONTEXT_WINDOW = 200000;
export interface AggregateAdapterOptions {
    contextWindowPolicy?: 'preferred' | 'widest';
    accountPool: AccountPool;
    /** 注入的当前时刻（测试用）。 */
    now?: () => number;
    /** 选型缓存时长（测试用）。 */
    ttlMs?: number;
    /** 目录推导缓存时长（测试用；生产用 {@link AGGREGATE_CATALOG_TTL_MS}）。 */
    catalogTtlMs?: number;
    /**
     * 后台那一轮目录刷新的**放弃等待**预算（测试用；生产用
     * {@link AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS}）。
     *
     * ⚠️ 存在的理由只有一个：它必须是**可注入**的，否则那条「上游永不 resolve ⇒
     * 标记永不清」的守卫用例得跑满 60 秒（本仓库明确禁止这种 flaky 判据）。
     */
    backgroundRefreshTimeoutMs?: number;
    /**
     * 单个候选能力解析的超时预算（测试用；生产用
     * {@link AGGREGATE_CAPABILITY_TIMEOUT_MS}）。
     *
     * ⚠️ 存在的理由与 `backgroundRefreshTimeoutMs` 同：它必须是**可注入**的，
     * 否则那条「坏候选不得拖住整轮」的守卫用例得跑满 3 秒 × N，本仓库明确禁止
     * 这种拖慢全量套件的判据。
     */
    capabilityTimeoutMs?: number;
    /**
     * 失败的能力解析结果的缓存时长（测试用；生产用
     * {@link AGGREGATE_CAPABILITY_FAILURE_TTL_MS}）。
     *
     * ⚠️ 同上：不可注入就无法在单测里验证「TTL 到期后会重试」，只能等 30 秒。
     */
    capabilityFailureTtlMs?: number;
    /**
     * **退化**窗口判决的缓存时长（测试用；生产用
     * {@link AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS}）。
     *
     * ⚠️ 同上：不可注入就只能等 30 秒才能验证「到期后重新解析」。
     */
    contextWindowDegradedTtlMs?: number;
    /**
     * 目录**落地**（后台那一轮成功写入 `this.catalog`）后的通知钩子。
     *
     * ⚠️ 由 `registerAggregateLlm` 注入为 `() => broadcastCatalogChanged(ctx)`，
     * 与其余 12 家适配器的 `onCatalogLoaded` **同一口径、同一实现**。
     * 省略时静默不广播（单测替身常见形态）。
     *
     * ⚠️ **只在「目录真的变了」时调**（见 {@link AggregateAdapter.onCatalogLanded}）：
     * 每次 `listModels` 都广播会让客户端反复重读，形成广播风暴。
     */
    onCatalogLanded?: () => void;
    /** 临期探针（省略时用 `createExpiryProbe`；单测注入替身）。 */
    expiryProbe?: ExpiryProbe;
    /**
     * 读取「拒绝轮换」表（虚拟模型 id → provider → realId → true）。
     *
     * ⚠️ 必须是**函数**而不是快照：设置面板上的开关改完后，**下一次请求**就要生效。
     * 传快照会让用户以为开关坏了（要重启插件才生效）。
     * 省略时视为「没有任何拒绝」（全部候选参与轮换）。
     *
     * ⚠️ 与 `choiceCache` 的耦合：改了拒绝表必须调
     * {@link AggregateAdapter.clearChoiceCache}，否则 60 秒 TTL 内仍会用旧的候选序
     *（RPC 端点负责这件事，见 `aggregate.setRejected`）。
     */
    rejections?: () => AggregateRejectionMap;
    /**
     * 读取「**显式允许**参与轮换」白名单（虚拟模型 id → provider → realId → true）。
     *
     * ⚠️ 与 {@link rejections} 同为**函数**（不是快照）且理由相同：面板改完开关，
     * **下一次请求**就要生效。
     * 省略时视为「没有任何手工打开」⇒ 未接入临期折算的渠道**全部默认不参与**
     *（这是用户 2026-10-15 选定的默认态；已接入渠道不受影响）。
     */
    allowed?: () => AggregateAllowedMap;
    /**
     * 读取**手工顺序**表（虚拟模型 id → 候选键数组）。
     *
     * ⚠️ 省略时视为「未自定义任何顺序」⇒ 全部按临期序（升级前行为）。
     */
    order?: () => AggregateOrderMap;
    /**
     * 读取**排序模式**（`'expiry'` / `'manual'`）。
     *
     * ⚠️ 省略时视为 `'expiry'`（升级前行为）。
     */
    orderMode?: () => 'expiry' | 'manual';
}
/** 聚合适配器。 */
export declare class AggregateAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /** 上次目录读取结果（面板与 listModels 共用一次推导）。 */
    private catalog;
    /** 上次推导时刻（目录缓存的判据）。 */
    private catalogAt;
    /**
     * 「已有一轮后台目录刷新在飞」标记（{@link startBackgroundCatalogRefresh} 的单飞闸门）。
     *
     * ⚠️ **不合并就会扇出**：宿主对目录的调用是高频的（选择器一开就一轮），
     * 而每次「缓存不新鲜」都会起一轮 ⇒ 十几家渠道被反复并发读取，正是
     * {@link AGGREGATE_CATALOG_TTL_MS} 注释里要防的形态。
     * ⚠️ 与 `catalogAt` 的区别：那个记「上次**成功**的时刻」，本标记记「此刻有没有人在跑」
     * ——两者不可互相推导（在飞期间 `catalogAt` 仍是旧值）。
     *
     * ⚠️⚠️ **它必须由「预算到期」也能清掉**（不只是 `finally`）：上游会**永不
     * resolve**（实测 `loomy` 的目录读取挂住）⇒ `.finally` 永不执行 ⇒ 标记永不清
     * ⇒ 后续所有 `listModels` 都不再起后台刷新 ⇒ 目录**永久冻在冷帧**且零报错。
     * 故起一轮时同时 arm 一份**放弃等待预算**
     * （{@link AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS}），到期即清标记（保留旧值）。
     */
    private catalogRefreshInFlight;
    /**
     * 在飞那一轮的**门票**（每次起轮自增）。
     *
     * ⚠️ 存在的唯一理由是**解决竞态**：被放弃的那一轮日后仍可能真的落地，而那时
     * 「在飞」的可能是**新的一轮**。若被放弃的那一轮在自己的 `finally` 里无条件清标记，
     * 就会把**新那一轮**的单飞闸门提前打开 ⇒ 又一次扇出。⇒ 只有「我这一轮仍是在飞
     * 那一轮」时才清。
     */
    private catalogRefreshTicket;
    /**
     * **按虚拟模型**缓存的候选序（键 = 虚拟模型 id）。
     *
     * ## 为什么需要它（规格 §9 要求，初版漏实现 ⇒ 死配置）
     *
     * `candidatesFor` 会对每个候选渠道 `await probe(...)` —— 那是一次**上游余额
     * GET**。而 `prepareCall` 是**每请求一次**（`dsh-llm/lib/index.js:1667`），
     * 于是 `auto` 最坏每轮要打十几次余额查询；而**旧的 `auto` 有 60 秒缓存**
     * （`auto-adapter.ts` 的 `AUTO_CHOICE_TTL_MS`）⇒ 新主路径反而**严格劣于**旧路径。
     *
     * ⚠️ 必须**按模型分别缓存**（规格 §9）：不同虚拟模型的候选表不同，共用一条会让
     * A 模型的候选序被 B 模型的请求覆盖。
     * ⚠️ 缓存的是**候选序**，不是「最终选中的渠道」—— 失败切换仍在同一次请求内
     * 逐个尝试（那是 `dispatch` 的事，与本缓存无关）。
     * ⚠️ 一分钟内临期时刻不会显著变化，故 60 秒 TTL 不破坏「临期优先」的语义。
     */
    private readonly choiceCache;
    /** 小容量备用渠道报告超限后，让下一次压缩读取它的容量；有效期与选型缓存一致。 */
    private readonly overflowContext;
    /**
     * 「上次**实际**转发成功的渠道」——按虚拟模型分别记录（P3，供用量徽标显示）。
     *
     * ## ⚠️ 语义是**真实历史**，不是预测
     *
     * 只在**产出可见内容时**写入（= 这个候选真的成功了）。**不做预测**：
     * 预测的胜者可能因失败切换而实际未被使用，徽标显示一个错的渠道比不显示更误导。
     *
     * ## ⚠️ 纯内存、进程内
     *
     * 插件重启即清空 ⇒ 徽标「无历史 ⇒ 不渲染」（规格 §6.3 的 P4）。
     * ⚠️ **不落盘**：这是展示用的瞬时状态，写盘只会带来无谓的 IO 与陈旧值
     *（重启后显示一个早已不用的渠道，反而误导）。
     *
     * ⚠️ 与 `choiceCache` 的区别：那个缓存的是**候选序**（可预测），
     * 本表记录的是**实际结果**（已发生）——两者不可互相推导。
     */
    private readonly activeProviderByModel;
    /**
     * 每个候选（`provider\0realId`）的**能力**缓存：窗口 / 档位 / 图片。
     *
     * ## 为什么需要它
     *
     * 窗口推导（{@link contextWindowFor}）与派发前的能力解析（{@link capabilityOf}）
     * 问的是**同一件事**，而两者都会被高频调用：
     * - DSH 的 `buildModelCatalog` 对**目录里每个模型**都调一次 `resolveModelInfo`
     *   （`dsh-api-session-controller/lib/index.js:506`）⇒ 窗口推导会在用户每次打开
     *   模型选择器时对全部虚拟模型的全部候选各问一次；
     * - `prepareCall` 每次请求都会对本次候选逐个解析能力。
     *
     * 没有缓存时同一份元数据会被反复解析（对**远端目录**类适配器是本地查表，
     * 但对目录尚未拉全的适配器会重试拉取）。缓存让两者共用一次结果。
     *
     * ## ⚠️ 只缓存**成功**的结果，绝不缓存失败
     *
     * 失败时 `capabilityOf` 返回保守默认值（无档位 / 不支持图片 / 无窗口）。
     * 把「这一次没问出来」缓存 60 秒会把**瞬时**故障固化成单向门 —— 那正是
     * 本仓库反复修过的缺陷形态（见 `AGENTS.md` 的「`refreshable` 单向门」）。
     * ⇒ 失败不写本缓存；**失败记录进 {@link capabilityFailureCache}，只有 30 秒**，
     * 见那里的注释（完全不缓存会让持续故障的候选每轮都被重试一遍）。
     *
     * ⚠️ 与目录同生命周期：{@link refreshCatalog} 重建目录时清空 —— 目录变了，
     *    「哪些候选存在」就变了，缓存必须跟着失效。
     */
    private readonly capabilityAt;
    private readonly capabilityCache;
    /**
     * **失败**的能力解析记录（`provider\0realId` → 失败时刻）。
     *
     * ## ⚠️⚠️ 为什么需要它（用户报障 2026-10-20 实测）
     *
     * 只有 {@link capabilityCache}（只存成功）时，候选池里**任何一个**持续故障的
     * 渠道都会让每一轮请求都重新等它超时：
     *
     * ```
     * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
     * contextWindowCache 命中? ★否 —— 永不记忆化
     * ```
     *
     * 而 `buildModelCatalog` 对目录里**每个虚拟模型**各调一次 `resolveModelInfo`
     * ⇒ 坏候选的代价被乘以虚拟模型数（实测 1/5/10 个 = 508/2551/5102 ms）。
     *
     * ## 与「不得缓存失败」的关系
     *
     * 本表**不是**把失败当成成功缓存：命中时返回的仍是 `resolved: false` 的保守值，
     * 且 TTL 只有 {@link AGGREGATE_CAPABILITY_FAILURE_TTL_MS}（30 秒，目录 TTL 的一半）。
     * 它解决的是「同一轮内反复问同一个坏候选」，不是「永远不再问」。
     *
     * ⚠️ **解析成功时立刻 `delete` 该键**：上游恢复后不必等 TTL 到期。
     * ⚠️ **中止（`isAbortLike`）不写本表**：中止不是「候选坏了」，写进去会让用户
     *    取消一次请求后，该候选在 30 秒内被当成故障候选（真实缺陷形态，见
     *    `capabilityOf` 的 catch 分支注释）。
     * ⚠️ 与目录同生命周期：{@link refreshCatalog} 重建目录时一并清空。
     */
    private readonly capabilityFailureCache;
    /**
     * **在飞**的能力解析（`provider\0realId` → 该次解析的 Promise）。
     *
     * ## ⚠️⚠️ 为什么必须有它（2026-10-20 独立审计实测的重复扇出）
     *
     * {@link capabilityCache} 只在 `await` **之后**才写 ⇒ 同一拍的重复询问全部穿透：
     *
     * - 宿主 `buildModelCatalog` 对**每个虚拟模型**并行调 `resolveModelInfo`，而一个
     *   候选常常**同时**挂在多个虚拟模型下（同一个 realId 在多渠道归一成一个键）；
     * - `auto` 的池与具名模型的候选表**重叠**。
     *
     * 实测（18 渠道 × 40 模型、41 个虚拟模型并行）：**738** 次 `resolveModelInfo`
     * 调用、单候选最多被重复解析 **2** 次；改前（无封顶、无在飞合并）峰值 720。
     *
     * ⇒ 本表把「同一个候选的并发询问」合并成**一次**底层解析（`Promise` 共享）。
     * ⚠️ **不得缓存失败的 Promise**：`finally` 里无条件删（成功/失败都删），否则
     * 一次失败会像「失败短缓存」那样被固化 —— 那只由
     * {@link capabilityFailureCache} 按 30 秒显式控制。
     * ⚠️ 与目录同生命周期：{@link refreshCatalog} 一并清空（`Map.clear()` 只丢引用，
     * 已在飞的 Promise 仍会跑完并各自写 `capabilityCache`，无害）。
     */
    private readonly capabilityInFlight;
    /**
     * 每个虚拟模型（含 `auto`）的**窗口声明值**缓存。
     *
     * ⚠️ 判决结果是「候选集的最大值」，是个**纯函数**（同一份目录 + 同一份能力缓存
     * 必然得到同一个值）⇒ 记忆化不改变语义，只是避免每次 `resolveModel` 都重算。
     * ⚠️ 同样在 {@link refreshCatalog} 里清空（目录变了 ⇒ 候选集变了 ⇒ 最大值可能变）。
     * ⚠️ 值是 {@link ContextWindowEntry} 而不是裸 `number`：**退化判决**（有候选没解析
     * 成功）的 TTL 必须比正常判决短得多，见那里的注释。
     */
    private readonly contextWindowCache;
    constructor(ctx: Context, options: AggregateAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 该虚拟模型下被**拒绝轮换**的候选集合，键是 `` `${provider}\u0000${realId}` ``。
     *
     * ⚠️ 用 `\u0000` 作分隔符（不是 `:` 或 `/`）：provider id 与 realId 里都可能含
     * 冒号或斜杠（如 `cline-free/deepseek-v4.1-flash`），用它们会**误判**（把
     * `a/b` + `c` 与 `a` + `b/c` 拼成同一个键）。NUL 在两者里都不可能出现。
     */
    rejectedIn(canonicalId: string): ReadonlySet<string>;
    /**
     * 该虚拟模型下**实际应被拒绝**的候选集合（**含 D4 的 id 漂移降级**）。
     *
     * ## ⚠️ 为什么需要它（规格 §0.3 D4 + §1.9 + §5.1 的成文要求）
     *
     * 规格 §5.1 的判据表：
     * ```
     * 查 (虚拟模型, provider, realId) 是否有拒绝记录
     * ├─ 有精确匹配 → 拒绝该候选
     * ├─ 无精确匹配，但该 (虚拟模型, provider) 下有**任何**拒绝记录
     * │     且该记录对应的 realId **已不在当前候选中**（id 漂移）
     * │     → 降级为渠道级拒绝（该虚拟模型下该渠道全部候选都被拒），并记一条 warn
     * └─ 无记录 → 参与轮换
     * ```
     *
     * ## ⚠️ 不实现它的**真实后果**（规格 §1.9 记录的静默失效）
     *
     * `lobsterai` 的候选 id 会随「远端可用 / 兜底」切换：远端是 `deepseek-flash`
     *（真 V4.1 Flash），兜底表是 `deepseek-v4-flash`（更旧的型号）。
     * 若拒绝记录只锁 `realId`，**状态一翻转就匹配不上、静默失效** ——
     * 用户明确拒绝过的候选**悄悄复活**，而他以为还拒着。
     *
     * ⚠️ 降级判据是「该记录对应的 realId **已不在当前候选中**」——
     *    **不是**「没有精确匹配」（那样会把「同渠道的另一个候选没被拒」也降级掉，
     *    那是过度拒绝，方向相反的错误）。
     *
     * @param virtual - 当前的虚拟模型（用来知道该渠道眼下有哪些 realId）
     * @returns 应拒绝的 `provider\u0000realId` 集合（**已展开为渠道级**，若降级发生）
     */
    rejectedFor(virtual: {
        key: string;
        candidates: readonly {
            provider: string;
            realId: string;
        }[];
    }): ReadonlySet<string>;
    /**
     * 清空选型缓存。
     *
     * ⚠️ **改了拒绝表之后必须调它**：`choiceCache` 的 TTL 是 60 秒，而面板上的开关
     * 是「立刻生效」的语义 —— 不清缓存的话，用户在面板上关掉的候选在 60 秒内仍会被
     * 尝试（用户会以为开关坏了）。RPC 的 `aggregate.setRejected` / `clearRejected`
     * 负责调用。
     */
    clearChoiceCache(): void;
    /**
     * 清空**临期折算缓存**（领取成功后由 RPC 调用）。
     *
     * ## ⚠️⚠️ 为什么领取之后必须清（真实缺陷，对抗审计实测证伪，2026-10-07）
     *
     * 折算缓存**也缓存 `UNUSABLE`**，而 `zcodeExpiry` 现在把「余额为 0」判成
     * `UNUSABLE`（修掉「额度已尽仍被 auto 选中」的真实缺陷）。zcode 的每日赠送额度
     * **要先领取才进 `balances` 桶** ⇒ 「先撞额度尽（写 `UNUSABLE`）→ 去签到 → 立刻用
     * auto」时，**最长 60 秒内 auto 仍说没有候选**，用户会以为签到没用。
     *
     * ⚠️ 已有的两个清理入口（`pool.onAccountAdded` / 拒绝表变更）**都不覆盖领取**。
     *
     * ⚠️ 必须清**共享的**那一份探针（装配层 `src/index.ts` 把同一个实例同时给
     * aggregate 与 auto）—— 只清一份会让 auto 仍看到旧的 `UNUSABLE`。
     * 故这里清的是注入进来的 `options.expiryProbe`（与 auto 同一个对象）。
     */
    clearExpiryCache(): void;
    /**
     * 「上次**实际**转发成功的渠道」（P3，供用量徽标）。
     *
     * ⚠️ **纯内存读、零网络零余额查询** —— 徽标在**门控阶段**就要拿到它
     *（规格 §6.3 的 P2：重定向必须发生在门控之前），查网络会让外层渲染抖动。
     *
     * @param canonicalId - 虚拟模型 id。**省略时返回「最近一次任意虚拟模型的转发渠道」**
     *   （规格 §8.4：徽标只关心「当前在跑的是哪个渠道」，不必区分模型）。
     *   实现上「最近一次」取 `Map` 的**最后一个插入项** —— 但 `Map` 的迭代顺序是
     *   **插入顺序**而非「最近写入顺序」（覆盖已存在的键**不改变**其位置）。
     *   ⚠️ 故这里**显式维护一个「最近写入」指针**，而不是依赖迭代顺序
     *   （否则「切回一个之前用过的渠道」时顺序会错，徽标显示旧渠道）。
     * @returns 渠道 id；无历史时 `null`（调用方据此**不渲染**徽标）。
     */
    activeProvider(canonicalId?: string): string | null;
    /** 最近一次（任意虚拟模型）实际转发成功的渠道；无历史时 `null`。 */
    private lastActiveProvider;
    /**
     * 「按临期排序」用的候选到期时刻（面板的可选按钮，用户 2026-10-07 选定方案 C）。
     *
     * ## ⚠️⚠️ 这是**唯一**会做余额探测的面板端点 —— 且**只在用户显式点击时**调用
     *
     * 为什么必须单独一个方法而不是给 `describeCatalog` 加参数：那个方法的契约是
     * **零余额查询**（规格 §8.3，且有专门用例断言 `expiryProbe` 零调用）。
     * 面板一打开就打十几次上游请求是不可接受的；而「按临期排序」**必须**探测才知道顺序。
     * ⇒ 两者分开：默认零探测，用户点按钮才走这里。
     *
     * ## 为什么需要它（用户报障）
     *
     * 面板标题写「临期优先」，但候选列表来自 `aggregate-catalog.ts` 的
     * `candidates.sort(...)` —— 那是按 `provider` **字母序**
     * （用户原话：「codearts 的 4.1 flash 没有显示在最后」）。
     * ⇒ 标题与列表**矛盾**（面板没说真话）。
     *
     * ## 返回形状
     *
     * `{ <provider>: expiry }` —— 按渠道去重（同一渠道的多个候选共享一次探测，
     * 与 `candidatesFor` 的 `seen` 表同一口径，避免重复打上游）。
     * ⚠️ 探测失败（`UNUSABLE`）也如实返回该值，由客户端决定怎么显示/排序
     *（`sortCandidatesByExpiry` 把非有限值排最后）。
     *
     * ⚠️ **只读**：不改拒绝表、不写缓存、不落盘。
     *
     * @param force - `true` 时绕过探针自己的折算缓存（`EXPIRY_CACHE_TTL_MS` 60 秒）。
     *   面板的「每 5 分钟自动重探」与用户手动点击都传 `true`（那两种情形要的是**新鲜**值）；
     *   进入模式时那次传 `false`（省一次上游请求）。
     */
    describeExpiryOrder(signal?: AbortSignal, force?: boolean): Promise<Record<string, number>>;
    /**
     * 组装给设置面板的目录（**只读、零余额查询**，规格 §8.3）。
     *
     * ⚠️⚠️ **不得调用 `expiryProbe` / `resolveModelInfo`** —— 面板一打开就会对每个
     * 渠道打一次上游请求；而本端点只回答「有哪些虚拟模型、各自有哪些候选、哪些被拒」，
     * 与余额无关。实时余额仍由各渠道自己的面板负责。
     *
     * ⚠️ 「按临期排序」需要探测 ⇒ 它走**单独的** {@link describeExpiryOrder}，
     * 不在这里加参数（那会破坏本方法的零查询契约，且有专门用例断言）。
     *
     * ⚠️ 也**不得**改动拒绝表（纯读）。
     *
     * @param force - **绕过目录 TTL 缓存**（面板的「刷新」按钮用）。
     *   ⚠️ 真实缺陷（对抗审计实测证伪）：初版**不传 force**，而 `refreshCatalog` 有
     *   60 秒缓存 ⇒ 面板的「刷新」按钮实际是「读缓存」，用户在渠道侧新增/关闭模型后
     *   点刷新**看不到任何变化**，会以为聚合坏了。同时 `refreshCatalog` 的 `force`
     *   参数在**全仓零调用点**（死参数）—— 两处都是这条缺陷的一部分。
     *   ⚠️ 只有**用户显式点刷新**时才传 `true`：`listModels` 等高频路径必须继续走缓存，
     *   否则每次打开模型选择器都会重推整个目录。
     */
    describeCatalog(force?: boolean, signal?: AbortSignal): Promise<{
        models: Array<{
            canonicalId: string;
            name: string;
            candidates: Array<{
                provider: string;
                realId: string;
                realName: string;
                price: number;
                viaPatch: boolean;
                rejected: boolean;
                state: CandidateGate;
                expiryWired: boolean;
            }>;
            order: string[];
        }>;
        orderMode: 'expiry' | 'manual';
    }>;
    /**
     * 某条候选当前的三态门控（**唯一判据**，同步、零网络：只读注入的三张表）。
     *
     * ⚠️⚠️ **只有这一处实现**：`describeCatalog` 下发 `state`、`pickerNameOf` 统计
     * 「当前参与」的价格，都调它。两处各写一遍判据必然漂移（本仓库有过「同一文件
     * 两套同义判据」的缺陷史）。
     *
     * ⚠️ `WIRED_EXPIRY_PROVIDERS` 的引用也**只在此一处**（`candidatesFor` 的建池过滤
     * 同样走本方法）⇒ 「谁的默认态是什么」这个问题全仓只有一个答案。
     *
     * @param degraded - 省略时内部算（`rejectedFor`）。传入可让调用方在循环里复用
     *   同一次降级计算（`describeCatalog` 对每个虚拟模型算一次，避免每候选重算）。
     */
    private gateOf;
    /**
     * 聚合路由状态的**内容指纹**（参与 `choiceCache` 的键，见 `candidatesFor`）。
     *
     * ⚠️ **四项缺一不可**（用户 2026-10-15 起：拒绝表 + 白名单 + 手工顺序表 + 排序模式）：
     * 任何一项变了，缓存里的候选序（含**次序**）都不再成立。漏一项的症状是
     * 「用户改了门控/顺序，随后最多 60 秒内仍按旧的走」—— **静默**（用户会以为开关坏了）。
     *
     * ⚠️ 拒绝表与白名单用**排序后的拼接**（与键的书写顺序无关：同一集合的不同书写顺序
     * 是同一张表，不该导致缓存失效）；顺序表**不能**排序（它的**顺序本身就是语义**）；
     * 模式直接拼接。
     *
     * ⚠️ 不要改成「条目数」之类的摘要：本仓库有过「缓存失效判据按数组长度」被实测证伪的
     * 教训（两条不同内容长度相同 ⇒ 恒不失效）。
     */
    private routingFingerprint;
    /**
     * 手工位次函数：`orderMode === 'manual'` 且该模型**有**顺序表时给出，否则 `undefined`
     *（⇒ `rankCandidates` 走临期序）。
     *
     * ⚠️ `auto` **恒为 `undefined`**（用户 2026-10-15 的取舍 Q6=C）：`auto` 的池是跨全部渠道的
     *    巨池，「手工顺序」在那里没有可解释的含义 —— 用户拖的是**某个虚拟模型**的候选。
     *
     * ⚠️ 未排在数组里的候选返回 `undefined` ⇒ `rankCandidates` 把它们按
     *    **临期↑ → 倍率↑** 追加在已排过的**之后**（新增候补因此不会消失）。
     */
    private manualRankOf;
    /**
     * 重新推导虚拟模型表（**带 TTL 缓存**，理由见 {@link AGGREGATE_CATALOG_TTL_MS}）。
     *
     * ⚠️ 逐个渠道 `try/catch`：某一个渠道目录读取失败**不得**让整个聚合目录变空
     * （那会让用户在别的渠道都正常时突然看不到任何模型）。
     *
     * @param force - 绕过缓存（设置页手动刷新用）。
     */
    refreshCatalog(force?: boolean, signal?: AbortSignal): Promise<VirtualModel[]>;
    /**
     * 通知「目录已落地」——**唯一**出口（`broadcastCatalogChanged` 与 12 家适配器同源）。
     *
     * ⚠️ **失败只记日志**：目录已经写好了，因通知失败而抛错会让调用方
     *（`listModels` 的宿主路径）以为目录加载失败 —— 与 `catalog-broadcast.ts`
     * 自己的约定、以及 `jet-hub-rpc.ts` 的「通知失败不能反噬已落盘的开关」同一条。
     */
    private onCatalogLanded;
    /**
     * 两份推导结果是否**逐条相同**（判定「目录真的变了」用）。
     *
     * ⚠️ 判据必须比到**候选表**，不能只比虚拟模型 id 的数量：候选增减（用户新登录
     *    一个渠道、某渠道下架了一个 realId）同样改变目录语义，而 id 集合可能不变。
     * ⚠️ 顺序也要比：`buildVirtualModels` 的结果顺序是**稳定**的（候选数降序、
     *    同数按 key 升序）⇒ 同内容必然同序；不同序即不同内容。
     */
    private sameCatalogAs;
    /**
     * 若聚合 provider 处于「整个已关闭」态，则把**新增的**虚拟模型补进黑名单。
     *
     * ⚠️ 详见 {@link refreshCatalog} 末尾的长注释：这是为了弥补宿主
     * 「一键关闭写快照」与「聚合目录动态推导」之间的语义缺口。
     *
     * @param previousIds - **上一次**推导出的全量目录（含 `auto`）——
     *   用它判断「用户关的是整个 provider」而不是逐个关了某几个模型。
     */
    private maintainProviderClosedState;
    /**
     * 参与聚合的渠道 id 白名单 —— **只含本插件注册的渠道**。
     *
     * ## ⚠️ 为什么必须是白名单，不能用 `listProviders()`
     *
     * 初版直接 `ctx.llm.listProviders()` 并注释成「本插件注册的全部渠道」，但那个 API
     * 返回的是**宿主全部**存活路由 —— 它会纳入 `deepseek-account`、`pi-ai` 等
     * **别的插件**的 provider（真实缺陷，全分支终审 I1）。后果：
     *
     * 1. **广告出无法路由的虚拟模型**：那些渠道的临期折算没接入（`createExpiryProbe`
     *    只接了 buddy / workbuddy / loomy / codearts / zcode），一律折算成 `UNUSABLE`
     *    ⇒ 它们的虚拟模型**永远没有可用候选**。用户选中后拿到的是
     *    「没有任何可用候选（渠道被关闭、模型被关、或所有渠道都无可用账号）」——
     *    把「该渠道尚未接入」**谎报成「你没登录」**，正是本仓库反复修的误导性报错。
     * 2. **跨渠道归一被污染**：宿主自带 provider 的模型会被并进聚合目录
     *    （实测 `deepseek-account:deepseek-flash` 与 `qoder:dfmodel` 会被合并成同一个
     *    虚拟模型），使「跨渠道归一」把**非本插件渠道**也算成候选。
     *
     * ⚠️ 用字面量而非 import 各 `product.ts` 的常量：那要引入 12 个模块，显著加重本文件
     * 的依赖；而这些 id 是**稳定契约**（`index.ts` 的 `modelAdapters` 表同样用字面量）。
     * 新增 provider 时**两处都要加**。
     *
     * ## ⚠️ 本清单**有守卫**（2026-10-12 补）
     *
     * 原先本行写的是「（与 `modelAdapters` 同一约定）」—— 那句是**误导**：`modelAdapters`
     * 当时已有两条守卫（源码文本抓多余键 + 行为抓漏键），而**本数组一条都没有**。
     * 实测（对抗性审计）：从本数组删掉 `'gemini'` 后全量测试**依然全绿**，而线上后果是
     * 该渠道的模型**永不进聚合目录**、用户看不到、`auto` 也不用，**无报错无日志**。
     *
     * 现由 `tests/unit/aggregate-adapter.spec.ts` 的
     * 「★★ 聚合渠道白名单与 registry 对齐」守：它用 `listModels` 的**调用记录**反推本
     * 数组（该常量是私有的，行为路径才拿得到），与 `PROVIDER_REGISTRY.filter(d => d.channel)`
     * 做**集合**比对，漏一家即红并点名。
     * ⚠️ 判据是**集合**不是有序：本数组与 registry 的尾部顺序**本来就不同**
     *（本数组 `… gemini, zcode, opencode`，registry `… zcode, opencode, gemini`），
     * 故不能要求有序相等；顺序本身在本数组内有语义，由下面的排列体现。
     */
    private static readonly AGGREGATE_CHANNELS;
    /**
     * 本插件注册的渠道 id（`aggregate` 与 `jet-hub-auto` 自身除外）。
     *
     * ⚠️ 先取 `listProviders()` 的**存活路由**再与白名单取交集：这样宿主没装载的渠道
     * 不会进目录（否则会广告出连适配器都没有的模型），同时**排除**别的插件的 provider。
     */
    private providerIds;
    /**
     * 对外播报虚拟模型（含 `auto`），**套用户黑名单**。
     *
     * ## ⚠️⚠️ 2026-10-16：另加一条「**全部候选都是「无临期积分且没打开」**⇒ 不播报」
     *
     * 用户验收反馈原话：「默认不参与轮换的无临期模型（没有一个打开轮换）则**不显示在
     * 选择模型的列表中的聚合模型下属的列表中**」。
     *
     * ### 为什么这条**不违反**「候选全被拒 ≠ 关闭模型」的成文不变式（判据是**分档**）
     *
     * 两种「没有任何候选在轮换」必须分开对待 —— 这是本次改动的**全部要害**：
     *
     * | 情形 | 选择器 | 理由 |
     * |---|---|---|
     * | 用户**主动**把候选全拒（`rejected`） | **仍播报** | 那是既有成文不变式（`jet-hub-store.ts` 的「候选全被拒 ≠ 关闭模型」）。模型留在选择器里，用户选中它拿到**如实**报错，回面板重新打开即恢复 —— 若藏起来，恢复入口就消失了 |
     * | 候选**全是**「无临期积分且用户没打开」（`default-rejected`） | **不播报** | 用户**从未**对该模型做过任何决定，它进选择器只会得到「没有任何可用候选」（第 4 种原因的报错）。⚠️ 它**仍在聚合面板里**（那才是唯一的打开入口），故**恢复路径没有丢** |
     * | 混合（一部分被拒、一部分默认） | **仍播报** | 里面含用户**主动**做的决定 ⇒ 归第一档 |
     *
     * ⇒ 判据是「**所有**候选都 `default-rejected`」，**不是**「没有候选在轮换」。
     * ⚠️ 别把它简化成后者 —— 那会把「用户主动全拒」的模型也藏掉，正是上面那张表第一行禁止的。
     *
     * ⚠️ **只作用于本方法（模型选择器）**：
     *   - `describeCatalog`（聚合面板）**不受影响** —— 面板必须能看到并打开它们；
     *   - `listAllModels`（设置页的开关清单）与 `provider.status` 的 `total` **不受影响**
     *     —— 目录身份保持稳定（`this.catalog` 不随门控漂移，这是上面那份不变式的另一半）。
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 模型选择器用的目录：**缓存新鲜就同步返回；不新鲜就先返旧目录、后台补算**。
     *
     * ## ⚠️⚠️ 为什么不能在这里 `await refreshCatalog()`（2026-10-18，实测 7 秒）
     *
     * 实测排障日志：
     * ```
     * [buildModelCatalog] provider=aggregate 全部完成：listModels=…ms，总耗时=7028ms
     * [buildModelCatalog] provider=loomy     全部完成：…              总耗时=6852ms
     * ```
     * 两者**同步出现且数值相近** ⇒ 共享同一个下游。真实机制（核对代码得出）：
     * `refreshCatalog` 会**逐渠道 `await ctx.llm.listModels(provider)`**，即每个渠道
     * 一次**远端目录读取**（`loomy` 的 `listModels` → `loadModels()` →
     * `fetchRemoteModels()` 真发网络请求）。聚合的总耗时 = 各渠道目录读取之和，
     * loomy 那 6852ms 是其中最大的一项 ⇒ 宿主 `buildModelCatalog` 里
     * `provider=aggregate` 这一个分组就把它的选择器拖住整 7 秒，而 `auto` 这类
     * 不需要目录的东西也被一起拖住。
     *
     * ⇒ `listModels` **不再等**：先播报**已知**目录（冷启动时可能只有 `auto`），
     * 折算/读取交给后台，落地后下一次 `listModels` 自然带上它。
     *
     * ## 三条口径（缺一条都会让某条既有行为漂移）
     *
     * 1. **缓存新鲜 ⇒ 完全同步返回**（`isCatalogFresh`，与 `refreshCatalog` 的短路
     *    **是同一个判据**）—— 常见路径（60 秒内重复打开选择器）行为与改前逐字相同；
     * 2. **不新鲜 ⇒ 返回已知目录 + 起一次后台刷新**，**不 await**；
     * 3. ⚠️ **后台任务必须复用 {@link refreshCatalog}**，不另写折算+读取逻辑 ——
     *    它已经是「重新推导 + 清缓存 + 补写关闭态」的**唯一**入口，另写一份会让两条路
     *    的上游行为分叉。
     *
     * ## ⚠️ 为什么**不传 signal**
     *
     * 后台任务没有调用方要通知（`listModels(provider)` 的契约里根本没有 signal 通道），
     * 传了反而是错的。而不传**不会**破坏 `refreshCatalog` 里那段 abort 铁律：
     * 那段逻辑由 `signal?.throwIfAborted()` 与 `isAbortLike(error, signal)` 组成，
     * `signal` 为 `undefined` 时两者都**静默不做任何事** ⇒ 逐渠道真实的读取失败仍照旧
     * 只记 warn 并跳过（既有语义），AbortError 也不会被误吞成目录缓存 —— 因为**没有**
     * AbortError 可言（没有 signal 就没有取消源）。
     *
     * ## ⚠️ 单飞（不得并发两次）
     *
     * 选择器可能在后台那一轮还没跑完时被再开一次（宿主对目录的调用是高频的）。
     * 若每次不新鲜都起一轮，就会对**十几个渠道**并发扇出（正是
     * `AGGREGATE_CATALOG_TTL_MS` 注释里要防的形态）⇒ 必须靠 {@link catalogRefreshInFlight}
     * 合并成一轮。
     *
     * ## 行为代价（如实登记）
     *
     * 冷启动（或距上次成功读取超过 60 秒）后的**第一次**打开选择器，聚合分组里
     * 可能**只有 `auto`**，虚拟模型会在后台读取完成后出现（用户再开一次即见）。
     * 这是「目录不再同步等上游」的必然代价，与 `auto-adapter.ts` 的
     * `resolveModel` 那次修复（实测 70 秒）同一取舍。
     */
    private catalogForListModels;
    /**
     * 起一轮后台目录刷新（幂等：已有在跑的一轮就**不**再起）。
     *
     * ⚠️ 见 {@link catalogForListModels}：**必须复用** {@link refreshCatalog}。
     * ⚠️ **必须 `.catch()`**：这是 fire-and-forget，未捕获的 rejection 会变成
     *    unhandled rejection 并可能打崩进程（与注册预热同一口径）。
     * ⚠️ 清在飞标记：失败后下一轮 `listModels` 必须仍能再试一次
     *    （否则一次瞬时失败会把目录**永久**冻在空目录上 —— 那是本仓库反复修过的
     *    「单向门」形态）。
     *
     * ## ⚠️⚠️ 「清标记」必须有**两条**路径：settle 与**预算到期**
     *
     * 初版只有 `.finally`，即假设「一轮刷新**总会结束**」。上游会**永不 resolve**
     * （实测 `loomy` 的目录读取挂住）⇒ `.finally` 永不执行 ⇒ 标记永不清 ⇒
     * 此后**所有** `listModels` 都不再起后台刷新 ⇒ 目录永久冻在冷帧，零报错。
     *
     * ⇒ 这里同时 arm 一份放弃等待预算（{@link withBackgroundDeadline}）：
     * - **settle**（成功或失败）⇒ 清标记、正常返回；
     * - **预算到期** ⇒ 清标记、记一条 warn、**保留旧目录**。被放弃的那一轮若日后
     *   真的落地，仍会正常写 `this.catalog` 并广播（不丢结果）。
     *
     * ⚠️ 清标记时比对 {@link catalogRefreshTicket}：被放弃那一轮的 `.finally` 迟到时，
     *   绝不能把**新那一轮**的单飞闸门提前打开（那会重新引入扇出）。
     */
    private startBackgroundCatalogRefresh;
    /**
     * 该虚拟模型的候选是否**全部**是「无临期积分且用户没打开」（`default-rejected`）。
     *
     * ⚠️ **判据必须逐条看三态**，不能写成「没有 allowed」—— 后者会把
     * 「用户主动全拒」（`rejected`）也算进来，而那**必须仍播报**（见 `listModels` 的表）。
     *
     * ⚠️ 无候选 ⇒ `false`（「无候选」是另一回事：那是该渠道模型下架，不是用户的选择）。
     */
    private isAllDefaultsUnopened;
    /**
     * **不套黑名单**的全量目录 —— 设置页要用它渲染开关。
     *
     * ⚠️ 与其余 14 个适配器的同名方法同约定：被用户关闭的模型也必须出现在这里，
     * 否则用户在设置页**连开关都摸不着**（`jet-hub-rpc.ts` 对 `model.list` 的
     * 注释记录了该缺陷）。
     * ⚠️ 必须是**同步**方法（`jet-hub-rpc.ts` 的 `ModelCatalogSource` 契约要求），
     * 故只读上一次推导结果（由 {@link listModels} 刷新）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /** `auto` 的元数据。 */
    private autoModelInfo;
    /** 虚拟模型的展示名 —— **设置页与解析路径用**（不带倍率，见 {@link pickerNameOf}）。
     *
     * ⚠️ **不加「（单渠道）」之类的后缀**（与 brief 初版的 `nameOf` 不同）：
     * 设计文档 §12.1（`docs/superpowers/specs/2026-10-06-aggregate-provider-design.md`
     * 的「关于 `auto-adapter.ts` 的三处名字」一节）把新 provider
     * 定成「目录展示规范名 + 运行期渠道后缀」**单一形态**，并逐字写死三处的名字都是
     * 规范名（`listModels` / `resolveModel` → `DeepSeek V4.1 Flash`；`prepareCall`
     * → `DeepSeek V4.1 Flash · buddy`）。加后缀会让选择器与服务端目录名不一致，
     * 且 `prepareCall` 会拼出 `…（单渠道） · buddy` 这类双重后缀。
     * 「有没有冗余渠道」是**设置页**的信息（§7.3：按厂商分组、组内按候选渠道数降序、
     * 展开看逐条候选），不该混进模型展示名。
     *
     * ⚠️ 本方法**保持无倍率**：`resolveModel` 与 `describeCatalog` 的返回值被三处
     * 既有断言逐字钉住（`aggregate-adapter.spec.ts:88`、`aggregate-rejections.spec.ts:251`、
     * `aggregate-catalog.spec.ts:21` 全是 `'DeepSeek V4.1 Flash'`），且 `describeCatalog`
     * 的候选子列表**逐条**显示倍率（`candidateRowLabel`）—— 在模型名上再叠一次
     * 会出现「两个倍率」的重复展示。倍率只加在**模型选择器**那一条路径上，
     * 即 {@link pickerNameOf}。
     */
    private nameOf;
    /**
     * 聚合目录**此刻是否可用于「关闭整个供应商」这类写操作**（同步、零 IO）。
     *
     * ## ⚠️⚠️ 为什么必须有这个探测（Critical：`provider.setEnabled` 的冷帧假成功）
     *
     * Task 7 之后 `listModels` **不再同步等上游** ⇒ 冷启动时它立刻返回 `['auto']`。
     * 而 `jet-hub-rpc.ts` 的 `fullCatalogIds` 判据是「远端读到即可」（`remoteError`
     * 为空 ⇒ 认为成功）⇒ 用户在冷帧点「关闭聚合供应商」，黑名单只写进 `auto` 一条，
     * `provider.setEnabled` 返回 `ok:true` / `changedCount:1`，而另外两个虚拟模型
     * **仍然可选**。改前它必然 2000ms 超时 ⇒ `remoteError` ⇒ 走拒绝分支，所以这是
     * **Task 7 重新打开**的 IKJW33 缺陷形态（该文件 `:6298` 的注释明文禁止它）。
     *
     * 同一份冷帧数据还让 `provider.status` 把 `closed` 从**安全方向**（`false`）
     * 翻成危险方向（`true`）—— 两个端点同一个根因，故判据只留**这一处**。
     *
     * ## 判据：**只认「从未成功推导过」**（`catalogAt === 0`）
     *
     * 这是「读到的是不是完整目录」唯一**权威**的本地事实：`catalogAt` 只由
     * `refreshCatalog` 在**跑完一轮逐渠道读取之后**写（与 `this.catalog` 同一处赋值，
     * 两者锁定），而冷帧下上游挂住时它**永远**是 0（那正是本次要防的形态）。
     *
     * ### ⚠️ 为什么**不**把另两个信号算进来（都试过，都会造成更坏的误判）
     *
     * | 候选判据 | 看起来能挡冷帧 | 实际后果 |
     * |---|---|---|
     * | `catalogRefreshInFlight` | ✅ 冷帧必在飞 | 也覆盖「TTL 过期后的稳态」：`listModels` 在目录**非空**时同样会起后台刷新 ⇒ 用户点「关闭聚合」被无故拒绝，而那次关闭本来是完全正确的（旧目录里的模型全都写进黑名单了，新增的由 `maintainProviderClosedState` 补写） |
     * | `catalog.length === 0` | ✅ 冷帧必为空 | 也覆盖「**所有渠道都未登录**」：此时聚合确实一个虚拟模型都没有，用户却再也关不掉聚合供应商（与 `provider.setEnabled` 注释里「无账号供应商永远关不掉」那条既有取舍直接冲突）；而且 `maintainProviderClosedState` 已保证「关掉后新长出来的模型会被自动补写」 |
     *
     * ⇒ 那些更严的判据换来的是**误报**（安全但不可用），而 `catalogAt === 0`
     * 精确命中「读到的必然残缺」这一种状态。
     *
     * ⚠️ 三个条件都只读本适配器自己的内存状态：**零网络、零 await** ⇒
     * `provider.status` 那些「常见路径零网络」的承诺不受影响。
     *
     * ⚠️ 不实现成 `describeCatalogHealth`：那是 cline 专用的「目录**来源**健康度」
     *    诊断（多外部站点拼装），语义与「有没有读到」不同，混用会让两件事的判据漂移。
     */
    catalogReadyForBulkWrite(): {
        ready: boolean;
        reason?: string;
    };
    /**
     * **模型选择器**里的展示名 = 规范名 + 倍率后缀（如 `GLM-5.3-Flash · 最低 x0.06`）。
     *
     * ## 为什么需要它（用户报障 2026-10-08）
     *
     * 用户原话：「没倍率显示？」—— 切到聚合后，选择器里每条虚拟模型**都没有倍率**，
     * 而同屏的普通渠道（`GLM-5.3-Flash · x0.06`）有。用户据此无法判断「聚合给我
     * 挑的是不是便宜的那个」，而本功能的全部卖点正是「省钱烧临期」。
     *
     * 根因：`nameOf` 只回规范名，而倍率其实**早就算好了** ——
     * `aggregate-catalog.ts` 的 `CandidateEntry.price` 就是 `priceFactorFromName(realName)`
     * 的结果，只是从没被展示层用过。
     *
     * ## ⚠️⚠️ 为什么文案是「**最低** x…」而不是直接 `· x…`（真实缺陷，复审实测）
     *
     * 初版取全局最小 `price` 并直接拼成 `· x0.03`，其注释推理是「轮换的**第二**判据
     * 是同临期档内倍率升序 ⇒ 最便宜候选最可能被选中」。**该推理在跨临期档时不成立**：
     * `rankCandidates` 的第一判据是**临期升序**，倍率只在**同档内**才起作用。
     * 复审实测（真实 `lib/aggregate-adapter.js` + 真实 `prepareCall`）：
     *
     * ```
     * 候选：buddy x0.29（临期 100，最早） / codearts x0.03（临期 900）
     * 选择器显示："DeepSeek V4.1 Flash · x0.03"   <-- 让用户以为会挑便宜的
     * 实际发往  ：["buddy"]                         <-- 实际挑的是最贵的
     * ```
     *
     * ⇒ 直接写 `x0.03` 会**误导用户**，与本 PR 自己在 `types.ts` 立下的判据
     *（「往静态名里写死倍率就是编造」）同型：显示的价与实际会用的价不符。
     *
     * ⚠️ 修法**不是**「按临期最早那档取最便宜候选」：`CandidateEntry` 里**没有**
     * `expiry`（临期是运行期由 `expiryProbe` 折算的，见 `aggregate-expiry.ts`），
     * 而本方法被 `listModels` / `listAllModels` 调用、**契约要求同步**
     *（`ModelCatalogSource` 的注释）⇒ 这里根本拿不到临期档。若为它改成异步或
     * 触发一轮余额查询，代价远大于收益（选择器渲染路径不能打网络）。
     * ⇒ 采用**如实表达下界**的口径：`最低 x0.03` 的语义是「这个虚拟模型下最便宜的
     * 可路由候选」，它**不声称**本次会选它 —— 用户据此仍能判断「值不值得选这个
     * 模型」，且不会被误导成「一定会用 0.03」。
     *
     * ⚠️ **不显示「区间」**（如 `x0.03–x0.29`）：那会变成最长行，而选择器是窄菜单
     *（与 `buddy-adapter.ts` 的「不写 `（促销 …）`」同一取舍）。
     *
     * ## 三条不显示倍率的规则（都是既有约定）
     *
     * 1. **全部候选都无标注**（`Infinity`）⇒ 不加后缀。直接拼会渲染出
     *    `xInfinity`，那是明显的渲染缺陷（`aggregate-panel-logic.js` 同款判据）。
     * 2. **`0` 显示「免费」**（本仓库既有口径，见 `candidateRowLabel`）。
     * 3. **解析不出就不猜**：宁可没有倍率，也不编一个（`buddy.ts` 同款理由：
     *    编造倍率比不显示更糟）。
     *
     * ⚠️ 只用于 `listModels` / `listAllModels`（选择器与设置页「显示列表」）。
     * **不得**用于 `resolveModel` / `describeCatalog` —— 见 {@link nameOf} 的注释。
     */
    private pickerNameOf;
    /**
     * 解析一个虚拟模型 —— **目录已有就用它；目录为空时立刻回保守元数据、绝不等待**。
     *
     * 目录**命中**时（热路径）的三条既有口径不变：
     * - `provider`/`id` 必须**按入参回填**（DSH 的 `normalizeModelInfo` 逐字校验，
     *   不符即 `INVALID_MODEL_INFO`）；
     * - `inputModalities` 恒含 `image`：聚合是整池，池里有能看图的渠道，如实声明；
     *   「这次选中的渠道收不收得了图」由分发阶段改道保证；
     * - **档位**声明规范化档位的并集（不是候选集交集，见 {@link aggregateReasoningInfo}）；
     * - **窗口**声明候选集的<u>最大值</u>（不是写死、也不是取小）——
     *   理由与失效形态见 {@link AggregateAdapter.contextWindowFor}。
     *
     * ## ⚠️⚠️ 为什么本方法**不得** `await ensureCatalog`（2026-10-18 复审 + 控制方实测）
     *
     * Task 7 把 `listModels` 改成「先返已知目录、读取转后台」后，排障日志里的
     * `listModels=` 那一格确实降到 1ms —— 但**总耗时仍是 7 秒级**。原因是 DSH 的
     * `buildModelCatalog`（`dsh-api-session-controller/lib/index.js`）的形状是：
     *
     * ```js
     * const models = await ctx.llm.listModels(provider.id)          // ← 1ms（Task 7）
     * const entries = await Promise.all(models.map(async (model) =>
     *   ctx.llm.resolveModelInfo(provider.id, model.id)))           // ← 7 秒全在这里
     * ```
     *
     * 而 `resolveModelInfo` 落到本方法，本方法原先首行就是 `await this.ensureCatalog()`
     * ⇒ 耗时只是从 `listModels=` 那格**搬到了总耗时那格**，用户感知**没有任何改善**。
     * 控制方实测：`listModels` 返回 `["auto"]` 用 1ms，`resolveModel` 仍跑满 407ms
     * （上游卡住时是 7 秒）。
     *
     * ⇒ 与 Task 6 的 `auto-adapter.ts:393` **同构**：目录命中就用；未命中立刻返回
     * 一份**保守元数据**并把读取转后台（复用 {@link startBackgroundCatalogRefresh}）。
     *
     * ## ⚠️ `prepareCall` 路径**不受影响**（发消息必须拿真实目录）
     *
     * `prepareCall` 自己在首行 `await this.ensureCatalog(signal)`（见该方法注释）——
     * 那条路径有 abort 铁律，必须拿到真实目录；本方法只负责**目录加载路径**的
     * 非阻塞。⚠️ 行为差异因此只落在「选择器首次渲染的能力元数据」上（真实代价如实
     * 登记：冷帧下窗口声明的是 {@link AGGREGATE_COLD_CONTEXT_WINDOW} 而不是候选集的
     * 最大值，档位暂不声明）。
     *
     * ## 保守元数据的三条「不撒谎」规则（见 {@link coldModelInfo}）
     *
     * 1. `provider`/`id` 按**入参**回填（DSH 逐字校验，否则 `INVALID_MODEL_INFO`）；
     * 2. **不声明 `reasoning`** —— 档位表要等目录落地才知道，此刻编一份等于替用户
     *    承诺一个可能不存在的档位；
     * 3. 窗口给一个**具名常量**（{@link AGGREGATE_COLD_CONTEXT_WINDOW}），不声称
     *    「目标模型的窗口是多少」。DSH 要求必须声明（`dsh-compaction-basic` 在
     *    `info.context === undefined` 时抛 `TargetPressureConfigError`）⇒ 不能省略。
     *
     * ## ⚠️ abort 语义不变
     *
     * 原先那条 `signal?.throwIfAborted()` 在 `refreshCatalog` 的首行；冷帧**不再进**
     * `refreshCatalog` ⇒ 必须在入口保留一次，否则「已取消的请求仍能拿到元数据」。
     * 热路径的取消仍由 `contextWindowFor` → `capabilityOf` 的
     * `signal?.throwIfAborted()` + `isAbortLike` 逃逸负责（未改动）。
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 与请求复用同一候选序和能力读取，按首选渠道的真实容量声明压缩预算。 */
    private contextFor;
    /**
     * **冷帧**（目录尚未推导出来）时 `resolveModel` 的保守元数据。
     *
     * ## ⚠️⚠️ 「保守」的三条硬约束：**可辨识、不撒谎、不编造**
     *
     * | 字段 | 冷帧给什么 | 为什么是这个 |
     * |---|---|---|
     * | `provider` / `id` | **按入参原样回填** | DSH 的 `normalizeModelInfo` 逐字校验；不符即 `INVALID_MODEL_INFO`（整个 provider 分组变成 failure） |
     * | `name` | 该虚拟模型的**规范化展示名** | 用与目录**同一份** `canonicalDisplayName` ⇒ 同一个模型在冷帧与热帧**同名**，不会出现「先是 `glm-5-3`、后是 `GLM-5.3`」的跳变 |
     * | `inputModalities` | `['text', 'image']` | 与热路径同口径：聚合是整池，池里有能看图的渠道；**真正能不能收图由分发阶段改道保证**（`dispatch` 的 `imageTargets`） |
     * | `context.contextWindow` | {@link AGGREGATE_COLD_CONTEXT_WINDOW} | DSH **强制**要求正整数（`dsh-compaction-basic` 在 `context === undefined` 时抛 `TargetPressureConfigError`）⇒ 不能省略；给一个**具名常量**且**不声称**它是目标模型的真实窗口 |
     * | `reasoning` | **不声明**（字段缺席） | 档位表要等目录落地才知道。编一份等于替用户承诺一个可能不存在的档位（`auto-adapter.ts` 的降级路径同一取舍） |
     * | `description` | **不给** | 同上：任何「目标是 xxx」的描述在冷帧都是编造 |
     *
     * ⚠️ **`auto` 与具名虚拟模型走同一份冷帧元数据**（只差 `name`）：冷帧时
     * `this.catalog` 是空的，`auto` 的候选池也就无从谈起 —— 此时若给 `auto` 一个
     * 更「丰富」的元数据，那只能是编的。
     *
     * ⚠️ **不要把本方法当成「永久降级」**：目录落地后（最长 60 秒 TTL，通常远短于
     * 一次选择器的打开时长）下一次 `resolveModel` 就走热路径，窗口与档位都变成真值。
     */
    private coldModelInfo;
    /**
     * `auto` 的候选池：所有虚拟模型的候选**并集**（按 `provider\0realId` 去重）。
     *
     * ⚠️ 与 `candidatesFor` 的 `auto` 分支同语义（那边还要叠加拒绝表过滤；本方法
     *    **不过滤拒绝** —— 窗口声明是「这个池里最大能到多少」，被拒的候选仍在池的
     *    物理能力范围内，且拒绝表随时可能被改回来）。
     * ⚠️ 去重是必要的：同一候选可能归属多个虚拟模型（如同一 realId 同时归入两个
     *    规范名），重复解析虽被 `capabilityCache` 吸收，但会让循环做无用功。
     */
    private autoCandidates;
    /**
     * 目录为空时先推导一次（避免 `prepareCall` / 面板在 `listModels` 之前被调用时找不到模型）。
     *
     * ⚠️⚠️ **必须接收并透传 `signal`**（真实缺陷，独立审计实测证伪）：
     *   本方法原先调 `this.refreshCatalog()` **不传 signal** ⇒ **真实请求路径**
     *  （`prepareCall` → 本方法）的中止**不生效** ——
     *   实测「取消于 50ms 仍跑满 312ms 的 `listModels` 才抛错」。
     *   此前只有 `describeCatalog`（面板路径）串了 signal，故 `refreshCatalog`
     *   自己的中止逃逸是对的，但**调用它的真实路径拿不到取消信号**。
     *
     * ⚠️ **2026-10-18 起本方法不再是 `resolveModel` 的调用方**（那会让目录加载
     *    路径同步等上游 7 秒，见 `resolveModel` 的方法头）。现在的调用方只有
     *    **发消息**与**面板**两条路径 —— 它们都**必须**拿到真实目录，故仍同步等待。
     */
    private ensureCatalog;
    /** 当前的临期探针：注入优先，否则保守返回 UNUSABLE。 */
    private expiryProbe;
    /**
     * 绑定「本次候选序」到一次分发。
     *
     * ⚠️ 候选序必须在**这里**算好（`prepareCall` 是异步的）：返回的 `stream` 闭包
     * 契约是**同步返回 AsyncIterable**（`PreparedAdapterCall`），闭包里拿不到
     * `await` 的机会 ⇒ 临期折算、档位表都得在这之前备齐。
     */
    prepareCall(_provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 构造本次请求的候选序（临期升序 → 倍率升序），并备好每条的档位表。
     *
     * ⚠️ **带按虚拟模型的 TTL 缓存**（规格 §9）—— 否则每次 `prepareCall` 都要对每个
     * 候选渠道重跑一次上游余额查询（见 {@link choiceCache} 的长注释）。
     */
    private candidatesFor;
    /**
     * 逐个候选问账号池「该候选**自己的模型**上还有可用账号吗」。
     *
     * ## ⚠️⚠️ 为什么返回**映射**而不是「过滤后的数组」（真实缺陷，对抗审计实测证伪）
     *
     * 我上一版返回「过滤后的数组」，调用方拿它去折算临期 —— 但**建池时每个候选的
     * `expiry` 初值是 `NEVER`**，而 `rankCandidates`（`aggregate-core.ts`）
     * **只剔除 `UNUSABLE`**（`NEVER` 是合法排序值：「可用、只是不临期」）。
     * ⇒ 被过滤掉的候选 `expiry` 仍是 `NEVER`，**照样进入候选序**、只是排最后；
     * 当前面的候选失败时**回落到它**（`targets` 逐个尝试）。
     *
     * 实测：buddy 可用 + codearts 在该模型上额度已尽 ⇒ 候选序 `[buddy, codearts]`，
     * buddy 失败后请求**发往 codearts** —— 缺陷只是被推迟而非消除。
     *
     * ⇒ 必须让调用方**显式把 `expiry` 置 `UNUSABLE`**（那才是 `rankCandidates` 读的字段）。
     * 返回映射就是为了让「谁不可用」这个事实能落到调用方的赋值上。
     *
     * ## ⚠️⚠️ 为什么必须按 `realId` 复核，不能只靠临期折算
     *
     * 各 provider 的「额度耗尽」是按 **modelId** 记账的：
     * `AccountPool.getAvailableAccount` / `listAvailableCredentials` 都按
     * `entry.modelRateLimits[modelId]` 过滤候选（`account-pool.ts`），
     * 而 codearts 的 benefit（免费额度）耗尽正是写进那里的
     * （`llm-adapter.ts` 的三处 `updateModelRateLimit` 调用）。
     *
     * 但 `createExpiryProbe` 取号时用的模型键是**该渠道目录的第一个模型**
     * （`src/index.ts` 的 `firstModelIdOf`：`models[0]?.id`），而**聚合层要派发的是
     * 候选自己的 `realId`** —— 两者常常不是同一个模型（一个虚拟模型会挂多渠道多模型的
     * 候选表）。于是：
     *
     * | 场景 | 探测用的键 | 实际派发 | `modelRateLimits` 过滤 | 结果 |
     * |---|---|---|---|---|
     * | auto | `firstModelOf`（= 实际派发） | 同一个 | ✓ 生效 | 已覆盖 |
     * | **aggregate** | `models[0]` | **候选 `realId`** | ✗ **失效** | **缺口可达** |
     *
     * ## 返回值
     *
     * `Map<候选, 是否有可用账号>`：`false` = 明确查到「该模型上无可用账号」；
     * `true` = 有可用账号 / 池未实现该方法 / 查询异常（后两者是**保留**的取舍）。
     * ⚠️ 用 `Map` 而非 `Set` 是为了让「查过且为真」与「没查」在类型上可区分 ——
     * 虽然调用方按 `=== false` 判据处理，两者等价。
     *
     * ## 取舍
     *
     * - ⚠️ **只在池实现了 `getAvailableAccount` 时过滤**：它是既有 API，但大量单测桩
     *   只实现了 `disabledModelsFor`（见 `{@link refreshCatalog}` 的注释）。缺失时**跳过过滤**而不是
     *   判成不可用 —— 宁可少筛一层，不可把整池误剔除（与 `aggregate-expiry.ts` 对
     *   `listAvailableCredentials` 缺失时的降级同一取向）。
     * - ⚠️ 查询失败（抛错）时**保留该候选**：一次池查询异常不该让渠道整体消失。
     * - ⚠️ **中止必须原样逃逸**（与 `candidatesFor` / `capabilityOf` 同一口径，
     *   本仓库已在该缺陷上复发三次）。
     */
    private availableByModel;
    /**
     * 取目标模型的**三项**能力：**上下文窗口**、**思考档位 id**、**是否收得了图片**。
     *
     * ⚠️ 三项**共用同一次 `resolveModelInfo` 调用** —— 不额外发请求。这是把窗口与
     * 图片能力做成「顺带取回」而不是「另查一遍」的原因（选型路径上每次请求都会走这里，
     * 多一次解析就是多一次上游交互）。
     *
     * ⚠️ 失败时按**保守**方向回落：窗口 `undefined`（不编造，由调用方兜底）、
     * 档位为空（不下发该字段）、图片为 `false`（不把它当带图候选）。
     * 理由见 {@link DispatchTarget.imageCapable} 与 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW}。
     *
     * ⚠️ **成功的解析结果进 {@link capabilityCache}**（见那里的长注释：失败**不**缓存）。
     *
     * ⚠️⚠️ **每次解析都有独立预算**（{@link AGGREGATE_CAPABILITY_TIMEOUT_MS}，默认 3 秒）。
     * 没有它时，候选池里一个在 DNS/TCP 层挂住的渠道（实测 `autoclaw` 的目录端点
     * ETIMEDOUT 21.6 秒，它自己的 8 秒 `AbortController` 管不到）会让**每一轮**请求
     * 都白等一次；`buildModelCatalog` 又会把它乘以虚拟模型数。见常量处的实测数据。
     */
    private capabilityOf;
    /**
     * {@link capabilityOf} 的**单次**解析体（在飞合并的实际执行部分）。
     *
     * ⚠️ 抽出来是为了让「在飞合并」只包一层：`capabilityOf` 负责查两张缓存 + 登记/清除在飞表，本方法只做「问一次 + 折算」。
     */
    private resolveCapability;
    /**
     * 带**独立预算**的 `resolveModelInfo`。
     *
     * ## ⚠️ 为什么不能用 `AbortSignal.timeout` 单独了事
     *
     * 超时后必须**区分**「预算用尽」与「调用方中止」：前者按「这个候选暂时问不出来」
     * 处理（保守回落 + 记失败短缓存），后者必须原样抛出 `AbortError`（否则用户取消
     * 后整轮还在跑）。故这里自己造一个 `controller`，超时时抛一个**名字可辨识**的
     * 哨兵错误，由 {@link capabilityOf} 的 catch 分支按 `isAbortLike` 区分。
     *
     * ⚠️ 与 {@link withBackgroundDeadline} 同一口径：**放弃等待 ≠ 取消**。
     * `resolveModelInfo` 会透传 `signal` 给各适配器，故这里额外把预算信号
     * `AbortSignal.any([signal, budget])` 传下去 —— 预算到期时底层请求能被打断的
     * 部分会被打断；打不断的（DNS 解析、TCP 建连）由我们这边**不再等**兜住。
     *
     * ⚠️ 定时器必须 `unref()`（与 `withBackgroundDeadline` 同约定）：宿主常驻进程里
     * 一个 pending 的 3 秒定时器不该拖住退出。
     */
    private resolveWithBudget;
    /**
     * 该虚拟模型的**上下文窗口声明值**：**候选集的最大值**。
     *
     * ## 口径（设计文档 §4.1「ctx / 图片 / 档位取候选集的能力并集」）
     *
     * 取**最大值**而不是最小值/交集，理由与档位取并集同源：
     *
     * - 声明的窗口是给**宿主**看的（压缩阈值 + 占用指示器），而一次请求实际发往
     *   哪个候选**在声明时还没定**（`prepareCall` 是发起请求之前就返回元数据的）。
     *   取最小值意味着「池里有一条 262144 的候选，就把整池按 262144 声明」——
     *   用户明明在用 1M 的渠道，界面与压缩却按最小的那条算，与本条报障同类；
     * - 取最大值后，若某次真的切到了窗口更小的候选，**由既有的失败切换兜住**
     *   （上游报超长 → 换下一个候选重试）。代价是可能白跑一轮，而最小值口径的
     *   代价是**每一次**请求都被按最小窗口过早压缩 —— 后者持续存在，前者只在
     *   恰好选中小窗口候选时发生。
     *
     * ⚠️ **一个候选的窗口都取不到时**（渠道全部未登录 / 该渠道的 `resolveModel`
     * 不声明窗口）回落到 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW} —— 不能返回
     * `undefined`，`dsh-compaction-basic` 会抛 `TargetPressureConfigError`。
     *
     * ⚠️ 本方法**不做任何余额探测**（`resolveModel` 会被 `buildModelCatalog` 对
     * 目录里每个模型各调一次），只是读/填能力缓存。
     *
     * ⚠️ **取不到窗口的候选也进入循环**：它不拉低结果，但要为它解析一次能力 ——
     * 解析结果会进缓存，供同一候选在派发路径上复用。
     *
     * ## ⚠️⚠️ 退化判决也记忆化，但只活 30 秒（2026-10-20 用户报障后改）
     *
     * 原实现是「只有**每一个**候选都解析成功时才记忆化」。那条判据的**动机是对的**
     * （不能把瞬时故障固化成持续状态 —— `AGENTS.md` 的「`refreshable` 单向门」），
     * 但**手段过强**：候选池里只要有一个渠道持续故障，本方法就**永不**写缓存，
     * 于是每一轮请求、每一次 `buildModelCatalog` 都要把全部候选重新解析一遍。
     *
     * 实测（`aggregate/deepseek-v4-1-flash`，候选 13 家，其中 `autoclaw` 的目录端点
     * 在 DNS/TCP 层 ETIMEDOUT 21.6 秒）：
     *
     * ```
     * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
     * contextWindowCache 命中? ★否 —— 永不记忆化
     * ```
     *
     * 用户侧的观感是「每次发消息先白等 60 多秒」，而同模型直连 `workbuddy` 只有 0.8 秒。
     *
     * ⇒ 现行口径：**退化判决照样写缓存**，但打上 `degraded` 标记，有效期只有
     * {@link AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS}（30 秒，目录 TTL 的一半）。
     * 这样既不再每轮重试坏候选，又能在上游恢复后最迟 30 秒自动纠正 ——
     * 「不固化瞬时故障」这条**约束**仍然成立，只是把「永不缓存」换成了「缓存很短」。
     * ⚠️⚠️ **退化期间声明的窗口方向是「可能偏大」，不是「偏保守」**（2026-10-20
     * 对抗审计实测证伪）：
     *
     * | 情形 | 声明值 | 与真实窗口比 | 后果 |
     * |---|---|---|---|
     * | 有候选解析成功 | 已成功那部分的最大值 | **≤** 真实最大值 | 保守（提前压缩） |
     * | **全部候选都失败** | `AGGREGATE_FALLBACK_CONTEXT_WINDOW`（200_000） | 可能 **>** 真实值 | **偏大** ⇒ 压缩阈值推后 ⇒ 上游 `CONTEXT_WINDOW_EXCEEDED` |
     *
     * 实测：唯一候选真实窗口 131_072（128K）而解析失败 ⇒ 声明 **200_000**（大 52%）。
     * 同文件的**冷帧**常量 `AGGREGATE_COLD_CONTEXT_WINDOW`=131_072 才是真保守 ⇒
     * 两个「保守兜底」方向相反（该取值是**既有行为**，master 上同样是 200_000，
     * 不是本 PR 引入；本 PR 引入的只是那句写错方向的注释）。
     *
     * ⚠️ 完整判决（全部候选都解析成功）的有效期跟目录 TTL 走，因为它由
     * {@link refreshCatalog} 重建目录时统一清空兜住。
     *
     * @param modelKey - 虚拟模型 id（含 `auto`），仅用于记忆化。
     * @param candidates - 该虚拟模型的候选表（`auto` 传全池候选）。
     */
    private contextWindowFor;
    /**
     * 按候选序**逐个尝试**，成功即返回；全部失败则抛最后一个错误。
     *
     * ## 为什么必须自己实现失败切换
     *
     * DSH 层没有跨 provider 重试：`dsh-llm-retry` 的 `retryStateKey(provider, policyKey)`
     * 只重试**同一** provider/model。故跨渠道切换只能在这里做。
     *
     * ## 为什么 `catch` 要包在**迭代过程**外层
     *
     * 生产路径只走 `prepareCall` 返回的 `call.stream`，而真实错误发生在**迭代
     * 过程中**（dsh-llm 的 `iterator.next()`），不是 `prepareCall` 自己抛的
     * ⇒ `try` 必须包住 `for await`。
     *
     * ## ⚠️⚠️ 只在「一个 chunk 都还没产出」时才能切换（本实现的关键约束）
     *
     * 已 `yield` 出去的内容**收不回来**。若某个候选先吐了「答案是……」然后中途失败，
     * 我们再切到下一个候选，用户看到的是：
     *
     * ```
     * 答案是……答案是 42。
     *      ↑ A 的半截        ↑ B 的完整答案
     * ```
     *
     * 这是**两段拼接的畸形回答**，比「半截 + 报错」严重得多 —— 前者看起来像一句
     * 正常但奇怪的话，用户会当成模型的问题；后者至少明确告诉用户失败了。
     * 本仓库对「静默降级」有明确红线（反复修过的那类缺陷），而拼接畸形内容更甚。
     *
     * ⇒ 规则：**该候选只要产出过「可见内容」，其后任何失败都直接向上抛**，不再尝试下一个。
     * 「切换」只发生在「尚未产出任何可见内容」的失败上（连接失败、认证失败、上游立刻
     * 返回错误 —— 这些恰好是跨渠道切换真正有价值的情形）。
     *
     * ## ⚠️ 为什么判据是「可见内容」而不是「任何 chunk」（Task 6 复审 M23）
     *
     * 初版用「产出过任何 chunk」作判据，于是候选**只吐了 `block-start` / `usage`
     * 这类元数据帧**就失败时，也会放弃切换 —— 那是**过度保守**，白白丢掉一次
     * 本可成功的切换机会。
     *
     * 而只产出元数据帧时切换是**安全**的（实测 `BlockAssembler` 的语义）：
     * - `block-start` 是**幂等**的（`if (!this.partials.has(chunk.index))`）——
     *   下一个候选重发同 index 的 `block-start` 不会产生重复块；
     * - `usage` 是**覆盖**语义（`this._usage = chunk.usage`）—— 后到的会顶掉前一个；
     * - 两者都**不含用户可见的正文**。
     *
     * ⇒ 判据：只有 `text` / `reasoning` / `image` / `tool-call` / `tool-result`
     * 以及 `*-delta` / `block-end` 算「可见内容」；`block-start` 与 `usage` 不算。
     * ⚠️ 未知类型一律**算可见内容**（保守方向：宁可少切换，不可拼接畸形回答）。
     *
     * ## 档位必须逐候选翻译
     *
     * 请求里的 `reasoningEffort` 来自**上一次对话**，可能带着别的模型族的档位名
     * （如给只声明 `enabled` 的模型发 `xhigh`）。原样转发会被 DSH 按 id 严格校验
     * 拦下 `UNSUPPORTED_REASONING_EFFORT`。故复用仓库既有的
     * {@link translateReasoningEffort}：不可表达时**不下发该字段**而非抛错。
     */
    private dispatch;
    /** 把请求转发给一个候选，按目标档位表翻译 `reasoningEffort`。 */
    private streamThrough;
    /** 从不直接被 stream（总是先经 prepareCall）；兜底抛错而非静默。 */
    stream(): AsyncIterable<StreamChunk>;
}
/**
 * 候选循环的**尝试上限**。
 *
 * ⚠️ **不得写死常量**（issue 明确记录：那个参数在 contributor 的实现里调整过 4 次
 * 才固化）。写死一个偏小的值会让**末位候选永远轮不到** —— 等于「加了渠道但没生效」。
 */
export declare function maxAttemptsFor(models: readonly VirtualModel[]): number;
/**
 * 聚合模型的**档位声明** —— 规范化档位的**并集**（不是候选集交集）。
 *
 * ## 为什么是并集而不是交集（真实数据修正）
 *
 * 初版设计写的是「取候选集的能力交集」。**该口径在真实数据下是错的**：各渠道的
 * 档位命名空间彼此几乎不相交 ——
 *
 * | 渠道 | 档位 id |
 * |---|---|
 * | codearts | `off` / `on`（只有开关，声明顺序即强度序；注释明确「不臆造强度阶梯」） |
 * | buddy / workbuddy | `low` / `high` / `max`（**逐模型不同**） |
 * | zcode | `low` / `high` / `max` |
 * | loomy | `none` / `low` / `medium` / `high` / `xhigh` |
 * | trae | `light` / `high` / `extra_high`（**私有名**） |
 * | lobsterai | `off` / `high` / `xhigh` |
 * | raccoon | `off` / `on`（同 codearts，强度序） |
 *
 * `deepseek-v4.1-flash` 跨 buddy + codearts + cline ⇒ **交集为空**。而空档位的后果
 * 本仓库有明确记录（`opencode-adapter.ts`：「档位为空时**不声明**本字段，声明空数组
 * 会让 UI 出现一个没有任何档位的空选择器」）⇒ 取交集会让**聚合模型的档位选择器
 * 全部消失**，与本功能目标相反。
 *
 * ⇒ 声明规范化并集，转发时由 `translateReasoningEffort` 逐候选翻译（Task 6）：
 * `exact` 原样、`mapped` 就近同族（同距取更强）、`unexpressible`/`unknown` 时
 * **不下发该字段**让上游走自己的默认。
 *
 * ## 展示名用官方中文
 *
 * DSH 客户端**直接渲染 `efforts[].name`**（不本地化、不查字典）⇒ 必须给中文。
 * 权威来源是 Qoder IDE 的 i18n 词条（`qoder-product.ts` 有逐字记录）：
 * `none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`。
 *
 * ⚠️ `unknown` 档位（`CANONICAL_REASONING_EFFORTS` 里没有的）**回退为 id 本身** ——
 * 宁可显示英文原值，也不猜一个可能错译的中文（与 `opencode-adapter` 同取向）。
 */
export declare function aggregateReasoningInfo(): LlmModelReasoningInfo;
/**
 * 该错误是否是「调用方中止」类，而不是「这个候选坏了」类。
 *
 * ⚠️ 两者**必须分开**：中止时换候选会让用户在取消后仍继续跑（且最终抛出的
 * 可能是个误导性的上游错误）。判据取四条：
 * - `signal.aborted` —— 最权威（调用方确实取消了）；
 * - `name === 'AbortError'` —— `throwIfAborted` / `timers/promises` 的形态；
 * - `code === 'ABORTED'` —— 某些适配器上报失败时的机器码；
 * - 🔴 `message` 含 `aborted request` / `HTTP_499` / `HTTP 499` —— **上游网关的
 *   499 口径**（nginx「client closed request」＝ 连接在响应完成前被断开）。
 *   实测（2026-10-11，本会话两次 + 工单 `raccoon-499/01` 取证）：raccoon 网关把
 *   这类断开报成 `provider: client has aborted request HTTP_499` 的 **error 帧**，
 *   三条旧判据全不命中 ⇒ 被归成「本轮运行失败」⇒ 消费者看到误导性的 provider
 *   故障，而真相是「请求没跑完，重发即可」。归 aborted 的语义收益：终端不再
 *   显示「运行失败」，且外层不把它当「候选坏了」去改道（重发是新请求，不是换候选）。
 * ⚠️ **本函数是共享判据**（2026-10-15 导出）：装配层与 `balance-cache` 都应当用它，
 *    而不是各写一份 —— 本仓库此前已有 **4 份**同义实现（本文件、`aggregate-expiry.ts`
 *    的简化版、`auto-adapter.ts`、`raccoon-adapter.ts` 的内联），别再添第五份。
 */
export declare function isAbortLike(error: unknown, signal?: AbortSignal): boolean;
/** 在 `ctx.llm` 上注册聚合路由（幂等）。 */
export declare function registerAggregateLlm(ctx: Context, options: AggregateAdapterOptions): AggregateAdapter;
//# sourceMappingURL=aggregate-adapter.d.ts.map