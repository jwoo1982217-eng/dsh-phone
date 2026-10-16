import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { check } from './common.mjs';

export function mediaProvider(ctx) {
  for (const d of ctx.settings?.describe() || []) {
    if (d.ns !== 'llm-pi-ai') continue;
    for (const [id, config] of Object.entries(d.value?.providers || {})) {
      try {
        const url = new URL(config.baseURL);
        if (url.protocol === 'https:' && ['apihub.agnes-ai.com', 'api.agnes-ai.cn'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash)
          return { id, baseURL: url.href.replace(/\/$/, ''), apiKeyEnv: config.apiKeyEnv };
      } catch {}
    }
  }
}
export function networkError(error) {
  const code = error.cause?.code || error.code;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return '请求超时或已取消，结果可能未知；不要自动重新提交生成任务';
  return '媒体网络请求失败' + (typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code) ? '：' + code : '') + '；请检查当前设备网络、DNS和代理';
}
export class MediaApi {
  constructor(ctx, { fetchImpl = fetch } = {}) { this.ctx = ctx; this.fetch = fetchImpl; }
  async provider(id) {
    const p = mediaProvider(this.ctx);
    check(p && (!id || p.id === id), '请先在账号设置配置 Agnes API；不会使用插件作者的默认密钥');
    const secret = p.apiKeyEnv && (await this.ctx.credentials.resolve(credentialRef(p.apiKeyEnv)))?.value;
    check(secret, '当前 Agnes 接口没有可用凭据，请在账号设置检查');
    return { ...p, secret };
  }
  async request(p, pathname, body, signal, timeout = 30000) {
    const url = pathname.startsWith('/agnesapi?') ? new URL(pathname, p.baseURL) : new URL(p.baseURL + '/' + pathname);
    let r;
    try {
      r = await this.fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + p.secret, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeout)]) });
    } catch (error) { throw Error(networkError(error)); }
    if (!r.ok) {
      let raw = ''; for await (const b of r.body || []) { raw += Buffer.from(b).toString('utf8'); if (raw.length > 4096) break; }
      let detail; try { const error = JSON.parse(raw); detail = error.detail || error.error?.message || error.message; } catch {}
      const safe = typeof detail === 'string' ? detail.split(p.secret).join('[凭据]').replace(/Bearer\s+[^\s"']+|sk-[A-Za-z0-9_-]+/gi, '[凭据]').replace(/[\r\n]/g, ' ').slice(0, 240) : '';
      throw Object.assign(Error('媒体接口返回 HTTP ' + r.status + (safe ? '：' + safe : r.status === 401 || r.status === 403 ? '：当前凭据或模型权限不可用' : r.status === 429 ? '：请求限流，请稍后查询已有任务' : '；请检查模型和参数') + '；未自动重试'), { status: r.status });
    }
    const declared = Number(r.headers.get('content-length'));
    check(!declared || declared <= 64 * 1024 * 1024, '媒体响应过大');
    const chunks = []; let size = 0;
    for await (const b of r.body) { size += b.length; check(size <= 64 * 1024 * 1024, '媒体响应过大'); chunks.push(b); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('媒体接口没有返回有效 JSON'); }
    check(data && typeof data === 'object', '媒体响应无效'); return data;
  }
  async models(signal) {
    const p = await this.provider(); const data = await this.request(p, 'models', undefined, signal);
    check(Array.isArray(data.data) && data.data.length <= 1000, '媒体模型目录无效');
    return { provider: p.id, baseURL: p.baseURL, models: data.data.filter(x => typeof x.id === 'string' && /^agnes-(image|video)-/.test(x.id)).map(x => ({ id: x.id, kind: x.id.startsWith('agnes-image-') ? 'image' : 'video' })) };
  }
}
