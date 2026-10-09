/**
 * Noema memory tools: the model-facing surface of the plugin.
 *
 * Each Noema MCP tool is wrapped in a typed DSH tool. Results are normalized
 * into a uniform envelope ({ ok, tool, text }) where text carries the full
 * server output (pretty JSON or catalog markdown), so the canonical output
 * schema stays strict while the payload stays free-form.
 * @module @zseven-w/dsh-noema/tools
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NoemaServerManager } from './server-manager.js';
import type { MemoryImportService } from './import-service.js';
import type { NoemaMemorySettings } from './settings.js';
import { NOEMA_TOOL_NAMES } from './names.js';
/** Canonical envelope returned by every Noema tool. */
export interface NoemaToolResult {
    ok: true;
    tool: string;
    text: string;
}
/** All Noema tool definitions in stable order. */
export declare function createNoemaTools(manager: NoemaServerManager, resolveConfig: () => NoemaMemorySettings, importService?: MemoryImportService): ToolDefinition[];
export { NOEMA_TOOL_NAMES };
