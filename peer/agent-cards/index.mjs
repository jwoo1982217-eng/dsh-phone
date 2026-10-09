import { readFileSync } from 'node:fs';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { AgentCards, CardsError } from './store.mjs';
import { applyMemoryIsolation } from '../memory-isolation/index.mjs';

/** Shared by desktop peer and native-phone host; never changes the QQ persona. */
export async function applyAgentCards(ctx, { legacyPrompts } = {}) {
  const cards = new AgentCards({ get: async key => (await ctx.credentials.resolve(credentialRef(key)))?.value,
    set: (key, value) => ctx.credentials.set(credentialRef(key), value) });
  await cards.init();
  const migrate = async () => { if (legacyPrompts) await cards.importLegacy(await legacyPrompts()); };
  await migrate();
  await applyMemoryIsolation(ctx,cards);
  ctx.systemPrompt.variable('dsh_agent_persona_cards', context => {
    const session = context.agent?.session;
    return String(session?.id ?? '').startsWith('qq-') || session?.header?.origin === 'subagent' || (session?.header?.delegationDepth ?? 0) > 0 ? '' : cards.promptText();
  });
  ctx.systemPrompt.context({ name: 'dsh:agent-persona-cards', order: 20, text: '{{dsh_agent_persona_cards}}' });
  ctx.connection.rpc.handle('/agent-cards', async (method, payload) => {
    try {
      if (method !== 'manage' || !payload) throw new CardsError('无效的人设操作');
      await migrate();
      const value = payload.action === 'status' ? await cards.status()
        : payload.action === 'export' ? cards.export() : await cards.change(payload.action, payload);
      return { ok: true, value };
    } catch (error) { return { ok: false, error: { code: 'agent-cards/failed', message: error instanceof CardsError ? error.message : '人设未保存，请检查服务后重试', details: {} } }; }
  }, { authority: 'loopback' });
  for (const [route, file, type] of [['/agent-cards', 'page.html', 'text/html'], ['/agent-cards/page.js', 'page.js', 'text/javascript'], ['/agent-cards/page.css', 'page.css', 'text/css']]) {
    const content = readFileSync(new URL('./' + file, import.meta.url));
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler: (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; object-src 'none'" });
      res.end(content);
    } }));
  }
  return cards;
}
