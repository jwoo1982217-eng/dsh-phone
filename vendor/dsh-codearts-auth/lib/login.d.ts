import { createServer } from 'node:http';
import type { CodeArtsCredential, CodeArtsCredentialResponse, LoginFlowOptions, LoginFlowResult } from './types.js';
import type { DpopKeyPair, PkcePair } from './oauth.js';
export declare const CODEARTS_LOGIN_BASE = "https://devcloud.cn-north-4.huaweicloud.com/doer/redirect";
export declare const HUAWEI_AUTH_BASE = "https://auth.huaweicloud.com/authui/login.html";
export declare const CREDENTIAL_ENDPOINT = "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket";
/** 与重定向流程共享的随机 64 字符小写十六进制密钥。 */
export declare function generateRandomSecret(): string;
/** 构建 doer/redirect URL 及包裹它的华为认证页面 URL。 */
export declare function buildLoginUrl(port: number, ticketId: string): {
    redirectUrl: string;
    loginUrl: string;
};
/** 将一次 ticket 响应归一化为凭据，未完成时返回 null。 */
export declare function parseCredentialResponse(data: CodeArtsCredentialResponse): CodeArtsCredential | null;
/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export declare function expiresFromCredential(credential: CodeArtsCredential): number;
/**
 * 轮询 ticket 端点，直到收到完整凭据或尝试
 * 次数耗尽。瞬时失败会被跳过，不会视为致命错误。
 */
export declare function pollForCredential(ticketId: string, secret: string, options?: {
    fetcher?: typeof fetch;
    maxAttempts?: number;
    pluginName?: string;
    pluginVersion?: string;
}): Promise<CodeArtsCredential>;
/**
 * 使用平台默认打开器打开 URL；永不抛出异常。
 *
 * ⚠️ **「永不抛出」必须靠 `'error'` 监听器兑现**（真实缺陷，2026-10-03）。
 *
 * `spawn` 的失败（`ENOENT` / `EACCES`）是以**异步 `'error'` 事件**上报的，
 * 外层 `try/catch` **接不住**它。而 `ChildProcess` 是 EventEmitter ——
 * `'error'` 没有监听器时会被 `throw` 成**未捕获异常**。
 *
 * POSIX 上这很容易踩：无桌面环境的 `open`（macOS）/ `xdg-open`（Linux）
 * 常常不存在 ⇒ `ENOENT` ⇒ **直接把宿主进程带走**。
 * （Windows 的 `cmd` 恒存在，所以只在 POSIX 上暴露 —— 典型的「本地测不出来」。）
 *
 * ⚠️ 用 `child.unref()` + 监听器，不能只 `unref` 就完事：前者让父进程
 * 不因它挂起，后者补上缺失的监听器，二者缺一不可。
 */
export declare function openBrowser(url: string): void;
/**
 * 从 Windows 注册表取默认浏览器的可执行文件路径与参数模板。
 *
 * ## 为什么需要它（而不是直接用 `openBrowser`）
 *
 * `cmd /c start` 只能把 URL 交给系统默认打开器，**无法附加 `--incognito`**；
 * 而 `window.open` 在客户端也无法请求无痕模式（该标志是进程级启动参数、
 * 不是 JS 能控制的窗口特性）。
 *
 * 故要走无痕只能在宿主侧**直接拉起浏览器可执行文件**，而它的路径只有注册表
 * 这个真相源（用户装的可能是 Chrome / Edge / 360 / Firefox，路径各不相同，
 * 不能硬编码）。读 `UrlAssociations\https\UserChoice` 拿 ProgId，再读该
 * ProgId 的 `shell\open\command`。
 *
 * @returns 可执行文件路径；读不到时 `undefined`（调用方回退到 `openBrowser`）。
 */
export declare function defaultBrowserExecutable(): string | undefined;
/**
 * 构造**无痕窗口**的浏览器命令行参数 —— 抽成**纯函数**以便确定性地单测
 * （Gitee issue IKM741 修法）。
 *
 * ⚠️ 抽出来的理由与 `officeacePendingTtlMs` 同源：`openIncognitoWindow` **会真的
 * `spawn` 浏览器**，故它本身在单测里被 `NODE_ENV === 'test'` 断路器挡住 ⇒
 * 「参数到底传对了没有」这一格**在单测里不可达**。把参数构造抽成纯函数后，
 * 这一格可以在零副作用下被逐项断言（本仓库既有范式：`raccoonDefaultEffort`）。
 *
 * @param exe - 浏览器可执行文件（只看是否 Firefox 决定分支）。
 * @param url - 授权页 URL。
 * @param profileDir - **本次专用的**独立 profile 目录（须每次不同）。
 */
export declare function incognitoWindowArgs(exe: string, url: string, profileDir: string): string[];
/**
 * 用**无痕窗口**打开 URL（华为云 OAuth 换账号登录用）。
 *
 * ## 为什么必须无痕（实测依据，2026-10-13）
 *
 * 华为 `authui` 会**静默复用**浏览器已有的登录会话：带着已登录 cookie 打开
 * 授权页会直接放行，**看不到登录框**，于是「新建账号」永远只能建出同一个号。
 * 实测三条：
 *
 * | 试验 | 结果 |
 * |---|---|
 * | `authui/login.html?service=<authorize>` | 200 直接返回页面（复用会话）|
 * | authorize 追加 `&prompt=login` | **仍 200，无重定向** ⇒ authui 忽略该参数 |
 * | `authui/logout?service=<authorize>` | 302 先清会话再跳 authorize |
 *
 * ⇒ 只有两条路：先 logout，或换一个 cookie jar。**选后者**：
 * `logout` 的作用域是整个 `auth.huaweicloud.com` 域（实测 `Set-Cookie` 含
 * `cloud_verify_ticket` 清除与 `IAMIdentity` 重写），会**连带登出用户日常浏览器
 * 里的华为云控制台**；无痕窗口则是全新 cookie jar，天然无会话，
 * **既不碰用户既有会话、也不需要 logout**。
 *
 * ⚠️ 官方客户端（果办）也没有解决这点：它的 `LoginPage` 用
 * `window.open(url, 'officeclaw-login', 'popup,…')` 开共享 cookie 的小窗，
 * 「重新登录」则走 `authui/logout`（`LoginCallbackPage`）。即官方同样无法
 * 换账号登录 —— 别把它当参考实现。
 *
 * @returns 是否成功以无痕方式拉起（`false` 时调用方应回退到普通打开）。
 */
export declare function openIncognitoWindow(url: string): boolean;
/** 浏览器重定向的本地回调服务器；当某个分支完成时 resolve `result`。 */
export declare function startCallbackServer(ticketId: string, secret: string, options: LoginFlowOptions): Promise<{
    port: number;
    server: ReturnType<typeof createServer>;
    result: Promise<LoginFlowResult>;
}>;
/** 运行完整的浏览器登录流程，返回已存储的凭据值。 */
export declare function runLoginFlow(options?: LoginFlowOptions): Promise<LoginFlowResult>;
/** 新式 IAM OAuth 的 portal 授权端点（对齐真实插件的 getPortalHost + /authorize）。 */
export declare const PORTAL_AUTHORIZE_BASE = "https://codearts.huaweicloud.com/portal/authorize";
/** portal 登录结果页（登录完成后重定向目标，对齐真实插件回调处理器的 login_succeed 页）。 */
export declare const PORTAL_LOGIN_BASE = "https://codearts.huaweicloud.com/portal/login";
/** 构建 portal 登录结果页 URL（真实插件在回调成功后 307 重定向到此页）。 */
export declare function buildPortalLoginResultUrl(succeeded: boolean): string;
/** portal 期望的插件名（逆向常量，硬编码）。 */
export declare const LOGIN_PLUGIN_NAME = "snap_AIIDE";
/** portal 期望的插件版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export declare const LOGIN_PLUGIN_VERSION = "5.2.0";
/** 主题色 kind（对齐 IDE 的 activeColorTheme.kind：2 = Dark）。 */
export declare const OAUTH_THEME = "2";
/** 界面语言（对齐 env.language）。 */
export declare const OAUTH_LOCALE = "zh-cn";
/** 构建新式 IAM OAuth 的 portal 授权 URL（参数完全对齐真实插件 buildLoginUrl）。 */
export declare function buildOAuthLoginUrl(port: number, pkce: PkcePair, ticketId: string): string;
/** 新式 OAuth 的本地回调服务器：收到 code（新流程）或 secret（旧流程回退）后换取凭据并 resolve。 */
export declare function startOAuthCallbackServer(ticketId: string, pkce: PkcePair, keyPair: DpopKeyPair, options: LoginFlowOptions): Promise<{
    port: number;
    server: ReturnType<typeof createServer>;
    result: Promise<LoginFlowResult>;
}>;
/**
 * 已启动但尚未完成的 OAuth 登录流程。
 *
 * 拆出这一层是为了支持**两步式登录**（Jet Hub 的「+ 新建账号」）：
 * 调用方先拿到 `loginUrl` 立刻打开窗口，再自行 await `result`。
 *
 * 为什么必须拆：浏览器只在用户点击后的短暂窗口（transient activation，
 * 约 5 秒）内允许 `window.open`。若把「起服务器 → 打开浏览器 → 等用户授权」
 * 整个流程做成一次阻塞调用，调用方拿到 URL 时手势早已过期，`window.open`
 * 会被弹窗拦截器拒绝。
 */
export interface StartedOAuthFlow {
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 用户完成授权（或超时/失败）后落定的结果。 */
    result: Promise<LoginFlowResult>;
    /** 关闭回调服务器；**幂等**，可重复调用。 */
    close: () => Promise<void>;
}
/**
 * 启动 OAuth 登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export declare function startOAuthFlow(options?: LoginFlowOptions): Promise<StartedOAuthFlow>;
/**
 * 运行完整的新式 IAM OAuth 登录流程（默认登录方式）。
 *
 * 阻塞语义：打开浏览器并等待用户完成授权后才返回。
 * 需要「立即拿到 URL」的场景（Jet Hub 两步式登录）请用 {@link startOAuthFlow}。
 */
export declare function runOAuthFlow(options?: LoginFlowOptions): Promise<LoginFlowResult>;
//# sourceMappingURL=login.d.ts.map