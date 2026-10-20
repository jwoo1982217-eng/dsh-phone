import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDesktopNode, desktopVersion } from './install-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function desktopStatePath(home, port) { return path.join(home, `.desktop-web-${port}.json`); }
function validLocalUrl(url, port) {
  try { const u = new URL(url); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === port && u.pathname === '/' && !!u.searchParams.get('token') && !u.username && !u.password; }
  catch { return false; }
}

/** Reopen only a live, authenticated local DSH; never trust an arbitrary URL. */
export async function runningDesktop(home, port) {
  try {
    const state = JSON.parse(await readFile(desktopStatePath(home, port), 'utf8'));
    if (state.home !== home || state.version !== desktopVersion || !Number.isInteger(state.pid) || state.pid < 1 || !validLocalUrl(state.url, port)) return null;
    process.kill(state.pid, 0);
    const response = await fetch(state.url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    // The bootstrap can redirect after setting its session cookie. A direct
    // root response is accepted only when it is actually the DSH document.
    if (response.status === 302 || response.status === 303) {
      const location = response.headers.get('location');
      if (!response.headers.get('set-cookie') || !location || new URL(location, state.url).origin !== new URL(state.url).origin) return null;
    } else if (!response.ok || !(await response.text()).includes('__DSH_BOOT__')) return null;
    return state;
  } catch { return null; }
}
export async function desktopLaunch({ home = process.env.DSH_HOME || path.join(homedir(), '.dsh'), noOpen = false, port = 3080 } = {}) {
  assertDesktopNode();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口必须在 1–65535 之间');
  const modules = path.join(root, 'desktop-runtime/node_modules');
  const engine = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (engine.version !== desktopVersion) throw Error('桌面核心版本不匹配，请重新安装 desktop-runtime');
  home = path.resolve(home);
  const manifest = JSON.parse(await readFile(path.join(home, 'profiles/web/package.json'), 'utf8'));
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-codearts-auth', 'dsh-peer', 'dsh-desktop-chatgpt']) {
    if (!manifest.dsh?.profile?.bundles?.includes(name)) throw Error('电脑版尚未安装完整，请先执行 node scripts/install-desktop.mjs');
  }
  return {
    executable: process.execPath,
    args: ['--expose-internals', path.join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), ...(noOpen ? ['--no-open'] : [])],
    cwd: root, env: { ...process.env, DSH_HOME: home }, home, port,
  };
}

export async function startDesktop(options) {
  const plan = await desktopLaunch(options);
  const running = await runningDesktop(plan.home, plan.port);
  if (running) {
    if (!options?.noOpen) {
      const require = createRequire(path.join(root, 'desktop-runtime/package.json'));
      const { default: open } = await import(pathToFileURL(require.resolve('open')).href);
      await open(running.url);
    }
    console.log('电脑版 DSH 已在运行，已复用当前服务。');
    return 0;
  }
  const child = spawn(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['inherit', 'pipe', 'inherit'] });
  const file = desktopStatePath(plan.home, plan.port), instance = randomUUID();
  let output = '', recorded = false, pendingState = Promise.resolve();
  child.stdout.on('data', bytes => {
    process.stdout.write(bytes);
    output = (output + bytes.toString()).slice(-16384);
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
    if (!recorded && match && validLocalUrl(match[1], plan.port)) {
      recorded = true;
      pendingState = (async () => {
        const temp = file + '.' + instance;
        try {
          await writeFile(temp, JSON.stringify({ version: desktopVersion, home: plan.home, pid: child.pid, instance, url: match[1] }) + '\n', { mode: 0o600, flag: 'wx' });
          await rename(temp, file);
        } finally { await rm(temp, { force: true }); }
      })().catch(() => console.error('无法保存网页启动入口；请使用本终端打印的完整登录链接。'));
    }
  });
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 0 : 1)));
    });
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    await pendingState;
    try {
      const current = JSON.parse(await readFile(file, 'utf8'));
      if (current.instance === instance) await rm(file, { force: true });
    } catch (error) { if (!['ENOENT', 'SyntaxError'].includes(error.code || error.name)) throw error; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const flag = args.shift();
      if (flag === '--no-open') options.noOpen = true;
      else if (['--home', '--port'].includes(flag) && args[0] && !args[0].startsWith('--')) options[flag.slice(2)] = flag === '--port' ? Number(args.shift()) : args.shift();
      else throw Error('用法：node scripts/start-desktop.mjs [--home 目录] [--no-open] [--port 端口]');
    }
    process.exitCode = await startDesktop(options);
  } catch (error) { console.error(error.code === 'ENOENT' ? '请先按 desktop/README.md 安装电脑版。' : error.message); process.exitCode = 1; }
}
