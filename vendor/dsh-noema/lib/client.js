window.__ModuleLoader__.load({ id: "@zseven-w/dsh-noema", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../dsh-phone-public/vendor/dsh-noema/src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  NoemaMemorySettingsPanel: () => NoemaMemorySettingsPanel,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// ../dsh-phone-public/vendor/dsh-noema/src/names.ts
var NOEMA_STATUS_ROUTE = "/_dsh/dsh-noema/status";

// ../dsh-phone-public/vendor/dsh-noema/src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "locale"];
var IMPORT_SOURCE_LABELS = [
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
  ["opencode", "opencode"],
  ["zcode", "ZCode"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["workbuddy", "WorkBuddy"],
  ["antigravity", "Antigravity"],
  ["trae", "Trae"],
  ["qoder", "Qoder"]
];
var COPY = {
  en: {
    title: "Memory",
    intro: "Long-term memory for DSH, stored locally as inspectable files. Server command, working directory, and memory root changes apply after the memory server restarts.",
    enabled: "Enable memory",
    enabledHint: "When off, every noema_* tool fails with a clear message.",
    guidance: "Memory guidance",
    guidanceHint: "Teach the model when to recall and save durable memories.",
    autoStart: "Start server at boot",
    autoStartHint: "Spawn the Noema server when DSH starts instead of on first use.",
    acceptByDefault: "Auto-accept new memories",
    acceptByDefaultHint: "noema_remember persists immediately instead of leaving a review candidate.",
    command: "Server command",
    commandHint: "Use bundled for the included noema-mcp binary, or enter a custom executable path/command.",
    workingDirectory: "Working directory",
    workingDirectoryHint: "Directory the server runs in (needed for cargo commands). Empty keeps the default.",
    noemaRoot: "Memory root (NOEMA_ROOT)",
    noemaRootHint: "Where memories are stored. Empty uses the Noema default (~/.agent-memory).",
    recallBudget: "Recall token budget",
    recallBudgetHint: "Default budget_tokens applied to noema_recall when omitted.",
    idleTimeout: "Idle timeout (ms)",
    idleTimeoutHint: "Stop the server after this many idle milliseconds. 0 keeps it running.",
    keepAlive: "Keep alive",
    keepAliveHint: "Automatically restart the memory server in the background when it crashes or exits.",
    keepAliveInterval: "Keep-alive interval (ms)",
    keepAliveIntervalHint: "Minimum delay between background health checks.",
    callTimeout: "Call timeout (ms)",
    callTimeoutHint: "Deadline for a single tool call to the memory server.",
    restartDelay: "Restart delay (ms)",
    restartDelayHint: "Minimum delay between a stop/crash and the next automatic start.",
    restartNote: "Server command, working directory, and memory root changes apply after a restart of the memory server.",
    status: "Memory server",
    statusRunning: "Running",
    statusStopped: "Stopped",
    statusUnavailable: "Unavailable",
    statusStarting: "Starting\u2026",
    statusError: "Error",
    restart: "Restart",
    stop: "Stop",
    refresh: "Refresh",
    saved: "Saved",
    notWritable: "Settings are not writable in this session",
    loading: "Loading settings\u2026",
    unavailable: "Memory settings are unavailable in this browser session",
    importTitle: "Import memories from other tools",
    importHint: "Read AGENTS.md / CLAUDE.md / .cursor rules files from other AI coding tools and save each section as a durable Noema memory. Re-runs skip already-imported items.",
    importEnabled: "Enable memory import",
    importEnabledHint: "Master switch for the noema_import tool and the import button below.",
    importOnStartup: "Import on startup",
    importOnStartupHint: "Run one deduplicated import pass every time the plugin mounts.",
    importWorkspaceFiles: "Include workspace files",
    importWorkspaceFilesHint: "Also import AGENTS.md / CLAUDE.md / rules from the session workspace.",
    importMaxBytes: "File size cap (bytes)",
    importMaxBytesHint: "Larger memory files are truncated at this size before import.",
    importSources: "Sources",
    importSourcesHint: "Which tools to read from when importing.",
    importNow: "Import now",
    importLast: "Last import",
    importEmpty: "No import has run yet in this session.",
    manageTitle: "Manage memories",
    manageHint: "Search, add, review, and delete the stored memories directly.",
    searchPlaceholder: "Search memories\u2026",
    searchButton: "Search",
    addPlaceholder: "Add a durable memory\u2026",
    addButton: "Add",
    forget: "Forget",
    noResults: "No matching memories.",
    reviewTitle: "Review queue",
    reviewHint: "Candidate memories waiting for a decision.",
    accept: "Accept",
    reject: "Reject",
    reviewEmpty: "No pending candidates.",
    manageError: "Memory operation failed",
    viewAll: "View all memories",
    viewAllHint: "Browse the full memory catalog grouped by topic.",
    viewAllEmpty: "The memory catalog is empty.",
    backToGroups: "\u2190 Back to topics",
    groups: "Topics"
  },
  zh: {
    title: "\u8BB0\u5FC6",
    intro: "\u7EDF\u4E00\u7BA1\u7406\u65B0\u5BF9\u8BDD\u7684\u8BB0\u5FC6\u8303\u56F4\u3001\u4E0D\u540C Agent \u7684\u8BB0\u5FC6\u540C\u6B65\u548C\u5F85\u5BA1\u5185\u5BB9\u3002\u540C\u6B65\u540E\u7684\u8BB0\u5FC6\u7ECF\u63A5\u53D7\uFF0C\u5E76\u5F00\u542F\u8DE8 Agent \u5F15\u7528\u3001\u52FE\u9009\u6765\u6E90\u540E\uFF0C\u624D\u4F1A\u81EA\u52A8\u5F15\u7528\u3002",
    enabled: "\u542F\u7528\u8BB0\u5FC6",
    enabledHint: "\u5173\u95ED\u540E\uFF0C\u6240\u6709 noema_* \u5DE5\u5177\u4F1A\u4EE5\u6E05\u6670\u7684\u9519\u8BEF\u4FE1\u606F\u5FEB\u901F\u5931\u8D25\u3002",
    guidance: "\u8BB0\u5FC6\u5F15\u5BFC",
    guidanceHint: "\u6559\u4F1A\u6A21\u578B\u4F55\u65F6\u8C03\u7528\u8BB0\u5FC6\u3001\u4F55\u65F6\u4FDD\u5B58\u6301\u4E45\u8BB0\u5FC6\u3002",
    autoStart: "\u542F\u52A8\u65F6\u542F\u52A8\u670D\u52A1\u5668",
    autoStartHint: "DSH \u542F\u52A8\u65F6\u5373\u62C9\u8D77 Noema \u670D\u52A1\u5668\uFF0C\u800C\u4E0D\u662F\u9996\u6B21\u4F7F\u7528\u65F6\u624D\u542F\u52A8\u3002",
    acceptByDefault: "\u81EA\u52A8\u63A5\u53D7\u65B0\u8BB0\u5FC6",
    acceptByDefaultHint: "\u4EC5\u7528\u4E8E\u754C\u9762\u624B\u52A8\u6DFB\u52A0\uFF1BAgent \u548C\u540C\u6B65\u5BFC\u5165\u7684\u5185\u5BB9\u4ECD\u8FDB\u5165\u5F85\u5BA1\u961F\u5217\u3002",
    command: "\u670D\u52A1\u5668\u547D\u4EE4",
    commandHint: "\u4F7F\u7528 bundled \u542F\u52A8\u968F\u63D2\u4EF6\u5B89\u88C5\u7684 noema-mcp\uFF0C\u4E5F\u53EF\u4EE5\u586B\u5199\u81EA\u5B9A\u4E49\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84\u6216\u547D\u4EE4\u3002",
    workingDirectory: "\u5DE5\u4F5C\u76EE\u5F55",
    workingDirectoryHint: "\u670D\u52A1\u5668\u8FDB\u7A0B\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08cargo \u547D\u4EE4\u9700\u8981\uFF09\u3002\u7559\u7A7A\u4F7F\u7528\u9ED8\u8BA4\u503C\u3002",
    noemaRoot: "\u8BB0\u5FC6\u6839\u76EE\u5F55 (NOEMA_ROOT)",
    noemaRootHint: "\u8BB0\u5FC6\u5B58\u50A8\u4F4D\u7F6E\u3002\u7559\u7A7A\u4F7F\u7528 Noema \u9ED8\u8BA4\u76EE\u5F55 (~/.agent-memory)\u3002",
    recallBudget: "\u53EC\u56DE token \u9884\u7B97",
    recallBudgetHint: "\u672A\u6307\u5B9A budget_tokens \u65F6 noema_recall \u4F7F\u7528\u7684\u9ED8\u8BA4\u9884\u7B97\u3002",
    idleTimeout: "\u7A7A\u95F2\u8D85\u65F6 (ms)",
    idleTimeoutHint: "\u7A7A\u95F2\u8D85\u8FC7\u8BE5\u6BEB\u79D2\u6570\u540E\u505C\u6B62\u670D\u52A1\u5668\u30020 \u8868\u793A\u6C38\u4E0D\u505C\u6B62\u3002",
    keepAlive: "\u4FDD\u6D3B",
    keepAliveHint: "\u8BB0\u5FC6\u670D\u52A1\u5668\u5D29\u6E83\u6216\u9000\u51FA\u65F6\u81EA\u52A8\u5728\u540E\u53F0\u91CD\u542F\u3002",
    keepAliveInterval: "\u4FDD\u6D3B\u95F4\u9694 (ms)",
    keepAliveIntervalHint: "\u540E\u53F0\u5065\u5EB7\u68C0\u67E5\u7684\u6700\u5C0F\u95F4\u9694\u3002",
    callTimeout: "\u8C03\u7528\u8D85\u65F6 (ms)",
    callTimeoutHint: "\u5355\u6B21\u5DE5\u5177\u8C03\u7528\u8BBF\u95EE\u8BB0\u5FC6\u670D\u52A1\u5668\u7684\u622A\u6B62\u65F6\u95F4\u3002",
    restartDelay: "\u91CD\u542F\u5EF6\u8FDF (ms)",
    restartDelayHint: "\u505C\u6B62/\u5D29\u6E83\u540E\u518D\u6B21\u81EA\u52A8\u542F\u52A8\u7684\u6700\u5C0F\u95F4\u9694\u3002",
    restartNote: "\u670D\u52A1\u5668\u547D\u4EE4\u3001\u5DE5\u4F5C\u76EE\u5F55\u4E0E\u8BB0\u5FC6\u6839\u76EE\u5F55\u7684\u4FEE\u6539\u5728\u8BB0\u5FC6\u670D\u52A1\u5668\u91CD\u542F\u540E\u751F\u6548\u3002",
    status: "\u8BB0\u5FC6\u670D\u52A1\u5668",
    statusRunning: "\u8FD0\u884C\u4E2D",
    statusStopped: "\u5DF2\u505C\u6B62",
    statusUnavailable: "\u4E0D\u53EF\u7528",
    statusStarting: "\u542F\u52A8\u4E2D\u2026",
    statusError: "\u9519\u8BEF",
    restart: "\u91CD\u542F",
    stop: "\u505C\u6B62",
    refresh: "\u5237\u65B0",
    saved: "\u5DF2\u4FDD\u5B58",
    notWritable: "\u5F53\u524D\u4F1A\u8BDD\u4E2D\u8BBE\u7F6E\u4E0D\u53EF\u5199",
    loading: "\u6B63\u5728\u52A0\u8F7D\u8BBE\u7F6E\u2026",
    unavailable: "\u5F53\u524D\u6D4F\u89C8\u5668\u4F1A\u8BDD\u4E2D\u8BB0\u5FC6\u8BBE\u7F6E\u4E0D\u53EF\u7528",
    importTitle: "\u540C\u6B65\u5176\u4ED6 Agent \u7684\u8BB0\u5FC6",
    importHint: "\u9009\u62E9\u6765\u6E90\u5E76\u540C\u6B65\u5230\u672C\u673A\u5F85\u5BA1\u5E93\uFF1B\u91CD\u590D\u540C\u6B65\u4F1A\u8DF3\u8FC7\u5DF2\u6709\u5185\u5BB9\u3002\u4E0B\u65B9\u63A5\u53D7\u540E\uFF0C\u76F8\u5173\u5185\u5BB9\u624D\u4F1A\u6309\u6240\u9009\u9879\u76EE\u8303\u56F4\u548C Agent \u6765\u6E90\u8FDB\u5165\u65B0\u5BF9\u8BDD\u3002",
    importEnabled: "\u542F\u7528\u8BB0\u5FC6\u5BFC\u5165",
    importEnabledHint: "noema_import \u5DE5\u5177\u4E0E\u4E0B\u65B9\u5BFC\u5165\u6309\u94AE\u7684\u603B\u5F00\u5173\u3002",
    importOnStartup: "\u542F\u52A8\u65F6\u81EA\u52A8\u5BFC\u5165",
    importOnStartupHint: "\u63D2\u4EF6\u6BCF\u6B21\u6302\u8F7D\u65F6\u81EA\u52A8\u6267\u884C\u4E00\u6B21\u53BB\u91CD\u5BFC\u5165\u3002",
    importWorkspaceFiles: "\u5305\u542B\u5DE5\u4F5C\u533A\u6587\u4EF6",
    importWorkspaceFilesHint: "\u540C\u65F6\u5BFC\u5165\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u5185\u7684 AGENTS.md / CLAUDE.md / \u89C4\u5219\u6587\u4EF6\u3002",
    importMaxBytes: "\u6587\u4EF6\u5927\u5C0F\u4E0A\u9650 (bytes)",
    importMaxBytesHint: "\u8D85\u8FC7\u8BE5\u5927\u5C0F\u7684\u8BB0\u5FC6\u6587\u4EF6\u5728\u5BFC\u5165\u524D\u88AB\u622A\u65AD\u3002",
    importSources: "\u6765\u6E90",
    importSourcesHint: "\u5BFC\u5165\u65F6\u8BFB\u53D6\u54EA\u4E9B\u5DE5\u5177\u7684\u8BB0\u5FC6\u6587\u4EF6\u3002",
    importNow: "\u7ACB\u5373\u540C\u6B65",
    importLast: "\u4E0A\u6B21\u5BFC\u5165",
    importEmpty: "\u672C\u4F1A\u8BDD\u4E2D\u8FD8\u6CA1\u6709\u6267\u884C\u8FC7\u5BFC\u5165\u3002",
    manageTitle: "\u7BA1\u7406\u8BB0\u5FC6",
    manageHint: "\u76F4\u63A5\u641C\u7D22\u3001\u6DFB\u52A0\u3001\u5BA1\u9605\u548C\u5220\u9664\u5DF2\u5B58\u50A8\u7684\u8BB0\u5FC6\u3002",
    searchPlaceholder: "\u641C\u7D22\u8BB0\u5FC6\u2026",
    searchButton: "\u641C\u7D22",
    addPlaceholder: "\u6DFB\u52A0\u4E00\u6761\u6301\u4E45\u8BB0\u5FC6\u2026",
    addButton: "\u6DFB\u52A0",
    forget: "\u5220\u9664",
    noResults: "\u6CA1\u6709\u5339\u914D\u7684\u8BB0\u5FC6\u3002",
    reviewTitle: "\u5BA1\u9605\u961F\u5217",
    reviewHint: "\u7B49\u5F85\u51B3\u5B9A\u7684\u5019\u9009\u8BB0\u5FC6\u3002",
    accept: "\u63A5\u53D7",
    reject: "\u62D2\u7EDD",
    reviewEmpty: "\u6CA1\u6709\u5F85\u5BA1\u5019\u9009\u3002",
    manageError: "\u8BB0\u5FC6\u64CD\u4F5C\u5931\u8D25",
    viewAll: "\u67E5\u770B\u5168\u90E8\u8BB0\u5FC6",
    viewAllHint: "\u6309\u4E3B\u9898\u6D4F\u89C8\u5B8C\u6574\u8BB0\u5FC6\u76EE\u5F55\u3002",
    viewAllEmpty: "\u8BB0\u5FC6\u76EE\u5F55\u4E3A\u7A7A\u3002",
    backToGroups: "\u2190 \u8FD4\u56DE\u4E3B\u9898",
    groups: "\u4E3B\u9898"
  }
};
var styles = {
  section: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 12, color: "var(--dsw-alias-label-primary)" },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px" },
  intro: { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-tertiary)" },
  note: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
  row: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "12px 14px", background: "var(--dsw-alias-bg-container)" },
  rowText: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: 500, lineHeight: "22px" },
  rowHint: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
  input: { boxSizing: "border-box", width: 200, flex: "none", height: 32, padding: "4px 10px", fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-input)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8 },
  switch: { flex: "none", margin: 0, accentColor: "var(--dsw-alias-button-primary-fill)" },
  statusCard: { display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "12px 14px" },
  statusHead: { display: "flex", alignItems: "center", gap: 8 },
  dot: { boxSizing: "border-box", width: 8, height: 8, borderRadius: "50%", flex: "none" },
  statusLabel: { fontSize: 14, fontWeight: 500 },
  statusMeta: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all" },
  statusJson: { margin: 0, fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 160, overflow: "auto" },
  actions: { display: "flex", gap: 8, marginTop: 4 },
  button: { boxSizing: "border-box", height: 28, padding: "0 12px", fontSize: 12, lineHeight: "18px", borderRadius: 14, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)", cursor: "pointer" },
  saved: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-success-primary)", margin: 0 },
  errorText: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)", margin: 0 }
};
function AutomaticMemoryCard() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("iframe", { title: "\u81EA\u52A8\u8BB0\u5FC6\u4E0E\u5386\u53F2\u68C0\u7D22", src: "/knowledge-link#memory", style: { width: "100%", height: "min(72dvh, 740px)", minHeight: 420, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12 } });
}
function dotColor(state, ok) {
  if (state === "running" && ok) return "var(--dsw-alias-state-success-primary)";
  if (state === "starting") return "var(--dsw-alias-state-warn-label)";
  return "var(--dsw-alias-state-error-primary)";
}
function statusLabel(copy, status) {
  if (status.state === "running" && status.ok) return copy.statusRunning;
  if (status.state === "starting") return copy.statusStarting;
  if (status.state === "unavailable") return copy.statusUnavailable;
  return copy.statusStopped;
}
function millisecondsAgo(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1e3));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m";
  return Math.round(minutes / 60) + "h";
}
function parseRecallText(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const memories = parsed.memories;
      if (Array.isArray(memories)) {
        return memories.filter(
          (memory) => typeof memory === "object" && memory !== null && typeof memory.id === "string"
        );
      }
    }
  } catch {
  }
  return [];
}
function parseCatalogGroups(text) {
  const groups = [];
  for (const line of text.split("\n")) {
    const match = /^##\s+(.+?)\s+\((\d+) memories?\)$/.exec(line);
    if (match !== null) groups.push({ title: match[1], count: Number(match[2]) });
  }
  return groups;
}
function parseBrowseText(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (memory) => typeof memory === "object" && memory !== null && typeof memory.id === "string"
    );
  } catch {
    return [];
  }
}
function parseReviewText(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string").map((item) => {
      const space = item.indexOf(" ");
      return space < 0 ? { id: item, body: "" } : { id: item.slice(0, space), body: item.slice(space + 1) };
    });
  } catch {
    return [];
  }
}
function MemoryManagerCard(props) {
  const copy = props.copy;
  const [query, setQuery] = (0, import_react.useState)("");
  const [addText, setAddText] = (0, import_react.useState)("");
  const [memories, setMemories] = (0, import_react.useState)(null);
  const [catalog, setCatalog] = (0, import_react.useState)(null);
  const [expanded, setExpanded] = (0, import_react.useState)(null);
  const [browsed, setBrowsed] = (0, import_react.useState)(null);
  const [review, setReview] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const post = (0, import_react.useCallback)(async (payload) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(NOEMA_STATUS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "memory", ...payload })
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "memory operation failed");
      return body;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, []);
  const search = (0, import_react.useCallback)(async () => {
    if (query.trim() === "") return;
    const result = await post({ op: "search", query });
    setMemories(result.ok && result.text !== void 0 ? parseRecallText(result.text) : null);
  }, [query, post]);
  const add = (0, import_react.useCallback)(async () => {
    if (addText.trim() === "") return;
    const result = await post({ op: "add", text: addText });
    if (result.ok) {
      setAddText("");
      setQuery(addText.trim());
      const refreshed = await post({ op: "search", query: addText.trim() });
      setMemories(refreshed.ok && refreshed.text !== void 0 ? parseRecallText(refreshed.text) : memories);
    }
  }, [addText, post, memories]);
  const forget = (0, import_react.useCallback)(async (memoryId) => {
    const result = await post({ op: "forget", memory_id: memoryId });
    if (result.ok) {
      setMemories((current) => current === null ? current : current.filter((memory) => memory.id !== memoryId));
      setBrowsed((current) => current === null ? current : current.filter((memory) => memory.id !== memoryId));
    }
  }, [post]);
  const viewAll = (0, import_react.useCallback)(async () => {
    const result = await post({ op: "catalog" });
    if (result.ok && result.text !== void 0) {
      setCatalog(parseCatalogGroups(result.text).sort((a, b) => b.count - a.count));
      setExpanded(null);
      setBrowsed(null);
    } else {
      setCatalog(null);
    }
  }, [post]);
  const openGroup = (0, import_react.useCallback)(async (title) => {
    const result = await post({ op: "browse", query: title, limit: 30 });
    if (result.ok && result.text !== void 0) {
      setExpanded(title);
      setBrowsed(parseBrowseText(result.text));
    }
  }, [post]);
  const loadReview = (0, import_react.useCallback)(async () => {
    const result = await post({ op: "review" });
    setReview(result.ok && result.text !== void 0 ? parseReviewText(result.text) : null);
  }, [post]);
  const decide = (0, import_react.useCallback)(async (candidateId, decision) => {
    const result = await post({ op: "review_decide", candidate_id: candidateId, decision });
    if (result.ok) {
      setReview((current) => current === null ? current : current.filter((item) => item.id !== candidateId));
    }
  }, [post]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.statusCard, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { ...styles.title, fontSize: 14 }, children: copy.manageTitle }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.rowHint, children: copy.manageHint }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "text",
          style: { ...styles.input, width: "100%", flex: 1 },
          value: query,
          placeholder: copy.searchPlaceholder,
          disabled: busy,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") void search();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void search(), children: copy.searchButton })
    ] }),
    memories !== null && memories.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.rowHint, children: copy.noResults }) : null,
    memories !== null && memories.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflow: "auto" }, children: memories.map((memory) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { display: "flex", gap: 8, alignItems: "flex-start", borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { flex: 1, minWidth: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { ...styles.rowHint, margin: 0 }, children: [
          memory.kind ?? "memory",
          " \xB7 ",
          memory.id.slice(0, 13)
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...styles.statusMeta, margin: 0, wordBreak: "break-word" }, children: (memory.text ?? "").length > 240 ? memory.text.slice(0, 240) + "\u2026" : memory.text })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void forget(memory.id), children: copy.forget })
    ] }, memory.id)) }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...styles.statusMeta, margin: 0 }, children: copy.viewAllHint }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, marginTop: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void viewAll(), children: copy.viewAll }),
        expanded !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => {
          setExpanded(null);
          setBrowsed(null);
        }, children: copy.backToGroups }) : null
      ] }),
      catalog !== null && catalog.length === 0 && expanded === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.rowHint, children: copy.viewAllEmpty }) : null,
      catalog !== null && expanded === null && catalog.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { ...styles.statusMeta, margin: "6px 0 0" }, children: [
          copy.groups,
          ":"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 160, overflow: "auto" }, children: catalog.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "button",
          {
            type: "button",
            style: { ...styles.button, height: "auto", padding: "3px 10px", lineHeight: "18px" },
            disabled: busy,
            onClick: () => void openGroup(group.title),
            children: [
              group.title,
              " (",
              group.count,
              ")"
            ]
          }
        ) }, group.title)) })
      ] }) : null,
      expanded !== null && browsed !== null && browsed.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.rowHint, children: copy.noResults }) : null,
      expanded !== null && browsed !== null && browsed.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflow: "auto" }, children: browsed.map((memory) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { display: "flex", gap: 8, alignItems: "flex-start", borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { flex: 1, minWidth: 0 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { ...styles.rowHint, margin: 0 }, children: [
            memory.kind ?? "memory",
            " \xB7 ",
            memory.id.slice(0, 13)
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...styles.statusMeta, margin: 0, wordBreak: "break-word" }, children: (memory.text ?? "").length > 240 ? memory.text.slice(0, 240) + "\u2026" : memory.text })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void forget(memory.id), children: copy.forget })
      ] }, memory.id)) }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "text",
          style: { ...styles.input, width: "100%", flex: 1 },
          value: addText,
          placeholder: copy.addPlaceholder,
          disabled: busy,
          onChange: (event) => setAddText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") void add();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void add(), children: copy.addButton })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { ...styles.statusMeta, margin: 0 }, children: [
        copy.reviewTitle,
        " \xB7 ",
        copy.reviewHint
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", gap: 8, marginTop: 6 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void loadReview(), children: copy.reviewTitle }) }),
      review !== null && review.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.rowHint, children: copy.reviewEmpty }) : null,
      review !== null && review.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflow: "auto", marginTop: 6 }, children: review.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { display: "flex", gap: 8, alignItems: "flex-start" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { flex: 1, minWidth: 0 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...styles.rowHint, margin: 0 }, children: item.id.slice(0, 13) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...styles.statusMeta, margin: 0, wordBreak: "break-word" }, children: item.body })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void decide(item.id, "accept"), children: copy.accept }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void decide(item.id, "reject"), children: copy.reject })
      ] }, item.id)) }) : null
    ] }),
    error !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.errorText, children: [
      copy.manageError,
      ": ",
      error
    ] }) : null
  ] });
}
function ToggleRow(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-phone-noema-row", style: styles.row, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.rowText, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowLabel, children: props.copy[props.labelKey] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowHint, children: props.copy[props.hintKey] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        type: "checkbox",
        style: styles.switch,
        checked: props.checked,
        disabled: props.disabled,
        onChange: (event) => props.onChange(event.target.checked)
      }
    )
  ] });
}
function TextRow(props) {
  const [draft, setDraft] = (0, import_react.useState)(props.value);
  (0, import_react.useEffect)(() => {
    setDraft(props.value);
  }, [props.value]);
  const commit = () => {
    if (draft === props.value) return;
    props.onCommit(draft);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-phone-noema-row", style: styles.row, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.rowText, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowLabel, children: props.copy[props.labelKey] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowHint, children: props.copy[props.hintKey] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        type: "text",
        style: styles.input,
        value: draft,
        disabled: props.disabled,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === "Enter") commit();
        }
      }
    )
  ] });
}
function SourcesRow(props) {
  const toggle = (id, enabled) => {
    const next = enabled ? props.selected.includes(id) ? props.selected : [...props.selected, id] : props.selected.filter((current) => current !== id);
    props.onToggle(next);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-phone-noema-row", style: styles.row, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.rowText, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowLabel, children: props.copy.importSources }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowHint, children: props.copy.importSourcesHint }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: 8 }, children: IMPORT_SOURCE_LABELS.map(([id, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, lineHeight: "20px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "checkbox",
          style: styles.switch,
          checked: props.selected.includes(id),
          disabled: props.disabled,
          onChange: (event) => toggle(id, event.target.checked)
        }
      ),
      label
    ] }, id)) })
  ] }) });
}
function NumberRow(props) {
  const [draft, setDraft] = (0, import_react.useState)(String(props.value));
  (0, import_react.useEffect)(() => {
    setDraft(String(props.value));
  }, [props.value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(props.value));
      return;
    }
    if (parsed === props.value) return;
    props.onCommit(parsed);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-phone-noema-row", style: styles.row, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.rowText, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowLabel, children: props.copy[props.labelKey] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.rowHint, children: props.copy[props.hintKey] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        type: "number",
        style: styles.input,
        value: draft,
        disabled: props.disabled,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === "Enter") commit();
        }
      }
    )
  ] });
}
function NoemaMemorySettingsPanel({ ctx }) {
  const locale = (0, import_react.useSyncExternalStore)(
    (notify) => ctx.on("locale/change", notify),
    () => ctx.locale.getLocale().active,
    () => ctx.locale.getLocale().active
  );
  const copy = COPY[locale === "zh" ? "zh" : "en"];
  const [notice, setNotice] = (0, import_react.useState)(null);
  const noticeTimer = (0, import_react.useRef)();
  const [status, setStatus] = (0, import_react.useState)(null);
  const [loaded, setLoaded] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const settings = status?.config;
  const writable = status?.writable === true;
  const showNotice = (0, import_react.useCallback)((text) => {
    setNotice(text);
    if (noticeTimer.current !== void 0) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  }, []);
  const setField = (0, import_react.useCallback)(async (field, value) => {
    setBusy(true);
    try {
      const response = await fetch(NOEMA_STATUS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "configure", field, value })
      });
      const next = await response.json();
      if (!response.ok || !next.ok) throw new Error(next.error ?? "settings write failed");
      setStatus(next);
      showNotice(copy.saved);
    } catch {
      showNotice(copy.notWritable);
    } finally {
      setBusy(false);
    }
  }, [showNotice, copy.saved, copy.notWritable]);
  const refreshStatus = (0, import_react.useCallback)(async () => {
    setBusy(true);
    try {
      const response = await fetch(NOEMA_STATUS_ROUTE, { cache: "no-store" });
      setStatus(await response.json());
    } catch {
      setStatus(null);
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, []);
  const runAction = (0, import_react.useCallback)(async (action) => {
    setBusy(true);
    try {
      const response = await fetch(NOEMA_STATUS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      });
      const payload = await response.json();
      setStatus(payload);
      if (action === "import") showNotice(copy.saved);
    } catch {
      setStatus(null);
      showNotice(copy.notWritable);
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, [showNotice, copy.saved, copy.notWritable]);
  (0, import_react.useEffect)(() => {
    void refreshStatus();
  }, [refreshStatus]);
  if (!loaded && settings === void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-phone-noema", style: styles.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AutomaticMemoryCard, {}),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.intro, children: copy.loading })
    ] });
  }
  if (settings === void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-phone-noema", style: styles.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AutomaticMemoryCard, {}),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.intro, children: copy.unavailable })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-phone-noema", style: styles.section, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: styles.title, children: copy.title }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.intro, children: copy.intro }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AutomaticMemoryCard, {}),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { children: locale === "zh" ? "\u9AD8\u7EA7\u8BB0\u5FC6\u8BBE\u7F6E" : "Advanced memory settings" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "enabled", hintKey: "enabledHint", checked: settings.enabled, disabled: !writable || busy, onChange: (next) => setField("enabled", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "guidance", hintKey: "guidanceHint", checked: settings.guidance, disabled: !writable || busy, onChange: (next) => setField("guidance", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "autoStart", hintKey: "autoStartHint", checked: settings.autoStart, disabled: !writable || busy, onChange: (next) => setField("autoStart", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "acceptByDefault", hintKey: "acceptByDefaultHint", checked: settings.acceptByDefault, disabled: !writable || busy, onChange: (next) => setField("acceptByDefault", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextRow, { copy, labelKey: "command", hintKey: "commandHint", value: settings.command, disabled: !writable || busy, onCommit: (next) => setField("command", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextRow, { copy, labelKey: "workingDirectory", hintKey: "workingDirectoryHint", value: settings.workingDirectory, disabled: !writable || busy, onCommit: (next) => setField("workingDirectory", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextRow, { copy, labelKey: "noemaRoot", hintKey: "noemaRootHint", value: settings.noemaRoot, disabled: !writable || busy, onCommit: (next) => setField("noemaRoot", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberRow, { copy, labelKey: "recallBudget", hintKey: "recallBudgetHint", value: settings.recallBudgetTokens, disabled: !writable || busy, onCommit: (next) => next === void 0 ? void 0 : setField("recallBudgetTokens", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberRow, { copy, labelKey: "idleTimeout", hintKey: "idleTimeoutHint", value: settings.idleTimeoutMs, disabled: !writable || busy, onCommit: (next) => next === void 0 ? void 0 : setField("idleTimeoutMs", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "keepAlive", hintKey: "keepAliveHint", checked: settings.keepAlive, disabled: !writable || busy, onChange: (next) => setField("keepAlive", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberRow, { copy, labelKey: "keepAliveInterval", hintKey: "keepAliveIntervalHint", value: settings.keepAliveIntervalMs, disabled: !writable || busy, onCommit: (next) => next === void 0 ? void 0 : setField("keepAliveIntervalMs", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberRow, { copy, labelKey: "callTimeout", hintKey: "callTimeoutHint", value: settings.callTimeoutMs, disabled: !writable || busy, onCommit: (next) => next === void 0 ? void 0 : setField("callTimeoutMs", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberRow, { copy, labelKey: "restartDelay", hintKey: "restartDelayHint", value: settings.restartDelayMs, disabled: !writable || busy, onCommit: (next) => next === void 0 ? void 0 : setField("restartDelayMs", next) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.note, children: copy.restartNote })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: styles.title, children: copy.importTitle }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.intro, children: copy.importHint }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "importEnabled", hintKey: "importEnabledHint", checked: settings.importEnabled, disabled: !writable || busy, onChange: (next) => setField("importEnabled", next) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "importOnStartup", hintKey: "importOnStartupHint", checked: settings.importOnStartup, disabled: !writable || busy, onChange: (next) => setField("importOnStartup", next) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToggleRow, { copy, labelKey: "importWorkspaceFiles", hintKey: "importWorkspaceFilesHint", checked: settings.importWorkspaceFiles, disabled: !writable || busy, onChange: (next) => setField("importWorkspaceFiles", next) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberRow, { copy, labelKey: "importMaxBytes", hintKey: "importMaxBytesHint", value: settings.importMaxBytes, disabled: !writable || busy, onCommit: (next) => next === void 0 ? void 0 : setField("importMaxBytes", next) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SourcesRow, { copy, selected: settings.importSources ?? [], disabled: !writable || busy, onToggle: (next) => setField("importSources", next) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MemoryManagerCard, { copy }),
    notice !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.saved, children: notice }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.statusCard, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.statusHead, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.dot, background: dotColor(status?.state, status?.ok ?? false) } }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: styles.statusLabel, children: [
          copy.status,
          ": ",
          status === null ? copy.statusUnavailable : statusLabel(copy, status)
        ] })
      ] }),
      status?.lastError !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.errorText, children: status.lastError }) : null,
      status?.pid !== void 0 && status.startedAt !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.statusMeta, children: [
        "pid ",
        status.pid,
        " \xB7 up ",
        millisecondsAgo(status.startedAt)
      ] }) : null,
      status?.server !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: styles.statusJson, children: JSON.stringify(status.server, null, 2) }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.actions, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy || !settings.importEnabled, onClick: () => void runAction("import"), children: copy.importNow }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void runAction("restart"), children: copy.restart }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void runAction("stop"), children: copy.stop }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: styles.button, disabled: busy, onClick: () => void refreshStatus(), children: copy.refresh })
      ] }),
      (() => {
        const last = status?.import ?? status?.lastImport;
        if (last === void 0) return null;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.statusMeta, children: [
            copy.importLast,
            ": ",
            last.imported,
            " imported \xB7 ",
            last.skipped,
            " skipped \xB7 ",
            last.totalFiles,
            " files"
          ] }),
          last.errors.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: styles.statusJson, children: last.errors.slice(0, 8).join("\n") }) : null
        ] });
      })()
    ] })
  ] });
}
function apply(ctx) {
  const Panel = () => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NoemaMemorySettingsPanel, { ctx });
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    {
      name: "settings.section",
      id: "noema-memory",
      order: 29,
      label: () => ctx.locale.getLocale().active === "zh" ? "\u8BB0\u5FC6" : "Memory"
    },
    Panel
  ));
}

return module.exports; } });
