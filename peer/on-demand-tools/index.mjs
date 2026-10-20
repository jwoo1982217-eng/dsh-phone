import {defineTool, renderToolsSdk, renderToolsSdkPy} from '@deepseek-ai/dsh-tools';

export const name = 'dsh-on-demand-tools';
export const inject = ['tools', 'systemPrompt'];
export const apply = applyOnDemandTools;

const BASE = new Set(['tool_search', 'tool_load', 'skill', 'read', 'ask_user_question']);
const MAX_ACTIVE_CHARACTERS = 24000;
const groupOf = name => name.startsWith('mcp__') ? name.split('__')[1] : 'core';
const sizeOf = tool => JSON.stringify(tool).length;
const output = {schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: value}]};
const instructions = '工具采用按需展开。常驻 tool_search、tool_load、skill、read 和询问入口；其他已安装能力完整保留。先用 tool_search 按英文/中文关键词或 group 查简短目录，再用 tool_load 加载精确名称（每次最多8个），下一步即可按完整参数调用。core 包括文件、shell、网页、任务、记忆；MCP 组包括 mt（手机文件/APK）、browser、media、router 及其他接入服务。加载只影响当前任务的定义展示，任务结束自动收回；较旧定义可能被收回，需要时重新加载。技能目录只含简介，使用时通过 skill 读取正文。所有调用继续遵守原有权限。';

/** 展示层裁剪；不改工具注册、执行回调、权限或持久会话。 */
export function applyOnDemandTools(ctx) {
  const states = new WeakMap();
  const stateOf = agent => {
    if (!agent || !agent.session) throw Error('按需加载需要当前 DSH 会话');
    let state = states.get(agent);
    if (!state) { state = {active: new Map()}; states.set(agent, state); }
    return state;
  };
  const catalog = agent => ctx.tools.schemas(agent).filter(tool => tool.name !== 'run_code');
  const canDiscover = agent => ctx.tools.get('tool_search', agent) && ctx.tools.get('tool_load', agent);
  const visible = (agent, schemas) => {
    // 显式子代理白名单可能没有发现入口；保留它原有的小许可清单，避免藏住可用工具。
    if (!canDiscover(agent)) return schemas;
    const active = stateOf(agent).active;
    const coordination = new Set(ctx.get('dshTeam')?.coordinationTools(agent) ?? []);
    // SDK 子代理的结构化输出始终保留；其他作用域工具同样按需展示。
    const inherited = ctx.tools.view(agent).restrictableNames;
    return schemas.filter(tool => tool.name === 'run_code' || BASE.has(tool.name) || coordination.has(tool.name) || active.has(tool.name) || (tool.name === 'structured_output' && !inherited.has(tool.name)));
  };
  const search = (args, exec) => {
    exec.signal?.throwIfAborted();
    const query = (args.query || '').trim().toLowerCase();
    const group = (args.group || '').trim().toLowerCase();
    const limit = args.limit ?? 8, offset = args.offset ?? 0;
    if (query.length > 160 || group.length > 64 || !Number.isInteger(limit) || limit < 1 || limit > 12 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw Error('查询范围无效；limit 为1至12');
    const tokens = query.split(/[\s,，/]+/).filter(Boolean);
    const schemas = catalog(exec.agent);
    const groups = {};
    for (const tool of schemas) { const key = groupOf(tool.name); groups[key] = (groups[key] || 0) + 1; }
    const matches = schemas.filter(tool => !group || groupOf(tool.name) === group).map(tool => {
      const name = tool.name.toLowerCase(), text = `${name} ${tool.description || ''}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (name === token ? 100 : name.includes(token) ? 10 : text.includes(token) ? 1 : 0), 0);
      return {tool, score};
    }).filter(item => !tokens.length || item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    return JSON.stringify({groups, total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null,
      tools: matches.slice(offset, offset + limit).map(({tool}) => ({name: tool.name, group: groupOf(tool.name), description: String(tool.description || '').replace(/\s+/g, ' ').slice(0, 160)}))});
  };
  const load = (args, exec) => {
    exec.signal?.throwIfAborted();
    const names = args.names;
    if (!Array.isArray(names) || !names.length || names.length > 8 || names.some(name => typeof name !== 'string' || name.length > 160)) throw Error('每次加载1至8个精确工具名');
    const available = new Map(catalog(exec.agent).map(tool => [tool.name, tool]));
    const requested = [...new Set(names)];
    for (const name of requested) if (!available.has(name)) throw Error(`工具 ${name} 不存在或不在当前会话可用范围`);
    const deferred = requested.filter(name => !BASE.has(name));
    if (deferred.reduce((sum, name) => sum + sizeOf(available.get(name)), 0) > MAX_ACTIVE_CHARACTERS) throw Error('本批工具定义过大，请减少加载数量');
    const state = stateOf(exec.agent), next = new Map([...state.active].filter(([name]) => available.has(name)));
    for (const name of deferred) { next.delete(name); next.set(name, sizeOf(available.get(name))); }
    const evicted = [];
    let size = [...next.values()].reduce((sum, value) => sum + value, 0);
    for (const [name, chars] of next) {
      if (size <= MAX_ACTIVE_CHARACTERS) break;
      if (requested.includes(name)) continue;
      next.delete(name); size -= chars; evicted.push(name);
    }
    state.active = next;
    return JSON.stringify({loaded: requested, evicted, active: [...next.keys()], definitionCharacters: size,
      next: '完整参数将在下一次模型请求中提供；按工具原有参数调用。加载不执行工具。'});
  };
  ctx.tools.register(defineTool({name: 'tool_search', description: 'Search the installed, permission-filtered tool catalog by keyword or group. Returns short summaries; use tool_load for full callable definitions.',
    parameters: {query: {type: 'string', description: 'Keywords, for example read file, APK, browser, 音频'}, group: {type: 'string', description: 'Optional core or MCP server id, such as mt/browser/media/router'}, limit: {type: 'integer', description: '1..12, default 8'}, offset: {type: 'integer', description: 'Pagination offset, default 0'}}, output, execute: search,
    presentCall: () => ({card: 'generic', title: '查找可用工具', kind: 'read'})}));
  ctx.tools.register(defineTool({name: 'tool_load', description: 'Expose 1..8 exact tool definitions for this task, then call them normally on the next step. Does not execute tools or change permissions. Older definitions may be evicted.',
    parameters: {names: {type: 'array', items: {type: 'string'}, required: true, description: 'Exact names from tool_search or current task instructions'}}, output, execute: load,
    presentCall: () => ({card: 'generic', title: '加载工具定义', kind: 'read'})}));
  ctx.systemPrompt.context({name: 'dsh:on-demand-tools', order: 111, text: context => canDiscover(context.agent || context.scope) ? instructions : '当前作用域的工具已按原权限清单提供，直接使用可见工具完成任务。发现入口若未获许可，不扩展权限。技能只提供简介，匹配任务时通过可用的 skill 工具加载正文。'});
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next(), agent = context.agent || context.scope;
    if (!agent?.session) return assembly;
    context.signal?.throwIfAborted();
    const tools = visible(agent, assembly.tools);
    const hasSdk = assembly.sections.some(section => section.name === 'tools:sdk' && section.text);
    let sections = assembly.sections;
    if (hasSdk) {
      const mode = ctx.tools.modeFor(agent), runtime = ctx.tools.requirePtcRuntime(mode);
      const schemas = visible(agent, ctx.tools.sdkSchemas(agent));
      const text = runtime.language === 'python' ? renderToolsSdkPy(schemas) : renderToolsSdk(schemas);
      sections = sections.map(section => section.name === 'tools:sdk' ? {...section, text} : section);
    }
    return {...assembly, tools, sections};
  });
  ctx.on('agent/status', ({agent, status}) => {
    if (status === 'idle' || status === 'running') states.get(agent)?.active.clear();
  });
  const service = {reset(agent) { states.get(agent)?.active.clear(); }, snapshot(agent) { const all = catalog(agent), shown = visible(agent, all); return {available: all.length, shown: shown.length, characters: JSON.stringify(shown).length, names: shown.map(tool => tool.name)}; }};
  ctx.provide('dshOnDemandTools', service);
  return service;
}
