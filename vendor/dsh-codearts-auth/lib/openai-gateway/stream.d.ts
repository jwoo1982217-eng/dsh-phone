import type { StreamChunk } from '@deepseek-ai/dsh-llm';
/**
 * 失败后给出纠错建议的钩子。
 *
 * 只在**出错时**被调用（正常路径零开销），故可以放心在这里去查模型目录。
 * 流式与非流式共用同一个钩子，保证两条路径给出的建议完全一致。
 */
export type SuggestionHook = (message: string) => string | undefined | Promise<string | undefined>;
/**
 * 把「你可能是想用 X」拼到错误消息后面。
 *
 * ⚠️ 导出给 `responses.ts` 复用：两个端点的纠错建议必须逐字一致，
 * 否则同一次误填在两个 URL 上会得到不同的提示。
 */
export declare function withSuggestion(message: string, suggest: SuggestionHook | undefined): Promise<string>;
export declare function toOpenAiSse(chunks: AsyncIterable<StreamChunk>, requestId: string, model: string, suggest?: SuggestionHook): AsyncIterable<string>;
export declare function collectOpenAiCompletion(chunks: AsyncIterable<StreamChunk>, requestId: string, model: string, suggest?: SuggestionHook): Promise<Record<string, unknown>>;
export declare function failureToOpenAiError(error: unknown): {
    status: number;
    body: {
        error: Record<string, unknown>;
    };
};
//# sourceMappingURL=stream.d.ts.map