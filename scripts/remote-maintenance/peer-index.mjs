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
import { newPair, pairCode, connectionLink, shareLink, parsePair, validatePair } from './protocol.mjs';
import { ConfigSync } from './config-sync.mjs';
import { RemoteService, serviceError } from './remote-service.mjs';
import { applyAgentCards } from './agent-cards/index.mjs';
import { applyControlledMarket } from './controlled-market/index.mjs';
import { applyWorkflowHub } from './workflow-hub/index.mjs';
import { applyChatHistory } from './chat-history/index.mjs';
import { applyMcpManager } from './mcp-manager/index.mjs';
import { applyChatFiles } from './chat-files/index.mjs';
import { applyTaskSupervisor } from './task-supervisor/index.mjs';

export const name = 'dsh-peer';
export const inject = ['webServer', 'connection', 'credentials', 'settings', 'llm', 'systemPrompt', 'tools'];
export const Config = Schema.object({ role: Schema.union(['phone', 'computer']), webPort: Schema.natural().default(3080), proxyPort: Schema.natural().default(3081), gatewayPort: Schema.natural().default(8326), sharedGatewayPort: Schema.natural().default(8327) });
const REF = credentialRef('DSH_PEER_PAIR_V1');
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
export async function apply(ctx, options = {}) {
  if (ctx.get('tools')) applyChatFiles(ctx);
  const role = options.role ?? (process.env.DSH_PHONE_ANDROID === '1' ? 'phone' : 'computer');
  applyChatHistory(ctx);
  if (role === 'phone') (await import('./conversation-actions/index.mjs')).applyConversationActions(ctx);
  applyControlledMarket(ctx, role);
  await applyWorkflowHub(ctx, role);
  if (role === 'computer') await applyAgentCards(ctx);
  if (ctx.get('tools')) await applyMcpManager(ctx);
  if (ctx.get('tools')) applyTaskSupervisor(ctx);
  const webPort = options.webPort ?? 3080, proxyPort = options.proxyPort ?? 3081, sharedGatewayPort = options.sharedGatewayPort ?? 8327;
  const sync = new ConfigSync(ctx.settings, ctx.credentials), remoteService = new RemoteService(ctx.credentials);
  let state = { role, name: role === 'phone' ? '我的手机' : hostname(), allowGateway: true, autoSync: false }, tunnel, proxy, disposed = false;
  let error = '', errorCode = '', remoteIdentity = null, mutation = Promise.resolve(), lastSync = null, catalogue = [], autoRunning = false, autoPending = false, autoTimer, remoteName = '家里的电脑', adapterRegistration;
  const refreshModels = () => { if (!disposed) { try { adapterRegistration?.replace(['phone-gateway']); } catch {} } };
  const notifyModels = () => { if (role === 'phone' && tunnel?.online) { try { tunnel.send({ type: 'models.changed' }); } catch {} } };
  const persist = async next => { try { await ctx.credentials.set(REF, JSON.stringify(next)); } catch { throw serviceError('PEER_STORAGE'); } state = next; };
  const close = async () => {
    clearTimeout(autoTimer); tunnel?.stop(); proxy?.close();
    if (proxy) await Promise.all([proxy.ui, proxy.gateway].map(server => new Promise(resolve => { if (!server.listening) resolve(); else { server.closeAllConnections(); server.close(resolve); } })));
    proxy = null; tunnel = null; remoteIdentity = null; catalogue = []; if (!disposed) refreshModels();
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
    const currentTunnel = tunnel;
    tunnel.on('online', () => { error = ''; errorCode = ''; refreshModels(); void currentTunnel.call('identity', {}).then(identity => { if (tunnel === currentTunnel && currentTunnel.online) { remoteIdentity = identity; remoteName = identity.name; } }).catch(() => {}); if (role === 'phone' && state.autoSync) queueAuto(); });
    tunnel.on('state', status => { if (tunnel === currentTunnel) errorCode = status.errorCode; });
    tunnel.on('offline', () => { remoteIdentity = null; catalogue = []; if (!disposed) refreshModels(); });
    tunnel.on('packet', packet => { if (role === 'computer' && packet.type === 'models.changed') refreshModels(); });
    const localServer = role === 'phone' ? proxy.ui : proxy.gateway, port = role === 'phone' ? proxyPort : sharedGatewayPort;
    await new Promise((resolve, reject) => { const failed = cause => reject(cause); localServer.once('error', failed); localServer.listen(port, '127.0.0.1', () => { localServer.off('error', failed); resolve(); }); });
    tunnel.start();
  };
  const startConnection = async () => {
    try { await connect(); } catch (cause) {
      await close(); errorCode = cause.code === 'EADDRINUSE' ? 'PEER_LOCAL_PORT_BUSY' : cause.code === 'EACCES' ? 'PEER_LOCAL_PORT_DENIED' : ['ENOENT', 'ENOTDIR'].includes(cause.code) ? 'PEER_LOCAL_RESOURCE_MISSING' : 'PEER_LOCAL_START_FAILED';
      error = '设备连接未启动，请检查本机服务后重试';
    }
  };
  const ready = (async () => {
    await remoteService.init();
    try {
      const stored = (await ctx.credentials.resolve(REF))?.value;
      if (stored) { const parsed = JSON.parse(stored); if (parsed.role === role) state = { ...state, ...parsed, ...(parsed.pair ? { pair: validatePair(parsed.pair) } : {}), pendingRevocations: (parsed.pendingRevocations ?? []).map(validatePair) }; }
    } catch { error = '设备配置无法读取，请重新配对'; return; }
    if (!state.pendingRevocations?.length) await startConnection(); else { errorCode = 'PEER_REVOKE_PENDING'; error = serviceError(errorCode).message; }
  })();
  ctx.on('dispose', () => { disposed = true; return close(); });
  const publicStatus = async () => ({ role, name: state.name, paired: !!state.pair, connected: !!tunnel?.online, relay: state.pair?.relay ?? '', allowGateway: state.allowGateway, autoSync: state.autoSync, lastSync, error, errorCode, phase: tunnel?.phase ?? (state.pendingRevocations?.length ? 'revocation-pending' : state.pair ? 'idle' : 'unpaired'), remoteService: remoteService.status(), pendingRevocations: state.pendingRevocations?.length ?? 0,
    remote: tunnel?.online ? remoteIdentity : null,
    remoteUrl: role === 'phone' ? `http://127.0.0.1:${proxyPort}/` : null, gatewayUrl: role === 'computer' ? `http://127.0.0.1:${sharedGatewayPort}/v1` : null });
  const links = () => ({ code: pairCode(state.pair), link: connectionLink(state.pair), ...(state.managed && state.pair.relay.startsWith('wss:') ? { shareLink: shareLink(state.pair) } : {}) });
  const flushRevocations = async () => {
    while (state.pendingRevocations?.length) {
      try { await remoteService.revoke(state.pendingRevocations[0]); }
      catch { throw serviceError('PEER_REVOKE_PENDING'); }
      await persist({ ...state, pendingRevocations: state.pendingRevocations.slice(1) });
    }
  };
  const replacePair = async (pair, managed) => {
    await flushRevocations();
    const previous = state;
    if (managed) {
      // Journal before POST: a lost response can mean the service admitted this
      // room. Keep its unshared capability recoverable across process exit.
      await persist({ ...state, pendingRevocations: [pair] });
      try { await remoteService.register(pair); }
      catch (cause) {
        try { await flushRevocations(); } catch { throw serviceError('PEER_CLEANUP_PENDING'); }
        throw cause;
      }
    }
    try { await persist({ ...state, pair, managed, pendingRevocations: previous.managed && previous.pair ? [previous.pair] : [] }); }
    catch (cause) {
      if (managed) { try { await flushRevocations(); } catch { throw serviceError('PEER_CLEANUP_PENDING'); } }
      throw cause;
    }
    // The new admission and recovery journal are durable before old admission
    // is removed. A later failure remains visible and retryable, never atomic.
    await close();
    try { await flushRevocations(); } catch (cause) { errorCode = cause.code; error = cause.message; throw cause; }
    error = ''; errorCode = ''; await startConnection();
  };
  async function manage(payload) {
    switch (payload.action) {
      case 'status': return publicStatus();
      case 'remote.status': return remoteService.status();
      case 'remote.configure': {
        if (role !== 'computer') throw Error('请在电脑端配置远程服务');
        if ([...(state.managed && state.pair ? [state.pair] : []), ...(state.pendingRevocations ?? [])].some(pair => pair.relay !== payload.relay)) throw serviceError('PEER_SERVICE_MISMATCH');
        return remoteService.configure({ relay: payload.relay, adminKey: payload.adminKey });
      }
      case 'prepare': {
        if (role !== 'computer') throw Error('请在电脑上准备连接');
        await flushRevocations();
        if (!state.pair) await replacePair(newPair(remoteService.relay), true);
        else { if (state.managed) await remoteService.register(state.pair); if (!tunnel) await startConnection(); }
        return links();
      }
      case 'create': {
        if (role !== 'computer') throw Error('请在电脑上创建配对码');
        const pair = newPair(payload.relay || remoteService.relay);
        await replacePair(pair, remoteService.matches(pair)); return links();
      }
      case 'code':
        if (!state.pair || role !== 'computer') throw Error('请先创建连接链接');
        await flushRevocations(); return links();
      case 'reconnect': {
        if (!state.pair) throw Error('请先配对电脑');
        await flushRevocations();
        if (state.managed) await remoteService.register(state.pair);
        if (tunnel) tunnel.reconnect(); else await startConnection();
        return publicStatus();
      }
      case 'pair': {
        if (role !== 'phone') throw Error('配对码在手机上输入');
        const pair = parsePair(payload.code);
        if (state.pair && pairCode(state.pair) === pairCode(pair)) {
          if (!tunnel) await startConnection(); else if (!tunnel.online) tunnel.reconnect();
        } else await replacePair(pair, false);
        return publicStatus();
      }
      case 'disconnect': {
        await flushRevocations();
        const previous = state;
        if (state.managed && state.pair) await remoteService.revoke(state.pair);
        const { pair, managed, ...rest } = state;
        try { await persist({ ...rest, autoSync: false }); }
        catch (cause) {
          if (previous.managed && previous.pair) { try { await remoteService.register(previous.pair); } catch { errorCode = 'PEER_REVOKE_PENDING'; error = serviceError(errorCode).message; } }
          throw cause;
        }
        await close(); error = ''; errorCode = ''; return publicStatus();
      }
      case 'preferences': {
        const next = { ...state };
        if (typeof payload.name === 'string' && payload.name.trim().length >= 1 && payload.name.trim().length <= 60) next.name = payload.name.trim();
        if (typeof payload.allowGateway === 'boolean') next.allowGateway = payload.allowGateway;
        if (typeof payload.autoSync === 'boolean') next.autoSync = payload.autoSync;
        await persist(next); queueAuto(); notifyModels(); return publicStatus();
      }
      case 'sync.preview': if (role !== 'phone') throw Error('请从手机同步'); return tunnel?.call('sync.preview', await sync.snapshot()) ?? Promise.reject(Error('请先配对电脑'));
      case 'sync.commit': if (role !== 'phone') throw Error('请从手机同步'); lastSync = await tunnel.call('sync.commit', { token: payload.token, mode: payload.mode }); return lastSync;
      default: throw Error('无效的设备操作');
    }
  }
  ctx.connection.rpc.handle('/phone-peer', async (method, payload) => {
    try {
      if (method !== 'manage' || !payload) throw Error('无效操作');
      await ready;
      if (['status', 'remote.status'].includes(payload.action)) return { ok: true, value: await manage(payload) };
      const operation = mutation.then(() => manage(payload)); mutation = operation.catch(() => {});
      return { ok: true, value: await operation };
    } catch (cause) {
      const safe = typeof cause.code === 'string' && /^PEER_(SERVICE_|STORAGE$|REVOKE_PENDING$|CLEANUP_PENDING$)/.test(cause.code) ? serviceError(cause.code) : null;
      return { ok: false, error: { code: safe?.code || 'peer/unavailable', message: safe?.message || '设备操作未完成，请检查连接链接和两端服务后重试', details: {} } };
    }
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
