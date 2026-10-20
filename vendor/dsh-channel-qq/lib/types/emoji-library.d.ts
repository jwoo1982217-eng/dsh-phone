/** Emoji library: dedup-by-md5 sticker store with vision tagging and semantic search.
 *
 * Ideas ported from astrbot_plugin_stealer / meme_manager (analyzed, not copied):
 * - MD5 dedup: the same sticker never enters the index twice.
 * - Vision tagging: stolen images get a one-shot multimodal caption + mood tags
 *   through the harness LLM seam (best-effort, non-blocking).
 * - Semantic search: the agent finds stickers by mood/meaning instead of
 *   browsing a flat directory.
 * - Send cooldown: per-conversation minimum interval between auto-sent
 *   stickers, so a hot room cannot get spammed.
 *
 * Storage layout (under <dshHome>/channel-qq/):
 *   emoji/            raw stolen images (unchanged, shared with EmojiStore)
 *   emoji-registered/ hand-picked sendable stickers (unchanged)
 *   emoji-index.json  the index: md5 -> { file, source, tags, mood, desc, addedAt }
 */
import type { Context } from '@deepseek-ai/cordis';
import type { EmojiConfig } from './config.js';
export interface EmojiIndexEntry {
    /** Absolute file path. */
    file: string;
    /** registered (hand-picked) or stolen. */
    source: 'registered' | 'stolen';
    /** Lowercase hex MD5 of the file bytes. */
    md5: string;
    /** Free-text description from the vision model (empty until tagged). */
    desc: string;
    /** Mood/usage tags, lowercase, e.g. ["开心","嘲讽","摸鱼"]. */
    tags: string[];
    addedAt: number;
}
export interface EmojiSearchHit {
    file: string;
    source: string;
    desc: string;
    tags: string[];
    score: number;
}
export declare class EmojiLibrary {
    private readonly config;
    private readonly log;
    private readonly indexFile;
    private index;
    private dirty;
    /** md5 of in-flight tagging jobs, prevents double-tagging. */
    private readonly tagging;
    private readonly lastAutoSend;
    constructor(config: EmojiConfig, log: (line: string) => void);
    load(): Promise<void>;
    save(): Promise<void>;
    private static md5;
    /**
     * Register a newly stolen/registered image. Returns the index entry, or
     * null when the exact image (by MD5) is already indexed — the caller then
     * does not need to keep the duplicate file.
     */
    addFile(file: string, source: 'registered' | 'stolen'): Promise<EmojiIndexEntry | null>;
    /** Whether this MD5 is already indexed (duplicate detection before download). */
    hasMd5(md5: string): boolean;
    /**
     * Best-effort vision tagging through the harness LLM seam. Never throws:
     * a failed tagging leaves the entry searchable by filename later.
     */
    tagEntry(ctx: Context, entry: EmojiIndexEntry, imageData: Buffer, mediaType: string): Promise<void>;
    /**
     * Search the library by free text: scores tag/desc substring hits plus a
     * light synonym expansion so "哈哈" finds "大笑" entries.
     */
    search(query: string, limit?: number): EmojiSearchHit[];
    /** All indexed entries (bounded), newest first — the fallback listing. */
    list(limit?: number): EmojiIndexEntry[];
    /** Cooldown gate for auto-sent stickers. True when sending is allowed now. */
    autoSendAllowed(key: string): boolean;
    markAutoSent(key: string): void;
    /** Full-library rebuild: index every image file on disk that is missing. */
    rescan(): Promise<{
        added: number;
        duplicates: number;
    }>;
}
