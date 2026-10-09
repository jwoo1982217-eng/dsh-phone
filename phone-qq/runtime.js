import { readFile, writeFile, mkdir, rename, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ConfigError } from './config.js';
const hash = data => createHash('sha256').update(data).digest('hex');
const catalog = JSON.parse(readFileSync(new URL('./runtime-catalog.json', import.meta.url)));
const DEFAULTS = ['bash-timeout', 'read-caps'];
export const ENHANCEMENTS = [
  { id: 'bash-timeout', patchId: 22, title: '长任务执行', description: '机器人命令最长执行 10 分钟，适合较长的代码任务。编辑器手动运行仍限 30 秒。', file: '@deepseek-ai/dsh-base/cordis.patch.yml', replacements: [["    - id: bash-sandbox\n      name: '@deepseek-ai/dsh-bash-sandbox'\n      disabled: !!js process.platform === 'win32'\n      config:\n        timeoutMs: 60000", "    - id: bash-sandbox\n      name: '@deepseek-ai/dsh-bash-sandbox'\n      disabled: !!js process.platform === 'win32'\n      config:\n        timeoutMs: 600000"]] },
  { id: 'read-caps', patchId: 23, title: '大文件阅读', description: '单次读取最多 1 MB、20,000 行，减少分析代码时的截断。', file: '@deepseek-ai/dsh-tool-fs/lib/index.js', replacements: [['const READ_MAX_LINE_LENGTH = 2e3;', 'const READ_MAX_LINE_LENGTH = 1e4;'], ['const READ_MAX_BYTES = 50 * 1024;', 'const READ_MAX_BYTES = 1024 * 1024;'], ['const READ_LIMIT = 2e3;', 'const READ_LIMIT = 2e4;']] },
  { id: 'agent-depth', patchId: 24, title: '更深的子任务', description: '子任务最大嵌套深度由 3 层变为 10 层，可能增加耗时与模型用量。', file: '@deepseek-ai/dsh-tool-subagent/lib/index.js', replacements: [['maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default(3)', 'maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default(10)']] },
];
async function atomic(file, value) { const temporary = file + '.' + randomUUID() + '.tmp'; await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, file); }
export class PhoneRuntime {
  constructor(root, home) { this.root = path.resolve(root); this.home = path.resolve(home); this.file = path.join(this.home, 'phone-runtime.json'); this.backups = path.join(this.home, '.phone-runtime-backups'); this.queue = Promise.resolve(); }
  async config() { try { const value = JSON.parse(await readFile(this.file, 'utf8')); if (!Array.isArray(value.enabled) || value.enabled.some(id => !ENHANCEMENTS.some(e => e.id === id))) throw new ConfigError('运行增强配置无法读取'); return value; } catch (e) { if (e.code === 'ENOENT') return { enabled: [...DEFAULTS], revision: 0 }; throw e; } }
  async target(feature) { const file = path.join(this.root, 'node_modules', feature.file); const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new ConfigError('运行时目标文件不正确'); return file; }
  desired(text, feature, enabled) {
    for (const [before, after] of feature.replacements) {
      const from = enabled ? before : after, to = enabled ? after : before;
      if (text.includes(from)) { if (text.split(from).length !== 2) throw new ConfigError('运行时出现多个匹配，保留原文件'); text = text.replace(from, to); }
      else if (!text.includes(to)) throw new ConfigError('这个补丁不匹配当前运行时，保留原文件');
    }
    return text;
  }
  async change(feature, enabled) {
    const file = await this.target(feature), before = await readFile(file, 'utf8'), after = this.desired(before, feature, enabled);
    if (before === after) return null;
    if (file.endsWith('.js')) {
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: after, encoding: 'utf8', timeout: 10000, env: process.env });
      if (checked.status !== 0) throw new ConfigError('补丁语法验证未通过，保留原文件');
    }
    await mkdir(this.backups, { recursive: true });
    const backup = path.join(this.backups, feature.id + '-' + hash(before) + '.txt');
    try { await writeFile(backup, before, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    // A concurrent runtime update must never be replaced by this operation.
    if (hash(await readFile(file)) !== hash(before)) throw new ConfigError('运行时刚刚被更新，请重试');
    await atomic(file, after); return { file, before, after };
  }
  async apply() {
    const config = await this.config(), report = [];
    for (const feature of ENHANCEMENTS) {
      try { const changed = await this.change(feature, config.enabled.includes(feature.id)); report.push({ id: feature.id, ok: true, changed: !!changed }); }
      catch (error) { report.push({ id: feature.id, ok: false, message: error instanceof ConfigError ? error.message : '运行时文件不可用' }); }
    }
    return report;
  }
  async status() {
    await this.queue; const config = await this.config(), features = [];
    for (const feature of ENHANCEMENTS) {
      let supported = false, installed = false;
      try { const source = await readFile(await this.target(feature), 'utf8'); this.desired(source, feature, true); supported = true; installed = feature.replacements.every(([, after]) => source.includes(after)); } catch {}
      features.push({ id: feature.id, patchId: feature.patchId, title: feature.title, description: feature.description, supported, installed, enabled: config.enabled.includes(feature.id) });
    }
    const adapted = new Map(features.map(f => [f.patchId, f]));
    const rows = catalog.map(row => {
      const feature = adapted.get(row.id);
      if (feature) return { ...row, status: feature.supported ? feature.installed ? '已写入手机运行时' : '可适配' : '不匹配当前运行时' };
      if ([20,21,25].includes(row.id)) return { ...row, status: '手机使用独立网页抓取工具；原补丁未写入' };
      if ([6,7,8,9,10,13,14,15,16,17,36].includes(row.id)) return { ...row, status: '手机通过个人／管理员私聊权限设置执行；不改写全局限制' };
      if ([31,32,39,40].includes(row.id)) return { ...row, status: '桌面插件或新版字段专用；本机未写入' };
      return { ...row, status: '原补丁未写入；指令由提示卡单独管理' };
    });
    return { features, catalog: rows, revision: config.revision, permissions: 'QQ 管理员私聊执行权限仍由机器人设置控制；群聊及其他用户不自动获得权限。' };
  }
  save(enabled, revision) {
    const result = this.queue.then(async () => {
      const current = await this.config(); if (revision !== current.revision) throw new ConfigError('运行增强在其他页面更新了，请刷新');
      if (!Array.isArray(enabled) || enabled.some(id => !ENHANCEMENTS.some(e => e.id === id))) throw new ConfigError('运行增强选项不正确');
      const previous = [];
      try {
        for (const feature of ENHANCEMENTS) { const changed = await this.change(feature, enabled.includes(feature.id)); if (changed) previous.push(changed); }
        await atomic(this.file, JSON.stringify({ enabled, revision: revision + 1 }));
      } catch (e) { for (const { file, before, after } of previous) { if (hash(await readFile(file)) === hash(after)) await atomic(file, before); } throw e; }
      return { saved: true, revision: revision + 1, restartRequired: true };
    });
    this.queue = result.catch(() => {}); return result;
  }
}
