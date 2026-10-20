// Bounded ZIP reader. Archive data never becomes executable installer code.
import { inflateRawSync } from 'node:zlib';
import { ConfigError } from './config.js';
const MAX_ZIP = 24 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export function crc32(bytes) { let n = 0xffffffff; for (const b of bytes) n = table[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
export function readZip(input) {
  const bytes = Buffer.from(input);
  const fail = () => { throw new ConfigError('ZIP 无法读取：文件损坏、加密或格式不支持'); };
  if (bytes.length < 22 || bytes.length > MAX_ZIP) throw new ConfigError('技能 ZIP 最多 24 MB');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 4096 || count !== bytes.readUInt16LE(end + 8) || start + size !== end) fail();
  let cursor = start, total = 0;
  const files = new Map(); const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nl = bytes.readUInt16LE(cursor + 28), el = bytes.readUInt16LE(cursor + 30), cl = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42), mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if (cursor + 46 + nl + el + cl > end || flags & 1 || ![0, 8].includes(method) || expanded > 4 * 1024 * 1024 || (total += expanded) > MAX_TOTAL) fail();
    const raw = bytes.subarray(cursor + 46, cursor + 46 + nl);
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail(); }
    if (!name || name.length > 500 || /[\x00-\x1f\\:]/.test(name) || name.startsWith('/') || name.replace(/\/$/, '').split('/').some(p => !p || p === '..' || p === '.') || names.has(name) || ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000))) throw new ConfigError('ZIP 包含重复路径、符号链接或不安全文件名');
    names.add(name); cursor += 46 + nl + el + cl;
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail();
    const lnl = bytes.readUInt16LE(offset + 26), lel = bytes.readUInt16LE(offset + 28);
    const body = offset + 30 + lnl + lel;
    if (body + compressed > start || !bytes.subarray(offset + 30, offset + 30 + lnl).equals(raw)) fail();
    if (name.endsWith('/')) { if (expanded) fail(); continue; }
    let content;
    try { content = method === 0 ? bytes.subarray(body, body + compressed) : inflateRawSync(bytes.subarray(body, body + compressed), { maxOutputLength: Math.max(1, expanded) }); } catch { fail(); }
    if (content.length !== expanded || crc32(content) !== crc) fail();
    files.set(name, content);
  }
  if (cursor !== end) fail();
  return files;
}
