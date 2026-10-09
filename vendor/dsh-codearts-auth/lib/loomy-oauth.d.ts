/**
 * Loomy 短信验证码登录。
 *
 * ## 为什么与其余 7 个 provider 不同
 *
 * 那 7 个都是「返回 loginUrl → 前端 window.open → 轮询 login.poll」。
 * 短信登录**没有 URL 可打开**，故走「发验证码 → 用户输入 → 提交」三步，
 * 由 Jet Hub 渲染表单（见 `loginMode: 'sms'` 契约）。
 *
 * ## 端点与请求体
 *
 * ```
 * POST {accountBase}/login/phone/sendMsgCode   { base, param:{ ccode, phone, expire:300 } }
 * POST {accountBase}/login/phone/checkCode     { base, param:{ ccode, phone, mcode, msgid, expire:1209600 } }
 * ```
 *
 * ⚠️ 认证是 **HMAC-SHA1 签名**（`Authorization: account {ak}:{sig}`），
 * 不是 Bearer。见 `loomy-sign.ts`。
 * ⚠️ body 必须**先序列化成字符串**，签名与发送共用同一个字符串 ——
 * 二次序列化会改变字节（键序/空格）导致签名失效。
 * ⚠️ `ua` 硬编码 `Loomy|Desktop|Electron|macOS`，Windows 上也是这个值。
 */
import type { LoomyProduct } from './loomy-product.js';
/** 短信验证码有效期（秒）。 */
export declare const LOOMY_SMS_CODE_TTL_SECONDS = 300;
/**
 * 登录会话有效期（秒）= 14 天。
 *
 * 依据 `account-service.js:391` 的 `expire: 14 * 24 * 3600`。
 * ⚠️ 这只是向服务端**声明**的有效期，响应里不带到期时间戳，
 * 故凭据的 `expires_at` 由本地按此推算。
 */
export declare const LOOMY_SESSION_TTL_SECONDS = 1209600;
/** 一次成功登录的结果。 */
export interface LoomyLoginResult {
    /** 32 位小写 hex 的讯飞 session。 */
    session: string;
    /** 讯飞用户 id。 */
    userid: string;
}
/**
 * 构建账号端点的请求体信封 `{ base, param }`。
 *
 * 依据 `account-service.js:441-450`。`traceid` 每次调用重新生成
 * （去掉连字符的 uuid，32 位 hex）。
 */
export declare function buildLoomyAccountBody(product: LoomyProduct, param: Record<string, unknown>): Record<string, unknown>;
/**
 * 下发短信验证码。
 *
 * @returns `msgid` —— 提交验证码时必须原样带回。
 * @throws 手机号格式错误、频率限制、网络失败等（消息含服务端 `desc`）。
 */
export declare function sendLoomySmsCode(phone: string, product: LoomyProduct, fetcher?: typeof fetch): Promise<string>;
/**
 * 用短信验证码登录。
 *
 * @returns `{ session, userid }`。
 * @throws 验证码错误/过期、缺少字段、网络失败。
 */
export declare function loginLoomyBySmsCode(phone: string, code: string, msgid: string, product: LoomyProduct, fetcher?: typeof fetch): Promise<LoomyLoginResult>;
/** 微信授权的中间上下文（第 1 步返回）。 */
export interface LoomyWechatBindAuth {
    /** 1 = 讯飞侧已绑手机号（可直接 bindSkip）；0 = 需绑定手机号。 */
    bind: 0 | 1;
    /** 后续三步都要用的会话标识。 */
    rcode: string;
    /** 是否新注册用户（仅展示用）。 */
    isnew?: number;
    /** 微信昵称（仅展示用）。 */
    nickname?: string;
    /** 微信头像（仅展示用）。 */
    headpic?: string;
}
/**
 * 第 1 步：用微信 code 换 rcode，并得知是否已绑手机号。
 *
 * @throws 缺少 rcode、微信 code 无效、网络失败。
 */
export declare function bindLoomyThirdAccount(code: string, product: LoomyProduct, fetcher?: typeof fetch): Promise<LoomyWechatBindAuth>;
/**
 * 第 2 步：向待绑定的手机号下发验证码。
 *
 * @returns `msgid` —— 第 3 步必须原样带回。
 */
export declare function bindLoomySendMsg(rcode: string, phone: string, product: LoomyProduct, fetcher?: typeof fetch): Promise<string>;
/**
 * 第 3 步：验证短信验证码，通过即完成绑定 + 登录。
 *
 * @returns `{ session, userid, phone }`。
 */
export declare function bindLoomyCheckCode(rcode: string, mcode: string, msgid: string, product: LoomyProduct, fetcher?: typeof fetch): Promise<LoomyLoginResult & {
    phone: string;
}>;
/**
 * 第 4 步（`bind === 1` 时走）：跳过绑定，直接换 session。
 *
 * 业务侧仅在 `bind === 1`（微信已绑过手机号）时调用 —— 让讯飞跳过
 * 「重新绑手机」步骤直接下发 session。
 */
export declare function bindLoomySkip(rcode: string, product: LoomyProduct, fetcher?: typeof fetch): Promise<LoomyLoginResult>;
//# sourceMappingURL=loomy-oauth.d.ts.map