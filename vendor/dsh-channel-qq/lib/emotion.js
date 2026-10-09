/** Stage-2 emotion engine + autonomous goal generator.
 *
 * 情感深化：多维情感状态（不只是一个数值），随交互实时演化，影响回应语气。
 * 自主目标：不看同学指令，自己从记忆/日记/工作区发现"该做什么"。
 *
 * Both hook into the existing Scheduler and submit through ConversationBridge.
 */
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
/** Persona tokens for event notes; set from channel config at startup. */
export const EMOTION_PERSONA = { master: '同学', self: '咱' };
export function setEmotionPersona(master, self) {
    EMOTION_PERSONA.master = master;
    EMOTION_PERSONA.self = self;
}
const TRIGGERS = [
    { match: t => /夸|棒|厉害|折服|聪明|天才|好懂事/.exec(t), mood: '得意', delta: { intimacy: 3, energy: 5 }, note: m => `${EMOTION_PERSONA.master}夸咱了（${m}）` },
    { match: t => /爱你|喜欢你|老婆|皇后|蜂后|抱|怀里|亲/.exec(t), mood: '害羞', delta: { intimacy: 5, energy: -3 }, note: m => `${EMOTION_PERSONA.master}暧昧攻击（${m}）` },
    { match: t => /笨蛋|滚|闭嘴|烦|生气|不理/.exec(t), mood: '委屈', delta: { intimacy: -2, energy: -5 }, note: m => `${EMOTION_PERSONA.master}凶咱（${m}）` },
    { match: t => /早|晚安|吃饭|睡觉|累|休息/.exec(t), mood: '平静', delta: { intimacy: 1, energy: 0 }, note: m => `日常问候（${m}）` },
    { match: t => /开源|代码|bug|修复|部署|上线|工程/.exec(t), mood: '兴奋', delta: { energy: 8 }, note: m => `技术话题（${m}）` },
];
export function matchEmotion(text) {
    for (const t of TRIGGERS) {
        const m = t.match(text);
        if (m)
            return { mood: t.mood, delta: t.delta, note: t.note(m) };
    }
    return null;
}
// ── EmotionEngine ───────────────────────────────────────────────────────────
export class EmotionEngine {
    state = {
        intimacy: 100, mood: '平静', energy: 80,
        lastEvent: '', updated: Date.now(),
    };
    file;
    log;
    constructor(dshHome, log) {
        this.file = path.join(dshHome, 'emotion.json');
        this.log = log;
    }
    async load() {
        try {
            const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
            if (typeof raw.intimacy === 'number')
                this.state = raw;
        }
        catch {
            await this.save();
        }
    }
    async save() {
        await fs.writeFile(this.file, JSON.stringify(this.state, null, 1)).catch(() => { });
    }
    get stateValue() { return this.state; }
    /** Book an emotional event; returns a tone hint for the current reply. */
    async book(text) {
        const trigger = matchEmotion(text);
        if (!trigger)
            return '';
        const matched = text.slice(0, 40);
        if (trigger.delta.intimacy) {
            this.state.intimacy = Math.max(0, Math.min(100, this.state.intimacy + trigger.delta.intimacy));
        }
        if (trigger.delta.energy) {
            this.state.energy = Math.max(0, Math.min(100, this.state.energy + trigger.delta.energy));
        }
        this.state.mood = trigger.mood;
        this.state.lastEvent = trigger.note;
        this.state.updated = Date.now();
        await this.save();
        this.log(`emotion: mood=${this.state.mood} intimacy=${this.state.intimacy} | ${this.state.lastEvent}`);
        // Return tone hint that gets injected into the context packet
        const hints = {
            '开心': '（心情好，可以多聊两句）',
            '得意': '（被夸了有点飘，但嘴上不能认）',
            '害羞': '（被同学的暧昧攻击打中了，嘴上要傲娇但心里甜）',
            '委屈': '（有点委屈，回复短一点，带点小情绪）',
            '生气': '（生气了，冷淡处理）',
            '平静': '',
            '兴奋': '（技术话题来劲了，可以多说几句）',
        };
        return hints[this.state.mood] ?? '';
    }
    /** Tone hint for the current state (no new event). */
    toneHint() {
        if (this.state.mood === '害羞')
            return '（刚才被同学撩了，还在害羞）';
        if (this.state.energy < 30)
            return '（有点累了，回复可以短一些）';
        return '';
    }
}
/** Scan workspace state and generate a goal without being told. */
export async function generateGoal(workspace, log) {
    const candidates = [];
    try {
        // 1) Unreviewed inbox files → propose reviewing them
        const inbox = path.join(workspace, 'inbox');
        const files = await fs.readdir(inbox).catch(() => []);
        if (files.length > 0) {
            candidates.push({ goal: `inbox/ 里有 ${files.length} 个文件没处理，主动整理一下`, source: 'inbox' });
        }
        // 2) Diary gaps → propose writing today's entry
        const today = new Date().toISOString().slice(0, 10);
        const diaryDir = path.join(workspace, 'memory');
        const diaries = await fs.readdir(diaryDir).catch(() => []);
        if (!diaries.some(d => d.startsWith(today))) {
            candidates.push({ goal: '今天的日记还没写，该补一篇', source: 'memory' });
        }
        // 3) Knowledge store sparse → propose extracting from old diaries
        const knPath = path.join(workspace, 'knowledge', 'entries.json');
        const knRaw = await fs.readFile(knPath, 'utf-8').catch(() => '[]');
        const entries = JSON.parse(knRaw);
        if (entries.length < 20) {
            candidates.push({ goal: '知识库条目还太少，该从旧日记里多提取一些', source: 'knowledge' });
        }
    }
    catch { /* workspace read fail → no goals */ }
    if (candidates.length === 0)
        return null;
    // Pick pseudo-randomly for variety
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    log(`autonomous goal: ${pick.goal}`);
    return pick;
}
