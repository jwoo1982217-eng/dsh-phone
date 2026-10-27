/**
 * 远端模型目录的加载闸门：并发去重 + 失败冷却。
 *
 * ## 为什么需要它（实测，2026-10-01）
 *
 * DSH 宿主的 `buildModelCatalog` 会对**每个** provider `await listModels()`，
 * 再对**每个模型** `await resolveModelInfo()`。适配器里的 `resolveModel`
 * 同样会触发目录拉取，于是「目录没拿到」这件事会被放大成
 * **一次请求 × 每个模型**：
 *
 * - 拉取失败时原实现直接 `catch {}` 返回，`remoteModels` 保持 `undefined`
 *   ⇒ 下一次 `listModels` / `resolveModel` **再拉一次**；
 * - 返回空目录时同样不落缓存 ⇒ 同上。
 *
 * 而这些拉取的超时上限是 30–60 秒量级
 * （`src/buddy.ts` `REQUEST_TIMEOUT_MS = 60_000`、
 * `src/loomy.ts` `LOOMY_REQUEST_TIMEOUT_MS = 60_000`、
 * `src/raccoon.ts` `RACCOON_REQUEST_TIMEOUT_MS = 60_000` …），
 * 未登录或离线时表现就是「首屏加载模型巨长」。
 *
 * 另有并发维度：`listModels` 与 `resolveModel` 会被 DSH **并发**调用
 * （`Promise.all`），不去重会打出多份重复请求。
 * `src/cline-adapter.ts` 早先已单独处理过这一条，本模块把它抽成共用件。
 *
 * ## 三道语义
 *
 * 1. **命中缓存**：调用方自己判 `remoteModels !== undefined` 后直接返回，
 *    不进本闸门（保持既有「成功即永久缓存」的行为）。
 * 2. **并发去重**：同一次加载的多个调用共享同一个 Promise。
 * 3. **失败/空结果冷却**：`run` 判定这次**没拿全**目录时，
 *    在 `cooldownMs` 内不再重试。
 *
 * ⚠ 冷却只影响**拉取时机**，不影响兜底目录：调用方在冷却期间照旧回落到
 * 静态表，界面不会因此少模型。
 *
 * ## `got` 与 `complete` 是两个判据（issue IKJVTF）
 *
 * 返回值的两个字段语义**不同，不能合并**：
 *
 * - **`got`**：这次拿到了**非空**目录（**残缺也算**）⇒ 调用方据此**展示**，
 *   本闸门据此**广播** `llm/adapters-updated`。
 * - **`complete`**：这次把**所有来源**都拿全了 ⇒ 调用方据此**永久缓存**，
 *   本闸门据此**清冷却**。
 *
 * 合并成一个布尔会产生两个方向的缺陷，实测都出现过：
 *
 * - 只看「非空」：`recommended-models` 成功、`/api/v1/models` 失败时，
 *   残缺目录（少了 466 条按量计费模型）被当成「已加载」**永久缓存**
 *   （`if (this.remoteModels !== undefined) return` 短路），此后连预热重试
 *   都在短路处直接返回 ⇒ 只能重启 DSH。
 * - 只看「完整」：残缺时整个目录都不展示，用户的模型列表凭空消失。
 *
 * ⇒ **显示与广播按 `got`，永久缓存与清冷却按 `complete`**。
 */
/** 失败 / 空结果后的默认冷却时长。 */
export declare const REMOTE_CATALOG_COOLDOWN_MS = 30000;
/**
 * 一次目录加载的结果。
 *
 * ⚠️ 也接受**裸布尔**（向后兼容）：此时 `complete = got`，
 * 既有「只有一个来源」的适配器行为逐字节不变。
 */
export type CatalogLoadResult = boolean | CatalogLoadOutcome;
/** 归一化后的加载结果。 */
export interface CatalogLoadOutcome {
    /** 是否拿到了**非空**目录（残缺也算）。 */
    got: boolean;
    /** 是否**所有来源**都拿全了；省略时等于 {@link got}。 */
    complete?: boolean;
}
export interface RemoteCatalogGateOptions {
    /** 冷却毫秒数，默认 {@link REMOTE_CATALOG_COOLDOWN_MS}。 */
    cooldownMs?: number;
    /** 时钟注入（测试用），默认 `Date.now`。 */
    now?: () => number;
    /**
     * 目录**落地后**的通知回调（通常是广播 `llm/adapters-updated`）。
     *
     * ⚠️ 放在本闸门而非各适配器，是因为这里是十个适配器的**单点收口** ——
     * 分散成十份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
     *
     * ⚠️ 调用时机是 `await task` **之后**：那时适配器才刚把目录赋给
     * `remoteModels`，客户端重读才能拿到新数据；早于它广播等于白广播。
     *
     * ⚠️ 只在**本轮真正发起并拿到目录**（`got`）时调用 —— 命中缓存的短路
     * 与冷却期内的跳过都不通知（没有新数据，通知只会让客户端空刷）。
     */
    onLoaded?: () => void;
}
export declare class RemoteCatalogGate {
    private inFlight;
    private retryAt;
    private readonly cooldownMs;
    private readonly now;
    /**
     * 距**最近一次尝试**（不论成败）过去了多久，最小值为 0。
     *
     * ⚠️ 与 {@link retryAt} 是**两个不同的闸门**，别合并：
     * - `retryAt` 只在**失败/空结果**后置位，管「别立刻重试」；
     * - 本字段在**每次尝试后**都推进（包括成功），用来回答「上一次尝试距今
     *   多久了」—— 贴图门禁据此决定「值不值得为了重新判定能力而再拉一次」
     *   （issue IKJQ3M：能力未知时不放行图片，但要在合理间隔后重看一次目录）。
     *
     * 用**同一个 `now` 来源**取两次时间戳，才能与 {@link cooling} 保持一致，
     * 不出现「冷却判定用真实时间、这个判定用假时间」的分叉。
     */
    private lastAttemptAt;
    /** 目录落地后的通知回调（见 {@link RemoteCatalogGateOptions.onLoaded}）。 */
    private readonly onLoaded;
    constructor(options?: RemoteCatalogGateOptions);
    /**
     * 距上一次尝试的毫秒数；从未尝试过时为 `undefined`。
     *
     * ⚠️ 与 {@link cooling} 共用**同一个** `now` 来源，故调用方若替换了时钟，
     * 两者必然一致 —— 不会出现「冷却判定用真实时间、这个判定用假时间」的分叉。
     *
     * ⚠️ 墙钟被回拨时差值可能为负（`cooling()` 有同样的隐患，此处取同样的口径）：
     * 负数会让「已过 10 秒」的判据误判成「还没到」，把重试永久推迟。
     * ⇒ 一律夹到 0，宁可早重试也不卡死。
     */
    sinceLastAttemptMs(): number | undefined;
    /**
     * 是否处于「上次没拿到目录」的冷却窗口内。
     *
     * ⚠ `retryAt` 是用**墙钟**算的，系统时间被回拨时 `now() < retryAt` 会
     * 把冷却**拉长**（回拨一天就是事实上的永久卡死）。故这里只认「剩余量
     * 不超过一个冷却周期」的窗口 —— 回拨造成的超长窗口一律按已到期处理。
     */
    cooling(): boolean;
    /**
     * 至多发起一次加载。
     *
     * - 冷却中：**不调用** `run`，直接返回。
     * - 已有在飞的加载：等它，不重复调用 `run`。
     * - 否则调用 `run`；结果决定冷却与广播（见下）。
     *
     * @param run 执行实际拉取，并在成功时自行落缓存。
     *   返回**裸布尔**即 `got = complete = 该值`（向后兼容，既有适配器行为不变）；
     *   返回 `{ got, complete }` 时两者分开判定 —— **显示与广播按 `got`，
     *   永久缓存与清冷却按 `complete`**（理由见文件头）。
     */
    run(run: () => Promise<CatalogLoadResult>): Promise<void>;
    /** 清掉冷却窗口（例如用户显式触发刷新）。 */
    reset(): void;
}
//# sourceMappingURL=remote-catalog-gate.d.ts.map