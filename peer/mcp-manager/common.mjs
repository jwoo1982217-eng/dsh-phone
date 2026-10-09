import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export function check(condition, message) { if (!condition) throw Error(message); }
export function read(file, fallback) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { check(fs.fstatSync(fd).size <= 4e6, '记录过大'); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
    finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function localCaller(exec) {
  const session = exec?.agent?.session;
  check(session && typeof session.id === 'string', '缺少实际会话身份');
  check(!session.id.startsWith('qq-') && !session.id.startsWith('cloud-') && session.header?.origin !== 'subagent' && !(session.header?.delegationDepth > 0), '此入口只供本机主代理使用');
  const cwd = session.header?.cwd;
  check(typeof cwd === 'string' && path.isAbsolute(cwd), '会话缺少项目目录');
  return { id: session.id, cwd: fs.realpathSync(cwd), agent: exec.agent, signal: exec.signal };
}
export function toolName(server, raw) {
  const name = 'mcp__' + server + '__' + raw, clean = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return name === clean && name.length <= 64 ? name : clean.slice(0, 51) + '_' + hash(JSON.stringify([server, raw])).slice(0, 12);
}
export const MT_READ = new Set(['mt_apk_open', 'mt_apk_list_available_apks', 'mt_apk_list_workspaces', 'mt_apk_list', 'mt_apk_search', 'mt_apk_read_text', 'mt_apk_read_bytes', 'mt_apk_dex_outline_class', 'mt_apk_dex_xref', 'mt_apk_resource_read', 'mt_apk_resource_xref', 'mt_apk_native_inspect', 'mt_apk_native_read_items', 'mt_apk_native_map_address', 'mt_apk_native_xref', 'mt_apk_native_disassemble', 'mt_apk_native_function_cfg', 'mt_apk_continue', 'mt_apk_read_signature', 'mt_file_access_policy', 'mt_file_list', 'mt_file_stat', 'mt_file_read_text', 'mt_file_read_bytes', 'mt_file_search', 'mt_file_search_text']);
export const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
export function policyOf(ctx, exec) {
  const policy=exec.agent?.ctx?.get('sandboxPolicy')||ctx.get('sandboxPolicy')||ctx.sandboxPolicy;
  check(policy,'当前会话权限服务未就绪');
  return policy.resolve({session:exec.agent.session});
}
