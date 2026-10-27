/**
 * Accio 认证服务。
 *
 * ## ⚠️⚠️ 续期：三条铁律，缺一不可（AGENTS.md 事故史）
 *
 * 1. **只按凭据材料过滤**（`refresh_token` 非空）
 *    - ⚠️ **不看 `enabled`**：停用只影响自动选号，与「凭据是否需要保鲜」无关。
 *      真实缺陷：两处都按 `enabled` 过滤 ⇒ 停用期间 refresh_token 一路放到失效，
 *      用户重新启用后拿到的是死凭据。
 *    - ⚠️ **也不按池里的 `refreshable` 过滤**：那个布尔是被对账的**结果**，
 *      拿它当门禁会把一次瞬时失败固化成**单向门**（codearts 真实事故）。
 * 2. **判终态前先重读凭据**：并发下服务端轮换的是**旧的**那一份，
 *    磁盘上此刻可能躺着一份**新的、可用的**凭据 ⇒ 那是「他处已续成功」，
 *    不是「本账号不可续期」。
 * 3. **per-`credentialRef` 串行**（`SerialQueue`）+ **锁内重读**。
 *
 * ## 为什么第 3 条对 Accio 尤其关键
 *
 * 参考实现明确记录「刷新会**轮换** refresh_token」。三条入口——
 * ① `src/index.ts` 的定时器（含启动首轮）、② 推理路径的按需续期
 * （DSH 会**并发**发主回复 + 标题生成 + 上下文压缩）、③ 面板「刷新」按钮——
 * 若不串行，必然「1 个成功、其余 `invalid_grant`」，而失败方会把**好账号标死**。
 *
 * ⚠️ **锁只在单进程内有效**：同机跑 web + desktop 两个实例时跨进程互踩，
 * 只能靠第 2 条兜 ⇒ **两处都得有**。
 *
 * ## ⚠️ 不注册任何斜杠命令
 *
 * 与其余 provider 一致：登录 / 续期 / 积分全部在 Jet Hub 设置页完成。
 *
 * ## 协议事实（2026-10-12 实测，详见 `docs/agent-notes/providers-accio.md`）
 *
 * - 标准 OAuth 2.0 + PKCE（公开客户端 `accio-work`，无 secret）⇒ **可完全脱离 IDE**；
 * - 回调落在**我们自己的** loopback（Accio 对 `return_url` 无白名单校验）；
 * - `expires_at` 上游给的是**秒**，`accio-oauth.ts` 已一次性归一化为毫秒。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type AccioFallbackModel, type AccioRegion } from './accio-product.js';
import { AccountPool } from './account-pool.js';
/**
 * 续期被服务端判定为**终态**（`refresh_token` 已不可用）时抛出的错误。
 *
 * ⚠️ **判据必须窄**：只有服务端明确说「这份 refresh_token 不认了」才算终态。
 * 网络抖动、5xx、超时、读体失败一律是**可重试**的普通 `Error` —— 把它们
 * 归为终态就是本仓库记录过的「一次瞬时失败固化成单向门」。
 * （同族的反例见 `docs/agent-notes/providers-*` 里 DPoP 那条：
 * `InvalidDPoPHeader` 说的是「这一次证明不合格」，与 token 能不能用无关。）
 */
export declare class AccioRefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 判断一次续期失败是不是**终态**（`refresh_token` 真的不能用了）。 */
export declare function isAccioTerminalRefreshError(error: unknown): boolean;
/**
 * 把外部传入的 region 归一化到白名单。
 *
 * ⚠️ 与 zcode 的 `normalizeZcodeLoginProvider` 同因（issue IKJLK3 E2）：
 * `region` 来自**客户端自报**的 RPC 载荷（没有 schema 校验），未登记的值会
 * 被原样写进凭据并决定登录域名。这里收敛到白名单，未知值回落 `'cn'`。
 */
export declare function normalizeAccioRegion(raw: unknown): AccioRegion;
/**
 * 把**一条**远端目录条目归一化为 `AccioFallbackModel`（与兜底表同形，
 * 便于适配器把「远端目录」与「兜底表」拼成一份、不必引入第二个模型类型）。
 *
 * ⚠️ `visible !== true` 一律剔除：不可见模型不该进目录。
 *
 * ⚠️ **这是全仓库唯一的 Accio 目录条目解析器**（`parseAccioCatalog` 也走它）。
 * 适配器（Task 6）应 `export { normalizeAccioModel } from './accio-auth.js'`
 * 复用本函数，**不要**再写第二份 —— 「同一份语义两套判据」是本仓库首条红线，
 * 而目录解析尤其容易分叉（`visible` / `multimodal` / `effectiveMultiple` 三处
 * 都是踩过坑的字段）。
 *
 * ⚠️ `supportsImage` 在这里是**二值投影**（`multimodal === true`）。设计文档
 * 要求 `inputModalities` 是**三态**（省略 = 未知，`['text']` = 明确不支持），
 * 而本字段表达不了「未知」—— 需要三态的一方（适配器）必须自己读原始
 * `multimodal`，**不要**把本字段的 `false` 当作「明确不支持」。
 */
export declare function normalizeAccioModel(raw: unknown): AccioFallbackModel | undefined;
/**
 * 解析 `POST /api/llm/config/v2` 的响应体（`data[].modelList[]`），
 * 按**倍率升序**（便宜在前）返回；无倍率的排最后。
 *
 * ⚠️ 目录**必须动态拉取**：`modelCode` 形如 `1Drift-N8kP2Q7wR5mX`（非人类可读），
 * 兜底表只作离线回退，无法凭名字手写维护。
 *
 * ⚠️ 适配器侧（Task 6）应直接消费 {@link AccioAuth.fetchModels} 的输出，
 * **不要**再写第二份目录解析 —— 同一份语义两套判据是本仓库的首条红线。
 */
export declare function parseAccioCatalog(body: unknown): AccioFallbackModel[];
/** Accio 的默认凭据 ref（单凭据路径的历史常量，多账号一律走 `ACCIO_ACCOUNT_XXX`）。 */
export declare const ACCIO_CREDENTIAL_REF: string;
/** 一次两步式登录的启动结果。 */
export interface StartedAccioLogin {
    /** 供前端**立即** `window.open` 的授权页地址。 */
    loginUrl: string;
    /** 用户完成授权（或超时/失败）后落定；**不 await 它也能拿到 loginUrl**。 */
    result: Promise<void>;
    /** 关闭回调服务器；**幂等**，可重复调用。 */
    close: () => void;
}
/**
 * 登录参数。
 *
 * ⚠️ `pool` / `accountId` 是**两步式占位条目**所需：本仓库的交互是
 * 「点击 → 弹出小窗 → 轮询 `login.poll`」，而 `login.poll` 靠
 * 「账号条目还在 + 凭据已写入」判断成功 ⇒ 必须先登记占位条目，
 * 失败时删除它（不留无凭据的幽灵账号）。
 */
export interface AccioLoginOptions {
    /** 登录区域（决定登录页域名）；缺省 `'cn'`。 */
    region?: AccioRegion;
    /** 凭据 ref 名；缺省 {@link ACCIO_CREDENTIAL_REF}。 */
    refName?: string;
    /** 账号池；与 `accountId` 成对提供时才登记 / 清理占位条目。 */
    pool?: AccountPool;
    /** 账号 id（由 RPC 的 `account.create` 生成）。 */
    accountId?: string;
}
/** `AccioAuth` 的构造选项。 */
export interface AccioAuthOptions {
    /** 注入的 fetch（测试用）；缺省全局 `fetch`。 */
    fetcher?: typeof fetch;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        accioAuth: AccioAuth;
    }
}
/**
 * Accio 认证服务：两步式 PKCE 登录 + per-ref 串行续期。
 */
export declare class AccioAuth extends Service {
    private readonly options;
    /** 本实例默认读写的凭据 ref 名称（`ACCIO_ACCESS_TOKEN`）。 */
    readonly credentialRefName: string;
    /**
     * 按凭据 ref 分的**续期互斥队列**（进程内）。
     *
     * 为什么必须有它（Accio 尤其致命）：参考实现记录「刷新会**轮换**
     * refresh_token」，而三条续期入口会并发消费**同一份** ——
     * ① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
     * ② 推理路径的按需续期（DSH 会并发发主回复 + 标题生成 + 上下文压缩）；
     * ③ Jet Hub 账号面板的「刷新」按钮。
     * 不串行必然「1 个成功、其余 `invalid_grant`」，而失败方会把**好账号标死**。
     *
     * ⚠️ 这把锁只在**本进程**内有效：同机跑 dsh web 与 desktop 两个实例时
     * 各自持锁、跨进程互踩仍会发生 —— 那部分靠 `refreshAll` 里「判终态前先
     * 重读凭据」的防护兜住（**两处都必须有**，少一个都会复发）。
     */
    private readonly refreshQueues;
    /**
     * 已就「refresh_token 失效」告警过的 ref → 上次告警的服务端原文。
     *
     * 同一账号连续多轮撞上同一个终态错误时只说一次，避免每 30 分钟刷满日志；
     * 错误原文一变（说明状况变了）就重新告警。
     */
    private readonly terminalWarned;
    /** 登录态是否活跃；`stop()` / `logout()` 置 false，阻止在途续期回写已登出的凭据。 */
    private active;
    constructor(ctx: Context, options?: AccioAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
    /** 取（或建）某个凭据 ref 的续期队列。 */
    private queueFor;
    /** 读取某个凭据 ref 下的当前凭据；缺失或不可解析时 undefined。 */
    private readCredential;
    /**
     * 判断两份凭据是否「同一份」（用于识别他处是否已经续过）。
     *
     * ⚠️ 必须**按值**比：`parseCredential` 每次都产生新对象，引用比较恒为
     * 「不相等」，会让幂等短路在每一轮都误判成「凭据已更新」。
     */
    private sameCredential;
    /** 记录一条警告（经 `ctx.logger`）。 */
    private warn;
    /**
     * 回写账号池的有效期（**失败只记日志、绝不上抛**）。
     *
     * `syncAccountExpiry` 自身已保证三条硬规矩：失败只 warn、优先用调用方给的
     * `accountId`、现值一致时不写盘；且**凭据里读不到过期时间时不覆盖池内旧值**
     * （写 `undefined` 落盘会被 `JSON.stringify` 丢弃，UI 会从「已过期」变成
     * 「未知」—— 保留旧信息更有价值）。
     */
    private syncExpiry;
    /**
     * 运行完整登录流程（**阻塞**：打开浏览器并等用户授权完成）。
     *
     * ⚠️ Jet Hub 的「+ 新建账号」**不得**用它 —— 浏览器只在用户点击后的短暂
     * 窗口（transient activation，约 5 秒）内允许 `window.open`，阻塞调用返回时
     * 手势早已过期，弹窗被拦后前端兜底会 `window.location.href = loginUrl`
     * 把整个设置页跳走。两步式请用 {@link startLogin}。
     */
    login(options?: AccioLoginOptions): Promise<void>;
    /**
     * **两步式登录**：起 loopback → 生成 PKCE/state → **立即**返回 `loginUrl`
     * （不打开浏览器、不等用户），后台再等回调。
     *
     * 顺序说明：**先监听拿到端口，再拼授权 URL** —— `return_url` 必须写实际
     * 端口，否则回调会打到没人监听的地址上。
     */
    startLogin(options?: AccioLoginOptions): Promise<StartedAccioLogin>;
    /** 两步式与阻塞式共用的实现（落库逻辑必须完全一致）。 */
    private startLoginFlow;
    /** 删除登录占位条目；**任何异常只记日志**（清理不该反噬登录结果）。 */
    private removePlaceholder;
    /** 用授权码换 token、写凭据、回填账号池（两步式与阻塞式共用）。 */
    private finishLogin;
    /**
     * 落盘凭据。
     *
     * ⚠️ **必须写调用方给的 ref**（Jet Hub 传的是 `ACCIO_ACCOUNT_XXX`），
     * 而不是本实例的默认单凭据 ref —— 后者会让「账号池里那个账号」拿不到凭据，
     * 表现为「登录成功、账号一发请求就报未配置凭据」（本仓库真实缺陷形态）。
     */
    private persistLogin;
    /**
     * 登录成功后回填账号池（占位条目的昵称 / 有效期 / 可续期标记）。
     *
     * ⚠️ 昵称暂时只有账号 id：兑换响应**不含任何身份字段**（`userinfo` 是另一个
     * 端点，属 Task 5 的 `accio-credits.ts`）。本任务刻意不 import 那个尚不存在的
     * 模块；它落地后可在登录成功后补一次 `userinfo` 拿真实昵称（与 Qoder 补昵称同款）。
     */
    private fillAccountEntry;
    /**
     * 按凭据 ref 续期**指定账号**的凭据（Jet Hub 账号卡片 / 定时器路径）。
     *
     * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：UI 账号
     * 卡片的「有效期」读的正是**池里的值**，而不是凭据里 access_token 的真实过期
     * 时间。只 `credentials.set` 的后果是「凭据续好了、界面一直显示已过期」，
     * 且没有任何自救手段（「重测」按钮的 refresh 是刻意的 no-op）。
     * ⇒ `pool` 与 `accountId` **在实际调用中必须传**（签名保持可选只为兼容既有形态）。
     *
     * @param pool 账号池；提供时把新 `expiresAt` / `refreshable` 写回。
     * @param accountId 账号 id。**调用方已知时请显式传入** —— 否则只能按凭据内容
     *   反查，而 Accio 的 `access_token` 每次都会轮换，反查**可能失效**。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 加锁续期：拿到锁后**重读凭据**，只在他处还没续过的时候真的发请求。
     *
     * 与 {@link refreshAccountCredential} 共用同一条 per-ref 队列，因此
     * 「批量续期」「按需续期」「面板刷新」三条入口在同一进程内必然串行；
     * 锁内重读则覆盖跨进程场景（同机 web + desktop 两个实例）—— 那种互斥锁
     * 管不到，只能靠「先看当前值」兜，少烧一次 refresh_token。
     *
     * @param credential 调用方读到的那份凭据（可能已在等锁期间被他处续期）。
     */
    private refreshCredentialUnderLock;
    /**
     * 对一份凭据执行一次续期并返回新凭据（**不触碰存储**）。
     *
     * 终态判定（只有服务端明确说 refresh_token 不认了才算）：
     * `isAccioTerminalRefreshError` 命中 ⇒ 抛 {@link AccioRefreshTokenExpiredError}；
     * 其余（网络抖动、5xx、超时、读体失败）⇒ 普通 `Error`，可重试。
     */
    private refreshCredential;
    /**
     * 批量续期本产品的所有账号（`src/index.ts` 的定时器，含启动首轮）。
     *
     * ## 两条**不得**过滤的铁律（各是一次真实事故）
     *
     * 1. **不看账号是否停用**：停用只应影响账号池的自动选号，与「凭据是否需要
     *    保鲜」无关。真实缺陷：两处都按停用过滤 ⇒ 停用期间 refresh_token 一路
     *    放到失效，用户重新启用后拿到的是**死凭据**，只能重新登录。
     * 2. **不按池里的 `refreshable` 过滤**：那个布尔是**每轮由凭据对账出来的
     *    结果**，不是「曾被服务端拒绝过」的案底。拿它当门禁会把一次瞬时失败
     *    固化成**单向门**（codearts 真实事故：池里 2 个账号被误标后
     *    「自动续期没工作、重启也还是 401」，而凭据本体完好）。
     *
     * ⇒ 权威判据只有**凭据材料**（`isAccioRefreshable`：`refresh_token` 非空）。
     * 凭据缺材料才写 false，且写前先比现值（定时器每 30 分钟一轮，别重复整体落盘）。
     *
     * ⚠️ **「本轮不刷」的分支绝不能直接跳过对账**：存量账号的凭据早已在别处
     * （IDE / 上一轮）续好，池里还是旧值；只修「续期时回写」是不够的，跳过时
     * 若不对账，UI 会**永远**显示「已过期」。判据是「与凭据不一致」（不是
     * 「池值已过期」），容差 1 秒 —— 由 `refreshAccountWithReconcile` 承担。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 拉取远端模型目录（`POST /api/llm/config/v2`，token 在 body）。
     *
     * 优先用账号池里的可用账号；无池或池为空时回退到本实例的默认凭据 ref。
     * 失败或未登录一律返回**空数组**（调用方回退到 `ACCIO.fallbackModels`），
     * 与 `TraeAuth.fetchModels` / `LobsteraiAuth.fetchModels` 同语义。
     *
     * ⚠️ **「没有凭据」不是异常**：未登录的用户每次列模型都会走到这条分支，
     * 打日志只会制造噪声。只有真正的失败（HTTP 非 2xx、网络异常）才记录。
     */
    fetchModels(pool?: AccountPool): Promise<AccioFallbackModel[]>;
    /** 移除已存储的凭据（账号条目由调用方决定是否删除）。 */
    logout(): Promise<void>;
    /**
     * 停止服务：置 inactive，阻止在途续期回写已登出的凭据。
     *
     * 与 CodeArts 同因：登录态与续期都归属账号池条目，续期由 `src/index.ts` 的
     * 多账号调度器（{@link refreshAll}）驱动，本服务**没有**自己的调度器可停。
     */
    stop(): void;
}
//# sourceMappingURL=accio-auth.d.ts.map