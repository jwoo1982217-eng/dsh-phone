import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { WorkflowStore } from './store.mjs';
import { PluginCenter } from './plugins.mjs';
import { Appearance } from './appearance.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
export function workflowDefinition(row, role, readiness) {
  const dir = path.join(root, 'presets', row.folder, 'preset');
  const instruction = row.prompt + '\n\n工作流仅规定本任务的方法；姓名、称呼与语气沿用当前激活的角色卡。用户当轮明确要求优先。\n'
    + (readiness.missing.length ? '当前缺少：' + readiness.missing.join('、') + '。可以准备资料和方案；需要这些依赖的执行须先配置，不能假装已完成。\n' : '')
    + '手机使用运行时提供的工作目录和工具，不使用电脑绝对路径。没有本机工具时，可从设备连接页进入已连接电脑执行。';
  const plugins = [
    { id: 'workflow-persona', name: '@deepseek-ai/dsh-persona', config: { prefix: instruction } },
    { id: 'workflow-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: { providerName: 'workflow-' + row.id, includeDefaultRoots: false, customSkillDirs: [path.join(dir, 'skills')] } },
  ];
  if (row.runtime === 'motion-deck') plugins.push({ id: 'workflow-deck', name: path.join(dir, 'runtime/motion-deck/index.js') });
  if (row.runtime === 'content-imagegen' && role === 'computer' && !readiness.missing.length) plugins.push({ id: 'workflow-imagegen', name: path.join(dir, 'runtime/content-imagegen/index.js') });
  if (row.runtime === 'feishu' && !readiness.missing.length) {
    for (const server of ['feishu', 'datetime']) plugins.push({ id: 'workflow-mcp-' + server, name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: server, transport: 'stdio', command: process.env.DSH_PHONE_ANDROID === '1' ? path.join(process.env.HOME, 'bin/node') : process.execPath,
      args: [path.join(dir, 'runtime/' + server + '-mcp.mjs')], toolCallTimeoutMs: server === 'feishu' ? 60000 : 10000,
      ...(server === 'feishu' ? { credentialEnv: { FEISHU_APP_ID: 'FEISHU_APP_ID', FEISHU_APP_SECRET: 'FEISHU_APP_SECRET', FEISHU_DEFAULT_OPEN_ID: 'FEISHU_DEFAULT_OPEN_ID' } } : {}), failOnStartupError: true,
    } });
  }
  return { id: row.id, name: row.name, description: row.description, order: row.order, plugins };
}
export async function readinessFor(row, role, credentials) {
  const available = executable => (process.env.PATH ?? '').split(path.delimiter).some(dir => existsSync(path.join(dir, executable)));
  const missing = [];
  if (row.runtime === 'content-imagegen' && (role === 'phone' || !available('codex'))) missing.push('已登录的电脑 Codex 生图桥接');
  if (row.runtime === 'feishu') for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DEFAULT_OPEN_ID']) {
    if (!(await credentials.resolve(credentialRef(key)))?.value) missing.push(key === 'FEISHU_DEFAULT_OPEN_ID' ? '飞书默认负责人 open_id' : key === 'FEISHU_APP_ID' ? '飞书应用 ID' : '飞书应用密钥');
  }
  if (row.folder.includes('video-generation')) for (const binary of ['ffmpeg', 'ffprobe']) if (!available(binary)) missing.push(binary);
  return { missing, mode: missing.length ? 'prepare' : 'ready', note: row.note[role] };
}
export async function applyWorkflowHub(ctx, role) {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const store = new WorkflowStore(home, catalog), disposers = new Map(); await store.init();
  const plugins = new PluginCenter(ctx, role, home);
  const appearance = new Appearance(home); await appearance.init();
  ctx.connection.rpc.handle('/appearance', async (method, payload) => {
    try {
      if (method !== 'manage') throw Error('无效的主题请求');
      const value = payload?.action === 'status' ? appearance.status() : payload?.action === 'select' ? await appearance.change(payload.skin, payload.revision) : null;
      if (!value) throw Error('无效的主题操作'); return { ok: true, value };
    } catch (error) { return { ok: false, error: { code: 'appearance/rejected', message: error.message, details: {} } }; }
  }, { authority: 'loopback' });
  let ready = Promise.resolve();
  ctx.inject(['agentPresets'], child => {
    const activate = async (row, enabled) => {
      if (enabled) {
        if (!disposers.has(row.id)) disposers.set(row.id, await child.agentPresets.register(workflowDefinition(row, role, await readinessFor(row, role, ctx.credentials))));
      } else { const dispose = disposers.get(row.id); if (dispose) { await dispose(); disposers.delete(row.id); } }
    };
    ready = Promise.all(catalog.filter(row => store.state.enabled.includes(row.id)).map(row => activate(row, true)));
    child.effect(() => async () => { await ready; for (const dispose of disposers.values()) await dispose(); disposers.clear(); });
    ctx.connection.rpc.handle('/workflow-hub', async (method, payload) => {
      try {
        await ready;
        if (method !== 'manage') throw Error('无效的工作流请求');
        if (payload?.action === 'toggle') await store.change(payload.id, payload.enabled, payload.revision, enabled => activate(catalog.find(x => x.id === payload.id), enabled));
        else if (payload?.action === 'configure-feishu') {
          const keys = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DEFAULT_OPEN_ID'];
          if (keys.some(key => typeof payload.values?.[key] !== 'string' || !payload.values[key].trim() || payload.values[key].length > 1024)) throw Error('请填写飞书应用 ID、密钥和默认负责人');
          const previous = await Promise.all(keys.map(async key => [key, (await ctx.credentials.resolve(credentialRef(key)))?.value]));
          try {
            for (const key of keys) await ctx.credentials.set(credentialRef(key), payload.values[key].trim());
          } catch (error) {
            for (const [key, value] of previous) if (value !== undefined) await ctx.credentials.set(credentialRef(key), value); else await ctx.credentials.unset(credentialRef(key));
            throw Error('飞书配置未完整保存，已恢复之前的值');
          }
          // A retained Session keeps its old composition; only subsequent selections use the new MCP.
          const row = catalog.find(row => row.runtime === 'feishu');
          if (store.state.enabled.includes(row.id)) { await activate(row, false); await activate(row, true); }
        } else if (payload?.action !== 'status') throw Error('无效的工作流操作');
        const state = store.status(), roster = await child.agentPresets.list();
        return { ok: true, value: { ...state, role, workflows: await Promise.all(catalog.map(async row => ({ ...row, prompt: undefined, readiness: await readinessFor(row, role, ctx.credentials), enabled: state.enabled.includes(row.id), broken: roster.find(x => x.id === row.id)?.broken }))) } };
      } catch (error) { return { ok: false, error: { code: 'workflow/rejected', message: error.message, details: {} } }; }
    }, { authority: 'loopback' });
  });
  ctx.connection.rpc.handle('/plugin-center', async (method, payload) => {
    try { if (method !== 'manage') throw Error('无效的插件请求'); return { ok: true, value: await plugins.manage(payload) }; }
    catch (error) { return { ok: false, error: { code: 'plugins/rejected', message: error.message, details: {} } }; }
  }, { authority: 'loopback' });
  for (const route of ['/workflow-hub', '/plugin-center']) for (const [suffix, file, type] of [['', 'page.html', 'text/html'], ['/page.js', 'page.js', 'text/javascript'], ['/page.css', 'page.css', 'text/css']]) {
    const content = readFileSync(new URL('./' + file, import.meta.url));
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route + suffix, handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'" }); res.end(content);
    } }));
  }
  for (const [route, file, type] of [['/appearance', 'appearance.html', 'text/html'], ['/appearance/page.js', 'appearance-page.js', 'text/javascript'], ['/appearance/theme.css', 'theme.css', 'text/css'], ['/appearance/theme-client.js', 'theme-client.js', 'text/javascript']]) {
    const content = readFileSync(new URL('./' + file, import.meta.url));
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'" }); res.end(content);
    } }));
  }
}
