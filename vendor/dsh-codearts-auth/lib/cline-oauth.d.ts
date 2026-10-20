/**
 * Cline 登录流程（**WorkOS 设备码轮询**）。
 *
 * ## 与其它 provider 的差异
 *
 * | provider | 登录方式 | 是否需要本地端口 |
 * |---|---|---|
 * | CodeArts / LobsterAI | 本地回调服务器收 code | 是 |
 * | Qoder | PKCE 设备码轮询（`404` = 尚未授权） | 否 |
 * | TRAE | 回调直接回传 token（并存 PKCE 新流程） | 是 |
 * | **Cline** | **WorkOS 设备码轮询**（`authorization_pending` = 尚未授权） | **否** |
 *
 * Cline 官方桌面端在 prod 下走的就是设备码分支
 * （源码 `loginClineOAuth` → `useWorkOSDeviceAuth ?? true`），
 * 与「本地回调 + 端口 48801-48811」那条分支并存。本插件只实现前者：
 * 不起监听端口，也就没有端口占用与回调伪造问题。
 *
 * ## 三步协议（全部实测，2026-09-25）
 *
 * ```
 * 1) POST {workOsBase}/user_management/authorize/device
 *      Content-Type: application/x-www-form-urlencoded
 *      body: client_id=<workOsClientId>
 *   → { device_code, user_code, verification_uri, verification_uri_complete,
 *       expires_in, interval }
 *
 * 2) 轮询 POST {workOsBase}/user_management/authenticate
 *      body: grant_type=urn:ietf:params:oauth:grant-type:device_code
 *            &device_code=<device_code>&client_id=<workOsClientId>
 *   → 200 { access_token, refresh_token, token_type }
 *   → 错误体 { error: "authorization_pending" | "slow_down" | … }
 *
 * 3) POST {apiBase}/api/v1/auth/register
 *      Content-Type: application/json
 *      body: { accessToken, refreshToken }
 *   → { success: true, data: { accessToken, refreshToken, expiresAt,
 *                              tokenType, userInfo: { clineUserId, email, … } } }
 * ```
 *
 * ⚠️ **`authorization_pending` 不是错误**，必须继续轮询 —— 它与 Qoder 的
 * 「404 表示用户尚未完成授权」是同一类语义，但**判据形态完全不同**
 * （Qoder 看 HTTP 状态码，Cline 看响应体的 `error` 字段且状态码可能非 2xx）。
 * 早期若按状态码判失败，会把「用户还没点授权」误报成登录失败。
 *
 * ⚠️ **`slow_down` 必须真的退避**（源码 `intervalSeconds += 1`），
 * 否则会被 WorkOS 持续限流。
 *
 * ## 两步式的必要性
 *
 * 浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内允许
 * `window.open`。若把「拿设备码 → 打开页面 → 等授权」做成一次阻塞调用，
 * 调用方拿到 URL 时手势已过期，弹窗被拦截（返回 null），前端兜底若执行
 * `window.location.href = loginUrl` 会把**整个设置页**导航走（真实缺陷，
 * 已在 CodeArts / LobsterAI / Qoder 三处修过）。
 *
 * 故提供 {@link startClineLoginFlow} 立即返回 URL，由前端先开窗再等结果。
 */
import { type ClineProduct } from './cline-product.js';
/** 在浏览器中打开 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>;
/** 单次 HTTP 请求超时（毫秒；对齐源码 `DEFAULT_HTTP_TIMEOUT_MS`）。 */
export declare const CLINE_HTTP_TIMEOUT_MS = 30000;
/** 设备码默认有效期（毫秒；对齐源码 `DEFAULT_DEVICE_AUTH_EXPIRES_IN_SECONDS = 300`）。 */
export declare const CLINE_DEVICE_AUTH_EXPIRES_MS = 300000;
/** 设备码默认轮询间隔（毫秒；对齐源码 `DEFAULT_DEVICE_AUTH_INTERVAL_SECONDS = 5`）。 */
export declare const CLINE_DEVICE_AUTH_INTERVAL_MS = 5000;
/** 连续网络失败多少次后放弃轮询。 */
export declare const CLINE_POLL_MAX_FAILURES = 5;
/** WorkOS 设备码授权响应（已归一化）。 */
export interface ClineDeviceAuthorization {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    /** 带 `user_code` 的完整 URL（有则优先用它，用户少一步输入）。 */
    verificationUriComplete?: string;
    expiresInMs: number;
    intervalMs: number;
}
/** 一次登录流程的结果。 */
export interface ClineLoginFlowResult {
    /** 已序列化的 `ClineCredential` JSON 字符串（直接存入 ctx.credentials）。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
    /** 设备码流程里的用户码（供 UI 提示「在浏览器里输入 XXXX」）。 */
    userCode?: string;
}
/** {@link startClineLoginFlow} 接受的选项。 */
export interface ClineLoginFlowOptions {
    /** 使用的 fetch 实现；默认为全局 fetch。 */
    fetcher?: typeof fetch;
    /** 打开登录 URL 的方式；默认用平台打开器。 */
    openBrowser?: OpenBrowser;
    /** 登录等待总超时（毫秒）；默认取设备码响应的 `expires_in`。 */
    timeoutMs?: number;
    /** 轮询间隔（毫秒）；默认取设备码响应的 `interval`。 */
    pollIntervalMs?: number;
    /** 外部取消信号。 */
    signal?: AbortSignal;
    /** 产品配置。 */
    product: ClineProduct;
}
/**
 * 请求设备码授权。
 *
 * 实测响应字段：`device_code` / `user_code` / `verification_uri` /
 * `verification_uri_complete` / `expires_in` / `interval`。
 * 缺 `device_code` / `user_code` / `verification_uri` 任一即视为无效响应
 * （源码同样三字段齐备才通过）。
 */
export declare function requestClineDeviceAuthorization(product: ClineProduct, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<ClineDeviceAuthorization>;
/**
 * 轮询直到用户完成授权并拿到 WorkOS token。
 *
 * **`authorization_pending` 表示「用户尚未完成授权」，必须继续轮询**
 * （与 Qoder 的「404 表示尚未授权」同型，但判据是响应体的 `error` 字段）。
 *
 * 状态机（对齐源码 `pollWorkOSTokens`）：
 * - `authorization_pending` → 按 interval 继续；
 * - `slow_down` → interval **+1 秒**后继续（必须真退避）；
 * - `access_denied` / `expired_token` / `invalid_grant` → 终态失败；
 * - 其它非 2xx → 终态失败；
 * - 网络失败容忍 {@link CLINE_POLL_MAX_FAILURES} 次连续失败。
 *
 * ⚠️ **`slow_down` 的退避必须累积**：源码是 `intervalSeconds += 1` 而非重置，
 * 用固定间隔会在服务端要求降速后持续被限流。
 */
export declare function pollClineWorkOsTokens(authorization: ClineDeviceAuthorization, options: ClineLoginFlowOptions): Promise<{
    accessToken: string;
    refreshToken: string;
}>;
/**
 * 用 WorkOS token 换取 Cline 自己的 token（`/api/v1/auth/register`）。
 *
 * ⚠️ 请求体字段是**驼峰** `accessToken` / `refreshToken`。
 * 响应套 `{success, data}` 信封，解析交给 `parseClineTokenPayload`。
 */
export declare function registerClineTokens(workOsTokens: {
    accessToken: string;
    refreshToken: string;
}, options: ClineLoginFlowOptions): Promise<unknown>;
/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedClineLoginFlow {
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 设备码流程的用户码（UI 可提示用户输入）。 */
    userCode?: string;
    /** 用户完成授权（或超时/失败）后落定的结果。 */
    result: Promise<ClineLoginFlowResult>;
    /** 取消登录（中止轮询）；**幂等**。 */
    close: () => Promise<void>;
}
/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * 设备码流程天然是「先拿 URL → 打开 → 后台轮询」，故无需起服务器，
 * 也没有端口可泄漏。`close()` 通过 abort 取消轮询。
 *
 * ⚠️ 设备码授权请求本身是**网络调用**，必须先 await 它拿到 URL 才能返回 ——
 * 但那只是一次快速的 POST，不涉及用户等待，仍能满足「立即返回 URL」
 * 对浏览器手势窗口的要求（与 Qoder 的纯本地 URL 构造略有不同，
 * 故这里把超时压到 {@link CLINE_HTTP_TIMEOUT_MS}）。
 */
export declare function startClineLoginFlow(options: ClineLoginFlowOptions): Promise<StartedClineLoginFlow>;
/**
 * 运行完整登录流程：打开授权页 → 轮询 → 返回凭据。
 *
 * 阻塞语义：等用户完成授权后才返回。需要「立即拿到 URL」的场景
 * （Jet Hub 两步式登录）请用 {@link startClineLoginFlow}。
 */
export declare function runClineLoginFlow(options: ClineLoginFlowOptions): Promise<ClineLoginFlowResult>;
//# sourceMappingURL=cline-oauth.d.ts.map