/** Qwen free-login TTS, ported from the JRead qianwen voice plugin protocol.
 *
 * Speaks over wss://speech-tts.qianwen.com with a daily sign fetched from
 * public mirrors — no account, no key. Voices:
 *  - 鹿 (LU) clone girls (default: 鹿·沈曦, lu_female_child group) with a
 *    24-emotion reference-sample router (温柔喜悦 by default);
 *  - Qwen official voices as stable fallbacks (起司妹妹, 小酒窝, …).
 * Output: 24 kHz s16le PCM → silk (via audio-convert) → .silk file for the
 * OneBot `record` segment.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import WebSocket from 'ws'
import { pcmToSilk } from './audio-convert.js'

const AUTH_URLS = [
  'https://cnb.cool/mingwuyan/yinpin/-/git/raw/main/qianwen.json?download=true',
  'https://cnb.cool/xiatian.ktn/tts/-/git/raw/main/auth_qianwen.json',
]
const GROUP_BASE = 'https://cnb.cool/applecabal/viocefactory/-/git/raw/main/ai_drama_voice_pool_zh_v2_20260825/qwen_lazy_groups_v1'
const GROUP_VERSION = '9859fae'

/** [friendly name, lu group, lu voice id] — 鹿系克隆女童音色 */
const LU_VOICES: Array<[string, string, string]> = [
  ['沈曦', 'lu_female_child', 'lu_female_child_沈曦'],
  ['幼年葛术', 'lu_female_child', 'lu_female_child_幼年葛术'],
]

/** Qwen official voices (no reference audio needed) */
const OFFICIAL_VOICES: Record<string, string> = {
  '起司妹妹': 'zh_female_quark_xinshen',
  '小酒窝': 'zh_female_quark_luoying',
  '彩虹甜豆': 'zh_female_quark_f29',
  '念念': 'zh_female_quark_xiaoxiao',
  '若初': 'zh_female_quark_lulu',
  '沐阳': 'zh_female_quarkF531S0_ptts',
}

export const LU_EMOTIONS = [
  '欢快明亮', '兴奋雀跃', '得意张扬', '温柔喜悦', '强势凌厉', '压抑怒火', '暴怒嘶吼', '冷讥嘲讽',
  '深沉悲伤', '哽咽泣诉', '绝望空洞', '压抑哀恸', '平静沉稳', '温柔安抚', '惊讶错愕', '恐惧紧张',
  '厌恶鄙夷', '疲惫虚弱', '深情告白', '急切催促', '威严庄重', '狡黠神秘', '傲慢冷漠', '慵懒微醺',
]

export const DEFAULT_VOICE = '沈曦'
export const DEFAULT_EMOTION = '温柔喜悦'

function cacheDir(): string {
  const dir = path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? '.', '.dsh'), 'channel-qq')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

interface QwenAuth { nonce: string; timestamp: string; sign: string; updateDate?: string }

async function fetchAuth(): Promise<QwenAuth> {
  const file = path.join(cacheDir(), 'qwen-auth.json')
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as QwenAuth
    if (cached.nonce && cached.updateDate === today()) return cached
  } catch { /* miss */ }
  for (const url of AUTH_URLS) {
    try {
      const remote = await (await fetch(url)).json() as QwenAuth
      if (remote.nonce && remote.timestamp && remote.sign) {
        const auth = { ...remote, updateDate: today() }
        try { fs.writeFileSync(file, JSON.stringify(auth)) } catch { /* best-effort */ }
        return auth
      }
    } catch { /* try next mirror */ }
  }
  throw new Error('千问免登录认证获取失败（检查网络）')
}

interface CloneVoice {
  id: string
  displayName?: string
  referenceText?: string
  audioUrl?: string
  emotion_samples?: Array<{ emotion: string; referenceText: string; audioUrl: string }>
}

async function loadGroup(group: string): Promise<CloneVoice[]> {
  const file = path.join(cacheDir(), `qwen-clone-${group}-${GROUP_VERSION}.json`)
  const parse = (text: string): CloneVoice[] => {
    const parsed = JSON.parse(text) as { key?: string; voices?: CloneVoice[] }
    if (parsed.key !== group || !Array.isArray(parsed.voices)) throw new Error(`克隆分组不完整: ${group}`)
    return parsed.voices
  }
  try { return parse(fs.readFileSync(file, 'utf8')) } catch { /* miss */ }
  const text = await (await fetch(`${GROUP_BASE}/${group}.json?v=${GROUP_VERSION}`)).text()
  const voices = parse(text)
  try { fs.writeFileSync(file, text) } catch { /* best-effort */ }
  return voices
}

function wsUrl(auth: QwenAuth): string {
  const params = [
    'nt=5', 'nw=wifi', 've=6.1.5.2782', 'pf=3300', 'fr=android', 'bi=37260', 'pr=qwen', 'sv=release',
    'ch=tongyi%40store_free_vivo', 'os=15', 'nonce=' + auth.nonce, 'timestamp=' + auth.timestamp,
    'sign=' + auth.sign, 'bizid=qwen-chat',
  ]
  return 'wss://speech-tts.qianwen.com/api/v2/tts?' + params.join('&')
}

function synthPcm(opts: { text: string; vcn: string; audioText?: string; audioUrl?: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fetchAuth().then(auth => {
      const ws = new WebSocket(wsUrl(auth), {
        headers: {
          Origin: 'https://tongyi.aliyun.com',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 16; PJX110) AliApp(tongyi/6.1.5.2780)',
        },
      })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => { try { ws.close() } catch { /* gone */ } reject(new Error('千问合成超时')) }, 45000)
      ws.on('open', () => {
        const reqid = Array.from({ length: 32 }, () => 'abcdef0123456789'[Math.floor(Math.random() * 16)]).join('')
        const base = {
          reqid, text: opts.text, model: 'QUARK_VOICE', vcn: opts.vcn, type: 'stream',
          speed: 1, volume: 50, format: 'pcm', status: 1, sample_rate: 24000, language_type: 'Chinese',
          extra_params: { chat_req_id: crypto.randomUUID(), language_type: 'Chinese' },
        } as Record<string, unknown>
        const msg1: Record<string, unknown> = { ...base }
        if (opts.audioText !== undefined && opts.audioUrl !== undefined) {
          msg1.audio_text = opts.audioText
          msg1.audio_url = opts.audioUrl
        }
        const msg2: Record<string, unknown> = { ...base, text: '', vcn: 'zh_female_quarkF531S0_ptts', status: 2 }
        ws.send(JSON.stringify(msg1))
        setTimeout(() => { try { ws.send(JSON.stringify(msg2)) } catch { /* closing */ } }, 50)
      })
      ws.on('message', raw => {
        try {
          const data = JSON.parse(raw.toString()) as { code?: number; message?: string; data?: { audio?: string; status?: number | string } }
          if (data.code !== undefined && data.code !== 2000000) {
            clearTimeout(timer); reject(new Error(`千问API ${data.code}: ${data.message ?? ''}`)); return
          }
          if (data.data?.audio) chunks.push(Buffer.from(data.data.audio, 'base64'))
          if (Number(data.data?.status) === 2) {
            clearTimeout(timer)
            try { ws.close(1000, 'done') } catch { /* gone */ }
            resolve(Buffer.concat(chunks))
          }
        } catch (error) { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) }
      })
      ws.on('error', error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) })
    }).catch(reject)
  })
}

export interface QwenSayResult { silkPath: string; durationMs: number; voice: string; emotion: string | null }

/** Synthesize `text` to a .silk file. Voice by friendly name (default 鹿·沈曦);
 *  LU voices accept one of the 24 emotions (default 温柔喜悦). */
export async function qwenSayToSilk(text: string, options?: {
  voice?: string
  emotion?: string
  outDir?: string
}): Promise<QwenSayResult> {
  const wanted = (options?.voice ?? DEFAULT_VOICE).trim()
  const luEntry = LU_VOICES.find(([name]) => wanted === name || wanted === `鹿·${name}`)
  if (luEntry === undefined) {
    const official = OFFICIAL_VOICES[wanted]
    if (official === undefined) {
      throw new Error(`未知音色「${wanted}」。可用：${LU_VOICES.map(v => v[0]).join('、')}（鹿·女童）；${Object.keys(OFFICIAL_VOICES).join('、')}（官方）`)
    }
    const pcm = await synthPcm({ text, vcn: official })
    return finishSilk(pcm, wanted, null, options?.outDir)
  }
  const [, group, voiceId] = luEntry
  const voices = await loadGroup(group)
  const voice = voices.find(v => v.id === voiceId)
  if (voice === undefined) throw new Error(`音色 ${voiceId} 不在分组 ${group} 里（远程清单可能已更新）`)
  const emotionWanted = (options?.emotion ?? DEFAULT_EMOTION).trim()
  const samples = voice.emotion_samples ?? []
  const sample = samples.find(s => s.emotion === emotionWanted)
    ?? samples.find(s => s.emotion === DEFAULT_EMOTION)
    ?? samples[0]
  const engineId = 'create_voice_' + voiceId.replace(/^lu_/, '')
  const pcm = await synthPcm({
    text,
    vcn: engineId,
    audioText: sample?.referenceText,
    audioUrl: sample?.audioUrl,
  })
  return finishSilk(pcm, voice.displayName ?? wanted, sample?.emotion ?? null, options?.outDir)
}

async function finishSilk(pcm: Buffer, voice: string, emotion: string | null, outDir?: string): Promise<QwenSayResult> {
  const { silkBuffer, duration } = await pcmToSilk(pcm, 24000)
  const dir = outDir ?? path.join(cacheDir(), 'voice')
  fs.mkdirSync(dir, { recursive: true })
  const silkPath = path.join(dir, `say-${Date.now()}.silk`)
  fs.writeFileSync(silkPath, silkBuffer)
  return { silkPath, durationMs: Math.round(duration), voice, emotion }
}
