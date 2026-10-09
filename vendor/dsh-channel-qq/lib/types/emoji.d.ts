/** Sticker (emoji) store: steal images from the primary group, auto-attach on replies.
 *
 * Deliberately a lite port: the OpenClaw extension's VLM intensity scoring is
 * not carried over; stealing is keyword-free and sending is probability-based.
 */
import type { EmojiConfig } from './config.js';
import type { OneBotClient } from './onebot.js';
import type { OneBotEvent } from './types.js';
import type { EmojiLibrary, EmojiIndexEntry } from './emoji-library.js';
export declare class EmojiStore {
    private readonly client;
    private readonly log;
    private readonly library?;
    private readonly dir;
    private readonly registeredDir;
    constructor(config: EmojiConfig, client: OneBotClient, log: (line: string) => void, library?: EmojiLibrary | undefined);
    init(): Promise<void>;
    /** Steal the first image of a primary-group message into the raw sticker dir. */
    steal(event: OneBotEvent): Promise<EmojiIndexEntry | null>;
    /** Pick one registered sticker for auto-send; returns an absolute path or null. */
    pickRegistered(): Promise<string | null>;
    sendRandom(isGroup: boolean, chatId: number): Promise<void>;
}
