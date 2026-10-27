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
    /**
     * 请求体上限（字节）；缺省 {@link BODY_LIMIT}。
     *
     * 存在的唯一理由是**可测**：默认上限是 300 MiB，真发一个超限请求既慢又吃内存，
     * 而「超限时客户端拿到的是 413 而不是连接重置」（Issue IKKUBJ）这条回归用例
     * 必须有真实 HTTP 往返才立得住。它不是面向用户的配置项，插件调用方不传。
     */
    maxBodyBytes?: number;
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
/**
 * 请求体上限。
 *
 * ⚠️ **必须容得下自家图片声明所能产生的请求体**（Issue IKKUBJ）。原先的 16 MiB
 * 与 `DEFAULT_IMAGE_LIMITS` 自相矛盾：那里允许一条消息带 200 MiB 图片（**原始**
 * 字节），而 JSON 里图片以 base64 承载、膨胀 4/3 ⇒ 光图片就是 266.7 MiB。结果是
 * 「单张图片 20 MiB」这句声明在真实链路上**永不可达** —— 实测连 12 MiB 的图片
 * 都已经在读到 body 这一步就被拒，压根走不到图片体积校验。
 *
 * 300 MiB = 200 MiB 图片的 base64 形态（266.7 MiB）+ 约 35 MiB 余量给文本与
 * tools。取值上限由 `DEFAULT_IMAGE_LIMITS` 反推，故**改图片声明时必须回来核对**
 * —— `tests/unit/openai-gateway-server.spec.ts` 有一条纯算术用例锁住这个关系。
 */
export declare const BODY_LIMIT: number;
export declare function createOpenAiGateway(options: OpenAiGatewayOptions): OpenAiGateway;
//# sourceMappingURL=server.d.ts.map