'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function mkdir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function atomic(file, value) {
  mkdir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const writeJson = (file, value) => atomic(file, JSON.stringify(value, null, 2) + '\n');
function* walk(dir, accept, skip = new Set()) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) yield* walk(file, accept, skip);
    else if (e.isFile() && accept(e.name)) yield file;
  }
}
function lock(dir) {
  mkdir(dir);
  const file = path.join(dir, '.writer.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid; try { pid = json(file).pid; } catch { throw new Error(`索引锁不完整，请确认没有建库进程后移除 ${file}`); }
    try { process.kill(pid, 0); throw new Error(`已有建库进程 ${pid}；请等待其完成`); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    fs.unlinkSync(file); fd = fs.openSync(file, 'wx', 0o600);
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}
function parseArgs(args) {
  const opts = {}, words = [];
  const flags = new Set(['json','lexical','offline','refresh','download','force']);
  const values = new Set(['config','workspace','sessions-root','data-dir','cat','sub','kind','top','legacy','legacy-sessions','shard-size']);
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if (!a.startsWith('--')) { words.push(a); continue; }
    const key=a.slice(2);
    if (flags.has(key)) opts[key]=true;
    else if (values.has(key)) { if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`缺少参数 ${a} 的值`); opts[key]=args[++i]; }
    else throw new Error(`未知参数 ${a}`);
  }
  return { opts, words };
}
module.exports = { fs, path, hash, mkdir, atomic, json, writeJson, walk, lock, parseArgs };
