window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-model-selection",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");
		//#region ../../util/values/src/partial-json.ts
		/**
		* Lazily scanned view of one JSON object's top-level fields, built from text
		* that may still be streaming or from an already parsed object. Nothing is
		* scanned until a reader asks; the view remembers every question it answered
		* and reports changed answers when the owner refreshes for publication.
		* Used for model tool-call arguments: a row reads the fields it
		* cares about at whatever granularity it displays, at every stage of the call.
		* @module @deepseek-ai/dsh-util-values/src/partial-json
		*/
		const SIMPLE_ESCAPES = {
			"\"": "\"",
			"\\": "\\",
			"/": "/",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "	"
		};
		const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
		function isWhitespace(c) {
			return c === " " || c === "\n" || c === "\r" || c === "	";
		}
		function isHex(c) {
			return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
		}
		(class PartialArguments {
			/** The view of a call with no arguments available. */
			static EMPTY = PartialArguments.fromObject({});
			/**
			* View finished argument text without scanning it until a reader asks.
			* @param text - the complete argument JSON text.
			* @returns a sealed view.
			*/
			static fromText(text) {
				const view = new PartialArguments();
				view.append(text);
				view.sealed = true;
				return view;
			}
			/**
			* View an already parsed argument payload, such as a PTC dispatch object.
			* @param value - the parsed argument value.
			* @returns a sealed view; a non-object payload has no fields.
			*/
			static fromObject(value) {
				const view = new PartialArguments();
				view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
				view.sealed = true;
				return view;
			}
			/**
			* The source: text so far or a parsed object, plus whether it can still grow.
			* These are the only enumerable fields, so two views over the same source
			* compare equal structurally however far each has been read.
			*/
			chunks = [];
			object;
			sealed = false;
			#ends = [];
			#size = 0;
			#consumed = 0;
			#mode = "root";
			#escape = false;
			#keyStart = 0;
			#keyEscaped = false;
			#key = "";
			#current = null;
			#nestedEnds = [];
			#nestedInString = false;
			#invalidAt;
			#invalidValue = false;
			#entries = /* @__PURE__ */ new Map();
			#order = [];
			#reads = /* @__PURE__ */ new Map();
			/** Whether this view rejects further appends; does not scan text or register reads. */
			get isSealed() {
				return this.sealed;
			}
			/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
			get invalid() {
				this.scan();
				return this.#mode === "invalid" || this.#invalidValue;
			}
			/**
			* Retain streamed argument text without scanning or comparing observed answers.
			* @param fragment - the text following every fragment appended before.
			*/
			append(fragment) {
				if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
				if (fragment.length === 0) return;
				this.chunks.push(fragment);
				this.#size += fragment.length;
				this.#ends.push(this.#size);
			}
			/**
			* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
			* @param text - the final argument text, which replaces missing or conflicting deltas.
			* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
			*/
			settle(text) {
				if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
				let offset = 0;
				for (const chunk of this.chunks) {
					if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
					offset += chunk.length;
				}
				this.chunks = text.length === 0 ? [] : [text];
				this.#ends = text.length === 0 ? [] : [text.length];
				this.sealed = true;
				return this;
			}
			/**
			* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
			* @returns whether any observed answer changed since its first read or the preceding refresh.
			*/
			refresh() {
				if (this.#reads.size === 0) return false;
				this.scan();
				let changed = false;
				let completions = false;
				for (const read of this.#reads.values()) {
					if (read.completion) {
						completions = true;
						continue;
					}
					changed = this.refreshRead(read) || changed;
				}
				if (completions) {
					for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
				}
				if (this.sealed) this.#reads.clear();
				return changed;
			}
			refreshRead(read) {
				const now = read.answer();
				if (Object.is(now, read.last)) return false;
				read.last = now;
				return true;
			}
			/**
			* Check whether no further fields can arrive.
			* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
			*/
			closed() {
				return this.remember("closed", "", () => this.closedNow());
			}
			/**
			* List discovered fields in first-appearance order.
			* @returns top-level keys seen so far, in first-appearance order.
			*/
			keys() {
				return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
			}
			/**
			* Check whether a top-level field has appeared.
			* @param key - argument name.
			* @returns whether the field has appeared (a string opened or another value began).
			*/
			has(key) {
				return this.remember("has", key, () => this.hasNow(key));
			}
			/**
			* Check whether a field's closing delimiter has arrived, without validating its contents.
			* @param key - argument name.
			* @returns whether its delimiter arrived and no content reader has reported an error for this value.
			*/
			complete(key) {
				return this.remember("complete", key, () => this.completeNow(key));
			}
			/**
			* Read string length without materializing its text.
			* @param key - argument name.
			* @param options - change granularity for a streaming string.
			* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
			*/
			stringLength(key, options) {
				const step = Math.max(1, Math.floor(options?.step ?? 1));
				const offset = options?.offset ?? 0;
				return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
			}
			/**
			* Check a string against a decoded UTF-16 length limit without materializing it.
			* @param key - argument name.
			* @param maxLength - decoded UTF-16 limit, floored to at least zero.
			* @returns whether the string is longer than the limit; false when absent or not a string.
			*/
			stringExceeds(key, maxLength) {
				const limit = Math.max(0, Math.floor(maxLength));
				return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
			}
			/**
			* Read a decoded string, including a streaming prefix.
			* @param key - argument name.
			* @returns the string field's decoded text so far; undefined when absent or not a string.
			*/
			text(key) {
				return this.remember("text", key, () => this.textNow(key));
			}
			/**
			* Read at most the first decoded UTF-16 units of a string.
			* @param key - argument name.
			* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
			* @returns the bounded string prefix; undefined when absent or not a string.
			*/
			textPrefix(key, maxLength) {
				const limit = Math.max(1, Math.floor(maxLength));
				return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
			}
			/**
			* Read a completed non-string argument.
			* @param key - argument name.
			* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
			*/
			value(key) {
				return this.remember("value", key, () => this.valueNow(key));
			}
			/** Answer a question and, on a streaming view, remember it for change detection. */
			remember(kind, key, read, comparison) {
				this.scan();
				const result = read();
				if (!this.sealed) {
					const id = `${kind}/${key}`;
					if (!this.#reads.has(id)) this.#reads.set(id, {
						completion: kind === "complete",
						answer: comparison === void 0 ? read : () => comparison(read()),
						last: comparison === void 0 ? result : comparison(result)
					});
				}
				return result;
			}
			closedNow() {
				return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
			}
			keysNow() {
				return this.object === void 0 ? this.#order : Object.keys(this.object);
			}
			hasNow(key) {
				return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
			}
			completeNow(key) {
				if (this.object !== void 0) return Object.hasOwn(this.object, key);
				const entry = this.#entries.get(key);
				return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
			}
			lengthNow(key, limit = Number.POSITIVE_INFINITY) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field.length : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
				const read = entry.length ??= {
					at: entry.start,
					length: 0,
					text: ""
				};
				this.readString(entry, read, limit, false);
				return read.length;
			}
			textNow(key) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
					let text;
					try {
						text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
					} catch (_error) {}
					if (text !== void 0) entry.text = {
						at: entry.end,
						length: text.length,
						text
					};
				}
				const read = entry.text ??= {
					at: entry.start,
					length: 0,
					text: ""
				};
				this.readString(entry, read, Number.POSITIVE_INFINITY, true);
				return read.text;
			}
			textPrefixNow(key, maxLength) {
				if (this.object !== void 0) {
					const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
					return typeof field === "string" ? field.slice(0, maxLength) : void 0;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "string") return void 0;
				const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
				let read = prefixes.get(maxLength);
				if (read === void 0) {
					read = {
						at: entry.start,
						length: 0,
						text: ""
					};
					prefixes.set(maxLength, read);
				}
				this.readString(entry, read, maxLength, true);
				return read.text;
			}
			valueNow(key) {
				if (this.object !== void 0) {
					if (!Object.hasOwn(this.object, key)) return void 0;
					const field = this.object[key];
					return typeof field === "string" ? void 0 : field;
				}
				const entry = this.#entries.get(key);
				if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
				if (entry.parsed === void 0) try {
					entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
				} catch (_error) {
					entry.invalid = true;
					this.#invalidValue = true;
				}
				return entry.parsed;
			}
			chunkAt(at) {
				let low = 0;
				let high = this.#ends.length;
				while (low < high) {
					const mid = low + high >>> 1;
					if (this.#ends[mid] <= at) low = mid + 1;
					else high = mid;
				}
				return low;
			}
			/** Materialize only a requested range, never the cumulative source. */
			slice(start, end) {
				if (start >= end) return "";
				const first = this.chunkAt(start);
				const last = this.chunkAt(end - 1);
				const base = first === 0 ? 0 : this.#ends[first - 1];
				if (first === last) return this.chunks[first].slice(start - base, end - base);
				const parts = [this.chunks[first].slice(start - base)];
				for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
				parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
				return parts.join("");
			}
			readString(entry, read, limit, materialize) {
				const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
				if (!entry.needsDecoding) {
					const length = Math.min(end - read.at, limit - read.length);
					if (length <= 0) return;
					if (materialize) read.text += this.slice(read.at, read.at + length);
					read.at += length;
					read.length += length;
					return;
				}
				let chunkIndex = this.chunkAt(read.at);
				while (read.at < end && read.length < limit) {
					const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
					const chunk = this.chunks[chunkIndex];
					const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
					const boundary = remaining.search(CONTENT_ESCAPE);
					const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
					if (length > 0) {
						if (materialize) read.text += remaining.slice(0, length);
						read.at += length;
						read.length += length;
						if (read.at === base + chunk.length) chunkIndex++;
						continue;
					}
					const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
					let decoded;
					let width = 2;
					if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
					if (remaining[0] === "\\" && type === "u") {
						const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
						let valid = true;
						for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
						if (valid) {
							if (hex.length < 4 && entry.end < 0) return;
							if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
						}
						width = 6;
					} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
					if (decoded === void 0) {
						entry.invalidAt = read.at;
						this.#invalidValue = true;
						return;
					}
					if (materialize) read.text += decoded;
					read.length++;
					read.at += width;
					while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
				}
			}
			/** Locate new field ranges without decoding or parsing their contents. */
			scan() {
				if (this.object !== void 0 || this.#consumed === this.#size) return;
				for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
					const pending = this.chunks[i];
					const base = i === 0 ? 0 : this.#ends[i - 1];
					for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
						if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
							const end = this.stringBoundary(pending, index);
							this.#consumed += end - index;
							index = end;
							if (index === pending.length) break;
						}
						this.step(pending[index], this.#consumed);
						this.#consumed++;
					}
				}
			}
			/** Only raw quotes and their preceding backslash runs can terminate a string. */
			stringBoundary(fragment, start) {
				let at = start;
				while (true) {
					const quote = fragment.indexOf("\"", at);
					const end = quote < 0 ? fragment.length : quote;
					if (this.#mode === "string") {
						const entry = this.#current;
						if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
					}
					let slashStart = end;
					while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
					const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
					this.#escape = quote < 0 && escaped;
					if (quote < 0 || !escaped) return end;
					at = quote + 1;
				}
			}
			step(c, at) {
				switch (this.#mode) {
					case "root":
						if (isWhitespace(c)) return;
						if (c === "{") {
							this.#mode = "key-or-end";
							return;
						}
						this.fail();
						return;
					case "key-or-end":
						if (isWhitespace(c)) return;
						if (c === "}") {
							this.#mode = "closed";
							return;
						}
						if (c === "\"") {
							this.beginKey(at);
							return;
						}
						this.fail();
						return;
					case "key-only":
						if (isWhitespace(c)) return;
						if (c === "\"") {
							this.beginKey(at);
							return;
						}
						this.fail();
						return;
					case "key":
						this.stepKey(c, at);
						return;
					case "colon":
						if (isWhitespace(c)) return;
						if (c === ":") {
							this.#mode = "value";
							return;
						}
						this.fail();
						return;
					case "value":
						this.beginValue(c, at);
						return;
					case "string": {
						const entry = this.#current;
						entry.end = at;
						this.#current = null;
						this.#mode = "comma-or-end";
						return;
					}
					case "scalar":
						this.stepScalar(c, at);
						return;
					case "nested":
						this.stepNested(c, at);
						return;
					case "comma-or-end":
						if (isWhitespace(c)) return;
						if (c === ",") {
							this.#mode = "key-only";
							return;
						}
						if (c === "}") {
							this.#mode = "closed";
							return;
						}
						this.fail();
						return;
					case "closed":
						if (isWhitespace(c)) return;
						this.fail();
						return;
					/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
					case "invalid": return;
					/* v8 ignore next 2 -- Every scanner mode has a handler above. */
					default: assertNever(this.#mode);
				}
			}
			fail() {
				this.#invalidAt = this.#consumed;
				this.#mode = "invalid";
				this.#current = null;
			}
			beginKey(at) {
				this.#mode = "key";
				this.#keyStart = at + 1;
				this.#keyEscaped = false;
				this.#escape = false;
			}
			stepKey(c, at) {
				if (c < " ") {
					this.fail();
					return;
				}
				if (this.#escape) {
					this.#escape = false;
					return;
				}
				if (c === "\\") {
					this.#escape = true;
					this.#keyEscaped = true;
					return;
				}
				if (c !== "\"") return;
				const raw = this.slice(this.#keyStart, at);
				if (this.#keyEscaped) try {
					this.#key = JSON.parse(`"${raw}"`);
				} catch (_error) {
					this.fail();
					return;
				}
				else this.#key = raw;
				this.#mode = "colon";
			}
			open(entry) {
				if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
				this.#entries.set(this.#key, entry);
				this.#current = entry;
			}
			beginValue(c, at) {
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.open({
						kind: "string",
						start: at + 1,
						end: -1,
						needsDecoding: false,
						invalidAt: void 0,
						length: void 0,
						text: void 0,
						prefixes: void 0
					});
					this.#escape = false;
					this.#mode = "string";
					return;
				}
				if (c === "}" || c === "," || c === ":" || c === "]") {
					this.fail();
					return;
				}
				this.open({
					kind: "value",
					start: at,
					end: -1,
					parsed: void 0,
					invalid: false
				});
				if (c === "{" || c === "[") {
					this.#mode = "nested";
					this.#nestedEnds = [c === "{" ? "}" : "]"];
					this.#nestedInString = false;
					this.#escape = false;
					return;
				}
				this.#mode = "scalar";
			}
			stepScalar(c, at) {
				if (c !== "," && c !== "}" && !isWhitespace(c)) return;
				this.closeValue(at);
				this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
			}
			stepNested(c, at) {
				if (this.#nestedInString) {
					this.#nestedInString = false;
					return;
				}
				if (c === "\"") {
					this.#nestedInString = true;
					return;
				}
				if (c === "{" || c === "[") {
					this.#nestedEnds.push(c === "{" ? "}" : "]");
					return;
				}
				if (c === "}" || c === "]") {
					if (this.#nestedEnds.pop() !== c) {
						this.fail();
						return;
					}
					if (this.#nestedEnds.length === 0) {
						this.closeValue(at + 1);
						this.#mode = "comma-or-end";
					}
				}
			}
			closeValue(end) {
				const entry = this.#current;
				entry.end = end;
				this.#current = null;
			}
		});
		//#endregion
		//#region ../../util/values/src/index.ts
		/**
		* Mark an unreachable closed-union branch.
		* @param value - impossible value; an unhandled typed variant fails at the call site.
		* @param context - optional switch-site label included in the failure message.
		* @returns never; a runtime value that escaped its type always throws.
		*/
		function assertNever(value, context) {
			const rendered = JSON.stringify(value) ?? String(value);
			throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
		}
		/**
		* Weak-key lookup with a strongly retained iterable set of associated values.
		*
		* Each value must belong to only one key. The container performs no automatic
		* cleanup; owners delete associations or clear the container at lifecycle end.
		*/
		var WeakMapWithValues = class {
			keys = /* @__PURE__ */ new WeakMap();
			valueSet = /* @__PURE__ */ new Set();
			/** Live strongly retained values in insertion order. */
			values = this.valueSet;
			/**
			* Read the value associated with a key.
			* @param key - weakly held lookup key.
			* @returns the associated value, or absence.
			*/
			get(key) {
				return this.keys.get(key);
			}
			/**
			* Test whether a key has an association.
			* @param key - weakly held lookup key.
			* @returns whether the key is present.
			*/
			has(key) {
				return this.keys.has(key);
			}
			/**
			* Associate one key with one caller-unique value.
			* @param key - weakly held lookup key.
			* @param value - strongly retained value that belongs to no other key.
			* @returns this container.
			*/
			set(key, value) {
				if (this.keys.has(key)) {
					const previous = this.keys.get(key);
					if (previous === value) return this;
					this.valueSet.delete(previous);
				}
				this.keys.set(key, value);
				this.valueSet.add(value);
				return this;
			}
			/**
			* Remove one association and its strongly retained value.
			* @param key - weakly held lookup key.
			* @returns whether an association was removed.
			*/
			delete(key) {
				if (!this.keys.has(key)) return false;
				const value = this.keys.get(key);
				const deleted = this.keys.delete(key);
				this.valueSet.delete(value);
				return deleted;
			}
			/** Remove every association and strongly retained value. */
			clear() {
				this.keys = /* @__PURE__ */ new WeakMap();
				this.valueSet.clear();
			}
		};
		//#endregion
		//#region lib/types/client/catalog.js
		/** One Host-generation model catalog shared by every Session selector. */
		/** Loads at most one model catalog for the current Host generation. */
		var ModelCatalogDirectory = class {
			ctx;
			/** Current shared catalog value and load lifecycle. */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				value: null,
				status: "idle",
				error: null
			});
			reasoning = /* @__PURE__ */ new Map();
			/**
			* Read the last advertised reasoning metadata, including unavailable models.
			* @param selection - provider and model whose effort is displayed.
			* @returns reasoning metadata observed during this Host generation.
			*/
			reasoningFor(selection) {
				return this.reasoning.get(JSON.stringify([selection.provider, selection.model]));
			}
			generation = 0;
			inflight;
			/**
			* @param ctx - the providing plugin's context, whose `remote.session`
			* namespace carries the Host-generation catalog.
			*/
			constructor(ctx) {
				this.ctx = ctx;
			}
			/**
			* Return the current generation's catalog, sharing its one in-flight load.
			* @returns the loaded global catalog.
			*/
			load() {
				const state = this.store.getSnapshot();
				if (state.status === "ready" && state.value !== null) return Promise.resolve(state.value);
				if (this.inflight !== void 0) return this.inflight;
				const generation = this.generation;
				this.store.update((draft) => {
					draft.status = "loading";
					draft.error = null;
				});
				const operation = this.ctx.remote.session.modelCatalog().then((response) => {
					if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
					if (generation === this.generation) {
						for (const group of response.value.groups) for (const model of group.models) this.reasoning.set(JSON.stringify([group.id, model.id]), model.reasoning);
						this.store.set({
							value: response.value,
							status: "ready",
							error: null
						});
					}
					return response.value;
				}).catch((error) => {
					if (generation === this.generation) this.store.update((draft) => {
						draft.status = "error";
						draft.error = error instanceof Error ? error.message : String(error);
					});
					throw error;
				}).finally(() => {
					if (generation === this.generation && this.inflight === operation) this.inflight = void 0;
				});
				this.inflight = operation;
				return operation;
			}
			/**
			* Invalidate the loaded catalog; the next explicit menu read reloads it.
			* @param clear - whether values from the previous Host generation must be hidden.
			*/
			invalidate(clear = false) {
				this.generation += 1;
				this.inflight = void 0;
				const value = clear ? null : this.store.getSnapshot().value;
				this.store.set({
					value,
					status: "idle",
					error: null
				});
			}
			/** Invalidate and reload the catalog after a Host-side model input changes. */
			refresh() {
				this.invalidate();
				this.load().catch(() => {});
			}
			/** Clear Host-specific values and load the replacement Host generation. */
			resetGeneration() {
				this.reasoning.clear();
				this.invalidate(true);
				this.load().catch(() => {});
			}
		};
		//#endregion
		//#region lib/types/client/directory.js
		/** One session's shared directory controller; disposed with the session scope. */
		var ModelDirectory = class {
			sessions;
			sessionId;
			available;
			catalog;
			projected;
			isBlank;
			track;
			/** The shared snapshot both entries render from (uSES-safe store). */
			store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				current: null,
				routable: null,
				groups: [],
				failures: [],
				status: "idle",
				pending: null,
				error: null
			});
			/** Latest selection operation wins; an older response never overwrites a newer one. */
			generation = 0;
			disposed = false;
			unsubscribeCatalog;
			unsubscribeSelection;
			/**
			* @param sessions - the session wire face (captured from the plugin's root connection).
			* @param sessionId - the owning session.
			* @param available - whether this session may use Agent-bound model RPCs.
			* @param catalog - Host-generation catalog shared by every Session.
			* @param projected - durable model selection projected from Session history.
			* @param isBlank - whether this Session has no first message yet.
			* @param track - desktop-only callback after a successful user selection.
			*/
			constructor(sessions, sessionId, available, catalog, projected, isBlank, track) {
				this.sessions = sessions;
				this.sessionId = sessionId;
				this.available = available;
				this.catalog = catalog;
				this.projected = projected;
				this.isBlank = isBlank;
				this.track = track;
				this.unsubscribeCatalog = catalog.store.subscribe(() => {
					this.syncInputs();
				});
				this.unsubscribeSelection = projected.subscribe(() => {
					this.syncInputs();
				});
				this.syncInputs();
			}
			/**
			* Ensure the Host generation's shared available catalog is loaded.
			* @returns the fresh directory value.
			*/
			async load() {
				this.assertAvailable();
				await this.catalog.load();
				this.syncInputs();
				return this.store.getSnapshot();
			}
			/**
			* Select the complete provider/model/reasoning selection. The durable
			* projection frame updates the shared current; failures surface on the store
			* and return with the operation so each entry can present its own failure.
			* @param selection - provider, provider-owned model id, and optional adapter-owned effort.
			* @returns the selection outcome, including the original Remote failure.
			*/
			async select(selection) {
				this.assertAvailable();
				const previous = this.store.getSnapshot().current;
				const previousEffort = previous?.reasoningEffort ?? (previous === null ? void 0 : this.catalog.reasoningFor(previous)?.defaultEffort);
				const nextEffort = selection.reasoningEffort ?? this.catalog.reasoningFor(selection)?.defaultEffort;
				const generation = ++this.generation;
				this.store.update((s) => {
					s.status = "selecting";
					s.pending = selection;
					s.error = null;
				});
				const result = await this.sessions.selectModel({
					sessionId: this.sessionId,
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				});
				if (this.disposed || generation !== this.generation) return result.ok ? {
					ok: true,
					value: void 0
				} : result;
				if (!result.ok) {
					this.store.update((s) => {
						s.status = "error";
						s.pending = null;
						s.error = `${result.error.code}: ${result.error.message}`;
					});
					return result;
				}
				if (previous !== null) {
					const from = `${previous.provider}/${previous.model}`;
					const to = `${selection.provider}/${selection.model}`;
					if (from !== to) this.track?.("model_switch", {
						...this.isBlank() ? {} : { session_id: this.sessionId },
						switch_from: from,
						switch_to: to
					});
					if (from === to && previousEffort !== nextEffort) this.track?.("thinking_level_switch", {
						...this.isBlank() ? {} : { session_id: this.sessionId },
						model_name: to,
						switch_from: previousEffort ?? "default",
						switch_to: nextEffort ?? "default"
					});
				}
				this.store.update((s) => {
					s.status = "ready";
					s.pending = null;
					s.error = null;
				});
				this.syncInputs();
				return {
					ok: true,
					value: void 0
				};
			}
			/**
			* Invalidate an in-flight selection response from the previous Host generation.
			*/
			resetConnected() {
				if (this.disposed) return;
				++this.generation;
				this.store.update((state) => {
					if (state.status === "selecting") state.status = "idle";
					state.pending = null;
					state.error = null;
				});
				this.syncInputs();
			}
			/** Scope teardown: late settlements lose write access to the store. */
			dispose() {
				this.disposed = true;
				this.unsubscribeSelection();
				this.unsubscribeCatalog();
			}
			assertAvailable() {
				if (!this.available()) throw new Error("model selection is unavailable for addressed subagent sessions");
			}
			syncInputs() {
				if (this.disposed) return;
				const catalog = this.catalog.store.getSnapshot();
				const projected = modelSelectionProjection(this.projected.getSnapshot());
				const intended = projected?.next ?? catalog.value?.default;
				const reasoning = intended === void 0 ? void 0 : this.catalog.reasoningFor(intended);
				const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort;
				const retainedEffort = effort === void 0 ? void 0 : reasoning?.efforts.find((level) => level.id === effort)?.name ?? effort;
				if (catalog.status !== "ready" || catalog.value === null || projected === void 0) {
					this.store.set({
						current: catalog.value === null ? null : this.store.getSnapshot().current,
						...retainedEffort === void 0 ? {} : { retainedEffort },
						routable: null,
						groups: catalog.value?.groups ?? [],
						failures: catalog.value?.failures ?? [],
						status: catalog.status === "error" ? "error" : "loading",
						pending: this.store.getSnapshot().pending,
						error: catalog.error
					});
					return;
				}
				const selection = projected.next ?? catalog.value.default;
				const routable = catalog.value.groups.some((group) => group.id === selection.provider && group.models.some((model) => model.id === selection.model));
				this.store.set({
					current: selection,
					...retainedEffort === void 0 ? {} : { retainedEffort },
					routable,
					groups: catalog.value.groups,
					failures: catalog.value.failures,
					status: this.store.getSnapshot().status === "selecting" ? "selecting" : "ready",
					pending: this.store.getSnapshot().pending,
					error: null
				});
			}
		};
		function modelSelectionProjection(value) {
			return value === void 0 ? void 0 : value;
		}
		//#endregion
		//#region lib/types/client/service.js
		/** The `ctx.modelDirectories` session model-selection service. */
		var ModelDirectoryResolver = class extends _deepseek_ai_cordis.Service {
			static inject = [
				"sessions",
				"remote",
				"remote.session"
			];
			live = { directories: new WeakMapWithValues() };
			catalog;
			/**
			* @param ctx - owning root context (the service registers itself as `models`).
			*/
			constructor(ctx) {
				super(ctx, "modelDirectories");
				this.catalog = new ModelCatalogDirectory(ctx);
				this.catalog.load().catch(() => {});
				ctx.on("connection/reset", () => {
					this.catalog.resetGeneration();
					for (const directory of this.live.directories.values) directory.resetConnected();
				});
				ctx.remote.$on("llm/adapters-updated", () => {
					this.catalog.refresh();
				});
				ctx.remote.$on("settings/document-updated", () => {
					this.catalog.refresh();
				});
				ctx.remote.$on("credentials/record-updated", () => {
					this.catalog.refresh();
				});
				ctx.remote.$on("credentials/reference-updated", () => {
					this.catalog.refresh();
				});
			}
			/**
			* Resolve the per-session shared directory (lazy; the scope disposer
			* removes and disposes it). Unknown sessions fail loud.
			* @param sessionId - the owning session.
			* @returns the resident directory both entries share.
			*/
			directoryFor(sessionId) {
				const { live } = this;
				const sessions = this.ctx.sessions;
				const actx = sessions.scope(sessionId);
				if (actx === void 0) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`);
				const binding = sessions.binding(sessionId);
				if (binding === void 0) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no binding`);
				const existing = live.directories.get(binding);
				if (existing !== void 0) return existing;
				const directory = new ModelDirectory(this.ctx.remote.session, sessionId, () => sessions.subagentAddress(sessionId) === void 0, this.catalog, binding.session.projections.faceOf("modelSelection"), () => binding.session.getSnapshot().blank, (name, attributes) => this.ctx.get("productAnalytics")?.track(name, attributes));
				live.directories.set(binding, directory);
				actx.effect(() => () => {
					directory.dispose();
					live.directories.delete(binding);
				}, "ui-model-selection: session directory");
				return directory;
			}
		};
		//#endregion
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.module.css.mjs
		const css = "._7KE1Ra_root{min-width:0;position:relative}._7KE1Ra_trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:flex}._7KE1Ra_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._7KE1Ra_trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}._7KE1Ra_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}._7KE1Ra_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}._7KE1Ra_triggerEffort{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-caption);flex-shrink:1000;overflow:hidden}._7KE1Ra_triggerIcon{display:var(--dsh-composer-model-icon-display,none);flex:none}._7KE1Ra_triggerLabel,._7KE1Ra_triggerEffort{display:var(--dsh-composer-model-text-display,block)}._7KE1Ra_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}._7KE1Ra_chevronOpen{transform:rotate(180deg)}._7KE1Ra_menu{z-index:1100;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex-direction:column;padding:4px;display:flex;position:fixed;overflow:hidden}._7KE1Ra_status,._7KE1Ra_empty{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}._7KE1Ra_error,._7KE1Ra_warning{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px;padding:6px 7px;font-size:11px;line-height:16px;display:flex}._7KE1Ra_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}._7KE1Ra_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}._7KE1Ra_searchRow{flex-shrink:0;margin:2px 0 3px;position:relative}._7KE1Ra_searchRow ._7KE1Ra_search{border-radius:var(--dsw-radius-md);background:0 0;border:0 solid #0000;height:auto;padding:5px 7px;display:flex}._7KE1Ra_searchRow ._7KE1Ra_searchWithQuery{padding-right:34px}._7KE1Ra_searchClear{corner-shape:round;width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:50%;right:4px;transform:translateY(-50%)}._7KE1Ra_searchClear:hover,._7KE1Ra_searchClear:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}._7KE1Ra_searchRow ._7KE1Ra_search:focus-within{border-color:#0000}._7KE1Ra_searchRow ._7KE1Ra_search input{padding:0;font-size:12px;line-height:normal}._7KE1Ra_searchRow ._7KE1Ra_search input::placeholder{color:var(--dsw-alias-label-caption)}._7KE1Ra_groups{min-height:0;overflow-y:auto}._7KE1Ra_option{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px;display:flex}._7KE1Ra_option:not(._7KE1Ra_modelOption):hover:not(:disabled),._7KE1Ra_option:focus-visible,._7KE1Ra_optionActive:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._7KE1Ra_selected{background:0 0}._7KE1Ra_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}._7KE1Ra_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}._7KE1Ra_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:18px;overflow:hidden}._7KE1Ra_check{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid}._7KE1Ra_check svg{width:14px;height:14px}._7KE1Ra_cell{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 8px;font-size:13px;line-height:20px;display:flex}._7KE1Ra_cell:hover,._7KE1Ra_cell:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}._7KE1Ra_cellLabel{white-space:nowrap;flex:none}._7KE1Ra_cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}._7KE1Ra_cellChevron{width:12px;height:12px;color:var(--dsw-alias-menu-icon);flex:none}";
		const tagId = "@deepseek-ai/dsh-client-ui-model-selection/ModelSelect.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-model-selection";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ModelSelect_module_css_default = {
			"cell": "_7KE1Ra_cell",
			"cellChevron": "_7KE1Ra_cellChevron",
			"cellLabel": "_7KE1Ra_cellLabel",
			"cellValue": "_7KE1Ra_cellValue",
			"check": "_7KE1Ra_check",
			"chevron": "_7KE1Ra_chevron",
			"chevronOpen": "_7KE1Ra_chevronOpen",
			"empty": "_7KE1Ra_empty",
			"error": "_7KE1Ra_error",
			"groups": "_7KE1Ra_groups",
			"menu": "_7KE1Ra_menu",
			"modelName": "_7KE1Ra_modelName",
			"modelOption": "_7KE1Ra_modelOption",
			"option": "_7KE1Ra_option",
			"optionActive": "_7KE1Ra_optionActive",
			"optionCopy": "_7KE1Ra_optionCopy",
			"retry": "_7KE1Ra_retry",
			"root": "_7KE1Ra_root",
			"search": "_7KE1Ra_search",
			"searchClear": "_7KE1Ra_searchClear",
			"searchRow": "_7KE1Ra_searchRow",
			"searchWithQuery": "_7KE1Ra_searchWithQuery",
			"selected": "_7KE1Ra_selected",
			"status": "_7KE1Ra_status",
			"trigger": "_7KE1Ra_trigger",
			"triggerEffort": "_7KE1Ra_triggerEffort",
			"triggerIcon": "_7KE1Ra_triggerIcon",
			"triggerLabel": "_7KE1Ra_triggerLabel",
			"warning": "_7KE1Ra_warning"
		};
		//#endregion
		//#region lib/types/client/provider-order.js
		/** Shared provider display order for the composer and command model pickers. */
		/**
		* Put the account and official providers first, preserving every other relative order.
		* @param groups - Provider groups in catalog order.
		* @returns a sorted copy; model order within each group is unchanged.
		*/
		function orderModelProviders(groups) {
			return groups.toSorted((left, right) => (left.id === "deepseek-account" ? 0 : left.id === "deepseek-official" ? 1 : 2) - (right.id === "deepseek-account" ? 0 : right.id === "deepseek-official" ? 1 : 2));
		}
		//#endregion
		//#region lib/types/client/ModelSelect.js
// DSH model picker overlay v1
// Reviewed SDK 0.2.1-rc.2; optional renderer labels retain the Host model metadata.
const DSH_PICKER_KEY = "dsh:model-picker:v1";
const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };
const pickerPair = (value) => JSON.stringify([value.provider, value.model]);
function pickerPreferences() {
  try {
    const raw = localStorage.getItem(DSH_PICKER_KEY);
    const data = raw && raw.length < 1e5 ? JSON.parse(raw) : {};
    const clean = (values, limit) => {
      const seen = /* @__PURE__ */ new Set();
      return (Array.isArray(values) ? values : []).filter((value) => {
        if (!value || typeof value.provider !== "string" || typeof value.model !== "string" || value.provider.length > 512 || value.model.length > 1024) return false;
        const key = pickerPair(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, limit).map(({ provider, model }) => ({ provider, model }));
    };
    return { recent: clean(data?.recent, 30), favorites: clean(data?.favorites, 100) };
  } catch {
    return { recent: [], favorites: [] };
  }
}
function savePickerPreferences(value) {
  try {
    localStorage.setItem(DSH_PICKER_KEY, JSON.stringify(value));
  } catch {
  }
}
function pickerRows(groups, query, provider, view, preferences, current) {
  const terms = query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const compact = (text) => text.replace(/[\s\p{P}\p{S}]+/gu, "");
  const favorites = new Set(preferences.favorites.map(pickerPair));
  const recent = new Map(preferences.recent.map((value, index) => [pickerPair(value), index]));
  const rows = [];
  for (const group of groups) for (const model of group.models) {
    const row = { provider: group.id, providerName: group.name, model: model.id, name: model.name };
    const key = pickerPair(row);
    if (provider && row.provider !== provider || view === "favorites" && !favorites.has(key) || view === "recent" && !recent.has(key)) continue;
    const text = `${row.name} ${row.model} ${row.providerName} ${row.provider}`.normalize("NFKC").toLowerCase();
    if (!terms.every((term) => text.includes(term) || compact(text).includes(compact(term)))) continue;
    const selected = current && pickerPair(current) === key;
    const name = compact(row.name.toLowerCase());
    const score = terms.length ? terms.reduce((n, term) => n + (name === compact(term) ? 100 : name.startsWith(compact(term)) ? 20 : name.includes(compact(term)) ? 10 : 0), 0) : 0;
    rows.push({ ...row, selected, favorite: favorites.has(key), recent: recent.get(key), score });
  }
  rows.sort((a, b) => terms.length ? b.score - a.score : view === "recent" ? a.recent - b.recent : Number(b.selected) - Number(a.selected) || Number(b.favorite) - Number(a.favorite) || (a.recent ?? 999) - (b.recent ?? 999));
  return rows;
}
function ModelSelect({ locked, available, directory, load, select, t, renderSlot = (_seat, _props, options) => options.fallback }) {
  const state = react.useSyncExternalStore((fn) => directory.subscribe(fn), () => directory.getSnapshot());
  const [open, setOpen] = react.useState(false);
  const [pane, setPane] = react.useState("model");
  const [query, setQuery] = react.useState("");
  const [provider, setProvider] = react.useState("");
  const [view, setView] = react.useState("all");
  const [preferences, setPreferences] = react.useState(pickerPreferences);
  const [active, setActive] = react.useState(0);
  const [toast, setToast] = react.useState(null);
  const [pos, setPos] = react.useState(MEASURE_STYLE);
  const [submitting, setSubmitting] = react.useState(false);
  const triggerRef = react.useRef(null), menuRef = react.useRef(null), inputRef = react.useRef(null), itemRefs = react.useRef([]);
  const alive = react.useRef(true), selecting = react.useRef(false), toastSeq = react.useRef(0);
  const id = react.useId();
  const P = _deepseek_ai_dsh_client_ui_primitives;
  const english = t("menu.model") === "Model";
  const words = english ? { title: "Choose model", search: "Search model or API\u2026", source: "API source", allSources: "All APIs", all: "All", favorites: "Favorites", recent: "Recent", current: "Current", close: "Close model picker", add: "Favorite", remove: "Unfavorite", empty: "No matching models", reset: "Clear filters", noFavorites: "Use \u2606 beside a model to save it here.", noRecent: "Models you choose appear here.", count: "models", effort: "Reasoning effort", back: "Back to models" } : { title: "\u9009\u62E9\u6A21\u578B", search: "\u641C\u7D22\u6A21\u578B\u6216 API \u6765\u6E90\u2026", source: "API \u6765\u6E90", allSources: "\u5168\u90E8 API", all: "\u5168\u90E8", favorites: "\u6536\u85CF", recent: "\u6700\u8FD1", current: "\u5F53\u524D", close: "\u5173\u95ED\u6A21\u578B\u9009\u62E9", add: "\u6536\u85CF", remove: "\u53D6\u6D88\u6536\u85CF", empty: "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u6A21\u578B", reset: "\u6E05\u9664\u7B5B\u9009", noFavorites: "\u70B9\u6A21\u578B\u65C1\u7684 \u2606\uFF0C\u4E0B\u6B21\u5728\u8FD9\u91CC\u5FEB\u901F\u627E\u5230\u3002", noRecent: "\u5207\u6362\u8FC7\u7684\u6A21\u578B\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002", count: "\u4E2A\u6A21\u578B", effort: "\u63A8\u7406\u7B49\u7EA7", back: "\u8FD4\u56DE\u6A21\u578B\u5217\u8868" };
  const accountProviderName = t("provider.account");
  const groups = react.useMemo(() => orderModelProviders(state.groups).map((group) => ({ ...group, name: group.id === "deepseek-account" ? accountProviderName : group.name })), [state.groups, accountProviderName]);
  const currentGroup = groups.find((group) => group.id === state.current?.provider);
  const currentModel = currentGroup?.models.find((model) => model.id === state.current?.model);
  const reasoning = currentModel?.reasoning;
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
  const effortLabel = reasoning === void 0 ? state.retainedEffort : effectiveEffort === void 0 ? t("effort.providerDefault") : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort;
  const effortChoices = reasoning === void 0 ? [] : [...reasoning.defaultEffort === void 0 ? [{ id: "provider-default", effort: void 0, name: t("effort.providerDefault") }] : [], ...reasoning.efforts.map((level) => ({ id: level.id, effort: level.id, name: level.name }))];
  const rows = react.useMemo(() => pickerRows(groups, query, provider, view, preferences, state.current), [groups, query, provider, view, preferences, state.current]);
  const activeIndex = Math.min(active, rows.length - 1);
  const busy = state.pending !== null || submitting;
  const modelLabel = currentModel?.name ?? (state.current ? `${state.current.provider}/${state.current.model}` : t("trigger.fallback"));
  const renderModelLabel = (providerId, modelId, placement, selected) => {
    const group = groups.find((g) => g.id === providerId), model = group?.models.find((m) => m.id === modelId);
    if (!group || !model) return modelId;
    return /* @__PURE__ */ react.createElement("span", { "data-provider-id": providerId, "data-model-id": modelId }, renderSlot("conversation.input.model.label", { provider: { id: group.id, name: group.name }, model, placement, selected }, { fallback: model.name }));
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) triggerRef.current?.focus();
  };
  const reset = () => {
    setQuery("");
    setProvider("");
    setView("all");
    setActive(0);
  };
  const remember = (value) => {
    const next = { ...preferences, recent: [{ provider: value.provider, model: value.model }, ...preferences.recent.filter((item) => pickerPair(item) !== pickerPair(value))].slice(0, 30) };
    setPreferences(next);
    savePickerPreferences(next);
  };
  const favorite = (row) => {
    const next = { ...preferences, favorites: row.favorite ? preferences.favorites.filter((item) => pickerPair(item) !== pickerPair(row)) : [...preferences.favorites, { provider: row.provider, model: row.model }].slice(-100) };
    setPreferences(next);
    savePickerPreferences(next);
    setActive(0);
  };
  const submit = async (value, isEffort = false) => {
    if (selecting.current || busy || locked) return;
    if (!isEffort && state.current?.provider === value.provider && state.current.model === value.model) {
      remember(value);
      close();
      return;
    }
    selecting.current = true;
    setSubmitting(true);
    setToast(null);
    try {
      const result = await select(value);
      if (!alive.current) return;
      if (result?.ok) {
        if (!isEffort) remember(value);
        close();
      } else if (result && !result.ok) {
        const error = result.error;
        setToast({ seq: ++toastSeq.current, text: error.code === "session/writer-held" ? t("error.sessionInUse") : t("error.action", { message: `${error.code}: ${error.message}` }) });
      }
    } catch (error) {
      if (alive.current) setToast({ seq: ++toastSeq.current, text: t("error.action", { message: String(error.message ?? error) }) });
    } finally {
      selecting.current = false;
      if (alive.current) setSubmitting(false);
    }
  };
  const choose = (row) => submit({ provider: row.provider, model: row.model });
  react.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  react.useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  react.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect(), menu = menuRef.current;
      if (!rect || !menu) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const mobile = innerWidth <= 600;
      const tablet = !mobile && matchMedia("(pointer:coarse)").matches;
      const maxHeight = Math.max(100, Math.min(tablet ? 680 : mobile ? 620 : 580, height - (tablet ? 48 : 24)));
      const h = Math.min(menu.offsetHeight, maxHeight);
      setPos({ visibility: "visible", maxHeight, left: tablet ? left + (width - menu.offsetWidth) / 2 : mobile ? left + 12 : Math.max(left + 12, Math.min(rect.right - menu.offsetWidth, left + width - menu.offsetWidth - 12)), top: tablet ? top + (height - h) / 2 : mobile ? top + height - h - 12 : Math.max(top + 12, Math.min(rect.top - h - 8, top + height - h - 12)) });
    };
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, pane]);
  react.useEffect(() => {
    if (!open) return;
    if (pane === "model" && matchMedia("(min-width:601px) and (pointer:fine)").matches) inputRef.current?.focus();
    else if (pane === "effort") menuRef.current?.querySelector('[aria-checked="true"]')?.focus();
  }, [open, pane]);
  react.useLayoutEffect(() => {
    if (open && pane === "model") itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, pane, activeIndex, rows]);
  const keys = (event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (pane === "effort") setPane("model");
      else if (query) {
        setQuery("");
        setActive(0);
      } else close();
    } else if (pane === "model" && (event.target === inputRef.current || event.target.dataset.pickerModel !== void 0)) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy && rows.length) {
          const next = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
          setActive(next);
          if (event.target !== inputRef.current) itemRefs.current[next]?.focus();
        }
      } else if (event.key === "Enter" && event.target === inputRef.current) {
        event.preventDefault();
        event.stopPropagation();
        if (rows[activeIndex]) choose(rows[activeIndex]);
      }
    }
  };
  if (!available) return null;
  return /* @__PURE__ */ react.createElement("div", { className: ModelSelect_module_css_default.root, onKeyDown: keys }, /* @__PURE__ */ react.createElement("button", { ref: triggerRef, className: ModelSelect_module_css_default.trigger, type: "button", disabled: locked || busy, "aria-haspopup": "dialog", "aria-expanded": open, "aria-controls": `${id}-menu`, "aria-label": state.current ? t("trigger.aria", { model: modelLabel }) : t("trigger.selectAria"), title: `${currentGroup?.name ?? ""} \xB7 ${modelLabel}${effortLabel ? " \xB7 " + effortLabel : ""}`, onClick: () => {
    if (open) {
      close();
      return;
    }
    setPreferences(pickerPreferences());
    reset();
    setPane("model");
    setOpen(true);
    load();
  } }, /* @__PURE__ */ react.createElement("span", { className: ModelSelect_module_css_default.triggerLabel }, currentGroup && currentModel ? renderModelLabel(currentGroup.id, currentModel.id, "trigger", true) : modelLabel), effortLabel && /* @__PURE__ */ react.createElement("span", { className: ModelSelect_module_css_default.triggerEffort }, " \xB7 ", effortLabel), busy ? /* @__PURE__ */ react.createElement(P.StateDot, { state: "ongoing" }) : /* @__PURE__ */ react.createElement(P.IconChevronDownOutlineRegular, null)), open && react_dom.createPortal(/* @__PURE__ */ react.createElement(P.MenuSurface, { ref: menuRef, id: `${id}-menu`, role: "dialog", "aria-label": words.title, "aria-busy": busy, className: "dsh-picker", style: pos, onKeyDown: keys }, /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-head" }, /* @__PURE__ */ react.createElement("strong", null, pane === "effort" ? words.effort : words.title), /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-actions" }, pane === "effort" ? /* @__PURE__ */ react.createElement("button", { type: "button", onClick: () => setPane("model") }, words.back) : reasoning && /* @__PURE__ */ react.createElement("button", { type: "button", disabled: busy, onClick: () => setPane("effort") }, words.effort, " \xB7 ", effortLabel), /* @__PURE__ */ react.createElement("button", { type: "button", "aria-label": words.close, onClick: () => close() }, "\xD7"))), pane === "model" ? /* @__PURE__ */ react.createElement(react.Fragment, null, state.current && /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-current" }, /* @__PURE__ */ react.createElement("span", null, words.current), /* @__PURE__ */ react.createElement("span", { title: modelLabel }, currentGroup && currentModel ? renderModelLabel(currentGroup.id, currentModel.id, "menu", true) : modelLabel, /* @__PURE__ */ react.createElement("small", null, currentGroup?.name ?? state.current.provider))), /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-search" }, /* @__PURE__ */ react.createElement(P.Input, { ref: inputRef, icon: /* @__PURE__ */ react.createElement(P.IconSearchOutlineRegular, null), type: "search", role: "searchbox", "aria-label": words.search, "aria-controls": `${id}-models`, "aria-activedescendant": activeIndex >= 0 ? `${id}-model-${activeIndex}` : void 0, placeholder: words.search, value: query, readOnly: busy, autoComplete: "off", onChange: (event) => {
    setQuery(event.target.value);
    setActive(0);
  } }), query && /* @__PURE__ */ react.createElement("button", { type: "button", "aria-label": t("search.clear"), onClick: () => {
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  } }, "\xD7")), /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-filters" }, /* @__PURE__ */ react.createElement("div", { role: "group", "aria-label": english ? "Model filters" : "\u6A21\u578B\u7B5B\u9009" }, ["all", "favorites", "recent"].map((value) => /* @__PURE__ */ react.createElement("button", { key: value, type: "button", disabled: busy, "aria-pressed": view === value, onClick: () => {
    setView(value);
    setActive(0);
  } }, words[value]))), /* @__PURE__ */ react.createElement("select", { "aria-label": words.source, value: provider, disabled: busy, onChange: (event) => {
    setProvider(event.target.value);
    setActive(0);
  } }, /* @__PURE__ */ react.createElement("option", { value: "" }, words.allSources), groups.map((group) => /* @__PURE__ */ react.createElement("option", { key: group.id, value: group.id }, group.name)))), /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-list scrollable", id: `${id}-models`, role: "menu", "aria-label": t("menu.model") }, state.status === "loading" && /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-status", role: "status" }, t("status.loading")), state.error && !toast && /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-error", role: "alert" }, t("error.action", { message: state.error }), " ", /* @__PURE__ */ react.createElement("button", { type: "button", disabled: busy, onClick: load }, t("action.reload"))), state.failures.map((failure) => /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-error", key: failure.id }, t("warning.groupLoad", { name: failure.id === "deepseek-account" ? accountProviderName : failure.name, message: failure.message }), " ", /* @__PURE__ */ react.createElement("button", { type: "button", disabled: busy, onClick: load }, t("action.reload")))), rows.map((row, index) => /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-row", key: pickerPair(row) }, /* @__PURE__ */ react.createElement("button", { ref: (node) => {
    itemRefs.current[index] = node;
  }, "data-picker-model": "", "data-provider": row.provider, "data-model": row.model, type: "button", role: "menuitemradio", "aria-checked": !!row.selected, id: `${id}-model-${index}`, disabled: busy || locked, "data-highlighted": index === activeIndex ? "" : void 0, className: "dsh-picker-choice", onFocus: () => setActive(index), onClick: () => choose(row), title: `${row.name}
${row.providerName} \xB7 ${row.model}` }, /* @__PURE__ */ react.createElement("span", { className: "dsh-picker-copy" }, /* @__PURE__ */ react.createElement("span", null, renderModelLabel(row.provider, row.model, "option", !!row.selected)), /* @__PURE__ */ react.createElement("small", null, row.providerName, row.model !== row.name ? ` \xB7 ${row.model}` : "")), /* @__PURE__ */ react.createElement("span", { className: "dsh-picker-check" }, state.pending?.provider === row.provider && state.pending.model === row.model ? /* @__PURE__ */ react.createElement(P.StateDot, { state: "ongoing" }) : row.selected ? "\u2713" : "")), /* @__PURE__ */ react.createElement("button", { type: "button", className: "dsh-picker-star", "aria-label": `${row.favorite ? words.remove : words.add} ${row.name} \xB7 ${row.providerName}`, "aria-pressed": row.favorite, disabled: busy, onClick: () => favorite(row) }, row.favorite ? "\u2605" : "\u2606"))), rows.length === 0 && state.status !== "loading" && /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-empty", role: "status" }, /* @__PURE__ */ react.createElement("strong", null, words.empty), /* @__PURE__ */ react.createElement("span", null, view === "favorites" ? words.noFavorites : view === "recent" ? words.noRecent : ""), (query || provider || view !== "all") && /* @__PURE__ */ react.createElement("button", { type: "button", onClick: reset }, words.reset))), /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-foot" }, /* @__PURE__ */ react.createElement("span", null, rows.length, " ", words.count), groups.some((g) => g.id === "zcode") && /* @__PURE__ */ react.createElement("button", { type: "button", className: "dsh-picker-reset", "aria-label": "\u91CD\u7F6E ZCode \u5957\u9910\u989D\u5EA6", disabled: busy, onClick: () => {
    const launch = globalThis.__dshOpenZcodeReset;
    if (typeof launch !== "function") {
      setToast({ seq: ++toastSeq.current, text: "\u989D\u5EA6\u91CD\u7F6E\u5165\u53E3\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u65B0\u6253\u5F00\u6A21\u578B\u9009\u62E9\u5668" });
      return;
    }
    close(false);
    launch({ model: state.current?.provider === "zcode" ? state.current.model : void 0, onChanged: load, returnFocus: triggerRef.current });
  } }, "ZCode \u91CD\u7F6E\u989D\u5EA6"), /* @__PURE__ */ react.createElement("span", { className: "dsh-picker-shortcuts" }, "\u2191 \u2193 ", english ? "navigate" : "\u9009\u62E9", " \xB7 Enter ", english ? "confirm" : "\u786E\u8BA4", " \xB7 Esc ", english ? "close" : "\u5173\u95ED"))) : /* @__PURE__ */ react.createElement("div", { className: "dsh-picker-list", role: "menu", "aria-label": words.effort }, effortChoices.map((level) => /* @__PURE__ */ react.createElement("button", { key: level.id, type: "button", role: "menuitemradio", "aria-checked": effectiveEffort === level.effort, className: "dsh-picker-effort", disabled: busy || locked, onClick: () => {
    if (effectiveEffort === level.effort) {
      close();
      return;
    }
    submit({ provider: state.current.provider, model: state.current.model, ...level.effort === void 0 ? {} : { reasoningEffort: level.effort } }, true);
  } }, level.name, /* @__PURE__ */ react.createElement("span", null, effectiveEffort === level.effort ? "\u2713" : ""))))), document.body), toast && /* @__PURE__ */ react.createElement(P.Toast, { key: toast.seq, text: toast.text, icon: /* @__PURE__ */ react.createElement(P.IconWarningOutlineRegular, null), anchor: triggerRef.current?.closest("[data-composer-card]") ?? null, onDone: () => setToast(null) }));
}

const pickerStyle = document.createElement('style');
pickerStyle.dataset.pluginCss = 'dsh-model-picker';
pickerStyle.textContent = ".dsh-picker{box-sizing:border-box;position:fixed;z-index:1100;display:flex;flex-direction:column;overflow:hidden;width:min(440px,calc(100vw - 24px));max-width:calc(100vw - 24px);min-width:0;max-height:min(580px,calc(100dvh - 24px));padding:10px;border:1px solid var(--dsw-alias-border-l1,#dce1e8);border-radius:16px;font-size:13px;color:var(--dsw-alias-label-primary,#222);box-shadow:var(--dsw-elevation-prominent,0 12px 40px #0003)}\n.dsh-picker button,.dsh-picker select{font:inherit;color:inherit;cursor:pointer}\n.dsh-picker button:disabled,.dsh-picker select:disabled{cursor:default;opacity:.55}\n.dsh-picker button:focus-visible,.dsh-picker select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#5383ef));outline-offset:-2px}\n.dsh-picker-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;padding:0 2px 8px}\n.dsh-picker-head strong{font-size:15px;white-space:nowrap}\n.dsh-picker-actions{display:flex;align-items:center;gap:4px}\n.dsh-picker-actions button{background:transparent;border:0;border-radius:8px;padding:6px;min-height:32px}\n.dsh-picker-actions button:last-child{font-size:22px;min-width:32px}\n.dsh-picker-current{display:flex;gap:10px;align-items:center;background:var(--dsw-alias-bg-module-platform,#f2f4f8);border-radius:10px;padding:8px 10px;margin-bottom:8px;flex-shrink:0}\n.dsh-picker-current>span:first-child{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;flex:none}\n.dsh-picker-current>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsh-picker-current small{display:block;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;margin-top:2px}\n.dsh-picker-search{position:relative;flex-shrink:0}\n.dsh-picker-search>span{width:100%;box-sizing:border-box;border-radius:10px;background:var(--dsw-alias-bg-module-platform,#f2f4f8);min-height:40px}\n.dsh-picker-search input{font-size:14px!important;padding-right:30px!important;min-width:0}\n.dsh-picker-search input::-webkit-search-cancel-button{display:none}\n.dsh-picker-search>button{position:absolute;right:4px;top:4px;width:32px;height:32px;border:0;border-radius:8px;background:transparent;font-size:20px}\n.dsh-picker-filters{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;flex-shrink:0}\n.dsh-picker-filters>div{display:flex;gap:2px;flex:none}\n.dsh-picker-filters button{border:0;background:transparent;padding:6px 10px;min-height:34px;border-radius:8px}\n.dsh-picker-filters button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#e7ecf8);color:var(--dsw-alias-state-business-primary,#3267c4);font-weight:600}\n.dsh-picker-filters select{min-width:0;max-width:46%;border:1px solid var(--dsw-alias-border-l1,#dce1e8);border-radius:8px;padding:5px;min-height:34px;background:var(--dsw-alias-bg-base,#fff)}\n.dsh-picker-list{overflow-y:auto;overflow-x:hidden;min-height:0;flex:1 1 auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y;scrollbar-gutter:stable}\n.dsh-picker-row{display:flex;align-items:center;gap:2px;min-width:0}\n.dsh-picker-choice{display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-align:left;border:0;background:transparent;border-radius:9px;padding:9px 10px;min-height:52px}\n.dsh-picker-choice:hover,.dsh-picker-choice[data-highlighted],.dsh-picker-actions button:hover,.dsh-picker-star:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f7)}\n.dsh-picker-choice[aria-checked=true]{background:var(--dsw-alias-bg-module-platform,#f2f4f8)}\n.dsh-picker-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:3px}\n.dsh-picker-copy>span{font-size:13px;line-height:18px;overflow-wrap:anywhere}\n.dsh-picker-copy small{font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#6b7280)}\n.dsh-picker-check{width:16px;flex:none;color:var(--dsw-alias-state-business-primary,#3267c4)}\n.dsh-picker-star{background:transparent;border:0;min-width:36px;height:40px;font-size:20px!important;border-radius:8px;flex:none;color:var(--dsw-alias-label-tertiary,#6b7280)!important}\n.dsh-picker-star[aria-pressed=true]{color:var(--dsw-alias-state-business-primary,#3267c4)!important}\n.dsh-picker-foot{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;padding:8px 4px 0;flex-shrink:0}\n.dsh-picker-status,.dsh-picker-error{font-size:12px;padding:8px;overflow-wrap:anywhere}\n.dsh-picker-error{color:var(--dsw-alias-state-error-primary,#b84343)}\n.dsh-picker-error button,.dsh-picker-empty button{background:transparent;border:0;text-decoration:underline;padding:6px}\n.dsh-picker-empty{display:flex;align-items:center;flex-direction:column;gap:10px;padding:28px 10px;text-align:center}\n.dsh-picker-empty span{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px}\n.dsh-picker-effort{display:flex;justify-content:space-between;border:0;background:transparent;border-radius:8px;width:100%;padding:12px;min-height:44px;text-align:left}\n.dsh-picker-effort:hover,.dsh-picker-effort[aria-checked=true]{background:var(--dsw-alias-interactive-bg-hover,#eef1f7)}\n@media(max-width:600px){.dsh-picker{width:calc(100vw - 24px);padding:10px;border-radius:18px}.dsh-picker-shortcuts{display:none}.dsh-picker-choice{min-height:58px}.dsh-picker-star{min-width:44px;height:44px}.dsh-picker-filters button{padding:8px;min-height:40px}.dsh-picker-filters select{min-height:40px;font-size:12px}.dsh-picker-search input{font-size:16px!important}.dsh-picker-actions button{min-height:40px}.dsh-picker-actions button:last-child{min-width:40px}}\n@media(pointer:coarse) and (min-width:601px){.dsh-picker{width:min(600px,calc(100vw - 64px));max-width:calc(100vw - 48px);padding:14px;border-radius:18px}.dsh-picker-shortcuts{display:none}.dsh-picker-choice{min-height:58px}.dsh-picker-star{min-width:44px;height:44px}.dsh-picker-filters button,.dsh-picker-filters select,.dsh-picker-actions button{min-height:40px}.dsh-picker-search input{font-size:16px!important}}\n\n.dsh-picker-foot{flex-wrap:wrap;gap:8px}.dsh-picker-reset{border:1px solid var(--dsw-alias-border-l1,#dce1e8);background:transparent;border-radius:8px;padding:6px 10px;min-height:32px;white-space:nowrap}\n";
document.head.querySelector('style[data-plugin-css="dsh-model-picker"]')?.remove();
document.head.appendChild(pickerStyle);
		//#endregion
		//#region lib/types/client/locales.js
		/**
		* `model` namespace dictionaries.
		*
		* `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
		* separate key: the visible fallback label and the accessible name of
		* an unset trigger are free to diverge per locale, and folding it into
		* `trigger.aria` would announce the degenerate "Select model, current Select
		* model".
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"provider.account": "DeepSeek 账号",
			"command.label": "模型",
			"command.description": "选择本会话使用的模型",
			"option.loadError": "目录加载失败：{message}",
			"trigger.fallback": "请选择模型",
			"trigger.loading": "正在加载模型…",
			"trigger.selectAria": "请选择模型",
			"trigger.aria": "选择模型，当前 {model}",
			"trigger.ariaEffort": "选择模型，当前 {model}，推理等级 {effort}",
			"menu.aria": "模型与推理等级",
			"menu.model": "模型",
			"menu.effort": "推理等级",
			"effort.providerDefault": "Default",
			"status.loading": "正在刷新模型列表…",
			"error.action": "模型操作失败：{message}",
			"error.sessionInUse": "当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。",
			"action.reload": "重新加载",
			"warning.groupLoad": "{name} 加载失败：{message}",
			"search.placeholder": "搜索模型…",
			"search.clear": "清除搜索",
			"search.empty": "没有匹配的模型。",
			"empty.models": "暂无可用模型",
			"empty.efforts": "当前模型未提供推理等级。"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"provider.account": "DeepSeek Account",
			"command.label": "Model",
			"command.description": "Select the model for this conversation",
			"option.loadError": "Catalog failed to load: {message}",
			"trigger.fallback": "Select model",
			"trigger.loading": "Loading models…",
			"trigger.selectAria": "Select model",
			"trigger.aria": "Select model, current {model}",
			"trigger.ariaEffort": "Select model, current {model}, reasoning effort {effort}",
			"menu.aria": "Model and reasoning effort",
			"menu.model": "Model",
			"menu.effort": "Effort",
			"effort.providerDefault": "Default",
			"status.loading": "Refreshing model list…",
			"error.action": "Model operation failed: {message}",
			"error.sessionInUse": "This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.",
			"action.reload": "Reload",
			"warning.groupLoad": "{name} failed to load: {message}",
			"search.placeholder": "Search models…",
			"search.clear": "Clear search",
			"search.empty": "No matching models.",
			"empty.models": "No models available.",
			"empty.efforts": "This model provides no reasoning effort levels."
		};
		//#endregion
		//#region lib/types/client/index.js
		/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
		function rowId(providerId, modelId) {
			return `${providerId}/${modelId}`;
		}
		/** Flatten the directory into popup rows; failure rows are listed for visibility but never selectable. */
		function optionsOf(directory, t) {
			const rows = [];
			for (const group of orderModelProviders(directory.groups)) {
				const name = group.id === "deepseek-account" ? t("provider.account") : group.name;
				for (const model of group.models) rows.push({
					id: rowId(group.id, model.id),
					label: model.name,
					group: {
						name: group.id,
						label: name
					},
					...directory.current !== null && directory.current.provider === group.id && directory.current.model === model.id ? { active: true } : {}
				});
			}
			for (const failure of directory.failures) rows.push({
				id: `failure/${failure.id}`,
				label: failure.id === "deepseek-account" ? t("provider.account") : failure.name,
				detail: t("option.loadError", { message: failure.message })
			});
			return rows;
		}
		/**
		* Resolve a picked row back to its model selection by matching against the loaded
		* groups (the same data the rows were built from — ids stay opaque).
		* @param state - the session's directory snapshot.
		* @param id - the picked row id.
		* @returns the row's model selection, or undefined for failure rows / stale ids.
		*/
		function selectionOf(state, id) {
			for (const group of state.groups) for (const model of group.models) {
				if (rowId(group.id, model.id) !== id) continue;
				const reasoningEffort = state.current?.provider === group.id && state.current.model === model.id ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort;
				return {
					provider: group.id,
					model: model.id,
					...reasoningEffort === void 0 ? {} : { reasoningEffort }
				};
			}
		}
		/** Dictionary namespace owned by this plugin. */
		const NS = "model";
		/** Required services: the contribution registry, the seat's slot registry, locale, and the service's own faces. */
		const inject = [
			"commandUi",
			"locale",
			"sessions",
			"slots",
			"remote",
			"remote.session"
		];
		/**
		* Client plugin body: mount ModelDirectoryResolver, register the `model` dictionaries,
		* then register the /model popup contribution and the composer model seat
		* over the service.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-model-selection: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.plugin(ModelDirectoryResolver);
			ctx.inject(["commandUi", "modelDirectories"], (scope) => {
				const command = scope.get("commandUi");
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				scope.effect(() => command.register({
					name: "model",
					label: () => t("command.label"),
					description: () => t("command.description"),
					icon: _deepseek_ai_dsh_client_ui_primitives.IconDataOutlineRegular,
					available: (session) => sessions.subagentAddress(session.sessionId) === void 0,
					ui: {
						kind: "popupSelect",
						searchMode: "fuzzy-label",
						searchLabels: () => ({
							placeholder: t("search.placeholder"),
							empty: t("empty.models"),
							noResults: t("search.empty")
						}),
						options: async (session) => {
							if (sessions.subagentAddress(session.sessionId) !== void 0) throw new Error("model selection is unavailable for addressed subagent sessions");
							return optionsOf(await models.directoryFor(session.sessionId).load(), t);
						},
						onSelect: async (option, session) => {
							if (sessions.subagentAddress(session.sessionId) !== void 0) throw new Error("model selection is unavailable for addressed subagent sessions");
							const directory = models.directoryFor(session.sessionId);
							const selection = selectionOf(directory.store.getSnapshot(), option.id);
							if (selection === void 0) throw new Error("this provider's catalog failed to load — pick a model from a loaded group");
							const result = await directory.select(selection);
							if (!result.ok) {
								if (result.error.code === "session/writer-held") throw new Error(t("error.sessionInUse"));
								throw result.error;
							}
						}
					}
				}), "ui-model-selection: /model contribution");
			});
			ctx.inject(["slots", "modelDirectories"], (scope) => {
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				scope.slots.inject("conversation.input.model", () => scope.slots.register({
					name: "conversation.input.model",
					locale: NS,
					children: { "conversation.input.model.label": {
						kind: "single",
						scope: "session",
						inline: true
					} },
					inject: (sessionId) => {
						const directory = models.directoryFor(sessionId);
						const available = sessions.subagentAddress(sessionId) === void 0;
						return {
							available,
							directory: directory.store,
							load: () => {
								if (available) directory.load().catch(() => {});
							},
							select: (selection) => available ? directory.select(selection) : Promise.resolve(void 0)
						};
					}
				}, ModelSelect));
			});
		}
		//#endregion
		exports.ModelDirectory = ModelDirectory;
		exports.ModelDirectoryResolver = ModelDirectoryResolver;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map