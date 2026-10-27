/**
 * AutoClaw 认证服务。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type AutoclawProduct } from './autoclaw-product.js';
import { type AutoclawCredential } from './autoclaw.js';
import { type SendAutoclawCodeResult, type LoginAutoclawWithCodeResult, type StartedAutoclawSmsLoginFlow } from './autoclaw-oauth.js';
import { AccountPool } from './account-pool.js';
/**
 * 计算一条凭据的**账号身份**（同账号判据）。
 *
 * ⚠️ 抽成具名导出是为了让守卫能直接钉住它（`autoclawIdentityForTest` 同体）——
 *    这段逻辑踩过两次真机缺陷（同一账号被重复添加 3 次、积分重复累加），
 *    必须能被单测独立覆盖，而不是只能通过整条登录链路间接验证。
 *
 * ⚠️⚠️ **字段优先级**（2026-10-19 三次真机报障后定稿）：
 *      1. `credential.user_id` —— 服务端 `user-profile` 的 UUID 主键；
 *      2. `readUserIdFromJwt(access_token)` —— 老凭据没落该字段时兜底；
 *      3. `access_token` —— 两者都取不到时退化（宁可退化，不要「无身份」）。
 *
 *     ⚠️ 1 与 2 属**两个 id 空间**（UUID ↔ `numericUserId`）：同一账号可能
 *        一部分 ref 落在 1、另一部分落在 2 ⇒ 分裂成两组、去重白做
 *        （用户三次报障「怎么还是在啊」的直接原因）。
 *        彻底统一由 `autoclawSelfHeal` 在启动时调 `user-profile` 补 UUID 完成；
 *        本函数只在「来不及补齐」的窗口内保证不会没有身份。
 */
export declare function autoclawIdentityOf(credential: AutoclawCredential): string;
/** @internal 守卫专用别名（与 {@link autoclawIdentityOf} 同一实现）。 */
export declare const autoclawIdentityForTest: typeof autoclawIdentityOf;
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
export interface AutoclawAuthOptions {
    readonly product?: AutoclawProduct;
    readonly serviceName?: string;
    readonly fetcher?: typeof fetch;
}
export interface AutoclawStatusResult {
    readonly loggedIn: boolean;
    readonly expiresAt?: number;
    readonly refreshable: boolean;
    readonly lastError?: string;
}
export declare class AutoclawAuth extends Service {
    private readonly options;
    readonly product: AutoclawProduct;
    readonly credentialRefName: string;
    private readonly scheduler;
    private refreshTokenInvalid;
    private lastRefreshError;
    private active;
    constructor(ctx: Context, options?: AutoclawAuthOptions);
    private get fetchImpl();
    /**
     * 探测本地是否有有效凭据（一键导入）。
     *
     * ⚠️ **按产品选 userData 目录**（2026-10-20）：国内版与国际版是同一客户端的
     * 两份构建（`isOversea` 构建期常量），但 userData 目录名不同：
     * - 国内：`AutoClaw-official`
     * - 国际：`AutoClaw-oversea-official`
     *
     * 原实现硬编码国内目录 ⇒ **国际版永远导入不到自己的凭据**。
     *
     * ⚠️⚠️ 目录名**不再在这里拼**（2026-10-20 审计 P0 后收口）：它已进
     *    `product.userDataDirName`，因为同一个目录名有**三个读点**
     *    （本函数 / `resolveDeviceId` / 登录页 `/autoclaw/import-local`），
     *    原先各写一份 ⇒ PR 只修了本函数，另两处照旧读国内目录。
     */
    probeLocal(): Promise<AutoclawCredential | undefined>;
    /**
     * 刷新指定的凭据对象。
     */
    refreshCredential(credential: AutoclawCredential): Promise<AutoclawCredential>;
    /**
     * 按凭据 ref 续期指定账号的凭据。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量续期本产品的所有账号。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 刷新单凭据路径下的当前凭据。
     */
    refresh(): Promise<void>;
    private markRefreshTokenInvalid;
    /**
     * 获取当前单凭据状态。
     */
    status(): Promise<AutoclawStatusResult>;
    /**
     * **归属校验**：用**本产品自己的**基址探一次余额，确认这份凭据属于本站。
     *
     * ## 为什么必须存在（真实事故，2026-10-20）
     *
     * 旧代码把 `refName` 写死 `AUTOCLAW_ACCOUNT_*`、且读国内目录 ⇒ 国际版槽位里
     * 被塞进**国内版凭据**。用户看到的是「国际版卡片显示国内手机号、且已过期」
     * —— 而凭据本身能解出来、能落盘，**全流程无一处报错**。
     *
     * ⇒ 「能读到」不等于「读对了」。国内凭据打国际基址会 `410000 未登录`，
     *    反之亦然（实测）。
     *
     * ## ⚠️⚠️ 为什么抽成 public 方法（审计 P0 的直接产物）
     *
     * 凭据落盘有**两条腿**：
     * 1. `importLocalAccount()` —— 本类内部，原先就调它；
     * 2. `startLogin()` 的 `started.result` —— 登录页上的「⚡ 一键读取本机凭据」
     *    （`/autoclaw/import-local`）走这条，结果由 `jet-hub-rpc.ts` **直接
     *    `credentials.set`** ⇒ 原先把校验留在 `importLocalAccount` 里，
     *    这条腿**完全绕过**它。
     *
     * 审计实测：以 `product: AUTOCLAW_INTL` 起 flow 后请求该端点，被探测的
     * 路径是 `AutoClaw-official`（国内）⇒ 国内凭据进 `AUTOCLAWINTL_ACCOUNT_*`，
     * 零报错。
     *
     * ⇒ 校验必须**与落盘同址**、且能被两条腿各自调用。
     *
     * @param cred - 待落盘的凭据。
     * @throws 校验失败时抛出**指向性**错误（告诉用户去哪个客户端登录）。
     */
    verifyCredentialSite(cred: AutoclawCredential): Promise<void>;
    /**
     * 将本地探测到的凭据导入为账号。
     */
    importLocalAccount(pool: AccountPool, options?: {
        accountId?: string;
        refName?: string;
    }): Promise<{
        accountId: string;
        refName: string;
        credential: AutoclawCredential;
    }>;
    /**
     * 发送手机验证码（免桌面端快速登录模式）。
     */
    sendVerificationCode(phone: string): Promise<SendAutoclawCodeResult>;
    /**
     * 使用手机验证码登录并保存凭据（免桌面端快速登录模式）。
     */
    loginWithCode(phone: string, code: string, refName?: string): Promise<LoginAutoclawWithCodeResult>;
    /**
     * 启动 AutoClaw 登录授权流程（本地服务器承载独立登录页，支持短信验证码与一键本地导入）。
     */
    startLogin(_options?: {
        refName?: string;
    }): Promise<StartedAutoclawSmsLoginFlow>;
    /**
     * 构造 **Z.ai OAuth** 授权 URL（仅国际版 `autoclawintl` 用）。
     *
     * ## 为什么国际版必须走 OAuth 而不是短信
     *
     * 国际版**后端也接受短信**（实测 `/userapi/v1/agent-send-code` 在国际基址回
     * `code=0 SUCCESS`），但国际版账号是**邮箱 + OAuth 创建、没绑手机号**
     * （`account-profile.json`: `phone: null`），且**没有绑手机的端点**
     * （`agent-bind-phone` / `bind-phone` 等全 404）⇒ 短信对国际账号不可用。
     *
     * ## `state` 的处理：**不生成，透传**
     *
     * 官方 `state` 是不透明串（`aosi.<base64url JWT>`，含 `dh` / `nh` 等字段），
     * 由远端登录页生成。`dh = SHA256(deviceId)` 已破解，但 **`nh` 来源未知**。
     *
     * ⚠️ 实测：用**瞎编的** `state` 打 `/userapi/overseasv1/zai-oauth-login`，
     *    服务端回 `631001 User login error`（= 进了登录逻辑、code 无效），
     *    **不是**「state 无效」⇒ 服务端不硬校验 `state` 内容。
     *
     * ⇒ 本方法**只拼 `client_id` / `redirect_uri` / `response_type`**，
     *   `state` 留给授权页填，回调时原样透传给 {@link loginWithZaiCode}。
     *
     * @param redirectUri - 回调地址（`http://localhost:<port>/auth/callback-zai`）。
     */
    buildZaiAuthUrl(redirectUri: string): string;
    /**
     * 用 Z.ai 授权码换 token 并落盘（仅国际版）。
     *
     * ⚠️ 与 {@link loginWithCode}（短信）并列的**第二条登录腿**：
     *    - 短信：国内版；国际版短信端点通但账号没绑手机。
     *    - OAuth：国际版唯一可用路径。
     *
     * @param code - 回调 URL 里的 `code`。
     * @param state - 回调 URL 里的 `state`（**原样透传**，不解析）。
     * @param navigateUri - 与授权时**完全相同**的回调地址。
     * @param refName - 凭据 ref 名（登录成功后写它）。
     */
    loginWithZaiCode(code: string, state: string, navigateUri: string, refName: string): Promise<LoginAutoclawWithCodeResult>;
}
//# sourceMappingURL=autoclaw-auth.d.ts.map