/**
 * Foreign-agent memory importers: Codex, Claude Code, opencode, Cursor,
 * Grok, and WorkBuddy. Each importer declares the global and per-workspace
 * memory files its tool reads, plus how to display them. The import service
 * owns reading, chunking, dedup, and submission.
 * @module @zseven-w/dsh-noema/importers
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Generic AGENTS.md-style importer factory. */
function agentsImporter(id, label, globalFiles, workspaceFiles) {
    return {
        id,
        label,
        globalCandidates: () => {
            const home = homedir();
            return globalFiles.map(path => ({
                path: path.startsWith('~/') ? join(home, path.slice(2)) : path,
                label: path.includes('/') ? path : label + ' ' + path,
                kind: 'markdown',
            }));
        },
        workspaceCandidates: (root) => workspaceFiles.map(relative => ({
            path: join(root, relative),
            label: relative,
            kind: 'markdown',
        })),
    };
}
/**
 * Codex keeps two memory surfaces: the AGENTS.md instruction file and the
 * Codex memory pipeline under ~/.codex/memories/ (curated MEMORY.md, the
 * compact memory_summary.md, rollout summaries, and ad-hoc notes). The raw
 * raw_memories.md feed is deliberately skipped: it is the uncurated input
 * the curated files are distilled from.
 */
const CODEX = {
    id: 'codex',
    label: 'Codex',
    globalCandidates: () => {
        const home = homedir();
        return [
            { path: join(home, '.codex', 'AGENTS.md'), label: '~/.codex/AGENTS.md', kind: 'markdown' },
            { path: join(home, '.codex', 'memories', 'MEMORY.md'), label: '~/.codex/memories/MEMORY.md', kind: 'markdown' },
            { path: join(home, '.codex', 'memories', 'memory_summary.md'), label: '~/.codex/memories/memory_summary.md', kind: 'markdown' },
            { path: join(home, '.codex', 'memories', 'rollout_summaries'), label: '~/.codex/memories/rollout_summaries', kind: 'markdown-dir' },
            { path: join(home, '.codex', 'memories', 'extensions', 'ad_hoc', 'notes'), label: '~/.codex/memories/extensions/ad_hoc/notes', kind: 'markdown-dir' },
        ];
    },
    workspaceCandidates: (root) => [
        { path: join(root, 'AGENTS.md'), label: 'AGENTS.md', kind: 'markdown' },
        { path: join(root, 'AGENTS.local.md'), label: 'AGENTS.local.md', kind: 'markdown' },
    ],
};
/**
 * Claude Code memory is CLAUDE.md plus the newer MEMORY.md surface some
 * versions write to; global and project copies are both collected.
 */
const CLAUDE_CODE = agentsImporter('claude-code', 'Claude Code', ['~/.claude/CLAUDE.md', '~/.claude/CLAUDE.local.md', '~/.claude/MEMORY.md'], ['CLAUDE.md', 'CLAUDE.local.md', 'MEMORY.md']);
const OPENCODE = agentsImporter('opencode', 'opencode', ['~/.config/opencode/AGENTS.md'], ['AGENTS.md']);
/**
 * Grok memory (the experimental cross-session memory system): a global
 * ~/.grok/memory/MEMORY.md, per-project MEMORY.md files, and per-session
 * summaries under each project's sessions/ directory. One recursive walk of
 * ~/.grok/memory covers all three; the AGENTS.md instruction file stays a
 * separate candidate.
 */
const GROK = {
    id: 'grok',
    label: 'Grok',
    globalCandidates: () => {
        const home = homedir();
        return [
            { path: join(home, '.grok', 'AGENTS.md'), label: '~/.grok/AGENTS.md', kind: 'markdown' },
            { path: join(home, '.grok', 'memory'), label: '~/.grok/memory', kind: 'markdown-dir' },
        ];
    },
    workspaceCandidates: (root) => [
        { path: join(root, 'AGENTS.md'), label: 'AGENTS.md', kind: 'markdown' },
    ],
};
/**
 * WorkBuddy (CodeBuddy architecture) persists memories to a CODEBUDDY.md
 * file at the project root or under ~/.codebuddy/, plus AGENTS.md-style
 * instructions; cover the common config-dir candidates as well.
 */
const WORKBUDDY = {
    id: 'workbuddy',
    label: 'WorkBuddy',
    globalCandidates: () => {
        const home = homedir();
        return [
            join(home, '.codebuddy', 'CODEBUDDY.md'),
            join(home, '.workbuddy', 'AGENTS.md'),
            join(home, '.workbuddy', 'memory.md'),
            join(home, '.config', 'workbuddy', 'AGENTS.md'),
            join(home, 'Library', 'Application Support', 'WorkBuddy', 'AGENTS.md'),
        ].map(path => ({ path, label: 'WorkBuddy ' + path.split('/').slice(-2).join('/'), kind: 'markdown' }));
    },
    workspaceCandidates: (root) => [
        { path: join(root, 'AGENTS.md'), label: 'AGENTS.md', kind: 'markdown' },
        { path: join(root, 'CODEBUDDY.md'), label: 'CODEBUDDY.md', kind: 'markdown' },
    ],
};
/**
 * Antigravity (Google's AI IDE): AGENTS.md is the instruction surface. No
 * stable global memory store is documented yet, so the global candidates
 * cover the common config-dir conventions and stay best-effort.
 */
const ANTIGRAVITY = {
    id: 'antigravity',
    label: 'Antigravity',
    globalCandidates: () => {
        const home = homedir();
        return [
            join(home, '.antigravity', 'AGENTS.md'),
            join(home, '.config', 'antigravity', 'AGENTS.md'),
            join(home, 'Library', 'Application Support', 'Antigravity', 'AGENTS.md'),
        ].map(path => ({ path, label: 'Antigravity ' + path.split('/').slice(-2).join('/'), kind: 'markdown' }));
    },
    workspaceCandidates: (root) => [
        { path: join(root, 'AGENTS.md'), label: 'AGENTS.md', kind: 'markdown' },
        { path: join(root, 'AGENTS.local.md'), label: 'AGENTS.local.md', kind: 'markdown' },
    ],
};
/**
 * Trae (ByteDance): AGENTS.md instructions plus the built-in Memory feature.
 * Trae's memory and rules live under the per-user ~/.trae directory (the CN
 * build may use ~/.trae-cn); both roots are covered, best-effort.
 */
const TRAE = {
    id: 'trae',
    label: 'Trae',
    globalCandidates: () => {
        const home = homedir();
        const roots = ['.trae', '.trae-cn'];
        const candidates = [];
        for (const root of roots) {
            candidates.push({ path: join(home, root, 'AGENTS.md'), label: '~/' + root + '/AGENTS.md', kind: 'markdown' }, { path: join(home, root, 'memory'), label: '~/' + root + '/memory', kind: 'markdown-dir' }, { path: join(home, root, 'rules'), label: '~/' + root + '/rules', kind: 'markdown-dir' });
        }
        return candidates;
    },
    workspaceCandidates: (root) => [
        { path: join(root, 'AGENTS.md'), label: 'AGENTS.md', kind: 'markdown' },
        { path: join(root, '.trae', 'rules'), label: '.trae/rules', kind: 'markdown-dir' },
    ],
};
/**
 * Qoder (Alibaba Lingma): AGENTS.md at ~/.qoder-cn/AGENTS.md plus
 * user-level rules (~/.qoder-cn/rules/**), the auto-memory roots
 * (~/.qoder-cn/memory/ for user-level and ~/.qoder-cn/projects/<p>/memory/
 * for projects), and project files AGENTS.md / AGENTS.local.md /
 * .qoder/rules/**. The international build may use ~/.qoder instead of
 * ~/.qoder-cn; both roots are covered.
 */
const QODER = {
    id: 'qoder',
    label: 'Qoder',
    globalCandidates: () => {
        const home = homedir();
        const roots = ['.qoder-cn', '.qoder'];
        const candidates = [];
        for (const root of roots) {
            candidates.push({ path: join(home, root, 'AGENTS.md'), label: '~/' + root + '/AGENTS.md', kind: 'markdown' }, { path: join(home, root, 'rules'), label: '~/' + root + '/rules', kind: 'markdown-dir' }, { path: join(home, root, 'memory'), label: '~/' + root + '/memory', kind: 'markdown-dir' }, { path: join(home, root, 'projects'), label: '~/' + root + '/projects', kind: 'markdown-dir' });
        }
        return candidates;
    },
    workspaceCandidates: (root) => [
        { path: join(root, 'AGENTS.md'), label: 'AGENTS.md', kind: 'markdown' },
        { path: join(root, 'AGENTS.local.md'), label: 'AGENTS.local.md', kind: 'markdown' },
        { path: join(root, '.qoder', 'rules'), label: '.qoder/rules', kind: 'markdown-dir' },
    ],
};
/** Cursor rules: global and per-project .mdc rule files plus legacy .cursorrules. */
const CURSOR = {
    id: 'cursor',
    label: 'Cursor',
    globalCandidates: () => {
        const home = homedir();
        return [
            join(home, '.cursorrules'),
            join(home, '.cursor', 'rules'),
        ].map(path => ({ path, label: 'Cursor ' + path.split('/').slice(-2).join('/'), kind: 'rules' }));
    },
    workspaceCandidates: (root) => [
        { path: join(root, '.cursorrules'), label: '.cursorrules', kind: 'rules' },
        { path: join(root, '.cursor', 'rules'), label: '.cursor/rules', kind: 'rules' },
    ],
};
/** All importers in stable display order. */
export const IMPORTERS = [CODEX, CLAUDE_CODE, OPENCODE, CURSOR, GROK, WORKBUDDY, ANTIGRAVITY, TRAE, QODER];
export const IMPORTER_IDS = IMPORTERS.map(importer => importer.id);
/** Resolve an importer by id, or undefined for an unknown/absent id. */
export function importerById(id) {
    return IMPORTERS.find(importer => importer.id === id);
}
/** Resolve the enabled importers for one run, in stable order. */
export function resolveImporters(sources) {
    if (sources === undefined || sources.length === 0 || sources.includes('all'))
        return [...IMPORTERS];
    const selected = [];
    for (const importer of IMPORTERS) {
        if (sources.includes(importer.id))
            selected.push(importer);
    }
    return selected;
}
