/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
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
import { type AutoBadgeState } from './auto-badge.js';
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
import type * as OfficeAceAuthModule from './officeace-auth.js';
/** 以模块命名空间为类型（`startLogin` / `pollLoginCode` / `fetchSubscriptionSummary` 等纯函数）。 */
type OfficeAceAuth = typeof OfficeAceAuthModule;
import type { AccioAuth } from './accio-auth.js';
import type { AutoclawAuth } from './autoclaw-auth.js';
import type { ModelscopeAuth } from './modelscope-auth.js';
import { type AstudioAuth } from './astudio-auth.js';
import type { BuddyCredential } from './buddy.js';
import { type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js';
import { type BuddyProduct } from './product.js';
import { collectBuddyGrowth } from './buddy-growth.js';
/**
 * ⚠️ **`collectBuddyGrowth` 已搬到 `src/buddy-growth.ts`**（2026-10-08 Task 4），
 * 并在此**原样再导出**以保持既有调用点与用例的 import 路径不变。
 *
 * 搬家的理由（不是洁癖）：它是 `credits.afterClaim` 的实现，而 `afterClaim`
 * 由 `src/provider-credits.ts` 的能力表提供。留在本文件会让那张表必须 import
 * 本文件 ⇒ `provider-credits.ts ⇄ jet-hub-rpc.ts` **循环 import**（本文件已经
 * import 前者）。搬到 `buddy-growth.ts` 后依赖是单向的：
 * `jet-hub-rpc.ts` → `provider-credits.ts` → `buddy-growth.ts`。
 *
 * ⚠️ **本再导出是过渡形态**，不是接口：新代码应直接从 `buddy-growth.js` 取。
 * 它由 `tests/unit/buddy-growth.spec.ts` 的 import 覆盖（唯一的生产消费者是
 * `src/provider-credits.ts`，它**直接从 `buddy-growth.js` 取**，不经过本文件）。
 *
 * ⚠️ **2026-10-08 修正（Task 4 复审 Finding 1）**：本 import 原先还捎带了一个
 * 成长引擎的**死 import**（本文件零调用），本条注释一度把它写成「本文件与成长
 * 引擎的接缝」—— 那会让「谁调用成长引擎」这个问题在本文件里得到一个**假答案**。
 * 现已删除该名字，并改正本注释：本文件**不持有**任何成长引擎入口，成长任务的
 * 唯一生产入口是 `provider-credits.ts` 的 `afterClaim`（由 `credits.claimAll`
 * 消费）。别再回到这里找。
 */
export { collectBuddyGrowth };
import type { ProviderAccountEntry, RpcCreditsStatusResponse, RpcCreditsClaimAllResponse, RpcBuddyGrowthAccountResult, RpcCreditsClaimSummary, RpcCreditsBalanceExtra, RpcCreditsBalancesResponse, CatalogHealth } from './types.js';
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
 * OfficeAce 登录中间态的有效期（毫秒）—— **判据的唯一实现处**。
 *
 * ## 为什么必须有（Gitee issue IKM741 的 A 档：登录中止留幽灵占位账号）
 *
 * `account.create` **先** `pool.addAccount` 登记占位条目、**再**返回 `loginUrl`，
 * 此后由 `login.poll` 轮询取 code。用户**打开授权页但没完成授权就关掉**时
 * （issue 原话「好像是没回调 callback」），云侧永远不会给出 code ⇒ 占位条目
 * **永久残留**成一张「凭据未配置」的幽灵卡片，而它没有任何入口会被清理
 * （issue 原话「还要手动删一次」）。
 *
 * ⚠️ **不能判成「失败」来清理**：「用户还没授权完」与「正在轮询」必须同形 ——
 * 判成失败会**删掉正在进行的正常登录**。故判据只能是**时间**。
 *
 * 客户端自己的轮询上限是 5 分钟（`plugin-src/client/jet-hub.js` 的
 * `deadline = Date.now() + 300000`），超时后它停表并关窗 —— 那之后这个中间态
 * 在结构上已经**不可能**再拿到 code。这里取 **4 倍余量**（20 分钟），让
 * 「慢网络 / 用户在多个窗口间切换」都还有救，而残留最多存活 20 分钟。
 *
 * `DSH_OFFICEACE_PENDING_TTL_MS` 可覆盖（**测试与 e2e 用**：判据必须是
 * 「确定时刻」可驱动的，见 `healExpiredAccounts` 的 `now` 注入点那条教训）。
 * ⚠️ 非法值（NaN / ≤0）回落默认值：`parseInt(x) || default` 那种写法会把
 * **显式传 0** 也吃掉，而 0 在这里是合法且有意义的值（「立即收口」）。
 */
export declare function officeacePendingTtlMs(): number;
/** {@link officeacePendingTtlMs} 的默认值（20 分钟 = 客户端轮询上限的 4 倍）。 */
export declare const OFFICEACE_PENDING_TTL_MS_DEFAULT: number;
/**
 * 判「这份 OfficeAce 登录中间态是否已被用户中止」—— **判据的唯一实现处**。
 *
 * 抽成纯函数（而不是内联在收口循环里）的理由与 `officeacePendingTtlMs` 同源：
 * 边界（恰好 TTL、TTL 前 1ms）必须能被**确定地**测到 —— 内联时判据隐含在
 * 一次 `Date.now()` 调用里，用例只能靠跨毫秒的运气命中（本仓库已实测过
 * 「20 次只有 10 次变红」的同型事故）。
 *
 * ⚠️ **中间态缺失 ⇒ 判定为「已中止」**（`pending === undefined` 返回 true）：
 * 那种形态是「宿主重启过，中间态（内存 Map）丢了，而池里的占位条目还在盘上」
 * —— 它同样拿不到 code（state 已随进程消失），属于**必须收口**的残留。
 * ⚠️ 但收口**仍要过凭据那道闸**（见 `sweepAbandonedOfficeAceLogins`）：重启后
 * 若凭据早已落库，条目必须保留。
 *
 * ## ⚠️⚠️ 「在途」是**显式状态**，不是时间推断（2026-10-17 红队 P2 + P4 两轮打穿）
 *
 * 判据演化（每一步都由可复现探针推动）：
 *
 * | 版本 | 判据 | 红队打穿的形态 |
 * |---|---|---|
 * | 初版 | `now - pending.at > TTL`，且落库**前**就删 pending | **P2**：落库中任何 `account.list` 都删号（不需要 TTL 到期） |
 * | 二版 | 把 `delete` 挪到落库**之后** | **P4**：落库**耗时 > TTL** 时，`pending` 虽在仍判「已中止」⇒ 同样删号 |
 * | 三版（本版） | **`settling` 显式在途标记**：为真时**无条件**返回 false | —— |
 *
 * ⚠️ 我一度想用「`login.poll` 每次刷新 `at`」这个更省的替代（红队也提了）：
 *    它对**真机**有效（客户端每 1 秒轮询），但**结构上仍不严密** ——
 *    只要 `account.list` 在两次轮询之间到达、且 `at` 恰好已过 TTL，判据仍会误判。
 *    红队探针（只调 `account.list`、不调 `login.poll`）正是这样打穿它的。
 *    ⇒ 「在途」必须是**离散可分**的状态，**不能靠任何时间判据近似**。
 *
 * @param pending - 该账号的中间态（`undefined` = 没有 / 已随重启丢失）。
 * @param nowMs - 「现在」的毫秒时刻（**入参化**，不在这里读时钟）。
 */
export declare function isAbandonedOfficeAceLogin(pending: {
    at: number;
    settling?: boolean;
} | undefined, nowMs: number): boolean;
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
 *
 * ## ⚠️ 2026-10-08 起从 `PROVIDER_REGISTRY` 派生
 *
 * 原先这是一份手抄 `Set`，而客户端 `supportsPermanentLock` 读的是 registry 的
 * `permanentLock` 字段 ⇒ **两处必须一致**（不一致会出现「按钮渲染出来了，
 * 点了却报 bad-request」）。现在两侧同出一个字段，不再可能漂移。
 * 上面那张「分桶依据」表已随值迁移到 registry 里各条的注释。
 *
 * ⚠️ **本常量是模块级、但这里安全**：它只读 `PROVIDER_REGISTRY`（Task 1 的
 * **静态数据**），**不读 runtime 注册表** —— 后者要到 `apply()` 才填充，
 * 模块级求值会得到空集（`WIRED_EXPIRY_PROVIDERS` 那条注释记的正是这个陷阱，
 * 但那里是**刻意**保持常量的，理由见 `aggregate-expiry.ts`）。
 * 判据是「读的是不是静态数据」，不是「是不是模块级常量」。
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
     * ⚠️ **只有 buddy 注入**（`workbuddy` 后端没有成长中心，见 `src/product.ts`
     * 的 `WORKBUDDY` 注释）；其余 provider 不传，行为逐字不变。
     *
     * ⚠️ 2026-10-08（Task 4）：**「哪家有成长中心」不再由本文件的手抄集合判定**
     *（原 `GROWTH_CAPABLE_PROVIDERS` 已删除），改由「该家是否提供
     * `ProviderCredits.afterClaim`」回答。本钩子仍是**同一个骨架接缝**，
     * 只是调用侧的门控换成了能力表。
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
    /**
     * 签到收尾的**附加提示**（可选；对 `claimed` 与 `already-claimed` **都会跑**）。
     *
     * ## 为什么需要它（2026-10-20 用户报障，真机截图）
     *
     * TRAE 的「1024 打卡抽奖」应该在**点签到按钮**时触发。第一版把抽奖挂在
     * `claimTraeDailyCheckin` 内部 ⇒ **几乎永不触发**：本家 `precheckStatus: true`，
     * `credits.claimAll` 会先查状态，今天已签到就直接回 `already-claimed`、
     * **根本不调 `claim`**（见上面 `precheck` 那段）。而「已签到」恰恰是最该抽奖的
     * 时机（签到后才解锁抽奖）⇒ 用户实测 4 个账号全显示「今天已签到」、
     * 一条抽奖信息都没有。
     *
     * ## 契约
     *
     * - 返回**字符串** ⇒ 追加到该账号的 `outcome.message`（客户端已经渲染这一行）；
     * - 返回 `undefined` ⇒ 什么都不加（**不该抽的情形必须回 undefined**，
     *   报「今天本来就不该抽」只会制造噪声）；
     * - **永不抛**：抽奖是不可逆写操作且会因「今日已参与 / 窗口外 / 无资格」失败，
     *   那些都**不是**签到失败（本仓库有两轮「登录成功却因记账失败被报成失败」事故史）。
     *
     * ⚠️ 只有 trae 注入；其余 provider 不传 ⇒ 行为逐字不变。
     */
    afterClaimNote?: (credential: TCredential, product: TProduct, entry: ProviderAccountEntry, outcome: ClaimOutcome) => Promise<string | undefined>;
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
    fetchBalanceDetailed?: (credential: TCredential, product: TProduct, accountId?: string) => Promise<{
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
     * **共享余额读数缓存**的回写出口（2026-10-15，规格 §5.7）。
     *
     * ## ⚠️ 为什么是「回写」而不是「改读」（本端点的响应形状约束）
     *
     * 本端点的响应是 `{ balance, error?, extra? }`，比折算路径要的 `CreditBalance`
     * **多两个字段**（Gemini 的 `extra` 来自另一个端点）⇒ 让本端点「读」缓存会**丢字段**。
     * ⇒ 本端点继续用自己的取数（**响应逐字节不变**），但把拿到的 `balance`
     * **写回**缓存 —— 于是聚合折算能命中面板刚查过的那一条。
     *
     * ⚠️ 省略时本端点行为与升级前**逐字节相同**（未接线 = 无回写）。
     */
    writeBalance?: (accountId: string, balance: CreditBalance) => void;
    /**
     * ★ **共享余额读数缓存**的**读**出口（2026-10-16，issue IKMCOO 缺陷 1 + 用户要求）。
     *
     * ## 为什么需要它（与上面 `writeBalance` 互补）
     *
     * `writeBalance` 只让**别的消费者**命中本端点的读数；本端点自己**每次调用
     * 仍逐账号打上游**。而本端点有**多个调用方**（面板渲染、用量徽标的分钟级
     * 轮询——见 `usage.badge` 内部直接调 `credits.balances`），于是同一个账号在
     * 一分钟里被查 N 次：上游抖动时一失败就整批拖住，用户看到「面板加载很久」。
     *
     * ⇒ 本钩子让端点**先吃共享读数**（含陈旧兼顶），命中即零网络请求。
     *
     * ## ⚠️ 形状约束与 `writeBalance` 同源（端点响应有 `extra` 等额外字段）
     *
     * 本钩子返回的是**折叠后的** `CreditBalance`（缓存里那份），**不含** `extra`
     * ⇒ 命中时**不得**同时回传 `extra`，否则那是编造。
     *
     * @param accountId - 账号池条目 id。
     * @param force - `true` 时跳过缓存（含兼顶），强制回源 —— 面板「刷新」按钮。
     * @returns 读数（成功/兼顶旧值都可能）；`undefined` ⇒ **本次没有可用的缓存读数**，
     *   调用方**照常发请求**（折叠的可用性不得依赖缓存是否接线）。
     */
    readCachedBalance?: (accountId: string, options: {
        force?: boolean;
    }) => Promise<{
        balance: CreditBalance;
        stale: boolean;
        at: number;
        error?: string;
    } | undefined>;
    /**
     * 载荷里的 `force`（面板「刷新积分」按钮）。
     *
     * ⚠️ **必须透传给 {@link CreditsEndpointDeps.readCachedBalance}**（审计 P1-1）：
     *   不传 ⇒ 「刷新」退化成「再读一次缓存」，且在兼顶场景下**看起来成功**
     *   （返回旧值 + 一句「本次查询失败」），比报错更误导。
     */
    force?: boolean;
    /**
     * 领取前是否先查一次签到状态（默认 `true`）。
     *
     * CodeBuddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
     * 领取请求（活动未开 / 今天已领时直接短路）。
     *
     * ⚠️ **本骨架只认这个布尔，不认 provider**：各家的取值由能力表给出
     *（`ProviderCredits.precheckStatus`，见 `src/provider-runtime.ts` 的完整
     * 「哪家 true / 哪家 false 及各自实测理由」）。本文件**不重复那张表**
     * —— 一处语义两套判据必然漂移（本仓库首条红线）。
     *
     * ⚠️ 调用方若省略它，骨架会回落到**默认的 buddy 式** `fetchCheckinStatus`。
     * 对**没有同构状态端点**的渠道（如 loomy）那是**发错端点的必然失败请求** ——
     * 故那些家**必须显式传 `false`**，而不是靠「没配 fetchStatus 就会跳过」这种
     * 想当然的推断（骨架不看 `fetchStatus` 是否存在）。
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
/**
 * 各 provider auth 实例的**共同部分**（结构化类型），使 `authOf` 不必依赖
 * 各家具体类（逐个 import 会把它们全拖进依赖图）。
 *
 * ⚠️ **名字里的 `JetHub` 比实际语义窄（2026-10-08 独立复审 M-5 实测）**：
 * 本接口有两个**不同层次**的使用方，第二个并不在 JetHub RPC 里 ——
 *
 * | 成员 | 谁在用 |
 * |---|---|
 * | `refreshAccountCredential` | **`jet-hub-rpc.ts` 自己**（`account.refresh` 端点，实测该文件里有真调用） |
 * | `refreshAll` | **`index.ts` 的 runtime 注册循环**（填 `ProviderRuntime.auth.refreshAll`，即 `wiredRefreshTargets()` 的派生依据）。实测本文件里**只有声明、零调用** |
 *
 * ⇒ 读到这里别以为 `refreshAll` 有 JetHub 调用方；它的价值是「让注册循环能用
 * 一个统一的形状遍历各家的实例」。**没有改名**是刻意的：改名要动 `index.ts` 的
 * import 与类型标注，而收益只是名字更准；**语义澄清写在这里即可**。
 */
export interface JetHubAuthLike {
    refreshAccountCredential(refName: string, pool: AccountPool, accountId: string): Promise<void>;
    /**
     * 批量续期该 provider 的全部账号。
     *
     * ⚠️ 2026-10-08（Task 10）：`index.ts` 的注册循环用它填
     * `ProviderRuntime.auth.refreshAll`，而后者是 `wiredRefreshTargets()` 的派生依据。
     * 实测各家签名**完全一致**（`(pool) => Promise<void>`）⇒ 无需逐家适配。
     */
    refreshAll(pool: AccountPool): Promise<void>;
}
/**
 * 各 provider 的 auth 实例（`registerJetHubRpc` 的命名对象形参）。
 *
 * ⚠️ **键必须是 provider id，不是变量名**：
 * - provider id 是 `qodercn`（无连字符、全小写），而 `index.ts` 里的**变量名**
 *   是 `qoderCn`。若键用变量名，`authOf(auths, 'qodercn')` 就**查不到**中国版
 *   （键 `qoderCn` ≠ id `qodercn`），症状是「中国版账号续期报
 *   `Unknown provider: qodercn`」—— 与本仓库历史上的 `workbuddy` 漏接是同一形态。
 * - 键用 id 后，`account.refresh` 可以直接 `authOf(auths, entry.provider)` 分派。
 *
 * ⇒ 调用点写 `qodercn: qoderCn`（**键是 id、值是变量**），这是刻意的。
 *
 * ⚠️ **每个字段都必须保留具体类型**（不要都改成 `JetHubAuthLike`）——
 * 那会丢掉「全部键必须都在」的类型检查，而「漏接一个 provider 就编译不过」
 * 正是本次改名的核心价值。
 *
 * ⚠️ **刻意不写「N 个字段」**：条数随 provider 增删必然腐坏（本仓库已多次
 * 记录「注释里的数字先烂」），且「数字对不上」会让人怀疑整段约定。
 * 权威条数以本接口的字段为准，一致性由
 * `tests/unit/zcode-wiring.spec.ts` 的「接口键 === 调用点键」锁死。
 */
export interface JetHubAuths {
    readonly codearts: CodeArtsAuth;
    readonly buddy: BuddyAuth;
    readonly workbuddy: BuddyAuth;
    readonly lobsterai: LobsteraiAuth;
    readonly qoder: QoderAuth;
    /** ⚠️ 键是 **provider id**（`qodercn`），值是 `index.ts` 里的 `qoderCn` 实例。 */
    readonly qodercn: QoderAuth;
    readonly trae: TraeAuth;
    readonly cline: ClineAuth;
    readonly loomy: LoomyAuth;
    readonly raccoon: RaccoonAuth;
    readonly minimax: MinimaxAuth;
    /**
     * MiniMax Code **国际版**（key 是 provider id `minimaxintl`）。
     *
     * ⚠️ 与 `minimax` **共用同一个 `MinimaxAuth` 类**（两站只差产品配置），故这里
     * 的类型相同、只是**另一个实例** —— 与 `qoder` / `qodercn` 同型。
     * 两站账号不互通、凭据 ref 前缀不同（`MINIMAX_*` / `MINIMAXINTL_*`），
     * 若这里的**键与值接错**，症状是「国际站账号的续期去刷了国内站凭据」，
     * 而按 id 查表（`authOf`）会把国际站账号分派到**国内站实例**上。
     */
    readonly minimaxintl: MinimaxAuth;
    readonly zcode: ZcodeAuth;
    readonly gemini: GeminiAuth;
    /**
     * OfficeAce（华为 ModelArts MaaS 云端直连）。
     *
     * ⚠️ 值是 **auth 模块命名空间**（`import * as officeaceAuth`），不是 Service 实例
     * —— 该模块导出的是纯函数（`startLogin` / `pollLoginCode` / `completeLogin` /
     * `fetchSubscriptionSummary`），没有类实例。见 `officeace-auth.ts` 模块头。
     */
    readonly officeace: OfficeAceAuth;
    readonly accio: AccioAuth;
    /**
     * AStudio（讯飞 AstronStudio，2026-10-16）。
     *
     * ⚠️ 与其余各家**不同**：本家没有 `startLogin`、不开回调服务器、没有
     * `authorizeUrl`。`account.create` 用 `importLocalSession(refName)` 把**本机 AStudio
     * 客户端已登录的会话**（磁盘明文 `modelBearerToken`，fact 399/402）读进 DSH 凭据库
     * —— 一次做完的同步路径 ⇒ 返回体靠 `reused: true` 走前端的成功出口。
     */
    readonly astudio: AstudioAuth;
    readonly autoclaw: AutoclawAuth;
    /**
     * **AutoClaw 国际版**（`autoclawintl`）。
     *
     * ⚠️⚠️ **键与值必须严格对应**：它的值是 `index.ts` 里那个用
     * `product: AUTOCLAW_INTL` 构造的 `AutoclawAuth` 实例。
     * ⚠️ 本段注释**不得出现右花括号字符**：`credits-balance-self-heal.spec.ts` 的
     *    `jetHubAuthsKeys()` 用「找第一个右花括号」的方式截取接口体，注释里出现
     *    该字符会让它**提前截断** ⇒ 后续所有键被判为「不存在」（实测踩过两次）。
     * 若写成 `autoclawintl: autoclaw`（指向国内实例），症状是
     * 「国际站账号的续期去刷了国内站凭据」—— 因为续期用的是**实例上的 product**，
     * 而按 id 查表（`authOf`）会把国际站账号分派到国内站实例上。
     * 这与 `minimaxintl` 的同类风险完全一样（见上方注释）。
     */
    readonly autoclawintl: AutoclawAuth;
    /**
     * ModelScope（魔搭）—— **本 fork 独有**（上游 rc.11 仍无此 provider）。
     *
     * ⚠️ 值是 `ModelscopeAuth` **Service 实例**（与 accio 同款），不是命名空间。
     */
    readonly modelscope: ModelscopeAuth;
}
/**
 * 按 provider id 取 auth 实例。
 *
 * ⚠️ **键是 provider id**（`qodercn`），不是变量名（`qoderCn`）——
 * 这是 `JetHubAuths` 的接口约定（见其注释）。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `'constructor'`），
 * 把 `entry.provider` 为怪值时误判成「有该 provider」。
 */
export declare function authOf(auths: JetHubAuths, provider: string): JetHubAuthLike | undefined;
/**
 * ⚠️ 2026-10-08 改：各 provider 形参从**位置传参**改为**命名对象**（`auths`）。
 *
 * 原注释记录「历史上已因少传/插队错位复发 **6 次**」—— 位置参数天生有这个缺陷
 *（改签名顺序、插一个新 provider 都会静默错位，而症状是「某个 provider 在用
 * 另一个 provider 的凭据续期」）。命名对象让错位在**类型层面不可能**，
 * 且新增 provider 只加一个键。
 *
 * ## ⚠️ 积分能力表**不是形参**（2026-10-08 设计复审 C1）
 *
 * Task 3 初版曾在本函数末尾加**第 5 个形参** `credits?: Readonly<Record<string,
 * ProviderCredits>>`，现已删除。三条理由（复审报告 `.superpowers/sdd/
 * task-3-design-eval.md` §4/§6）：
 *
 * 1. **它在生产路径上不承载任何信息** —— `src/index.ts` 传进来的正是
 *    `createProviderCredits({ loomy, raccoon, zcode })`，而这三个实例就是本函数
 *    形参 `auths` 里的 `loomy` / `raccoon` / `zcode`；`registerJetHubEndpoints`
 *    自己现造的那份**逐字节等价**。删掉实参生产行为不变 ⇒ 它是**纯测试接缝**，
 *    而「形参一侧 === 生产分派」这件事**没有任何测试守着**。
 * 2. **它重开了 Task 9 刚关掉的门** —— 一个可选的**位置**形参：在它之前插入
 *    任何新的可选形参，调用点 `(…, modelAdapters, creditsTable)` 就会**静默**
 *    把表落进新形参（本仓库实测复发 6 次的位置错位形态）。`modelAdapters` 与
 *    `credits` 值类型不同，互换会被 `tsc` 抓到，但**插入**不会。
 * 3. ⇒ 改为**从 `auths` 派生**（见 `registerJetHubEndpoints` 里的 `credits`），
 *    签名回到 4 个形参。
 *
 * ⚠️ **全局注册表（`ProviderRuntime.credits`）仍然保留且必须保留** —— 那是
 * Task 5 的 `aggregate-expiry.ts` / Task 8 的 `account-probe.ts` 这类
 * **拿不到 `auths` 形参**的跨模块消费点的唯一入口，由 `src/index.ts` 的
 * `registerProviderRuntime` 挂上。它与本函数现造的表**同源同构**
 *（同一个工厂、同一批实例），只是消费方不同。
 *
 * ⚠️ 端点级「表真的驱动分派」的测试改由模块替身注入
 *（`tests/unit/credits-runtime-parity.spec.ts` 的 `vi.mock('provider-credits')`）——
 * 断言仍打在**端点响应**上，判别力与原形参方案逐条等价。
 */
export declare function registerJetHubRpc(ctx: Context, pool: AccountPool, 
/** ⚠️ 命名对象，不是位置参数。键是 provider id（见 `JetHubAuths`）。 */
auths: JetHubAuths, 
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
    handleRpc?(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown | undefined>;
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
    describeCatalog?(force?: boolean, signal?: AbortSignal): Promise<{
        models: Array<{
            canonicalId: string;
            name: string;
            candidates: Array<{
                provider: string;
                realId: string;
                realName: string;
                price: number;
                viaPatch: boolean;
                rejected: boolean;
                /** 三态门控（宿主判定的**权威**结果，客户端只渲染）。 */
                state: 'allowed' | 'rejected' | 'default-rejected';
                /** 该渠道是否已接入临期折算（客户端据此决定「关掉时写哪张表」）。 */
                expiryWired: boolean;
            }>;
            /** 该模型的**手工顺序**（宿主已按当前候选集过滤）。 */
            order: string[];
        }>;
        orderMode: 'expiry' | 'manual';
    }>;
    /**
     * 清空选型缓存（**可选** —— 只有聚合适配器实现它）。
     *
     * ⚠️ 改了拒绝表之后调它可立即释放内存。但**正确性不依赖它**：
     * 聚合适配器的缓存键含拒绝表指纹，故改了表就自动不命中旧条目
     *（见 `AggregateAdapter.routingFingerprint` —— 2026-10-15 起为四项：拒绝表 + 白名单
     *  + 手工顺序表 + 排序模式）。
     */
    clearChoiceCache?(): void;
    /**
     * 目录健康快照（**可选** —— 只有目录来自**多个外部来源**的适配器实现它，
     * 目前只有 `cline`：它的 `cline-pass/*` 条目与图片能力**只由 models.dev 提供**，
     * 而那是 5.39 MB 的外部站点、经常拉不到）。
     *
     * ⚠️ 必须**零 IO**：`provider.status` 在设置页挂载时对**每个**供应商都会调它，
     * 一旦它触发网络请求，首屏会被拖慢（本端点全程只用同步内存副本正是为此）。
     * ⚠️ 抛错会被调用点吞掉（诊断不得反噬主流程），故实现方可以放心地
     * 「读到什么就报什么」。
     */
    describeCatalogHealth?(): CatalogHealth;
    /**
     * 「**目录是否已可用于批量写操作**」的本地探测（**可选** —— 目前只有聚合适配器实现它）。
     *
     * ## ⚠️⚠️ 为什么需要它（Critical：Task 7 的目录非阻塞把 IKJW33 缺陷重新打开了）
     *
     * `fullCatalogIds` 的判据是「**远端读到即可**」（`remoteError` 为空 ⇒ 认为成功）。
     * 对**其余 19 家**，目录是**固定 / 编译期兜底表 + 远端覆盖**，「读到」与「读全」
     * 基本等价。而聚合的目录是**逐渠道动态推导**的，且 Task 7 之后它的 `listModels`
     * **不再同步等上游** ⇒ 冷启动时它**立刻**返回 `['auto']` ⇒ 远端那一半「读成功」
     * 但只含 1 条 ⇒ 用户点「关闭聚合供应商」只关掉 `auto`，
     * `provider.setEnabled` 却返回 `ok:true` / `changedCount:1`，另外两个虚拟模型
     * **仍然可选**（`provider.status` 则把这帧错判成 `closed:true`）。
     *
     * ⇒ 有实现时，**两个端点都先问它**；`ready === false` 时按「目录不完整」处理
     *（`setEnabled` 拒绝、`status` 报安全方向 `closed:false`）。
     *
     * ⚠️ 必须**同步且零 IO**：`provider.status` 在设置页挂载时对每个供应商都调，
     *    一旦它触发网络请求会拖慢首屏（本接口其它成员的同一约束）。
     * ⚠️ 抛错会被调用点吞掉（按「不可用」处理，即安全方向），故实现方可以放心报。
     */
    catalogReadyForBulkWrite?(): {
        ready: boolean;
        reason?: string;
    };
    /**
     * 清空**临期折算缓存**（**可选** —— 只有聚合适配器实现它）。
     *
     * ## ⚠️⚠️ 为什么领取（claim）之后必须调它（真实缺陷，对抗审计实测证伪，2026-10-07）
     *
     * `createExpiryProbe` 的折算缓存（TTL 60 秒）**也缓存 `UNUSABLE`** —— 这是刻意的
     * （见 `aggregate-expiry.ts` 的 `cacheAndReturn`：一个渠道「现在没账号」60 秒内不会变）。
     *
     * 但 `UNUSABLE` 现在**新增了一个来源**：`zcodeExpiry` 把「余额为 0」判成 `UNUSABLE`
     *（修掉「额度已尽仍被 auto 选中」的真实缺陷）。而 zcode 的每日赠送额度**要先领取
     * 才进 `balances` 桶** ⇒ 于是出现这个时序：
     *
     * 1. 用户请求 → 余额 0 → 写入 `UNUSABLE`（缓存 60 秒）；
     * 2. 用户去面板点「一键领取」→ **领取成功、余额进桶**；
     * 3. 用户立刻用 auto → **仍命中第 1 步的 `UNUSABLE`** ⇒ 报「没有任何可用候选」。
     *
     * ⇒ 用户会以为「签到没用」或「auto 坏了」，而账号其实已经好了。
     *
     * ⚠️ 旧实现不会暴露这个问题：它那时在「余额 0 但有可领活动」时返回**当日**
     *（可当选），根本不写 `UNUSABLE`。是本次收窄**引入了**这个时序。
     *
     * ⚠️ 已有的两个清理入口（`pool.onAccountAdded` 与拒绝表变更）**都不覆盖领取** ——
     * 领取既不新增账号、也不改拒绝表。故必须在领取成功后**显式**清一次。
     */
    clearExpiryCache?(): void;
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
     *
     * @param force - `true` 绕过探针的 60 秒折算缓存（面板每 5 分钟自动重探 / 手动点击时用）。
     */
    describeExpiryOrder?(signal?: AbortSignal, force?: boolean): Promise<Record<string, number>>;
    /**
     * auto 的**实际转发历史**与选型入口（**可选** —— 只有 `jet-hub-auto` 实现它）。
     *
     * ## ⚠️ 为什么放在 `modelAdapters` 表里，而不是给 `registerJetHubRpc` 加一个位置参数
     *
     * 那个函数是**位置传参**，其形参列表有成文警告「历史上已因少传/插队错位复发 6 次」，
     * 且 `zcode-wiring.spec.ts` 有一条**派生式不变量**：
     * 「客户端 `PROVIDERS` 条数 + 1 == 形参个数」。
     * 加第 17 个位置参数会直接打破它（实测：10 条接线断言同时变红），而那条不变量
     * 正是为了防「中间某个 provider 位置错位 = 拿 A 的实例当 B 用」这类真实故障。
     *
     * ⇒ 走**按 id 键控**的 `modelAdapters` 表：加一个键不影响任何位置，也不影响
     *   那条不变量（它只数形参）。聚合 provider 同样在这张表里（见 `index.ts`）。
     *
     * ⚠️ 返回类型复用 `auto-badge.ts` 的 `AutoBadgeState`（**唯一权威**）——
     *    在 `usage.badge` 里再声明一份同样的形状必然漂移。
     */
    autoState?(): AutoBadgeState;
}
//# sourceMappingURL=jet-hub-rpc.d.ts.map