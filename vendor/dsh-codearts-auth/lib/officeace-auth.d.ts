/**
 * OfficeAce 凭据层：DSH 自主华为云 OAuth（PKCE + DPoP），**零外部依赖**。
 *
 * ## 为什么不用 OfficeAce 客户端
 *
 * 早期实现从 OfficeAce 的本机 Redis 读凭据 —— 但那要求用户装过并登录过客户端。
 * 逆向（2026-10-12，全部实测验证）发现华为云的登录链**完全公开可自走**：
 *
 * ```
 * 1. POST {claw}/v1/claw/auth/state          → 云侧登记 state（匿名）
 * 2. 浏览器打开 auth.huaweicloud.com 授权页    → SSO 秒过 → 回调带 code
 * 3. GET  {claw}/v1/claw/auth/code?state=    → 取回 code（匿名，秒级时效）
 * 4. POST sts.../v1/oauth2/tokens            → code+verifier+DPoP 换 token
 * 5. GET  {claw}/v1/claw/client-permission-validate（AK/SK 签名）
 *    → 返回 modelInfo（model_app_key/secret）⇒ 推理凭据
 * ```
 *
 * client_id `pdp5_for_agentarts` 是 PKCE 公开客户端（无 secret），redirect_uri
 * 是云侧固定域 —— DSH 复用同一组参数，无需任何注册。
 *
 * ## 凭据存储（DSH 自有，JSON 文件）
 *
 * `~/.dsh-officeace/session.json`：token + refresh_token + modelInfo + DPoP 私钥
 * （DPoP 私钥**必须持久化**：refresh 请求要用同一把密钥签 DPoP）。
 *
 * ## 时序陷阱（实测踩过）
 *
 * - code 有效期**秒级**：拿到后必须立刻换 token（一体化流程，不能分两步交互）
 * - state 必须来自云侧（自造的查不到）
 * - refresh_token 一次性：刷新成功后必须立即落盘新 token，否则重放触发
 *   STS5.1806 "has been used" 死循环（OfficeAce 源码注释里的同款教训）
 */
import { OFFICEACE } from './officeace-product.js';
import type { ProviderAccountEntry } from './types.js';
/** WebCrypto 的 JWK/CryptoKey 类型（lib.dom 不可用时手动声明最小形状）。 */
export type DpopPrivateJwk = {
    kty?: string;
    crv?: string;
    x?: string;
    y?: string;
    d?: string;
};
type JsonWebKey = DpopPrivateJwk;
export interface OfficeAceCredential {
    /** MaaS 推理的 Basic 凭据对（permission-validate 返回）。 */
    modelAppKey: string;
    modelAppSecret: string;
    /** MaaS 端点 host（model_api_url_base）。 */
    maasBaseUrl: string;
    /** 华为云 IAM STS 凭据（AK/SK/STS，调 claw 管理 API 用）。 */
    access: string;
    secret: string;
    securityToken: string;
    projectId: string;
    expiresAt: string;
    /** OAuth refresh token（30 天，一次性）。 */
    refreshToken: string;
    /** DPoP 私钥 JWK（refresh 必须同钥）。 */
    dpopPrivateJwk: JsonWebKey;
    /** 用户显示名。 */
    displayName?: string;
    /** 账号 id。 */
    accountId?: string;
}
/** 读当前凭据；不存在/损坏返回 undefined。 */
export declare function readStoredCredential(ref?: string): OfficeAceCredential | undefined;
/** 清除凭据（登出/刷新死循环时的自救入口）。 */
export declare function clearStoredCredential(ref?: string): void;
export interface OfficeAceLoginStart {
    /** 浏览器要打开的授权页 URL。 */
    authorizeUrl: string;
    /** 云侧登记的 state（login.poll 用它取 code）。 */
    state: string;
    /** PKCE verifier + DPoP 私钥（换 token 时用；内存中间态，不落盘）。 */
    _internal: {
        codeVerifier: string;
        dpopPrivateJwk: JsonWebKey;
    };
}
/**
 * 步骤 1：向云侧注册 state 并生成授权 URL。
 *
 * `_internal` 由调用方保存在内存（`pendingOfficeAceState`），授权完成后传给
 * {@link completeLogin}。
 */
export declare function startLogin(): Promise<OfficeAceLoginStart>;
/**
 * 步骤 2：向云侧轮询 code（state 已登记时，用户授权后此端点返回 code）。
 *
 * @returns code；用户尚未授权时返回 undefined（前端继续轮询）。
 */
export declare function pollLoginCode(state: string): Promise<string | undefined>;
export interface ModelTokenRate {
    modelName: string;
    promptTokensPerPoint: number;
    completionTokensPerPoint: number;
    cachedTokensPerPoint: number;
    /** 计费系数 —— OfficeAce 界面显示为 `0.7x`（截图 2026-10-12 证实）。 */
    costCoefficient: number;
}
/**
 * 拉模型计费倍率（OfficeAce 主界面「模型选择器」里 `0.7x` 的数据源）。
 *
 * 端点：`GET {agentarts}/v1/model-token-rates`（V11 签名，2026-10-12 实测 200）。
 * 响应字段是 **snake_case**（`model_name` / `cost_coefficient`），与本地 API
 * 的 camelCase 形态不同 —— 这里做归一化。
 *
 * ⚠️ **不依赖 OfficeAce 客户端**（与余额同款 V11 直读）。
 * 凭据缺失 / 网络失败 → 空表：倍率显示优雅降级（模型照常可选，只是名字后不带 x 系数）。
 */
export declare function fetchModelTokenRates(): Promise<Map<string, number>>;
/**
 * 读 OfficeAce 本地 API 的会话 cookie（`oc_sid`）。
 *
 * `~/.office-claw/session.cookie` 是 DPAPI 密文（`OC-DPAPI-1` 前缀），同一
 * Windows 用户可直接解密 —— 内容是 `{"value":"<签名cookie值>","expires":...}`。
 *
 * ⚠️ 仅用于**只读**的倍率查询（`/api/subscription/model-token-rates`）；
 * 登录/推理已不依赖 OfficeAce（见模块头）。未安装时返回 undefined → 倍率降级。
 */
export declare function readSessionCookie(): string | undefined;
/**
 * 完成登录：code → token → modelInfo → **返回凭据（不落盘）**。
 *
 * ⚠️ 必须在轮询到 code 后**立刻**调用（code 秒级时效）。
 *
 * ⚠️ **落盘由调用方通过 {@link persistLogin} 完成**（与 gemini / raccoon /
 *    minimax 同款 `persistLogin(credential, { refName })` 范式）：凭据存进
 *    DSH 凭据库并按 `credentialRef` 索引 —— **这才是号池能多账号的根**。
 *    本文件早先自己写了 `session.json`，那是绕开凭据库的孤岛，正是
 *    「第二条卡片覆盖第一条」的成因（2026-10-13 改造）。
 *
 * ⚠️ 兼容：仍在**默认文件**写一份（`session.json`），供尚未走凭据库的
 *    老调用点与 `probeOfficeAce` 读取。多账号路径**不依赖**它。
 */
export declare function completeLogin(code: string, codeVerifier: string, dpopPrivateJwk: JsonWebKey): Promise<OfficeAceCredential>;
/**
 * 落库凭据（登录成功后由 RPC 调用）—— **DSH 标准范式**。
 *
 * 与 `gemini-auth.ts` / `raccoon-auth.ts` / `minimax-auth.ts` 的
 * `persistLogin(credential, { refName })` **同款**：
 * `ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))`。
 *
 * ⚠️ 凭据按 `refName` 索引进 DSH 凭据库 ⇒ 每个账号一份，**互不覆盖**，
 *    号池多账号/轮换天然成立。这是与「自己写 session.json」的本质区别。
 */
export declare function persistLogin(credential: OfficeAceCredential, options: {
    refName: string;
    credentials: CredentialStore;
}): Promise<{
    accountId?: string;
}>;
/** 凭据存储的最小接口（`ctx.credentials` 的形状）。 */
export interface CredentialStore {
    set(ref: string, value: string): Promise<void>;
    resolve(ref: string): Promise<{
        value: string;
    } | undefined>;
    unset?(ref: string): Promise<void>;
}
/**
 * 按 ref 读凭据（**优先 DSH 凭据库**，再回落**本 ref** 的兼容文件）。
 *
 * ⚠️ 这个次序不能反：多账号下每个账号的凭据在凭据库里按 ref 索引，
 *    `session.json` 只是老数据的兼容兜底 —— 先读文件会串号。
 *
 * ## ⚠️⚠️ 兜底**必须带 `ref`**（Gitee issue IKM741，2026-10-16 实测确证）
 *
 * 这里原先写的是 `readStoredCredential()` —— **漏传了 `ref`**，于是它读的是那份
 * **全局唯一**的 `session.json`（语义 =「最后一次登录的那个账号」）。而本函数
 * 的**每一个**调用方都传了 ref（`refreshAccountCredential` / `latestAfterFailedRefresh`
 * / `fetchSubscriptionSummary` / `index.ts` 的两处）⇒ 这个「不带 ref 的兜底」
 * 没有任何调用方需要它，纯粹是串号源。这正是 AGENTS.md 记的
 * 「位置/键错位」那一类缺陷的又一次复发（把 ref 丢在调用边上）。
 *
 * 实测后果（`~/.dsh` 四个账号三条已无凭据的真实机器）：
 *
 * | 情形 | 修前 | 修后 |
 * |---|---|---|
 * | 库里**有**该 ref | 用它 | 用它（不变） |
 * | 库里**无**该 ref，但有 `session-<ref>.json` | 读它（不变） | 读它（不变） |
 * | 库里**无**该 ref，也没有该 ref 的兼容文件 | **读全局 `session.json`** ⇒ 把**别的账号**的凭据当成本账号的 | `undefined`（如实报「本账号无凭据」） |
 *
 * 第三格是三条真实故障的**同一个根因**：
 *
 * 1. **跨账号烧一次性 `refresh_token`**：`refresh_token` 是一次性的，而
 *    `session.json` 是全局单份 ⇒ N 个「有账号无凭据」的账号各自回落到**同一份**
 *    token、各自拿它去续期 ⇒ 第一个消费掉，其余全部收到
 *    `STS5.1806 has been used`（issue 补充评论里的三条日志逐字如此）。
 *    危害是**跨账号**的：一份坏账号能把别的健康账号的路堵掉。
 * 2. **读数串号**：`fetchSubscriptionSummary(48, ref, …)` 拿全局凭据走云侧直读
 *    ⇒ 把最后一个登录账号的余额显示成本账号的余额（正是
 *    `ProviderExpiryContext.credentialRef` 那段注释记录的形态）。
 * 3. **`expiresAt` 串号**：`account.list` 的逐账号回填读到的是全局那份。
 *
 * ⚠️ 兼容性：改成按 ref 后，**单凭据老用户零行为变化** —— 那条路径本来就
 *    不经过本函数（它由 `readStoredCredential()` 无参调用点承担，如
 *    `probeOfficeAce` / `readOfficeAceCredential` / `fetchModelTokenRates`）。
 *    本函数只服务多账号路径，而多账号路径**必须**按 ref。
 */
export declare function readCredential(ref: string, credentials?: CredentialStore): Promise<OfficeAceCredential | undefined>;
export declare function refreshStoredCredential(ref?: string): Promise<OfficeAceCredential | undefined>;
/**
 * 「按账号续期」入口 —— 满足 `JetHubAuthLike` 的形状，供
 * `account.refresh` / 批量续期表 / `provider-runtime` 统一分派。
 *
 * ## ⚠️ `refName` **必须真正生效**（2026-10-13 修正）
 *
 * 原注释写的是「OfficeAce 是单凭据文件，故忽略 refName」—— 那是**凭据共用**
 * 这个缺陷的伴随假设。凭据改为**按 ref 分文件**后，多账号天然共存，这里就
 * 必须按 `refName` 定位到那一份文件去续期；否则 N 个账号会把同一份凭据
 * 续期 N 次（后 N-1 次拿到 STS5.1806 —— refresh_token 一次性已被消费）。
 *
 * ⚠️ 返回值恒 `undefined`（`void` 语义）：续期成功与否由**调用方后续读凭据**
 * 判定，这里不抛错 —— 与其余渠道一致（失败不阻断批量续期）。
 *
 * ## ⚠️⚠️⚠️ per-ref 串行 + 锁内重读 + 终态前重读（2026-10-13 审计补齐）
 *
 * 模块头（`:30-31`）自己写明 `refresh_token` **一次性**，而三条续期入口
 * （定时器 `refreshAll` / 适配器 401 兜底 / 面板 `account.refresh` 与自愈）
 * 都会并发进入**同一个 ref**。原先这里直连 `doRefreshCredential` ⇒
 * 先到者消费掉 token、后到者拿 STS5.1806；更糟的是若先到者写盘前被中断，
 * **新 token 永久丢失、只能重新登录**。
 *
 * ⚠️ 原先的 `refreshInFlight` 闸只包住了 `refreshStoredCredential`
 * （**兼容的文件那条腿**），生产主路径完全绕过它 —— 「加了锁但加错了一条腿」。
 *
 * 三条规则**必须一起**（同 codearts；AGENTS.md 记过「只搬第一条会继续误标」）：
 * 1. **per-ref 串行**（`SerialQueue`）：同进程内三条入口必然串行；
 * 2. **锁内重读 + lead-time**：拿到锁时凭据可能已被上一轮换新，距过期还早时
 *    只对账池值、**不发第二次请求**（少烧一个一次性 token）；
 * 3. **判终态前重读**：续期被拒时先看磁盘那份 `refresh_token` 是否**已经不等于**
 *    本次用的那份 —— 并发下服务端烧掉的是**旧的**一份，磁盘上此刻躺着**新的、
 *    可用的**凭据，那是「他处已续成功」而不是「本账号不可续期」。
 *
 * ⚠️ 该锁**只在单进程内有效**（dsh web 与 desktop 各自持锁），
 * 跨进程互踩靠上面第 3 条兜 —— 两处都得有。
 */
export declare function refreshAccountCredential(refName: string, pool: unknown, accountId: string, credentials?: CredentialStore): Promise<void>;
/**
 * 批量续期用的池形状。
 *
 * ⚠️⚠️ **`listAccountsByProvider` 是同步方法**（`AccountPool` 的真实签名，见
 * `src/account-pool.ts`）：返回数组，**不是 Promise**。
 *
 * 这个接口是为了让 IKLPTZ 那类误判**留下可读的类型证据**。早先两处 `refreshAll`
 * 把形参声明为 `unknown` 再用**内联断言**收窄，其中把返回值写成了
 * `Promise<…>`。断言直接覆盖了 `unknown` 的推导结果，故 TypeScript
 * 全程不报错、编译照常通过，缺陷活了 12 天（2026-10-12 引入 → 10-14 报障）。
 *
 * ## ⚠️⚠️ 为什么同时允许 `Promise`（2026-10-14 对抗性审计打穿后的修正）
 *
 * 第一版把返回值**只**声明为同步数组，并在 `refreshAccountList` 里直接
 * `for…of accounts`。那引入了一个**新的行为回归**（审计实测）：
 *
 * | 池返回 | 修复前（`await ….catch(…)`） | 第一版新代码 |
 * |---|---|---|
 * | 数组 | 逐个续期 | 逐个续期（等价） |
 * | **Promise（resolved）** | 逐个续期（`await` 到了数组） | **抛 `TypeError: accounts is not iterable`** |
 * | Promise（rejected） | 吞成 `[]` ⇒ 兜底 | **同上抛错，且兜底也不走** |
 *
 * ⇒ 「同步」是**当前生产事实**，不是**契约**。把契约收紧成同步，等于把
 * 「调用方给了 Promise」从「能用」变成「抛错」，而且抛在 `for…of` 上、
 * 连 `fallbackRefresh` 都绕过 —— 比原来的缺陷更难查。
 *
 * ⇒ 故本接口**同时接受两种形态**，由 {@link refreshAccountList} 归一化
 * （`await` 一次 + `Array.isArray` 兜底）。这样：
 * - 生产同步池：行为逐格不变；
 * - 任何 Promise 池（含老测试桩）：**与修复前等价**，不再回归；
 * - 真正非法的东西（非数组）：归入「空池兜底」并留日志，而不是抛 TypeError。
 */
export interface OfficeAceRefreshPool {
    /**
     * 列出某 provider 的全部账号（含已停用）。
     *
     * ⚠️ 生产实现是**同步**返回数组；`Promise` 形态仅为**兼容**而接受
     * （见上表：收紧它会制造回归）。
     */
    listAccountsByProvider?(provider: string): readonly ProviderAccountEntry[] | Promise<readonly ProviderAccountEntry[]>;
}
/**
 * 遍历账号池逐个续期（`refreshAll` 的**唯一**一份实现）。
 *
 * ## ⚠️⚠️ 为什么抽出来而不是让两处各写一遍（IKLPTZ 的真实成因）
 *
 * 生产里有**两个** `refreshAll`：模块导出的这个，与 `src/index.ts` 里包在
 * `officeaceAuthService` 上的那个（定时器实际走后者 —— `ctx.credentials`
 * 只能在那里注入）。两者除「分派目标」外**逐字相同**，于是 IKLPTZ 那个
 * `.catch()` 误判被**复制了两遍**，修 bug 也要修两处。
 *
 * ⇒ 把「取账号 → 判空 → 兜底」收成这里一份，两处只提供各自的
 * `refreshOne` 分派（这正是 `trae-model-id-selection.spec.ts` 那条守卫
 * 要断言的语义：续期必须打到**每个账号自己的** ref）。
 *
 * ## ⚠️ 形状契约（勿改）
 *
 * - **必须逐个账号续期**，不能图省事直接调 {@link refreshStoredCredential}：
 *   后者绕过账号池 ⇒「续期后不回写 `expiresAt`」，界面有效期停在旧值。
 * - **不看 `enabled`**（AGENTS.md 既有铁律）：停用只影响自动选号，与凭据
 *   新鲜度无关。故这里**刻意不过滤**。
 * - 拿不到池 / 池里 0 个账号 ⇒ 退化为续期本机那一份凭据（老用户兼容路径）。
 * - 池读取**同步抛错**不阻断：按「0 个账号」处理并走同一条兜底。
 *
 * ## ⚠️⚠️ 登记一处**刻意的行为变更**（2026-10-14 复审实测确认，别当等价重构）
 *
 * 本函数**不是**对修复前那两段代码的逐格等价重构 —— 有**一格**确实变了：
 * 「`listAccountsByProvider` **同步抛错**」。
 *
 * | | 修复前（`await ….catch(…)`） | 现（`try/catch`） |
 * |---|---|---|
 * | 池返回 rejected Promise | 吞成 `[]` ⇒ 走兜底 | 走兜底（等价） |
 * | 池**同步 throw** | **逃逸出 `refreshAll`** ⇒ 被上层 `refreshAllCredentials` 的逐 provider `try` 记一条 warn | **吞成 `[]`** ⇒ 走兜底 |
 *
 * 原因是 `.catch()` 只接 Promise 的 rejection，接不住同步 throw（已实测：
 * `await p.listAccountsByProvider('x').catch(()=>[])` 在同步 throw 下**抛出**）。
 *
 * ⚠️ **这个变更是刻意的、方向正确的**：`refreshAllCredentials` 的语义是
 * 「单个 provider 失败不阻断其余」，而「读池抖动」不该让 OfficeAce 整条
 * 从续期表里消失（那正是 IKLPTZ 的可观测症状）。故归入「空池兜底」比逃逸更好。
 * ⚠️ 但**必须按本仓库惯例登记**（见 `provider-abstraction-g3-exceptions.md`：
 * 「登记了一处例外」不等于它没有守卫）—— 守卫是 `officeace-refresh-all.spec.ts`
 * 的用例⑤（断言读池抛错时 `fallbackRefresh` **真的被调用一次**；
 * 改成静默 `return` 即变红）。
 *
 * ## ⚠️ `fallbackRefresh` 为什么是**参数**
 *
 * 它的生产默认值就是 {@link refreshStoredCredential}（语义与从前逐字相同）。
 * 提成参数是为了让单测能**替换掉那个会碰 `~/.dsh-officeace/session.json`
 * 的入口**：那个文件是用户**真实的华为云凭据**，而 `refresh_token` 是一次性的
 * —— 用例若顺着兜底分支读进去并发一次 STS，就会**消费掉用户的一次性 token**
 * （实测踩到过：vitest 输出里出现真实报文 `STS5.1806 has been used`）。
 * 注入之后，「空池」那几条用例完全不碰文件系统与网络。
 */
export declare function refreshAccountList(pool: unknown, refreshOne: (account: ProviderAccountEntry) => Promise<void>, fallbackRefresh?: () => Promise<unknown>): Promise<void>;
/**
 * 批量续期（`refreshAll` 形状）。
 *
 * ⚠️ 实现见 {@link refreshAccountList} —— 本函数只负责把「续期某一个账号」
 * 分派到**本模块**的 {@link refreshAccountCredential}（走兼容文件那条腿）。
 * `src/index.ts` 的服务包装会调同一个 {@link refreshAccountList}，但把
 * 分派指向**注入了 `ctx.credentials`** 的那一份。
 *
 * ⚠️ **把 `pool` 原样透传给 `refreshAccountCredential`**（不能省）：续期成功后
 * 要靠它回写池里的 `expiresAt`，漏传的症状是卡片有效期永远不更新。
 */
export declare function refreshAll(pool: unknown): Promise<void>;
/**
 * 读 OfficeAce 订阅摘要（果办界面右上角的积分池）。
 *
 * @returns totalCredits（总量）、usedCredits（已用）、creditGroups（分桶明细）；
 *          OfficeAce 未装/未运行时返回 undefined。
 */
export interface OfficeAceSubscriptionSummary {
    planName?: string;
    totalCredits: number;
    usedCredits: number;
    creditGroups: Array<{
        key: string;
        name: string;
        kind?: string;
        remaining: number;
        total: number;
        used?: number;
        expiresAt?: string;
        expired?: boolean;
    }>;
}
/**
 * 读 OfficeAce 订阅摘要（果办界面右上角的积分池）。
 *
 * ## 离线兜底（2026-10-12）：**不依赖 OfficeAce 运行**
 *
 * 在线时（cookie 可用且端口通）拉实时数据并**写缓存**；离线时读**最近一次
 * 缓存**兜底（`stale: true` 标记，展示层据此标注「数据截至 hh:mm」）。
 * 推理本身从不依赖此函数——余额只是展示。
 *
 * ## ⚠️ 多账号（2026-10-13）：查**哪个**账号由入参决定
 *
 * 传了 `credential` / `ref` 时**优先走云侧 V11 直读** —— 因为下面的本地 API 走
 * 的是果办客户端的**全局单一 cookie**（`oc_sid`），它只反映「当前登录在果办里的
 * 那一个账号」，**无法按 ref 区分** ⇒ 多账号下会让所有卡片显示同一个账号的
 * 余额（实测两个账号都显示 6500）。故多账号**必须**走云侧。
 *
 * @param staleHours - 缓存超过多少小时视为过期（默认 48）。过期且在线拉取
 *   失败时仍返回缓存（聊胜于无），由 `stale` 标记让 UI 如实呈现。
 * @param ref - 账号的 credentialRef（用于定位缓存文件）。
 * @param credential - 直接注入凭据（**多账号最可靠**：免一次解析，且明确指向某账号）。
 * @param credentials - DSH 凭据库；给了就按 `ref` 从库里读（多账号标准路径）。
 */
export declare function fetchSubscriptionSummary(staleHours?: number, ref?: string, credential?: OfficeAceCredential, credentials?: CredentialStore): Promise<(OfficeAceSubscriptionSummary & {
    stale?: boolean;
    cachedAt?: string;
}) | undefined>;
/**
 * 自动领取每日福利（**签到**）——`POST /v1/subscription/bonus/claim`。
 *
 * ## 为什么需要它（以及为什么必须是**自动**的）
 *
 * OfficeAce 的签到实际上是「每日送 1000 积分」的活动桶（`bonus_skus` 里的
 * `bonus-bonus-daily-checkin-2026`）。果办客户端的做法是**订阅页一挂载就自动
 * 调这个端点**（源码 `SubscriptionStateProvider`：用「年+月+日+时」做去重键，
 * 每小时最多领一次）—— **UI 上没有签到按钮**，不存在「手动签到」这回事。
 *
 * 故插件侧也必须是自动的：拉余额之前顺手领一次。
 *
 * ⚠️ **积分当日作废**（实测 2026-10-13）：`expired_time` 是当天 23:59:59。
 *    当天不领就永久失去那 1000 分 —— 这正是自动领取的价值所在。
 *
 * ⚠️ **失败的错误文本必须带出来**（2026-10-18 真实报障）：原先这里是一个裸
 *    `catch { return [] }`，尽管上一行的注释就写着「记日志而不是静默吞」。
 *    实测后果：凭据过期后**连续三天**每日签到 401 全失败、每天白丢 1000 分，
 *    而日志与面板**一个字都没有** —— 用户只能从「临期桶不见了」反推。
 *    ⇒ 本函数改为返回**结果对象**：调用方据此决定记日志与是否重试。
 *
 * @returns 领取结果。`ok: true` 时为领到的活动桶；`ok: false` 时带错误原因
 *（**不抛错**：签到失败绝不阻断余额展示）。
 */
export declare function claimDailyBonus(credential: OfficeAceCredential): Promise<ClaimBonusResult>;
/** 每日签到的领取结果。**失败带原因** —— 静默失败会让用户每天白丢 1000 分。 */
export type ClaimBonusResult = {
    ok: true;
    skus: Array<{
        activityId: string;
        activityName: string;
        points: number;
    }>;
} | {
    ok: false;
    reason: string;
};
/** Basic 授权头值（推理用）。 */
export declare function basicAuthorization(credential: OfficeAceCredential): string;
/** 读凭据并顺带判断 STS 是否临期（调用方决定是否先刷新）。 */
export declare function isExpiring(credential: OfficeAceCredential, leadMs?: number): boolean;
/** 探测凭据可读（面板/目录门控用）。 */
export declare function probeOfficeAce(): Promise<boolean>;
/**
 * 读凭据：优先 DSH 自有存储；OfficeAce 客户端已装且登录过时**回读迁移**。
 *
 * ⚠️ 迁移是**一次性的桥**：OfficeAce Redis 里的凭据结构与 DSH 自有登录不同
 *（缺 DPoP 私钥 ⇒ 不能刷新），故迁移条目标记 refresh 能力降级 —— 面板会提示
 * 重新登录一次以获得完整能力。
 */
export declare function readOfficeAceCredential(): Promise<OfficeAceCredential | undefined>;
/** Redis 密码的凭据管理器目标名（诊断日志用）。 */
export declare const REDIS_CRED_TARGET = "OfficeClaw/redis/password";
export { OFFICEACE };
//# sourceMappingURL=officeace-auth.d.ts.map