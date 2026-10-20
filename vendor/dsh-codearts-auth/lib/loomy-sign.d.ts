/**
 * 讯飞账号（CAccount）HMAC-SHA1 签名。
 *
 * 逐字节复刻 Loomy 客户端 `electron/xfyun/sign.js`。任何偏差都会让账号端点
 * 返回鉴权失败，故本模块**全部是纯函数**，由单测锁死拼串格式。
 *
 * ## 签名字符串（9 段，`\n` 连接）
 *
 * ```
 * {METHOD}\n{ESCAPED_PATH}\n{ESCAPED_QUERY}\n{Content-MD5}\n
 * {Content-Type}\n{Date}\n{Nonce}\n{SignedHeaders}\n{CanonicalizedHeaders}
 * ```
 *
 * ⚠️ 后两段在本项目**恒为空串**（我们不发任何 `x-*` 头），
 * 故最终字符串**以两个换行结尾**。这是 `join('\n')` 在 9 个元素上的自然结果，
 * 不要「顺手」去掉尾随换行 —— 去掉会让签名不匹配。
 *
 * ⚠️ 认证头前缀是 **`account`**（`account {ak}:{sig}`），不是 `Bearer`。
 */
/** 签名所需参数。 */
export interface LoomySignOptions {
    accessKeyId: string;
    accessKeySecret: string;
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    /** **已序列化**的请求体字符串（与发送时用的必须是同一个）。 */
    body?: string;
    contentType?: string;
}
/**
 * 计算 `Content-MD5`（base64）。
 *
 * ⚠️ 空 body 返回**空串**而不是空串的 md5 —— 与客户端 `sign.js:13-18` 一致。
 */
export declare function loomyContentMd5(body: string): string;
/**
 * 构建待签名字符串。
 *
 * `date` / `nonce` 由调用方传入（而非在此生成），使本函数**完全确定**、
 * 可用固定值单测。
 */
export declare function buildLoomySigningString(options: LoomySignOptions & {
    date: string;
    nonce: string;
}): string;
/**
 * 生成完整的讯飞账号请求头。
 *
 * `Date` 用 UTC 字符串、`Nonce` 用 UUID（与客户端 `sign.js:207-208` 一致）。
 *
 * ⚠️ **返回的 body 必须与签名时的 `options.body` 是同一个字符串**：
 * 调用方应先把 body `JSON.stringify` 一次，签名与发送共用该字符串，
 * 否则 axios/fetch 的二次序列化会改变字节（键序、空格），签名随即失效。
 */
export declare function loomyAuthHeaders(options: LoomySignOptions): Record<string, string>;
//# sourceMappingURL=loomy-sign.d.ts.map