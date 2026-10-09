/** Bounded protocol envelope sizes, generous for full catalogs. */
export declare const MAX_MCP_MESSAGE_BYTES: number;
/** MCP protocol version negotiated during initialize. */
export declare const MCP_PROTOCOL_VERSION = "2024-11-05";
/** How long the initialize handshake may take before the server is rejected. */
export declare const DEFAULT_INITIALIZE_TIMEOUT_MS = 15000;
export interface McpStdioOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    initializeTimeoutMs?: number;
    /** Each stderr line the server prints; used for diagnostics, never protocol. */
    stderr?: (line: string) => void;
}
export interface McpToolResult {
    /** Joined text content of the tool result; '' when the result had none. */
    text: string;
}
/** One client lifecycle error (spawn, protocol, tool, or exit). */
export declare class McpStdioError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/**
 * One Noema MCP stdio connection. Pull-based: the owner starts it, calls
 * tools, and disposes it; a server exit rejects every in-flight call.
 */
export declare class McpStdioClient {
    private readonly options;
    private child;
    private nextId;
    private readonly pending;
    private buffer;
    private disposed;
    /** Observed lifecycle state for the manager and status route. */
    state: 'stopped' | 'starting' | 'running' | 'exited';
    /** Child pid while spawned; undefined otherwise. */
    get pid(): number | undefined;
    exitCode: number | null | undefined;
    exitSignal: string | null | undefined;
    startedAt: number | undefined;
    /** When the process exited; drives the keep-alive backoff window. */
    exitAt: number | undefined;
    constructor(options: McpStdioOptions);
    /** Spawn (if needed) and complete the initialize handshake. */
    start(): Promise<void>;
    /** Call one MCP tool and return its joined text content. */
    callTool(name: string, args: Record<string, unknown>, options: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<McpToolResult>;
    /** Stop the child (SIGTERM, then SIGKILL) and reject all in-flight calls. */
    dispose(): Promise<void>;
    private spawn;
    private handleExit;
    private markExited;
    private onStdout;
    private onLine;
    private request;
    private notify;
    private send;
    private rejectPending;
}
