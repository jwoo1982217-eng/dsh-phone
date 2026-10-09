#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { ToolTunnel } from '../lib/tunnel.mjs';
import { validatePair } from '../lib/protocol.mjs';
let tunnel;
try {
  if (!process.argv[2]) throw Error('用法：node bin/check.mjs /私有目录/phone-pair.json');
  tunnel = new ToolTunnel(validatePair(JSON.parse(await readFile(process.argv[2], 'utf8'))), 'computer');
  const connected = once(tunnel, 'online', { signal: AbortSignal.timeout(15000) }); tunnel.start(); await connected;
  const status = await tunnel.call('phone_status', {});
  process.stdout.write(JSON.stringify({ connected: true, protocol: status.protocol, availableApps: status.apps?.length ?? 0, localConfirmationRequired: status.localConfirmationRequired }) + '\n');
} catch { process.stderr.write('连接检查未通过：请检查中继 TLS、配对文件、手机启用状态与服务运行情况；不要同时运行两个连接器。\n'); process.exitCode = 1; }
finally { tunnel?.stop(); }
