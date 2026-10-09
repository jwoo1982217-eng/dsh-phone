import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ConfigError } from './config.js';

const LIMIT = 512 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
export class PhoneWorkspace {
  constructor(root, shell = process.env.DSH_PHONE_SHELL ?? '/bin/bash') { this.root = path.resolve(root); this.shell = shell; this.queue = Promise.resolve(); this.running = false; }
  async ensureRoot() {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink()) throw new ConfigError('工作区不能是符号链接');
    this.root = await realpath(this.root);
  }
  async target(relative, create = false) {
    if (typeof relative !== 'string' || !relative || relative.length > 240 || /[\x00-\x1f\\]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new ConfigError('请输入工作区内的相对文件名，例如 scripts/report.mjs');
    await this.ensureRoot();
    let current = this.root;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await lstat(current); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (i < parts.length - 1 && create) { await mkdir(current); stat = await lstat(current); }
        else if (i < parts.length - 1) throw new ConfigError('文件夹不存在');
      }
      if (stat?.isSymbolicLink()) throw new ConfigError('请直接选择工作区内的文件，不能通过符号链接访问');
      if (i < parts.length - 1 && !stat?.isDirectory()) throw new ConfigError('路径中存在非文件夹项目');
      if (i === parts.length - 1 && stat && !stat.isFile()) throw new ConfigError('请选择普通文本文件');
    }
    return current;
  }
  async read(relative) {
    const file = await this.target(relative);
    let bytes;
    try { if ((await lstat(file)).size > LIMIT) throw new ConfigError('编辑器支持最多 512 KB 的文本文件'); bytes = await readFile(file); }
    catch (e) { if (e.code === 'ENOENT') return { path: relative, text: '', revision: null, exists: false }; throw e; }
    if (bytes.length > LIMIT || bytes.includes(0)) throw new ConfigError('编辑器只支持最多 512 KB 的 UTF-8 文本文件');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ConfigError('这个文件不是 UTF-8 文本'); }
    return { path: relative, text, revision: hash(bytes), exists: true };
  }
  save(relative, text, revision) {
    if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > LIMIT) throw new ConfigError('文本内容最多 512 KB');
    const task = this.queue.then(async () => {
      const file = await this.target(relative, true);
      const current = await this.read(relative);
      if (revision !== current.revision) throw new ConfigError('文件已被机器人或其他页面修改，请重新读取后合并');
      const temporary = path.join(path.dirname(file), '.dsh-edit-' + randomUUID());
      try {
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        if ((await this.read(relative)).revision !== revision) throw new ConfigError('文件刚刚发生变化，请重新读取后合并');
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      return this.read(relative);
    });
    this.queue = task.catch(() => {}); return task;
  }
  async list() {
    await this.ensureRoot();
    const files = []; let truncated = false;
    const walk = async (dir, depth) => {
      for (const item of await readdir(path.join(this.root, dir), { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.isSymbolicLink()) continue;
        if (files.length >= 200) { truncated = true; return; }
        const relative = dir ? dir + '/' + item.name : item.name;
        if (item.isDirectory()) { if (depth < 4) await walk(relative, depth + 1); else truncated = true; }
        else if (item.isFile()) files.push(relative);
      }
    };
    await walk('', 0);
    return { files: files.sort(), truncated, capabilities: { node: true, bash: !!this.shell }, running: this.running };
  }
  async run(relative, revision, mode) {
    if (this.running) throw new ConfigError('已有脚本正在运行，请等待完成');
    if (!['check', 'node', 'bash'].includes(mode)) throw new ConfigError('运行方式不正确');
    const current = await this.read(relative);
    if (!current.exists || current.revision !== revision) throw new ConfigError('先保存并确认当前文件，再运行');
    if (mode !== 'bash' && !/\.(?:js|mjs|cjs)$/.test(relative)) throw new ConfigError('请选择 .js、.mjs 或 .cjs 文件');
    if (mode === 'bash' && !/\.sh$/.test(relative)) throw new ConfigError('请选择 .sh 文件');
    const file = await this.target(relative);
    this.running = true;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(mode === 'bash' ? this.shell : process.execPath, mode === 'check' ? ['--check', file] : [file], { cwd: this.root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = []; let length = 0, reason = null, settled = false;
        const stop = why => { reason ??= why; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
        const timer = setTimeout(() => stop('timeout'), 30000);
        const collect = (stream, bytes) => { length += bytes.length; if (length <= 128 * 1024) output.push({ stream, text: bytes.toString() }); else stop('output-limit'); };
        child.stdout.on('data', b => collect('stdout', b)); child.stderr.on('data', b => collect('stderr', b));
        child.once('error', () => { settled = true; clearTimeout(timer); reject(new ConfigError('运行环境暂时无法启动，请检查服务日志')); });
        child.once('close', (code, signal) => { clearTimeout(timer); if (!settled) resolve({ code, signal, reason, output }); });
      });
    } finally { this.running = false; }
  }
}
