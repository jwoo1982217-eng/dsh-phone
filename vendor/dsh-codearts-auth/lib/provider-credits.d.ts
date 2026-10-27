import type { ZcodeSources } from './zcode-sources.js';
import { type ZcodeBalanceResult } from './zcode-upstream.js';
import { type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js';
import type { ProviderCredits } from './provider-runtime.js';
import type { LoomyCredential } from './loomy.js';
import type { RaccoonCredential } from './raccoon.js';
import type { ZcodeCredential } from './zcode.js';
/**
 * 三家「余额查询挂在 auth 实例上」的渠道所需的最小接口。
 *
 * ⚠️ **结构化类型而不是 `LoomyAuth` / `RaccoonAuth` / `ZcodeAuth`**：
 * 本模块只需这三个方法，导入三个 auth 类会把 `@deepseek-ai/cordis` 与
 * 一整套登录流程拖进依赖图 —— 而它只被 `index.ts`（已经持有实例）与
 * 单测使用。结构化类型同时让单测可以传**只带一个方法的替身**。
 */
export interface ProviderCreditsDeps {
    readonly zcodeSourceInfo?: (accountId: string) => ReturnType<ZcodeSources['list']>;
    /** Loomy auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly loomy?: {
        fetchCreditBalance(credential: LoomyCredential): Promise<CreditBalance | null>;
        /** 一键签到：触发每日额度（`POST /points/first-login`）。 */
        claimDailyQuota(credential: LoomyCredential): Promise<ClaimOutcome>;
    };
    /** Raccoon auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly raccoon?: {
        fetchCreditBalance(credential: RaccoonCredential): Promise<CreditBalance | null>;
    };
    /** ZCode auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly zcode?: {
        fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined>;
        fetchCheckinStatusFor?(credential: ZcodeCredential): Promise<CheckinStatus | null>;
    };
    /**
     * LobsterAI 的**客户端版本号**解析器。
     *
     * ⚠️ 必须**惰性**调用（`() => lobsterai.resolveClientVersion()`），不能注册时
     * 先 await 一个字符串：该值由远端更新接口解析（带 TTL 缓存），把它固化成闭包
     * 里的常量会让「缓存过期后拿到新版本」失效 —— 而它是签到接口的**必填** query 参数。
     */
    readonly lobsteraiClientVersion?: () => Promise<string>;
    /**
     * MiniMax **国际站**绕地理分流用的 `X-Forwarded-For` 值（issue IKMEVG）。
     *
     * ⚠️ 必须**惰性**读（`() => pool.minimaxXff()`），不能注册时固化成字符串：
     * 用户随时可能在面板里改这个设置，固化会让「改了却不生效」变成静默失效。
     *
     * ⚠️ 省略等价于「不附头」（与修复前行为逐字节一致）。**只对
     * `minimaxintl` 生效** —— 判据在 `minimaxHeadersFor` 里按 product id 分流。
     */
    readonly minimaxXff?: () => string | undefined;
    /**
     * Gemini 的**按账号 fetcher**（Gitee issue IKLTZ2）。
     *
     * ⚠️ Gemini 的配额端点（`retrieveQuotaSummary`）在墙外，而积分行是**用户
     * 点一下就等**的主路径：不接代理时它恒报「配额查询网络失败：fetch failed」，
     * 且**零线索**指向代理。
     *
     * ⚠️ 与其余各家同理，必须**惰性**调用（按 `accountId` 现取），不能在注册时
     * 固化成一份 fetcher —— 账号可能随时在面板里改代理。
     */
    readonly geminiFetchFor?: (accountId: string) => typeof fetch;
}
/**
 * 把 ZCode 的额度桶映射成 `CreditBalance`。
 *
 * ⚠️ **逐桶映射，不是只取第一个桶**（真实缺陷）：旧实现只取
 * `result.planName`（= `buckets[0]?.showName`）拼**一个**包 —— 多桶账号的
 * 其余额度被**静默丢掉**，而 `result.remaining` / `total` 却是**全桶汇总**，
 * 于是那一个包的数字比它自己的 `totalUnits` 还大，自相矛盾。
 * 实测本机账号只回一个桶，但**不能按「只有一个桶」来写** —— 那正是把缺陷
 * 固化成契约。
 *
 * ## 空桶的兜底
 *
 * 上游可能一个桶都不给。此时**不能**返回空 `packages`（前端会显示成
 * 「没有额度」而不是「查不到」），故给一个具名占位包，让 UI 至少能显示
 * 「0 / 0」并带上 `result.planName`。
 */
export declare function buildZcodeBalance(result: ZcodeBalanceResult): CreditBalance;
/**
 * 构造「id → 积分能力」的表。
 *
 * ⚠️ **只覆盖余额查得到资源包的渠道**。`opencode` 与 `qoder` 系刻意缺席
 *（见文件头），`aggregate` 没有自己的账号与余额。
 */
export declare function createProviderCredits(deps?: ProviderCreditsDeps): Readonly<Record<string, ProviderCredits>>;
/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `jet-hub-rpc.ts` 的 `authOf` 同因。
 */
export declare function creditsOf(table: Readonly<Record<string, ProviderCredits>>, provider: string): ProviderCredits | undefined;
//# sourceMappingURL=provider-credits.d.ts.map