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
export declare function loadCookie(): Promise<string>;
export declare function saveCookie(cookie: string): Promise<void>;
export interface KugouSearchHit {
    hash: string;
    name: string;
    singers: string;
    durationSec?: number;
}
export declare function searchSongs(keyword: string, limit?: number): Promise<KugouSearchHit[]>;
export interface KugouUrlResult {
    url: string;
    status: number;
    trial: boolean;
    extName: string;
}
/** Resolve playback URL for a hash. quality: auto|viper_tape|viper_clear|super|high|flac|320|128 */
export declare function songUrl(hash: string, quality?: string): Promise<KugouUrlResult>;
/** QR login step 1: key + QR image URL. */
export declare function qrLoginStart(): Promise<{
    key: string;
    qrUrl: string;
}>;
/** QR login step 2: poll. Returns cookie on success. */
export declare function qrLoginPoll(key: string): Promise<{
    status: string;
    cookie: string;
    nickname?: string;
}>;
