/**
 * 每账号代理 → undici Dispatcher。
 *
 * ## 两条实现路线（设计文档 §3）
 *
 * - **HTTP(S)**：undici 的 `ProxyAgent`。⚠️ 必须传
 *   `clientFactory` + `pipelining: 0` —— 默认的 keep-alive 连接池会被
 *   Clash 类代理静默关闭空闲 CONNECT 隧道，导致请求挂死
 *   （opencode2dsh / dsh-llm-proxy 都实测踩过，数据 2/10 → 10/10）。
 * - **SOCKS5**：Node 生态**没有**可用的纯 JS 栈（npm 的 `socks-proxy-agent`
 *   是给 node:http 的 Agent，不是 undici Dispatcher），故自实现最小
 *   CONNECT 隧道：RFC 1928 握手 + RFC 1929 认证 + CONNECT，
 *   **不**自写加密协议栈（设计文档 §8 明确排除）。
 *
 * ## 作用域：仅本 provider
 *
 * 只在 `fetch(url, { dispatcher })` 里逐请求传入，**不动全局 dispatcher**
 * （opencode2dsh 的 R1 教训：两个插件抢全局槽位会互相短路整个路由层）。
 *
 * ## ⚠️ 依赖说明
 *
 * 本模块是**全仓库唯一**新增的 npm 依赖（undici）。原本的设计要求「零新依赖」，
 * 但 per-request 代理的 `ProxyAgent` / 可插 connector 的 `Agent` 都住在 undici
 * 里，而它既不在本仓库依赖中、也无法从 Node 内部路径 require 到
 * （`node:undici` 不存在、`globalThis.ProxyAgent` 未定义、
 * `--use-env-proxy` 是**进程全局**的，给不了「每账号不同出口」）。
 * 用户已确认接受这一处破例。
 */
import type { Dispatcher } from 'undici';
import type { NormalizedProxy } from './opencode.js';
/** 取（或建）该代理地址的 Dispatcher。 */
export declare function buildProxyDispatcher(proxy: NormalizedProxy): Dispatcher;
/** 当前缓存的代理实例数（诊断用）。 */
export declare function proxyCacheSize(): number;
/** 关闭并清空全部缓存实例（插件 dispose 路径）。 */
export declare function closeAllProxyDispatchers(): Promise<void>;
/**
 * SOCKS5 握手的**首帧**（可单测的纯函数）。
 *
 * - 无认证 → `[0x05, 0x01, 0x00]`（VER=5，NMETHODS=1，METHOD=NO AUTH）
 * - 有认证 → `[0x05, 0x02, 0x00, 0x02]`（NMETHODS=2，NO AUTH + USER/PASS）
 *
 * ⚠️ 凭据用 `decodeURIComponent` 解码：用户在 URL 里写 `%40` 表示 `@`。
 */
export declare function buildSocks5Handshake(proxy: Pick<NormalizedProxy, 'url'>): Uint8Array;
//# sourceMappingURL=opencode-proxy.d.ts.map