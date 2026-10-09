/**
 * Qoder 设备码登录流程（PKCE + 轮询）。
 *
 * ## 与其它 provider 的差异
 *
 * CodeArts / LobsterAI 都起**本地回调服务器**等浏览器跳回 `127.0.0.1`。
 * Qoder 不是：它的 `redirect_uri` 是自定义协议 `qoder-app://`，
 * 官方 CLI 的做法是「打开授权页 → 轮询 `/api/v1/deviceToken/poll`」。
 * 本模块照搬该模式 —— 不起监听端口，也就没有端口泄漏与回调伪造问题。
 *
 * ## 两步式的必要性
 *
 * 浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内允许
 * `window.open`。若把「生成 URL → 打开 → 等授权」做成一次阻塞调用，
 * 调用方拿到 URL 时手势已过期，弹窗被拦截（返回 null），前端兜底若执行
 * `window.location.href = loginUrl` 会把**整个设置页**导航走（真实缺陷）。
 * 故提供 {@link startQoderLoginFlow} 立即返回 URL，由前端先开窗再等结果。
 *
 * 协议依据：`docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2.3。
 */
import { type QoderDeviceSession, type QoderTokenPayload } from './qoder.js';
import type { QoderProduct } from './qoder-product.js';
/** 在浏览器中打开 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>;
/** 一次登录流程的结果。 */
export interface QoderLoginFlowResult {
    /** 已序列化的 `QoderCredential` JSON 字符串（直接存入 ctx.credentials）。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
    /** 本次登录使用的设备标识（需随凭据持久化）。 */
    machineId: string;
}
/** `startQoderLoginFlow` 接受的选项。 */
export interface QoderLoginFlowOptions {
    /** 使用的 fetch 实现；默认为全局 fetch。 */
    fetcher?: typeof fetch;
    /** 打开登录 URL 的方式；默认用平台打开器。 */
    openBrowser?: OpenBrowser;
    /** 登录等待总超时（毫秒）；默认 5 分钟。 */
    timeoutMs?: number;
    /** 轮询间隔（毫秒）；默认 1000。 */
    pollIntervalMs?: number;
    /** 外部取消信号。 */
    signal?: AbortSignal;
    /** 产品配置。 */
    product: QoderProduct;
}
/**
 * 轮询直到拿到 token。
 *
 * **404 表示「用户尚未完成授权」，必须继续轮询**（源码
 * `if (404 === A.status) { await sleep(...); continue }`）。
 * 实测依据：`openapi.qoder.sh/api/v1/deviceToken/poll` 返回 404
 * `{"errorCode":"NotFound"}`，而任意不存在的路径返回 401
 * —— 说明该端点存在且被网关豁免认证，404 是业务层的「会话未就绪」。
 *
 * 网络失败容忍 {@link QODER_POLL_MAX_FAILURES} 次连续失败；
 * 其它非 2xx（如 5xx）立即抛错 —— 那是服务端异常，不是「等用户」。
 */
export declare function pollQoderDeviceToken(session: QoderDeviceSession, options: QoderLoginFlowOptions): Promise<QoderTokenPayload>;
/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedQoderLoginFlow {
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 用户完成授权（或超时/失败）后落定的结果。 */
    result: Promise<QoderLoginFlowResult>;
    /** 取消登录（中止轮询）；**幂等**。 */
    close: () => Promise<void>;
}
/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * 设备码流程天然是「先拿 URL → 打开 → 后台轮询」，故无需起服务器，
 * 也没有端口可泄漏。`close()` 通过 abort 取消轮询。
 */
export declare function startQoderLoginFlow(options: QoderLoginFlowOptions): Promise<StartedQoderLoginFlow>;
/**
 * 运行完整登录流程：打开授权页 → 轮询 → 返回凭据。
 *
 * 阻塞语义：等用户完成授权后才返回。需要「立即拿到 URL」的场景
 * （Jet Hub 两步式登录）请用 {@link startQoderLoginFlow}。
 */
export declare function runQoderLoginFlow(options: QoderLoginFlowOptions): Promise<QoderLoginFlowResult>;
//# sourceMappingURL=qoder-oauth.d.ts.map