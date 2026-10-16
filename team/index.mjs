import {readFileSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRuntime} from './vendor/ds-bot/index.js';

export const name = 'dsh-team';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection', 'webServer'];
const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = path => {try {return realpathSync(path);} catch {return resolve(path);}};

export function teamService(rt, cards = () => rt.ctx.get('dshAgentCards')) {
  const botOfSession = id => rt.botOf(rt.selfOf(id)) ?? rt.botOf(id);
  const isSession = session => !!session && (!!botOfSession(session.id) || !!rt.roomOf(session.id));
  let copying = Promise.resolve();
  const service = {
    isSession,
    ownsWorkingDirectory(cwd) {
      if (typeof cwd !== 'string') return false;
      const folders = [rt.config.workspace, ...Object.values(rt.state.bots).map(bot => bot.workDir), ...Object.values(rt.state.rooms).map(room => room.workDir)].filter(Boolean);
      return folders.some(folder => canonical(folder) === canonical(cwd));
    },
    coordinationTools(agent) {
      const id = agent?.session?.id;
      if (!id) return [];
      if (rt.roomOf(id) && !botOfSession(id)) return ['group_relay'];
      if (!botOfSession(id)) return [];
      const names = ['list_bots', 'message_bot', 'stop_bot', 'ask_user', 'read_own_chat', 'read_group_chat'];
      if (rt.isMain(rt.selfOf(id))) names.push('create_bot', 'update_bot', 'create_group', 'update_group', 'post_to_group');
      return names;
    },
    async status() {
      await rt.load();
      return {version: '0.1.0', upstream: 'ds-bot@0.1.5', bots: Object.values(rt.state.bots).map(bot => ({id: bot.id, name: bot.name, role: bot.role, main: rt.isMain(bot.id)})), groups: Object.values(rt.state.rooms).map(room => ({id: room.id, name: room.name})), readOnly: rt.readOnly() !== undefined};
    },
    fromCard(payload) {
      const run = copying.then(async () => {
      const {id, revision} = payload;
      const cardStore = cards();
      if (!cardStore) throw Error('人设卡尚未就绪，请刷新后重试');
      const snapshot = await cardStore.status();
      if (snapshot.revision !== revision) throw Error('人设卡已变化，请刷新后重试');
      const card = snapshot.cards.find(card => card.id === id);
      if (!card) throw Error('人设卡不存在');
      await rt.load();
      if (rt.readOnly() !== undefined) throw Error(rt.readOnly());
      const existing = Object.values(rt.state.bots).find(bot => bot.sourceCard?.id === id);
      if (existing) return {id: existing.id, sessionId: rt.chatOf(existing.id), name: existing.name, existing: true};
      const bot = await rt.createBot({name: card.name.slice(0, 40), role: card.kind === 'main' ? '主理人' : card.name.slice(0, 20), instructions: card.content, main: card.kind === 'main'});
      bot.sourceCard = {id, sha256: hash(card.content)};
      await rt.save();
      return {id: bot.id, sessionId: rt.chatOf(bot.id), name: bot.name, existing: false};
      });
      copying = run.catch(() => {});
      return run;
    },
  };
  return service;
}

export function apply(ctx, config = {}) {
  if (ctx.get('dshTeam')) return;
  const rt = createRuntime(ctx, {...config, browser: false, updateCheck: false});
  // Importing phone skills uses the existing workspaces scope by default.
  rt.config.workspace ??= join(rt.dshHome, 'workspaces/team');
  const service = teamService(rt);
  ctx.provide('dshTeam', service);
  ctx.connection.rpc.handle('/dsh-team', async (method, payload) => {
    try {
      if (method !== 'manage') throw Error('无效的团队操作');
      if (payload?.action === 'status') return {ok: true, value: await service.status()};
      if (payload?.action === 'from-card') return {ok: true, value: await service.fromCard(payload)};
      throw Error('无效的团队操作');
    } catch (error) {return {ok: false, error: {code: 'team/failed', message: error.message, details: {}}};}
  }, {authority: 'loopback'});
  for (const [route, file, type] of [['/dsh-team', 'page.html', 'text/html'], ['/dsh-team/page.js', 'page.js', 'text/javascript']]) {
    const body = readFileSync(new URL(file, import.meta.url));
    ctx.effect(() => ctx.webServer.register({kind: 'exact', path: route, handler: (req, res) => {
      if (req.method !== 'GET') {res.writeHead(405).end(); return;}
      res.writeHead(200, {'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'"}); res.end(body);
    }}));
  }
  return service;
}
