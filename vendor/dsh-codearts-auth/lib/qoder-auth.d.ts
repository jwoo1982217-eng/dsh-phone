/**
 * Qoder 认证服务。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/buddy-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期。这是本插件已被三个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与 LobsterAI 侧的实质差异只有两处：
 *
 * 1. **没有客户端版本号**。LobsterAI 的 exchange/续期/签到都要带 `version`，
 *    Qoder 不需要，故本服务没有 `resolveClientVersion`。
 * 2. **续期载荷是 `{refresh_token, machine_id}`**，`machine_id` 必须随凭据
 *    持久化并原样回传（见 `qoderRefreshBody`）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type QoderCredential } from './qoder.js';
import { type QoderProduct } from './qoder-product.js';
import { type QoderLoginFlowOptions } from './qoder-oauth.js';
import { AccountPool } from './account-pool.js';
/**
 * Qoder 的默认凭据 ref。
 *
 * 等价于 `QODER.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `QODER.defaultCredentialRef`。
 */
export declare const QODER_CREDENTIAL_REF = "QODER_ACCESS_TOKEN";
/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与其它 provider 的同名类**刻意是各自独立的类**：
 * `src/refresh.ts:21-25` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 一次成功登录的结果。 */
export interface QoderLoginResult {
    /** 已存储的凭据 JSON 字符串。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 凭据值存储所用的凭据引用。 */
    ref: CredentialRef;
    /** 打开的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
}
/** 用于配置界面的只读登录状态。 */
export interface QoderLoginStatus {
    configured: boolean;
    source?: string;
    expiresAt?: number;
    /** 存储的凭据是否可通过刷新令牌静默续期。 */
    refreshable: boolean;
    /** 最近一次刷新失败的原因（如有）。 */
    refreshError?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /**
         * Qoder 的认证服务实例。
         *
         * 与 `buddyAuth` / `workbuddyAuth` / `codeartsAuth` / `lobsteraiAuth` 并列：
         * cordis 的 `Service` 构造时按名称注册，同名第二次注册会抛
         * `service "..." has been registered`，故每个 provider 各占一个服务名。
         */
        qoderAuth: QoderAuth;
        /**
         * Qoder **中国版**的认证服务实例。
         *
         * 与 `qoderAuth` 是**两个独立实例**（同一 `QoderAuth` 类，不同 `product`），
         * 正如 `buddyAuth` 与 `workbuddyAuth`。服务名由 `${product.id}Auth` 派生，
         * 故不会与国际版撞名 —— 这也是 `id` 必须区分两站的原因。
         */
        qoderCnAuth: QoderAuth;
    }
}
/** `QoderAuth` 的构造选项。 */
export interface QoderAuthOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link QODER}。 */
    product?: QoderProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `qoderAuth`）。 */
    serviceName?: string;
}
/**
 * Qoder 认证服务：PKCE 设备码登录 + refresh_token 静默续期。
 */
export declare class QoderAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: QoderProduct;
    /** 本实例默认读写的凭据 ref 名称（`QODER_ACCESS_TOKEN`）。 */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    constructor(ctx: Context, options?: QoderAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false。 */
    private markRefreshTokenInvalid;
    /**
     * 运行完整登录流程并持久化凭据。
     *
     * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池
     * （Jet Hub 的「+ 新建账号」路径）。
     */
    login(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & Partial<QoderLoginFlowOptions>): Promise<QoderLoginResult>;
    /**
     * **两步式登录**：立即返回登录 URL，由调用方先打开窗口。
     *
     * 与 CodeArts 的 `CodeArtsAuth.startLogin` / LobsterAI 的同名方法同因
     * （真实缺陷）：Jet Hub 的「+ 新建账号」原先调用阻塞式 {@link login}，
     * 而浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内
     * 允许 `window.open`。等阻塞调用返回时手势早已过期，`window.open` 被
     * 弹窗拦截器拒绝并返回 `null`，前端兜底逻辑便执行
     * `window.location.href = loginUrl`，把**整个设置页**跳转到登录页。
     *
     * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
     */
    startLogin(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & Partial<QoderLoginFlowOptions>): Promise<{
        loginUrl: string;
        result: Promise<QoderLoginResult>;
        close: () => Promise<void>;
    }>;
    /**
     * 持久化一次登录结果：写凭据、重置失效状态、武装续期、按需登记账号池。
     *
     * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
     * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致。
     */
    private persistLogin;
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    status(): Promise<QoderLoginStatus>;
    /**
     * 静默续期：`refresh_token` + `machine_id` 换取新令牌。
     *
     * 终态判定：
     * - HTTP 401/403、或响应缺 token → 抛 {@link RefreshTokenExpiredError}，
     *   让调度器停止续期；
     * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走调度器的可重试路径。
     */
    refresh(): Promise<void>;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
     * `refresh()` 读写本实例的默认单凭据 ref（`QODER_ACCESS_TOKEN`），
     * 而 Jet Hub 账号卡片对应的是 `QODER_ACCOUNT_XXX` ——
     * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
     *
     * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
     *
     * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：
     * UI 账号卡片的「有效期」读的正是池里的值，而不是凭据里 access_token 的真实
     * 过期时间。早期这里只 `credentials.set`，于是调用 `account.refresh` 后凭据确实续好了、
     * 界面却**一直显示「已过期」**，且没有任何自救手段（「重测」按钮的 refresh
     * 是刻意的 no-op）。
     *
     * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
     * @param accountId 账号 id。**调用方已知时请显式传入** ——
     *   否则只能按凭据内容反查（代价高，且反查会跳过已停用账号）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
     *
     * 抽出来供 `refresh()` 与 `refreshAll()` 共用，避免两处各写一遍
     * 「发请求 → 判终态 → 合并字段」的逻辑而逐渐分叉。
     */
    private refreshCredential;
    /**
     * 批量续期本产品的所有账号。
     *
     * **包含已停用账号**（只按 `refreshable` 过滤）：停用只应影响账号池的自动
     * 选号，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
     * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
     * 单账号失败不影响其他账号（与 `BuddyAuth.refreshAll` 同语义）。
     *
     * ⚠️ **lead-time 过滤**（issue !IKIRTT）：早先这里是**无条件全量续期** ——
     * 定时器每 30 分钟就把每个账号的 refresh_token 轮换一次，与「凭据还剩多久」
     * 无关。现复用单凭据时代 `REFRESH_LEAD_MS` 的语义：**距过期不足 1 小时才刷**。
     * 跳过的账号仍会做一次**有效期对账**（见 `refreshAccountWithReconcile`），
     * 因为「不刷」与「不回写池值」正是 UI 假过期的两个来源，必须分开处理。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /** 移除已存储的凭据并停止任何待处理的刷新。 */
    logout(): Promise<void>;
    /** 停止刷新调度（不清理凭据）。 */
    stop(): void;
    /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
    scheduleRefresh(): void;
    /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
    checkExpired(): Promise<boolean>;
    /**
     * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
     *
     * 供 e2e 探针与 `account-probe` 使用。
     */
    resolveStoredCredential(): Promise<QoderCredential | undefined>;
}
//# sourceMappingURL=qoder-auth.d.ts.map