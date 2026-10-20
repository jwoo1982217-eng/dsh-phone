/** Stage-2 knowledge pipeline: auto-extract from diaries/group chats into
 * structured entries, keyword+weight retrieval, persists to workspace/knowledge/.
 *
 * Extractor: none (2026-09-26 master order) — knowledge entries are composed by the main model itself via extract_knowledge tool; no external API.
 * Retrieval: keyword overlap + recency + weight scoring (vector upgrade later).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
let knSeq = 0;
/** 知识条目库：entries.json 持久化（去重），检索=关键词命中*3+权重*2+新近度。 */
export class KnowledgeStore {
    log;
    entries = [];
    file;
    constructor(dshHome, workspace, log) {
        this.log = log;
        const dir = workspace && workspace.length > 0 ? path.join(workspace, 'knowledge') : path.join(dshHome, 'knowledge');
        this.file = path.join(dir, 'entries.json');
    }
    async load() {
        try {
            const raw = await fs.readFile(this.file, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.entries = parsed.filter((x) => typeof x === 'object' && x !== null && typeof x.content === 'string');
                this.log(`knowledge: loaded ${this.entries.length} entries`);
            }
        }
        catch {
            this.entries = [];
            this.log('knowledge: empty store (no entries.json yet)');
        }
    }
    async save() {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2), 'utf-8');
        await fs.rename(tmp, this.file);
    }
    /** 去重入库（按 content 精确匹配），返回新增条数。 */
    async addMany(items) {
        const seen = new Set(this.entries.map(e => e.content.trim()));
        let added = 0;
        for (const it of items) {
            const content = it.content.trim();
            if (content.length < 4 || seen.has(content))
                continue;
            seen.add(content);
            knSeq += 1;
            this.entries.push({
                id: `kn-${Date.now().toString(36)}-${knSeq}`,
                type: 'fact',
                content,
                tags: it.tags,
                source: it.source,
                created: Date.now(),
                weight: 1,
                hits: 0,
            });
            added += 1;
        }
        if (added > 0)
            await this.save();
        return added;
    }
    /** 关键词检索：命中数*3 + 权重*2 + 新近度，Top-N。 */
    search(query, limit) {
        const q = query.toLowerCase();
        const terms = q.split(/[\s，。、！？,.!?]+/).filter(t => t.length > 0);
        const now = Date.now();
        const scored = this.entries.map(e => {
            const hay = (e.content + ' ' + e.tags.join(' ')).toLowerCase();
            let hits = 0;
            for (const t of terms)
                if (hay.includes(t))
                    hits += 1;
            const recency = (e.created - 1700000000000) / (now - 1700000000000 + 1);
            return { e, score: hits * 3 + e.weight * 2 + recency * (hits > 0 ? 1 : 0) };
        }).filter(x => x.score > 0);
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(x => x.e);
    }
    /** 当前条目数。 */
    size() {
        return this.entries.length;
    }
    /** 命中强化：权重 +1，检索越频繁越靠前。 */
    async reinforce(id) {
        const e = this.entries.find(x => x.id === id);
        if (e === undefined)
            return;
        e.weight += 1;
        e.hits += 1;
        try {
            await this.save();
        }
        catch (err) {
            this.log(`knowledge reinforce save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
