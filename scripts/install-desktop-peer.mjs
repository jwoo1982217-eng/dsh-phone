import { mkdir, readFile, writeFile, rename, rm, cp, symlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function installDesktopPeer(profile, modules) {
  profile = path.resolve(profile); modules = path.resolve(modules);
  const manifestPath = path.join(profile, 'package.json');
  const original = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('请选择已有 DSH profile，目录内须有 dsh.profile.bundles');
  const engine = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (engine.version !== '0.2.1-alpha.1') throw Error('当前远程插件适配 DSH 0.2.1-alpha.1；请使用匹配的桌面运行时');
  // pnpm desktops normally expose only the CLI at the project root. Locate
  // its transitive bundle dependencies in their real pnpm package trees.
  const locations = [modules];
  async function locate(name, required = true) {
    for (const location of [...locations]) {
      try {
        const found = await realpath(path.join(location, name));
        const dependencyDirectory = name.startsWith('@') ? path.dirname(path.dirname(found)) : path.dirname(found);
        if (!locations.includes(dependencyDirectory)) locations.push(dependencyDirectory);
        return found;
      } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
    }
    if (required) throw Error(`桌面运行时缺少 ${name}`);
  }
  await locate('@deepseek-ai/dsh');
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-client-connection']) await locate(name, false);
  const dependencies = ['eventsource-parser', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-timeout', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-launch-environment', '@deepseek-ai/dsh-anonymous-user-id', 'ws', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-llm-deepseek', '@modelcontextprotocol/client', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-subprocess'];
  const resolved = await Promise.all(dependencies.map(async name => [name, await locate(name)]));
  const target = path.join(profile, 'node_modules/dsh-peer'), staging = target + '.new-' + randomUUID(), backup = target + '.old-' + randomUUID();
  const temporaryManifest = manifestPath + '.peer-' + randomUUID();
  await mkdir(path.dirname(target), { recursive: true });
  let old = false, installed = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    const files = ['package.json', 'cordis.patch.yml', 'index.mjs', 'protocol.mjs', 'relay.mjs', 'tunnel.mjs', 'proxy.mjs', 'ui-reuse.mjs', 'browser-session.mjs', 'config-sync.mjs', 'page.html'];
    for (const name of files) await cp(path.join(root, 'peer', name), path.join(staging, name));
    await cp(path.join(root, 'peer/vendor'), path.join(staging, 'vendor'), { recursive: true });
    await cp(path.join(root, 'peer/agent-cards'), path.join(staging, 'agent-cards'), { recursive: true });
    await cp(path.join(root, 'peer/chat-history'), path.join(staging, 'chat-history'), { recursive: true });
    await cp(path.join(root, 'peer/memory-isolation'), path.join(staging, 'memory-isolation'), { recursive: true });
    await cp(path.join(root, 'peer/mcp-manager'), path.join(staging, 'mcp-manager'), { recursive: true });
    await cp(path.join(root, 'peer/controlled-market'), path.join(staging, 'controlled-market'), { recursive: true });
    await cp(path.join(root, 'peer/workflow-hub'), path.join(staging, 'workflow-hub'), { recursive: true });
    for (const [source, dest] of [['app/src/main/assets/dsh-phone.css', 'presentation.css'], ['app/src/main/assets/dsh-phone.js', 'presentation.js'], ['app/src/main/assets/dsh-phone.compat.js', 'browser-compat.js'], ['phone-qq/skill-import.js', 'skill-import.js']]) await cp(path.join(root, source), path.join(staging, dest));
    for (const [name, location] of resolved) { const link = path.join(staging, 'node_modules', name); await mkdir(path.dirname(link), { recursive: true }); await symlink(location, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    try { await rename(target, backup); old = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rename(staging, target); installed = true;
    manifest.dependencies = { ...manifest.dependencies, 'dsh-peer': 'file:./node_modules/dsh-peer' };
    if (!manifest.dsh.profile.bundles.includes('dsh-peer')) manifest.dsh.profile.bundles.push('dsh-peer');
    // Preserve concurrent profile edits rather than overwriting them.
    if (await readFile(manifestPath, 'utf8') !== original) throw Error('Profile 在安装中变化，请重新运行');
    await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await rename(temporaryManifest, manifestPath);
    if (old) await rm(backup, { recursive: true, force: true });
    return { profile, plugin: target, page: 'http://127.0.0.1:3080/phone-peer' };
  } catch (e) {
    if (installed) await rm(target, { recursive: true, force: true });
    if (old) await rename(backup, target);
    throw e;
  } finally { await rm(staging, { recursive: true, force: true }); await rm(temporaryManifest, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = process.argv[2] || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'profiles/web');
  const modules = process.argv[3] || path.join(process.cwd(), 'node_modules');
  try { console.log(JSON.stringify(await installDesktopPeer(profile, modules))); console.log('安装完成。下次启动此 profile 后打开设备连接页；当前 DSH 进程不会被重启。'); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
