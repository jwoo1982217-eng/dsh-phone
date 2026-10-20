import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { NativeControlBridge } from 'dsh-phone-control/bridge';
import { PhoneToolHub } from './hub.mjs';
import { ToolTunnel } from './tunnel.mjs';
import { newPair, validatePair, connectionLink } from './protocol.mjs';
import { PolicyError, fail } from './policy.mjs';
import { applyHermesRemote } from './remote/index.mjs';

export async function applyPhoneCloudTools(ctx, { home, getSkills, android = process.env.DSH_PHONE_ANDROID === '1', bridge = new NativeControlBridge() }) {
  if (!android) return;
  await applyHermesRemote(ctx, { home });
  const hub = new PhoneToolHub({ home, bridge, getSkills }), ref = credentialRef('DSH_PHONE_CLOUD_TOOLS_V1');
  let pair = null, tunnel = null, disposed = false, configError = '', queue = Promise.resolve();
  const disconnect = () => { hub.disconnect(); tunnel?.stop(); tunnel = null; };
  const connect = () => {
    disconnect(); if (!pair || !hub.config.enabled || disposed) return;
    tunnel = new ToolTunnel(pair, 'phone');
    tunnel.handler = (name, args) => { if (!hub.online) fail('AI 连接已断开，旧请求不再执行'); return hub.call(name, args); };
    tunnel.on('online', () => { hub.online = true; hub.log('connection', 'online'); });
    tunnel.on('offline', () => { hub.disconnect(); hub.log('connection', 'offline'); });
    tunnel.start();
  };
  try {
    const raw = (await ctx.credentials.resolve(ref))?.value;
    if (raw) {
      const saved = JSON.parse(raw);
      pair = saved.pair ? validatePair(saved.pair) : null;
      hub.config = { enabled: saved.enabled === true, skillIds: Array.isArray(saved.skillIds) ? saved.skillIds.filter(x => typeof x === 'string').slice(0, 100) : [], toolIds: Array.isArray(saved.toolIds) ? saved.toolIds.filter(x => typeof x === 'string').slice(0, 50) : [] };
    }
  } catch { configError = '配置无法读取；手机工具箱保持关闭，请重新配对'; pair = null; hub.config.enabled = false; }
  const sample = path.join(home, 'cloud-tool-hub/tools/note-normalize');
  await mkdir(sample, { recursive: true, mode: 0o700 });
  for (const file of ['tool.json', 'tool.mjs']) await writeFile(path.join(sample, file), readFileSync(new URL('../sample-tools/note-normalize/' + file, import.meta.url)), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  connect();
  const timer = setInterval(() => hub.expire(), 1000); timer.unref();
  ctx.effect(() => () => { disposed = true; clearInterval(timer); disconnect(); });
  const status = async () => ({ ...await hub.localStatus(), paired: !!pair, relay: pair?.relay ?? '', error: configError });
  const persist = config => ctx.credentials.set(ref, JSON.stringify(config));
  const manage = async payload => {
    switch (payload.action) {
      case 'status': return status();
      case 'pair': {
        const next = newPair(payload.relay);
        await persist({ ...hub.config, enabled: false, pair: next });
        disconnect(); pair = next; hub.config.enabled = false; configError = ''; hub.log('pair', 'created'); break;
      }
      case 'export': if (!pair) fail('请先建立配对'); return { link: connectionLink(pair) };
      case 'configure': {
        if (typeof payload.enabled !== 'boolean' || !Array.isArray(payload.skillIds) || !Array.isArray(payload.toolIds)) fail('配置格式无效');
        if (payload.enabled && !pair) fail('请先建立配对');
        const available = await hub.localStatus();
        if (payload.skillIds.length > 100 || payload.toolIds.length > 50 || payload.skillIds.some(id => !available.skills.some(s => s.id === id)) || payload.toolIds.some(id => !available.tools.some(t => t.id === id))) fail('选择的技能或工具已不可用，请刷新');
        const next = { enabled: payload.enabled, skillIds: [...new Set(payload.skillIds)], toolIds: [...new Set(payload.toolIds)] };
        await persist({ ...next, pair }); disconnect(); hub.config = next; connect(); break;
      }
      case 'revoke': await persist({ enabled: false, pair: null, skillIds: [], toolIds: [] }); disconnect(); pair = null; hub.config = { enabled: false, skillIds: [], toolIds: [] }; hub.log('pair', 'revoked'); break;
      case 'task.approve': await hub.approveTask(payload.id, payload.allow === true); break;
      case 'tool.import': await hub.registry.install(payload.bundle); hub.log('import', 'done'); break;
      case 'task.stop': hub.stopTask(hub.task(payload.id, false)); break;
      case 'operation.approve': hub.approveOperation(payload.id, payload.allow === true); break;
      default: fail('无效的本地操作');
    }
    return status();
  };
  ctx.connection.rpc.handle('/phone-tools', async (method, payload) => {
    try {
      if (method !== 'manage' || !payload) fail('无效请求');
      const operation = queue.then(() => manage(payload)); queue = operation.catch(() => {});
      return { ok: true, value: await operation };
    } catch (error) { return { ok: false, error: { code: 'phone-tools/failed', message: error instanceof PolicyError ? error.message : '手机工具箱设置未完成，请检查地址和服务后重试', details: {} } }; }
  }, { authority: 'loopback' });
  for (const [route, file, type] of [['/phone-tools', 'page.html', 'text/html'], ['/phone-tools/page.js', 'page.js', 'text/javascript'], ['/phone-tools/page.css', 'page.css', 'text/css']]) {
    const bytes = readFileSync(new URL('./' + file, import.meta.url));
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler: (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; object-src 'none'" });
      res.end(bytes);
    } }));
  }
  return hub;
}
