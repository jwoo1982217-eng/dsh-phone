import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { decode, encode, isSilk } from "silk-wasm";

/** Minimal local replacements for the old platform.ts helpers. */
function isWindows(): boolean {
  return process.platform === 'win32'
}

function detectFfmpeg(): string | null {
  const candidates = process.platform === 'win32'
    ? ['ffmpeg', 'C:\ffmpeg\bin\ffmpeg.exe']
    : ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']
  return candidates[0] ?? null
}


export function isSilkFile(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    return isSilk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return false;
  }
}

function pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);
  const strippedBuf = stripAmrHeader(fileBuf);
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  if (!isSilk(rawData)) {
    return null;
  }

  const sampleRate = 24000;
  const result = await decode(rawData, sampleRate);
  const wavBuffer = pcmToWav(result.data, sampleRate);

  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}

export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) {
    return true;
  }
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".amr", ".silk", ".slk", ".slac"].includes(ext);
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}分${remainSeconds}秒` : `${minutes}分钟`;
}

export function isAudioFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".silk", ".slk", ".amr", ".wav", ".mp3", ".ogg", ".opus", ".aac", ".flac", ".m4a", ".wma", ".pcm"].includes(ext);
}

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  authStyle?: "bearer" | "api-key";
  queryParams?: Record<string, string>;
  speed?: number;
}

function resolveTTSFromBlock(
  block: Record<string, any>,
  providerCfg: Record<string, any> | undefined,
): TTSConfig | null {
  const baseUrl: string | undefined = block?.baseUrl || providerCfg?.baseUrl;
  const apiKey: string | undefined = block?.apiKey || providerCfg?.apiKey;
  const model: string = block?.model || "tts-1";
  const voice: string = block?.voice || "alloy";
  if (!baseUrl || !apiKey) return null;

  const authStyle = (block?.authStyle || providerCfg?.authStyle) === "api-key" ? "api-key" as const : "bearer" as const;
  const queryParams: Record<string, string> = { ...(providerCfg?.queryParams ?? {}), ...(block?.queryParams ?? {}) };
  const speed: number | undefined = block?.speed;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    voice,
    authStyle,
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null {
  const c = cfg as any;

  const channelTts = c?.channels?.qq?.tts;
  if (channelTts && channelTts.enabled !== false) {
    const providerId: string = channelTts?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const result = resolveTTSFromBlock(channelTts, providerCfg);
    if (result) return result;
  }

  const msgTts = c?.messages?.tts;
  if (msgTts && msgTts.auto !== "disabled") {
    const providerId: string = msgTts?.provider || "openai";
    const providerBlock = msgTts?.[providerId];
    const providerCfg = c?.models?.providers?.[providerId];
    const result = resolveTTSFromBlock(providerBlock ?? {}, providerCfg);
    if (result) return result;
  }

  return null;
}

function buildTTSRequest(ttsCfg: TTSConfig): { url: string; headers: Record<string, string> } {
  let url = `${ttsCfg.baseUrl}/audio/speech`;
  if (ttsCfg.queryParams && Object.keys(ttsCfg.queryParams).length > 0) {
    const qs = new URLSearchParams(ttsCfg.queryParams).toString();
    url += `?${qs}`;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ttsCfg.authStyle === "api-key") {
    headers["api-key"] = ttsCfg.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${ttsCfg.apiKey}`;
  }

  return { url, headers };
}

export async function textToSpeechPCM(
  text: string,
  ttsCfg: TTSConfig,
): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  const sampleRate = 24000;
  const { url, headers } = buildTTSRequest(ttsCfg);

  console.log(`[tts] Request: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, url=${url}`);

  const formats: Array<{ format: string; needsDecode: boolean }> = [
    { format: "pcm", needsDecode: false },
    { format: "mp3", needsDecode: true },
  ];

  let lastError: Error | null = null;
  const startTime = Date.now();

  for (const { format, needsDecode } of formats) {
    const controller = new AbortController();
    const ttsTimeout = setTimeout(() => controller.abort(), 120000);

    try {
      const body: Record<string, unknown> = {
        model: ttsCfg.model,
        input: text,
        voice: ttsCfg.voice,
        response_format: format,
        ...(format === "pcm" ? { sample_rate: sampleRate } : {}),
        ...(ttsCfg.speed !== undefined ? { speed: ttsCfg.speed } : {}),
      };

      console.log(`[tts] Trying format=${format}...`);
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(ttsTimeout));

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        if (format === "pcm" && (resp.status === 400 || resp.status === 422)) {
          lastError = new Error(`TTS PCM not supported: ${detail.slice(0, 200)}`);
          continue;
        }
        throw new Error(`TTS failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      const rawBuffer = Buffer.from(arrayBuffer);

      if (!needsDecode) {
        return { pcmBuffer: rawBuffer, sampleRate };
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-"));
      const tmpMp3 = path.join(tmpDir, "tts.mp3");
      fs.writeFileSync(tmpMp3, rawBuffer);

      try {
        const ffmpegCmd = await checkFfmpeg();
        if (ffmpegCmd) {
          const pcmBuf = await ffmpegToPCM(ffmpegCmd, tmpMp3, sampleRate);
          console.log(`[tts] Done: mp3→PCM (ffmpeg), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`);
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        const pcmBuf = await wasmDecodeMp3ToPCM(rawBuffer, sampleRate);
        if (pcmBuf) {
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        throw new Error("No decoder available for mp3 (install ffmpeg for best compatibility)");
      } finally {
        try { fs.unlinkSync(tmpMp3); fs.rmdirSync(tmpDir); } catch {}
      }
    } catch (err) {
      clearTimeout(ttsTimeout);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (format === "pcm") continue;
      throw lastError;
    }
  }

  throw lastError ?? new Error("TTS failed: all formats exhausted");
}

export async function pcmToSilk(
  pcmBuffer: Buffer,
  sampleRate: number,
): Promise<{ silkBuffer: Buffer; duration: number }> {
  const pcmData = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const result = await encode(pcmData, sampleRate);
  return {
    silkBuffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    duration: result.duration,
  };
}

export async function textToSilk(
  text: string,
  ttsCfg: TTSConfig,
  outputDir: string,
): Promise<{ silkPath: string; silkBase64: string; duration: number }> {
  const { pcmBuffer, sampleRate } = await textToSpeechPCM(text, ttsCfg);
  const { silkBuffer, duration } = await pcmToSilk(pcmBuffer, sampleRate);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const silkPath = path.join(outputDir, `tts-${Date.now()}.silk`);
  fs.writeFileSync(silkPath, silkBuffer);

  return { silkPath, silkBase64: silkBuffer.toString("base64"), duration };
}

const QQ_NATIVE_UPLOAD_FORMATS = [".wav", ".mp3", ".silk"];

export async function audioFileToSilkBase64(filePath: string, directUploadFormats?: string[]): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    console.error(`[audio-convert] file is empty: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();

  const uploadFormats = directUploadFormats ? normalizeFormats(directUploadFormats) : QQ_NATIVE_UPLOAD_FORMATS;
  if (uploadFormats.includes(ext)) {
    return buf.toString("base64");
  }

  if ([".slk", ".slac"].includes(ext)) {
    const stripped = stripAmrHeader(buf);
    const raw = new Uint8Array(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    if (isSilk(raw)) {
      return buf.toString("base64");
    }
  }

  const rawCheck = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const strippedCheck = stripAmrHeader(buf);
  const strippedRaw = new Uint8Array(strippedCheck.buffer, strippedCheck.byteOffset, strippedCheck.byteLength);
  if (isSilk(rawCheck) || isSilk(strippedRaw)) {
    return buf.toString("base64");
  }

  const targetRate = 24000;

  const ffmpegCmd = await checkFfmpeg();
  if (ffmpegCmd) {
    try {
      const pcmBuf = await ffmpegToPCM(ffmpegCmd, filePath, targetRate);
      if (pcmBuf.length === 0) return null;
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      return silkBuffer.toString("base64");
    } catch (err) {
      console.error(`[audio-convert] ffmpeg conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (ext === ".pcm") {
    const pcmBuf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
    return silkBuffer.toString("base64");
  }

  if (ext === ".wav" || (buf.length >= 4 && buf.toString("ascii", 0, 4) === "RIFF")) {
    const wavInfo = parseWavFallback(buf);
    if (wavInfo) {
      const { silkBuffer } = await pcmToSilk(wavInfo, targetRate);
      return silkBuffer.toString("base64");
    }
  }

  if (ext === ".mp3" || ext === ".mpeg") {
    const pcmBuf = await wasmDecodeMp3ToPCM(buf, targetRate);
    if (pcmBuf) {
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      return silkBuffer.toString("base64");
    }
  }

  console.error(`[audio-convert] unsupported format: ${ext} (no ffmpeg available)`);
  return null;
}

export async function waitForFile(filePath: string, timeoutMs: number = 120000, pollMs: number = 500): Promise<number> {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        if (stat.size === lastSize) {
          stableCount++;
          if (stableCount >= 2) return stat.size;
        } else {
          stableCount = 0;
        }
        lastSize = stat.size;
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  try {
    const finalStat = fs.statSync(filePath);
    if (finalStat.size > 0) return finalStat.size;
  } catch {}
  return 0;
}

async function checkFfmpeg(): Promise<string | null> {
  return detectFfmpeg();
}

function ffmpegToPCM(ffmpegCmd: string, inputPath: string, sampleRate: number = 24000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-acodec", "pcm_s16le",
      "-v", "error",
      "pipe:1",
    ];
    execFile(ffmpegCmd, args, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: "buffer",
      ...(isWindows() ? { windowsHide: true } : {}),
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${err.message}`));
        return;
      }
      resolve(stdout as unknown as Buffer);
    });
  });
}

async function wasmDecodeMp3ToPCM(buf: Buffer, targetRate: number): Promise<Buffer | null> {
  console.warn(`[audio-convert] WASM MP3 decode not available: mpg123-decoder package not installed. Please install ffmpeg for MP3 support.`);
  return null;
}

function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = f.toLowerCase().trim();
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
}

function parseWavFallback(buf: Buffer): Buffer | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  if (buf.toString("ascii", 12, 16) !== "fmt ") return null;

  const audioFormat = buf.readUInt16LE(20);
  if (audioFormat !== 1) return null;

  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) return null;

  let offset = 36;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buf.length);
      let pcm = new Uint8Array(buf.buffer, buf.byteOffset + dataStart, dataEnd - dataStart);

      if (channels > 1) {
        const samplesPerCh = pcm.length / (2 * channels);
        const mono = new Uint8Array(samplesPerCh * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
        for (let i = 0; i < samplesPerCh; i++) {
          let sum = 0;
          for (let ch = 0; ch < channels; ch++) sum += inV.getInt16((i * channels + ch) * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
        }
        pcm = mono;
      }

      const targetRate = 24000;
      if (sampleRate !== targetRate) {
        const inSamples = pcm.length / 2;
        const outSamples = Math.round(inSamples * targetRate / sampleRate);
        const out = new Uint8Array(outSamples * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(out.buffer, out.byteOffset, out.byteLength);
        for (let i = 0; i < outSamples; i++) {
          const src = i * sampleRate / targetRate;
          const i0 = Math.floor(src);
          const i1 = Math.min(i0 + 1, inSamples - 1);
          const f = src - i0;
          const s0 = inV.getInt16(i0 * 2, true);
          const s1 = inV.getInt16(i1 * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))), true);
        }
        pcm = out;
      }

      return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    offset += 8 + chunkSize;
  }

  return null;
}
