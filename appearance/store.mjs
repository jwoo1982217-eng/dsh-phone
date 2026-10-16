import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { catalog, findTheme, legacyIds } from './catalog.mjs';
import { defaults, preferences } from './preferences.mjs';

/** One durable choice, per-provider customizations, no mutation of plugin/account/session settings. */
export class AppearanceStore {
  constructor(home, io = {}) {
    this.file = path.join(home, 'appearance/center.json');
    this.legacy = path.join(home, 'appearance/theme.json');
    this.io = { readFile, writeFile, rename, mkdir, rm, ...io };
    this.state = { version: 1, theme: 'local:original', revision: 0, preferences: {} };
    this.queue = Promise.resolve();
  }
  async init() {
    try {
      const value = JSON.parse(await this.io.readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('外观记录无效');
      findTheme(value.theme);
      const validated = {};
      for (const [provider, settings] of Object.entries(value.preferences || {})) {
        if (!catalog.providers.some(row => row.id === provider)) throw Error('主题来源无效');
        validated[provider] = preferences(settings);
      }
      this.state = { ...value, preferences: validated };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        const old = JSON.parse(await this.io.readFile(this.legacy, 'utf8'));
        if (!legacyIds[old.skin]) throw Error('旧皮肤记录无效');
        this.state.theme = legacyIds[old.skin];
      } catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
    }
    return this.status();
  }
  status() {
    const theme = findTheme(this.state.theme);
    return { ...this.state, preferences: structuredClone(this.state.preferences), selected: theme,
      options: { ...defaults, ...this.state.preferences[theme.provider] }, providers: catalog.providers };
  }
  change(payload) {
    const job = this.queue.then(async () => {
      if (payload.revision !== this.state.revision) throw Error('外观已在另一页面更新，请刷新后再试');
      const theme = findTheme(payload.theme ?? this.state.theme);
      let choices = { ...this.state.preferences };
      if (payload.action === 'reset') choices = {};
      else if (payload.options !== undefined) choices[theme.provider] = preferences(payload.options, choices[theme.provider] || defaults);
      const next = { version: 1, theme: theme.id, preferences: choices, revision: this.state.revision + 1 };
      const temporary = this.file + '.' + randomUUID();
      await this.io.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        await this.io.writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
        await this.io.rename(temporary, this.file);
        this.state = next;
      } finally { await this.io.rm(temporary, { force: true }); }
      return this.status();
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
