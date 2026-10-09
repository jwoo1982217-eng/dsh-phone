export declare const AUTOCLAW: {
    readonly id: "autoclaw";
    readonly displayName: "AutoClaw (智谱)";
    readonly origin: "https://autoglm-acceleration-api.zhipuai.cn";
};
export interface AutoclawCredential {
    access_token: string;
    refresh_token: string;
    user_id: string;
    device_id: string;
    nickname: string;
}
export interface AutoclawModel {
    id: string;
    name: string;
    api: 'openai-completions' | 'anthropic-messages';
    input: ('text' | 'image')[];
    contextWindow?: number;
    maxTokens?: number;
}
export declare function autoclawHeaders(token?: string, now?: number): Record<string, string>;
export declare function parseAutoclawCredential(raw: string): AutoclawCredential | undefined;
export declare function autoclawExpiry(c: AutoclawCredential): number | undefined;
/** 不编造模型目录：只使用当前账号拿到的官方配置。 */
export declare function parseAutoclawModels(value: unknown): AutoclawModel[];
export declare class AutoclawApi {
    readonly fetchImpl: typeof fetch;
    constructor(fetchImpl?: typeof fetch);
    request(path: string, body?: unknown, c?: AutoclawCredential, signal?: AbortSignal): Promise<any>;
    sendSms(phone: string, device: string): Promise<void>;
    login(phone: string, code: string, device: string): Promise<AutoclawCredential>;
    refresh(c: AutoclawCredential): Promise<AutoclawCredential>;
    models(c: AutoclawCredential): Promise<AutoclawModel[]>;
    balance(c: AutoclawCredential): Promise<number>;
}
//# sourceMappingURL=autoclaw-api.d.ts.map