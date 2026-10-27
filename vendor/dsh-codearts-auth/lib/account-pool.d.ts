import { Context } from '@deepseek-ai/cordis';
import type { BuddyCredential } from './buddy.js';
import type { BuddyProduct } from './product.js';
import type { AggregateAllowedMap, AggregateOrderMap, AggregateOrderMode, AggregateRejectionMap, JetHubState, ModelDisableMap, PermanentLockMap } from './jet-hub-store.js';
import type { CodeArtsCredential, ProviderAccountEntry, ProviderAccountStatus } from './types.js';
export { JET_HUB_NS } from './jet-hub-store.js';
export type { ModelDisableMap, ProviderClosedMap } from './jet-hub-store.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        accountPool: AccountPool;
    }
}
/**
 * 判定「某 provider 的启用账号是否**全部**因目标模型处于限流期」。
 *
 * ## 为什么需要它
 *
 *
 * 选号按 `modelRateLimits[modelId]` 过滤候选（见本类的 `getAvailableAccount`
 * 与 `src/credential-resolver.ts` 的候选筛）。当一个 provider 只有**一个**
 * 启用账号、而它恰好被标记了该模型的限流时，候选集变成空集，调用链一路
 * 返回 `undefined`，最终由适配器抛出「no usable credential; log in from the
 * Jet Hub panel first」—— 而**凭据其实是好的、账号也是启用的**，用户被指去
 * 重新登录，方向完全错。
 *
 * 本函数把这种情形**证明**出来：返回非 `undefined` 即表示「这批账号全都因
 * 该模型受限」，调用方据此报带解禁时刻的明确错误。
 *
 * ⚠️ **判据必须窄**，两条边界都不能松：
 * - 空 `modelId`（未知目标模型）直接返回 `undefined` —— 与选号侧约定一致
 *   （空 modelId 不做限流过滤），否则会把「未登录」误报成「限流」。
 *   这条**不是**冗余守卫：`updateModelRateLimit` 不校验 modelId，理论上可能
 *   落下一个 `modelRateLimits['']` 脏键，没有它就会被当成真实限流上报；
 * - 只要**任一**账号没有该模型的未过期标记，整体即不成立 —— 那种情况下
 *   候选本就非空，轮不到本函数说话。
 *
 * ℹ️ 空 `accounts` 无需单独早退：循环不执行 → `earliest` 保持 `undefined`
 * → 末尾守卫返回 `undefined`。（曾写过一条 `accounts.length === 0` 早退，
 * 反向验证证明它**不可区分**、纯冗余，故删除。）
 *
 * @param accounts - 该 provider 的**启用**账号（调用方负责按 `enabled` 过滤）。
 * @param modelId - 目标模型 id；空串表示不判定。
 * @param now - 当前时刻（毫秒），供测试注入。
 * @returns 最早的解禁时刻与账号数；不满足条件时为 `undefined`。
 */
export declare function allAccountsRateLimitedForModel(accounts: readonly ProviderAccountEntry[], modelId: string, now?: number): {
    resetAtMs: number;
    accountCount: number;
} | undefined;
/**
 * 「限额账号自动沉底」的开关环境变量。
 *
 * 默认**开启**（用户 2026-10 的明确要求）。留这道逃生门是因为它改变了
 * 账号顺序的语义：用户手拖出来的顺序会被系统改写。若有人依赖「首位账号
 * 永远优先」的旧行为（例如想让某个额度充足的号一直扛），把它设为 `0` 即可
 * 退回纯手动顺序。
 */
export declare const DSH_RATE_LIMIT_SINK = "DSH_RATE_LIMIT_SINK";
/**
 * 当前是否启用「限额沉底」。
 *
 * ⚠️ **不能写成 `Boolean(env[...])` 之类的 falsy 判据**：本开关的**默认值是
 * 开启**，而「未设置」与「显式关闭」必须区分开 —— `Boolean(undefined)` 与
 * `Boolean('0')` 都为 false，会把默认开启变成默认关闭（与 Qoder 排队超时、
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 那几个坑同型）。
 *
 * 判据取「显式写了 `0` / `false` / `off` / `no` 才算关」，其余（含未设置、
 * 空串、无法识别的值）一律按默认开启。
 */
export declare function rateLimitSinkEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * 把「目标账号」移动到本 provider 的**最末尾**（限额沉底）。
 *
 * ## 为什么需要它（用户报障的根因）
 *
 * 取号永远是「服务端顺序里**第一个**可用账号」（见 `getAvailableAccount`）。
 * 于是只要 1 号账号没撞限额，**全部流量都压在它身上**；等它撞了限额，2 号才
 * 顶上；而等 1 号解禁，它又**排在最前面被立刻捡回去**，2 号重新闲置。
 *
 * 后果正是用户报障的原话：*「每次都轮不完，等限额号好了因为排在前面又开始
 * 用刚好的限额号了，后面的号的额度就白白过期了」* —— 每个账号的额度都有
 * 使用期限（资源包的 `DeductionEndTime`），轮不到就真的作废。
 *
 * 故「限额即沉底」的真正价值**不在受限期间**（受限账号本来就被选号过滤掉），
 * 而在**解禁之后**：它留在末尾，不会再抢回首位，后面的号因此轮到使用。
 *
 * ## 为什么必须持久化（不能只在内存里排）
 *
 * 沉底若不写盘，重启/刷新后顺序回到原位，解禁账号又会插回最前 —— 等于没做。
 * 因此它写在**权威的服务端顺序**里（与用户拖拽的 `reorderAccounts` 同一份）。
 *
 * ## 槽位约定（与 `reorderAccounts` 完全一致）
 *
 * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分）。
 * 这里取「该 provider 原本占用的那些下标」，把新顺序（其余账号保持原相对
 * 顺序、目标账号排到最后）填回这些下标 —— **其它 provider 的账号绝对位置
 * 完全不变**。不这么做（例如整体挪到数组尾部）会让拖拽 buddy 顺带改变
 * CodeArts 账号的位置，属于跨面板的意外副作用。
 *
 * @param accounts - 当前账号列表（服务端顺序）。
 * @param accountId - 要沉底的账号 id。
 * @returns 新数组；无需变更（账号不存在 / 已在本 provider 末位）时返回 `null`。
 */
export declare function sinkAccountToProviderEnd(accounts: readonly ProviderAccountEntry[], accountId: string): ProviderAccountEntry[] | null;
/**
 * AccountPool —— 多账号管理核心
 *
 * 职责：
 * - 账号列表 CRUD（索引走 {@link JetHubStore}，凭据存于 ctx.credentials，
 *   两者各自独立）
 * - 获取指定 provider + 模型的下一个可用账号
 *   算法：enabled=true 且模型不在重置期内 → 取第一个
 * - 更新模型重置时间（收到限流错误后调用）
 *
 * 持久化后端按 DSH 版本能力探测（见 `src/jet-hub-store.ts`）：0.1.7 起
 * `ctx.settings` 不再允许插件注册 namespace，故改用插件自有状态文档；
 * 两者都不可用时退化为内存态，保证不抛错。
 */
/**
 * 把池里的代理字段读成**字符串**（**读取侧的唯一收口**）。
 *
 * ## ⚠️ 为什么必须有它（实测的真缺陷，独立于 IKLTZ2 审计发现）
 *
 * `opencodeProxy` / `geminiProxy` 都来自**用户可编辑的备份文件**，而
 * `sanitizeAccounts`（`src/jet-hub-store.ts`）用 `{ ...candidate }` 原样透传、
 * **不校验这两个字段的形状**（对照 `modelRateLimits`：那个已由 `isValidResetAtMs`
 * 加固）。于是池里可能存在 `"geminiProxy": 12345`。
 *
 * 下游 `normalizeProxy`（`src/opencode.ts`）第一句就是 `input.trim()` ⇒
 * 非字符串会在那里抛 `TypeError: raw.trim is not a function`：
 *
 * - 该账号**永久不可用**（每次请求都抛，且没有自愈路径）；
 * - 症状与「代理配错了」同形，排障者会去看代理配置，而真因是备份里的脏数据。
 *
 * 实测（本机，IKLTZ2 修复期间）：`sanitizeAccounts` 原样透传 `12345`，
 * 解析器随即抛 `raw.trim is not a function`。
 *
 * ## ⚠️ 为什么「读侧兜底」而不是「写侧过滤」
 *
 * 写侧过滤（`sanitizeAccounts` 里丢弃非法值）更彻底，但它是**全仓共享**的清洗
 * 函数，改动会影响十家 provider 的条目落库形态。本函数是**代理专属**的收口，
 * 影响面精确到两个读方法。
 *
 * ⚠️ **刻意不删键、不改盘**：读侧只保证「不崩、行为确定」—— 脏值视为「未配置」
 * （= 直连）是最保守的降级，用户仍可在面板里重新配一次把它覆盖掉。
 *
 * @param value 池字段原始值（可能是任意 JSON 值）。
 * @returns 字符串原值；非字符串（含 `undefined` / 数字 / 对象 / 数组）一律回退空串。
 */
export declare function asProxyText(value: unknown): string;
export declare class AccountPool {
    private readonly ctx;
    private readonly options;
    /** 持久化后端；两个后端都不可用时是仅内存实现。 */
    private readonly store;
    /**
     * 账号列表的**权威进程内副本**。
     *
     * 不直接把后端的读取结果当读源：后端的落盘快照在写入后未必立即反映到
     * 下一次读取，而本类的每次写入都是「读 → 改 → 整体写回」。
     * 若以滞后快照为读源，并发/连续的 updateModelRateLimit 会互相覆盖
     * （典型表现：多个账号触发限流后，落盘文档里一条 modelRateLimits
     * 都没有）。因此首次载入后，这份副本即为唯一读源。
     */
    private cache;
    /**
     * 模型黑名单的**权威进程内副本**（与 {@link cache} 同理：载入一次后即以
     * 本副本为准）。
     */
    private modelCache;
    /**
     * **供应商关闭意图**的权威进程内副本（Gitee issue IKP8OF）。
     *
     * ⚠️ 与 {@link modelCache} **语义不同、不可合并**：黑名单是「这个模型被关着」，
     * 本表是「用户要求这个**供应商**整体关着」。二者由 {@link disabledModelsFor}
     * 双腿取或后对消费者**同形**（都表现为「这些 id 不可调用」），但判据与生命周期
     * 完全不同：黑名单会被逐条打开，而本表只在「打开整个供应商」时才清除。
     *
     * 详见 `jet-hub-store.ts` 的 `ProviderClosedMap` 注释（含为什么它**不能**
     * 单独充当 `provider.status.closed` 的权威）。
     */
    private providerClosedCache;
    /**
     * 聚合「拒绝轮换」表的**权威进程内副本**（与 {@link cache} / {@link modelCache} 同理）。
     *
     * ⚠️ 与 {@link modelCache} **语义不同、不可合并**：黑名单是「关闭这个模型」（它从
     * 模型选择器消失），本表是「这一条候选不参与该虚拟模型的轮换」（模型仍在目录里）。
     * 详见 `AggregateRejectionMap` 的注释。
     */
    private aggregateRejectionCache;
    /**
     * 聚合「**显式允许**参与轮换」白名单的权威进程内副本。
     *
     * ⚠️ 与 {@link aggregateRejectionCache} **各有各的域、不做归一**（用户 2026-10-15 的修正）：
     * 已接入临期折算的候选只归**拒绝表**（黑名单语义：默认参与），未接入的只归**白名单**
     *（默认不参与，「参与」才需显式记录）。两表的键域由渠道级的「是否接入折算」划分 ⇒
     * **天然不相交** ⇒ 写一侧**不得**改另一侧。
     * 详见 `jet-hub-store.ts` 的 `AggregateAllowedMap` 注释。
     */
    private aggregateAllowedCache;
    /**
     * 聚合「手工排序」表的权威进程内副本。
     *
     * ⚠️ 缺键 / 空数组 = 未自定义（与 {@link providerOrderCache} 同语义）：
     * 展示与轮换都回落临期序。
     */
    private aggregateOrderCache;
    /**
     * 聚合候选的排序模式（缺省 `'expiry'` = 升级前行为）。
     *
     * ⚠️ 它不是「有没有手工顺序表」的派生量：用户可能切到手工模式但一条都没拖过
     *（此时行为与临期模式相同，但面板要显示「按手工」）。
     */
    private aggregateOrderModeCache;
    /**
     * 「锁定永久积分」开关表的**权威进程内副本**（与 {@link cache} 同理）。
     *
     * ⚠️ 每个 provider 一项（Loomy / CodeBuddy / WorkBuddy 各自独立），
     * **只记录已锁定的**（缺键 = 未锁定）。
     *
     * ⚠️ 它的落盘位置与账号池**不是同一份文档**：住在
     * `$DSH_HOME/jet-hub/permanent-locks.json`，因为 state.json 是同机多 profile
     * 共享的文档，而另一条工作区里的旧版本代码全量重写它时**不会携带自己不认识
     * 的键** —— 放那儿会被静默抹掉，解锁的后果是真把永久积分烧掉。
     * 详见 `src/permanent-lock-store.ts` 的文件头。
     */
    private permanentLockCache;
    /**
     * 「本机 OpenAI 网关」开关的进程内副本。
     *
     * 缺键语义是**启用**（与 `jet-hub-store.ts` 的 `sanitizeGatewayEnabled`
     * 同一方向）：老用户升级后网关行为与升级前完全一致，不会被静默关掉。
     *
     * ⚠️ 与 {@link permanentLockCache} 不同，它**不需要**独立文档：丢失本键
     * 的唯一后果是回到默认启用，用户再关一次即可。
     */
    private gatewayEnabledCache;
    /**
     * 「渠道原生搜索」总开关的进程内副本（`false` = 全部搜索回官方 provider）。
     *
     * 缺键语义是**启用**（与 {@link gatewayEnabledCache} 同一方向）：老文档没有
     * 本键时保持原生搜索，不会因读取失败而静默改走官方（那会让搜索突然开始
     * 要 API Key，用户看不出是自己关过还是坏了）。
     *
     * ⚠️ 与 {@link gatewayEnabledCache} 同级、**不需要**独立文档：丢失本键的
     * 唯一后果是回到原生搜索，用户再关一次即可。
     */
    private nativeWebSearchCache;
    /**
     * 供应商自定义显示顺序（「供应商开关」弹窗拖拽排序）的进程内副本。
     *
     * ⚠️ 与 {@link gatewayEnabledCache} 同级、**不需要**独立文档：丢失本键的
     * 唯一后果是顺序回到声明顺序，用户重新拖一次即可（纯展示偏好，可逆）。
     * 数组语义见 `jet-hub-store.ts` 的 `JetHubState.providerOrder`。
     */
    private providerOrderCache;
    /**
     * MiniMax **国际站**绕过分流用的 `X-Forwarded-For` 值（进程内副本）。
     *
     * 语义与校验见 `jet-hub-store.ts` 的 `JetHubState.minimaxXff` 与
     * `sanitizeMinimaxXff`（**同一份判据**，本文件不另写一份）。
     *
     * ⚠️ `undefined` / 空串 = **不附头**（行为与修复前逐字节一致）。这是刻意的
     * 缺省：附 `X-Forwarded-For` 等于声明一个并非本机的来源 IP，不能是默认行为。
     *
     * ⚠️ 与 {@link providerOrderCache} 同级、**可以**住在这里：丢失本键的唯一后果
     * 是国际站用户重新遇到 307（可逆，重填一次即可）。但它**必须**被带进
     * `queueStoreSave` 的整体写入（否则「任何一次改账号都会静默清掉它」）。
     */
    private minimaxXffCache;
    /**
     * ★ **由折算观测写下的** `modelRateLimits` 标记集合（键 = `accountId\u0000modelId`）。
     *
     * ## ⚠️⚠️ 为什么必须有它（真实缺陷，两个独立审计共同命中 2026-10-12）
     *
     * `modelRateLimits` 这一张表承载了**两种语义**、且两者写的**值与键完全相同**
     *（都是「该账号 + 该模型」+ UTC+8 次日 0 点）：
     *
     * | 来源 | 语义 | 依据 |
     * |---|---|---|
     * | `updateModelRateLimit`（各适配器） | **撞墙**：上游真的拒绝了 | **线上事实**（一次真实失败的请求） |
     * | `markModelsExhaustedForExpiry` | **观测**：余额接口说这个模型没额度了 | 可能**滞后 / 口径不同**的计数器 |
     *
     * 而折算**每轮选型都跑**：只要余额接口报该模型 `> 0`，`clearModelsExhaustedForExpiry`
     * 就会把适配器刚写的标记**无条件删掉** ⇒
     *
     * ```
     * round0: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 被擦了
     * round1: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 又被擦
     * round2: pick=zcode-A ...                                  ← 死循环
     * ```
     *
     * ⇒ 同一个号被**反复选中、反复撞墙**，每次**真烧一发请求**。
     * 实测（关掉折算缓存后 `3/3` 轮全中）：`scripts/verify-zcode-fight-single.mjs`。
     *
     * ## 判据：**谁的证据更强**
     *
     * 「上游真的拒绝了一次请求」强于「余额接口说还有额度」（后者可能滞后）。
     * ⇒ 清除只允许作用于**本机制写下的**标记：
     * - `markModelsExhaustedForExpiry` 写成功后**登记**来源；
     * - `updateModelRateLimit`（适配器）一旦为该键写过，就**认领**它
     *  （从本集合移除）⇒ 观测路径再也擦不掉它；
     * - `clearModelsExhaustedForExpiry` **只删登记过的**键。
     *
     * ⚠️ **纯内存、不落盘**：丢失它的后果是「既有标记变成来源不明 ⇒ 清不掉」
     * —— 那是**保守方向**（与「只写不清」的单向门同向，但危害小得多：
     * 标记本来就会在次日 0 点自然过期）。刻意不落盘，避免给
     * `JetHubState` 加一份需要迁移与对账的新结构。
     */
    private readonly expiryMarkedKeys;
    /** 是否已完成首次载入。 */
    private loaded;
    /** 顺位仅在真实请求选号后推进；不写入账号凭据。 */
    private readonly rotationLast;
    private readonly requestEligibility;
    private readonly selectionChains;
    isRotationRequest(provider: string): boolean;
    /** 只串行选号，不串行整个网络请求；并发请求沿用当前可用账号。 */
    withSelection<T>(provider: string, select: () => Promise<T>): Promise<T>;
    orderForRequest<T extends {
        id: string;
    }>(provider: string, candidates: readonly T[]): T[];
    setRequestEligibility(provider: string, check: (entry: ProviderAccountEntry, model: string) => Promise<boolean>): void;
    setRequestSource(provider: string, accountId: string, source: string): void;
    rateLimitKey(entry: ProviderAccountEntry, model: string): string;
    requestAccount(provider: string): ProviderAccountEntry | undefined;
    rememberSelection(provider: string, id: string): void;
    /**
     * 状态文档落盘的**串行链**（见 {@link queueStoreSave}）。
     *
     * ⚠ 它必须存在：内层重新读一次快照只能保证「读→改」这半原子，而
     * `store.save()` 本身是异步的，两个写者的 `save` 可以乱序完成。
     */
    private storeChain;
    /** 锁定表的独立后端（权威落盘点）。 */
    private readonly lockStore;
    /**
     * 「账号入库」订阅者（Gitee issue IKJOZB）。
     *
     * ⚠️ 刻意**不落盘、不跨实例**：它的消费者是插件会话内的续期调度器，
     * 而调度器按会话创建 —— 持久化订阅者既无意义，还会让「谁来订阅」变成
     * 需要在启动时恢复的状态。
     */
    private readonly accountAddedListeners;
    constructor(ctx: Context, options?: {
        preserveAccountOrder?: boolean;
    });
    /** 首次访问时从后端载入账号列表、黑名单与锁定表。 */
    private ensureLoaded;
    /**
     * 载入锁定表：独立文档是权威；它**不存在**时才从 state.json 的镜像字段迁移。
     *
     * ⚠️ 迁移判据必须是「文档不存在」而不是「表里没有某键」：表里的缺键语义是
     * 「用户明确解锁了」，此时若还回看镜像字段那个陈旧的 `true`，就会出现
     * **解不掉的开关** —— 比丢状态更难排查。
     *
     * ⚠️ 迁移出的内容立即固化到独立文档：否则每次冷启动都要重新读镜像，
     * 而镜像随时可能被另一条工作区的旧代码改回旧值。
     */
    private loadLocks;
    /** 读取账号列表（进程内权威副本）。 */
    private readAccounts;
    /**
     * 串行化状态文档的落盘，并在**轮到本次时**重新取一次快照。
     *
     * ## 为什么 `removeAccount` 里的重读不够（真实缺陷，审查发现）
     *
     * `await this.writeAccounts(this.readAccounts().filter(...))` 只保证了
     * 「读 → 改」之间没有 `await`（内存那半确实原子），但
     * {@link writeAccounts} 内部的 `await this.store.save(...)` 是**异步**的
     * （`SettingsStore.save` → `await this.scope.replace(...)`）。两个写者各自的
     * `save` 可以**乱序完成**：后完成者带着它更早的快照覆盖磁盘 ⇒ 磁盘与
     * `this.cache` 分叉。实测形态（探针复现真实 IO 交错）：
     *
     * - 并发 `removeAccount('a')` / `removeAccount('b')`（先发起的后完成）：
     *   `cache=["keep"]` 而 `disk=["b","keep"]` ⇒ **已删除的账号在磁盘上复活**，
     *   下次进程启动它又回来；
     * - `removeAccount('victim')` 与 `addAccount(added)` 交错：
     *   `cache=["added","keep"]` 而 `disk=["keep"]` ⇒ **新增账号被静默丢失**。
     *
     * ⚠ 仅 `SettingsStore` 这类**异步** `replace` 后端中招；`FileStore.save` 是
     * 同步的 `writeFileSync` + `renameSync`（见 `src/jet-hub-store.ts`），整段
     * RMW 本来就原子、免疫此竞态。故不能靠「换个后端」绕过，只能在
     * `AccountPool` 这一层把写排队。
     *
     * ## 做法
     *
     * 把本次写挂到 {@link storeChain} 尾部，**在轮到它执行时**才从进程内权威副本
     * 取快照，于是「取快照」与「写磁盘」之间隔着前面所有已排队的写。磁盘上因此
     * 永远是「最后一次排队的写」的内容，与 `this.cache` / `this.modelCache` 收敛。
     *
     * ⚠ 三条数据**必须取自同一时刻**：账号、黑名单、锁定镜像字段共用一次快照，
     * 否则会出现「同一份文档里两个字段自相矛盾」（与 {@link lockFields} 的约定一致）。
     *
     * ⚠ 失败**照常向调用方抛出**（与改造前的 `writeAccounts` 一致：登录成功后落盘
     * 失败必须让 `account.create` 报错，不能静默假装成功）。同时用一条
     * `.catch()` 派生量更新 {@link storeChain}，让**链本身不被一次失败打断**
     * ——否则后续所有写都会跟着拒绝，账号池进入永不落盘状态。
     */
    private queueStoreSave;
    /**
     * 持久化账号列表（同时更新进程内权威副本）。
     *
     * **必须连同黑名单一起写回**：两种后端都是整体写入，
     * 只写 `{ accounts }` 会把同一文档里的 `disabledModels` 抹掉。
     *
     * ## ⚠️⚠️ 这里是「同 id 去重」的**唯一收口点**（真实缺陷，独立审计实测证伪）
     *
     * 原先只把去重放在 `sanitizeAccounts`（归一化层）。但**并非所有写入路径都经过
     * 归一化** —— 最典型的是 {@link addAccount}：它直接
     * `writeAccounts([...readAccounts(), entry])`，**不调 `sanitizeAccounts`**。
     * 而 `addAccount` 有 20+ 个调用点（各 `*-auth.ts` 的登录落库、`jet-hub-rpc.ts`
     * 的 `account.create`、`opencode-rpc.ts`、`ensureDefaultAnonymousSlot`），
     * 于是「池里两条同 id」仍可达。
     *
     * 后果**不是崩溃**（`sinkAccountToProviderEnd` 的长度不变式兜底会拦下空洞），
     * 而是**沉底静默失效**：兜底返回 `null` ⇒ 顺序不变 ⇒ 限额号解禁后仍抢占首位 ⇒
     * 用户报障的那个「额度轮不完、白白过期」**原样复现**。用静默失效换掉崩溃
     * 只是把问题藏得更深。
     *
     * ⇒ 去重必须放在**唯一的写入收口点**（本方法）：无论调用方是否做过归一化，
     * 落盘与进程内副本都不会含两条同 id。这是「按 id 唯一」这一不变式的
     * **结构性保证**，而不是依赖每个调用方自觉。
     *
     * ⚠️ 保留**首次**出现的条目（与 `sanitizeAccounts` 同口径）。
     * ⚠️ `sanitizeAccounts` 里的去重**仍然保留**：它是**入口**的清洗（坏条目、
     * 脏限流标记），两者职责不同、互相不替代 —— 少了本层则 `addAccount` 漏网，
     * 少了那层则脏数据进池。
     */
    private writeAccounts;
    /**
     * 读取某 provider 的模型黑名单（被关闭的模型 id 集合）。
     *
     * 适配器只调用这一个方法，因此进程内副本就是它们的读源：设置页改开关
     * 后，下一次 `listModels` 立即生效，无需重启或重新注册适配器。
     */
    disabledModelsFor(provider: string): ReadonlySet<string>;
    /**
     * 列出某 provider 的模型黑名单，供设置页渲染开关。
     *
     * 返回**全部键**（含显式设为 false 的），以便 UI 区分"从未设置过"与
     * "曾被关闭又打开"——两者对用户都是"开"，但保留记录便于排查。
     */
    listDisabledModels(provider: string): Record<string, boolean>;
    /**
     * 该 provider 是否处于「**用户要求整体关闭**」态（Gitee issue IKP8OF）。
     *
     * ## ⚠️⚠️ 这是「关闭**意图**」，不是「当前是否真的全关」——两个判据必须分开
     *
     * | 判据 | 含义 | 谁用 |
     * |---|---|---|
     * | 本方法 | 用户点过「关闭供应商」，且此后没再打开过它 | 过滤（选择器 / 路由）、`provider.status` |
     * | `disabled === total` | 目录里**每一个**模型都在黑名单里 | 兜底（用户逐条关光也算关闭） |
     *
     * 二者取**或**才是 `closed`（见 `provider.status`）。只读本方法会漏掉
     * 「用户逐条关光」（既有语义，有既有用例锁定）；只读派生判据会漏掉
     * 「关闭后目录继续变长」（本 issue）。
     *
     * ## 为什么它是修「新模型仍可选」的关键
     *
     * 关闭供应商时只写入了**当时目录**的黑名单；目录随后变长，新 id 不在黑名单里
     * ⇒ 它们**可被选中**。本意图表让「该 provider 整体关闭」这件事不再依赖
     * 目录快照 ⇒ 各适配器的 `listModels` 见它即返回 `[]`，选择器里**一条都不出现**。
     *
     * ⚠️ **纯内存同步读、零 IO**：本方法在 `provider.status`（设置页挂载时对
     * 每个供应商各调一次）与每次 `listModels` 的路径上，不能有 await 或磁盘读。
     */
    providerClosedFor(provider: string): boolean;
    /**
     * 设置/清除某 provider 的「整体关闭」意图（Gitee issue IKP8OF）。
     *
     * ⚠️ **只动意图，不动黑名单**：黑名单由 `provider.setEnabled` 按固定顺序
     * 显式处理（先关模型、再停账号）。本方法只回答「用户要求这个供应商关着吗」。
     *
     * ⚠️ 幂等且无变更不落盘（与 `setModelsDisabled` 的「空列表不落盘」同精神）：
     * 重复点同一个开关不该产生一次文档重写。
     */
    setProviderClosed(provider: string, closed: boolean): Promise<void>;
    /**
     * 清除「整体关闭」意图 —— **任何**打开方向的操作都必须走这里。
     *
     * ## ⚠️⚠️ 为什么必须在「打开」时清除，否则用户点不动
     *
     * 意图为 `true` 时，全部模型都被过滤掉（`listModels` 返回 `[]`）、设置页里
     * 每条模型开关也显示为「已关闭」。此时用户在模型列表里打开**某一个**模型，
     * 若意图不清除 ⇒ 该模型仍被整体关闭拦掉 ⇒ **点击看起来毫无效果**，
     * 而界面也不报错。这与本仓库反复修的「开关点了没反应」同型。
     *
     * ⇒ 语义定为：**「打开任意一个模型」= 用户想让这个供应商可用** ⇒ 清除意图，
     * 之后由派生判据（黑名单是否覆盖全目录）如实反映「还剩几个关着」。
     *
     * ⚠️ 三个打开入口（`setModelDisabled(false)` / `clearModelsDisabled` /
     * `clearDisabledModels`）都在**本类内部**调用它 —— 调用方（RPC 层）不需要
     * 记得清，这正是「收口到一个实现」的目的。
     */
    private clearProviderClosed;
    /**
     * 聚合「拒绝轮换」表的**只读快照**（供适配器与设置面板读取）。
     *
     * ⚠️ 返回**浅拷贝的顶层**（避免调用方改到内部缓存），但内层仍共享引用 ——
     * 调用方**只读**即可；写入一律走 {@link setAggregateRejected}。
     */
    listAggregateRejections(): AggregateRejectionMap;
    /**
     * 设置某条候选是否被拒绝参与该虚拟模型的轮换。
     *
     * 语义（与 {@link setModelDisabled} 对称）：
     * - `rejected === true` → 写入；
     * - `rejected === false` → **删除**该键（不留 `false` 噪音，与 sanitize 同口径）；
     * - 空层逐级清理（realId 层空 → 删 provider 层；provider 层空 → 删虚拟模型层）。
     */
    setAggregateRejected(canonicalId: string, provider: string, realId: string, rejected: boolean): Promise<void>;
    /**
     * 聚合「显式允许」白名单的只读快照（与 {@link listAggregateRejections} 同口径：
     * 顶层浅拷贝、内层仍共享引用，调用方**只读**）。
     */
    listAggregateAllowed(): AggregateAllowedMap;
    /**
     * 设置某条候选是否**显式允许**参与轮换（用户手工打开 / 关闭）。
     *
     * ⚠️ **只动白名单、不碰拒绝表**（见 {@link aggregateAllowedCache} 的说明）：
     * 白名单服务的是未接入折算的候选（默认不参与），拒绝表服务的是已接入的候选
     *（默认参与）—— 两表的键域天然不相交。
     *
     * ⚠️ `allowed === false` 走**删键**（不留 `false` 噪音，与 `setAggregateRejected` 同口径）：
     * 表里一旦被 `false` 污染，下次读取就有人按 truthy 判成「允许」= 静默放行一个
     * 我们没有余额信息的渠道。
     */
    setAggregateAllowed(canonicalId: string, provider: string, realId: string, allowed: boolean): Promise<void>;
    /**
     * 一键「拒绝非临期」：把 `keepProviders`（= **已接入**临期折算的渠道）**之外**的白名单
     * 条目全部清掉，让那些渠道回到「默认不参与」的初始态（用户后续仍可逐条手工打开）。
     *
     * ⚠️ 池**不知道**「接入临期折算」是什么语义：它只收到一份「要保留哪些 provider」的清单，
     *    该清单由调用方（RPC 层）从权威常量 `WIRED_EXPIRY_PROVIDERS` 取。这样「谁是未接入渠道」
     *    的权威仍然只有那一个常量（本仓库「同一事实两处判据」的红线）。
     *
     * @returns `cleared` = 清掉的**候选条数**（面板提示要用它）；`aggregateAllowed` = 清后的白名单。
     * ⚠️ `cleared === 0` 时**不写盘**（幂等；也避免把一次空点击变成一次整体替换）。
     */
    clearAggregateAllowedExcept(keepProviders: readonly string[]): Promise<{
        cleared: number;
        aggregateAllowed: AggregateAllowedMap;
    }>;
    /** 聚合手工顺序表的只读快照（缺键 = 未自定义）。 */
    listAggregateOrder(): AggregateOrderMap;
    /**
     * 写入某虚拟模型的**手工顺序**。
     *
     * ⚠️ **过滤与去重必须在这里做**（服务端是权威）：入参是客户端拖动后拼出来的数组，
     *    可能含「不含 NUL 分隔符的畸形元素」与「重复元素」。重复会让比较器**非确定**
     *   （同一候选有两个位次）；畸形元素在适配器里解析不出 `(provider, realId)`
     *    ⇒ 静默失效（顺序表看着有内容却全不生效）。
     *
     * ⚠️ 返回**落盘后的权威数组**（不是入参回声）—— 客户端据此校正本地状态，
     *    否则「客户端以为排好了、服务端丢了一半」会长期分叉。
     * ⚠️ 空数组 = 未自定义（删键，回落临期序）。
     */
    setAggregateOrder(canonicalId: string, entries: readonly string[]): Promise<string[]>;
    /** 排序模式（`'expiry'` = 升级前行为）。 */
    listAggregateOrderMode(): AggregateOrderMode;
    /**
     * 切换排序模式并落盘。
     *
     * ⚠️ 幂等：写同一个值**不落盘**（一次空点击不该触发一次整体替换）。
     */
    setAggregateOrderMode(mode: AggregateOrderMode): Promise<void>;
    /**
     * 清空拒绝表（支持按虚拟模型或按渠道清）。
     *
     * - 都不传 ⇒ 清空**全部**；
     * - 只传 `canonicalId` ⇒ 清空该虚拟模型的全部候选拒绝；
     * - 只传 `provider` ⇒ 清空**所有**虚拟模型里该渠道的拒绝；
     * - 两个都传 ⇒ 清空该虚拟模型里该渠道的拒绝。
     *
     * ⚠️ 与 {@link setAggregateRejected} 的 `false` 方向**不等价**：后者是「打开某一条」，
     * 本方法是「清空一批」（即便某条从未被拒绝也无所谓）。
     */
    clearAggregateRejected(canonicalId?: string, provider?: string): Promise<void>;
    /**
     * 落盘**聚合路由族**的全部状态（拒绝表 / 白名单 / 手工顺序表 / 排序模式）。
     *
     * ⚠️ 四份状态**共用一个写方法**：它们是同一份文档里的同一族状态，分开写会让
     *    「一次用户操作」产生两次整体替换，中间那一刻的快照自相矛盾
     *   （本仓库已有「分两次快照让同一份文档里的字段互相矛盾」的缺陷史）。
     * ⚠️ 调用方**必须先把 `this.xxxCache` 换成新值**再调本方法 ——
     *    `queueStoreSave` 读的是缓存字段，不是入参。
     * ⚠️ `label` 只用于日志，便于排障时区分是哪张表触发的落盘。
     */
    private writeAggregateRouting;
    /**
     * 「本机 OpenAI 网关」当前是否启用。
     *
     * 缺键语义为**启用**（老用户升级后行为不变），见
     * {@link gatewayEnabledCache}。
     */
    gatewayEnabled(): boolean;
    /**
     * 打开/关闭本机 OpenAI 网关并落盘。
     *
     * ⚠️ 这里**只改状态**，不负责启停 HTTP server —— 真正的启停由
     * `src/openai-gateway/runtime.ts` 在调用方做完持久化后接手。两者分开是为了
     * 让「存开关」与「跑进程」各自可单测，且启停失败不会把已写入的开关回滚成
     * 看似没生效的样子。
     */
    setGatewayEnabled(enabled: boolean): Promise<void>;
    /**
     * 「渠道原生搜索」总开关当前是否启用。
     *
     * 缺键语义为**启用**（见 {@link nativeWebSearchCache}）。
     *
     * ⚠️ 调用方（`web-native.ts` 的监听器）**必须每次现读**，不能缓存返回值：
     * 用户随时可能在 Jet Hub 面板里切换。
     */
    nativeWebSearchEnabled(): boolean;
    /**
     * 打开/关闭「渠道原生搜索」并落盘。
     *
     * 关闭后，即使 CodeBuddy / WorkBuddy 渠道也改为走 DeepSeek 官方搜索
     *（需要 `DEEPSEEK_API_KEY`）—— 即所有渠道的搜索行为统一。
     */
    setNativeWebSearchEnabled(enabled: boolean): Promise<void>;
    /**
     * 读取供应商自定义显示顺序（进程内权威副本）。
     *
     * 空数组 = 用户尚未自定义（或老文档没有该键），展示侧按声明顺序渲染。
     */
    providerOrder(): string[];
    /**
     * 写入供应商自定义显示顺序并落盘。
     *
     * ⚠️ 入参**原样保存**、不在池里做 provider 合法性过滤：合法集合随插件版本
     * 变化，在此过滤会让「新版本加入 provider → 被旧版本代码重写文档」场景下
     * 的顺序无法保留。脏值防护由两层承担：RPC 层校验 `string[]`，
     * store 层 `sanitizeProviderOrder` 去重/剔除非字符串。
     */
    setProviderOrder(order: string[]): Promise<void>;
    /**
     * 当前设置的 MiniMax 国际站 `X-Forwarded-For` 值；`undefined` = 不附头。
     *
     * ⚠️ 请求侧（`minimax.ts` 的 `minimaxHeadersFor`）**必须每次现读**，不能缓存：
     * 用户随时可能在面板里改这个设置。
     */
    minimaxXff(): string | undefined;
    /**
     * 设置（或清除）MiniMax 国际站的 `X-Forwarded-For` 并落盘。
     *
     * 传空串 / `undefined` = **清除**（不附头）。校验由 `sanitizeMinimaxXff` 统一做：
     * 非法值（主机名、XFF 链、含换行等）**不会**被写进缓存 —— 于是「填了个坏值」
     * 与「没填」等价，不会让请求带上一个可能触发头注入的串。
     *
     * ⚠️ 非法值**静默归一为 `undefined`** 而不是抛错：本设置是可选逃生口，
     * 用户输错一个字符就报错阻断保存只会更糟。但 RPC 层会把**归一后的实际值**
     * 回给客户端，UI 照它渲染，用户能立刻看出「没生效」。
     */
    setMinimaxXff(value: string | undefined): Promise<void>;
    /**
     * 打开/关闭某个模型。
     *
     * 关闭时写入 `true`；打开时**删除该键**而不是写 `false` —— 保持黑名单
     * 里只留真正被关闭的模型，`disabledModelsFor` 的语义因此始终是
     * "键存在且为 true 即隐藏"，配置文件也不会随开关操作无限膨胀。
     */
    setModelDisabled(provider: string, modelId: string, disabled: boolean): Promise<void>;
    /**
     * 批量关闭一批模型（Jet Hub 模型列表的「关闭全部」）。
     *
     * 语义是**按当前列表逐项加入黑名单**，与 {@link setModelDisabled} 的关闭方向
     * 一致，只是**一次落盘**：逐条调用会写 N 次完整文档（30 个模型就是 30 次
     * 整体重写 + 30 次目录广播），且中途失败会留下「关了一半」的黑名单。
     *
     * 空列表直接返回、不落盘：没有变更就不该产生一次无意义的写入与广播。
     * 注意这与 {@link clearDisabledModels} **不对称** —— 后者的语义是「清空」，
     * 即使传入空列表也仍有事可做（详见该方法注释）。
     */
    setModelsDisabled(provider: string, modelIds: readonly string[]): Promise<void>;
    /**
     * 批量**打开**一批模型（Jet Hub 模型列表里**按分组**的「本组全开」）。
     *
     * ## 与 {@link clearDisabledModels} 的区别是**范围**（勿混）
     *
     * 后者清空该 provider 的**全部**键，并刻意顺带清掉「已下线模型」的历史死键；
     * 本方法**只删传入的 id**。分组开关必须用本方法 —— 用「清空」会把用户特意
     * 关着的其它组一起打开（那正是分组开关要避免的事）。
     *
     * ⚠️ **无实际变更不落盘**：传进来的 id 若本来就不在黑名单里（例如该组已经
     * 全开），删不掉任何键，此时不该产生一次文档重写与目录广播 ——
     * 与 {@link setModelsDisabled} 的「空列表不落盘」是同一条精神。
     */
    clearModelsDisabled(provider: string, modelIds: readonly string[]): Promise<void>;
    /**
     * 批量启用/停用某 provider 的**全部**账号（Jet Hub 左侧供应商一键开关）。
     *
     * ## 为什么需要批量方法
     *
     * 供应商级开关的语义是「关闭该供应商」= 关掉它的全部模型（黑名单）+
     * 停用它的全部账号。前者复用 {@link setModelsDisabled}，后者没有现成路径 ——
     * 逐账号调 {@link updateAccount} 会写 N 次完整文档（且每次都可能与其它
     * provider 的改动互相覆盖），故这里一次落盘。
     *
     * ## 与「账号级开关」的区别（勿混）
     *
     * 账号级开关（账号卡片上的「停用/启用」）只动**单个**账号，且带
     * 「是否连带关闭该 provider 模型」的询问（见前端 `toggleAccount`）。
     * 本方法只动 `enabled`，**不碰模型黑名单**、不做任何询问 ——
     * 模型那侧由调用方（`provider.setEnabled` 端点）按固定顺序显式处理。
     *
     * ## 语义要点
     *
     * - **只改本 provider 的账号**：账号存在一个全局数组里（各 provider 混排），
     *   与 {@link reorderAccounts} 的隔离约定一致，绝不波及其它 provider。
     * - **幂等且无变更不落盘**：全部已是目标状态时直接返回 0，不产生无意义的
     *   文档重写（与 {@link setModelsDisabled} 的「空列表不落盘」同精神）。
     * - ⚠️ **返回「实际变更数」而非「命中数」**：调用方用它给用户提示
     *   （如「已停用 2 个账号」）。若返回命中数，全部本就停用时也会报「已停用 2 个」，
     *   用户会以为发生了他没预料到的改动。
     *
     * @param provider - provider id（`this.product.id`，不要写死字面量）
     * @param enabled - 目标状态：true 启用 / false 停用
     * @returns 实际被改变的账号数
     */
    setAccountsEnabled(provider: string, enabled: boolean): Promise<number>;
    /**
     * 清空某 provider 的全部关闭项（Jet Hub 模型列表的「打开全部」）。
     *
     * ⚠️ **刻意不看模型目录**：直接删掉该 provider 在黑名单里的**全部**键，
     * 而不是按当前目录逐个删。理由是「曾被关闭、后来从服务端目录里下线」的
     * 历史遗留键 —— 按目录删的话它们永远清不掉，黑名单会积累死键，残留键
     * 将来若被同名模型复用还会莫名隐藏它。
     *
     * 该 provider 本就无关闭项时直接返回、不落盘。
     */
    clearDisabledModels(provider: string): Promise<void>;
    /**
     * 一次性写入「模型黑名单 + 供应商关闭意图」并落盘**一次**（Gitee issue IKP8OF）。
     *
     * ## ⚠️⚠️ 为什么必须合并成一次落盘（真实窗口，已实测）
     *
     * `provider.setEnabled(false)` 的语义是「关掉全部模型 + 记下关闭意图」。
     * 若分两次落盘（先 `setModelsDisabled`、再 `setProviderClosed`），第二次失败时：
     *
     * ```
     * 磁盘: disabledModels = {buddy:{a:true,b:true}}   ← 已写
     * 磁盘: providerClosed  = {}                        ← 未写（失败）
     * 内存: providerClosedFor = true                    ← 内存已是 true，本次会话看起来正常
     * ```
     *
     * 后果是**重启后静默复发**：意图丢了 ⇒ 只剩派生判据 ⇒ 目录一变长就翻回
     * 「已打开」（正是本 issue 的症状），而用户完全不知道「上次关闭其实只成了一半」。
     *
     * ⇒ 两者必须**同一份快照、同一次 `save`**：要么都落盘、要么都不落盘。
     * 这与 `queueStoreSave` 的既有约定（账号 / 黑名单 / 各开关**取自同一时刻**）
     * 完全同源 —— 那份注释里已写明「分两次快照会让同一份文档里的字段互相矛盾」。
     *
     * ## 参数语义：**合并**（与 `setModelsDisabled` 同口径）
     *
     * 传「要追加关闭的 id 列表」而不是整张表 —— 这样调用方不必先读全表再拼，
     * 少一次「读 → 拼 → 写」的往返，也就少一个读到的快照过期的时间窗。
     *
     * @param provider - provider id
     * @param modelIds - 要**追加**进黑名单的 id（已有的关闭项不受影响）
     * @param closed - 目标关闭意图（`true` 写入 / `false` 删除该键）
     */
    writeModelsWithProviderClosed(provider: string, modelIds: readonly string[], closed: boolean): Promise<void>;
    /**
     * 一次性**清空**某 provider 的黑名单**并**清除「关闭意图」并落盘**一次**
     *（Gitee issue IKP8OF，「打开供应商」专用）。
     *
     * ## ⚠️⚠️ 为什么必须合并（对抗审计打穿的真实窗口）
     *
     * 「打开供应商」原先走两步：`clearDisabledModels`（save #1）→
     * `setProviderClosed(false)`（save #2）。实测 `saves=2`，两次 `replace` 之间
     * 磁盘上是「**黑名单空 + 意图真**」。若第二次失败或进程被杀：
     *
     * ```
     * 磁盘: disabledModels = {}            ← 已清
     * 磁盘: providerClosed  = {buddy:true} ← 仍是「已关闭」
     * 内存: providerClosedFor = false      ← 本次会话看起来正常
     * ```
     *
     * ⇒ **重启后该供应商的模型选择器恒空**（意图真 + 黑名单空 ⇒ `listModels` 返回
     * `[]`、`provider.status` 报 `closed:true`），而设置页黑名单里一条关闭项都没有
     * ⇒ 用户无从归因，只能手工编辑 `state.json`。
     *
     * ⚠️ 危险的那条路径恰好是**最常见**的一条：只有「黑名单本来就空」时
     * `clearDisabledModels` 才会一次写完（它的早退分支）；黑名单非空（= 用户真的
     * 关过东西、现在要打开）时必然两次。
     *
     * ⚠️ 语义与 {@link clearDisabledModels} **逐字相同**（清空该 provider 的全部键，
     * 含历史死键），只是把「清意图」并进同一次落盘。
     */
    clearModelsWithProviderClosed(provider: string): Promise<void>;
    /** 持久化模型黑名单（同时更新进程内权威副本）。 */
    private writeModels;
    /**
     * 状态文档里那份**镜像字段**（`loomyPermanentLocked`）。
     *
     * ⚠️ 它只是镜像，权威表在独立文档（见 {@link persistLocks}）。仍继续同源写出
     * 有两个理由：① 同机其它 profile 里的**旧版本代码**只认这个字段（它读它、
     * 也原样写回它），保持一致才能让那一侧的 Loomy 面板显示正确的锁定态；
     * ② 回退到老版本时用户不会看到「锁定悄悄失效」。
     * 二者**取自同一次快照**，于是「同一份状态里两个字段自相矛盾」这种隐性分歧
     * 从结构上就不可能出现。
     */
    private lockFields;
    /**
     * 某 provider 的「锁定永久积分」是否开启。
     *
     * 锁定后选号**只允许消耗会近期作废的积分**，永久积分不参与 ——
     * 只剩永久积分的账号在锁定期间等同于不可用（用户语义：「没有临时积分后
     * 找可用账号就是没有可用账号」）。
     *
     * ⚠️ 「什么算永久积分」各 provider 不同（Loomy 看服务端给的每日池；两个 buddy
     * 看资源包的扣费截止距今是否满 15 天），但**开关本身是同一件事**，故共用本表。
     */
    permanentLocked(provider: string): boolean;
    /**
     * 设置某 provider 的「锁定永久积分」开关（持久化）。
     *
     * ⚠️ 解锁时**删除该键**而不是写 `false`（与模型黑名单同款约定）：表里只留
     * 真正处于锁定态的 provider，`permanentLocked` 的判据因此始终是
     * 「键存在且为 true 即锁定」。
     */
    setPermanentLocked(provider: string, locked: boolean): Promise<void>;
    /**
     * 落盘锁定表：先写**权威**（独立文档），再同步**镜像**（state.json）。
     *
     * ⚠️ 顺序与容错都是有意的：
     * - 权威先落 —— 独立文档才是本 profile 选号的依据；镜像写失败只让另一条
     *   工作区的面板显示旧值，不会让我们**误烧用户的永久积分**；
     * - 镜像失败只 warn，不向上抛 —— 否则一次 settings 后端抖动会让面板上的
     *   「锁定」按钮报错，而实际开关已经生效。
     *
     * 写镜像沿用「读 → 改 → 整体写回」的既有约定：必须连同账号与黑名单一起带，
     * 否则那份文档里的另外两份数据会被抹掉。
     */
    private persistLocks;
    /** 锁定表的当前快照（备份导出用；权威来自独立文档）。 */
    permanentLocksSnapshot(): PermanentLockMap;
    /** 全部处于锁定态的 provider（供设置页一次性读取）。 */
    listPermanentLocked(): string[];
    /** 列出某个 provider 的所有账号（含状态信息）。
     *
     * 🔴 **视图排序（工单 08，2026-10-02）**：「任一模型限流中」的账号**沉到最后**
     * （稳定序：未限流者保持手动拖拽序不变）。**只排序这个返回视图，不改磁盘顺序** ——
     * 面板列表即时反映真实命中序（限流者沉底、解除后自动回原位），而"手动顺序=用户
     * 拖拽意图"的成文契约不受影响。写时挪位（首版方案）因破坏该契约被废弃——
     * 曾被上游行为契约测试抓出 4 条红，教训：改"展示顺序"别动"存储顺序"。
     */
    listAccounts(provider: string): Promise<ProviderAccountStatus[]>;
    /** 列出所有 provider 的账号 */
    listAllAccounts(): Promise<ProviderAccountEntry[]>;
    /**
     * 清理「凭据域名确证属于**其它**产品」的账号。
     *
     * 用途：WorkBuddy provider 从中国版（copilot.tencent.com）改造为国际版
     * （www.workbuddy.ai）后，旧账号存的仍是中国版凭据 —— 它们的 `token.domain`
     * 指向旧端点，用新 endpoint 发请求必然失败（且会一直续期失败）。
     * 这类条目已无修复价值，直接删除，让用户在 Jet Hub 重新登录。
     *
     * ## ⚠️⚠️ 判据必须是「命中别的产品的域集合」，不是「不等于本产品的 apiDomain」
     * （真实缺陷，独立审计实测证伪）
     *
     * 原判据 `domain !== product.apiDomain` **语义不成立**：
     *
     * - 凭据里 `domain` 的语义是「**登录站点**」（token 的 `iss` 主机），不是请求
     *   端点域名（`src/buddy-adapter.ts` 明文写着这一点，且 `X-Domain` 实际以
     *   `this.product.apiDomain || credential.domain` 取值 —— 凭据的 `domain`
     *   只是**兜底**）。故 `domain ≠ apiDomain` **不蕴含**「凭据发不到当前端点」。
     * - 本机实测（20 个真实腾讯系账号）证明**同一 provider 的 `domain` 合法地存在
     *   多种值**：buddy 的 `www.codebuddy.cn`（12 条）与 `copilot.tencent.com`（8 条）
     *   —— 那 12 条一直是正常可用的。该判据在 buddy 上没出事，**只是因为上游恰好
     *   没对 `CODEBUDDY` 调用本函数**；一旦推广会一次性删光它们。
     * - 更严重的是它把「**未知**」当成「失配」：跨机导入、上游新增 realm 主机、
     *   登录站改版，都会让一个**完全可用**的账号在下次启动时被静默删除
     *   （本函数原先只留一行 `logger.info`）。
     *
     * ⇒ 现判据：`domain` **属于本产品的 `knownDomains`** ⇒ 保留；
     * **命中其它产品的 `knownDomains`** ⇒ 确证失配，删除；
     * **两边都不命中（未知域）** ⇒ **保守保留**（无法判定 ≠ 失配）。
     *
     * ⚠️ 产品未声明 `knownDomains` 时**一律保留**：没有域信息就无法判定失配，
     * 删除的代价（用户重新登录 / 账号永久丢失）远大于保留一个可能失效的条目
     * （它至多续期失败并在日志里可见）。
     *
     * @param product - 目标产品配置。
     * @param foreignDomains - **其它**产品的已知域集合（用于确证失配）。
     *   缺省为空集合 ⇒ 只保留、不删除（安全默认值）。
     * @returns 被删除的账号 id 列表（供调用方记日志）。
     */
    pruneAccountsWithForeignDomain(product: BuddyProduct, foreignDomains?: readonly string[]): Promise<string[]>;
    /** 添加新账号（登录成功后调用） */
    addAccount(entry: ProviderAccountEntry): Promise<void>;
    /**
     * 注册「账号入库」回调（Gitee issue IKJOZB）。
     *
     * ## 为什么需要这个出口
     *
     * 续期调度器原先只在**插件启动那一刻**按「池是否非空」决定是否武装，而
     * 冷启动时池为空是正常态（新用户、刚清过存储）—— 此后登录的账号在本会话内
     * **永远不会被主动续期**。修法之一是「账号入库时补武装」，于是需要有人告诉
     * 调度器「池刚变了」。
     *
     * ⚠️ **收口点必须是这里**，不能逐个登录流程接线：`pool.addAccount` 在全仓库
     * 有十几处调用点（12 个 provider 的 auth、opencode 的账号槽与匿名槽、RPC 的
     * 导入/恢复分支）。逐处接线必然漏掉某一处，而漏掉的那一处会**静默**地不续期。
     *
     * @param listener 回调；**抛错会被吞掉并记 warn**（订阅者不得让登录失败）。
     * @returns 取消订阅函数。
     */
    onAccountAdded(listener: (entry: ProviderAccountEntry) => void): () => void;
    /**
     * 逐个调用入库订阅者；**任何异常都只记日志**。
     *
     * ⚠️ 不能让订阅者的异常冒到 `addAccount` 的调用者：那条路径是「登录成功」，
     * 一个写坏的订阅者不该让用户看到「登录失败」（凭据其实已经存好了）。
     */
    private notifyAccountAdded;
    /**
     * **只追加**账号（合并导入用）：已有的 id 一律跳过，返回**实际新增**的 id。
     *
     * ⚠️ 与 {@link replaceAll} 的差别是本质的，不要互相替换：
     * - 只调用 `writeAccounts`（账号 + 黑名单整体写回，但黑名单取**当前**值），
     *   因此**不改**模型黑名单，也**不触碰**锁定表（它住在独立文档里）；
     * - 绝不删除或覆盖任何现有账号 —— 判重按 `id`，这是账号的唯一键；
     * - 入参同样经 `sanitizeAccounts` 归一化：数据来自用户提供的文件，
     *   坏条目丢弃而不是写进池里反复触发选号失败。
     *
     * ⚠️ **文件内部重复的 id 去重已下沉到 `sanitizeAccounts`**（该函数按 id 去重，
     * 全部入口共用）。本方法只需再比一次「与**池里已有**的 id 是否冲突」。
     * 备份文件可能被手工编辑过，重复条目会在池里留下两条同 id 的账号 ——
     * 那不只是「删不掉、改不动」的幽灵账号：沉底函数按 id 匹配会写出
     * `undefined` 空洞，使整个 provider 崩溃并在重启后永久丢账号
     * （详见 `sanitizeAccounts` 与 `sinkAccountToProviderEnd` 的注释）。
     */
    mergeAccounts(accounts: readonly ProviderAccountEntry[]): Promise<string[]>;
    /** 更新账号部分字段 */
    updateAccount(id: string, patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable' | 'zcodeSource'>>): Promise<void>;
    /** 删除账号（同时清理凭据） */
    removeAccount(id: string): Promise<void>;
    /**
     * **启动自愈**：按「身份字段」清理同一账号的重复条目（只留一条）。
     *
     * ## 为什么需要它（2026-10-19 真机报障）
     *
     * AutoClaw 的 `access_token` 是 JWT、**每次登录/续期都轮换**，而早期实现
     * 拿它当身份判据 ⇒ 同一账号每续一次就被当成新账号。用户面板里同一个手机号
     * 出现了 **3 次**，积分被**重复累加**：
     *
     * ```
     * 合计 62416 积分
     *   187****9406  20838
     *   187****9406  20789
     *   187****9406  20789
     * ```
     *
     * 判据侧已修（改用稳定的 `user_id`，见 `autoclawIdentityOf`），但**池里已有的
     * 重复条目不会自己消失** ⇒ 用户仍看到 62416。本方法负责一次性清掉存量。
     *
     * ## 保留哪一条
     *
     * 保留**凭据最新**的那一条（`expiresAt` 最大者）；`expiresAt` 相同则保留
     * **先出现**的（与 `writeAccounts` 的「保留首次」同口径，保证确定性）。
     * ⚠️ 不按 `id` 字典序 —— 那与「哪个账号能续期」无关。
     *
     * ## 边界
     *
     * - 身份字段缺失的条目**跳过**（无法判断，不误删）；
     * - 只处理传入的 `provider`，绝不跨渠道合并；
     * - 每次只删「确认同身份且非保留项」的条目，删除走 {@link removeAccount}
     *   （它会一并 `credentials.unset`，不留孤儿凭据）；
     * - 失败不抛：自愈是**尽力而为**，不能因此让插件启动失败。
     *
     * @param provider - provider id（如 `autoclaw`）。
     * @param field - 凭据里作身份判据的字段名（如 `user_id`）。
     * @returns 实际删除的条目数。
     */
    dedupeByCredentialField(provider: string, field: string): Promise<number>;
    /**
     * 重排某 provider 下账号的顺序（Jet Hub 拖拽排序）。
     *
     * ## 为什么顺序有实际意义
     *
     * 账号列表的数组顺序就是 {@link getAvailableAccount} 的**候选优先级**：
     * 自动选号、限流后的换号重试都按这个顺序取「第一个可用账号」。
     * 因此拖拽不是 UI 装饰，它直接决定实际用哪个账号发请求。
     *
     * ## 只动本 provider 的槽位
     *
     * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分），
     * 而设置页是按 provider 分组渲染的。因此这里取「该 provider 账号原本占用的
     * 那些下标」，把新顺序填回这些下标 —— 其他 provider 的账号**位置不变**。
     *
     * 不这么做（例如把该 provider 的账号整体挪到数组头部）会让拖拽 CodeArts
     * 的顺序顺带改变 Buddy 账号的相对位置，属于跨面板的意外副作用。
     *
     * ## 校验：必须是同一集合的一个排列
     *
     * `orderedIds` 必须恰好包含该 provider 的**全部**账号 id（顺序可变、集合不可变）。
     * 不满足就抛错而不是「尽力而为」：
     * - 少了某个 id（前端列表过期，期间账号被别处新增）→ 若静默忽略，那个账号
     *   会莫名其妙掉到末尾，用户看到的是"顺序自己变了"；
     * - 多了未知 id → 说明前端状态与服务端不一致。
     * 两种情况都让用户刷新重试，比悄悄改数据安全。
     *
     * @param provider - provider id
     * @param orderedIds - 该 provider 全部账号 id 的目标顺序
     */
    reorderAccounts(provider: string, orderedIds: readonly string[]): Promise<void>;
    /**
     * 按凭据内容反查账号 id（供适配器记录"当前用的是哪个账号"）。
     *
     * 适配器不持有 ctx，也不该直接访问本类的私有凭据存储，
     * 因此这里集中做「遍历已启用账号 → 解析凭据 → 比对标识字段」。
     * @param provider - provider 名称（'buddy' | 'workbuddy' | 'codearts'）。
     * @param identity - 比对用的标识值：CodeBuddy 系传 access_token，CodeArts 传 access_key_id。
     * @returns 匹配到的账号 id；无匹配返回空串。
     */
    findAccountIdByCredential(provider: string, identity: string): Promise<string>;
    /** 解析某个 credentialRef 下的凭据 JSON；不可用时返回 undefined。 */
    private resolveCredentialByRef;
    /**
     * 按凭据里的**任意身份字段**查找同 provider 的已有账号。
     *
     * ## 与 {@link findAccountIdByCredential} 的区别
     *
     * 那个是**限流记录归属**专用，写死了「codearts 用 access_key_id、
     * 其余用 access_token」两套字段名，且**只看已启用账号**。
     * 本方法是**通用去重**用：调用方给字段名与值，且**不看 `enabled`** ——
     * 停用的账号同样占着一个条目的位置，重复添加它仍是重复。
     *
     * ## 为什么必须容忍「字段缺失」
     *
     * 早期登录的凭据里可能**没有**该字段（例如 zcode 的 `user_id` 是
     * 2026-10-02 才补上的）。此时**跳过该条目**（视为「无法判断」），
     * 而不是把它当成「不匹配」或直接报错 —— 前者会漏判，
     * 后者会让老用户根本添加不了账号。
     *
     * @param provider - provider id（如 `zcode`）。
     * @param field - 凭据里用作身份判据的字段名（如 `user_id`）。
     * @param identity - 要比对的值（空串直接返回 `''`，调用方据空串放弃去重）。
     * @returns 匹配到的账号 id；无匹配返回空串。
     */
    findAccountIdByIdentityField(provider: string, field: string, identity: string): Promise<string>;
    /** 按 id 查找账号条目（含已停用账号）。 */
    findAccount(id: string): ProviderAccountEntry | undefined;
    /** 列出某 provider 的全部账号（含已停用），供「重测所有 / 重置所有」使用。 */
    listAccountsByProvider(provider: string): ProviderAccountEntry[];
    /**
     * 该 provider 是否**至少有一个已登录（凭据可用）的账号**。
     *
     * 供适配器的 `listModels` 做门控：没有已登录账号时返回空目录，让 DSH 的
     * `buildModelCatalog` 把整个 provider 分组隐藏（它显式
     * `.filter(group => group.models.length > 0)`），从而显著减少模型选择
     * 列表里用不上的条目（用户需求：「没有已登录账号就不显示该供应商的所有
     * 模型」）。
     *
     * ## 为什么判据是「凭据可解析」而不是「有条目」
     *
     * 1. **`logout()` 只清凭据、保留账号条目**（删除条目是另一条路径
     *    `removeAccount`）。若只看「有没有条目」，用户登出后模型仍会显示，
     *    门控形同虚设。
     * 2. **不看 `enabled`**：停用只应影响「自动选号」，与「是否已登录」无关。
     *    这与续期调度器「只按 `refreshable` 过滤、不看 `enabled`」是同一条
     *    既有约定（停用账号同样参与积分领取），故这里保持一致。
     *
     * ⚠️ **这是异步的**：需要逐个解析凭据。但只解析到**第一个可用账号**即返回
     * （短路），多账号场景下通常第一次就命中。
     *
     * ⚠️ **本方法只用于「目录展示」的门控**，绝不能用于路由判定 ——
     * DSH 约定 `listModels` 结果仅供参考，隐藏目录不等于拒绝请求
     * （被隐藏的模型仍可 `resolveModel` / 正常收发）。
     */
    hasLoggedInAccount(provider: string): Promise<boolean>;
    /**
     * 按账号 id 解析凭据（**不检查 enabled**）。
     *
     * 限流重测必须能对已停用账号发请求（用户明确要求"停用的账号也能发送"），
     * 因此这里刻意与 {@link getAvailableAccount} 的过滤条件区分开：自动选择
     * 只认启用账号，而按 id 的显式探测认全部账号。
     * @returns 凭据对象；账号不存在或凭据不可用时返回 undefined。
     */
    resolveCredentialForAccount(id: string): Promise<CodeArtsCredential | BuddyCredential | undefined>;
    /**
     * 清除限流标记。
     *
     * @param accountId - 目标账号。
     * @param modelIds - 要清除的模型；省略时清除该账号的**全部**标记。
     * @returns 实际清除的标记数。
     */
    clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number>;
    /**
     * 获取指定 provider + 模型的下一个可用账号。
     *
     * `modelId` 为空串时**不做限流过滤**——调用方（provider 的
     * resolveCredential 入口）此时还不知道要发哪个模型，只能退化为
     * "任取一个启用账号"。但 `enabled` 过滤在任何情况下都生效：
     * 停用账号绝不参与自动选择，空 modelId 也不例外。
     *
     * @param provider - provider id（`this.product.id`，不要写死字面量）
     * @param modelId - 目标模型；空串表示不按模型过滤
     * @param excludeAccountIds - 需要跳过的账号 id。
     *
     * **为什么需要 `excludeAccountIds`**：调用方在「请求级轮换」时会逐个换号
     * 重试，必须能拿到**下一个**账号而不是每次都拿回同一个。
     * 本池默认按「重置时间最早到期」排序，当失败类别**不写限流标记**时
     * （如 5xx / 请求错误 —— 它们不是限流，不该留徽章），
     * 刚失败的账号仍是排序第一，调用方若不排除它就会原地打转、
     * 换号形同虚设。Go 侧对应的是 `PickExcluding(tried)`（`pool.go:131`）。
     *
     * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
     * 「池认为最优的一个」，无法枚举候选自己去重。
     *
     * ## ⚠️ 为什么带类型参数 `TCredential`（2026-10-08，Task 11）
     *
     * 返回类型原先写死成 `CodeArtsCredential | BuddyCredential` 这个**两家的联合**，
     * 而本池服务 **13 家**，各家凭据形状互不相同 ⇒ 每个调用方都得在结果处
     * 写一个向具体凭据类型的断言才能用。
     *
     * ⚠️ **处数实测为 21（2026-10-08 独立复审按 `90cc881` 的 diff 逐行复核）** ——
     * 本节原先写「**20 处**」、而那次 commit 的标题与正文写「**19 处**」，**两个数都不对**。
     * 复核方式（可复现，不要靠记忆）：
     *
     *     git show 90cc881 --unified=0 -- '*.ts' |
     *       grep -E '^-[^-].*\bas [A-Z][A-Za-z]*Credential\b'
     *
     * 命中 **22** 行，其中 **21** 行形如 `<x>.credential as <X>Credential`
     *（唯一的例外是池内 `JSON.parse(...) as CodeArtsCredential | BuddyCredential`，
     * 它是**被改成** `as TCredential`、不是被删）。逐处核对过上游 API：
     * **21 处的上游全部是 `getAvailableAccount`**（`lobsterai-adapter.ts` 那处
     * 因上下文窗口较窄未被正则识别，人工核对确认同源）。
     * ⚠️ 所以「这样的收窄」= **21**，不是 19/20 —— 引数时请引这个实测值。
     *
     * ⚠️ **那个断言不是「必要的坏味道」，而是纯粹的噪音**：调用方**自己**知道
     * 它在查哪一家（`this.product.id` 或字面量 id），池却把类型信息擦掉了。
     * 断言写错方向时 TS 也不会拦（`as` 双向放行），于是「中国版账号拿到国际版
     * 凭据类型」这类错位在类型层是**静默**的。
     *
     * ⇒ 改为泛型：`getAvailableAccount<ClineCredential>(CLINE.id, model)`，
     * 类型由**调用点**给出、池原样回传。**纯类型层改动，零运行时行为变化**
     * （函数体一行未改，`JSON.parse` 的结果照旧不做形状校验 —— 校验是各家
     * `parseCredential` 的职责，见 `credential-resolver.ts` 的头注）。
     *
     * ⚠️ 默认值 `CodeArtsCredential | BuddyCredential` **刻意保留**：13 家之外
     * 还有测试桩与 `ResolverPool` 这类结构化替身，去掉默认值会让它们全部编译失败，
     * 而它们本就不关心具体形状。
     */
    /** 余额选号与普通选号共用请求过滤，避免停用/冷却/来源限制被旁路。 */
    requestCandidateAllowed(entry: ProviderAccountEntry, model: string): Promise<boolean>;
    getAvailableAccount<TCredential = CodeArtsCredential | BuddyCredential>(provider: string, modelId: string, excludeAccountIds?: ReadonlySet<string>): Promise<{
        entry: ProviderAccountEntry;
        credential: TCredential;
    } | null>;
    /**
     * 取某 provider **全部启用账号**的凭据（按手动顺序）。
     *
     * ## ⚠️ 为什么需要它（真实缺陷，用户报障 2026-10-07）
     *
     * 用户质疑：「workbuddy 中一个号是 1 天到期，为什么我们统计是 2000 多天，
     * **只用了第一个账号吗**？」—— **他猜对了**。
     *
     * 聚合的临期折算原先走 {@link getAvailableAccount}，那个方法只返回**一个**
     * 账号（手动序第一个可用的）。于是「渠道最早什么时候作废」只反映了那**一个**
     * 账号 —— 而用户把「1 天到期」的号拖到后面时，它的临期额度在**排序**里被完全忽略，
     * 结果是「按临期排序」把这个渠道排到后面，尽管它有一个快作废的号。
     *
     * ⚠️ 与 {@link getAvailableAccount} 的**分工**：那个方法服务于「实际发请求用哪个
     * 账号」（手动顺序优先，渠道内部换号由适配器负责）；本方法只服务于**观测**
     *（「这个渠道整体的临期额度大概什么时候作废」），**不改变选号行为**。
     *
     * ⚠️ 与 `getAvailableAccount` 一致：**跳过凭据损坏的账号**（记日志、继续），
     * 而不是整批失败 —— 一个坏账号不该让整个渠道被判成不可用。
     *
     * @param provider - 渠道 id
     * @param modelId - 真实模型 id（用于限流过滤；空串则跳过限流维度）
     * @returns 凭据数组（可能为空 = 没有可用账号）
     */
    listAvailableCredentials(provider: string, modelId: string): Promise<Array<{
        entry: ProviderAccountEntry;
        credential: unknown;
    }>>;
    /**
     * 更新某账号某模型的重置时间。
     *
     * 关键：基于**读取到的最新账号列表**做局部合并，再把整个列表写回。
     * settings scope 的 get() 返回的是服务内部快照，可能滞后于磁盘；
     * 但 replace() 是整体替换，因此这里每次都在最新快照上合并，
     * 避免"写 A 的限流 → 读旧快照 → 写 B 的限流"把 A 的记录抹掉。
     *
     * ⚠️ **只接受比现值更大的解禁时刻**（与
     * {@link updateTraeCheckinDeviceGeneration} 同一约定）：
     *
     * 各 provider 的限流解析都有「解析不出时长 → 退回一个兜底值」的末端，而那个兜底
     * 通常是**短**的（cline 是 1 小时，而真实等待可能是 19 小时 39 分）。于是同一个
     * (账号, 模型) 上先写入的**真值**会被后写入的**兜底**覆盖 ——
     * cline「倒计时结束了还是失败，显示又 60 分钟」正是这样无限循环的。
     *
     * 并发场景最容易踩：同一 provider 的两个请求，一个拿到可解析的报文（写 19h39m），
     * 另一个拿到被 CDN 包成 HTML 的 429（写 1h），**后写的赢**。
     *
     * ⇒ 这里取「更长者」。真值被丢掉的风险不用担心：所有调用方写入的都是**未来**
     * 时刻，而过期的标记由 {@link sweepExpiredRateLimits} 清理。
     */
    updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void>;
    /**
     * ★ **批量**写入「该账号在这些模型上已无额度」的标记（zcode 专用，2026-10-12）。
     *
     * ## 与 {@link updateModelRateLimit} 的分工（⚠️ 别把它实现成循环调用它）
     *
     * | | `updateModelRateLimit` | 本方法 |
     * |---|---|---|
     * | 语义 | 「**撞到**限额了」（事后，来自上游错误） | 「**查到**该模型已无额度」（事前，来自余额接口） |
     * | 副作用 | 标记 **+ 账号沉底** | **只写标记**，**不沉底** |
     * | 调用方 | 各适配器（收到 429/额度错误） | `zcodeExpiry` 的折算（每次选型） |
     *
     * ## ⚠️⚠️ 为什么必须**不沉底**（这是本方法存在的唯一理由）
     *
     * 沉底（`sinkAccountToProviderEnd`）的语义是「这个号撞限额了，挪到最后，
     * 让后面的号有机会用」（见那个函数的注释）。
     *
     * 而本方法的调用场景是**每次选型折算**：它只是个**观测**动作。若它也沉底，
     * 那么「GLM-5.3 专属桶烧光、但 Flash 桶还有 5M」的账号会在**每一次**
     * auto 选型时被挪到末尾 —— 用户会发现自己的账号顺序**莫名反复变化**，
     * 而那个账号在 Flash 上明明完全可用。这属于跨面板的意外副作用。
     *
     * ## ⚠️ 为什么是「批量」
     *
     * zcode 一次余额查询就能算出**所有**已尽的模型（见 `zcode-entitlements.ts`
     * 的 `exhaustedModelsOf`）。逐个调 `updateModelRateLimit` 会**每次整体重写
     * 账号列表**（那个方法末尾是 `writeAccounts(next)`）—— N 个模型就是 N 次全量落盘。
     * 批量写只落一次盘。
     *
     * ## 标记的时长与语义
     *
     * 取 `nextUtc8DayStartMs()`（UTC+8 次日 0 点），与 zcode 的免费额度
     * **按自然日结算**一致（`zcode-adapter.ts` 的 `switchAccountOnQuota` 同口径）。
     * ⚠️ 到点后由 {@link sweepExpiredRateLimits} 清掉 ⇒ 自愈，不会永久固化。
     *
     * ⚠️ 单个模型写失败**不中断其余**？——不，本实现是**整体一次写**：
     * 要么全写、要么全不写（`writeAccounts` 是整体替换）。这是刻意的：
     * 部分成功会让「哪些模型被标了」变得不可预测，而重试的代价只是一次余额查询。
     *
     * @param accountId - 目标账号。
     * @param modelIds - 要标记的模型 id（**必须是目录形态** —— 两侧大小写不同，
     *   写错形态会让池的 `modelRateLimits[modelId]` 精确匹配**静默不命中**；
     *   形态由 `zcode-entitlements.ts` 的 `exhaustedModelsOf` 保证）。
     *   空数组时**直接返回**（不写盘）。
     */
    markModelsExhaustedForExpiry(accountId: string, modelIds: readonly string[]): Promise<void>;
    /**
     * ★ **批量**清除「该账号在这些模型上已无额度」的标记（zcode 专用，2026-10-12）。
     *
     * ## ⚠️⚠️ 为什么必须与 {@link markModelsExhaustedForExpiry} 成对（单向门）
     *
     * 只写不清会让标记变成**单向门**：zcode 的免费额度按自然日结算，用户**当天**
     * 烧光后去面板签到、又领到额度时，标记仍挂在池里到 UTC+8 次日 0 点 ⇒
     * 「签到成功了，但这个模型当天还是用不了」。本仓库对此有明确事故史
     * （`refreshable` 被当过滤条件用，一次瞬时失败把账号永久标死）。
     *
     * ⚠️ **光靠签到路径救不回来**（实测 `scripts/verify-zcode-mark-after-claim.mjs`）：
     * `credits.claimAll` 成功只清**折算缓存**（`clearExpiryCache`），
     * **不清 `modelRateLimits`** ⇒ 自愈必须发生在**下一次折算**
     * （那时已经拿到新的余额报文，判据是 `recoveredModelsOf`）。
     *
     * ## 与 {@link clearModelRateLimits} 的分工（别合并）
     *
     * | | `clearModelRateLimits` | 本方法 |
     * |---|---|---|
     * | 语义 | 用户主动「重测 / 重置」 | 折算时**发现额度已恢复** |
     * | 传 `undefined` | 清**全部**标记 | —— 不接受省略（必须给具体模型） |
     * | 调用频率 | 低（用户点击） | 高（每次折算），故**空数组直接返回** |
     *
     * ⚠️ 之所以不直接复用 `clearModelRateLimits`：那个方法没有「只清这些、别动
     * 其余」的判据保证（传 `undefined` 会清全部），而本方法的调用方**只**知道
     * 「这些模型有额度」，对别的模型一无所知 —— 误清会让一个真已尽的模型被反复选中。
     *
     * ## ⚠️⚠️ **只清「本机制写下的」标记**（真实缺陷，两个独立审计共同命中 2026-10-12）
     *
     * `modelRateLimits` 是**两种语义共用**的一张表，且两者写的键与值完全相同：
     * ① 本机制（余额接口的观测）；② 各适配器的 `updateModelRateLimit`（**真的撞墙了**）。
     *
     * 而折算**每轮选型都跑** ⇒ 若本方法无条件删键，就会把适配器刚写下的事后证据擦掉：
     *
     * ```
     * round0: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 被擦了
     * round1: pick=zcode-A 适配器写标记=true 折算后仍在=false
     * round2: pick=zcode-A ...                                  ← 死循环，每次真烧一发请求
     * ```
     *
     * 实测（关掉折算缓存后 `3/3` 轮全中）：`scripts/verify-zcode-fight-single.mjs`。
     * ⇒ 判据取「**谁的证据更强**」：一次**真实失败**的请求强于可能滞后的余额计数器。
     * 故只删 {@link expiryMarkedKeys} 登记过的键（适配器为该键写过就会被「认领」）。
     *
     * @param accountId - 目标账号。
     * @param modelIds - 要清除的模型 id（**目录形态**）；空数组时**直接返回**。
     */
    clearModelsExhaustedForExpiry(accountId: string, modelIds: readonly string[]): Promise<void>;
    /** 清理已过期的重置时间记录 */
    sweepExpiredRateLimits(): Promise<void>;
    /**
     * 记录 TRAE 签到设备轮换代次（命中 9074 后由积分领取流程调用）。
     *
     * 与 {@link updateModelRateLimit} 同款：在**最新快照**上做局部合并后整体
     * 写回，避免与并发的账号操作互相覆盖。
     *
     * 只接受比现值**更大**的代次，防止乱序/重复回调把代次写回小值而让同一个
     * 被限流的设备号复活。
     */
    updateTraeCheckinDeviceGeneration(accountId: string, generation: number): Promise<void>;
    /** 读取 TRAE 签到设备轮换代次（未设置时为 0）。 */
    traeCheckinDeviceGenerationFor(accountId: string): number;
    /**
     * 设置/清除某 opencode 账号的出口代理。
     *
     * ⚠️ **空串是合法输入**（用户显式清除代理 → 回到「与其它无代理账号共享
     * 本机出口」），故这里**不能**用 `if (!proxy) return` 早退，否则「清除」
     * 按钮点了会静默无效。清除时**删键**而不是写空串，避免下游把空串误当成
     * 「配了一个空地址」。
     *
     * 与 `updateModelRateLimit` 同款：在**最新快照**上做局部合并后整体写回，
     * 避免与并发的账号操作互相覆盖。
     */ setOpencodeProxy(accountId: string, proxy: string): Promise<void>;
    /** 读取某 opencode 账号的代理（未设置时为空串）。 */
    opencodeProxyFor(accountId: string): string;
    /**
     * 设置/清除某 **gemini** 账号的出口代理（Gitee issue IKLTZ2）。
     *
     * ⚠️ **刻意与 `setOpencodeProxy` 分开成两份实现**，理由与字段同款：两者的
     * **语义不同**（opencode = 分份额度 / Gemini = 能不能连通）。共用一份会让
     * 「清掉 Gemini 的代理」连带清掉 opencode 的出口配置，且日志/判据也会漂移。
     *
     * ⚠️ 空串是合法输入（用户显式清除 → 直连），故**不能**用 `if (!proxy) return`
     * 早退（与 `setOpencodeProxy` 同款，见其注释）。清除时删键而非写空串。
     */
    setGeminiProxy(accountId: string, proxy: string): Promise<void>;
    /**
     * 读取某 gemini 账号的代理（未设置时为空串 = 直连）。
     *
     * ⚠️ **必须过 `asProxyText`**（实测的同族缺陷，独立于 IKLTZ2 审计发现）：
     * 该字段来自**用户可编辑的备份文件**，而 `sanitizeAccounts` 用 `{...candidate}`
     * 原样透传、不校验形状 ⇒ 池里可能存在 `"geminiProxy": 12345`。下游
     * `normalizeProxy` 第一句就是 `input.trim()` ⇒ 非字符串会在那里抛
     * `TypeError: raw.trim is not a function`，该账号**永久不可用且无自愈**
     * （症状与「代理配置坏了」同形，日志只有一句 TypeError）。
     */
    geminiProxyFor(accountId: string): string;
    /**
     * 记录 opencode 指纹轮换代次。
     *
     * ⚠️ 只接受**比现值更大**的代次：乱序/重复回调把代次写回小值会让用户
     * 以为已轮换、实际指纹没换（TRAE 同款判据，见 `updateTraeCheckinDeviceGeneration`）。
     */
    updateOpencodeFingerprintGeneration(accountId: string, generation: number): Promise<void>;
    /** 读取 opencode 指纹代次（未设置时为 0）。 */
    opencodeFingerprintGenerationFor(accountId: string): number;
    /**
     * 读取当前完整状态快照（账号列表 + 模型黑名单 + Loomy 镜像字段）。
     *
     * 供备份导出使用：返回的副本与进程内权威副本解耦，调用方修改返回值
     * 不会污染池的运行时状态。`disabledModels` 是嵌套结构，必须深拷贝
     * （浅拷贝会让内层 provider 表仍共享引用）。
     *
     * ⚠️ 这里**不含**锁定表本体（它住在独立文档里），备份导出要走
     * {@link permanentLocksSnapshot}。
     */
    getStateSnapshot(): JetHubState;
    /**
     * 整体替换账号列表与模型黑名单（备份导入用）。
     *
     * 与 {@link writeAccounts} / {@link writeModels} 的约定一致：整体写入时
     * 必须同时携带账号与黑名单，否则会把另一份数据抹掉。这里一次落盘完成
     * 两件事，避免中间态。
     *
     * ⚠️ 导入数据来自用户提供的备份文件（可能被手工编辑），因此先经
     * `sanitizeAccounts` / `sanitizeDisabledModels` 归一化：只保留可用的
     * 账号条目与显式 `true` 的黑名单项，坏条目直接丢弃而不是写进池里
     * 反复触发选号失败。
     *
     * ⚠️ **同 id 去重由 `sanitizeAccounts` 承担**（不要在这里再补一套 ——
     * 那会形成「一文件两套同义判据」，本项目已有该形态的事故史）。去重缺失的
     * 后果是沉底写出 `undefined` 空洞、整个 provider 崩 + 重启丢账号，
     * 详见 `sanitizeAccounts` 的注释。另：`writeAccounts` 也有一层收口去重
     * （覆盖不经归一化的写入路径）。
     *
     * ⚠️⚠️ **必须逐个通知「账号入库」订阅者**（同族未修缺陷，独立审计实测证伪）：
     * `mergeAccounts` 已补上这一步（见其注释），而本方法是**备份导入的默认模式**
     * （`replace`）—— 它整体换掉整个账号池，影响面**比 merge 更大**，却同样绕过了
     * `notifyAccountAdded` 收口点。后果与 merge 那条完全同型：导入后的账号在
     * **最长 60 秒**内对 aggregate 路由不可见（临期折算与候选序缓存未清），
     * 报 `MISSING_CREDENTIAL | …没有任何可用候选`。
     *
     * 通知时机：放在 `persistLocks()` **之后**，且只在它成功时通知 —— 与
     * `mergeAccounts` 的 `finally` 语义略有不同（那里 `writeAccounts` 先更新
     * 进程内副本再落盘，故落盘失败账号也已可用）；这里 `this.cache` 在上面就已赋值，
     * 故落盘失败时账号同样可用，**也应当通知**。故同样用 `try/finally`。
     */
    replaceAll(accounts: readonly ProviderAccountEntry[], disabledModels: ModelDisableMap, permanentLocks?: PermanentLockMap): Promise<void>;
}
/**
 * `listModels` 的门控：**该 provider 是否应在模型目录中展示**。
 *
 * ## 需求来源
 *
 * 「如果某供应商没有已登录的账号，就不显示该供应商的所有模型 —— 这样对大多数
 * 用户来说模型选择选项卡臃肿的问题能改善很多。」
 *
 * ## 为什么可行：DSH 原生支持「空目录即隐藏」
 *
 * `dsh-api-session-controller` 的 `buildModelCatalog` 显式做了
 * `.filter(group => group.models.length > 0)`（注释：*"successful non-empty
 * provider groups"*）。因此适配器返回 `[]` 就能让整个 provider 分组从模型
 * 选择器中消失 —— **无需任何前端改动**。
 *
 * ⚠️ **必须返回空数组，不能抛错**：`buildModelCatalog` 的 `catch` 会把抛错
 * 归入 `failures`，界面上会多出一条 provider 报错，比「不显示」更糟。
 *
 * ⚠️ **不影响路由**：`catalog.routableProviders` 由 `listProviders()` 单独
 * 生成（不经过该 filter），且 DSH 明确约定 *"Catalog membership is advisory
 * and never changes routing"* —— 隐藏目录不等于拒绝请求，已持久化的模型
 * 仍能 `resolveModel` / 正常收发。
 *
 * ## 判定语义
 *
 * - **默认开启**（`DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0` 可关）：与
 *   `DSH_TRAE_MAX_MODE` 同为「默认开、显式假值才关」的语义，故单列解析函数。
 * - `accountPool` 缺失（headless / CLI / 单测）或替身未实现
 *   `hasLoggedInAccount` 时**视为可见** —— 门控是**展示优化而非安全边界**，
 *   判定不可用时宁多勿少（否则会让整个 provider 的模型凭空消失）。
 * - **六个 provider 判据完全一致**：都只看账号池。早期 CodeArts 有一个「单凭据
 *   例外」（额外认固定 ref `CODEARTS_ACCESS_TOKEN`），该模式已移除，故
 *   `extraCredentialRefs` 参数也一并删除，避免留下无人使用的分支。
 *
 * @param accountPool - 适配器的账号池（可能为 undefined）。
 * @param provider - provider id。
 */
export declare function providerCatalogVisible(accountPool: AccountPool | undefined, provider: string): Promise<boolean>;
//# sourceMappingURL=account-pool.d.ts.map