/** Outbound message log: what the bot herself sent, persisted per conversation.
 *
 * Injected into every context packet so she always remembers her own recent
 * messages and what they quoted — even across session resets, which is where
 * quote chains used to break ("这句不是我发的").
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
const MAX_ENTRIES = 50;
export class SentLog {
    key;
    log;
    file;
    entries = [];
    constructor(dshHome, key, log) {
        this.key = key;
        this.log = log;
        this.file = path.join(dshHome, 'channel-qq', `sent-${key}.json`);
    }
    async load() {
        try {
            this.entries = JSON.parse(await fs.readFile(this.file, 'utf-8'));
            if (!Array.isArray(this.entries))
                this.entries = [];
        }
        catch {
            this.entries = [];
        }
    }
    async add(entry) {
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES)
            this.entries = this.entries.slice(-MAX_ENTRIES);
        try {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await fs.writeFile(this.file, JSON.stringify(this.entries, null, 1));
        }
        catch (error) {
            this.log(`sent-log write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** Rendered block for the context packet; empty string when nothing sent. */
    render() {
        if (this.entries.length === 0)
            return '';
        const lines = this.entries.slice(-12).map((e) => {
            const quoted = e.quotedId !== null ? `（引用#${e.quotedId}）` : '';
            const id = e.messageId !== null ? `#${e.messageId}` : '#?';
            const time = new Date(e.time);
            const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            return `${hhmm} 咱发的 ${id}${quoted}：${e.text.slice(0, 80)}`;
        });
        return `【咱最近在群里发过的消息（这就是引用链的源头，别再说不是咱发的）】\n${lines.join('\n')}`;
    }
}
