/**
 * MiniMax Code 签到与积分余额。
 *
 * ## 端点（asar UI chunk 直读，实测通过）
 *
 * ```
 * GET  {host}/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
 * POST {host}/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   body {}
 * GET  {host}/minimax-cloud/api/v1/credit/details
 * ```
 *
 * ## ⚠️ 四个必须记住的点
 *
 * 1. **`timezone_id` 是 query 参数且必填**。实测四种组合：query 生效、
 *    请求头无效、都不带报 `invalid timezone_id`、非法时区名也报错。
 * 2. **业务码在 `base_resp.status_code`**（不是 `code`），且 `invalid timezone_id`
 *    也是 **HTTP 200** —— 只看 HTTP 状态码会把它当成成功。
 * 3. **`points` 是总数，`bonus_points` 是其中的「额外」部分，不得相加**。
 *    实测第 1 天 `points: 800`、`bonus_points: 400`，截图按钮就是「签到得 800」
 *    + 右上角「额外 400」角标。相加会**虚高一倍**。
 * 4. **「今日已领」判据是 `is_today && status === 3`**，**不能**用
 *    「没有 Claimable」反推（与 Qoder「领取成功后列表仍非空」同型教训）。
 */
import { type MinimaxProduct } from './minimax-product.js';
import { type MinimaxCredential } from './minimax.js';
import { type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js';
/** 单日状态（asar `SigninDayStatus`）。 */
export declare const MINIMAX_SIGNIN_STATUS: Readonly<{
    Upcoming: 1;
    Claimable: 2;
    Claimed: 3;
    Disabled: 4;
}>;
/** 领取结果（asar `SigninClaimResult`）。 */
export declare const MINIMAX_CLAIM_RESULT: Readonly<{
    Claimed: 1;
    AlreadyClaimed: 2;
}>;
/** 面板场景（asar `SigninPanelScene`）。 */
export declare const MINIMAX_PANEL_SCENE: Readonly<{
    Unknown: 0;
    First: 1;
    Active: 2;
    Completed: 3;
    Broken: 4;
}>;
/** 归一后的单日条目。 */
export interface MinimaxSigninDay {
    dayNo: number;
    points: number;
    bonusPoints: number;
    status: number;
    isToday: boolean;
}
/** 归一后的面板。 */
export interface MinimaxSigninPanel {
    scene: number;
    days: readonly MinimaxSigninDay[];
}
/**
 * 取本机 IANA 时区名。
 *
 * 客户端就是这么取的（asar UI chunk 模块 39504）：
 * `Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"`。
 *
 * ⚠️ **与 Qoder 的口径不同**：Qoder 的额度标记**写死 UTC+8**（服务端按 UTC+8
 * 结算），而 MiniMax 的签到按**客户端上报的时区**结算。不得互相套用。
 */
export declare function resolveMinimaxTimezoneId(resolve?: () => string): string;
/**
 * 解析签到面板（**完整复刻** asar `validateSigninPanel`）。
 *
 * 硬约束（不满足即返回 undefined，**不编造**）：
 * - `days` **恰好 7 条**
 * - 每条 `day_no` 是 1..7 整数且**无重复**
 * - `points` 非负有限；`bonus_points` 可选但非负有限
 * - `is_today` 是 **boolean**
 * - `status` ∈ {1,2,3,4}
 * - **最多 1 条 `Claimable`**、**最多 1 条 `is_today`**
 * - `scene` ∈ {0,1,2,3,4}
 */
export declare function parseMinimaxSigninPanel(data: unknown): MinimaxSigninPanel | undefined;
/**
 * 把面板映射成 DSH 的 {@link CheckinStatus}。
 *
 * ⚠️ **`dailyCredit = points`**（800），**不是** `points + bonus_points`（1200）。
 * 见文件头注释第 3 点。
 *
 * ⚠️ **`active` 恒 `true`** —— 拿到响应即 true，不按「有可领项」判。
 * 否则会把「今天已领」误报成「签到活动未开启」（Qoder 同型缺陷）。
 */
export declare function minimaxPanelToCheckinStatus(panel: MinimaxSigninPanel): CheckinStatus;
/** 查询签到状态；失败返回 `null`（不抛错）。 */
export declare function fetchMinimaxSigninStatus(credential: MinimaxCredential, fetcher?: typeof fetch, product?: MinimaxProduct): Promise<CheckinStatus | null>;
/**
 * 领取每日签到。
 *
 * ⚠️ **幂等判据是 `claim_result`**（`1` = 本次真领取，`2` = 已领过），
 * **不是 HTTP 状态码**（重复领取同样 200）。
 *
 * ⚠️ 本函数**不抛错**（失败也返回 `failed`），保证批量领取不因单账号中断。
 */
export declare function claimMinimaxDailyCheckin(credential: MinimaxCredential, fetcher?: typeof fetch, product?: MinimaxProduct): Promise<ClaimOutcome>;
/**
 * 查询积分余额。
 *
 * ## ⚠️ 一个已被生产数据推翻的字段误读（2026-09-29 修复）
 *
 * 初版把 `total_count` 当作**积分余额**。这是**错的** ——
 * `total_count` 是 `details[]` 的**记录条数**。
 *
 * 实测原始响应（本机账号领取 800 积分后）：
 * ```json
 * {"details":[{"remaining_amount":"800.00","consumed_amount":"0.00",
 *              "granted_amount":"800.00","credit_type":2,
 *              "granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],
 *  "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
 * ```
 * 真实余额是 `remaining_amount`（**800**），而 `total_count` 是 **1**。
 *
 * ⚠️ **为什么初版没被发现**：账号余额为 0 时 `details` **整个字段缺失**、
 * `total_count` 恰好也是 **0** —— 于是「条数 0」与「余额 0」在数值上
 * **偶然重合**，单测那条断言（`total_count: 0` → `total: 0`）因此成了
 * **同义反复**，无法暴露该误读。领取积分后才分叉（条数 1 / 余额 800）。
 *
 * ## 取值口径
 *
 * - **余额 = Σ `details[].remaining_amount`**（各有效包剩余之和，
 *   与既有 `CreditBalance.total` 的口径一致）。
 * - `remaining_amount` 实测是**字符串**（`"800.00"`），故需要宽容解析
 *   （数字与字符串都接受）—— 上游改型不该让余额整块失效。
 * - ⚠️ `details` 缺失/非数组 ⇒ 视为**空数组 ⇒ 余额 0**（「真的为 0」），
 *   **不是**「查询失败」。两者必须区分（`null` 才是失败）。
 * - ⚠️ `base_resp.status_code` 非 0 ⇒ `null`（真失败）。
 *
 * ⚠️ **`expiredTotal` 仍为 0**：`details[]` 里没有区分「本周期有效」的标志
 *（`credit_type` 的语义未实测），故**不凭猜测分类**。`packages` 同理留空 ——
 * 需要时再按实测补充，**不得**用 locale 文案反推字段名。
 */
export declare function fetchMinimaxCreditBalance(credential: MinimaxCredential, fetcher?: typeof fetch, product?: MinimaxProduct): Promise<CreditBalance | null>;
//# sourceMappingURL=minimax-credits.d.ts.map