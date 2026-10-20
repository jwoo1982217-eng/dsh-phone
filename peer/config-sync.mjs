import { createHash, randomUUID } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const cleanObject = value => JSON.parse(JSON.stringify(value));
function externalEndpoint(config) {
  if (!config.baseURL) return true;
  try { const u = new URL(config.baseURL); return ['https:', 'http:'].includes(u.protocol) && !['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(u.hostname); } catch { return false; }
}
export class ConfigSync {
  constructor(settings, credentials) { Object.assign(this, { settings, credentials }); this.previews = new Map(); this.busy = false; }
  async snapshot() {
    const routes = [], skipped = [];
    for (const d of this.settings.describe()) {
      const entries = d.ns === 'llm-pi-ai' ? Object.entries(d.value?.providers ?? {}).map(([id, config]) => ({ id, config, path: ['providers', id] }))
        : d.ns === 'llm-deepseek' ? [{ id: 'deepseek', config: d.value, path: [] }] : [];
      for (const route of entries) {
        if (!route.config || !externalEndpoint(route.config)) { skipped.push(route.id); continue; }
        const config = cleanObject(route.config);
        const secret = config.apiKeyEnv ? (await this.credentials.resolve(credentialRef(config.apiKeyEnv)))?.value : undefined;
        if (config.apiKeyEnv && !secret) { skipped.push(route.id); continue; }
        routes.push({ ns: d.ns, id: route.id, path: route.path, config, ...(secret ? { secret } : {}) });
      }
    }
    return { version: 1, routes, skipped };
  }
  preview(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.routes) || snapshot.routes.length > 256 || JSON.stringify(snapshot).length > 500000) throw Error('同步配置格式无效');
    const descriptors = new Map(this.settings.describe().map(d => [d.ns, d]));
    const ids = new Set();
    const routes = snapshot.routes.map(route => {
      if (!['llm-deepseek', 'llm-pi-ai'].includes(route.ns) || typeof route.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(route.id) || ['__proto__', 'constructor', 'prototype'].includes(route.id) || !route.config || Array.isArray(route.config) || typeof route.config !== 'object' || !externalEndpoint(route.config)) throw Error('同步接口无效');
      const identity = route.ns + ':' + route.id; if (ids.has(identity)) throw Error('重复同步接口'); ids.add(identity);
      const path = route.ns === 'llm-pi-ai' ? ['providers', route.id] : [];
      if (route.ns === 'llm-deepseek' && route.id !== 'deepseek') throw Error('无效的 DeepSeek 配置');
      const d = descriptors.get(route.ns); if (!d) throw Error('电脑缺少对应的模型配置插件');
      const current = path.length ? d.value?.providers?.[route.id] : d.value;
      // Composition/base-layer APIs can also have working credentials. A
      // same-name route is a conflict even without a user settings override.
      const hasUser = current !== undefined;
      if (route.secret !== undefined && (typeof route.secret !== 'string' || route.secret.length > 65536)) throw Error('接口凭据无效');
      return { ...cleanObject(route), path, conflict: hasUser, revision: d.revision, currentHash: digest(current) };
    });
    const token = randomUUID();
    for (const [key, value] of this.previews) if (Date.now() - value.at > 300000) this.previews.delete(key);
    if (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(token, { at: Date.now(), routes });
    return { token, routes: routes.map(r => ({ id: r.id, name: r.config.displayName || r.id, conflict: r.conflict })), skipped: snapshot.skipped ?? [] };
  }
  async commit(token, mode = 'keep') {
    if (this.busy) throw Error('同步正在进行');
    const preview = this.previews.get(token); this.previews.delete(token);
    if (!preview || Date.now() - preview.at > 300000 || !['keep', 'replace'].includes(mode)) throw Error('同步预览已过期，请重新预览');
    this.busy = true;
    const written = [], imported = [], retained = [], before = new Map();
    try {
      const descriptors = new Map(this.settings.describe().map(d => [d.ns, d]));
      for (const route of preview.routes) {
        const d = descriptors.get(route.ns), current = route.path.length ? d?.value?.providers?.[route.id] : d?.value;
        if (d?.revision !== route.revision || digest(current) !== route.currentHash) throw Error('电脑配置已变化，请重新预览');
      }
      const groups = new Map();
      for (const route of preview.routes) {
        if (route.conflict && mode === 'keep') { retained.push(route.id); continue; }
        const config = cleanObject(route.config);
        if (route.secret) {
          const ref = 'DSH_SYNC_' + randomUUID().replaceAll('-', '').toUpperCase();
          await this.credentials.set(credentialRef(ref), route.secret); written.push(ref); config.apiKeyEnv = ref;
        } else delete config.apiKeyEnv;
        if (!groups.has(route.ns)) groups.set(route.ns, []);
        groups.get(route.ns).push({ route, config });
      }
      for (const [ns, group] of groups) {
        const descriptor = descriptors.get(ns); before.set(ns, cleanObject(descriptor.user ?? {}));
        const ops = group.map(({ route, config }) => ({ op: 'set', path: route.path, value: config }));
        await this.settings.mutate(ns, ops, descriptor.revision);
        imported.push(...group.map(x => x.route.id));
      }
      return { imported, retained };
    } catch (error) {
      // Roll back only namespaces still at our committed revision. Never
      // overwrite a concurrent user change in an attempt to hide a failure.
      let rollbackFailed = false;
      for (const [ns, user] of [...before.entries()].reverse()) {
        const current = this.settings.describe().find(d => d.ns === ns), original = preview.routes.find(r => r.ns === ns)?.revision;
        if (current?.revision === original + 1) { try { await this.settings.replace(ns, user, current.revision); } catch { rollbackFailed = true; } }
        else if (current?.revision !== original) rollbackFailed = true;
      }
      if (!rollbackFailed) for (const ref of written) await this.credentials.unset(credentialRef(ref)).catch(() => {});
      throw Error(rollbackFailed ? '同步未全部完成，电脑有并发修改，请检查配置并重新预览' : error.message === '电脑配置已变化，请重新预览' ? error.message : '同步失败，已恢复电脑配置；请检查接口格式并重新预览');
    } finally { this.busy = false; }
  }
}
