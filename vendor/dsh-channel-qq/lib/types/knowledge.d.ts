/** Stage-2 knowledge pipeline: auto-extract from diaries/group chats into
 * structured entries, keyword+weight retrieval, persists to workspace/knowledge/.
 *
 * Extractor: none (2026-09-26 master order) — knowledge entries are composed by the main model itself via extract_knowledge tool; no external API.
 * Retrieval: keyword overlap + recency + weight scoring (vector upgrade later).
 */
export interface KnowledgeEntry {
    id: string;
    type: 'skill' | 'fact' | 'preference' | 'event' | 'person';
    content: string;
    tags: string[];
    source: string;
    created: number;
    weight: number;
    hits: number;
}
interface StoreItem {
    type: 'fact';
    content: string;
    tags: string[];
    source: string;
}
/** 知识条目库：entries.json 持久化（去重），检索=关键词命中*3+权重*2+新近度。 */
export declare class KnowledgeStore {
    private log;
    private entries;
    private readonly file;
    constructor(dshHome: string, workspace: string | null | undefined, log: (line: string) => void);
    load(): Promise<void>;
    private save;
    /** 去重入库（按 content 精确匹配），返回新增条数。 */
    addMany(items: readonly StoreItem[]): Promise<number>;
    /** 关键词检索：命中数*3 + 权重*2 + 新近度，Top-N。 */
    search(query: string, limit: number): KnowledgeEntry[];
    /** 当前条目数。 */
    size(): number;
    /** 命中强化：权重 +1，检索越频繁越靠前。 */
    reinforce(id: string): Promise<void>;
}
export {};
