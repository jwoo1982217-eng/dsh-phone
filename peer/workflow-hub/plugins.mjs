import { packageName, version, protectedName } from '../controlled-market/catalog.mjs';
import { boundedResponse, checkManifest } from '../controlled-market/trials.mjs';
import { randomUUID } from 'node:crypto';

/** Use the current SDK's transactional manager, never replace the runtime with Studio's SDK. */
export class PluginCenter {
  constructor(ctx, role, home, { fetchImpl = fetch } = {}) { Object.assign(this, { ctx, role, home, fetchImpl }); this.pending = false; this.tickets = new Map(); }
  manager() { const value = this.ctx.get('pluginManager'); if (!value) throw Error('当前 Profile 未提供插件管理服务'); return value; }
  guard(name) { if (!packageName(name) || protectedName(name) || ['dsh-phone-control', 'dsh-desktop-chatgpt'].includes(name)) throw Error('内置账号、互联和核心组件受保护'); }
  async manage(payload = {}) {
    const manager = this.manager();
    if (payload.action === 'status') return { role: this.role, bundles: await manager.listBundles(), plugins: await manager.listPlugins(), busy: this.pending };
    if (this.pending) throw Error('已有插件操作进行中，请等待完成');
    this.guard(payload.name);
    if (payload.action === 'inspect') {
      if (this.role !== 'computer') throw Error('手机安装与更新请在插件市场使用原生备份试装');
      if (!version(payload.version)) throw Error('请输入固定版本号');
      const response = await this.fetchImpl('https://registry.npmjs.org/' + encodeURIComponent(payload.name) + '/' + payload.version, { redirect: 'error', signal: AbortSignal.timeout(20000) });
      const manifest = JSON.parse((await boundedResponse(response, 2 * 1024 * 1024)).toString());
      if (manifest.name !== payload.name || manifest.version !== payload.version) throw Error('来源返回的包名或版本不一致');
      checkManifest(manifest, undefined, { os: process.platform, cpu: process.arch });
      const spec = payload.name + '@' + payload.version, inspection = await manager.inspect(spec);
      if (inspection.status !== 'accepted' && inspection.problem !== 'already-installed') throw Error(inspection.reason || '插件未通过检查');
      const ticket = randomUUID(); this.tickets.set(ticket, { spec, name: payload.name, createdAt: Date.now() });
      for (const [key, value] of this.tickets) if (Date.now() - value.createdAt > 600000) this.tickets.delete(key);
      return { ticket, name: payload.name, version: payload.version, description: String(manifest.description ?? ''), overrides: manifest.dsh?.bundle?.patch, inspection };
    }
    // Package operations settle independently of this RPC. The SDK snapshots manifests and locks.
    if (this.ctx.get('agents')?.list().some(agent => agent.status === 'running')) throw Error('有对话正在执行，请结束后再管理插件');
    this.pending = true;
    try {
      let result;
      if (payload.action === 'install') {
        const plan = this.tickets.get(payload.ticket); this.tickets.delete(payload.ticket);
        if (this.role !== 'computer' || !plan || plan.name !== payload.name || Date.now() - plan.createdAt > 600000) throw Error('安装确认已过期，请重新检查');
        result = await manager.installBundle(plan.spec, { enabled: true });
      } else {
        const bundle = (await manager.listBundles()).find(x => x.name === payload.name);
        if (!bundle || bundle.readOnlyReason) throw Error('插件不存在或属于管理必需组件');
        if (payload.action === 'toggle' && typeof payload.enabled === 'boolean') result = await manager.setBundleEnabled(payload.name, payload.enabled);
        else if (payload.action === 'remove' && bundle.removable) result = await manager.removeBundle(payload.name);
        else throw Error('这个操作不可用');
      }
      return result;
    } finally { this.pending = false; }
  }
}
