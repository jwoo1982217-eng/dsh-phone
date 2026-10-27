/**
 * TRAE「1024 程序员节每日打卡抽奖」—— 活动状态读取与参与。
 *
 * ## 契约全部来自真机取证（2026-10-20，Trae CN 客户端 + 实测）
 *
 * | 项 | 值 |
 * |---|---|
 * | 读活动 | `POST {host}/trae/api/v2/ug/activity/info`，body `{ version_code, req_source }` |
 * | **参与抽奖** | `POST {host}/trae/api/v2/ug/activity/action`，body `{ activity_id: 'checkin_1024', req_source }` |
 * | `req_source` | **数字**：IDE = `1`、Lite = `2`（客户端 `OGe(t,…)` 的 `t?2:1`）⇒ 我们恒 `1` |
 * | 活动 id | 客户端常量 `Y1 = 'checkin_1024'`（`common/checkinLottery.js`） |
 * | 重试 | 客户端对 `checkin_1024` **显式 `retry: 0`**（敏感写操作） |
 *
 * ## ⚠️⚠️ 三条实测边界（每一条都曾经让判据变错）
 *
 * 1. **`activity/info` 必须带 `req_source` + `version_code`**：空 body 只回 **6** 个
 *    通用活动，带齐后回 **8** 个 —— 多出来的正是 `checkin_1024` 与 `code_fission_202609`
 *    （账号级活动）。⇒ 缺参数会把「有资格」误判成「没有这个活动」。
 * 2. **`work_extra.grantable` / `granted` 是字符串 `"true"` / `"false"`，不是布尔**。
 *    客户端自己的 `_transformCommercialActivityInfo` 写的是 `o.grantable === true`
 *    —— 对字符串**恒假**（客户端自身缺陷）。⇒ 本实现**两种形态都接受**，
 *    否则会像客户端那样把「可领」判成「不可领」。
 * 3. **`checkin_1024` 只在活动窗口内出现**：实测窗口
 *    `2026-10-18T16:00Z → 2026-10-24T10:00Z`（北京时间 10-19 00:00 → 10-24 18:00）。
 *    ⇒ 窗口外 `activity_id` 缺失是**正常**，不得报错。
 *
 * ## 为什么「参与」是**独立导出**而不是塞进 `claimTraeDailyCheckin`
 *
 * 抽奖是**不可逆的写操作**、且每日次数有限（窗口内「每日签到领 100，再抽 88/888」）。
 * 把它嵌进签到主流程会让「只要签到成功就必然抽奖」成为**默认行为**，
 * 用户无法只签到不抽奖。⇒ 这里提供纯函数 + 独立入口，由调用方显式决定。
 * 客户端自己是在 `claimCheckinCredits` 成功后**直接 participate**（同一 Promise 链），
 * 我们**刻意不照抄**那一点：那条路一旦服务端拒绝，会把「签到成功」也拖进失败分支。
 */
import { type TraeCredential } from './trae.js';
import type { TraeProduct } from './trae-product.js';
/** 1024 打卡抽奖的活动 id（客户端常量 `Y1`）。 */
export declare const TRAE_CHECKIN_LOTTERY_ACTIVITY_ID = "checkin_1024";
/**
 * `req_source` 取值：IDE = `1`、Lite/Trae Work = `2`。
 *
 * ⚠️ 它是**数字**而不是「来源字符串」（客户端 `OGe` 的 `t ? 2 : 1`）。
 *    我们按 IDE 侧行为恒发 `1`。
 */
export declare const TRAE_UG_REQ_SOURCE_IDE = 1;
/** 一个商业活动条目（只解析本模块用得到的字段）。 */
export interface TraeCommercialActivity {
    /** 活动 id（如 `checkin_1024` / `checkin_credits`）。 */
    activityId: string;
    /** 活动类型数字（`checkin_1024` 实测为 `108`）。 */
    activityType: number;
    /** 服务端 `Enabled`。 */
    enabled: boolean;
    /** 开始 / 结束时刻（毫秒；缺失为 `undefined`）。 */
    startTimeMs?: number;
    endTimeMs?: number;
    /** 有资格（`work_extra.eligible`）。 */
    eligible?: boolean;
    /** 可领取/可参与（`work_extra.grantable`；**兼容字符串 `"true"`**）。 */
    grantable?: boolean;
    /** 已领取/已参与（`work_extra.granted`；**兼容字符串 `"true"`**）。 */
    granted?: boolean;
}
/**
 * 把一个**可能**是布尔也可能是字符串的字段读成布尔。
 *
 * ⚠️⚠️ **这就是实测边界 ②**：真实响应里 `grantable` / `granted` 是 `"true"` / `"false"`
 *    字符串（长度 4 / 5 即它们）。客户端写 `=== true` ⇒ 对字符串恒假 ⇒ 自身缺陷。
 *    本函数同时接受：
 * - 布尔 ⇒ 原样；
 * - 字符串 ⇒ 去空白后小写，只认 `'true'` / `'false'`（其余 → `undefined`，**不臆造**）；
 * - 其他（含缺省）⇒ `undefined`。
 *
 * ⚠️ 返回 `undefined` 与 `false` **语义不同**：前者「上游没说」，后者「上游说不行」。
 *    调用方不得把 `undefined` 当成 `false`（那会把「不知道」误报成「没资格」）。
 */
export declare function readTraeBooleanish(value: unknown): boolean | undefined;
/** 从响应里挑出活动数组；形状不对返回 `undefined`（不抛，交由调用方决定文案）。 */
export declare function extractTraeCommercialActivities(body: unknown): TraeCommercialActivity[] | undefined;
/** 现在是否落在活动窗口内（缺失窗口字段 ⇒ 视为**在**窗口内，不臆造过期）。 */
export declare function isTraeActivityInWindow(activity: Pick<TraeCommercialActivity, 'startTimeMs' | 'endTimeMs'>, now?: number): boolean;
/** {@link decideTraeLottery} 的结论。 */
export interface TraeLotteryDecision {
    /**
     * - `participate`：可以抽（在窗口内、enabled、eligible、grantable、**且未 granted**）；
     * - `already`：今天已经抽过（`granted === true`）；
     * - `unavailable`：活动没下发 / 未启用 / 不在窗口 / 无资格 / 不可领 —— 附 `reason`。
     */
    kind: 'participate' | 'already' | 'unavailable';
    reason?: string;
}
/**
 * **纯函数**：从活动列表判断「该不该抽」。
 *
 * ⚠️ 判据只有这一份 —— 抽奖是**不可逆写操作**，判错会白烧机会，
 *    故不允许调用点各写一套 `if`。
 *
 * ⚠️ 「拿不到 `eligible` / `grantable`」一律按 **不可参与** 处理（fail-closed）：
 *    宁可少抽一次，也不要因为字段缺失去撞一个可能已用掉的机会。
 *    这与本仓库「判据缺失不得当成功」的既有取向一致。
 */
export declare function decideTraeLottery(activities: readonly TraeCommercialActivity[] | undefined, now?: number): TraeLotteryDecision;
/** {@link fetchTraeLotteryActivities} 的入参。 */
export interface TraeLotteryFetchOptions {
    fetcher?: typeof fetch;
    /** 账号客户端版本（客户端会带 `version_code`，缺失也能跑但要与客户端形状一致）。 */
    versionCode?: string;
    timeoutMs?: number;
}
/**
 * 读活动信息（**只读 GET 语义的 POST**，不产生任何写操作）。
 *
 * ⚠️ 必须带 `req_source` + `version_code`，否则**看不到账号级活动**（实测边界 ①）。
 *
 * @returns 活动数组；失败返回 `{ error }`，**不抛**（签到流程不该被它拖垮）。
 */
export declare function fetchTraeLotteryActivities(credential: TraeCredential, product: TraeProduct, options?: TraeLotteryFetchOptions, userId?: string): Promise<{
    activities?: TraeCommercialActivity[];
    error?: string;
}>;
/** {@link participateTraeLottery} 的结果。 */
export interface TraeLotteryParticipateResult {
    /** `ok` = 服务端接受；`failed` = 明确失败；`skipped` = 前置判据说**不该发**（一个请求都没发）。 */
    kind: 'ok' | 'failed' | 'skipped';
    /** 服务端返回的业务码（`ok` 时为 `0`）。 */
    code?: number;
    /** 服务端文案（失败时展示给用户；如实透传，不替换）。 */
    message?: string;
    /** 判定/失败原因（`skipped` 时说明为什么没发）。 */
    reason?: string;
    /** 本次抽奖带来的积分（服务端有就给，没有就不臆造）。 */
    credits?: number;
    /**
     * ★ **奖品如实描述**（2026-10-20 真机实测补）：抽到的可能是**券**而不是积分
     * （实测 `prize_text: "AI Build 专属抵扣券"` + `coupon_face_amount_fen: 1000`）。
     * 只给 `credits` 会把券的信息整个丢掉。
     */
    prizeText?: string;
}
/**
 * **参与 1024 打卡抽奖**（写操作；每日一次，**不可逆**）。
 *
 * ## ⚠️⚠️ 与签到**刻意解耦**
 *
 * 客户端是在 `claimCheckinCredits` 成功后**同一 Promise 链里直接 participate**。
 * 我们**不照抄**那一点：抽奖失败会把「签到成功」也拖进失败分支（本仓库对
 * 「登录成功却因记账失败被报成失败」已有两轮事故史）。⇒ 本函数**独立入口**，
 * 由调用方显式调用，失败只回报自己。
 *
 * ## ⚠️ 三道前置闸门（任一不过 ⇒ `skipped`，**一个请求都不发**）
 *
 * 1. **先读活动状态**并跑 {@link decideTraeLottery}（`participate` 才继续）；
 * 2. **不重试**（客户端对 `checkin_1024` 显式 `retry: 0`）；
 * 3. 只发 `activity_id` + `req_source`，与客户端 body 逐字段一致
 *    （客户端还带了 `assertCheckinLotteryRequest` 的本地校验，我们没有那个上下文 ⇒ 不伪造）。
 *
 * ⚠️ **把「判定结果」与「服务端结果」分成两层**：跳过的原因与服务端拒绝的原因
 *    文案不同，混在一起用户无法判断「是我没资格」还是「抽奖失败了」。
 */
export declare function participateTraeLottery(credential: TraeCredential, product: TraeProduct, options?: TraeLotteryFetchOptions, userId?: string, now?: number): Promise<TraeLotteryParticipateResult>;
/**
 * 从抽奖响应里读「本次获得多少积分」。
 *
 * ⚠️ **读不到就返回 `undefined`，绝不臆造 0** —— 本仓库已因「领取成功 +0 积分」
 *    报障三次（`trae-credits.ts:283`、`zcode-auth.ts:2053`、`provider-credits.ts:310`），
 *    根因都是「拿不到实际所得却照样报一个数字」。`0` 会被读成「没抽到」，
 *    与「不知道」是两件事。
 */
export declare function readLotteryCredits(record: Record<string, unknown>): number | undefined;
/**
 * 抽奖**奖品**的如实描述（2026-10-20 真机实测补）。
 *
 * ## 为什么必须有它（实测打穿了我第一版）
 *
 * 真机抽到的响应是：
 * ```json
 * {"work_extra":{"coupon_face_amount_fen":1000,"eligible":true,"grantable":false,
 *                "granted":true,"prize_text":"AI Build 专属抵扣券","prize_type":2}}
 * ```
 * ⇒ **奖品是券，根本没有 `credits` 字段**。而第一版只用 {@link readLotteryCredits}
 *   读积分 ⇒ 抽到券时返回 `undefined` ⇒ 提示退化成「所得以 IDE 面板为准」，
 *   把 `prize_text`（"AI Build 专属抵扣券"）与 `coupon_face_amount_fen`（1000 分 = 10 元）
 *   这两条**已知的**真实信息**白丢了**。
 *
 * ⚠️ 判据：**只如实转述上游给的字段**，不猜、不换算成"多少积分"。
 *    券与积分是**不同单位**（本仓库红线：跨单位不得求和/不得混算）。
 *
 * @returns 可读描述；上游没给任何奖品字段 ⇒ `undefined`（不臆造"没抽到"）。
 */
export declare function readTraeLotteryPrize(record: Record<string, unknown>): {
    /** 上游的奖品文案（`prize_text`），原样。 */
    text?: string;
    /**
     * 奖品类型（`prize_type`）：实测 `2` = 券。
     * ⚠️ **不枚举**其余取值 —— 只实测过 2，臆造映射会让未知类型被错标。
     */
    type?: number;
    /** 券面额（分）。`coupon_face_amount_fen`，**单位是分**，展示时自行除 100。 */
    couponFaceAmountFen?: number;
    /** 积分（若上游给的是积分奖）。 */
    credits?: number;
} | undefined;
/** 把 {@link readTraeLotteryPrize} 的结论转成**一句如实的中文提示**。 */
export declare function describeTraeLotteryPrize(prize: ReturnType<typeof readTraeLotteryPrize>): string | undefined;
//# sourceMappingURL=trae-lottery.d.ts.map