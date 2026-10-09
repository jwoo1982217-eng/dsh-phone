#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { serveMcp } from '../lib/mcp.mjs';
import { validatePair } from '../lib/protocol.mjs';
try {
  const index = process.argv.indexOf('--pair-file');
  if (index < 0 || !process.argv[index + 1]) throw Error('需要 --pair-file 私有配对文件');
  const file = process.argv[index + 1], info = await stat(file);
  if (info.size > 2048 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw Error('配对文件需设置 chmod 600，大小不超过2 KiB');
  const server = serveMcp(validatePair(JSON.parse(await readFile(file, 'utf8'))));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); process.exit(0); });
} catch (error) { process.stderr.write('手机工具连接器无法启动：' + error.message + '\n'); process.exitCode = 1; }
