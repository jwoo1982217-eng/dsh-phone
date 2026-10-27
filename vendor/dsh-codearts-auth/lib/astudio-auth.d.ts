import { type AstudioLoginInput } from './astudio-oauth.js';
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type AstudioProduct } from './astudio-product.js';
import { type AstudioCatalogModel, type AstudioCredential, type AstudioSessionFile } from './astudio.js';
import type { AccountPool } from './account-pool.js';
/**
 * 「需要人工重新登录」的终态错误。
 *
 * ⚠️ `name` **必须**恰为 `RefreshTokenExpiredError`：`src/refresh.ts` 的
 * `isRefreshTokenExpired` 用 `error.name` 而非 `instanceof` 作判据（本仓库各家
 * 的同名类**刻意是各自独立的类** —— 跨模块 identity 不同，用 `instanceof` 会让
 * 一个 provider 的失效信号穿透成「可重试」而无限重试）。
 * 名字写错 = 每 30 分钟对账号后端白撞一次，且 UI 永远显示「可刷新」。
 */
export declare class AstudioRefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/**
 * 判断一次失败是否**终态**（只能人工重新登录，静默重试无意义）。
 *
 * 判据落在 `error.name` 而不是 `instanceof`（理由见 {@link AstudioRefreshTokenExpiredError}）。
 * 与 `isAccioTerminalRefreshError` 同形。
 */
export declare function isAstudioTerminalRefreshError(error: unknown): boolean;
/**
 * 会话文件路径（**环境变量覆盖优先**）。
 *
 * ⚠️ 覆盖项是 `DSH_ASTUDIO_SESSION_FILE`（与 `DSH_JET_HUB_STATE_DIR` /
 * `DSH_OFFICEACE_HOME` 同型；后者是安全整改时补的 —— 不覆盖时**单测会读到
 * 用户真实凭据**并据此发出真实请求）。默认值是实测的本机安装位置；换机必然
 * 不对，但那只影响「能不能零网络拿到凭据」，拿不到就自然走远端重取。
 */
export declare function astudioSessionFilePath(env?: Record<string, string | undefined>, product?: AstudioProduct): string;
/**
 * 解析会话文件原文 → {@link AstudioSessionFile}。
 *
 * 单独导出只为**单测能直接喂文本**而不必先落盘（生产路径经
 * {@link readAstudioSessionFile}）。坏 JSON / 顶层数组 ⇒ `undefined`。
 */
export declare function parseAstudioSessionJson(text: string | undefined): AstudioSessionFile | undefined;
/**
 * 读磁盘会话文件（**只读**）。
 *
 * 未装 AStudio / 未登录的用户每次都会走到 `undefined`：那不是异常，不记日志
 * （噪声），由调用方决定回退。
 */
export declare function readAstudioSessionFile(env?: Record<string, string | undefined>, product?: AstudioProduct): AstudioSessionFile | undefined;
/**
 * 磁盘凭据（快路径，零网络）。
 *
 * ⚠️ **刻意不做进程内缓存**：`dsh-credentials` 的铁律是「consumers re-resolve
 * at each operation and must not cache across operations」，而本家更极端 ——
 * 客户端是唯一权威写者，它随时可能因用户重登覆盖写盘。缓存一份旧值会让
 * 「客户端刚重登」必须靠重启插件才能生效。读盘只是本地 I/O，不省这点。
 */
export declare function readAstudioDiskCredential(env?: Record<string, string | undefined>, product?: AstudioProduct): AstudioCredential | undefined;
/** `bot/models/configs` 的完整 URL（账号后端，与推理网关**不同域**）。 */
export declare function buildAstudioApiKeyConfigUrl(product?: AstudioProduct): string;
/** 解析凭据存储值；缺 `access_token` 时 `undefined`（账号池身份依赖该字段）。 */
export declare function parseAstudioCredential(value: string): AstudioCredential | undefined;
/** {@link extractAstudioApiKey} 的结果（**带取证信息**，四种失败要能分开说）。 */
export interface AstudioApiKeyPick {
    /** 取到的 `api_key`；没取到为空串。 */
    apiKey: string;
    /** 命中判据的那条 `data[]` 的 `model`（证明取的是哪个模型行的 key）。 */
    model: string;
    /** 命中方式；`none` = 一条 api_key 都没有。 */
    via: 'is_current' | 'is_default' | 'first' | 'none';
    /** 是否**终态**（账号后端明确没有可用凭据 ⇒ 要人工重登）。 */
    terminal: boolean;
    /** 失败/终态的可读原因（成功时为空串）。 */
    reason: string;
}
/**
 * 从 `bot/models/configs` 的响应里取**活体模型凭据**。
 *
 * ## 取值判据（与客户端 `getAuthoritativeModelCredential` 一致）
 *
 * `data[].api_key` 先按 `is_current === true`，无则 `is_default === true`，
 * 再退 `data[0]`。实测本账号 9 行里 `astronclaw-auto` 是 `is_default:true`、
 * **没有任何一行 `is_current:true`** ⇒ 只判 `is_current` 会恒取不到；只判
 * `data[0]` 又会在客户端切换当前模型后取错行（三条都得留，顺序不能换）。
 *
 * ## ⚠️ `data` 是**数组**形态
 *
 * 实测：`{flag:true,code:0,desc:"成功",count:null,data:[{model,api_key,…}]}`。
 * 信封解析器（本轮之前）只认对象形态，会让这条链**恒失败** —— 症状是
 * 「凭据刷不动、每轮都要人工重登」，而这正是本模块唯一的自愈能力。
 * 修法在 `astudio.ts` 的 `parseAstudioEnvelope`（新增 `rows`）。
 *
 * ## 终态 vs 可重试（不得混淆）
 *
 * | 情形 | 判定 | 依据 |
 * |---|---|---|
 * | `code` 命中失效码（1002/1005） | 终态 | fact 344/328 的会话失效码 |
 * | `code:0` 但 `data` 空 / 全行无 `api_key` | 终态 | 客户端在此抛 `AuthoritativeModelCredentialError` |
 * | 其它非 0 码（实测无 Cookie 回 `99909001/系统异常`） | **可重试** | 把未知码固化成「账号已死」是本仓库 codearts 的**单向门**事故形态 |
 * | 网络抖动 / 5xx / 非 JSON | 可重试 | 网络问题不该让用户重新登录 |
 */
export declare function extractAstudioApiKey(body: unknown): AstudioApiKeyPick;
/**
 * 把磁盘那份与凭据库里那份**合并**成刷新用的种子。
 *
 * ## 为什么不能只用其中一份
 *
 * - 磁盘那份有 Cookie，但 `access_token` 可能是过期副本；
 * - 凭据库里那份（上一轮重取的、或被账号池投影过的）**可能没有 Cookie**，
 *   单独用它 ⇒ 永远凑不出 Cookie 串 ⇒ **刷新能力永久丢失**（这是最坏的一种：
 *   不报错，只是从此刷不动）。
 *
 * ⇒ 规则：`access_token` 与 Cookie 各字段一律**磁盘优先**（客户端只写盘），
 * 但**空值不覆盖另一侧的好值** —— 磁盘里 `token:""` 若直接铺开，会抹掉库里
 * 的真值，而 `astudioCookieHeader` 跳过空值 ⇒ 症状是「明明有会话却拼不出 Cookie」。
 */
export declare function mergeAstudioRefreshSeed(disk: AstudioCredential | undefined, stored: AstudioCredential | undefined): AstudioCredential | undefined;
/** 展示名（手机号掩码到只露末 2 位）：供 Jet Hub 卡片复用，避免第二处实现。 */
export declare function astudioAccountNickname(credential: AstudioCredential | undefined, fallbackId: string): string;
/** {@link AstudioAuth.refreshOnce} 的结果（**四态**，不是布尔）。 */
export interface AstudioRefreshOutcome {
    /** 刷新后的凭据；完全读不到时 `undefined`。 */
    credential: AstudioCredential | undefined;
    /**
     * `access_token` 是否**真的变了**。
     *
     * ⚠️ 不变 ⇒ **重试无意义**（同 token 同 401 是确定性失败，实测本家不轮换）。
     * 调用方必须据此跳过重发并直接报终态 —— 用布尔把「没变」与「读不到」混成
     * 一格是本仓库 officeace 的 `RenewalOutcome` 整改过的同一缺陷。
     */
    changed: boolean;
    /** 刷新前指纹（`sha256[:8]`；`''` = 本来没有凭据）。与客户端日志同算法，便于对账。 */
    before: string;
    /** 刷新后指纹。 */
    after: string;
    /** 本轮是否真的发了远端请求。 */
    fetched: boolean;
    /** 取值判据（透传 {@link AstudioApiKeyPick.via}）。 */
    via: AstudioApiKeyPick['via'];
    /** 是否终态（只能人工重登）。 */
    terminal: boolean;
    /** 失败原因（成功时为空串）。⚠️ 必须能进错误文案：静默失败是本仓库明令禁止的。 */
    reason: string;
}
/** 本服务对凭据库的最小需求（收窄成接口，单测可直接喂结构替身）。 */
export interface AstudioCredentialStore {
    resolve(ref: CredentialRef): Promise<{
        value: string;
    } | undefined>;
    set(ref: CredentialRef, value: string): Promise<void>;
    unset(ref: CredentialRef): Promise<void>;
}
/** `AstudioAuth` 的构造选项（**单测全靠它们注入 fixture 与假 fetch，不碰真实凭据/网络**）。 */
export interface AstudioAuthOptions {
    /** 注入的 fetch；缺省全局 `fetch`。 */
    fetcher?: typeof fetch;
    /** 产品配置；缺省 {@link ASTUDIO}。 */
    product?: AstudioProduct;
    /** 环境变量视图；缺省 `process.env`（单测把会话文件指到 fixture）。 */
    env?: Record<string, string | undefined>;
    /** 注入的凭据库；缺省用宿主 `ctx.credentials`。 */
    store?: AstudioCredentialStore;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        astudioAuth: AstudioAuth;
    }
}
/**
 * AStudio 认证服务：磁盘快路径 + 401 触发的权威重取（**不做本地到期预判**）。
 */
export declare class AstudioAuth extends Service {
    private readonly options;
    /** 本实例默认读写的凭据 ref 名称（`ASTUDIO_ACCESS_TOKEN`）。 */
    readonly credentialRefName: string;
    /** 产品配置（端点、可选头、超时）。 */
    readonly product: AstudioProduct;
    /** 登录态是否活跃；`stop()` / `logout()` 置 false，阻止在途刷新回写。 */
    private active;
    constructor(ctx: Context, options?: AstudioAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    get fetchImpl(): typeof fetch;
    /** 注入的环境变量视图（单测用它把会话文件指到 fixture）。 */
    private get env();
    /** 凭据库：注入的替身优先，否则用宿主 `ctx.credentials`。 */
    private get store();
    /** 记录一条警告（经 `ctx.logger`）。 */
    private warn;
    /** 读凭据库里的存储值（失败 `undefined`，绝不抛）。 */
    readStoredCredential(refName: string): Promise<AstudioCredential | undefined>;
    /** 把凭据写进 DSH 凭据库（**绝不写客户端文件**）。失败只记日志。 */
    private saveCredential;
    /**
     * 当前可用凭据：**磁盘优先**，退回凭据库里的存储值。
     *
     * ⚠️ 顺序不能倒：客户端是 `modelBearerToken` 的唯一权威写者（重登/自刷新都会
     * 覆盖写盘）。库里那份可能是**上一轮的陈旧副本**，甚至属于换掉之前的账号。
     */
    currentCredential(refName?: string): Promise<AstudioCredential | undefined>;
    /**
     * 向账号后端要一份**权威**的 `modelBearerToken`（纯读、幂等、零副作用）。
     *
     * ⚠️ 请求**不带 `Authorization`**：实测该端点只认 Cookie（见
     * `astudioControlHeaders` 的注释 —— 「与客户端逐字一致」是唯一不需要证明的选项）。
     * ⚠️ Cookie 拼不出来时**不去撞**：直接抛终态 —— 没有会话就没有权威源，发一个
     * 必然空体的请求只会把「需要重新登录」延迟成更难归因的错误。
     */
    fetchAuthoritativeCredential(seed?: AstudioCredential): Promise<AstudioCredential>;
    /**
     * {@link fetchAuthoritativeCredential} 的实现层，**多透出 `via`**。
     *
     * ⚠️ 为什么要拆成两个而不是把 `via` 塞进 `AstudioCredential`：`via` 是**记账/诊断**
     * 字段（命中判据是 `is_current` / `is_default` / `first` 哪一条），不属于协议凭据；
     * 混进凭据会跟着一起落盘，让「磁盘 JSON 的字段集」出现第四个来源不明的键
     * （fact 374：磁盘文件是客户端的，我们连写都不写，更不能改它的形状）。
     * `AstudioRefreshOutcome.via` 的注释原话就是「透传 {@link AstudioApiKeyPick.via}」——
     * 这一层是那条注释一直缺的实现。
     */
    private fetchAuthoritativePick;
    /**
     * 刷新一次（**推理路径的 401 入口**），返回「值到底变了没有」。
     *
     * ⚠️ 本方法**不抛**：401 路径上抛错会把一次可归因的凭据问题变成适配器里的
     * 未捕获异常。失败以 `credential`/`reason`/`terminal` 回传，由适配器决定文案。
     * 之所以仍然要区分 `terminal`：终态意味着**再多的定时刷新也不会成功**，
     * 调用方据此停止调度并提示重登；非终态只是「这次没刷动」。
     */
    refreshOnce(refName?: string): Promise<AstudioRefreshOutcome>;
    /**
     * 续期**指定账号**（Jet Hub 账号卡片 / `ProviderRuntime.auth.refreshAccount`）。
     *
     * ⚠️ 本家的刷新**不需要额外材料**（Cookie 就在凭据里），因此不存在
     * 「无 refresh_token」那一格；可刷性判据就是「当前有 access_token」。
     * ⚠️ 失败必须**原样上抛**（终态抛 `AstudioRefreshTokenExpiredError`）：
     * 调度器靠 `error.name` 停掉本账号的定时刷新，吞掉它 = 每 30 分钟白撞一次。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量续期（`src/index.ts` 启动首轮 + 30 分钟定时器；接
     * `jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS`）。
     *
     * ## 两条不得过滤的铁律（本仓库真实事故同型）
     *
     * 1. **不看账号是否停用**：停用只影响自动选号，与「凭据是否保鲜」无关。
     * 2. **不按池里的 `refreshable` 过滤**：那个布尔是被对账的**结果**，拿它当
     *    门禁会把一次瞬时失败固化成**单向门**（账号从此永不自愈 —— codearts
     *    真实事故：「自动续期没有工作吗？重启也还是 401」）。
     *
     * ⇒ 权威判据只有凭据材料本身（{@link isAstudioRefreshable}）。
     * ⚠️ 本家的刷新是**幂等纯读、零副作用**（fact 374：可无条件定时重取），
     * 所以每轮全量重取不烧任何东西；它同时能救「客户端在别处重登、磁盘值已换新」
     * 这一类场景。
     * ⚠️ 单账号失败**不中断其余账号**，且必须**留日志**：静默会让账号在 UI 上
     * 永远显示「可刷新」却刷不动，无从排查。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 回写账号池的 `refreshable`。
     *
     * ⚠️ 本家**没有**可用的 `expiresAt`（磁盘无 TTL，`astudioCredentialExpiresAtMs`
     * 恒 `undefined`）⇒ **绝不写 `expiresAt`**：把字段写成 `undefined` 落盘会被
     * `JSON.stringify` 整个丢弃，UI 于是从「已过期」变成「未知」，反而抹掉了既有
     * 信息（与 `src/expiry-sync.ts` 的同一约定，那里把这条列为硬规矩）。
     */
    private syncExpiry;
    /**
     * 拉取远端模型目录：`GET {catalogBaseUrl}{catalogPath}`，解
     * `{code:0,data:{models:[…]}}` 信封。
     *
     * ⚠️ **不能**走 `{maasBaseUrl}/models`：实测恒 **404** `page not found`
     *（`/model-gateway/v1/models` 与 `/api/v1/model-manager/models` 是两个不同前缀，
     * 见 `astudio-product.ts` 模块头第 1 条）。
     * ⚠️ 返回**未过滤**的解析结果：可见性过滤（剔 `visibility:hide` 的内部别名）
     * 由适配器用 `astudioVisibleModels` 做 —— 一处只干一件事，且
     * `raw` 的全量 39 字段必须原样保留（内核 `modelInfo` 逐字段强校验）。
     * 失败返回空数组（调用方回退兜底表），与 `AccioAuth.fetchModels` 同语义。
     */
    fetchCatalogModels(): Promise<readonly AstudioCatalogModel[]>;
    /**
     * 导入**本机 AStudio 客户端已有的登录会话**（纯本地读盘 + 写 DSH 凭据库，**零网络请求**）。
     *
     * ## 为什么本家没有 `startLogin`
     *
     * AStudio 不走 OAuth：推理凭据是客户端登录后**明文落盘**的 `modelBearerToken`
     * （`ASTUDIO.sessionFilePath`，fact 399/402），服务端 `Set-Cookie` 恒
     * `Max-Age=31536000`、bundle 内**不存在任何程序化续期接口** ⇒ 没有「授权页 +
     * 回调」这一步可返回 URL。用户动作是「在 AStudio 客户端里登录」，本函数只负责
     * 把那份会话**读进来** —— 它是 `jet-hub-rpc.ts` 的 `account.create` astudio
     * 分支的唯一取数入口（fact 472 缺口 B）。
     *
     * ⚠️ **磁盘优先，但绝不回写磁盘**：客户端是 `modelBearerToken` 的唯一权威写者
     * （fact 401 挂点约束），本函数只写 DSH 凭据库，与 `refreshOnce` 行为一致
     * （单测已断言磁盘 fixture 一字未改）。
     *
     * ⚠️ 读不到 ⇒ **抛** `AstudioRefreshTokenExpiredError`，不得返回 `undefined`
     * 让调用侧写出一个没有凭据的账号条目（那会被自愈/探测链当成「已登录但坏了」）。
     *
     * ⚠️ 写库**刻意不走 `saveCredential`**（那条吞错误只留日志）：导入失败必须让
     * 调用方看见，它才能 `pool.removeAccount` 清掉刚登记的幽灵条目。
     *
     * @param refName 账号池条目的 `credentialRef`（由 `account.create` 生成）。
     *                只用于并入库里既有值；凭据本身固定写在 `defaultCredentialRef`
     *                —— 本家是「单账号一份会话文件」的形态（fact 374），且与
     *                `currentCredential()` 缺省读取的 ref 对齐，避免读盘值与库里值分裂。
     */
    importLocalSession(refName: string): Promise<AstudioCredential>;
    /**
     * 微信扫码登录凭据兑换与会话持久化（completeLogin）。
     *
     * 对接微信扫码授权后拿到的 { uid, ssoSessionId, username }：
     * 1. 走 completeAstudioLogin 兑换完整推理凭据；
     * 2. 持久化写入凭据库。
     */
    /**
     * 将登录凭据回填并持久化写入凭据库（persistLogin）。
     *
     * 供 Carrier 载体页（startAstudioLoginFlow）或外部登录流程在拿到完整凭据后统一回填持久化。
     */
    persistLogin(credential: AstudioCredential, options?: {
        refName?: string;
    }): Promise<AstudioCredential>;
    completeLogin(account: AstudioLoginInput, refName?: string): Promise<AstudioCredential>;
    /** 移除已存储的凭据（账号条目由调用方决定是否删除）。**不碰客户端文件**。 */
    logout(): Promise<void>;
    /** 停止服务：置 inactive，阻止在途刷新回写已登出的凭据。 */
    stop(): void;
}
export { completeAstudioLogin, getAstudioGeeTestConfig, sendAstudioSmsCode, loginAstudioWithSms, loginAstudioWithPassword, startAstudioLoginFlow, type AstudioWechatAccount, type AstudioLoginIdentity, type AstudioLoginInput, type AstudioGeeTestConfig, type AstudioGeeTestResult, type AstudioSmsSendResult, type AstudioLoginFlowOptions, type StartedAstudioLoginFlow, } from './astudio-oauth.js';
//# sourceMappingURL=astudio-auth.d.ts.map