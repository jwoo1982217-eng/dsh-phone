/**
 * Raccoon Work 认证服务。
 *
 * ## 与其余 provider 的差异
 *
 * | 维度 | raccoon | 对照 |
 * |---|---|---|
 * | 登录 | 微信扫码 + 短信（本地页承载） | Loomy 同型 |
 * | 续期 | **有** `refresh_token` 轮换 | Loomy 没有（恒 false） |
 * | 凭据过期 | JWT `exp` 本地解码 | 比 Loomy 的「登录时刻 + 14 天推算」更准 |
 *
 * ## 两条硬约束（来自 AGENTS.md 的真实缺陷）
 *
 * 1. **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`** ——
 *    停用只影响账号池的自动选号，与「凭据是否需要保持新鲜」无关。
 *    早期按 `enabled` 过滤导致两个停用账号的 refresh_token 被放到失效。
 * 2. **`refreshAccountCredential(refName)` 只读写传入的 ref** ——
 *    账号卡片要刷的是 `RACCOON_ACCOUNT_XXX`，而 `refresh()` 读写默认单凭据 ref。
 *    错配的后果是「刷了另一个凭据」（本插件在 Cline 上踩过同类坑）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AccountPool } from './account-pool.js';
import type { ClaimOutcome, CreditBalance } from './credits.js';
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
import { type StartedRaccoonLoginFlow } from './raccoon-login-page.js';
/** 默认凭据 ref 名称（与 `RaccoonProduct.defaultCredentialRef` 一致）。 */
export declare const RACCOON_CREDENTIAL_REF = "RACCOON_ACCESS_TOKEN";
/**
 * 续期令牌失效。
 *
 * 单独一个类而不是 `Error`：调用方据此区分「需要重新登录」（终态）
 * 与「暂时性失败」（可重试），分别决定 UI 文案与是否继续重试。
 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 登录/续期后的结果（与 `LoomyLoginResult` 同构）。 */
export interface RaccoonLoginResult {
    /** 已存储的凭据 JSON 字符串。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 凭据值存储所用的凭据引用。 */
    ref: CredentialRef;
    /** 是否可续期（取决于是否存在 refresh_token）。 */
    refreshable: boolean;
}
/** 只读登录状态。 */
export interface RaccoonLoginStatus {
    configured: boolean;
    source?: string;
    expiresAt?: number;
    refreshable: boolean;
    refreshError?: string;
}
/** 远端模型条目（已归一）。 */
export interface RaccoonRemoteModel {
    id: string;
    /** **已规范化**的展示名（含倍率）。 */
    name: string;
    contextWindow: number;
    maxTokens: number;
    supportsImage: boolean;
}
/** `RaccoonAuth` 的构造选项。 */
export interface RaccoonAuthOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link RACCOON}。 */
    product?: RaccoonProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `raccoonAuth`）。 */
    serviceName?: string;
}
/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export declare function parseRaccoonCredential(value: string): RaccoonCredential | undefined;
/**
 * Raccoon Work 认证服务。
 *
 * 登录走**本地页承载**的扫码/短信双路径（见 `raccoon-login-page.ts`），
 * 续期走 `refresh_token` 轮换（与 Loomy 不同）。
 */
export declare class RaccoonAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: RaccoonProduct;
    /** 本实例默认读写的凭据 ref 名称。 */
    readonly credentialRefName: string;
    /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
    private lastRefreshError;
    constructor(ctx: Context, options?: RaccoonAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
    /**
     * 启动登录（微信扫码 + 短信双路径）。
     *
     * 起本地服务器承载弹窗页，**立即返回 `loginUrl`** —— 与其余 provider 的
     * 「两步式」契约一致（`window.open` 只在用户手势窗口内有效，
     * 不能等流程跑完再返回）。
     */
    startLogin(): Promise<StartedRaccoonLoginFlow>;
    /**
     * 把登录结果落盘成凭据。
     *
     * 与 `startLogin` 分开：流程编排（本地服务器 + 轮询 + 表单）在
     * `raccoon-login-page.ts` 里，本方法只负责「补全用户信息 + 写凭据 +
     * 静默领取一次性登录奖励」。
     */
    persistLogin(credential: RaccoonCredential, flowOptions?: {
        refName?: string;
    }): Promise<RaccoonLoginResult>;
    /** 只读登录状态。 */
    status(): Promise<RaccoonLoginStatus>;
    /** 解析默认 ref 的凭据。 */
    private resolveDefaultCredential;
    /**
     * 续期默认单凭据。
     *
     * @throws {RefreshTokenExpiredError} refresh_token 失效（需重新登录）。
     */
    refresh(): Promise<void>;
    /**
     * 续期**指定 ref**（RPC `account.refresh` / 定时器）。
     *
     * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref —— 账号池里的是
     * `RACCOON_ACCOUNT_XXX`，用 `refresh()` 会刷错凭据。
     * ⚠️ **不触碰** `lastRefreshError`：那属于单凭据路径，
     * 被多账号操作污染会让 UI 显示错误的失效提示。
     *
     * ⚠️ **必须把新过期时间写回账号池**（真实缺陷，用户报障）：
     * 只更新凭据、不更新账号池，会让 Jet Hub 一直显示「已过期」——
     * 因为 UI 读的是账号池的 `expiresAt`，而它停留在续期前的旧值。
     * 实测该账号的 JWT `exp` 已是 15:09（有效），账号池却是 12:02（已过期），
     * **相差 3.1 小时**，UI 显示「已过期」但发消息完全正常。
     *
     * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
     * @param accountId 账号 id。**调用方已知时请显式传入** ——
     *   否则只能按凭据内容反查（`findAccountIdByCredential` 遍历账号、
     *   逐个解析凭据比对，代价高且需要账号池具备凭据访问能力）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 说明：原先这里有一份私有的 `syncAccountExpiry`（把续期后的过期时间写回
     * 账号池，失败只记日志不上抛）。它已被抽到 `src/expiry-sync.ts` 成为九个
     * provider 共用的实现 —— 三条硬规矩（失败不反噬、优先用调用方的 accountId、
     * 反查要传**凭据内容**而非 ref 名）都随之外移并记在那份文件的注释里。
     */
    /**
     * 批量续期本产品的账号。
     *
     * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**：停用只影响账号池的
     * 自动选号，与「凭据是否需要保持新鲜」无关。早期按 `enabled` 过滤导致
     * 两个停用账号的 refresh_token 在停用期间被放到失效（真实缺陷，见 AGENTS.md）。
     *
     * 单账号失败不影响其他账号（且**必须留日志**：曾完全静默的实现
     * 让「续期永远失败但 UI 显示可续期」无法排查）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /** 登出：清除默认单凭据。 */
    logout(): Promise<void>;
    /**
     * 拉取远端模型目录。
     *
     * ⚠️ 失败时返回**空数组**：适配器据此回退兜底表。
     * 让模型目录失败不抛错，是为了不让整个 provider 在模型选择器里报错。
     */
    fetchModels(pool?: AccountPool): Promise<RaccoonRemoteModel[]>;
    /** 取一个可用凭据（先账号池，再默认 ref）。 */
    private resolveForFetchModels;
    /** 查询积分余额（供 Jet Hub 账号卡片）。 */
    fetchCreditBalance(credential: RaccoonCredential): Promise<CreditBalance | null>;
    /** 领取一次性登录奖励。 */
    claimLoginReward(credential: RaccoonCredential): Promise<ClaimOutcome>;
    /** 查询一次性登录奖励是否已领。 */
    fetchOnboardingStatus(credential: RaccoonCredential): Promise<{
        claimed: boolean;
        points: number;
    }>;
    /**
     * 一次性修复**老账号**的昵称与凭据字段（启动时调用）。
     *
     * ## 为什么需要它
     *
     * 早期实现有两处不足，导致**已登录的账号不会自动更正**：
     *
     * 1. 账号昵称直接用了服务端的 `name`（实测 `RaccoonAva` —— 它是服务端
     *    **自动生成的默认名**，注册第二个账号时会重名、无法区分）；
     * 2. 凭据里**没有存 `phone`**（后来才发现 `user_info.phone` 可用于消歧）。
     *
     * 光改代码只影响**新登录**的账号，老账号的昵称/凭据仍是旧值。
     * 故这里主动补一次：读凭据 → 缺 `phone` 就拉一次 `user_info` 补上 →
     * 用 `buildRaccoonNickname` 重算昵称并写回账号池。
     *
     * ## 语义约束
     *
     * - **幂等**：昵称已是目标形态时不写（避免每次启动都落盘）。
     * - **失败不阻塞启动**：单个账号失败只记日志，抛错由调用方 catch。
     * - **不发写请求**：只调只读的 `user_info`，不碰积分领取端点。
     * - `buildNickname` 由调用方注入（它依赖 `jet-hub-rpc` 里的纯函数，
     *   而那个模块依赖本模块 —— 注入避免循环依赖）。
     *
     * @returns 被修复的账号 id 列表（供日志）。
     */
    repairAccountNicknames(pool: import('./account-pool.js').AccountPool, buildNickname: (credential: Pick<RaccoonCredential, 'nickname' | 'phone' | 'user_id'>, fallbackId: string) => string): Promise<string[]>;
}
/**
 * 解析 `GET /model_catalog` 响应。
 *
 * 只取 `categories[].type === 'chat'` 的那个分类（实测只有一个），
 * 过滤 `visible === false`，并用 `raccoonDisplayName` 生成含倍率的展示名。
 */
export declare function parseRaccoonModelCatalog(payload: unknown): RaccoonRemoteModel[];
//# sourceMappingURL=raccoon-auth.d.ts.map