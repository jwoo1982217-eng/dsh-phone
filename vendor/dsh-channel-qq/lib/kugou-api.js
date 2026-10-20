/** KuGou music via self-hosted KuGouMusicApi server (port 4000).
 *
 * Ported from astrbot_plugin_kugoumusic (analyzed):
 * - server: github.com/MakcRe/KuGouMusicApi, started with PORT=4000
 * - /register/dev once to get dfid (device id), persisted
 * - /search (needs login token after kugou banned anonymous search: error_code 152)
 * - /song/url?hash=..&quality=.. -> { url|backupUrl[], status(1 ok/2 quality degrade), extName }
 * - QR login: /login/qr/key -> /login/qr/create -> /login/qr/check (token+userid)
 * - Cookie storage: <dshHome>/channel-qq/kugou-cookie.txt (token=..;userid=..)
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const BASE = process.env.KUGOU_API_BASE ?? 'http://127.0.0.1:4000';
const COOKIE_FILE = `${HOME}/channel-qq/kugou-cookie.txt`;
const DFID_FILE = `${HOME}/channel-qq/kugou-dfid.txt`;
export async function loadCookie() {
    try {
        return (await fs.readFile(COOKIE_FILE, 'utf8')).trim();
    }
    catch {
        return '';
    }
}
export async function saveCookie(cookie) {
    await fs.writeFile(COOKIE_FILE, cookie.trim(), 'utf8');
}
async function ensureDfid() {
    try {
        const existing = (await fs.readFile(DFID_FILE, 'utf8')).trim();
        if (existing !== '')
            return existing;
    }
    catch { /* first run */ }
    const res = await fetch(`${BASE}/register/dev`);
    const body = (await res.json());
    const dfid = body.data?.dfid ?? '';
    if (dfid === '')
        throw new Error('register/dev 拿不到 dfid');
    await fs.writeFile(DFID_FILE, dfid, 'utf8');
    return dfid;
}
async function kgGet(path, params, anonFallback = false) {
    const dfid = await ensureDfid();
    const cookie = await loadCookie();
    const search = new URLSearchParams({ ...params, dfid });
    // kugou banned anonymous search (error_code 152): needs logged cookie; anonymous
    // placeholder only helps /search per kugoumusic plugin notes.
    if (cookie === '') {
        if (anonFallback)
            search.set('token', 'kg');
    }
    else {
        search.set('cookie', cookie);
    }
    const attempt = async () => {
        const res = await fetch(`${BASE}${path}?${search.toString()}`);
        const text = await res.text();
        try {
            return JSON.parse(text);
        }
        catch (error) {
            // Kugou risk control occasionally answers with a non-JSON body; one
            // short retry absorbs the transient hiccup instead of failing the turn.
            throw new Error(`酷狗接口返回非JSON（HTTP ${res.status}）：${text.slice(0, 80)}`);
        }
    };
    try {
        return await attempt();
    }
    catch (first) {
        if (!/非JSON/.test(String(first)))
            throw first;
        await new Promise(resolve => setTimeout(resolve, 1200));
        return await attempt();
    }
}
export async function searchSongs(keyword, limit = 5) {
    const body = await kgGet('/search', { keywords: keyword, type: 'song', page: '1', pagesize: String(Math.min(limit, 10)) }, true);
    if (body.status !== 1) {
        const code = body.error_code;
        throw new Error(code === 152 ? '酷狗搜索需要登录：先 qq_kugou_login 扫码' : `酷狗搜索失败: ${body.error_msg ?? body.msg ?? code}`);
    }
    const lists = body.data?.lists ?? [];
    return lists.map((item) => ({
        hash: item.hash ?? item.FileHash ?? '',
        name: item.name ?? item.SongName ?? '',
        singers: (item.singers ?? []).map((s) => s.name ?? s).join('/'),
        durationSec: item.duration !== undefined ? Math.round(item.duration / 1000) : undefined,
    }));
}
/** Resolve playback URL for a hash. quality: auto|viper_tape|viper_clear|super|high|flac|320|128 */
export async function songUrl(hash, quality = 'auto') {
    // 'auto' is not a value the API accepts (error_code 20010): walk a fallback
    // chain from compact to lossless instead.
    const candidates = quality === 'auto' || quality === '' ? ['128', '320', 'flac', 'high'] : [quality];
    let body = {};
    let lastCode = '';
    for (const q of candidates) {
        body = await kgGet('/song/url', { hash, quality: q });
        const has = (Array.isArray(body.backupUrl) && body.backupUrl.length > 0) || body.url;
        if (has)
            break;
        lastCode = `error_code=${String(body.error_code ?? '?')} quality=${q}`;
        body = {};
    }
    if (!body || (!body.url && !(Array.isArray(body.backupUrl) && body.backupUrl.length > 0))) {
        throw new Error(`酷狗拿不到链接 (${lastCode || 'no response'})`);
    }
    const pick = (item) => {
        for (const key of ['url', 'backupUrl']) {
            const v = item[key];
            if (Array.isArray(v)) {
                const first = v.find((u) => Boolean(u));
                if (first !== undefined)
                    return String(first);
            }
            else if (v)
                return String(v);
        }
        return '';
    };
    const url = pick(body);
    if (url === '')
        throw new Error(`酷狗拿不到链接 (status=${body.status} error_code=${body.error_code})`);
    const trial = url.toLowerCase().includes('p_0_') && !url.toLowerCase().includes('full');
    return { url, status: body.status ?? 0, trial, extName: body.extName ?? 'mp3' };
}
/** QR login step 1: key + QR image URL. */
export async function qrLoginStart() {
    const keyBody = await kgGet('/login/qr/key', { timestamp: String(Date.now()) });
    const key = keyBody.data?.qrcode ?? '';
    if (key === '')
        throw new Error('拿不到酷狗登录 key');
    const create = await kgGet('/login/qr/create', { key, qrimg: 'true' });
    const qrUrl = create.data?.url ?? `https://activity.kugou.com/static/login/index.html?key=${encodeURIComponent(key)}`;
    return { key, qrUrl };
}
/** QR login step 2: poll. Returns cookie on success. */
export async function qrLoginPoll(key) {
    const body = await kgGet('/login/qr/check', { key, timestamp: String(Date.now()) });
    const data = body.data ?? {};
    const status = String(data.status ?? body.status ?? '');
    if (status === '1' || body.status === 1) {
        const token = data.token ?? '';
        const userid = data.userid ?? '';
        if (token !== '') {
            const cookie = `token=${token};userid=${userid}`;
            await saveCookie(cookie);
            return { status: 'ok', cookie, nickname: data.nickname };
        }
    }
    return { status, cookie: '' };
}
