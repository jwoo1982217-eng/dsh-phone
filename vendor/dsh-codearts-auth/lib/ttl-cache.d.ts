/**
 * 带 **TTL** 与**在飞去重**的小缓存。
 *
 * ## 为什么需要（对齐官方 ZCode，2026-10-01）
 *
 * 官方闭源版渲染层产物里的 `f3()`（`out/renderer/assets/styles-*.js`）：
 *
 * ```js
 * let u3 = null, d3 = null
 * async function f3(e) {
 *   const t = Date.now()
 *   if (u3 && u3.expiresAt > t) return u3.value      // ← 命中缓存
 *   if (d3) return d3                                // ← 在飞去重
 *   d3 = (async () => { … u3 = { value: n ?? null, expiresAt: t + 6e4 } … })()
 *         .finally(() => { d3 = null })
 *   return d3
 * }
 * ```
 *
 * 两个语义都对得上我们的需求：
 * - **TTL 60 秒**（`t + 6e4`）：captcha **配置**（region/prefix/sceneId）极少变，
 *   但也不该永久缓存 —— 服务端改动后要能自愈。
 * - **在飞去重**：并发请求只发一次底层调用。
 *
 * ## 与 `index.ts` 现有实现的关键差异（真实缺陷）
 *
 * 现状是 `zcodeCaptchaConfigPromise ??= (async () => …)()` —— 那是**永久缓存**：
 * 赋过一次就**再也不刷新**。后果是服务端换 `sceneId`／灰度切换后，进程必须
 * 重启才能跟上；而若第一次拉取恰好失败（网络抖动），`??=` 会把**失败结果**
 * 也一起记住（下面 `fetchZcodeCaptchaConfig` 失败返回 `undefined`，
 * 而调用方回退到兜底值 —— 那个兜底值同样会被永久固化）。
 */
/** 构造选项。 */
export interface TtlCacheOptions<T> {
    /** 缓存有效期（毫秒）。`ttlFor` 省略时，每个值都用它。 */
    ttlMs: number;
    /** 真正的加载函数（**失败**应抛错；返回值可为 `undefined` 表示「无结果」）。 */
    load: () => Promise<T>;
    /**
     * 按**结果**决定这一条自己的有效期（毫秒）；省略时一律用 `ttlMs`。
     *
     * 需求来自「用量徽标」：拿到真实读数的结果值得缓存久一点，而**全部账号都
     * 失败**的那种结果只是当时的网络/凭据状态，缓存久了会让用户修好凭据之后
     * 仍盯着「用量不可用」。与 `buddy-balance-selector.ts` /
     * `loomy-balance-selector.ts` 既有的「成功 60s / 失败 5s」口径同源。
     *
     * ⚠️ 返回值非法（非有限数 / 负数）时**回落到 `ttlMs`**，不抛错也不当成 0：
     * 当成 0 会让这个缓存变成「永不命中」，把上游请求量悄悄放大一个数量级。
     */
    ttlFor?: (value: T) => number;
    /** 取当前时刻（注入以便单测）。 */
    now?: () => number;
}
/**
 * 缓存项。`ttlMs` 是**写入时**按 `ttlFor` 定下的、这一条自己的有效期。
 *
 * ⚠️ **导出**（原先是模块私有的）：`peekStale()` 的返回类型要携带它，
 * 而一个「返回私有类型」的公开方法在 `.d.ts` 里无法表达 —— TS 会把
 * `peekStale` 标成返回不可命名的类型，跨包调用方拿不到 `.value` / `.stale`。
 */
export interface Entry<T> {
    value: T;
    atMs: number;
    ttlMs: number;
}
/**
 * 单个值的 TTL 缓存 + 在飞去重。
 *
 * ⚠ **失败不缓存**：`load()` 抛错时清掉在飞标记并**向上抛** ——
 * 让调用方自己决定回退（例如 captcha 配置回退到兜底值），
 * 而**不要把失败固化**（那正是现状 `??=` 的缺陷）。
 */
export declare class TtlCache<T> {
    private entry;
    private inflight;
    private readonly ttlMs;
    private readonly ttlFor;
    private readonly load;
    private readonly now;
    constructor(options: TtlCacheOptions<T>);
    /**
     * 取缓存值；过期则重新加载。
     *
     * @param options.force - 强制绕过缓存重新加载（用于「服务端拒绝后刷新配置」）。
     */
    get(options?: {
        force?: boolean;
    }): Promise<T>;
    /**
     * 只看缓存（**不触发加载**）。过期返回 `undefined` 并顺手丢弃。
     *
     * 诊断与单测用；`get()` 内部也走它，避免两处 TTL 判据漂移。
     */
    peek(): Entry<T> | undefined;
    /**
     * ★ 看**过期后**的条目（陈旧兼顶），**不触发加载**。
     *
     * ## 为什么要有它（用户 2026-10-16 的要求）
     *
     * 「用底层缓存；加载如果得不到新数据，应该读出旧数据，不能直接返回错误
     *（除非旧数据也没有）」—— {@link peek} 在条目过期那一刻就把 `this.entry`
     * 丢弃了，于是「上次成功读到的值」在取数失败时**已经取不回来**。
     *
     * ## ⚠️ 为什么是**独立方法**而不是给 `peek` 加参数
     *
     * `peek()` 是**严格 TTL** 判据，被 `get()` 与多处调用方共用；给它加开关会
     * 让「这个缓存到底严不严格」变成运行期才确定的事 —— 那正是本仓库红线
     * 「同一语义两套判据」的形态。⇒ 两条语义各占一个方法名，调用点**写死**。
     *
     * ## 语义
     *
     * - 有条目（无论新鲜或过期）⇒ 返回它，并附 `stale: true` 标记；
     * - 一次都没写进过 ⇒ 返回 `undefined`（**没有旧数据可兼顶**，调用方只能报错）；
     * - ⚠️ **不丢弃**过期条目：兼顶之后取数成功会覆盖它、失败会继续用它，
     *   两者都不需要「先扔掉再重取」—— 丢弃发生在 `write()` 里。
     *
     * ⚠️ **返回值带 `stale` 标记是刻意的**：调用方据此告诉用户「这是 HH:MM 的
     * 值」，否则用户会把几分钟前的数字当成现状（`balance-cache.ts` 依赖它）。
     */
    peekStale(): (Entry<T> & {
        stale: true | false;
    }) | undefined;
    /** 写入一个已知值（例如从别处拿到的新配置，避免下一次白加载）。 */
    set(value: T): void;
    /** 写入缓存项：有效期在**这一刻**定下（见 `TtlCacheOptions.ttlFor`）。 */
    private write;
    /** 这一条该缓存多久；`ttlFor` 缺省或返回非法值时用构造参数。 */
    private effectiveTtl;
    /** 清空（关停时调用）。 */
    clear(): void;
}
//# sourceMappingURL=ttl-cache.d.ts.map