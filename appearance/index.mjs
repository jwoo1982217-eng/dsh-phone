import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppearanceStore } from './store.mjs';
import { themes } from './catalog.mjs';
import {installOpenCodeCompatibility} from './compat/opencode.mjs';

export const name = 'appearance-center';
export const inject = ['connection', 'webServer', 'clientModules'];
const root = fileURLToPath(new URL('.', import.meta.url));
const pages = new Map([
  ['/appearance-center', ['page.html', 'text/html']],
  ['/appearance-center/page.js', ['page.js', 'text/javascript']],
  ['/appearance-center/page.css', ['page.css', 'text/css']],
  ['/appearance-center/visuals.js', ['visuals.js', 'text/javascript']],
  ['/appearance-center/runtime.css', ['runtime.css', 'text/css']],
]);
export async function apply(ctx) {
  const home=process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const store = new AppearanceStore(home);
  await store.init();
  let compatibility={present:false},checking;
  const check=()=>checking|| (checking=installOpenCodeCompatibility(ctx.clientModules,home).then(result=>{compatibility=result;}).catch(error=>{compatibility={present:true,adapted:false,warning:error.message};}).finally(()=>{checking=null;}));
  await check();ctx.effect(()=>ctx.clientModules.onGraphChanged(check));
  ctx.connection.rpc.handle('/appearance-center', async (method, payload) => {
    try {
      if (method !== 'manage' || !payload || !['status', 'select', 'configure', 'reset'].includes(payload.action)) throw Error('外观请求无效');
      return { ok: true, value: {...(payload.action === 'status' ? store.status() : await store.change(payload)),compatibility} };
    } catch (error) { return { ok: false, error: { code: 'appearance/rejected', message: error.message, details: {} } }; }
  }, { authority: 'loopback' });
  const assets = new Map(pages);
  for (const theme of themes.values()) {
    assets.set('/appearance-center/themes/' + theme.file + '.json', ['assets/themes/' + theme.file + '.json', 'application/json']);
    assets.set('/appearance-center/themes/' + theme.file + '.css', ['assets/themes/' + theme.file + '.css', 'text/css']);
  }
  for (const [url, [file, type]] of assets) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: url, async handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      try {
        const body = await readFile(path.join(root, file));
        res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'" });
        res.end(body);
      } catch { res.writeHead(503).end('外观资源暂不可用'); }
    },
  }));
}
