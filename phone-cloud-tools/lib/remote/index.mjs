import { readFileSync } from 'node:fs';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { HermesRemote, RemoteError } from './client.mjs';

export async function applyHermesRemote(ctx, { home, fetcher, timeout }) {
  const ref = credentialRef('DSH_PHONE_HERMES_REMOTE_V1');
  const remote = new HermesRemote({ home, fetcher, timeout, credentials: {
    get: async () => (await ctx.credentials.resolve(ref))?.value,
    set: value => ctx.credentials.set(ref, value),
  } });
  let startupError = '';
  try { await remote.init(); } catch (error) { startupError = error instanceof RemoteError ? error.message : 'Hermes 记录无法读取，原文件已保留'; }
  ctx.connection.rpc.handle('/hermes-remote', async (method, payload) => {
    try {
      if (startupError) throw new RemoteError(startupError);
      if (method !== 'manage' || !payload || typeof payload.action !== 'string') throw new RemoteError('无效请求');
      return { ok: true, value: await remote.call(payload.action, payload) };
    } catch (error) { return { ok: false, error: { code: 'hermes-remote/failed', message: error instanceof RemoteError ? error.message : '本机保存失败，原记录已保留；请核对服务器任务状态', details: {} } }; }
  }, { authority: 'loopback' });
  for (const [route, file, type] of [['/hermes-remote', 'page.html', 'text/html'], ['/hermes-remote/page.js', 'page.js', 'text/javascript'], ['/hermes-remote/page.css', 'page.css', 'text/css']]) {
    const bytes = readFileSync(new URL('./' + file, import.meta.url));
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler: (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; object-src 'none'" }); res.end(bytes);
    } }));
  }
  return remote;
}
