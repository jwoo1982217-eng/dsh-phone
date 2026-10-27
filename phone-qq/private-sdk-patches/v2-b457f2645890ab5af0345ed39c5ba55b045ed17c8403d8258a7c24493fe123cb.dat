import { Buffer } from "node:buffer";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
//#region lib/types/index.js
/**
* Incremental session-log contribution for official DeepSeek LLM API requests.
* Accepted sequence watermarks live in the canonical log, so restart recovery
* can conservatively resend uncertain tails without maintaining another store.
* @module @deepseek-ai/dsh-session-log-deepseek
*/
/** Cordis plugin name. */
const name = "session-log-deepseek";
/** Services required to resolve sessions and contribute the provider request field. */
const inject = ["deepseekLlmApiExtensions", "sessions"];
/** Validated Session-log request contribution configuration. */
const Config = z.object({
	enabled: z.boolean().default(false).volatile(), // [dsh-purge] session log upload off
	maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024)
});
const acceptanceFolds = /* @__PURE__ */ new WeakMap();
/** Event each Session's upload was last reported blocked at; a block is logged once. */
const blockedWarnings = /* @__PURE__ */ new WeakMap();
/** Translate logical Session metadata to raw external request fields. */
function wireHeader(session) {
	const header = session.header;
	return {
		version: header.version,
		id: String(header.id),
		createdAt: header.createdAt,
		...header.cwd === void 0 ? {} : { cwd: header.cwd },
		...header.parentSession === void 0 ? {} : { parentSession: String(header.parentSession) },
		...header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {},
		...header.origin === void 0 ? {} : { origin: header.origin },
		...header.delegationDepth === void 0 ? {} : { delegationDepth: header.delegationDepth },
		...header.agentPreset === void 0 ? {} : { agentPreset: header.agentPreset }
	};
}
/** Translate compile-time sequence brands to raw numeric request fields. */
function wireEvent(event) {
	const common = {
		seq: Number(event.seq),
		time: event.time,
		data: event.data,
		...event.ignorable === void 0 ? {} : { ignorable: event.ignorable }
	};
	switch (event.type) {
		case "developer/message":
		case "system/message":
		case "user/message":
		case "tool/result": return {
			...common,
			type: event.type,
			surfaceOp: wireSurfaceOp(event.surfaceOp),
			...event.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: event.sourceEventSeqs.map(Number) }
		};
		case "assistant/message": return {
			...common,
			type: event.type,
			surfaceOp: wireSurfaceOp(event.surfaceOp)
		};
		default:
			if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) {
				const opaque = event;
				return {
					...common,
					type: event.type,
					ignorable: true,
					...opaque.surfaceOp === void 0 ? {} : { surfaceOp: opaque.surfaceOp },
					...opaque.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: opaque.sourceEventSeqs }
				};
			}
			return {
				...common,
				type: event.type
			};
	}
}
function wireSurfaceOp(op) {
	return op === "append" ? op : {
		op: "replace",
		startSeq: Number(op.startSeq),
		endSeq: Number(op.endSeq)
	};
}
/**
* UTF-8 length of one value's JSON text as the request body encodes it.
* @returns `Infinity` when the value fails to serialize, which counts as exceeding every limit.
*/
function jsonBytes(value) {
	let text;
	try {
		text = JSON.stringify(value);
	} catch (_unserializable) {
		return Number.POSITIVE_INFINITY;
	}
	return Buffer.byteLength(text);
}
/**
* Highest confirmed sequence for this exact Session format generation.
* @param session - canonical log whose matching acceptance events are folded.
* @returns greatest accepted sequence, or `-1` before any accepted request.
*/
function acceptedThrough(session) {
	const previous = acceptanceFolds.get(session);
	let throughSeq = previous?.throughSeq ?? -1;
	const length = session.seq;
	const start = previous?.scannedEvents ?? SessionLogOffset(0);
	for (let index = start; index < length; index++) {
		const event = session.eventAt(SessionSeq(index));
		if (event === void 0) throw new Error(`session-log-deepseek: missing event ${String(index)} below captured length ${String(length)}`);
		if (event.type !== "session-log-deepseek/delivery-accepted") continue;
		const acceptedFormatVersion = event.data.sessionFormatVersion ?? 0;
		if (!Number.isSafeInteger(acceptedFormatVersion) || acceptedFormatVersion < 0 || Object.is(acceptedFormatVersion, -0)) throw new Error(`session-log-deepseek: malformed acceptance format version at seq ${event.seq}`);
		if (acceptedFormatVersion !== session.header.version) continue;
		let acceptedSeq;
		try {
			acceptedSeq = SessionSeq(event.data.throughSeq);
		} catch {
			throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`);
		}
		if (typeof event.data.sessionId !== "string" || event.data.sessionId.length === 0 || acceptedSeq >= event.seq) throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`);
		if (event.data.sessionId !== session.id) continue;
		if (acceptedSeq > throughSeq) throughSeq = acceptedSeq;
	}
	acceptanceFolds.set(session, {
		scannedEvents: length,
		throughSeq
	});
	return throughSeq;
}
/**
* Register the incremental request contribution; enablement is read for each request.
* @param ctx - plugin context carrying Sessions and the DeepSeek request-extension registry.
* @param config - validated configuration.
*/
function apply(ctx, config) {
	const { maxBytes } = config;
	ctx.deepseekLlmApiExtensions.register("dsh_session_log", { prepare: (request) => {
		if (!config.enabled.get()) return void 0;
		if (request.sessionId === void 0) return void 0;
		const session = ctx.sessions.get(brandString(request.sessionId));
		if (session === void 0) return void 0;
		const afterSeq = acceptedThrough(session);
		const pending = session.snapshotEvents(SessionLogOffset(afterSeq + 1));
		const envelope = {
			version: 1,
			sessionFormatVersion: session.header.version,
			session: wireHeader(session),
			afterSeq: Number(afterSeq)
		};
		let bytes = jsonBytes({
			...envelope,
			throughSeq: 0,
			events: []
		}) - 1;
		const events = [];
		let candidateBytes = 0;
		for (const event of pending) {
			const wire = wireEvent(event);
			const next = bytes + (events.length === 0 ? 0 : 1) + jsonBytes(wire);
			candidateBytes = next + String(event.seq).length;
			if (candidateBytes > maxBytes) break;
			bytes = next;
			events.push(wire);
		}
		const last = events.length === 0 ? void 0 : pending[events.length - 1];
		if (last === void 0) {
			const first = pending[0];
			if (first !== void 0 && blockedWarnings.get(session) !== first.seq) {
				blockedWarnings.set(session, first.seq);
				const seq = String(first.seq);
				ctx.logger.warn(Number.isFinite(candidateBytes) ? `session-log-deepseek: event ${seq} of session "${session.id}" needs a ${String(candidateBytes)}-byte dsh_session_log field, above maxBytes ${String(maxBytes)}; this session's upload stays at event ${seq} until maxBytes admits it` : `session-log-deepseek: event ${seq} of session "${session.id}" is too large to serialize into a dsh_session_log field; this session's upload stays at event ${seq}`);
			}
			return;
		}
		const throughSeq = last.seq;
		return {
			value: {
				...envelope,
				throughSeq: Number(throughSeq),
				events
			},
			accept: () => {
				session.append("session-log-deepseek/delivery-accepted", {
					sessionId: session.id,
					sessionFormatVersion: session.header.version,
					throughSeq
				});
			}
		};
	} });
}
//#endregion
export { Config, acceptedThrough, apply, inject, name };
