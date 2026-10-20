/**
 * ZCode 插件内登录（**不需要 ZCode IDE**）。
 *
 * ## 协议（从官方 asar 的 `startOAuthWithPolling` 解出，并经实测跑通）
 *
 * 官方 3.12.3+ 桌面版用的是**服务端中介的设备授权流** ——
 * 完全不经 `zcode://` 自定义协议回调，故普通 Node 进程就能走完：
 *
 * ```
 * ① POST /api/v1/oauth/cli/init
 *      Authorization: Bearer <自己生成的 32 字节 hex>
 *      body: { provider: "bigmodel" }
 *    → { flow_id, poll_token, authorize_url, expires_at, poll_interval_sec }
 *
 * ② 用户在浏览器打开 authorize_url 完成授权
 *      （授权在**服务端**完成，回调到 /oauth/cli/callback/bigmodel）
 *
 * ③ GET /api/v1/oauth/cli/poll/{flow_id}
 *      → { status: "pending" }                    继续等
 *      → { status: "ready", token, user, bigmodel: { access_token, refresh_token? } }
 * ```
 *
 * 本机实测（2026-09-29）：
 *
 * ```
 * ① HTTP 200  flow_id=ed3c813afe…  poll_interval_sec=2
 *    authorize_url=https://bigmodel.cn/login?appId=zcode&redirect=…&state=…
 * ③ HTTP 200  status=pending  （轮询正常）
 * ```
 *
 * ## 为什么这条路径是正确的
 *
 * 它**绕开了故障的 `POST /api/v1/oauth/token`**（`dsh-free-glm` 记录该端点
 * 自 2026-09-28 起稳定 500 / code 2007）—— token 由轮询直接返回，
 * 完全不经过它。
 *
 * ## 凭据的**唯一**来源
 *
 * 就是本文件这条授权流。此前还存在一条「回退：解密官方客户端的
 * `~/.zcode/v2/credentials.json`」的旁路，它已于 2026-10-05 整体删除
 * （理由见 `zcode.ts` 文件头）⇒ 现在**不读本机任何 ZCode 数据**。
 */
/** ZCode 平台 origin。 */
export declare const ZCODE_ORIGIN = "https://zcode.z.ai";
/** 设备授权流的初始化端点。 */
export declare const ZCODE_OAUTH_CLI_INIT_URL = "https://zcode.z.ai/api/v1/oauth/cli/init";
/** 轮询端点（需拼 `flow_id`）。 */
export declare const zcodeOauthCliPollUrl: (flowId: string) => string;
/**
 * 支持的 provider 标识（官方 `Ne` / `"zai"` 两个）。
 *
 * ⚠ 实测 `bigmodel`（对应 `Ne`）在授权 URL 上追加的是 `redirect=`；
 * 官方对 `zai` 追加的是 `redirect_uri=` —— 两者语义相同但参数名不同，
 * 故这里保留区分。
 *
 * ## 两者的实际差异（2026-10-02 实测）
 *
 * | provider | 授权页 | 凭据落点 | 适用 |
 * |---|---|---|---|
 * | `bigmodel` | `bigmodel.cn/login?appId=zcode&redirect=…` | `data.bigmodel` | 智谱开放平台（国内） |
 * | `zai` | `chat.z.ai/api/oauth/authorize?client_id=…&redirect_uri=…` | `data.zai` | z.ai（国际版） |
 *
 * 两者的 `init` 响应结构**完全一致**（`flow_id` / `poll_token` /
 * `authorize_url` / `expires_at` / `poll_interval_sec`），差异只在
 * ready 响应里第三方 token 落在哪个块 —— 故 `pollZcodeLogin` 对两者
 * 都做了兼容（见那里的字段注释）。
 */
export declare const ZCODE_LOGIN_PROVIDER = "bigmodel";
/** 可选的登录 provider。 */
export type ZcodeLoginProvider = 'bigmodel' | 'zai';
/** ① 的响应。 */
export interface ZcodeLoginFlow {
    /** 流程 id（③ 用它轮询）。 */
    flowId: string;
    /**
     * 轮询令牌。
     *
     * ⚠ 官方的实现里 ③ **只带 flow_id、不带这个 token**（它把
     * `oauthFlowStartGeneration` 用作并发保护）。这里保留字段以便诊断，
     * 但**不**把它当作 ③ 的鉴权凭证 —— 实测 ③ 不带它也返回 200。
     */
    pollToken?: string;
    /** 用户在浏览器打开这个 URL 完成授权。 */
    authorizeUrl: string;
    /** 过期时刻（Unix 秒）。 */
    expiresAt: number;
    /** 官方建议的轮询间隔（秒）。 */
    pollIntervalSec: number;
    /** 发起这次流程用的 CLI 会话密钥（官方用它做 Bearer）。 */
    flowSecret: string;
}
/** ③ 在 `status: "ready"` 时返回的东西。 */
export interface ZcodeLoginResult {
    /** zcode JWT —— 免费额度通道的 `Authorization: Bearer`。 */
    zcodeJwt: string;
    /** 大模型 access token（bigmodel 侧；`zai` 登录时为 `undefined`）。 */
    bigmodelAccessToken?: string;
    /** 大模型 access token（zai 侧；`bigmodel` 登录时为 `undefined`）。 */
    zaiAccessToken?: string;
    /** 大模型 refresh token（若服务端给）。 */
    bigmodelRefreshToken?: string;
    /** 用户 id。 */
    userId: string;
    /** 展示名（用户名 / 邮箱 / id）。 */
    displayName: string;
}
/** 一次登录尝试的失败原因（人类可读）。 */
export declare class ZcodeLoginError extends Error {
    readonly kind: 'init' | 'poll' | 'timeout' | 'denied' | 'cancelled';
    constructor(message: string, kind: 'init' | 'poll' | 'timeout' | 'denied' | 'cancelled');
}
/** 生成 CLI 会话密钥（官方 `UH(32).toString("hex")` = 32 字节 hex）。 */
export declare function generateFlowSecret(): string;
/**
 * ★ 生成一个**自用**的设备标识。
 *
 * ## 为什么可以自己生成（实测依据）
 *
 * `X-Device-Mid` 是 `billing/*` 与推理端点的**硬需求**（缺它回
 * `400 {"code":3001,"msg":"parameter error"}`），但它的**值本身**并不被
 * 绑定校验 —— 实测同一 JWT 换任意随机 UUID 都返回 200：
 *
 * ```
 * 官方 mid      → 200
 * 随机 mid #1   → 200
 * 随机 mid #1 重试 → 200
 * 随机 mid #2   → 200（间隔后重测；首次的 429 是限流）
 * 全新随机 mid  → 200
 * 无 mid        → 400 code 3001   ← 证明它确实必需
 * ```
 *
 * ⇒ 插件可以自己生成并持久化一个稳定的 UUID，**不再依赖官方客户端的
 * `telemetry-state.json`** —— 这是「脱离 IDE」的关键一步。
 *
 * ⚠ 生成后**必须持久化**：同一账号换 mid 会让服务端的用量归集看起来
 * 像换了一台设备（虽然不报错，但不自然）。故存进凭据本体，
 * 登录一次就固定下来。
 */
export declare function generateDeviceMid(): string;
/** 发起登录：拿到 `authorize_url`。 */
export declare function startZcodeLogin(fetchImpl?: typeof fetch, options?: {
    provider?: ZcodeLoginProvider;
    appVersion?: string;
}): Promise<ZcodeLoginFlow>;
/** ③ 的单次轮询结果。 */
export type ZcodePollOutcome = {
    kind: 'pending';
} | {
    kind: 'ready';
    result: ZcodeLoginResult;
} | {
    kind: 'failed';
    message: string;
};
/** 轮询一次。 */
export declare function pollZcodeLogin(flow: Pick<ZcodeLoginFlow, 'flowId' | 'flowSecret'>, fetchImpl?: typeof fetch, appVersion?: string): Promise<ZcodePollOutcome>;
/**
 * 一次性完成「发起 → 轮询到 ready」。
 *
 * ⚠ `onAuthorizeUrl` 必须在**返回 URL 后立刻**调用（前端据此弹窗），
 * 因为 `window.open` 只在用户手势窗口内有效。
 *
 * @param options.timeoutMs 总超时（默认 5 分钟，与官方 `zH` 一致）
 * @param options.signal    外部取消（用户在 Jet Hub 点「取消」）
 */
export declare function runZcodeLogin(options?: {
    fetchImpl?: typeof fetch;
    appVersion?: string;
    /** 登录 provider（默认 `bigmodel`；`zai` 走 chat.z.ai 国际版）。 */
    provider?: ZcodeLoginProvider;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** 拿到授权 URL 时立刻回调（前端弹窗用）。 */
    onAuthorizeUrl?: (url: string) => void;
    /** 轮询间隔覆盖（测试用）。 */
    pollIntervalMs?: number;
}): Promise<ZcodeLoginResult>;
//# sourceMappingURL=zcode-login.d.ts.map