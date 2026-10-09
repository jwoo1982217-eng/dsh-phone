/** Conversation bridge: OneBot events in, agent sessions, replies back out.
 *
 * One stable session per conversation (group or DM peer), so history resumes
 * across process restarts.
 *
 * Group traffic is batched to keep the agent's inbox from queueing one turn
 * per message: every message lands in a per-conversation intake queue, and one
 * "data packet" (context + messages) is analyzed once per quiet window. An @
 * (or keyword call) skips the wait entirely and flushes the packet — queued
 * context included, since a call is often about what was just said.
 *
 * Outbound is TOOL-ONLY: the agent speaks exclusively through its qq_* send
 * tools, so reasoning and process narration physically cannot reach the group.
 *
 * Vision: inbound images are downloaded and attached to the packet through the
 * harness attachment service, so multimodal models see them natively.
 *
 * Pokes: group pokes are counted with a patience window; only when the
 * patience runs out does 我 poke back and (optionally) vent.
 *
 * Quotes: a reply-reference pulls the referenced message text into the packet
 * (MaiBot-style flexible quote context).
 */
import type { KnowledgeStore } from './knowledge.js';
import type { Context } from '@deepseek-ai/cordis';
import type { QQChannelConfig } from './config.js';
import { OutboundQueue } from './outbound.js';
import type { OneBotClient } from './onebot.js';
import type { OneBotEvent } from './types.js';
export interface ReplyListener {
    (isGroup: boolean, chatId: number): void;
}
export declare class ConversationBridge {
    private readonly ctx;
    private readonly config;
    private readonly client;
    private readonly out;
    private readonly log;
    private get persona();
    private readonly conversations;
    /** Numbers that are DM peers: a same-numbered group target is always a misroute. */
    readonly dmPeers: Set<number>;
    /** Numbers that are group chat ids: sending them a PRIVATE message is always a misroute. */
    readonly groupIds: Set<number>;
    private readonly ensureInFlight;
    /** Poke patience counters per (group:user). */
    private readonly pokes;
    /** Per-conversation outbound message logs (quote-chain memory). */
    private readonly sentLogs;
    /** Multi-dimensional emotional state (stage-2 情感深化). */
    emotionEngine: {
        book(text: string): Promise<string>;
        toneHint(): string;
    } | null;
    /** Stage-2 knowledge store: top relevant entries ride with each packet. */
    knowledge: KnowledgeStore | null;
    private workspace;
    /** Fired whenever a reply turn is submitted (auto-emoji hook). */
    onReply: ReplyListener | null;
    constructor(ctx: Context, config: QQChannelConfig, client: OneBotClient, out: OutboundQueue, log: (line: string) => void);
    /** Reconnect replay: messages that arrived while our WS listener was down
     *  (a dsh restart window) are pulled from NapCat history and re-fed through
     *  the normal ingest path; per-conversation message_id dedup keeps it
     *  idempotent, and a freshness window keeps stale chatter out. */
    private replaying;
    private replayMissed;
    /** Outbound sanitizer: strict OpenAI-compatible gateways (Rust/serde parsers)
     * reject a `role:"tool"` wire message whose `tool_call_id` is absent — one
     * orphaned tool-result block bricks the whole session permanently, because
     * every later request replays the same history. Strip tool-result content
     * blocks that lost their callId before the request leaves the process. */
    private installWireSanitizer;
    /** Stage-2 auto-retrieval: most relevant knowledge entries for this packet text. */
    private knowledgeHint;
    /**
     * Self-heal workspace membership: every persisted qq-* session is re-attached
     * to the configured workspace at startup, so sessions created before an
     * attach persisted (or dropped by a crash) still group under the workspace.
     */
    reattachPersistedSessions(): Promise<void>;
    /** Release batch timers when the plugin unloads. */
    dispose(): void;
    /** STT one voice-bar message; failures are logged, never fatal. */
    private transcribeVoice;
    /** Proactive DM: she comes to find the master on her own initiative. */
    dmProactive(prompt: string): Promise<void>;
    /** Scheduler hooks: patrol / dream / evolution packets on the group session. */
    patrolTick(key: string, prompt: string): Promise<void>;
    dreamTick(key: string, prompt: string): Promise<void>;
    evolveTick(key: string, prompt: string): Promise<void>;
    private scheduledTick;
    /** Download inbound files into the workspace inbox so the agent can process them. */
    private receiveFiles;
    /** Group pokes with a patience counter — no instant reaction. */
    handleNotice(event: OneBotEvent): Promise<void>;
    /** Deterministic call: @-mention or keyword hit (DMs are always direct). */
    private isCalled;
    private talkChance;
    reactionHint(event: OneBotEvent): string | null;
    /** One message line for the intake packet. */
    private formatLine;
    handleEvent(event: OneBotEvent): Promise<void>;
    /** Arm (or re-arm) the quiet-window timer for one batched analysis. */
    private scheduleBatch;
    /** Deliver one group message straight into the agent context (inject mode). */
    private injectNow;
    /**
     * Analyze the intake queue as one packet.
     * `immediate` (a call) skips both the wait and the probability gate; a
     * running turn is not interrupted. A batch waits for idle instead of
     * queueing behind the running turn — that is the queueing we are avoiding.
     */
    private flushNow;
    private createConversationRecord;
    private ensureConversation;
    private ensureConversationInner;
    /** Master-only admin prompt: submit one packet into the master's DM session. */
    adminPrompt(prompt: string): Promise<void>;
    private sentLogFor;
    private ensureWorkspace;
    private submit;
}
