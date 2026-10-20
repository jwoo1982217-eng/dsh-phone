import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const skins = [{ id: 'peach', name: '小甜桃 · 桃云', description: '柔和桃粉、温暖留白，深色模式为莓紫。' }, { id: 'mint', name: '薄荷手记', description: '清爽薄荷绿，深色模式为森林绿。' }, { id: 'original', name: '原版皮肤', description: '沿用当前运行时的原始颜色。' }];
export class Appearance {
  constructor(home) { this.file = path.join(home, 'appearance/theme.json'); this.state = { skin: 'peach', revision: 0 }; this.queue = Promise.resolve(); }
  async init() { try { const value = JSON.parse(await readFile(this.file, 'utf8')); if (!skins.some(x => x.id === value.skin) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('主题记录无效'); this.state = value; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  status() { return { ...this.state, skins }; }
  change(skin, revision) {
    const result = this.queue.then(async () => {
      if (revision !== this.state.revision) throw Error('主题在另一页面更新了，请刷新');
      if (!skins.some(x => x.id === skin)) throw Error('请选择内置皮肤');
      const next = { skin, revision: revision + 1 }, tmp = this.file + '.' + randomUUID();
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try { await writeFile(tmp, JSON.stringify(next) + '\n', { mode: 0o600 }); await rename(tmp, this.file); this.state = next; }
      finally { await rm(tmp, { force: true }); }
      return this.status();
    }); this.queue = result.catch(() => {}); return result;
  }
}
