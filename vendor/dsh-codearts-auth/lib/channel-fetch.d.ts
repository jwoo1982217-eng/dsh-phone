import { createProxyDispatcher } from './opencode-proxy.js';
export interface ChannelOutlet {
    active: () => boolean;
    fetch: typeof fetch;
}
interface WindowsProxy {
    server: string;
    bypass: string;
}
/** 解析手动系统代理；不执行 PAC 脚本，也不读取其它注册表配置。 */
export declare function parseWindowsProxy(output: string): WindowsProxy | undefined;
/** NO_PROXY 支持域名后缀、通配符、可选端口；系统例外另支持 <local>。 */
export declare function channelProxyBypassed(target: URL, patterns: string, windows?: boolean): boolean;
/** 只显示路由类型和错误码，避免将代理密码、OAuth code 或令牌写进日志。 */
export declare class ChannelNetworkError extends Error {
    name: string;
}
export interface ChannelFetchOptions {
    outlet?: ChannelOutlet;
    /** 以下依赖可注入，用于离线验证，不读取测试机的真实代理配置。 */
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readSystemProxy?: () => Promise<string>;
    fetchImpl?: typeof fetch;
    dispatcherFor?: typeof createProxyDispatcher;
}
/** 一次挂载一个实例：插件出口 > 环境代理 > Windows 手动代理 > 直连。 */
export declare function createChannelFetch(options?: ChannelFetchOptions): {
    fetch: typeof fetch;
    close: () => Promise<void>;
};
export {};
//# sourceMappingURL=channel-fetch.d.ts.map