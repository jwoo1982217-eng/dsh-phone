import { ConfigError, parseConfig, publicConfig, exportConfig } from './config.js';
export const REF = 'DSH_PHONE_QQ_CONFIG';
export class QQManager {
  constructor(store, runtime) { this.store = store; this.runtime = runtime; this.record = null; this.handle = null; this.error = null; this.queue = Promise.resolve(); this.closed = false; }
  mutate(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async init() {
    return this.mutate(async () => {
      const raw = await this.store.get(REF);
      if (raw) {
        try {
          const saved = JSON.parse(raw);
          this.record = { config: parseConfig(JSON.stringify(saved.config)), enabled: saved.enabled === true,
            revision: Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0 };
        } catch { this.error = '已保存的配置无法读取，请重新导入'; }
      }
      if (this.record?.enabled) await this.launch();
    });
  }
  async persist(record) { await this.store.set(REF, JSON.stringify(record)); this.record = record; }
  async unload() { if (this.handle) { const handle = this.handle; this.handle = null; await this.runtime.stop(handle); } }
  async launch() {
    this.error = null;
    try { this.handle = await this.runtime.start(this.record.config); }
    catch { this.error = '机器人启动失败，请检查连接地址、模型登录状态或重启服务'; }
  }
  snapshot() {
    return { configured: !!this.record, enabled: this.record?.enabled === true, running: !!this.handle,
      connected: !!this.handle && this.runtime.connected(this.handle), error: this.error,
      config: publicConfig(this.record?.config), hasToken: !!this.record?.config.accessToken,
      revision: this.record?.revision ?? 0 };
  }
  async status() { await this.queue; return this.snapshot(); }
  import(text) {
    const config = parseConfig(text); // Validate before touching the previous working setup.
    return this.mutate(async () => {
      if (this.closed) throw new ConfigError('服务正在关闭');
      await this.persist({ config, enabled: false, revision: (this.record?.revision ?? 0) + 1 });
      await this.unload(); this.error = null;
      return this.snapshot();
    });
  }
  save(text, { clearToken = false, revision } = {}) {
    // Parse and bound untrusted input before entering the mutation queue.
    const parsed = parseConfig(text, this.record?.config.accessToken ?? '');
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    const hasToken = Object.hasOwn(raw.config ?? raw, 'accessToken');
    if (typeof clearToken !== 'boolean') throw new ConfigError('清除令牌选项不正确');
    return this.mutate(async () => {
      if (this.closed) throw new ConfigError('服务正在关闭');
      if (revision !== (this.record?.revision ?? 0)) throw new ConfigError('配置已在其他页面更新，请重新读取后再保存');
      const config = parseConfig(JSON.stringify({ ...parsed, accessToken: clearToken ? '' : hasToken ? parsed.accessToken : this.record?.config.accessToken ?? '' }));
      const enabled = this.record?.enabled === true;
      await this.persist({ config, enabled, revision: (this.record?.revision ?? 0) + 1 });
      await this.unload(); this.error = null;
      if (enabled) await this.launch();
      return this.snapshot();
    });
  }
  restart() { return this.mutate(async () => {
    if (this.closed) throw new ConfigError('服务正在关闭');
    if (!this.record) throw new ConfigError('请先保存机器人配置');
    await this.persist({ ...this.record, enabled: true });
    await this.unload(); await this.launch(); return this.snapshot();
  }); }
  start() { return this.mutate(async () => {
    if (this.closed) throw new ConfigError('服务正在关闭');
    if (!this.record) throw new ConfigError('请先导入你自己的 QQ 配置');
    if (this.handle) return this.snapshot();
    await this.persist({ ...this.record, enabled: true });
    await this.launch(); return this.snapshot();
  }); }
  stop() { return this.mutate(async () => {
    if (this.record) await this.persist({ ...this.record, enabled: false });
    await this.unload(); this.error = null; return this.snapshot();
  }); }
  async export() { await this.queue; if (!this.record) throw new ConfigError('还没有可导出的配置'); return exportConfig(this.record.config); }
  dispose() { this.closed = true; return this.mutate(() => this.unload()); }
}
