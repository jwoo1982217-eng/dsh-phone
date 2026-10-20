/** Netease VIP playback for dsh-channel-qq.
 *
 * Path (verified live from this host): POST /api/song/enhance/player/url with
 * {ids:[..], br:..} + member Cookie (MUSIC_U=...) -> url for VIP/fee tracks.
 * weapi is WAF-blocked from datacenter IPs (200 + empty body) — avoided.
 * QR login: /api/login/qrcode/unikey (key) + /api/login/qrcode/client/login (poll,
 * 803 = cookie in Set-Cookie). Member check: /api/vip/info/ or login/status.
 *
 * Cookie storage: <dshHome>/channel-qq/netease-cookie.txt (written by login tool or hand-paste).
 */

import { promises as fs } from 'node:fs'

const HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`
const COOKIE_FILE = `${HOME}/channel-qq/netease-cookie.txt`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'

export async function loadCookie(): Promise<string> {
  try {
    return (await fs.readFile(COOKIE_FILE, 'utf8')).trim()
  } catch {
    return ''
  }
}

export async function saveCookie(cookie: string): Promise<void> {
  await fs.writeFile(COOKIE_FILE, cookie.trim(), 'utf8')
}

function cookieHeader(extra = 'appver=2.0.2'): string {
  return extra
}

/** POST form to music.163.com /api/ endpoint, parse JSON. */
async function apiPost(path: string, params: Record<string, string>, cookie?: string): Promise<any> {
  const res = await fetch(`https://music.163.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      'User-Agent': UA,
      Cookie: [cookieHeader(), cookie].filter((v) => v !== undefined && v !== '').join('; '),
    },
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`网易云响应异常 (HTTP ${res.status}): ${text.slice(0, 100)}`)
  }
}

export interface NeteaseSearchHit {
  id: string
  name: string
  artists: string
  durationSec?: number
}

export async function searchSongs(keyword: string, limit = 5): Promise<NeteaseSearchHit[]> {
  const data = await apiPost('/api/search/get/web', {
    s: keyword,
    limit: String(Math.min(limit, 10)),
    type: '1',
    offset: '0',
  }, 'appver=2.0.2')
  const songs = (data as { result?: { songs?: any[] } }).result?.songs ?? []
  return songs.map((s: any) => ({
    id: String(s.id),
    name: s.name,
    artists: (s.artists ?? []).map((a: any) => a.name).join('/'),
    durationSec: s.duration !== undefined ? Math.round(s.duration / 1000) : undefined,
  }))
}

export interface NeteaseUrlResult {
  url: string | null
  fee: number
  code: number
  br: number
  size: number
  vipRequired: boolean
}

/** Resolve playable URL. Cookie with MUSIC_U unlocks VIP/fee tracks; br is bitrate (999000 = max). */
export async function songUrl(songId: string, br = 320000, cookie?: string): Promise<NeteaseUrlResult> {
  const effectiveCookie = cookie !== undefined && cookie !== '' ? cookie : await loadCookie()
  const data = await apiPost('/api/song/enhance/player/url', {
    br: String(br),
    ids: `[${Number(songId)}]`,
  }, effectiveCookie === '' ? 'appver=2.0.2' : effectiveCookie)
  const item = (data.data ?? [])[0] ?? {}
  return {
    url: typeof item.url === 'string' ? item.url : null,
    fee: item.fee ?? 0,
    code: item.code ?? data.code ?? 0,
    br: item.br ?? 0,
    size: item.size ?? 0,
    vipRequired: item.url === null && (item.fee === 1 || item.fee === 4 || item.fee === 16),
  }
}

/** QR login step 1: get unikey + QR image URL. */
export async function qrLoginStart(): Promise<{ unikey: string; qrUrl: string }> {
  const body = await apiPost('/api/login/qrcode/unikey', { type: '3' })
  const unikey = body.unikey ?? ''
  if (unikey === '') throw new Error('拿不到登录 key（可能被风控），稍后再试')
  return { unikey, qrUrl: `https://music.163.com/login?codekey=${unikey}` }
}

/** QR login step 2: poll. 800 expired / 801 waiting / 802 scanned / 803 success(+cookie). */
export async function qrLoginPoll(unikey: string): Promise<{ code: number; message: string; cookie: string }> {
  const res = await fetch('https://music.163.com/api/login/qrcode/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/', 'User-Agent': UA },
    body: new URLSearchParams({ key: unikey, type: '3' }).toString(),
  })
  const body = (await res.json()) as { code?: number; message?: string; msg?: string }
  let cookie = ''
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const line of setCookie) {
    const first = line.split(';', 1)[0].trim()
    if (first.startsWith('MUSIC_U=') || first.startsWith('__csrf=') || first.startsWith('MUSIC_A=')) {
      cookie = cookie === '' ? first : `${cookie}; ${first}`
    }
  }
  return { code: body.code ?? -1, message: body.message ?? body.msg ?? '', cookie }
}

/** Login status + VIP level from the stored cookie. */
export async function loginStatus(): Promise<{ loggedIn: boolean; nickname?: string; vipType?: string }> {
  const cookie = await loadCookie()
  if (cookie === '') return { loggedIn: false }
  const data = await apiPost('/api/nuser/account/get', {}, cookie)
  const profile = data.profile
  if (profile === undefined || profile === null) return { loggedIn: false }
  let vipType = '普通'
  try {
    const vip = await apiPost('/api/vip/info/', {}, cookie)
    const v = vip.data ?? {}
    if (v.redVipLevel !== undefined || v.redVipDynamicIconUrl !== undefined) vipType = `黑胶VIP Lv.${v.redVipLevel ?? '?'}`
  } catch { /* keep 普通 */ }
  return { loggedIn: true, nickname: profile.nickname, vipType }
}
