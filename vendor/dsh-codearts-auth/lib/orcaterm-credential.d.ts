/**
 * OrcaTerm 凭据来源：账号池优先，回退浏览器 cookie 采集与 token 文件。
 *
 * ## 为什么需要三层
 *
 * 三条路径对应三种真实使用场景，缺一条就有用户走不通：
 *
 * 1. **账号池**（正常路径）—— 用户在 Jet Hub 面板点「登录」，扫码后凭据落进
 *    `ctx.credentials`，账号进 `accountPool`。这条路径支持多账号、过期提示、
 *    面板展示，是主路径。
 * 2. **浏览器 cookie 采集**（免手输）—— 面板的登录窗口本身就是 DSH 内置浏览器
 *    的可见标签页，登录后 `uin`/`skey` 就在同一个 cookie jar 里。直接从 jar 读出来，
 *    用户不需要复制粘贴任何东西。
 * 3. **token 文件**（离线/脚本场景）—— `~/.dsh/orcaterm_token.txt`，内容可以是
 *    `uin=…; skey=…` 或 `ot_session` JWT。CI、无图形会话、或用户手上有现成凭据时用。
 *
 * ## 采集器的边界
 *
 * 内置浏览器是 Chromium，cookie 用 `Chrome Safe Storage` 钥匙串密码加密
 * （**实测确认**：用 `Chromium Safe Storage` 会解出看似合理但错误的明文，
 * 比报错更危险）。`v10` 值布局是 `v10 || 32 字节常量头 || 密文` —— 那 32 字节
 * 在**明文**里，解完整段再丢弃前 32 字节，砍密文是错的。
 *
 * 解出不可打印的内容一律丢弃：错误的 key 不会产出可打印明文，这条闸门防止把
 * 垃圾当会话交出去。
 *
 * @module orcaterm-credential
 */
import type { OrcaTermCredential } from './orcaterm-adapter.js';
/** DSH_HOME 下的默认 cookie 库位置。 */
export declare function defaultCookieDb(dshHome?: string): string;
/** token 文件路径。 */
export declare function tokenFilePath(dshHome?: string): string;
/** Chromium 的 PBKDF2 参数（2013 起 saltysalt / 1003 轮 / 16 字节）。 */
export declare function deriveKey(password: string): Buffer;
/**
 * 解密一个 Chromium cookie 值。
 *
 * 顺序很重要：先用空格 IV 解整段（去掉 `v10` 前缀），**再**丢弃前 32 字节明文。
 */
export declare function decryptChromiumValue(blob: Buffer, key: Buffer): string;
/**
 * 从 DSH 内置浏览器的 cookie 库采集 OrcaTerm 会话。
 *
 * @returns 网页形态凭据；库缺失、无登录、或解不出可打印值时返回 null
 */
export declare function harvestBrowserSession(cookieDb?: string): Extract<OrcaTermCredential, {
    kind: 'web';
}> | null;
/** 解析 token 文件内容为凭据；认 `uin/skey` 串、JSON、裸 JWT。 */
export declare function parseCredentialText(text: string): OrcaTermCredential | null;
/**
 * 按优先级解析一个可用凭据。
 *
 * @param options.poolCredential 账号池给出的凭据（最高优先级）
 * @param options.cookieDb 自定义 cookie 库路径
 * @param options.tokenFile 自定义 token 文件路径
 */
export declare function resolveOrcaTermCredential(options?: {
    poolCredential?: OrcaTermCredential | undefined;
    cookieDb?: string;
    tokenFile?: string;
}): OrcaTermCredential | null;
//# sourceMappingURL=orcaterm-credential.d.ts.map