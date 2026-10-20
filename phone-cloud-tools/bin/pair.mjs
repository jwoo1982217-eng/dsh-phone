#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';
import { parsePair } from '../lib/protocol.mjs';
const rl = createInterface({ input: process.stdin, output: process.stderr });
try {
  const file = process.argv[2]; if (!file) throw Error('用法：node bin/pair.mjs /私有目录/phone-pair.json');
  const code = await rl.question('粘贴手机生成的云端工具配对链接（含密钥，勿发送给别人）：\n');
  const pair = parsePair(code);
  await writeFile(file, JSON.stringify(pair) + '\n', { flag: 'wx', mode: 0o600 });
  process.stderr.write('配对已保存。已有文件不会覆盖；重新配对请先删除旧文件。\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
finally { rl.close(); }
