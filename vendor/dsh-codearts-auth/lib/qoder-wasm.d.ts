/** `generate_runtime_auth_fields` 的产物：服务端用于识别身份的加密字段。 */
export interface QoderRuntimeAuthFields {
    encrypt_user_info: string;
    key: string;
}
/** 构造 WASM 上下文所需的用户信息。 */
export interface QoderWasmUserInfo {
    uid: string;
    securityOauthToken: string;
    organizationId?: string;
    organizationTags?: readonly string[];
    dataPolicyAgreed?: boolean;
}
/** 客户端元数据（写入 `QoderContext`）。 */
export interface QoderClientMetadata {
    client_type: string;
    business_product: string;
    business_type: string;
    scene: string;
}
/** `prepareInferRequest` 的产物。 */
export interface QoderInferRequest {
    url: string;
    headers: Record<string, string>;
    body: string;
}
/**
 * assistant 消息携带的一次工具调用（**OpenAI 风格**）。
 *
 * 形态取自客户端 `t2c()`：它把内部 `tool_use` 块转成
 * `{id, type:'function', index, function:{name, arguments}}` 后挂到
 * 消息的 `tool_calls` 上。
 *
 * ⚠️ **不要**用 Anthropic 风格的 `tool_use` / `input` —— 那是客户端给
 * Anthropic BYOK 走的另一条分支（`input_schema` / `tool_use_id`），
 * 加密端点 `agent_chat_generation` 不吃那套。
 */
export interface QoderInferToolCall {
    id: string;
    type: 'function';
    /** 同一 assistant 消息内多个调用的序号（客户端会给）。 */
    index?: number;
    function: {
        name: string;
        arguments: string;
    };
}
/**
 * 加密推理请求里，单条待发送消息。
 *
 * - `content` 通常是**字符串**（客户端 `udn(r, '')`；工具调用消息的正文是 `''`）。
 * - ⚠️ **带图片的消息 `content` 是多模态数组**（`{type:'image_url',…}`）。
 *   客户端 `eQc()` / `bJc()` 就是这么把它放进 `messages[]` 的 ——
 *   图片**不走** `chat_context.imageUrls`（官方 `Hyc()` 把那个字段恒置 `null`）。
 *   早期实现把 content 压成纯文本，导致图片在下游全部消失（真实缺陷，用户报障）。
 * - `tool_calls` 只出现在 assistant 上。
 * - `tool_call_id` 只出现在 `role: 'tool'` 上（客户端 `A2c()` 的 `tool_result` 分支）。
 *
 * ⚠️ 这三者缺一不可：只发工具结果而不发对应的 assistant `tool_calls`，
 * 会让模型看不到自己调用过什么 —— 表现为反复重调同一工具或凭空编造结果。
 */
export interface QoderInferMessage {
    role: string;
    content: string | ReadonlyArray<Record<string, unknown>>;
    tool_calls?: readonly QoderInferToolCall[];
    tool_call_id?: string;
}
/**
 * 下发给模型的工具定义（**OpenAI 风格**）。
 *
 * 客户端 `$Hc(A)` 的产物：`{type:'function', function:{name, description?, parameters?}}`，
 * 写入请求体**顶层** `tools`（源码：`tools: o?.tools ?? []`）。
 * `description` / `parameters` 缺省时该键**不出现**。
 */
export interface QoderInferTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
/** 构造加密推理请求的入参。 */
export interface QoderInferAsk {
    /** 模型目录 key（如 `qfmodel`）。
  
     * ⚠️ 这是**目录 key**，不是推理用的通用名 —— 本端点认的就是 key。 */
    modelKey: string;
    /** 用户消息文本（`chat_context.text` 取最后一条 user 消息）。 */
    userText: string;
    /** 系统提示（可选）。 */
    systemText?: string;
    /** 该模型是否支持思考（写入 `model_config.is_reasoning`）。 */
    isReasoning?: boolean;
    /** 会话里已发生的消息（历史），按顺序。首条 user 即 `userText`。 */
    history?: readonly QoderInferMessage[];
    /** 单次输出上限。 */
    maxTokens?: number;
    /** 思考档位；`none` 表示关闭思考。 */
    reasoningEffort?: string;
    /** 模型目录里的 `source`（默认 `system`）。 */
    source?: string;
    /** 模型是否支持图片（`is_vl`）。 */
    isVl?: boolean;
    /** 上下文长度（可选）。 */
    contextWindow?: number;
    /**
     * 该模型在目录里的 `display_name`（写入 `model_config.display_name`）。
     *
     * 官方 `Uyc()` 的 `model_config` 有 10 个字段，这是其中之一；
     * 为对齐官方结构而带上（**不是**路由的决定因素 —— 那是 `business`）。
     */
    displayName?: string;
    /** 目录里的 `format`（默认 `openai`）。 */
    format?: string;
    /** 目录里的 `max_input_tokens`（写入 `model_config.max_input_tokens`）。 */
    maxInputTokens?: number;
    /**
     * `session_type`。
     *
     * 官方源码：`session_type: process.env[SESSION_TYPE] ?? (r0() ? l7A : swe)`
     * —— 国际版是 **`qodercli`**（`swe`），国内版是 **`qoder_work`**（`l7A`）。
     * 早期传的是 `'cli'`（两边都不是）；现已对齐国际版。
     */
    sessionType?: string;
    /**
     * **业务归属 —— 必填，它决定服务端路由。**
     *
     * ⚠️ 这是 `qfmodel`（Qwen3.8-Flash）`Execution failed` 的**真正根因**
     * （实测 2026-09-20）：**不带 `business`** 时请求恒被路由到故障节点
     * `oa_qwen-plus-2025-04-28`；补上后立即正常。
     *
     * 其余模型（如 `qmodel_38max`）恰好不受影响，故极易误判为
     * 「该模型服务端故障」—— 但同一模型在 IDE 里完全可用。
     *
     * 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
     * —— 服务端按 `business.type` 选路由池。
     */
    business?: Record<string, unknown>;
    /**
     * 下发给模型的工具定义（OpenAI 风格）。
     *
     * ⚠️ **必须真的传**：加密端点认请求体**顶层** `tools`
     * （客户端源码 `tools: o?.tools ?? []`）。早期实现把它硬编码为 `[]`，
     * 模型拿不到任何函数 schema，只能用正文里的 XML 文本臆造工具调用
     * （用户报障：「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」）。
     *
     * 省略等价于空数组（与客户端一致：键恒在，值为 `[]`）。
     */
    tools?: readonly QoderInferTool[];
}
/**
 * 构造加密端点 `agent_chat_generation` 的**明文请求体**。
 *
 * 抽成纯函数有两个理由：
 * 1. **可测**：加密端点的请求体经 WASM 加密后本地不可解（朴素 `JSON.parse`
 *    会抛），把 payload 构造独立出来才能直接断言 `tools` / `messages`；
 * 2. **单一来源**：`prepareInfer` 只负责「拿它去加密」，不再内联一份结构。
 *
 * ⚠️ 结构逐项复刻官方 `G4A()`，改动前请先读
 * `docs/qoder-encryption-notes.md` 的 §3 与 §6：
 * `chat_context` 不能传空对象、`business` 缺失会被路由到故障节点。
 *
 * @param ask - 上层适配器给出的请求参数。
 * @param requestId - 请求 id（默认随机；测试可固定以求确定性）。
 */
export declare function buildQoderInferPayload(ask: QoderInferAsk, requestId?: string): Record<string, unknown>;
/**
 * 生成运行时鉴权字段（`encrypt_user_info` / `key`）。
 *
 * 这两个字段是服务端识别用户身份的依据，后续 `QoderContext` 需要它们。
 */
export declare function generateRuntimeAuthFields(user: QoderWasmUserInfo): Promise<QoderRuntimeAuthFields>;
/**
 * 解密 Qoder 的模型目录缓存（`~/.qoder/.models/{uid}/catalog-v6`）。
 *
 * 目录文件是 WASM 加密的 base64 文本，明文是模型目录 JSON —— 里面有
 * **倍率**（`cost_multiplier`）等本插件兜底表尚未收录的字段。
 * WASM 自己导出了 `model_cache_decrypt`，直接调用即可（不是破解）。
 *
 * ⚠️ **`machineId` 是必填的第二参**（官方调用点 `model_cache_decrypt(i, A)`，
 * `A` 即 machineId）。漏传会得到 `AES-GCM decrypt failed: aead::Error` ——
 * 这个报错看起来像「密文损坏」，实际是缺参数。
 * 该值由本插件生成并随凭据持久化（`QoderCredential.machine_id`）。
 *
 * 仅用于离线读取本机缓存做核对/排查；线上模型列表仍走兜底表
 * （目录端点需 WASM 签名，见 `qoder-adapter.ts` 的 `listModels`）。
 */
export declare function decryptModelCatalog(encrypted: string, machineId: string): Promise<unknown>;
/**
 * Qoder 加密推理客户端。
 *
 * 持有 WASM 上下文（`QoderContext`）与运行时鉴权字段，用于反复生成
 * 加密推理请求。实例**不是**线程安全的；一个账号一个实例即可。
 */
export declare class QoderEncryptedInfer {
    private readonly g;
    private readonly context;
    private readonly metadata;
    /** 加密端点所在 host（`agent_chat_generation`）。 */
    private readonly host;
    private constructor();
    /** 创建客户端（会调 WASM 构造 `QoderContext`）。 */
    static create(options: {
        user: QoderWasmUserInfo;
        /** 设备标识（官方用硬件指纹；本插件用持久化的随机 UUID）。 */
        machineId: string;
        metadata: QoderClientMetadata;
        /**
         * 加密推理端点所在 host。
         *
         * ⚠️ 必须是 `api2.qoder.sh` 系 —— 传 `api2-v2.qoder.sh` 会 404
         * （那是公开 OpenAI 兼容端点的 host，两者不同）。
         */
        host: string;
        /** 客户端版本；影响 `Cosy-Version` 与签名载荷。 */
        clientVersion?: string;
    }): Promise<QoderEncryptedInfer>;
    /**
     * 构造加密推理请求（url / headers / body）。
     *
     * ⚠️ 返回的 `headers` **必须原样透传**：其中的 `Authorization` 是
     * WASM 生成的 `Bearer COSY.<载荷>.<签名>`。用普通 `Bearer <token>`
     * 覆盖会导致 `403 Signature invalid`。
     */
    prepareInfer(ask: QoderInferAsk): QoderInferRequest;
}
/** 供测试注入/复位（导出以便单测隔离）。 */
export declare const __testing: {
    resetGlue(): void;
    wasmPath: string;
};
//# sourceMappingURL=qoder-wasm.d.ts.map