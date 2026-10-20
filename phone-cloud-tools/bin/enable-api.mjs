import { readFile, writeFile, rename, lstat, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function enableApi(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw Error('请传入已配置模型的 Hermes profile 绝对目录');
  const config = await lstat(path.join(home, 'config.yaml'));
  if (!config.isFile() || config.isSymbolicLink()) throw Error('未找到普通 config.yaml 文件，请先安装 Hermes 并配置模型');
  const file = path.join(home, '.env'); let previous = '';
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error('现有 .env 文件不适合自动修改'); previous = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const matches = [...previous.matchAll(/^\s*(?:export\s+)?API_SERVER_KEY\s*=\s*(.*?)\s*$/gm)];
  let key = matches.at(-1)?.[1] ?? '';
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  if (!/^[a-zA-Z0-9._~+\/\-]{24,256}={0,2}$/.test(key)) key = randomBytes(32).toString('hex');
  const controlled = /^(?:\s*export\s+)?\s*API_SERVER_(ENABLED|HOST|PORT|KEY)\s*=/;
  const body = previous.split(/\r?\n/).filter(line => !controlled.test(line)).join('\n').replace(/\n*$/, '\n') + 'API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=' + key + '\n';
  let backup = null;
  if (previous) { backup = path.join(home, '.env.before-dsh-phone-' + randomUUID()); await writeFile(backup, previous, { flag: 'wx', mode: 0o600 }); }
  const temporary = file + '.dsh-phone-' + randomUUID();
  try { await writeFile(temporary, body, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  return { file, backup, host: '127.0.0.1', port: 8642 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await enableApi(process.argv[2]); console.log(JSON.stringify({ ...result, message: 'API 配置已保存，原模型配置保留。重启该 profile 的 Hermes gateway 后生效。公网使用有效 HTTPS 代理；手机填写 API_SERVER_KEY。' }, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
