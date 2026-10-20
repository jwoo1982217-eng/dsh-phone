import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, readdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class PolicyError extends Error {
  constructor(message) { super(message); this.publicMessage = message; }
}
export const fail = message => { throw new PolicyError(message); };
export const digest = value => createHash('sha256').update(value).digest('hex');
export function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('此文件不是有效的 UTF-8 文本'); }
}
export function text(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008]/.test(value)) fail(`${name}无效`);
  return value.trim();
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('标识无效');
  return value;
}
export function filename(value) {
  // V1 intentionally supports flat task workspaces. No traversals or subdirectories.
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,119}$/u.test(value) || value.includes('..')) fail('文件名无效；只允许任务目录中的普通文件');
  return value;
}
export async function directory(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== path.resolve(root)) fail('目录不能包含符号链接');
  return root;
}
export async function readBounded(file, max = 131072) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) fail('只允许读取限定大小的普通文件');
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) fail('文件过大');
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    if (error.code === 'ENOENT') fail('文件不存在');
    fail('文件无法安全读取');
  } finally { await handle?.close(); }
}
export async function fileSnapshot(root, name) {
  const file = path.join(await directory(root), filename(name));
  try { return { exists: true, sha256: digest(await readBounded(file)) }; }
  catch (error) { if (error.publicMessage === '文件不存在') return { exists: false }; throw error; }
}
export async function writeApproved(root, name, content, before, signal) {
  signal?.throwIfAborted();
  await directory(root);
  if (JSON.stringify(await fileSnapshot(root, name)) !== JSON.stringify(before)) fail('文件在审批后改变，请重新提出写入请求');
  const target = path.join(root, filename(name)), temp = path.join(root, '.write-' + randomUUID());
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
    // Repeat after writing the temporary file, before the atomic publication.
    if (JSON.stringify(await fileSnapshot(root, name)) !== JSON.stringify(before)) fail('文件已改变，写入取消');
    signal?.throwIfAborted();
    await rename(temp, target);
    return { filename: name, bytes: Buffer.byteLength(content), sha256: digest(content) };
  } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
}
export async function listFiles(root) {
  await directory(root);
  const names = await readdir(root);
  if (names.length > 200) fail('任务文件过多');
  const result = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const s = await lstat(path.join(root, name));
    if (s.isFile() && !s.isSymbolicLink()) result.push({ name, bytes: s.size });
  }
  return result;
}
export function validateArguments(schema, value, depth = 0) {
  if (depth > 8 || !schema || typeof schema !== 'object') fail('工具参数定义无效');
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'description']);
  if (Object.keys(schema).some(key => !allowed.has(key))) fail('工具使用了首版不支持的参数定义');
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail('工具参数不在允许值中');
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('工具参数需要对象');
      const properties = schema.properties ?? {};
      for (const key of Object.keys(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(properties, key)) fail('包含未声明的工具参数');
        validateArguments(properties[key], value[key], depth + 1);
      }
      if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) fail('缺少工具参数');
      break;
    }
    case 'array':
      if (!Array.isArray(value) || value.length > 50) fail('数组参数无效');
      value.forEach(item => validateArguments(schema.items, item, depth + 1)); break;
    case 'string':
      if (typeof value !== 'string' || value.length > (schema.maxLength ?? 65536) || value.length < (schema.minLength ?? 0)) fail('文本参数无效'); break;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail('数字参数无效'); break;
    case 'boolean': if (typeof value !== 'boolean') fail('布尔参数无效'); break;
    default: fail('工具参数类型不受支持');
  }
}
