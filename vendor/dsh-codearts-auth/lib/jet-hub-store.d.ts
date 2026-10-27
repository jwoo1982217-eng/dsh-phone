/**
 * Jet Hub 状态持久化（账号索引 + 模型黑名单）。
 *
 * ## 为什么不能再用 settings namespace
 *
 * DSH ≤0.1.6：`ctx.settings` 是 SettingsProvider，插件用
 * `settings.register(ns, schema)` 拿到 owner scope（`get()` / `replace()`），
 * 数据落在 `$DSH_HOME/settings.yaml` 的 `jet-hub:` 段。
 *
 * DSH 0.1.7-rc.1：`ctx.settings` 换成 **SettingsForms** —— **没有 `register`**。
 * 表单命名空间只能是 **profile 条目 id**，且只投影该条目 Config 中标了
 * `.volatile()` 的字段（见 `@deepseek-ai/dsh-settings` 的 `SettingsForms`）。
 * 于是早期写法 `settings.register(...)` 在 0.1.7 上恒走
 * `typeof settings.register !== 'function'` 分支，账号列表与模型黑名单
 * **退化为纯内存**（真实缺陷：Gitee issue IKI7WT ——「DSH 0.1.7 移除
 * `settings.register()` 后，账号列表与模型黑名单无法持久化」；启动日志实证
 * `[jet-hub] settings 服务不可用，账号列表仅存在于内存中`）。
 *
 * ## 现在的策略：按能力探测两条后端
 *
 * 1. `settings.register` 可用（老 DSH）→ **沿用旧契约**，行为与数据位置完全不变；
 * 2. 否则（0.1.7+）→ 插件自有 JSON 文档 `$DSH_HOME/jet-hub/state.json`，
 *    同步读 + 原子写（tmp + rename）。
 * 3. 两者都不可用（headless / 单测替身缺服务）→ 仅内存，并**显式告警**。
 *
 * ## 为什么不把状态塞进插件 Config
 *
 * 0.1.7 的 settings 表单确实能持久化「本条目 Config 的 volatile 字段」，但
 * 账号索引与**限流重置时间戳**是运行时状态：限流每命中一次就要写一次，
 * 而写 Config 会改写 profile 的 `cordis.patch.yml` 并触发 Loader 协调 ——
 * 把易变的运行时数据混进用户手写的配置层，代价与风险都不划算。
 * 这里与 `src/models.ts` 的 `~/.cache/deveco/*.json` 是同一思路（本插件既有的
 * 文件持久化惯例）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ProviderAccountEntry } from './types.js';
/** Jet Hub schema namespace（老契约的 settings 命名空间名）。 */
export declare const JET_HUB_NS = "jet-hub";
/**
 * 模型黑名单：provider id → **被关闭**的模型 id → true。
 *
 * **黑名单制**：只有键存在且为 `true` 的模型被隐藏，未记录的模型默认打开。
 */
export type ModelDisableMap = Record<string, Record<string, boolean>>;
/**
 * 聚合 provider 的「拒绝轮换」表：虚拟模型 id → provider → 被拒绝的 realId → true。
 *
 * ## 与相邻两张表的关系（三者语义互不相同，不要合并）
 *
 * | 表 | 语义 | 粒度 |
 * |---|---|---|
 * | `disabledModels[provider][modelId]` | **关闭这个模型**（它从模型选择器里消失） | provider + 模型 |
 * | `provider.setEnabled` | **关闭整个 provider**（等于关掉它全部模型） | provider |
 * | `aggregateRejections[虚拟模型][provider][realId]` | **这一条候选不参与该模型的轮换** | 候选 |
 *
 * ⚠️ 把某虚拟模型的候选**全部**拒绝 ≠ 关闭该虚拟模型：前者它仍在目录里
 *（只是无候选可用，请求时如实报错），后者从目录消失。
 */
export type AggregateRejectionMap = Record<string, Record<string, Record<string, boolean>>>;
/**
 * 聚合 provider 的「**显式允许**参与轮换」白名单：虚拟模型 id → provider → 被允许的 realId → true。
 *
 * 形状与 {@link AggregateRejectionMap} **逐格相同**，但语义相反：本表只记录「用户**手工打开**」的候选。
 *
 * ⚠️⚠️ **为什么需要白名单，而不是「拒绝表里没有就是允许」**：
 *    未接入临期折算的渠道（7 家）的默认态是**不参与**（见 `aggregate-core.ts` 的
 *    `CandidateGate`）。若用「拒绝表里没有 = 允许」表达这个例外，老用户升级后这 7 家的
 *    全部候选会**立刻参与轮换** —— 配额未知的渠道被静默放行，请求打到用户没打算用的渠道。
 *    ⇒ 默认态必须由「该渠道是否接入折算」（渠道级编译期事实）**推导**，而**例外**（手工打开）
 *    需要本表才能表达。
 *
 * ⚠️ **两张表各有各的域、不做互斥归一**（用户 2026-10-15 的修正，规格 §5.1）：
 *    已接入折算的候选只归**拒绝表**（黑名单语义：默认参与），未接入的只归**白名单** ——
 *    两表的键域由「渠道是否接入折算」划分，**天然不相交** ⇒ 写一侧**不得**改另一侧
 *    （顺手清另一侧会静默改掉另一张表里**属于别的操作**的用户状态：拒绝一条候选不该顺手
 *    关掉同渠道其它手工打开的候选）。
 *
 * ⚠️ 只记录 `true`（缺键 = 未显式允许），与拒绝表同口径。
 */
export type AggregateAllowedMap = Record<string, Record<string, Record<string, boolean>>>;
/**
 * 聚合 provider 的**手工排序**表：虚拟模型 id → 有序候选键数组。
 *
 * 元素 = `` `${provider}\u0000${realId}` ``（与本文件外的候选键约定**逐字相同**：分隔符是
 * **NUL**，不是 `:` 或 `|` —— 本仓库有过「两套同义分隔符」的缺陷史）。
 *
 * ⚠️ **缺键 / 空数组 = 未自定义**（与 `providerOrder` 同语义）：展示与轮换都回落到临期序。
 * ⚠️ **未出现在数组里的候选不是被排除**，而是「排在已排过的之后，按 临期↑ → 倍率↑」——
 *    这样新增候补（渠道新登录、目录新增模型）不会因为没有位次而消失。
 */
export type AggregateOrderMap = Record<string, string[]>;
/**
 * 聚合候选的排序模式：`'expiry'`（默认，按临期）或 `'manual'`（按手工顺序）。
 *
 * ⚠️ 缺键 / 任何非法值的语义都是 `'expiry'` = **升级前行为**（老用户读到旧文档时
 * 不会突然变成手工序 —— 那时手工序表是空的，切过去等于「全都未排过」，行为其实一样，
 * 但显式回落能让面板文案不说谎）。
 */
export type AggregateOrderMode = 'expiry' | 'manual';
/** 各 provider 的「锁定永久积分」开关：provider id → 已锁定。 */
export type PermanentLockMap = Record<string, boolean>;
/** 持久化文档结构（两种后端共用）。 */
export interface JetHubState {
    accounts: ProviderAccountEntry[];
    disabledModels: ModelDisableMap;
    /**
     * 聚合 provider 的「拒绝轮换」表（见 {@link AggregateRejectionMap}）。
     *
     * ⚠️ 住 `state.json` 是**有意**的：本文件是**整体替换**语义，旧版本代码重写时
     * 会抹掉它不认识的键。判定标准是**丢失后果是否可逆**：
     * 拒绝表丢了 = 某个候选重新参与轮换 = **回到默认行为**，用户再关一次即可
     *（对比 `loomyPermanentLocked`：丢了会真烧掉永久积分，故它住独立文档）。
     *
     * 老文档没有这个键 → 空表（没有任何拒绝），与升级前行为一致。
     */
    aggregateRejections?: AggregateRejectionMap;
    /**
     * 聚合 provider 的「**显式允许**参与轮换」白名单（见 {@link AggregateAllowedMap}）。
     *
     * ⚠️ 住 `state.json` 的理由与拒绝表完全同级：丢失后果**可逆且方向安全** ——
     * 白名单丢了 ⇒ 那些未接入折算的渠道回到「默认不参与」，用户再逐条打开即可
     *（对比 `loomyPermanentLocked`：丢了会真烧掉永久积分，故它住独立文档）。
     *
     * 老文档没有这个键 → 空表（没有任何手工打开），与升级前行为一致。
     */
    aggregateAllowed?: AggregateAllowedMap;
    /**
     * 聚合候选的**手工排序**表（见 {@link AggregateOrderMap}）。
     *
     * ⚠️ 丢失后果**可逆**：顺序回到临期序，用户重拖一次即恢复。缺键 / 空数组 = 未自定义。
     */
    aggregateOrder?: AggregateOrderMap;
    /**
     * 聚合候选的**排序模式**（见 {@link AggregateOrderMode}）。缺键 = `'expiry'`（升级前行为）。
     */
    aggregateOrderMode?: AggregateOrderMode;
    /**
     * Loomy「锁定永久积分」开关 —— **镜像字段，不是权威**。
     *
     * 权威值在 `$DSH_HOME/jet-hub/permanent-locks.json`（见
     * `src/permanent-lock-store.ts`）。本字段仍**继续同源写出**，理由有两条：
     *
     * 1. **同机多 profile**：`state.json` 是 dsh home 级共享文档，另一条工作区里
     *    的**旧版本代码**只认这一个字段（它读它、也原样写回它）。镜像保持一致，
     *    web / tui / headless 侧的 Loomy 锁定才不会与 desktop 侧脱节；
     * 2. **升级前的磁盘状态只有本字段**：新文档不存在时要靠它把老用户的锁定
     *    迁移进来（迁移判据见 `permanent-lock-store.ts` —— 只在**新文档不存在**时
     *    生效，避免把已解除的锁定重新打开）。
     *
     * ⚠️ 反过来，**新字段绝不能只住在这里**：本文档是整体替换语义，旧代码全量
     * 重写时不会携带它不认识的任何键 —— 把锁定表放这儿会被静默抹掉，而解锁的
     * 后果是真把永久积分烧掉（不可撤回）。这正是把表拆到独立文档的原因。
     */
    loomyPermanentLocked?: boolean;
    /**
     * 本机 OpenAI 网关开关（`false` = 不启动网关）。
     *
     * ⚠️ 与 `loomyPermanentLocked` 不同，这个字段**可以**住在这里、不需要独立
     * 文档：老版本代码整体重写 `state.json` 时会丢掉本键，后果仅仅是**网关回到
     * 默认启用**，用户再关一次即可 —— 没有任何不可逆后果（对照 `loomyPermanentLocked`
     * 丢失会把「永久积分已锁定」静默变成「已解锁」，那才是灾难）。
     *
     * 缺键语义为**启用**：老用户升级后行为与升级前完全一致。
     */
    gatewayEnabled?: boolean;
    /**
     * 渠道原生搜索总开关（`false` = 全部搜索回官方 provider）。
     *
     * 「原生搜索」指支持它的渠道（CodeBuddy / WorkBuddy）用**自己后端的搜索接口**
     * （`/agenttool/v1/search` 与 `/agenttool/v1/webfetch`）；关掉后这些渠道也回落到
     * DeepSeek 官方搜索（需要 `DEEPSEEK_API_KEY`）。
     *
     * ⚠️ 与 `gatewayEnabled` 同级、**可以**住在这里：老版本代码整体重写 `state.json`
     * 时会丢掉本键，后果仅仅是**回到原生搜索**，用户再关一次即可 —— 没有任何
     * 不可逆后果（对照 `loomyPermanentLocked` 的不可逆性，那才需要独立文档）。
     *
     * 缺键语义为**启用**：老用户升级后行为与升级前一致（原生搜索本就是新功能，
     * 默认开启才符合「装上就能用」）。
     */
    nativeWebSearchEnabled?: boolean;
    /**
     * 供应商自定义显示顺序（「供应商开关」弹窗的拖拽排序，2026-10-06）。
     *
     * ⚠️ 与 `gatewayEnabled` 同级、**可以**住在这里：老版本代码整体重写
     * `state.json` 时丢掉本键的后果仅仅是**顺序回到声明顺序**——纯展示偏好，
     * 可逆、重拖一次即恢复（对照 `loomyPermanentLocked` 的不可逆性，那才需要
     * 独立文档）。缺键 / 空数组语义为「未自定义」。
     *
     * 数组含**全部**供应商 id：拖拽提交时 = 拖后的「已打开」序列 + 已关闭的
     * 按声明序缀尾。展示侧（`plugin-src/client/provider-toggle.js` 的
     * `sortOpenProvidersByOrder`）对数组中不认识 / 缺失的 id 都有稳定兜底，
     * 故插件跨版本增删 provider 时不需要任何迁移。
     */
    providerOrder?: string[];
    /**
     * MiniMax **国际站**请求要附带的 `X-Forwarded-For` 值（Gitee issue IKMEVG，2026-10-17）。
     *
     * ## 它解决什么
     *
     * `agent.minimax.io` 对所有路径恒返 `307 → agent.minimaxi.com`，而**是否 307
     * 由 Akamai 按请求来源 IP 的国别决定**（本机实测：美国 `8.8.8.8`、日本
     * `133.130.0.1`、新加坡、香港的 IP ⇒ 留在国际站；中国 `114.114.114.114`、
     * `223.5.5.5`、`180.76.76.76` ⇒ 307；内网/非法/空值 ⇒ 视为无此头，同样 307）。
     *
     * ⇒ 中国大陆出口的用户**永远**拿不到国际站数据面，无论 token 多有效。
     * 设置本字段后，国际站请求会附带 `X-Forwarded-For: <该值>`，从而被判定为
     * 海外来源、留在国际站。
     *
     * ## ⚠️ 为什么是「用户显式开启」而不是默认行为
     *
     * 附 `X-Forwarded-For` 本质是**声明一个并非本机的来源 IP**。Akamai 这条规则
     * 是上游的区域路由策略（账单、内容合规都基于它），默认伪造来源**不该是产品的
     * 默认行为**。故：缺键 / 空串 = **不附任何头**，行为与修复前逐字节一致。
     *
     * ⚠️ 它还可能**随时失效**：很多 CDN 已默认不信任客户端提供的 `X-Forwarded-For`。
     * 上游一旦改策略，本设置会**静默无效** —— 所以「设置后仍然 307」必须如实报错，
     * 不能假装成功（`minimax.ts` 的 `describeMinimaxGeoRoute` 守这一条）。
     *
     * ⚠️ 取值校验在 {@link sanitizeMinimaxXff}：**只接受 IP 字面量**（IPv4/IPv6），
     * 不接受主机名、不接受任意头注入字符（`,` / 换行 / 冒号在 IPv6 之外一律拒绝）。
     *
     * ⚠️ **只对 `minimaxintl` 生效**，中国站不受影响（它不需要绕过）。
     */
    minimaxXff?: string;
    /**
     * **供应商关闭意图**：provider id → `true`（Gitee issue IKP8OF）。
     *
     * ## 它解决什么
     *
     * 「关闭供应商」（`provider.setEnabled(false)`）原先**只**把**当时目录里的 id**
     * 写进模型黑名单，而 `provider.status` 的 `closed` 判据是
     * `total > 0 && disabled === total`（`total` 取自**当前**全量目录）。
     * 于是目录**在关闭之后继续变长**（cline 三源异步 + models.dev 可恢复、
     * 其余家后台刷新器补进上游新模型）⇒ `disabled < total` ⇒ `closed` 从
     * `true` 翻回 `false` ⇒ 供应商**静默回到「已打开」**，且新模型**仍可选**。
     * 实测（真实 `ClineAdapter` + 真实 `AccountPool` 走完整 RPC 链路；
     * 关闭那一刻 models.dev 未就绪 ⇒ 目录 3 条，恢复后补齐到 7 条）：
     * `{total:3,disabled:3,closed:true}` → `{total:7,disabled:3,closed:false}`。
     *
     * ## ⚠️⚠️ 为什么是「意图」而不是「状态」——**不要把它当 `closed` 的权威**
     *
     * 本表记的是「用户**要求**它关着」，**不是**「它现在真的全关」。二者必须靠
     * **双腿取或**才等价（见 `AccountPool.closedProviders` 与 `provider.status`）：
     *
     * - 若**只**读本表（issue 原文的第一个建议）⇒ 用户在模型列表里**逐条打开**
     *   该供应商的模型后，本表仍是 `true` ⇒ 界面显示「已关闭」而模型**全部可选**
     *   —— 正是 IKJW33 修过的「显示已关闭而模型仍可选」矛盾态；
     * - 若**只**读派生判据（修复前的形态）⇒ 目录一长就翻回「已打开」（本 issue）。
     *
     * ⇒ 判据 = `本表有该 provider` **或** `目录非空且全部已关闭`。
     * 前者管「目录增长」，后者管「逐条关光也算关闭」（既有语义，有既有用例锁定）。
     *
     * ## ⚠️ 为什么它能**同时**修好「新模型仍可选」（这才是真正的危害）
     *
     * 本表在 `AccountPool.disabledModelsFor()` 里被读 —— 那是**全部 22 家适配器**
     * 过滤黑名单的**唯一收口点**（`model-catalog.ts` 的共享骨架、
     * `autoclaw` / `modelscope` / `officeace` / `opencode` 四个手写实现、
     * 聚合与 auto 的路由都读它）。故这里**一处实现**就让新增模型在选择器里消失，
     * 无需在目录落地时异步补写黑名单（那种写法要在 22 家各接一次钩子，
     * 且读路径写盘、失败还要重试）。
     *
     * ⚠️ 但 `listAllModels()`（设置页开关清单）与 `provider.status` 的 `total`
     * **不套** `disabledModelsFor`（契约要求它们是不套黑名单的全量目录）——
     * 这正是我们想要的：用户仍能在设置页看到并**逐条打开**这些模型。
     *
     * ## ⚠️ 丢失后果**可逆**，故可以住 `state.json`
     *
     * 老版本代码整体重写 `state.json` 时会丢掉本键 ⇒ 后果是回到修复前的行为
     *（目录增长后自动「已打开」），用户再关一次即可 —— 无任何不可逆后果。
     * 对照 `loomyPermanentLocked`（丢了会真烧永久积分）才需要独立文档。
     *
     * 缺键语义 = **没有任何供应商被关闭**，与升级前行为一致。
     */
    providerClosed?: ProviderClosedMap;
}
/**
 * 「供应商关闭意图」表：provider id → `true`。
 *
 * ⚠️ 只记 `true`（缺键 = 未关闭），与 {@link ModelDisableMap} 同口径 ——
 * 不留 `false` 噪音，文档不随开关操作膨胀。
 */
export type ProviderClosedMap = Record<string, boolean>;
/** 持久化后端的能力标识，供调用方决定要不要告警。 */
export type JetHubStoreKind = 'settings' | 'file' | 'memory';
/** Jet Hub 状态存取接口（同步读、异步写）。 */
export interface JetHubStore {
    readonly kind: JetHubStoreKind;
    /** 同步载入；文档不存在时返回 `undefined`（等价于"空"）。 */
    load(): JetHubState | undefined;
    /** 整体写入（账号与黑名单必须同时携带，见 AccountPool 的说明）。 */
    save(state: JetHubState): Promise<void>;
}
/**
 * 归一化「本机 OpenAI 网关」开关。
 *
 * 判据与 `sanitizePermanentLocks` 相反：**只有显式 `false` 才算停用**，
 * 其余（缺键 / `true` / 字符串 / 对象 / 数组）一律按启用处理。
 *
 * ⚠️ 方向不能反。文档缺失、被手工编辑成脏值、或老版本代码整体重写时丢了本键，
 * 都必须**回到默认启用** —— 那正是升级前的行为；反过来（只认 `true`）会让
 * 任何一次读取失败都变成「网关被静默关闭」，而用户根本不知道自己关过它。
 */
export declare function sanitizeGatewayEnabled(raw: unknown): boolean;
/**
 * 归一化「渠道原生搜索」总开关。
 *
 * 判据与 {@link sanitizeGatewayEnabled} **逐字同构**，理由也同向：
 * **只有显式 `false` 才算关闭**，其余（缺键 / `true` / 字符串 / 对象 / 数组）
 * 一律按启用处理。
 *
 * ⚠️ 方向不能反。文档缺失、被手工编辑成脏值、或老版本代码整体重写时丢了本键，
 * 都必须**回到默认启用** —— 反过来（只认 `true`）会让任何一次读取失败都变成
 * 「原生搜索被静默关闭」，用户根本不知道自己关过它，只会看到搜索突然开始
 * 要 API Key。
 */
export declare function sanitizeNativeWebSearchEnabled(raw: unknown): boolean;
/**
 * 归一化供应商自定义显示顺序（{@link JetHubState.providerOrder}）。
 *
 * 只保留非空字符串 id 并**去重**（保留首次出现位置）；非数组一律视为
 * 「无自定义顺序」（空数组）。⚠️ 这里**不做** provider 合法性校验：
 * 合法集合随插件版本变化，在此过滤会让「新版本加入 provider → 被旧版本
 * 代码重写文档」场景下的顺序无法保留 —— 展示层对数组中不认识 / 缺失的
 * id 自带稳定兜底，脏条目天然无害。
 */
/**
 * 归一化 MiniMax 国际站绕过分流用的 `X-Forwarded-For` 值。
 *
 * ## ⚠️ 为什么必须校验，而不是「用户填什么就发什么」
 *
 * 这个值会被**原样拼进 HTTP 请求头**。不校验的话，用户（或一份被篡改的
 * `state.json`）填入 `1.2.3.4\r\nX-Evil: 1` 就能向**上游**注入任意请求头
 * —— 那是典型的头注入（CRLF injection）。故判据必须**白名单字符集**，
 * 而不是「挡掉已知坏字符」。
 *
 * ## 取值口径
 *
 * - **只接受 IP 字面量**：IPv4（`a.b.c.d`，四段 0-255）与 IPv6
 *  （含 `::` 压缩、`%zone` 允许但**原样保留**——本机链路本地地址确实带它）；
 * - 主机名、`1.2.3.4, 5.6.7.8`（XFF 链）、前后空白以外的任何字符 ⇒ `undefined`；
 * - **空串 / 仅空白 ⇒ `undefined`**（语义 = 不附头，与缺键一致）；
 * - 超长（>128）⇒ `undefined`（最长合法 IPv6 也只有 45 字符）。
 *
 * ⚠️ 归一化只做 `trim()`，**不改大小写、不改缩写**：这个值是用户从自己的
 * 代理/VPN 那里抄来的，改写它只会让「为什么我填对了却不生效」更难查。
 *
 * ⚠️ 返回 `undefined` 表示「不附头」。**绝不能**把它变成空串头
 * （`X-Forwarded-For: `）—— 空值在 Akamai 侧会被当成非法并回退真实 IP，
 * 行为与不附头相同，但会污染上游日志。
 */
export declare function sanitizeMinimaxXff(raw: unknown): string | undefined;
export declare function sanitizeProviderOrder(raw: unknown): string[];
/**
 * 归一化「锁定永久积分」开关表。
 *
 * 与 `sanitizeDisabledModels` 同款口径：**只保留显式 `true`**，其余值（`false` /
 * 字符串 / 对象）一律丢弃 —— 于是「缺键」与「值为 false」在语义上完全一致
 * （未锁定），文档也不会随开关操作累积噪音。
 * ⚠️ 单测专门覆盖「`{ loomy: 'yes' }` 不得判成已锁定」这一类脏数据。
 */
export declare function sanitizePermanentLocks(raw: unknown): PermanentLockMap;
/**
 * 把**老的单字段**并进锁定表 —— 仅用于「独立文档尚不存在」的那一次迁移。
 *
 * 背景：锁定开关早于 `permanent-locks.json` 存在，住在 state.json 的
 * `loomyPermanentLocked` 里，老用户磁盘上只有它。不并进来的话，升级后 Loomy 的
 * 锁定会**静默消失**（用户看到的是「永久积分被烧掉了」且毫无提示）——
 * 那是最坏的一类回归。
 *
 * ⚠️ 调用方**只能在新文档不存在时**用它（`PermanentLockStore.load()` 的
 * `exists: false`）。新文档一旦存在就以它为准：否则用户在 desktop 里解锁 Loomy
 * 之后（表里没有 `loomy` 键 = 未锁定），只要镜像字段因为任何原因还留着
 * `true`，锁定就会被重新打开 —— 那种"解不掉"的开关比丢状态更难排查。
 */
export declare function mergeLegacyLoomyLock(locks: PermanentLockMap, legacyLoomyLocked: unknown): PermanentLockMap;
/**
 * 把读到的原始值归一化为 {@link ModelDisableMap}。
 *
 * 文档可能被手工编辑过、或残留老版本格式（如数组），因此逐层校验：任何一层
 * 不是对象就丢弃那一层，只保留「provider → 模型 → true」。**只把显式 `true`
 * 视为关闭**，其余值一律忽略，避免与 `disabledModelsFor` 的判定产生分歧。
 */
export declare function sanitizeDisabledModels(raw: unknown): ModelDisableMap;
/**
 * 把读到的原始值归一化为 {@link ProviderClosedMap}（Gitee issue IKP8OF）。
 *
 * 判据照 {@link sanitizeDisabledModels} 的形态：**只把显式 `true` 视为关闭意图**，
 * 其余（`false` / `1` / `'true'` / `null` / 对象 / 数组）一律忽略。
 *
 * ⚠️ 宽松接受 truthy 是**危险方向**：`'false'` 是非空字符串（truthy），
 * 被当成关闭意图会让该供应商的**全部模型**静默从选择器消失，用户只看到
 * 「模型全没了」而无从归因。故必须严格 `=== true`。
 */
export declare function sanitizeProviderClosed(raw: unknown): ProviderClosedMap;
/**
 * 归一化聚合 provider 的「拒绝轮换」表（见 {@link AggregateRejectionMap}）。
 *
 * 判据（照 {@link sanitizeDisabledModels} 的形态）：
 *
 * - 只有**显式 `true`** 算拒绝（`false` / `1` / `'true'` / `null` 都不算）——
 *   宽松接受 truthy 会让 `'false'`（非空字符串）被当成拒绝，用户莫名其妙丢一个渠道；
 * - **空层不保留**：不留 `{ m: {} }` / `{ m: { buddy: {} } }` 这类无意义噪音；
 * - 任何畸形输入（含**数组** —— `typeof [] === 'object'`，只判 object 会让它通过）
 *   退化为空表。
 *
 * ⚠️ 用 `Object.entries` 遍历**自有**键 ⇒ 原型链键（`constructor` 等）天然不会被
 * 误当条目（与 `canonical-models.ts` 的 M9 是同一类风险；那里需要显式 `Object.hasOwn`，
 * 这里由 `entries` 天然保证 —— 故**不要**改成 `for (const k in raw)`）。
 */
export declare function sanitizeAggregateRejections(raw: unknown): AggregateRejectionMap;
/**
 * 归一化聚合「显式允许」白名单。
 *
 * 判据与 {@link sanitizeAggregateRejections} **逐格同构**（只认显式 `true`、空层不保留、
 * 畸形退化空表、`Object.entries` 遍历自有键）—— 两张表口径一致才能让上层用同一套读法。
 *
 * ⚠️ 判据**不能宽松接受 truthy**：表里一旦被 `1` / `'true'` 污染，下次读取就有人按 truthy
 * 判成「允许」= 静默放行一个我们没有余额信息的渠道。
 */
export declare function sanitizeAggregateAllowed(raw: unknown): AggregateAllowedMap;
/**
 * 归一化聚合**手工顺序**表。
 *
 * 判据（三条都必须，缺一条就是静默失效）：
 *
 * - 元素必须是**字符串且含 NUL 分隔符** —— 否则它在适配器里解析不出 `(provider, realId)`，
 *   会被静默忽略 ⇒「顺序表看着有内容、实际全不生效」；
 * - **去重**（保留首次出现）—— 重复元素会让比较器**非确定**（同一候选有两个位次）；
 * - 空数组 **丢键**（= 未自定义，与 `providerOrder` 同语义）。
 */
export declare function sanitizeAggregateOrder(raw: unknown): AggregateOrderMap;
/**
 * 归一化排序模式：**只有字面量 `'manual'`** 认作手工序，其余（含缺键 / 畸形 / 大小写不同）
 * 一律回落到 `'expiry'` = 升级前行为。
 */
export declare function sanitizeAggregateOrderMode(raw: unknown): AggregateOrderMode;
/**
 * 从拒绝表里移除「该渠道在该虚拟模型下」的**整层**。
 *
 * ⚠️⚠️ 这是 **D4 降级语义**的恢复路径，**只留这一份实现**：`AccountPool.setAggregateRejected`
 * 的 `false` 分支调它（`setAggregateAllowed` **不调** —— 两表各有各的域，见
 * {@link AggregateAllowedMap} 的说明）。
 *
 * ## 为什么是「整渠道层」而不是「只删这一个 realId」
 *
 * D4 规定：`(虚拟模型, 渠道)` 下有 `true` 记录、但那些 `realId` **都不在**当前候选中
 *（id 漂移）⇒ **降级为渠道级拒绝**。而漂移的**旧键会一直留在表里** ⇒ 用户按降级告警的
 * 指引来面板「重新打开」**当前**候选时，若只删**当前**键，**旧键仍在** ⇒ 降级判据依然成立：
 *
 * - 面板用「该 realId 在不在表里」判断显示 ⇒ 显示「参与轮换」；
 * - 宿主实际**仍拒绝** ⇒ **显示与行为分叉**，告警指引的那条恢复路径**走不通**。
 *
 * 用户「重新打开」的意图是「让这个渠道在这个模型下重新参与」，而 D4 本就是**渠道级**语义
 * ⇒ 唯一自洽的结果就是**整渠道恢复**。
 *
 * ⚠️ 调用方**不得**在清层后再把 `perProvider[provider] = perRealId` 挂回去
 *（初版正是如此：删除被自己覆盖，降级不解除；独立审计用真实池实测证伪）。
 */
export declare function clearRejectionLayer(rejections: AggregateRejectionMap, canonicalId: string, provider: string): AggregateRejectionMap;
/**
 * 白名单侧写入（不可变；空层不保留）。
 *
 * 唯一调用方是 `AccountPool.setAggregateAllowed(..., true)`。
 */
export declare function withAllowed(allowed: AggregateAllowedMap, canonicalId: string, provider: string, realId: string): AggregateAllowedMap;
/**
 * 白名单侧**单键**删除（不可变；空层逐级清理）。
 *
 * ⚠️ 唯一调用方是 `AccountPool.setAggregateAllowed(..., false)` —— **只删同键**：
 * 同渠道其它被手工打开的候选必须保留（用户逐条打开的是**候选**，不是渠道）。
 */
export declare function withoutAllowed(allowed: AggregateAllowedMap, canonicalId: string, provider: string, realId: string): AggregateAllowedMap;
/**
 * 归一化账号条目数组。
 *
 * 判据刻意保守：只保留同时具备 `id` / `provider` / `credentialRef` 三个非空
 * 字符串的条目 —— 缺任何一个都无法解析凭据，留着只会在选号时反复失败。
 * 其余字段按原样透传（`enabled` / `modelRateLimits` 等由下游各自判空）。
 *
 * ## ⚠️⚠️ 必须按 `id` 去重（真实缺陷，对抗审计实测证伪）
 *
 * `id` 是账号的**唯一键**：`updateAccount` / `removeAccount` / `reorderAccounts`
 * 全都 `findIndex(a => a.id === id)`，只命中**第一条**。池里出现两条同 id 时，
 * 第二条**永远改不动、删不掉**（幽灵账号）。
 *
 * 原先只有 `mergeAccounts` 内部去重，而 `replaceAll`（备份导入的**默认模式**）
 * 不去重 ⇒ 一份手工编辑过的备份即可把两条同 id 写进池里。后果实测**远不止**
 * 幽灵账号：沉底函数按 id 匹配会写出 `undefined` 空洞，使该 provider 的
 * `getAvailableAccount` / `listAccounts` 全部抛错（整条推理链崩），且空洞经
 * `JSON.stringify` 变 `null`、重启后被本函数丢弃 ⇒ **账号永久丢失**。
 *
 * ⚠️⚠️ **去重有「两层」，缺一不可**（第二层是独立审计实测证伪后补的）：
 *
 * 1. **本函数（归一化层）**：清洗**入口**数据 —— 后端载入、`replaceAll`、
 *    `mergeAccounts` 都经它。
 * 2. **`AccountPool.writeAccounts`（唯一写入收口点）**：`addAccount` 等路径
 *    **不经过本函数**（它直接 `writeAccounts([...readAccounts(), entry])`），
 *    而 `addAccount` 有 20+ 个调用点（各 `*-auth.ts` 登录落库、`account.create`、
 *    `opencode-rpc`、`ensureDefaultAnonymousSlot`）⇒ 只靠本层，「池里两条同 id」
 *    **仍可达**。
 *
 * ⚠️ 本层**不能**声称「写盘时自愈」：`updateAccount` / `setAccountsEnabled` /
 * `clearModelRateLimits` / `updateModelRateLimit` / `setOpencodeProxy` 等
 * 8 条写路径都**不调本函数**。真正让「历史遗留重复条目」自愈的是**载入路径**
 * （两种后端的 `load()` 都经本函数），以及 `writeAccounts` 的收口去重。
 *
 * 保留**首次出现**的条目（与「先到先得」的直觉一致；重复条目的字段差异
 * 不合并 —— 无法判断哪份更新，合并反而会造出谁都没写过的混合体）。
 */
export declare function sanitizeAccounts(raw: unknown): ProviderAccountEntry[];
/**
 * 判定一个「限流解禁时刻」是否为**可用的毫秒时间戳**。
 *
 * ## ⚠️⚠️ 这是读写两侧**共用的唯一谓词**（真实缺陷，独立审计实测证伪）
 *
 * 原先读取侧（{@link sanitizeAccounts} 的 `sanitizeModelRateLimits`）判据是
 * 「有限正数」，而写入侧（`AccountPool.updateModelRateLimit`）只拒 `!Number.isFinite`
 * —— 两处**并不同源**，且读取侧的上界**不够严**：
 *
 * `1e308` 是「有限正数」，能穿过过滤落进池；而它**超出 `Date` 的合法范围**
 * （上界 ±8.64e15）。后果是下次该 (账号, 模型) 真撞限流时，
 * `updateModelRateLimit` 里 `new Date(current).toISOString()` 抛
 * **`RangeError: Invalid time value`** —— 而 17 个 `updateModelRateLimit` 调用点里
 * **16 个没有 try**（llm-adapter ×3、各 adapter、account-probe ×3），异常直接冒到
 * 推理路径与「重测」路径。
 *
 * 可达输入是**手工编辑过的备份文件**（正是本模块要防的那类输入）：
 * `modelRateLimits: {"glm-5.2": 1e308}`。
 *
 * ⇒ 判据收敛到本函数一处，读写两侧都调它。**不要再各写一份**。
 *
 * 上界取 `8.64e15`（`Date` 的最大毫秒值，`8640000000000000`）：
 * 超过它的值 `new Date(v).getTime()` 为 `NaN`，任何 `toISOString()` 都会抛。
 *
 * @param value 待判定的值（任意类型，非数字一律 false）。
 * @returns 是否是「可安全交给 `new Date()` 的毫秒时间戳」。
 */
export declare function isValidResetAtMs(value: unknown): value is number;
/** `Date` 可表示的最大毫秒值（±8.64e15）。 */
export declare const MAX_DATE_MS = 8640000000000000;
/**
 * 由账号凭据 ref 反推 provider；不是账号 ref 形态时返回 `undefined`。
 *
 * 用途是**合并导入的「ref 占用」检查**（`src/backup.ts`）：备份里被采纳账号引用的
 * ref 若已被本机**另一个**账号占用，回写它会静默覆盖本机凭据。调用方需要知道
 * 该 ref 归属哪个 provider 才能判断「占用它的那条账号是不是同一个号」。
 *
 * ⚠️ 判据与 {@link accountFromCredentialRef} **同源**（同一个正则、同一张表）——
 * 不要再写第二份「前缀 → provider」映射，本项目已有「一文件两套同义判据」的事故史。
 * ⚠️ 单凭据回退 ref（`CODEARTS_ACCESS_TOKEN` / `BUDDY_ACCESS_TOKEN` 等）不含
 * `_ACCOUNT_`，故返回 `undefined` —— 它们不是账号 ref，调用方应自行决定如何处理。
 */
export declare function providerOfAccountRef(ref: string): string | undefined;
/**
 * 解析状态文档所在目录。
 *
 * 优先级：`DSH_JET_HUB_STATE_DIR`（单测隔离用）→ `profileContext.home`
 * → `$DSH_HOME` → `~/.dsh`。与 `dsh-home-paths` 的 `resolveDshHome` 同序。
 *
 * ⚠️ `ctx` **必传**（2026-10-06 复审 !66 收紧）：本函数是**所有**插件状态文档
 * （`state.json` / `permanent-locks.json` / `badge-preferences` / `auto-checkin` /
 * `gemini-sigstore` / `dead-models`）的**唯一** home 解析入口，必须保证它们落在
 * 同一目录。PR !66 曾把它放宽成可选、并在 `dead-model-store` 里传 `undefined` ——
 * 那会**跳过优先级更高的 `profileContext.home`**，在 profile home 与 `$DSH_HOME`
 * 不相等时把失效表写到另一个目录，造成「账号池在 A、失效表在 B」的分裂，
 * 正是 `permanent-lock-store.ts` 明确警告过必须避免的情况。
 */
export declare function resolveJetHubHome(ctx: Context): string | undefined;
/**
 * 按能力探测创建持久化后端（见文件头）。
 *
 * 顺序刻意是「老契约优先」：在 ≤0.1.6 上必须继续把数据写在 settings 文档里，
 * 否则升级/回退版本会看到两套互不相识的数据。
 */
export declare function createJetHubStore(ctx: Context): JetHubStore;
//# sourceMappingURL=jet-hub-store.d.ts.map