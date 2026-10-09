import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = fileURLToPath(new URL('../', import.meta.url)), req = createRequire(import.meta.url);
const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-cloud-package-'));
try {
  const packageRoot = path.join(temp, 'dsh-phone-tools'); await mkdir(packageRoot);
  const source = path.join(root, 'phone-cloud-tools');
  for (const file of ['bin', 'LICENSE', 'README.md', 'REMOTE.md', 'mcp-config.example.json', 'codex-config.example.toml', 'dsh-config.example.yaml', 'hermes-config.example.yaml', 'nginx-relay.example.conf', 'nginx-hermes.example.conf', 'relay.service.example']) await cp(path.join(source, file), path.join(packageRoot, file), { recursive: true, filter: source => !source.endsWith('.test.mjs') });
  await mkdir(path.join(packageRoot, 'lib'));
  for (const file of ['mcp.mjs', 'tools.mjs', 'tunnel.mjs', 'protocol.mjs', 'relay.mjs']) await cp(path.join(source, 'lib', file), path.join(packageRoot, 'lib', file));
  const ws = path.dirname(req.resolve('ws/package.json'));
  await cp(ws, path.join(packageRoot, 'node_modules/ws'), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json')));
  delete manifest.main; delete manifest.exports;
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const toolRoot = path.join(source, 'sample-tools/note-normalize'), tool = JSON.parse(await readFile(path.join(toolRoot, 'tool.json')));
  delete tool.entry; tool.source = await readFile(path.join(toolRoot, 'tool.mjs'), 'utf8'); tool.exampleArgs = { text: '需要整理的笔记  \n第二行  ' };
  await writeFile(path.join(packageRoot, 'note-normalize.tool.json'), JSON.stringify(tool, null, 2) + '\n');
  const delivery = path.join(root, 'build-delivery'); await mkdir(delivery, { recursive: true });
  const target = path.join(delivery, 'DSH-手机工具箱-通用接入包-' + manifest.version + '.zip');
  await rm(target, { force: true });
  await promisify(execFile)('zip', ['-qr', target, 'dsh-phone-tools'], { cwd: temp });
  console.log(target);
} finally { await rm(temp, { recursive: true, force: true }); }
