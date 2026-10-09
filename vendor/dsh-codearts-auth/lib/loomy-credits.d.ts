/**
 * Loomy 积分：余额查询（只读）与每日额度签到。
 *
 * ## 两个积分池（用户补充确认的机制）
 *
 * Loomy 的积分**分成两个池、分开计算**：
 * - **永久积分**：注册奖励 5000 + 新手任务 10000（`balance`）
 * - **每日赠送池**：每天 5000，**消耗后不回补**（`dailyBalance`）
 *
 * 实测（2026-09-26）：
 * ```
 * balance: 15000        ← 永久
 * dailyBalance: 4992    ← 每日池余额 = dailyQuota(5000) - dailyConsumed(8)
 * availableBalance: 19992  ← 两者之和
 * ```
 *
 * ## 每日额度由 `first-login` 发放
 *
 * 官方在**登录成功后立即调用** `POST /api/v1/points/first-login`
 * （渲染 bundle 的短信登录与微信登录两条路径都调，失败仅 warn）。
 * 响应返回完整账户快照：
 * ```
 * { alreadyProcessed, currentBalance, permanentBalance, dailyBalance,
 *   dailyQuota, dailyConsumed, dailyCycleDate, ... }
 * ```
 *
 * ⚠️ **`dailyQuota` 只在 `first-login` 的响应里**，`points/records` 不返回它。
 * 故未签到时该字段缺省 —— **不要硬编码 5000**（额度可能随活动变化）。
 *
 * ## 读与写严格分离
 *
 * | 动作 | 端点 | 性质 |
 * |---|---|---|
 * | 查余额 | `GET /points/records` | **只读**，无副作用 |
 * | 一键签到 | `POST /points/first-login` | 写，幂等 |
 *
 * 这样「打开面板」不会悄悄触发签到。
 */
import type { ClaimOutcome, CreditBalance } from './credits.js';
import { type LoomyCredential } from './loomy.js';
import type { LoomyProduct } from './loomy-product.js';
/** 「一键签到」的语义说明（供 UI 提示用，避免写成「+5000 积分」）。 */
export declare const LOOMY_DAILY_QUOTA_DESCRIPTION = "\u6BCF\u65E5\u8D60\u9001\u989D\u5EA6\uFF08\u6D88\u8017\u540E\u4E0D\u56DE\u8865\uFF09";
/** 两个积分池的明细。 */
export interface LoomyCreditDetail {
    /** 永久积分（`balance`）。 */
    permanent: number;
    /** 每日赠送池余额（`dailyBalance`）。 */
    daily: number;
    /** 永久 + 每日（`availableBalance`）。 */
    total: number;
    /** 每日额度上限 —— **仅签到后可得**（`first-login` 专有字段）。 */
    dailyQuota?: number;
    /** 今日已消耗 —— 仅签到后可得。 */
    dailyConsumed?: number;
    /** 每日额度所属业务日（`YYYY-MM-DD`）—— 仅签到后可得。 */
    dailyCycleDate?: string;
}
/**
 * 查询两个积分池的明细（**只读**）。
 *
 * ⚠️ 用 `points/records` 而不是 `first-login`：后者是**写**端点，
 * 在「打开面板」这种高频路径上调用会意外触发签到。
 *
 * @returns 查不到（凭据失效 / 响应异常）时返回 `null`，与「余额为 0」严格区分。
 */
export declare function fetchLoomyCreditDetail(credential: LoomyCredential, product: LoomyProduct, fetcher?: typeof fetch): Promise<LoomyCreditDetail | null>;
/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状，供 Jet Hub 账号卡片渲染）。
 *
 * ⚠️ **两个池各作一个 package**，让用户看出「永久」与「每日」是分开计算的
 * （用户明确要求的展示方式）。`total` 用 `availableBalance`（两者之和）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export declare function fetchLoomyCreditBalance(credential: LoomyCredential, product: LoomyProduct, fetcher?: typeof fetch): Promise<CreditBalance | null>;
/**
 * 一键签到：触发每日赠送额度。
 *
 * ⚠️ **语义是「触发每日额度重置」，不是「+5000 积分」**：
 * `dailyBalance = dailyQuota - dailyConsumed`，消耗后不回补。
 * UI 文案必须准确（见 {@link LOOMY_DAILY_QUOTA_DESCRIPTION}）。
 *
 * ⚠️ 幂等判据是响应体的 `alreadyProcessed`（重复调用同样返回 HTTP 200），
 * 故已处理的情况映射成 `already-claimed` 而**不是** `claimed` ——
 * 后者会让用户以为每天都真的加了额度。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export declare function claimLoomyDailyQuota(credential: LoomyCredential, product: LoomyProduct, fetcher?: typeof fetch): Promise<ClaimOutcome>;
//# sourceMappingURL=loomy-credits.d.ts.map