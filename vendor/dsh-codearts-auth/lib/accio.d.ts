import { type AccioRegion } from './accio-product.js';
/** 凭据结构。 */
export interface AccioCredential {
    /**
     * ⚠️ **必须是这个名字**：`AccountPool.findAccountIdByCredential` 对非 codearts 的
     * provider 一律取 `access_token` 作身份标识。上游是不透明 32 字符串（非 JWT）。
     */
    access_token: string;
    refresh_token: string;
    /**
     * ⚠️ **毫秒**。
     *
     * ⚠️⚠️ 上游 `expiresAt` 是**秒**（官方客户端自己也做 `1e3 *`）。若忘了归一化，
     * `new Date(1794407698)` = **1970 年** ⇒ 判定「早已过期」⇒ 每个请求都触发续期
     * ⇒ 并发下反复消费 `refresh_token` ⇒ `invalid_grant` ⇒ **账号被标死**。
     * 这与 codearts 的「续期单向门」事故同型，且更隐蔽（错的是**时间量纲**）。
     * ⇒ 归一化只在 `accio-oauth.ts` 的兑换/续期返回处做**一次**。
     */
    expires_at: number;
    /** 兑换时下发。⚠️ 实测**不必需**，但保留零成本、删除是单向下注。 */
    sgcookie?: string;
    /** 登录时选的区域 —— 续期与推理要按它选登录域。 */
    region: AccioRegion;
    user_id?: string;
    accio_id?: string;
    nickname?: string;
}
/**
 * 秒→毫秒归一化。**所有**写入 `expires_at` 的地方都必须经过它。
 *
 * @param raw 上游 `expiresAt`（**秒**）或已是毫秒的值。
 * ⚠️ `> 1e12` 视为已是毫秒（防御性：容忍上游某天改单位）。
 */
export declare function accioExpiresAtMs(raw: unknown): number | undefined;
/** 凭据的过期时刻（毫秒）；读不到返回 `undefined`（**不伪装成 0**）。 */
export declare function accioCredentialExpiresAtMs(credential: AccioCredential): number | undefined;
/** 是否已过期。读不到过期时间时视为**未过期**（让适配器按需续期兜底）。 */
export declare function isAccioExpired(credential: AccioCredential): boolean;
/** 是否可续期 —— ⚠️ 只要求 `refresh_token` 非空（不读池里的 `refreshable`）。 */
export declare function isAccioRefreshable(credential: AccioCredential): boolean;
/** 一次请求的 id（也用于 `sg_k` 与 `message_id` 的派生）。 */
export declare function accioRequestId(): string;
/** `sg_k` = md5(requestId) 的 hex。 */
export declare function accioSgK(requestId: string): string;
/**
 * `message_id` —— ⚠️ **必填**，缺它上游回 400（与其它字段无关）。
 *
 * 掺入随机量：同一 `requestId` 连续两次不能相同（上游可能按它去重）。
 */
export declare function accioMessageId(requestId: string): string;
/**
 * camelCase → snake_case（递归），与官方客户端的 `Vn()` 同口径。
 *
 * ⚠️ `undefined` 的键**整个丢掉**：保留会让 JSON 里出现 `null`，
 * 而上游对 `system_instruction: null` 之类的处理与「键不存在」不同。
 */
export declare function accioToSnake(value: unknown): unknown;
/** 一次 LLM 请求的输入。 */
export interface BuildAccioBodyOptions {
    model: string;
    accessToken: string;
    contents: readonly unknown[];
    systemInstruction?: string;
    tools?: readonly unknown[];
    temperature?: number;
    maxOutputTokens?: number;
    utdid: string;
    requestId: string;
}
/**
 * 构造请求体（已 snake_case 化）。
 *
 * ⚠️ 四处硬约束（逐条实测 / 逐字逆向）：
 * 1. `empid` / `tenant` / `iai_tag` **必须空串**（真实值会被拒）；
 * 2. `message_id` **必填**；
 * 3. `token` 必须在 **body**（放 `Authorization` 头恒流内 402）；
 * 4. ⚠️⚠️ **`system_instruction` 是「字符串」，不是 `{parts:[{text}]}` 对象**。
 *    本函数初版照 Gemini 的 `systemInstruction.parts` 形态产出**对象**，
 *    实测**恒回 `HTTP 200` + 流内 `400`**（Task 6 真机验证）。
 *    **权威证据**（官方 proto，`gateway-worker.js`）：
 *    `systemInstruction: gt(e.systemInstruction) ? globalThis.String(e.systemInstruction) : …`
 *    —— 两处都用 `String()` 归一；诊断路径的判据同样是
 *    `typeof t.system_instruction === 'string'`。
 *    ⇒ Accio 与 Gemini 在这一格上**不同形**，别照搬 Gemini。
 */
export declare function buildAccioBody(options: BuildAccioBodyOptions): Record<string, unknown>;
/** 请求头。⚠️ **不带** SecurityGuard 的 `pctb-x-*`（实测不必需）。 */
export declare function accioHeaders(options: {
    utdid: string;
    sgcookie?: string;
}): Record<string, string>;
//# sourceMappingURL=accio.d.ts.map