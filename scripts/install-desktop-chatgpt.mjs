import { readFile, mkdir, cp, symlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function installDesktopChatGpt(profile, modules) {
  profile = path.resolve(profile); modules = path.resolve(modules);
  const manifestFile = path.join(profile, 'package.json'), original = await readFile(manifestFile, 'utf8'), manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('请选择已有 DSH profile');
  const engine = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (engine.version !== '0.2.1-alpha.1') throw Error('此插件适配 DSH 0.2.1-alpha.1，请先验证其他核心版本');
  const locations = [modules];
  async function locate(name, required = true) {
    for (const location of [...locations]) {
      try { const found = await realpath(path.join(location, name)); const parent = name.startsWith('@') ? path.dirname(path.dirname(found)) : path.dirname(found); if (!locations.includes(parent)) locations.push(parent); return found; }
      catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
    }
    if (required) throw Error(`桌面运行时缺少 ${name}`);
  }
  await locate('@deepseek-ai/dsh');
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-client-connection']) await locate(name, false);
  const dependencies = await Promise.all(['@deepseek-ai/schemastery', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-llm'].map(async name => [name, await locate(name)]));
  const target = path.join(profile, 'node_modules/dsh-desktop-chatgpt'), staging = target + '.new-' + randomUUID(), backup = target + '.old-' + randomUUID(), temporary = manifestFile + '.chatgpt-' + randomUUID();
  let old = false, installed = false;
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const name of ['package.json', 'cordis.patch.yml', 'index.mjs']) await cp(path.join(root, 'desktop-chatgpt', name), path.join(staging, name));
    for (const name of ['chatgpt.js', 'chatgpt-page.html', 'chatgpt-account.js', 'chatgpt-protocol.js', 'chatgpt-adapter.js']) await cp(path.join(root, 'phone-account', name), path.join(staging, name));
    for (const [name, found] of dependencies) { const link = path.join(staging, 'node_modules', name); await mkdir(path.dirname(link), { recursive: true }); await symlink(found, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    try { await rename(target, backup); old = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rename(staging, target); installed = true;
    manifest.dependencies = { ...manifest.dependencies, 'dsh-desktop-chatgpt': 'file:./node_modules/dsh-desktop-chatgpt' };
    if (!manifest.dsh.profile.bundles.includes('dsh-desktop-chatgpt')) manifest.dsh.profile.bundles.push('dsh-desktop-chatgpt');
    if (await readFile(manifestFile, 'utf8') !== original) throw Error('Profile 在安装中变化，请重试');
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, manifestFile);
    if (old) await rm(backup, { recursive: true, force: true });
    return { profile, plugin: target, page: 'http://127.0.0.1:3080/phone-chatgpt' };
  } catch (e) { if (installed) await rm(target, { recursive: true, force: true }); if (old) await rename(backup, target); throw e; }
  finally { await rm(staging, { recursive: true, force: true }); await rm(temporary, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await installDesktopChatGpt(process.argv[2], process.argv[3]))); console.log('下次启动此 profile 后使用电脑 ChatGPT 会员入口。'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
