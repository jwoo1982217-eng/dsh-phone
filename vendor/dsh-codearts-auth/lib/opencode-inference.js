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
import { randomBytes } from 'node:crypto';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 闸门要求的核心工具名（缺任一都会被 403）。 */
export const INFERENCE_CORE_TOOLS = ['shell', 'edit', 'glob', 'grep', 'read'];
/** 官方 CLI 2.x 工具定义（原样，勿改）。 */
const GENUINE_TOOLS = JSON.parse("{\"shell\":{\"description\":\"Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.\",\"parameters\":{\"additionalProperties\":false,\"properties\":{\"background\":{\"description\":\"Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.\",\"type\":\"boolean\"},\"command\":{\"description\":\"Shell command string to execute\",\"type\":\"string\"},\"timeout\":{\"description\":\"Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.\",\"minimum\":0,\"type\":\"integer\"},\"workdir\":{\"description\":\"Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.\",\"type\":\"string\"}},\"required\":[\"command\"],\"type\":\"object\"}},\"edit\":{\"description\":\"Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\\\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\\\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.\",\"parameters\":{\"additionalProperties\":false,\"properties\":{\"newString\":{\"description\":\"Text to replace oldString with (must differ from oldString)\",\"type\":\"string\"},\"oldString\":{\"description\":\"Exact text to find and replace\",\"type\":\"string\"},\"path\":{\"description\":\"File to edit\",\"type\":\"string\"},\"replaceAll\":{\"description\":\"Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.\",\"type\":\"boolean\"}},\"required\":[\"path\",\"oldString\",\"newString\"],\"type\":\"object\"}},\"glob\":{\"description\":\"Search file paths using a glob pattern (examples: \\\"**/*.ts\\\", \\\"src/**/*.tsx\\\").\",\"parameters\":{\"additionalProperties\":false,\"properties\":{\"hidden\":{\"description\":\"Include hidden files and directories (default: false).\",\"type\":\"boolean\"},\"limit\":{\"description\":\"Maximum number of matching files to return (default: 100)\",\"exclusiveMinimum\":0,\"type\":\"integer\"},\"path\":{\"description\":\"Directory to search. Defaults to the current working directory.\",\"type\":\"string\"},\"pattern\":{\"description\":\"Glob pattern to match files against\",\"type\":\"string\"}},\"required\":[\"pattern\"],\"type\":\"object\"}},\"grep\":{\"description\":\"Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.\",\"parameters\":{\"additionalProperties\":false,\"properties\":{\"caseSensitive\":{\"description\":\"Use case-sensitive matching (default: true).\",\"type\":\"boolean\"},\"include\":{\"description\":\"Glob pattern to filter files (for example, \\\"*.js\\\" or \\\"*.{ts,tsx}\\\")\",\"type\":\"string\"},\"limit\":{\"description\":\"Maximum number of matching lines to return (default: 100)\",\"exclusiveMinimum\":0,\"type\":\"integer\"},\"literal\":{\"description\":\"Treat `pattern` as exact text instead of a regular expression (default: false).\",\"type\":\"boolean\"},\"path\":{\"description\":\"File or directory to search. Defaults to the current working directory.\",\"type\":\"string\"},\"pattern\":{\"description\":\"Regular expression or literal text to match in file contents.\",\"minLength\":1,\"type\":\"string\"}},\"required\":[\"pattern\"],\"type\":\"object\"}},\"read\":{\"description\":\"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.\",\"parameters\":{\"additionalProperties\":false,\"properties\":{\"limit\":{\"description\":\"The maximum number of lines or directory entries to read (defaults to and capped at 2000)\",\"minimum\":0,\"type\":\"integer\"},\"offset\":{\"description\":\"The line or directory entry to start reading from (1-based)\",\"minimum\":0,\"type\":\"integer\"},\"path\":{\"description\":\"File or directory to read\",\"type\":\"string\"}},\"required\":[\"path\"],\"type\":\"object\"}}}");
/** 取官方定义（未知工具名返回 undefined）。 */
export function genuineTool(name) {
    return Object.prototype.hasOwnProperty.call(GENUINE_TOOLS, name)
        ? GENUINE_TOOLS[name]
        : undefined;
}
function randomBase62(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++)
        out += BASE62[bytes[i] % BASE62.length];
    return out;
}
/**
 * 派生 /inference 会话 id：`ses_` + 12 位降序时间 + 14 位 base62。
 *
 * 与旧 `deriveSessionId()` 的区别只有时间段的编码方向：官方 CLI 2.x 用
 * `Identifier.descending()`（48 位取反，低 12 位 = 0xFFF - counter），
 * /inference 闸门按 `^[0-9a-f]{9}f[c-f][0-9a-f]` 校验这一段；旧写法是
 * 升序小端时间，形状对不上。
 */
export function deriveInferenceSessionId(now = Date.now()) {
    const ts = BigInt(Math.max(0, Math.trunc(now))) & 0xffffffffffffn;
    const current = ((ts >> 12n) << 12n) | 1n; // 36 位时间戳 + counter=1
    const inverted = (~current) & 0xffffffffffffn;
    const timePart = inverted.toString(16).padStart(12, '0');
    return `ses_${timePart}${randomBase62(14)}`;
}
/**
 * /inference 的请求头（**不含** `x-opencode-request`）。
 *
 * project id 复用旧指纹（40 位 hex），形状与 2.x CLI 一致；会话用
 * {@link deriveInferenceSessionId} 的降序编码。
 */
export function inferenceHeaders(fingerprint, sessionId, userAgent) {
    return {
        'x-opencode-project': fingerprint.projectId,
        'x-opencode-session': sessionId,
        'x-opencode-session-id': sessionId,
        'x-session-affinity': sessionId,
        'X-Session-Id': sessionId,
        'x-opencode-client': 'cli',
        'user-agent': userAgent,
    };
}
function toolNameOf(tool) {
    if (typeof tool !== 'object' || tool === null)
        return undefined;
    const fn = tool.function;
    return typeof fn?.name === 'string' ? fn.name : undefined;
}
/**
 * 把 body 归一成 /inference 闸门接受的样子（幂等；无 `messages` 时原样返回）。
 *
 * 1. `stream` 强制 true；
 * 2. `stream_options.include_usage` = true（下游统计需要）；
 * 3. 认识的工具名（shell/edit/glob/grep/read）**替换为官方定义**；
 * 4. 缺失的核心工具按官方定义补齐；
 * 5. 其它客户端工具原样保留（闸门不认识的名字不校验，允许存在）。
 */
export function prepareInferencePayload(payload) {
    if (!Array.isArray(payload.messages))
        return payload;
    const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
    const present = new Set();
    for (let i = 0; i < tools.length; i++) {
        const name = toolNameOf(tools[i]);
        if (name === undefined)
            continue;
        present.add(name);
        const genuine = genuineTool(name);
        if (genuine !== undefined) {
            tools[i] = {
                type: 'function',
                function: { name, description: genuine.description, parameters: genuine.parameters },
            };
        }
    }
    for (const name of INFERENCE_CORE_TOOLS) {
        if (present.has(name))
            continue;
        const genuine = genuineTool(name);
        if (genuine === undefined)
            continue;
        tools.push({
            type: 'function',
            function: { name, description: genuine.description, parameters: genuine.parameters },
        });
    }
    const streamOptions = typeof payload.stream_options === 'object' && payload.stream_options !== null
        ? { ...payload.stream_options }
        : {};
    return {
        ...payload,
        stream: true,
        stream_options: { ...streamOptions, include_usage: true },
        tools,
    };
}
//# sourceMappingURL=opencode-inference.js.map