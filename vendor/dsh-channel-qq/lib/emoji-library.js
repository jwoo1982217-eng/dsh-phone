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
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
const TAG_PROMPT = [
    '你是表情包索引员。看这张表情包/图片，输出一行 JSON（不要多余文字）：',
    '{"desc":"<20字内描述画面内容>","tags":["<情绪/用途标签1>","<标签2>","<标签3>"]}',
    'tags 从这些常用维度挑3-5个：开心 大笑 哭 委屈 生气 嘲讽 无语 尴尬 害羞 点赞 摸鱼 吃瓜 惊讶 害怕 疑问 加油 睡觉。若图片有文字也写进 desc。',
].join('\n');
/** Minimum ms between auto-sent stickers per conversation key. */
const SEND_COOLDOWN_MS = 20_000;
export class EmojiLibrary {
    config;
    log;
    indexFile;
    index = new Map();
    dirty = false;
    /** md5 of in-flight tagging jobs, prevents double-tagging. */
    tagging = new Set();
    lastAutoSend = new Map();
    constructor(config, log) {
        this.config = config;
        this.log = log;
        const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
        const dir = config.dir ?? path.join(home, 'channel-qq', 'emoji');
        this.indexFile = path.join(dir, '..', 'emoji-index.json');
    }
    async load() {
        try {
            const raw = JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
            this.index = new Map((raw.entries ?? []).map((e) => [e.md5, e]));
            this.log(`emoji library loaded: ${String(this.index.size)} entries`);
        }
        catch {
            this.index = new Map();
            this.log('emoji library: no existing index, starting fresh');
        }
    }
    async save() {
        if (!this.dirty)
            return;
        try {
            await fs.writeFile(this.indexFile, JSON.stringify({ version: 1, entries: [...this.index.values()] }, null, 1), 'utf8');
            this.dirty = false;
        }
        catch (error) {
            this.log(`emoji index save failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    static md5(buf) {
        return createHash('md5').update(buf).digest('hex');
    }
    /**
     * Register a newly stolen/registered image. Returns the index entry, or
     * null when the exact image (by MD5) is already indexed — the caller then
     * does not need to keep the duplicate file.
     */
    async addFile(file, source) {
        let buf;
        try {
            buf = await fs.readFile(file);
        }
        catch {
            return null;
        }
        const md5 = EmojiLibrary.md5(buf);
        const existing = this.index.get(md5);
        if (existing !== undefined) {
            // Prefer keeping the registered copy as canonical.
            if (source === 'registered' && existing.source !== 'registered') {
                existing.source = 'registered';
                existing.file = file;
                this.dirty = true;
            }
            return null;
        }
        const entry = { file, source, md5, desc: '', tags: [], addedAt: Date.now() };
        this.index.set(md5, entry);
        this.dirty = true;
        return entry;
    }
    /** Whether this MD5 is already indexed (duplicate detection before download). */
    hasMd5(md5) {
        return this.index.has(md5);
    }
    /**
     * Best-effort vision tagging through the harness LLM seam. Never throws:
     * a failed tagging leaves the entry searchable by filename later.
     */
    async tagEntry(ctx, entry, imageData, mediaType) {
        if (this.tagging.has(entry.md5))
            return;
        this.tagging.add(entry.md5);
        try {
            const ctxRecord = ctx;
            const llm = ctxRecord.llm;
            const selection = ctxRecord.agentDefaultModel?.currentSelection();
            if (llm === undefined || selection === undefined)
                return;
            const dataUrl = `data:${mediaType};base64,${imageData.toString('base64')}`;
            const stream = llm.stream({
                provider: selection.provider,
                model: selection.model,
                maxTokens: 200,
                messages: [{
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: dataUrl } },
                            { type: 'text', text: TAG_PROMPT },
                        ],
                    }],
            });
            let text = '';
            for await (const chunk of stream) {
                if (typeof chunk?.text === 'string')
                    text += chunk.text;
            }
            const stripped = text.replace(/```(?:json)?/g, '').trim();
            const json = stripped.match(/\{[\s\S]*\}/);
            if (json === null)
                return;
            const parsed = JSON.parse(json[0]);
            if (typeof parsed.desc === 'string')
                entry.desc = parsed.desc.slice(0, 120);
            if (Array.isArray(parsed.tags))
                entry.tags = parsed.tags.map((t) => String(t).toLowerCase().slice(0, 12)).slice(0, 5);
            this.dirty = true;
            this.log(`emoji tagged [${entry.tags.join(',')}] ${entry.desc}`);
        }
        catch (error) {
            this.log(`emoji tagging skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.tagging.delete(entry.md5);
        }
    }
    /**
     * Search the library by free text: scores tag/desc substring hits plus a
     * light synonym expansion so "哈哈" finds "大笑" entries.
     */
    search(query, limit = 5) {
        const q = query.trim().toLowerCase();
        if (q === '')
            return [];
        const synonyms = {
            '哈哈': ['大笑', '开心'],
            '笑': ['大笑', '开心'],
            '乐': ['开心'],
            '哭': ['委屈'],
            '气': ['生气'],
            '喷': ['大笑', '嘲讽'],
            '赞': ['点赞'],
            '冲': ['加油'],
            '摸': ['摸鱼'],
            '瓜': ['吃瓜'],
            '怕': ['害怕'],
            '?': ['疑问'],
            '？': ['疑问'],
        };
        const terms = new Set([q]);
        for (const [key, list] of Object.entries(synonyms)) {
            if (q.includes(key))
                for (const t of list)
                    terms.add(t);
        }
        const hits = [];
        for (const entry of this.index.values()) {
            let score = 0;
            const haystackDesc = entry.desc.toLowerCase();
            for (const term of terms) {
                if (term === '')
                    continue;
                if (entry.tags.some((t) => t.includes(term)))
                    score += 3;
                if (haystackDesc.includes(term))
                    score += 2;
            }
            if (score > 0)
                hits.push({ file: entry.file, source: entry.source, desc: entry.desc, tags: entry.tags, score });
        }
        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, limit);
    }
    /** All indexed entries (bounded), newest first — the fallback listing. */
    list(limit = 40) {
        return [...this.index.values()].sort((a, b) => b.addedAt - a.addedAt).slice(0, limit);
    }
    /** Cooldown gate for auto-sent stickers. True when sending is allowed now. */
    autoSendAllowed(key) {
        const last = this.lastAutoSend.get(key);
        return last === undefined || Date.now() - last >= SEND_COOLDOWN_MS;
    }
    markAutoSent(key) {
        this.lastAutoSend.set(key, Date.now());
    }
    /** Full-library rebuild: index every image file on disk that is missing. */
    async rescan() {
        const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
        const dir = this.config.dir ?? path.join(home, 'channel-qq', 'emoji');
        const registeredDir = this.config.registeredDir ?? path.join(dir, '..', 'emoji-registered');
        let added = 0;
        let duplicates = 0;
        for (const [d, source] of [[registeredDir, 'registered'], [dir, 'stolen']]) {
            let files = [];
            try {
                files = (await fs.readdir(d)).filter((name) => !name.startsWith('.'));
            }
            catch {
                continue;
            }
            for (const name of files) {
                const entry = await this.addFile(path.join(d, name), source);
                if (entry === null)
                    duplicates += 1;
                else
                    added += 1;
            }
        }
        await this.save();
        return { added, duplicates };
    }
}
