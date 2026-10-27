import z from "@deepseek-ai/schemastery";
//#region lib/types/recovery-config.js
/** Shared validation for Host-configured and browser-local connection recovery. */
const MAX_TIMER_MS = 2147483647;
/** Schema shared by the Host plugin and the Client's recovery input parser. */
const ConnectionRecoveryConfigSchema = z.object({
	backoffBaseMs: z.natural().min(1).max(MAX_TIMER_MS).default(500),
	backoffFactor: z.number().min(1).max(Number.MAX_VALUE).default(2),
	backoffMaxMs: z.natural().min(1).max(MAX_TIMER_MS).default(1e4),
	generationReadyWarnMs: z.natural().min(1).max(MAX_TIMER_MS).default(3e3),
	generationReadyTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(15e3)
});
/**
* Validate recovery input and supply every timing default before starting work.
* @param config - Host configuration, page bootstrap data, or direct loop options.
* @returns validated, complete recovery timing.
*/
function resolveConnectionConfig(config = {}) {
	const resolved = ConnectionRecoveryConfigSchema(config);
	if (!Number.isFinite(resolved.backoffFactor)) throw new RangeError("connection recovery backoffFactor must be finite");
	return resolved;
}
//#endregion
//#region lib/types/client/connection.js
/** Connection generation readiness, cancellation, and continuous recovery. */
const MANUAL_RECONNECT = /* @__PURE__ */ new Error("connection: manual reconnect requested");
const NETWORK_STATE_CHANGED = /* @__PURE__ */ new Error("connection: browser network state changed");
function sleep(ms, signal) {
	return new Promise((resolve) => {
		const t = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		}
	});
}
function waitForAbort(signal) {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => {
			resolve();
		}, { once: true });
	});
}
/**
* Opens the registered generation source, reconnecting with exponential backoff on loss.
* State (generation/attempt) is instance-private, never in the store.
* Sink exceptions do not kill the generation loop.
*/
var ConnectionController = class {
	source;
	sinks;
	generation = 0;
	attempt = 0;
	current = null;
	retryDelay = null;
	running = false;
	immediateRetry = false;
	networkAvailable = true;
	lastState;
	config;
	constructor(source, sinks = {}, config = {}) {
		this.source = source;
		this.sinks = sinks;
		this.config = resolveConnectionConfig(config);
	}
	/** Idempotent: begin the connect/pump/reconnect loop. */
	start() {
		if (this.running) return;
		this.running = true;
		this.loop();
	}
	/** Stop the loop and abort the current generation source. */
	stop() {
		this.running = false;
		this.current?.abort();
		this.current = null;
		this.retryDelay?.abort();
		this.retryDelay = null;
	}
	/** Reset the retry sequence and replace the current generation or retry delay immediately. */
	reconnect() {
		if (!this.running) return;
		this.attempt = 0;
		this.immediateRetry = true;
		this.emitState("connecting");
		if (!this.isRunning()) return;
		this.current?.abort(MANUAL_RECONNECT);
		this.retryDelay?.abort(MANUAL_RECONNECT);
	}
	/**
	* Suspend automatic retries while offline and restart backoff when the network returns.
	* @param available - whether the browser reports network access.
	*/
	setNetworkAvailable(available) {
		if (this.networkAvailable === available) return;
		this.networkAvailable = available;
		this.attempt = 0;
		this.immediateRetry = false;
		if (!this.running) return;
		this.emitState(available ? "connecting" : "disconnected");
		if (!this.isRunning()) return;
		this.current?.abort(NETWORK_STATE_CHANGED);
		this.retryDelay?.abort(NETWORK_STATE_CHANGED);
	}
	backoffCap(attempt) {
		const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config;
		return Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1));
	}
	backoffDelay(attempt) {
		const cap = this.backoffCap(attempt);
		return cap / 2 + Math.random() * (cap / 2);
	}
	/** Re-read retry inputs after a potentially reentrant state sink. */
	isRetryInterrupted(immediate) {
		return this.immediateRetry || !this.networkAvailable && !immediate;
	}
	/** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
	isRunning() {
		return this.running;
	}
	/** Re-read both mutable liveness guards after a potentially reentrant sink. */
	isGenerationActive(controller) {
		return this.isRunning() && !controller.signal.aborted;
	}
	async loop() {
		let retry = false;
		while (this.running) {
			if (!this.networkAvailable && !this.immediateRetry) {
				const retryDelay = new AbortController();
				this.retryDelay = retryDelay;
				this.emitState("disconnected");
				await waitForAbort(retryDelay.signal);
				if (this.retryDelay === retryDelay) this.retryDelay = null;
				if (!this.isRunning()) return;
				retry = true;
				continue;
			}
			let manualAttempt = false;
			if (retry) {
				const immediate = this.immediateRetry;
				this.immediateRetry = false;
				if (immediate) this.attempt = 0;
				manualAttempt = immediate;
				const attempt = ++this.attempt;
				this.emitState("connecting");
				if (!this.isRunning()) return;
				if (this.isRetryInterrupted(immediate)) continue;
				if (!immediate) {
					const retryDelay = new AbortController();
					this.retryDelay = retryDelay;
					await sleep(this.backoffDelay(attempt), retryDelay.signal);
					if (this.retryDelay === retryDelay) this.retryDelay = null;
					if (!this.isRunning()) return;
					if (retryDelay.signal.aborted) continue;
				}
				console.warn(`[connection] connection lost, retry #${String(attempt)}`);
				this.callSink(() => {
					this.sinks.onReconnectRequested?.();
				});
				if (!this.isRunning()) return;
			}
			const gen = ++this.generation;
			const ac = new AbortController();
			this.current = ac;
			let sourceReady = false;
			let resolveReady;
			let rejectReady;
			let rejectSourceLost;
			const ready = new Promise((resolve, reject) => {
				resolveReady = resolve;
				rejectReady = reject;
			});
			const sourceLost = new Promise((_resolve, reject) => {
				rejectSourceLost = reject;
			});
			const reportReady = (host) => {
				if (sourceReady || gen !== this.generation || !this.isGenerationActive(ac)) return;
				sourceReady = true;
				resolveReady(host);
			};
			const failed = new Promise((resolve) => {
				const settle = () => {
					if (gen === this.generation && !ac.signal.aborted) ac.abort();
					resolve();
				};
				Promise.resolve().then(() => this.source(ac.signal, reportReady)).then(() => {
					const error = /* @__PURE__ */ new Error("connection generation ended");
					if (!sourceReady) rejectReady(error);
					rejectSourceLost(error);
					settle();
				}, (error) => {
					const failure = error instanceof Error ? error : new Error("connection generation failed", { cause: error });
					if (!sourceReady) rejectReady(failure);
					rejectSourceLost(failure);
					settle();
				});
			});
			try {
				const host = await Promise.race([waitForReady(ready, this.config, ac.signal), sourceLost]);
				if (ac.signal.aborted) throw new Error("generation aborted during readiness handshake");
				this.attempt = 0;
				this.emitState("connected");
				if (this.isGenerationActive(ac)) this.callSink(() => {
					this.sinks.onConnected?.(host);
				});
			} catch (error) {
				if (!ac.signal.aborted) ac.abort(error);
			}
			await failed;
			if (!this.isRunning()) return;
			if (manualAttempt) this.attempt = 0;
			retry = true;
		}
	}
	/** Deduplicated state emission (sink isolation applies). */
	emitState(state) {
		if (this.lastState === state) return;
		this.lastState = state;
		this.callSink(() => this.sinks.onStateChange?.(state));
	}
	/** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
	callSink(fn) {
		try {
			fn();
		} catch (error) {
			console.error("[connection] connection sink threw:", error);
		}
	}
};
/** Report a slow handshake before the hard deadline ends its generation. */
function waitForReady(ready, config, signal) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const warning = setTimeout(() => {
			console.warn(`[connection] generation is still not ready after ${String(config.generationReadyWarnMs)}ms`);
		}, config.generationReadyWarnMs);
		const timeout = setTimeout(() => {
			const error = /* @__PURE__ */ new Error(`connection generation was not ready within ${String(config.generationReadyTimeoutMs)}ms`);
			console.warn(`[connection] ${error.message}; cancelling generation`);
			finish({ error });
		}, config.generationReadyTimeoutMs);
		const aborted = () => {
			finish({ error: new Error("connection generation aborted", { cause: signal.reason }) });
		};
		const finish = (outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(warning);
			clearTimeout(timeout);
			signal.removeEventListener("abort", aborted);
			if ("error" in outcome) reject(outcome.error);
			else resolve(outcome.value);
		};
		signal.addEventListener("abort", aborted, { once: true });
		ready.then((value) => {
			finish({ value });
		}, (error) => {
			finish({ error });
		});
	});
}
//#endregion
//#region lib/types/rpc.js
/** Generic unary RPC contracts shared by the Host and Client Connection halves. */
/**
* Brand one validated string as a Connection correlation id.
* @param id - validated wire identity.
* @returns the same string with the correlation-id brand.
*/
function RpcId(id) {
	return id;
}
/**
* Convert a rejected transport operation into a generic failure result.
* @param error - rejected transport value.
* @returns an `internal` failure preserving the available message.
*/
function transportError(error) {
	return {
		ok: false,
		error: {
			code: "gateway/internal",
			message: error instanceof Error ? error.message : String(error),
			details: {}
		}
	};
}
//#endregion
//#region lib/types/client/random-uuid.js
/** Browser-safe UUID generation for client-side wire correlation. */
/**
* Generate an RFC 4122 version 4 UUID without requiring a secure context.
* @returns a UUID backed by `crypto.getRandomValues()`, which browsers expose on insecure origins.
*/
function randomUuid() {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint8(6, view.getUint8(6) & 15 | 64);
	view.setUint8(8, view.getUint8(8) & 63 | 128);
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//#endregion
//#region lib/types/client/rpc.js
/** Browser caller for generic Connection unary RPC channels. */
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
* Create the browser-backed generic RPC caller.
* @param doFetch - transport override; defaults to the page's global fetch.
* @param openStream - optional worker-local Gateway stream carrier.
* @returns caller that owns request correlation and response-envelope validation.
*/
function createWebConnectionRpc(doFetch, openStream) {
	const send = doFetch ?? ((input, init) => globalThis.fetch(input, init));
	return {
		async call(channel, endpoint, payload, signal) {
			assertTarget(channel, endpoint);
			const rpcId = RpcId(randomUuid());
			const message = {
				type: "client-request",
				rpcId,
				method: endpoint,
				payload
			};
			const response = await send(`${channel}/${endpoint}`.slice(1), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(message),
				...signal === void 0 ? {} : { signal }
			});
			if (!response.ok) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
			const full = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data" ? await parseBinaryResponse(response) : parseConnectionResponse(await response.json());
			signal?.throwIfAborted();
			if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
			return full.result;
		},
		...openStream === void 0 ? {} : { open(channel, endpoint, payload, signal, uplink) {
			assertTarget(channel, endpoint);
			if (channel !== "/api") throw new Error(`connection: worker-local streams require the /api channel, got ${JSON.stringify(channel)}`);
			return openStream(endpoint, payload, signal, uplink);
		} }
	};
}
async function parseBinaryResponse(response) {
	const body = await response.formData();
	const fields = /* @__PURE__ */ new Map();
	for (const [name, value] of body) {
		if (fields.has(name)) throw new TypeError("connection: invalid binary response fields");
		fields.set(name, value);
	}
	const metadata = fields.get("metadata");
	fields.delete("metadata");
	if (typeof metadata !== "string") throw new TypeError("connection: invalid binary response fields");
	const envelope = JSON.parse(metadata);
	const full = parseConnectionResponse(envelope);
	if (!full.result.ok || !isRecord(envelope) || !Array.isArray(envelope.attachments) || envelope.attachments.length === 0) throw new TypeError("connection: invalid binary response result");
	const root = { value: full.result.value };
	for (const attachment of envelope.attachments) {
		if (!isRecord(attachment) || attachment.codec !== "bytes" || typeof attachment.part !== "string" || !Array.isArray(attachment.path)) throw new TypeError("connection: invalid binary response attachment");
		const data = fields.get(attachment.part);
		fields.delete(attachment.part);
		if (!(data instanceof Blob)) throw new TypeError("connection: invalid binary response fields");
		let parent = root;
		let key = "value";
		for (const segment of attachment.path) {
			const value = Reflect.get(parent, key);
			if (typeof value !== "object" || value === null) throw new TypeError("connection: invalid binary response path");
			if (Array.isArray(value)) {
				if (typeof segment !== "number" || !Number.isSafeInteger(segment) || segment < 0 || segment >= value.length) throw new TypeError("connection: invalid binary response path");
			} else if (typeof segment !== "string") throw new TypeError("connection: invalid binary response path");
			if (!Object.hasOwn(value, segment)) throw new TypeError("connection: invalid binary response path");
			parent = value;
			key = segment;
		}
		if (Reflect.get(parent, key) !== null) throw new TypeError("connection: invalid binary response placeholder");
		Object.defineProperty(parent, key, {
			value: new Uint8Array(await data.arrayBuffer()),
			enumerable: true,
			writable: true,
			configurable: true
		});
	}
	if (fields.size !== 0) throw new TypeError("connection: invalid binary response fields");
	return {
		rpcId: full.rpcId,
		result: {
			ok: true,
			value: root.value
		}
	};
}
function parseConnectionResponse(value) {
	if (!isRecord(value) || value.type !== "server-response" || typeof value.rpcId !== "string") throw new TypeError("connection: invalid server-response envelope");
	const result = value.result;
	if (!isRecord(result)) throw new TypeError("connection: invalid server-response result");
	if (result.ok === true) return {
		rpcId: RpcId(value.rpcId),
		result: {
			ok: true,
			value: result.value
		}
	};
	if (result.ok !== false || !isRecord(result.error)) throw new TypeError("connection: invalid server-response result");
	const error = result.error;
	if (typeof error.code !== "string" || typeof error.message !== "string" || !isRecord(error.details)) throw new TypeError("connection: invalid server-response failure");
	return {
		rpcId: RpcId(value.rpcId),
		result: {
			ok: false,
			error: {
				code: error.code,
				message: error.message,
				details: error.details
			}
		}
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertTarget(channel, endpoint) {
	const segments = endpoint.split("/");
	if (!CHANNEL_PATTERN.test(channel) || segments.some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`);
}
//#endregion
//#region lib/types/loopback-hostname.js
/**
* Browser-safe, zero-dependency loopback classification shared by the `/api`
* Host fence and the package's `ctx.connection` state. The predicate stays
* package-internal; client plugins consume the derived state through Cordis.
*/
/**
* Whether a normalized URL hostname names the local loopback authority.
* @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
* @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
*/
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
//#endregion
//#region lib/types/client/socket.js
/** Physical socket selection for browser, desktop, and authenticated Node connections. */
/**
* Resolve a logical channel against the explicit Host or the page's document base.
* @param path - absolute logical channel path.
* @param factory - authenticated socket factory; omission uses the browser API.
* @param baseUrl - Host base URL, required outside a document.
* @returns a socket owned by the calling channel.
*/
function openConnectionWebSocket(path, factory = (url) => new WebSocket(url), baseUrl) {
	const base = baseUrl ?? (typeof document === "undefined" ? void 0 : document.baseURI);
	if (base === void 0) throw new Error("connection: WebSocket carrier requires streamBaseUrl outside a document");
	const url = new URL(path.slice(1), base);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return factory(url.href);
}
//#endregion
//#region lib/types/client/index.js
/** Required services (none — this is the wire root). */
const inject = [];
function watchBrowserNetwork(controller, pageLocation, getState) {
	const browser = globalThis.window;
	const initiallyAvailable = browser?.navigator?.onLine;
	if (browser === void 0 || initiallyAvailable === void 0) return () => {};
	// Internet reachability is only a hint. Android can report offline
	// while its local DSH server (including the paired-device proxy) is
	// reachable. Let the real carrier and its backoff decide availability.
	const loopback = pageLocation !== void 0 && isLoopbackHostname(pageLocation.hostname);
	const online = () => {
		controller.setNetworkAvailable(true);
	};
	const offline = () => {
		if (!loopback) controller.setNetworkAvailable(false);
	};
	const restored = (event) => {
		if (event.persisted) controller.reconnect();
	};
	const visible = () => {
		if (globalThis.document?.visibilityState === "visible" && getState() !== "connected") controller.reconnect();
	};
	controller.setNetworkAvailable(loopback || initiallyAvailable);
	browser.addEventListener("online", online);
	browser.addEventListener("offline", offline);
	browser.addEventListener("pageshow", restored);
	globalThis.document?.addEventListener("visibilitychange", visible);
	return () => {
		browser.removeEventListener("online", online);
		browser.removeEventListener("offline", offline);
		browser.removeEventListener("pageshow", restored);
		globalThis.document?.removeEventListener("visibilitychange", visible);
	};
}
/**
* Install one Context-owned Connection service from explicit composition inputs.
* @param ctx - client Cordis context.
* @param options - interaction participation, physical carrier, reconnect timing, and page location.
*/
function installConnection(ctx, options = {}) {
	const pageLocation = options.location;
	const transport = options.transport;
	const recovery = options.recovery ?? {};
	const interactions = options.interactions ?? (pageLocation === void 0 ? "none" : "answer");
	const rpc = transport?.rpc ?? createWebConnectionRpc(transport?.fetch, transport?.openStream);
	let generationSource;
	let owner;
	let generationId = 0;
	let generation;
	let state;
	const generationListeners = /* @__PURE__ */ new Set();
	const stateListeners = /* @__PURE__ */ new Set();
	const publishGeneration = (next) => {
		if (Object.is(generation, next)) return;
		generation = next;
		for (const listener of [...generationListeners]) try {
			listener();
		} catch (error) {
			console.error("[connection] generation listener threw:", error);
		}
	};
	const publishState = (next) => {
		if (state === next) return;
		state = next;
		for (const listener of [...stateListeners]) try {
			listener();
		} catch (error) {
			console.error("[connection] state listener threw:", error);
		}
	};
	const releaseOwner = (current) => {
		if (owner !== current) return;
		owner = void 0;
		current.stopNetworkWatch();
		current.controller.stop();
		publishGeneration(void 0);
		publishState(void 0);
	};
	const handle = {
		interactions,
		openWebSocket: (path) => openConnectionWebSocket(path, transport?.createWebSocket, transport?.streamBaseUrl),
		isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),
		generation: {
			getSnapshot: () => generation,
			subscribe: (listener) => {
				generationListeners.add(listener);
				return () => {
					generationListeners.delete(listener);
				};
			}
		},
		state: {
			getSnapshot: () => state,
			subscribe: (listener) => {
				stateListeners.add(listener);
				return () => {
					stateListeners.delete(listener);
				};
			}
		},
		rpc,
		reconnect() {
			owner?.controller.reconnect();
		},
		registerGenerationSource(source) {
			if (generationSource !== void 0) throw new Error("connection: a generation source is already registered");
			generationSource = source;
			return () => {
				if (generationSource !== source) return;
				generationSource = void 0;
				const current = owner;
				if (current?.source === source) releaseOwner(current);
			};
		},
		start(sinks, config) {
			if (owner !== void 0) throw new Error("connection: the stream loop is already owned by another consumer");
			const source = generationSource;
			if (source === void 0) throw new Error("connection: no generation source is registered");
			const token = {};
			const ownsGeneration = () => owner?.token === token;
			const controller = new ConnectionController(source, {
				...sinks,
				onConnected: (host) => {
					const nextGeneration = {
						id: ++generationId,
						host
					};
					publishGeneration(nextGeneration);
					if (!ownsGeneration() || !Object.is(generation, nextGeneration)) return;
					sinks.onConnected?.(host);
				},
				onStateChange: (state) => {
					if (state !== "connected") publishGeneration(void 0);
					if (!ownsGeneration()) return;
					publishState(state);
					sinks.onStateChange?.(state);
				}
			}, {
				...recovery,
				...config
			});
			const current = {
				token,
				source,
				controller,
				stopNetworkWatch: watchBrowserNetwork(controller, pageLocation, () => state)
			};
			owner = current;
			controller.start();
			return { stop: () => {
				releaseOwner(current);
			} };
		}
	};
	ctx.provide("connection", handle);
}
/**
* Client plugin body: read the page composition and install its Connection service.
* @param ctx - client Cordis context.
*/
function apply(ctx) {
	const globals = globalThis;
	const pageLocation = typeof location === "undefined" ? void 0 : location;
	const transport = globals.__DSH_TRANSPORT__;
	installConnection(ctx, {
		...transport === void 0 ? {} : { transport },
		recovery: resolveConnectionConfig(globals.__DSH_CONNECTION_RECOVERY__),
		...pageLocation === void 0 ? {} : { location: pageLocation }
	});
}
//#endregion
export { RpcId, apply, inject, installConnection, transportError };

//# sourceMappingURL=client.node.js.map