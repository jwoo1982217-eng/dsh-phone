/**
 * LobsterAI（有道龙虾）每日签到与积分余额。
 *
 * 与 `src/credits.ts`（CodeBuddy 版）**刻意分开**：两者协议没有一处共用，
 * 硬合并只会让那个文件出现大量 `if (provider === 'lobsterai')` 分支。
 * 但**复用它的两个类型**（`ClaimOutcome` / `CheckinStatus` 风格的判别联合），
 * 让 `computeClaimSummary` 与 Jet Hub 的结果摘要 UI 一行都不用改。
 *
 * ## 协议（三步，来源 `lobsterai2api/sigin.py:51-67`）
 *
 * ```
 * 0) 版本号（必填参数）：GET {clientVersionApi} → data.value.version
 * 1) 查活动槽位  GET  /api/client-activities/slot?placement=…&clientVersion=…
 * 2) 查活动上下文 GET  /api/client-activities/{activityCode}/context?configRevision=…
 * 3) 签到        POST /api/client-activities/{activityCode}/actions/check_in
 * ```
 *
 * 认证是**纯 Bearer，无签名**（`sigin.py:32-48`）—— 与 CodeBuddy 那套
 * `X-Domain` / `X-Product` / `X-Enterprise-Id` 头族毫无关系。
 *
 * ## 幂等
 *
 * 与 CodeBuddy 靠服务端 `code:10001` 不同，LobsterAI 是**客户端幂等**：
 * 请求带 `idempotencyKey`（UUID4），且签到前先查 `context` 的
 * `state.claimedToday` 与 `actions` 是否含 `check_in`。
 * 两步预检查都要做 —— 只看 `claimedToday` 会漏掉「活动有但今天不该领」的情形。
 */
import { type LobsteraiCredential } from './lobsterai.js';
import type { LobsteraiProduct } from './lobsterai-product.js';
import type { ClaimOutcome, CreditBalance } from './credits.js';
/** 活动槽位查询端点。 */
export declare const LOBSTERAI_ACTIVITY_SLOT_PATH = "/api/client-activities/slot";
/** 活动上下文查询端点（需拼 activityCode）。 */
export declare const LOBSTERAI_ACTIVITY_CONTEXT_PATH = "/api/client-activities";
/** 积分余额端点。 */
export declare const LOBSTERAI_PROFILE_SUMMARY_PATH = "/api/user/profile-summary";
/**
 * 槽位查询的三个固定 query 参数（**照抄 `sigin.py:52-53`**）。
 *
 * 这些值是用真实客户端观察到的：`placement=desktop_sidebar` 声明「桌面端侧边栏」
 * 这一投放位，`containerApiVersion=2` 是容器协议版本，`platform=win32` 是
 * **伪装客户端形态** —— 即使本插件跑在 macOS/Linux 上也照发 win32，
 * 它与运行环境无关，改了可能拿不到活动。
 */
export declare const LOBSTERAI_SLOT_PLACEMENT = "desktop_sidebar";
export declare const LOBSTERAI_SLOT_CONTAINER_API_VERSION = "2";
export declare const LOBSTERAI_SLOT_PLATFORM = "win32";
/** 活动槽位（`slot` 接口的 `data`）。 */
export interface LobsteraiActivitySlot {
    /** 槽位状态；只有 `'available'` 时才应继续。 */
    slotState: string;
    /** 活动编码；缺失时无法继续。 */
    activityCode: string;
    /** 配置修订号；后续两步都要回传。 */
    configRevision: number;
}
/** 活动上下文（`context` 接口的 `data`）。 */
export interface LobsteraiActivityContext {
    /** 今天是否已领取。 */
    claimedToday: boolean;
    /** 可用动作列表；不含 `'check_in'` 时不应尝试签到。 */
    actions: string[];
}
/**
 * 查询当前活动槽位。
 *
 * 返回 `null` 表示查询失败（网络/信封/结构问题），与「无可用活动」
 * （返回 `slotState !== 'available'` 的对象）**严格区分** —— 前者是异常、
 * 后者是正常业务状态，UI 文案不同。
 */
export declare function fetchLobsteraiActivitySlot(credential: LobsteraiCredential, product: LobsteraiProduct, clientVersion: string, fetcher?: typeof fetch): Promise<LobsteraiActivitySlot | null>;
/**
 * 查询活动上下文（今天领了没、有哪些可用动作）。
 *
 * 返回 `null` 表示查询失败。
 */
export declare function fetchLobsteraiActivityContext(credential: LobsteraiCredential, product: LobsteraiProduct, slot: LobsteraiActivitySlot, fetcher?: typeof fetch): Promise<LobsteraiActivityContext | null>;
/**
 * 执行每日签到领取。
 *
 * 完整三步流程，返回与 `credits.ts` 同构的 {@link ClaimOutcome}
 * 判别联合 —— 这样 `computeClaimSummary` 与 Jet Hub 的结果摘要 UI 无需改动。
 *
 * 判定顺序（把「业务正常状态」与「真失败」严格分开）：
 * 1. 槽位查询失败 → `failed`；
 * 2. `slotState !== 'available'` 或无 activityCode → `inactive`；
 * 3. 上下文查询失败 → `failed`；
 * 4. `claimedToday` → `already-claimed`；
 * 5. `actions` 不含 `check_in` → `inactive`；
 * 6. 领取请求失败 / 信封异常 → `failed`；
 * 7. 成功 → `claimed`（积分取三级回退链）。
 */
export declare function claimLobsteraiDailyCheckin(credential: LobsteraiCredential, product: LobsteraiProduct, clientVersion: string, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/**
 * 查询账号积分余额。
 *
 * 端点用 `profile-summary` 而非 `quota`（`client.go:282-283` 的注释）：
 * `/api/user/quota` 只显示 `freeCreditsTotal=300`，**不含活动积分**
 * （实测某账号 profile-summary 有 5297.72，quota 只有 300）。
 *
 * 返回 `null` 表示**查不到**（网络/信封问题），与「余额为 0」严格区分 ——
 * 失败时 UI 应显示原因而不是 0。
 *
 * 结构对齐 `credits.ts` 的 {@link CreditBalance}，让 `CreditBalanceRow`
 * 组件能直接复用：`creditItems[]` → `packages[]`，`totalCreditsRemaining` → `total`。
 */
export declare function fetchLobsteraiCreditBalance(credential: LobsteraiCredential, product: LobsteraiProduct, fetcher?: typeof fetch): Promise<CreditBalance | null>;
//# sourceMappingURL=lobsterai-credits.d.ts.map