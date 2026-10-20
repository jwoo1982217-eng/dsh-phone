import {cp, mkdir, readFile, writeFile, rename, rm, realpath, symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function installDesktopTeam(profile, modules) {
  const manifestPath = path.join(profile, 'package.json'), original = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('Profile 缺少组合包清单');
  if (JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version !== '0.2.1-alpha.1') throw Error('团队协作需要已验证的 DSH 0.2.1-alpha.1');
  if (manifest.dsh.profile.bundles.some(name => ['ds-bot', 'dsh-bot', 'deepseekbot'].includes(name))) throw Error('Profile 已启用其他 Bot 插件，请先选择一个团队插件，原团队数据不会删除');
  const locations = [modules];
  async function locate(name, required = true) {
    for (const location of [...locations]) {
      try {
        const found = await realpath(path.join(location, name));
        const parent = name.startsWith('@') ? path.dirname(path.dirname(found)) : path.dirname(found);
        if (!locations.includes(parent)) locations.push(parent);
        return found;
      } catch (error) {if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;}
    }
    if (required) throw Error('团队运行时缺少 ' + name);
  }
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-llm-deepseek', 'dsh-peer']) await locate(name, false);
  const deps = [];
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-mcp-client']) deps.push([name, await locate(name)]);
  const target = path.join(profile, 'node_modules/dsh-team'), staging = target + '.new-' + randomUUID(), backup = target + '.old-' + randomUUID(), tempManifest = manifestPath + '.team-' + randomUUID();
  let old = false, installed = false;
  try {
    await mkdir(path.dirname(target), {recursive: true});
    await cp(path.join(root, 'team'), staging, {recursive: true, filter: file => !file.includes('/node_modules') && !file.endsWith('.test.mjs')});
    for (const [name, location] of deps) {const link = path.join(staging, 'node_modules', name); await mkdir(path.dirname(link), {recursive: true}); await symlink(location, link, process.platform === 'win32' ? 'junction' : 'dir');}
    try {await rename(target, backup); old = true;} catch (error) {if (error.code !== 'ENOENT') throw error;}
    await rename(staging, target); installed = true;
    manifest.dependencies = {...manifest.dependencies, 'dsh-team': 'file:./node_modules/dsh-team'};
    if (!manifest.dsh.profile.bundles.includes('dsh-team')) manifest.dsh.profile.bundles.push('dsh-team');
    if (await readFile(manifestPath, 'utf8') !== original) throw Error('Profile 在团队安装中变化，请重试');
    await writeFile(tempManifest, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600}); await rename(tempManifest, manifestPath);
    if (old) await rm(backup, {recursive: true, force: true});
    return {plugin: target, version: '0.1.0', upstream: 'ds-bot@0.1.5'};
  } catch (error) {
    if (installed) await rm(target, {recursive: true, force: true});
    if (old) await rename(backup, target);
    throw error;
  } finally {await rm(staging, {recursive: true, force: true}); await rm(tempManifest, {force: true});}
}
