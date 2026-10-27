import type { AstudioProduct } from './astudio-product.js';
import { type AstudioCredential, type AstudioSessionFile } from './astudio.js';
import { type AstudioRefreshOutcome } from './astudio-auth.js';
/** 凭据库未接线时的默认 ref 名（与 `ASTUDIO.defaultCredentialRef` 同值）。 */
export declare const ASTUDIO_DEFAULT_CREDENTIAL_REF = "ASTUDIO_ACCESS_TOKEN";
/** 会话失效（HTTP 200 + code=80000）时唯一允许透出给用户的终态文案。 */
export declare const ASTUDIO_MANUAL_RELOGIN_HINT = "AStudio \u4F1A\u8BDD\u5DF2\u5931\u6548\uFF08\u4E0A\u6E38\u6052\u4E3A HTTP 200 + code=80000\u300C\u767B\u5F55\u5F02\u5E38\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u300D\uFF09\u3002\u672C\u5BA2\u6237\u7AEF\u6CA1\u6709\u7A0B\u5E8F\u5316\u7EED\u671F\u63A5\u53E3\uFF0C\u8BF7\u5728 AStudio \u684C\u9762\u7AEF\u91CD\u65B0\u5FAE\u4FE1\u626B\u7801\u767B\u5F55\u540E\u518D\u8BD5\uFF1B\u63D2\u4EF6\u4FA7\u4E0D\u4F1A\u5FAA\u73AF\u91CD\u8BD5\u3002";
/** 读不到本机会话时的文案（同样归终态：只能人工登录，无法自动补）。 */
export declare const ASTUDIO_NO_LOCAL_SESSION_MESSAGE = "\u672A\u627E\u5230\u672C\u673A AStudio \u4F1A\u8BDD\uFF08userdata\\astron-session.json \u7F3A\u5931\uFF0C\u6216\u5176\u4E2D\u6CA1\u6709 modelBearerToken\uFF09\u3002\u8BF7\u5148\u5728 AStudio \u5BA2\u6237\u7AEF\u767B\u5F55\uFF1B\u5982\u9700\u6307\u5411\u522B\u5904\u7684\u4F1A\u8BDD\u6587\u4EF6\uFF0C\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DSH_ASTUDIO_SESSION_FILE\u3002";
/** 有效性副标题：如实说明「长期有效」的依据，并明确不给倒计时。 */
export declare const ASTUDIO_SESSION_LIFETIME_NOTE = "\u957F\u671F\u6709\u6548\uFF1A\u670D\u52A1\u7AEF ssoSessionId \u7684 Max-Age=31536000\uFF08\u4E00\u5E74\u4E14\u4E0D\u6ED1\u52A8\uFF09\uFF0C\u78C1\u76D8\u4F1A\u8BDD\u6587\u4EF6\u65E0 TTL \u5B57\u6BB5\uFF0C\u6545\u4E0D\u663E\u793A\u5230\u671F\u5012\u8BA1\u65F6\u3002";
/**
 * 会话态展示状态。
 *
 * ⚠️ 刻意**没有** `expiring` 这一档：磁盘无 TTL 可预判，加上去只能靠编造判据
 * （`loggedInAt + 2h` 之类），而那是实测被否掉的臆造。
 */
export type AstudioSessionDisplayState = 'active' | 'needs_manual_relogin' | 'no_local_session';
/** 一行会话态视图；字段全是**已掩码/可安全展示**的字符串，不含明文凭据。 */
export interface AstudioSessionView {
    readonly provider: 'astudio';
    readonly state: AstudioSessionDisplayState;
    /** 掩码后的账号展示名（手机号只露末 2 位；真实昵称原样）。 */
    readonly account: string;
    readonly accountId: string;
    readonly uid: string;
    /** 实测为 `wechat`。 */
    readonly loginMethod: string;
    /** `'session-file'` | `'account-backend'`。 */
    readonly source: string;
    /** 磁盘 `banned` 字段（⚠️ astudio.ts 从不消费它，这里只做如实展示）。 */
    readonly banned: boolean;
    /** 恒 `undefined`：见文件头第 1 条，**不得**用于倒计时。 */
    readonly expiresAtMs?: number;
    /** 登录时刻原值（诊断用；不参与到期判定）。 */
    readonly loggedInAt: string;
    /** 可直接展示的一行状态。 */
    readonly statusLine: string;
    /** 需要人工介入时的一句话说明。 */
    readonly hint?: string;
}
/**
 * 磁盘 `banned` 的形态不固定（`AstudioSessionFile.banned?: boolean | string`），
 * 统一收敛成布尔。读不到会话文件时一律 `false` —— **不臆造**「被封」这种重结论。
 */
export declare function astudioBannedFromSessionFile(session: AstudioSessionFile | undefined): boolean;
/**
 * 任意展示串的手机号掩码。
 *
 * 复用 {@link maskLobsteraiPhoneTail}：只对「像手机号」的输入生效（11 位纯数字且 1 开头，
 * 或 `3 位数字 + 星号 + 数字` 的服务端已脱敏形态），真实昵称原样返回，且幂等。
 * 账号 id / uid 也可能是手机号形态，所以本层对它们同样过一次（已是掩码串的输入不受影响）。
 */
export declare function maskAstudioAccountLabel(value: string): string;
/**
 * 会话态的纯映射：给一份凭据（或 `undefined`）出一行视图，**零网络、零写入**。
 *
 * 展示名走 {@link astudioAccountNickname} → `astudioDisplayNickname` →
 * `maskLobsteraiPhoneTail` 这条**既有**链路（只露末 2 位），本层不再算第二遍。
 */
export declare function astudioSessionViewFromCredential(credential: AstudioCredential | undefined, options?: {
    fallbackLabel?: string;
    banned?: boolean;
}): AstudioSessionView;
/**
 * 一次凭据/异常是否属于「只能人工重新登录」的终态（两条判据各覆盖一半）。
 *
 * {@link isAstudioTerminalRefreshError} 按 `error.name === 'RefreshTokenExpiredError'`
 * 判（**不是 instanceof**）并自带文案兜底；{@link isAstudioSessionDeadError} 命中
 * `ASTUDIO_SESSION_DEAD_CODES`（含 80000）。
 * ⚠️ 网络抖动 / 5xx / 未知业务码**都不是**终态 —— 把它们固化成「账号已死」是本仓库
 * 明令禁止的「单向门」事故形态。
 */
export declare function astudioSessionDeadFromError(error: unknown): boolean;
/** 异常 → 会话态视图：终态归 `needs_manual_relogin`，非终态保留原视图不谎报。 */
export declare function astudioSessionViewFromError(error: unknown, fallback?: AstudioSessionView): AstudioSessionView;
/**
 * 刷新结果 → 会话态视图（**四态分格**，不压成布尔）。
 *
 * 三格必须分开，混成一格会让 UI 谎报：
 * - `terminal === true` ⇒ 人工重登（含 code=80000 那族）：再多的定时刷新也不会成功；
 * - `fetched !== true` ⇒ 本轮压根没发远端请求（如 Cookie 拼不出）⇒ 属「未刷新」而非失败；
 * - `changed !== true` ⇒ 值没变（实测本家不轮换）⇒ 如实报「重试无意义」，
 *   **绝不能**显示成「刷新成功」；
 * - 其余 ⇒ 凭据真的更新了。
 */
export declare function astudioSessionViewFromRefreshOutcome(outcome: AstudioRefreshOutcome, options?: {
    fallbackLabel?: string;
}): AstudioSessionView;
/**
 * 凭据库读取入口的**最小接口**（`AstudioAuth.currentCredential` 的形状）。
 * 接线侧传 `ctx.astudioAuth`，单测传结构替身 —— 于是本层天然零网络。
 */
export interface AstudioCredentialReaderLike {
    currentCredential(refName?: string): Promise<AstudioCredential | undefined>;
}
/** 会话态读取选项；全部可选，缺省只走磁盘快路径。 */
export interface AstudioSessionStatusOptions {
    /** 环境变量视图；`DSH_ASTUDIO_SESSION_FILE` 在此覆盖会话文件路径。 */
    env?: Record<string, string | undefined>;
    /** 凭据库 ref 名，缺省 `ASTUDIO_ACCESS_TOKEN`。 */
    refName?: string;
    /** 磁盘读不到时的回落入口（接线侧 = `ctx.astudioAuth`）。 */
    auth?: AstudioCredentialReaderLike;
    /** 展示名兜底（无昵称且无账号 id 时用）。 */
    fallbackLabel?: string;
    /** 是否把凭据原值一并带回（缺省 `false`：展示层不需要明文 token）。 */
    includeCredential?: boolean;
}
export interface AstudioSessionStatus extends AstudioSessionView {
    /** 实际读取的会话文件路径（只读展示；本层不写该文件）。 */
    readonly sessionFile: string;
    readonly refName: string;
    /** 仅 `includeCredential === true` 且读到了才存在。 */
    readonly credential?: AstudioCredential;
}
/**
 * 读会话态：**磁盘快路径优先**，读不到再回落凭据库。
 *
 * 两个数据源都是纯读；上游重取只由 `astudio-auth.ts` 在 HTTP 401 时触发一次，
 * 本层**不越权发起任何网络请求**（所以它也不可能是「登录」的实现）。
 */
export declare function readAstudioSessionStatus(options?: AstudioSessionStatusOptions): Promise<AstudioSessionStatus>;
/**
 * 单步「导入本机既有会话」：把磁盘/库里的既有登录态读成一份视图交接线侧落库。
 *
 * ⚠️ 真正的凭据库写入在 `astudio-auth.ts`（接线缺口 B 的 `importLocalSession`）；
 * 本函数刻意**不写任何东西、不发任何请求** —— 读不到就直接返回
 * `no_local_session` / `needs_manual_relogin` 终态，由 UI 提示人工登录。
 * 之所以是单步而不是 `startLogin` + `pollLogin` 两步：本家没有可展示的本地授权页
 * URL（扫码在客户端窗口里完成），轮询一个不存在的回调只会是死代码。
 */
export declare function importAstudioLocalSession(refName?: string, options?: AstudioSessionStatusOptions): Promise<AstudioSessionStatus>;
/**
 * 「检查登录态 / 需要时重取一次」的展示入口（面板按钮语义）。
 *
 * 只有传入 `refresh`（接线侧 = `ctx.astudioAuth.refreshOnce`）时才可能发远端请求；
 * 不传就退化成纯读 —— 这让单测与无凭据环境下都不会误撞网络。
 */
export declare function checkAstudioSession(options?: AstudioSessionStatusOptions & {
    refresh?: (refName: string) => Promise<AstudioRefreshOutcome>;
}): Promise<AstudioSessionStatus>;
export declare const ASTUDIO_SSO_BASE_URL = "https://sso.xfyun.cn";
export declare const ASTUDIO_SSO_QRCODE_PATH = "/SSOService/wx/scanlogin/qrcode";
export declare const ASTUDIO_SSO_UIDS_PATH = "/SSOService/wx/scanlogin/uids";
export declare const ASTUDIO_SSO_BIND_PATH = "/SSOService/wx/scanlogin/bind";
export declare const ASTUDIO_INIT_APP_PATH = "/tenant-app/v2/init-app";
export declare const ASTUDIO_USER_INFO_PATH = "/userInfo";
export declare const ASTUDIO_BOT_CONFIGS_PATH = "/bot/models/configs";
export declare const ASTUDIO_GEE_CAPTCHA_PATH = "/chat/gee-captcha";
export declare const ASTUDIO_SEND_SMS_PATH = "/login/mobile/send-verify-code";
export declare const ASTUDIO_PHONE_LOGIN_PATH = "/login/phone-quick-login";
export declare const ASTUDIO_PASSWORD_LOGIN_PATH = "/login/check-account";
export declare const ASTUDIO_CARRIER_PATHS: {
    readonly login: "/astudio/login";
    readonly loginAlt: "/login";
    readonly geeCaptcha: "/astudio/gee-captcha";
    readonly sendSms: "/astudio/sms/send";
    readonly smsLogin: "/astudio/sms/login";
    readonly passwordLogin: "/astudio/password/login";
    readonly wechatQr: "/astudio/wechat/qrcode";
    readonly poll: "/astudio/poll";
};
export declare const ASTUDIO_WECHAT_FD_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
/** 生成 8 字符的随机 fd 串（官方微信扫码唯一凭证）。 */
export declare function generateAstudioWechatFd(): string;
export interface AstudioWechatQrCode {
    fd: string;
    qrUrl: string;
    expiresInMs: number;
}
/**
 * 申请微信扫码登录二维码。
 * 对接 GET https://sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd={fd}
 */
export declare function createAstudioWechatQrCode(options?: {
    ssoBaseUrl?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    fd?: string;
}): Promise<AstudioWechatQrCode>;
export interface AstudioWechatAccount {
    uid: string;
    ssoSessionId: string;
    username?: string;
}
export type AstudioWechatPollResult = {
    status: 'pending';
    message?: string;
} | {
    status: 'scanned';
    account: AstudioWechatAccount;
    accounts: AstudioWechatAccount[];
} | {
    status: 'unbound';
    message?: string;
} | {
    status: 'error';
    code: number | string;
    message: string;
};
/**
 * 轮询微信扫码状态。
 * 对接 GET https://sso.xfyun.cn/SSOService/wx/scanlogin/uids?fd={fd}
 * - code = -1: 未扫码
 * - code = 0: 已扫码，返回关联账号信息
 */
export declare function pollAstudioWechatScan(fd: string, options?: {
    ssoBaseUrl?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    /**
     * **拿到上游原始响应时回调**（可选，2026-10-20 加）。
     *
     * 存在理由：这条路径此前**没有任何留痕** —— 扫码失败时用户只看到一句文案，
     * 而排障需要知道「上游到底下发了什么形状」（字段名变了 / 只给一半）。
     * 生产可接到 `ctx.logger`；探针（`tests/e2e/astudio-scan-probe.e2e.spec.ts`）
     * 用它把**结构**（键名 + 类型，不含账号值）打到终端。
     *
     * ⚠️ 回调**不得抛**（调用点不包 try，实现方自己消化异常）。
     */
    onRaw?: (raw: unknown) => void;
}): Promise<AstudioWechatPollResult>;
/**
 * 确认绑定微信登录会话。
 * 对接 POST https://sso.xfyun.cn/SSOService/wx/scanlogin/bind
 */
export declare function bindAstudioWechatSession(fd: string, account: AstudioWechatAccount, options?: {
    ssoBaseUrl?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
}): Promise<{
    ok: boolean;
    message?: string;
}>;
export interface CompleteAstudioLoginOptions {
    fetcher?: typeof fetch;
    authBaseUrl?: string;
    timeoutMs?: number;
}
export interface AstudioGeeTestConfig {
    gt: string;
    challenge: string;
    success: boolean | number;
    new_captcha: boolean;
}
export interface AstudioGeeTestResult {
    geetestChallenge: string;
    geetestValidate: string;
    geetestSeccode: string;
}
export interface AstudioLoginIdentity {
    uid?: string;
    ssoSessionId?: string;
    sso_session_id?: string;
    token?: string;
    accountId?: string;
    account_id?: string;
    username?: string;
    nickname?: string;
    mobile?: string;
    avatar?: string;
    loginMethod?: 'wechat' | 'sms' | 'password' | string;
    login_method?: 'wechat' | 'sms' | 'password' | string;
}
export interface AstudioSmsSendResult {
    ok: boolean;
    message?: string;
    data?: unknown;
}
export type AstudioLoginInput = AstudioWechatAccount | AstudioLoginIdentity;
/**
 * 凭据交换与会话初始化（completeLogin）。
 * 统一支持微信扫码、手机短信快速登录与账号密码登录获取的会话：
 * 1. POST /tenant-app/v2/init-app 会话初始化（非阻塞）；
 * 2. GET /userInfo 获取用户信息与昵称；
 * 3. GET /bot/models/configs 换取模型推理 access_token（modelBearerToken）；
 * 组装并返回完整的 AstudioCredential。
 */
export declare function completeAstudioLogin(account: AstudioLoginInput, options?: CompleteAstudioLoginOptions): Promise<AstudioCredential>;
/**
 * 获取极验初始化配置。
 * 对接 GET https://agent.xfyun.cn/xingchen-studio/chat/gee-captcha
 */
export declare function getAstudioGeeTestConfig(options?: {
    fetcher?: typeof fetch;
    authBaseUrl?: string;
    timeoutMs?: number;
}): Promise<AstudioGeeTestConfig>;
/**
 * 发送短信验证码。
 * 对接 POST https://agent.xfyun.cn/xingchen-studio/login/mobile/send-verify-code
 */
export declare function sendAstudioSmsCode(mobile: string, captcha: AstudioGeeTestResult, options?: {
    countryCode?: string;
    fetcher?: typeof fetch;
    authBaseUrl?: string;
    timeoutMs?: number;
}): Promise<AstudioSmsSendResult>;
/**
 * 手机短信快速登录。
 * 对接 POST https://agent.xfyun.cn/xingchen-studio/login/phone-quick-login
 */
export declare function loginAstudioWithSms(mobile: string, verifyCode: string, options?: {
    countryCode?: string;
    fetcher?: typeof fetch;
    authBaseUrl?: string;
    timeoutMs?: number;
}): Promise<AstudioLoginIdentity>;
/**
 * 账号密码登录。
 * 对接 POST https://agent.xfyun.cn/xingchen-studio/login/check-account
 */
export declare function loginAstudioWithPassword(accountName: string, accountPwd: string, captcha: AstudioGeeTestResult, options?: {
    fetcher?: typeof fetch;
    authBaseUrl?: string;
    timeoutMs?: number;
}): Promise<AstudioLoginIdentity>;
export interface AstudioLoginPageOptions {
    product?: AstudioProduct;
    initialWechatQrUrl?: string;
}
/**
 * 渲染 AStudio Carrier Server 载体页 HTML（含手机验证码、账号密码、微信扫码 3 个 Tab）。
 */
export declare function renderAstudioLoginPage(options?: AstudioLoginPageOptions): string;
export interface AstudioLoginFlowOptions {
    product?: AstudioProduct;
    fetcher?: typeof fetch;
    authBaseUrl?: string;
    ssoBaseUrl?: string;
    timeoutMs?: number;
    onSuccess?: (credential: AstudioCredential) => Promise<void> | void;
}
export interface StartedAstudioLoginFlow {
    loginUrl: string;
    result: Promise<AstudioCredential>;
    close: () => Promise<void>;
}
/**
 * 启动 AStudio Carrier Server 本地载体页服务。
 */
export declare function startAstudioLoginFlow(options?: AstudioLoginFlowOptions): Promise<StartedAstudioLoginFlow>;
//# sourceMappingURL=astudio-oauth.d.ts.map