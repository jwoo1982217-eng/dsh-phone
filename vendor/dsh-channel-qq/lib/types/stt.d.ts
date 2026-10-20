/** Voice-bar → text (STT) pipeline, ported from the OpenClaw extension:
 * get_record (silk) → silk-wasm decode → WAV → [OI]-compatible
 * /audio/transcriptions (Whisper-style form upload) → text for the model.
 */
import type { STTConfig } from './config.js';
import type { OneBotClient } from './onebot.js';
/**
 * Fetch a voice-bar message and transcribe it.
 * @returns `[文字, 时长秒]`, or null when STT is disabled/unavailable.
 */
export declare function transcribeVoiceMessage(client: OneBotClient, config: STTConfig, messageId: number, log: (line: string) => void): Promise<[string, number] | null>;
