/**
 * AStudio（讯飞 AstronStudio）**额度面**：`GET /xingchen-studio/points/balance`。
 *
 * ## 为什么单独一个文件
 *
 * 额度端点在**账号后端**（`agent.xfyun.cn/xingchen-studio`），与推理网关
 *（`astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1`）**不同域、不同鉴权**：
 * 推理用 `Authorization: Bearer <modelBearerToken>`，额度只认 **Cookie 的
 * `ssoSessionId`**。⇒ 凭据里那一份 `access_token` 在这里**用不上**，
 * 本文件读的是 `sso_session_id`（缺失时如实报「未登录」，不发必然 80000 的请求）。
 *
 * ## ⚠️ 三条失败路径的用户动作**完全不同**（故必须用 `fetchBalanceDetailed`）
 *
 * 1. **会话失效**：HTTP 恒 **200** + `code=80000`「登录异常，请重新登录」⇒
 *    用户要做的是**去客户端人工重登**（唯一终态，实测无程序化续期接口，
 *    服务端 Set-Cookie 的 Max-Age=31536000 意味着一年内不会自然到期）。
 * 2. **服务不可用**：HTTP 4xx/5xx、非 JSON、其它 `flag=false` 业务码 ⇒
 *    可重试，**不得**报成「需重登」（那会让用户白重登一次）。
 * 3. **形状不认识**：`code=0` 但响应里没有 `totalBalance`（上游改了 Schema）⇒
 *    明说「未包含余额字段」。
 *
 * ⚠️ **绝不允许把「查不到」写成 0**（0 是「已用光」的语义，本仓库反复记录的
 * 缺陷形态；provider-credits.ts 文件头同样写着这条红线）。
 *
 * ## ⚠️ 为什么**不**按 HTTP 码判失效
 *
 * 实测该端点无论成功还是「未登录」都回 **200**（22 例消融），故判据只能是
 * `flag`/`code` 本体。这与上游 MAAS 的 `HTTP 502 + error.code` 是两套形态，
 * 不要复用 `classifyAstudioError` 那条推理侧的映射。
 */
import type { AstudioProduct } from './astudio-product.js';
import type { AstudioCredential } from './astudio.js';
import type { ProviderBalanceDetail } from './provider-runtime.js';
import type { ClaimOutcome, CreditBalance } from './credits.js';
/** 注入替身用（单测不碰真实凭据与网络）。 */
export interface AstudioCreditsOptions {
    fetcher?: typeof fetch;
    product?: AstudioProduct;
    timeoutMs?: number;
}
/**
 * 把 `points/balance` 的 data 映射成 `CreditBalance`。
 *
 * ## 口径（与客户端一致，用户可与官方面板逐数核对）
 *
 * - `total` = 上游**权威**字段 `totalBalance`（主池可用合计），**不是**逐包求和。
 *   实测 `totalBalance === activityBalance`（1192），而 `totalAmount - totalBalance = 8`
 *   正是已消耗 —— 用求和会在星火池在场时凭空多出 5000。
 * - `packages` 按**来源四分法**分桶（member / buy / activity，均为**主池**），
 *   星火池作为**最后一个**条目并如实标注「独立池，不参与主池合计」。
 *   ⚠️ 这是刻意与 zcode 的「`total` 必须等于逐包之和」**不同**的口径：本渠道
 *   服务端本身就给了两个互不相通的池，压成一个数才是撒谎。
 *   ⇒ 面板若按「逐包之和」显示总额会偏大；接线时若需要严格自洽，可以把星火条目
 *     移出 `packages` 并在 `extra` 里给短标签，但那需要扩 `RpcCreditsBalanceExtra`
 *     （现只有 `accountTier`），属接口扩张，**本轮不做**。
 * - `expiredTotal` = 0：上游**不下发**失效额度（无独立 frozen 字段、也不回已失效桶），
 *   如实为 0 并在此注明「不是估算出来的 0」。
 *
 * ⚠️ `spark*` 六项在官方 Schema 里是 **optional** ⇒ 老响应可能整个缺席，
 * 缺席时**不生成**该条目（生成一个 `remaining: 0` 的星火包会让用户以为星火没了）。
 */
export declare function buildAstudioBalance(data: Record<string, unknown>): CreditBalance | null;
/**
 * 查一次 AStudio 积分余额（**带原因**）。
 *
 * 判据阶梯（顺序**不可**调换，理由逐条）：
 * ① 本地就能判定的「没有会话 Cookie」⇒ 直接报未登录，**不发**一个必然 80000 的请求；
 * ② 传输层失败 / 非 2xx / 非 JSON ⇒ 「额度服务不可用（可重试）」；
 * ③ `flag=false`（HTTP 仍是 200）⇒ 用 `isAstudioSessionDeadError(code, 文案)` 分流
 *    「需人工重新登录」与「可重试」；
 * ④ `code=0` 但没有 `totalBalance` ⇒ 「响应未包含余额字段」。
 *
 * ⚠️ ③ 的终态判据**只此一份**（复用 `astudio.ts` 的 `isAstudioSessionDeadError`），
 * 本文件**不再抄一份业务码集合** —— 同一语义两套判据是本仓库的红线。
 * 该判据依赖 `src/astudio-product.ts` 的 `ASTUDIO_SESSION_DEAD_CODES` **含 80000**
 *（本轮实测已在盘：`new Set([1002, 1005, 80000])`）；否则「需重登」会退化成
 * 只靠服务端中文文案正则兜底、每轮白撞一次的可重试。
 */
export declare function fetchAstudioBalanceDetailed(credential: AstudioCredential, options?: AstudioCreditsOptions): Promise<ProviderBalanceDetail>;
/** 待处理弹窗查询端点（每日奖励等）。 */
export declare const ASTUDIO_CLIENT_POPUPS_PENDING_PATH = "/client-popups/pending";
/** 弹窗完成/领取端点。 */
export declare const ASTUDIO_CLIENT_POPUPS_COMPLETE_PATH = "/client-popups/complete";
/** 每日奖励弹窗类型标识。 */
export declare const ASTUDIO_POPUP_TYPE_DAILY_REWARD = "DAILY_REWARD_DIALOG";
/** 新用户礼包弹窗类型标识。 */
export declare const ASTUDIO_POPUP_TYPE_NEW_USER = "NEW_USER_DIALOG";
/** 可领取的福利弹窗类型列表。 */
export declare const ASTUDIO_CLAIMABLE_POPUP_TYPES: readonly ["DAILY_REWARD_DIALOG", "NEW_USER_DIALOG"];
/** 领取弹窗数据结构（每日奖励或新用户礼包）。 */
export interface AstudioClaimablePopup {
    popupId: number;
    instanceKey: string;
    type: string;
    payload?: {
        points?: string | number;
        [key: string]: unknown;
    };
}
/** 每日签到弹窗数据结构（兼容别名）。 */
export type AstudioDailyRewardPopup = AstudioClaimablePopup;
/**
 * 解析弹窗或完成响应中的积分数值。
 * 支持字符串数字 "10"、数值 10 等形式。
 */
export declare function parseAstudioPopupPoints(payload: unknown): number;
/**
 * 解析待领取每日签到弹窗列表中的目标项。
 */
export declare function extractAstudioDailyRewardPopup(data: unknown): AstudioDailyRewardPopup | undefined;
/**
 * 解析待领取新用户礼包弹窗（NEW_USER_DIALOG）。
 */
export declare function extractAstudioNewUserPopup(data: unknown): AstudioClaimablePopup | undefined;
/**
 * 提取所有可领取的福利弹窗（包含每日签到与新用户礼包）。
 */
export declare function extractAstudioClaimablePopups(data: unknown): AstudioClaimablePopup[];
/**
 * 执行 AStudio 每日签到领取（claimDaily）。
 *
 * 对接：
 * 1. GET /client-popups/pending 查询待领取的 DAILY_REWARD_DIALOG 弹窗；
 *    若无弹窗或无 DAILY_REWARD_DIALOG，返回 already-claimed；
 * 2. POST /client-popups/complete 提交 popupId 与 instanceKey 领取积分；
 * 3. 终态鉴权失败（code 80000）返回 failed 并提示人工重登。
 */
export declare function claimAstudioDailyReward(credential: AstudioCredential, options?: AstudioCreditsOptions): Promise<ClaimOutcome>;
/**
 * 单独领取新用户礼包（NEW_USER_DIALOG）。
 */
export declare function claimAstudioNewUserGift(credential: AstudioCredential, options?: AstudioCreditsOptions): Promise<ClaimOutcome>;
/** 规范签到别名（对齐 claimDaily 规范）。 */
export declare const claimDaily: typeof claimAstudioDailyReward;
//# sourceMappingURL=astudio-credits.d.ts.map