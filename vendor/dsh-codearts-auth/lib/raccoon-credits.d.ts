/**
 * Raccoon Work 积分（余额 + 一次性登录奖励）。
 *
 * ## ⚠️ 三个来源的语义（关键）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` | ✅ `claimRaccoonLoginReward` |
 * | 每日积分发放 | 300 | **服务端按日自动发放，无端点** | ❌ 不实现 |
 *
 * ⚠️ **每日 300 没有签到端点** —— 实测该账号 13:30 注册、13:31 就收到
 * `daily_grant` 账单（`biz_type: 'daily_grant'`）。故**不能**把它实现成
 * 签到按钮：不存在可调用的端点，按钮必然失败。
 *
 * ⚠️ **登录奖励是幂等一次性的**（已领过返回 `granted:false`），
 * 语义与 Loomy 的新手任务同构，故登记为 `onboardingTasks` 而**不是**
 * `dailyCheckin` —— 后者会让用户以为每天都真的加了额度。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰写端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
import type { ClaimOutcome, CreditBalance } from './credits.js';
/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export declare const RACCOON_LOGIN_REWARD_POINTS = 3000;
/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export declare const RACCOON_LOGIN_REWARD_EVENT_NAME = "\u684C\u9762\u7AEF\u767B\u5F55\u5956\u52B1";
/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export declare function fetchRaccoonCreditBalance(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<CreditBalance | null>;
/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：实测该端点是幂等一次性的（已领过返回 `granted:false`
 * 且账单里能看到上一次的记录）。映射到 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export declare function claimRaccoonLoginReward(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：`GET /points/v1/bills` 里是否已有
 * `biz_type === 'reward_grant'` 且 `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export declare function fetchRaccoonOnboardingStatus(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<{
    claimed: boolean;
    points: number;
}>;
/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export declare const raccoonCreditsForDefaultProduct: {
    fetchBalance: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<CreditBalance | null>;
    claimLoginReward: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<ClaimOutcome>;
    fetchOnboardingStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<{
        claimed: boolean;
        points: number;
    }>;
};
//# sourceMappingURL=raccoon-credits.d.ts.map