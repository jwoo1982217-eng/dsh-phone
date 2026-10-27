/**
 * OpenCode V2 凭据、会话标识与代理地址归一。
 * session 不仅校验外形，还校验 descending 时间算法；V2 请求头与旧 CLI 不同。
 * project 仍按账号/匿名条目与代次派生 40hex，不改变账号池的指纹隔离语义。
 */
/** 一份可持久化的指纹。 */
export interface OpencodeFingerprint {
    /** 40 位小写 hex，与真实 CLI project id 同形。 */
    projectId: string;
    /** 轮换代次；+1 后 project id 整体变化。 */
    generation: number;
}
/** 账号凭据（存 `ctx.credentials`，不进 settings 明文）。 */
export interface OpencodeCredential {
    /** Zen API key（`sk-…`），身份本体；匿名槽用字面量 `public`。 */
    api_key: string;
    nickname?: string;
    /** 首次添加时生成；旧账号缺失时由 `newAccountFingerprint` 补。 */
    fingerprint?: OpencodeFingerprint;
    /** 代理 URL；空/缺省 = 直连（与其它无代理账号共享本机出口）。 */
    proxy?: string;
}
/**
 * 派生 project id。
 *
 * @param identity  账号标识（接线层传 API key；匿名槽传固定串 `'anonymous'`）。
 * @param generation 轮换代次。
 *
 * 刻意**不**把 key 全文直接进哈希链的明文位置：identity 先过 SHA-256，
 * 再以 `git-remote:` 前缀走 SHA-1 —— 既复用真实 CLI 的派生外形，
 * 又使明文 key 片段不出现在任何可从 project id 反推的中间量。
 */
export declare function deriveProjectId(identity: string, generation: number): string;
/**
 * ses_ + 12hex + 14base62；时间段为 ~(timestamp * 0x1000 + counter) 的低 48 位。
 * 使用 counter=1，随机段区分同毫秒生成的 ID；调用方缓存复用。
 * 旧实现把裸时间戳按小端写入，即使外形正确仍被上游算法校验拒绝。
 */
export declare function deriveSessionId(timestamp?: number): string;
/** 派生 request id（每请求一个，官方形态 `msg_` 前缀改 `req_`）。 */
export declare function deriveRequestId(): string;
/**
 * V2 UA 外形为 `opencode/<channel>/<version>/<client>`。
 *
 * ⚠️ 实测（2026-10-15，逐变量对照 2×2×2，每格 2 次）：UA **不参与**聊天门禁 ——
 * `user-agent: opencode/1.18.22`（本机 1.x CLI 的真实值）在其余两项正确时照样
 * HTTP 200。故这里把 2.x 覆盖成 `latest/<v>/cli`、把 1.x 回落成默认 V2 串，
 * 只是**外形一致**，不是过门禁的必要条件；别再把它写成「不换就 403」。
 * （真正必需的是 `x-opencode-session-id` 与降序 session 算法。）
 */
export declare function opencodeUserAgent(override?: string): string;
/** 构造发往 V2（`/inference`）的完整指纹头集。 */
export declare function opencodeHeaders(fingerprint: OpencodeFingerprint, sessionId: string, _requestId: string, userAgent: string): Record<string, string>;
export type OpencodeProxyKind = 'http' | 'socks5';
export interface NormalizedProxy {
    kind: OpencodeProxyKind;
    /** 可直接交给 dispatcher 的完整 URL。 */
    url: string;
    /** 展示用（脱敏，密码以 *** 代替）。 */
    label: string;
}
/**
 * 归一用户输入的代理地址。
 *
 * 接受三类（设计文档 §3）：本地代理客户端端口（裸 `host:port`）、HTTP(S)、SOCKS5。
 * 空串表示「清除代理」，返回 `ok: false` 让调用方走清理分支。
 */
export declare function normalizeProxy(input: string): {
    ok: true;
    proxy: NormalizedProxy;
} | {
    ok: false;
    reason: string;
};
//# sourceMappingURL=opencode.d.ts.map