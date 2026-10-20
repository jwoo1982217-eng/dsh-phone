/**
 * Qoder 协议的类型与纯函数。
 *
 * 全部逻辑都是**可单测的纯计算**（PKCE、URL、凭据形状、续期载荷），
 * 与网络 I/O 分离 —— 这样协议细节能被单测直接覆盖，不需要 mock fetch。
 *
 * 协议依据：`docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2。
 */
import type { QoderProduct } from './qoder-product.js';
/** 单次 HTTP 请求超时（毫秒）。 */
export declare const QODER_REQUEST_TIMEOUT_MS = 30000;
/** 登录等待总超时（毫秒）。源码 `L_a = 3e5`（5 分钟）。 */
export declare const QODER_LOGIN_TIMEOUT_MS = 300000;
/** 轮询间隔（毫秒）。源码 `Djr = 1e3`。 */
export declare const QODER_POLL_INTERVAL_MS = 1000;
/** 轮询连续网络失败上限。源码 `H_a = 3`；本实现放宽到 5 以容忍抖动。 */
export declare const QODER_POLL_MAX_FAILURES = 5;
/** 授权页路径（挂 `authBase`）。 */
export declare const QODER_DEVICE_SELECT_PATH = "/device/selectAccounts";
/** 轮询取 token 路径（挂 `openApiBase`）。 */
export declare const QODER_POLL_PATH = "/api/v1/deviceToken/poll";
/** 续期路径（挂 `openApiBase`）。 */
export declare const QODER_REFRESH_PATH = "/api/v1/deviceToken/refresh";
/** 用户信息路径（挂 `openApiBase`）。 */
export declare const QODER_USERINFO_PATH = "/api/v1/userinfo";
/** 推理路径（挂 `inferBase`）。 */
export declare const QODER_CHAT_PATH = "/model/v1/chat/completions";
/** 一次 PKCE 生成的结果。 */
export interface QoderPkce {
    /** 明文 verifier（轮询时提交）。 */
    verifier: string;
    /** `base64url(sha256(verifier))`，**无 padding**。 */
    challenge: string;
}
/**
 * 生成 PKCE verifier / challenge。
 *
 * verifier 长度取 43..128（源码 `43 + floor(86*random)`），
 * challenge 用 `base64url(sha256(verifier))` 且**去掉 padding**
 * —— 带 `=` 会让服务端校验失败。
 */
export declare function createQoderPkce(): QoderPkce;
/**
 * 一次设备登录会话。
 *
 * `machineId` 由**本插件生成并随凭据持久化**，不是硬件指纹。
 *
 * 为什么不复制 Qoder 的硬件指纹逻辑：它依赖 `@napi-rs` 原生模块取
 * SMBIOS UUID 再 `sha256("{salt}:{platform}:{uuid}")`，属设备指纹且不可移植。
 * 本插件改为随机 UUID 并持久化，续期时原样回传。风险见设计文档 §8。
 */
export interface QoderDeviceSession {
    pkce: QoderPkce;
    /** 一次性随机串（UUID）。 */
    nonce: string;
    /** 设备标识（本插件生成的随机 UUID，需持久化）。 */
    machineId: string;
}
/** 生成一次性设备登录会话。 */
export declare function createQoderDeviceSession(machineId?: string): QoderDeviceSession;
/**
 * 构造浏览器授权 URL。
 *
 * 形态（源码 `startDeviceFlow`）：
 * `{authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`
 *
 * ⚠️ `client_id` 必须用 **`product.clientId`（= 源码 `J_a`，prod 用）**。
 * 源码是 `client_id: i ? J_a : G_a`，而调用点传的第 4 参 `i` 是
 * `isProd()` —— prod 为 `true`，故 **prod 用 `J_a`**。
 * 用成 `G_a`（非 prod 的）会让服务端在授权回调阶段拒绝，
 * 页面报「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」（真实缺陷）。
 */
export declare function buildQoderAuthUrl(session: QoderDeviceSession, product: QoderProduct): string;
/**
 * 构造轮询 URL。
 *
 * ⚠️ 挂 **`openApiBase`**（`openapi.qoder.sh`），不是 `authBase`。
 * 实测：`qoder.com` 的该路径返回 401，而 `openapi.qoder.sh` 返回 404
 * （= 无待授权会话，应继续轮询）。写错 host 会让登录永远失败。
 */
export declare function buildQoderPollUrl(session: QoderDeviceSession, product: QoderProduct): string;
/**
 * 凭据。
 *
 * `security_oauth_token` 与 `access_token` **双写同值**：Qoder 的取用顺序是
 * `security_oauth_token ?? access_token`（源码 `a6e()`），双写可兼容两种路径。
 *
 * `machine_id` **必须持久化**：续期请求体需要它，且它参与服务端的设备绑定。
 */
export interface QoderCredential {
    security_oauth_token: string;
    access_token: string;
    refresh_token?: string;
    /** 访问令牌过期时间（毫秒时间戳）。 */
    expire_time?: number;
    /** refresh_token 过期时间（毫秒时间戳）。 */
    refresh_token_expire_time?: number;
    /** 本插件生成并持久化的设备标识。 */
    machine_id: string;
    /**
     * 用户 id（设备码响应里的 `user_id`）。
     *
     * ⚠️ **加密推理必需**：`generate_runtime_auth_fields` 用它派生
     * `encrypt_user_info`；缺了它会挂起或失败（实测）。
     * 源码 `buildUserInfoFromDeviceToken` 读的就是 `A.user_id`。
     */
    uid?: string;
    /** 展示用昵称（设备码响应的 `user_name`，或后续 userinfo）。 */
    nickname?: string;
}
/** 从 token 响应解析出的规范化载荷。 */
export interface QoderTokenPayload {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshTokenExpiresAt?: number;
    /** 用户 id（`user_id`）。加密推理需要。 */
    uid?: string;
    /** 用户名（`user_name`）。 */
    userName?: string;
}
/**
 * 解析 token 响应。
 *
 * 登录响应用 `token`，续期响应用 `device_token` —— 两者字段名不同，
 * 故都接受。垃圾输入返回空 `accessToken`（而非抛错），由调用方判定失败。
 */
export declare function parseQoderTokenPayload(value: unknown): QoderTokenPayload;
/** 构造凭据。 */
export declare function buildQoderCredential(payload: QoderTokenPayload, extra: {
    machineId: string;
    nickname?: string;
}): QoderCredential;
/** 凭据的访问令牌过期时间（毫秒）；未知时 undefined。 */
export declare function qoderCredentialExpiresAtMs(credential: QoderCredential): number | undefined;
/**
 * 是否可静默续期。
 *
 * 判据是「有 refresh_token」，与过期与否无关 —— 未过期但无 refresh_token
 * 的凭据同样无法续期。
 */
export declare function isQoderRefreshable(credential: QoderCredential): boolean;
/** 访问令牌是否已过期。无过期时间时保守视为未过期（交给服务端 401 判定）。 */
export declare function isQoderExpired(credential: QoderCredential, nowMs?: number): boolean;
/**
 * 续期请求体。
 *
 * 源码的 `getMachineIdentityRequestFields` 会在两个字段都存在时才带上，
 * 且 `machine_token` 来自 UMID 子系统（本插件没有）—— 故只发
 * `refresh_token` 与 `machine_id`。
 */
export declare function qoderRefreshBody(credential: QoderCredential): Record<string, string>;
/** 取 Bearer 令牌（`security_oauth_token` 优先，与源码一致）。 */
export declare function qoderBearerToken(credential: QoderCredential): string;
/** 推理请求头。 */
export declare function qoderChatHeaders(credential: QoderCredential, product: QoderProduct, requestId: string, sessionId: string): Record<string, string>;
/**
 * 用续期结果覆盖旧凭据。
 *
 * **保留** `machine_id` / `uid` / `nickname`：它们不在续期响应里，
 * 丢失会让下一次续期缺少设备标识、或让加密推理缺少 uid。
 */
export declare function applyQoderRefresh(credential: QoderCredential, payload: QoderTokenPayload): QoderCredential;
/**
 * 取用户的展示名（`GET /api/v1/userinfo` 的 `name`）。
 *
 * ## 为什么需要它（真实缺陷，用户报障 2026-09-26）
 *
 * > 另外授权登录后的名字都是 `qoder-xxxx`，无法识别是哪个号，
 * > 应该显示授权的名字
 *
 * 根因：**设备码轮询响应里没有 `user_name`**。`parseQoderTokenPayload` 会读
 * `user_name` / `userName`，`buildQoderCredential` 也会回退到它 —— 但两者都
 * 拿不到值，于是凭据永不带 `nickname`，Jet Hub 便退回显示账号 id
 * （`qoder-c2472fa6` 这类），多账号时无法区分。
 *
 * 实测（2026-09-26）：4 个账号的凭据 `nickname` **全部缺失**，而 userinfo
 * 稳定给出真实名字：
 *
 * | 账号 id | 凭据 nickname | userinfo `name` |
 * |---|---|---|

 *
 * 故**登录成功后必须补一次 userinfo** 才能拿到名字（这是唯一可靠来源）。
 *
 * ⚠️ 失败时返回 `undefined` 而**不抛错**：昵称只是展示信息，拿不到不应让
 * 登录整体失败（与 `toLoginFlowResult` 对过期时间的处理同原则）。
 * 调用方应退回账号 id。
 *
 * @param fetcher 可注入（单测用）
 */
export declare function fetchQoderUserNickname(credential: QoderCredential, product: QoderProduct, fetcher?: typeof fetch): Promise<string | undefined>;
/**
 * 把昵称写进凭据（返回新对象，不改原凭据）。
 *
 * 昵称**写回凭据**而不只写账号条目：账号条目会随 Jet Hub 的账号操作整体
 * 重写，而凭据里存一份才能在续期后（`applyQoderRefresh` 会保留它）
 * 与其它面板（积分、模型）都稳定拿到。
 *
 * 空串与 undefined 均视为「没有昵称」，此时原样返回（不写入空字段）。
 */
export declare function withQoderNickname(credential: QoderCredential, nickname: string | undefined): QoderCredential;
//# sourceMappingURL=qoder.d.ts.map