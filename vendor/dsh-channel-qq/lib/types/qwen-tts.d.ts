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
export declare const LU_EMOTIONS: string[];
export declare const DEFAULT_VOICE = "\u6C88\u66E6";
export declare const DEFAULT_EMOTION = "\u6E29\u67D4\u559C\u60A6";
export interface QwenSayResult {
    silkPath: string;
    durationMs: number;
    voice: string;
    emotion: string | null;
}
/** Synthesize `text` to a .silk file. Voice by friendly name (default 鹿·沈曦);
 *  LU voices accept one of the 24 emotions (default 温柔喜悦). */
export declare function qwenSayToSilk(text: string, options?: {
    voice?: string;
    emotion?: string;
    outDir?: string;
}): Promise<QwenSayResult>;
