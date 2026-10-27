/**
 * OpenCode Zen 产品配置与错误分类。
 *
 * ## 数据来源（设计文档 §0）
 *
 * 1. 端点 / 免费模型清单：官方 docs https://opencode.ai/docs/zen/ （2026-10-01 采集）
 * 2. 错误类型名：opencode 官方源码 `packages/opencode/src/session/retry.ts`
 *    （`FreeUsageLimitError` / `GoUsageLimitError` + `retry-after` 头）
 *
 * ## ⚠️ 为什么按「错误类型名」而不是「状态码」分类
 *
 * 本仓库 qoder 曾因「用错误码的默认归类代替业务语义判断」把确定性的额度耗尽
 * 当成可重试的 SERVER 而白重试 5 次；minimax 也曾把 402 归 AUTH 让用户
 * 看不到「去充值」这个唯一有效动作。Zen 的额度错误可能带 400/401/403/429
 * 任一状态码，唯一稳定的信号是**响应体里的错误类型名**。
 *
 * ## ⚠️ 身份结论（本 provider 设计的基石）
 *
 * opencode CLI 发往 Zen 的请求**没有任何机器级指纹**（1.18.22 源码逐行核对：
 * 无 machine-id / deviceId / 安装 ID / 遥测）。身份只有三个维度：
 * **出口 IP、API key（账号）、随机会话 id**。
 * ⇒ 「换一台 PC」在协议层等价于「换一个 key 或换一个出口 IP」，
 * 指纹派生的作用是**防关联**与满足形状门禁，不是换配额桶。
 */
// `retry-after` 的解析已收敛到 `src/retry-after.ts`（原先本文件与
// `opencode-adapter.ts` 各有一份几乎逐字相同的私有实现）。
import { retryAfterMsFromRecord } from './retry-after.js';
export const OPENCODE = {
    id: 'opencode',
    // ⚠️ 必须与客户端 `PROVIDERS` 里的 label 逐字一致（rail 宽度算式依赖它，
    // 且 `opencode-client-panel.spec.ts` 有跨文件一致性断言）。
    displayName: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen',
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    // 免费模型的快通道（旧 /zen 的匿名档被 TLS 指纹门禁锁死，见 opencode-inference.ts）。
    inferenceBaseUrl: 'https://opencode.ai/inference',
    inferenceChatPath: '/v1/chat/completions',
    inferenceUserAgent: 'opencode/latest/2.0.29/cli',
    // ⚠️ 与本仓库其余 provider 的流式超时常量同档（保守值）。
    chatHeaderTimeoutMs: 60_000,
    chatChunkTimeoutMs: 120_000,
    // ⚠️ 匿名凭证是**字面量** `public`：opencode 官方 CLI 在没有 key 时自己就用它
    // （其 provider.ts 的 opencode 分支：`options: ok ? {} : { apiKey: 'public' }`）。
    anonymousKey: 'public',
    // ⚠️ 兜底 UA。1.19.0 起官方 UA 是**复合串**（真机抓包 2026-10-15）：
    //   opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
    // 接线层会用真机 `opencode --version` 的版本号重建前段；后两段随 CLI 构建
    // 而变，CLI 升级后以重新抓包为准（openai-compatible 模型元数据里不带这些）。
    defaultUserAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    userAgentSuffix: 'ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    /**
     * 模型能力元数据源（**远端**，能力的主来源）。
     *
     * ⚠️ 不是 `/zen/v1/models` —— 实测它只返回 `id`/`object`/`created`/
     * `owned_by` 四个字段，**不含任何能力信息**（85 条全如此）。
     * 能力在 **models.dev** 的 `opencode` 条目里，官方 CLI 自己就用它
     * （`packages/core/src/models-dev.ts`）。见 `opencode-capability.ts`。
     */
    modelsDevUrl: 'https://models.dev/api.json',
    /** 能力表缓存 TTL（与官方 CLI 的 60 分钟同档）。 */
    modelsDevTtlMs: 60 * 60 * 1000,
};
export const OPENCODE_MODELS_DEV_URL = OPENCODE.modelsDevUrl;
export const OPENCODE_MODELS_DEV_TTL_MS = OPENCODE.modelsDevTtlMs;
/**
 * 兜底模型表（**以真机实测为准**，2026-10-01）。
 *
 * ⚠️ 每条都对应 `docs/superpowers/specs/2026-10-02-opencode-zen-endpoint-matrix.md`
 * 里一次成功的真实请求。`isFree` 的含义是「**匿名通道**（`Bearer public`）
 * 能否使用」，不是官方定价表的 Free 标记 —— 这是本插件唯一关心的维度。
 *
 * ⚠️ `ling-3.0-flash-fin-free` **已移除**：官方 docs 说它走 `/v1/messages`
 * （Anthropic），而该端点当前对匿名与付费 key 都返回 500（与 body 形态无关），
 * chat 端点则是 404 路由不存在 ⇒ 它在两条通道上都不可用，留在目录里只会
 * 让用户点到一个必然失败的模型。
 */
export const OPENCODE_FALLBACK_MODELS = [
    // ── 匿名可用（chat 端点，无需 key）──
    { id: 'big-pickle', name: 'Big Pickle', isFree: true, contextWindow: 262144 },
    { id: 'space-bunny-free', name: 'Space Bunny Free', isFree: true, contextWindow: 262144 },
    { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview Free', isFree: true, contextWindow: 262144 },
    { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', isFree: true, contextWindow: 262144 },
    { id: 'mimo-v2.5-free', name: 'MiMo-V2.5 Free', isFree: true, contextWindow: 262144 },
    // ⚠️ 这两个官方 docs 标注走 `/v1/models/{id}`（Gemini 风格），但**实测
    // chat 端点也通** ⇒ 按 chat 处理。**以实测为准，不以 docs 为准。**
    { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', isFree: true, contextWindow: 262144 },
    { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', isFree: true, contextWindow: 262144 },
    // ── 需付费 key（chat 端点；实测匿名为 401）──
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', isFree: false, contextWindow: 262144 },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', isFree: false, contextWindow: 262144 },
    { id: 'glm-5.2', name: 'GLM 5.2', isFree: false, contextWindow: 262144 },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', isFree: false, contextWindow: 262144 },
    { id: 'minimax-m2.7', name: 'minimax M2.7', isFree: false, contextWindow: 262144 },
    { id: 'minimax-m3', name: 'minimax M3', isFree: false, contextWindow: 262144 },
    { id: 'qwen3.8-max', name: 'Qwen3.8 Max', isFree: false, contextWindow: 262144 },
];
const FREE_IDS = new Set(OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id));
const REACHABLE_IDS = new Set(OPENCODE_FALLBACK_MODELS.map((m) => m.id));
/**
 * /inference lane 承载的免费模型（2026-10-17 逐个真实回话验证）。
 *
 * 目录（`https://models.opencode.ai/api.json` 的 `opencode.models`）当前
 * 127 个模型、44 个零价；这里只收 **status=active 且实测回话** 的：
 * - `nemotron-3-ultra-free` 实测 200 但正文为空，未收；
 * - `status=deprecated` 的一批不再保证，未收。
 *
 * ⚠️ 与 `OPENCODE_FALLBACK_MODELS` 有重叠（big-pickle / space-bunny 等）——
 * 合并处按 id 去重，不要在这里删重复项：fallback 表还被旧 /zen lane 使用。
 */
export const OPENCODE_INFERENCE_MODELS = [
    // ⚠️ deepseek-v4.1-flash-free：官方目录标 200000。2026-10-17 实测
    // 1,040,101 prompt tokens 仍 200 且头/中/尾三针全对；1,850,000 chars
    // (≈1,069k tokens) 起 400（上游透传空 body）⇒ 上限与 GLM 同网关的
    // 1,048,576 吻合，取 1000000 留余量。
    { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', isFree: true, contextWindow: 1000000 },
    // ⚠️ glm-5.3-flash-free：官方目录标 200000，实测 998,399 prompt tokens
    // 仍 200 且三针全对；1,109,168 tokens 时上游 400 明确回
    // `This model's maximum context length is 1048576 tokens` ⇒ 取 1000000
    // （留 48,576 余量给输出与工具）。
    { id: 'glm-5.3-flash-free', name: 'GLM-5.3-Flash Free', isFree: true, contextWindow: 1000000 },
    { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview Free', isFree: true, contextWindow: 1000000 },
    { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', isFree: true, contextWindow: 200000 },
    { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', isFree: true, contextWindow: 262144 },
    { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', isFree: true, contextWindow: 1048576 },
    { id: 'space-bunny-free', name: 'Space Bunny Free', isFree: true, contextWindow: 1048576 },
    { id: 'beam-free', name: 'Beam Free', isFree: true, contextWindow: 1048576 },
    { id: 'big-pickle', name: 'Big Pickle', isFree: true, contextWindow: 200000 },
];
const INFERENCE_FREE_IDS = new Set(OPENCODE_INFERENCE_MODELS.map((m) => m.id));
/**
 * 该模型是否走 /inference lane。
 *
 * ⚠️ 判据是**这张实测表**，不是 `isFreeOpencodeModel`：fallback 表里还有
 * 两个旧 /zen 时代的免费模型（mimo-v2.5-free / nemotron-3-ultra-free）
 * 没在新通道复测，不能直接甩过去。
 */
export function usesInferenceLane(id) {
    return INFERENCE_FREE_IDS.has(id);
}
/**
 * 把 /inference 免费模型并进目录（按 id 去重，保持原顺序在前）。
 *
 * 只给适配器内部用：`loadOpencodeCatalog` 的对外语义（远端/回退）保持不变，
 * 否则现有单测与「目录来源」诊断都会被打乱。
 */
export function mergeInferenceModels(entries) {
    const seen = new Set(entries.map((e) => e.id));
    const extra = OPENCODE_INFERENCE_MODELS.filter((m) => !seen.has(m.id));
    return extra.length === 0 ? entries : [...entries, ...extra];
}
/**
 * 该模型是否属免费（匿名槽只接受免费模型）。
 *
 * ⚠️ **未知模型返回 false**：远端目录可能含表外的新免费模型，
 * 但在未实测前把它们放给匿名槽只会换来 403/500；宁可要求用户加一个付费账号。
 */
export function isFreeOpencodeModel(id) {
    return FREE_IDS.has(id) || INFERENCE_FREE_IDS.has(id);
}
/**
 * 该模型在我们**已实现并实测可达**的通道里是否存在。
 *
 * ## 为什么远端目录必须过这道闸（真实报障 2026-10-01）
 *
 * `GET /v1/models` 返回全部 84 个模型，且**不含任何协议信息**
 * （字段只有 id/object/created/owned_by）。若直接把它们交给 DSH，
 * 用户会在选择器里看到 `ling-3.0-flash-fin-free`、`claude-*`、
 * `gpt-*` 等模型 —— 点下去只会拿到 404/401/500。
 *
 * ⇒ 目录**只暴露本表内的模型**；表外的新模型要等实测确认端点后再加进来。
 * （表本身也来自实测：见 `2026-10-02-opencode-zen-endpoint-matrix.md`。）
 */
export function isReachableOpencodeModel(id) {
    return REACHABLE_IDS.has(id);
}
/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
function readableDetail(body) {
    const text = body.trim();
    if (text === '')
        return '（上游未返回错误详情）';
    try {
        const data = JSON.parse(text);
        const nested = typeof data.error === 'object' && data.error !== null
            ? data.error.message
            : data.error;
        const parts = [data.message, nested, data.msg]
            .filter((v) => typeof v === 'string' && v.length > 0);
        if (parts.length > 0)
            return parts.join(' ');
    }
    catch {
        // 非 JSON：直接截断原文
    }
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
/**
 * 把一次失败的 HTTP 响应归类为语义化的错误。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyOpencodeError(status, body, headers) {
    const retryAfterMs = retryAfterMsFromRecord(headers);
    const detail = readableDetail(body);
    const lower = body.toLowerCase();
    // ⚠️ **顺序即优先级**：限流语义必须在 auth 之前判 —— 上游的额度错误
    // 经常带 401/403 状态码，若先判状态码会把「额度用尽」误报成「key 失效」，
    // 用户的唯一有效动作（等窗口恢复 / 切下一个账号）会被完全掩盖。
    if (body.includes('FreeUsageLimitError')) {
        return { kind: 'free_usage_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (body.includes('GoUsageLimitError')) {
        return { kind: 'go_usage_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (body.includes('FreeTierError')) {
        // 传输指纹门禁（2026-10-15 起）：免费模型只认官方 OpenCode 客户端的
        // TLS/HTTP 指纹，非官方栈（Node/curl/python/普通 Bun 反代）连完全复刻
        // 的头序都过不了。**不重试也不换槽**（每槽同一套栈，换槽重试无意义），
        // 如实透传让用户走唯一有效动作：绑定付费 key（Zen sk / Console）。
        return { kind: 'free_tier', detail };
    }
    if (status === 429 || lower.includes('too many requests') || lower.includes('rate limit')) {
        return { kind: 'rate_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail };
    }
    if (status === 0 || lower.includes('fetch failed') || lower.includes('terminated')
        || lower.includes('econnreset') || lower.includes('socket hang up')
        || lower.includes('getaddrinfo') || lower.includes('econnrefused')) {
        return { kind: 'transport', detail };
    }
    // ⚠️⚠️ **402 必须单独归类**（真实报障 2026-10-01）：
    // 实测付费 key 余额耗尽时上游回 `402
    // {"error":{"type":"server_error","message":"...Insufficient account funds"}}`。
    // 若落进下面的 `status >= 500` 之外、又被 `httpErrorCode` 归成 `SERVER`，
    // 用户看到的是「服务端故障，请重试」—— 而重试永远不会成功（要充值）。
    // 必须映射到 QUOTA_EXCEEDED，UI 才能给出「去充值」这个唯一有效动作。
    if (status === 402 || lower.includes('insufficient account funds')
        || lower.includes('insufficient funds') || lower.includes('insufficient balance')) {
        return { kind: 'quota', detail };
    }
    if (status === 401 || status === 403)
        return { kind: 'auth', detail };
    if (status >= 500)
        return { kind: 'server', detail };
    return { kind: 'auth', detail };
}
//# sourceMappingURL=opencode-inference-product.js.map