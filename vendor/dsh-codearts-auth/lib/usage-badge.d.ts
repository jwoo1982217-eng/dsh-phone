/**
 * 用量徽标的**宿主侧读数**：把「当前渠道还剩多少」折算成一次 RPC 就能画完的快照。
 *
 * ## 为什么需要一个新端点，而不是让客户端直接调 `credits.balances`
 *
 * 徽标挂在会话输入区，**每分钟轮询一次**（见客户端 `usage-badge.js`），而
 * `credits.balances` 是**逐账号顺序打上游**的（`collectCreditBalances` 的
 * 「顺序查询，避免并发触发风控」）。若客户端直连它：
 *
 * - 每轮轮询 × 账号数 = 上游请求数（5 个号就是每 5 分钟 5 次，多开几个会话再翻倍）；
 * - 设置页那两个按钮的读数与徽标**各拉各的**，同一时刻可能显示不同的数字。
 *
 * 本模块做的事很少，但每件都是必需的：
 * 1. **复用** `credits.balances` 的实现（由装配层注入，见 `jet-hub-rpc.ts`），
 *    不复制任何 provider 分支 —— 否则两套口径必然漂移；
 * 2. **只保留启用账号**，并给出 `disabledCount`（停用账号不该进合计）；
 * 3. 附加**订阅读数**（窗口 / 套餐，判定在 `badge-subscription.ts`）；
 * 4. 每个渠道一份 **TTL 缓存 + 在飞去重**（`TtlCache`）：
 *    成功缓存久、**全部失败缓存短** —— 后者是为了让用户修好凭据后不必干等，
 *    口径与 `buddy-balance-selector.ts` 的「成功 60s / 失败 5s」同源。
 *
 * ## ⚠️ 失败与「读数为 0」必须分开
 *
 * 本模块**不吞**任何失败：单账号失败照原样留在 `accounts[].error` 里（UI 显示
 * 原因而不是 0）；整批失败（如渠道不支持、`credits.balances` 返回 bad-request）
 * 则以 `{ ok: false }` 原样上抛给 RPC 层。把失败画成 0 会让用户以为额度被清空
 * —— 那是本仓库反复记录过的缺陷形态。
 */
import type { ProviderAccountEntry, RpcCreditsBalancesResponse, RpcClineQuotaResponse, RpcUsageAutoCheckinState, RpcUsageBadgeResponse } from './types.js';
import type { BadgePreference } from './badge-preferences.js';
/** RPC 错误（与 `jet-hub-rpc.ts` 的响应信封一致，便于直接透传）。 */
export interface BadgeRpcError {
    code: string;
    message: string;
}
/** RPC 结果信封（与 `jet-hub-rpc.ts` 的 `{ ok, value|error }` 同形）。 */
export type BadgeRpcResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: BadgeRpcError;
};
/** 徽标读数的缓存时长（毫秒）；`DSH_JET_HUB_BADGE_TTL_MS` 可覆盖。 */
export declare const DSH_JET_HUB_BADGE_TTL_MS = "DSH_JET_HUB_BADGE_TTL_MS";
/**
 * 默认缓存时长：**120 秒**。
 *
 * 取值依据：客户端 60s 轮询一次 ⇒ 每两轮只有一轮真的打上游；一次读取最坏是
 * 「账号数 × 一次 HTTP」，120s 对配额与风控都可接受，而读数的新鲜度对
 * 「现在该不该用这个模型」这个决策仍然够用（手动刷新可随时绕过）。
 */
export declare const BADGE_TTL_MS = 120000;
/**
 * **全部账号都失败**时的缓存时长：15 秒。
 *
 * 与成功分开的理由：失败通常来自凭据过期 / 网络抖动，用户往往立刻去修；
 * 若沿用 120s，修好之后徽标还会继续显示「用量不可用」最长两分钟，
 * 看起来像「修复无效」。
 */
export declare const BADGE_FAILURE_TTL_MS = 15000;
/**
 * 读取缓存时长。
 *
 * ⚠️ **不能写成 `Number(raw) || 默认值`**：`0` 是合法值（表示「不缓存、每次都
 * 重新读」），而 `0` 是 falsy 会被 `||` 静默换成默认值 —— 与本仓库
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` / `DSH_QODER_QUEUE_TIMEOUT_MS` 同一个坑。
 */
export declare function badgeTtlMs(env?: NodeJS.ProcessEnv): number;
/** 读取失败缓存时长（口径同上）。 */
export declare function badgeFailureTtlMs(env?: NodeJS.ProcessEnv): number;
/** 装配层注入的依赖（全部可替换 ⇒ 单测零网络、零文件系统）。 */
export interface UsageBadgeDeps {
    /**
     * 取某渠道的余额行 —— **必须复用 `credits.balances` 的实现**（装配层直接调
     * 内部 `handleMethod`），不要在调用方另写一套 provider 分派。
     */
    collectBalances(provider: string): Promise<BadgeRpcResult<RpcCreditsBalancesResponse>>;
    /**
     * 取某渠道的**订阅窗口**读数；返回 `undefined` 表示「该渠道没有窗口式订阅」
     * （目前只有 Cline 有，由装配层判渠道，本模块不认识任何具体渠道）。
     *
     * 允许**同步**返回 `undefined`（装配层判渠道时就是这么写的），本模块统一
     * `await` 一次，故两种写法都吃。
     */
    collectQuota?(provider: string): BadgeRpcResult<RpcClineQuotaResponse> | undefined | Promise<BadgeRpcResult<RpcClineQuotaResponse> | undefined>;
    /** 该渠道的账号池条目（**同步**读内存副本；`enabled !== false` 视为启用）。 */
    listAccounts(provider: string): readonly ProviderAccountEntry[];
    /** 读当前生效的显示偏好。 */
    readPreference(): BadgePreference;
    /**
     * 读「每日首次启动自动签到」的实时状态（顺带回传给弹窗右上角的状态灯）。
     *
     * ⚠️ 与 `readPreference` 一样**不进缓存**：`running` / `ranToday` 由宿主的
     * 后台任务驱动，缓存住界面就会一直停在旧状态。
     */
    readAutoCheckin(): RpcUsageAutoCheckinState;
    /** 取当前时刻（注入以便单测）。 */
    now?(): number;
    /** 缓存时长（省略时读环境变量）。 */
    ttlMs?: number;
    /** 失败缓存时长（省略时读环境变量）。 */
    failureTtlMs?: number;
    /** 告警出口（订阅查询失败时用；省略则静默）。 */
    warn?(message: string): void;
}
/** 徽标读数服务。 */
export interface UsageBadge {
    /**
     * 读取某渠道的徽标读数。
     *
     * @param provider - 渠道 id。
     * @param options.force - 绕过缓存重新读（手动刷新 / 签到之后）。
     */
    read(provider: string, options?: {
        force?: boolean;
    }): Promise<BadgeRpcResult<RpcUsageBadgeResponse>>;
    /** 清空所有渠道的缓存（插件卸载 / 关停时调用）。 */
    clear(): void;
}
/** 创建徽标读数服务（每个插件实例一份，内部按渠道各持一个缓存）。 */
export declare function createUsageBadge(deps: UsageBadgeDeps): UsageBadge;
//# sourceMappingURL=usage-badge.d.ts.map