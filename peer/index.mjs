import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import Schema from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, resolveAdapterOptions } from './vendor/adapter.js';
import { PeerTunnel } from './tunnel.mjs';
import { createPeerProxy } from './proxy.mjs';
import { loadReusableUiScripts } from './ui-reuse.mjs';
import { browserSessionHeaders } from './browser-session.mjs';
import { newPair, pairCode, connectionLink, parsePair, validatePair } from './protocol.mjs';
import { ConfigSync } from './config-sync.mjs';
import { applyAgentCards } from './agent-cards/index.mjs';
import { applyControlledMarket } from './controlled-market/index.mjs';
import { applyWorkflowHub } from './workflow-hub/index.mjs';
import { applyChatHistory } from './chat-history/index.mjs';
import { applyMcpManager } from './mcp-manager/index.mjs';

export const name = 'dsh-peer';
export const inject = ['webServer', 'connection', 'credentials', 'settings', 'llm', 'systemPrompt', 'tools'];
export const Config = Schema.object({ role: Schema.union(['phone', 'computer']), webPort: Schema.natural().default(3080), proxyPort: Schema.natural().default(3081), gatewayPort: Schema.natural().default(8326), sharedGatewayPort: Schema.natural().default(8327) });
const REF = credentialRef('DSH_PEER_PAIR_V1');
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
export async function apply(ctx, options = {}) {
  const role = options.role ?? (process.env.DSH_PHONE_ANDROID === '1' ? 'phone' : 'computer');
  applyChatHistory(ctx);
  applyControlledMarket(ctx, role);
  await applyWorkflowHub(ctx, role);
  if (role === 'computer') await applyAgentCards(ctx);
  if (ctx.get('tools')) await applyMcpManager(ctx);
  const webPort = options.webPort ?? 3080, proxyPort = options.proxyPort ?? 3081, sharedGatewayPort = options.sharedGatewayPort ?? 8327;
  const sync = new ConfigSync(ctx.settings, ctx.credentials);
  let state = { role, name: role === 'phone' ? '我的手机' : hostname(), allowGateway: true, autoSync: false }, tunnel, proxy, disposed = false;
  let error = '', lastSync = null, catalogue = [], autoRunning = false, autoPending = false, autoTimer, remoteName = '家里的电脑', adapterRegistration;
  const refreshModels = () => { if (!disposed) { try { adapterRegistration?.replace(['phone-gateway']); } catch {} } };
  const notifyModels = () => { if (role === 'phone' && tunnel?.online) { try { tunnel.send({ type: 'models.changed' }); } catch {} } };
  const save = () => ctx.credentials.set(REF, JSON.stringify(state));
  const close = async () => {
    clearTimeout(autoTimer); tunnel?.stop(); proxy?.close();
    if (proxy) await Promise.all([proxy.ui, proxy.gateway].map(server => new Promise(resolve => { if (!server.listening) resolve(); else { server.closeAllConnections(); server.close(resolve); } })));
    proxy = null; tunnel = null; catalogue = []; if (!disposed) refreshModels();
  };
  const autoSync = async () => {
    if (!state.autoSync || role !== 'phone' || !tunnel?.online) return;
    if (autoRunning) { autoPending = true; return; }
    autoRunning = true;
    try { const snapshot = await sync.snapshot(); const preview = await tunnel.call('sync.preview', snapshot); lastSync = await tunnel.call('sync.commit', { token: preview.token, mode: 'keep' }); }
    catch { error = '自动同步未完成，请在设备页重新预览同步'; }
    finally { autoRunning = false; if (autoPending) { autoPending = false; queueAuto(); } }
  };
  const queueAuto = () => { clearTimeout(autoTimer); autoTimer = setTimeout(() => void autoSync(), 1000); autoTimer.unref(); };
  ctx.on('settings/updated', () => { if (role === 'phone') queueAuto(); });
  ctx.on('credentials/updated', ref => { if (String(ref) !== String(REF) && role === 'phone') queueAuto(); });
  ctx.on('llm/adapters-updated', notifyModels);
  const connect = async () => {
    await close(); if (!state.pair || disposed) return;
    tunnel = new PeerTunnel(state.pair, role);
    const css = readFileSync(new URL('./presentation.css', import.meta.url), 'utf8');
    const js = readFileSync(new URL('./presentation.js', import.meta.url), 'utf8');
    const compat = readFileSync(new URL('./browser-compat.js', import.meta.url), 'utf8');
    proxy = createPeerProxy(tunnel, { role, webPort, reusableScripts: loadReusableUiScripts(), localWebPort: role === 'phone' ? webPort : undefined, uiHeaders: browserSessionHeaders(ctx.connection, webPort), gatewayPort: options.gatewayPort ?? 8326, allowGateway: () => state.allowGateway,
      gatewayKey: async () => process.env.DSH_OPENAI_GATEWAY_API_KEY?.trim() || (await readFile(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'openai-gateway/api-key'), 'utf8')).trim(),
      assets: new Map([['/phone-skill-import.js', readFileSync(new URL('./skill-import.js', import.meta.url))]]),
      transformHtml: html => html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}<script>${compat};window.__dshPeerRemote=true;window.__dshPeerName=${JSON.stringify(remoteName).replaceAll('<', '\\u003c')};</script><style>${css}</style>`).replace('</body>', `<script>${js}</script></body>`),
    });
    tunnel.handler = (action, value) => {
      if (action === 'identity') return { role, name: state.name };
      if (action.startsWith('http.') || action.startsWith('ws.')) return proxy.action(action, value);
      if (action === 'models.resolve' && role === 'phone' && state.allowGateway) {
        const id = value?.id;
        if (typeof id !== 'string' || id.length > 512 || !id.includes('/')) throw Error('Invalid model route');
        const slash = id.indexOf('/'); return ctx.llm.resolveModelInfo(id.slice(0, slash), id.slice(slash + 1));
      }
      if (role !== 'computer') throw Error('Configuration sync target must be a computer');
      if (action === 'sync.preview') return sync.preview(value);
      if (action === 'sync.commit') return sync.commit(value.token, value.mode);
      throw Error('Unknown peer operation');
    };
    tunnel.on('online', () => { error = ''; refreshModels(); void tunnel.call('identity', {}).then(identity => { remoteName = identity.name; }).catch(() => {}); if (role === 'phone') queueAuto(); });
    tunnel.on('offline', () => { catalogue = []; if (!disposed) refreshModels(); });
    tunnel.on('packet', packet => { if (role === 'computer' && packet.type === 'models.changed') refreshModels(); });
    const localServer = role === 'phone' ? proxy.ui : proxy.gateway, port = role === 'phone' ? proxyPort : sharedGatewayPort;
    await new Promise((resolve, reject) => { localServer.once('error', reject); localServer.listen(port, '127.0.0.1', resolve); });
    tunnel.start();
  };
  const ready = (async () => {
    try {
      const stored = (await ctx.credentials.resolve(REF))?.value;
      if (stored) { const parsed = JSON.parse(stored); if (parsed.role === role) state = { ...state, ...parsed, ...(parsed.pair ? { pair: validatePair(parsed.pair) } : {}) }; }
    } catch { error = '设备配置无法读取，请重新配对'; return; }
    try { await connect(); } catch { error = '设备连接未启动，请检查本机端口或重新配对'; }
  })();
  ctx.on('dispose', () => { disposed = true; return close(); });
  const publicStatus = async () => ({ role, name: state.name, paired: !!state.pair, connected: !!tunnel?.online, relay: state.pair?.relay ?? '', allowGateway: state.allowGateway, autoSync: state.autoSync, lastSync, error,
    remote: tunnel?.online ? await tunnel.call('identity', {}).catch(() => null) : null,
    remoteUrl: role === 'phone' ? `http://127.0.0.1:${proxyPort}/` : null, gatewayUrl: role === 'computer' ? `http://127.0.0.1:${sharedGatewayPort}/v1` : null });
  async function manage(payload) {
    await ready;
    switch (payload.action) {
      case 'status': return publicStatus();
      case 'create': {
        if (role !== 'computer') throw Error('请在电脑上创建配对码');
        state.pair = newPair(payload.relay); await save(); await connect(); return { code: pairCode(state.pair), link: connectionLink(state.pair) };
      }
      case 'code': if (!state.pair || role !== 'computer') throw Error('请先创建连接链接'); return { code: pairCode(state.pair), link: connectionLink(state.pair) };
      case 'pair': {
        if (role !== 'phone') throw Error('配对码在手机上输入');
        state.pair = parsePair(payload.code); await save(); await connect(); return publicStatus();
      }
      case 'disconnect': await close(); delete state.pair; state.autoSync = false; await save(); return publicStatus();
      case 'preferences':
        if (typeof payload.name === 'string' && payload.name.trim().length >= 1 && payload.name.trim().length <= 60) state.name = payload.name.trim();
        if (typeof payload.allowGateway === 'boolean') state.allowGateway = payload.allowGateway;
        if (typeof payload.autoSync === 'boolean') state.autoSync = payload.autoSync;
        await save(); queueAuto(); notifyModels(); return publicStatus();
      case 'sync.preview': if (role !== 'phone') throw Error('请从手机同步'); return tunnel?.call('sync.preview', await sync.snapshot()) ?? Promise.reject(Error('请先配对电脑'));
      case 'sync.commit': if (role !== 'phone') throw Error('请从手机同步'); lastSync = await tunnel.call('sync.commit', { token: payload.token, mode: payload.mode }); return lastSync;
      default: throw Error('无效的设备操作');
    }
  }
  ctx.connection.rpc.handle('/phone-peer', async (method, payload) => {
    try { if (method !== 'manage' || !payload) throw Error('无效操作'); return { ok: true, value: await manage(payload) }; }
    catch { return { ok: false, error: { code: 'peer/unavailable', message: '设备操作未完成，请检查配对码、中继地址和两端服务后重试', details: {} } }; }
  }, { authority: 'loopback' });
  const page = readFileSync(new URL('./page.html', import.meta.url));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/phone-peer', handler: (req, res) => {
    if (req.method !== 'GET' || !loopback(req)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" }); res.end(page);
  } }));
  if (role === 'computer') {
    class PhoneGatewayAdapter extends DeepSeekAdapter {
      providerInfo(provider) { return { id: provider, name: '手机模型网关' }; }
      async resolveModel(provider, id) {
        if (!tunnel?.online) throw new LlmError('手机模型网关离线，请保持手机 DSH 运行并检查两端连接', 'PEER_OFFLINE');
        let remote;
        try { remote = await tunnel.call('models.resolve', { id }); }
        catch { throw new LlmError('手机模型网关不可用，请检查手机的模型账号、网关共享开关和两端网络', 'PEER_UNAVAILABLE'); }
        const entry = { id, name: '手机网关 · ' + (remote.name || id), inputModalities: remote.inputModalities || ['text'], contextWindow: remote.context?.contextWindow, maxTokens: remote.defaultMaxTokens };
        catalogue = [...catalogue.filter(m => m.id !== id), entry];
        const { reasoning, ...model } = await super.resolveModel(provider, id);
        // The gateway uses each phone provider's defaults. Do not display a
        // desktop "Off" switch that cannot override those defaults.
        return model;
      }
      async listModels(provider) {
        if (!tunnel?.online) return [];
        const response = await fetch(`http://127.0.0.1:${sharedGatewayPort}/v1/models`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Error('手机模型目录暂时不可用');
        const data = await response.json();
        catalogue = (Array.isArray(data.data) ? data.data : []).slice(0, 4096).filter(m => typeof m.id === 'string' && m.id.length <= 512).map(m => ({ id: m.id, name: '手机网关 · ' + (m.name || m.id), inputModalities: m.input || ['text'], contextWindow: m.context_window, maxTokens: m.max_tokens }));
        return super.listModels(provider);
      }
    }
    const userId = randomUUID();
    const adapter = new PhoneGatewayAdapter({ options: () => resolveAdapterOptions({ baseURL: `http://127.0.0.1:${sharedGatewayPort}/v1`, models: catalogue, thinking: 'disabled', retryPolicy: { mode: 'normal', maxRetries: 0 } }), resolveUserId: () => userId, resolveApiKey: async () => 'dsh-paired-device', resolveAttachments: () => ctx.get('attachments') });
    ctx.effect(() => { adapterRegistration = ctx.llm.registerAdapter(['phone-gateway'], adapter); return () => { adapterRegistration(); adapterRegistration = null; }; });
  }
}
