import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { OpencodeLocalService } from './opencode-local-native.js';
interface AdapterOptions {
    providerClosed?: () => boolean;
    readImage?: (ref: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    disabledModels?: () => ReadonlySet<string>;
    timeoutMs?: number;
}
export declare function nativeOpencodeFailure(error: any): LlmError;
/** 本地 API 管会话，DSH 管工具执行；不会把 native 工具的已执行结果再执行一次。 */
export declare class OpencodeLocalAdapter extends LlmAdapter {
    readonly service: OpencodeLocalService;
    private readonly options;
    constructor(service: OpencodeLocalService, options?: AdapterOptions);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    listAllModels(): {
        id: string;
        name: string;
        isFree: boolean;
    }[];
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo>;
    handleRpc(method: string, payload: unknown): Promise<unknown>;
    private parts;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export {};
//# sourceMappingURL=opencode-local-adapter.d.ts.map