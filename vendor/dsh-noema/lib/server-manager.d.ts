import { type McpToolResult } from './mcp-stdio.js';
import type { NoemaMemorySettings } from './settings.js';
import { type MemoryCallSource } from './isolation.js';
export interface NoemaServerCallOptions {
    signal?: AbortSignal;
    source?: MemoryCallSource;
    provenance?: {
        window: string;
        project: string;
    };
}
export interface NoemaServerStatus {
    ok: boolean;
    state: 'stopped' | 'starting' | 'running' | 'unavailable';
    pid?: number;
    startedAt?: number;
    lastError?: string;
    /** Noema-side tenant/engine status, present when connected. */
    server?: unknown;
}
export interface NoemaLogger {
    info(message: string): void;
    warn(message: string): void;
}
export interface NoemaLaunch {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
}
/** Split a configured command into argv without shell quoting rules. */
export declare function tokenizeCommand(command: string): string[];
/** Resolve a settings section into a spawn descriptor. */
export declare function resolveNoemaLaunch(config: NoemaMemorySettings, resolveBundledBinary?: () => string): NoemaLaunch;
/** Owns the Noema server child and its restart/idle/keep-alive policy. */
export declare class NoemaServerManager {
    private readonly resolveConfig;
    private readonly logger?;
    private client;
    private starting;
    private lastError;
    private idleTimer;
    private keepAliveTimer;
    private keepAliveRunning;
    private lastKeepAliveCheckAt;
    private lastStopAt;
    private disposed;
    constructor(resolveConfig: () => NoemaMemorySettings, logger?: NoemaLogger | undefined);
    /**
     * Start the crash keep-alive loop. While enabled, an exited/crashed server
     * is restarted in the background; intentional idle stops and manual stops
     * are never fought (state 'stopped' stays stopped).
     */
    startKeepAlive(): void;
    /** Stop the keep-alive loop (restarting the plugin or manual control). */
    stopKeepAlive(): void;
    private keepAliveTick;
    /** Bring the server up if it is down; concurrent callers share one spawn. */
    ensureRunning(): Promise<void>;
    /** Call one Noema MCP tool, starting the server on demand. */
    call(name: string, args: Record<string, unknown>, options?: NoemaServerCallOptions): Promise<McpToolResult>;
    /** Stop (if running) and start again; used by the settings route. */
    restart(): Promise<void>;
    /** Stop the server and clear idle state. */
    stop(): Promise<void>;
    /** Snapshot for the settings route: lifecycle state plus engine status. */
    status(): Promise<NoemaServerStatus>;
    /** Tear down for plugin disposal: stop the child and refuse new work. */
    dispose(): Promise<void>;
    private start;
    private armIdle;
    private clearIdle;
}
