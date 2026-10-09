/**
 * Gemini (Cloud Code) 的 Google OAuth 授权流程。
 *
 * 骨架照 `src/login.ts` 的 `startOAuthFlow`（两步式：先监听、**立即**返回
 * `loginUrl`，调用方自己去 await `result`），但**刻意去掉**了 CodeArts 那套
 * PKCE / DPoP / 自定义 ticket —— 上游 Cloud Code 客户端用的是最朴素的
 * authorization_code + client_secret。
 *
 * ## ⚠️ 三条上游硬约束（原版 oauth.go 实测踩过）
 *
 * 1. **token 端点强制校验客户端身份**：只发 `client_id` 会回
 *    `invalid_request: client_secret is missing`，症状是「浏览器显示授权成功，
 *    但面板里账号一直不出现」。所以 `exchange` / `refresh` 的表单**必须**带
 *    `client_secret`。
 * 2. **必须「先监听、再拼 URL」**：端口被占时会回退到别的端口，若先拼 URL
 *    就会 `redirect_uri_mismatch`。
 * 3. **`state` 必须校验**：回调里 `state` 不匹配一律 400 拒绝（防伪造回调）。
 *
 * ## 回调地址
 *
 * `http://localhost:<port>/oauth-callback` —— Google 对原生应用的 loopback
 * 重定向（RFC 8252）允许**任意端口**，所以动态端口是合法的。
 * 同时监听 `127.0.0.1` 与 `[::1]`：浏览器常把 `localhost` 解析成 IPv6。
 */
import type { GeminiCredential } from './gemini.js';
export declare const GEMINI_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export declare const GEMINI_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export declare const GEMINI_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
export declare const GEMINI_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
/** 上游 Cloud Code 客户端的公开 client（env 可覆盖，用于自建凭据的场景）。 */
export declare const GEMINI_DEFAULT_CLIENT_ID = "";
export declare const GEMINI_DEFAULT_CLIENT_SECRET = "";
/** 回调路径（与 client 注册值逐字一致，改了就 redirect_uri_mismatch）。 */
export declare const GEMINI_CALLBACK_PATH = "/oauth-callback";
/** 端口被占用时的兜底端口；默认走动态端口（0），与原版一致。 */
export declare const GEMINI_DEFAULT_CALLBACK_PORT = 8845;
/**
 * 授权流程总预算。
 *
 * ⚠️ 用 **6 分钟**而不是照 `login.ts` 的 180 秒：原版 `oauth.go` 的
 * `authFlowTimeout` 就是 6 分钟 —— Google 账号常带二次验证，3 分钟会把
 * 正常用户掐掉（面板亮「授权失败」，其实人家只是慢）。
 */
export declare const GEMINI_AUTH_FLOW_TIMEOUT_MS = 360000;
/** 六项 scope 逐字照抄（`cloud-platform` 必需，后两项是 Cloud Code 自己的通道）。 */
export declare const GEMINI_SCOPES: readonly string[];
/** 用户在浏览器里点了「取消」/拒绝授权。 */
export declare class GeminiLoginCancelledError extends Error {
    constructor(message?: string);
}
/** 授权窗口超时（没人来点）。 */
export declare class GeminiLoginExpiredError extends Error {
    constructor(message?: string);
}
/** 生效的 client id（env 优先）。 */
export declare function geminiClientId(): string;
/** 生效的 client secret（env 优先）。 */
export declare function geminiClientSecret(): string;
/** 一次授权流程的固定参数。 */
export interface GeminiAuthFlow {
    state: string;
    redirectUri: string;
}
/** 构造授权 URL（参数顺序无关紧要，Google 不校验）。 */
export declare function buildGeminiAuthUrl(flow: GeminiAuthFlow): string;
/** 一次令牌端点响应的解析结果。 */
export interface GeminiTokenGrant {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope?: string;
    /**
     * OIDC `id_token`。授权 URL 带 `openid` scope，故令牌端点**必然**返回它 ——
     * 身份从这里解，不再依赖 userinfo 那次可静默失败的跨域请求。
     */
    id_token?: string;
}
/**
 * 账号身份。
 *
 * `sub` 是 OIDC 的稳定标识（邮箱可改、`sub` 不变）；`email` 只用于展示。
 */
export interface GeminiUserInfo {
    sub?: string;
    email?: string;
}
/**
 * 解析令牌端点的 JSON。
 *
 * 三种失败形态都要给**能定位问题**的文案（原版口径）：
 * 解析不了 / `error` 字段 / 缺 `access_token`。
 */
export declare function parseGeminiTokenGrant(payload: unknown, previousRefreshToken?: string): GeminiTokenGrant;
/**
 * 从 `id_token` 解出身份（`sub` / `email`）。
 *
 * ⚠️ **不验签**：该值只用于展示名与稳定标识，不作为鉴权依据（与
 * `src/buddy.ts` 的 `jwtExpiresAtMs` 同口径）；令牌端点的响应本身已由 TLS 保护。
 * 任何解析失败返回 `{}` 而不抛错 —— 身份不该让授权失败。
 */
export declare function geminiIdentityFromIdToken(idToken: string): GeminiUserInfo;
/** 由 `expires_in`（秒）算出 RFC3339 过期时刻。 */
export declare function geminiExpiryFrom(expiresIn: number, nowMs?: number): string;
/** 把令牌授予结果并成一条凭据（保留已有的 sub/email/project）。 */
export declare function credentialFromGeminiGrant(grant: GeminiTokenGrant, previous?: Partial<GeminiCredential>, nowMs?: number): GeminiCredential;
/** 用授权码换令牌（**必须**带 client_secret，见文件头第 1 条）。 */
export declare function exchangeGeminiCode(code: string, redirectUri: string, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<GeminiTokenGrant>;
/**
 * 用 refresh_token 续期。
 *
 * ⚠️ Google **偶尔会轮换 refresh_token**：响应里给了新的就必须回写，
 * 否则下一次续期用的是已作废的旧值（表现为「昨天还好好的，今天突然要重新登录」）。
 */
export declare function refreshGeminiCredential(refreshToken: string, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<GeminiTokenGrant>;
/**
 * 拉账号身份（`id_token` 缺席时的**兜底**）。
 *
 * ⚠️ 用 `id`（= `sub`）当账号主键：邮箱用户可以随时改，`sub` 不会变。
 * 失败**不抛错**（身份只是展示信息，不该让整个授权失败），但会通过
 * `onFailure` 上报原因 —— 2026-10-03 用户报障「昵称退化成池 id」时这里
 * 静默吞掉了一切异常，导致无从排查。
 */
export declare function fetchGeminiUserInfo(accessToken: string, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    /** 失败原因上报口（默认静默，仅供诊断日志）。 */
    onFailure?: (reason: string) => void;
}): Promise<GeminiUserInfo>;
/** 撤销令牌（退出登录时调用）。失败只记日志，不上抛。 */
export declare function revokeGeminiToken(token: string, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<void>;
/** 已启动但尚未完成的授权流程。 */
export interface StartedGeminiLoginFlow {
    /** 展示给用户的授权 URL。 */
    loginUrl: string;
    /** 用户完成授权后落定的凭据。 */
    result: Promise<GeminiCredential>;
    /** 关闭回调服务器；**幂等**。 */
    close: () => Promise<void>;
}
/** `startGeminiOAuthFlow` 的选项。 */
export interface GeminiOAuthOptions {
    /** 自定义 fetch（单测注入）。 */
    fetcher?: typeof fetch;
    /** 固定回调端口；默认 0 = 动态。 */
    callbackPort?: number;
    /** 授权总预算，默认 {@link GEMINI_AUTH_FLOW_TIMEOUT_MS}。 */
    timeoutMs?: number;
    /**
     * 身份兜底（userinfo）失败时的上报口。
     *
     * ⚠️ 这是 2026-10-03 报障的直接教训：`fetchGeminiUserInfo` 曾把一切异常
     * 静默吞成 `{}`，于是「昵称退化成池 id」在现场**零日志可查**。
     */
    onIdentityFailure?: (reason: string) => void;
}
/**
 * 启动授权流程并**立即返回** `loginUrl`。
 *
 * 两步式的原因与 CodeArts 那边一样：浏览器只在用户点击后的短暂窗口内允许
 * `window.open`，阻塞式流程会让调用方拿到 URL 时手势已过期。
 */
export declare function startGeminiOAuthFlow(options?: GeminiOAuthOptions): Promise<StartedGeminiLoginFlow>;
//# sourceMappingURL=gemini-oauth.d.ts.map