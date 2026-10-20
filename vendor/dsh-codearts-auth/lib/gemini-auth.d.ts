/**
 * Gemini（Cloud Code Assist）认证服务。
 *
 * 登录走**浏览器回调式 OAuth**（见 `gemini-oauth.ts`：本地 `createServer` 起回调、
 * 立即返回 `loginUrl`），续期走 `refresh_token` grant。
 *
 * ## ⚠️ `refreshAll` 照 `src/service.ts:406`（codearts）范式，**不照** `minimax-auth.ts:281`
 *
 * 旧范式第一行是 `if (!entry.refreshable) continue` —— 那让这个布尔变成一道
 * **单向门**：任何一次把它写成 false 的路径都会让该账号此后**永远不进循环**，
 * 「自动续期没工作、重启也还是 401」，而凭据本体可能完全健康。
 * 现在的口径：`refreshable` 只是**凭据材料的镜像**，每轮由凭据本体对账得出；
 * 缺材料才写 false，凭据齐全而被误写成 false 时本轮**自动改回 true（自愈）**。
 *
 * 本方法**不看 `enabled`**：停用只应影响账号池的自动选号，不该让凭据烂掉。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import { type ExpiryAccessors } from './expiry-sync.js';
import { type GeminiCredential, type GeminiProduct } from './gemini.js';
import { type StartedGeminiLoginFlow } from './gemini-oauth.js';
/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里取 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts:67` 记录的坑）。
 *
 * `refreshableOf` 是**诚实**的：Gemini 确实有 refresh 端点（`oauth2.googleapis.com/token`
 * 的 `refresh_token` grant），故提供它，让共享实现据此把池里的 `refreshable` 对账。
 */
export declare const GEMINI_EXPIRY_ACCESSORS: ExpiryAccessors<GeminiCredential>;
/** refresh_token 已失效，需要重新登录。 */
export declare class GeminiRefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 认证服务选项。 */
export interface GeminiAuthOptions {
    /** 产品配置；默认 {@link GEMINI}。 */
    product?: GeminiProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `geminiAuth`）。 */
    serviceName?: string;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /** 回调端口覆盖（0 = 动态端口，默认）。 */
    callbackPort?: number;
}
/** 登录流程句柄（与 `gemini-oauth.ts` 同形，此处直接复用其类型）。 */
export type { StartedGeminiLoginFlow } from './gemini-oauth.js';
/** Gemini 认证服务。 */
export declare class GeminiAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: GeminiProduct;
    /** 本实例默认读写的凭据 ref 名称。 */
    readonly credentialRefName: string;
    /**
     * per-ref 续期互斥队列。
     *
     * ⚠️ 没有它时，「定时续期」与「按需续期」可能并发消费**同一份**
     * `refresh_token`：Google 对 refresh_token 有重放检测，交错请求会让其中一次
     * 拿到 `invalid_grant`，进而被误判成「终态失效」把好账号标死。
     */
    private readonly refreshQueues;
    /** 终态告警去重：同账号同服务端原因只告警一次。 */
    private readonly terminalWarned;
    constructor(ctx: Context, options?: GeminiAuthOptions);
    private get fetchImpl();
    private queueFor;
    private readCredential;
    /** 按值比较两份凭据（引用比较恒不相等）。 */
    private sameCredential;
    /**
     * 两步式登录：**立即**返回 `loginUrl`，浏览器回调完成后落定 `result`。
     *
     * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
     * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
     */
    startLogin(): Promise<StartedGeminiLoginFlow>;
    /**
     * 落盘凭据（登录成功后调用）。
     *
     * ⚠️ 返回的 `accountId` 是 OIDC `sub` —— 它只适合当**稳定标识**
     *（换邮箱、改昵称都不影响），**不要**拿它拼展示名：`sub` 是 21 位数字，
     * 截前 8 位得到 `Gemini 10500520` 这种用户认不出的名字（2026-10-03 报障）。
     * 展示名走 `geminiAccountLabel`（邮箱优先，回退 `sub`）。
     */
    persistLogin(credential: GeminiCredential, options: {
        refName: string;
    }): Promise<{
        accountId?: string;
    }>;
    /** 解析默认单凭据。 */
    private resolveDefaultCredential;
    /** 续期默认单凭据（`refreshTargets` 的兜底路径）。 */
    refresh(): Promise<void>;
    /**
     * 续期**指定 ref**（RPC `account.refresh` / 定时器）。
     *
     * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
     * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
     * 也把池值对账（否则 UI 会永远显示「已过期」）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量续期所有 Gemini 账号。
     *
     * **包含已停用账号**：停用只应影响自动选号，不该让凭据烂掉 ——
     * 否则用户重新启用时只能重新登录。
     *
     * 单账号失败不影响其他账号，但**必须留日志**：静默失败会让账号在 UI 上
     * 仍显示「可续期」却永远刷不动，无从排查。
     *
     * ⚠️ 判据读**凭据**，不读账号池里的 `refreshable`（见文件头注释）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 一次性修复**老账号**的展示名（与 `RaccoonAuth` / `TraeAuth` 同一模式）。
     *
     * 成因：2026-10-03 之前的版本在解析令牌响应时丢掉了 `id_token`，身份只剩
     * 「userinfo 那次跨域请求」这一个失败面；它一失败（且当时**静默吞异常**），
     * 凭据就只落了 token 而无 `sub`/`email`，`geminiAccountLabel` 返 `undefined`，
     * 账号昵称于是退化成一串池 id（`gemini-6a53dbca`），用户认不出是谁。
     *
     * 光改代码只影响**新登录**的账号，故这里在启动时主动补一次。
     *
     * ## 契约
     *
     * - **幂等**：昵称已是目标值时不算变化，不触发写入。
     * - **失败不阻塞**：逐账号 catch，任何异常只记 warn。
     * - **只读补字段**：最多发一次 userinfo GET（不续期、不换 token），
     *   且**拿不到就什么都不做** —— 绝不退回去用凭据里的池 id 重算昵称，
     *   那会覆盖掉用户在 Jet Hub 里手动改过的昵称。
     *
     * @returns 被修复的账号 id 列表（供日志）
     */
    repairAccountNicknames(pool: AccountPool): Promise<string[]>;
    /**
     * 锁内续期：轮到自己时**重读**当前凭据，若已被他处续好就跳过本次请求。
     *
     * 队列只保证同一 ref 的续期串行，管不到「另一个进程/另一条路径刚刷完」；
     * 那种情况下再发一次请求会白白消费一次 refresh_token（Google 有重放检测）。
     */
    private refreshCredentialUnderLock;
    /**
     * 用 refresh_token 换取一份新凭据（**不触碰存储**）。
     *
     * 抽出来供 `refresh` / `refreshAccountCredential` / `refreshAll` 共用 ——
     * 一旦字段合并逻辑分叉，就会出现「某条路径丢了 sub/email」。
     */
    private refreshCredential;
}
//# sourceMappingURL=gemini-auth.d.ts.map