import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { check } from './common.mjs';
import { networkError } from './media-api.mjs';

export const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function mediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF') {
    if (bytes.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (bytes.toString('ascii', 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  }
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return { ext: 'mp4', mime: 'video/mp4' };
  throw Error('服务返回的文件不是支持的图片、WAV或MP4；没有保存为成功结果');
}
function privateAddress(value) {
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd]|fe[89ab]|::ffff:)/i.test(value);
}
export async function publicMediaUrl(value) {
  const u = new URL(value);
  check(u.protocol === 'https:' && !u.username && !u.password && !u.hash && !['localhost', 'localhost.localdomain'].includes(u.hostname), '媒体下载只支持公网 HTTPS 地址');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  check(ips.length > 0 && ips.every(x => !privateAddress(x.address)), '媒体地址指向本地或私有网络'); return u;
}
export function jobDirectory(home, id) {
  check(JOB_ID.test(id), '媒体任务标识无效');
  const root = path.join(fs.realpathSync(home), 'storage/media/jobs', id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  check(fs.realpathSync(root) === path.resolve(root), '媒体目录不能含符号链接'); return root;
}
export async function downloadMedia(url, signal, { fetchImpl = fetch } = {}) {
  let u = await publicMediaUrl(url);
  try {
    for (let i = 0; i < 4; i++) {
      const r = await fetchImpl(u, { redirect: 'manual', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120000)]) });
      if ([301, 302, 303, 307, 308].includes(r.status)) { await r.body?.cancel(); u = await publicMediaUrl(new URL(r.headers.get('location'), u).href); continue; }
      check(r.ok, '媒体文件下载返回 HTTP ' + r.status);
      const max = 100 * 1024 * 1024; check(Number(r.headers.get('content-length')) <= max || !r.headers.get('content-length'), '媒体文件超过100MB');
      const chunks = []; let size = 0;
      for await (const b of r.body) { size += b.length; check(size <= max, '媒体文件超过100MB'); chunks.push(b); }
      return Buffer.concat(chunks);
    }
    throw Error('媒体下载重定向过多');
  } catch (error) { if (error.cause || /^(AbortError|TimeoutError|TypeError)$/.test(error.name)) throw Error(networkError(error)); throw error; }
}
export function writeMedia(home, id, bytes, kind) {
  const type = mediaType(bytes); check(type.mime.startsWith(kind + '/'), '返回媒体类型与任务不符');
  const dir = jobDirectory(home, id), file = path.join(dir, 'output.' + type.ext), temporary = file + '.tmp';
  try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return { file, mimeType: type.mime, bytes: bytes.length, previewUrl: '/mcp-manager/media-file?job=' + id };
}
