export declare const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export declare const DEFAULT_GATEWAY_PORT = 8326;
export interface OpenAiGatewayConfig {
    host: string;
    port: number;
}
/**
 * 网关开关。只有**显式**的假值才停用，未设置时默认启用（保持既有行为）。
 *
 * ⚠️ 不能写成 `parseInt(raw) || 1` 这类形式：`'0'` 是**合法**的停用值，
 * 而 `0` 是 falsy 会被 `||` 静默换回默认值 —— 开关会「关不掉」。
 * 判定只看归一化后的字符串，与本仓库 Qoder 环境变量的同一教训同源。
 */
export declare function isGatewayEnabled(env?: NodeJS.ProcessEnv): boolean;
/** 解析本机网关配置，端口错误时显式失败，避免静默换端口。 */
export declare function resolveGatewayConfig(env?: NodeJS.ProcessEnv): OpenAiGatewayConfig;
//# sourceMappingURL=config.d.ts.map