import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';
import { packageName, version, protectedName, repositoryUrl } from './catalog.mjs';

export async function boundedResponse(response, limit) {
  if (!response.ok) throw Error('插件来源暂时无法访问（HTTP ' + response.status + '）');
  const parts = []; let count = 0;
  for await (const chunk of response.body) { count += chunk.length; if (count > limit) throw Error('插件下载超过大小限制'); parts.push(chunk); }
  return Buffer.concat(parts);
}
export function checkManifest(manifest, hostVersion = getDshRuntimeVersion(), platform = { os: 'android', cpu: 'arm64' }) {
  if (!packageName(manifest?.name) || !version(manifest?.version)) throw Error('插件没有有效的包名和固定版本');
  if (protectedName(manifest.name)) throw Error('这个包属于手机核心适配组件，不能覆盖安装');
  for (const [field, current] of [['os', platform.os], ['cpu', platform.cpu]]) {
    const values = manifest[field]; if (!values) continue;
    if (!Array.isArray(values) || !values.every(x => typeof x === 'string')) throw Error('插件平台声明无效');
    const positive = values.filter(x => !x.startsWith('!'));
    if (values.includes('!' + current) || (positive.length && !positive.includes('any') && !positive.includes(current))) throw Error('插件明确不支持 ' + (platform.os === 'android' ? 'Android' : platform.os) + ' ' + platform.cpu);
  }
  const peers = { ...manifest.dependencies, ...manifest.peerDependencies };
  if (manifest.engines?.dsh) peers['@deepseek-ai/dsh'] = manifest.engines.dsh;
  const conflict = evaluatePluginCompatibility({ ...manifest, peerDependencies: peers }, {}, hostVersion);
  if (conflict) throw Error('插件要求的 DSH 版本不匹配：' + JSON.stringify(conflict.peers) + '；手机为 ' + hostVersion);
  const patch = manifest.dsh?.bundle?.patch;
  const files = typeof patch === 'string' ? [patch] : patch;
  if (!Array.isArray(files) || !files.length || files.length > 32 || files.some(x => typeof x !== 'string' || !x || x.length > 1024 || x.startsWith('/') || x.includes('\\') || x.split('/').some(y => y === '..' || !y))) throw Error('来源没有有效的 DSH 插件入口');
  return files;
}
export function artifactUrl(value, source) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw Error('插件下载地址无效');
  if (source === 'npm' && url.hostname === 'registry.npmjs.org' && url.pathname.endsWith('.tgz')) return url.href;
  if (source === 'github' && url.hostname === 'codeload.github.com' && /^\/[\w.-]+\/[\w.-]+\/tar\.gz\/[a-f0-9]{40}$/.test(url.pathname)) return url.href;
  throw Error('插件下载地址无效');
}
export class TrialPlans {
  constructor(market, { fetchImpl = fetch, now = Date.now } = {}) {
    this.market = market; this.fetchImpl = fetchImpl; this.now = now; this.tickets = new Map();
    this.flag = path.join(market.home, 'market-cache', 'trial.json');
  }
  async enabled() { try { return JSON.parse(await readFile(this.flag, 'utf8')).enabled === true; } catch { return false; } }
  async json(url) {
    try { return JSON.parse((await boundedResponse(await this.fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } }), 2 * 1024 * 1024)).toString()); }
    catch (error) { throw Error('插件信息读取失败：' + error.message); }
  }
  async manage(payload) {
    if (this.market.role !== 'phone') throw Error('试装只管理手机本机，不能安装到电脑');
    if (payload.action === 'trial-allow') {
      if (typeof payload.enabled !== 'boolean') throw Error('试装开关无效');
      await mkdir(path.dirname(this.flag), { recursive: true, mode: 0o700 });
      const tmp = this.flag + '.' + randomUUID(); await writeFile(tmp, JSON.stringify({ enabled: payload.enabled }), { mode: 0o600 }); await rename(tmp, this.flag);
      if (!payload.enabled) this.tickets.clear();
      return { trialEnabled: payload.enabled };
    }
    if (!await this.enabled()) throw Error('请先主动开启「允许试装」');
    for (const [id, ticket] of this.tickets) if (this.now() - ticket.createdAt > 600000) this.tickets.delete(id);
    if (payload.action === 'trial-cancel') { this.tickets.delete(payload.ticket); return { cancelled: true }; }
    if (payload.action === 'trial-view') {
      const plan = this.tickets.get(payload.ticket); if (!plan) throw Error('试装确认已过期，请重新选择插件'); return plan;
    }
    if (payload.action === 'trial-claim') {
      const plan = this.tickets.get(payload.ticket); this.tickets.delete(payload.ticket);
      if (!plan) throw Error('试装确认已过期，请重新选择插件');
      return plan;
    }
    if (payload.action !== 'trial-prepare') throw Error('无效的试装操作');
    const { catalog } = await this.market.load(false);
    const row = catalog.plugins.find(x => x.url === payload.url && x.name === payload.name);
    if (!row || protectedName(row.npm)) throw Error('插件不在当前目录，或属于受保护的内置组件');
    const repository = repositoryUrl(row.url); let manifest, source, download, integrity, commit;
    if (row.npm && row.version) {
      source = 'npm'; manifest = await this.json('https://registry.npmjs.org/' + encodeURIComponent(row.npm) + '/' + row.version);
      if (manifest.name !== row.npm || manifest.version !== row.version) throw Error('来源返回的插件版本不一致');
      download = artifactUrl(manifest.dist?.tarball, source); integrity = manifest.dist?.integrity;
      if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw Error('插件来源没有有效的完整性校验');
    } else {
      source = 'github'; const repo = new URL(repository).pathname.replace(/^\//, '').replace(/\/$/, '');
      const tip = await this.json('https://api.github.com/repos/' + repo + '/commits/HEAD'); commit = tip.sha;
      if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('无法固定仓库提交版本');
      manifest = await this.json('https://raw.githubusercontent.com/' + repo + '/' + commit + '/package.json');
      download = artifactUrl('https://codeload.github.com/' + repo + '/tar.gz/' + commit, source);
    }
    checkManifest(manifest);
    const plan = { source, name: manifest.name, version: manifest.version, download, integrity: integrity ?? null, commit: commit ?? null,
      repository, hostVersion: getDshRuntimeVersion(), createdAt: this.now() };
    if (this.tickets.size >= 16) throw Error('待确认试装过多，请先完成或关闭试装');
    const ticket = randomBytes(32).toString('hex'); this.tickets.set(ticket, plan);
    return { ...plan, ticket };
  }
}
