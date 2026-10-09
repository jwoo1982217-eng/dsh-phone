export interface ImportCandidate {
    /** Absolute file path (or directory root for the dir-walking kinds). */
    path: string;
    /** Human label shown in the imported memory text. */
    label: string;
    /** File kind: single markdown file, Cursor .mdc rules dir, or a directory of .md memory files. */
    kind: 'markdown' | 'rules' | 'markdown-dir';
}
export interface Importer {
    id: string;
    label: string;
    /** Memory files under the user's home (global, apply everywhere). */
    globalCandidates(): ImportCandidate[];
    /** Memory files inside one workspace root (project-scoped). */
    workspaceCandidates(workspaceRoot: string): ImportCandidate[];
}
/** All importers in stable display order. */
export declare const IMPORTERS: readonly Importer[];
/** Importer id union. */
export type ImporterId = (typeof IMPORTERS)[number]['id'];
export declare const IMPORTER_IDS: readonly string[];
/** Resolve an importer by id, or undefined for an unknown/absent id. */
export declare function importerById(id: string): Importer | undefined;
/** Resolve the enabled importers for one run, in stable order. */
export declare function resolveImporters(sources: readonly string[] | undefined): Importer[];
