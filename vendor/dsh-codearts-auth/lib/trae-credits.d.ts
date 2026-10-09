/**
 * TRAE（字节跳动 TRAE IDE）每日签到与积分余额。
 *
 * ## 数据来源
 *
 * 本模块重构自 trae-mate 的 `checkin.rs` + `credits.rs`。
 * trae-mate 是实际能成功签到的参考实现，其核心差异：
 *
 * - **请求头齐全**：约 20 个客户端头，而非简单的 Ug 头
 * - **设备身份稳定**：每个账号的 device_id 基于 user_id 确定性派生
 *   （15 位数字 + UUID v4 market_user_id + 64 hex session_id）
 * - **领取 body 为 `{}`**，而非 `{"req_source":2}`
 * - **积分余额 body 含 `require_usage: true`**
 * - **错误分类与冷却**：PlanLimit/SoftRate/SessionDead 等有冷却时间
 *
 * ## 签到
 *
 * 状态查询：
 *   POST /trae/api/v2/ug/checkin_credits/status → body {}
 *   响应: { checked_in: bool, credits: int64, enable: bool }
 *
 * 领取：
 *   POST /trae/api/v2/ug/checkin_credits/claim → body {}
 *   响应: { code: 0, message: "success" }
 *
 * ## 积分余额
 *
 *   POST /trae/api/v2/pay/ide_user_ent_usage
 *   body {"require_usage": true, "req_source": 2}
 *   响应: { user_entitlement_pack_list: [ ... ] }
 *   remain = ∑(credits_limit - credits_amount)
 *
 * ## 公共约定（与另三套协议一致）
 *
 * - `claimAll` / `status` **处理该 provider 下的全部账号，含已停用**
 * - 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
 * - 返回同一个 `ClaimOutcome` / `CreditBalance` 判别联合
 */
import { type TraeCredential } from './trae.js';
import type { TraeProduct } from './trae-product.js';
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js';
/**
 * 签到错误分类，每类对应不同冷却策略。
 */
export interface TraeCheckinError {
    type: string;
    cooldownSecs: number;
}
/**
 * 分类签到错误，返回类型与冷却时间。
 *
 * 对齐 trae-mate `cooldown.rs:classify_error`：
 * - 200 + code=1005 → PlanLimit, 43200s (12h)
 * - HTTP 429 → SoftRate, 60s
 * - HTTP 401 → SessionDead, 永久
 * - HTTP 404 → NotFound, 60s
 * - 5xx → Server, 600s
 * - 4xx → Client, 600s
 * - 业务码非0 → BusinessError, 300s
 * - 成功/无码 → Unknown, 不冷却
 */
export declare function classifyTraeCheckinError(httpStatus: number, code: number | undefined): TraeCheckinError;
/**
 * 签到业务码 **9074**：「签到人数过多」。
 *
 * 保留此常量作为公开引用（供测试与 RPC 使用）。
 */
export declare const TRAE_CHECKIN_BUSY_CODE = 9074;
/**
 * 查询签到状态。
 */
export declare function fetchTraeCheckinStatus(credential: TraeCredential, _product: TraeProduct, fetcher?: typeof fetch): Promise<CheckinStatus | null>;
/**
 * 执行签到领取。
 *
 * 对齐 trae-mate `checkin_engine` 流程，关键差异：
 *
 * 1. **请求头**：使用完整客户端头（含 `X-Market-User-ID` / `X-Lscbd-Aid` 等）
 * 2. **设备身份**：基于 `credential.uid` 确定性派生，每个账号独立稳定
 * 3. **Body**：`{}` 而非 `{"req_source":2}`
 * 4. **网络重试**：网络异常（非业务码、HTTP 不可达）重试，业务码不重试
 * 5. **错误分类**：返回分类信息供调用方做冷却
 *
 * @param userId 可选的手动 user_id（默认用 credential.uid）
 */
export declare function claimTraeDailyCheckin(credential: TraeCredential, product: TraeProduct, fetcher?: typeof fetch, generation?: number, onRotate?: (nextGeneration: number) => void | Promise<void>, userId?: string, retryCount?: number): Promise<ClaimOutcome & {
    errorType?: string;
    cooldownSecs?: number;
}>;
/**
 * 查询积分余额（对齐 trae-mate `calc_remaining_credits`）。
 *
 * 关键差异与签到相同：使用完整客户端头 + 基于 user_id 的设备身份。
 * body 使用 `{"require_usage": true, "req_source": 2}`。
 */
export declare function fetchTraeCreditBalance(credential: TraeCredential, _product: TraeProduct, fetcher?: typeof fetch): Promise<CreditBalance | null>;
export declare function makeTraeCheckinStatusHandler(_product: TraeProduct): (credential: TraeCredential) => Promise<CheckinStatus | null>;
export declare function makeTraeClaimHandler(_product: TraeProduct): (credential: TraeCredential) => Promise<ClaimOutcome & {
    errorType?: string;
    cooldownSecs?: number;
}>;
export declare function makeTraeBalanceHandler(_product: TraeProduct): (credential: TraeCredential) => Promise<CreditBalance | null>;
//# sourceMappingURL=trae-credits.d.ts.map