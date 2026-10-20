/** Outbound pipeline: segmentation, rate limiting, and length caps. Ported from the OpenClaw extension. */
/**
 * Hard-split one overlong segment at natural boundaries (ported from the
 * extension's smartSplitMessage): newline first, then sentence punctuation,
 * then a hard cut. Keeps every chunk under the OneBot-safe limit.
 */
export function smartSplitMessage(text, limit) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        let splitPos = remaining.lastIndexOf('\n', limit);
        if (splitPos < limit * 0.5) {
            splitPos = Math.max(remaining.lastIndexOf('。', limit), remaining.lastIndexOf('！', limit), remaining.lastIndexOf('？', limit), remaining.lastIndexOf('!', limit), remaining.lastIndexOf('?', limit), remaining.lastIndexOf('. ', limit), remaining.lastIndexOf('；', limit), remaining.lastIndexOf('; ', limit), remaining.lastIndexOf(', ', limit), remaining.lastIndexOf('，', limit));
            if (splitPos <= 0)
                splitPos = limit;
        }
        chunks.push(remaining.slice(0, splitPos + 1).trim());
        remaining = remaining.slice(splitPos + 1).trim();
    }
    return chunks.filter((chunk) => chunk !== '');
}
/** Junk the model sometimes emits; never sent to the group (ported from the OpenClaw extension). */
const JUNK_PATTERNS = [
    /这些是重复发送的内容/i,
    /NO_REPLY/i,
    /^Something went wrong while processing your request/i,
    /^Please try again, or use \/new to start a fresh session/i,
    /^.*terminated.*$/i,
    /^GitHub\s*-\s*.+·\s*GitHub\s*$/i,
    /Contribute to .+ development by creating an account on GitHub/i,
    /未解析到有效文本内容/,
    /生成任务失败/,
];
function stripJunk(text) {
    let filtered = text;
    for (const pattern of JUNK_PATTERNS) {
        filtered = filtered.replace(pattern, '');
    }
    filtered = filtered.replace(/<思考>[\s\S]*?<\/思考>/g, '');
    filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    filtered = filtered.replace(/[（(][\d一二三四五六七八九十百千万]+字[）)]/g, '');
    const seen = new Set();
    filtered = filtered.replace(/https?:\/\/github\.com\/[^\s]+/gi, (match) => (seen.has(match) ? '' : (seen.add(match), match)));
    return filtered.trim();
}
/** English punctuation → fullwidth; straight quotes → curly pairs. */
function convertPunctuation(text) {
    let result = text.replace(/:/g, '：').replace(/,/g, '，').replace(/\?/g, '？').replace(/!/g, '！');
    let open = true;
    let converted = '';
    for (const char of result) {
        if (char === '"') {
            converted += open ? '“' : '”';
            open = !open;
        }
        else
            converted += char;
    }
    return converted;
}
/**
 * Rule-based segmentation ported from the OpenClaw extension's smartSegmenter:
 * 段数由句号说了算 — every sentence ender (。！？…!?) outside protected regions
 * (code blocks, --- blocks, quotes, brackets) starts a new segment. Emotional
 * punctuation is kept, trailing 。 is dropped, duplicates removed, and the
 * style knob tunes rhythm: conservative merges tiny adjacent sentences,
 * active keeps every sentence as its own message.
 */
export function segmentReply(text, config) {
    const { enabled, style, maxSegments, removeTrailingPeriod } = config.segmentation;
    let body = stripJunk(text);
    if (!enabled || body === '')
        return body === '' ? [] : [body];
    body = convertPunctuation(body);
    const enders = new Set(['。', '！', '？', '…', '!', '?']);
    const hasEnder = Array.from(body).some((c) => enders.has(c));
    if (!hasEnder)
        return [body];
    // Protected regions: never split inside these.
    const protectedRanges = [];
    for (const pattern of [/```[\s\S]*?```/g, /---[\s\S]*?---/g, /「[^」]*」/g, /《[^》]*》/g, /【[^【】]*】/g, /（[^（）]*）/g, /\([^()]*\)/g]) {
        for (const match of body.matchAll(pattern)) {
            protectedRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
        }
    }
    const isProtected = (pos) => protectedRanges.some((r) => pos >= r.start && pos < r.end);
    const segments = [];
    let current = '';
    const chars = Array.from(body);
    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        current += char;
        if (enders.has(char) && !isProtected(i)) {
            // Keep trailing run of the same ender or ellipsis dots with the sentence.
            while (i + 1 < chars.length && (chars[i + 1] === '…' || chars[i + 1] === char || (char === '…' && chars[i + 1] === '。'))) {
                i += 1;
                current += chars[i];
            }
            segments.push(current.trim());
            current = '';
        }
    }
    if (current.trim() !== '')
        segments.push(current.trim());
    let cleaned = segments
        .map((seg) => (removeTrailingPeriod ? seg.replace(/。+$/u, '') : seg))
        .filter((seg) => seg !== '');
    // Style rhythm: conservative glues tiny adjacent sentences; active keeps all.
    if (style === 'conservative') {
        const merged = [];
        for (const seg of cleaned) {
            const prev = merged[merged.length - 1];
            if (prev !== undefined && prev.length < 8 && seg.length < 8)
                merged[merged.length - 1] = `${prev}，${seg}`;
            else
                merged.push(seg);
        }
        cleaned = merged;
    }
    const seen = new Set();
    const deduped = [];
    for (const seg of cleaned) {
        const key = seg.trim().toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(seg);
        }
    }
    return deduped.slice(0, maxSegments);
}
/** Serialises sends so the configured rate limit holds across segments and tools. */
export class OutboundQueue {
    client;
    config;
    log;
    chain = Promise.resolve();
    /** Every segment ever sent, keyed lowercase — a repeat is skipped (sentMessages). */
    sentHistory = new Set();
    constructor(client, config, log) {
        this.client = client;
        this.config = config;
        this.log = log;
    }
    /** Queue one send; trailing nullish segments are skipped silently. */
    enqueue(send) {
        this.chain = this.chain
            .then(() => new Promise((resolve) => setTimeout(resolve, this.config.rateLimitMs)))
            .then(send)
            .catch((error) => this.log(`send failed: ${error.message}`))
            .then(() => { });
    }
    sendSegments(params) {
        const segments = segmentReply(params.text, this.config);
        let skipped = 0;
        for (const piece of segments) {
            // Cross-reply dedup: the same sentence never goes out twice.
            const key = piece.trim().toLowerCase();
            if (this.sentHistory.has(key)) {
                skipped += 1;
                continue;
            }
            this.sentHistory.add(key);
            // Hard-split any segment still over the per-message cap.
            for (const chunk of smartSplitMessage(piece, this.config.maxMessageLength)) {
                const message = [];
                if (params.replyTo !== null)
                    message.push({ type: 'reply', data: { id: String(params.replyTo) } });
                message.push({ type: 'text', data: { text: chunk } });
                const action = params.isGroup ? 'send_group_msg' : 'send_private_msg';
                const payload = params.isGroup
                    ? { group_id: params.chatId, message }
                    : { user_id: params.chatId, message };
                this.enqueue(() => this.client.call(action, payload));
            }
        }
        if (skipped > 0)
            this.log(`skipped ${skipped} duplicate segment(s)`);
    }
    async sendNow(action, payload) {
        return this.client.call(action, payload);
    }
    /** Rate-limited send that resolves with the OneBot result when its turn in the chain comes. */
    push(task) {
        return new Promise((resolve, reject) => {
            this.chain = this.chain
                .then(() => new Promise((resolve) => setTimeout(resolve, this.config.rateLimitMs)))
                .then(() => task())
                .then((value) => resolve(value))
                .catch((error) => reject(error));
        });
    }
}
