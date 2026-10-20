import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ZcodeCredential } from './zcode.js';
/** Keep business failures visible without returning credential-bearing bodies. */
export declare function organizationFailure(status: number, body: string): {
    code: string;
    message: string;
};
/** Ordinary API billing uses the selected organization's own key and scope. */
export declare function streamZcodeOrganization(options: GenerateOptions, credential: ZcodeCredential, images: Map<string, string>, fetchImpl: typeof fetch): AsyncIterable<StreamChunk>;
//# sourceMappingURL=zcode-source-stream.d.ts.map