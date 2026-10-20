/**
 * MiniMax Code 认证服务。
 *
 * 登录走 **OAuth 设备码 + PKCE**（见 `minimax-oauth.ts`），
 * 续期走 `refresh_token` grant。
 *
 * ⚠️ **`refreshAll` 只按 `refreshable` 过滤，不看 `enabled`**
 * （AGENTS.md「续期不得按 enabled 过滤」的真实缺陷教训）。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import { type ExpiryAccessors } from './expiry-sync.js';
import { type MinimaxProduct } from './minimax-product.js';
import { type MinimaxCredential, type MinimaxModelEntry } from './minimax.js';
import { type MinimaxDeviceAuthorization } from './minimax-oauth.js';
/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里是 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts:67` 记录的坑）。
 *
 * ⚠️ `refreshableOf` 提供时共享实现会据此写池里的 `refreshable`。
 * MiniMax **确实有** refresh 端点，故提供它是**诚实**的
 *（与 Loomy 相反 —— 那边恒 false 故刻意不提供）。
 */
export declare const MINIMAX_EXPIRY_ACCESSORS: ExpiryAccessors<MinimaxCredential>;
/** refresh_token 已失效，需要重新登录。 */
export declare class MinimaxRefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export declare function parseMinimaxCredential(value: string): MinimaxCredential | undefined;
/** 认证服务选项。 */
export interface MinimaxAuthOptions {
    /** 产品配置；默认 {@link MINIMAX}。 */
    product?: MinimaxProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `minimaxAuth`）。 */
    serviceName?: string;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /** 注入的 sleep（测试用）。 */
    sleep?: (ms: number) => Promise<void>;
}
/** 登录流程句柄。 */
export interface StartedMinimaxLoginFlow {
    /** 用户点开的授权链接（**含 user_code**）。 */
    loginUrl: string;
    /** 授权完成后的凭据。 */
    result: Promise<MinimaxCredential>;
    /** 放弃本次登录。 */
    close: () => void;
}
/** MiniMax Code 认证服务。 */
export declare class MinimaxAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: MinimaxProduct;
    /** 本实例默认读写的凭据 ref 名称。 */
    readonly credentialRefName: string;
    private lastRefreshError;
    constructor(ctx: Context, options?: MinimaxAuthOptions);
    private get fetchImpl();
    /** 申请设备码（供 RPC 提前拿到 loginUrl）。 */
    fetchDeviceAuthorization(): Promise<MinimaxDeviceAuthorization>;
    /**
     * 两步式登录：**立即**返回 `loginUrl`，后台轮询。
     *
     * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
     * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
     */
    startLogin(): Promise<StartedMinimaxLoginFlow>;
    /**
     * 落盘凭据（登录成功后调用）。
     *
     * ⚠️ 返回 `accountId` 供调用方构造展示名。
     */
    persistLogin(credential: MinimaxCredential, options: {
        refName: string;
        nickname?: string;
    }): Promise<{
        accountId?: string;
    }>;
    /** 解析默认单凭据。 */
    private resolveDefaultCredential;
    /** 续期默认单凭据。 */
    refresh(): Promise<void>;
    /**
     * 续期**指定 ref**（RPC `account.refresh` / 定时器）。
     *
     * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
     * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
     * 也把池值对账（见 `refreshAll` 的注释）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量续期：**只按 `refreshable` 过滤，不看 `enabled`**。
     *
     * ⚠️ **必须走共享实现 `refreshAccountWithReconcile`**（`src/expiry-sync.ts`），
     * **不要**手写对账逻辑。九个既有 provider 里**八个**都用它
     *（buddy / cline / lobsterai / qoder / service / trae / loomy / raccoon 的部分路径）；
     * 手写版本会在「凭据仍有效」的分支漏掉池值对账，导致 UI **永远**显示「已过期」
     * —— 那正是 `src/expiry-sync.ts` 模块注释记录的真实缺陷。
     *
     * 照 `src/cline-auth.ts` 的 `refreshAll` 形态（它是最规范的一份）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 续期给定凭据（供 `refreshAccountWithReconcile` 的 `refresh` 回调）。
     *
     * ⚠️ **不落盘** —— 落盘由共享实现的 `save` 回调负责。
     */
    refreshCredentialFor(credential: MinimaxCredential): Promise<MinimaxCredential>;
    /**
     * 拉取远端模型目录（给定凭据）。
     *
     * ⚠️ **测试专用入口**（无需账号池）：`fetchModels` 是它的薄包装。
     */
    fetchModelsWith(credential: MinimaxCredential): Promise<readonly MinimaxModelEntry[]>;
    /**
     * 拉取**裸**远端目录：拿到就是拿到，拿不到一律 `undefined`（**不**回退兜底表）。
     *
     * 这是全插件唯一一处真正解析远端模型目录的地方；两个公开入口的差别只在
     * 「拿不到时回吐什么」：
     * - {@link fetchModelsWith} / {@link fetchModels} ⇒ **展示侧**语义，回退兜底表；
     * - {@link fetchRemoteModelsOnly} ⇒ **接线侧**语义，回 `[]`。
     *
     * ⚠ 把这个区分做在**这里**（而不是让接线自己去比对结果与兜底表）是刻意的：
     * 兜底表内容可以被改写，若远端下发的恰好与兜底表相同，「比较内容」的判据会把
     * 一次成功的拉取误判为失败。只有「解析函数返回了几个条目」这个**内部事实**
     * 能可靠区分两者。
     */
    private fetchRawModels;
    /** 拉取远端模型目录（账号池版本）。 */
    fetchModels(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]>;
    /** 目录拉取用哪份凭据：账号池优先，其次插件自存的默认凭据。 */
    private resolveModelsCredential;
    /**
     * 只取**真远端**目录；未登录 / 上游失败 / 解析出 0 条 ⇒ `[]`。
     *
     * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
     *
     * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
     * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
     * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
     * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
     * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
     *
     * 日志语义与 {@link fetchModelsWith} 一致（失败 / 解析 0 条都留 warn），
     * 只是**不**把兜底表当结果返回。
     */
    fetchRemoteModelsOnly(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]>;
}
/**
 * 解析远端目录响应。
 *
 * 校验（照 asar `parseSnapshot`）：`providers[]` 含 `providerId === 'minimax'`、
 * `config.models` 是非空对象；逐条经 {@link normalizeMinimaxModel} 归一。
 */
export declare function parseMinimaxModelsPayload(payload: unknown): readonly MinimaxModelEntry[];
//# sourceMappingURL=minimax-auth.d.ts.map