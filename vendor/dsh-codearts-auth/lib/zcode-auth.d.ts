/**
 * ZCode 认证/凭据服务（`ctx.zcodeAuth`）。
 *
 * ## 凭据的**唯一**来源：插件自己的授权流
 *
 * 用户在 Jet Hub 面板点「添加账号」→ 走官方 CLI 设备授权流
 * （`zcode-login.ts`）→ 凭据写进 `ctx.credentials`。
 * **不读取本机 ZCode 客户端的任何数据**（2026-10-05 决策，理由见
 * `zcode.ts` 文件头）。
 *
 * ## 与其它 auth 服务的关键差异
 *
 * 其它 `ctx.xxxAuth` 管「浏览器登录 → 拿 token → **续期**」。
 * ZCode 的凭据是**静态**的（JWT 的 payload 里没有 `exp`）⇒ **不可续期**，
 * 失效时上游回 401/1002，由适配器归为 AUTH 提示用户重新登录。
 *
 * 本服务的职责是：
 *
 * 1. **登录与存凭据**（`startLogin` / `login`），含顺带换取 coding-plan key
 * 2. **探活**：凭据是否可用（能不能拿到额度）
 * 3. **额度**：`billing/balance`
 * 4. **签到**：补激活上报 → preview → claim（每个 plan 单独 mint captcha）
 * 5. **captcha 配置**：`client/configs`（拿 region/prefix/sceneId）
 *
 * ## ⚠ 必须 `extends Service`
 *
 * 其余八个 auth 服务全部继承 `@deepseek-ai/cordis` 的 `Service` 基类，
 * 由基类构造函数完成 `ctx.provide(<name>, this)` 注册。
 * 初版 `ZcodeAuth` 是个**裸 class**，既没继承也没自己 provide ——
 * 结果是 `ctx.zcodeAuth` **恒为 undefined**（行为探针实证），
 * 与注释里「注册为 ctx.zcodeAuth」的声明直接矛盾。
 *
 * 服务名由 `product.id` 派生为 `zcodeAuth`，与 `RaccoonAuth` 同款做法。
 *
 * ## ⚠ 不注册任何斜杠命令
 *
 * 与其余 provider 一致：登录/状态/额度/签到全部在 Jet Hub 面板完成。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import type { CheckinStatus } from './credits.js';
import type { ClaimOutcome } from './credits.js';
import { type ZcodeCredential } from './zcode.js';
import { type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js';
import type { ZcodeClaimablePlan } from './zcode-upstream.js';
import { type ZcodeCaptchaConfig } from './zcode-captcha.js';
import { CaptchaCarrier, type CarrierOutcome } from './captcha-carrier.js';
import { type ZcodeLoginProvider } from './zcode-login.js';
import { type ZcodeBalanceResult, type ZcodeClaimOutcome } from './zcode-upstream.js';
/** 一次探活的结果。 */
export interface ZcodeProbeResult {
    /** 凭据是否可用。 */
    available: boolean;
    /** 展示名（脱敏手机号 / 设备码）。 */
    accountLabel?: string;
    /** 剩余额度（探活成功时）。 */
    remaining?: number;
    /** 不可用时的原因（人类可读）。 */
    reason?: string;
}
/**
 * 领取路径注入的 param 产出回调。
 *
 * ## ⚠ 实参是「**本次领取用的那份** captcha 配置」，不是可选装饰
 *
 * 阿里云验签时会把 param 与请求头 `x-aliyun-captcha-verify-region` **成对**校验，
 * 两边不是同一个 region 就必然 `400 / 3007`（captcha 校验失败）。
 *
 * ⚠ 真实缺陷（Gitee issue IKJNPS，用户报障，非 cn 区账号 100% 复现）：
 * 「一键领取」此前由调用方自己去 `fetchCaptchaConfig()` 拿配置产 param，
 * 而 region 走 `claimDailyFor` 的**兜底常量** `ZCODE_CAPTCHA_FALLBACK.region`
 * （`cn`）。于是 z.ai 国际渠道（服务端下发 `region: "sgp"`）这类账号
 * 会稳定发出「sgp 签的 param + cn 的 region 头」⇒ 恒 `3007`，一个都领不到。
 *
 * ⇒ 由 {@link ZcodeAuth.claimDailyWith} 解析**一次**配置，并把同一份传进来，
 * 让「param 的来源」与「region 的来源」**在类型上就是同一份**。
 */
export type ZcodeClaimCaptchaMint = (config: ZcodeCaptchaConfig) => Promise<string>;
/** `ZcodeAuth` 的构造选项。 */
export interface ZcodeAuthOptions {
    /** 产品配置；默认 {@link ZCODE}。 */
    product?: ZcodeProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `zcodeAuth`）。 */
    serviceName?: string;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /**
     * 账号池（测试用）。
     *
     * 生产路径靠 `ctx.get('accountPool')` 惰性取（见 `accountPool()`），
     * 但单测里未必把池注册到 ctx 上 —— 故保留这个注入口。
     */
    accountPool?: AccountPool;
    /**
     * **内部载体链**的诊断日志（缺省完全不输出）。
     *
     * 与 `ZcodeAdapterOptions.log` 同因：那两条告警（「内部载体的 param 被上游拒」
     * 「累计拒 N 次 ⇒ 本次运行禁用内部载体」）是排查内部载体为什么不起作用的**唯一**线索，
     * 缺省不接就等于线上什么都看不见。由 `index.ts` 注入 `ctx.logger?.warn?.()`。
     */
    carrierLog?: (message: string) => void;
}
/**
 * 内部载体（DSH Desktop 的 webview guest 产 param）是否**允许**参与产出。
 *
 * ⚠ 只有显式 `0` 表示关闭（关掉 ⇒ **既不有界等待、也不取供给槽**，逐字回到一期的
 *   那条 chromium 链）。判据与 `captchaQueueEnabledFromEnv` / `captchaBackoffConfigFromEnv`
 *   同款：**未设置/空串 = 默认开**。
 *
 * ⚠ **不许**写成 `parseInt(env) || 默认值` 那类判断 —— `0` 恰恰是本开关**唯一**
 *   有意义的取值，`||` 会把它当成假值静默换成默认（本仓库在
 *   `DSH_QODER_QUEUE_TIMEOUT_MS` 上犯过一次，AGENTS.md 有记录）。
 *   网在 `tests/unit/zcode-carrier-auth.spec.ts` 的「只有显式 `0` 关掉」那条。
 */
export declare function internalCarrierEnabledFromEnv(env?: NodeJS.ProcessEnv): boolean;
/** ZCode 认证服务。 */
export declare class ZcodeAuth extends Service {
    private readonly product;
    private readonly fetchImpl;
    /** 注入的账号池（测试用；生产走 ctx.get）。 */
    private readonly injectedPool;
    /**
     * 常驻 captcha 浏览器。
     *
     * ⚠ 常驻是必需的：浏览器**进程**冷启动实测约 690ms，每次拉一台会让首字延迟凭空多一秒。
     * ⚠ 但**不是**「每次 mint 都要新建 page」：那个 1.2 秒（中位 1246ms）是页面停在
     * `about:blank` 时的历史结论，origin 修正后同一页面可连续 mint —— 现行**复用常驻页面**，
     * 稳态一次约 0.4–0.5 秒（中位 426ms / 平均 546ms）。依据与矩阵见 `zcode-captcha.ts` 的
     * `CAPTCHA_PAGE_ORIGIN`，口径统一见 README 的 ZCode 章节。
     * 另：mint 本身现在是**按需**的（先探后取，见 `captcha-requirement.ts`），
     * 上游不要验证的窗口里这条路一次都不走。
     * 生命周期由 `stop()` 收尾。
     */
    private captchaBrowser;
    /**
     * captcha **预取池**（挂在与浏览器同一个生命周期上）。
     *
     * ⚠ 惰性创建：纯插件登录、从不用推理的用户不该为它做任何事。
     */
    private captchaPool;
    /**
     * 最近一次 `mintCaptcha` 用的 captcha 配置。
     *
     * 池的 `mint` 回调不带参数（它的语义是「产一个 param」），故配置由这里传递。
     * 配置来自服务端 `client/configs` 且极少变化，跟着最近一次调用走即可。
     */
    private captchaMintConfig;
    /**
     * captcha **产出失败退避**（设备级信誉保护）。
     *
     * ⚠ 与 `captchaPool` 不同，它**不惰性创建**：闸门要在第一次
     * `mintCaptcha` 之前就生效，且构造它无任何副作用。
     */
    private readonly captchaBackoff;
    /**
     * captcha 产出的**全局串行队列**（对齐官方 `jnn`/`wnn`）。
     *
     * ⚠ 必须是**实例字段**：队列靠共享的尾巴指针生效，每次新建等于没有队列。
     */
    private readonly captchaQueue;
    /**
     * captcha **载体链**（二期 Task 5 接线）：内部载体（DSH Desktop 的 guest 产的 param）
     * 优先，等不到再落回 {@link mintWithChromium} 那条既有链。
     *
     * ## 注入的那条 chromium 腿**就是既有那条链**，一行语义都没改
     * `mintWithChromium` = {@link mintWithChromium}（退避闸门 → `captchaQueue` 串行
     * → 预取池 take），也就是 Task 5 之前的 `mintCaptcha` 函数体。
     * ⚠ **不许**在这里另开一条「直接调浏览器」的捷径：那等于把
     *   「同设备每小时 150 次」的两道护栏（冷却闸门 + 全局串行）拆掉。
     *
     * ## param 的年龄口径（与 `elapsedMs` 的关系，别记混三个数）
     * | 数 | 谁算的 | 锚点 | 用途 |
     * |---|---|---|---|
     * | `atMs` | `src/jet-hub-rpc.ts` 的 `captcha.contribute`：server 到达时刻 **− elapsedMs** | **server 时钟** | 槽的年龄基准（= 推算的产出时刻） |
     * | `elapsedMs` | client 报的「产出 → 回传」相对耗时（同机单向差值） | 两端**同一台机器** | 把到达时刻往前推成真实产出时刻 |
     * | 年龄 | `takeFreshParam(now) - atMs` | server 时钟 | 超过 `PARAM_MAX_AGE_MS` 一律丢 |
     *
     * ⚠ 不用 client 的**绝对**时间戳（跨端时钟漂移会把时效闸弄废），
     *   也不用纯到达时刻（那会**低估**一个 client→server 跳数的年龄）—— 详见
     *   `src/captcha-supply.ts` 的 `SupplySlot.atMs` 注释。
     * ⚠ 与适配器日志里那个 `mintMs` **不是一回事**：`mintMs` 是「取 param」这一跳的
     *   墙上时钟差（`src/zcode-adapter.ts`，含载体链那至多 1.5 秒的有界等待），
     *   只用于前置耗时诊断，不参与任何时效判定。
     *
     * ⚠ **实例字段**（不是每请求新建）：被上游拒的累计计数与「本次运行是否已禁用」
     *   必须跨请求活着，否则永远到不了阈值。
     */
    readonly carrier: CaptchaCarrier;
    /** 内部载体的 env 开关（构造期读一次，与 `captchaQueueEnabledFromEnv` 同一读取点）。 */
    private readonly internalCarrierEnabled;
    /**
     * 载体页小服务（评审 C1/C2 的形态 B，见 `src/captcha-carrier-server.ts` 文件头）。
     *
     * ## 为什么它必须挂在**插件自己的 `/api/…` 之外**（这轮修掉的致命缺陷）
     * 桌面版主进程对 guest 的请求有两道硬闸（asar `lib/main.js`，DSH Desktop 0.2.0-rc.2）：
     * `allowedNavigation()` 与 `configureSession().onBeforeRequest` 都以
     * `isApplicationHost(url)` 拒绝「**端口相同** 且 主机相同/回环」的地址 ——
     * 而插件的 `/api/jet-hub/captcha-carrier` 正好就是那个端口 ⇒ guest 连文档都建不起来。
     * 换端口即绕开（那也是 `isApplicationHost` 判定的盲区），代价是要自己监听一个回环端口。
     *
     * ## 为什么**懒起**而不是构造期就起
     * web 版根本不会有人来问地址（`dshDesktop.browser` 拿不到 ⇒ 贡献循环整体 return，
     * 一个 RPC 都不发）—— 那就别给 web 版开一个常驻监听器（凭空多一个端口是行为变化）。
     * 懒起也让「起了就一定用得上」成立：唯一调用方是 `captcha.carrierUrl` 那条 RPC。
     */
    private carrierPageServer;
    /** 构造期注入的诊断日志（载体链与载体页小服务共用同一条通道，见 `ZcodeAuthOptions`）。 */
    private readonly carrierLog;
    /**
     * captcha 产出的**观测计数**（对齐官方 `mnn` 的 ARMS 上报思路）。
     *
     * 官方把每次结果作为 `traceless_passed` / `interactive_displayed` 上报，
     * 并维护两个计数器 —— 那是它判断「设备信誉是否在恶化」的手段。
     * 我们至少要把这两个数**记下来并通过日志暴露**，否则降级发生时
     * 用户和我们都没有任何趋势可看（这正是这次排查最缺的东西）。
     */
    private readonly captchaStats;
    /** 最近一次失败原因（供 `status()` 暴露给 UI）。 */
    private lastError;
    constructor(ctx: Context, options?: ZcodeAuthOptions);
    /** 凭据 ref 名（供 Jet Hub 展示）。 */
    get credentialRefName(): string;
    /** 产品配置（测试与 Jet Hub 用）。 */
    get productConfig(): ZcodeProduct;
    /**
     * 读取当前凭据（**唯一来源：插件自己存的那份**）。
     *
     * ## ⚠ 不再有第二个来源（2026-10-05 用户决策）
     *
     * 旧实现会回退去解密官方客户端的 `~/.zcode/v2/credentials.json`
     * （「装了 ZCode 就零操作可用」）。该能力**已整体删除**，理由见
     * `src/zcode.ts` 文件头。⇒ 现在没有 ZCode 账号就是没有，
     * UI 必须引导用户走 Jet Hub 里的登录，**不要**再暗示「装了客户端就能用」。
     *
     * 返回 `undefined` 表示「没有可用的 ZCode 登录态」。
     */
    current(): Promise<ZcodeCredential | undefined>;
    /**
     * 读插件自存的凭据（`ctx.credentials`）。
     *
     * ## ⚠ 必须同时认**账号池里的 ref**（真实缺陷）
     *
     * 凭据可能落在**两个**地方，ref 名不同：
     *
     * | 来源 | ref |
     * |---|---|
     * | RPC `account.create`（用户点「添加账号」） | **`ZCODE_ACCOUNT_XXXX`**（`refName`） |
     * | 单凭据回退 / 手工写入 | `ZCODE_CREDENTIAL`（`defaultCredentialRef`） |
     *
     * 早期只读后者 —— 于是「用户在 Jet Hub 登录成功」之后，
     * `probe()` / `fetchBalance()` / `status()` / `fetchCheckinStatus()`
     * **全都读不到凭据**（它们都走本方法），表现为：
     * **能聊天（适配器读账号条目的 ref），但面板显示「未配置」、积分查不出**。
     *
     * ⇒ 顺序：**账号池（用户的显式登录）> 单凭据 ref（回退）**。
     * 与适配器的解析顺序保持一致，避免「适配器能用而面板不能用」。
     *
     * ⚠ **形状校验必须做**：凭据存储里可能有**任何**字符串（用户手填、旧版本
     * 残留）。`isUsableZcodeCredential` 保证后续代码拿到的是完整对象。
     */
    private readStoredCredential;
    /**
     * 从账号池里第一个**凭据可用**的 zcode 账号读取。
     *
     * ⚠ **不看 `enabled`** —— 与其余 provider 的既有约定一致
     * （`AGENTS.md`：停用只影响自动选号，与凭据是否可用无关）。
     * 用户停用了账号，面板仍应能显示它的额度与状态。
     */
    private readCredentialFromPool;
    /** 从某个 ref 解析凭据（带形状校验）。 */
    private readCredentialFromRef;
    /**
     * 取账号池。
     *
     * ⚠ 用 `ctx.get` 而非构造注入：本服务可能在**账号池注册之前**被构造
     * （`index.ts` 里 `new ZcodeAuth(ctx)` 早于 `registerJetHubRpc`，
     * 且测试里账号池可能是后提供的）。惰性读取能让两种情况都成立。
     */
    private accountPool;
    /**
     * 探活：凭据是否可用。
     *
     * 判据是**端到端**的 —— 能不能真的查到额度。这样「证书解出来了但
     * 已失效」也会被如实反映（比只看文件存在可靠）。
     */
    probe(): Promise<ZcodeProbeResult>;
    /**
     * ★ **插件内登录** —— 走官方 CLI 设备授权流，**不需要 ZCode IDE**。
     *
     * ## 为什么这是「登录」而不是「读凭据」
     *
     * 早期实现**只有**「确认磁盘上有一份官方客户端写的凭据」这一条路，
     * 那要求用户先装并登录官方 ZCode 客户端 —— 与本插件「装完即用」的
     * 定位冲突。而现在**只剩**本方法这一条路（磁盘读取已于 2026-10-05 删除）。
     *
     * 实测确认官方 3.12.3+ 用的是**服务端中介的设备授权流**
     * （`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`），
     * 完全不经 `zcode://` 回调，**普通 Node 进程就能走完**（见 `zcode-login.ts`）。
     *
     * ## 返回形状与其余 provider 一致
     *
     * `{ loginUrl, result }` —— `loginUrl` 是**真的**授权 URL（前端据此弹窗），
     * `result` 是等待用户授权完成的 Promise。
     *
     * ⚠ 与本文件其它方法不同，这个方法**不是幂等的**：每次调用都会向
     * 服务端申请一条新的授权流程。前端只在用户点「添加账号」时调一次。
     */
    startLogin(options?: {
        refName?: string;
        appVersion?: string;
        provider?: ZcodeLoginProvider;
    }): Promise<{
        loginUrl: string | undefined;
        result: Promise<{
            refName: string;
            credential: ZcodeCredential;
        }>;
    }>;
    /**
     * 换取 coding-plan（**付费订阅**）通道的 api-key。
     *
     * ## 为什么需要这一步（真实断链，2026-10-05 修）
     *
     * `coding_plan_key_*` **不是登录时下发的** —— 官方用登录拿到的 OAuth
     * access_token **现换**（逆向 `AccountProviderApiKeyResolver`，
     * 见 `zcode-transport.ts` 的 `fetchCodingPlanApiKey`）。
     *
     * ⚠ 此前这条链是**断的**：`fetchCodingPlanApiKey` 建好了却**没有任何调用方**，
     * 而两个 key 字段的**唯一**写入点是「从本机 ZCode 客户端读凭据」——
     * 那条路已于同日删除 ⇒ **纯插件登录用户的 coding-plan 通道一直不可用**
     * （表现为 `glm-5.3` / `glm-5.3-flash` 在通道表里 unavailable）。
     *
     * ⇒ 本方法把缺的那一环接上。原料是齐的：登录结果里**必然**带
     * `zai_access_token` 或 `bigmodel_access_token`（`startLogin` 刚写进去）。
     *
     * ## 失败绝不牵连登录
     *
     * 换不到 key 只意味着「用户没买 coding-plan，或云上没有那个 key」
     * （`reason` 会区分）—— `start-plan`（免费积分）**照常可用**。
     * 故这里**只记日志、返回 `undefined`**，绝不抛。
     *
     * @returns api-key；换不到（没 token / 没订阅 / 超时 / 网络错）时 `undefined`。
     */
    private resolveCodingPlanKey;
    /**
     * 阻塞式登录（等待用户在浏览器完成授权）。
     *
     * ⚠ 与 `startLogin` 的区别：这个会**等到授权完成**才返回。
     * 供「没有前端、只想在脚本里登录」的场景用；Jet Hub 走 `startLogin`
     * （两步式，避免弹窗被拦截）。
     */
    login(options?: {
        refName?: string;
        appVersion?: string;
    }): Promise<{
        refName: string;
        credential: ZcodeCredential;
    }>;
    /**
     * 把**当前可用凭据**（插件自存）写进 `ctx.credentials`。
     *
     * ⚠ 若已有插件自存凭据，本方法会**覆盖**它 —— 调用方需自行确认
     * （Jet Hub 的「添加账号」在已有账号时不会走到这里）。
     */
    persistCurrent(refName?: string): Promise<{
        refName: string;
        credential: ZcodeCredential;
    }>;
    /**
     * 拉取服务端下发的 captcha 配置（**带 60 秒 TTL 缓存**）。
     *
     * ## 为什么要缓存（对齐官方）
     *
     * 官方 `f3()` 对 captcha 配置做了 60 秒 TTL 缓存 + 在飞去重
     *（`out/renderer/assets/styles-*.js` 的 `expiresAt: t + 6e4`）。
     * 此前我们在 `index.ts` 用 `??=` 做**永久缓存** —— 两个问题：
     *
     * 1. **服务端换 `sceneId`／灰度切换后永不生效**（必须重启宿主）；
     * 2. **首次拉取失败会被永久固化**（`??=` 把失败结果也记住）。
     *
     * 现在改成 {@link TtlCache}：60 秒后自动重取，**失败不缓存**。
     *
     * 失败返回 `undefined`，由调用方回退到 `ZCODE_CAPTCHA_FALLBACK`。
     */
    fetchCaptchaConfig(): Promise<{
        region: string;
        prefix: string;
        sceneId: string;
    } | undefined>;
    /** captcha 配置缓存（60 秒 TTL，对齐官方 `f3()`）。惰性创建。 */
    private captchaConfigCache;
    private captchaConfigCacheInstance;
    /** 查额度（Jet Hub 的「余额」用）。 */
    fetchBalance(): Promise<ZcodeBalanceResult | undefined>;
    /**
     * 用**给定凭据**查额度（Jet Hub 逐账号查询时用）。
     *
     * 与 {@link fetchBalance} 的区别：那个用「当前磁盘凭据」，
     * 这个用调用方给的那份（每个账号条目各自的凭据）——
     * 多账号场景下两者可能不是同一份。
     */
    fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined>;
    /**
     * 那条**外挂 chromium** 的产出链（退避闸门 → 全局串行队列 → 预取池 take）。
     *
     * 历史上它就是 `mintCaptcha` 的全部；Task 5 起被 {@link CaptchaCarrier} 当作
     * 「chromium 兜底」那一腿注入进去，公开入口改叫 {@link mintCaptcha}。
     *
     * ## 走**预取池**（2026-09-30 新增）
     *
     * 每次请求现产的成本实测 0.5-3.7 秒（页面空闲 <8s 复用约 0.5s，更久则要
     * 新建页面约 3.7s），而 agent 多步循环的两步间隔通常**大于 8 秒** ——
     * 也就是说现产路径几乎每步都付新建页面的钱。
     * {@link CaptchaPool} 把这段成本移到**后台**：上一轮结束时产好下一轮的 param。
     * ⚠ 上面那句「更久要新建页面」的**前提已被推翻**（2026-10-01 复测：`F001` 与空闲
     * 时长没有稳定因果，见 `zcode-captcha.ts` 的 `mint()` 第 2 条），现行策略是
     * **复用优先、失败才换页** ⇒ 常态下现产只要约 0.4–0.5 秒，本池的相对收益随之变小。
     *
     * ⚠ 语义没变：池只存**尚未使用**的 param，取走即弃（在索要验证的窗口里复用必 `3007`）。
     *
     * 关闭方式：`DSH_ZCODE_CAPTCHA_POOL=0`（关闭后行为与引入池之前逐字一致）。
     *
     * ⚠ `options.signal` 会被透传到浏览器侧（取页等待 / 建连超时 / abort）——
     * 推理链路的「停止」能否生效就靠它（真实缺陷，2026-09-29）。
     *
     * ## ★ 产出失败会进入**指数退避**（2026-10-01 新增，会话实证驱动）
     *
     * `session-eced01ed` 里额度耗尽后连续 **12 次**空响应，而每次重试都重新
     * mint 一个 captcha —— 在注定失败的情况下白耗 12 个配额，且**扣设备信誉**
     * （同分钟另一个 session 就报 `502 Failed to mint auth material`）。
     *
     * 故这里加闸门：连续产出失败达阈值后，**直接抛错不再发起 mint**
     * （那边注释原话：「继续请求不会让信誉恢复，只会更糟」）。
     * 详见 {@link CaptchaBackoff}。
     *
     * ## ★★ 产出走**全局串行队列**（2026-10-01 新增，对齐官方）
     *
     * 官方闭源版把 captcha 产出链在一条全局 promise 上（`jnn`/`wnn`，
     * 日志 `zcode-plan verification queue slot acquired`）——
     * **同一时刻只产一个**。原因是阿里云按**设备维度**限流
     * （官方文档：同设备每小时 150 次），并发产出是纯浪费。
     *
     * 而 DSH 会并发发请求（主回复 + 标题生成 + 压缩），此前每个都独立 mint。
     *
     * ⚠ **Task 5 把它改成了 private**：函数体一行语义没动（闸门 → 队列 → 池 take），
     *   只是换了名字，让 {@link CaptchaCarrier} 能把「chromium 兜底」这一腿注回**同一条链**。
     *   公开入口是同文件的 {@link mintCaptcha}（claim/签到与 `account-probe` 仍在用它）。
     */
    private mintWithChromium;
    /**
     * 产出 captcha param —— `ctx.zcodeAuth` 的公开入口（`account-probe` 与 claim 的注入回调用）。
     *
     * ⚠ **不经载体链**，逐字就是那条 chromium 链：
     * - **`account-probe.ts`**：探测要的是「现在就发得出去」的 param，等一个
     *   「为下一发就位」的 param 毫无意义；
     * - **claim/签到**：`jet-hub-rpc.ts` 注入进来的是**这条兜底腿**（要现取
     *   `fetchCaptchaConfig()`，故由调用方提供），claim 入口在其之上还叠了
     *   「内部载体优先」那一层，见 {@link mintClaimCaptcha}。
     * 推理热路径那条「内部优先 + 当次回退」走 {@link mintCaptchaParam}。
     */
    mintCaptcha(config?: {
        region: string;
        prefix: string;
        sceneId: string;
    }, options?: {
        signal?: AbortSignal;
    }): Promise<string>;
    /**
     * ★ **载体页的地址**（`captcha.carrierUrl` 那条 RPC 的唯一来源）。
     *
     * 第一次调用时懒起一个**只监听 `127.0.0.1` 的独立小服务**，之后一直复用；
     * `stop()` 里关掉（插件卸载 ⇒ 不留常驻监听器）。
     *
     * ## 返回 `null` 的三种情况（client 拿到 null 就安静退出，本轮不导航）
     * 1. `DSH_ZCODE_INTERNAL_CARRIER=0`（用户显式关掉内部载体）；
     * 2. 端口候选全被占 / 监听失败（`CarrierPageServer.start()` 的契约是不抛、回 null）；
     * 3. 尚未起（只有在被问到时才会起，所以「没起」等价于「没人要」）。
     *
     * ⚠ **不要**在这里再做「是不是桌面版」的判断：server 侧判断不了 GUI 形态
     *   （web 版与桌面版跑的是同一个宿主进程）。真正把 web 版挡在门外的是 client 侧
     *   规则 1（拿不到 `dshDesktop.browser` 就整体 return，一个 RPC 都不发）——
     *   见 `plugin-src/client/zcode-carrier.js`。
     */
    carrierPageUrl(): Promise<string | null>;
    /**
     * claim（领取）路径的 param 产出：**内部载体优先**，等不到即落那条注入的 chromium 链。
     *
     * ## 为什么领取是需求位的**唯一**触发点（2026-09-29 实测）
     * | 端点 | 3.14.4 之后是否索要 captcha |
     * |---|---|
     * | 模型请求（推理） | **否** —— 6 个采样点不带验证头也是 HTTP 200（官方更新说明同口径） |
     * | `/zcode-plan/billing/claim` | **始终是** —— 带非法 captcha 与不带 captcha 都回 `400/3007`，且**校验前置于 plan 校验** |
     *
     * ⇒ 置位点在推理侧就是**死触发点**（推理永远不撞 `3007` ⇒ 需求位恒假 ⇒
     *   client 永远不产 param ⇒ 内部载体接了个空壳）。置位点必须跟着 claim 走。
     *
     * ## 三条出口（与 {@link CaptchaCarrier.mint} 同序）
     * 1. 载体链不参与（`DSH_ZCODE_INTERNAL_CARRIER=0` / 本机从未收到过贡献 ⇒ web 版）
     *    → 逐字走注入的那条链，**零额外开销**（既有行为逐字不变）；
     * 2. **需求位为假** → 不取槽也不等：`captchaDemand` 就是「此刻有人在索要验证」的
     *    信号，窗口外取槽等于把为下一次窗口备的货提前烧掉（且必然白等 `waitMs`）；
     * 3. 需求位为真 → 载体链（先取槽、再有界等一次贡献），取不到才落注入的链。
     *
     * ⚠ 一次性由 `takeFreshParam` 保证（取走即清），故「每 plan 一个」不会被复用成 `3007`。
     * ⚠ 载体链**禁用**（内部 param 被上游拒到阈值）时同样落注入的链 —— 归因纪律见
     *   `src/captcha-carrier.ts` 文件头。
     *
     * ## ⚠ `config` 必须**原样透传**给注入链（真实缺陷，Gitee issue IKJNPS）
     *
     * 注入链（`zcode.mintCaptcha`）拿到的 config 决定 param 由**哪个 region** 签发，
     * 而请求头里的 region 取自**同一份**（`claimDailyWith` 解析的那次）。
     * 这里若「顺手再拉一次配置」或干脆不传，两跳之间（60 秒 TTL 里服务端换 region
     * 也可能）就会漂成两份真相，稳定复现成 `3007` —— 而 param 与 region 不同源
     * 时**重试多少次都没用**，它不是概率问题。
     *
     * ## ★ 返回值带 `source`（评审 C4）
     * 领取端点 `/zcode-plan/billing/claim` **始终索要** captcha（实测：带非法与不带都
     * `400/3007`，且校验**前置于** plan 校验）⇒ 内部 param 在这条路径上被拒的概率
     * 比推理路径高得多，必须能归因。`claimDailyWith` 靠这个 `source` 决定
     * 「记一次 internalRejected + 当次换注入链重发一次」（见那里）。
     */
    private mintClaimCaptcha;
    /**
     * 内部载体**此刻是否可用**（= 本次要不要走载体链）。两个条件缺一不可：
     *
     * 1. env 没关（`DSH_ZCODE_INTERNAL_CARRIER=0` ⇒ 既不等待也不取槽）；
     * 2. 这个进程**真的收到过**至少一次贡献（`captchaSupplyStats().supplied > 0`）。
     *
     * ## 为什么第 2 条不能省（web 版逐字不变就靠它）
     * web 版里**没有任何人**会去轮询需求位（拿不到 `dshDesktop.browser`，贡献循环整个
     * 不启动），载体链若据此去 `waitForFreshParam`，就会**每次取 param 都白等 1.5 秒**
     * 再走 chromium —— 而 web 版永远不会有贡献，这一等纯亏。拿「收到过贡献」当证据即可两全：
     * 桌面版的贡献与消费在**同一进程**（RPC 直接落槽），一次投放之后才可能有第二次命中。
     *
     * ⚠ 这是一台**闩锁**（once true, stays true）：桌面版 client 后来死了不会自动关掉，
     *   那种情况下每发最多多等 1.5 秒再退回 chromium，且 `carrier().supply.waitTimeouts`
     *   会一路往上涨 —— 那个数就是「该关掉内部载体了」的现场证据（`DSH_ZCODE_INTERNAL_CARRIER=0`）。
     */
    internalCarrierAvailable(): boolean;
    /**
     * 推理热路径的 param 产出：**内部载体优先**，等不到再落那条 chromium 链。
     *
     * 返回 {@link CarrierOutcome}（带 `source`）—— 上游回 `3007` 时的**归因**要看它：
     * 只有内部来源的 param 被拒才记一次 `internalRejected`（见 {@link CaptchaCarrier}）。
     *
     * ⚠ 需求位**不在这里**置：置位点是 **claim（领取）入口**
     *   （{@link claimDailyWith} 的 `try/finally`）—— 3.14.4 起上游只对领取索要验证，
     *   推理路径已不再驱动内部载体（依据见 {@link mintClaimCaptcha} 的那张表）。
     *   这里只消费需求位。
     */
    mintCaptchaParam(config?: {
        region: string;
        prefix: string;
        sceneId: string;
    }, options?: {
        signal?: AbortSignal;
    }): Promise<CarrierOutcome>;
    /**
     * 带着 param 的那一发被上游 `3007` 拒 ⇒ 交回载体链做**归因 + 当次回退**。
     *
     * ## 三条纪律（都写进了 `tests/unit/zcode-carrier-auth.spec.ts`）
     * 1. **只按 `outcome.source` 归因**：来源是 `chromium` 的 param 被拒，是「时效/信誉」
     *    问题（`CaptchaBackoff` 管的那本账），**不许**记到载体头上；
     * 2. 载体链本身不可用（env 关 / web 版）⇒ **一个数都不记**，直接换一个新的 chromium
     *    param —— 否则面板会出现「一次都没用过的内部载体被拒 3 次」；
     * 3. chromium 腿撞上**退避冷却**而抛错 ⇒ 保持既有抛出语义（原样上抛，不吞、
     *    不退化成「不带 param 再撞一次」）。
     */
    mintCaptchaAfterRejection(outcome: CarrierOutcome, config?: {
        region: string;
        prefix: string;
        sceneId: string;
    }, options?: {
        signal?: AbortSignal;
    }): Promise<CarrierOutcome>;
    /** 取（并惰性创建）captcha 预取池。 */
    private captchaPoolInstance;
    /**
     * captcha 产出的**观测快照**（供 Jet Hub / 诊断读取）。
     *
     * 对齐官方维护 `traceless_passed_count` / `captcha_displayed_count` 的思路：
     * 用户与我们都该能看到「无感通过 vs 被要求交互」的比例趋势。
     */
    captchaObservability(): {
        tracelessPassed: number;
        interactiveDisplayed: number;
        failed: number;
        probeFirstCount: number;
        knownRequiredCount: number;
        failureStreak: number;
        queuePending: number;
        cooldownRemainingMs: number;
        carrier: ReturnType<CaptchaCarrier['stats']>;
    };
    /**
     * 用**给定凭据**领取每日额度（Jet Hub 逐账号领取时用）。
     *
     * 与 {@link claimDaily} 的区别同 {@link fetchBalanceFor}。
     *
     * ⚠ `captchaRegion` **不要传**：省略即跟随「本次 mint 用的那份配置」
     * （真实缺陷，Gitee issue IKJNPS —— 传兜底常量 `cn` 会让非 cn 区账号恒 `3007`）。
     * 保留它只是为了在特殊场景显式覆盖，正常入口一律省略。
     */
    claimDailyFor(credential: ZcodeCredential, mintCaptcha: ZcodeClaimCaptchaMint | undefined, captchaRegion?: string): Promise<ClaimOutcome[]>;
    /**
     * 拉模型目录。
     *
     * ⚠ ZCode 的模型表是**静态白名单**（实测可用的两个），不发网络请求
     * 去枚举 —— 上游 `/v1/models` 是桥的端点（我们不再依赖桥），
     * 而 `client/configs` 的模型池含**实测不可用**的两条
     * （`GLM-5-Turbo` / `GLM-5.2` 返回空响应）。
     * 故直接返回兜底表，语义是「实测可用的清单」。
     */
    fetchModels(): Promise<ZcodeRemoteModelLike[]>;
    /**
     * 只取**真远端**目录；未登录 / 上游失败 / 上游解析出 0 条 ⇒ `[]`。
     *
     * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
     *
     * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
     * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
     * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
     * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
     * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
     */
    fetchRemoteModelsOnly(): Promise<ZcodeRemoteModelLike[]>;
    /**
     * 查签到状态。
     *
     * ## ⚠ 判据是「有没有可领的 plan」，**不是**「列表是否为空」
     *
     * 与 Qoder 那次教训同型（`AGENTS.md` 记过）：服务端在活动不同阶段
     * 都可能回空列表。而 ZCode 的服务端**不会主动推送**活动 ——
     * 必须先补 `event/report`（`app_launch` + `app_daily_active`），
     * `preview` 才会下发 plan。
     *
     * 故本方法**先补激活信号再查**，否则会稳定误报「今日已领」。
     */
    fetchCheckinStatus(): Promise<CheckinStatus>;
    /** 逐账号使用自己的凭据，已拥有的待生效活动也属于已领取。 */
    fetchCheckinStatusFor(credential: ZcodeCredential): Promise<CheckinStatus>;
    /**
     * 领取每日额度。
     *
     * ## 流程（每一步都不能省）
     *
     * 1. 补活跃上报 → 2. 查 preview → 3. 逐个 claim
     *
     * ## ⚠ captcha 是**一次性**的
     *
     * 每个 plan 都必须**重新 mint** 一个新 param（在索要验证的窗口里，复用会得 `3007`）。
     * 本路径**不走先探后取**：每个 plan 都现产一个，故「一次性」在这里是必须遵守的前提，
     * 没有「这次上游没校验所以可以复用」的余地（那只在**推理**路径上由探测结果决定，
     * 见 `captcha-requirement.ts`）。
     * 故 captcha 的产出来自调用方注入的 `mintCaptcha` 回调 ——
     * 让本服务不必知道浏览器怎么起（也便于单测注入桩）。
     *
     * ## ★ 内部载体的需求位跟着**领取**走
     * 领取端点始终索要 captcha（推理侧自 3.14.4 起已不索要）⇒ 需求位在本方法内
     * 置起、在 `finally` 里清掉，per-plan 的 param 产出**内部载体优先**。
     * 依据与落点理由见 {@link claimDailyWith}，产出顺序见 {@link mintClaimCaptcha}。
     *
     * ## ⚠ `1003`（已领取）是**成功**
     *
     * 服务端对「已领取过」回 `code:1003`。把它当失败会让定时任务
     * 反复误报 —— 这与 Buddy / Qoder 的幂等语义一致。
     *
     * ⚠ `captchaRegion` 与 {@link claimDailyFor} 同款：**省略即跟随配置**，别传兜底常量
     * （真实缺陷，Gitee issue IKJNPS）。
     */
    claimDaily(mintCaptcha: ZcodeClaimCaptchaMint | undefined, captchaRegion?: string): Promise<ClaimOutcome[]>;
    /**
     * 领取的共用实现（`claimDaily` 与 `claimDailyFor` 都走它）。
     *
     * ## ★ 内部载体的**需求位**归这里（2026-09-29）
     *
     * 领取端点 `/zcode-plan/billing/claim` **始终强制索要** captcha
     * （实测：带非法 captcha 与不带 captcha 都回 `400/3007`，且**校验前置于 plan 校验**），
     * 而**模型请求**自 ZCode 3.14.4（2026-09-29）起**不再校验**（6 个采样点不带验证头也
     * HTTP 200，官方更新说明同口径）⇒ 需求位只能跟领取走。
     *
     * ### 为什么落在这里，而不是 `src/jet-hub-rpc.ts` 的编排层
     * 两条领取入口（RPC 的「一键领取」`claimDailyFor` 与定时自动领取 `claimDaily`）
     * **都收敛到这个方法**；放在编排层就得要求每个调用方自己记得置位 ——
     * 漏一处 = 那条路静默退化成 chromium，而**外部看不出来**（领取照样成功，只是
     * 内部载体白接）。放在这里则「进入领取窗口」与「置位」是同一个动作，无法漏。
     *
     * ### 为什么用 `try/finally`，而不是 TTL 看门狗
     * 领取窗口是**有界**的（几秒 ~ 几十秒：激活上报 + 查 plan + 逐 plan 领取），
     * `finally` 覆盖成功、抛错、提前 return（没浏览器 / 无可领 plan）**全部**出口；
     * 而推理侧当初那道「空闲一个 TTL 自动落下」的看门狗正是为「窗口无界」设计的，
     * 搬过来反而更弱：claim 卡住时它会先于领取结束落下。
     *
     * ⚠ 需求位是**进程级**的位，`finally` 漏写就是「client 无限定地产 param」的最坏形态
     *   （阿里云同设备每小时 150 次，见 `src/captcha-backoff.ts`）
     *   —— 故由 `tests/unit/zcode-carrier-auth.spec.ts` 的源码用例 + 行为用例双向锁死。
     *
     * ## ★★ region 与 param **必须来自同一份配置**（真实缺陷，Gitee issue IKJNPS）
     *
     * 阿里云验签把 param 与 `x-aliyun-captcha-verify-region` **成对**校验，
     * 不一致即 `400 / 3007`。而 region 由**服务端**下发（`client/configs`，
     * 本仓库作者所在账号是 `cn`，z.ai 国际渠道实测是 **`sgp`**），
     * 把它写成本地兜底常量只会在 cn 区账号上「碰巧正确」。
     *
     * 修复前的形态是**两份真相**：`jet-hub-rpc.ts` 的注入回调自己
     * `fetchCaptchaConfig()` 拿配置产 param，而 region 走本方法的**默认参数**
     * `ZCODE_CAPTCHA_FALLBACK.region` ⇒ 非 cn 区账号 100% 领不到
     * （用户报障：15/15 全部 3007；同账号改用配置里的 region 后立即成功 +100M）。
     *
     * ⇒ 这里解析**一次**配置，region 从它取、并把它传给注入回调：
     * 「产 param 的那份」与「写 region 的那份」从此是**同一个对象**。
     */
    private claimDailyWith;
    /**
     * 领取**单个 plan** 的完整一步：mint → 首发 → 3007 换链重发 → 判定是否短路。
     *
     * ## 为什么抽成独立方法
     *
     * 它自带 `try/catch`，并**返回「是否继续下一个 plan」** —— 这两个都是
     * 「单发」的概念，不属于编排层。留在 {@link claimDailyWith} 的循环里会让
     * 那个方法同时承担编排与单发两种职责，并撞上源码切片护栏
     * （`tests/unit/zcode-close-chromium.spec.ts` 断言其源码切片 < 8000 字符；
     * 混写时实测 9246）。
     *
     * ## ★★ 3012 短路**只在这里判断一次**（真实缺陷，2026-10-05）
     *
     * 首发的 `3007` 会触发换链重发，而**短路检查曾位于该换链之前**，
     * 于是重发那一发**绕过**了短路。桩测实测（两个 plan，首发 3007 ⇒ 重发 3012）：
     *
     * ```
     * claims=3 outcomes=2   → 被风控的账号继续发了下一个 plan 并成功领取
     * ```
     *
     * 即「一次点击连续触发多次风控」这条**恰在最需要它的场景下失效** ——
     * 上游先因 captcha 拒、再因风控拒，正说明它已在盯这个账号。
     * ⇒ 现在换链的结果**写回 `outcome`**，再由**唯一一处** `isClaimUnusualActivity`
     * 判定短路，首发与重发天然共用，结构上不可能再漏。
     *
     * @returns `outcome` 本条结果；`continueWithNextPlan` 为 `false` 时调用方须 `break`
     *   （即命中 `3012` 风控 —— **不要再发下一个 plan**，那会加重冷却惩罚）。
     */
    private claimOnePlan;
    /**
     * ★ 评审 C4 的那一次重发：用**注入链**产一个新 param 重发同一个 plan（上限一次）。
     *
     * ## 为什么单独抽一个方法（而不是塞进循环里）
     * 它有**自己的异常语义**：注入链可能撞上退避冷却而抛错（`mintWithChromium` 的闸门）。
     * 那时**必须**如实抛给外层的 `catch`（记成这个 plan 的 failed），**不许**吞掉、
     * 也不许退化成「不带 param 再撞一次」—— 那等于把既有护栏拆了
     * （纪律见 `mintCaptchaAfterRejection` 的第 3 条，推理路径上早就这么定过）。
     *
     * ## 文案必须能区分两种失败
     * 「换 chromium 之后**仍然**被拒」与「随手 3007」对用户是两件事：
     * 前者意味着**这台机器的设备信誉有问题**（上游把无感验证降级了），
     * 继续点只会更糟；后者可能只是这一发赶上了什么。`toClaimOutcome` 的
     * `internalRetried` 开关就是干这个的。
     *
     * ## ⚠ 重发**不重新取配置**（issue IKJNPS 的同一条纪律）
     * 换的是 param，不是 region。config 与 `captchaRegion` 都由调用方
     * （`claimDailyWith`）原样传进来 —— 保持「param 与 region 同源」这件事
     * **贯穿整个领取窗口**，包括这一次重发。
     *
     * @param diagnostics 诊断现场（Gitee issue IKJOQB）—— 重发这一发**同样是
     *   一次真实的上游请求**，`sent` / `ok` / `failed` 三笔账都要记到同一个账号上，
     *   否则 issue 要的「本进程 成功 N/失败 M」会漏掉这一类失败。
     *
     *   ⚠⚠ **只传 `accountId`，`sentAt` 由本方法自己取**（不是沿用首发的）。
     *   `noteZcodeRequestSent(id, sentAt)` 的 `sentAt` 语义是「**本次**出发时刻」，
     *   而 `previousSentAt` 是「上一条」的分母。若把**首发**的时刻当作重发的
     *   出发时刻传进来，`previousSentAt` 会被写成首发时刻 == 本次 ⇒
     *   `formatZcodeDiagnostic` 算出 `距上条 0ms`，「距上一条请求隔多久」
     *   这一项**永久失去信息量**（实测复现过，见下）。
     *
     *   ⚠ 这不是理论风险：把 `sentAt` 写成首发的值后，探针实测诊断行是
     *   `… · 距上条 0ms · HTTP 405`，而正确值应是「首发到上一条真实请求」的间隔。
     *   本仓库在推理侧为同一个坑写过专门用例
     *   （`tests/unit/zcode-diagnostics.spec.ts` 的「距上条算的是**上一条**请求」），
     *   这里若传首发时刻就是**同型缺陷的第二次实例**。
     */
    private retryClaimWithInjectedChain;
    /**
     * 反查领取凭据对应的**账号池条目 id**（诊断画像的 key），供
     * {@link claimDailyWith} 的 `noteZcodeRequest*` 埋点使用。
     *
     * ## 为什么必须与推理路径用同一个 key
     *
     * 推理侧用的是**池条目 id**（`index.ts` 的 `activeZcodeAccountId`）。
     * 若领取侧另用 `user_id` / `credentialRef`，同一个账号会拿到两个序号，
     * 诊断里的「本进程 成功 N/失败 M」被劈成两半 —— 而 issue 要回答的
     * 「这个账号此前成功过几次 / 是否突然开始被拦」正靠这一项。
     *
     * ## ⚠ 用 `findAccountIdByIdentityField` 而**不是** `findAccountIdByCredential`
     *
     * 后者写死了「codearts 用 `access_key_id`、其余用 `access_token`」
     * （见 `account-pool.ts` 的方法注释），而 zcode 凭据里**没有** `access_token`
     * 字段（它用 `zcode_jwt` / `user_id`）⇒ 拿它查 zcode 恒回空串，
     * 诊断会静默退化成「所有账号都是 #1」。
     *
     * ## 处处容错（非关键路径）
     *
     * 账号池可能未注册（headless / 单测）、`user_id` 可能缺失（老凭据）——
     * 这些**都不该影响领取**，故整段吞异常并回 `undefined`：此时诊断退化成
     * 「账号#1 + 只有领取路径的计数」，如实降级，绝不编造。
     */
    private resolveClaimAccountId;
    /**
     * RPC `account.refresh`。
     *
     * ## ⚠⚠ 这里曾经有一个**数据破坏缺陷**（真实缺陷，2026-10-02）
     *
     * **用户报障**：「登录了 2 个账号（两个不同微信各自收到 bigmodel 登录通知），
     * 第二个账号有余额，但插件刷新积分显示 0，发消息报『额度已用尽』，
     * 而 IDE 里同一个账号发消息能收到回复」。
     *
     * **根因**：本方法与 {@link refreshAll} 都拿 `this.current()` 的结果
     * **无条件写回目标 ref** —— 而 `current()` 只返回**第一个凭据可用的账号**。
     * 于是账号 A 的凭据被写进账号 B 的 ref，**B 的原始凭据被永久覆盖**。
     *
     * **实测证据**（用户机器 `~/.dsh/.credentials.yaml`）：两个条目的
     * `zcode_jwt` 的 sha256、`device_mid`、`account_label`（同一昵称）、
     * `bigmodel_access_token` **全部逐字节相同** —— 同一个账号占了两条。
     * 用户确认「是两个不同微信账号」，故**只能是覆盖所致**。
     *
     * ⚠ **此处刻意不写真实值**：ref 名会暴露账号编号、昵称是用户的微信账号名、
     * `device_mid` 是设备标识。需要复核时从本机凭据自行取。
     *
     * **症状为何那么像服务端问题**：IDE 用自己那份真实凭据（B）→ 正常；
     * 插件池里两条都是 A → A 已耗尽 → 报额度用尽。
     *
     * ## 修法：**绝不跨账号写**
     *
     * ZCode **不可续期**（凭据是静态的，没有 refresh 端点），所以「刷新」
     * 唯一正确的语义是：**重新解析该账号自己的 ref，再写回它自己**
     * （用于「用户在别处更新了这个账号的凭据」这种情形）。
     * 与 `BuddyAuth.refreshAll` 的做法一致（那边也是逐账号读自己的 ref）。
     *
     * ⚠ 传了 `refName` 就**只动那一个 ref**；没传才回退到当前账号自己的 ref。
     * 无论如何**不会**拿到 A 的凭据去写 B。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量续期（定时调度器调用）。
     *
     * ## ⚠⚠ 这里曾经是**跨账号覆盖**的第二个入口（真实缺陷，2026-10-02）
     *
     * 旧实现：
     * ```ts
     * const credential = await this.current()          // ← 只取「第一个可用账号」
     * for (const account of accounts) {
     *   await set(account.credentialRef, credential)   // ← 覆盖**每一个**账号
     * }
     * ```
     * 于是 30 分钟一轮的定时器会把账号 A 的凭据**铺满整个池**，
     * 抹掉其余账号的真实凭据（详见 {@link refreshAccountCredential} 的实测证据）。
     *
     * 旧注释的本意是「一份新凭据能铺开到所有条目」——
     * 那个前提在**多账号池**下是**错的**：一份凭据只对应**一个**账号。
     *
     * ## 正确做法：逐账号、各写各的
     *
     * ZCode **不可续期**，故这里没有「续期」动作；做的是**逐账号对账**：
     * 每个账号重新解析**自己的** ref，能解出就写回自己（规范化字段），
     * 解不出就**跳过并告警**（不填别人的凭据）。
     *
     * ⚠ **必须用它，不能自己写 `current()` + `getAvailableAccount()`**：
     * `current()` 先读池且**不看 `enabled`**，`getAvailableAccount` **过滤 `enabled`**，
     * 两者可能指向不同账号 ⇒ 「A 的凭据写进 B 的 ref」（见 `src/index.ts` 的 `refresh`）。
     *
     * ⚠ **只按 `refreshable` 过滤、不看 `enabled`**（`AGENTS.md` 既有约定：
     * 停用只影响自动选号，与凭据新鲜度无关）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * `status()` —— 供 Jet Hub 展示「是否已配置」。
     *
     * 与其余 provider 同形（返回 `{configured, ...}`）。
     */
    status(): Promise<{
        configured: boolean;
        label?: string;
        error?: string;
    }>;
    /**
     * 释放资源。
     *
     * ⚠ 契约要求：`index.ts` 的 cleanup 对**全部** provider 统一调 `stop()`，
     * 缺了它会以 `is not a function` 崩在启动路径上
     * （`LoomyAuth` 的注释记过同一条）。
     *
     * ⚠ 会一并关闭 captcha 浏览器 —— 否则留下孤儿 chromium
     * （约 200-400MB，且用户没有界面能关掉它）。
     *
     * ⚠ 还要**放下内部载体的需求位**：需求位是进程级的，插件停了而位还提着，
     * GUI 那边的贡献循环就会继续按「server 要 param」产 —— 白耗**设备级**的验证配额
     * （阿里云同设备每小时 150 次，见 `src/captcha-backoff.ts`），且产出来的东西没人消费。
     * ⚠ 这一行是需求位的**兜底 owner**（正常路径由 {@link claimDailyWith} 的 `finally` 清），
     *   补的是「领取窗口进行中就被卸载」这一种：`finally` 要等 promise 落定才跑。
     * webview 租约本身由 client 侧归还（`plugin-src/client/index.js` 把停止函数挂在
     * `ctx.effect` 的清理路径上，`zcode-carrier.js` 的 `destroyGuest()` 调 `release`）。
     *
     * ⚠ 还要**关掉载体页小服务**（评审 C1/C2 的形态 B）：它是个真的监听器，
     *   漏关就是「插件卸载后仍有一个回环端口开着」（`CarrierPageServer.stop()`
     *   内部忽略「未在运行」这类幂等异常，重复调用无害）。
     */
    stop(): void;
    /**
     * ★ **关掉外挂 chromium** —— 只由**领取积分**流程在收尾时调用。
     *
     * ## 为什么需要（用户报障 2026-10-02）
     *
     * > 领取完 chromium 还是留存在任务栏，图标还会闪烁。
     *
     * 根因：`captchaBrowser` 一旦惰性创建就**只**在 `stop()`（插件卸载）里销毁 ——
     * 而领取是**低频写操作**（一天一次）。于是那个 chromium 进程
     * （约 200–400MB）会**一直留着**，它的窗口也就一直挂在任务栏上。
     *
     * ## ⚠⚠ 谁在 web / desktop 下真的会开 chromium（用户 2026-10-02 更正）
     *
     * > desktop 环境索要积分也走不到要开 chromium，所以不用开
     *
     * 核对 `mintClaimCaptcha()` 的判据后确认属实：
     *
     * ```js
     * if (!this.internalCarrierAvailable() || !captchaDemand())
     *   return { param: await injected(), source: 'chromium' }   // ← 这里才开
     * return await this.carrier.mint()                            // ← desktop 走这条
     * ```
     *
     * `internalCarrierAvailable()` = `internalCarrierEnabled && supplied > 0` ——
     * desktop 有内部载体的贡献 ⇒ `true` ⇒ **走载体链，不开 chromium**。
     *
     * | 环境 | 领取时走哪条 | 会开 chromium 吗 |
     * |---|---|---|
     * | **desktop**（有内部载体贡献） | `carrier.mint()` | **不会** |
     * | **web**（无人贡献需求位） | 注入链 → `mintWithChromium` | **会**（就是本方法要收的尾） |
     *
     * ⇒ 本方法在 desktop 下是**空操作**（`captchaBrowser === undefined`
     * 直接 return），故对 desktop 行为**逐字不变**；它只为 web 版收尾。
     *
     * ## 判据是「哪个流程在用」，不是「浏览器是否本次新建」
     *
     * | 流程 | 是否要 captcha | 收尾动作 |
     * |---|---|---|
     * | **领取积分**（`claimDaily*`） | 始终要（上游校验前置于 plan 校验） | ★ **关闭** |
     * | 推理（`mintCaptchaParam`） | 通常不要；被 `3007` 拒时才补产 | **不关**（那次确实用了） |
     *
     * ⚠ 两条路用的是**同一个** `captchaBrowser` 实例（`index.ts` 注入给适配器的
     * `mintCaptchaParam` 最终也落到 `this.captchaBrowser`，见其注释
     * 「整个插件共用一台」），所以**不能**在这里判断"浏览器是否本次新建" ——
     * 必须由**调用方**决定。这也是不做成"自动闲置关闭"的原因：
     * 那会在推理正需要它时把浏览器拿走。
     *
     * ⚠ **可以再次启动**：`dispose()` 会把 `ready` 置 false、`profileDir` 置空，
     * 下一次走 `captchaBrowser ??= new …` 重新冷启动（约 3.7 秒）。
     * 这是**刻意的取舍**（用户明确选择「用完即关」）：宁可多付一次启动，
     * 也不要留一个会闪烁的常驻窗口。
     *
     * ⚠ **幂等**：浏览器本来就不存在时是空操作（不抛错、不新建）。
     */
    closeChromium(): void;
}
/**
 * 把上游的领取结果映射成 Jet Hub 的 `ClaimOutcome`。
 *
 * @param options.internalRetried 这条结果来自「3007 之后换 chromium 重发」那一次
 *   （评审 C4）。⚠ 文案要据此区分：换链之后**仍然**被拒 ⇒ 上游多半已把我们降级成
 *   交互式验证 / 设备信誉不足，继续重试只会更糟（`CaptchaBackoff` 引用了那句
 *   「继续请求不会让信誉恢复，只会更糟」）；而随手一个 3007 未必如此。
 */
export declare function toClaimOutcome(outcome: ZcodeClaimOutcome, planId: string, options?: {
    internalRetried?: boolean;
    plan?: ZcodeClaimablePlan;
    /**
     * 诊断现场（Gitee issue IKJOQB，**只为 `3012` 用**）。
     *
     * ⚠ 三者**必须成套给**：缺 `accountId`/`sentAt` 时诊断行仍会渲染，
     * 但账号序号与「距上条」会退化成 `账号#1` / `—` —— 故调用方
     * （`claimDailyWith`）一贯三个都给。
     */
    accountId?: string | undefined;
    sentAt?: number;
    status?: number;
}): ClaimOutcome;
/**
 * 领取结果是否为**上游风控拦截**（`3012`）—— 领取路径的统一判据。
 *
 * ## ⚠⚠ 判据有**优先级**：`code` 明确时**只信 `code`**（真实缺陷，2026-10-05 自审发现）
 *
 * 初版写成「`code === 3012` **或** `message` 含 `3012`」—— 那个「或」是错的：
 * 上游 `code` 一旦解析出来就是**权威**，此时再去扫 `message` 的自由文本只会引入误判。
 * 实测被误判的三种真实形态：
 *
 * | `code` | `message` | 初版 | 现在 |
 * |---|---|---|---|
 * | `1005` 额度用尽 | `quota 3012 exceeded` | ❌ 报成风控 | ✅ 如实报额度 |
 * | `1001` plan 不存在 | `plan plan-3012 not found` | ❌ 报成风控 | ✅ 如实报失败 |
 * | `3007` captcha | `captcha verify failed` | ✅ | ✅ |
 *
 * ## 为什么误判的后果**很重**（不是文案问题）
 *
 * 领取路径据此**短路**（`claimDailyWith` 的 `break`）⇒ 一个「plan 名里恰好含
 * `3012`」的普通失败会被当成风控，**跳过本账号本可领取的其余 plan**；
 * 且真实业务码被改写成 `3012` —— 而 `1005`（等额度重置）与 `3012`
 * （别重试，有冷却惩罚）的用户动作**完全相反**。
 *
 * ## 那什么时候才扫 `message`
 *
 * 只在 `code` **缺失**时。**而且要求风控语义共现**（真实缺陷，2026-10-05
 * 对抗性审计打出）——
 *
 * | 形态（无码） | 仅词边界 `3012` | 现在（+语义共现） |
 * |---|---|---|
 * | `too many requests, retry after 3012 ms` | ❌ **误判成风控** | ✅ 不命中 |
 * | `<h1>Error 3012</h1>upstream connect timeout` | ❌ **误判成风控** | ✅ 不命中 |
 * | `request has been blocked due to unusual activity.` | 需配合码 | ✅ 命中 |
 *
 * ⚠ 误判的后果与「漏判」**同样重**，只是方向相反：`429 限流`是「稍后重试即可」，
 * 被改写成「风控、**别重试**」—— 两者用户动作**完全相反**；且领取路径据此
 * **短路**，跳过本可领取的 plan。审计实测该形态下 3 个 plan 只发了 1 发。
 *
 * ⚠ 故判据是 {@link mentionsZcodeUnusualActivity}（词边界 + 语义共现），
 *   **不是**裸数字匹配。
 *
 * ⚠ 与推理侧的差异为何是合理的：`describeUpstreamError` 用
 * 「先 3009、再 1005、再 3007、最后 3012」的**分支顺序**达成了同样的优先级；
 * 而 `toClaimOutcome` 里 `3012` 特判在**通用分支之前**，没有那个顺序保护，
 * 故必须靠这里显式的优先级。
 */
export declare function isClaimUnusualActivity(outcome: ZcodeClaimOutcome): boolean;
/** 构造一个「不可用」的 `CheckinStatus`（字段全部显式给，满足契约）。 */
export declare function emptyCheckinStatus(active: boolean, actionRequired?: boolean): CheckinStatus;
//# sourceMappingURL=zcode-auth.d.ts.map