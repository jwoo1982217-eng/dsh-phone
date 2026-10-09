/**
 * LobsterAI（有道龙虾）认证服务。
 *
 * 结构与 `src/buddy-auth.ts` 的 `BuddyAuth` **刻意保持一致**：同样的
 * `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期。这是本插件已被两个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与 Buddy 侧的实质差异只有两处：
 *
 * 1. **续期的终态判定更精确**。Go 版只判「响应里有没有 accessToken」，
 *    会把网络抖动也当成终态而停止续期；本实现按 HTTP 状态码 +
 *    `classifyLobsteraiError` 的 `session-dead` 判定，其余错误交给
 *    `RefreshScheduler` 走可重试路径。
 * 2. **凭据里必须回写 `latest_keyfrom`**（LobsterAI 的续期请求体不是只带
 *    refreshToken，还要带身份字段；见 `lobsteraiRefreshBody`）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LobsteraiClientVersionResolver, type LobsteraiCredential } from './lobsterai.js';
import { type LobsteraiRemoteModel } from './lobsterai-adapter.js';
import { type LobsteraiProduct } from './lobsterai-product.js';
import { type LobsteraiLoginFlowOptions } from './lobsterai-oauth.js';
import { AccountPool } from './account-pool.js';
/**
 * LobsterAI 的默认凭据 ref。
 *
 * 等价于 `LOBSTERAI.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `LobsterAI.defaultCredentialRef`。
 */
export declare const LOBSTERAI_CREDENTIAL_REF = "LOBSTERAI_ACCESS_TOKEN";
/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与 `buddy-oauth.ts` / `oauth.ts` 同名类**刻意是各自独立的类**：
 * `src/refresh.ts:21-25` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 一次成功登录的结果。 */
export interface LobsteraiLoginResult {
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
export interface LobsteraiLoginStatus {
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
         * LobsterAI 的认证服务实例。
         *
         * 与 `buddyAuth` / `workbuddyAuth` / `codeartsAuth` 并列：
         * cordis 的 `Service` 构造时按名称注册，同名第二次注册会抛
         * `service "..." has been registered`，故每个 provider 各占一个服务名。
         */
        lobsteraiAuth: LobsteraiAuth;
    }
}
/** `LobsteraiAuth` 的构造选项。 */
export interface LobsteraiAuthOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link LOBSTERAI}。 */
    product?: LobsteraiProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `lobsteraiAuth`）。 */
    serviceName?: string;
    /** 客户端版本号解析器；默认为内部新建的实例。 */
    versionResolver?: LobsteraiClientVersionResolver;
}
/**
 * LobsterAI 认证服务：本地回调登录 + refresh_token 静默续期。
 */
export declare class LobsteraiAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: LobsteraiProduct;
    /**
     * 本实例默认读写的凭据 ref 名称（`LOBSTERAI_ACCESS_TOKEN`）。
     *
     * 由产品配置派生，与 CodeBuddy 系的两个 ref 完全隔离。
     */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    /** 客户端版本号解析器（带缓存与兜底）。 */
    private readonly versionResolver;
    constructor(ctx: Context, options?: LobsteraiAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
    /**
     * 解析客户端版本号（带缓存与兜底）。
     *
     * 三个消费点都需要它：登录 exchange 的 `version` 字段、续期请求体的
     * `version`、以及签到接口的必填 query 参数。集中在此避免三处各自拉取。
     */
    resolveClientVersion(): Promise<string>;
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
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
    } & Partial<LobsteraiLoginFlowOptions>): Promise<LobsteraiLoginResult>;
    /**
     * **两步式登录**：起回调服务器并立即返回登录 URL，由调用方先打开窗口。
     *
     * 与 CodeArts 的 `CodeArtsAuth.startLogin` 同因（真实缺陷）：Jet Hub 的
     * 「+ 新建账号」原先调用阻塞式 {@link login}，而浏览器只在用户点击后的
     * 短暂窗口（transient activation，约 5 秒）内允许 `window.open`。
     * 等阻塞调用返回时手势早已过期，`window.open` 被弹窗拦截器拒绝并返回
     * `null`，前端兜底逻辑便执行 `window.location.href = loginUrl`，
     * 把**整个设置页**跳转到登录页。
     *
     * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
     */
    startLogin(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & Partial<LobsteraiLoginFlowOptions>): Promise<{
        loginUrl: string;
        result: Promise<LobsteraiLoginResult>;
        close: () => Promise<void>;
    }>;
    /**
     * 持久化一次登录结果：写凭据、重置失效状态、武装续期、按需登记账号池。
     *
     * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
     * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致。
     */
    private persistLogin;
    /**
     * 用**已有的授权码**完成登录（供需要自行起回调的场景使用）。
     *
     * 与 {@link login} 的区别：不走本地服务器，直接拿 code 换凭据。
     * 保留这个入口是为了让 e2e 探针能在不打开浏览器的情况下验证 exchange。
     */
    loginWithCode(code: string, session: {
        uuid: string;
        firstKeyfrom: string;
    }, options?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    }): Promise<LobsteraiLoginResult>;
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    status(): Promise<LobsteraiLoginStatus>;
    /**
     * 静默续期：`refresh_token` + keyfrom 身份载荷换取新令牌。
     *
     * 终态判定（**比 Go 版精确**，见模块头注释）：
     * - HTTP 401/403、或响应体命中 `session-dead` 标记 → 抛
     *   {@link RefreshTokenExpiredError}，让调度器停止续期；
     * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走调度器的可重试路径。
     */
    refresh(): Promise<void>;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
     * `refresh()` 读写本实例的默认单凭据 ref（`LOBSTERAI_ACCESS_TOKEN`），
     * 而 Jet Hub 账号卡片对应的是 `LOBSTERAI_ACCOUNT_XXX` ——
     * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
     *
     * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
     *
     * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：
     * UI 账号卡片的「有效期」读的正是池里的值，而不是凭据里 access_token 的真实
     * `exp`。早期这里只 `credentials.set`，于是调用 `account.refresh` 后凭据确实续好了、
     * 界面却**一直显示「已过期」**，且没有任何自救手段（「重测」按钮的 refresh
     * 是刻意的 no-op）。
     *
     * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
     * @param accountId 账号 id。**调用方已知时请显式传入** ——
     *   否则只能按凭据内容反查（代价高，且反查会跳过已停用账号）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 一次性修复**老账号**的展示名：把手机号掩码归一化为「只露末 2 位」。
     *
     * ## 为什么需要它（用户要求 2026-09-27）
     *
     * > lobsterai 的用户名字显示的手机号尾号漏出 4 位，现在也改为只漏出 2 位
     *
     * ⚠️ 那个 `130****1100` 是**服务端下发的 `user.nickname` 原值**，不是本插件
     * 截取的（实测四个账号登录响应即为此形态）。故只改代码只影响新登录账号，
     * 已登录的老账号昵称仍是露 4 位 —— 启动时主动补一次。
     *
     * 与 `RaccoonAuth.repairAccountNicknames` / `TraeAuth.repairAccountNicknames`
     * 同一模式（都是「服务端下发的名字不适合直接展示」）。
     *
     * ## 契约
     *
     * - **幂等**：`lobsteraiDisplayNickname` 对已归一化的值算出同一结果，
     *   故不触发写入（只在**确实变化**时落盘）。
     * - **失败不阻塞**：逐账号 catch，异常只记 warn。
     * - **纯本地**：不发任何网络请求（掩码只依赖凭据里的昵称）。
     * - **不误伤真实昵称**：非手机号形态（如 `用户26815487395`）原样保留。
     *
     * @returns 被修复的账号 id 列表（供日志）
     */
    repairAccountNicknames(pool: AccountPool): Promise<string[]>;
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
     * 供 e2e 探针与 `account-probe` 使用（后者实际走 `resolveCredentialForAccount`，
     * 按账号 id 解析，不受 `enabled` 限制）。
     */
    resolveStoredCredential(): Promise<LobsteraiCredential | undefined>;
    /**
     * `GET /api/models/available` → 远端模型列表。
     *
     * 失败或未登录时返回空数组（调用方回退到产品兜底目录），
     * 与 `BuddyAuth.fetchModels` 同语义。
     *
     * 优先使用账号池中的可用账号；无账号池或池为空时回退到固定凭据 ref。
     * 两处都必须带上 `this.product` 与真实版本号 —— 该端点的 query 是
     * **身份载荷**（keyfrom），发错身份会让服务端返回错误的模型集合。
     */
    fetchModels(pool?: AccountPool): Promise<LobsteraiRemoteModel[]>;
}
//# sourceMappingURL=lobsterai-auth.d.ts.map