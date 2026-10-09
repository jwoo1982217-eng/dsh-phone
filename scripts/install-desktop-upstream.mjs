import { readFile, writeFile, mkdir, cp, rename, symlink, rm, lstat, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { installDesktopPeer } from './install-desktop-peer.mjs';
import { installDesktopChatGpt } from './install-desktop-chatgpt.mjs';
import { installDesktopPocket } from './install-desktop-pocket.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** 部署已验证的新核心，保留原插件源码和可恢复的启动入口。 */
export async function installDesktopUpstream(desktop, profile) {
  // Every profile uses the same pinned runtime. Serialize its file updates,
  // including installers running in separate terminals or test processes.
  const lock = path.join(root, 'desktop-runtime/.install-lock');
  const deadline = Date.now() + 20000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw Error('另一个电脑安装器尚未完成；请等待它结束后重试');
      await delay(100);
    }
  }
  try { return await installDesktopUpstreamUnlocked(desktop, profile); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function installDesktopUpstreamUnlocked(desktop, profile) {
  desktop = desktop ? path.resolve(desktop) : null; profile = path.resolve(profile);
  const modules = path.join(root, 'desktop-runtime/node_modules');
  const version = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version;
  if (version !== '0.2.1-alpha.1') throw Error('请先安装锁定的桌面运行时');
  const manifestPath = path.join(profile, 'package.json');
  const original = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('请选择包含 dsh.profile.bundles 的 Web profile');
  manifest.dependencies ??= {};
  const expected = JSON.parse(await readFile(path.join(root, 'desktop-chatgpt/upstream-source-hashes.json'), 'utf8'));
  const currentJetHub = path.join(profile, 'node_modules/dsh-codearts-auth');
  let hasJetHub = false;
  try { await lstat(currentJetHub); hasJetHub = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hasJetHub) for (const entry of expected.files) {
    const digest = hash(await readFile(path.join(currentJetHub, entry.path)));
    if (![entry.old, entry.new, entry.rotation, entry.upstreamRc3].includes(digest)) throw Error(`Jet Hub 的 ${entry.path} 有其他修改，请先合并兼容改动`);
  }
  const backup = path.join(profile, '.upstream-rollback-' + randomUUID());
  await mkdir(backup, { mode: 0o700 });
  await writeFile(path.join(backup, 'package.json'), original, { mode: 0o600 });
  const swapped = [], copied = [];
  // 子安装器会替换本地自带插件，先保留完整副本，失败时连同清单一起恢复。
  for (const name of ['dsh-peer', 'dsh-desktop-chatgpt', 'dsh-pocket']) {
    const target = path.join(profile, 'node_modules', name), saved = path.join(backup, name);
    let existed = false;
    try { await lstat(target); await cp(target, saved, { recursive: true }); existed = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    copied.push({ target, saved, existed });
  }
  const launcher = desktop ? path.join(desktop, 'node_modules/.bin/dsh') : null;
  if (launcher) await cp(launcher, path.join(backup, 'dsh-launcher'));
  const record = { profile, swapped, copied, launcher };
  const saveRecord = () => writeFile(path.join(backup, 'restore.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  await saveRecord();
  const swap = async (target, source) => {
    const saved = path.join(backup, String(swapped.length));
    let existed = false;
    try { await lstat(target); await rename(target, saved); existed = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    swapped.push({ target, saved, existed });
    await mkdir(path.dirname(target), { recursive: true });
    await saveRecord();
    await symlink(source, target);
  };
  try {
    // 核心会优先从自身安装目录解析组合包，部署时同步已审核的本地程序。
    for (const [name, source] of [['dsh-codearts-auth', 'vendor/dsh-codearts-auth'], ['@zseven-w/dsh-noema', 'vendor/dsh-noema'], ['dsh-peer', 'peer']]) {
      for (const entry of ['package.json', 'cordis.patch.yml', 'lib', 'src', 'locale', 'vendor', 'agent-cards', 'chat-history', 'memory-isolation', 'mcp-manager', 'controlled-market', 'workflow-hub', 'index.mjs', 'protocol.mjs', 'relay.mjs', 'tunnel.mjs', 'proxy.mjs', 'ui-reuse.mjs', 'browser-session.mjs', 'config-sync.mjs', 'page.html', 'presentation.css', 'presentation.js', 'browser-compat.js', 'skill-import.js']) {
        const file = path.join(root, source, entry);
        try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const deployed = path.join(modules, name, entry);
        if (name === 'dsh-codearts-auth') {
          const temporary = deployed + '.jethub-' + randomUUID();
          try {
            await cp(file, temporary, { recursive: true });
            await rm(deployed, { recursive: true, force: true });
            await rename(temporary, deployed);
          } finally { await rm(temporary, { recursive: true, force: true }); }
          continue;
        }
        await cp(file, deployed, { recursive: true, filter: async (from, to) => {
          try { const a = await stat(from), b = await stat(to); return a.dev !== b.dev || a.ino !== b.ino; }
          catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        } });
      }
    }
    // 新核心的移动适配均以本版源码为基线；桌面仍走原生分支。
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(path.join(root, 'runtime/overlays/@deepseek-ai'))) {
      await cp(path.join(root, 'runtime/overlays/@deepseek-ai', name), path.join(modules, '@deepseek-ai', name), { recursive: true });
    }
    for (const name of ['dsh-codearts-auth', '@zseven-w/dsh-noema']) {
      await swap(path.join(profile, 'node_modules', name), path.join(modules, name));
      manifest.dependencies[name] = 'file:' + path.join(modules, name);
      if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name);
    }
    if (await readFile(manifestPath, 'utf8') !== original) throw Error('安装期间 Profile 有其他修改');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await installDesktopPeer(profile, modules);
    await installDesktopChatGpt(profile, modules);
    await installDesktopPocket(profile, modules);
    if (desktop) {
      const source = path.join(modules, '@deepseek-ai/dsh');
      const target = path.join(desktop, 'node_modules/@deepseek-ai/dsh');
      // Never replace the canonical runtime with a symlink to itself.
      if (path.resolve(target) !== path.resolve(source)) await swap(target, source);
      await writeFile(launcher, '#!/bin/sh\nexec node "$(dirname "$0")/../@deepseek-ai/dsh/lib/bin.js" "$@"\n', { mode: 0o755 });
    }
    await saveRecord();
    return { version, profile, backup };
  } catch (error) {
    await restoreDesktopUpstream(backup);
    throw error;
  }
}

/** 仅恢复安装入口与程序；用户会话的格式回退须使用升级前数据备份。 */
export async function restoreDesktopUpstream(backup) {
  const record = JSON.parse(await readFile(path.join(backup, 'restore.json'), 'utf8'));
  for (const { target, saved, existed } of [...record.swapped].reverse()) {
    await rm(target, { recursive: true, force: true });
    if (existed) await rename(saved, target);
  }
  for (const { target, saved, existed } of record.copied) {
    await rm(target, { recursive: true, force: true });
    if (existed) await cp(saved, target, { recursive: true });
  }
  if (record.launcher) await cp(path.join(backup, 'dsh-launcher'), record.launcher);
  await writeFile(path.join(record.profile, 'package.json'), await readFile(path.join(backup, 'package.json')), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await installDesktopUpstream(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
