import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** A separate registry: importing workflows never rewrites personas, skills or accounts. */
export class WorkflowStore {
  constructor(home, catalog) { this.file = path.join(home, 'workflow-hub/state.json'); this.catalog = catalog; this.queue = Promise.resolve(); this.state = { revision: 0, enabled: catalog.map(x => x.id) }; }
  async init() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.enabled) || value.enabled.some(id => !this.catalog.some(x => x.id === id))) throw Error('工作流记录损坏，请从备份恢复');
      this.state = { revision: value.revision, enabled: [...new Set(value.enabled)] };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.status();
  }
  status() { return structuredClone(this.state); }
  change(id, enabled, revision, apply) {
    const result = this.queue.then(async () => {
      if (typeof enabled !== 'boolean' || !this.catalog.some(x => x.id === id)) throw Error('工作流或开关无效');
      if (revision !== this.state.revision) throw Error('工作流已在另一页面更新，请刷新');
      const before = this.status(), after = { revision: before.revision + 1, enabled: enabled ? [...new Set([...before.enabled, id])] : before.enabled.filter(x => x !== id) };
      if (before.enabled.includes(id) === enabled) return before;
      const tmp = this.file + '.' + randomUUID();
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        await writeFile(tmp, JSON.stringify(after) + '\n', { mode: 0o600, flag: 'wx' });
        await apply(enabled);
        try { await rename(tmp, this.file); }
        catch (error) { await apply(!enabled); throw error; }
        this.state = after; return this.status();
      } finally { await rm(tmp, { force: true }); }
    });
    this.queue = result.catch(() => {}); return result;
  }
}
