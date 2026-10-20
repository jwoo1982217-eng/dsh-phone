export declare function isSilkFile(filePath: string): boolean;
export declare function convertSilkToWav(inputPath: string, outputDir?: string): Promise<{
    wavPath: string;
    duration: number;
} | null>;
export declare function isVoiceAttachment(att: {
    content_type?: string;
    filename?: string;
}): boolean;
export declare function formatDuration(durationMs: number): string;
export declare function isAudioFile(filePath: string): boolean;
export interface TTSConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
    authStyle?: "bearer" | "api-key";
    queryParams?: Record<string, string>;
    speed?: number;
}
export declare function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null;
export declare function textToSpeechPCM(text: string, ttsCfg: TTSConfig): Promise<{
    pcmBuffer: Buffer;
    sampleRate: number;
}>;
export declare function pcmToSilk(pcmBuffer: Buffer, sampleRate: number): Promise<{
    silkBuffer: Buffer;
    duration: number;
}>;
export declare function textToSilk(text: string, ttsCfg: TTSConfig, outputDir: string): Promise<{
    silkPath: string;
    silkBase64: string;
    duration: number;
}>;
export declare function audioFileToSilkBase64(filePath: string, directUploadFormats?: string[]): Promise<string | null>;
export declare function waitForFile(filePath: string, timeoutMs?: number, pollMs?: number): Promise<number>;
