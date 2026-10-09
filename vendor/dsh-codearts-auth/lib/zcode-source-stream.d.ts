import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ZcodeCredential } from './zcode.js';
/** 默认机构资源包/余额必须走通用OpenAI端点，避免错误消耗编程套餐。 */
export declare function streamZcodeOrganization(options: GenerateOptions, credential: ZcodeCredential, images: Map<string, string>, fetchImpl: typeof fetch): AsyncIterable<StreamChunk>;
//# sourceMappingURL=zcode-source-stream.d.ts.map