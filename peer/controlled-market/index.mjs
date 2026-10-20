import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ControlledMarket, protectedName } from './catalog.mjs';
import { TrialPlans } from './trials.mjs';
export function applyControlledMarket(ctx, role) {
  const market = new ControlledMarket({ role, home: process.env.DSH_HOME || homedir() + '/.dsh' });
  const trials = new TrialPlans(market);
  ctx.connection.rpc.handle('/controlled-market', async (method, payload) => {
    try {
      if (method !== 'manage') throw Error('无效的市场操作');
      if (payload?.action !== 'catalog') return { ok: true, value: await trials.manage(payload ?? {}) };
      const value = await market.manage(payload); value.trialEnabled = role === 'phone' && await trials.enabled();
      value.plugins = value.plugins.map(row => ({ ...row, canTrial: role === 'phone' && !protectedName(row.npm) }));
      return { ok: true, value };
    }
    catch (error) { return { ok: false, error: { code: 'market/rejected', message: error.message, details: {} } }; }
  }, { authority: 'loopback' });
  for (const [route, file, type] of [['/controlled-market', 'page.html', 'text/html'], ['/controlled-market/page.js', 'page.js', 'text/javascript'], ['/controlled-market/page.css', 'page.css', 'text/css']]) {
    const content = readFileSync(new URL('./' + file, import.meta.url));
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; object-src 'none'" }); res.end(content);
    } }));
  }
  return market;
}
