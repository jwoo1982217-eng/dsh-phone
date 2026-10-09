import z from '@deepseek-ai/schemastery';
import { IMPORTER_IDS } from './importers.js';
import { NOEMA_MEMORY_SETTINGS_NAMESPACE } from './names.js';
/** Schema defaults — the single source of truth the schema is built from. */
export const NOEMA_MEMORY_SETTINGS_DEFAULTS = {
    enabled: false,
    command: 'bundled',
    workingDirectory: '',
    noemaRoot: '',
    autoStart: false,
    idleTimeoutMs: 0,
    keepAlive: false,
    keepAliveIntervalMs: 5_000,
    callTimeoutMs: 30_000,
    restartDelayMs: 1_000,
    recallBudgetTokens: 1_200,
    acceptByDefault: false,
    guidance: false,
    importEnabled: false,
    importOnStartup: false,
    importWorkspaceFiles: false,
    importMaxBytes: 65_536,
    importSources: ['codex', 'claude-code', 'opencode', 'cursor', 'grok', 'workbuddy', 'antigravity', 'trae', 'qoder'],
};
/** Branded settings namespace. */
export const NOEMA_MEMORY_SETTINGS_NS = NOEMA_MEMORY_SETTINGS_NAMESPACE;
/** Schemastery schema of the settings section. */
export const NOEMA_MEMORY_SETTINGS_SCHEMA = z.object({
    enabled: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.enabled),
    command: z.string().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.command),
    workingDirectory: z.string().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.workingDirectory),
    noemaRoot: z.string().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.noemaRoot),
    autoStart: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.autoStart),
    idleTimeoutMs: z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.idleTimeoutMs),
    keepAlive: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.keepAlive),
    keepAliveIntervalMs: z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.keepAliveIntervalMs),
    callTimeoutMs: z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.callTimeoutMs),
    restartDelayMs: z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.restartDelayMs),
    recallBudgetTokens: z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.recallBudgetTokens),
    acceptByDefault: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.acceptByDefault),
    guidance: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.guidance),
    importEnabled: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importEnabled),
    importOnStartup: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importOnStartup),
    importWorkspaceFiles: z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importWorkspaceFiles),
    importMaxBytes: z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importMaxBytes),
    importSources: z.array(z.string()).default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importSources),
});
/** Entry-config face accepted by the cordis loader for this plugin. */
export const Config = NOEMA_MEMORY_SETTINGS_SCHEMA.volatile();
const NON_NEGATIVE_FIELDS = [
    ['idleTimeoutMs', 'idle timeout'],
    ['callTimeoutMs', 'call timeout'],
    ['restartDelayMs', 'restart delay'],
];
/**
 * Cross-field validation the schema cannot express: numeric ranges and the
 * recall budget floor. Throwing here refuses the write before anything is
 * persisted (dsh-settings contract). Accepts a partial section because the
 * settings register hook validates resolved candidates of any shape.
 */
export function validateNoemaMemorySettings(value) {
    for (const [field, label] of NON_NEGATIVE_FIELDS) {
        const current = value[field];
        if (current !== undefined && (!Number.isFinite(current) || current < 0)) {
            throw new Error('Noema memory: ' + label + ' (' + String(field) + ') must be a non-negative number of milliseconds');
        }
    }
    if (value.recallBudgetTokens !== undefined && (!Number.isInteger(value.recallBudgetTokens) || value.recallBudgetTokens < 1)) {
        throw new Error('Noema memory: recall budget must be a positive integer number of tokens');
    }
    if (value.command !== undefined && value.command.trim() === '') {
        throw new Error('Noema memory: server command must not be empty');
    }
    if (value.keepAliveIntervalMs !== undefined && (!Number.isInteger(value.keepAliveIntervalMs) || value.keepAliveIntervalMs < 1000)) {
        throw new Error('Noema memory: keep-alive interval must be at least 1000 milliseconds');
    }
    if (value.importMaxBytes !== undefined && (!Number.isInteger(value.importMaxBytes) || value.importMaxBytes < 1024)) {
        throw new Error('Noema memory: import file cap must be at least 1024 bytes');
    }
    if (value.importSources !== undefined) {
        const known = new Set(IMPORTER_IDS);
        for (const source of value.importSources) {
            if (!known.has(source)) {
                throw new Error('Noema memory: unknown import source ' + JSON.stringify(source));
            }
        }
    }
}
/**
 * Install the optional-settings wiring. `entry` is the plugin's composition
 * entry config, used as the `base` layer; `setSource` points the caller's
 * resolution thunk at the live resolved value and `onChange` fires when it
 * moves.
 */
export function installNoemaMemorySettings(ctx, entry, hooks) {
    const fallback = resolveNoemaMemorySettings(entry);
    hooks.setSource(() => fallback);
    hooks.setWriter(undefined);
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.settings;
        const ns = ctx.fiber.entry?.options.id ?? 'dsh-noema';
        const source = () => resolveNoemaMemorySettings(settings.describe().find(d => d.ns === ns)?.value ?? entry);
        hooks.setSource(source);
        hooks.setWriter(async (patch) => {
            validateNoemaMemorySettings({ ...source(), ...patch });
            await settings.update(ns, patch);
        });
        settingsCtx.on('settings/document-updated', changed => { if (changed === ns)
            hooks.onChange(); });
        hooks.onChange();
        settingsCtx.effect(() => () => { hooks.setWriter(undefined); hooks.setSource(() => fallback); });
    });
}
export { IMPORTER_IDS } from './importers.js';
/** Resolve an entry config against the schema defaults. */
export function resolveNoemaMemorySettings(entry) {
    return { ...NOEMA_MEMORY_SETTINGS_DEFAULTS, ...(entry ?? {}) };
}
