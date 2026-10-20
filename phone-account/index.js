import { readFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { AccountMessagesAdapter, resolveAdapterOptions } from './messages-adapter.js';
import { PhoneAccount, INFERENCE } from './account.js';
import { applyChatGpt } from './chatgpt.js';

export const name = 'phone-deepseek-account';
export const inject = ['credentials', 'connection', 'llm', 'webServer'];
export const Config = Schema.object({});

export function apply(ctx) {
  applyChatGpt(ctx);
  const store = {
    get: async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
    set: (ref, value) => ctx.credentials.set(credentialRef(ref), value),
    remove: ref => ctx.credentials.unset(credentialRef(ref)),
  };
  const account = new PhoneAccount(store);
  ctx.on('dispose', () => account.dispose());
  const page = readFileSync(new URL('./page.html', import.meta.url));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/phone-account', handler: (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" });
    res.end(page);
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/oauth/callback', handler: async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const result = await account.callback(new URL(req.url, 'http://127.0.0.1:3080'));
    res.writeHead(result.status, { 'cache-control': 'no-store', ...(result.location ? { location: result.location } : {}), 'content-type': 'text/plain; charset=utf-8' });
    res.end(result.location ? '' : '登录未完成或已取消，请返回 DSH 重新登录。');
  } }));
  ctx.connection.rpc.handle('/phone-account', async (method, payload) => {
    if (method !== 'manage' || !payload || !['status', 'login', 'cancel', 'logout'].includes(payload.action)) {
      return { ok:false, error:{code:'phone-account/bad-request', message:'无效的账号操作', details:{}} };
    }
    try {
      let value;
      if (payload.action === 'login') value = await account.login();
      else if (payload.action === 'logout') value = await account.logout();
      else { if (payload.action === 'cancel') account.cancel(); value = await account.status(); }
      return { ok:true, value };
    } catch {
      return { ok:false, error:{code:'phone-account/unavailable', message:'账号服务暂时不可用，请重试', details:{}} };
    }
  }, { authority:'loopback' });

  let userId;
  class AccountAdapter extends AccountMessagesAdapter {
    providerInfo(provider) { return { id:provider, name:'DeepSeek 账号' }; }
    async listModels(provider) { return await account.grant() ? super.listModels(provider) : []; }
  }
  const adapter = new AccountAdapter({
    options: () => resolveAdapterOptions({ baseURL:INFERENCE, models:[
      { id:'deepseek-flash', name:'DeepSeek Flash', inputModalities:['text','image'] },
      { id:'deepseek-v4-pro', name:'DeepSeek V4 Pro' },
    ] }, launchEnvironmentOf(ctx)),
    resolveApiKey: async connection => {
      const token = await account.token(connection.baseURL);
      if (!token) throw new LlmError('请先在手机顶部的 DeepSeek 账号入口登录', 'ACCOUNT_SIGN_IN_REQUIRED');
      return token;
    },
    resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
    resolveAttachments: () => ctx.get('attachments'),
    onAuthError: token => account.rejectToken(token),
  });
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-account'], adapter));
}
