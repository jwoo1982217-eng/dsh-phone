import { readFileSync } from 'node:fs';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { ChatGptAccount } from './chatgpt-account.js';
import { ChatGptAdapter, CHATGPT_PROVIDER } from './chatgpt-adapter.js';
import { CALLBACK_PATH } from './chatgpt-protocol.js';

export function applyChatGpt(ctx, { desktop = false, callbackOrigin = 'http://127.0.0.1:3080' } = {}) {
  const store = {
    get: async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
    set: (ref, value) => ctx.credentials.set(credentialRef(ref), value),
  };
  const account = new ChatGptAccount(store, { callbackOrigin, agentName: desktop ? 'DSH' : 'DSH 手机版' });
  ctx.on('dispose', () => account.dispose());
  let page = readFileSync(new URL('./chatgpt-page.html', import.meta.url), 'utf8');
  if (desktop) page = page.replace(/<small>在 DSH 的模型选择中[\s\S]*?<\/small>/, '<small>登录后在电脑 DSH 的模型选择中找到“ChatGPT 会员”。供其他程序调用时，在“设置 → Jet Hub → API 网关”中启用电脑网关，地址和密钥以该面板为准；模型 ID 见上方列表。</small>');
  const policy = {
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'",
  };
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/phone-chatgpt', handler: (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.writeHead(200, { ...policy, 'content-type': 'text/html; charset=utf-8' }); res.end(page);
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: CALLBACK_PATH, handler: async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    let success = false;
    try { await account.callback(new URL(req.url, 'http://127.0.0.1:3080')); success = true; } catch {}
    // Do not reflect OAuth codes, tokens, provider messages or callback parameters.
    const title = success ? '授权已完成' : '授权未完成';
    res.writeHead(success ? 200 : 400, { ...policy, 'content-type': 'text/html; charset=utf-8' });
    const back = desktop ? '<a href="/phone-chatgpt">返回电脑 ChatGPT 账号</a><a href="/">返回电脑 DSH</a>' : '<a href="dsh-phone://chatgpt/return">返回 DSH 手机版</a><p>若按钮没有打开应用，请从手机桌面返回 DSH。</p>';
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:18px/1.7 system-ui;padding:24px}a{display:block;padding:14px;margin-top:18px}</style><h1>${title}</h1><p>请返回 DSH 查看账号状态和官方可用模型。</p>${back}</html>`);
  } }));
  ctx.connection.rpc.handle('/phone-chatgpt', async (method, payload) => {
    if (method !== 'manage' || !payload || !['status', 'login', 'cancel', 'logout', 'switch', 'models', 'welcome'].includes(payload.action)) {
      return { ok: false, error: { code: 'phone-chatgpt/bad-request', message: '无效的账号操作', details: {} } };
    }
    try {
      let value;
      switch (payload.action) {
        case 'login': value = await account.login({ newProfile: payload.newProfile === true, profileId: typeof payload.profileId === 'string' ? payload.profileId : undefined }); break;
        case 'logout': value = await account.logout(); break;
        case 'switch': value = await account.switchAccount(payload.id); break;
        case 'models': value = { models: await account.models(undefined, { force: payload.force === true }) }; break;
        case 'welcome': value = await account.welcome(); break;
        default: if (payload.action === 'cancel') account.cancel(); value = await account.status();
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: error?.code ?? 'phone-chatgpt/unavailable', message: error?.failure?.message ?? 'ChatGPT 账号服务暂时不可用，请稍后重试。', details: {} } };
    }
  }, { authority: 'loopback' });
  const adapter = new ChatGptAdapter(account, { attachments: () => ctx.get('attachments') });
  ctx.effect(() => ctx.llm.registerAdapter([CHATGPT_PROVIDER], adapter));
  return { account, adapter };
}
