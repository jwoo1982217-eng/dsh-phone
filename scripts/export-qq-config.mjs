// Explicit local export helper. The output is never added to APK assets.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseConfig, exportConfig } from '../phone-qq/config.js';
const require = createRequire(new URL('../runtime/package.json', import.meta.url));
const { parse } = require('yaml');
const args = process.argv.slice(2);
const includeToken = args.includes('--include-token');
const paths = args.filter(value => value !== '--include-token');
if (paths.length !== 2) {
  console.error('用法：node scripts/export-qq-config.mjs <cordis.patch.yml> <输出.json> [--include-token]');
  process.exit(1);
}
try {
  const rows = parse(await readFile(paths[0], 'utf8'));
  const matches = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if ((value.name === 'dsh-channel-qq' || value.id === 'channel-qq') && value.config) matches.push(value.config);
    for (const child of Object.values(value)) visit(child);
  }
  visit(rows);
  if (matches.length !== 1) throw new Error('需要恰好一份 QQ 配置；请指定实际保存机器人配置的 patch 文件');
  const source = matches[0];
  const keys = ['connection','selfId','admins','accessToken','primaryGroup','groupEnabled','requireMention','talkValue','groupModel','persona'];
  const config = parseConfig(JSON.stringify(Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]))));
  const output = exportConfig(config);
  if (includeToken) output.config.accessToken = config.accessToken;
  await writeFile(paths[1], JSON.stringify(output, null, 2)+'\n', { mode:0o600, flag:'wx' });
  console.log(includeToken ? '已导出个人迁移文件（含 OneBot 令牌），仅供自己导入。' : '已导出 QQ 配置，不含令牌；手机导入时可补填。');
  console.log('聊天账号、会话、插件高级配置和原设备文件路径不在迁移范围内。');
} catch (error) {
  // YAML parse errors may quote private source lines; never print their raw details.
  console.error(error.code === 'EEXIST' ? '输出文件已存在，请换一个文件名。' : '导出未完成。请核对文件路径、QQ 配置格式及输出目录。');
  process.exitCode=1;
}
