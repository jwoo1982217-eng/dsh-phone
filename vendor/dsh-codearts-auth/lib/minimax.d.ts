/**
 * MiniMax Code 协议常量、凭据结构与归一纯函数。
 *
 * ⚠️ **两条来源（远端解析与兜底表）共用的是「输出形状」**（`MinimaxModelEntry`），
 * **不是归一规则** —— 兜底路径由 `fallbackToEntry` 直接搬运人工填好的字面量，
 * **不调用** `normalizeMinimaxModel`。
 * ⇒ 改归一规则时**必须同步核对兜底表**，否则远端失败降级到兜底表时档位与窗口
 * 会不一致（**静默失效**，极难排查）。
 */
import { type MinimaxFallbackModel, type MinimaxProduct } from './minimax-product.js';
/** 凭据结构（存 `ctx.credentials`）。 */
export interface MinimaxCredential {
    /** OAuth access token（前缀 `mmoat_`，实测 60 字符）。 */
    access_token: string;
    /**
     * refresh token（实测 60 字符）。
     *
     * ⚠️ **不是 JWT**（非三段）⇒ **不能**从 JWT 解过期时间，
     * 必须用响应 `expires_in` 自算 `expires_at`。
     */
    refresh_token?: string;
    /** 恒 `'Bearer'`。 */
    token_type?: string;
    /**
     * 毫秒时间戳字符串（本实现写入的形态）。
     *
     * ⚠️ **读取时也兼容秒级时间戳**（`> 1e12` 视为毫秒，否则视为秒）——
     * 与既有 `src/buddy.ts` 的 `credentialExpiresAtMs` 同一约定。
     * 不兼容会让「上游/历史误写成秒」的值被当成 1970 年 ⇒ **恒判已过期**、无谓续期。
     */
    expires_at?: string;
    /** 空格分隔的 scope 字符串。 */
    scope?: string;
    /**
     * 账号标识（若可解）。
     *
     * ⚠️ 实测本机凭据的 `access_token` **不是 JWT**（见 `decodeJwtExpMs` 的注释），
     * 故该字段对当前凭据**恒为 undefined**。保留仅为兼容上游将来改发 JWT。
     */
    account_id?: string;
    /** 展示名。 */
    nickname?: string;
}
/**
 * 从 JWT 解出 `exp`（毫秒）。
 *
 * ⚠️⚠️ **实测：MiniMax 的 `access_token` 不是 JWT**（复审者 2026-09-28 读本机凭据形状：
 * 前缀 `mmoat_`、**60 字符、0 个点**；`refresh_token` 前缀 `mmort_` 同样非 JWT）。
 * 故本函数对真实凭据**恒返回 `undefined`**，`minimaxCredentialExpiresAtMs` 实际
 * **永远**走 `expires_at` 回退。
 *
 * ⇒ **登录/续期时必须写入 `expires_at`**（由 `expires_in` 自算），
 * 否则过期时间彻底丢失、账号永远显示「未知」。
 *
 * 保留本函数仅为兼容上游将来改发 JWT —— **不要**据此省略 `expires_at` 的写入。
 */
export declare function decodeJwtExpMs(token: string): number | undefined;
/** 从 JWT 解出 `sub`（账号标识）。 */
export declare function decodeJwtSub(token: string): string | undefined;
/**
 * 凭据过期时间（毫秒）。
 *
 * ⚠️ **优先 `expires_at`** —— 实测 `access_token` **不是 JWT**（见 `decodeJwtExpMs`），
 * 故 JWT 路径对真实凭据恒不命中。保留 JWT 分支只为兼容上游将来改发 JWT。
 *
 * ⚠️ **单位兼容**：`expires_at` 是**秒**时按秒换算（判据 `> 1e12` 视为毫秒），
 * 与既有 `src/buddy.ts:162` 的 `credentialExpiresAtMs` 同一约定。
 * 不兼容会让秒级值被当成 1970 年 ⇒ **恒判已过期**、每次使用都触发无谓续期。
 */
export declare function minimaxCredentialExpiresAtMs(credential: MinimaxCredential): number | undefined;
/** 凭据是否已过期（无过期信息时保守视为未过期）。 */
export declare function isMinimaxExpired(credential: MinimaxCredential, nowMs?: number): boolean;
/** 凭据是否可续期（必须有 refresh_token）。 */
export declare function isMinimaxRefreshable(credential: MinimaxCredential): boolean;
/**
 * 构造业务请求头。
 *
 * ⚠️ MiniMax 的业务端点**只需 Bearer**（实测签到 / 积分 / 目录均如此），
 * 不需要 machine 头或签名（与 Qoder 的 `/sash/` 端点是**不同**情形）。
 */
export declare function minimaxHeaders(credential: MinimaxCredential): Headers;
/**
 * 推理请求的头（**Anthropic Messages** 端点）。
 *
 * ⚠️ **实测不需要 `anthropic-version` 头**（2026-09-29 真实请求：只带
 * `Authorization` + `Content-Type` + `Accept` 即 HTTP 200）。
 * 故**不照抄 Anthropic 官方文档**加那个头 —— 加未经验证的头是猜测。
 *
 * ⚠️ `Accept: text/event-stream`（不是 `application/json`）：
 * 请求体带 `stream: true`，响应是 SSE。
 */
export declare function minimaxInferHeaders(credential: MinimaxCredential): Headers;
/** 归一后的模型条目（远端与兜底**共用**的形状）。 */
export interface MinimaxModelEntry {
    id: string;
    name: string;
    /**
     * 上下文窗口。
     *
     * ⚠️ **`0` 是「未知」哨兵**，不是合法窗口 —— 调用方（`resolveModel`）
     * **必须**判 `> 0` 才声明，否则会把 0 当成有效窗口下发给 DSH。
     */
    contextWindow: number;
    /**
     * 单次输出上限。
     *
     * ⚠️ **可选**：远端 `limit.output` 非正整数（`0` / 负数 / `NaN` / 缺失）时
     * **整个键不产出**。声明成必填 `number` 会让类型撒谎 —— 调用方若信它，
     * 会把 `undefined` 塞给 DSH 的 `defaultMaxTokens`，触发
     * `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）。
     *
     * 兜底表的每一条都填了它（见 `MinimaxFallbackModel.maxTokens`），
     * 故可选只影响远端路径。
     */
    maxTokens?: number;
    supportsImage: boolean;
    effortOptions?: readonly string[];
    defaultEffort?: string;
    /**
     * 思考开关模式（远端 `thinking_config.mode`）。
     *
     * ⚠️ `'switchable'` ⇒ 该模型**可以关闭思考**，`minimaxReasoningInfo` 会
     * 追加 `none` 档（DSH 的 `LlmModelReasoningInfo` 没有 `supportsDisable` 字段，
     * 「可关闭」就是靠 `efforts` 里出现 `none` 表达的）。
     * `'forced_on'` ⇒ **不可关闭**，绝不追加（M3.1 会硬 400、M2.7 被静默忽略）。
     * 缺失 ⇒ 未知，不声明开关能力。
     */
    thinkingMode?: string;
}
/**
 * 把**远端**模型条目归一。
 *
 * 规则参照 asar `official-model-config-sync.js` 的 `parseModel`：
 * - `contextWindow` 取 `context_window_options` **最大档**；无档位表则回退 `limit.context`
 * - `maxTokens` 取 `limit.output`，**只放行安全正整数**（`0`/负数/`NaN` 会让 DSH 抛
 *   `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**）
 * - `supportsImage` = `modalities.input` 含 `'image'`
 * - `effortOptions` 取 `effort_options`（去重保序）
 * - `defaultEffort` 取 `default_effort`，**必须落在 `effortOptions` 内**，否则丢弃
 *
 * ⚠️ **只实现了 snake_case 字段名**（实测远端下发即 snake_case）。asar 的
 * `parseModel` 通过 `aliasValue()` **同时**认 camelCase 别名（实测共 4 组：
 * `context_window_options` ← `contextWindowOptions` / `context_options`；
 * `context_window_option_hints` ← `contextWindowOptionHints` / `context_option_hints`；
 * `effort_options` ← `thinking.effortOptions`；
 * `default_effort` ← `thinking.defaultEffort`），
 * 并带 `≤ 2147483647`（2^31-1）上限校验（`requirePositiveInteger` 超限即抛）——
 * **这些本实现都没有做**。
 *
 * 若哪天远端改下发 camelCase，或下发超过 2^31-1 的值，本函数会**静默取不到值**
 * （窗口退化为 `0` 哨兵 / 回退 `limit.context`），届时需按 asar 补齐。
 */
export declare function normalizeMinimaxModel(raw: unknown): MinimaxModelEntry | undefined;
/**
 * 兜底表条目转归一形状。
 *
 * ⚠️ **不是「与远端走同一套规则」** —— 本函数**直接搬运字面量**，不调用
 * `normalizeMinimaxModel`：两条路径只共用**输出形状**（`MinimaxModelEntry`），
 * **不共用归一规则**。兜底表的值是**人工按实测口径填好的字面量**
 * （已符合「档位表最大档」口径），故只需搬运、无需再归一。
 *
 * ⚠️ 因此**改归一规则时必须同步核对兜底表**（例如改了窗口口径，
 * 兜底表不会跟着变）—— 回归用例里有一条一致性断言专门锁这一点。
 */
export declare function fallbackToEntry(model: MinimaxFallbackModel): MinimaxModelEntry;
/** 默认产品下的兜底条目。 */
export declare function minimaxFallbackEntries(product?: MinimaxProduct): readonly MinimaxModelEntry[];
//# sourceMappingURL=minimax.d.ts.map