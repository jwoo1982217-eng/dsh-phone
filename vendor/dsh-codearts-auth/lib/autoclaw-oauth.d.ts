/**
 * AutoClaw 凭据获取、本地探测、短信验证码快速登录与 Token 刷新。
 */
import { type AutoclawProduct } from './autoclaw-product.js';
import { type AutoclawCredential } from './autoclaw.js';
export declare const AUTOCLAW_SEND_CODE_PATH = "/userapi/v1/agent-send-code";
export declare const AUTOCLAW_LOGIN_PATH = "/userapi/v1/agent-login";
/** Z.ai 授权页（国际版）。 */
export declare const AUTOCLAW_ZAI_AUTH_URL = "https://chat.z.ai/auth";
/**
 * Z.ai OAuth 的固定 `client_id`。
 *
 * ⚠️ 实测依据：两次独立授权 URL 的 `client_id` 逐字节相同 ⇒ 它是**构建期常量**，
 * 不是服务端下发（`oauth-url` 端点需要登录态，首次登录拿不到）。
 */
export declare const AUTOCLAW_ZAI_CLIENT_ID = "client_EnD0QI8bLRFT8cciLp389Q";
/** OAuth 换 token 端点（`overseasv1` 命名空间，仅国际站有）。 */
export declare const AUTOCLAW_ZAI_EXCHANGE_PATH = "/userapi/overseasv1/zai-oauth-login";
/** Google OAuth 换 token 端点（对照用）。 */
export declare const AUTOCLAW_GOOGLE_EXCHANGE_PATH = "/userapi/overseasv1/google-oauth-login";
/** OAuth 回调路径（与客户端同款：`/auth/callback-zai`）。 */
export declare const AUTOCLAW_OAUTH_CALLBACK_PATH = "/auth/callback-zai";
/** OAuth 回调端口候选（与客户端 `OAUTH_CALLBACK_PORTS` 逐字相同）。 */
export declare const AUTOCLAW_OAUTH_CALLBACK_PORTS: readonly number[];
/**
 * 构造 Z.ai 授权 URL。
 *
 * ⚠️ `state` **不由本函数生成** —— 它留空，由官方授权页在跳转时填充，
 *    回调时原样带回（见上方「关于 state.nh」）。这避免了逆向 `nh`。
 *
 * @param redirectUri - 回调地址（`http://localhost:<port>/auth/callback-zai`）。
 */
export declare function buildAutoclawZaiAuthUrl(redirectUri: string): string;
/**
 * 用授权码换 token（国际版 Z.ai OAuth）。
 *
 * ## 与国内版 HTTP 请求的差别：**必须带完整 managed 头**
 *
 * 客户端 `createZworkManagedRequestHeaders` 里除了签名头还有三个：
 * `X-Version`（客户端版本）/ `X-Tm`（平台 `win`）/ `X-Product`（`autoclaw`）。
 *
 * ⚠️ **实测对照（2026-10-20）**：缺这三个头时服务端回
 * `410000 用户未登录`（看起来像「没登录」但其实**压根没进登录逻辑**）；
 * 补齐后回 `631001 User login error`（= 进了逻辑、code 无效）。
 * ⇒ 三个头是**必需**的，缺了会被误诊成「凭据问题」。
 *
 * @param code - 授权码（回调 URL 的 `code`）。
 * @param state - 授权页原样带回的 `state`（透传，不解析）。
 * @param navigateUri - 与授权时**完全相同**的回调地址。
 */
export declare function exchangeAutoclawZaiCode(code: string, state: string, navigateUri: string, options?: LoginAutoclawWithCodeOptions): Promise<LoginAutoclawWithCodeResult>;
/**
 * AutoClaw 客户端版本号（`X-Version` 头用）—— **单一真相源在 `autoclaw-product.ts`**。
 *
 * ⚠️ 此处不再重复定义（2026-10-20）：`X-Version` 是国际站推理的硬校验头
 *    （缺它 → HTTP 500 空响应体），两处各写一份 `'2.1.1'` 必然漂移，
 *    统一从 `autoclaw-product.js` 导入（见 `AUTOCLAW_CLIENT_VERSION` 的注释）。
 */
/** 手机号格式正则（中国大陆11位手机号）。 */
export declare const PHONE_NUMBER_RE: RegExp;
/**
 * 从本地 Windows DPAPI 及 AES-256-GCM 探测 AutoClaw 桌面端保存的有效凭据（一键导入模式）。
 *
 * ## ⚠️⚠️ 凭据来源是**用户真实凭据**，故必须可隔离（2026-10-17 审计 P0 修复）
 *
 * 本函数会真读 `%APPDATA%\AutoClaw-official\` 并**真跑 powershell 解 DPAPI**
 * （约 1s）⇒ 单测里若不隔离，用户装了 AutoClaw 桌面端时就会读到**他的真实
 * access/refresh token**（本仓库 `.office-claw` 未隔离事故的同型，见
 * `tests/setup-isolation.ts` 的长注释）。
 *
 * ⇒ 新增 `DSH_AUTOCLAW_APPDATA` 覆盖：**优先级高于 `APPDATA`**，
 *   `tests/setup-isolation.ts` 在**进程级**把它指向临时目录
 *   （与 `DSH_OFFICEACE_HOME` / `DSH_JET_HUB_STATE_DIR` 同型）。
 * ⚠️ 为什么不用「在用例里改 `APPDATA`」：`apply()` 内部有 fire-and-forget 的
 *   后台链，用例的 `afterEach` 恢复环境变量**之后**那条链才跑到本分支 ⇒
 *   与 officeace 那次事故同型，唯一可靠做法是进程级。
 */
export declare function probeAutoclawLocalCredential(options?: {
    customAppData?: string;
    /**
     * **产品配置**（推荐形态）—— 目录名从 `product.userDataDirName` 取。
     *
     * ⚠️ 与下面的 `appDirName` 二选一，`product` 优先。新增调用点**必须**用它
     * （而不是自己拼目录名），否则又会出现「三个读点各写一份」的事故形态。
     */
    product?: AutoclawProduct;
    /**
     * 客户端 userData 目录名（**低层逃生口**，仅测试/特殊场景用）。
     *
     * ⚠️ **国内版与国际版是同一客户端的两份构建**（`isOversea` 是构建期常量），
     * 但 userData 目录名不同 —— 实测（2026-10-20）：
     * - 国内构建：`AutoClaw-official`
     * - 国际构建：`AutoClaw-oversea-official`
     *
     * ⇒ 生产调用点一律传 `product`，别在这里写死（原实现硬编码国内目录，
     *   导致国际版**永远导入不到**自己的凭据；审计 P0 就是漏了本函数的
     *   `/autoclaw/import-local` 那个调用点）。
     *
     * @default AUTOCLAW.userDataDirName（`'AutoClaw-official'`）
     */
    appDirName?: string;
}): Promise<AutoclawCredential | undefined>;
/**
 * 刷新 AutoClaw Token。
 */
export declare function refreshAutoclawToken(refreshToken: string, options?: {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
    deviceId?: string;
}): Promise<AutoclawCredential>;
/**
 * 校验 AutoClaw 凭据是否连通可用。
 */
export declare function testAutoclawConnection(accessToken: string, options?: {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
}): Promise<boolean>;
export interface SendAutoclawCodeOptions {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
    deviceId?: string;
}
export interface SendAutoclawCodeResult {
    ok: boolean;
    msgid?: string;
    error?: string;
}
export interface LoginAutoclawWithCodeOptions {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
    deviceId?: string;
}
export interface LoginAutoclawWithCodeResult {
    ok: boolean;
    credential?: AutoclawCredential;
    error?: string;
}
/**
 * 向手机号发送 AutoClaw 登录验证码（/userapi/v1/agent-send-code）。
 */
export declare function sendAutoclawVerificationCode(phone: string, options?: SendAutoclawCodeOptions): Promise<SendAutoclawCodeResult>;
/**
 * 使用手机验证码登录 AutoClaw 并兑换凭据（/userapi/v1/agent-login）。
 */
export declare function loginAutoclawWithCode(phone: string, code: string, options?: LoginAutoclawWithCodeOptions): Promise<LoginAutoclawWithCodeResult>;
export interface StartedAutoclawSmsLoginFlow {
    readonly loginUrl: string;
    readonly result: Promise<{
        credential: AutoclawCredential;
        phone: string;
    }>;
    readonly close: () => Promise<void>;
}
export interface AutoclawSmsLoginFlowOptions {
    product?: AutoclawProduct;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    deviceId?: string;
}
/**
 * 启动本地独立服务器承载 AutoClaw 登录授权页（支持一键读取本地凭据或手机验证码登录）。
 */
export declare function startAutoclawSmsLoginFlow(options?: AutoclawSmsLoginFlowOptions): Promise<StartedAutoclawSmsLoginFlow>;
//# sourceMappingURL=autoclaw-oauth.d.ts.map