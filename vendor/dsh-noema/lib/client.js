window.__ModuleLoader__.load({ id: "@zseven-w/dsh-noema", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/names.ts
/** Web route the settings panel uses to read server health and restart it. */
const NOEMA_STATUS_ROUTE = "/_dsh/dsh-noema/status";
//#endregion
//#region src/client/index.tsx
/**
* Browser half of dsh-noema: a settings section for the memory configuration.
*
* The panel edits the noema-memory settings namespace one field at a time
* through the plugin's loopback route, which also feeds a live status card
* and accepts start/stop/restart actions.
*/
/** Client services required by this plugin. */
const inject = ["slots", "locale"];
/** Tool ids with fixed display labels for the import source picker. */
const IMPORT_SOURCE_LABELS = [
	["codex", "Codex"],
	["claude-code", "Claude Code"],
	["opencode", "opencode"],
	["cursor", "Cursor"],
	["grok", "Grok"],
	["workbuddy", "WorkBuddy"],
	["antigravity", "Antigravity"],
	["trae", "Trae"],
	["qoder", "Qoder"]
];
const COPY = {
	en: {
		title: "Noema Memory",
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
		statusStarting: "Starting…",
		statusError: "Error",
		restart: "Restart",
		stop: "Stop",
		refresh: "Refresh",
		saved: "Saved",
		notWritable: "Settings are not writable in this session",
		loading: "Loading settings…",
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
		searchPlaceholder: "Search memories…",
		searchButton: "Search",
		addPlaceholder: "Add a durable memory…",
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
		backToGroups: "← Back to topics",
		groups: "Topics"
	},
	zh: {
		title: "Noema 记忆",
		intro: "为 DSH 提供长期记忆，以可检查的本地文件存储。服务器命令、工作目录与记忆根目录的修改在记忆服务器重启后生效。",
		enabled: "启用记忆",
		enabledHint: "关闭后，所有 noema_* 工具会以清晰的错误信息快速失败。",
		guidance: "记忆引导",
		guidanceHint: "教会模型何时调用记忆、何时保存持久记忆。",
		autoStart: "启动时启动服务器",
		autoStartHint: "DSH 启动时即拉起 Noema 服务器，而不是首次使用时才启动。",
		acceptByDefault: "自动接受新记忆",
		acceptByDefaultHint: "noema_remember 立即持久化，而不是留下待审候选。",
		command: "服务器命令",
		commandHint: "使用 bundled 启动随插件安装的 noema-mcp，也可以填写自定义可执行文件路径或命令。",
		workingDirectory: "工作目录",
		workingDirectoryHint: "服务器进程的工作目录（cargo 命令需要）。留空使用默认值。",
		noemaRoot: "记忆根目录 (NOEMA_ROOT)",
		noemaRootHint: "记忆存储位置。留空使用 Noema 默认目录 (~/.agent-memory)。",
		recallBudget: "召回 token 预算",
		recallBudgetHint: "未指定 budget_tokens 时 noema_recall 使用的默认预算。",
		idleTimeout: "空闲超时 (ms)",
		idleTimeoutHint: "空闲超过该毫秒数后停止服务器。0 表示永不停止。",
		keepAlive: "保活",
		keepAliveHint: "记忆服务器崩溃或退出时自动在后台重启。",
		keepAliveInterval: "保活间隔 (ms)",
		keepAliveIntervalHint: "后台健康检查的最小间隔。",
		callTimeout: "调用超时 (ms)",
		callTimeoutHint: "单次工具调用访问记忆服务器的截止时间。",
		restartDelay: "重启延迟 (ms)",
		restartDelayHint: "停止/崩溃后再次自动启动的最小间隔。",
		restartNote: "服务器命令、工作目录与记忆根目录的修改在记忆服务器重启后生效。",
		status: "记忆服务器",
		statusRunning: "运行中",
		statusStopped: "已停止",
		statusUnavailable: "不可用",
		statusStarting: "启动中…",
		statusError: "错误",
		restart: "重启",
		stop: "停止",
		refresh: "刷新",
		saved: "已保存",
		notWritable: "当前会话中设置不可写",
		loading: "正在加载设置…",
		unavailable: "当前浏览器会话中记忆设置不可用",
		importTitle: "从其他工具导入记忆",
		importHint: "读取其他 AI 编程工具的 AGENTS.md / CLAUDE.md / .cursor 规则文件，把每个小节保存为一条持久 Noema 记忆。重复运行会跳过已导入的内容。",
		importEnabled: "启用记忆导入",
		importEnabledHint: "noema_import 工具与下方导入按钮的总开关。",
		importOnStartup: "启动时自动导入",
		importOnStartupHint: "插件每次挂载时自动执行一次去重导入。",
		importWorkspaceFiles: "包含工作区文件",
		importWorkspaceFilesHint: "同时导入会话工作区内的 AGENTS.md / CLAUDE.md / 规则文件。",
		importMaxBytes: "文件大小上限 (bytes)",
		importMaxBytesHint: "超过该大小的记忆文件在导入前被截断。",
		importSources: "来源",
		importSourcesHint: "导入时读取哪些工具的记忆文件。",
		importNow: "立即导入",
		importLast: "上次导入",
		importEmpty: "本会话中还没有执行过导入。",
		manageTitle: "管理记忆",
		manageHint: "直接搜索、添加、审阅和删除已存储的记忆。",
		searchPlaceholder: "搜索记忆…",
		searchButton: "搜索",
		addPlaceholder: "添加一条持久记忆…",
		addButton: "添加",
		forget: "删除",
		noResults: "没有匹配的记忆。",
		reviewTitle: "审阅队列",
		reviewHint: "等待决定的候选记忆。",
		accept: "接受",
		reject: "拒绝",
		reviewEmpty: "没有待审候选。",
		manageError: "记忆操作失败",
		viewAll: "查看全部记忆",
		viewAllHint: "按主题浏览完整记忆目录。",
		viewAllEmpty: "记忆目录为空。",
		backToGroups: "← 返回主题",
		groups: "主题"
	}
};
/** DSH-token-based styling: no hardcoded colors, no UI package deps. */
const styles = {
	section: {
		maxWidth: 720,
		display: "flex",
		flexDirection: "column",
		gap: 12,
		color: "var(--dsw-alias-label-primary)"
	},
	title: {
		margin: 0,
		fontSize: 16,
		fontWeight: 500,
		lineHeight: "24px"
	},
	intro: {
		margin: 0,
		fontSize: 14,
		lineHeight: "22px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	note: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	row: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: 12,
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 12,
		padding: "12px 14px",
		background: "var(--dsw-alias-bg-container)"
	},
	rowText: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		minWidth: 0,
		flex: 1
	},
	rowLabel: {
		fontSize: 14,
		fontWeight: 500,
		lineHeight: "22px"
	},
	rowHint: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	input: {
		boxSizing: "border-box",
		width: 200,
		flex: "none",
		height: 32,
		padding: "4px 10px",
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		background: "var(--dsw-alias-bg-input)",
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 8
	},
	switch: {
		flex: "none",
		margin: 0,
		accentColor: "var(--dsw-alias-button-primary-fill)"
	},
	statusCard: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 12,
		padding: "12px 14px"
	},
	statusHead: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	dot: {
		boxSizing: "border-box",
		width: 8,
		height: 8,
		borderRadius: "50%",
		flex: "none"
	},
	statusLabel: {
		fontSize: 14,
		fontWeight: 500
	},
	statusMeta: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)",
		wordBreak: "break-all"
	},
	statusJson: {
		margin: 0,
		fontSize: 11,
		lineHeight: "16px",
		color: "var(--dsw-alias-label-tertiary)",
		whiteSpace: "pre-wrap",
		wordBreak: "break-all",
		maxHeight: 160,
		overflow: "auto"
	},
	actions: {
		display: "flex",
		gap: 8,
		marginTop: 4
	},
	button: {
		boxSizing: "border-box",
		height: 28,
		padding: "0 12px",
		fontSize: 12,
		lineHeight: "18px",
		borderRadius: 14,
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "transparent",
		color: "var(--dsw-alias-label-primary)",
		cursor: "pointer"
	},
	saved: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-success-primary)",
		margin: 0
	},
	errorText: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-error-primary)",
		margin: 0
	}
};
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
			if (Array.isArray(memories)) return memories.filter((memory) => typeof memory === "object" && memory !== null && typeof memory.id === "string");
		}
	} catch {}
	return [];
}
function parseCatalogGroups(text) {
	const groups = [];
	for (const line of text.split("\n")) {
		const match = /^##\s+(.+?)\s+\((\d+) memories?\)$/.exec(line);
		if (match !== null) groups.push({
			title: match[1],
			count: Number(match[2])
		});
	}
	return groups;
}
function parseBrowseText(text) {
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((memory) => typeof memory === "object" && memory !== null && typeof memory.id === "string");
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
			return space < 0 ? {
				id: item,
				body: ""
			} : {
				id: item.slice(0, space),
				body: item.slice(space + 1)
			};
		});
	} catch {
		return [];
	}
}
/** In-panel memory management: search, add, forget, and the review queue. */
function MemoryManagerCard(props) {
	const copy = props.copy;
	const [query, setQuery] = (0, react.useState)("");
	const [addText, setAddText] = (0, react.useState)("");
	const [memories, setMemories] = (0, react.useState)(null);
	const [catalog, setCatalog] = (0, react.useState)(null);
	const [expanded, setExpanded] = (0, react.useState)(null);
	const [browsed, setBrowsed] = (0, react.useState)(null);
	const [review, setReview] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const post = (0, react.useCallback)(async (payload) => {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(NOEMA_STATUS_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "memory",
					...payload
				})
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
	const search = (0, react.useCallback)(async () => {
		if (query.trim() === "") return;
		const result = await post({
			op: "search",
			query
		});
		setMemories(result.ok && result.text !== void 0 ? parseRecallText(result.text) : null);
	}, [query, post]);
	const add = (0, react.useCallback)(async () => {
		if (addText.trim() === "") return;
		if ((await post({
			op: "add",
			text: addText
		})).ok) {
			setAddText("");
			setQuery(addText.trim());
			const refreshed = await post({
				op: "search",
				query: addText.trim()
			});
			setMemories(refreshed.ok && refreshed.text !== void 0 ? parseRecallText(refreshed.text) : memories);
		}
	}, [
		addText,
		post,
		memories
	]);
	const forget = (0, react.useCallback)(async (memoryId) => {
		if ((await post({
			op: "forget",
			memory_id: memoryId
		})).ok) {
			setMemories((current) => current === null ? current : current.filter((memory) => memory.id !== memoryId));
			setBrowsed((current) => current === null ? current : current.filter((memory) => memory.id !== memoryId));
		}
	}, [post]);
	const viewAll = (0, react.useCallback)(async () => {
		const result = await post({ op: "catalog" });
		if (result.ok && result.text !== void 0) {
			setCatalog(parseCatalogGroups(result.text).sort((a, b) => b.count - a.count));
			setExpanded(null);
			setBrowsed(null);
		} else setCatalog(null);
	}, [post]);
	const openGroup = (0, react.useCallback)(async (title) => {
		const result = await post({
			op: "browse",
			query: title,
			limit: 30
		});
		if (result.ok && result.text !== void 0) {
			setExpanded(title);
			setBrowsed(parseBrowseText(result.text));
		}
	}, [post]);
	const loadReview = (0, react.useCallback)(async () => {
		const result = await post({ op: "review" });
		setReview(result.ok && result.text !== void 0 ? parseReviewText(result.text) : null);
	}, [post]);
	const decide = (0, react.useCallback)(async (candidateId, decision) => {
		if ((await post({
			op: "review_decide",
			candidate_id: candidateId,
			decision
		})).ok) setReview((current) => current === null ? current : current.filter((item) => item.id !== candidateId));
	}, [post]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles.statusCard,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
				style: {
					...styles.title,
					fontSize: 14
				},
				children: copy.manageTitle
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.rowHint,
				children: copy.manageHint
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "text",
					style: {
						...styles.input,
						width: "100%",
						flex: 1
					},
					value: query,
					placeholder: copy.searchPlaceholder,
					disabled: busy,
					onChange: (event) => setQuery(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter") search();
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					style: styles.button,
					disabled: busy,
					onClick: () => void search(),
					children: copy.searchButton
				})]
			}),
			memories !== null && memories.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.rowHint,
				children: copy.noResults
			}) : null,
			memories !== null && memories.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				style: {
					listStyle: "none",
					margin: 0,
					padding: 0,
					display: "flex",
					flexDirection: "column",
					gap: 6,
					maxHeight: 260,
					overflow: "auto"
				},
				children: memories.map((memory) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					style: {
						display: "flex",
						gap: 8,
						alignItems: "flex-start",
						borderTop: "1px solid var(--dsw-alias-border-l2)",
						paddingTop: 6
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: 1,
							minWidth: 0
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: {
								...styles.rowHint,
								margin: 0
							},
							children: [
								memory.kind ?? "memory",
								" · ",
								memory.id.slice(0, 13)
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								...styles.statusMeta,
								margin: 0,
								wordBreak: "break-word"
							},
							children: (memory.text ?? "").length > 240 ? memory.text.slice(0, 240) + "…" : memory.text
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: styles.button,
						disabled: busy,
						onClick: () => void forget(memory.id),
						children: copy.forget
					})]
				}, memory.id))
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					borderTop: "1px solid var(--dsw-alias-border-l2)",
					paddingTop: 8
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...styles.statusMeta,
							margin: 0
						},
						children: copy.viewAllHint
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8,
							marginTop: 6
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button,
							disabled: busy,
							onClick: () => void viewAll(),
							children: copy.viewAll
						}), expanded !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button,
							disabled: busy,
							onClick: () => {
								setExpanded(null);
								setBrowsed(null);
							},
							children: copy.backToGroups
						}) : null]
					}),
					catalog !== null && catalog.length === 0 && expanded === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.rowHint,
						children: copy.viewAllEmpty
					}) : null,
					catalog !== null && expanded === null && catalog.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: {
							...styles.statusMeta,
							margin: "6px 0 0"
						},
						children: [copy.groups, ":"]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: {
							listStyle: "none",
							margin: "6px 0 0",
							padding: 0,
							display: "flex",
							flexWrap: "wrap",
							gap: 6,
							maxHeight: 160,
							overflow: "auto"
						},
						children: catalog.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							style: {
								...styles.button,
								height: "auto",
								padding: "3px 10px",
								lineHeight: "18px"
							},
							disabled: busy,
							onClick: () => void openGroup(group.title),
							children: [
								group.title,
								" (",
								group.count,
								")"
							]
						}) }, group.title))
					})] }) : null,
					expanded !== null && browsed !== null && browsed.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.rowHint,
						children: copy.noResults
					}) : null,
					expanded !== null && browsed !== null && browsed.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: {
							listStyle: "none",
							margin: "6px 0 0",
							padding: 0,
							display: "flex",
							flexDirection: "column",
							gap: 6,
							maxHeight: 320,
							overflow: "auto"
						},
						children: browsed.map((memory) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							style: {
								display: "flex",
								gap: 8,
								alignItems: "flex-start",
								borderTop: "1px solid var(--dsw-alias-border-l2)",
								paddingTop: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									flex: 1,
									minWidth: 0
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									style: {
										...styles.rowHint,
										margin: 0
									},
									children: [
										memory.kind ?? "memory",
										" · ",
										memory.id.slice(0, 13)
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										...styles.statusMeta,
										margin: 0,
										wordBreak: "break-word"
									},
									children: (memory.text ?? "").length > 240 ? memory.text.slice(0, 240) + "…" : memory.text
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								disabled: busy,
								onClick: () => void forget(memory.id),
								children: copy.forget
							})]
						}, memory.id))
					}) : null
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "text",
					style: {
						...styles.input,
						width: "100%",
						flex: 1
					},
					value: addText,
					placeholder: copy.addPlaceholder,
					disabled: busy,
					onChange: (event) => setAddText(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter") add();
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					style: styles.button,
					disabled: busy,
					onClick: () => void add(),
					children: copy.addButton
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					borderTop: "1px solid var(--dsw-alias-border-l2)",
					paddingTop: 8
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: {
							...styles.statusMeta,
							margin: 0
						},
						children: [
							copy.reviewTitle,
							" · ",
							copy.reviewHint
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							gap: 8,
							marginTop: 6
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button,
							disabled: busy,
							onClick: () => void loadReview(),
							children: copy.reviewTitle
						})
					}),
					review !== null && review.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.rowHint,
						children: copy.reviewEmpty
					}) : null,
					review !== null && review.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: {
							listStyle: "none",
							margin: 0,
							padding: 0,
							display: "flex",
							flexDirection: "column",
							gap: 6,
							maxHeight: 200,
							overflow: "auto",
							marginTop: 6
						},
						children: review.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							style: {
								display: "flex",
								gap: 8,
								alignItems: "flex-start"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										flex: 1,
										minWidth: 0
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: {
											...styles.rowHint,
											margin: 0
										},
										children: item.id.slice(0, 13)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: {
											...styles.statusMeta,
											margin: 0,
											wordBreak: "break-word"
										},
										children: item.body
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.button,
									disabled: busy,
									onClick: () => void decide(item.id, "accept"),
									children: copy.accept
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.button,
									disabled: busy,
									onClick: () => void decide(item.id, "reject"),
									children: copy.reject
								})
							]
						}, item.id))
					}) : null
				]
			}),
			error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: styles.errorText,
				children: [
					copy.manageError,
					": ",
					error
				]
			}) : null
		]
	});
}
/** One labelled row with a checkbox control. */
function ToggleRow(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-phone-noema-row", style: styles.row,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: styles.rowText,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.rowLabel,
				children: props.copy[props.labelKey]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.rowHint,
				children: props.copy[props.hintKey]
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			type: "checkbox",
			style: styles.switch,
			checked: props.checked,
			disabled: props.disabled,
			onChange: (event) => props.onChange(event.target.checked)
		})]
	});
}
/** One labelled row with a text control committing on blur/Enter. */
function TextRow(props) {
	const [draft, setDraft] = (0, react.useState)(props.value);
	(0, react.useEffect)(() => {
		setDraft(props.value);
	}, [props.value]);
	const commit = () => {
		if (draft === props.value) return;
		props.onCommit(draft);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-phone-noema-row", style: styles.row,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: styles.rowText,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.rowLabel,
				children: props.copy[props.labelKey]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.rowHint,
				children: props.copy[props.hintKey]
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			type: "text",
			style: styles.input,
			value: draft,
			disabled: props.disabled,
			onChange: (event) => setDraft(event.target.value),
			onBlur: commit,
			onKeyDown: (event) => {
				if (event.key === "Enter") commit();
			}
		})]
	});
}
/** One card with a checkbox per memory-import source. */
function SourcesRow(props) {
	const toggle = (id, enabled) => {
		const next = enabled ? props.selected.includes(id) ? props.selected : [...props.selected, id] : props.selected.filter((current) => current !== id);
		props.onToggle(next);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: "dsh-phone-noema-row", style: styles.row,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: styles.rowText,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.rowLabel,
					children: props.copy.importSources
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.rowHint,
					children: props.copy.importSourcesHint
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						display: "flex",
						flexWrap: "wrap",
						gap: "6px 14px",
						marginTop: 8
					},
					children: IMPORT_SOURCE_LABELS.map(([id, label]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
							fontSize: 13,
							lineHeight: "20px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							style: styles.switch,
							checked: props.selected.includes(id),
							disabled: props.disabled,
							onChange: (event) => toggle(id, event.target.checked)
						}), label]
					}, id))
				})
			]
		})
	});
}
/** One labelled row with a numeric control committing on blur/Enter. */
function NumberRow(props) {
	const [draft, setDraft] = (0, react.useState)(String(props.value));
	(0, react.useEffect)(() => {
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
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-phone-noema-row", style: styles.row,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: styles.rowText,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.rowLabel,
				children: props.copy[props.labelKey]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.rowHint,
				children: props.copy[props.hintKey]
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			type: "number",
			style: styles.input,
			value: draft,
			disabled: props.disabled,
			onChange: (event) => setDraft(event.target.value),
			onBlur: commit,
			onKeyDown: (event) => {
				if (event.key === "Enter") commit();
			}
		})]
	});
}
/** The settings section body. */
function NoemaMemorySettingsPanel({ ctx }) {
	const locale = (0, react.useSyncExternalStore)((notify) => ctx.on("locale/change", notify), () => ctx.locale.getLocale().active, () => ctx.locale.getLocale().active);
	const copy = COPY[locale === "zh" ? "zh" : "en"];
	const [notice, setNotice] = (0, react.useState)(null);
	const noticeTimer = (0, react.useRef)();
	const [status, setStatus] = (0, react.useState)(null);
	const [loaded, setLoaded] = (0, react.useState)(false);
	const [busy, setBusy] = (0, react.useState)(false);
	const settings = status?.config;
	const writable = status?.writable === true;
	const showNotice = (0, react.useCallback)((text) => {
		setNotice(text);
		if (noticeTimer.current !== void 0) clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(null), 2500);
	}, []);
	const setField = (0, react.useCallback)(async (field, value) => {
		setBusy(true);
		try {
			const response = await fetch(NOEMA_STATUS_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "configure",
					field,
					value
				})
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
	}, [
		showNotice,
		copy.saved,
		copy.notWritable
	]);
	const refreshStatus = (0, react.useCallback)(async () => {
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
	const runAction = (0, react.useCallback)(async (action) => {
		setBusy(true);
		try {
			const payload = await (await fetch(NOEMA_STATUS_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action })
			})).json();
			setStatus(payload);
			if (action === "import") showNotice(copy.saved);
		} catch {
			setStatus(null);
			showNotice(copy.notWritable);
		} finally {
			setLoaded(true);
			setBusy(false);
		}
	}, [
		showNotice,
		copy.saved,
		copy.notWritable
	]);
	(0, react.useEffect)(() => {
		refreshStatus();
	}, [refreshStatus]);
	if (!loaded && settings === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
		className: "dsh-phone-noema", style: styles.section,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: styles.intro,
			children: copy.loading
		})
	});
	if (settings === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
		className: "dsh-phone-noema", style: styles.section,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: styles.intro,
			children: copy.unavailable
		})
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "dsh-phone-noema", style: styles.section,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				style: styles.title,
				children: copy.title
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.intro,
				children: copy.intro
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "enabled",
				hintKey: "enabledHint",
				checked: settings.enabled,
				disabled: !writable || busy,
				onChange: (next) => setField("enabled", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "guidance",
				hintKey: "guidanceHint",
				checked: settings.guidance,
				disabled: !writable || busy,
				onChange: (next) => setField("guidance", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "autoStart",
				hintKey: "autoStartHint",
				checked: settings.autoStart,
				disabled: !writable || busy,
				onChange: (next) => setField("autoStart", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "acceptByDefault",
				hintKey: "acceptByDefaultHint",
				checked: settings.acceptByDefault,
				disabled: !writable || busy,
				onChange: (next) => setField("acceptByDefault", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextRow, {
				copy,
				labelKey: "command",
				hintKey: "commandHint",
				value: settings.command,
				disabled: !writable || busy,
				onCommit: (next) => setField("command", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextRow, {
				copy,
				labelKey: "workingDirectory",
				hintKey: "workingDirectoryHint",
				value: settings.workingDirectory,
				disabled: !writable || busy,
				onCommit: (next) => setField("workingDirectory", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextRow, {
				copy,
				labelKey: "noemaRoot",
				hintKey: "noemaRootHint",
				value: settings.noemaRoot,
				disabled: !writable || busy,
				onCommit: (next) => setField("noemaRoot", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
				copy,
				labelKey: "recallBudget",
				hintKey: "recallBudgetHint",
				value: settings.recallBudgetTokens,
				disabled: !writable || busy,
				onCommit: (next) => next === void 0 ? void 0 : setField("recallBudgetTokens", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
				copy,
				labelKey: "idleTimeout",
				hintKey: "idleTimeoutHint",
				value: settings.idleTimeoutMs,
				disabled: !writable || busy,
				onCommit: (next) => next === void 0 ? void 0 : setField("idleTimeoutMs", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "keepAlive",
				hintKey: "keepAliveHint",
				checked: settings.keepAlive,
				disabled: !writable || busy,
				onChange: (next) => setField("keepAlive", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
				copy,
				labelKey: "keepAliveInterval",
				hintKey: "keepAliveIntervalHint",
				value: settings.keepAliveIntervalMs,
				disabled: !writable || busy,
				onCommit: (next) => next === void 0 ? void 0 : setField("keepAliveIntervalMs", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
				copy,
				labelKey: "callTimeout",
				hintKey: "callTimeoutHint",
				value: settings.callTimeoutMs,
				disabled: !writable || busy,
				onCommit: (next) => next === void 0 ? void 0 : setField("callTimeoutMs", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
				copy,
				labelKey: "restartDelay",
				hintKey: "restartDelayHint",
				value: settings.restartDelayMs,
				disabled: !writable || busy,
				onCommit: (next) => next === void 0 ? void 0 : setField("restartDelayMs", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.note,
				children: copy.restartNote
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
				style: styles.title,
				children: copy.importTitle
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.intro,
				children: copy.importHint
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "importEnabled",
				hintKey: "importEnabledHint",
				checked: settings.importEnabled,
				disabled: !writable || busy,
				onChange: (next) => setField("importEnabled", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "importOnStartup",
				hintKey: "importOnStartupHint",
				checked: settings.importOnStartup,
				disabled: !writable || busy,
				onChange: (next) => setField("importOnStartup", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
				copy,
				labelKey: "importWorkspaceFiles",
				hintKey: "importWorkspaceFilesHint",
				checked: settings.importWorkspaceFiles,
				disabled: !writable || busy,
				onChange: (next) => setField("importWorkspaceFiles", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
				copy,
				labelKey: "importMaxBytes",
				hintKey: "importMaxBytesHint",
				value: settings.importMaxBytes,
				disabled: !writable || busy,
				onCommit: (next) => next === void 0 ? void 0 : setField("importMaxBytes", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourcesRow, {
				copy,
				selected: settings.importSources ?? [],
				disabled: !writable || busy,
				onToggle: (next) => setField("importSources", next)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryManagerCard, { copy }),
			notice !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.saved,
				children: notice
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.statusCard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.statusHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
							...styles.dot,
							background: dotColor(status?.state, status?.ok ?? false)
						} }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: styles.statusLabel,
							children: [
								copy.status,
								": ",
								status === null ? copy.statusUnavailable : statusLabel(copy, status)
							]
						})]
					}),
					status?.lastError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.errorText,
						children: status.lastError
					}) : null,
					status?.pid !== void 0 && status.startedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: styles.statusMeta,
						children: [
							"pid ",
							status.pid,
							" · up ",
							millisecondsAgo(status.startedAt)
						]
					}) : null,
					status?.server !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: styles.statusJson,
						children: JSON.stringify(status.server, null, 2)
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.actions,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								disabled: busy || !settings.importEnabled,
								onClick: () => void runAction("import"),
								children: copy.importNow
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								disabled: busy,
								onClick: () => void runAction("restart"),
								children: copy.restart
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								disabled: busy,
								onClick: () => void runAction("stop"),
								children: copy.stop
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								disabled: busy,
								onClick: () => void refreshStatus(),
								children: copy.refresh
							})
						]
					}),
					(() => {
						const last = status?.import ?? status?.lastImport;
						if (last === void 0) return null;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								borderTop: "1px solid var(--dsw-alias-border-l2)",
								paddingTop: 8
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: styles.statusMeta,
								children: [
									copy.importLast,
									": ",
									last.imported,
									" imported · ",
									last.skipped,
									" skipped · ",
									last.totalFiles,
									" files"
								]
							}), last.errors.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								style: styles.statusJson,
								children: last.errors.slice(0, 8).join("\n")
							}) : null]
						});
					})()
				]
			})
		]
	});
}
/** Register the settings section slot. */
function apply(ctx) {
	const Panel = () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NoemaMemorySettingsPanel, { ctx });
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "noema-memory",
		order: 60,
		label: () => ctx.locale.getLocale().active === "zh" ? "Noema 记忆" : "Noema Memory"
	}, Panel));
}
//#endregion
exports.NoemaMemorySettingsPanel = NoemaMemorySettingsPanel;
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
