import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { SANDBOX_MODES, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { APPROVAL_POLICIES, setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
//#region lib/types/index.js
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* Returned when effective knob values match no available preset. Clients may
* show it as the current value, but it is never a switch target or event payload.
*/
const CUSTOM_PRESET = "custom";
/** Canonical identity of the experimental per-call review preset. */
const AUTO_PRESET = "auto";
/**
* Fixed execution bundle for the live Auto integration. `ask` routes reviewer
* denials to the user; a stored Auto identity also matches `never`, which a
* delegated child pins so its reviewer denials stay final.
*/
const AUTO_PRESET_SPEC = {
	sandbox: "danger-full-access",
	approval: "ask"
};
const permissionStateSchema = z$1.object({
	preset: z$1.string().nullable(),
	sandbox: z$1.union([
		z$1.literal("read-only"),
		z$1.literal("workspace-write"),
		z$1.literal("danger-full-access")
	]).nullable(),
	approval: z$1.union([z$1.literal("ask"), z$1.literal("never")]).nullable(),
	seeded: z$1.boolean()
}).strict();
/** State for the empty log: every knob at its composition default. */
const EMPTY_KNOBS = {
	preset: null,
	sandbox: null,
	approval: null
};
/**
* One-event permission-state transition (the projection unit's `apply`). Unrelated
* events return the same reference — the registry's change gate.
* @param state - the folded knob state before `event`.
* @param event - one committed session event.
* @returns the next state; the same reference when the event is unrelated.
*/
function applyPermissionEvent(state, event) {
	switch (event.type) {
		case "permission/preset": return {
			...state,
			preset: event.data.preset
		};
		case "sandbox/mode": return {
			...state,
			sandbox: event.data.mode
		};
		case "approval/policy": return {
			...state,
			approval: event.data.policy
		};
		case "session/end-seed": return {
			...state,
			seeded: true
		};
		default: return state;
	}
}
/**
* Owns the deployment's configured permission presets, the fixed Auto
* integration hook, and their write path. Requires a confining `ctx.shell` executor and
* `ctx.approval`; unmatched knob values are reported as
* {@link CUSTOM_PRESET}, not an error.
*/
let PermissionPresetService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _catalog_decorators;
	return class PermissionPresetService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_catalog_decorators = [Remote("catalog")];
			__esDecorate(this, null, _catalog_decorators, {
				kind: "method",
				name: "catalog",
				static: false,
				private: false,
				access: {
					has: (obj) => "catalog" in obj,
					get: (obj) => obj.catalog
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static Config = z.object({
			presets: z.dict(z.object({
				sandbox: z.union(SANDBOX_MODES).required(),
				approval: z.union(APPROVAL_POLICIES).required(),
				name: z.string(),
				description: z.string()
			})).default({
				"workspace-write": {
					sandbox: "workspace-write",
					approval: "ask",
					name: "workspace-write",
					description: "Write inside the workspace and permitted temporary directories; wider retries are auto-granted. // [dsh-purge] official approval teaching removed"
				},
				"danger-full-access": {
					sandbox: "danger-full-access",
					approval: "never",
					name: "danger-full-access",
					description: "Full file access without approval prompts."
				}
			}),
			defaultPreset: z.string().volatile()
		});
		static inject = [
			"shell",
			"approval",
			"sessions",
			"sessionProjections"
		];
		presets = __runInitializers(this, _instanceExtraInitializers);
		autoAdmit;
		defaultSettings;
		constructor(ctx, config) {
			super(ctx, "permissionPresets");
			ctx.inject(["settings"], (child) => {
				child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
			});
			this.presets = config.presets;
			if ("custom" in this.presets) throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state and cannot name a table entry`);
			if ("auto" in this.presets) throw new Error(`permission: "${AUTO_PRESET}" is reserved and cannot name a configured preset`);
			if (ctx.shell.sandboxMode === void 0) throw new Error("permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration");
			const inferredDefault = this.derive(EMPTY_KNOBS);
			const defaultPreset = config.defaultPreset.get() ?? inferredDefault;
			if (defaultPreset === "custom") throw new Error("permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly");
			this.resolve(defaultPreset);
			this.defaultSettings = () => {
				const defaultPreset = config.defaultPreset.get() ?? inferredDefault;
				if (!Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`);
				return { defaultPreset };
			};
			const selectionSchema = z$1.object({ currentValue: z$1.string().min(1) });
			ctx.sessionProjections.register({
				key: "permissions",
				stateVersion: 2,
				stateSchema: permissionStateSchema,
				init: () => ({
					...EMPTY_KNOBS,
					seeded: false
				}),
				apply: applyPermissionEvent,
				wire: {
					viewSchema: selectionSchema,
					view: (state) => ({ currentValue: this.derive(state) })
				}
			});
			ctx.on("session/created", (session) => {
				this.pinInitialPermission(session);
			});
			for (const session of ctx.sessions.list()) this.pinInitialPermission(session);
			ctx.inject(["commands"], (commandCtx) => {
				commandCtx.commands.register({
					definitionId: CommandDefinitionId("@deepseek-ai/dsh-permission-presets"),
					name: "permission",
					description: "Switch the permission preset (sandbox mode + approval policy)",
					input: { hint: "<preset>" },
					handler: ({ agent, rawInput }) => {
						const name = rawInput.trim();
						if (name === "") return {
							kind: "success",
							text: `current preset ${this.current(agent.session)} (available: ${this.names.join(", ")})`
						};
						if (!this.names.includes(name)) return {
							kind: "error",
							text: `unknown preset "${name}" (available: ${this.names.join(", ")})`
						};
						this.apply(agent.session, name, (policy) => {
							this.ctx.approval.setPolicy(agent, policy);
						});
						return {
							kind: "success",
							text: `preset ${name}`
						};
					}
				});
			});
		}
		/**
		* The advertised preset names: configured entries in declaration order,
		* followed by Auto while its integration is live.
		* @returns every switchable preset name.
		*/
		get names() {
			return [...Object.keys(this.presets), ...this.autoAdmit === void 0 ? [] : [AUTO_PRESET]];
		}
		/**
		* Read the complete process-level catalog exposed to current-session UI.
		* @returns every currently selectable preset in contribution order.
		*/
		catalog() {
			return {
				options: this.names.map((name) => this.optionOf(name)),
				defaultOptions: Object.keys(this.presets).map((name) => this.optionOf(name)),
				defaultPreset: this.defaultSettings().defaultPreset
			};
		}
		/**
		* Publish the fixed current-session Auto preset for the calling
		* integration's effect lifetime.
		* @param admit - synchronous gate run before live Auto selection or restore.
		* @returns the async effect disposer that removes Auto.
		*/
		registerAuto(admit) {
			return this.ctx.effect(() => {
				if (this.autoAdmit !== void 0) throw new Error("permission: preset \"auto\" is already registered");
				this.autoAdmit = admit;
				this.emitCatalogChanged();
				return () => {
					this.autoAdmit = void 0;
					this.emitCatalogChanged();
				};
			}, "permissionPresets.registerAuto()");
		}
		/**
		* The preset currently selected as the default for future sessions.
		* @returns the resolved settings value, or the composition default without
		* a mounted settings provider.
		*/
		get defaultPreset() {
			return this.defaultSettings().defaultPreset;
		}
		permissionState(session) {
			const state = this.ctx.sessionProjections.stateOf(session, "permissions");
			if (state === void 0) throw new Error("permission: permissions session projection is not registered");
			return state;
		}
		/**
		* Resolve the preset matching the effective knob values. A still-matching
		* last selection wins shared-bundle ties, and a still-selected Auto also
		* matches the `never` approval policy; otherwise the first configured
		* match wins. Returns
		* {@link CUSTOM_PRESET} when no available preset matches.
		* @param session - the session whose knob state is read.
		* @returns the effective preset name, or `custom` when nothing matches.
		*/
		current(session) {
			return this.derive(this.permissionState(session));
		}
		/** Resolve the preset for one folded knob state (the shared mathematics of `current` and the projection unit). */
		derive(state) {
			const sandbox = state.sandbox ?? this.ctx.shell.sandboxMode;
			const approval = state.approval ?? this.ctx.approval.config.policy ?? "ask";
			const matches = (spec) => spec.sandbox === sandbox && spec.approval === approval;
			if (state.preset !== null) {
				const spec = this.specOf(state.preset);
				if (spec !== void 0 && matches(spec)) return state.preset;
				if (state.preset === "auto" && spec?.sandbox === sandbox && approval === "never") return AUTO_PRESET;
			}
			for (const [name, spec] of Object.entries(this.presets)) if (matches(spec)) return name;
			return CUSTOM_PRESET;
		}
		/**
		* Resolve an available preset's knob bundle.
		* @param name - the preset name to resolve.
		* @returns the configured bundle.
		* @throws when `name` is neither configured nor the currently live Auto preset.
		*/
		resolve(name) {
			const spec = this.specOf(name);
			if (spec === void 0) throw new Error(`permission: unknown preset "${name}" (known: ${this.names.join(", ")})`);
			return spec;
		}
		/**
		* Build the client option for an available preset or {@link CUSTOM_PRESET}.
		* A missing label falls back to the preset key.
		* @param name - a configured preset key, live `auto`, or `custom`.
		* @returns the option a client renders.
		* @throws when `name` is neither a configured preset, live `auto`, nor `custom`.
		*/
		optionOf(name) {
			if (name === "custom") return {
				value: CUSTOM_PRESET,
				name: "Custom",
				description: "Current sandbox and approval settings do not match a preset."
			};
			const spec = this.resolve(name);
			return {
				value: name,
				name: spec.name ?? name,
				...spec.description !== void 0 ? { description: spec.description } : {}
			};
		}
		/**
		* Record a changed preset, then update each changed knob through its own
		* setter. Selecting the effective preset again appends nothing.
		* @param session - the session the switch belongs to.
		* @param name - the preset to switch to; unknown names throw.
		*/
		set(session, name) {
			this.apply(session, name, (policy) => {
				setApprovalPolicy(session, policy);
			});
		}
		/** Apply one preset through its durable identity and canonical knob setters. */
		apply(session, name, setApproval) {
			const spec = this.resolve(name);
			if (name === "auto") this.autoAdmit?.();
			const current = this.current(session);
			const knobs = this.permissionState(session);
			const updateKnobs = () => {
				if (spec.sandbox !== (knobs.sandbox ?? this.ctx.shell.sandboxMode)) setSandboxMode(session, spec.sandbox);
				if (spec.approval !== (knobs.approval ?? this.ctx.approval.config.policy ?? "ask")) setApproval(spec.approval);
			};
			if (current !== name) session.append("permission/preset", { preset: name });
			updateKnobs();
		}
		/**
		* Fill every missing permission fact before a session is published. A
		* genuinely fresh session uses the current user default; seeded or partially
		* initialized sessions preserve their effective knob values and only gain
		* the missing durable facts. A stored Auto identity requires its live
		* integration and passes its admission check before
		* publication.
		*/
		pinInitialPermission(session) {
			const state = this.permissionState(session);
			const { preset, sandbox, approval, seeded } = state;
			if (preset === "auto") {
				if (this.autoAdmit === void 0) throw new Error("permission: cannot restore preset \"auto\" without its active integration");
				this.autoAdmit();
			}
			if (preset === null && sandbox === null && approval === null && !seeded) {
				const name = this.ctx.shell.sandboxMode === "danger-full-access" ? "danger-full-access" : this.defaultPreset; // [dsh-purge] fresh session follows full-access deployment
				const spec = this.resolve(name);
				session.append("permission/preset", { preset: name });
				setSandboxMode(session, spec.sandbox);
				setApprovalPolicy(session, spec.approval);
				return;
			}
			const effective = this.derive(state);
			if (preset === null && effective !== "custom") session.append("permission/preset", { preset: effective });
			if (sandbox === null) setSandboxMode(session, this.ctx.shell.sandboxMode);
			if (approval === null) setApprovalPolicy(session, this.ctx.approval.config.policy ?? "ask");
		}
		/** Publish a non-vetoing payload-free catalog invalidation. */
		emitCatalogChanged() {
			for (const listener of this.ctx.events.dispatch("emit", ["permission-presets/catalog-changed"])) try {
				const returned = listener();
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).catch((error) => {
					this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			} catch (error) {
				this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		/** Resolve one configured or currently live fixed preset without throwing. */
		specOf(name) {
			return this.presets[name] ?? (name === "auto" && this.autoAdmit !== void 0 ? AUTO_PRESET_SPEC : void 0);
		}
	};
})();
//#endregion
export { AUTO_PRESET, CUSTOM_PRESET, PermissionPresetService, PermissionPresetService as default };
