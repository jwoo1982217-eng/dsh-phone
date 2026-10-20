/**
 * OpenCode /inference lane（2026-10-17 起启用）—— 免费模型的新匿名通道。
 *
 * ## 为什么有这条 lane（旧 /zen 匿名通道已死）
 *
 * 2026-10-15 起 Zen 免费模型对非官方 CLI 的 **TLS/HTTP 栈**做指纹门禁，
 * `Bearer public` 直发一律 403 FreeTierError（见 `opencode.ts` 顶部注释与
 * `opencode-adapter.ts` 的 free_tier 分支）。但上游同时提供了一条新的
 * OpenAI 兼容入口 `https://opencode.ai/inference`：
 *
 * - 它**不校验 TLS 指纹**（Node fetch / python / curl 均可，2026-10-17 实测）；
 * - 它校验的是**请求形态**：CLI 2.x 的头集 + 降序 session id + 官方工具定义；
 * - 免费模型（cost=0）用 `Bearer public` 即可调用，按出口 IP 记账。
 *
 * 配方与开源网关 `jasonxu114514/opencode2api` 的
 * `internal/gateway/upstream.go` + `internal/identity/request.go` 同源，
 * 并与本仓库 APK 侧 `OpenCodeClient`（multiweb）逐条对齐：
 *
 * | 要素 | 值 |
 * | --- | --- |
 * | endpoint | `POST https://opencode.ai/inference/v1/chat/completions` |
 * | UA | `opencode/latest/2.0.29/cli` |
 * | 会话头 | `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `X-Session-Id` 四头同值 |
 * | 会话编码 | `ses_` + 12 位**降序**时间（低 12 位 0xFC0~0xFFF）+ 14 位 base62 |
 * | 工程头 | 裸 40 位小写 hex；`prj_` 前缀会 403 |
 * | 禁止头 | 旧版 `x-opencode-request`（见到即 403） |
 * | body | 必须 `stream: true`，并带官方 shell/edit/glob/grep/read 定义 |
 *
 * ## 工具定义为什么是「原样内嵌」
 *
 * `/inference` 闸门对**它认识的**每个工具名逐字节比对 description 与
 * parameters schema；精简/伪造定义（旧 /zen 时代的 bash/read 桩）会 403。
 * 定义取自 opencode2api 的 `internal/gateway/opencode_tools.json`
 * （从官方 CLI 2.x 抓取）。**不要为了省字节改写它们。**
 */
import type { OpencodeFingerprint } from './opencode.js';
/** 闸门要求的核心工具名（缺任一都会被 403）。 */
export declare const INFERENCE_CORE_TOOLS: readonly ["shell", "edit", "glob", "grep", "read"];
export interface GenuineTool {
    description: string;
    parameters: Record<string, unknown>;
}
/** 取官方定义（未知工具名返回 undefined）。 */
export declare function genuineTool(name: string): GenuineTool | undefined;
/**
 * 派生 /inference 会话 id：`ses_` + 12 位降序时间 + 14 位 base62。
 *
 * 与旧 `deriveSessionId()` 的区别只有时间段的编码方向：官方 CLI 2.x 用
 * `Identifier.descending()`（48 位取反，低 12 位 = 0xFFF - counter），
 * /inference 闸门按 `^[0-9a-f]{9}f[c-f][0-9a-f]` 校验这一段；旧写法是
 * 升序小端时间，形状对不上。
 */
export declare function deriveInferenceSessionId(now?: number): string;
/**
 * /inference 的请求头（**不含** `x-opencode-request`）。
 *
 * project id 复用旧指纹（40 位 hex），形状与 2.x CLI 一致；会话用
 * {@link deriveInferenceSessionId} 的降序编码。
 */
export declare function inferenceHeaders(fingerprint: OpencodeFingerprint, sessionId: string, userAgent: string): Record<string, string>;
/**
 * 把 body 归一成 /inference 闸门接受的样子（幂等；无 `messages` 时原样返回）。
 *
 * 1. `stream` 强制 true；
 * 2. `stream_options.include_usage` = true（下游统计需要）；
 * 3. 认识的工具名（shell/edit/glob/grep/read）**替换为官方定义**；
 * 4. 缺失的核心工具按官方定义补齐；
 * 5. 其它客户端工具原样保留（闸门不认识的名字不校验，允许存在）。
 */
export declare function prepareInferencePayload(payload: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=opencode-inference.d.ts.map