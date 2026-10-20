/**
 * TRAE 登录流程：AuthCode 换 Token + 用户信息查询。
 *
 * 与 LobsterAI 同样采用**本地回调**方式——TRAR 强制回调 `127.0.0.1`，
 * 浏览器与服务器无需同机（回调链接可粘贴到浏览器所在机器执行授权）。
 *
 * ## 回调端口策略
 *
 * TRAE 登录页 `https://www.trae.cn/authorization` 强制回调
 * `http://127.0.0.1:18080/authorize`（端口固定 18080，对齐 Go 端默认）。
 *
 * ## 两步式模式
 *
 * 与 `lobsterai-oauth.ts` 的 `startLobsteraiLoginFlow` 同款模式：
 * - `startTraeLoginFlow`：起回调服务器并立即返回 `loginUrl`，由调用方先打开窗口；
 * - `runTraeLoginFlow`：阻塞式，等待回调完成后再返回（供 CLI / E2E 使用）。
 * - `exchangeTraeCallback`：纯函数，用回调解出的凭证直接换凭据（供两步式回调服务器使用）。
 */
import { type TraeCredential } from './trae.js';
import type { TraeProduct } from './trae-product.js';
/**
 * 登录流程选项。
 */
export interface TraeLoginFlowOptions {
    /** 可选的 fetch 实现（测试用）。 */
    fetcher?: typeof fetch;
    /** 自定义回调端口（默认 18080）。 */
    callbackPort?: number;
}
/** 登录流程的结果。 */
export interface TraeLoginFlowResult {
    /** 可持久化的凭据 JSON 字符串。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 打开的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
}
/**
 * 由 machineId + deviceId 派生稳定的 `login_trace_id`（hex16）。
 *
 * 对齐 Go 端 `machineTraceID`（`callback.go:55-63`）：取拼接串的**尾部 16 字符**。
 * 作用是让回调能被关联回本次登录的 pending（TRAE 回调不保证回传
 * machine_id/device_id，但会回传 login_trace_id）。
 */
export declare function machineTraceId(machineId: string, deviceId: string): string;
/**
 * 构建 TRAE 登录 URL。
 *
 * 对齐 `login.sh:47-72` / Go 端 `BuildLoginURL`（`callback.go:28-51`）的
 * **完整 17 参数集**。
 *
 * ## ⚠️ 为什么参数一个都不能少（真实缺陷）
 *
 * 早期实现只发了 `client_id` / `machine_id` / `device_id` / `callback_url`
 * / `redirect_uri` 五个参数 —— 与真实协议**完全不匹配**：
 *
 * 1. **回调地址的参数名是 `auth_callback_url`**，不是 `callback_url`
 *    （也没有 `redirect_uri`）。名字错了，TRAE 拿不到回调地址，
 *    登录页会**永远停在授权中**，既不跳转也不回传任何东西。
 * 2. `auth_from` / `login_channel` / `auth_type` / `redirect` 决定走哪条
 *    授权通道；缺失时授权流程不会走到本地回传分支。
 * 3. `login_trace_id` 是回调**反查 pending** 的唯一凭据。
 * 4. `x_*` 系列是客户端形态伪装（设备/应用信息），缺席可能被风控拦截。
 *
 * 用户症状即为「网页一直停在认证中的界面」。
 */
export declare function buildTraeLoginURL(product: TraeProduct, machineId: string, deviceId: string, callbackUrl: string): string;
/**
 * TRAE 登录回调解出的原始凭证。
 *
 * 对齐 Go 端 `CallbackInfo`（`callback.go:66-73`）与 `login.sh:153-166`。
 */
export interface TraeCallbackInfo {
    /** 优先取 query.refreshToken；缺失时回退 userJwt.RefreshToken。 */
    refreshToken: string;
    /** 无 refreshToken 时的兜底 access token（userJwt.Token）。 */
    accessToken: string;
    uid: string;
    nickname: string;
    /** ⚠️ 回调里字段名是 **TenantID**（不是 EnterpriseID）。 */
    enterpriseId: string;
    /**
     * **PKCE 新流程**携带的授权码（`code` / `authCodeInfo.code`）。
     *
     * ## 为什么需要它（对齐 `Trae2api-cn/src/main.py:478-484`）
     *
     * TRAE 授权页实际会走**两套并列的流程**：
     *
     * 1. **新流程**（`code_challenge` / PKCE）：回调带 `authCodeInfo` / `code`；
     * 2. **老流程**（`refreshToken`）：回调**直接回传 token**（当前 `auth_type=local`
     *    走的即是这条，见 `buildTraeLoginURL`）。
     *
     * 早期实现只认第 2 条，并把「没有 refreshToken」一律判为**无效回调** ——
     * 一旦上游切到 PKCE 流程，合法回调会被误判为失败，症状与「一直认证中」
     * 一模一样（因为失败路径当时不会落定结果 Promise）。
     *
     * 本字段用于**识别**该形态并给出精确报错，而不是把它错报成
     * 「缺少 refreshToken」。
     */
    authCode?: string;
}
/**
 * `parseTraeCallback` 的详细结果。
 *
 * 除了「解出了什么」，还回答「**为什么没解出来**」—— 回调服务器需要把原因
 * 写进 HTTP 响应与日志，否则用户只看到一句含糊的
 * `missing refreshToken / userJwt.Token`，无法区分「上游换了流程」与「参数名变了」。
 */
export type TraeCallbackParseResult = {
    ok: true;
    info: TraeCallbackInfo;
} | {
    ok: false;
    reason: string;
    authCodeFlow: boolean;
};
/**
 * 修复回调 `userInfo.ScreenName` 的**双重编码乱码**。
 *
 * 对齐 `login.sh:135-150` 的 `fix_mojibake`：TRAE 回调的中文昵称会被错误地
 * 按 latin-1/cp1252 解读一次，实测得到 `Óû§8847309959` 这类乱码。
 * 尝试回转编码；无法修复且**不含任何 CJK 字符**时，回退为「用户+uid末4位」。
 */
export declare function fixNicknameMojibake(raw: string, uid: string): string;
/**
 * 解析 TRAE 登录回调 URL，提取凭证字段。
 *
 * ## ⚠️ 回调**没有** `code` 参数（真实缺陷的根因）
 *
 * 真实回调形如（`login.sh:117` 注释、`callback.go:117`）：
 * ```
 * http://127.0.0.1:18080/authorize?refreshToken=...&userInfo={...}&userJwt={...}
 * ```
 * 即它**直接回传 token**，不是 OAuth 的 `?code=` 授权码交换。
 *
 * 早期实现按 OAuth 惯例去找 `?code=`，于是 `parseAuthCode` **恒返回 undefined**
 * → 回调服务器回 400 "Missing code" → 结果 Promise 永不落定
 * → 前端 `login.poll` 永远拿不到 `done:true` → **网页一直停在认证中**。
 *
 * ## ⚠️ 但「带 code」的回调**不是**无效回调（第二次修正）
 *
 * 上述结论只说明「token 直传」是**当时实测的**流程，并不意味着带 `code` 的
 * 回调可以判为非法。TRAE 授权页并存两套流程（`Trae2api-cn/src/main.py:478-484`）：
 * 新流程走 PKCE（回带 `code` / `authCodeInfo`），老流程直传 `refreshToken`。
 *
 * 因此本函数对两种形态**都返回结果**：
 * - 有 token（refreshToken / userJwt.Token）→ 正常解出；
 * - 只有 `code` / `authCodeInfo` → 也解出，把 code 放进 `authCode`，
 *   由调用方**明确报出「上游走了 PKCE 流程，本实现暂不支持」**，
 *   而不是含糊地说「缺少 refreshToken」。
 *
 * 需要区分失败原因时用 {@link parseTraeCallbackDetailed}。
 */
export declare function parseTraeCallback(rawUrl: string): TraeCallbackInfo | undefined;
/**
 * 解析回调并**带回失败原因**（供回调服务器写出可读文案与日志）。
 *
 * @see parseTraeCallback 了解两套流程的背景
 */
export declare function parseTraeCallbackDetailed(rawUrl: string): TraeCallbackParseResult;
/**
 * 用**回调解出的凭证**换取最终凭据（供回调服务器与 E2E 复用）。
 *
 * 对齐 `login.sh:168-212` 的两条分支：
 * 1. 有 `refreshToken` → `ExchangeToken` 换新 access（并**轮换** refreshToken）；
 * 2. 无 `refreshToken` → 直接用 `userJwt.Token` 兜底，不走 ExchangeToken。
 *
 * 随后调 `GetUserInfo` 补齐 uid / nickname / enterpriseId；**失败不阻塞**
 * （回退用回调 `userInfo` 的值）—— 对齐 `login.sh:197-209` 的容错。
 *
 * 不涉及本地服务器，纯 HTTP 请求。
 *
 * @param callback `parseTraeCallback` 的解出结果
 * @param session 登录时生成的 machineId / deviceId
 * @param product 产品配置
 * @param fetcher fetch 实现
 * @param nowMs 当前时间（测试注入）
 */
export declare function exchangeTraeCallback(callback: TraeCallbackInfo, session: {
    machineId: string;
    deviceId: string;
}, product: TraeProduct, fetcher?: typeof fetch, nowMs?: number): Promise<TraeCredential>;
/**
 * 阻塞式完整登录流程。
 *
 * 起本地回调服务器 → 打开登录 URL → 等待回调 → ExchangeToken + GetUserInfo → 返回凭据。
 */
export declare function runTraeLoginFlow(options: TraeLoginFlowOptions & {
    product: TraeProduct;
}): Promise<TraeLoginFlowResult>;
/**
 * 两步式登录：起回调服务器并立即返回 loginUrl。
 *
 * 调用方拿到 loginUrl 后应 **立即** `window.open`，再 await `result`。
 *
 * 顺序说明：**先监听拿到端口，再构造登录 URL**。因为首选端口被占用时会
 * 回退到系统分配的随机端口，而 `redirect_uri` 必须写实际端口，否则回调
 * 会打到没人监听的地址上（详见 `listenWithFallback` 的注释）。
 */
export declare function startTraeLoginFlow(options: TraeLoginFlowOptions & {
    product: TraeProduct;
}): Promise<{
    loginUrl: string;
    result: Promise<TraeLoginFlowResult>;
    close: () => Promise<void>;
}>;
/**
 * 启本地回调服务器，等待 TRAE 的回调，返回**解析出的凭证**与实际监听端口。
 *
 * `port` 为**首选**端口：被占用时会自动回退到系统分配的随机端口，
 * 因此调用方**必须**使用返回的 `port`（而非传入值）来构造 `auth_callback_url`。
 *
 * @param port 首选监听端口（默认 18080）
 * @param _consoleHost TRAE 登录门户域名（保留参数，当前未使用）
 * @param timeoutMs 超时毫秒
 */
export declare function startCallbackServer(port?: number, _consoleHost?: string, timeoutMs?: number): Promise<{
    callback: TraeCallbackInfo;
    port: number;
}>;
//# sourceMappingURL=trae-oauth.d.ts.map