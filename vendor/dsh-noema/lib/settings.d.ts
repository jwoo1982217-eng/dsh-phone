/**
 * Memory configuration namespace: schema, defaults, validation, and the
 * optional-settings wiring shared by the plugin root.
 *
 * While a settings service exists the user layer is read and written live;
 * without one the composition entry stays in force and remains read-only.
 * @module @zseven-w/dsh-noema/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Memory configuration as resolved for the running plugin. */
export interface NoemaMemorySettings {
    /** Master switch. When false every tool fails fast with a clear message. */
    enabled: boolean;
    /** Launch command/path for the Noema MCP stdio server (whitespace-split). */
    command: string;
    /** Working directory for the server process (e.g. the noema repo for cargo). */
    workingDirectory: string;
    /** NOEMA_ROOT override; empty keeps Noema's default (~/.agent-memory). */
    noemaRoot: string;
    /** Spawn the server when the plugin mounts instead of on first use. */
    autoStart: boolean;
    /** Stop the server after this many idle milliseconds (0 = never). */
    idleTimeoutMs: number;
    /** Restart the server in the background when it crashes or exits. */
    keepAlive: boolean;
    /** Minimum interval between keep-alive health checks. */
    keepAliveIntervalMs: number;
    /** Per-tool-call deadline in milliseconds. */
    callTimeoutMs: number;
    /** Minimum delay between a crash/stop and the next auto-restart. */
    restartDelayMs: number;
    /** Default token budget applied to noema_recall when omitted. */
    recallBudgetTokens: number;
    /** noema_remember auto-accepts candidates into durable memory by default. */
    acceptByDefault: boolean;
    /** Include the memory-usage guidance section in the system prompt. */
    guidance: boolean;
    /** Master switch for the foreign-agent memory import feature. */
    importEnabled: boolean;
    /** Run an import pass automatically when the plugin mounts. */
    importOnStartup: boolean;
    /** Include the session workspace's AGENTS.md/CLAUDE.md/rules files. */
    importWorkspaceFiles: boolean;
    /** Per-file byte cap applied while reading foreign memory files. */
    importMaxBytes: number;
    /** Enabled importer ids (Codex, Claude Code, opencode, Cursor, Grok, WorkBuddy). */
    importSources: string[];
}
/** Schema defaults — the single source of truth the schema is built from. */
export declare const NOEMA_MEMORY_SETTINGS_DEFAULTS: NoemaMemorySettings;
/** Branded settings namespace. */
export declare const NOEMA_MEMORY_SETTINGS_NS = "noema-memory";
/** Schemastery schema of the settings section. */
export declare const NOEMA_MEMORY_SETTINGS_SCHEMA: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    command: z<string, string, "defined">;
    workingDirectory: z<string, string, "defined">;
    noemaRoot: z<string, string, "defined">;
    autoStart: z<boolean, boolean, "defined">;
    idleTimeoutMs: z<number, number, "defined">;
    keepAlive: z<boolean, boolean, "defined">;
    keepAliveIntervalMs: z<number, number, "defined">;
    callTimeoutMs: z<number, number, "defined">;
    restartDelayMs: z<number, number, "defined">;
    recallBudgetTokens: z<number, number, "defined">;
    acceptByDefault: z<boolean, boolean, "defined">;
    guidance: z<boolean, boolean, "defined">;
    importEnabled: z<boolean, boolean, "defined">;
    importOnStartup: z<boolean, boolean, "defined">;
    importWorkspaceFiles: z<boolean, boolean, "defined">;
    importMaxBytes: z<number, number, "defined">;
    importSources: z<string[], string[], "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    command: z<string, string, "defined">;
    workingDirectory: z<string, string, "defined">;
    noemaRoot: z<string, string, "defined">;
    autoStart: z<boolean, boolean, "defined">;
    idleTimeoutMs: z<number, number, "defined">;
    keepAlive: z<boolean, boolean, "defined">;
    keepAliveIntervalMs: z<number, number, "defined">;
    callTimeoutMs: z<number, number, "defined">;
    restartDelayMs: z<number, number, "defined">;
    recallBudgetTokens: z<number, number, "defined">;
    acceptByDefault: z<boolean, boolean, "defined">;
    guidance: z<boolean, boolean, "defined">;
    importEnabled: z<boolean, boolean, "defined">;
    importOnStartup: z<boolean, boolean, "defined">;
    importWorkspaceFiles: z<boolean, boolean, "defined">;
    importMaxBytes: z<number, number, "defined">;
    importSources: z<string[], string[], "defined">;
}>>, "plain">;
/** Entry-config face accepted by the cordis loader for this plugin. */
export declare const Config: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    command: z<string, string, "defined">;
    workingDirectory: z<string, string, "defined">;
    noemaRoot: z<string, string, "defined">;
    autoStart: z<boolean, boolean, "defined">;
    idleTimeoutMs: z<number, number, "defined">;
    keepAlive: z<boolean, boolean, "defined">;
    keepAliveIntervalMs: z<number, number, "defined">;
    callTimeoutMs: z<number, number, "defined">;
    restartDelayMs: z<number, number, "defined">;
    recallBudgetTokens: z<number, number, "defined">;
    acceptByDefault: z<boolean, boolean, "defined">;
    guidance: z<boolean, boolean, "defined">;
    importEnabled: z<boolean, boolean, "defined">;
    importOnStartup: z<boolean, boolean, "defined">;
    importWorkspaceFiles: z<boolean, boolean, "defined">;
    importMaxBytes: z<number, number, "defined">;
    importSources: z<string[], string[], "defined">;
}>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    command: z<string, string, "defined">;
    workingDirectory: z<string, string, "defined">;
    noemaRoot: z<string, string, "defined">;
    autoStart: z<boolean, boolean, "defined">;
    idleTimeoutMs: z<number, number, "defined">;
    keepAlive: z<boolean, boolean, "defined">;
    keepAliveIntervalMs: z<number, number, "defined">;
    callTimeoutMs: z<number, number, "defined">;
    restartDelayMs: z<number, number, "defined">;
    recallBudgetTokens: z<number, number, "defined">;
    acceptByDefault: z<boolean, boolean, "defined">;
    guidance: z<boolean, boolean, "defined">;
    importEnabled: z<boolean, boolean, "defined">;
    importOnStartup: z<boolean, boolean, "defined">;
    importWorkspaceFiles: z<boolean, boolean, "defined">;
    importMaxBytes: z<number, number, "defined">;
    importSources: z<string[], string[], "defined">;
}>>>, "volatile">;
/**
 * Cross-field validation the schema cannot express: numeric ranges and the
 * recall budget floor. Throwing here refuses the write before anything is
 * persisted (dsh-settings contract). Accepts a partial section because the
 * settings register hook validates resolved candidates of any shape.
 */
export declare function validateNoemaMemorySettings(value: Partial<NoemaMemorySettings>): void;
/**
 * Install the optional-settings wiring. `entry` is the plugin's composition
 * entry config, used as the `base` layer; `setSource` points the caller's
 * resolution thunk at the live resolved value and `onChange` fires when it
 * moves.
 */
export declare function installNoemaMemorySettings(ctx: Context, entry: Partial<NoemaMemorySettings>, hooks: {
    setSource: (source: () => NoemaMemorySettings) => void;
    setWriter: (writer: ((patch: Partial<NoemaMemorySettings>) => Promise<void>) | undefined) => void;
    onChange: () => void;
}): void;
export { IMPORTER_IDS } from './importers.js';
/** Resolve an entry config against the schema defaults. */
export declare function resolveNoemaMemorySettings(entry: Partial<NoemaMemorySettings> | undefined): NoemaMemorySettings;
