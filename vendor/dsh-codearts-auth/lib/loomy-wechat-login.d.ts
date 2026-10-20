/**
 * Loomy 微信扫码登录流程（本地服务器承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方客户端用 Electron `BrowserWindow` 的 `will-redirect` 截获微信 code，
 * 而那个回调页（`loomy.xunfei.cn/oauth/wechat/callback`）实测 **404**。
 * 本插件没有 `will-redirect`，故**不用回调页收 code** —— 改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET /wechat/qr       → 弹窗页：内联二维码（data URL）+ 前端轮询 + 绑定手机号表单
 *   GET /wechat/poll     → 前端轮询：长轮询微信，返回状态（待扫码/已扫码/已确认）
 *   POST /wechat/complete→ 提交微信 code（或手机号+验证码）完成登录
 * ```
 *
 * 微信 `code` 由**长轮询**（`loomy-wechat.ts`）直接拿到，完全绕开那个 404 回调页。
 *
 * ## 与其余 provider 的契约一致性
 *
 * 对外仍返回 `loginUrl`（指向本地 `/wechat/qr`），前端照常 `window.open` ——
 * 与 codearts / lobsterai / qoder / trae / cline 的「两步式」体验完全一致。
 *
 * ## ⚠️ redirect_uri 必须是官方地址
 *
 * 微信校验域名白名单（实测换本地地址会得到「redirect_uri 参数错误」），
 * 故 `buildLoomyWechatAuthUrl` 里写死官方地址 —— 它只用于**取 uuid**，
 * 不参与回调（我们从长轮询拿 code）。
 */
import type { LoomyProduct } from './loomy-product.js';
import { type LoomyLoginResult } from './loomy-oauth.js';
/**
 * 按平台决定「用哪个命令打开 URL」。
 *
 * ⚠️ **本模块不使用它，也不应该使用** —— Loomy 走**两步式**：返回
 * `loginUrl` 由**前端** `window.open` 打开（与 codearts / lobsterai /
 * qoder / trae / cline 一致）。宿主侧主动开浏览器会**破坏两步式的意义**
 * （`window.open` 只在用户手势窗口内有效，等流程跑完再开必被拦截）。
 *
 * 保留这个纯函数是为了让「平台分派」有**可离线单测**的落点 ——
 * 早期这里有个会真的 spawn 浏览器的 `defaultOpenBrowser`，单测一调它
 * 就弹出 `http://127.0.0.1:1/never`（真实缺陷，用户报障）。
 * 现在只测这个纯函数，**永不 spawn**。
 */
export declare function resolveOpenCommand(platform: string): {
    command: string;
    args: string[];
};
/** 整个扫码 + 绑定的超时（毫秒）。 */
export declare const LOOMY_WECHAT_LOGIN_TIMEOUT_MS: number;
/** 本地弹窗页的路径。 */
export declare const LOOMY_WECHAT_QR_PATH = "/wechat/qr";
/** 前端轮询端点。 */
export declare const LOOMY_WECHAT_POLL_PATH = "/wechat/poll";
/** 提交端点（微信 code 或手机号验证码）。 */
export declare const LOOMY_WECHAT_COMPLETE_PATH = "/wechat/complete";
/** 微信登录流程的选项。 */
export interface LoomyWechatLoginOptions {
    product: LoomyProduct;
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 超时（毫秒）。 */
    timeoutMs?: number;
}
/** `startLoomyWechatLoginFlow` 的返回值（与其余 provider 的 `StartedXxxLoginFlow` 同形）。 */
export interface StartedLoomyWechatLoginFlow {
    /** 弹窗地址（本地服务器）。 */
    loginUrl: string;
    /** 登录结果（凭据 + 手机号）。 */
    result: Promise<LoomyLoginResult & {
        phone: string;
        nickname?: string;
    }>;
    /** 主动关闭本地服务器。 */
    close: () => Promise<void>;
}
/**
 * 启动微信扫码登录流程。
 *
 * 立即返回 `loginUrl`（本地弹窗页）与 `result` promise，**不阻塞** ——
 * 与其余 provider 的「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export declare function startLoomyWechatLoginFlow(options: LoomyWechatLoginOptions): Promise<StartedLoomyWechatLoginFlow>;
//# sourceMappingURL=loomy-wechat-login.d.ts.map