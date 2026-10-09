import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { type ApiKeySource } from './auth.js';
import type { AttachmentBridge, ImageLimits } from './images.js';
export interface GatewayLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export interface LlmRuntimeLike {
    listProviders(): readonly {
        id: string;
    }[];
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export interface OpenAiGatewayOptions {
    ctx?: Context;
    llm: LlmRuntimeLike;
    /**
     * 附件服务桥接（`ctx.attachments.saveImage`）。
     *
     * 缺失时收到图片会明确回「未装载附件服务」而不是静默丢图 —— 静默丢弃会让用户
     * 以为模型看到了图，而答案其实是基于文本生成的。
     */
    attachments?: AttachmentBridge;
    /** 图片限制；缺省用 `images.ts` 里附件服务的实测默认值。 */
    imageLimits?: ImageLimits;
    home?: string;
    env?: NodeJS.ProcessEnv;
    logger?: GatewayLogger;
}
export interface OpenAiGateway {
    start(): Promise<void>;
    close(): Promise<void>;
    address(): {
        host: string;
        port: number;
    };
    /**
     * 密钥来源（含本体与文件路径）。
     *
     * 刻意**只经由 `createOpenAiGateway()` 拿**（runtime 已持有实例），而不是
     * 另开一条读密钥的通道：多一个入口就多一处「读到的和网关在用的不是同一个」
     * 的可能，而那种偏差会表现为「设置页复制的 key 一律 401」。
     */
    apiKey: ApiKeySource;
}
export declare function createOpenAiGateway(options: OpenAiGatewayOptions): OpenAiGateway;
//# sourceMappingURL=server.d.ts.map