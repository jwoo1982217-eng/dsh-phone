/**
 * Raccoon Work 登录与续期的纯 API 层。
 *
 * ## 两条登录路径
 *
 * 1. **微信扫码**（首选）：`code` 由**客户端本地随机生成**，服务端只做轮询查询。
 *    实测任意自造 code 都被接受并进入 `pending`，故完全绕开官方那条
 *    `office-raccoon://auth/callback` 自定义协议回调 —— 那是本插件（宿主侧
 *    Node 进程）无法接收的。
 * 2. **短信验证码**（次选）：手机号需 AES-128-CFB 加密，且 `send_sms` 要求
 *    先过阿里云滑块拿到 `captcha_param`。
 *
 * ## 为什么不用官方桌面端的授权码链路
 *
 * `desktopLogin.js` 走「网页授权 → `office-raccoon://auth/callback?code=` →
 * `POST /login_with_authorization_code`」。回调地址在网页里是**写死的**，
 * 改不成 localhost，插件收不到回调。故该链路只保留 `exchangeRaccoonAuthorizationCode`
 * 供将来（如支持自定义协议的环境）复用。
 *
 * ## 本模块是纯 API 层
 *
 * 不含本地 HTTP 服务器（那是 `raccoon-login-page.ts` 的职责），
 * 也不做凭据持久化（那是 `raccoon-auth.ts` 的职责）。全部函数可离线单测。
 */
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
/** 扫码轮询的状态值。 */
export type RaccoonQrStatus = 'pending' | 'logging' | 'canceled' | 'success';
/** 一次扫码轮询的结果。 */
export interface RaccoonQrPollResult {
    status: RaccoonQrStatus;
    /** 仅 `success` 时存在。 */
    accessToken?: string;
    /** 仅 `success` 时存在。 */
    refreshToken?: string;
    /** 仅 `success` 时存在（毫秒时间戳字符串）。 */
    expiresAt?: string;
    /** 仅 `logging` 时存在（二维码有效期）。 */
    expiredAt?: string;
}
/**
 * 生成一个扫码用的 `qrcode_code`（32 位小写 hex = 16 字节随机）。
 *
 * 依据客户端：`CryptoJS.lib.WordArray.random(16)`（渲染层模块 68284 的 `yl()`）。
 */
export declare function generateQrCode(): string;
/**
 * 构造二维码承载的微信登录页 URL。
 *
 * 依据客户端：`` `${base}/login/mp?code=${code}&appname=商汤小浣熊官网` ``。
 * 这是一个**公开页面**，扫码后在微信内完成授权，服务端据此把该 code 置为
 * `success`，我们轮询 `login_with_qrcode_code` 取回 token。
 */
export declare function buildQrImageUrl(product: RaccoonProduct, code: string): string;
/**
 * 轮询一次扫码登录状态。
 *
 * ⚠️ **任何异常都降级为 `pending`**（网络抖动、响应畸形、未知 status）：
 * 轮询是 2 秒一次的循环，偶发失败不应中断整个登录流程；而把未知状态
 * 误判成 `success` 会让流程拿到空 token 后卡死，误判成 `canceled` 则会让
 * 用户正在扫码的二维码被无故刷新。
 */
export declare function pollRaccoonQrLogin(product: RaccoonProduct, code: string, fetcher?: typeof fetch): Promise<RaccoonQrPollResult>;
/**
 * 下发短信验证码。
 *
 * ⚠️ 手机号必须 AES-128-CFB 加密（否则 `100003 params_encryted_error`）。
 * ⚠️ `captcha_param` 是阿里云滑块验证码的产物，**必需**（否则
 * `100006 captcha_verify_error`）。
 */
export declare function sendRaccoonSmsCode(product: RaccoonProduct, phone: string, captchaParam: string, fetcher?: typeof fetch): Promise<void>;
/**
 * 用短信验证码登录。
 *
 * @returns 完整凭据（`expires_at` 由 JWT 的 exp 推算）。
 * @throws 验证码错误/过期、手机号非法、网络失败。
 */
export declare function loginRaccoonWithSmsCode(product: RaccoonProduct, phone: string, smsCode: string, fetcher?: typeof fetch): Promise<RaccoonCredential>;
/**
 * 用授权码换取凭据（官方桌面端链路）。
 *
 * 本插件**当前不走这条路**（收不到自定义协议回调），保留它是为了让
 * 「官方链路」有可单测的落点，并在将来支持自定义协议时可直接复用。
 */
export declare function exchangeRaccoonAuthorizationCode(product: RaccoonProduct, authorizationCode: string, fetcher?: typeof fetch): Promise<RaccoonCredential>;
/**
 * 用 refresh_token 换新凭据。
 *
 * ⚠️ 服务端可能**只返回新的 access_token**（不带新 refresh_token），
 * 此时必须**保留旧值** —— 否则续期一次就把账号变成不可续期。
 * ⚠️ 服务端不返回的附加字段（昵称、身份、设备号）也要保留。
 * ⚠️ 401 表示 refresh_token 已失效，**抛「请重新登录」且不重试**。
 */
export declare function refreshRaccoonCredential(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<RaccoonCredential>;
/**
 * 拉取用户信息（展示用）。
 *
 * ⚠️ 失败时返回**空对象**而不是抛错：用户信息只用于昵称展示，
 * 不该因为它失败而让整个登录流程失败（登录已经成功了）。
 *
 * ⚠️ `nickname` 取的是远端的 `name`，而**它是服务端自动生成的默认名**
 *（实测 `RaccoonAva`），微信扫码不回传微信昵称 —— 故多账号消歧要靠 `phone`。
 */
export declare function fetchRaccoonUserInfo(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<{
    userId?: string;
    nickname?: string;
    officeIdentity?: string;
    phone?: string;
}>;
//# sourceMappingURL=raccoon-oauth.d.ts.map