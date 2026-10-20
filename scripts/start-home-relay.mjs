import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Publish only the ciphertext relay, never the computer's DSH web server.
export async function startHomeRelay({ cloudflared = process.env.DSH_CLOUDFLARED || 'cloudflared', port = Number(process.env.DSH_RELAY_PORT || 8789), onUrl = url => console.log(`中继地址：${url}\n在电脑设备连接页粘贴此地址，再生成配对码：http://127.0.0.1:3080/phone-peer`) } = {}) {
  // A desktop-only checkout has no Android runtime/root node_modules. Resolve
  // ws through the installed desktop bundle instead of the source directory.
  const { createRelay } = await import('../desktop-runtime/node_modules/dsh-peer/relay.mjs');
  const relay = createRelay();
  await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(port, '127.0.0.1', resolve); });
  const actualPort = relay.server.address().port;
  const child = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${actualPort}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let reported = false, stopped = false, output = '';
  const report = bytes => {
    output = (output + bytes.toString()).slice(-16384);
    const match = output.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/i);
    if (match && !reported) { reported = true; onUrl(`wss://${match[1]}/relay`); }
  };
  child.stdout.on('data', report); child.stderr.on('data', report);
  const close = async () => { if (stopped) return; stopped = true; child.kill(); await relay.close(); };
  child.on('error', () => { process.exitCode = 1; console.error('无法启动 cloudflared。请先按官方说明安装，或通过 DSH_CLOUDFLARED 指定程序路径。'); void close(); });
  child.on('exit', code => { if (!stopped) { if (code !== 0) process.exitCode = 1; console.error(`外网中继通道已退出（${code ?? 'signal'}），重新启动后需要更新配对地址。`); void close(); } });
  return { close, child, relay };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const service = await startHomeRelay(); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close()); }
  catch { console.error('中继无法启动，请检查端口是否占用。'); process.exitCode = 1; }
}
