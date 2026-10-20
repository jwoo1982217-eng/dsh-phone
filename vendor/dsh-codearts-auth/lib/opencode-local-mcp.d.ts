export interface LocalHarnessTool {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
}
export interface CapturedHarnessCall {
    name: string;
    arguments: Record<string, unknown>;
}
/** 原生 OpenCode 只生成调用；真正执行留给 DSH 的工具与权限管线。 */
export declare class OpencodeHarnessMcp {
    private server?;
    private readonly token;
    private readonly names;
    private readonly accepted;
    readonly calls: CapturedHarnessCall[];
    readonly called: Promise<void>;
    private notify;
    url: string;
    constructor(tools: readonly LocalHarnessTool[]);
    start(): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=opencode-local-mcp.d.ts.map