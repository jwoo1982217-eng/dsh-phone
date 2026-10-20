import { readFile, writeFile, mkdir, rename, rm, symlink, lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const pocketVersion = '2.10.6';

/** 初装自带 Pocket；已有用户安装的版本与启停配置保持原样。 */
export async function installDesktopPocket(profile, modules) {
  const manifestFile = path.join(profile, 'package.json');
  const original = await readFile(manifestFile, 'utf8'), manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('请选择已有 DSH Web profile');
  const target = path.join(profile, 'node_modules/dsh-pocket');
  if (manifest.dsh.profile.bundles.includes('dsh-pocket')) {
    try {
      const installed = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
      if (installed.name === 'dsh-pocket') return { profile, version: installed.version, preserved: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const source = path.resolve(modules, 'dsh-pocket');
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'dsh-pocket' || pkg.version !== pocketVersion) throw Error('请先按锁文件安装 Pocket 2.10.6');
  for (const file of ['cordis.patch.yml', 'lib/index.js', 'client/index.jsx']) await readFile(path.join(source, file));
  const require = createRequire(path.join(await realpath(source), 'package.json'));
  for (const dependency of ['qrcode', 'qrcode-terminal']) require.resolve(dependency);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = target + '.new-' + randomUUID(), backup = target + '.old-' + randomUUID();
  const temporary = manifestFile + '.pocket-' + randomUUID();
  let old = false, installed = false;
  try {
    await symlink(source, staging, process.platform === 'win32' ? 'junction' : 'dir');
    try { await lstat(target); await rename(target, backup); old = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staging, target); installed = true;
    manifest.dependencies = { ...manifest.dependencies, 'dsh-pocket': 'file:' + source };
    if (!manifest.dsh.profile.bundles.includes('dsh-pocket')) manifest.dsh.profile.bundles.push('dsh-pocket');
    if (await readFile(manifestFile, 'utf8') !== original) throw Error('Profile 在 Pocket 安装中变化，请重试');
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, manifestFile);
    if (old) await rm(backup, { recursive: true, force: true }).catch(() => {});
    return { profile, version: pocketVersion, preserved: false };
  } catch (error) {
    if (installed) await rm(target, { recursive: true, force: true });
    if (old) await rename(backup, target);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(temporary, { force: true });
  }
}
