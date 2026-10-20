import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const MAX_BYTES = 16 * 1024 * 1024;
export const BUILTINS = new Set(['@zseven-w/dsh-noema', 'dsh-codearts-auth', 'dsh-phone-account', 'dsh-phone-qq', 'dsh-phone-control', 'dsh-phone-cloud-tools', 'dsh-peer', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
export const protectedName = name => BUILTINS.has(name) || name === '@deepseek-ai/dsh' || name?.startsWith('@deepseek-ai/dsh-');
const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
export const packageName = value => typeof value === 'string' && value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value) ? value : null;
export const version = value => typeof value === 'string' && value.length <= 100 && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value) ? value : null;
export function repositoryUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443') && /^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname) ? url.href : null; } catch { return null; }
}
export function normalizeCatalog(raw) {
  if (!raw || !Array.isArray(raw.plugins) || raw.plugins.length > 25000) throw Error('插件目录格式无效');
  const categories = Object.create(null);
  for (const [key, value] of Object.entries(raw.categories ?? {}).slice(0, 128)) categories[text(key, 80)] = text(typeof value === 'string' ? value : value?.zh ?? value?.en ?? key, 100);
  const plugins = raw.plugins.map(row => ({ name: text(row.name, 200), owner: text(row.owner, 100), url: repositoryUrl(row.url),
    description: text(row.description?.zh ?? row.description?.en ?? row.description),
    category: [...new Set((Array.isArray(row.category) ? row.category : [row.category]).filter(x => typeof x === 'string').map(x => text(x, 80)))].slice(0, 8),
    npm: packageName(row.npm), version: version(row.version), stars: Number.isFinite(row.stars) ? Math.max(0, row.stars) : 0,
    deprecated: row.deprecated === true })).filter(row => row.name && row.url);
  return { updated: text(raw.updated, 100), categories, plugins };
}

/** Catalog content never grants installation authority. Approved phone builds ship in the APK. */
export class ControlledMarket {
  constructor({ role, home, fetchImpl = fetch, now = Date.now }) {
    if (!['phone', 'computer'].includes(role)) throw Error('无效的安装目标');
    Object.assign(this, { role, home, fetchImpl, now });
    this.cacheFile = path.join(home, 'market-cache', 'catalog.json');
    this.cache = null; this.pending = null; this.lastAttempt = 0; this.refreshFailed = false;
  }
  async load(refresh) {
    if (!this.cache) try {
      const saved = await readFile(this.cacheFile, 'utf8'); if (Buffer.byteLength(saved) <= MAX_BYTES) {
        const parsed = JSON.parse(saved); this.cache = { fetchedAt: parsed.fetchedAt, catalog: normalizeCatalog(parsed.catalog) };
      }
    } catch {}
    // A slow network must not hide a directory already stored on this phone.
    // Keep one background refresh; callers can search and page the cache now.
    if (this.pending) return this.cache ? { ...this.cache, stale: true, refreshing: true } : this.pending;
    if (!refresh && this.cache && this.now() - this.cache.fetchedAt < 300000) return { ...this.cache, stale: this.refreshFailed, refreshing: false };
    if (this.lastAttempt && this.now() - this.lastAttempt < 15000) {
      if (this.cache) return { ...this.cache, stale: true, refreshing: false }; throw Error('目录正在准备，请稍后刷新');
    }
    this.lastAttempt = this.now();
    this.pending = (async () => {
      try {
        const response = await this.fetchImpl(CATALOG_URL, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
        if (!response.ok) throw Error('目录暂时无法访问');
        const chunks = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > MAX_BYTES) throw Error('目录超出大小限制'); chunks.push(chunk); }
        const catalog = normalizeCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const result = { fetchedAt: this.now(), catalog };
        await mkdir(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 });
        const tmp = this.cacheFile + '.' + randomUUID(); await writeFile(tmp, JSON.stringify(result), { mode: 0o600 }); await rename(tmp, this.cacheFile);
        this.cache = result; this.refreshFailed = false; return { ...result, stale: false, refreshing: false };
      } catch {
        this.refreshFailed = true;
        if (this.cache) return { ...this.cache, stale: true, refreshing: false };
        throw Error('插件目录加载失败，请稍后刷新或打开市场官网');
      } finally { this.pending = null; }
    })();
    return this.cache ? { ...this.cache, stale: true, refreshing: true } : this.pending;
  }
  async manage(payload) {
    // Neither a catalog badge nor a caller-supplied target/version may enable an install.
    if (payload?.action !== 'catalog') throw Error('本入口不执行未审核插件安装、更新或启用；手机请使用已验证的 APK 版本');
    const { catalog, fetchedAt, stale, refreshing } = await this.load(payload.refresh === true);
    const query = text(payload.query, 120).trim().toLowerCase(), category = text(payload.category, 80);
    const filtered = catalog.plugins.filter(row => (!query || (row.name + ' ' + row.owner + ' ' + row.description).toLowerCase().includes(query)) && (!category || row.category.includes(category)))
      .sort((a, b) => b.stars - a.stars);
    const page = Number.isInteger(payload.page) ? Math.max(0, Math.min(payload.page, 1000)) : 0;
    const rows = filtered.slice(page * 30, (page + 1) * 30).map(row => ({ ...row, canInstall: false,
      policy: protectedName(row.npm) ? '内置组件受保护 · 不覆盖为社区版' : this.role === 'phone' ? 'Android 未验证 · 可开启试装' : '电脑插件 · 安装前检查兼容性',
      command: this.role === 'computer' && row.npm && row.version && !protectedName(row.npm) ? `dsh plugin --profile web add ${row.npm}@${row.version}` : null }));
    return { role: this.role, target: this.role === 'phone' ? '手机本机' : '这台电脑', catalogUpdated: catalog.updated,
      fetchedAt, stale, refreshing, total: filtered.length, page, pageSize: 30, categories: catalog.categories, plugins: rows,
      approvedExternalVersions: 0, builtins: this.role === 'phone' ? ['Jet Hub 手机适配版', 'DeepSeek 账号', 'Noema 手机适配版', 'Agent 人设与设备连接'] : [] };
  }
}
