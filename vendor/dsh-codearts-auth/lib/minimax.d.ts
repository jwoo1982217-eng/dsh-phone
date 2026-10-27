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
 * 与既有 `src/buddy.ts` 的 `credentialExpiresAtMs` 同一约定。
 * 不兼容会让秒级值被当成 1970 年 ⇒ **恒判已过期**、每次使用都触发无谓续期。
 */
export declare function minimaxCredentialExpiresAtMs(credential: MinimaxCredential): number | undefined;
/** 凭据是否已过期（无过期信息时保守视为未过期）。 */
export declare function isMinimaxExpired(credential: MinimaxCredential, nowMs?: number): boolean;
/** 凭据是否可续期（必须有 refresh_token）。 */
export declare function isMinimaxRefreshable(credential: MinimaxCredential): boolean;
/**
 * 传输级重试次数（**不含首次**；共发 `1 + N` 次）。
 *
 * ⚠️ 取 2 的依据：2026-10-15 本机实测，环境里的 **HTTPS 检查代理**
 *（企业 / 杀软 / Clash 的 MITM 证书）约 **50%** 概率打断到本家的请求：
 * ```
 * 签到 (signin/status): 成功 5/10 —— 失败全是
 *   fetch failed ← self-signed certificate in certificate chain [SELF_SIGNED_CERT_IN_CHAIN]
 * 目录 (models)       : 成功 10/10
 * ```
 * 失败独立同分布 ⇒ 3 次全败约 12.5%，已足够把用户可见的 `fetch failed` 压得很低；
 * 再加只会拖长真正的失败路径。
 *
 * ⚠️ **修复效果已实测**（同一端点、同一凭据、各 10 次）：
 * 裸 `fetch` **5/10** → 走本函数（插件真实代码路径）**10/10**。
 */
export declare const MINIMAX_TRANSPORT_RETRIES = 2;
/** 传输级重试的基础退避（指数：base × 2^attempt）。 */
export declare const MINIMAX_TRANSPORT_RETRY_BASE_MS = 400;
/**
 * 该错误是否为**传输级**（值得原样重发的瞬时故障）。
 *
 * ## ⚠️ 与 `classifyMinimaxFailure` 的分工（不要合并）
 *
 * - 本函数判「**要不要重发**」——只看**没拿到 HTTP 响应**的错误；
 * - `classifyMinimaxFailure` 判「**要不要换号 / 写冷却**」——那要看服务端的
 *   **明确答复**（状态码或报文）。
 *
 * 合并会让「4xx 也重发」（浪费且掩盖真因），或「传输错误被当成额度」（误封账号）。
 *
 * ## ⚠️ 必须沿 `cause` 链找真因
 *
 * undici 把底层错误包成一句 `TypeError: fetch failed`，**真因在 `cause` 里**
 *（本仓库 `docs/agent-notes/providers-opencode.md` 记过这一点）。
 * 只读 `error.message` 会漏掉 `SELF_SIGNED_CERT_IN_CHAIN` / `UND_ERR_SOCKET` 等。
 */
export declare function isMinimaxTransportError(error: unknown): boolean;
/** 退避等待（本文件内联一份，避免为一次退避引入跨模块依赖）。 */
export declare function minimaxRetrySleep(ms: number): Promise<void>;
/**
 * 带**传输级重试**地发一次请求。
 *
 * ⚠️ **只重试传输错误，绝不重试 HTTP 状态错误**：4xx / 5xx 是服务端的明确答复
 *（401 要续期、402 要充值、429 要冷却），重发只会原样失败且掩盖真因。
 *
 * ⚠️ **abort 绝不重试**：用户点了停止还继续发是**不可接受**的行为。
 *
 * ⚠️ 重试耗尽时抛**最后一次**的错误对象（保住 `cause` 链，真因仍可见）。
 *
 * @param fetchOnce 只负责发一次；判据与退避都在这里，调用方不用管。
 */
export declare function minimaxFetchWithRetry(fetchOnce: () => Promise<Response>, signal?: AbortSignal, retries?: number): Promise<Response>;
/**
 * 重定向跳数上限。
 *
 * 实测本家只有一跳（`.io`/`.chat` 域 → `.minimaxi.com`），留 3 是余量；
 * 再多就说明不是「域名迁移」而是握手/登录页重定向环 —— 那种情况必须停，
 * 否则每轮多打 N 个请求。
 */
export declare const MINIMAX_REDIRECT_MAX_HOPS = 3;
/**
 * 主机名是否等于该域**或**是它的子域（**带边界**的后缀匹配）。
 *
 * ## ⚠️⚠️ 这是「后缀匹配」的**唯一实现处**，不许在别处再抄一份
 *
 * 必须有边界：`evilminimaxi.com` **不能**命中 `minimaxi.com`。
 * 初版把「前缀伪装」漏在两个地方（2026-10-17 红队审计打穿其中一处）：
 * - `isMinimaxTrustedHost` 写了边界 ✅
 * - `isMinimaxGeoRoute` 用裸 `endsWith` ❌ ⇒ `evilminimaxi.com` 被当成中国站
 *
 * ⇒ 抽成纯函数供两处共用（本仓库明列「同义判据分两处必然漂移」）。
 */
export declare function hasHostSuffix(hostname: string, suffix: string): boolean;
/**
 * 该主机名是否属于 MiniMax 自有域（跟随即信闸门的唯一判据）。
 *
 * 导出供守卫用例逐条点名（含 `evil-minimax.io` 这类仿冒）。
 */
export declare function isMinimaxTrustedHost(hostname: string): boolean;
/**
 * 跟随重定向，并且在**每一跳重新附上自己的请求头**。
 *
 * ## ⚠️⚠️ 为什么不能依赖 `fetch` 的自动跟随（2026-10-17 真实缺陷，issue IKMEVG）
 *
 * `agent.minimax.io` 现对**所有**路径恒返 `307 → https://agent.minimaxi.com/...`
 *（两个 Akamai 边缘 IP、连打 15 次全部一致；curl 独立复核同结果）。
 * 而按 fetch 规范，**跨 origin 重定向会移除 `Authorization` 头** ——
 * 于是链路变成：
 *
 * ```
 * 带 Bearer 发 → 307 → fetch 自己跟到 minimaxi.com（Authorization 已被剥）→ 400
 * ```
 *
 * 那个 `400 {"error":"invalid signature"}` 与「**完全不发 token**」**同形**
 *（实测对照矩阵印证），所以看起来像「凭据无效 / 授权不成功」，实际是
 * **第二跳没带凭据**。
 *
 * ⚠️ 补 `x-api-key` 不解决问题：实测它虽然**不**被剥（不属于 CORS
 * non-wildcard 头），但 MiniMax 业务端点只认 `Authorization`
 *（仅 x-api-key → 同样 400 invalid signature）。
 *
 * ⇒ 唯一正解是自己跟随，并在**每一跳重新构造头**。实测效果：同一份有效
 * 凭据从 `400` 变 `200`，签到 / 积分 / 推理三个端点全部打通。
 *
 * ⚠️ **307/308 必须保留方法与 body**；301/302/303 按 fetch 规范降级成 GET
 *（本家实测只出现 307，但既然写了跟随就得两种都写对）。
 *
 * ⚠️ abort **绝不继续跟随**：用户点了停止还继续发是不可接受的行为
 *（与 `minimaxFetchWithRetry` 的既有边界同一条）。
 *
 * @param buildInit 每次跳都调用一次，返回**该跳**要用的 init（含头）。
 *   ⚠️ 传函数而不是对象，就是为了保证「重新附头」这件事在结构上做不到漏。
 */
export declare function minimaxFetchFollowRedirects(url: string, buildInit: (currentUrl: string) => RequestInit, fetcher?: typeof fetch, signal?: AbortSignal, maxHops?: number, 
/**
 * 可选：**跟随之前**观测到「国际站被地理路由」时的回调（issue IKMEVG）。
 *
 * ⚠️ 为什么必须在跟随**之前**观测：一旦跟到中国站，`401 invalid access token`
 * 与「凭据真失效」**逐字同形**（实测），事后无法区分。故这里把「判定的时机」
 * 卡在 307 这一跳上。
 *
 * ⚠️ 回调**只做记录/埋点**，不得改变控制流 —— 跟随照常进行（用户可能设了 XFF
 * 但该 IP 上游不认，此时仍要跟随以拿到真实响应）。
 */
onGeoRoute?: () => void): Promise<Response>;
/**
 * 「带传输级重试 + 保凭据跟随重定向」的完整发送入口 —— **三处调用点共用这一份**。
 *
 * ⚠️ **顺序是刻意的**：重试包在**外层**。
 * - 传输错误（本机 HTTPS 检查代理约 50% 打断）在**任何**一跳都可能发生，
 *   所以重试必须罩住整条重定向链，而不是只罩第一跳；
 * - 反过来，把跟随放外层会让「重试到一半换了一台主机」这类状态泄漏到调用方。
 *
 * ⚠️ 合成一个函数（而不是让三个调用点各自组合 `WithRetry` + `FollowRedirects`）
 * 是因为本仓库反复记录的教训：**同义判据分两处必然漂移**。漏掉任一层都是
 * 静默失效（漏跟随 = 400 假象；漏重试 = 偶发 `fetch failed`）。
 */
export declare function minimaxFetch(url: string, buildInit: (currentUrl: string) => RequestInit, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    retries?: number;
    maxHops?: number;
    /** 跟随**之前**观测到国际站地理路由时的回调（见 `minimaxFetchFollowRedirects`）。 */
    onGeoRoute?: () => void;
}): Promise<Response>;
/**
 * 国际站绕过分流用的头名（用户设置值 → 本头）。
 *
 * ⚠️ 抽成常量而不是调用点字面量：**设置侧与请求侧必须是同一个串**，
 * 拼错一处就是「设置保存成功但请求没带上」的静默失效。
 */
export declare const MINIMAX_XFF_HEADER = "X-Forwarded-For";
/**
 * 给请求头附上用户设置的 `X-Forwarded-For`（若有）。
 *
 * ## 它绕的是什么（Gitee issue IKMEVG，2026-10-17 实测）
 *
 * `agent.minimax.io` 对**所有**路径恒返 `307 → agent.minimaxi.com`，
 * 而是否 307 **由 Akamai 按请求来源 IP 的国别判定**：
 *
 * | 来源 IP | 结果 |
 * |---|---|
 * | 美国 `8.8.8.8` / `1.1.1.1`、日本、新加坡、香港 | **留在国际站（200）** |
 * | 中国 `114.114.114.114` / `223.5.5.5` / `180.76.76.76` | **307 → 中国站** |
 * | 内网 `127.0.0.1` / `10.0.0.1` / `::1`、空值、非法串 | 视为无此头 ⇒ **307** |
 *
 * ⇒ 中国大陆出口的用户**永远**拿不到国际站数据面，与 token 有效性无关。
 * 附一个**海外** IP 到本头即可让 Akamai 判定为海外来源。
 *
 * ## ⚠️ 三条必须守的纪律
 *
 * 1. **只对国际站生效**：中国站不需要绕过（它本来就在中国），给它附这个头
 *    纯属伪造来源、徒增风险。故本函数只在 `product.id === 'minimaxintl'` 时被调用
 *    （判据在调用点，见 `minimaxHeadersFor`）。
 * 2. **`undefined` / 空串 ⇒ 一个头都不加**（行为与修复前逐字节一致）。
 * 3. **值必须是 IP 字面量**：校验在 `sanitizeMinimaxXff`（store 层）与 RPC 层
 *    双重把关；本函数**信任入参已归一**，但仍做一次 `trim()` 兜底 ——
 *    因为它是最后一个能拦住「带换行的头注入」的地方。
 */
export declare function withMinimaxXff(headers: Headers, xff: string | undefined): Headers;
/**
 * 构造业务请求头。
 *
 * ⚠️ MiniMax 的业务端点**只需 Bearer**（实测签到 / 积分 / 目录均如此），
 * 不需要 machine 头或签名（与 Qoder 的 `/sash/` 端点是**不同**情形）。
 */
export declare function minimaxHeaders(credential: MinimaxCredential): Headers;
/**
 * 业务请求头 + 可选的国际站 `X-Forwarded-For`。
 *
 * ⚠️ 凡是**国际站**的业务请求都必须走本函数（而不是裸 `minimaxHeaders`），
 * 否则「用户设置了 XFF 却不生效」——与 `minimaxHeaders` 并存的同义入口是
 * 本仓库明列的缺陷形态，故本文件只保留这一个带参版本供业务路径调用；
 * `minimaxHeaders` 仅作为它的无参底层（测试与 OAuth 路径仍在用）。
 */
export declare function minimaxHeadersFor(credential: MinimaxCredential, xff: string | undefined, productId: string): Headers;
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
/**
 * 推理请求头 + 可选的国际站 `X-Forwarded-For`（理由见 `minimaxHeadersFor`）。
 */
export declare function minimaxInferHeadersFor(credential: MinimaxCredential, xff: string | undefined, productId: string): Headers;
/**
 * 该 3xx 是否是**国际站被地理路由**（而不是普通域名迁移）。
 *
 * ## 为什么要单独判它（issue IKMEVG）
 *
 * 一旦跟随过 307，**「国际站账号被导到中国站」与「凭据真失效」完全同形**
 *（都是 `401 {"error":"invalid access token"}`，本机实测逐字一致）⇒ 跟随后
 * 再想区分就**不可能**了。故必须在**跟随之前**看那个 307 的 Location。
 *
 * 判据：`minimax.io` 的响应 307 到 `minimaxi.com`。这就是 Akamai 的
 * 中国 IP 分流规则（海外 IP 不 307，实测见 `withMinimaxXff` 的表）。
 *
 * @param fromHost 请求发起的主机名（`agent.minimax.io`）
 * @param status   HTTP 状态码
 * @param location `Location` 头
 */
export declare function isMinimaxGeoRoute(fromHost: string, status: number, location: string | null): boolean;
/**
 * 地理路由的**可操作**提示文案（用户照着这一句就能自救）。
 *
 * ⚠️ 必须同时给出**三条**信息，缺一条用户就卡住：
 * ① 发生了什么（上游按出口 IP 把请求判成了中国区）；
 * ② 怎么自查（先确认自己的出口 IP 到底在哪 —— 否则用户会怀疑是插件坏了）；
 * ③ 两条出路（面板里的 XFF 设置 / 用代理改变出口 IP）。
 *
 * ⚠️⚠️ **文案不能写死"中国大陆"**（真实缺陷，2026-10-17 审计发现）：
 * 判据只是「IP 被判成中国」，而实测**内网 IP（`127.0.0.1` / `10.0.0.1` / `::1`）
 * 与无法解析的 IP 同样 307**。对本机代理/公司内网出口的用户，说「你在国内」
 * 是**事实错误**，会把他引向错误的排查方向。
 * ⇒ 措辞用「被判成中国区」，并在括号里点明「含内网或无法解析的地址」。
 *
 * @param detail 可选的**真实业务错误**原文（如 `insufficient balance`）。
 *   ⚠️⚠️ **必须透传它**（2026-10-17 自查发现的真实缺陷）：
 *   `geoRouted` 只表示「这次请求**经历过** 307」，**不表示失败原因就是地理路由**。
 *   实测反例：`307 → 402 insufficient_balance_error` 时，旧实现把文案整个换成
 *   地理路由说明 ⇒ 用户看到的全是「去填 IP / 走代理」，而**「去充值」这个唯一
 *   有效动作彻底消失**（用户会一直折腾网络，永远不知道账号没钱）。
 *   ⇒ 有业务错误原文时，**它必须出现在文案里**。
 */
export declare function describeMinimaxGeoRoute(detail?: string): string;
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