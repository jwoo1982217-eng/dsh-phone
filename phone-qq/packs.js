import { mkdir, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as yaml } from 'yaml';
import { readZip } from './zip.js';
import { ConfigError } from './config.js';
import { phoneWorkspaceVisible } from './phone-home.js';
export const PACKS_REF = 'DSH_PHONE_SKILL_PACKS';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identifier = (value, fallback) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64 ? value : 'imported-' + digest(fallback).slice(0, 16);
function text(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ConfigError('技能和提示卡须为 UTF-8 文本'); } }
export function inspectPack(bytes) {
  const entries = readZip(bytes), hash = digest(bytes), skills = [], prompts = [], assets = new Map(), warnings = [];
  let root;
  for (const name of entries.keys()) {
    const match = /^(.*?)(?:materials\/)?skills\/([^/]+)\/SKILL\.md$/.exec(name);
    if (match) { root = name.slice(0, name.lastIndexOf(match[2] + '/SKILL.md')); break; }
  }
  if (!root) {
    const file = [...entries.keys()].find(n => /^(?:[^/]+\/)?SKILL\.md$/.test(n));
    if (file) root = ''; else throw new ConfigError('ZIP 中没有找到技能目录和 SKILL.md');
  }
  const candidates = [...entries.keys()].filter(n => n.startsWith(root) && /^(?:[^/]+\/)?SKILL\.md$/.test(n.slice(root.length)));
  if (candidates.length > 512) throw new ConfigError('一个 ZIP 最多 512 个技能');
  const used = new Set();
  for (const file of candidates) {
    const folder = path.posix.dirname(file), basename = folder === '.' ? 'imported-skill' : path.posix.basename(folder), source = text(entries.get(file));
    if (Buffer.byteLength(source) > 128 * 1024) throw new ConfigError('包内单个技能文档最多 128 KB');
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
    let metadata = {};
    if (match) { try { metadata = yaml(match[1], { maxAliasCount: 0 }) ?? {}; } catch { warnings.push(`${basename} 的开头信息未解析，保留为普通技能文档`); } }
    const originalName = typeof metadata.name === 'string' ? metadata.name : basename;
    let name = identifier(originalName, file);
    if (used.has(name)) { name = name.slice(0, 43).replace(/-$/, '') + '-' + digest(file).slice(0, 12); warnings.push(`${originalName} 有同名版本，另保存为 ${name}`); }
    used.add(name);
    const description = String(metadata.description || source.split('\n').find(l => l.trim() && !l.startsWith('---')) || basename).slice(0, 2000);
    const destination = `skills/${name}`;
    let count = 0;
    const prefix = folder === '.' ? '' : folder + '/';
    for (const [resource, data] of entries) if (resource.startsWith(prefix)) { assets.set(destination + '/' + resource.slice(prefix.length), data); count++; }
    // Retain the original document in attachments; a normalized body is used for loading.
    assets.set(`${destination}/PHONE-INSTRUCTIONS.md`, Buffer.from(match ? match[2].trim() : source.trim()));
    skills.push({ name, originalName, description, directory: destination, files: count, modelInvocable: metadata['disable-model-invocation'] !== true });
  }
  const outer = root.replace(/(?:materials\/)?skills\/$/, '');
  for (const [file, data] of entries) {
    const relative = file.slice(outer.length);
    if (!file.startsWith(outer) || !/^(?:prompts\/[^/]+\.md|materials\/model-routes\/[^/]+\.md|materials\/shield-protocol\.md)$/.test(relative)) continue;
    const content = text(data); if (Buffer.byteLength(content) > 32 * 1024) throw new ConfigError('单张提示卡最多 32 KB');
    const id = identifier(path.posix.basename(file, '.md').replace(/_/g, '-'), file);
    const title = path.posix.basename(file, '.md');
    assets.set(`prompts/${id}.md`, data); prompts.push({ id, title, file: `prompts/${id}.md` });
  }
  if (!skills.length) throw new ConfigError('ZIP 中没有可导入的技能');
  return { hash, id: hash.slice(0, 24), title: 'DSH 技能包', skills, prompts, assets, warnings, bytes: [...assets.values()].reduce((sum, value) => sum + value.length, 0) };
}
export class PhonePacks {
  constructor(store, root, home, { sharedStorage = process.env.DSH_PHONE_STORAGE } = {}) { this.store = store; this.root = path.resolve(root); this.home = path.resolve(home); this.sharedStorage = sharedStorage ? path.resolve(sharedStorage) : undefined; this.records = []; this.revision = 0; this.promptCache = ''; this.queue = Promise.resolve(); this.invalidate = () => {}; }
  mutate(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async ensureRoot() { await mkdir(this.root, { recursive: true }); if ((await lstat(this.root)).isSymbolicLink()) throw new ConfigError('技能库目录不能是符号链接'); this.root = await realpath(this.root); }
  init(bundled) { return this.mutate(async () => {
    await this.ensureRoot(); const raw = await this.store.get(PACKS_REF);
    if (raw) {
      const data = JSON.parse(raw);
      if (!Array.isArray(data.records) || data.records.length > 20) throw new ConfigError('技能包记录无法读取');
      for (const record of data.records) if (!/^[a-f0-9]{24}$/.test(record.id)) throw new ConfigError('技能包记录无法读取');
      this.records = data.records; this.revision = data.revision ?? 0; this.promptCache = await this.loadPromptText(this.records);
    }
    for (const file of (Array.isArray(bundled)?bundled:bundled?[bundled]:[])) {
      let bytes; try { bytes = await readFile(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (bytes) { const pack = inspectPack(bytes); if (!this.records.some(r => r.id === pack.id)) await this.install(pack); }
    }
  }); }
  visible(cwd) { return phoneWorkspaceVisible(cwd, this.home, this.sharedStorage); }
  async status() { await this.queue; return { records: structuredClone(this.records), revision: this.revision }; }
  preview(bytes) { const { assets, ...info } = inspectPack(bytes); return info; }
  import(bytes, revision) { return this.mutate(async () => { this.check(revision); await this.install(inspectPack(bytes)); return { records: structuredClone(this.records), revision: this.revision }; }); }
  check(revision) { if (revision !== this.revision) throw new ConfigError('技能包在其他页面更新了，请刷新后重试'); }
  async commit(records) { const revision = this.revision + 1, promptCache = await this.loadPromptText(records); await this.store.set(PACKS_REF, JSON.stringify({ records, revision })); this.records = records; this.revision = revision; this.promptCache = promptCache; this.invalidate(); }
  async install(pack) {
    if (this.records.some(r => r.id === pack.id)) return;
    if (this.records.length >= 20) throw new ConfigError('最多保存 20 个技能包');
    const staging = path.join(this.root, '.staging-' + randomUUID()), target = path.join(this.root, pack.id);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const [name, bytes] of pack.assets) { const file = path.join(staging, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { mode: 0o600, flag: 'wx' }); }
      // An unreferenced directory can remain after a failed credential commit.
      await rm(target, { recursive: true, force: true }); await rename(staging, target);
      const record = { id: pack.id, hash: pack.hash, title: pack.title, skills: pack.skills, prompts: pack.prompts, warnings: pack.warnings, disabled: [], activePrompts: [], enabled: true, installedAt: new Date().toISOString() };
      await this.commit([...this.records, record]);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  toggle(id, name, enabled, revision) { return this.mutate(async () => {
    this.check(revision); if (typeof enabled !== 'boolean') throw new ConfigError('技能开关不正确');
    const record = this.records.find(r => r.id === id); if (!record || (name && !record.skills.some(s => s.name === name))) throw new ConfigError('技能包或技能不存在');
    const updated = name ? { ...record, disabled: enabled ? record.disabled.filter(n => n !== name) : [...new Set([...record.disabled, name])] } : { ...record, enabled };
    await this.commit(this.records.map(r => r.id === id ? updated : r)); return { records: structuredClone(this.records), revision: this.revision };
  }); }
  async safeFile(record, relative) {
    if (typeof relative !== 'string' || !/^(?:skills\/[a-z0-9-]+\/(?:PHONE-INSTRUCTIONS|SKILL)\.md|prompts\/[a-z0-9-]+\.md)$/.test(relative)) throw new ConfigError('技能资源路径不正确');
    const file = path.join(this.root, record.id, relative), actual = await realpath(file);
    if (actual !== file || !actual.startsWith(this.root + '/')) throw new ConfigError('技能资源路径发生变化，请重新导入');
    return file;
  }
  async read(id, name, kind = 'skill') {
    await this.queue; const record = this.records.find(r => r.id === id);
    const item = kind === 'prompt' ? record?.prompts.find(p => p.id === name) : record?.skills.find(s => s.name === name);
    if (!item) throw new ConfigError('技能或提示卡不存在');
    const content = await readFile(await this.safeFile(record, kind === 'prompt' ? item.file : `${item.directory}/PHONE-INSTRUCTIONS.md`), 'utf8');
    return { ...item, content: kind === 'prompt' ? record.promptEdits?.[name] ?? content : content, enabled: kind === 'prompt' ? record.enabled && record.activePrompts.includes(name) : record.enabled && !record.disabled.includes(name) };
  }
  prompt(id, name, content, enabled, revision) { return this.mutate(async () => {
    this.check(revision); const record = this.records.find(r => r.id === id);
    if (!record?.prompts.some(p => p.id === name) || typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 32 * 1024 || typeof enabled !== 'boolean') throw new ConfigError('提示卡内容或开关不正确，最多 32 KB');
    const activePrompts = enabled ? [...new Set([...record.activePrompts, name])] : record.activePrompts.filter(n => n !== name);
    if (this.records.reduce((n, r) => n + (r.id === id ? activePrompts.length : r.activePrompts.length), 0) > 4) throw new ConfigError('最多同时启用 4 张提示卡');
    await this.commit(this.records.map(r => r.id === id ? { ...r, activePrompts, promptEdits: { ...r.promptEdits, [name]: content } } : r));
    return { records: structuredClone(this.records), revision: this.revision };
  }); }
  provider(control) { this.invalidate = control.invalidate; return { name: 'phone-packs',
    list: async options => { await this.queue; if (!this.visible(options.cwd)) return []; return this.records.filter(r => r.enabled).flatMap(r => r.skills.filter(s => !r.disabled.includes(s.name)).map(s => ({ name: s.name, description: s.description.slice(0, 600), source: 'phone-pack', provider: 'phone-packs', rank: 400, locator: { id: r.id, name: s.name }, invocation: { modelInvocable: s.modelInvocable, userInvocable: true }, resourceBase: { kind: 'directory', path: path.join(this.root, r.id, s.directory) } }))); },
    get: async (candidate, options) => { if (!this.visible(options.cwd)) return; const { id, name } = candidate.locator; const item = await this.read(id, name); if (!item.enabled) return; const { rank, locator, ...summary } = candidate; return { ...summary, content: item.content }; },
  }; }
  async loadPromptText(records) { const parts = []; for (const record of records.filter(r => r.enabled)) for (const id of record.activePrompts) { const item = record.prompts.find(p => p.id === id); if (!item) throw new ConfigError('提示卡记录无法读取'); const content = record.promptEdits?.[id] ?? await readFile(await this.safeFile(record, item.file), 'utf8'); parts.push(`提示卡：${item.title}\n${content}`); } return parts.join('\n\n'); }
  promptText() { return this.promptCache; }
}
export function installPromptCards(ctx, packs, manager, { agentCardsManaged = false } = {}) {
  const active = context => {
    const agent = context.agent, id = String(agent?.session?.id ?? '');
    if (id.startsWith('qq-')) return !!manager.handle && /^qq-(dm|group)-\d+$/.test(id);
    return !agentCardsManaged && packs.visible(agent?.cwd ?? context.cwd ?? process.env.DSH_HOME);
  };
  // Use the real prompt variable API on every assembly, preserving literal braces
  // and avoiding pre-step mutations of the session's signed history.
  ctx.systemPrompt.variable('phone_prompt_cards', context => active(context) ? packs.promptText() : '');
  ctx.systemPrompt.context({ name: 'phone:prompt-cards', order: -20, text: context => active(context) ? '{{phone_prompt_cards}}' : '' });
}
