/**
 * opencode 专用 RPC 的**方法处理函数**（不是自注册端点）。
 *
 * ## ⚠️⚠️ 为什么是「被主 switch 调用」而不是「自己注册」（真实事故 2026-10-02）
 *
 * 我最初在这里调 `rpc.register('jet-hub', handler)`，以为可以与
 * `jet-hub-rpc.ts` 并存。真机报障：
 *
 *     添加失败：unknown method: opencode.addAnonymous
 *
 * 根因：**Jet Hub 只有一条通道** —— `jet-hub-rpc.ts` 的
 * `connection.fetch.register({ path: JET_HUB_API_PATH })`，它把 `call.method`
 * 交给一个穷举 `switch`，`default` 分支直接回 `unknown method` 且**不让路**。
 * 仓库里 `rpc.register` 只有我这一处用到（其它 11 个 provider 全部走主 switch），
 * 所以我那条注册路径从来就没被接过请求。
 *
 * ⇒ 现在本文件只导出 {@link handleOpencodeRpc}，由 `jet-hub-rpc.ts` 的
 * `handleMethod` 在 `default` **之前**调用。文件边界的好处（评审 diff 可控）
 * 保留了，错误的注册方式去掉了。
 *
 * ## 与既有 RPC 的关系
 *
 * 账号的增删改、拖拽排序、限流标记**全部复用** `account.*` 族；
 * 这里只加 opencode 特有的五件事。其中「添加账号」是本插件第一家
 * **不跳浏览器**的登录方式（手动粘贴 API key）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ProviderAccountEntry } from './types.js';
export interface RpcOpencodeAddAccountRequest {
    apiKey: string;
    nickname?: string;
}
export interface RpcOpencodeAddAccountResponse {
    accountId: string;
    /** true = 该 key 之前已添加过，本次只是复用。 */
    existed: boolean;
}
export interface RpcOpencodeProxyRequest {
    accountId: string;
    proxy: string;
}
export interface RpcOpencodeProxyResponse {
    proxy: string;
    label: string;
}
export interface RpcOpencodeTestProxyRequest {
    proxy: string;
}
export interface RpcOpencodeTestProxyResponse {
    exitIp: string;
    country: string;
    latencyMs: number;
}
export interface RpcOpencodeRotateRequest {
    accountId: string;
}
export interface RpcOpencodeRotateResponse {
    generation: number;
    projectId: string;
}
/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface OpencodePoolLike {
    listAccountsByProvider(provider: string): Array<{
        id: string;
        enabled: boolean;
        credentialRef: string;
    }>;
    addAccount(entry: ProviderAccountEntry): Promise<void>;
    updateAccount(id: string, patch: Partial<ProviderAccountEntry>): Promise<void>;
    setOpencodeProxy(accountId: string, proxy: string): Promise<void>;
    updateOpencodeFingerprintGeneration(accountId: string, generation: number): Promise<void>;
    opencodeFingerprintGenerationFor(accountId: string): number;
}
/**
 * 处理一个 opencode RPC 方法。
 *
 * @param method 来自主 `handleMethod` 的方法名。
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（这样它自己的 `default`
 *          分支仍能给出 `unknown method`，语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若本函数对未知方法也回信封，别的 provider 的
 * 方法名就会被误判成「格式错误」而不是「没这个方法」。
 */
export declare function handleOpencodeRpc(ctx: Context, pool: OpencodePoolLike, method: string, payload: unknown): Promise<unknown>;
//# sourceMappingURL=opencode-rpc.d.ts.map