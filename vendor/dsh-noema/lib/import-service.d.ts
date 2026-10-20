import type { NoemaLogger, NoemaServerManager } from './server-manager.js';
import type { NoemaMemorySettings } from './settings.js';
export interface ImportOptions {
    /** Importer ids to run; undefined or ['all'] runs every importer. */
    sources?: string[];
    /** Workspace root for project-scoped files; undefined skips project files. */
    workspaceRoot?: string;
    /** Re-import items even when the ledger already contains them. */
    force?: boolean;
}
export interface ImportSourceSummary {
    source: string;
    files: number;
    items: number;
    imported: number;
    skipped: number;
    errors: string[];
}
export interface ImportSummary {
    ok: boolean;
    at: number;
    sources: ImportSourceSummary[];
    totalFiles: number;
    totalItems: number;
    imported: number;
    skipped: number;
    errors: string[];
}
export interface ImportItem {
    sourceId: string;
    sourceLabel: string;
    path: string;
    heading: string;
    /** Raw section content; the ledger key ignores the source attribution prefix. */
    body: string;
    /** Model-facing memory text (source attribution prefix + body). */
    text: string;
}
/** Split a markdown memory file into items at heading boundaries. */
export declare function splitMarkdown(sourceId: string, sourceLabel: string, path: string, content: string): ImportItem[];
/** Parse a Cursor .mdc rule: frontmatter metadata plus the rule body. */
export declare function ruleItem(sourceId: string, sourceLabel: string, path: string, content: string): ImportItem;
/** Resolve the ledger file under $DSH_HOME/storages. */
export declare function importLedgerPath(): string;
/** Owns one import pass: ledger dedup plus submission through the bridge. */
export declare class MemoryImportService {
    private readonly manager;
    private readonly resolveConfig;
    private readonly logger?;
    private lastImport;
    constructor(manager: NoemaServerManager, resolveConfig: () => NoemaMemorySettings, logger?: NoemaLogger | undefined);
    /** Last completed pass, for the status route and settings panel. */
    get lastSummary(): ImportSummary | undefined;
    /** Run one import pass and return its summary. */
    run(options?: ImportOptions): Promise<ImportSummary>;
}
