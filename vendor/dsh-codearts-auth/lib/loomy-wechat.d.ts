/**
 * Loomy 微信扫码登录：二维码获取与长轮询。
 *
 * ## 为什么不能用官方的 Electron 做法
 *
 * 官方客户端用 `BrowserWindow` 的 `will-redirect` 事件在**导航发生前**截获
 * 微信回调里的 `code`，`event.preventDefault()` 后关窗 —— **从不真的加载
 * 回调页**。那个回调页 `https://loomy.xunfei.cn/oauth/wechat/callback`
 * 实测 **404**（本插件跑在 DSH 宿主进程里，没有 `will-redirect` 能力）。
 *
 * ## 本实现走「纯 HTTP」路线（2026-09-26 实测打通）
 *
 * ```
 * 1. GET open.weixin.qq.com/connect/qrconnect?appid=…&redirect_uri=…&state=…
 *      → HTML 里**内嵌 uuid**（正则直接提取，无需执行 JS）
 * 2. GET open.weixin.qq.com/connect/qrcode/<uuid>
 *      → 二维码图片（实测 **JPEG**，约 47KB，可转 data URL 渲染）
 * 3. GET long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>[&last=<prev>]
 *      → 长轮询状态机（见 LOOMY_WECHAT_POLL_STATUS）
 * ```
 *
 * 于是**完全不需要那个 404 回调页**，也不需要用户手动粘贴 code。
 *
 * ## ⚠️ redirect_uri 必须用官方地址
 *
 * 实测：换成 `http://127.0.0.1:<port>/callback` 或任意域名，微信直接返回
 * **872 字节**的「redirect_uri 参数错误」页；用官方地址才返回 **42KB** 的
 * 正常授权页。微信校验域名白名单，故**不能**用本地回调服务器收 code ——
 * 好在长轮询本来就够用，回调页我们完全不碰（它只是白名单占位）。
 */
/** 微信开放平台「网站应用」AppID（取自客户端 `.env.prod` 的 `LOOMY_WECHAT_APP_ID`）。 */
export declare const LOOMY_WECHAT_APP_ID = "wx18d60be432287cf8";
/**
 * 微信授权回调地址。
 *
 * ⚠️ **必须是这个官方地址**：微信校验 `redirect_uri` 域名白名单，
 * 换成本地地址或任意域名会得到「redirect_uri 参数错误」。
 * 它实际返回 404，但我们的链路**不需要**它真的可达 ——
 * `code` 是从长轮询拿到的。
 */
export declare const LOOMY_WECHAT_REDIRECT_URI = "https://loomy.xunfei.cn/oauth/wechat/callback";
/** 微信扫码长轮询的超时（毫秒）。微信侧约 25 秒无状态变化才返回，故给足余量。 */
export declare const LOOMY_WECHAT_POLL_TIMEOUT_MS = 40000;
/**
 * 长轮询状态。
 *
 * ⚠️ **语义以微信授权页内嵌 JS 为准**（`switch(window.wx_errcode)`）——
 * 那是**官方源码**，不是推测：
 *
 * ```js
 * switch (e) {
 *   case 405:  // 已确认 → 用 wx_code 拼回调 URL 跳转
 *     t += "?…&code=" + wx_code
 *   case 404:  // 已扫码待确认 → 显示 js_wx_after_scan，**继续轮询**
 *   case 403:  // 用户取消
 *   case 402:  // 二维码失效 → 刷新
 *   case 408:  // 待扫码 → 继续轮询
 * }
 * ```
 *
 * **真实缺陷**（用户报障「扫码后显示已扫码，但没有后续跳转」）：
 * 早期把 **404 当成「已确认」、405 当成「已扫码待确认」** —— 恰好**读反了**。
 * 后果：用户确认后微信回 **405**（`wx_code` 就在这一帧），而实现按 404 分支
 * 去等一个「带 code 的 404」，**永远等不到** → 流程卡在「已扫码」，
 * `persistWechatLogin` 永不执行 → 账号池里的凭据始终为空
 * （用户看到「凭据未配置 / 积分查询失败」）。
 */
export declare const LOOMY_WECHAT_POLL_STATUS: Readonly<{
    /** 408：等待扫码（常态）。 */
    readonly waiting: "waiting";
    /** 404：已扫码，等待用户在手机上点确认。**继续轮询**。 */
    readonly scanned: "scanned";
    /** 405：**已确认**，`wx_code` 就在这一帧。 */
    readonly confirmed: "confirmed";
    /** 403：用户取消。 */
    readonly cancelled: "cancelled";
    /** 402：二维码失效，需重新获取 uuid。 */
    readonly expired: "expired";
    /** 网络/解析异常：调用方应继续轮询（瞬时不代表失败）。 */
    readonly error: "error";
}>;
export type LoomyWechatPollStatus = (typeof LOOMY_WECHAT_POLL_STATUS)[keyof typeof LOOMY_WECHAT_POLL_STATUS];
/** 一次长轮询的结果。 */
export interface LoomyWechatPollResult {
    status: LoomyWechatPollStatus;
    /** 仅在 `confirmed` 时非空：微信一次性授权码。 */
    code: string;
    /** 本次响应的 errcode（诊断用）。 */
    errcode: string;
}
/**
 * 拼微信授权页 URL。
 *
 * @param state - 32 位随机串（微信原样回传；本实现不依赖它，但保持与官方一致）。
 */
export declare function buildLoomyWechatAuthUrl(state: string): string;
/**
 * 从授权页 HTML 提取二维码 uuid。
 *
 * 实测页面**直接内嵌** uuid，两条路径互为兜底：
 * - `<img class="js_qrcode_img" src="/connect/qrcode/<uuid>"/>`（主路径）
 * - `var fordevtool = "…/connect/l/qrconnect?uuid=<uuid>"`（兜底）
 *
 * ⚠️ **无需执行 JS** —— 这是本方案能脱离浏览器的基础。
 *
 * @returns 提取不到时返回**空串**（由调用方决定是否抛错）。
 */
export declare function extractLoomyWechatUuid(html: unknown): string;
/** 拼二维码图片地址。 */
export declare function buildLoomyWechatQrImageUrl(uuid: string): string;
/**
 * 拉取授权页并提取 uuid。
 *
 * @throws 页面拉取失败或提取不到 uuid。
 */
export declare function fetchLoomyWechatUuid(state: string, fetcher?: typeof fetch): Promise<string>;
/**
 * 下载二维码图片并转成 data URL。
 *
 * ⚠️ 实测返回 **JPEG**（`image/jpeg`）。早期只判 PNG 魔数会误报
 * 「不是图片」——故这里 PNG / JPEG / GIF 三种都认。
 *
 * @throws 内容不是已知图片格式（避免把 HTML 错误页当二维码渲染）。
 */
export declare function fetchLoomyWechatQrImage(uuid: string, fetcher?: typeof fetch): Promise<string>;
/**
 * 执行一次长轮询。
 *
 * ⚠️ **状态语义以微信授权页内嵌 JS 为准**（`switch(window.wx_errcode)`，
 * 官方源码，见 {@link LOOMY_WECHAT_POLL_STATUS} 的完整引用）：
 *
 * | errcode | 含义 | 本实现返回 |
 * |---|---|---|
 * | 408 | 待扫码（常态；长轮询会挂起直到状态变化） | `waiting` |
 * | 404 | **已扫码待确认**（显示 js_wx_after_scan，继续轮询） | `scanned` |
 * | 405 | **已确认**，`wx_code` 就在这一帧 | `confirmed` |
 * | 403 | 用户取消 | `cancelled` |
 * | 402 | 二维码失效 | `expired` |
 *
 * ⚠️ **真实缺陷**（用户报障「扫码后显示已扫码但没有后续跳转」）：
 * 早期把 **404 当「已确认」、405 当「待确认」**，**恰好读反**。
 * 于是用户确认后（微信回 405 + code）实现仍在等「带 code 的 404」，
 * **永远等不到** → 卡在「已扫码」→ 凭据始终为空。
 *
 * ⚠️ **405 但 `wx_code` 为空时不判成功**：否则会拿空 code 发请求。
 *
 * 网络异常返回 `error` 状态而**不抛错**：长轮询偶发失败不该终止整个流程，
 * 由调用方的循环决定是否重试。
 */
export declare function pollLoomyWechatOnce(uuid: string, lastErrcode: string, fetcher?: typeof fetch): Promise<LoomyWechatPollResult>;
//# sourceMappingURL=loomy-wechat.d.ts.map