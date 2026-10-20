/** OrcaTerm 与 DSH 的消息、工具协议转换；不执行工具，也不声称移除上游预设。 */
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm';
export interface OrcaTermToolRequest {
    name: string;
    arguments: string;
}
/** 系统消息进 emphasisPrompt；历史中的工具调用和结果保持关联与错误标志。 */
export declare function prepareOrcaTermInput(options: GenerateOptions): {
    text: string;
    emphasis: string;
    tools: ToolSchema[];
    discoveredTools: Set<string>;
};
/** 只从实际工具搜索回执提取候选名，不信任普通用户正文中的工具示例。 */
export declare function discoveredOrcaTermTools(messages: GenerateOptions['messages']): Set<string>;
/** 只接受本轮声明的工具。参数完整性与权限仍由 DSH 工具层裁决。 */
export declare function resolveOrcaTermTools(result: {
    action: string;
    text: string;
    tool?: {
        name?: unknown;
        args?: unknown;
    };
}, tools: readonly ToolSchema[], discoveredTools?: ReadonlySet<string>): OrcaTermToolRequest[];
/** 专用工具协议的文本不能泄漏到正文；其余答案保持原样。 */
export declare class OrcaTermToolTextGate {
    private readonly hasTools;
    private pending;
    private pass;
    constructor(hasTools: boolean);
    feed(text: string): string;
    private release;
    finish(isToolCall: boolean): string;
}
//# sourceMappingURL=orcaterm-harness.d.ts.map