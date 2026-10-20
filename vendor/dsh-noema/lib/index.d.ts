/**
 * @zseven-w/dsh-noema — long-term memory for DSH, backed by Noema.
 *
 * Plugin lifecycle: register the settings namespace, the model-facing
 * noema_* tools, a system-prompt guidance section, and a loopback status
 * route for the settings panel. Everything is registered through
 * ctx.effect / ctx.inject (or the returned disposer) so unloading the
 * plugin removes every contribution.
 *
 * The Noema engine itself runs out of process: the plugin spawns the
 * noema-mcp stdio server (command configured in settings) and speaks
 * newline-delimited JSON-RPC to it.
 * @module @zseven-w/dsh-noema
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, type NoemaMemorySettings } from './settings.js';
export { PLUGIN_NAME, NOEMA_TOOL_NAMES, NOEMA_MEMORY_SETTINGS_NAMESPACE, NOEMA_STATUS_ROUTE } from './names.js';
export { NOEMA_MEMORY_SETTINGS_NS, NOEMA_MEMORY_SETTINGS_SCHEMA, NOEMA_MEMORY_SETTINGS_DEFAULTS, type NoemaMemorySettings } from './settings.js';
export { McpStdioClient, McpStdioError, MCP_PROTOCOL_VERSION } from './mcp-stdio.js';
export { DSH_NOEMA_VERSION } from './version.js';
export { NoemaServerManager, resolveNoemaLaunch, tokenizeCommand, type NoemaServerStatus } from './server-manager.js';
export { BUNDLED_NOEMA_COMMAND, NOEMA_PLATFORM_PACKAGES, bundledNoemaCandidates, noemaPlatformKey, noemaPlatformPackage, resolveBundledNoemaBinary, tryResolveBundledNoemaBinary } from './bundled-binary.js';
export { createNoemaTools, type NoemaToolResult } from './tools.js';
export { noemaGuidanceText } from './guidance.js';
export { registerNoemaStatusRoute } from './status-route.js';
/** Stable plugin name (the loader entry id in cordis.patch.yml). */
export declare const name = "@zseven-w/dsh-noema";
/** Services this plugin's root fiber requires. */
export declare const inject: string[];
/** Entry-config face accepted by the cordis loader. */
export { Config };
/**
 * Plugin entry: mount every contribution and return the aggregate disposer.
 * The memory server itself starts lazily (first tool call) or at mount when
 * autoStart is enabled; start failures degrade to tool-call errors instead of
 * breaking profile boot.
 */
export declare function apply(ctx: Context, config?: Partial<NoemaMemorySettings>): Promise<() => Promise<void>>;
