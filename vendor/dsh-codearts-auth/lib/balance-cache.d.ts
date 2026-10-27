/**
 * 账号余额**读数**的共享缓存（基础设施层）。
 *
 * 规格：`docs/superpowers/specs/2026-10-15-aggregate-gating-manual-order-design.md` §5.7
 *
 * ## ⚠️⚠️ 本模块的定位（用户 2026-10-15 的更正原话）
 *
 * 「为什么不能更新账号积分用共享缓存，取号逻辑只是在调用缓存的时候取舍的问题，
 * 不影响刷新账号积分缓存呢，账号积分缓存是更底层基础设置，计算怎么取号是
 * 基础设施上的使用逻辑」
 *
 * ⇒ 本模块共享的是「**同一账号的余额读数**」，**不是**「谁该被读」：
 *
 * | 层 | 谁负责 |
 * |---|---|
 * | 缓存（本模块） | 同一个 `(provider, accountId)` 在 TTL 内复用同一次读数 |
 * | 取数（注入的 `fetch`） | 各渠道自己的协议（本模块**不认识**任何上游形状） |
 * | **取舍**（调用方） | 积分面板要**全部**账号（含停用）；用量徽标只要**启用**账号；聚合只要**可用**账号 |
 *
 * ⚠️ 三者不要混：把「谁该被读」塞进本模块，会让同一个账号在不同调用路径下拿到
 * **不同的缓存条目**（那正是「共享缓存」失效的形态）。
 *
 * ## 为什么用 `TtlCache`（而不是自建 Map）
 *
 * 与 `usage-badge.ts`（`:180-191` 的 `cacheFor`）**同款**：懒建实例、`ttlFor` 按结果分档。
 * 自建一份会立刻产生「两套 TTL 判据」——本仓库红线。
 *
 * ## ⚠️ `load` 是零参契约 ⇒ 用「可变槽」把条目喂进去
 *
 * `TtlCache.load` 的签名是 `() => Promise<T>`（`src/ttl-cache.ts:39`），而
 * 「这次要读哪个账号」是**运行时**才知道的。⇒ `read()` 先把条目写进 `slots`，再
 * 调 `cacheOf(key).get({ force })`；`load` 从槽里取。
 *
 * ⚠️ **这是本模块唯一需要解释的技巧**：换成「把条目闭包进 `load`」要求每个账号一个闭包，
 * 而账号是运行时才知道的（且账号会增删）⇒ 只能靠槽。
 *
 * ## 三条必须遵守的约束（规格 §5.7.4）
 *
 * 1. **取消语义**：调用方 `await read(...)` 之后必须自己 `signal?.throwIfAborted()` ——
 *    用户可见的取消行为**逐字节不变**（立刻 `AbortError`），但**本次上游填充会跑完**
 *    （读数进缓存，不浪费）。⚠️ 「abort 不得被折叠成 `UNUSABLE`」是本仓库复发过三次的
 *    铁律，本处是**新增的第四种形态**：`fetch` 抛的中止错误必须**原样上抛**，
 *    **不得**记成 `error` 读数。
 * 2. **顺序**：逐账号**串行**取数，**不得**改成 `Promise.all` —— 并发打上游会触发限流
 *    （照 `collectCreditBalances`（`src/jet-hub-rpc.ts`）的既有体例，那里有实测记载）。
 * 3. **失败是「值」不是「抛错」**：`{ error }` 读数按 `failureTtlMs` 缓存（15 秒）。
 *    若让失败抛错，`TtlCache` 的「抛错不缓存」会让失败被**无限重试**
 *    （上游限流时那是最坏结果）。
 *
 * @module src/balance-cache.ts
 */
import type { ProviderAccountEntry } from './types.js';
/**
 * 刷新周期缺省值（60 秒 = 共享缓存 `ttlMs` 的一半）。
 *
 * ⚠️ **理由（别丢）**：周期恰等于 `ttlMs` 时，条目会在**刚过期的那一刻**才被刷
 * ⇒ 读路径仍会频繁撞上「陈旧且后台刚开始刷」，常新目标落空。取一半 ⇒ 任何时刻
 * 至少有半个周期的余量。
 *
 * ⚠️ **刻意不新增第三套 TTL 常量**：它与 `ttlMs` 是**同一条语义的两个尺度**
 * （缓存寿命 / 保鲜节奏），写死一份会让人以为二者可以各自独立调。
 *
 * ⚠️ **导出**是为了装配层不再写死同一个字面量（`src/index.ts` 的 `intervalMs`）——
 * 那正是「提常量」要消除的重复；装配层**必须**引用本常量而不是重打一遍 `60_000`。
 */
export declare const REFRESH_PERIOD_FALLBACK_MS = 60000;
/**
 * 一个账号的一条读数。
 *
 * ⚠️ `value` 是**上游原样形状**（本模块不解释它）—— 各消费者按自己渠道的协议读它
 *（buddy 系是 `CreditBalance`、officeace 是套餐摘要、…）。
 * ⚠️ `error` 存在 ⇒ 这是**失败读数**（短 TTL）；`value` 此时为 `undefined`。
 *
 * ⚠️⚠️ **例外：兼顶读数（`StaleBalanceReading`）允许两者同时存在** ——
 * 「本次取数失败」与「上次读到的值仍然可用」是两件同时为真的事。
 * ⇒ **判「这条读数能不能用」不能只看 `error`**：
 *   - 只吃 `read`/`readOne` 的消费者（如聚合折算）：`error === undefined` 才可用，
 *     且它们**永远拿不到**兼顶读数（那是 `readStale` 的独有形状）；
 *   - 吃 `readStale` 的消费者：按 `stale` 判断，并把 `error` 当「本次失败原因」展示。
 */
export interface BalanceReading {
    /** 取到该读数的时刻（毫秒）。 */
    at: number;
    /** 上游原样返回值（失败时为 `undefined`）。 */
    value: unknown;
    /** 失败原因（人话）；成功时为 `undefined`。 */
    error?: string;
    /**
     * ★ 这条读数**是不是上一次的成功值**（陈旧兼顶，2026-10-16 审计 P1-2 修正）。
     *
     * ## 为什么需要它（实测复现的缺陷）
     *
     * `readStale` 兼顶成功时会**回滚写入** `{ at: 旧时刻, value: 旧值 }` 以保住
     * 兼顶能力。那条读数**不带 `error`** ⇒ 被 `ttlFor` 判成**成功读数** ⇒
     * 落盘 120 秒 TTL ⇒ 紧接着再打开一次面板时 `get()` 在 TTL 内**直接命中、
     * 不回源** ⇒ 返回 `{ stale: false }`。
     *
     * ⇒ 用户第一次看到「本次查询失败，显示的是 HH:MM 的数据」，第二次看到的是
     * **一条看起来完全正常的余额**，会据此认为「上游已恢复」—— 恰恰相反，
     * 上游还在挂着。**这比报错更糟**（它看起来成功了）。
     *
     * ## 为什么用字段而不用「改 TTL」来表达
     *
     * 另一条思路是把回滚条目的 TTL 设成 `failureTtlMs`（短档），让下一轮必定
     * 回源。但那会让「上游刚恢复」也要等满一个短 TTL 才被发现，且**不能**告诉
     * 用户「你现在看到的仍是旧值」—— 用户要的正是这个标注。
     *
     * ⚠️ **判据只在 `readStale` 内读**：其它消费者（`read` / `readOne`）拿到的
     *   仍是 `BalanceReading`，它们判的是 `error === undefined`，不受此字段影响
     *   （兼顶值对它们而言就是一条「有值的读数」，与既有行为一致）。
     */
    stale?: boolean;
}
/**
 * ★ 兼顶读数（{@link BalanceCache.readStale} 的返回值）。
 *
 * ⚠️ `value` **可能**有值（陈旧兼顶）也可能是 `undefined`（连旧值都没有）——
 *    「能不能用」看 `value !== undefined`，**不看** `error`。
 */
export interface StaleBalanceReading {
    /**
     * 值本身是**什么时候**取到的（毫秒）—— 即陈旧值的年龄。
     *
     * ⚠️ 与兼顶无关（即本次取数成功）时，它就是本次取数的时刻。
     */
    at: number;
    /** 上游原样返回值；**兼顶失败且无旧值**时为 `undefined`。 */
    value: unknown;
    /** 本次取数的失败原因；成功时为 `undefined`。**兼顶时它仍然有值**。 */
    error?: string;
    /** 该值是否来自上一次的缓存（`true` = 陈旧）。 */
    stale: boolean;
}
/** 一条要读的账号条目（**最少**只有 `id`；取数原语需要什么由调用方附带）。 */
export interface BalanceCacheEntry {
    /** 账号池条目 id（**缓存键的第二半**，必填）。 */
    id: string;
    /**
     * 该账号的**已解析凭据**（可选）。
     *
     * ⚠️ 聚合折算路径用它：`credentialExpiry(provider, credential, context)` 手上
     * **只有**凭据，没有账号池条目 ⇒ `cachedBalance(accountId)` 回填时要把凭据
     * 一起带进来，否则 `fetch` 拿不到凭据（它必须与 `*Expiry` 原语调的是**同一个**函数）。
     */
    credential?: unknown;
}
/** 构造选项。 */
export interface BalanceCacheOptions {
    /**
     * 成功读数的 TTL（毫秒）。
     *
     * ⚠️ 聚合折算用 **120_000**（规格 §5.7.4-3 的诚实登记：原先是 60 秒）：
     * 聚合是**多候选回落**结构，某渠道读数陈旧 60 秒的代价是「多一次失败尝试后回落」，
     * 用户看不到失败；换来的是上游请求不翻倍。面板侧有 5 分钟重探与手动 `force` 兜底。
     */
    ttlMs: number;
    /**
     * **失败**读数的 TTL（毫秒，默认 15_000）。
     *
     * ⚠️ 必须比 `ttlMs` 短一个数量级：把一次网络抖动缓存满 2 分钟，会让「查不到」
     * 伪装成「额度用尽」整整两分钟（`buddy-balance-selector.ts` 与 `usage-badge.ts`
     * 都有同款注释与同款修复）。
     */
    failureTtlMs?: number;
    /**
     * ★ **陈旧值最长兼顶**时长（毫秒，默认 15 分钟）。
     *
     * 用户 2026-10-16：「加载如果得不到新数据，应该读出旧数据，不能直接返回错误
     *（除非旧数据也没有）」。⚠️ 必须有上界 —— 无界兼顶会让一次读数命中后永久生效，
     * 用户看到的余额可能是一天前的，而 UI 只写「数据来自 HH:MM」。
     *
     * ⚠️ 这**不是** `failureTtlMs`：后者决定「一条**失败读数**缓存多久」，
     *   本项决定「**成功读数过期后**还能兼顶多久」。两者量级差 1~2 个数量级。
     */
    staleTtlMs?: number;
    /**
     * 单账号取数原语（**由装配层按渠道注入**）。
     *
     * ⚠️ 本模块**不认识**任何渠道协议；也**不含 self-heal**（续期留在
     * `credits.balances` / `credits.claimAll` 的**端点入口**，见规格 §5.7.1 末行）。
     */
    fetch: (provider: string, entry: BalanceCacheEntry) => Promise<unknown>;
    /**
     * 「这个错误是不是调用方取消」的判据（**由装配层注入共享实现**）。
     *
     * ⚠️⚠️ **不要在本模块里新写一份**：本仓库已经有 **4 份**同义实现
     *（`aggregate-adapter.ts` 的 `isAbortLike`、`aggregate-expiry.ts` 的简化版、
     * `auto-adapter.ts` 与 `raccoon-adapter.ts` 的内联）—— 「同一语义两套判据」是本仓库
     * 的红线，而那条红线正是被这类「顺手再写一份」破坏的。
     *
     * ⚠️ 缺省实现**只认** `name === 'AbortError'`（最保守的形状）；装配层应传
     * `aggregate-adapter.ts` 导出的共享判据（它还有 `code === 'ABORTED'` 与
     * 499 报文两条腿）。
     */
    isAbort?: (error: unknown) => boolean;
    /** 取当前时刻（注入以便单测）。 */
    now?: () => number;
}
/** 见模块头与 {@link createBalanceCache}。 */
export interface BalanceCache {
    /**
     * 逐账号命中/回源（**顺序执行**；同一账号在飞去重）。
     *
     * ⚠️ `entries` 决定「读哪些账号」—— 那是**调用方的取舍**（见模块头那张表）。
     * ⚠️ 返回的 Map 以 `accountId` 为键，**只含本次传入的账号**。
     */
    read(provider: string, entries: readonly BalanceCacheEntry[], options?: {
        force?: boolean;
    }): Promise<ReadonlyMap<string, BalanceReading>>;
    /** 只看缓存、不触发加载（面板用它显示「数据时间」）。未知键 / 已过期 ⇒ `undefined`。 */
    peek(provider: string, accountId: string): BalanceReading | undefined;
    /**
     * ★ 只看**过期后**的条目（不触发加载，**且不丢弃**它）。刷新器用它判「该不该刷」。
     *
     * ## 与 {@link BalanceCache.peek} 的差别**只有**「不丢弃过期条目」
     *
     * ⚠️ `peek()` 在条目过期那一刻会顺手丢弃（`src/ttl-cache.ts:129`）⇒
     * 拿它判「有多旧 / 是不是失败读数」会恒拿到 `undefined`。
     * ⇒ 两条语义各占一个方法名（`TtlCache` 也是这么分的），调用点**写死**。
     */
    peekStale(provider: string, accountId: string): (BalanceReading & {
        stale: true | false;
    }) | undefined;
    /**
     * ★ 后台重取**单个**账号（供 {@link createBalanceRefresher} 调用）。
     *
     * ⚠️ **不返回读数**：后台重取的价值全在「把新值写进缓存」，而调用方
     *   （读路径）刻意不等它。返回读数会诱使消费方误用它。
     * ⚠️ 失败已被 `fetchReading` 记成 `{ error }` 读数（模块头约束 3）；**abort
     *   会原样上抛**（约束 1），故刷新器侧必须 `.catch`（它刻意吃掉并记日志 ——
     *   后台刷新没有调用方可通知）。
     */
    refreshOne(provider: string, accountId: string, entry: {
        credential?: unknown;
    }): Promise<void>;
    /**
     * 取**一个**账号的读数（供「手上只有凭据、没有账号池条目」的路径用 —— 聚合折算）。
     *
     * ⚠️ 与 {@link read} 的差别只有**入参形态**：两者**共用同一份缓存**
     *（同一个 `(provider, accountId)` 的键）—— 那正是本模块的意义。
     * 若给这条路径另建一份缓存，同一个账号会被查两次（本模块要消除的正是它）。
     */
    readOne(provider: string, accountId: string, entry: {
        credential?: unknown;
    }, options?: {
        force?: boolean;
    }): Promise<BalanceReading>;
    /**
     * ★ **兼顶读数**（用户 2026-10-16 的要求）。
     *
     * 「用底层缓存；加载如果得不到新数据，应该读出旧数据，不能直接返回错误
     *（除非旧数据也没有）」—— {@link read} / {@link readOne} 在取数失败时
     * 返回的是 `error` 读数，**没有任何一条会回落到上一次的成功值**。
     *
     * ## 三条语义（逐条对应用户那句话）
     *
     * | 情形 | 返回 |
     * |---|---|
     * | 取数成功 | 新读数，`stale: false` |
     * | 取数失败，**有**旧的成功值 | **旧值** + `error`（本次失败原因）+ `stale: true` |
     * | 取数失败，**没有**旧值 | `error` 读数 + `stale: true`（无值可兼顶） |
     *
     * ⚠️ **`error` 与 `value` 同时存在**是这条路径独有的组合：`BalanceReading`
     *    的原注释说「`error` 存在 ⇒ 失败读数，`value` 为 `undefined`」——
     *    这里**刻意破例**，否则调用方无法区分「彻底查不到」与「拿旧值顶上」，
     *    而这两种的 UI 表现必须不同（后者要显示数据时间）。
     * ⇒ 因此**原有消费者不能直接吃这条读数**（它们的判据是
     *    `error === undefined` ⇒ 可用），见 {@link BalanceReading} 的新注释。
     *
     * @param staleTtlMs - 陈旧值**最长兼顶**时长（毫秒，默认 15 分钟）。
     *   ⚠️ 必须有上界：否则一次读数命中后就永久兼顶，用户看到的余额可能是一天前的，
     *   而 UI 只会写「数据来自 HH:MM」。
     */
    readStale(provider: string, accountId: string, entry: {
        credential?: unknown;
    }, options?: {
        force?: boolean;
        staleTtlMs?: number;
    }): Promise<StaleBalanceReading>;
    /**
     * **写入**一个已知读数（不触发取数）。
     *
     * ## ⚠️ 为什么需要它（而不是让消费者都走 `read`）
     *
     * `credits.balances` 端点的响应形状是 `{ balance, error?, extra? }`，比折算路径要的
     * `CreditBalance` **多两个字段**（Gemini 的 `extra`）⇒ 让端点「读」缓存会**丢字段**。
     * ⇒ 端点继续用自己的取数（响应逐字节不变），但把它已经拿到的 `balance`
     * **写回**本缓存 —— 于是折算路径能命中面板刚查过的那一条（那正是「共享读数」的收益）。
     *
     * ⚠️ `error !== undefined` 的读数**不要**写（失败是瞬时的，写进去会污染折算侧的判据）。
     */
    write(provider: string, accountId: string, reading: BalanceReading): void;
    /**
     * 清缓存：传 `provider` 只清该渠道，省略则清全部（关停时用）。
     *
     * ⚠️ **如实登记：当前没有任何生产调用者**（2026-10-16 审计实测，全仓 grep 只有
     * 测试调它）。这不是缺陷，而是**刻意**的取舍：正确性**不依赖**调用方记得清 ——
     * 折算序的正确性由 `aggregate-adapter.ts` 的 `routingFingerprint()`（拒绝表 +
     * 白名单 + 顺序表 + 模式**四项**）保证，拒绝/放行/顺序任何一项变化都会让
     * `choiceCache` 失效重算；而余额读数本身有 TTL（成功 120s / 失败 15s）自愈。
     *
     * ⇒ 保留它是为了两件事：① 关停时清理（若将来加 `dispose`）；② 测试隔离。
     * ⚠️ 若将来有人接上它，注意它是**共享**缓存 —— 清掉会连带作废徽标正在用的读数
     * （那正是本模块存在的意义），别当成「按渠道刷新」的顺手动作。
     */
    clear(provider?: string): void;
}
/**
 * 建一个余额读数缓存。见模块头的三条约束与「可变槽」的说明。
 */
export declare function createBalanceCache(options: BalanceCacheOptions): BalanceCache;
/** 后台刷新器的构造选项。见 {@link createBalanceRefresher}。 */
export interface BalanceRefresherOptions {
    /**
     * 列出**全部** provider 的账号（含停用），供刷新器决定刷什么。
     *
     * ⚠️ 类型是 `ProviderAccountEntry`（**不是** `ProviderAccountStatus`）——
     *    前者才有 `enabled` / `credentialRef` / `provider` 三个刷新器要读的字段。
     * ⚠️ 返回 Promise 与返回数组**都吃**（内部一律 `await`），故既可接
     *    `pool.listAllAccounts()`（实测是 `async`，见 `src/account-pool.ts:1308`），
     *    也可接同步的 `listAccountsByProvider` 拼接。
     */
    listAccounts(): readonly ProviderAccountEntry[] | Promise<readonly ProviderAccountEntry[]>;
    /**
     * ★ 按 `credentialRef` **解析**出已解析的凭据（返回 `undefined` = 取不到）。
     *
     * ## ⚠️ 为什么必须有这一腿（不是「顺手加的」）
     *
     * 生产取数原语 `fetchBalanceReading`（`src/index.ts`）在
     * `entry.credential === undefined` 时**直接抛「凭据未提供」** ⇒ 刷新器若传空
     * entry，**每一轮都会被记成失败读数**：外面看「刷新器在跑」，实则永远拿不到新值。
     *
     * ⚠️ 解析失败（返回 `undefined`）时刷新器**跳过该账号、不打上游** ——
     *   必然失败的请求只是浪费，还会让失败读数把该账号推进「跳过窗口」。
     */
    resolveCredential?(credentialRef: string): Promise<unknown>;
    /** 取当前时刻（注入以便单测）。 */
    now?(): number;
    /** 日志出口。 */
    info?(message: string): void;
    warn?(message: string): void;
    /** 兼顶上界的缺省值（默认 {@link DEFAULT_STALE_TTL_MS}）。 */
    staleTtlMs?: number;
    /** 定时器工厂（注入以便单测用假时钟）。缺省用全局 `setInterval`。 */
    setInterval?: (fn: () => void, ms: number) => {
        unref?: () => void;
    };
    /** 刷新周期（毫秒）。缺省 {@link REFRESH_PERIOD_FALLBACK_MS}（= 共享缓存 `ttlMs` 的一半）。 */
    intervalMs?: number;
}
/** 后台刷新器实例。见 {@link createBalanceRefresher}。 */
export interface BalanceRefresher {
    /** 武装定时器（**幂等**）。 */
    start(): void;
    /** 立即跑一轮（调用方不必 await —— 单测与装配都直接返回它）。 */
    tick(): Promise<void>;
    /** 解除武装（重复调用无害）。 */
    stop(): void;
    /** 是否已武装（诊断 / 守卫用）。 */
    isArmed(): boolean;
}
/**
 * ★ 后台刷新器：定时把**该刷的**条目重取一遍，让缓存常新。
 *
 * ## 为什么需要它（用户 2026-10-18 的原话）
 *
 * 「这个缓存不是应该一直存在并且自动在 2 分钟重新刷新，我们外面的请求是一直都缓存，
 * 和缓存每 2 分钟自己更新一次不矛盾，为什么 2 分钟后再读就过期了要重新直读呢？
 * 这个 2 分钟是 interval 不是 timeout」
 *
 * ⇒ 原实现是 **cache-aside**（读驱动）。读路径改成 stale-while-revalidate 后，
 *   陈旧命中**一个请求都不发**（提交 `a725101`：发了会与相邻账号的重取重叠，
 *   实测 `maxInflight = 2` ⇒ 触发风控）⇒ 重取这条腿**只剩本类**。
 *   本类补上「后台」那一半。
 *
 * ## 周期取值：默认 `ttlMs` 的一半
 *
 * 周期恰等于 `ttlMs` 时，条目会在**刚过期的那一刻**才被刷 ⇒ 读路径仍会频繁撞上
 * 「陈旧且后台刚开始刷」，常新目标落空。取一半 ⇒ 任何时刻至少有半个周期的余量。
 *
 * ## ⚠️ 三条判据（各对应一个真缺陷）
 *
 * | 条目状态 | 刷？ | 理由 |
 * |---|---|---|
 * | 从未读过 | ✅ | 否则它永远进不了缓存 |
 * | 成功读数，已过一个刷新周期 | ✅ | 正常保鲜 |
 * | 成功读数，仍在周期内 | ❌ | 没必要（读请求会命中，省一次上游） |
 * | 失败读数，未超 `staleTtlMs` | ❌ | 否则**每 15 秒打一次上游** |
 * | 失败读数，已超 `staleTtlMs` | ✅ | 不得永久卡在失败上 |
 *
 * ⚠️ 「失败条目跳过」是**新增判断**：失败读数走 15s 短 TTL，本意是
 * 「别把一次抖动缓存成『额度用尽』」；若每轮都重试，正好违背这条规则的原意。
 * 失败期间由 `lastSuccess` 的旧值兼顶着。
 *
 * ## ⚠️ 逐账号**串行**是本类的**承重约束**
 *
 * `a725101` 之前，串行由「读路径的 `for…of` + `await`」天然保证；删掉读路径的后台
 * 重取之后，**本类成了新的请求来源**，串行必须自己扛 ——
 * 守卫见 `tests/unit/balance-cache.spec.ts` 的「刷新**逐账号串行**」（**两个**账号，
 * 单账号时串行与并行不可区分）。
 *
 * ## 停用账号低频刷（不完全不刷）
 *
 * 停用只影响自动选号（仓库铁律「续期不得按 `enabled` 过滤」），凭据仍需保鲜 ——
 * 用户重新启用时不该拿到死凭据。但用户看不到它们，不值得每轮都打。
 * ⇒ 判据**从 `staleTtlMs` 派生，不新增常量**。
 */
export declare function createBalanceRefresher(cache: BalanceCache, options: BalanceRefresherOptions): BalanceRefresher;
//# sourceMappingURL=balance-cache.d.ts.map