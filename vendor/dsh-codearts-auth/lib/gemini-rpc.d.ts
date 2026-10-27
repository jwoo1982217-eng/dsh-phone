/**
 * Gemini 的**账号出口代理**端点（Gitee issue IKLTZ2）。
 *
 * ## 缺陷背景
 *
 * Gemini 全部端点都在墙外，而 undici（Node 内置 fetch）**既不读** Windows WinINET
 * 系统代理、**也不读** `HTTP(S)_PROXY`（除非额外开 `NODE_USE_ENV_PROXY`）⇒
 * 「浏览器能打开授权页并点同意、面板里账号却一直不出现」。
 *
 * ## 为什么单独成文件（而不是塞进 `jet-hub-rpc.ts` 的 `switch`）
 *
 * ① **前缀分流**：`gemini.*` 需要与 `opencode.*` 一样在主 switch **之前**被试一次
 *    （理由见 `opencode-rpc.ts` 模块头：Jet Hub 只有一条 RPC 通道，主 switch 的
 *    `default` 会把不认识的方法报成 `unknown method`，**不让路**）；
 * ② **形状同构**：setProxy / testProxy 与 opencode 的同名端点**逐字段同构**，
 *    抄两份会漂移（这正是 AGENTS.md 的第一条红线）。
 *
 * ⚠️ 但**实现不复用 opencode 的 `handleOpencodeRpc`**：它绑的是
 * `setOpencodeProxy` / `OPENCODE.id`，而 Gemini 要写 `setGeminiProxy` /
 * `GEMINI.id`（见 `AccountPool` 里两套方法的注释：语义不同，不可合并）。
 * ⇒ 复用的是**判据与措辞**（`normalizeProxy` / `describeFetchError`），
 * 不是那份分派表。
 *
 * ## ⚠️ 为什么「测试代理」打的是 Google 而不是出口 IP 服务
 *
 * opencode 的测试打 `ip-api.com`（能显示出口 IP 与地区，信息量对用户有用）。
 * Gemini 这里的**唯一目的是「能不能连上 Google」** ⇒ 探测目标必须是
 * **Google 自己的端点**。用出口 IP 服务会产生一个**假阳性**：代理能通 ip-api
 * 却仍被 Google 拒（DNS 污染 / 分流规则 / Google 侧封禁），用户点「测试连接」
 * 看到绿色以为配好了，面板依然失败。
 *
 * ⚠️ 选 `oauth2.googleapis.com/token`：它对**任何**请求都会回一个 HTTP 响应
 * （无 body 也有 `invalid_request` 400），所以「拿到 HTTP 状态码」即证明
 * TCP + TLS + 代理握手全通 —— 不需要真凭据。
 */
import type { Context } from '@deepseek-ai/cordis';
export interface RpcGeminiProxyRequest {
    accountId: string;
    proxy: string;
}
export interface RpcGeminiProxyResponse {
    proxy: string;
    label: string;
}
export interface RpcGeminiTestProxyRequest {
    proxy: string;
}
export interface RpcGeminiTestProxyResponse {
    /** 目标端点回的 HTTP 状态码（证明链路通；400 也是「通」）。 */
    status: number;
    latencyMs: number;
}
/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface GeminiPoolLike {
    setGeminiProxy(accountId: string, proxy: string): Promise<void>;
}
/**
 * 处理一个 `gemini.*` RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（同 `opencode-rpc.ts` 的契约：
 *          对未知方法回信封会把别的 provider 的方法名误判成「格式错误」）。
 */
export declare function handleGeminiRpc(_ctx: Context, pool: GeminiPoolLike, method: string, payload: unknown): Promise<unknown>;
//# sourceMappingURL=gemini-rpc.d.ts.map