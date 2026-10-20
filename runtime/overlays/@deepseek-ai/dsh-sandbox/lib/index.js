import { Service } from "@deepseek-ai/cordis";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
//#region lib/types/escalation.js
/**
* The escalation vocabulary and choreography shared by every sandbox-enforcing
* tool family (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-fs`): the
* strictly-wider ladder, the argument-pairing validation, the model-facing
* denial/hint markers, and {@link approveEscalation} — the ordered fail-closed
* sequence that resolves a `sandbox_permissions` request through a
* user-approval channel BEFORE anything executes. One home keeps the two
* families' approval ordering and verbatim error texts from drifting apart.
*
* The channel is a minimal STRUCTURAL function shape ({@link EscalationAsk}),
* not the approval service type: the tool layer — which owns the agent, the
* call id, and the tool name — closes over `ctx.approval.request(...)` and
* hands the closure down, so this package never depends on the approval or
* agent packages.
*
* @module dsh-sandbox/escalation
*/
/**
* The strictly-wider table: what a call whose effective mode is the key may
* escalate TO. Checked at EXECUTION, never baked into a tool schema — the
* schema's enum is {@link ESCALATION_TARGETS}, because schemas are
* registry-global while the effective mode is per-call truth.
*/
const WIDER_MODES = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"]
};
/**
* The closed escalation-target vocabulary — every mode a call could ever
* escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
* whenever the mounted capability confines: cutting the enum down to the modes
* wider than the composition's DEFAULT would strand a session whose effective
* mode sits below it (a `danger-full-access` default would advertise nothing
* while a narrower-switched session stays confined with no lever).
*/
const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"];
/**
* Validate the escalation argument pairing a tool schema cannot express:
* `sandbox_permissions` and `justification` travel together — an approval
* prompt without a reason, or a reason driving nothing, is a malformed ask —
* and the justification must be a non-empty sentence.
* @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
* @param justification - the raw `justification` argument, if given.
*/
function validateEscalationArgs(sandboxPermissions, justification) {
	if (sandboxPermissions !== void 0 && justification === void 0) throw new Error("invalid escalation: sandbox_permissions requires a justification");
	if (justification !== void 0 && sandboxPermissions === void 0) throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
	if (justification !== void 0 && justification.trim().length === 0) throw new Error("invalid justification: expected a non-empty sentence");
}
/**
* The model-facing denial marker — the one vocabulary both enforcing families
* teach and report, so the model recognizes a policy denial identically
* whether the kernel refused a bash file effect or the filesystem provider's
* fence refused a mutation.
* @param mode - the mode the denied call ran under.
* @returns the marker line, exactly as the model sees it.
*/
function sandboxDenialMarker(mode) {
	return `[sandbox: file access denied under ${mode} mode]`;
}
/**
* The same-turn escalation hint that rides a denial when the composition
* advertises the escalation fields — the nudge lives at the decision point so
* the sanctioned retry does not depend on the model recalling the tool
* description.
* @param subject - the family's noun for the denied action (`command` for
*   bash, `operation` for a filesystem mutation).
* @returns the hint line, exactly as the model sees it.
*/
function escalationHintMarker(subject) {
	return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`;
}
/**
* The model-facing `sandbox_permissions` parameter description, which carries
* the escalation rules for every enforcing family.
* @param subject - the family's noun for the denied action (`command` for
*   bash, `operation` for a filesystem mutation).
* @returns the parameter description, exactly as the model sees it.
*/
function sandboxPermissionsDescription(subject) {
	return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`;
}
/**
* Resolve a sandbox permission request before execution. Repeating the call's
* effective mode returns it without approval. A strictly wider mode requires
* approval and applies only to this call. Narrower or unsupported targets,
* missing approval services or agents for widening, and non-grant outcomes
* throw before execution.
* @param request - the escalation to judge (see {@link EscalationRequest}).
* @param approval - the approval ingredients the tool holds (see {@link EscalationApproval}).
* @returns the granted mode, consumed by the one call that asked.
*/
async function approveEscalation(request, approval) {
	const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (mode === effectiveMode) return effectiveMode;
	if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`);
	if (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);
	if (approval.agent === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`);
	const outcome = await approval.approver.request({
		agent: approval.agent,
		toolName: approval.toolName,
		callId: approval.callId,
		reason: `escalate sandbox to ${mode}: ${justification}`,
		displayReason: {
			en: `Allow this operation with ${mode} permissions: ${justification}`,
			zh: process.platform === "android" && mode === "danger-full-access" ? `允许本次命令使用 DSH 已获 Android 权限？命令可访问已授权目录，无法限制为仅工作区。本次授权不改变会话设置。原因：${justification}` : `允许本次操作使用 ${mode} 权限：${justification}`
		},
		...approval.signal ? { signal: approval.signal } : {}
	});
	switch (outcome) {
		case "allowed-once": return mode;
		case "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`);
		case "cancelled": throw new Error(`approval for escalating to "${mode}" was cancelled`);
		case "unavailable": throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`);
		default: return assertNever(outcome, "EscalationOutcome");
	}
}
//#endregion
//#region lib/types/roots.js
/**
* The writable-root derivation shared by every enforcement dialect that
* expresses a mode as a canonical allow-list: `workspace-write` means "the
* workspace root plus the platform temp areas", and this module is that
* meaning's one home. The Seatbelt profile
* (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
* (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
* write tool cannot write /tmp but bash can" asymmetries cannot arise between
* them. The bwrap and Landlock dialects keep their own grant spellings (an
* ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
* differences recorded in the sandbox RFC — with parity pinned by test.
*
* @module dsh-sandbox/roots
*/
/**
* Resolve a granted root to the path the enforcement layer actually compares:
* canonical (symlinks resolved), because both Seatbelt filters and the fs
* fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
* on darwin, and an as-spelled grant would match nothing.
* @param path - the root as configured or platform-reported.
* @returns the canonical path, or the spelling as-is when resolution fails
*   (a missing root matches nothing until it exists — the conservative
*   outcome; inventing a fallback would grant a path the caller never named).
*/
function canonicalPath(path) {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}
/**
* The roots one confined execution may WRITE under — the mode's meaning as a
* canonical, deduplicated allow-list. `read-only` allows nothing;
* `workspace-write` allows the policy's workspace root, the host `/tmp`, and
* the per-user platform temp dir (`os.tmpdir()` — the real temp area for
* mkstemp-family tools; omitting it would deny what the mode promises).
* @param policy - the file-effect policy to derive the allow-list from.
* @returns the canonical writable roots; empty exactly under `read-only`.
*/
function writableRoots(policy) {
	if (policy.mode !== "workspace-write") return [];
	return [...new Set([
		policy.workspaceRoot,
		...(process.platform === "android" ? [] : ["/tmp"]),
		tmpdir()
	].map(canonicalPath))];
}
//#endregion
//#region lib/types/diagnostics.js
/** Classify observed sandbox runner failures and file-effect denials. */
/** Node-local spawn codes proven to identify executable resolution or permission failure. */
const EXECUTABLE_SPAWN_CODES = new Set(["EACCES", "ENOENT"]);
/** Whether the caller-owned spawn cwd can be entered. */
function isUsableWorkdir(path) {
	try {
		if (!statSync(path).isDirectory()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* Attribute only Node ENOENT/EACCES failures whose error path equals argv[0]
* after independently ruling out the caller-owned cwd. A supplied error path
* must exactly identify the runner; without one, the syscall must. With a
* usable cwd, these codes describe resolution or execute permission for that
* argv[0] or its shebang interpreter.
* The workdir is checked at classification time, not atomically with spawn;
* concurrent path replacement may change attribution but cannot permit an
* unconfined execution.
* @param error - the original spawn rejection.
* @param runnerProgram - provider argv[0], the executable that establishes confinement.
* @param workdir - the caller-owned spawn cwd, checked independently for usability.
* @returns whether the rejection has executable-specific runner evidence.
*/
function isRunnerSpawnFailure(error, runnerProgram, workdir) {
	if (runnerProgram === void 0 || !isUsableWorkdir(workdir)) return false;
	if (typeof error !== "object" || error === null) return false;
	const { code, path, syscall } = error;
	if (typeof code !== "string" || !EXECUTABLE_SPAWN_CODES.has(code)) return false;
	if (typeof syscall !== "string") return false;
	const exactSyscall = `spawn ${runnerProgram}`;
	if (path === void 0) return syscall === exactSyscall;
	if (typeof path !== "string" || path.length === 0 || path !== runnerProgram) return false;
	return syscall === "spawn" || syscall === exactSyscall;
}
/**
* Classify one settled process against the selected backend's structured
* runner-failure rules. Each rule requires a nonzero exit, its optional
* exit-code gate, and a fatal signature on one stderr line after exact
* informational lines are excluded.
* @param exitCode - process exit code; null means signal termination.
* @param stderr - collected stderr text, left unchanged.
* @param rules - structured runner-failure rules from the active wrap.
* @returns the first matching fatal line, or undefined when evidence is insufficient.
*/
function classifyRunnerFailure(exitCode, stderr, rules) {
	if (exitCode === null || exitCode === 0) return void 0;
	const lines = stderr.split(/\r?\n/);
	for (const rule of rules) {
		if (rule.allowedExitCodes !== void 0 && !rule.allowedExitCodes.includes(exitCode)) continue;
		const informationalLines = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()));
		const fatalSignatures = rule.fatalSignatures.filter((signature) => signature.trim().length > 0).map((signature) => signature.toLowerCase());
		for (const line of lines) {
			const lowered = line.toLowerCase();
			if (informationalLines.has(lowered)) continue;
			if (fatalSignatures.some((signature) => lowered.includes(signature))) return { detail: line };
		}
	}
}
/**
* Match a non-zero exit against case-insensitive stderr signatures.
* @param exitCode - process exit code; null means signal termination.
* @param stderr - collected stderr text.
* @param signatures - substrings identifying the selected backend's dialect.
* @returns whether this is a non-zero exit whose stderr matches a signature.
*/
function matchesSignature(exitCode, stderr, signatures) {
	if (exitCode === null || exitCode === 0) return false;
	const lowered = stderr.toLowerCase();
	return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}
//#endregion
//#region lib/types/index.js
/**
* Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a
* host-path file policy. Containers, microVMs, and remote execution replace the
* surrounding capability seam instead; this service shares the host kernel and filesystem.
* @module @deepseek-ai/dsh-sandbox
*/
/**
* Error code for a requested confined mode when no backend is usable. The
* provider fails closed, and `HarnessError` carries the code through
* `tool/result` so callers can distinguish missing confinement from command
* failure.
*/
const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";
/**
* Thrown when {@link SandboxProvider.confine} cannot enforce the requested
* mode. Carries {@link SANDBOX_UNAVAILABLE} through the structured error
* channel.
*/
var SandboxUnavailableError = class extends HarnessError {
	constructor(mode, detail) {
		super((process.platform === "android" ? `Android 命令沙箱不可用（${mode}）：系统未提供可用的 Landlock 隔离能力，操作未执行。请在服务→工具环境检查状态。优先使用文件工具；如确需运行此命令，可通过 sandbox_permissions 与 justification 申请单次 danger-full-access 授权，明确说明命令可访问 DSH 已获 Android 权限的所有目录。未获准不得执行，也不得换工具绕过拒绝。不会自动降低当前权限。` : `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.`) + (detail === void 0 ? "" : ` Runner failure: ${detail}`), SANDBOX_UNAVAILABLE);
		this.name = "SandboxUnavailableError";
	}
};
/**
* Abstract process-sandbox service. {@link confine} must return enforcing argv
* or fail closed at wrap or runner-execution time; silent unconfined passthrough
* is forbidden. Functional probes arbitrate multi-runner chains and may be
* skipped for a sole candidate, whose own refusal remains the fail-closed end.
*/
var SandboxProvider = class extends Service {
	/* v8 ignore next -- abstract service construction is covered through concrete provider packages. */
	constructor(ctx) {
		super(ctx, "sandbox");
	}
};
//#endregion
export { ESCALATION_TARGETS, SANDBOX_UNAVAILABLE, SandboxProvider, SandboxProvider as default, SandboxUnavailableError, WIDER_MODES, approveEscalation, canonicalPath, classifyRunnerFailure, escalationHintMarker, isRunnerSpawnFailure, matchesSignature, sandboxDenialMarker, sandboxPermissionsDescription, validateEscalationArgs, writableRoots };
