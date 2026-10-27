/**
 * OrcaTerm 凭据来源：账号池优先，回退浏览器 cookie 采集与 token 文件。
 *
 * ## 为什么需要三层
 *
 * 三条路径对应三种真实使用场景，缺一条就有用户走不通：
 *
 * 1. **账号池**（正常路径）—— 用户在 Jet Hub 面板点「登录」，扫码后凭据落进
 *    `ctx.credentials`，账号进 `accountPool`。这条路径支持多账号、过期提示、
 *    面板展示，是主路径。
 * 2. **浏览器 cookie 采集**（免手输）—— 面板的登录窗口本身就是 DSH 内置浏览器
 *    的可见标签页，登录后 `uin`/`skey` 就在同一个 cookie jar 里。直接从 jar 读出来，
 *    用户不需要复制粘贴任何东西。
 * 3. **token 文件**（离线/脚本场景）—— `~/.dsh/orcaterm_token.txt`，内容可以是
 *    `uin=…; skey=…` 或 `ot_session` JWT。CI、无图形会话、或用户手上有现成凭据时用。
 *
 * ## 采集器的边界
 *
 * 内置浏览器是 Chromium，cookie 用 `Chrome Safe Storage` 钥匙串密码加密
 * （**实测确认**：用 `Chromium Safe Storage` 会解出看似合理但错误的明文，
 * 比报错更危险）。`v10` 值布局是 `v10 || 32 字节常量头 || 密文` —— 那 32 字节
 * 在**明文**里，解完整段再丢弃前 32 字节，砍密文是错的。
 *
 * 解出不可打印的内容一律丢弃：错误的 key 不会产出可打印明文，这条闸门防止把
 * 垃圾当会话交出去。
 *
 * @module orcaterm-credential
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
/** 钥匙串项候选（实测内置浏览器用第一个）。 */
const KEYCHAIN_CANDIDATES = ['Chrome Safe Storage', 'Chromium Safe Storage'];
/** 承载登录态的域，最长匹配优先。 */
const SESSION_HOSTS = ['orcaterm.cloud.tencent.com', 'lightai.cloud.tencent.com', '.cloud.tencent.com'];
/** DSH_HOME 下的默认 cookie 库位置。 */
export function defaultCookieDb(dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')) {
    return path.join(dshHome, 'browser', 'profile', 'Default', 'Cookies');
}
/** token 文件路径。 */
export function tokenFilePath(dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')) {
    return path.join(dshHome, 'orcaterm_token.txt');
}
/** 读钥匙串密码；失败返回 null。 */
function keychainPassword() {
    for (const service of KEYCHAIN_CANDIDATES) {
        try {
            const value = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            if (value)
                return value;
        }
        catch { /* 试下一个 */ }
    }
    return null;
}
/** Chromium 的 PBKDF2 参数（2013 起 saltysalt / 1003 轮 / 16 字节）。 */
export function deriveKey(password) {
    return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}
/**
 * 解密一个 Chromium cookie 值。
 *
 * 顺序很重要：先用空格 IV 解整段（去掉 `v10` 前缀），**再**丢弃前 32 字节明文。
 */
export function decryptChromiumValue(blob, key) {
    let body = blob;
    const prefix = body.subarray(0, 3).toString();
    if (prefix === 'v10' || prefix === 'v11')
        body = body.subarray(3);
    if (body.length === 0)
        return '';
    if (body.length % 16 !== 0)
        body = body.subarray(0, body.length - (body.length % 16));
    if (body.length === 0)
        return '';
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    let out = Buffer.concat([decipher.update(body), decipher.final()]);
    const pad = out[out.length - 1];
    if (pad !== undefined && pad > 0 && pad <= 16)
        out = out.subarray(0, out.length - pad);
    if (out.length > 32)
        out = out.subarray(32);
    return out.toString('utf8');
}
/** 用 sqlite3 CLI 查库（BLOB 必须走 hex，`-json` 不能往返二进制）。 */
function querySqlite(dbPath, sql) {
    const tmp = path.join(os.tmpdir(), `dsh-orcaterm-${process.pid}-${Date.now()}.db`);
    fs.copyFileSync(dbPath, tmp);
    try {
        const raw = execFileSync('sqlite3', ['-json', tmp, sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        const text = raw.trim();
        return text === '' ? [] : JSON.parse(text);
    }
    finally {
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                fs.unlinkSync(tmp + suffix);
            }
            catch { /* 不存在 */ }
        }
    }
}
/**
 * 从 DSH 内置浏览器的 cookie 库采集 OrcaTerm 会话。
 *
 * @returns 网页形态凭据；库缺失、无登录、或解不出可打印值时返回 null
 */
export function harvestBrowserSession(cookieDb = defaultCookieDb()) {
    if (!fs.existsSync(cookieDb))
        return null;
    const password = keychainPassword();
    if (password === null)
        return null;
    const key = deriveKey(password);
    const rows = querySqlite(cookieDb, "SELECT host_key, name, hex(encrypted_value) AS hex FROM cookies WHERE name IN ('uin','skey','userId')");
    const found = new Map();
    for (const row of rows) {
        const host = String(row.host_key ?? '');
        const rank = SESSION_HOSTS.findIndex((candidate) => host === candidate || host.endsWith(candidate));
        if (rank < 0 || !row.hex)
            continue;
        let value = '';
        try {
            value = decryptChromiumValue(Buffer.from(String(row.hex), 'hex'), key);
        }
        catch {
            continue;
        }
        // 解出不可打印内容 = key 不对；丢弃而不是把垃圾当会话。
        if (!value || !/^[\x20-\x7e]+$/.test(value))
            continue;
        const existing = found.get(String(row.name));
        if (existing === undefined || rank < existing.rank)
            found.set(String(row.name), { value, rank });
    }
    const uin = found.get('uin')?.value ?? '';
    const skey = found.get('skey')?.value ?? '';
    if (!uin || !skey)
        return null;
    return { kind: 'web', uin, skey, userId: found.get('userId')?.value ?? '' };
}
/** 解析 token 文件内容为凭据；认 `uin/skey` 串、JSON、裸 JWT。 */
export function parseCredentialText(text) {
    const raw = text.trim();
    if (!raw)
        return null;
    // JSON：{"cookie":…} / {"uin":…,"skey":…} / {"ot_session":…}
    if (raw.startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            const nested = parsed.cookie ?? parsed.raw;
            if (typeof nested === 'string' && nested.trim())
                return parseCredentialText(nested);
            const uin = String(parsed.uin ?? '').trim();
            const skey = String(parsed.skey ?? '').trim();
            if (uin && skey)
                return { kind: 'web', uin, skey, userId: String(parsed.userId ?? '').trim() };
            const ot = String(parsed.ot_session ?? '').trim();
            if (isJwt(ot))
                return { kind: 'desktop', otSession: ot };
        }
        catch { /* 落到 cookie 串解析 */ }
    }
    // cookie 串形态
    const pairs = new Map();
    for (const part of raw.split(';')) {
        const index = part.indexOf('=');
        if (index <= 0)
            continue;
        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (value && !pairs.has(name))
            pairs.set(name, value);
    }
    const uin = pairs.get('uin');
    const skey = pairs.get('skey');
    if (uin && skey)
        return { kind: 'web', uin, skey, userId: pairs.get('userId') ?? '' };
    // 裸 JWT
    const candidate = raw.replace(/^bearer\s+/i, '').trim();
    if (isJwt(candidate))
        return { kind: 'desktop', otSession: candidate };
    return null;
}
function isJwt(value) {
    return value.startsWith('eyJ') && value.split('.').length === 3
        && !value.includes(';') && !value.includes(' ') && value.length > 20;
}
/**
 * 按优先级解析一个可用凭据。
 *
 * @param options.poolCredential 账号池给出的凭据（最高优先级）
 * @param options.cookieDb 自定义 cookie 库路径
 * @param options.tokenFile 自定义 token 文件路径
 */
export function resolveOrcaTermCredential(options = {}) {
    if (options.poolCredential !== undefined)
        return options.poolCredential;
    const harvested = harvestBrowserSession(options.cookieDb);
    if (harvested !== null)
        return harvested;
    try {
        const file = options.tokenFile ?? tokenFilePath();
        if (fs.existsSync(file))
            return parseCredentialText(fs.readFileSync(file, 'utf8'));
    }
    catch { /* 读不到就当没有 */ }
    return null;
}
//# sourceMappingURL=orcaterm-credential.js.map