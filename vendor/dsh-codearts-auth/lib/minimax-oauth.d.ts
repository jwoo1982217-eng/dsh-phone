/**
 * MiniMax Code 的 OAuth **设备码 + PKCE** 登录流程。
 *
 * ## 为什么用设备码而不是本地回调
 *
 * 官方桌面端就是这么登的（asar `@mavis/oauth-core`），我们复刻它：
 * 申请设备码 → 用户在浏览器完成授权 → 我们轮询换 token。
 * **不起本地监听端口**（与 Qoder 同型，与 buddy/lobsterai 不同）。
 *
 * ## ⚠️ 最容易踩的坑：`pending` 是 **HTTP 200**
 *
 * OAuth 标准的设备码轮询用 **400 + `error=authorization_pending`** 表示「还在等」，
 * 而 MiniMax 的账号服务用 **200 + `status=pending`**。
 * 只认标准形态会**立刻抛错**，用户来不及授权。
 * 故**两种形态都必须认**（asar `oauth-client.js:70-114` 也是分开处理的）。
 */
import { type MinimaxProduct } from './minimax-product.js';
import { type MinimaxCredential } from './minimax.js';
/** 用户拒绝授权。 */
export declare class MinimaxLoginCancelledError extends Error {
    constructor(message?: string);
}
/** 设备码过期。 */
export declare class MinimaxLoginExpiredError extends Error {
    constructor(message?: string);
}
/** 设备码授权会话。 */
export interface MinimaxDeviceAuthorization {
    deviceCode: string;
    codeVerifier: string;
    userCode: string;
    verificationUri: string;
    /** 含 `user_code` 的完整授权链接（**优先用它**，用户点开即完成）。 */
    verificationUriComplete: string;
    expiresInSec: number;
    /** ⚠️ 单位是**秒**（asar 里有一处 `/1000` 换算，仅用于 `user_code` 轮询分支）。 */
    intervalSec: number;
}
/** 构造设备码请求体（PKCE S256）。 */
export declare function buildMinimaxDeviceCodeBody(codeChallenge: string, product?: MinimaxProduct): URLSearchParams;
/** 构造轮询请求体。 */
export declare function buildMinimaxPollBody(auth: MinimaxDeviceAuthorization, product?: MinimaxProduct): URLSearchParams;
/** 构造续期请求体。 */
export declare function buildMinimaxRefreshBody(refreshToken: string, product?: MinimaxProduct): URLSearchParams;
/** 解析设备码响应；形状不对返回 undefined。 */
export declare function parseMinimaxDeviceAuthorization(payload: unknown): MinimaxDeviceAuthorization | undefined;
/**
 * 解析令牌响应（轮询与续期共用）。
 *
 * 硬校验（照 asar `parseTokenGrant`，不满足即抛）：
 * - `access_token` 非空
 * - `refresh_token` 非空（缺失时回退上一个）
 * - `token_type.toLowerCase() === 'bearer'`
 * - `expires_in` 是正数
 * - **`scope` 必须含产品声明的 scope**（默认 `agent.default`）
 */
export declare function parseMinimaxTokenGrant(payload: unknown, previousRefreshToken?: string, product?: MinimaxProduct): MinimaxCredential;
/** 生成 PKCE code_verifier / code_challenge。 */
export declare function createMinimaxPkce(): {
    codeVerifier: string;
    codeChallenge: string;
};
/** 申请设备码。 */
export declare function startMinimaxDeviceAuthorization(fetcher?: typeof fetch, product?: MinimaxProduct): Promise<MinimaxDeviceAuthorization>;
/** 轮询选项。 */
export interface PollMinimaxOptions {
    fetcher?: typeof fetch;
    /** 可注入的 sleep（测试用）。 */
    sleep?: (ms: number) => Promise<void>;
    /** 可注入的时钟（测试用）。 */
    now?: () => number;
    signal?: AbortSignal;
    product?: MinimaxProduct;
}
/**
 * 轮询直到拿到令牌。
 *
 * ⚠️ **两种「还在等」的形态都要认**（见文件头注释）。
 */
export declare function pollMinimaxDeviceToken(auth: MinimaxDeviceAuthorization, options?: PollMinimaxOptions): Promise<MinimaxCredential>;
/** 续期。 */
export declare function refreshMinimaxCredential(refreshToken: string, fetcher?: typeof fetch, product?: MinimaxProduct): Promise<MinimaxCredential>;
//# sourceMappingURL=minimax-oauth.d.ts.map