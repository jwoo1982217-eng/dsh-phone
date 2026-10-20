import { homedir } from "node:os";
import { join } from "node:path";
function agentsImporter(id, label, globalFiles, workspaceFiles) {
  return {
    id,
    label,
    globalCandidates: () => {
      const home = homedir();
      return globalFiles.map((path) => ({
        path: path.startsWith("~/") ? join(home, path.slice(2)) : path,
        label: path.includes("/") ? path : label + " " + path,
        kind: "markdown"
      }));
    },
    workspaceCandidates: (root) => workspaceFiles.map((relative) => ({
      path: join(root, relative),
      label: relative,
      kind: "markdown"
    }))
  };
}
const CODEX = {
  id: "codex",
  label: "Codex",
  globalCandidates: () => {
    const home = homedir();
    return [
      { path: join(home, ".codex", "AGENTS.md"), label: "~/.codex/AGENTS.md", kind: "markdown" },
      { path: join(home, ".codex", "memories", "MEMORY.md"), label: "~/.codex/memories/MEMORY.md", kind: "markdown" },
      { path: join(home, ".codex", "memories", "memory_summary.md"), label: "~/.codex/memories/memory_summary.md", kind: "markdown" },
      { path: join(home, ".codex", "memories", "rollout_summaries"), label: "~/.codex/memories/rollout_summaries", kind: "markdown-dir" },
      { path: join(home, ".codex", "memories", "extensions", "ad_hoc", "notes"), label: "~/.codex/memories/extensions/ad_hoc/notes", kind: "markdown-dir" }
    ];
  },
  workspaceCandidates: (root) => [
    { path: join(root, "AGENTS.md"), label: "AGENTS.md", kind: "markdown" },
    { path: join(root, "AGENTS.local.md"), label: "AGENTS.local.md", kind: "markdown" }
  ]
};
const CLAUDE_CODE = agentsImporter(
  "claude-code",
  "Claude Code",
  ["~/.claude/CLAUDE.md", "~/.claude/CLAUDE.local.md", "~/.claude/MEMORY.md"],
  ["CLAUDE.md", "CLAUDE.local.md", "MEMORY.md"]
);
const OPENCODE = agentsImporter(
  "opencode",
  "opencode",
  ["~/.config/opencode/AGENTS.md"],
  ["AGENTS.md"]
);
const GROK = {
  id: "grok",
  label: "Grok",
  globalCandidates: () => {
    const home = homedir();
    return [
      { path: join(home, ".grok", "AGENTS.md"), label: "~/.grok/AGENTS.md", kind: "markdown" },
      { path: join(home, ".grok", "memory"), label: "~/.grok/memory", kind: "markdown-dir" }
    ];
  },
  workspaceCandidates: (root) => [
    { path: join(root, "AGENTS.md"), label: "AGENTS.md", kind: "markdown" }
  ]
};
const WORKBUDDY = {
  id: "workbuddy",
  label: "WorkBuddy",
  globalCandidates: () => {
    const home = homedir();
    return [
      join(home, ".codebuddy", "CODEBUDDY.md"),
      join(home, ".workbuddy", "AGENTS.md"),
      join(home, ".workbuddy", "memory.md"),
      join(home, ".config", "workbuddy", "AGENTS.md"),
      join(home, "Library", "Application Support", "WorkBuddy", "AGENTS.md")
    ].map((path) => ({ path, label: "WorkBuddy " + path.split("/").slice(-2).join("/"), kind: "markdown" }));
  },
  workspaceCandidates: (root) => [
    { path: join(root, "AGENTS.md"), label: "AGENTS.md", kind: "markdown" },
    { path: join(root, "CODEBUDDY.md"), label: "CODEBUDDY.md", kind: "markdown" }
  ]
};
const ANTIGRAVITY = {
  id: "antigravity",
  label: "Antigravity",
  globalCandidates: () => {
    const home = homedir();
    return [
      join(home, ".antigravity", "AGENTS.md"),
      join(home, ".config", "antigravity", "AGENTS.md"),
      join(home, "Library", "Application Support", "Antigravity", "AGENTS.md")
    ].map((path) => ({ path, label: "Antigravity " + path.split("/").slice(-2).join("/"), kind: "markdown" }));
  },
  workspaceCandidates: (root) => [
    { path: join(root, "AGENTS.md"), label: "AGENTS.md", kind: "markdown" },
    { path: join(root, "AGENTS.local.md"), label: "AGENTS.local.md", kind: "markdown" }
  ]
};
const TRAE = {
  id: "trae",
  label: "Trae",
  globalCandidates: () => {
    const home = homedir();
    const roots = [".trae", ".trae-cn"];
    const candidates = [];
    for (const root of roots) {
      candidates.push(
        { path: join(home, root, "AGENTS.md"), label: "~/" + root + "/AGENTS.md", kind: "markdown" },
        { path: join(home, root, "memory"), label: "~/" + root + "/memory", kind: "markdown-dir" },
        { path: join(home, root, "rules"), label: "~/" + root + "/rules", kind: "markdown-dir" }
      );
    }
    return candidates;
  },
  workspaceCandidates: (root) => [
    { path: join(root, "AGENTS.md"), label: "AGENTS.md", kind: "markdown" },
    { path: join(root, ".trae", "rules"), label: ".trae/rules", kind: "markdown-dir" }
  ]
};
const QODER = {
  id: "qoder",
  label: "Qoder",
  globalCandidates: () => {
    const home = homedir();
    const roots = [".qoder-cn", ".qoder"];
    const candidates = [];
    for (const root of roots) {
      candidates.push(
        { path: join(home, root, "AGENTS.md"), label: "~/" + root + "/AGENTS.md", kind: "markdown" },
        { path: join(home, root, "rules"), label: "~/" + root + "/rules", kind: "markdown-dir" },
        { path: join(home, root, "memory"), label: "~/" + root + "/memory", kind: "markdown-dir" },
        { path: join(home, root, "projects"), label: "~/" + root + "/projects", kind: "markdown-dir" }
      );
    }
    return candidates;
  },
  workspaceCandidates: (root) => [
    { path: join(root, "AGENTS.md"), label: "AGENTS.md", kind: "markdown" },
    { path: join(root, "AGENTS.local.md"), label: "AGENTS.local.md", kind: "markdown" },
    { path: join(root, ".qoder", "rules"), label: ".qoder/rules", kind: "markdown-dir" }
  ]
};
const CURSOR = {
  id: "cursor",
  label: "Cursor",
  globalCandidates: () => {
    const home = homedir();
    return [
      join(home, ".cursorrules"),
      join(home, ".cursor", "rules")
    ].map((path) => ({ path, label: "Cursor " + path.split("/").slice(-2).join("/"), kind: "rules" }));
  },
  workspaceCandidates: (root) => [
    { path: join(root, ".cursorrules"), label: ".cursorrules", kind: "rules" },
    { path: join(root, ".cursor", "rules"), label: ".cursor/rules", kind: "rules" }
  ]
};
const ZCODE = {
  id: "zcode",
  label: "ZCode",
  globalCandidates: () => [{ path: join(homedir(), ".zcode", "cli", "memories"), label: "ZCode memories", kind: "markdown-dir" }],
  workspaceCandidates: () => []
};
const IMPORTERS = [CODEX, CLAUDE_CODE, OPENCODE, ZCODE, CURSOR, GROK, WORKBUDDY, ANTIGRAVITY, TRAE, QODER];
const IMPORTER_IDS = IMPORTERS.map((importer) => importer.id);
function importerById(id) {
  return IMPORTERS.find((importer) => importer.id === id);
}
function resolveImporters(sources) {
  if (sources === void 0 || sources.includes("all")) return [...IMPORTERS];
  const selected = [];
  for (const importer of IMPORTERS) {
    if (sources.includes(importer.id)) selected.push(importer);
  }
  return selected;
}
export {
  IMPORTERS,
  IMPORTER_IDS,
  importerById,
  resolveImporters
};
