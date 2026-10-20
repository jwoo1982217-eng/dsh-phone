import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { AutoclawApi, type AutoclawCredential } from './autoclaw-api.js';
export declare const AUTOCLAW_SYSTEM_PREFIX = "You are a personal assistant running inside OpenClaw.\n\n## Tooling\nAvailable tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n";
export declare function autoclawSystem(system?: string): string;
export declare class AutoclawIntegration {
    readonly ctx: Context;
    readonly pool: AccountPool;
    readonly api: AutoclawApi;
    readonly adapter: AutoclawAdapter;
    private pending;
    private refreshing;
    constructor(ctx: Context, pool: AccountPool, api?: AutoclawApi, readImage?: ImageReader);
    credential(ref: string): Promise<AutoclawCredential>;
    refresh(ref: string, credential?: AutoclawCredential): Promise<AutoclawCredential>;
    private prune;
    /** 返回 undefined 表示交给既有通用 RPC；不改变其他供应商行为。 */
    handle(method: string, payload: unknown): Promise<unknown | undefined>;
}
type ImageReader = (ref: unknown) => Promise<{
    mediaType: string;
    data: Uint8Array;
} | undefined>;
export declare class AutoclawAdapter extends LlmAdapter {
    readonly integration: AutoclawIntegration;
    readonly readImage?: ImageReader | undefined;
    private models;
    private loading?;
    constructor(integration: AutoclawIntegration, readImage?: ImageReader | undefined);
    handleRpc(method: string, payload: unknown): Promise<unknown>;
    providerInfo(provider: string): {
        id: string;
        name: "AutoClaw (智谱)";
    };
    invalidate(): void;
    listAllModels(): {
        id: string;
        name: string;
    }[];
    load(): Promise<void>;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export declare function registerAutoclaw(ctx: Context, pool: AccountPool, readImage?: ImageReader): AutoclawIntegration;
export {};
//# sourceMappingURL=autoclaw.d.ts.map