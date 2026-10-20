import type { LocalHarnessTool, CapturedHarnessCall } from './opencode-local-mcp.js';
export interface NativeShell {
    path: string;
    tool: 'bash' | 'pwsh';
}
/** 原生工具描述必须与 DSH 执行语言一致，不能把 Bash 命令直接交给 PowerShell。 */
export declare function nativeShellForTools(tools: readonly LocalHarnessTool[], platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, exists?: (file: string) => boolean): NativeShell | undefined;
/** 只接受仍被原生权限请求挂起、与本次会话及调用 ID 对应的输入；不放行原生执行。 */
export declare function captureNativeTool(request: any, message: any, sessionId: string, tools: readonly LocalHarnessTool[], shell?: NativeShell): CapturedHarnessCall | undefined;
//# sourceMappingURL=opencode-local-handoff.d.ts.map