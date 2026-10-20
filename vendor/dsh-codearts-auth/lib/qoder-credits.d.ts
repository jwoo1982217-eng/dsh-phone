/**
 * Qoder 积分余额查询与每日领取。
 *
 * ## 与前四个 provider 的差异
 *
 * Qoder 的用量接口**不需要 WASM 签名** —— 只需 `Bearer` + `Cosy-ClientType`
 * 头（源码 `Bx()`）。这一点与模型列表端点（`/api/v2/model/list`，需签名）
 * **不同**，早期因为只按 `/api/` 前缀搜索而误判「Qoder 无积分端点」。
 *
 * ## 端点与实测响应（2026-09-19，真实凭据）
 *
 * ```
 * GET {openApiBase}/sash/api/v2/me/usage
 * Authorization: Bearer <token>
 * Cosy-ClientType: 5
 * ```
 *
 * ```json
 * { "displayMode": "qoder",
 *   "qoderUsage": {
 *     "userType": "personal_standard",
 *     "userQuota":  { "total": 0,   "used": 0, "remaining": 0,   "unit": "credits" },
 *     "addOnQuota": { "total": 100, "used": 0, "remaining": 100, "unit": "credits" },
 *     "expiresAt": 253402214400000 } }
 * ```
 *
 * ⚠️ **余额不只在 `userQuota` 里**：实测该账号 `userQuota.remaining = 0`
 * 而 `addOnQuota.remaining = 100`（用户所说的「资源包 100 积分」正是后者）。
 * 只读 `userQuota` 会显示 0 —— 与其它 provider 的「漏读某一层」是同一类缺陷。
 *
 * ## 每日领取（2026-09-21 由抓包解出，keylog 解密）
 *
 * ```
 * GET  {openApiBase}/sash/api/v1/me/campaigns
 * POST {openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空**
 * ```
 *
 * 领取响应（实测，`grantedAt` 与 `claimedAt` 相差 200ms）：
 *
 * ```json
 * { "grantId": "01a0c475-d6f8-70de-90b2-d4c8058c554d",
 *   "status": "CLAIMED", "replayed": false,
 *   "benefit": { "kind": "CREDITS", "amount": 100,
 *                "modelScope": { "modelSeries": { "key": "ALL_MODELS" } },
 *                "validity": { "mode": "RELATIVE_DAYS", "days": 30 } },
 *   "campaignId": "01a0bf8d-…", "campaignKey": "act-20260921-308",
 *   "campaignVersion": 1,
 *   "claimedAt": "2026-09-21T14:54:12.176671Z",
 *   "grantedAt": "2026-09-21T14:54:12.393072Z",
 *   "expiresAt": "2026-10-21T14:54:12.176671Z" }
 * ```
 *
 * ⚠️ **幂等判据是响应体的 `replayed:true`**，不是 HTTP 状态码：
 * 重复领取同样返回 **200**，但 `replayed` 为 true、**不含 `benefit`**，
 * 且 `claimedAt` 是**上一次领取的旧时间**（实测 `2026-09-18`，而请求发生在
 * `2026-09-21`）。只看状态码会把「今天已领」误报成「领取成功 +100」。
 *
 * ⚠️ **请求体必须是空串**（抓包里 `content-length: 0`）。源码里领取走
 * `POST` 但无 payload；发 `{}` 之类未经验证的 body 属额外风险，故照实发空。
 *
 * ## 为什么不早做
 *
 * `/sash/api/v1/me/campaigns` 早期实测返回
 * `{"showCampaign":false,"claimable":false,"campaigns":[]}`，据此误判
 * 「Qoder 无签到端点」并把 `dailyCheckin` 登记为 false。真相是**那天已领**；
 * 活动状态是**每日 10:00（UTC+8）刷新**的（响应里
 * `description: "每日 10:00（UTC+8）刷新，领取后 30 天有效"`）。
 */
import { type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js';
import { type QoderCredential } from './qoder.js';
import type { QoderProduct } from './qoder-product.js';
/** 用量接口路径（挂 `openApiBase`）。 */
export declare const QODER_USAGE_PATH = "/sash/api/v2/me/usage";
/** 活动列表路径（挂 `openApiBase`）。 */
export declare const QODER_CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
/**
 * 每日活动**刷新时刻**（UTC+8 的小时）。来源是服务端自己下发的原文：
 * `description: "每日 10:00（UTC+8）刷新，领取后 30 天有效"`（见文件头）。
 *
 * ⚠️ 它的意义：**刷新之前**查到的活动列表属于「昨天那一轮」——
 * 看到 `CLAIMED` 只能说明昨天领过，**不能**说明今天已领。
 * 这个事实曾经造成过真实损失（见 {@link hasQoderCampaignRefreshedToday}）。
 */
export declare const QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10;
/**
 * 「今天的活动列表是否已经刷新」。
 *
 * **必须用算术平移而不是 `Date.getHours()`**：活动按 **UTC+8** 结算，
 * 取本机时区会让用户出差 / 改系统时区时得到错的答案（偏东会提前把当天
 * 记为已处理、真漏领；偏西会一天判两次）。口径与 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS` 一致，不另立偏移常量。
 */
export declare function hasQoderCampaignRefreshedToday(nowMs?: number): boolean;
/**
 * 判断账号是否「尚未开通每日领取」。
 *
 * 判据（两条**同时**满足才算，避免误报）：
 * 1. 活动列表里**没有** `CLAIM_BENEFIT`（连已领的都没有）；
 * 2. 用量响应里 `addOnQuota` 字段**不存在**（注意是缺失，不是 0 ——
 *    已开通账号即使额度用尽也会有该字段，如 `{total:100, remaining:0}`）。
 *
 * ⚠️ 第 2 条用「字段是否存在」而非「remaining 是否为 0」：后者对
 * 「额度用光」与「从未开通」不可区分，会把用光额度的老账号误报成未开通。
 *
 * @param campaigns 活动列表（undefined 表示未取到，此时不判定）
 * @param usageBody 用量响应体（undefined 表示未取到，此时不判定）
 */
export declare function isQoderNotActivated(campaigns: QoderCampaigns | undefined, usageBody: unknown): boolean;
/**
 * 拉取用量响应体（只读，失败返回 undefined）。
 *
 * 单独抽出来是给 `isQoderNotActivated` 喂判据用 —— 它需要一个**原始**响应，
 * 而 `fetchQoderCreditBalance` 会把结果归一化成 `CreditBalance`
 * （其中「查不到」与「余额 0」都可能变成 null，不足以区分开通与否）。
 */
export declare function fetchQoderUsageRaw(credential: QoderCredential, product: QoderProduct, fetcher?: typeof fetch): Promise<unknown>;
/**
 * 把一个 quota 对象转成 `CreditPackage`。
 *
 * `remaining` 优先取服务端字段；缺失时按 `total - used` 计算
 * （对齐源码 `tVe` 的 `Math.max(0, total - used)`）。
 * 负值一律 clamp 到 0：服务端在超额扣费/计量回滚下可能下发负值，
 * 原样透出会让卡片显示「-12.5 积分」。
 */
/**
 * 「套餐额度」这个包的**固定名**（本仓库自己合成的名字，服务端不下发）。
 *
 * ⚠️ 导出它是为了让「用量徽标」的套餐判定（`src/badge-subscription.ts`）与这里
 * **共用同一个字面量**：判定靠的是包名精确等于它，两处各写一份字符串会在将来
 * 改名时静默失配（表现为徽标永远不显示 Qoder 的订阅额度）。
 */
export declare const QODER_PLAN_PACKAGE = "\u5957\u9910\u989D\u5EA6";
/**
 * 查询 Qoder 账号积分余额。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 401 / 响应形状非法），
 * 与「余额为 0」严格区分 —— 失败时 UI 应显示原因而不是 0。
 *
 * 企业版账号（`displayMode === 'enterprise'`）返回 `null`：
 * 那种模式不提供额度数字，只给一个外部链接（`enterpriseUsage.detailUrl`），
 * 报 0 会误导用户以为没额度。
 */
export declare function fetchQoderCreditBalance(credential: QoderCredential, product: QoderProduct, fetcher?: typeof fetch): Promise<CreditBalance | null>;
/** 把 `CreditBalance` 压成一行可读摘要（供探针与日志使用）。 */
export declare function describeQoderBalance(balance: CreditBalance | null): string;
/** 一个可领取的活动条目（`campaigns[]` 的一项，只保留实现需要的字段）。 */
export interface QoderCampaign {
    campaignId: string;
    campaignKey?: string;
    /**
     * 动作类型：`CLAIM_BENEFIT` = 可领取积分；`VIEW_DETAILS` = 仅跳转详情
     * （实测「Pro 首月翻倍」就是后者，**不该尝试领取**）。
     */
    actionType?: string;
    /** `CLAIMABLE` / `CLAIMED` / … —— 领取前的权威判据。 */
    claimStatus?: string;
    /** 可领积分（`benefit.amount`）。 */
    amount?: number;
}
/**
 * 活动列表的一次解析结果。
 *
 * ⚠️ `claimable` 为 false 时**不代表没有活动** —— 实测今天已领后
 * 服务端返回 `showCampaign:false, claimable:false, campaigns:[]`，
 * 所以「无活动」与「已领完」在响应上无法区分。不要据此下结论。
 */
export interface QoderCampaigns {
    showCampaign: boolean;
    claimable: boolean;
    campaigns: QoderCampaign[];
}
/** 解析 `/sash/api/v1/me/campaigns` 的响应；形状非法时返回 undefined。 */
export declare function parseQoderCampaigns(body: unknown): QoderCampaigns | undefined;
/**
 * 查询活动列表（签到状态）。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 非 2xx / 形状非法），
 * 与「无活动可领」严格区分。
 *
 * `CheckinStatus` 是五个 provider 共用的结构，此处按 Qoder 的语义映射：
 *
 * - `active`：**拿到响应即 true**。⚠️ 不按「列表非空」判定 ——
 *   服务端在「今天已领」时会把 `campaigns` 清空并回 `showCampaign:false`，
 *   若据此判 `active:false`，调用方（`collectClaimResults`）会先命中
 *   「活动未开启」分支，把「今天已领」误报成「签到活动未开启」。
 * - `todayCheckedIn`：**只有存在「领过」的领分类活动时才为 true**
 *   （`CLAIM_BENEFIT` 且 `claimStatus === 'CLAIMED'`）。
 *
 *   ⚠️ **不能写成「没有可领活动即为 true」**（真实缺陷，用户报障
 *   「没领过就显示已经领取，去 IDE 看还是可以领取的状态」）：
 *   「列表里没有可领项」**不等于**「今天领过了」—— 它还可能是
 *   ① 未到刷新时间（每日 10:00 UTC+8）、② 请求头不完整导致服务端未下发
 *   （实测缺 `Cosy-MachineToken`/`Cosy-MachineType` 时就会这样，
 *   见 `qoder-machine.ts`）、③ 该账号本就无此类活动。三者都不是「已领」。
 *
 *   2026-09-21 抓包给了**同一账号的领取前后对照**（这是判据可靠性的直接证据）：
 *
 *   | 时刻 | `claimable` | 那条 `CLAIM_BENEFIT` 的 `claimStatus` |
 *   |---|---|---|
 *   | 领取前 | `true` | `CLAIMABLE` |
 *   | 领取后 | `false` | `CLAIMED` |
 *
 *   故「有 `CLAIM_BENEFIT`+`CLAIMED`」是「已领」的**充分且可靠**判据。
 *   方向仍取保守：误报未领最多让用户多点一次（服务端幂等，回
 *   `replayed:true`，无害）；误报已领会让其**真的错过当天积分**。
 *
 *   ⚠️⚠️ **但它只对「刷新之后」成立**（真实缺陷，2026-10-02 审查 PR !33 定位）：
 *   活动每日 10:00（UTC+8）才刷新，故**刷新前**看到的那条 `CLAIMED` 属于
 *   **昨天**。上午 9 点查状态若照旧判 `todayCheckedIn:true`，界面会显示「今天
 *   已领」，而官方 IDE 里今天的活动其实还没出现 —— 正好落在「误报已领」那个
 *   **不可逆**的方向上。刷新前一律判 `false`（见 `hasQoderCampaignRefreshedToday`）。
 * - `dailyCredit`：可领活动声明的 `benefit.amount`（实测 100）。
 */
export declare function fetchQoderCheckinStatus(credential: QoderCredential, product: QoderProduct, fetcher?: typeof fetch, nowMs?: number): Promise<CheckinStatus | null>;
/**
 * 领取一个活动的积分。
 *
 * ⚠️ **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**：重复领取同样
 * 返回 200，但 `replayed:true` 且**不含 `benefit`**、`claimedAt` 是旧时间。
 * 只看状态码会把「今天已领」误报成「领取成功 +100」。
 *
 * ⚠️ **请求体必须是空串**（抓包实测 `content-length: 0`）。
 */
export declare function claimQoderCampaign(credential: QoderCredential, product: QoderProduct, campaignId: string, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/**
 * 领取该账号**当前所有**可领活动。
 *
 * 一个账号可能同时有多个 `CLAIM_BENEFIT` 活动（实测有每日 100 Credits
 * 与其它运营活动），故逐个领取而非只领第一个。
 *
 * 返回的 `ClaimOutcome` 汇总为一条：
 * - 无可领活动 → `inactive`（⚠️ **不是** `already-claimed`）；
 * - 至少一个成功 → `claimed`（`credit` 为累计值）；
 * - 全部已领（`replayed:true`）→ `already-claimed`；
 * - 全部失败 → `failed`（带上第一条错误原因）。
 *
 * ⚠️ **「无可领活动」必须是 `inactive`，不能报 `already-claimed`**
 * （真实缺陷，用户报障「没领过就显示已经领取」）：旧实现在
 * `targets.length === 0` 时直接返回「今天已领取」，于是只要服务端没下发
 * 可领项（含**请求头不完整**、未到刷新时间、本就无活动三种情形），
 * 界面就显示「今天已领取」，与 IDE 的「可领取」直接矛盾。
 * 二者语义完全不同：`inactive` = 没东西可领；`already-claimed` = 领过了。
 */
export declare function claimQoderDailyCheckin(credential: QoderCredential, product: QoderProduct, fetcher?: typeof fetch, nowMs?: number): Promise<ClaimOutcome>;
//# sourceMappingURL=qoder-credits.d.ts.map