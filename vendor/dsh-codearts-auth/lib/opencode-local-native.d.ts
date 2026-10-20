import { fetch as localFetch } from 'undici';
export interface OpencodeLocalAuth {
    username: string;
    password: string;
}
export interface OpencodeNativeModel {
    id: string;
    name: string;
    inputModalities: Array<'text' | 'image'>;
    contextWindow?: number;
    outputLimit?: number;
    variants: string[];
}
export interface OpencodeLocalOptions {
    home: string;
    readAuth: () => Promise<OpencodeLocalAuth | undefined>;
    saveAuth: (auth: OpencodeLocalAuth) => Promise<void>;
    executable?: string;
    loader?: string;
    libraryRoot?: string;
    fetcher?: typeof localFetch;
    warn?: (message: string) => void;
    onCatalogChanged?: () => void;
}
/** 本地 serve 与 Zen 远程 OpenAI 端点是两种协议，不能共用 URL 拼接。 */
export declare function normalizeOpencodeLocalUrl(value: string): string;
export declare class OpencodeLocalService {
    readonly options: OpencodeLocalOptions;
    readonly root: string;
    private baseUrl;
    private readonly dispatcher;
    private child?;
    private starting?;
    private loading?;
    private initialized?;
    private models;
    private catalogAt;
    private version?;
    private error?;
    private disposed;
    private busy;
    constructor(options: OpencodeLocalOptions);
    cachedModels(): readonly OpencodeNativeModel[];
    beginCall(): () => void;
    private init;
    request(path: string, body?: unknown, options?: {
        signal?: AbortSignal;
        directory?: string;
        timeout?: number;
        method?: string;
    }): Promise<any>;
    private health;
    private executable;
    ensure(): Promise<void>;
    private start;
    catalog(force?: boolean): Promise<OpencodeNativeModel[]>;
    warm(): void;
    status(): Promise<unknown>;
    handleRpc(method: string, payload: unknown): Promise<unknown | undefined>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=opencode-local-native.d.ts.map