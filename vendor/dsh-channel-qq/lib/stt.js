/** Voice-bar → text (STT) pipeline, ported from the OpenClaw extension:
 * get_record (silk) → silk-wasm decode → WAV → [OI]-compatible
 * /audio/transcriptions (Whisper-style form upload) → text for the model.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { convertSilkToWav } from './audio-convert.js';
function resolveSTT(config) {
    if (!config.enabled || !config.baseUrl)
        return null;
    let apiKey = config.apiKey ?? '';
    if (apiKey.startsWith('$'))
        apiKey = process.env[apiKey.slice(1)] ?? '';
    if (apiKey === '')
        return null;
    return { baseUrl: config.baseUrl.replace(/\/+$/, ''), apiKey, model: config.model };
}
/** Transcribe one [OI] audio transcription endpoint via curl.
 * 2026-09-17: direct fetch to api.groq.com always 403s (Cloudflare blocks the
 * egress IP); FlClash's mixed port 127.0.0.1:7890 works (proxy 200 / direct 403
 * verified). Node's global fetch cannot use that proxy, so we shell out to
 * curl.exe with -x, falling back to direct when the proxy attempt fails. */
const STT_PROXY = process.env.STT_PROXY ?? 'http://127.0.0.1:7890';
async function transcribeWav(stt, wavPath) {
    const { execFile } = await import('node:child_process');
    const attempt = (proxy) => new Promise((resolve, reject) => {
        const args = ['-s', '-m', '90', '-w', '\n%{http_code}'];
        if (proxy)
            args.push('-x', proxy);
        args.push('-F', `file=@${wavPath};filename=${path.basename(wavPath)}`, '-F', `model=${stt.model}`, '-F', 'language=zh', '-F', 'response_format=json', '-H', `Authorization: Bearer ${stt.apiKey}`, `${stt.baseUrl}/audio/transcriptions`);
        execFile('curl.exe', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err && !stdout)
                return reject(err);
            const idx = stdout.lastIndexOf('\n');
            resolve({ code: stdout.slice(idx + 1).trim(), body: stdout.slice(0, idx) });
        });
    });
    let result;
    try {
        result = await attempt(STT_PROXY);
        if (result.code !== '200')
            throw new Error(`proxy HTTP ${result.code}`);
    }
    catch {
        result = await attempt(null);
    }
    if (result.code !== '200')
        throw new Error(`STT HTTP ${result.code}: ${result.body.slice(0, 200)}`);
    const text = JSON.parse(result.body).text?.trim() ?? '';
    return text === '' ? null : text;
}
/**
 * Fetch a voice-bar message and transcribe it.
 * @returns `[文字, 时长秒]`, or null when STT is disabled/unavailable.
 */
export async function transcribeVoiceMessage(client, config, messageId, log) {
    const stt = resolveSTT(config);
    if (stt === null)
        return null;
    const tempDir = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'), 'channel-qq', 'voice-tmp');
    await fs.mkdir(tempDir, { recursive: true });
    // 2026-09-17: out_format 'mp4' made NapCat fail with "file not found"
    // (ffmpeg unavailable). 'amr' returns the original file as-is; the silk→wav
    // conversion below handles it either way.
    const record = await client.call('get_record', { message_id: messageId, out_format: 'amr' }, 30_000);
    let local = typeof record?.file === 'string' ? record.file : '';
    let bytes = null;
    if (local !== '' && !local.startsWith('http')) {
        bytes = await fs.readFile(local).catch(() => null);
    }
    if (bytes === null) {
        const url = typeof record?.url === 'string' ? record.url : (local.startsWith('http') ? local : '');
        if (url === '')
            throw new Error('get_record returned no usable file');
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`voice download HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
        local = path.join(tempDir, `voice_${messageId}`);
        await fs.writeFile(local, bytes);
    }
    // NapCat hands us silk (or already-decoded audio); silk needs a decode to WAV.
    let wavPath = local;
    if (local.endsWith('.silk') || local.endsWith('.slk') || local.endsWith('.amr')) {
        const converted = await convertSilkToWav(local, tempDir);
        if (converted === null)
            throw new Error('silk decode failed');
        wavPath = converted.wavPath;
        log(`voice ${messageId}: silk → wav (${Math.round(converted.duration / 100) / 10}s)`);
    }
    const text = await transcribeWav(stt, wavPath);
    await fs.rm(local, { force: true }).catch(() => { });
    if (wavPath !== local)
        await fs.rm(wavPath, { force: true }).catch(() => { });
    return text === null ? null : [text, 0];
}
