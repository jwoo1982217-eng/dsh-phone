/** 在凭据过期前提前这么长时间触发刷新（1 小时；对齐真实插件的 36e5）。 */
export declare const REFRESH_LEAD_MS = 3600000;
/** 普通刷新失败后的重试间隔（10 分钟；对齐 RENEW_TOKEN_INTERVAL_WHEN_LAST_TIME_FAILED）。 */
export declare const REFRESH_RETRY_MS = 600000;
/** 异常网络（fetch failed 等）后的重试间隔（1 分钟；对齐 …_BY_ABNORMAL_NETWORK）。 */
export declare const REFRESH_ABNORMAL_NETWORK_RETRY_MS = 60000;
/**
 * 「连不上」与「连上了但失败」必须分开（Gitee issue IKLTZ2）。
 *
 * ⚠️ `fetch failed` 是 undici 把**所有**传输层失败压成的同一句话，真因只在
 * `cause` 上。`isAbnormalNetworkError` 把它（连同 `ENOTFOUND` /
 * `ECONNREFUSED`）一律归成「1 分钟后重试的瞬时抖动」—— 对真正的抖动是对的，
 * 但对**「墙外服务根本出不去」**是错的：那不是抖动，60 秒后再试还是同样的
 * 超时，于是调度器**永远静默重试**，面板上零线索（issue 原话：「面板上完全
 * 看不出是网络/代理原因，用户只能看到授权失败」）。
 *
 * ⚠️ 为什么是「拉长间隔」而不是「停止调度」：连接超时**可能**是临时的
 * （用户正在切代理 / 代理刚启动）⇒ 保留重试但从 1 分钟拉到 30 分钟。
 * **刻意不归终态**（`RefreshTokenExpiredError` 那种停调度）：凭据没坏，
 * 代理一恢复就该自动复活。
 *
 * ⚠️ 判据读 `cause` 链上的**错误码**（`UND_ERR_*` / `EHOSTUNREACH` …）而不是
 * message：`message` 恒为 `fetch failed`，用它判会把**所有**传输失败
 * （含 5xx 之后的读体失败）都拉长间隔。
 */
export declare function isUnreachableNetworkError(error: unknown): boolean;
/**
 * 计算首次刷新触发前的毫秒数（对齐真实插件 getFirstRefreshTime）：
 * - 无有效过期时间或距过期 ≤1h → 0（立即刷新）；
 * - 否则触发点 = now + 1h，再叠加 0-59 秒随机偏移。
 */
export declare function computeFirstRefreshDelayMs(expiresAtMs: number, nowMs?: number): number;
/** 静默刷新调度器：一次触发 + 失败重试（失效则停止）。 */
export declare class RefreshScheduler {
    private readonly refresh;
    private readonly onError;
    private timer;
    private pending;
    /** 调度代号：stop()/arm() 都会推进它，用于让在途 run() 放弃失败后的重试武装。 */
    private generation;
    constructor(refresh: () => Promise<void>, onError?: (error: unknown) => void);
    /** 为在 `expiresAtMs` 过期的凭据安排下次刷新；`nowMs` 仅供测试注入。 */
    arm(expiresAtMs: number, nowMs?: number): void;
    /** 取消任何待处理的刷新（并让在途 run() 失败后不再重试）。 */
    stop(): void;
    /** 立即执行一次刷新（供启动时已处于到期窗口内的凭据使用）。 */
    refreshOnce(): Promise<void>;
    private run;
}
//# sourceMappingURL=refresh.d.ts.map