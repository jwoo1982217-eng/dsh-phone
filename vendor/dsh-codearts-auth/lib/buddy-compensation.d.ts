/**
 * CodeBuddy（腾讯云代码助手）**限时补偿积分**的状态查询与领取客户端。
 *
 * ## 端点来源（逆向 + 真实报文双证据）
 *
 * 端点取自 `www.codebuddy.cn` 的前端 bundle
 * （`assets.workbuddy.cn/web/usercenter/<hash>/assets/index-*.js`），原文：
 *
 * ```js
 * bp = async () => await cn.post("/billing/meter/compensation-status")
 * vp = async () => await cn.post("/billing/meter/claim-compensation")
 * ```
 *
 * 「套餐与积分」页上「立即领取」按钮的 `onClick` 闭包调的就是 `vp()`。
 *
 * ⚠️ 路径**没有 `/v2` 前缀**（对比 WorkBuddy 的
 * `/v2/billing/meter/daily-checkin`）—— 这是另一个产品面，别按 v2 抄。
 *
 * ## 用哪个 host（2026-10-16 三 host 实测）
 *
 * **三个 host 全部可达**（Node `fetch`，带完整产品头，均 HTTP 200 且报文一致）：
 *
 * | host | 结果 |
 * |---|---|
 * | `www.codebuddy.cn` | 200 |
 * | `www.workbuddy.cn` | 200 |
 * | `copilot.tencent.com` | 200 |
 *
 * ⚠️ **本模块仍刻意走 `webBase`**（buddy 的取值是 `www.workbuddy.cn`）：
 * ① 它正是网页端发这个请求的站（前端 bundle 就托管在 `assets.workbuddy.cn`），
 *    与「用户看到的那个按钮」逐字同源；
 * ② `endpoint`（`copilot.tencent.com`）是**推理 API 站**，虽然实测也能通，
 *    但把「用户中心类请求」打到推理站没有依据（哪天它收窄路由就会静默失效）。
 *
 * ⚠️⚠️ **一条被污染的实测教训**（记下来别再犯）：我最初在**浏览器**里用
 * `fetch` 测这三个 host，得到「只有 codebuddy.cn 可达、另两个 Failed to fetch」——
 * 那是**跨域 CORS 拦截**造成的假象，不是服务端不可达。**判定端点的可达性
 * 必须在 Node/无 CORS 环境做**；浏览器里的失败要先排除 CORS 再下结论。
 *
 * ## 真实报文（2026-10-16，账号本人的 buddy token）
 *
 * `POST /billing/meter/compensation-status`（空 body）→ HTTP 200：
 *
 * ```json
 * {"code":0,"msg":"OK","requestId":"…","data":{
 *    "claimed": false,
 *    "active": true,
 *    "credit_num": 500,
 *    "validity_period": 1,
 *    "end_time": "2026-10-22 23:59:59"}}
 * ```
 *
 * ⚠️ **鉴权是 `Authorization: Bearer <buddy access_token>`，不需要浏览器
 * cookie** —— 已用 Node `fetch`（无任何浏览器上下文）实测 200。这是本功能
 * 能脱离「网页点按钮」实现自动化的前提。
 *
 * ## 真实报文（2026-10-17，领取端点 —— **成功时没有 `data`**）
 *
 * `POST /billing/meter/claim-compensation`（空 body）→ HTTP 200：
 *
 * ```json
 * {"code":0,"msg":"OK","requestId":"…"}
 * ```
 *
 * **没有 `data` 字段。** 当时本机 5 个账号批量领取，5/5 都是这个形态：
 * 面板按「缺 `data` ⇒ shape」判成「响应格式不认识：响应缺 data 对象」，
 * 于是报「5 个账号领取失败」；而随后用同一批 token 查 status，5/5 都是
 * `claimed:true, active:true, credit_num:500` —— **积分其实早就到账了**。
 *
 * ⇒ 写操作的成败**只看 `code`**（见 `parseEnvelope` 的 `requireData`）；
 *   状态查询仍然要求 `data`，两者判据刻意不同。
 *
 * ## ⚠️ 为什么**不**接进自动签到（本模块的实现约定）
 *
 * 这是一次性的**限时**补偿（`end_time` 到期即作废），不是每日可领的能力。
 * 本仓库对「一次性 / 有代价动作」的既有铁律是**默认不自动执行**
 * （见 `buddy-growth.ts` 的 `runExotic`：盲盒/抽奖默认关闭，理由正是
 * 「避免误触一次性动作」）。
 *
 * ⇒ 本模块**只提供
 *   ① 状态查询（供面板如实展示「有 N 积分待领 / 已领取 / 活动已结束」），
 *   ② 一次显式领取（由用户在面板上点按钮触发）。
 *   **不接入 `credits.claimAll` / `auto-checkin`**，也不在任何后台链路上调用
 *   `claimCompensation`。
 *
 * ⚠️ 将来若有人想改成自动领，**先读这一节**：那会违反上面的约定，且收益只有
 * 一次（活动结束后这个端点对所有人恒返回 `active:false`）。
 *
 * @module src/buddy-compensation.ts
 */
import { type BuddyCredential } from './buddy.js';
import type { BuddyProduct } from './product.js';
/** 补偿状态查询路径。⚠️ 无 `/v2` 前缀（见模块头）。 */
export declare const COMPENSATION_STATUS_PATH = "/billing/meter/compensation-status";
/** 补偿领取路径。⚠️ 无 `/v2` 前缀（见模块头）。 */
export declare const COMPENSATION_CLAIM_PATH = "/billing/meter/claim-compensation";
/**
 * 补偿活动状态（**如实映射上游字段**，不做任何推断）。
 *
 * ⚠️ 字段名逐字取自真实报文，别凭直觉改成 camelCase 的"更好听"版本 ——
 * 那会让解析静默失配（本仓库已多次记录该形态）。
 */
export interface CompensationStatus {
    /** 本账号是否已领取。 */
    claimed: boolean;
    /** 活动是否仍在进行（`false` = 已结束/未开始）。 */
    active: boolean;
    /** 可领取的积分数（上游 `credit_num`）。 */
    creditNum: number;
    /** 上游 `validity_period`，含义未在报文中说明，**原样透传**不解释。 */
    validityPeriod: number | undefined;
    /** 截止时间字符串（上游原样，如 `"2026-10-22 23:59:59"`）。 */
    endTime: string | undefined;
}
/** 查询/领取的失败原因（**结构化**，让调用方能区分「没活动」与「请求失败」）。 */
export type CompensationFailure = 
/** 网络/超时/非 JSON 等请求层失败。 */
{
    kind: 'network';
    message: string;
}
/** 上游业务码非 0。 */
 | {
    kind: 'upstream';
    code: number;
    message: string;
}
/** 响应形状不认识（缺 `data` 或缺关键字段）。 */
 | {
    kind: 'shape';
    message: string;
};
/** 查询结果：成功带状态，失败带结构化原因。 */
export type CompensationStatusResult = {
    ok: true;
    status: CompensationStatus;
} | {
    ok: false;
    failure: CompensationFailure;
};
/** 领取结果。 */
export type CompensationClaimResult = {
    ok: true;
} | {
    ok: false;
    failure: CompensationFailure;
};
/**
 * 查询**本账号**的补偿状态。
 *
 * 只读，无副作用 —— 面板挂载/刷新时调用。
 *
 * ⚠️ `credit_num` 缺失时按 **0** 处理（而不是判失败）：那样面板显示
 * 「无可领取积分」而非报错，与上游「活动在但额度为 0」的真实含义一致。
 */
export declare function fetchCompensationStatus(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<CompensationStatusResult>;
/**
 * 领取本账号的补偿积分（**写操作，只能成功一次**）。
 *
 * ⚠️ **只应由用户在面板上显式点击触发**，不得接进自动签到 / 定时器
 * （理由见模块头）。调用方应在点击后**重新查询状态**刷新展示。
 *
 * ⚠️ **不做重试**：这是一次性写操作，超时后服务端可能已经成功。盲目重试会有两种
 * 坏结果：① 若上游幂等则白打一次请求；② 若上游返回「已领取」的业务码，调用方
 * 会把「其实成功了」误报成失败。故这里**最多发一次**，失败就把上游原文交给用户。
 *
 * ⚠️⚠️ **成功响应没有 `data`**（2026-10-17 实测，见 `parseEnvelope` 的说明）：
 * 上游回的是 `{"code":0,"msg":"OK","requestId":"…"}`。这里必须传
 * `requireData: false`，否则「已领到 500 分」会被判成「响应格式不认识」
 * ——本机 5 个账号 5/5 命中过这个假失败。
 */
export declare function claimCompensation(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<CompensationClaimResult>;
/** 把失败原因整理成给用户看的一句话（**保留上游原文**，那是排障唯一线索）。 */
export declare function describeCompensationFailure(failure: CompensationFailure): string;
//# sourceMappingURL=buddy-compensation.d.ts.map