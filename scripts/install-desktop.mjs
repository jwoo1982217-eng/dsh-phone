import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDesktopUpstream } from './install-desktop-upstream.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const desktopVersion = '0.2.1-alpha.1';

export function assertDesktopNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 24 || major === 24 && minor >= 11)) throw Error('含 Noema 的电脑版需要 Node.js 24.11+');
}

/** A new Web profile has no phone database, credentials or personal presets. */
export async function installDesktop({ home = process.env.DSH_HOME || path.join(homedir(), '.dsh'), legacyDesktop } = {}) {
  assertDesktopNode();
  const modules = path.join(root, 'desktop-runtime/node_modules');
  let version;
  try { version = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version; }
  catch (error) { if (error.code === 'ENOENT') throw Error('请先执行 npx --yes pnpm@10.34.6 --dir desktop-runtime install --frozen-lockfile'); throw error; }
  if (version !== desktopVersion) throw Error('桌面核心版本不匹配，请按锁文件重新安装 desktop-runtime');
  home = path.resolve(home);
  const profile = path.join(home, 'profiles/web'), manifestFile = path.join(profile, 'package.json');
  let fresh = false;
  try { await readFile(manifestFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const manifest = {
      name: 'dsh-profile-web', private: true,
      dependencies: {},
      dsh: { profile: { bundles: [
        '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
        '@deepseek-ai/dsh-experimental-agent-team-profile',
        '@deepseek-ai/dsh-experimental-auto-review',
        '@deepseek-ai/dsh-experimental-inspector-profile',
      ] } },
    };
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fresh = true;
    // Existing user overrides and custom presets are never reset during install.
    for (const file of ['cordis.yml', 'cordis.patch.yml']) {
      try { await writeFile(path.join(profile, file), '[]\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  const installed = await installDesktopUpstream(legacyDesktop, profile);
  return { ...installed, home, fresh, entry: path.join(root, 'scripts/start-desktop.mjs') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const flag = args.shift();
      if (!['--home', '--legacy-desktop'].includes(flag) || !args[0] || args[0].startsWith('--')) throw Error('用法：node scripts/install-desktop.mjs [--home 目录] [--legacy-desktop 旧电脑工程目录]');
      options[flag === '--home' ? 'home' : 'legacyDesktop'] = args.shift();
    }
    const result = await installDesktop(options);
    console.log(`电脑 DSH ${result.version} 已安装；账号、聊天、技能、配对与预设保留。\n启动：node scripts/start-desktop.mjs\n程序回退备份：${result.backup}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
