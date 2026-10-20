/**
 * 「这个「账号 × 模型」当前**需要** captcha」的短时记忆。
 *
 * ## 背景（判据来源**外部仓库** `bonus-plan-4-open-zcode`（本机另一处 checkout、
 * **不在本仓库**）的提交 `52b6389` + 本仓库 2026-10-01 的实测，后者已写进 README 的 ZCode 章节）
 * 上游**并非每次都要求**验证头：官方壳在 `access.mode = normal` 时根本不索要
 * 运行时头（抓包 4674 包里 captcha 相关全为 0、14/14 直连成功），只有
 * `access.mode = off-peak` 才强制。而本仓库此前**每个请求都现 mint**（现行路径已改为
 * 下面的「先探后取」，实现在 `src/zcode-adapter.ts` 内层循环的
 * `knownRequired || probeRejected` 门控 —— 为假时直接不发 param）
 * —— 在不需要验证的窗口里纯属浪费 mint 配额与设备信誉
 * （阿里云按**同设备每小时 150 次**限流，失败还会扣信誉，见 `captcha-backoff.ts`）。
 *
 * ## 策略：默认「先探后取」
 * 1. 请求**不带**验证头发出（不拉配置、不 mint，几乎零成本）；
 * 2. 被 `3007 captcha verify failed` 拒 → 这才产出并重发，同时记下「需要验证」，
 *    `CAPTCHA_REQUIRED_TTL_MS` 内的后续请求直接带头，免得每条消息都白吃一次 3007；
 * 3. 一旦不带头的请求成功 → 清掉记忆（上游又不要了），回到最省的路径。
 *
 * 代价：未命中时多一次**快速失败**的往返（3007 立即返回、不消耗额度）；
 * 收益：窗口期完全省掉 mint（时间 + 设备信誉）。
 *
 * ## 为什么只在进程内，不落 `jet-hub-store`
 * TTL 只有 2 分钟，丢了最多白吃一次 3007（不消耗额度）；而
 * `$DSH_HOME/jet-hub/state.json` 是**同机多 profile 共享**的 home 级文档，
 * 落盘会把一个 profile 的验证结论传染给另一个（AGENTS.md 记过同型污染）。
 */
/** 「需要验证」的记忆时长（对齐**外部仓库**那次提交 `52b6389` 的 2 分钟；改它要有实测依据）。 */
export declare const CAPTCHA_REQUIRED_TTL_MS: number;
/**
 * 记忆键：captcha 需求是「账号 × 模型」维度的；真实的 key 格式见下面的
 * `captchaRequirementKey`，形如 `` `${accountId}|${model}` ``。
 * ⚠ 口径：描述**维度**时一律写「账号 × 模型」，`|` 只出现在这个真实 key 里。
 *
 * ⚠ 空/缺失的账号 id 归一成 `-`。这不是「消除」混淆、只是把混淆对象换成一个
 * 本仓库拿不出来的值：账号 id 在 Jet Hub RPC 创建路径上是 `src/jet-hub-rpc.ts:839`
 * 的 `${provider}-${shortId()}`（`shortId()` 为 8 位小写 hex，见同文件 `:158`），
 * 形如 `zcode-1a2b3c4d`，不会是单个 `-`，故冲突概率远低于直接拼字面量 `undefined`
 * （那会和「一个真的叫 `undefined` 的账号」共用同一条记忆）。
 */
export declare function captchaRequirementKey(accountId: string | undefined, model: string): string;
/** 是否处于「已知需要验证」窗口（惰性回收：过期条目在下一次查询该 key 时删除）。 */
export declare function isCaptchaKnownRequired(key: string, now: number): boolean;
/** 记下「上游要验证」。 */
export declare function noteCaptchaRequired(key: string, now: number, ttlMs?: number): void;
/** 上游不要验证了：清掉记忆，回到「先探」。 */
export declare function clearCaptchaRequirement(key: string): void;
/** 记一次「先探」（不带验证头发出）。 */
export declare function noteProbeFirst(): void;
/**
 * 记一次「命中记忆」：本次查询落在 `CAPTCHA_REQUIRED_TTL_MS` 窗口内，
 * 于是**这一发直接带验证头**（省掉一次探）。
 *
 * ⚠ 调用点只在**每个请求开局那一发**（`zcode-adapter.ts` 内层循环的
 * `attempt === 0`）计数：`attempt !== 0` 的直接带验证头**不计** —— 那是本请求
 * 自己刚写下的记忆或本请求内被 `3007` 拒后的补产，不算「跨请求少探一次」。
 */
export declare function noteKnownRequiredHit(): void;
/** 观测出口。 */
export declare function captchaRequirementObservability(): {
    probeFirstCount: number;
    knownRequiredCount: number;
};
/** 清空全部状态（与本文件单测 `tests/unit/captcha-requirement.spec.ts` 的 `beforeEach` 复位配套）。 */
export declare function resetCaptchaRequirementMemory(): void;
//# sourceMappingURL=captcha-requirement.d.ts.map