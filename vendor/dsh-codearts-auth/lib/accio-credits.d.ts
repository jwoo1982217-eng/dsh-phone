/**
 * Accio（阿里）的**积分与账号身份查询** —— 三个只读端点。
 *
 * ## ⚠️⚠️ 本文件唯一的陷阱：三个端点的**传参方式各不相同**
 *
 * 逐条实测（`docs/agent-notes/providers-accio.md` §6；探针
 * `.tmp-accio/probe-credits.mjs` / `probe-login.mjs` 全部 200）：
 *
 * | 端点 | 方法 | token 位置 |
 * |---|---|---|
 * | `/api/auth/userinfo` | **POST** | **body**（`{accessToken}`） |
 * | `/api/entitlement/currentSubscription` | **GET** | **query**（`?accessToken=…`） |
 * | `/api/entitlement/quota` | **GET** | **query** |
 *
 * **用错即 `405 Method Not Allowed` / `400 Bad Request`**（笔记原文：
 * 「`userinfo` 必须 POST + body（GET 会 405），其余 GET + query（缺 token 会 400）」）。
 * 故 {@link callAccioEndpoint} 里 method 与 token 位置**由同一个 `method` 参数决定**，
 * 调用点无法只改一处而漏掉另一处 —— 这是本文件刻意维持的形状，**不要**为了「统一好看」
 * 把三个端点收成一个公共形状。
 *
 * 官方客户端 bundle（`.tmp-accio/extract/out__main__gateway-worker.js`）里有同一
 * 事实的第二份证据：它的重试助手把新 token 写回 **body JSON**
 * （`n.accessToken = t; body = JSON.stringify(n)`），而另一条路径拼的是
 * **query**（`accessToken=${encodeURIComponent(t)}`）—— 两种形态并存，不是笔误。
 * 同一份 bundle 的端点 schema 也确认 `POST /auth/userinfo` 的响应含
 * `userId` / `userName` / `maskedMobile` / `userLevel` / `routeRegion`（与
 * {@link AccioUserInfo} 逐字段对上）。
 *
 * ## ⚠️ 失败语义：`null` 表达「查不到」，**绝不编造 0**
 *
 * 0 是「已用光」的语义。把一次网络失败画成 `0` 会让用户以为额度被清空
 * （本仓库反复记录的缺陷形态；`src/provider-credits.ts` 文件头有同一约定）。
 * 故 {@link fetchAccioBalanceDetailed} 的任何失败路径都返回 `balance: null` **加**原因。
 *
 * ## ⚠️ 401 / `NOT_LOGIN` 必须与「一般查询失败」区分
 *
 * 两者的**用户动作完全不同**：未登录 ⇒ 去重新登录；一般失败 ⇒ 查网络/上游。
 * 压成同一句「查询失败」会让用户按错误方向排查。
 * 判据照官方客户端：HTTP 401/403，或响应体 `code` 为 `'401'` / `'NOT_LOGIN'`
 * （实测该形态是 **HTTP 200 + body `{success:false, code:'401', message:'NOT_LOGIN'}`**，
 * 只看 HTTP 状态码会漏判）。
 *
 * ⚠️⚠️ `code` 必须按**标量**归一后再比（{@link readScalarString}）：官方客户端写的是
 * `String(e.code) === '401'`，说明它**可能不是字符串**。若只认字符串，上游某天发
 * `code: 401`（数字）时判据恒不命中 ⇒ 用户看到的是「查询失败」而不是「未登录」——
 * 方向性误诊。失败摘要同理要兼容 `{error:'…'}` 这种不带 `message` 的信封。
 *
 * ## 三类积分桶
 *
 * `data.entitlement` 下的 `daily` / `monthly` / `referral`（笔记 §6）：
 * - **值为 0 的桶保留**（用户要看到「还有 0」）；
 * - **缺席的桶不产出**（不是产出一条 0 —— 那会把「没有这个桶」说成「桶是空的」）。
 *
 * ## 只读、不消耗积分
 *
 * 三个端点**全是只读**（笔记 §6 标题即「积分：没有签到端点」）。本文件
 * **不实现任何签到/领取**：Accio 的每日 200 积分由**登录**触发服务端发放，
 * 没有可调用的签到 API（`provider-registry.ts` 的 `dailyCheckin: false` 是如实登记）。
 *
 * ## 为什么不带 `appKey` / `version` / `utdid` 头
 *
 * 推理端点（`/api/adk/llm/generateContent`）需要 `accioHeaders()` 那套头；
 * 但这三个**只读网关端点**的实测探针只发了 `Accept`（POST 另加 `Content-Type`）
 * 就全部 200。**照实测发**，不把推理端的头「顺手」带过来 —— 未实测的组合是
 * 单向下注（本仓库的既有纪律）。
 */
import type { AccioCredential } from './accio.js';
import type { ProviderBalanceDetail } from './provider-runtime.js';
/** 账号身份（`POST /api/auth/userinfo`，字段与官方 schema 逐字对应）。 */
export interface AccioUserInfo {
    userId: string;
    userName: string;
    /** 服务端按账号下发的区域（实测 `CN`）。⚠️ 与登录时选的区域是**两回事**。 */
    routeRegion: string;
    /** 会员等级（实测 `freeMember`）。 */
    userLevel: string;
    /** 脱敏手机号（实测 `+86 186****6665`）。未绑定手机时上游为 `null`。 */
    maskedMobile: string;
}
/** 一类积分桶（`flattenAccioCredits` 的一行）。 */
export interface AccioCreditRow {
    /** 展示名（`每日积分` / `每月积分` / `推荐积分`）。 */
    label: string;
    total: number;
    used: number;
    remaining: number;
}
/** 配额读数（`GET /api/entitlement/quota`）。 */
export interface AccioQuota {
    /** 已用百分比。 */
    usagePercent?: number;
    /** 距下一次刷新（每日额度重置）的秒数，实测 `86400`。 */
    refreshCountdownSeconds?: number;
}
/** 三个查询函数的公共可选参数。 */
export interface AccioCreditsOptions {
    /** 注入的 fetch（单测替身 / 代理）。省略时用全局 `fetch`。 */
    fetcher?: typeof fetch;
}
/**
 * 把订阅响应的 `data` 拍平成三类桶。
 *
 * @param subscription - `currentSubscription` 响应的 `data`（含 `entitlement`）。
 * @returns 每类**存在**的桶一行；缺席的桶不产出。`daily` 恒在首位。
 */
export declare function flattenAccioCredits(subscription: unknown): AccioCreditRow[];
/**
 * 查询账号身份（`POST /api/auth/userinfo`）。
 *
 * @returns 失败（含未登录 / 结构不对 / 网络错）一律 `undefined` ——
 * 身份是**附加信息**，取不到不该让余额行变成错误。
 */
export declare function fetchAccioUserInfo(credential: AccioCredential, options?: AccioCreditsOptions): Promise<AccioUserInfo | undefined>;
/**
 * 查询配额读数（`GET /api/entitlement/quota`）。
 *
 * ⚠️ `usagePercent` **不**进余额：它是百分比，塞进 `CreditBalance` 就是
 * 「把百分比假装成积分」（本仓库明确反对的形态，见 `credits-format.js` 的
 * `QUOTA_UNIT` 一节）。而订阅响应里的逐桶 `used` / `total` 已经是同一件事的
 * **更精确**读数，故本模块只用 `refreshCountdownSeconds`（见
 * {@link accioQuotaResetIso}），`usagePercent` 保留在返回值里供将来使用。
 */
export declare function fetchAccioQuota(credential: AccioCredential, options?: AccioCreditsOptions): Promise<AccioQuota | undefined>;
/**
 * 聚合三个只读端点，返回**带原因**的余额。
 *
 * ```
 * fetchAccioBalanceDetailed(credential)
 *   ├─ GET  /api/entitlement/currentSubscription?accessToken=…   → 三类桶（**必需**）
 *   ├─ GET  /api/entitlement/quota?accessToken=…                 → 重置倒计时（失败可容忍）
 *   └─ POST /api/auth/userinfo  {accessToken}                    → 账号等级（失败可容忍）
 * ```
 *
 * ⚠️ **`currentSubscription` 必须第一个发**：它是「必需」的那一个，先发可以让
 * 未登录 / 网络故障**短路返回**，不再白发两个注定失败的请求。
 *
 * ⚠️ 三条失败路径都返回 `balance: null` + `error`，**没有一条会退化成 0**：
 * 1. 未登录（HTTP 401/403 或 body `code` 为 `401`/`NOT_LOGIN`）⇒ 提示重新登录；
 * 2. 一般查询失败（网络 / HTTP / 信封 `success:false`）⇒ 带 HTTP 状态与服务端原文
 *    （`message` 缺席时回退读 `error`）；
 * 3. 查询成功但**响应里既没有桶也没有总余额**（形状不认识）⇒ 明说「未包含余额字段」。
 *    ⚠️ 这条判据排在 `quota` / `userinfo` **之前**：形状不认识时那两个请求注定救不回来。
 *
 * 反之，**查到了就是查到了**：桶全为 0 时如实返回 `total: 0`（那才是「额度已用光」），
 * 与上面三条 `null` 严格区分。
 */
export declare function fetchAccioBalanceDetailed(credential: AccioCredential, options?: AccioCreditsOptions): Promise<ProviderBalanceDetail>;
//# sourceMappingURL=accio-credits.d.ts.map