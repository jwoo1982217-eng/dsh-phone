import { parse as parseYaml } from 'yaml';
import { createHash } from 'node:crypto';
import { ConfigError } from './config.js';
import { canonicalPhonePath, phoneWorkspaceVisible } from './phone-home.js';
export const SKILLS_REF = 'DSH_PHONE_SKILLS';
export const SKILL_LIMIT = 64 * 1024;
function identifier(title) {
  const slug = title.normalize('NFKC').toLowerCase().replace(/[_\s]+/g, '-');
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 64 ? slug :
    'skill-' + createHash('sha256').update(title.normalize('NFC')).digest('hex').slice(0, 12);
}
export function parseSkill(input) {
  if (!input || typeof input !== 'object') throw new ConfigError('技能内容不正确');
  const { description, content } = input;
  let name = input.name, title = input.title;
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 160 || title.includes('\0'))) throw new ConfigError('技能显示名称最多 160 字');
  title = title?.trim();
  if (!name && title) name = identifier(title);
  else if (typeof name === 'string' && /[^\x00-\x7f]/.test(name) && /\p{L}/u.test(name) && !/[\0/\\]/.test(name) && name.length <= 160) { title ??= name; name = identifier(name); }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new ConfigError('技能开关格式不正确');
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new ConfigError('技能名称须为英文小写，例如 daily-report');
  if (typeof description !== 'string' || !description.trim() || description.length > 500) throw new ConfigError('请填写技能用途，最多 500 字');
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > SKILL_LIMIT || content.includes('\0')) throw new ConfigError('技能指令不能为空，最多 64 KB');
  return { name, ...(title ? { title } : {}), description: description.trim(), content: content.trim(), enabled: input.enabled !== false };
}
export function parseSkillMarkdown(text, filename = '') {
  if (typeof text !== 'string' || Buffer.byteLength(text) > SKILL_LIMIT) throw new ConfigError('技能文件最多 64 KB');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (typeof filename !== 'string' || filename.length > 255 || /[\0/\\]/.test(filename)) throw new ConfigError('导入文件名称不正确');
  let metadata = {};
  if (match) try { metadata = parseYaml(match[1], { maxAliasCount: 0 }) ?? {}; } catch { throw new ConfigError('技能开头信息无法读取'); }
  if (metadata?.['disable-model-invocation'] === true) throw new ConfigError('这个技能限制了自动调用；请用表单建立手动确认后的手机版技能');
  const content = match ? match[2] : text.replace(/^\uFEFF/, '');
  const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/m.exec(content)?.[1];
  const title = typeof metadata.title === 'string' ? metadata.title :
    !metadata.name || /[^\x00-\x7f]/.test(String(metadata.name)) ?
      (heading || filename.replace(/\.(?:md|txt)$/i, '') || '导入的技能文档').slice(0, 160) : undefined;
  const purpose = /^(?:>\s*)?(?:用途|适用场景|description)\s*[:：]\s*(.+)$/im.exec(content)?.[1];
  const description = metadata.description ?? purpose ?? `${title || metadata.name}：按文档中的步骤与要求完成相关任务。`;
  return parseSkill({ name: metadata.name, title, description: typeof description === 'string' ? description.slice(0, 500) : description, content });
}
export class PhoneSkills {
  constructor(store) { this.store = store; this.items = []; this.revision = 0; this.queue = Promise.resolve(); this.invalidate = () => {}; }
  mutate(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async init() {
    return this.mutate(async () => {
      const raw = await this.store.get(SKILLS_REF);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.items) || data.items.length > 50) throw new ConfigError('技能存储无法读取');
      const items = data.items.map(parseSkill);
      if (new Set(items.map(item => item.name)).size !== items.length) throw new ConfigError('技能存储包含重复名称');
      this.items = items;
      this.revision = Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
    });
  }
  async status() { await this.queue; return { items: structuredClone(this.items), revision: this.revision }; }
  update(input, revision) {
    const skill = parseSkill(input);
    return this.mutate(async () => {
      if (revision !== this.revision) throw new ConfigError('技能在其他页面更新了，请刷新后重试');
      const items = this.items.filter(item => item.name !== skill.name); items.push(skill);
      if (items.length > 50) throw new ConfigError('最多保存 50 个手机技能');
      await this.commit(items); return { items: structuredClone(this.items), revision: this.revision };
    });
  }
  toggle(name, enabled, revision) {
    return this.mutate(async () => {
      if (revision !== this.revision) throw new ConfigError('技能在其他页面更新了，请刷新后重试');
      if (typeof enabled !== 'boolean' || !this.items.some(item => item.name === name)) throw new ConfigError('技能或开关不正确');
      await this.commit(this.items.map(item => item.name === name ? { ...item, enabled } : item));
      return { items: structuredClone(this.items), revision: this.revision };
    });
  }
  async commit(items) {
    const revision = this.revision + 1;
    await this.store.set(SKILLS_REF, JSON.stringify({ items, revision }));
    this.items = items; this.revision = revision; this.invalidate();
  }
  provider(control, workspace, home) {
    this.invalidate = control.invalidate;
    const visible = cwd => home ? phoneWorkspaceVisible(cwd, home, process.env.DSH_PHONE_STORAGE) :
      typeof cwd === 'string' && (canonicalPhonePath(cwd) === canonicalPhonePath(workspace) || canonicalPhonePath(cwd).startsWith(canonicalPhonePath(workspace) + '/'));
    return { name: 'phone-robot',
      list: async options => { await this.queue; return visible(options.cwd) ? this.items.filter(item => item.enabled).map(item => ({
        name: item.name, description: item.title ? `${item.title}：${item.description}`.slice(0, 660) : item.description, source: 'phone', provider: 'phone-robot',
        rank: 300, locator: item.name, invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'opaque', description: 'Imported instruction document; companion scripts and files are not included.' },
      })) : []; },
      get: async (candidate, options) => {
        await this.queue;
        const item = visible(options.cwd) && this.items.find(item => item.enabled && item.name === candidate.locator);
        if (!item) return undefined;
        const { rank, locator, ...summary } = candidate;
        return { ...summary, content: item.content };
      },
    };
  }
}
