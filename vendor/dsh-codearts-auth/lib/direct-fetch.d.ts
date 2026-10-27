import { type ChannelFetchOptions, type ChannelOutlet } from './channel-fetch.js';
/** 插件出口需将提供的底层发送函数用于本机 relay，避免重新进入全局 fetch。 */
export interface SignedChannelOutlet extends ChannelOutlet {
    fetchSigned?: (input: Parameters<typeof fetch>[0], init: RequestInit | undefined, send: typeof fetch) => Promise<Response>;
}
export type DirectFetchOptions = Omit<ChannelFetchOptions, 'outlet'> & {
    outlet?: SignedChannelOutlet;
};
/** 沿用 PR #483 的离线测试入口；生产代码不写入它，显式 fetchImpl 始终优先。 */
export declare const directLane: {
    fetch: typeof fetch | null;
};
export declare function createDirectFetch(options?: DirectFetchOptions): {
    fetch: typeof fetch;
    close: () => Promise<void>;
};
export declare function attachDirectFetch(fetcher: typeof fetch): () => void;
export declare const directFetch: typeof fetch;
/** 仅关闭无宿主挂载时惰性创建的传输；宿主实例由各自的 close 管理。 */
export declare function closeDirectFetch(): Promise<void>;
//# sourceMappingURL=direct-fetch.d.ts.map