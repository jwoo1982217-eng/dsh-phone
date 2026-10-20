/**
 * Loomy 新手任务（合计 10000 积分）。
 *
 * ## ⚠️ 服务端不校验前置行为（决定性实测）
 *
 * 与 WorkBuddy **完全不同**：WorkBuddy 的任务要模拟真实用户行为（发对话、
 * 建定时任务、上报埋点事件链），因为它的服务端校验前置条件。Loomy 不是 ——
 * 2026-09-26 用本机账号对 8 个任务逐个发 `POST /complete`，全部返回
 * `{"code":"000000","data":{"alreadyCompleted":false,"balance":N}}`，
 * 余额 0 → 10000，**没有真的发对话、没有真的生成 PPT、没有真的装技能**。
 *
 * 原因：完成条件全部在**客户端本地判定**（源码 `onboarding-service.js`
 * 的注释与单测都表明服务端只做「幂等置位 + 加分」）。故本实现是
 * **纯 API 直领**，一个模型 token 都不花。
 *
 * ## 端点
 *
 * ```
 * GET  /api/v1/onboarding/tasks            → { tasks:{8key:bool}, earned, total }
 * POST /api/v1/onboarding/tasks/complete   body { key } → { alreadyCompleted, balance }
 * ```
 *
 * ⚠️ 上报 body **只有 `key`** —— 无设备指纹、无版本号、无渠道号
 * （`OnboardingService` 的构造参数里根本没有 `getDeviceId`，
 * 对比 `PointsService` 是有的）。
 * ⚠️ 幂等判据是响应体的 `alreadyCompleted`，**不是** HTTP 码、**不是** `code`。
 * ⚠️ **不采信服务端 `earned`**，按本地 `LOOMY_TASK_POINTS` 现算 ——
 * 官方自己也这么做（`onboarding-service.js:177-183` 明说不信任）。
 */
import { type LoomyCredential } from './loomy.js';
import type { LoomyProduct } from './loomy-product.js';
/**
 * 任务 key → 积分。
 *
 * 来源：Loomy 客户端 `electron/onboarding-service.js:18-27` 的 `TASK_POINTS`
 * （其单测 `:33-37` 断言各项之和 === 10000）。
 * 顺序即执行顺序。
 */
export declare const LOOMY_TASK_POINTS: Readonly<Record<string, number>>;
/** 任务 key → 中文标题（客户端 `GE` 注册表里的 `title`）。 */
export declare const LOOMY_TASK_TITLES: Readonly<Record<string, string>>;
/** 任务积分合计（10000）。 */
export declare const LOOMY_ONBOARDING_TOTAL = 10000;
/** 新手任务状态。 */
export interface LoomyOnboardingState {
    /** 8 个 key 的完成状态（缺失的补 false）。 */
    tasks: Record<string, boolean>;
    /** **本地现算**的已领积分（不采信服务端）。 */
    earned: number;
    /** 总分（10000）。 */
    total: number;
}
/** 一次「领取全部新手任务」的结果。 */
export interface LoomyOnboardingResult {
    /** 本次真正处理（含幂等重放）的 key 与积分。 */
    claimed: {
        key: string;
        points: number;
    }[];
    /** 此前已完成、本次跳过（**未发请求**）的 key。 */
    skipped: string[];
    /** 领取后本地现算的累计已领。 */
    earned: number;
    total: number;
}
/** 按本地表现算已领积分；未知 key 忽略。 */
export declare function computeLoomyEarned(tasks: Record<string, boolean>): number;
/**
 * 查询新手任务状态。
 *
 * `earned` 按本地表现算 —— 服务端回传的 `earned` 只是参考，
 * 且历史上出现过与本地表不一致的情况。
 */
export declare function fetchLoomyOnboardingTasks(credential: LoomyCredential, product: LoomyProduct, fetcher?: typeof fetch): Promise<LoomyOnboardingState>;
/**
 * 完成（领取）单个新手任务。
 *
 * ⚠️ 幂等：重复调用返回 `alreadyCompleted: true`，**视为成功**。
 */
export declare function completeLoomyTask(credential: LoomyCredential, key: string, product: LoomyProduct, fetcher?: typeof fetch): Promise<{
    alreadyCompleted: boolean;
    balance: number;
}>;
/**
 * 领取全部新手任务（补差额）。
 *
 * **串行**逐个完成（官方客户端也用 `Set` 去重、串行）；已完成的**跳过不发请求**。
 * 任一任务收到 `100002` 时**立即抛出**，不再对后续任务发请求
 * （否则会产生一串必然失败的请求）。
 */
export declare function claimAllLoomyOnboardingTasks(credential: LoomyCredential, product: LoomyProduct, fetcher?: typeof fetch): Promise<LoomyOnboardingResult>;
//# sourceMappingURL=loomy-onboarding.d.ts.map