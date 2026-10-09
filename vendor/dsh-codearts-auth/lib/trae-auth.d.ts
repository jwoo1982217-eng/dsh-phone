/**
 * TRAE（字节跳动 TRAE IDE）认证服务。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/buddy-auth.ts` 一致：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期。这是本插件已被多个产品验证过的模式。
 *
 * ## 与 Buddy 侧的关键差异
 *
 * 1. **续期是用 ExchangeToken（轮换 refreshToken）**，不是直接换新的 access_token。
 *    ExchangeToken 返回新 token + 新 refreshToken，旧 refreshToken 即刻失效。
 * 2. **凭据必须保留 machine_id / device_id**：续期时只改 token/expiresAt，
 *    这两个设备指纹字段**完全不动**。
 * 3. **GetUserInfo 用于登录后的默认凭据回填**，与续期无关。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type TraeRemoteModel } from './trae.js';
import { type TraeProduct } from './trae-product.js';
import { type TraeLoginFlowOptions } from './trae-oauth.js';
import { AccountPool } from './account-pool.js';
/**
 * TRAE 的默认凭据 ref。
 */
export declare const TRAE_CREDENTIAL_REF = "TRAE_ACCESS_TOKEN";
/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 一次成功登录的结果。 */
export interface TraeLoginResult {
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
export interface TraeLoginStatus {
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
        traeAuth: TraeAuth;
    }
}
/** `TraeAuth` 的构造选项。 */
export interface TraeAuthOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link TRAE}。 */
    product?: TraeProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `traeAuth`）。 */
    serviceName?: string;
}
/**
 * TRAE 认证服务：回调登录 + ExchangeToken 续期。
 */
export declare class TraeAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: TraeProduct;
    /** 本实例默认读写的凭据 ref 名称（`TRAE_ACCESS_TOKEN`）。 */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    /**
     * 模型目录缓存（含**空结果**）与拉取时刻。
     *
     * ⚠️ 为什么需要它：适配器的 `ensureRemoteModels` 是**只缓存非空结果**的
     * （全仓库四个适配器同一模式）—— 拉到空数组时 `remoteModels` 保持 undefined，
     * 于是**下一次** `listModels` / `resolveModel` 会再拉一次。
     *
     * 「未登录 TRAE」恰好就是恒空的情形：用户每打开一次模型选择器、每次
     * 解析模型都发起一次真实 HTTP 请求。用户报障的日志刷屏
     * （同一行 `fetchModels: calling …` 重复数十次）正是这么来的。
     *
     * 故这里**连同空结果一起缓存**，并给一个短 TTL（登录后 30s 内即可自愈，
     * 不需要用户重启宿主）。缓存的是「这次拉取的结果」，与是否有凭据无关 ——
     * 无凭据时直接返回空并缓存，避免重复走一遍凭据解析。
     */
    private modelsCache;
    /** 模型目录缓存有效期（毫秒）。短 TTL：新登录的账号最多 30s 后可见。 */
    private static readonly MODELS_CACHE_TTL_MS;
    constructor(ctx: Context, options?: TraeAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
    private markRefreshTokenInvalid;
    /**
     * 运行完整登录流程并持久化凭据。
     */
    login(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & Partial<TraeLoginFlowOptions>): Promise<TraeLoginResult>;
    /**
     * 两步式登录：起回调服务器并立即返回 loginUrl。
     */
    startLogin(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & Partial<TraeLoginFlowOptions>): Promise<{
        loginUrl: string;
        result: Promise<TraeLoginResult>;
        close: () => Promise<void>;
    }>;
    /**
     * 持久化一次登录结果。
     */
    private persistLogin;
    /** 报告凭据状态。 */
    status(): Promise<TraeLoginStatus>;
    /**
     * 静默续期：ExchangeToken 换新。
     *
     * 终态判定：
     * - HTTP 401/403、或响应体命中 session-dead 标记 → 抛 RefreshTokenExpiredError
     * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走可重试路径
     */
    refresh(): Promise<void>;
    /**
     * 按凭据 ref 续期指定账号的凭据。
     *
     * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
     * `refresh()` 读写本实例的默认单凭据 ref（`TRAE_ACCESS_TOKEN`），
     * 而 Jet Hub 账号卡片对应的是 `TRAE_ACCOUNT_XXX` ——
     * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
     *
     * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
     *
     * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：
     * UI 账号卡片的「有效期」读的正是池里的值，而不是凭据里 access_token 的真实
     * 过期时间。早期这里只 `credentials.set`，于是调用 `account.refresh` 后凭据确实续好了、
     * 界面却**一直显示「已过期」**，且没有任何自救手段（「重测」按钮的 refresh
     * 是刻意的 no-op）。TRAE 用 ExchangeToken 轮换 refreshToken，不回写还会让
     * 池里的 `refreshable` 与实际凭据脱节。
     *
     * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
     * @param accountId 账号 id。**调用方已知时请显式传入** ——
     *   否则只能按凭据内容反查（代价高，且反查会跳过已停用账号）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
     */
    private refreshCredential;
    /**
     * 批量续期本产品的所有账号。
     *
     * **包含已停用账号**（只按 `refreshable` 过滤）。
     *
     * ⚠️ **lead-time 过滤**（issue !IKIRTT）：早先这里是**无条件全量续期** ——
     * 定时器每 30 分钟就把每个账号的 refreshToken 轮换一次，与「凭据还剩多久」
     * 无关。现复用单凭据时代 `REFRESH_LEAD_MS` 的语义：**距过期不足 1 小时才刷**。
     * 跳过的账号仍会做一次**有效期对账**（见 `refreshAccountWithReconcile`），
     * 因为「不刷」与「不回写池值」正是 UI 假过期的两个来源，必须分开处理。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 一次性修复**老账号**的展示名：补 `GetUserInfo` 拿脱敏手机号并重算昵称。
     *
     * ## 为什么需要它（真实缺陷，用户报障 2026-09-27）
     *
     * > 用 trae provider 登录后用户名字显示无法区分各个用户，有其他名字昵称或者
     * > 手机尾号之类的信息可以区分吗？
     *
     * 服务端的 `ScreenName` 是**按 uid 自动生成的默认名**（`用户26815487395`
     * 这种），四个账号形态完全一致，一屏列出来认不出谁是谁。
     * `GetUserInfo` 会下发 `NonPlainTextMobile`（脱敏手机号），实测可区分。
     *
     * 光改代码只影响**新登录**的账号，已登录的老账号昵称仍是 ScreenName，
     * 故这里在启动时主动补一次 —— 与 `RaccoonAuth.repairAccountNicknames`
     * 同一模式（同因：服务端下发的名字是默认名）。
     *
     * ## 契约
     *
     * - **幂等**：昵称已是手机号时 `traeDisplayNickname` 会算出同一值，
     *   不触发写入（只在**确实变化**时落盘，否则每次启动都写一次文档）。
     * - **失败不阻塞**：逐账号 catch，任何异常只记 warn。
     * - **只读补字段**：不发续期、不动 token，只补 `phone` 与昵称。
     *
     * @returns 被修复的账号 id 列表（供日志）
     */
    repairAccountNicknames(pool: AccountPool): Promise<string[]>;
    /**
     * 调 `GetUserInfo` 只取脱敏手机号 / 邮箱。
     *
     * ⚠️ 两者都没有时返回 `undefined` 而**不抛错**：它们只是展示信息，拿不到
     * 不应让启动流程失败（与 `exchangeTraeCallback` 对 GetUserInfo 的容错同原则）。
     * 返回 `undefined` 也让调用方能区分「确实没有」与「拿到了空值」，
     * 从而避免用服务端默认名覆盖用户手动改过的昵称。
     */
    private fetchUserContact;
    /** 移除已存储的凭据并停止任何待处理的刷新。 */
    logout(): Promise<void>;
    /** 停止刷新调度（不清理凭据）。 */
    stop(): void;
    /** 启动时若已有可刷新凭据则安排续期。 */
    scheduleRefresh(): void;
    /** 从存储重载凭据，返回是否已过期。 */
    checkExpired(): Promise<boolean>;
    /**
     * 获取 TRAE 模型列表（`batch_get_detail_param`）。
     *
     * ## 日志约定（与其它 provider 对齐）
     *
     * **成功路径一律不打印**。早期这里用 `console.warn` 打了「calling / got N
     * models」，而本方法在冷启动阶段会被调用多次（每次 `listModels` /
     * `resolveModel` 都可能触发，见 `TraeAdapter.ensureRemoteModels`），
     * 于是整个日志被同一行刷屏 —— 用户报障「fetch 的 log 似乎太多了」。
     *
     * **「没有凭据」不是异常**：未登录 TRAE 的用户每次列模型都会走到这条分支，
     * 打日志只会制造噪声（用户报障「没有账号不需要显示 no credential
     * resolved from store」）。真正需要关注的失败（HTTP 非 2xx、网络异常）
     * 才记录。
     */
    fetchModels(pool?: AccountPool): Promise<TraeRemoteModel[]>;
    /** 真正发起一次拉取；日志与错误处理见 `fetchModels` 的注释。 */
    private fetchModelsUncached;
    /** 记录一条警告（经 `ctx.logger`，**仅失败路径**调用）。 */
    private warn;
}
//# sourceMappingURL=trae-auth.d.ts.map