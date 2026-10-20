/**
 * OpenAI chat payload 构造 + FreeTier 形状门禁注入。
 *
 * ## 门禁依据（设计文档 §0.6，opencode2dsh 2026-09-18 实测）
 *
 * 匿名通道拒绝**不带 agent 形状**的 body，回 403 FreeTierError，除非
 * `stream: true` 且 `tools` 里有名为 `bash` 与 `read` 的 function 工具
 * （描述 / parameters / 全部请求头都不检查）。
 *
 * ⚠️ 门禁参数**收敛在本文件**，不散落到适配器 —— 服务端再收紧时只改一处。
 * ⚠️ 账号槽（带 API key）**同样注入**：免费通道与认证通道的服务端策略
 * 可能共用同一层形状检查，多注入一层对认证通道无害（官方 CLI 本来也带
 * 全套工具），但缺了它就可能让匿名槽整体失效。
 */
/** DSH 的工具 schema（`GenerateOptions.tools` 的形状）。 */
export interface OpencodeHarnessTool {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
}
/** OpenAI wire 侧的工具定义。 */
export interface OpencodeWireTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
/** 门禁工具名（服务端只认这两个名字）。 */
export declare const FREE_LANE_GATE_TOOLS: readonly ["bash", "read"];
/**
 * DSH 工具 → wire 工具。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。不下发它，模型在 wire 上看不到
 * 任何函数定义，只能用正文里的 XML 臆造工具调用 —— qoder 的用户报障
 * 「执行任务出现任务调用 xml 泄露任务终止」就是这个根因。
 */
export declare function buildOpencodeTools(tools: readonly OpencodeHarnessTool[] | undefined): OpencodeWireTool[];
/**
 * 注入门禁工具，必要时补 `tool_choice`。
 *
 * ⚠️ `tool_choice: 'none'` **只在原本一个工具都没有时**补：真实工具在列时
 * 覆盖用户的自选 tool_choice 会改变模型行为（模型将无法调用任何工具，
 * 而 harness 仍在等它调用 —— 表现为工具执行不推进）。
 *
 * @returns 满足门禁的 body；已满足或非 chat body 时**返回同一引用**。
 */
export declare function ensureFreeLaneShape(payload: Record<string, unknown>): Record<string, unknown>;
export interface OpencodePayloadInput {
    model: string;
    messages: ReadonlyArray<Record<string, unknown>>;
    system?: string;
    tools?: readonly OpencodeHarnessTool[];
    temperature?: number;
    maxTokens?: number;
    /**
     * 思考档位（issue IKJJ0V）。
     *
     * ⚠️ 取自 `GenerateOptions.reasoningEffort`（品牌类型 `ReasoningEffortId`，
     * 传进来前转成普通字符串）。声明了档位就**必须真的发出去**，否则选择器只是
     * UI 装饰 —— 用户选了「高」却没有任何效果。
     */
    reasoningEffort?: string;
}
/** 构造一次 chat 请求的完整 body（已过门禁）。 */
export declare function buildOpencodePayload(input: OpencodePayloadInput): Record<string, unknown>;
//# sourceMappingURL=opencode-messages.d.ts.map