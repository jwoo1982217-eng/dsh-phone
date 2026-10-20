/**
 * Buddy (腾讯 CodeBuddy) 认证服务
 *
 * 管理 external-link-v2 轮询式登录、凭据存储与 RefreshScheduler 静默续期，
 * 结构与 CodeArtsAuth 保持一致（同样的调度语义、同样的登出竞态保护）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type BuddyLoginFlowOptions } from './buddy-oauth.js';
import type { BuddyRemoteModel } from './buddy.js';
import { AccountPool } from './account-pool.js';
import { type BuddyProduct } from './product.js';
/**
 * CodeBuddy 的登录结果存储所用的凭据引用。
 *
 * 等价于 `CODEBUDDY.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请改用 `BuddyAuth` 实例的 `credentialRefName` 字段（随产品变化）。
 */
export declare const BUDDY_CREDENTIAL_REF = "BUDDY_ACCESS_TOKEN";
/** 一次成功登录的结果。 */
export interface BuddyLoginResult {
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
export interface BuddyLoginStatus {
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
        buddyAuth: BuddyAuth;
        /**
         * WorkBuddy 的认证服务实例。
         *
         * 与 `buddyAuth`（CodeBuddy）并列存在：cordis 的 `Service` 构造时按名称
         * 注册，同名第二次注册会抛 `service "buddyAuth" has been registered`，
         * 故两个产品必须各占一个服务名。
         */
        workbuddyAuth: BuddyAuth;
    }
}
/** Buddy 登录服务：轮询式登录 + refresh_token 静默续期。 */
export declare class BuddyAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置（CodeBuddy 或 WorkBuddy）。 */
    readonly product: BuddyProduct;
    /**
     * 本实例默认读写的凭据 ref 名称。
     * CodeBuddy 为 `BUDDY_ACCESS_TOKEN`，WorkBuddy 为 `WORKBUDDY_ACCESS_TOKEN`；
     * 两个产品各自读写自己的 ref，凭据互不可见。
     */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    constructor(ctx: Context, options?: {
        fetcher?: typeof fetch;
        product?: BuddyProduct;
        serviceName?: string;
    });
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
    private markRefreshTokenInvalid;
    /** 运行登录流程并持久化凭据。 */
    login(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & BuddyLoginFlowOptions): Promise<BuddyLoginResult>;
    /**
     * 保存凭据并注册到账号池（供后台登录流程使用）。
     * 账号池已预先创建占位条目时，只做凭据写入和更新。
     */
    saveCredential(credentialJson: string, refName: string, accountId: string, pool: AccountPool): Promise<void>;
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    status(): Promise<BuddyLoginStatus>;
    /** 静默续期：refresh_token 换取；无 refresh_token 时明确报错（由命令提示重新登录）。 */
    refresh(): Promise<void>;
    /**
     * 用给定凭据换新令牌并合并字段（不触碰存储、调度器与错误状态）。
     *
     * 抽出来供 {@link refresh} 与 {@link refreshAccountCredential} 共用，
     * 避免两处各写一遍「换 token → 合并字段」而逐渐分叉。
     */
    private refreshCredential;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（这是修复既有缺陷的关键）：
     * - `refresh()` 读写的是本实例的**默认单凭据 ref**（如 `BUDDY_ACCESS_TOKEN`），
     *   而 Jet Hub 的账号卡片对应的是 `BUDDY_ACCOUNT_XXX` ——
     *   用 `refresh()` 去刷账号池里的账号，实际刷的是另一个凭据；
     * - 本方法也**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     *   那些状态属于「单凭据路径」，被多账号操作污染会让 UI 显示错误的失效提示。
     *
     * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT）：UI 卡片读的是池值，
     * 只更新凭据会让「已过期」的红字在续期成功后依然挂着，用户无处自救。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量续期本产品的所有账号。
     *
     * **包含已停用账号**（只按 `refreshable` 过滤）。
     *
     * 为什么不能跳过停用账号（真实缺陷）：停用只应影响「账号池的自动选号」，
     * 不该让凭据烂掉。早期实现有 `if (!entry.enabled ...) continue`，于是停用
     * 一段时间后 refresh_token 过期，用户重新启用时拿到的是一个死凭据 ——
     * 表现为「账号显示凭证过期」且**无法自动恢复**，只能重新登录。
     * 更糟的是停用账号仍会出现在 Jet Hub 里并参与积分领取，于是点「一键领取」
     * 时用过期凭据打腾讯接口，服务端回 HTML 错误页 → 前端报
     * `Unexpected token '<'`。续期不该依赖「是否参与自动选号」。
     *
     * 单账号失败不影响其他账号，但失败**必须留日志**：静默的实现会让账号
     * 在 UI 上永远显示「可续期」却刷不动，用户与开发者都拿不到线索。
     *
     * ⚠️ **lead-time 过滤**（issue !IKIRTT）：距过期不足 1 小时才发续期请求，
     * 跳过的账号只做有效期对账。详见 `refreshAccountWithReconcile`。
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
     * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
     * 失败或未登录时返回空数组（调用方回退到内置列表）。
     *
     * 优先使用账号池中的可用账号；无账号池或池为空时回退到固定凭据 ref。
     *
     * **关键**：两处调用都必须把 `this.product` 传给 `fetchModels`，否则
     * WorkBuddy 实例（Task 7 的 `fetchRemoteModels: () => workbuddy.fetchModels(pool)`）
     * 会以 `X-Product-Code: codebuddy` + CodeBuddy 的 UA 请求 /v3/config，
     * 即携带另一个产品的身份标识。
     */
    fetchModels(pool?: AccountPool): Promise<BuddyRemoteModel[]>;
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
}
/**
 * 构造腾讯系（buddy / workbuddy）适配器的 `refresh` 回调。
 *
 * ⚠️ **必须刷新 `resolveCredential` 实际用到的那一个账号**，而不是
 * {@link BuddyAuth.refresh} 读写的默认单凭据 ref（`BUDDY_ACCESS_TOKEN` /
 * `WORKBUDDY_ACCESS_TOKEN`）。错配的后果是**整轮不可恢复的失败**
 * （真实缺陷，2026-09-26 由用户报障定位：账号池里 5 个 workbuddy 账号、
 * 凭据全部有效，却一直报「未配置凭据，请先登录」）：
 *
 * 1. Jet Hub 的登录入口只写 `WORKBUDDY_ACCOUNT_XXX`，**从不写**那个固定
 *    ref —— 于是适配器在 `buddy-adapter.ts` 的 401/403 分支调 `refresh()`
 *    时，本类 `refresh()` 里的 `resolve` 恒为 null，抛
 *    「未配置凭据，请先登录」。该文案**完全是误导**：账号池里凭据齐全。
 * 2. 那个 401/403 分支在刷新后即返回（修复前），**不走**账号轮换 ——
 *    池里其余可用账号一个也用不上。
 * 3. 刷新抛错前没有写回任何凭据 → 下一轮仍取池首账号 → 再次 401 →
 *    再次同一条死路，表现为「中断后继续 goal 永远复现同一错误」的
 *    **自锁**，重试与重启都无效。
 *
 * 池内无账号时才回退到 {@link BuddyAuth.refresh}（单凭据路径，供未迁移的
 * 老数据）。与 LobsterAI / Qoder / TRAE 的既有实现同形。
 */
export declare function createPoolRefresh(pool: AccountPool, productId: string, auth: Pick<BuddyAuth, 'refreshAccountCredential' | 'refresh'>): () => Promise<void>;
//# sourceMappingURL=buddy-auth.d.ts.map