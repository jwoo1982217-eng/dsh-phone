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
export declare function loadCookie(): Promise<string>;
export declare function saveCookie(cookie: string): Promise<void>;
export interface NeteaseSearchHit {
    id: string;
    name: string;
    artists: string;
    durationSec?: number;
}
export declare function searchSongs(keyword: string, limit?: number): Promise<NeteaseSearchHit[]>;
export interface NeteaseUrlResult {
    url: string | null;
    fee: number;
    code: number;
    br: number;
    size: number;
    vipRequired: boolean;
}
/** Resolve playable URL. Cookie with MUSIC_U unlocks VIP/fee tracks; br is bitrate (999000 = max). */
export declare function songUrl(songId: string, br?: number, cookie?: string): Promise<NeteaseUrlResult>;
/** QR login step 1: get unikey + QR image URL. */
export declare function qrLoginStart(): Promise<{
    unikey: string;
    qrUrl: string;
}>;
/** QR login step 2: poll. 800 expired / 801 waiting / 802 scanned / 803 success(+cookie). */
export declare function qrLoginPoll(unikey: string): Promise<{
    code: number;
    message: string;
    cookie: string;
}>;
/** Login status + VIP level from the stored cookie. */
export declare function loginStatus(): Promise<{
    loggedIn: boolean;
    nickname?: string;
    vipType?: string;
}>;
