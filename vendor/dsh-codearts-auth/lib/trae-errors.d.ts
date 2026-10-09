/**
 * TRAE 上游错误分类。
 *
 * 移植自 `trae2api/internal/upstream/client.go:19-92`（Go）的 `Classify()`
 * 与 `solosse.go:60-68` 的 `Kind()`。
 *
 * ## 与 Go 版的差异：只移植分类，不移植自动冷却状态机
 *
 * 与 `lobsterai-errors.ts` 的 D2 设计哲学一致：只把 HTTP 状态码 + 响应体
 * 判定为有限几类，供上层决定「该换号还是该报错」。不在这里引入自动冷却
 * 或账号禁用——那属于 `AccountPool` 的 `modelRateLimits` + Jet Hub UI 的
 * 「重测/重置」按钮的职责范围。
 *
 * ## 限流标记的落点
 *
 * 换号循环中，调用方本模块外处理，在发现 `hard-plan` / `soft-rate` 时
 * 调用 `accountPool.updateModelRateLimit(...)` 写入限流标记。
 */
/**
 * TRAE 上游错误类别。
 */
export type TraeErrorKind = 
/** 成功（HTTP < 400）。 */
'none'
/** Plan 权益不足（1005） → 长冷却（12h）。 */
 | 'hard-plan'
/** 429 软限流或频率超限（4011） → 短冷却（60s）。 */
 | 'soft-rate'
/** 会话终止：refresh_token / access_token 失效 → 需重新登录。 */
 | 'session-dead'
/** 配额超限（4008：ide_credits 耗尽）→ 等每日重置或签到。 */
 | 'quota-exceeded'
/** 404 → 短冷却且不累计 errCount。 */
 | 'not-found'
/** 5xx 上游故障。 */
 | 'server'
/** 其他 4xx / 业务错误。 */
 | 'client';
/**
 * 按 HTTP 状态码 + 响应体判定错误类别。
 *
 * 判定顺序（对齐 Go 端 `Classify` + `SOLOStreamError.Kind`）：
 *
 * 1. body 含 1005 + plan → hard-plan
 * 2. body 含 4008 → quota-exceeded（**先于 4011**，见实现处说明）
 * 3. body 含 4011 → soft-rate（频率超限）
 * 4. HTTP 401 + body 含 session-dead 标记 → session-dead（或直接 401）
 * 5. HTTP 429 → soft-rate
 * 6. HTTP 404 → not-found
 * 7. >= 500 → server
 * 8. >= 400 → client
 * 9. 否则 none
 *
 * @param status HTTP 状态码
 * @param body 响应体原文（JSON 或纯文本均可，只做子串匹配）
 */
export declare function classifyTraeError(status: number, body: string): TraeErrorKind;
/**
 * 该类别是否应当触发「换下一个账号」。
 *
 * 除 `none` 外的每一类都换号，对齐 Go 端 handler 的每个分支都以 `continue` 结尾。
 */
export declare function shouldRotateTraeAccount(kind: TraeErrorKind): boolean;
/**
 * 该类别的失败是否应记为该模型的限流标记。
 *
 * 只包含真正需要冷却的类别：
 * - `hard-plan`：权益不足（可视为限流）
 * - `soft-rate`：短冷却
 * - `not-found`：短冷却
 * - `quota-exceeded`：配额超限（长冷却）
 *
 * `session-dead` 与 `server` / `client` 不记限流标记——它们不是限流。
 */
export declare function recordsTraeRateLimit(kind: TraeErrorKind): boolean;
/**
 * 该类别是否属于终态（重试无意义，只能重新登录）。
 */
export declare function isTraeTerminalError(kind: TraeErrorKind): boolean;
//# sourceMappingURL=trae-errors.d.ts.map