/** Sticker (emoji) store: steal images from the primary group, auto-attach on replies.
 *
 * Deliberately a lite port: the OpenClaw extension's VLM intensity scoring is
 * not carried over; stealing is keyword-free and sending is probability-based.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseInbound } from './segments.js';
export class EmojiStore {
    client;
    log;
    library;
    dir;
    registeredDir;
    constructor(config, client, log, library) {
        this.client = client;
        this.log = log;
        this.library = library;
        this.dir = config.dir ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'), 'channel-qq', 'emoji');
        this.registeredDir = config.registeredDir ?? path.join(this.dir, '..', 'emoji-registered');
    }
    async init() {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.mkdir(this.registeredDir, { recursive: true });
    }
    /** Steal the first image of a primary-group message into the raw sticker dir. */
    async steal(event) {
        const parsed = parseInbound(event);
        const url = parsed.imageUrls[0];
        if (url === undefined)
            return null;
        try {
            const ext = path.extname(new URL(url).pathname).replace(/[^.\w]/g, '') || '.png';
            const target = path.join(this.dir, `stolen_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`);
            const res = await fetch(url);
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            await fs.writeFile(target, buf);
            this.log(`stole sticker → ${path.basename(target)}`);
            if (this.library !== undefined) {
                const entry = await this.library.addFile(target, 'stolen');
                if (entry === null) {
                    this.log('duplicate sticker (md5 known), not indexed again');
                    return null;
                }
                return entry;
            }
            return null;
        }
        catch (error) {
            this.log(`sticker steal failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    /** Pick one registered sticker for auto-send; returns an absolute path or null. */
    async pickRegistered() {
        try {
            const files = (await fs.readdir(this.registeredDir)).filter((name) => !name.startsWith('.'));
            if (files.length === 0)
                return null;
            return path.join(this.registeredDir, files[Math.floor(Math.random() * files.length)]);
        }
        catch {
            return null;
        }
    }
    async sendRandom(isGroup, chatId) {
        const file = await this.pickRegistered();
        if (file === null)
            return;
        const message = [{ type: 'image', data: { file: `file://${file}` } }];
        const action = isGroup ? 'send_group_msg' : 'send_private_msg';
        const payload = isGroup ? { group_id: chatId, message } : { user_id: chatId, message };
        try {
            await this.client.call(action, payload);
        }
        catch (error) {
            this.log(`auto emoji send failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
