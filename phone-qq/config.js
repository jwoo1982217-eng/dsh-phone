export const FORMAT = 'dsh-phone-qq';
export const LIMIT = 32 * 1024;
export const TEMPLATE = {
  format: FORMAT, version: 1,
  config: {
    connection: { mode: 'forward', url: 'ws://127.0.0.1:3001' },
    selfId: '填写机器人QQ号', admins: ['填写管理员QQ号'],
    accessToken: '', primaryGroup: null, groupEnabled: true, requireMention: true,
    talkValue: 0, codeExecution: false, groupModel: { provider: null, model: null },
    persona: { selfName: '助手', masterName: '管理员', peerName: '朋友', pronoun: '我', style: 'friendly', description: '' },
  },
};
export class ConfigError extends Error {}
const fail = message => { throw new ConfigError(message); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}须为对象`);
  return value;
};
const only = (value, keys, label) => {
  object(value, label);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${label}含不支持的字段，请使用本应用导出的模板`);
};
const id = (value, label) => {
  if (!/^[1-9]\d{4,12}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(`${label}须为有效数字号码`);
  return Number(value);
};
const bool = (value, fallback, label) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${label}须为 true 或 false`);
  return value;
};
const short = (value, fallback, label, max = 64) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${label}格式不正确`);
  return value.trim();
};
export function parseConfig(text, defaultAccessToken = '') {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) fail('配置文件不能超过 32 KB');
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('不是有效的 JSON 配置'); }
  if (value?.format !== undefined) {
    only(value, ['format', 'version', 'config'], '文件');
    if (value.format !== FORMAT || value.version !== 1) fail('不支持的配置格式或版本');
    value = value.config;
  }
  only(value, ['connection', 'selfId', 'admins', 'accessToken', 'primaryGroup', 'groupEnabled', 'requireMention', 'talkValue', 'codeExecution', 'groupModel', 'persona'], 'QQ 配置');
  only(value.connection, ['mode', 'url'], '连接');
  const { mode } = value.connection;
  if (!['forward', 'reverse'].includes(mode)) fail('连接方式须为 forward 或 reverse');
  let url;
  try { url = new URL(value.connection.url); } catch { fail('OneBot WebSocket 地址不正确'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('请填写 ws:// 或 wss:// 地址，令牌应填在 accessToken 字段');
  if (['3080', '8326', '18789'].includes(url.port)) fail('OneBot 端口不能与本应用端口相同');
  if (mode === 'reverse' && (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(url.hostname) || !url.port || url.pathname !== '/')) fail('反向连接须填本机 ws://127.0.0.1:8082；局域网接入可填 ws://0.0.0.0:8082');
  const token = value.accessToken ?? defaultAccessToken;
  if (typeof token !== 'string' || token.length > 2048 || /[^\x21-\x7e]/.test(token)) fail('accessToken 须为不含空白的可见英文字符');
  if (mode === 'reverse' && url.hostname === '0.0.0.0' && !token) fail('局域网反向连接必须填写 accessToken');
  if (!Array.isArray(value.admins) || value.admins.length < 1 || value.admins.length > 20) fail('至少填写一个管理员 QQ 号，最多 20 个');
  const talk = value.talkValue ?? 0;
  if (typeof talk !== 'number' || !Number.isFinite(talk) || talk < 0 || talk > 1) fail('talkValue 须在 0 到 1 之间');
  const model = value.groupModel ?? { provider: null, model: null };
  only(model, ['provider', 'model'], '模型');
  if ((model.provider == null) !== (model.model == null)) fail('模型的 provider 和 model 须同时填写，或同时为 null');
  const persona = value.persona ?? {};
  only(persona, ['selfName', 'masterName', 'peerName', 'pronoun', 'style', 'description'], '性格');
  const style = persona.style ?? 'friendly';
  if (!['friendly', 'calm', 'lively', 'concise', 'custom'].includes(style)) fail('请选择有效的性格预设');
  const description = persona.description ?? '';
  if (typeof description !== 'string' || description.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) fail('自定义人设最多 4000 字，不能包含控制字符');
  return {
    connection: { mode, url: url.href.replace(/\/$/, '') }, selfId: id(value.selfId, '机器人 QQ 号'),
    admins: [...new Set(value.admins.map(v => id(v, '管理员 QQ 号')))], accessToken: token,
    primaryGroup: value.primaryGroup == null ? null : id(value.primaryGroup, '群号'),
    groupEnabled: bool(value.groupEnabled, true, '群聊开关'), requireMention: bool(value.requireMention, true, '群聊提及开关'),
    talkValue: talk, codeExecution: bool(value.codeExecution, false, '代码执行开关'),
    groupModel: model.provider == null ? { provider: null, model: null } : {
      provider: short(model.provider, null, '模型供应商', 128), model: short(model.model, null, '模型名称', 128),
    },
    persona: {
      ...Object.fromEntries(['selfName', 'masterName', 'peerName', 'pronoun'].map(k => [k, short(persona[k], TEMPLATE.config.persona[k], '称呼')])),
      style, description: description.trim(),
    },
  };
}
export function publicConfig(config) {
  if (!config) return null;
  const { accessToken, ...rest } = config;
  return structuredClone(rest);
}
export function exportConfig(config) {
  return { format: FORMAT, version: 1, config: { ...publicConfig(config), accessToken: '' } };
}
export function runtimeConfig(config, home) {
  return {
    ...config, workspacePath: `${home}/workspaces/qq`, affectionPort: 18789,
    scheduler: { enabled: false, cruises: false, morningReport: false, nightTasks: false },
    stt: { enabled: false }, emoji: { steal: false, autoSend: false },
  };
}
