/**
 * Cline **订阅额度**（官方额度窗口）。
 *
 * 与 `src/cline-credits.ts`（余额）分开成模块：余额是「还剩多少钱」，
 * 订阅额度是「这几个时间窗各用掉了百分之几」，两者端点、形状、失败语义
 * 都不同，混在一个文件里会让各自的判据互相干扰。
 *
 * ⚠️ **请求记录不在这里** —— 它是 `src/cline-request-log.ts` 的**本地流水**
 * （本插件自己发出的每笔推理请求，含延迟与首块时间；参考实现
 * `github.com/codeOct/dsh-cline-pass` 的请求记录部分同源）。网关的
 * `/users/{id}/usages` 记的是**该账号在官方所有渠道**的消费流水：
 * 没有延迟/首块时间、语义是「官方账单」而非「本插件发出的请求」，
 * 故不采用（表格字段也对不齐参考实现）。
 *
 * ## 端点（参考 `github.com/codeOct/dsh-cline-pass` 的额度管理实现）
 *
 * ```
 * GET {apiBase}/api/v1/users/me/plan/usage-limits
 *   → { success: true, data: { limits: [{ type, percentUsed, resetsAt }] } }
 *      type ∈ five_hour | weekly | monthly          ← 订阅额度窗口
 * ```
 *
 * ## ⚠️ 实测踩过的坑（2026-09-29 已实发核对，不要重新踩）
 *
 * 1. **`resetsAt` 是 ISO 字符串且带纳秒精度**（9 位小数，如
 *    `2026-09-29T15:41:02.244817775Z`）—— 不要按毫秒去 `new Date()`，
 *    也不要截断小数（会掩盖上游改动）。
 * 2. **用量为 0 的窗口 `resetsAt` 是空串** —— 客户端据此不渲染那一行。
 * 3. **额度端点用字面量 `users/me`**，由网关按 Bearer 令牌判定账号，
 *    不依赖凭据里的 `account_id`；请求记录端点才需要 `account_id`（`usr-…`）。
 *
 * ## 失败一律「作为数据上报」，不抛错
 *
 * 额度是**附加信息**：面板上的账号管理、模型开关、登录等功能不依赖它。
 * 因此读取失败必须降级成一条可读原因（含 HTTP 状态与响应体摘要），
 * 而不是让整个面板挂掉 —— 与 `fetchClineCreditBalance` 同约定。
 *
 * ## ⚠️ 不把「查不到」显示成 0
 *
 * `percentUsed: 0` 是「这个窗口一点没用」的合法语义。查询失败必须以
 * `ok: false` + `error` 表达，由调用方显示原因 —— 把失败渲染成 0% 会让用户
 * 以为自己额度充足（与其余 provider「查不到不显示成 0」的约定一致）。
 */
import { type ClineCredential } from './cline.js';
import type { ClineProduct } from './cline-product.js';
/** 单次额度请求超时（毫秒；与余额同档）。 */
export declare const CLINE_QUOTA_TIMEOUT_MS = 30000;
/**
 * 订阅额度窗口端点。
 *
 * ⚠️ 路径段是 `users/me`（**字面量 `me`**，不是账号 id）—— 由网关按 Bearer
 * 令牌自行判定账号。故本端点**不要求**凭据里有 `account_id`，这让
 * 「凭据缺 account_id」的账号也仍能看到额度。
 */
export declare const CLINE_USAGE_LIMITS_PATH = "/api/v1/users/me/plan/usage-limits";
/** 一个额度窗口。 */
export interface ClineQuotaWindow {
    /** 窗口类型：`five_hour` / `weekly` / `monthly`（网关新增的类型原样透传）。 */
    type: string;
    /** 已用百分比（网关原值，0–100 之外的值也如实透传，不在解析层夹取）。 */
    percentUsed: number;
    /** 窗口重置时刻（**ISO 字符串**，可能为空串）。 */
    resetsAt: string;
}
/** 额度查询结果。 */
export interface ClineQuotaResult {
    ok: boolean;
    windows: ClineQuotaWindow[];
    /** 失败原因；成功但网关附带文案时也可能有值。 */
    error?: string;
}
/**
 * 解析订阅额度响应。
 *
 * ⚠️ **窗口列表按网关给的原序透传，不映射到固定形状**：网关将来新增窗口
 * （例如 `daily`）时，面板多一行即可，**不需要**为它发一个插件版本。
 * 这正是把 `type` 当字符串而非联合类型的原因。
 *
 * ⚠️ **`percentUsed` 不做夹取**：网关若给 120（超额），如实透传 ——
 * 夹到 100 会把「已超限」显示成「刚好用完」，那正是最该看见的信息。
 */
export declare function parseClineUsageLimits(value: unknown): {
    windows: ClineQuotaWindow[];
    error?: string;
};
/**
 * 读取单个账号的**订阅额度窗口**。
 *
 * 失败作为数据返回（`ok:false` + `error`），不抛错。
 */
export declare function fetchClineUsageLimits(credential: ClineCredential, product: ClineProduct, fetcher?: typeof fetch, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<ClineQuotaResult>;
//# sourceMappingURL=cline-quota.d.ts.map