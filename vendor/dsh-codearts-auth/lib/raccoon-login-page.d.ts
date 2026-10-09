/**
 * Raccoon Work 本地登录页（宿主侧承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方桌面端的登录靠 `office-raccoon://auth/callback` 自定义协议回调，
 * 而本插件是宿主侧 Node 进程，**收不到该回调**；`/code/authorize` 页面的
 * 回调地址又是写死的，改不成 localhost。故改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET  /raccoon/login       → 弹窗页：Tab 切换「微信扫码 / 短信登录」
 *   GET  /raccoon/poll        → 前端轮询登录状态（宿主侧持有 qrcode_code）
 *   POST /raccoon/sms/send    → 提交手机号 + 阿里云 captcha_param
 *   POST /raccoon/sms/verify  → 提交验证码完成登录
 * ```
 *
 * 微信扫码的 `code` 由**宿主侧本地随机生成**（实测服务端接受任意自造 code
 * 并进入 `pending`），完全绕开那个收不到的自定义协议回调。
 *
 * ## 与其余 provider 的契约一致性
 *
 * 对外仍返回 `loginUrl`（指向本地 `/raccoon/login`），前端照常 `window.open`
 * —— 与 codearts / lobsterai / qoder / trae / cline / loomy 的「两步式」
 * 体验完全一致。
 *
 * ## ⚠️ 职责边界（安全约束）
 *
 * - **宿主侧**持有全部敏感状态：`qrcode_code`、手机号、凭据
 * - **页面侧**只做展示与表单提交：**不知道** `phoneCipherSecret`、token 等秘密
 * - 二维码由**宿主侧**生成 SVG 内联进 HTML（页面不需要任何 QR 逻辑，也不需要 CDN）
 * - 手机号加密在宿主侧的 `/raccoon/sms/send` 里完成
 */
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
/** 本地登录页的路径。 */
export declare const RACCOON_LOGIN_PAGE_PATHS: {
    readonly login: "/raccoon/login";
    readonly poll: "/raccoon/poll";
    readonly smsSend: "/raccoon/sms/send";
    readonly smsVerify: "/raccoon/sms/verify";
};
/** 一次登录流程的句柄。 */
export interface StartedRaccoonLoginFlow {
    /** 弹窗地址（本地服务器）。 */
    loginUrl: string;
    /** 登录结果（凭据）。 */
    result: Promise<RaccoonCredential>;
    /** 主动关闭本地服务器。 */
    close: () => Promise<void>;
}
/** `startRaccoonLoginFlow` 的选项。 */
export interface RaccoonLoginFlowOptions {
    product?: RaccoonProduct;
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 超时（毫秒）。 */
    timeoutMs?: number;
}
/**
 * 启动登录流程。
 *
 * 立即返回 `loginUrl` 与 `result` promise，**不阻塞** —— 与其余 provider 的
 * 「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export declare function startRaccoonLoginFlow(options?: RaccoonLoginFlowOptions): Promise<StartedRaccoonLoginFlow>;
/**
 * 渲染登录页 HTML。
 *
 * 导出以便单测断言页面结构（尤其是「不含任何密钥」这条安全约束）。
 *
 * ## 页面职责
 *
 * - 两个 Tab：微信扫码（默认）与短信登录
 * - 二维码由宿主侧生成的 **SVG 内联**进来（页面不需要 QR 逻辑，也不走 CDN）
 * - 每 2 秒轮询 `/raccoon/poll`（与官方客户端一致）
 * - 短信 Tab 加载阿里云滑块脚本，拿到 `captchaParam` 后提交
 *
 * @param qrCode 当前会话的扫码 code（宿主侧生成）。**注意**：本函数只是把它
 *   渲染成二维码 —— 页面拿不到 code 本身（它被编码进二维码图像里）。
 *   这符合职责边界：页面不需要知道 code，只需要展示。
 */
export declare function renderRaccoonLoginPage(product: RaccoonProduct, qrCode?: string): string;
//# sourceMappingURL=raccoon-login-page.d.ts.map