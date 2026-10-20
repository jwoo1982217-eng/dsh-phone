/** Outbound message log: what the bot herself sent, persisted per conversation.
 *
 * Injected into every context packet so she always remembers her own recent
 * messages and what they quoted — even across session resets, which is where
 * quote chains used to break ("这句不是我发的").
 */
export interface SentEntry {
    /** Real QQ message id of the sent message (from OneBot response when available). */
    messageId: number | null;
    /** The message this one quoted, if sent via qq_reply_quote. */
    quotedId: number | null;
    text: string;
    time: number;
}
export declare class SentLog {
    private readonly key;
    private readonly log;
    private readonly file;
    private entries;
    constructor(dshHome: string, key: string, log: (line: string) => void);
    load(): Promise<void>;
    add(entry: SentEntry): Promise<void>;
    /** Rendered block for the context packet; empty string when nothing sent. */
    render(): string;
}
