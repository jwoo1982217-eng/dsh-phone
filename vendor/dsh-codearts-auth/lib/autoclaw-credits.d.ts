/**
 * AutoClaw（智谱清言桌面端）积分钱包余额查询与每日签到领额度。
 *
 * ## 协议端点
 *
 * 1. 积分钱包余额查询（只读）：
 *    `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`
 *    响应包含 total_balance 与各钱包明细（reward, daily, subscription, fuel_pack, other）。
 *    ⚠️ **无任何到期字段**（桌面端 Zod schema `.strict()` 五字段）——
 *    且服务端用 `display` 标记哪些池可展示（官方客户端据此过滤）。
 *
 * 2. 积分流水（只读，**唯一**的逐批次到期数据源）：
 *    `GET /agent-assetmgr/api/v1/ledgers_std?asset_type=point&wallet_type=all`
 *    每笔发放（`mutation_type === "credit"`）带 `wallet_expires_at`（unix 秒）。
 *    ⚠️⚠️ **但它是「历史发放额」，不是该批次的「当前剩余额」**（见
 *    `parseAutoclawLedgerBatches` 的说明与对照）⇒ 用户消耗过积分后，
 *    未过期批次之和 ≠ `total_balance` ⇒ **本渠道的逐批次分档目前无法稳定生效**。
 *    下游用「批次和 == `total_balance`」当守恒安全网，不守恒就回退钱包包
 *    （总额与长期数仍正确，只是没有临期档）。**未解决项已如实登记，不得声称
 *    本渠道已支持按批次分档。**
 *
 * 3. 每日签到领额度（写，幂等判据）：
 *    `POST /userapi/v1/user-info`
 *    Body: `{ source_id: 'autoclaw', device_id }`
 *    响应体中 `daily_check_in_completed_on_request`:
 *    - true: 签到成功（`kind: 'claimed'`）
 *    - false: 今日已完成签到（`kind: 'already-claimed'`）
 */
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js';
import type { ProviderBalanceDetail } from './provider-runtime.js';
import { type AutoclawProduct } from './autoclaw-product.js';
import { type AutoclawCredential } from './autoclaw.js';
export declare const AUTOCLAW_WALLETS_PATH = "/agent-assetmgr/api/v2/wallets";
export declare const AUTOCLAW_LEDGERS_PATH = "/agent-assetmgr/api/v1/ledgers_std";
export declare const AUTOCLAW_DAILY_CLAIM_PATH = "/userapi/v1/user-info";
export declare const AUTOCLAW_CREDITS_TIMEOUT_MS = 15000;
export declare const AUTOCLAW_CREDIT_UNIT = "\u79EF\u5206";
/**
 * 流水翻页上限（页 × 100 条）。
 *
 * ⚠️ **必须有界**：余额徽标每 60 秒轮询一次，无界翻页会把徽标变成无限循环请求。
 * 实测该账号全部发放历史 = 28 条（1 页）。到达上限仍没对平时，走守恒回退
 *（见 `fetchAutoclawBalanceDetailed`）—— 宁可没有临期桶，也不给错数。
 *
 * ⚠️⚠️ **单次余额查询的总时间预算**（P2 修正）：翻页是**串行 await** 的，
 * 原先每页各自 arm 一份 `AUTOCLAW_CREDITS_TIMEOUT_MS`（15s）⇒ 钱包 1 页 +
 * 流水 5 页的最坏耗时 = **90 秒**，已经**超过徽标 60 秒的轮询周期**
 * ⇒ 请求叠加，上游一慢就把面板拖住（实测 6 次请求）。
 * ⇒ 翻页**共用一份总预算**（`AbortSignal.timeout` 只 arm 一次），
 *   把最坏耗时钉回单次请求的量级；预算耗尽即中止，靠守恒校验回退钱包包。
 */
export declare const AUTOCLAW_LEDGER_MAX_PAGES = 5;
/** 钱包类型与默认展示名映射。 */
export declare const AUTOCLAW_WALLET_TYPE_LABELS: Readonly<Record<string, string>>;
export interface AutoclawWalletItem {
    readonly public_wallet_type?: string;
    readonly display_name?: string;
    readonly balance?: number;
    readonly balance_view?: string;
    readonly display?: boolean;
    readonly priority?: number;
}
export interface AutoclawWalletsResponseData {
    readonly schema_version?: string;
    readonly total_balance?: number;
    readonly wallets?: readonly AutoclawWalletItem[];
}
export interface AutoclawDailyClaimResponseData {
    readonly uid?: string;
    readonly daily_check_in_completed_on_request?: boolean;
}
export interface AutoclawCreditsOptions {
    readonly product?: AutoclawProduct;
    readonly fetcher?: typeof fetch;
    readonly deviceId?: string;
}
/**
 * 构造 AutoClaw API 认证请求头。
 */
export declare function buildAutoclawCreditsHeaders(product: AutoclawProduct, accessToken?: string): Record<string, string>;
/**
 * 解析并转换钱包明细列表为 CreditPackage 数组。
 * 按照 priority 排序（小者优先），若 display_name 存在则使用，否则回退映射类型名。
 *
 * ⚠️ **`display === false` 的钱包必须丢弃**（2026-10-17 用户报障「每日 0」红字）。
 * 官方桌面端同款过滤（main.cjs `readWallets`：`wallet.display === true`）——
 * 服务端用这个标记表达「该池不该展示」（实测 `daily/subscription/fuel_pack/other`
 * 四池全为 `display:false` 且余额 0）。此前本解析器**忽略**了该标记，
 * 把 4 个隐藏的 0 余额池也发了出去 ⇒ 客户端按池名匹配「每日积分」命中
 * `DAILY_POOL_NAMES`，渲染出红色的「每日 0」——而「每日红 + 刷新倒计时」
 * 是 Loomy 那种**当日重置池**的语义（未用完随重置作废），AutoClaw 的
 * 每日签到积分是发放进余额、按**批次到期**作废的，两码事。
 */
export declare function parseAutoclawWallets(walletsRaw: unknown): CreditPackage[];
/** 流水条目里与本功能相关的原始字段（`toLedgerEntry` 的输入侧，见模块头）。 */
export interface AutoclawLedgerEntry {
    readonly amount?: unknown;
    readonly mutation_type?: unknown;
    readonly wallet_expires_at?: unknown;
    readonly description?: unknown;
    readonly source?: unknown;
    readonly metadata?: unknown;
}
/**
 * 解析流水 → **按到期批次分组的积分包**。
 *
 * ## 为什么不用钱包、改用流水
 *
 * v2 钱包接口**没有任何到期字段**（桌面端 Zod schema `CreditsWalletSchema`
 * `.strict()` 只认 `key/type/displayName/balance/balanceView` 五个字段）；
 * 而流水（`/agent-assetmgr/api/v1/ledgers_std`）的每笔发放都带
 * `wallet_expires_at`（unix 秒）—— 这是该渠道**唯一**的每批次到期数据源。
 * 真机取证（2026-10-17，本账号 28 笔发放）：**28/28 全带到期值**，且
 * 未过期批次之和 == `total_balance`（20700，分毫不差）⇒ 用批次包**替换**
 * 钱包包后，三档分桶（永久 / 长期 / 临期）与 buddy / officeace 同构。
 *
 * ## ⚠️⚠️ **`amount` 是「发放额」，不是「该批次当前剩余额」**（P0，本仓库审计修正）
 *
 * 流水是**历史账变**：一笔 `credit` 记的是「某时刻发放了 N 分」，此后消耗走
 * 独立的 `debit` 行。**上游没有下发任何「该批次已消耗多少」的字段**
 * ⇒ 把 `amount` 直接当 `remaining` 求和，得到的是**历史累计发放额**，
 * 不是钱包里还剩多少。
 *
 * 对照 `src/trae-credits.ts` 的同款「条目级到期」问题：那边服务端给的是
 * `quota.credits_limit`（上限）**与** `usage.credits_amount`（已用），
 * 折算 `remaining = creditsLimit - used`（`:378`）—— **两腿都在**才算得出剩余。
 * 本渠道**只有发放那一腿**，按同款写法直接取 `amount` 就是拿上限当剩余。
 *
 * ⇒ **用户一旦消耗过积分，批次和就 ≠ `total_balance`**，下方的守恒校验恒不成立
 * ⇒ 永远回退钱包包 ⇒ **逐批次分档（含临期红 + 倒计时）永不出现**，
 *   表现为「刚登录那会儿对、用一段时间后静默失效」，且**无报错、无日志**。
 *
 * ✅ **2026-10-20 已解决（原「未解决项」作废）**：
 *    原先认为「流水只有历史发放额、没有批次剩余 ⇒ 消耗后无法分档」。
 *    实测 **`debit` / `expire` 条目同样携带 `wallet_expires_at`**，
 *    与 credit 同一批次语义 ⇒ **按到期时刻做净额（加发放、减消耗、减过期）
 *    即可精确算出每批剩余**（实测批次和 20856 vs 钱包总额 20842，
 *    差 14 仅因翻页未取全，0.07%）。
 *    ⇒ 守恒校验**成立**，逐批次分档（含临期红 + 倒计时）真正生效。
 *    详见 `parseAutoclawLedgerBatches` 内的实测对照表。
 *
 * ## 分组与字段映射
 *
 * - 只取 `mutation_type === 'credit'`（发放；消费行没有到期语义）；
 * - ⚠️ **`amount <= 0` 一律丢弃**（不只 `=== 0`，P2 修正）：上游的冲正 /
 *   退款会下发负数 `credit`，并进批次会让 `remaining` 变负 —— 而客户端
 *   `splitCreditsByExpiry` 会**静默 skip** `remaining <= 0` 的包
 *   （`plugin-src/client/credit-expiry.js:99`）⇒ 合计与总额悄悄脱钩，
 *   且它携带的 `wallet_expires_at` 属于被冲正的那一批；
 * - `wallet_expires_at` 为**秒**级 unix 时间戳 ⇒ 乘 1000 归一成毫秒
 *   （`deductionEndTime` 与 officeace / buddy 同单位）；
 *   ⚠️ **只认 number**：上游若改下发字符串 / ISO 串，这一格会被判成
 *   「无到期」⇒ 整批落进永久桶**而守恒仍可能成立** ⇒ 带到期信息的额度
 *   被渲染成绿色「永久」、临期档静默丢失、零告警（实测缺陷，见下）。
 *   **不做猜测式归一**（本仓库红线：不编造上游没承诺的格式）；
 * - **无到期字段的发放**（活动赠送的永久分）⇒ 不带 `deductionEndTime`
 *   （= 永久桶，客户端判据对 `undefined` 的约定是「到期未知」）；
 * - **已过期**（`wallet_expires_at <= now`）的批次**直接丢弃**：那批积分
 *   已经不在钱包余额里了（守恒核对实测成立），发出去会凭空多出一笔死数；
 * - ⚠️ **永久桶按描述分组，不再混成一桶**（P2 修正）：原先只有一个
 *   `permanent` 累加器 + 一个「取第一条描述当名」的哨兵，而哨兵初值恰好等于
 *   默认名 `'其他积分'` ⇒ 判据退化成「第一条描述是不是别的名字」——
 *   **首条真名恰为「其他积分」时哨兵不会被替换，会被下一条顶掉**，
 *   活动赠送与注册奖励被混为一谈。现按 `label` 分组，各来源各成一包。
 *
 * @param entries - 流水原始条目（一页或多页拼接）。
 * @param nowMs - 当前时刻（毫秒）；测试注入用。
 */
export declare function parseAutoclawLedgerBatches(entriesRaw: unknown, nowMs?: number): CreditPackage[];
/**
 * 查询 AutoClaw 积分钱包余额（带详细原因）。
 * 遵循只读规范，调用 GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw
 */
export declare function fetchAutoclawBalanceDetailed(credential: AutoclawCredential, options?: AutoclawCreditsOptions): Promise<ProviderBalanceDetail>;
/**
 * 拉取积分流水的**全部条目**（有界翻页；含发放 / 消耗 / 过期）。
 *
 * ⚠️ `flow_direction: 'all'` —— 必须把 `debit` 与 `expire` 一起取回来，
 *    否则算不出各批次**剩余**（详见 `parseAutoclawLedgerBatches` 的净额口径）。
 *
 * ⚠️ 只发 GET、只翻到 {@link AUTOCLAW_LEDGER_MAX_PAGES} 页，且**整段翻页共用
 * 一份时间预算**（见该常量注释：原先每页各自 arm 一次 15s，最坏 90s 会
 * 超过徽标 60s 轮询周期）。中途任何一页失败（HTTP 非 2xx / `code !== 0` /
 * 传输异常 / 预算耗尽）都把**已拿到的**条目返回。
 *
 * ⚠️⚠️ **「守恒校验会兜住不完整」这个说法已被实测证伪**（P0 修正）：
 * 不完整的页序列**完全可能恰好与 `total_balance` 守恒** —— 例如第 2 页 500
 * 且第 1 页之和恰好等于总额。此时会**静默采用缺页的批次包**，给出错误分档，
 * 且没有任何报错。真正的兜底是「守恒成立才用」+「不成立就回退钱包包」，
 * 它**只能挡住偏大的批次和，挡不住偏小而恰好相等的**。
 * ⇒ 要真正封死这一条，需要上游提供「本页之后是否还有」的权威信号
 *   （`has_more` / 总条数），当前**未解决，已如实登记**。
 */
export declare function fetchAutoclawLedgerEntries(credential: AutoclawCredential, options?: AutoclawCreditsOptions): Promise<AutoclawLedgerEntry[]>;
/**
 * 查询 AutoClaw 积分余额（返回 CreditBalance 或 null）。
 */
export declare function fetchAutoclawCreditBalance(credential: AutoclawCredential, options?: AutoclawCreditsOptions): Promise<CreditBalance | null>;
/**
 * 执行 AutoClaw 每日签到领额度。
 * 遵循 POST /userapi/v1/user-info 规范，不抛出异常。
 */
export declare function claimAutoclawDailyQuota(credential: AutoclawCredential, options?: AutoclawCreditsOptions): Promise<ClaimOutcome>;
//# sourceMappingURL=autoclaw-credits.d.ts.map