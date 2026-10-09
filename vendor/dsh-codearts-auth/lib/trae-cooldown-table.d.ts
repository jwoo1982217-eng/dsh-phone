/** TRAE 各错误类别的冷却时长（毫秒）。供 trae-adapter.ts 的轮换循环使用。
 *
 * ## 为什么按类别（2026-09-26 修，PR #64 审查后修订取值）
 *
 * 原实现一律用 `TRAE_RATE_LIMIT_FALLBACK_MS`（1 小时兜底）。但错误类别的"自然恢复周期"差好几个量级。
 * 取值**对齐 `trae-errors.ts` 的既有权威定义**（PR #64 审查 2 的裁定：本表初版的
 * 7 天/1 小时是无实测支撑的沿用值，与既有定义冲突——既有定义优先）：
 *   · quota-exceeded（4008，ide_credits **日配额**耗尽——积分来自每日签到，
 *     余额 API 实测标「签到奖励/30 天到期」）→ 24 小时兜底（覆盖到下次签到）；
 *   · hard-plan（1005，套餐权益不足）→ 12 小时（既有定义的长冷却）；
 *   · soft-rate（4011，频率超限）→ 60 秒（既有定义的短冷却；频率类分钟级恢复，
 *     放大到小时级会白白损失多账号池的可用容量）。
 * 上游响应若给出明确重置时间应以那个为准；4008 没有可靠的重置字段，改的是兜底值。
 */
export declare const TRAE_COOLDOWN_MS: Record<string, number>;
/** 按类别取冷却时长；未知类别回落 1 小时（保守，与旧行为一致）。 */
export declare function traeCooldownFor(kind: string): number;
//# sourceMappingURL=trae-cooldown-table.d.ts.map