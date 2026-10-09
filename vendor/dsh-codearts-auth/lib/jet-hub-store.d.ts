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
}
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
 * 归一化供应商自定义显示顺序（{@link JetHubState.providerOrder}）。
 *
 * 只保留非空字符串 id 并**去重**（保留首次出现位置）；非数组一律视为
 * 「无自定义顺序」（空数组）。⚠️ 这里**不做** provider 合法性校验：
 * 合法集合随插件版本变化，在此过滤会让「新版本加入 provider → 被旧版本
 * 代码重写文档」场景下的顺序无法保留 —— 展示层对数组中不认识 / 缺失的
 * id 自带稳定兜底，脏条目天然无害。
 */
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
 * 归一化账号条目数组。
 *
 * 判据刻意保守：只保留同时具备 `id` / `provider` / `credentialRef` 三个非空
 * 字符串的条目 —— 缺任何一个都无法解析凭据，留着只会在选号时反复失败。
 * 其余字段按原样透传（`enabled` / `modelRateLimits` 等由下游各自判空）。
 */
export declare function sanitizeAccounts(raw: unknown): ProviderAccountEntry[];
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
 * 正是 `permanent-lock-store.ts:129-133` 明确警告过必须避免的情况。
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