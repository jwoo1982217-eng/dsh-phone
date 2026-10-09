/**
 * 腾讯 CodeBuddy 认证网络流程（external-link-v2 轮询式）
 *
 * 对齐 IDE genie 扩展的 NativeAuthBridgeService，流程为
 * fetchAuthState → 打开浏览器 → 轮询 token → 轮询 account，
 * 另有 refreshToken 静默续期与 fetchModels 远端模型拉取。
 *
 * 所有网络调用都接受注入的 fetcher，便于测试与复用；浏览器打开器同理。
 */
import type { BuddyAccount, BuddyCredential, BuddyRemoteModel, BuddyToken } from './buddy.js';
import { type BuddyProduct } from './product.js';
/** 在浏览器中打开登录 URL；永不抛出（失败时打印 URL 供手动打开）。 */
export type OpenBrowser = (url: string) => void;
/** 一次登录流程的结果。 */
export interface BuddyLoginFlowResult {
    /** 已序列化的 BuddyCredential JSON。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
}
/** runBuddyLoginFlow 接受的选项。 */
export interface BuddyLoginFlowOptions {
    /** 使用的 fetch 实现；默认为全局 fetch。 */
    fetcher?: typeof fetch;
    /** 在浏览器中打开登录 URL；默认使用平台打开器。 */
    openBrowser?: OpenBrowser;
    /** 轮询总超时（毫秒）；默认为 5 分钟。 */
    timeoutMs?: number;
    /** 轮询间隔（毫秒）；默认为 1 秒。 */
    pollIntervalMs?: number;
    /** 已有的 auth state（跳过 fetchAuthState，直接使用此 state 轮询 token）。 */
    state?: string;
    /** 产品配置；默认为 CodeBuddy。 */
    product?: BuddyProduct;
}
/**
 * POST /v2/plugin/auth/state?platform=<product.platform> → 获取 state + authUrl
 * （无需认证）。platform 与 User-Agent 随产品配置变化，默认 CodeBuddy。
 */
export declare function fetchAuthState(fetcher?: typeof fetch, signal?: AbortSignal, product?: BuddyProduct): Promise<{
    state: string;
    authUrl: string;
}>;
/**
 * GET /v2/plugin/auth/token?state=... 轮询获取 token。
 *
 * 错误码 11217 = token 尚未就绪 → 继续轮询；网络错误同样继续轮询，
 * 不中断登录流程（对齐 Rust loop_get_token）。
 *
 * `options.product` 决定 User-Agent（默认 CodeBuddy）；调用方（登录流程）
 * 必须传入，否则 WorkBuddy 会携带 CodeBuddy 的身份标识。
 */
export declare function loopGetToken(state: string, options?: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    /** 产品配置；默认为 CodeBuddy。 */
    product?: BuddyProduct;
}): Promise<BuddyToken>;
/**
 * GET /v2/plugin/login/account?state=... 轮询获取账户信息（需 Bearer token）。
 *
 * 错误码 12151 = 账户信息尚未完成 → 继续轮询。
 *
 * `options.product` 决定 User-Agent（默认 CodeBuddy）。
 */
export declare function getAccount(state: string, token: BuddyToken, options?: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    /** 产品配置；默认为 CodeBuddy。 */
    product?: BuddyProduct;
}): Promise<BuddyAccount>;
/**
 * POST /v2/plugin/auth/token/refresh 静默续期。
 *
 * 通过 X-Refresh-Token 头提交 refresh_token；成功时返回新令牌数据。
 * refresh_token 被后端判定失效（401/403 或 message 含 expired/invalid）时抛
 * {@link RefreshTokenExpiredError}，调用方据此停止续期并提示重新登录。
 *
 * `product` 放在参数列表**末尾**（默认 CodeBuddy），既让 WorkBuddy 携带
 * 自己的 User-Agent，又不破坏既有的位置参数调用点。
 */
export declare function refreshToken(credential: BuddyCredential, fetcher?: typeof fetch, signal?: AbortSignal, product?: BuddyProduct): Promise<BuddyToken>;
/** refresh_token 已失效/被拒绝时抛出的错误；调度器据此停止续期。 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/**
 * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
 *
 * 失败时返回空数组（调用方回退到内置列表）。
 *
 * `product` 放在参数列表**末尾**（默认 CodeBuddy）：它决定 X-Product-Code
 * 与 User-Agent 两个身份标识。**必须**由调用方传入，否则 WorkBuddy 会发出
 * `X-Product-Code: codebuddy` 的请求。
 */
export declare function fetchModels(credential: BuddyCredential, fetcher?: typeof fetch, signal?: AbortSignal, product?: BuddyProduct): Promise<BuddyRemoteModel[]>;
/** 企业模型端点的 scope 段：个人账号用字面量 `personal`。 */
export declare const ENTERPRISE_MODELS_SCOPE = "personal";
/**
 * 按产品配置装饰登录 URL。
 *
 * WorkBuddy（appendSessionParams 为 true）需要额外携带 `version` 与
 * `loginSessionId`：前者为产品版本号，后者为客户端生成的 UUID，仅用于
 * 服务端日志追踪（实测无校验语义，故每次登录生成新值均可）。
 * 其余产品原样返回。
 *
 * 注意：只追加参数，不得重建 URL —— platform/state/路径全部来自服务端
 * auth/state 下发的 authUrl。
 */
export declare function decorateLoginUrl(authUrl: string, product: BuddyProduct): string;
/**
 * 完整登录流程：fetchAuthState → 打开浏览器 → 轮询 token → 轮询 account。
 *
 * 当 options.state 已提供时，跳过 fetchAuthState（用于 RPC 场景：
 * 由调用方先获取 state+authUrl 返回给客户端弹窗，后台用同一 state 轮询）。
 *
 * 返回序列化后的凭据 JSON；持久化由调用方（BuddyAuth 服务）负责，
 * 与 CodeArts 的 runOAuthFlow 保持一致的分层。
 */
export declare function runBuddyLoginFlow(options?: BuddyLoginFlowOptions): Promise<BuddyLoginFlowResult>;
//# sourceMappingURL=buddy-oauth.d.ts.map