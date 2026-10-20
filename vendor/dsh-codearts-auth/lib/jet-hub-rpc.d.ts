/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 新 Connection 使用独立 RPC 通道 /jet-hub → /jet-hub/manage；
 * 旧 Fetch 注册器同时保留 /api/jet-hub，兼容旧客户端。
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.test / account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled /
 *           captcha.demand / captcha.carrierUrl / captcha.contribute（内部载体，
 *           载体页见 src/zcode-carrier-page.ts 与 src/captcha-carrier-server.ts）/
 *           backup.export / backup.import / backup.status
 * 另有一条 GET 路由 `/api/jet-hub/captcha-carrier`：渲染内部载体的载体页
 * （⚠ 手工诊断用；guest 加载不到它，见该路由注释里的主进程取证）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { AccountPool } from './account-pool.js';
import type { CodeArtsAuth } from './service.js';
import type { BuddyAuth } from './buddy-auth.js';
import type { LobsteraiAuth } from './lobsterai-auth.js';
import type { QoderAuth } from './qoder-auth.js';
import type { TraeAuth } from './trae-auth.js';
import type { ClineAuth } from './cline-auth.js';
import type { LoomyAuth } from './loomy-auth.js';
import type { RaccoonAuth } from './raccoon-auth.js';
import type { ZcodeAuth } from './zcode-auth.js';
import { type ZcodeLoginProvider } from './zcode-login.js';
import type { RaccoonCredential } from './raccoon.js';
import type { MinimaxAuth } from './minimax-auth.js';
import type { GeminiAuth } from './gemini-auth.js';
import type { BuddyCredential } from './buddy.js';
import { type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js';
import { type BuddyProduct } from './product.js';
/**
 * 单账号的成长中心任务执行，转成 RPC 明细。
 *
 * 僵尸账号（凭据被外部删除 ⇒ 上游回 401/403）归 `error` 提示但**不计入 failed**：
 * 它的处置是「重新登录」，与「任务真的推不动」完全不同。签到侧已把这类账号归
 * `inactive`（`collectClaimResults` 的 `凭据未配置` 分支同义），成长侧须一致 ——
 * 否则同一个僵尸条目在两处会给出互相矛盾的判定。
 *
 * @param budgetMs 透传给 `runGrowthTaskCompletions`；`undefined` 由其取缺省 10 分钟。
 */
export declare function collectBuddyGrowth(credential: BuddyCredential, product: BuddyProduct, entry: ProviderAccountEntry, budgetMs: number | undefined, roundDeadlineAt: number | undefined): Promise<RpcBuddyGrowthAccountResult>;
import type { ProviderAccountEntry, RpcCreditsStatusResponse, RpcCreditsClaimAllResponse, RpcBuddyGrowthAccountResult, RpcCreditsClaimSummary, RpcCreditsBalanceExtra, RpcCreditsBalancesResponse } from './types.js';
/** Jet Hub RPC API 路径 */
export declare const JET_HUB_API_PATH = "/api/jet-hub";
/**
 * 内部 captcha **载体页**的 GET 路径（与 GUI 同源，故 `<webview>` 能导航过来）。
 *
 * ⚠ 它挂在 `/api/` 前缀下，因而不是「随便一个静态页」：DSH 的 `/api` 路由会先过
 *   Connection 的 Host/Origin 栏与**浏览器会话认证**（`dsh-client-connection` 的
 *   `admit()` ⇒ 未认证回 401）。桌面版的 guest 与 GUI 是否同 partition、
 *   因而带得上那份会话 cookie，属 Task 5 的**实测项**，不在这里放宽。
 */
export declare const CAPTCHA_CARRIER_PATH = "/api/jet-hub/captcha-carrier";
/**
 * ZCode 登录渠道的白名单归一。
 *
 * ## 为什么要有这道
 *
 * `account.create` 的载荷来自**客户端自报**（RPC 入口没有 schema 校验），
 * 而 `ZcodeLoginProvider` 只是个 TypeScript 联合类型 —— 运行时任何字符串都能进来。
 * 原先只写 `req.zcodeProvider ?? 'bigmodel'`：缺省兜底是对的，但**没有校验**，
 * 传入 `zhiPu` / `ZAI`（大小写不同）这类未登记值会被原样送进
 * `startZcodeLogin` → 打到一个不存在的授权端点，表现为
 * 「授权页打不开」或「轮询到超时」这类极难定位的失败。
 *
 * ## 为什么**回落**而不是报错
 *
 * 回落方向与既有的 `?? 'bigmodel'` 兜底一致：老客户端、新客户端、
 * 手改过载荷的用户都还能登录（只是用缺省渠道）。且前端只会下发下拉框里的
 * 两个值，正常路径永远走不到这条分支 —— 它是**兜底**不是**主路径**。
 * 真正非法的输入会留一条 `console.warn`（与本文件其余告警同一惯例），
 * 便于事后发现是哪个客户端在发怪值。
 *
 * @param raw 客户端自报的渠道（可能未登记）
 * @returns 可安全交给 `zcode.startLogin` 的渠道
 */
export declare function normalizeZcodeLoginProvider(raw: string | undefined): ZcodeLoginProvider;
/**
 * 构造 Raccoon 账号的**展示名**：`RaccoonAva (1100)`。
 *
 * ## 为什么要追加手机号尾号
 *
 * 服务端的 `name` 是**自动生成的默认名**（实测本机账号为 `RaccoonAva`，
 * 即「Raccoon」+ 随机串）。实证：
 *
 * - `GET /user_info` 的 `data.name = "RaccoonAva"`；
 * - JWT payload 里同样带 `name: "RaccoonAva"`（官方客户端就是读这个：
 *   `M = () => { ... userName: t.name, id: t.sid }`）；
 * - `wechat_bindings` 只有 `[{id, bound_at}]` —— **没有微信昵称/头像**。
 *   微信扫码走 `snsapi_login`（只给 openid），要昵称需额外申请
 *   `snsapi_userinfo`，这里显然没申请。
 *
 * 所以「显示 `RaccoonAva`」本身与官方一致、**不是取错字段**；但它是默认名，
 * 注册第二个账号时服务端很可能又给一个相近的名字 → 多账号重名、无法区分。
 *
 * 修法参考 Loomy（`Loomy 2222`）：这边有真实名字可用，故**保留原名再挂尾号**，
 * 兼顾「看得出服务端原名字」与「多账号可区分」。
 *
 * 退化顺序：昵称 + 手机号尾号 → 昵称 + 用户 id → 昵称 → 账号 id。
 * ⚠️ 手机号取**后 4 位**（够区分且不完整暴露号码）。
 */
export declare function buildRaccoonNickname(credential: Pick<RaccoonCredential, 'nickname' | 'phone' | 'user_id'>, fallbackId: string): string;
/**
 * 支持「锁定永久积分」的 provider 白名单。
 *
 * ⚠️ **必须与前端 `plugin-src/client/jet-hub.js` 的 `supportsPermanentLock` 一致**：
 * 前端拿它决定要不要渲染按钮、要不要发读取请求；后端拿它拒绝越权写入。
 * 两边不一致的后果是「按钮出现但点了报错」或「功能存在却点不出来」。
 *
 * 登记条件：**余额响应里能拿到逐包的到期时间**（归一化到 `deductionEndTime`），
 * 从而分出「快到期」与「不会马上作废」两桶。判据见
 * `buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` —— 它只读通用的
 * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
 *
 * | provider | 分桶依据 |
 * |---|---|
 * | Loomy | 服务端直接给 `dailyBalance`（当日到期）与 `balance`（永久）两个命名池 |
 * | CodeBuddy / WorkBuddy | 资源包列表的 `DeductionEndTime` 距今是否满窗口天数 |
 * | TRAE（字节） | 资源包列表的**条目级** `expire_time`（秒级 Unix 时间戳） |
 * | LobsterAI（有道） | 资源包列表的 `expiresAt`（ISO 8601） |
 *
 * ⚠️ TRAE / LobsterAI **不区分「每日额度」与「永久积分」两个命名池**，但同样能按
 * 到期时间分桶 —— 对锁定功能而言，判据只需「会不会马上作废」，与池的名字无关。
 * 拿不到到期时间的包归入**永久桶**（保守方向：宁可锁定时少用一个号，
 * 也不要把长期积分误当快到期烧掉，见 `splitBuddyCreditsByExpiry` 注释）。
 *
 * 仍未登记的渠道（CodeArts / Qoder / Cline / Raccoon / Minimax / ZCode / Gemini /
 * OpenCode）：余额响应里没有逐包到期时间，或根本没有资源包列表 ——
 * 分不出两桶，登记进来只会多一个无效开关。
 */
export declare const PERMANENT_LOCK_PROVIDERS: ReadonlySet<string>;
/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 *
 * ★ **按单位分开累加**（2026-10-04，真实缺陷）：`totalCredit` 这个标量会把
 * 不同量纲加在一起（ZCode 的 1 亿 token + 100 积分 = `100000100`），单位信息
 * 一旦在这一层丢掉，下游无论怎么写文案都只能标一个「积分」。故同时产出
 * `totalByUnit`，消费方一律用它（见 `RpcCreditsClaimSummary.totalByUnit`）。
 *
 * ⚠️ `totalCredit` **保留原语义**（跨单位求和），只为不破坏既有契约；
 * **不要**在展示路径上用它 —— 那正是本缺陷的成因。
 */
export declare function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary;
/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 *
 * **对凭据/产品类型做泛型化**（而非写死 Buddy 系类型）：LobsterAI 的协议
 * 完全不同（无签名、三步签到、身份字段是 keyfrom），但「逐账号顺序执行、
 * 单个失败不中断、凭据解析在 try 之内」这套编排逻辑是**通用**的。
 * 泛型化让 `collect*` 三兄弟只写一遍，两套协议各自注入自己的下钻函数。
 * 默认类型参数保持 Buddy 系，故既有调用点与测试一行都不用改。
 */
export interface CreditsEndpointDeps<TCredential = BuddyCredential, TProduct = BuddyProduct> {
    /**
     * 解析凭据引用。
     * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
     * 实现允许抛错，调用方必须把异常算在单个账号头上。
     */
    resolve(ref: CredentialRef): Promise<{
        value: string;
    } | undefined>;
    /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
    fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>;
    /** 执行签到领取；默认使用真实的 claimDailyCheckin。 */
    claim?: (credential: TCredential, product: TProduct, entry: ProviderAccountEntry) => Promise<ClaimOutcome>;
    /**
     * 领取之后的下钻钩子，返回值原样带进 {@link RpcCreditsClaimAllResponse} 的
     * `growth` 字段。
     *
     * 存在的理由：成长中心任务与签到**共用同一趟逐账号循环**才能避免把凭据解析
     * 做两遍（凭据可能被外部删除，解析两次会得到两次不同的失败路径）。而它又
     * **不能**混进 `claim` 本身 —— `claim` 的返回类型是 `ClaimOutcome`，装不下
     * 22 项任务的逐项判据。
     *
     * 只有 buddy / workbuddy 注入；其余 provider 不传，行为逐字不变。
     */
    afterClaim?: (credential: TCredential, product: TProduct, entry: ProviderAccountEntry, outcome: ClaimOutcome, 
    /**
     * 整轮共享的截止时刻（`Date.now()` 口径），或 `undefined` 表示不限时。
     *
     * ⚠️ 逐账号预算是**每账号**上限，N 个账号会线性累加；宿主 RPC 的超时上界
     * 由 dsh 侧决定，本插件不可见也不可控。故另给一个整轮预算，让「账号很多」
     * 时也能**如实停住并报出哪些账号没跑**，而不是撞上宿主超时后前端只看到一个
     * 无来由的失败。
     */
    roundDeadlineAt: number | undefined) => Promise<RpcBuddyGrowthAccountResult | undefined>;
    /** 查询积分余额；默认使用真实的 fetchCreditBalance。 */
    fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>;
    /**
     * 余额查询的**带原因**版本（优先于 {@link fetchBalance}）。
     *
     * 为什么需要它：`fetchBalance` 只用 `null` 表达「查不到」，调用方统一回
     * 「余额查询失败」。但 CodeArts 还有第三种情形 —— **非积分计费账户**
     * （Token 计费）：它不是故障，如实显示「余额查询失败」会把用户引向错误的
     * 排查方向。该钩子让实现能带回精确文案，同时仍复用本函数的逐账号编排
     * （顺序执行、单账号失败不中断、凭据解析在 try 之内）。
     */
    fetchBalanceDetailed?: (credential: TCredential, product: TProduct) => Promise<{
        balance: CreditBalance | null;
        error?: string;
        extra?: RpcCreditsBalanceExtra;
    }>;
    /**
     * 整轮（全部账号）的时间预算（毫秒）。缺省 30 分钟。
     *
     * 与逐账号的 `budgetMs`（`afterClaim` 内透传）是**两个独立闸门**：前者管
     * 「账号很多」，后者管「单个账号卡住」。传0 或负数表示不限时。
     */
    roundBudgetMs?: number;
    /** 单账号异常时的告警出口（不参与控制流）。 */
    warn?: (message: string) => void;
    /**
     * 领取前是否先查一次签到状态（默认 `true`）。
     *
     * CodeBuddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
     * 领取请求（活动未开 / 今天已领时直接短路）。
     *
     * LobsterAI 的领取流程**自身就是多步的**（slot → context → check_in），
     * `claimedToday` / `actions` 判断已在内部完成并会返回对应的
     * `already-claimed` / `inactive`，外部再查一次纯属重复请求 ——
     * 故它传 `false` 跳过预检，直接交给 `claim`。
     */
    precheckStatus?: boolean;
    /**
     * 默认实现（`fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance`）
     * 使用的 fetch。
     *
     * ⚠️ **必须经此注入，不要在调用点直接 `fetch(...)`**：这些默认实现的真实签名是
     * `(credential, product, fetcher)`，而本模块的历史写法是
     * `deps.claim ?? (claimDailyCheckin as unknown as …)`，把三参函数硬转成
     * 「只传两个参数」的类型 —— 于是调用点写 `claim(credential, product, entry)`
     * 时，`entry` 落进了 `fetcher` 位置，运行时抛
     * **`TypeError: fetcher is not a function`**（真实缺陷：用户一键领取 4 个
     * CodeBuddy 账号全部失败）。
     *
     * 现改为**显式包装**默认实现（见下面的 `resolveClaim` 等），既保留 `entry`
     * 给需要它的 provider（TRAE 用 `entry.id` 取签到设备代次），又把 fetcher
     * 正确送进第三参。未提供时用全局 `fetch`。
     */
    fetcher?: typeof fetch;
}
/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export declare function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(accounts: readonly ProviderAccountEntry[], product: TProduct, deps: CreditsEndpointDeps<TCredential, TProduct>): Promise<RpcCreditsStatusResponse['accounts']>;
/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export declare function collectClaimResults<TCredential = BuddyCredential, TProduct = BuddyProduct>(accounts: readonly ProviderAccountEntry[], product: TProduct, deps: CreditsEndpointDeps<TCredential, TProduct>): Promise<RpcCreditsClaimAllResponse>;
/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export declare function collectCreditBalances<TCredential = BuddyCredential, TProduct = BuddyProduct>(accounts: readonly ProviderAccountEntry[], product: TProduct, deps: CreditsEndpointDeps<TCredential, TProduct>): Promise<RpcCreditsBalancesResponse['accounts']>;
/**
 * 注册 Jet Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 */
export declare function registerJetHubRpc(ctx: Context, pool: AccountPool, codearts: CodeArtsAuth, buddy: BuddyAuth, workbuddy: BuddyAuth, lobsterai: LobsteraiAuth, qoder: QoderAuth, 
/** Qoder **中国版**实例（与 `qoder` 同协议、不同 product；RPC 分支按注册表分派）。 */
qoderCn: QoderAuth, trae: TraeAuth, cline: ClineAuth, loomy: LoomyAuth, raccoon: RaccoonAuth, 
/** MiniMax Code **中国版**实例（OAuth 设备码 + PKCE，与 Qoder 同型但协议不同）。 */
minimax: MinimaxAuth, zcode: ZcodeAuth, 
/**
 * Gemini（Google Cloud Code Assist 免费线）实例（本地回调 OAuth）。
 *
 * ⚠️ **必须排在最后一个 provider 形参位**（即 `zcode` 之后、`modelAdapters`
 * 之前）：本仓库全部 `registerJetHubRpc` 调用点都是**位置传参**，历史上已因
 * 少传/插队错位复发 6 次。新 provider 一律**追加**在末尾，既有的 14 个调用点
 * 才不用逐个补占位。
 */
gemini: GeminiAuth, 
/**
 * provider → 适配器实例（可选）。
 *
 * 用于「显示列表」拿到**不受用户黑名单影响**的全量目录（`listAllModels`），
 * 使被关闭的模型也能显示正确的展示名（含倍率），而不是退化成裸 id。
 * 省略时退化为只用 `ctx.llm.listModels()` 的历史行为。
 */
modelAdapters?: Readonly<Record<string, ModelCatalogSource>>): void;
/**
 * 「显示列表」所需的最小适配器接口：能给出**不套用户黑名单**的完整目录。
 *
 * 只声明用到的方法（结构化类型），避免让本模块依赖五个具体适配器类。
 */
export interface ModelCatalogSource {
    handleRpc?(method: string, payload: unknown): Promise<unknown | undefined>;
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    /**
     * 聚合目录（**可选** —— 只有聚合适配器实现它）。
     *
     * ⚠️ 必须是**只读且零余额查询**的（规格 §8.3）：面板挂载时会调它。
     * 其余 14 家不实现本方法，故这里声明为可选（结构化类型，不影响它们）。
     */
    describeCatalog?(force?: boolean, signal?: AbortSignal): Promise<Array<{
        canonicalId: string;
        name: string;
        candidates: Array<{
            provider: string;
            realId: string;
            realName: string;
            price: number;
            viaPatch: boolean;
            rejected: boolean;
        }>;
    }>>;
    /**
     * 清空选型缓存（**可选** —— 只有聚合适配器实现它）。
     *
     * ⚠️ 改了拒绝表之后调它可立即释放内存。但**正确性不依赖它**：
     * 聚合适配器的缓存键含拒绝表指纹，故改了表就自动不命中旧条目
     *（见 `AggregateAdapter.rejectionFingerprint`）。
     */
    clearChoiceCache?(): void;
    /**
     * 「上次**实际**转发成功的渠道」（**可选** —— 只有聚合适配器实现它）。
     *
     * ⚠️ 必须是**纯内存读、零网络零余额查询**（规格 §6.3 的 P2）：用量徽标在
     * **门控阶段**就要拿到它（重定向必须发生在 `supportsCreditBalance` 门控之前），
     * 查网络会让外层渲染抖动。
     *
     * @param canonicalId - 省略时返回「最近一次任意虚拟模型的转发渠道」。
     */
    activeProvider?(canonicalId?: string): string | null;
    /**
     * 「按临期排序」用的候选到期时刻（**可选** —— 只有聚合适配器实现它）。
     *
     * ⚠️ 这是**唯一**会做余额探测的面板方法，**只在用户显式点「按临期排序」时**调用
     *（`describeCatalog` 的零查询契约不受影响，见那里的注释）。
     */
    describeExpiryOrder?(signal?: AbortSignal): Promise<Record<string, number>>;
}
//# sourceMappingURL=jet-hub-rpc.d.ts.map