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
 * ## 判据只用**服务端活动列表**（`/sash/api/v1/me/campaigns` 的响应）
 *
 * 旧判据是「无 `CLAIM_BENEFIT` **且** 用量响应里 `addOnQuota` 字段缺失」。
 * 后者**实测不可靠**（用户报障 IKJSHK，2026-10-07）：已开通账号也常常没有
 * `addOnQuota`（只有 `userQuota`），11 个账号里 7 个被误判「未开通」。
 * 维护者复核确认「`addOnQuota` 不是『是否登录过官方客户端 / 是否开通』的可靠
 * 代理」——同一份响应形状在 `349569d`（2026-09-26）被判「真未开通」、在
 * 2026-10-07 被判「误报」，说明**字段形状本身分不开这两类账号**。
 *
 * ## 新判据（仅凭活动列表，全部是服务端信号）
 *
 * | 活动列表形态 | 判定 | 依据 |
 * |---|---|---|
 * | 含任意 `CLAIM_BENEFIT`（`CLAIMABLE` 或 `CLAIMED`） | **已开通** → false | 服务端给该账号下发了「领积分」活动（真实抓包 `qoder-claim.spec.ts` 的 `CAMPAIGNS_BODY` / `CAMPAIGNS_AFTER_CLAIM`）。⚠️ **证据边界见下方「这一格的证据强度」** —— 抓包样本里的 `CLAIM_BENEFIT` **全是每日领取那一条** |
 * | `showCampaign:true` 且**无** `CLAIM_BENEFIT`（只剩 `VIEW_DETAILS`） | **未开通** → true | 服务端认识该账号、给它看了活动页，但**没有下发任何可领福利** —— 「未开通」的形态（2026-09-26 实测，`CAMPAIGNS_ONLY_VIEW`）。⚠️ 该形态与「缺 machine 头」**逐项同形**，故必须配第三腿才成立 |
 * | 列表为空 / `showCampaign:false` / 未取到 | **无法判定** → false | 来自 **CLI 身份**（`Cosy-ClientType:'5'`）或「今天已领」，与「未开通」不可区分；宁可少提示，不可误报（`CAMPAIGNS_EMPTY`） |
 *
 * ### ⚠️⚠️ 这一格的证据强度：**判据读的是「任意福利」，文案宣称的是「每日领取」
 *
 * 上表第一行把「含**任意** `CLAIM_BENEFIT`」等同于「**已开通每日领取**」。
 * 这两条**不是同一件事**，而本仓**没有证据**支持它们等价：
 *
 * - 仓库里两份 `CLAIM_BENEFIT` 抓包样本（`CAMPAIGNS_BODY` / `CAMPAIGNS_AFTER_CLAIM`）
 *   的 `CLAIM_BENEFIT` **都是每日领取那一条**（`campaignKey: 'act-20260921-308'`）；
 * - 无任何观测能证明「未开通每日领取的账号不会下发**非每日**的 `CLAIM_BENEFIT`」；
 * - 而运营类活动在服务端**确实存在**（`docs/agent-notes/misc.md:639` 记着
 *   「实测还有 `VIEW_DETAILS` 型活动，如『Pro 首月翻倍』」）——只是现有样本里
 *   它们恰好是 `VIEW_DETAILS` 而非 `CLAIM_BENEFIT`；
 * - ⚠️ 本仓**目前也没有能力区分**：`campaignKey` 全仓只用于填 `activityName`
 *   展示（见本文件 `fetchQoderCheckinStatus`），没有任何地方按它分流。
 *
 * ⇒ **已知漏报边界**：若上游真给未开通账号下发一个运营福利 `CLAIM_BENEFIT`，
 * 该账号会被判「已开通」⇒ 落到「当前没有可领取的活动」，**当天 100 Credits
 * 静默漏领且零出路提示**。
 *
 * ⚠️ **本项目的取证纪律**（本文件下方「为什么不用『尝试领取』」那条）：
 * **用未经验证的信号代替服务端语义，正是本缺陷反复踩坑的根源** ——
 * 该纪律在此处的应用就是：**不假装这条等价关系已被验证**。
 * 故此处**如实标注**为未验证，而非据此再写一条对称外推去「收紧」判据
 * （那会用同类未验证假设替换同类未验证假设，且需要臆造 `campaignKey` 的
 * 生成规则——同样属于凭空发明线上协议）。
 *
 * ⏳ **待真机取证**：一个「真未开通、但服务端下发了非每日 `CLAIM_BENEFIT`」的
 * 账号。在此之前该格按「任意福利即已开通」执行（保守方向：宁可漏报不可误报）。
 *
 * ⚠️ **为什么不用「尝试领取、服务端拒绝」作为判据**（曾考虑，IKJSHK 建议的
 * 修法 1）：走到「未开通」判定这条路径时，活动列表里本就**没有可领的
 * `CLAIM_BENEFIT`**（只有 `VIEW_DETAILS`），手上**没有可领的 `campaignId`**；
 * 对一个 `VIEW_DETAILS` 活动发 claim 的响应形状**从未被抓包实测过**，据此判定
 * 等于凭空发明线上协议 —— 这正是本缺陷反复踩坑的根源（用未经验证的信号代替
 * 服务端语义）。故判据取**已被抓包实证**的活动列表三态。
 *
 * ⚠️ **必须与「今天已领」「还没刷新」「请求头不完整」区分开**：本函数只在
 * 列表**非空且 `showCampaign` 为真却又无 `CLAIM_BENEFIT`**、**且本次请求
 * 确实带上了成对 machine 头**时才返回 true；其余「拿不到 CLAIM_BENEFIT」
 * 的情况（空列表 / 未取到 / **机器头缺失**）一律 false，把「说成已领 /
 * 说成未开通」这两个代价更高的方向都留给上游按 `refreshed` 处理。
 *
 * ⚠️⚠️ **两个方向都要读，漏报边界见上**：
 * - **误报方向**（用户白跑）：缺 machine 头 → 由第三腿挡住（PR !117 审计 P0-1）；
 * - **漏报方向**（当天额度静默漏领）：非每日福利的 `CLAIM_BENEFIT` → **未修**，
 *   待真机取证（见「这一格的证据强度」）。
 *
 * ⚠️⚠️ **第三腿：机器头必须真的发出去了**（PR !117 审计 P1-1）。
 * 缺 machine 头时服务端的响应形态是 `showCampaign:true, claimable:false,
 * **1 条 `VIEW_DETAILS`**`（逐项消融表，见 `qoder-machine.ts` /
 * `qoder-product.ts`；同表亦见本文件 `creditsHeaders` 的注释）——这与
 * 「未开通」的形态**逐项同形**，本函数单看响应**无法**区分。
 *
 * ⚠️ 该形态是**纯插件用户的常态**：`withQoderMachineHeadersAsync` 拿不到
 * 身份时按 `qoder-machine.ts` 的保守降级路径「不带这两个头、照常发请求」，
 * 而 `qoder-machine.ts` 自己就记录了 exe 定位失败 / 陈旧缓存这条路
 * **2026-09-25 已复发过一次**。若不设这道闸，凡本机拿不到机器身份的用户，
 * 其**每一个**账号都会被判「未开通」，并被前端（`usage-badge.js` /
 * `jet-hub.js` 都只判 `actionRequired === true`）渲染成醒目的
 * 「请先用 Qoder 官方客户端登录一次」——而真正缺的是机器头，
 * **装了客户端也未必能拿到**（同一条复发路径 + spawn 超时），用户按指引白跑一趟。
 *
 * ✅ **这条区分信号一直在插件自己手上**（`creditsHeaders` 的返回值里就有
 * `Cosy-MachineToken`），不需要额外请求，也不依赖任何未经验证的推断。
 * 端到端复现与修复验证见 `docs/audit/pr117-qoder-audit.md`。
 *
 * @param campaigns 活动列表（undefined 表示未取到，此时无法判定 → false）
 * @param machineHeadersPresent 本次请求是否带上了成对 machine 头；
 *   **省略视作 false**（保守：无法证明头齐全就不下「未开通」结论）
 */
export declare function isQoderNotActivated(campaigns: QoderCampaigns | undefined, machineHeadersPresent?: boolean): boolean;
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