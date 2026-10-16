import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { check } from './common.mjs';
import { jobDirectory, writeMedia } from './media-files.mjs';

const run = promisify(execFile);
export function speechCapability() {
  return { id: 'system-tts', kind: 'audio', configured: process.platform === 'darwin' || process.env.DSH_PHONE_ANDROID === '1', description: '系统语音合成；生成朗读WAV，不提供音乐或声音克隆' };
}
export async function beginSpeech(home, job, args, signal) {
  if (process.env.DSH_PHONE_ANDROID === '1') {
    const { NativeControlBridge } = await import('dsh-phone-control/bridge');
    await new NativeControlBridge().call('media_speech', { jobId: job.id, text: args.text, language: args.language || 'zh-CN', ...(args.voice ? { voice: args.voice } : {}) }, signal);
    return { nativeSpeech: true };
  }
  check(process.platform === 'darwin', '此设备尚未提供系统语音合成引擎');
  const dir = jobDirectory(home, job.id), target = path.join(dir, 'speech.wav');
  const voice = args.voice || ((args.language || 'zh-CN').startsWith('zh') ? 'Tingting' : 'Samantha');
  await run('/usr/bin/say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', target, '--', args.text], { timeout: 120000, signal, maxBuffer: 4096 });
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return writeMedia(home, job.id, fs.readFileSync(fd), 'audio'); } finally { fs.closeSync(fd); fs.rmSync(target, { force: true }); }
}
export async function speechResult(home, job, signal) {
  const { NativeControlBridge } = await import('dsh-phone-control/bridge');
  const result = await new NativeControlBridge().call('media_speech_result', { jobId: job.id }, signal);
  if (result.status !== 'completed') return result;
  const file = path.join(jobDirectory(home, job.id), 'speech.wav');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return { status: 'completed', ...writeMedia(home, job.id, fs.readFileSync(fd), 'audio') }; } finally { fs.closeSync(fd); }
}
