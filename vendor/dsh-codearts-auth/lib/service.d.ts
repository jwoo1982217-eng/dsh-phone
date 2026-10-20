import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { LoginFlowOptions } from './types.js';
import { AccountPool } from './account-pool.js';
/**
 * CodeArts 历史单凭据 ref 常量。
 *
 * ⚠️ **单凭据模式已移除**，此常量不再有读取方 —— 保留仅为兼容既有调用签名
 * （`login` / `startLogin` 的 `refName` 缺省值）与外部可能的引用。
 * 凭据一律存放在账号池条目对应的 `CODEARTS_ACCOUNT_XXX` 下。
 */
export declare const CODEARTS_CREDENTIAL_REF = "CODEARTS_ACCESS_TOKEN";
/** 一次成功登录的结果。 */
export interface LoginResult {
    /** 已存储的凭据值（原始令牌或 JSON 凭据字符串）。 */
    access: string;
    /** 凭据过期的毫秒时间戳。 */
    expires: number;
    /** 凭据值存储所用的凭据引用。 */
    ref: CredentialRef;
    /** 打开的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token（新式 OAuth 流程为 true）。 */
    refreshable: boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        codeartsAuth: CodeArtsAuth;
    }
}
/**
 * CodeArts 登录服务：新式 IAM OAuth（ticket 流程回退）+ refresh_token 静默续期。
 *
 * ## ⚠️ 仅支持**账号池**（单凭据模式已移除）
 *
 * 所有凭据都存放在账号池条目对应的 `CODEARTS_ACCOUNT_XXX` ref 下，由
 * Jet Hub 设置页管理。早期还存在一条「单凭据模式」（登录写固定 ref
 * `CODEARTS_ACCESS_TOKEN`，适配器在账号池取不到时回退读它）—— **已移除**：
 *
 * - 适配器的 `resolveCredential` 只查账号池；
 * - `codearts-login` / `codearts-status` / `codearts-refresh` 三个斜杠命令已删除
 *   （登录/状态/续期统一在 Jet Hub 完成，与其余五个 provider 一致）；
 * - 因此 `status()` / `refresh()` / `logout()` / 单凭据调度器等**只服务于单凭据
 *   路径**的方法一并移除，避免留下会去读写已废弃 ref 的死代码。
 *
 * 续期有两条账号池路径，都**不触碰任何「单凭据状态」**：
 * - {@link refreshAccountCredential}：按 ref 刷**指定账号**（由 RPC `account.refresh`
 *   驱动 —— ⚠️ 该端点**没有面板入口**，账号卡片的按钮是 测试/重测/重置/停用/代理/
 *   指纹/删除；调用方是仓库外的脚本/手工 RPC）；
 * - {@link refreshAll}：批量刷全部账号（`src/index.ts` 的定时调度器）。
 */
export declare class CodeArtsAuth extends Service {
    /** 登录会话是否仍处于活跃状态；stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    /** 用于测试的可注入 fetch；默认为全局 fetch。 */
    private fetchImpl;
    /**
     * 按凭据 ref 分的**续期互斥队列**（进程内）。
     *
     * 为什么必须有它（本次 401 的直接成因之一）：CodeArts 有三条各自独立的续期入口
     * 会并发消费**同一份** refresh_token ——
     * ① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
     * ② 推理路径的按需续期（`llm-adapter.ts` 的「过期预判」与「401 兜底」）；
     * ③ RPC `account.refresh`（⚠️ **无面板入口**，调用方是仓库外脚本）。
     * 而 DSH 本身还会并发发起多条模型请求（主回复 + 标题生成 + 上下文压缩），
     * 每条都可能独立走到 ②。华为 STS 在签发新凭据时**旧的那一份 refresh_token
     * 即失效**，于是并发下必然出现「1 个成功、其余全部 `invalid_grant`」，
     * 而失败方把它读成「refresh_token 已失效」并据此作废整个账号。
     *
     * ⚠️ 这把锁只在**本进程**内有效。多实例（如同一台机器上的 dsh web 与 desktop）
     * 各自持锁，跨进程互踩仍会发生 —— 那部分靠 `refreshAll` 里
     * 「判终态前先重读凭据」的防护兜住（两处都必须有，少一个都会复发）。
     */
    private readonly refreshQueues;
    /**
     * 已就「refresh_token 失效」告警过的 ref → 上次告警的服务端原文。
     *
     * 同一账号连续多轮撞上同一个终态错误时只说一次，避免每 30 分钟刷满日志；
     * 错误原文一变（说明状况变了）就重新告警。
     */
    private readonly terminalWarned;
    constructor(ctx: Context, options?: {
        fetcher?: typeof fetch;
    });
    /** 取（或建）某个凭据 ref 的续期队列。 */
    private queueFor;
    /** 读取某个凭据 ref 下的当前凭据；缺失或不可解析时 undefined。 */
    private readCredential;
    /**
     * 判断两份凭据是否「同一份」（用于识别他处是否已经续过）。
     *
     * ⚠️ 必须**按值**比：`parseCredential` 每次都产生新对象，引用比较恒为「不相等」，
     * 会让幂等短路在每一轮都误判成「凭据已更新」。
     */
    private sameCredential;
    /** 运行登录流程（默认新式 OAuth；flow: 'ticket' 走旧流程回退）并持久化凭据。 */
    login(options?: {
        flow?: 'oauth' | 'ticket';
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & LoginFlowOptions): Promise<LoginResult>;
    /**
     * **两步式登录**：起回调服务器并立即返回登录 URL，由调用方先打开窗口。
     *
     * 为什么需要它（真实缺陷）：Jet Hub 的「+ 新建账号」原先调用阻塞式
     * {@link login}，而浏览器只在用户点击后的短暂窗口（transient activation，
     * 约 5 秒）内允许 `window.open`。等阻塞调用返回时手势早已过期，
     * `window.open` 被弹窗拦截器拒绝并返回 `null`，前端兜底逻辑便执行
     * `window.location.href = loginUrl`，把**整个设置页**跳转到登录页
     * ——用户看到的正是「主页面直接跳转过去了」。
     *
     * 与 CodeBuddy 系的做法对齐（那边是后端不 await、立即返回 loginUrl），
     * 因此三者现在都是「点击 → 弹出小窗 → 轮询等待」的同一交互。
     *
     * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
     */
    startLogin(options?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & LoginFlowOptions): Promise<{
        loginUrl: string;
        result: Promise<LoginResult>;
        close: () => Promise<void>;
    }>;
    /**
     * 持久化一次登录结果：写凭据、按需登记账号池。
     *
     * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
     * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致，
     * 否则两步式路径会静默缺少账号登记。
     *
     * ⚠️ 单凭据模式移除后，**凭据一律写入账号池条目对应的 ref**
     * （Jet Hub 传入的 `CODEARTS_ACCOUNT_XXX`）。`refName` 缺省时仍回退到历史常量
     * `CODEARTS_CREDENTIAL_REF`，但**已无任何读取方**，仅为兼容既有调用签名。
     */
    private persistLogin;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 这是 RPC `account.refresh` 与定时调度器走的路径，读写的是账号池条目
     * 对应的 `CODEARTS_ACCOUNT_XXX`。
     *
     * ⚠️ `account.refresh` **没有面板入口**（issue IKJOZA 取证：36 处 `rpcCall(` 里没有它，
     * `git log -S "rpcCall('account.refresh'"` 零命中），别照着旧注释去找「刷新」按钮。
     *
     * ⚠️ 早期这里的方法注释在对比一个 `refresh()` —— 那个方法读写固定单凭据 ref
     * `CODEARTS_ACCESS_TOKEN`，**已随单凭据模式一并移除**。当时用 `refresh()`
     * 去刷账号池里的账号会刷到另一个凭据上（真实缺陷），这也是 `account.refresh`
     * RPC 一定要按 `entry.credentialRef` 分派的原因。现在只剩本方法这一条路径。
     *
     * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT）：UI 读的是池值，
     * 只更新凭据会让「已过期」的红字在续期成功后**依然挂着**。
     *
     * @param pool 账号池；提供时把新 `expiresAt` / `refreshable` 写回。
     * @param accountId 账号 id，调用方已知时显式传入（反查会跳过已停用账号）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 加锁续期：拿到锁后**重读凭据**，只在他处还没续过的时候真的发请求。
     *
     * 与 {@link refreshAccountCredential} 共用同一条 per-ref 队列，因此
     * 「批量续期」「按需续期」「手动刷新」三条入口在同一进程内必然串行；
     * 锁内重读则是为了跨进程场景（同一台机器上 dsh web 与 desktop 两个实例）
     * 少烧一次 refresh_token —— 那种互斥锁管不到，只能靠「先看当前值」兜。
     *
     * @param credential 调用方读到的那份凭据（可能已经在等锁期间过期于他处）。
     * @returns 应当落盘并回写账号池的凭据。
     */
    private refreshCredentialUnderLock;
    /**
     * 用 refresh_token 换取一份新凭据（**不触碰存储**）。
     *
     * 抽出来供 `refreshAccountCredential()` 与 `refreshAll()` 共用 ——
     * 两处原先各写一遍「取密钥对 → 换取 → 合并无变化字段」，
     * 一旦字段合并逻辑分叉就会出现「某条路径丢了 `model_rate_limits`」。
     */
    private refreshCredential;
    /**
     * 批量续期所有 codearts 账号。
     *
     * **包含已停用账号**（只按凭据是否具备续期材料过滤）：停用只应影响账号池的自动
     * 选号，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
     * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
     *
     * 单账号失败不影响其他账号，但**必须留日志**：CodeArts 是九个 provider 里
     * 唯一整份文件没有一处 `logger` 的（issue !IKIRTT 的可观测性条目），
     * 而它的 access_token 只有约 2 小时寿命、最容易撞过期，失败无痕最难查。
     *
     * ⚠️ **lead-time 过滤**：距过期不足 1 小时才真的发续期请求（与单凭据时代
     * `REFRESH_LEAD_MS` 同语义），跳过的账号只做有效期对账。详见
     * `refreshAccountWithReconcile`。
     *
     * ## ⚠️ 调度判据读**凭据**，不读账号池里的 `refreshable`（本次 401 的根因）
     *
     * 旧实现第一行是 `if (!entry.refreshable) continue`。那让这个布尔变成一道
     * **单向门**：任何一次把它写成 false 的路径（服务端拒绝、并发重放烧掉
     * refresh_token、DPoP 校验没过被误判成终态……）都会让该账号在此后
     * **永远不进这条循环** —— 定时续期跳过它、启动首轮也跳过它，于是
     * 「自动续期没工作、重启也还是 401」，而凭据本体可能完全健康
     * （实测：refresh_token 还有 18 天寿命、`code_verifier` 与 DPoP 私钥都在）。
     *
     * 现在的口径：`refreshable` 只是**凭据材料的镜像**，由本方法每轮对账得出，
     * 不是「曾被服务端拒绝过」的案底。凭据有材料就照常尝试续期，缺材料才写 false；
     * 一旦被别的路径误写成 false 而凭据其实齐全，本轮会**自动改回 true**（自愈）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 停止服务：置 inactive，阻止在途刷新回写。
     *
     * 单凭据模式移除后这里不再需要停调度器 —— 登录态与续期都归属账号池条目，
     * 续期由 `src/index.ts` 的多账号调度器（{@link refreshAll}）驱动。
     */
    stop(): void;
    /**
     * 用**账号池里某个可用账号**的凭据从远端拉取模型列表；非空时更新内存缓存与磁盘。
     *
     * ⚠️ **必须传 `pool`**：CodeArts 已移除「单凭据模式」，不再有
     * `CODEARTS_ACCESS_TOKEN` 那样的固定 ref 可读 —— 凭据一律来自账号池条目
     * （`CODEARTS_ACCOUNT_XXX`）。早期签名不接收 `pool` 并直接读固定 ref，
     * 移除单凭据后那样会恒返回空列表。
     *
     * 为什么用「可用账号」而不是遍历全部账号：模型目录是**账号无关**的（同一个
     * 华为云账号体系下发同一份目录），取第一个能解析出 AK/SK 的账号即可，
     * 无需为每个账号各拉一次。
     */
    refreshModels(pool: AccountPool): Promise<Array<{
        id: string;
        name: string;
    }>>;
    /**
     * 取账号池里第一个**凭据可解析且含 AK/SK** 的账号凭据。
     *
     * 按 `readAccounts()` 的既有顺序（用户的 Jet Hub 拖拽顺序）遍历，短路返回。
     * `getAvailableAccount` 不适合这里：它会按 `enabled` 与限流状态过滤，而
     * 「拉模型目录」既不需要账号处于启用状态、也与限流无关。
     */
    private firstUsableCredential;
}
//# sourceMappingURL=service.d.ts.map