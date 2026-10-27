import { type AccioRegion } from './accio-product.js';
import { type AccioCredential } from './accio.js';
/** PKCE 对。 */
export interface AccioPkcePair {
    verifier: string;
    challenge: string;
}
/**
 * 生成 PKCE 对。
 *
 * ⚠️ `code_verifier` 是 **48 随机字节**的 base64url（官方客户端 `new Uint8Array(48)`），
 * `challenge` 是 `base64url(SHA-256(verifier))`，方法恒 **S256**。
 */
export declare function createAccioPkcePair(): AccioPkcePair;
/** 生成 `state`（32 随机字节 hex，与官方一致）。 */
export declare function createAccioState(): string;
/**
 * 拼授权 URL。
 *
 * ⚠️ **参数缺一不可**：少了 `code_challenge` 会被登录页判为 legacy 客户端
 * 而弹「请升级客户端」（见文件头）。`ttid` / `language` 是 IDE 同款参数集。
 */
export declare function buildAccioAuthUrl(options: {
    region: AccioRegion;
    redirectUri: string;
    state: string;
    codeChallenge: string;
}): string;
/**
 * 用系统默认浏览器打开 URL。
 *
 * ⚠️⚠️ **绝不能用 `cmd /c start`**（`&` 会被当命令分隔符截断 URL）——
 * 见文件头的完整事故说明。`rundll32` 不经过 shell，参数原样传递。
 *
 * ⚠️ 永不抛出：`execFile` 的失败是**异步 `'error'` 事件**，
 * 而**第三个参数的回调就是它的消费者** —— 传了回调，Node 会代为挂上 `'error'`
 * 监听器（实测 `listenerCount('error') === 1`，ENOENT 落进回调、进程存活）。
 * ⇒ **那个 `() => {}` 不是装饰，删掉它就会变成未捕获异常并打挂宿主**。
 * 打开失败不影响流程：调用方会把 URL 显示给用户手动打开。
 */
export declare function openBrowser(url: string): void;
/** 兑换 / 续期的归一化结果（`expires_at` **已 ×1000**）。 */
export interface AccioTokenResult {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    sgcookie?: string;
}
/**
 * 用授权码兑换 token。
 *
 * ⚠️ `clientId` 必须是**公开客户端** `accio-work`；**没有** `client_secret`。
 *
 * ⚠️ `region` **刻意不参与**本函数的 URL 构造：gateway 两个区域**同一个**
 * （见 `ACCIO.gatewayBaseUrl`），只有**登录页**分区域。它保留在签名里是为了
 * 让调用方的语义完整，**不要**据此改 URL。
 */
export declare function exchangeAccioCode(options: {
    region: AccioRegion;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    fetcher?: typeof fetch;
}): Promise<AccioTokenResult>;
/**
 * 续期。
 *
 * ⚠️⚠️ **参考实现明确记录「刷新会轮换 refresh_token」**（本仓库尚未实测该端点，
 * 见 `docs/agent-notes/providers-accio.md` §10 U-A）。
 * ⇒ 三条入口（定时器 / 推理按需 / 面板按钮）**必须串行**，
 * 否则必然「1 成功、其余 `invalid_grant`」，而失败方会把**好账号标死**。
 * 串行由 `accio-auth.ts` 的 `SerialQueue` 保证，**不在这里**。
 */
export declare function refreshAccioCredential(options: {
    credential: AccioCredential;
    fetcher?: typeof fetch;
}): Promise<AccioTokenResult>;
//# sourceMappingURL=accio-oauth.d.ts.map