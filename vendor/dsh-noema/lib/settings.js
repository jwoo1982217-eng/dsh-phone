import z from "@deepseek-ai/schemastery";
import { IMPORTER_IDS } from "./importers.js";
import { NOEMA_MEMORY_SETTINGS_NAMESPACE } from "./names.js";
const NOEMA_MEMORY_SETTINGS_DEFAULTS = {
  enabled: false,
  command: "bundled",
  workingDirectory: "",
  noemaRoot: "",
  autoStart: false,
  idleTimeoutMs: 0,
  keepAlive: false,
  keepAliveIntervalMs: 5e3,
  callTimeoutMs: 3e4,
  restartDelayMs: 1e3,
  recallBudgetTokens: 1200,
  acceptByDefault: false,
  guidance: false,
  importEnabled: false,
  importOnStartup: false,
  importWorkspaceFiles: false,
  importMaxBytes: 65536,
  importSources: ["codex", "claude-code", "opencode", "zcode", "cursor", "grok", "workbuddy", "antigravity", "trae", "qoder"]
};
const NOEMA_MEMORY_SETTINGS_NS = NOEMA_MEMORY_SETTINGS_NAMESPACE;
const NOEMA_MEMORY_SETTINGS_SCHEMA = z.object({
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
  importSources: z.array(z.string()).default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importSources)
});
const Config = NOEMA_MEMORY_SETTINGS_SCHEMA.volatile();
const NON_NEGATIVE_FIELDS = [
  ["idleTimeoutMs", "idle timeout"],
  ["callTimeoutMs", "call timeout"],
  ["restartDelayMs", "restart delay"]
];
function validateNoemaMemorySettings(value) {
  for (const [field, label] of NON_NEGATIVE_FIELDS) {
    const current = value[field];
    if (current !== void 0 && (!Number.isFinite(current) || current < 0)) {
      throw new Error("Noema memory: " + label + " (" + String(field) + ") must be a non-negative number of milliseconds");
    }
  }
  if (value.recallBudgetTokens !== void 0 && (!Number.isInteger(value.recallBudgetTokens) || value.recallBudgetTokens < 1)) {
    throw new Error("Noema memory: recall budget must be a positive integer number of tokens");
  }
  if (value.command !== void 0 && value.command.trim() === "") {
    throw new Error("Noema memory: server command must not be empty");
  }
  if (value.keepAliveIntervalMs !== void 0 && (!Number.isInteger(value.keepAliveIntervalMs) || value.keepAliveIntervalMs < 1e3)) {
    throw new Error("Noema memory: keep-alive interval must be at least 1000 milliseconds");
  }
  if (value.importMaxBytes !== void 0 && (!Number.isInteger(value.importMaxBytes) || value.importMaxBytes < 1024)) {
    throw new Error("Noema memory: import file cap must be at least 1024 bytes");
  }
  if (value.importSources !== void 0) {
    const known = new Set(IMPORTER_IDS);
    for (const source of value.importSources) {
      if (!known.has(source)) {
        throw new Error("Noema memory: unknown import source " + JSON.stringify(source));
      }
    }
  }
}
function installNoemaMemorySettings(ctx, entry, hooks) {
  const fallback = resolveNoemaMemorySettings(entry);
  hooks.setSource(() => fallback);
  hooks.setWriter(void 0);
  ctx.inject(["settings"], (settingsCtx) => {
    const settings = settingsCtx.settings;
    const ns = ctx.fiber.entry?.options.id ?? "dsh-noema";
    const source = () => resolveNoemaMemorySettings(settings.describe().find((d) => d.ns === ns)?.value ?? entry);
    hooks.setSource(source);
    hooks.setWriter(async (patch) => {
      validateNoemaMemorySettings({ ...source(), ...patch });
      await settings.update(ns, patch);
    });
    settingsCtx.on("settings/document-updated", (changed) => {
      if (changed === ns) hooks.onChange();
    });
    hooks.onChange();
    settingsCtx.effect(() => () => {
      hooks.setWriter(void 0);
      hooks.setSource(() => fallback);
    });
  });
}
import { IMPORTER_IDS as IMPORTER_IDS2 } from "./importers.js";
function resolveNoemaMemorySettings(entry) {
  return { ...NOEMA_MEMORY_SETTINGS_DEFAULTS, ...entry ?? {} };
}
export {
  Config,
  IMPORTER_IDS2 as IMPORTER_IDS,
  NOEMA_MEMORY_SETTINGS_DEFAULTS,
  NOEMA_MEMORY_SETTINGS_NS,
  NOEMA_MEMORY_SETTINGS_SCHEMA,
  installNoemaMemorySettings,
  resolveNoemaMemorySettings,
  validateNoemaMemorySettings
};
