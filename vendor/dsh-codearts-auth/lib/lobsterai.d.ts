/**
 * LobsterAI（有道龙虾）协议常量、凭据结构与纯函数。
 *
 * 本模块只放**常量与纯函数**（无网络副作用，除显式的 fetcher 注入函数），
 * 与 `src/buddy.ts` 在 CodeBuddy 体系里的角色一致。网络流程见：
 * - `src/lobsterai-oauth.ts` —— 登录
 * - `src/lobsterai-auth.ts` —— 凭据服务（续期 / 状态）
 * - `src/lobsterai-adapter.ts` —— chat 转发
 * - `src/lobsterai-credits.ts` —— 签到与余额
 *
 * ## 协议速览（来源：`lobsterai2api`，实证见 docs/lobsterai-integration-plan.md §4）
 *
 * | 用途 | 方法 | 路径 | 认证 |
 * |---|---|---|---|
 * | 换 token | POST | `/api/auth/exchange` | 无 |
 * | 续期 | POST | `/api/auth/refresh` | 无（**不带 Authorization**） |
 * | 对话 | POST | `/api/proxy/v1/chat/completions` | Bearer |
 * | 模型列表 | GET | `/api/models/available` | Bearer |
 * | 积分余额 | GET | `/api/user/profile-summary` | Bearer |
 *
 * **统一信封** `{code, msg, data}`：`code !== 0` 即失败。
 * 唯一例外是 chat 端点 —— 它返回**裸 SSE，不套信封**。
 */
import type { LobsteraiProduct } from './lobsterai-product.js';
/** 授权码换 token。 */
export declare const LOBSTERAI_EXCHANGE_PATH = "/api/auth/exchange";
/** 静默续期。 */
export declare const LOBSTERAI_REFRESH_PATH = "/api/auth/refresh";
/** 可用模型列表。 */
export declare const LOBSTERAI_MODELS_PATH = "/api/models/available";
/**
 * 对话端点（OpenAI 兼容，**仅支持 SSE**）。
 *
 * 积分余额端点（`/api/user/profile-summary`）刻意**不在此处**定义：
 * 唯一使用方是 `src/lobsterai-credits.ts`，常量就近定义在那里。
 * 曾经两处各定义一份同名常量，端点一旦变更只改一处会让语义分叉，
 * 且没有任何测试会失败 —— 单一真相源比「集中放一起」更重要。
 */
export declare const LOBSTERAI_CHAT_PATH = "/api/proxy/v1/chat/completions";
/** 登录回调路径（对齐 `cmd/login/main.go:35` 的 `callbackPath`）。 */
export declare const LOBSTERAI_CALLBACK_PATH = "/auth/callback";
/** 控制面请求超时（毫秒）；对话流式请求不适用。 */
export declare const LOBSTERAI_REQUEST_TIMEOUT_MS = 30000;
/** 登录流程总超时（毫秒）；对齐 `main.go:36` 的 10 分钟回调窗口。 */
export declare const LOBSTERAI_LOGIN_TIMEOUT_MS: number;
/**
 * 客户端版本号缓存有效期（毫秒，12 小时）。
 *
 * 版本号是**日期式**的（如 `2026.9.4`），变更频率极低（客户端发版节奏），
 * 而签到每次都要带它 —— 不缓存会让每次签到多一次跨域请求。
 */
export declare const LOBSTERAI_VERSION_CACHE_TTL_MS: number;
/**
 * 持久化的 LobsterAI 凭据。
 *
 * 字段名刻意保持 `snake_case`，与 `BuddyCredential` 一致 ——
 * `AccountPool.findAccountIdByCredential`（`src/account-pool.ts:352-364`）
 * 对非 codearts 的 provider 统一取 `access_token` 作身份标识，
 * 命名一致才能直接复用，无需改那个函数。
 *
 * ## 与 `BuddyCredential` 的关键结构差异
 *
 * LobsterAI 的 **refresh 请求体不是只带 refreshToken**，还要带
 * `firstKeyfrom` / `latestKeyfrom` / `uuid`（`auth.go:37-50` +
 * `client.go:112-147`）。这三个字段必须随凭据一起持久化 —— 丢了就续期失败、
 * 只能让用户重新登录。这是两边最大的差异，也是最容易漏掉的地方。
 */
export interface LobsteraiCredential {
    /** 访问令牌（`Authorization: Bearer <access_token>`）。 */
    access_token: string;
    /** 刷新令牌。
     *
     * 由 exchange/refresh 返回。注意 Go 版把它当作「可缺失」处理
     * （`Parse` 不校验），故这里也保持必填但允许空串，
     * `isRefreshable` 以长度判定。
     */
    refresh_token: string;
    /**
     * 过期时间（**毫秒时间戳字符串**）。
     *
     * 统一存毫秒字符串而非秒/ISO：与 `BuddyCredential.expires_at` 的存储约定
     * 保持一致，`credentialExpiresAtMs` 一套解析逻辑可通用于两者。
     */
    expires_at?: string;
    /** 用户唯一 ID（账号池去重、候选排序的标识）。 */
    uid?: string;
    /** 有道 yid（用于 refresh 请求体，与 uid 不一定相同）。 */
    user_id?: string;
    /** 昵称（UI 展示）。 */
    nickname?: string;
    /**
     * 安装 UUID（exchange/refresh 必带）。
     *
     * 登录时由客户端生成（对齐 `main.go:166` `newUuid()`），
     * 之后每次续期原样回传。**不能每次刷新都重新生成** ——
     * 它是服务端识别「同一安装」的依据。
     */
    uuid?: string;
    /** 首次登录时间戳（毫秒字符串，exchange/refresh 必带）。 */
    first_keyfrom?: string;
    /** 最近活动时间戳（毫秒字符串，**每次刷新后更新**）。 */
    latest_keyfrom?: string;
}
/**
 * 把手机号（完整或已脱敏）统一掩码为**只露末 2 位**的形态。
 *
 * ## 为什么需要它（用户要求 2026-09-27）
 *
 * > lobsterai 的用户名字显示的手机号尾号漏出 4 位，现在也改为只漏出 2 位
 *
 * 故这里做**归一化**而非改某个 `slice(-4)`：两种输入都收敛到同一形态，
 * 因此**幂等**（已归一化的值再跑一次结果不变），老账号也无需重新登录。
 *
 * | 输入 | 输出 |
 * |---|---|
 * | `13011111100`（完整号码） | `130******00` |
 * | `130****1100`（服务端脱敏，露 4 位） | `130******00` |
 * | `130******00`（已归一化） | `130******00`（幂等） |
 * | `测试账号` / `用户26815487395` | 原样返回（非手机号形态） |
 *
 * ⚠️ **只对「像手机号」的输入生效**：判据是 11 位纯数字（`1` 开头），或
 * `3 位数字 + 星号 + 数字` 的脱敏形态。绝不能泛化到任意字符串 ——
 * 那会把真实昵称（如 `用户26815487395`）也掩码掉。
 *
 * 星号个数按**原串总长**推算（`总长 - 3 - 2`），故对非 11 位的号码也自洽。
 *
 * @param visibleTail 保留的末位位数；默认 **2**（用户要求的展示口径）
 */
export declare function maskLobsteraiPhoneTail(value: string, visibleTail?: number): string;
/**
 * LobsterAI 账号在 Jet Hub 里的**展示名**：昵称经手机号掩码归一化。
 *
 * 服务端把**手机号本身**当昵称下发（见 {@link maskLobsteraiPhoneTail}），
 * 故这里统一收敛到「只露末 2 位」；非手机号形态的昵称原样保留。
 * 昵称为空时退回账号 id（与登录路径既有行为一致）。
 */
export declare function lobsteraiDisplayNickname(credential: Pick<LobsteraiCredential, 'nickname'> | undefined, fallbackId: string): string;
/** 信封解析成功。 */
export interface LobsteraiEnvelopeSuccess {
    ok: true;
    data: Record<string, unknown>;
}
/** 信封解析失败（业务码非 0，或 data 缺失/非对象）。 */
export interface LobsteraiEnvelopeFailure {
    ok: false;
    /** 业务码；无法读出时为 -1。 */
    code: number;
    /** 可读原因（优先服务端 msg，缺失时给出本地的结构性说明）。 */
    message: string;
}
export type LobsteraiEnvelopeResult = LobsteraiEnvelopeSuccess | LobsteraiEnvelopeFailure;
/** 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。 */
export declare function readStringField(source: Record<string, unknown>, key: string): string;
/** 从 JSON 安全读取数字字段（兼容字符串形态的数字）。 */
export declare function readNumberField(source: Record<string, unknown>, key: string): number | undefined;
/**
 * 解析 `{code, msg, data}` 信封。
 *
 * 三条判定（对齐 `main.go:143-150` 与 `sigin.py:44-48` 的双重校验）：
 *
 * 1. 响应体必须是对象；
 * 2. `code` 必须为 `0`；
 * 3. `data` 必须是**对象** —— 非对象一律视为失败。
 *
 * 第 3 条尤其重要：`sigin.py:46-47` 用它判定「accessToken 可能已失效」——
 * 上游在凭据失效时倾向于返回 `code:0` 但 `data:null`，
 * 只看 code 会把这种情况当成成功，随后在解引用时崩在更远的地方。
 */
export declare function parseLobsteraiEnvelope(body: unknown): LobsteraiEnvelopeResult;
/**
 * 从凭据的 `expires_at` 解析毫秒时间戳。
 *
 * 兼容毫秒时间戳 / 秒级时间戳 / ISO 8601 三种形态，与
 * `src/buddy.ts:credentialExpiresAtMs` 的解析口径一致（详见那里的说明）。
 *
 * 后备来源：`expires_at` 为空时回退解析 `access_token` 这个 JWT 的 `exp`。
 * Go 注释（`main.go:317`）说明「实测 HS512 access token 30 天」，
 * 故 access token 是 JWT，`exp` 是权威过期时刻。
 */
export declare function lobsteraiCredentialExpiresAtMs(credential: LobsteraiCredential): number | undefined;
/** 凭据是否已过期；无法解析过期时间时**不**判定过期（与 Rust/Go 侧一致）。 */
export declare function isLobsteraiExpired(credential: LobsteraiCredential): boolean;
/** 凭据是否携带可静默续期的 refresh_token。 */
export declare function isLobsteraiRefreshable(credential: LobsteraiCredential): boolean;
/**
 * 构造 `keyfrom` 身份载荷。
 *
 * 对应 Go 的 `Auth.KeyfromBody()`（`auth.go:37-50`）。三个字段的含义：
 *
 * - `firstKeyfrom` —— 首次登录时间戳，标识「这个账号是什么时候开始用的」；
 * - `latestKeyfrom` —— 最近活动时间戳，随每次调用更新；
 * - `version` —— 客户端版本号（**动态真值**，见 §7.2 R11 的说明）；
 * - `uuid` / `userId` —— 可选，缺失时不带该键（而非带空串）。
 *
 * `uuid` / `userId` 缺省时**删除键**而不是写空串：Go 的 `if a.Uuid != ""`
 * 就是「有才带」，空串可能被服务端当成非法值。
 */
export declare function lobsteraiKeyfromBody(credential: LobsteraiCredential, clientVersion: string): Record<string, unknown>;
/**
 * 构造续期请求体 = keyfrom 载荷 + `refreshToken`。
 *
 * `latestKeyfrom` 与 `firstKeyfrom` 都用**凭据里存储的原值**，不取当前时刻
 * （对齐 Go：`KeyfromBody()` 读 `a.LatestKeyfrom`，而 `RefreshToken`
 * 从不更新该字段）。详见 {@link lobsteraiKeyfromBody} 的说明。
 *
 * 注意 `version` 由调用方传入而非在函数内取全局缓存：这样本函数是纯函数、
 * 可完整单测，也不把「版本号从哪来」这个决策硬编码进来。
 */
export declare function lobsteraiRefreshBody(credential: LobsteraiCredential, clientVersion: string): Record<string, unknown>;
/** exchange / refresh 响应的令牌部分。 */
export interface LobsteraiTokenPayload {
    accessToken: string;
    refreshToken: string;
    /** 相对过期秒数；缺失时为 undefined（由 JWT exp 兜底）。 */
    expiresIn?: number;
    /** 用户 ID 候选（`user.id`）。 */
    userId?: string;
    /** 有道 yid（`user.yid`）。 */
    yid?: string;
    /** 账号 userId（`user.userId`）。 */
    accountUserId?: string;
    /** 昵称。 */
    nickname?: string;
}
/**
 * 解析 exchange / refresh 响应里的令牌与用户信息。
 *
 * `expiresIn` 允许缺失：Go 在缺失时回退解 JWT `exp`（`main.go:313-319`），
 * 本插件在 {@link buildLobsteraiCredential} 里做同样的兜底。
 */
export declare function parseLobsteraiTokenPayload(data: Record<string, unknown>): LobsteraiTokenPayload;
/**
 * 解析账号唯一 ID，按**四级**回退（严格对齐 `main.go:297-306`）：
 *
 * `user.id` → `user.userId` → `user.yid` → `sha256(accessToken)` 前 16 位。
 *
 * 前三者是服务端字段，不同账号形态下哪个非空并不固定（个人号与企业号不同）；
 * 末级哈希兜底保证**任何情况下都能得到一个稳定 ID** —— 否则空 uid 会让
 * 账号池里多个账号互相覆盖（`addAccount` 按 id 去重）。
 *
 * 哈希取 hex 前 16 字符，与 Go 的 `fmt.Sprintf("%x", sha256.Sum256(...))[:16]`
 * 完全一致 —— 这是与 `lobsterai2api` 生成的 `auths/lobsterai-{uid}.json`
 * 逐字节对照的前提。
 *
 * ⚠️ **刻意不在 `yid` 与哈希之间插入 JWT `sub` 回退**：Go 没有这一级，
 * 插进去会让「服务端三个 user 字段皆空」的账号在本插件得到 `sub`、
 * 而在 Go 得到 16 位哈希 —— 同一账号两种 uid，破坏上述对照能力。
 * 稀有路径上与参考实现分叉，比多兜一层更糟。
 */
export declare function resolveLobsteraiUid(payload: LobsteraiTokenPayload): string;
/**
 * 由令牌载荷组装可持久化的凭据。
 *
 * `expires_at` 的取值顺序（**与 Go 一致**，`main.go:313-319`）：
 * 1. `expiresIn`（相对秒数）→ 以**当前时刻**为基准换算；
 * 2. 缺失时用 access token 的 JWT `exp`；
 * 3. 都拿不到则留空（`credentialExpiresAtMs` 会再尝试 JWT，仍失败则
 *    「不判定过期」——见 `isLobsteraiExpired`）。
 *
 * ⚠️ 基准取当前时刻而非 JWT `iat`：Go 用的是 `time.Now()`，
 * 与 Buddy 侧（用 iat）不同。保持与 Go 一致以便对照排查。
 *
 * `uuid` / `first_keyfrom` / `latest_keyfrom` 必须由调用方提供 ——
 * 它们不在响应里，而是登录流程自己生成的状态（见 `lobsterai-oauth.ts`）。
 */
export declare function buildLobsteraiCredential(payload: LobsteraiTokenPayload, session: {
    uuid: string;
    firstKeyfrom: string;
    latestKeyfrom: string;
}): LobsteraiCredential;
/**
 * 用续期结果更新凭据（保留服务端未返回的字段）。
 *
 * **所有身份字段一律沿用旧值**（`uuid` / `first_keyfrom` / `latest_keyfrom`
 * / `uid` / `user_id` / `nickname`）：LobsterAI 的 refresh 响应只带令牌，
 * 不含 account 对象。
 *
 * ⚠️ `latest_keyfrom` **刻意不更新为当前时刻**（虽然字段名叫「最近活动」）——
 * 严格对齐 Go：`RefreshToken`（`client.go:137-145`）只改 token 与过期时间，
 * `LatestKeyfrom` 永久停留在登录时那一刻，续期时原样回发。
 * 语义上「刷新即活动、理应更新」是更直觉的读法，但 Go 是唯一在生产验证过的
 * 实现；若服务端对该字段有校验，自作聪明地更新会让续期失败，
 * 而这不是能从代码推导出来的，需要实测支撑（见计划文档 §7.2）。
 */
export declare function applyLobsteraiRefresh(previous: LobsteraiCredential, payload: LobsteraiTokenPayload, nowMs?: number): LobsteraiCredential;
/**
 * 构造带 Bearer 的通用请求头。
 *
 * 只设四个头：LobsterAI **不认** CodeBuddy 那套
 * `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` 归属头，
 * 带上不仅无用，还可能让服务端按错误的客户端形态归因。
 */
export declare function lobsteraiAuthHeaders(credential: LobsteraiCredential, product: LobsteraiProduct, accept?: string): Record<string, string>;
/**
 * 构造对话请求头。
 *
 * 比 {@link lobsteraiAuthHeaders} 多两个 `X-LobsterAI-Client-*` 头，
 * `Accept` 为 SSE。这两个头来自 `client.go:94-101` 的实测实现：
 * `Capabilities` 声明客户端支持的 agentic 协议版本（影响工具调用行为），
 * `Version` 是客户端版本号（**用动态真值**，见下方说明）。
 *
 * 注意 `X-LobsterAI-Client-Version` 用传入的 `clientVersion` 而非
 * `product.fallbackClientVersion`：Go 侧一直发假值 `0.1.0` 未被拒绝，
 * 说明服务端不强校验，但**没有理由继续发假值**。
 */
export declare function lobsteraiChatHeaders(credential: LobsteraiCredential, product: LobsteraiProduct, clientVersion: string): Record<string, string>;
/**
 * 构造**模型列表**请求头（`GET /api/models/available`）。
 *
 * 与 {@link lobsteraiChatHeaders} 同样带两个 `X-LobsterAI-Client-*` 头，
 * 只是 `Accept` 为 JSON 而非 SSE。
 *
 * **这两个头在本端点是必需的，不是可有可无的元数据**（2026-09-17 实测）：
 * 服务端按 `X-LobsterAI-Client-Capabilities` 声明的能力**过滤模型集合** ——
 * 不带该头时 `kimi-k3` 不会出现在返回里（25 个模型），带上 `kimi-k3-agentic-v1`
 * 才返回 26 个。IDE 侧走的就是 `buildServerModelCapabilityHeaders`，
 * 与本函数同形。
 *
 * 早先的实现用 {@link lobsteraiAuthHeaders}（只有 4 个基础头）请求本端点，
 * 因此即使解析正确也会**永久缺少 kimi-k3**。`X-LobsterAI-Client-Version`
 * 同理用动态真值。
 */
export declare function lobsteraiModelsHeaders(credential: LobsteraiCredential, product: LobsteraiProduct, clientVersion: string): Record<string, string>;
/**
 * 构造无认证请求头（exchange / refresh 用）。
 *
 * 这两个端点**不需要** `Authorization` —— 换 token 时还没有 token，
 * 续期时服务端只认请求体里的 `refreshToken`（`auth.go:104-108` 的
 * `authHeaders` 同样不设该头）。
 */
export declare function lobsteraiAnonymousHeaders(product: LobsteraiProduct): Record<string, string>;
/**
 * 校验并解析日期式版本号。
 *
 * 正则对齐 `sigin.py:16-18` 的 `version_key`：
 * `^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$` —— 主干为点分数字，
 * 允许一个可选的预发布后缀（如 `2026.9.4-beta.1`）。
 *
 * 之所以要**校验**而不是直接采信：版本号是签到接口的必填 query 参数，
 * 若上游返回 `null` / 空串 / HTML 错误页，把它拼进 URL 会让签到以一个
 * 更费解的错误失败。提前拒绝能给出「版本格式异常」这种可读原因
 * （对齐 `sigin.py:27-28` 的 `RuntimeError`）。
 *
 * @returns 归一化后的版本字符串；格式非法时返回 undefined。
 */
export declare function parseClientVersion(raw: unknown): string | undefined;
/**
 * 从更新接口的响应体里取出 `data.value.version`。
 *
 * 该响应的结构与业务接口**不同**（见 `LOBSTERAI_CLIENT_VERSION_API` 说明）：
 * `code`/`msg` 在外层，载荷在 `data.value`。实测形状：
 * `{data:{value:{version:"2026.9.4", date, windowsX64:{url}, ...}}, code:0, msg:"OK"}`。
 */
export declare function parseClientVersionFromUpdate(body: unknown): string | undefined;
/**
 * 客户端版本号解析器（带进程内缓存与兜底）。
 *
 * 抽取成类而非模块级单例：模块级可变状态会让单元测试互相污染
 * （某个用例写入缓存后，后续用例就再也不会走到真实拉取分支）。
 * 生产侧在 `src/lobsterai-auth.ts` 里持有一个实例即可。
 */
export declare class LobsteraiClientVersionResolver {
    private readonly options;
    private cached;
    private cachedAt;
    constructor(options?: {
        /** 缓存有效期；默认 {@link LOBSTERAI_VERSION_CACHE_TTL_MS}。 */
        ttlMs?: number;
        /** 注入的 fetch（测试用）。 */
        fetcher?: typeof fetch;
        /** 注入的时钟（测试用）。 */
        now?: () => number;
    });
    /**
     * 解析当前客户端版本号。
     *
     * 顺序：进程内缓存（未过期）→ 请求上游更新接口 → 兜底常量。
     *
     * **失败不回退到抛错**（与 `sigin.py:73-76` 的「整个脚本放弃签到」不同）：
     * 返回 `fallbackClientVersion` 并在返回值里标出 `source`，
     * 让调用方能决定是否记日志。理由见 `LOBSTERAI_FALLBACK_CLIENT_VERSION` 说明。
     */
    resolve(product: LobsteraiProduct): Promise<{
        version: string;
        source: 'cache' | 'remote' | 'fallback';
    }>;
    /** 清空缓存（测试与「强制刷新版本号」场景用）。 */
    clear(): void;
}
//# sourceMappingURL=lobsterai.d.ts.map