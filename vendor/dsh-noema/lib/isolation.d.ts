import type { NoemaMemorySettings } from './settings.js';
export type MemoryCallSource = 'agent' | 'interface' | 'import';
/** Application entry-point protection; this is not an OS sandbox. */
export declare function isolatedMemoryArgs(config: NoemaMemorySettings, name: string, args: Record<string, unknown>, source?: MemoryCallSource, provenance?: {
    window: string;
    project: string;
}): Record<string, unknown>;
export declare function memoryReferenceText(tool: string, data: unknown): string;
