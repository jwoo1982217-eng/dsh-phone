/**
 * 各 provider 的**一次性奖励能力实现表** —— `ProviderRuntime.onboarding` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`onboarding.status` / `onboarding.claim` 各自是一段
 * `if (req.provider === LOOMY.id) … else if (req.provider === RACCOON.id) …`，
 * 两处**各写一遍**同样的 provider 分派、同样的「凭据未配置 / 账号不存在」守卫。
 * 那些分支体里**没有一行协议逻辑**（协议早已封装在 `loomy-onboarding.ts` 与
 * `raccoon-credits.ts` 内），RPC 层看到的只是「选哪个函数」。
 *
 * ## ⚠️ 与 `credits` 域的边界（**别把两者合并**）
 *
 * | 域 | 语义 | 频率 |
 * |---|---|---|
 * | `credits` | **每日**签到（每天都有收益） | 每天 |
 * | `onboarding` | **一次性**新手任务 / 登录奖励（每号只能领一次） | 一次 |
 *
 * 两者混在一个域里会诱导实现方拿「今天领过没」的判据去判「领过没」——
 * 那正是本仓库记录过的「一份语义两套判据」形态。
 *
 * ## ⚠️ 为什么返回类型直接用 RPC 响应的形状
 *
 * `RpcOnboardingStatusResponse` / `RpcOnboardingClaimResponse` 与 provider 数量
 * 无关（`tasks` / `earned` / `total` / `titles` / `points` 是**所有**一次性奖励的
 * 公共字段），且 `raccoon` 的「已领时 `earned` 报满分」这条语义**只有在这个形状上**
 * 才表达得出来 —— 压成 `ClaimOutcome` 会丢掉它（见 `ProviderOnboarding.claim`）。
 * 与 `ProviderBalanceDetail` 复用 `CreditsEndpointDeps` 的形状同款理由。
 */
import type { ClaimOutcome } from './credits.js';
import type { LoomyCredential } from './loomy.js';
import type { RaccoonCredential } from './raccoon.js';
import type { ProviderOnboarding } from './provider-runtime.js';
/** Loomy 一次性任务的只读状态（`fetchLoomyOnboardingTasks` 的返回形状）。 */
export interface LoomyOnboardingSnapshot {
    tasks: Record<string, boolean>;
    earned: number;
    total: number;
}
/** Loomy 一次性任务的领取结果（`claimAllLoomyOnboardingTasks` 的返回形状）。 */
export interface LoomyOnboardingClaim {
    claimed: {
        key: string;
        points: number;
    }[];
    skipped: string[];
    earned: number;
    total: number;
}
/**
 * 两家「一次性奖励挂在 auth 实例上」的渠道所需的最小接口。
 *
 * ⚠️ **结构化类型而不是 `LoomyAuth` / `RaccoonAuth`**：本模块只需这几个方法，
 * 导入两个 auth 类会把 `@deepseek-ai/cordis` 与一整套登录流程拖进依赖图 ——
 * 而它只被 `index.ts`（已经持有实例）与单测使用。结构化类型同时让单测可以传
 * **只带一个方法的替身**。
 *
 * ⚠️ 这与 `ProviderCreditsDeps` 同款做法（见 `provider-credits.ts`），
 * 且**理由相同**：实例可能带注入的 `fetchImpl`（测试替身 / 代理），
 * 故优先走实例方法；实例缺席时回退自由函数 + 全局 `fetch`
 *（与 `index.ts` 的实际构造逐字等价 —— 它**总是**传实例）。
 */
export interface ProviderOnboardingDeps {
    /** Loomy auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly loomy?: {
        fetchOnboardingTasks(credential: LoomyCredential): Promise<LoomyOnboardingSnapshot>;
        claimOnboardingTasks(credential: LoomyCredential): Promise<LoomyOnboardingClaim>;
    };
    /** Raccoon auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly raccoon?: {
        fetchOnboardingStatus(credential: RaccoonCredential): Promise<{
            claimed: boolean;
            points: number;
        }>;
        claimLoginReward(credential: RaccoonCredential): Promise<ClaimOutcome>;
    };
}
/**
 * 构造「id → 一次性奖励能力」的表。
 *
 * ⚠️ 只覆盖**真有**一次性奖励的渠道（与 `PROVIDER_REGISTRY` 的
 * `credits.onboardingTasks` 声明一致）：目前是 `loomy` 与 `raccoon`。
 */
export declare function createProviderOnboarding(deps?: ProviderOnboardingDeps): Readonly<Record<string, ProviderOnboarding>>;
/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `creditsOf` / `authOf` 同因。
 */
export declare function onboardingOf(table: Readonly<Record<string, ProviderOnboarding>>, provider: string): ProviderOnboarding | undefined;
//# sourceMappingURL=provider-onboarding.d.ts.map