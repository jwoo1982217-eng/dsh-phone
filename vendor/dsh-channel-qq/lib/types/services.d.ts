/** Minimal structural views of the harness services this channel consumes.
 *
 * The real declarations come from the harness packages via Cordis declaration
 * merging at runtime; here they are deliberately narrow so the plugin builds
 * against `@deepseek-ai/cordis` alone and cannot grow hidden dependencies on
 * host internals. Shapes mirror the call sites in `packages/webhook/webhook/src/session.ts`.
 */
import type { Context, Service } from '@deepseek-ai/cordis';
export type SessionId = string & {
    readonly __session: 'SessionId';
};
export declare function asSessionId(value: string): SessionId;
/** Content block subset used for prompts and tool render output. */
export interface TextBlock {
    readonly type: 'text';
    readonly text: string;
}
/** Vision block referencing an attachment saved through ctx.attachments. */
export interface ImageBlock {
    readonly type: 'image';
    readonly attachment: unknown;
}
export type PromptBlock = TextBlock | ImageBlock;
export interface AgentPresetInfo {
    readonly id: string;
}
/** `ctx.agentPresets` */
export interface AgentPresetsService {
    resolve(id: string): Promise<AgentPresetInfo>;
    standingKeyFor(id: string): Promise<unknown>;
    mount(agentCtx: Context, id: string): Promise<void>;
}
/** `ctx.permissionPresets` — capability gating stays harness-owned (its defaults, not ours). */
export interface PermissionPresetsService {
    resolve(id: string): unknown;
    set(session: unknown, id: string): void;
}
/** `ctx.workspaceRegistry` — durable workspace records; one per channel deployment. */
export interface WorkspaceEntry {
    readonly path: string;
    attachSession(sessionId: SessionId): Promise<void>;
}
export interface WorkspaceRegistryService {
    create(path: string): Promise<WorkspaceEntry>;
}
/** `ctx.agentDefaultModel` */
export interface AgentDefaultModelService {
    currentSelection(): {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
}
/** `ctx.sessionTitle` */
export interface SessionTitleService {
    rename(session: unknown, title: string): void;
}
/** The subset of a live agent the channel needs. `agents.get()` returns this directly. */
export interface AgentLike {
    readonly session: unknown;
    /** Agent-plane context; present on live agents, used to remount presets on resume. */
    readonly ctx?: Context;
    followup(message: unknown): void;
}
/** `agents.create()` wraps the agent in a handle. */
export interface ChannelAgentHandle {
    readonly agent: AgentLike;
}
export interface AgentsCreateOptions {
    /** Exact id for a fresh session; mutually exclusive with resumeSessionId. */
    sessionId?: SessionId;
    /** Resume existing persisted history under this id instead of creating fresh. */
    resumeSessionId?: SessionId;
    signal?: AbortSignal;
    meta: {
        cwd: string;
        agentPreset: string;
    };
    agentOptions: {
        provider: string;
        model: string;
        maxTokens?: number;
    };
    setup?(agentCtx: Context): Promise<void>;
}
/** Resume options: the persisted session id plus per-agent options and setup. */
export interface AgentsResumeOptions {
    resumeSessionId: SessionId;
    agentOptions?: {
        provider: string;
        model: string;
        maxTokens?: number;
    };
    setup?(agentCtx: Context): Promise<void>;
}
/** `ctx.agents` */
export interface AgentsService {
    create(options: AgentsCreateOptions): Promise<ChannelAgentHandle>;
    resume(options: AgentsResumeOptions): Promise<ChannelAgentHandle>;
    get(sessionId: SessionId): AgentLike | undefined;
}
/** `ctx.tools` */
export interface ToolsService {
    register(definition: Record<string, unknown>): () => void;
}
/** `ctx.attachments` — durable image storage for vision prompts. */
export interface AttachmentsService {
    saveImage(input: {
        data: Uint8Array;
        mediaType: string;
        name?: string;
    }): Promise<unknown>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        agents: AgentsService;
        agentPresets: AgentPresetsService;
        agentDefaultModel: AgentDefaultModelService;
        permissionPresets: PermissionPresetsService;
        sessionTitle: SessionTitleService;
        workspaceRegistry: WorkspaceRegistryService;
        tools: ToolsService;
        channelQQ: Service;
    }
}
export interface FollowupSource {
    readonly kind: 'plugin';
    readonly plugin: string;
}
export declare function pluginUserMessage(text: string, source: FollowupSource): {
    content: TextBlock[];
    source: FollowupSource;
};
