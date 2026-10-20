/** OneBot message segment ↔ text conversions for the agent boundary. */
import type { OneBotEvent, OneBotMessageSegment } from './types.js';
export interface ParsedInbound {
    text: string;
    imageUrls: string[];
    imageSummaries: string[];
    isAtBot: boolean;
    replyToMessageId: number | null;
    hasAtAll: boolean;
    /** Voice-bar segments present (STT candidates). */
    recordCount: number;
    /** QQ ids @-ed in the message (excluding the bot and @全体). */
    atIds: number[];
    /** Inbound files: [fileName, url, fileId]. */
    files: Array<{
        name: string;
        url: string;
        fileId: string;
    }>;
}
export declare function parseInbound(event: OneBotEvent): ParsedInbound;
/** Flattened raw text (for trigger matching), tolerating string-only messages. */
export declare function rawText(event: OneBotEvent): string;
export declare function textMessage(text: string): OneBotMessageSegment[];
export declare function replyAndText(messageId: number, text: string): OneBotMessageSegment[];
