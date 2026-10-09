/**
 * 「渠道余额 → 最早失效时刻」的**唯一口径**。
 *
 * ## 为什么单独一个文件（而不是并进 `aggregate-core.ts` / `aggregate-adapter.ts`）
 *
 * | 候选位置 | 为什么不行 |
 * |---|---|
 * | `aggregate-adapter.ts` | `auto-adapter.ts` 的 `expiryOf` 要复用它 ⇒ 依赖方向变成 `auto-adapter → aggregate-adapter`（**层次颠倒**，聚合适配器是更上层的东西） |
 * | `aggregate-core.ts` | 该文件定位是**纯逻辑**（哨兵 / 排序 / 倍率解析，模块头明写、零 import），而本模块要发网络请求 ⇒ 把 IO 混进纯函数模块，且 `aggregate-core.spec.ts` 这个纯函数单测会**被迫加载网络模块** |
 * | ✅ 本文件 | 单一职责；两个适配器都依赖它，方向正确 |
 *
 * ## ⚠️ 四个 `*Expiry` 是**搬移**进来的，不是复制
 *
 * 它们原先私有在 `auto-adapter.ts` 里（`private async buddyExpiry` 等）。Task 7
 * 把 `expiryOf` 改成委托本模块的 {@link createExpiryProbe} 后，若原处再留一份，
 * 就成了**同一语义两套实现**——本仓库对此有明确的红线记录（AGENTS.md 首条判据：
 * `buddy-growth.ts` 因两处对同一字段给出相反判据而产生**静默失效**：不报错、
 * 不崩溃、单测能过，只是把「没做到」说成「做到了」）。
 * Task 3 已用同样手法处理过 `pickSoonestProvider` / `priceFactorFromName`。
 *
 * @module src/aggregate-expiry.ts
 */
import type { AccountPool } from './account-pool.js';
import { type ExpiryProbe } from './aggregate-core.js';
import type { BuddyCredential } from './buddy.js';
import { CODEBUDDY } from './product.js';
import type { LoomyCredential } from './loomy.js';
import type { CodeArtsCredential } from './types.js';
import type { ZcodeCredential } from './zcode.js';
import { type LobsteraiProduct } from './lobsterai-product.js';
import type { LobsteraiCredential } from './lobsterai.js';
import { type TraeProduct } from './trae-product.js';
import type { TraeCredential } from './trae.js';
/**
 * 真实临期探针：**每个渠道折算成一个「最早失效时刻」**。
 *
 * ## 逐渠道判据（口径与 `jet-hub-auto` 完全一致，故复用同一套端点）
 *
 * | provider | 判据 | 依据 |
 * |---|---|---|
 * | buddy / workbuddy / **lobsterai** / **trae** | 有效资源包 `deductionEndTime` 的最小值（**共享** `sharedPackageExpiry`） | `credits.ts` / `lobsterai-credits.ts` / `trae-credits.ts` |
 * | loomy | `daily > 0` → 当日 24:00；否则 `permanent > 0 ? NEVER : UNUSABLE` | 命名池，无时间戳 |
 * | codearts | **`NEVER`（长期）** | ⚠️ **报文无任何时间字段**（实测三字段全空）⇒ 不臆造 |
 * | zcode | 各桶 `expiresAt`（秒）最小值；无带期余额时按当日 | `zcode-upstream.ts` |
 * | 其余（qoder / qodercn / cline / raccoon / minimax / gemini / opencode） | **本插件未接入** → `UNUSABLE` | 见设计文档 §9.1 |
 *
 * ## ⚠️ 未接入的渠道必须返回 `UNUSABLE`，**不能**返回 `NEVER`
 *
 * `NEVER` 的语义是「可用、只是无临期额度」，它**参与排序且可当选**。若把一个
 * 尚未实现的渠道折算成 `NEVER`，它会以「永久积分」的身份参与轮换 —— 而我们对
 * 它的余额**一无所知**（可能早就用尽了），结果是请求被发到一个没额度的渠道。
 * ⇒ 未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，不可把未知当可用。**
 *
 * ## 为什么只探「一个代表账号」
 *
 * 渠道**内部**的换号由各适配器每次请求现做（buddy/loomy 走余额选号器，其余走
 * `getAvailableAccount` + 429 换号）。本层只回答「这个渠道现在能不能用、它的
 * 临期额度大概什么时候作废」，不替它们选账号。
 *
 * ## ⚠️ 取代表账号时必须带**真实 modelId**
 *
 * `getAvailableAccount` 对空 `modelId` 会**跳过限流过滤**（`account-pool.ts`），
 * 于是取回的是「手动序第一个启用账号」——**哪怕它此刻正在限流**。后果是多账号
 * 池里临期额度被完全忽略。故这里先取一个真实模型 id 再取号。
 *
 * ⚠️ `AbortError` **不得**折算成 `UNUSABLE`：用户取消请求时看到「请先登录」
 * 是误导（真实缺陷，PR !69 审计实测）。
 */
/**
 * **已接入临期折算**的渠道 id（`createExpiryProbe` 的 `switch` 覆盖的那几家）。
 *
 * ## ⚠️ 为什么必须导出（审计轮次二实测证伪的缺陷）
 *
 * 聚合层的目录会**广告**出所有能推导出规范名的虚拟模型 —— 包括**候选全来自
 * 未接入渠道**的那些。但那些候选一律被折算成 `UNUSABLE`（正确，见上方注释），
 * 于是用户选中它拿到的是：
 *
 * ```
 * MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
 *                      或所有渠道都无可用账号）
 * ```
 *
 * ⇒ 把「**该渠道的临期折算尚未实现**」谎报成「**你没登录 / 渠道被关**」——
 * 正是本仓库反复修的那类误导性报错。实测（探针）：只接 `cline`（未接入）时
 * `listModels('aggregate')` 仍返回 `['auto','deepseek-v4-1-flash','muse-spark-1-3']`。
 *
 * ⇒ 聚合目录只播报「**至少有一个已接入候选**」的虚拟模型；`auto` 不受影响
 *（它的池跨全部渠道，任一已接入渠道有账号就能路由）。
 *
 * ⚠️ **本清单必须与下方 `switch` 的分支保持一致** —— 有专门用例锁它们相等
 *（`aggregate-expiry.spec.ts` 的「清单与 switch 一致」条），新增渠道时两处都要改。
 */
export declare const WIRED_EXPIRY_PROVIDERS: readonly string[];
/**
 * 临期折算结果的**缓存时长**（毫秒）。用户 2026-10-07 要求加缓存，TTL 由用户在
 * 60 / 90 / 120 中选定 —— **取 60**。
 *
 * ## 为什么是 60
 *
 * - 与既有的 {@link BUDDY_BALANCE_CACHE_TTL_MS}（余额选号器，`60_000`）**同值** ——
 *   两处节奏一致，不会出现「选号用 30 秒前的数据、排序用 90 秒前的」这种分叉；
 * - 临期判据的最小粒度是**天**（资源包到期以天计）⇒ 60 秒滞后在语义上无害；
 * - 最短 ⇒ 用户改完渠道侧配置后最坏等待最短。90/120 只省极少量请求
 *  （面板与排序都不是高频路径），却让「刚登录的账号不出现在排序里」的窗口更长。
 */
export declare const EXPIRY_CACHE_TTL_MS = 60000;
/**
 * `createExpiryProbe` 的返回类型：临期探针 **+ 缓存失效入口**。
 *
 * ⚠️ 为什么是**交叉类型**而不是改 `ExpiryProbe` 本身：那个类型定义在
 * `aggregate-core.ts`（必须是**零 import** 的纯逻辑底座），而它只描述「给定渠道
 * 返回最早失效时刻」这一件事。缓存是**实现细节**，不该渗进底座类型。
 *
 * ⚠️ 为什么要暴露 `clear`：见 `createExpiryProbe` 返回处与 `src/index.ts`
 * 装配处的长注释 —— 缓存原先**没有任何失效通道**，导致刚登录的账号
 * 最长 60 秒对路由不可见（用户拿到误导性的「没有任何可用候选」）。
 */
export type ExpiryProbeWithCache = ExpiryProbe & {
    clear: () => void;
};
/** `createExpiryProbe` 的可选依赖（单测注入时钟用）。 */ export interface ExpiryProbeOptions {
    /** 当前时刻（毫秒）；默认 `Date.now`。 */
    now?: () => number;
    /** 缓存时长（毫秒）；默认 {@link EXPIRY_CACHE_TTL_MS}。 */
    ttlMs?: number;
}
export declare function createExpiryProbe(pool: AccountPool, firstModelIdOf: (provider: string) => Promise<string | undefined>, options?: ExpiryProbeOptions): ExpiryProbeWithCache;
/** buddy 系：有效资源包 `deductionEndTime` 的最小值；无有效包 → NEVER。 */
export declare function buddyExpiry(product: typeof CODEBUDDY, credential: BuddyCredential): Promise<number>;
/**
 * lobsterai：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `lobsterai-credits.ts` 从 ISO 8601 的 `expiresAt` 归一化而来）。
 *
 * ⚠️ 本渠道此前**不在** `WIRED_EXPIRY_PROVIDERS` 里，理由是
 * `auto-adapter.ts` 那句「其余 provider 没有跨账号的到期余额探测端点」——
 * **该理由对 lobsterai 不成立**（用户 2026-10-07 质疑后核实）。
 */
export declare function lobsteraiExpiry(credential: LobsteraiCredential, product: LobsteraiProduct): Promise<number>;
/**
 * trae：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `trae-credits.ts` 从条目级秒级 `expire_time` 换算而来）。
 *
 * ⚠️ 同 lobsterai：此前被那句（不成立的）理由排除在白名单外。
 */
export declare function traeExpiry(credential: TraeCredential, product: TraeProduct): Promise<number>;
/** loomy：有今日赠送 → 当日 24:00；只剩永久 → NEVER。 */
export declare function loomyExpiry(credential: LoomyCredential): Promise<number>;
/**
 * codearts：**积分账户的到期时间不可知 ⇒ 一律 `NEVER`（长期）**。
 *
 * ## ⚠️⚠️ 为什么不再算「当日 24:00」（真实缺陷，用户报障 2026-10-07）
 *
 * 用户看到聚合面板把 codearts 列为候选，问「codearts 中也没显示积分临期」。
 *
 * **实测探针**（本机两个真实账号，只读 GET `statistics/plugin`）：
 *
 * | 账号 | 类型 | `credit` |
 * |---|---|---|
 * | `A3E53911` | `isTokenPackage: true`（Token 计费） | `undefined`（无积分口径） |
 * | `82AD9D6E` | `isCreditPackage: true` | `22088.16`（**赠送**积分包） |
 *
 * 且 `packages[].cycleStartTime` / `cycleEndTime` / `expiredTime` **三个字段实测全空**
 * —— 与 `codearts-credits.ts` 的既有注释一致：「`statistics/plugin` **不下发**
 * 资源包的有效性/周期字段……如实置为有效、周期留空，**而不是臆造一个到期时间**」。
 *
 * ⇒ 旧实现（继承自 PR !69 的 `auto-adapter.ts` 折算表）写的是
 * 「有积分 ⇒ `nextUtc8DayStartMs()`（今日 24:00 作废）」—— 那**正是臆造**：
 * 接口没给过期时间，官方文档（README 引用）说的是签到积分「**自发放起 30 天内有效**」，
 * 两者都不是「今天 24:00」。
 *
 * **后果**：codearts 的失效时刻被算成「今天」⇒ 在「临期优先」排序里**永远排最前**，
 * 抢走了本该先用掉的**真正临期**额度（buddy 的资源包 / loomy 的当日赠送）。
 *
 * ⇒ 改为 `NEVER`（长期积分：排最后，但**不剔除** —— 没有临期额度时仍要用它）。
 * 与本仓库既有原则一致：**读不到就不猜**（`zcodeExpiry` 对「查不到」返回
 * `UNUSABLE` 而非 `NEVER`，也是同一条原则）。
 *
 * ⚠️ 两种「无到期信息」的情形在本函数里**合并处理**（都返回 `NEVER`）：
 * 有积分（到期未知）与无积分（Token 计费账户 / 余额为 0）。两者在排序上同为
 * 「不临期」，且**都不该被剔除** —— 账号本身是可用的。
 * 这与 `buddyExpiry` 的「无有效包 → NEVER」是同一口径。
 *
 * ⚠️ 若将来接口开始下发周期字段，应改为读真实值（`packages[].expiredTime` 等），
 * **不要**恢复成某个固定估算。
 */
export declare function codeArtsExpiry(credential: CodeArtsCredential): Promise<number>;
/** zcode：各桶 `expiresAt`（秒）最小值；无桶但有可领活动 → 当日 24:00。 */
export declare function zcodeExpiry(credential: ZcodeCredential): Promise<number>;
//# sourceMappingURL=aggregate-expiry.d.ts.map