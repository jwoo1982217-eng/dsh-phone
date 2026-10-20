/** Outbound pipeline: segmentation, rate limiting, and length caps. Ported from the OpenClaw extension. */
import type { QQChannelConfig } from './config.js';
import type { OneBotClient } from './onebot.js';
/**
 * Hard-split one overlong segment at natural boundaries (ported from the
 * extension's smartSplitMessage): newline first, then sentence punctuation,
 * then a hard cut. Keeps every chunk under the OneBot-safe limit.
 */
export declare function smartSplitMessage(text: string, limit: number): string[];
/**
 * Rule-based segmentation ported from the OpenClaw extension's smartSegmenter:
 * 段数由句号说了算 — every sentence ender (。！？…!?) outside protected regions
 * (code blocks, --- blocks, quotes, brackets) starts a new segment. Emotional
 * punctuation is kept, trailing 。 is dropped, duplicates removed, and the
 * style knob tunes rhythm: conservative merges tiny adjacent sentences,
 * active keeps every sentence as its own message.
 */
export declare function segmentReply(text: string, config: QQChannelConfig): string[];
/** Serialises sends so the configured rate limit holds across segments and tools. */
export declare class OutboundQueue {
    private readonly client;
    private readonly config;
    private readonly log;
    private chain;
    /** Every segment ever sent, keyed lowercase — a repeat is skipped (sentMessages). */
    private readonly sentHistory;
    constructor(client: OneBotClient, config: QQChannelConfig, log: (line: string) => void);
    /** Queue one send; trailing nullish segments are skipped silently. */
    enqueue(send: () => Promise<unknown>): void;
    sendSegments(params: {
        isGroup: boolean;
        chatId: number;
        replyTo: number | null;
        text: string;
    }): void;
    sendNow(action: string, payload: Record<string, unknown>): Promise<unknown>;
    /** Rate-limited send that resolves with the OneBot result when its turn in the chain comes. */
    push<T>(task: () => Promise<T>): Promise<T>;
}
