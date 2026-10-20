/**
 * LobsterAI（有道龙虾）登录：本地回调服务器 + `authCode` 换 token。
 *
 * ## 与 `lobsterai2api` 的实现差异（有意为之）
 *
 * Go 侧是**两个进程 + 一个 `/tmp` 状态文件**：
 * `login.exe url` 起回调服务器后把 `{port,state,uuid,firstKeyfrom}` 落盘到
 * `/tmp/lb2api-login-state.json`，阻塞等待 `.result` 文件出现；
 * `login.exe poll` 再读那个文件取结果（由 `login.sh` 顺序驱动，
 * 中间还夹一个 `read -rp "按 y 继续"` 的人在环确认）。
 *
 * 本模块把这套编排**收进单个进程内的 Promise**：
 * 回调服务器收到 `code` 后**立即在本进程完成 exchange**，
 * 直接 `resolve` 结果。这样就没有跨进程状态文件、没有残留文件误判、
 * 没有 shell 与 python3 依赖 —— 而这三样正是 Go 侧最脆弱的环节
 * （`main.go:162-164` 专门写了清理上一轮残留的代码，就说明它踩过坑）。
 *
 * 骨架取自 `src/login.ts` 的 CodeArts OAuth 回调服务器（本插件已验证的模式），
 * 但没有 PKCE / DPoP —— LobsterAI 的 exchange 不要求它们。
 */
import { type LobsteraiCredential } from './lobsterai.js';
import type { LobsteraiProduct } from './lobsterai-product.js';
/** 在浏览器中打开登录 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>;
/** 一次登录流程的结果。 */
export interface LobsteraiLoginFlowResult {
    /** 已序列化的 `LobsteraiCredential` JSON 字符串（直接存入 ctx.credentials）。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
}
/** `runLobsteraiLoginFlow` 接受的选项。 */
export interface LobsteraiLoginFlowOptions {
    /** 使用的 fetch 实现；默认为全局 fetch。 */
    fetcher?: typeof fetch;
    /** 打开登录 URL 的方式；默认用平台打开器。 */
    openBrowser?: OpenBrowser;
    /** 回调等待总超时（毫秒）；默认 10 分钟。 */
    timeoutMs?: number;
    /** 外部取消信号。 */
    signal?: AbortSignal;
    /** 产品配置；默认 LOBSTERAI。 */
    product?: LobsteraiProduct;
}
/**
 * 登录会话状态。
 *
 * `uuid` / `firstKeyfrom` 由**客户端**生成并贯穿整个账号生命周期：
 * 它们不在服务端响应里，而是要在 exchange 时提交、并在之后**每次续期**时
 * 原样回传（见 `lobsteraiRefreshBody`）。因此必须随凭据持久化。
 */
export interface LobsteraiLoginSession {
    /** 安装 UUID（对齐 `main.go:166` `newUuid()`）。 */
    uuid: string;
    /** 首次登录时间戳（毫秒字符串，对齐 `nowMillis()`）。 */
    firstKeyfrom: string;
}
/** 生成一次性登录会话（uuid + firstKeyfrom）。 */
export declare function createLobsteraiLoginSession(nowMs?: number): LobsteraiLoginSession;
/**
 * 构造 portal 登录 URL。
 *
 * 形态照抄 `main.go:225-228`：
 * `{portal}/portal#/login?source=electron&redirect_uri=...&state=...`
 *
 * 三个 query 参数的语义：
 * - `source=electron` —— 声明登录来源是桌面客户端（portal 据此选择交互流程）；
 * - `redirect_uri` —— **必须**是 `http://127.0.0.1:{port}/auth/callback` 形态，
 *   登录页会校验（`main.go:223-225` 的注释明确记录了这一约束）；
 * - `state` —— 防 CSRF 的一次性随机串，回调时原样带回并比对。
 *
 * ⚠️ 用 `URL` + `searchParams` 而非手工拼字符串：`redirect_uri` 含 `://` 与 `:`
 * 必须被百分号编码，手工拼极易漏编码导致登录页校验失败。
 * 但 hash 段（`#/login`）不能用 `URL.searchParams` 构造 —— 它属于 fragment，
 * 故这里显式拼装：路径 + hash + `?` + 编码后的 query。
 */
export declare function buildLobsteraiLoginUrl(port: number, state: string, product: LobsteraiProduct): string;
/**
 * 用授权码换取凭据。
 *
 * 请求体**必须**含 5 个字段（对齐 `main.go:264-270`）：
 * `authCode` / `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version`。
 * 其中 `uuid` 与 `firstKeyfrom` 来自 {@link LobsteraiLoginSession}，
 * `latestKeyfrom` 取当前时刻，`version` 用动态拉取的真值。
 *
 * 该端点**不需要** `Authorization` 头（换 token 时还没有 token）。
 *
 * @throws 当网络失败、信封 code 非 0、或响应缺 accessToken 时。
 */
export declare function exchangeLobsteraiAuthCode(code: string, session: LobsteraiLoginSession, clientVersion: string, product: LobsteraiProduct, fetcher?: typeof fetch, signal?: AbortSignal): Promise<LobsteraiCredential>;
/**
 * 已启动但尚未完成的登录流程（两步式登录用）。
 *
 * 拆出这一层与 CodeArts 的 `startOAuthFlow` 同因：浏览器只在用户点击后的
 * 短暂窗口（transient activation，约 5 秒）内允许 `window.open`。
 * 若把「起服务器 → 打开浏览器 → 等用户授权」做成一次阻塞调用，
 * 调用方拿到 URL 时手势早已过期，`window.open` 会被拦截。
 */
export interface StartedLobsteraiLoginFlow {
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 用户完成授权（或超时/失败）后落定的结果。 */
    result: Promise<LobsteraiLoginFlowResult>;
    /** 关闭回调服务器；**幂等**，可重复调用。 */
    close: () => Promise<void>;
}
/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export declare function startLobsteraiLoginFlow(options: LobsteraiLoginFlowOptions & {
    product: LobsteraiProduct;
    clientVersion: string;
}): Promise<StartedLobsteraiLoginFlow>;
/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等 `code` → exchange。
 *
 * 单进程内闭环，不落状态文件（见模块头注释）。
 *
 * `timeoutMs` 覆盖「浏览器打开 + 用户操作」整个窗口，超时抛错；
 * 无论成功失败都关闭本地服务器（`finally`）。
 *
 * 阻塞语义：打开浏览器并等用户完成授权后才返回。需要「立即拿到 URL」的
 * 场景（Jet Hub 两步式登录）请用 {@link startLobsteraiLoginFlow}。
 */
export declare function runLobsteraiLoginFlow(options: LobsteraiLoginFlowOptions & {
    product: LobsteraiProduct;
    clientVersion: string;
}): Promise<LobsteraiLoginFlowResult>;
//# sourceMappingURL=lobsterai-oauth.d.ts.map