/**
 * 腾讯 CodeBuddy 认证常量、凭据结构与纯解析逻辑
 *
 * 逆向自 CodeBuddy CN IDE (genie 扩展 v4.11.2) 的 external-link-v2 轮询式登录：
 * - fetchAuthState → POST /v2/plugin/auth/state?platform=ide 获取 state + authUrl
 * - openAuthUrl    → 打开浏览器到 https://www.codebuddy.cn/login/?platform=ide&state=...
 * - loopGetToken   → GET /v2/plugin/auth/token?state=... 轮询获取 token（1s 间隔，5min 超时）
 * - getAccount     → GET /v2/plugin/login/account?state=... 轮询获取账户信息
 * - refreshToken   → POST /v2/plugin/auth/token/refresh 刷新 token
 *
 * 与 CodeArts 的 PKCE OAuth + 本地回调服务器不同，CodeBuddy 采用**轮询式**：
 * 客户端不起本地服务器，而是定期轮询后端 API 检查登录状态。
 *
 * 本模块只放常量与纯函数（无网络、无存储），网络流程见 buddy-oauth.ts。
 */
/** 主 API 端点（product.json endpoint）。 */
export declare const API_ENDPOINT = "https://copilot.tencent.com";
/** API 路径前缀（product.json authentication.attributes.prefixPath）。 */
export declare const PREFIX_PATH = "/plugin";
/** 平台标识（product.json authentication.attributes.platform）。 */
export declare const PLATFORM = "ide";
/** 登录网站首页（copilot.tencent.com → www.codebuddy.cn 映射）。 */
export declare const WEBSITE_HOME = "https://www.codebuddy.cn";
/** 获取 auth state 端点：POST /v2/plugin/auth/state?platform=ide */
export declare const AUTH_STATE_PATH = "/v2/plugin/auth/state";
/** 轮询 token 端点：GET /v2/plugin/auth/token?state=... */
export declare const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";
/** 轮询账户端点：GET /v2/plugin/login/account?state=... */
export declare const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";
/** 刷新 token 端点：POST /v2/plugin/auth/token/refresh */
export declare const AUTH_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
/** 账户列表端点：GET /v2/plugin/accounts */
export declare const ACCOUNTS_PATH = "/v2/plugin/accounts";
/** 云端配置端点：GET /v3/config（获取模型列表、agents、productFeatures） */
export declare const CONFIG_PATH = "/v3/config";
/** 登录轮询总超时（5 分钟，对齐 IDE 的 5*60*1e3）。 */
export declare const LOGIN_TIMEOUT_MS: number;
/** 轮询间隔（1 秒，对齐 IDE 的 setTimeout(o,1e3)）。 */
export declare const POLL_INTERVAL_MS = 1000;
/**
 * auth/state 请求超时（10 秒）。
 *
 * ⚠️ 原为 5 秒（对齐 IDE 的 `timeout:5e3`），实测**不够**：Jet Hub 对
 * WorkBuddy（国际版）点「+ 新建账号」时，本请求发往 `www.workbuddy.ai`，
 * 用 Node 的 `fetch`（undici，与本插件运行时一致）连测 6 次稳定耗时
 * **5860–7525 ms**，即每一次都会撞上 5 秒超时，用户侧表现为
 * 「无法获取 WorkBuddy (国际版) 登录地址（Host 网络请求失败）」。
 * 放宽到 10 秒后覆盖上述区间并留出余量。
 *
 * 该常量由 buddy / workbuddy 共用：放宽只影响「失败时多等 5 秒」，
 * 不会拖慢 CodeBuddy（`copilot.tencent.com` 实测数百毫秒即返回）。
 */
export declare const STATE_REQUEST_TIMEOUT_MS = 10000;
/** 其余控制面请求超时（token/account/refresh/config）。 */
export declare const REQUEST_TIMEOUT_MS = 60000;
/** token 尚未就绪（loopGetToken 中 continue 轮询）。 */
export declare const CODE_TOKEN_NOT_READY = 11217;
/** 账户信息尚未完成（getAccount 中 continue 轮询）。 */
export declare const CODE_ACCOUNT_NOT_READY = 12151;
export declare const HTTP_HEADER_DOMAIN = "X-Domain";
export declare const HTTP_HEADER_ENTERPRISE_ID = "X-Enterprise-Id";
export declare const HTTP_HEADER_TENANT_ID = "X-Tenant-Id";
export declare const HTTP_HEADER_NO_AUTHORIZATION = "X-No-Authorization";
export declare const HTTP_HEADER_NO_USER_ID = "X-No-User-Id";
export declare const HTTP_HEADER_NO_ENTERPRISE_ID = "X-No-Enterprise-Id";
export declare const HTTP_HEADER_NO_DEPARTMENT_INFO = "X-No-Department-Info";
export declare const HTTP_HEADER_REFRESH_TOKEN = "X-Refresh-Token";
export declare const HTTP_HEADER_AUTH_REFRESH_SOURCE = "X-Auth-Refresh-Source";
export declare const HTTP_HEADER_PRODUCT = "X-Product";
export declare const HTTP_HEADER_PRODUCT_CODE = "X-Product-Code";
/**
 * User-Agent 标识（对齐 IDE 的 getUserAgent() → CodeBuddyIDE/${platformVersion}）。
 * platformVersion 来自 IDE product.json version 字段（1.106.1），非 genie 版本。
 */
export declare const BUDDY_USER_AGENT = "CodeBuddyIDE/1.106.1";
/** X-Product-Code 值（对齐 IDE headers 设置）。 */
export declare const BUDDY_PRODUCT_CODE = "codebuddy";
/** X-Product 默认值（deploymentType，对齐 ProductEndpointHttpInterceptor）。 */
export declare const BUDDY_DEPLOYMENT_TYPE = "SaaS";
/** 刷新来源标识（对齐 IDE 的 ide-main）。 */
export declare const AUTH_REFRESH_SOURCE = "ide-main";
/** API 端点的裸域名（X-Domain 头的值）。 */
export declare const API_DOMAIN = "copilot.tencent.com";
/**
 * 持久化的 CodeBuddy 凭据。
 *
 * 对齐 IDE 的 auth 对象结构（accessToken/refreshToken/expiresAt/...）
 * 加上 account 对象（uid/nickname/enterpriseId/type）。除两个令牌外的字段
 * 均为可选，以便稳妥解析来自磁盘的旧版/部分凭据。
 */
export interface BuddyCredential {
    /** 访问令牌（Authorization: Bearer <access_token>）。 */
    access_token: string;
    /** 刷新令牌（X-Refresh-Token header）。 */
    refresh_token: string;
    /** token 过期时间（原始值，可能为毫秒时间戳或 ISO 字符串）。 */
    expires_at?: string;
    /** refresh_token 过期时间。 */
    refresh_expires_at?: string;
    /** token 类型（"Bearer"）。 */
    token_type?: string;
    /** OAuth scope（通常为空）。 */
    scope?: string;
    /** API 域名（"copilot.tencent.com"）。 */
    domain?: string;
    /** 用户 ID（account.uid）。 */
    user_id?: string;
    /** 用户昵称（account.nickname）。 */
    nickname?: string;
    /** 企业 ID（account.enterpriseId，个人版为空）。 */
    enterprise_id?: string;
    /** 账户类型（"personal" / "enterprise"）。 */
    account_type?: string;
}
/** auth/token 与 auth/token/refresh 响应的令牌数据。 */
export interface BuddyToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    refreshExpiresAt: string;
    tokenType: string;
    scope: string;
    domain: string;
}
/** login/account 响应的账户数据。 */
export interface BuddyAccount {
    uid: string;
    nickname: string;
    enterpriseId: string;
    accountType: string;
}
/**
 * 从凭据 expires_at 解析毫秒时间戳（兼容毫秒时间戳 / 秒级时间戳 / ISO 8601）。
 * 无法解析或缺失时返回 undefined。
 *
 * 后备来源（e2e 实证 2026-09-11）：CodeBuddy 的 `/v2/plugin/auth/token`
 * **不返回绝对的 `expiresAt`**，只返回相对的 `expiresIn`。若凭据里的
 * `expires_at` 为空（历史写入或后端变更），回退到解析 access_token 这个
 * JWT 的 `exp` 声明——它同样是权威的过期时刻。
 */
export declare function credentialExpiresAtMs(credential: BuddyCredential): number | undefined;
/**
 * 从 JWT 的 payload 读取 `exp`（秒）并换算为毫秒；非 JWT 或解析失败返回 undefined。
 * 仅做 base64url 解码，不验签——该值只用于展示与续期调度。
 */
export declare function jwtExpiresAtMs(token: string): number | undefined;
/**
 * 从 JWT payload 读取 `nickname`（CodeBuddy 的 login/account 响应不含昵称，
 * 昵称只在 access_token 的声明里）。解析失败返回空串。
 */
export declare function jwtNickname(token: string): string;
/** 凭据是否已过期；无法解析过期时间时不判定过期（对齐 Rust is_expired）。 */
export declare function isExpired(credential: BuddyCredential): boolean;
/** 凭据是否携带可静默续期的 refresh_token。 */
export declare function isRefreshable(credential: BuddyCredential): boolean;
/**
 * 构造基础请求头（X-Domain + User-Agent + 可选企业头）。
 *
 * ⚠️ `X-Domain` 用 `||` 而非 `??`：本函数是「凭据级」基础头，调用方
 * `buddy-oauth.ts`（`refreshToken` / `fetchModels`）随后会按当前产品覆盖 domain
 * 与 UA，故它只需把**空串**兜回默认域名，不承担「以产品为准」的判定。
 * 凭据的 domain 经 `parseTokenData` → `readStringField` 读取，**字段缺失时是
 * 空串而不是 undefined** —— 用 `??` 会让 X-Domain 以空值发出（真实缺陷，已用
 * 单测复现）。判定与 `src/credits.ts` 的 `checkinHeaders` 保持同一方向。
 */
export declare function credentialRequestHeaders(credential: BuddyCredential): Record<string, string>;
/** 构造带 Bearer 令牌的认证请求头。 */
export declare function credentialAuthHeaders(credential: BuddyCredential): Record<string, string>;
/**
 * 从 JSON 解析令牌数据（兼容 camelCase 字段名与数字型时间戳）。
 *
 * e2e 实证（2026-09-11）：`/v2/plugin/auth/token` 实际只返回
 * `expiresIn` / `refreshExpiresIn`（相对秒数），**没有** `expiresAt` /
 * `refreshExpiresAt`。因此这里在绝对字段缺失时用相对秒数换算，
 * 否则凭据的 `expires_at` 会一直是空串（UI 显示"有效期未知"）。
 */
export declare function parseTokenData(data: unknown): BuddyToken;
/**
 * 从 JSON 解析账户数据。
 *
 * `login/account` 响应不含 `nickname`（e2e 实证：只有 uid/nickname 之外的
 * 字段都为空），昵称实际在 access_token 的 JWT 声明里；调用方通过
 * `buildCredential` 时传入 token 以便回填。
 */
export declare function parseAccountData(data: unknown): BuddyAccount;
/**
 * 组合令牌与账户数据为可持久化的凭据。
 *
 * 昵称回填顺序（e2e 实证 2026-09-11：`login/account` 的 `nickname` 常为空，
 * 真正的昵称只在 access_token 的 JWT 声明里）：
 * account.nickname → JWT.nickname → JWT.preferred_username。
 * 过期时间同理：token.expiresAt 为空时由 credentialExpiresAtMs 从 JWT exp 兜底。
 */
export declare function buildCredential(token: BuddyToken, account: BuddyAccount): BuddyCredential;
/** 模型 ID → 人类可读显示名称；未知模型回退为 ID 本身。 */
export declare function displayNameForModel(id: string): string;
/** /v3/config 解析出的单个模型：id、展示名与远端声明的能力。 */
export interface BuddyRemoteModel {
    id: string;
    name: string;
    /** 上下文窗口（data.models[].maxInputTokens，模型自身配置）；远端未下发时缺省。 */
    contextWindow?: number;
    /**
     * 单次请求输出上限（data.models[].maxOutputTokens）。
     *
     * ⚠️ 这是**必须消费**的权威字段，不是仅供参考的元数据：适配器早期把它只当
     * 「过滤补全模型」的判据（见 isChatModel），却从不下发到请求体，导致所有
     * buddy / workbuddy 模型都退化成网关默认输出上限（实测 32000），大文件写入
     * 与长回答会被截断成 `finish_reason: 'length'`。
     *
     * 实测（2026-09-19）各端点取值不完全一致：
     * - 中国版 scoped `/console/enterprises/personal/models` → deepseek-v4.1-flash = 128000
     * - 中国版 `/v3/config` → deepseek-v4.1-flash = 131072
     * - 国际版 `/v3/config` → deepseek-v4.1-flash = 128000
     * 与 `maxInputTokens` 同策略：采信实际命中的那个端点，不做跨端点取大。
     */
    maxOutputTokens?: number;
    /** 是否接受图片输入（data.models[].supportsImages）。 */
    supportsImages?: boolean;
    /**
     * 计费倍率（`data.models[].credits`）。
     *
     * 真实形态是**字符串**且格式不固定：`"x0.29"` / `"x0.03 credits"` / `""`（空）。
     * 归一化后存**纯文本**（如 `"x0.29"`），不存数字——因为它只是展示用，
     * 且带 ` credits` 后缀与空串两种退化形态，转数字会引入无谓的解析失败分支。
     * 远端未下发或解析不出时缺省。
     */
    creditsRate?: string;
    /**
     * 促销后的实际倍率（`data.modelPromotions.discount.discountedCredits`）。
     *
     * 与 `creditsRate` 是**同族但独立**的两个字段：促销是全局活动（按模型 id
     * 索引），活动结束后服务端会把它改成 `"0x"` 或移除。存在且非 `0x` 时才带上。
     */
    discountedCreditsRate?: string;
    /** 可选思考等级（data.models[].reasoning.supportedEfforts）；无等级可选的模型缺省。 */
    reasoningEfforts?: string[];
    /** 默认思考等级（data.models[].reasoning.defaultEffort）。 */
    defaultReasoningEffort?: string;
    /**
     * 是否被**某个 agent 引用**（即服务端声明「该模型可在对话里选择」）。
     *
     * ⚠️ 用途：`reconcileWithFallback` 是**白名单式重建**，不在产品兜底表里的
     * id 会被丢弃。而两个端点下发的 id 集合不同 —— 实测 `hy4-preview-f`
     * （新用户限时免费变体）**只由 `/v3/config` 下发**且**被 craft/ask/plan 引用**，
     * 却不在兜底表里，于是被丢弃，用户看不到那个免费变体。
     *
     * 故用本标志把「服务端说可选」的模型保留下来；未声明的内部别名
     * （如 `default`）不会被误留。
     */
    agentReferenced?: boolean;
}
/**
 * 归一化 `data.models[].credits` 为可展示的倍率文本。
 *
 * 真实形态（2026-09-19 实测，**字符串**而非数字）：
 * - `"x0.29"` / `"x1.62"` —— 常态（**x 在前**）
 * - `"x0.03 credits"` —— 早期 scoped 端点会带 ` credits` 后缀
 * - `""` / 字段缺失 —— 无倍率信息（如 `auto` / `codewise-*`）
 *
 * 返回 `"x0.29"` 这类**纯展示文本**（统一成 `x` 前缀，与官方 UI 一致）。
 * 解析不出时返回 undefined，**不回退成 `x1`**：编造倍率比不显示更糟。
 */
export declare function normalizeCreditsRate(value: unknown): string | undefined;
/**
 * 归一化 `modelPromotions[].discount.discountedCredits`。
 *
 * ⚠️ 与 {@link normalizeCreditsRate} **形态相反**：实测促销值是 `"0.50x"`
 * （**x 在后**），而模型的 `credits` 是 `"x0.29"`（x 在前）。两者是同一后端
 * 的两套写法，不能共用一个正则 —— 早期版本只认前缀，导致**促销价全部解析
 * 失败且静默丢失**（单测直接暴露了这一点）。
 *
 * 另有一种已结束占位值 `"0x"`，归一化后是 `x0`，由调用方排除。
 */
export declare function normalizeDiscountedRate(value: unknown): string | undefined;
/**
 * 从 `data.modelPromotions` 提取「模型 id → **此刻生效的**促销价」映射。
 *
 * 真实结构（**数组**，不是对象；每项按 `modelIds` 关联，不是全局）：
 * ```json
 * [{ "kind": "discount", "enabled": true, "priority": 100,
 *    "discount": { "discountedCredits": "0.50x", "displayMode": "strikethrough", "factor": 0.5 },
 *    "badge": { "color": "#1E90FF", "label": "夜间折扣" },
 *    "schedule": { "daily": [{ "start": "23:00", "end": "7:50" }], "timezone": "Asia/Shanghai" },
 *    "modelIds": ["glm-5.2"] }]
 * ```
 *
 * 四个必须处理的退化情形：
 * - **时段未到 / 已过**（`schedule`）—— 跳过，见 {@link promotionActiveNow}；
 * - **有效期已过**（`validFrom`/`validUntil`，如 `hy3` 的限时免费）—— 跳过；
 * - `enabled: false` —— 已停用，跳过；
 * - 同一模型命中多条 —— 取 `priority` 最高者。
 *
 * ⚠️ **`factor: 0` 是「免费」而非「活动已结束」**：实测 `hy4-preview` 的夜间活动
 * 是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
 * 早期实现把 `0x` 当哨兵丢弃，于是「夜间免费」永远不显示（用户报障
 * 「hy4 preview 夜间 0，现在显示 0.29」）。**真正的「已结束」由有效期表达**。
 * 作为防御：**无任何时间窗口**的 `factor: 0` 仍按「已结束占位」跳过 ——
 * 免费额度必然是限时的，没有窗口的 `0x` 更可能是遗留占位。
 */
export declare function parsePromotions(record: Record<string, unknown>, now?: Date): Map<string, string>;
/**
 * 组合计费倍率的展示文案：有促销时标出促销价，否则只显示原价。
 *
 * 形态：`"x0.17→x0.50"`；无促销时 `"x0.03"`。
 *
 * 用箭头而非「（促销 x…）」：这段文案会被拼进**模型切换菜单的名字**里
 * （见 buddy-adapter 的 displayNameFor），菜单宽度有限，箭头更短且一眼
 * 看出折扣幅度。
 */
export declare function formatCreditsRate(rate: string | undefined, discounted: string | undefined): string | undefined;
/**
 * 从 /v3/config 响应解析可用的对话模型。
 *
 * 响应结构：{data: {agents: [{name: "craft", models: ["auto", ...]}, ...],
 *                     models: [{id, name, maxInputTokens, supportsImages, reasoning: {...}}],
 *                     productFeaturesConfig?: {ModelTrialBanner: {banners: [{targetModelId}]}}}}
 *
 * 解析策略（顺序即优先级）：
 * 1. **craft agent 引用的模型** —— 主对话模型，排在最前（中国版由它列出
 *    hy4-preview / glm-5.3 等具体 id）。
 * 2. **data.models 中剩余的可对话模型** —— 国际版的 craft 只引用 5 个抽象别名
 *    （default-model/fast-model/…），其余可用模型（如 o4-mini）只出现在
 *    data.models 里；若只取 craft，这些模型会在选择器中消失。
 * 3. **试用模型**（productFeaturesConfig.ModelTrialBanner）—— 例如国际版的
 *    hy4-preview：它既不在 craft 列表也不在 data.models，仅由试用横幅下发，
 *    但实测可正常调用，故一并加入。
 *
 * 过滤规则：跳过 `auto`（自动选择，非真实模型）、非对话用途的模型
 * （`text-to-image` 标签）与补全/NES 等专用模型（id 前缀 nes- / completion-）。
 * 解析失败时返回空数组，调用方回退内置列表。
 */
export declare function parseModelsFromConfig(body: unknown): BuddyRemoteModel[];
//# sourceMappingURL=buddy.d.ts.map