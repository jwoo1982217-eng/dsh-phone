import { readFile, writeFile, mkdir, readdir, lstat, realpath, symlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { checkManifest, boundedResponse, artifactUrl } from './trials.mjs';
import { packageName, version, protectedName } from './catalog.mjs';

export async function runPackageManager(executable, cli, stage, env, timeout = 240000) {
  const child = spawn(executable, [cli, 'install', '--prod', '--ignore-scripts', '--ignore-pnpmfile', '--ignore-workspace', '--no-frozen-lockfile', '--reporter=append-only', '--registry=https://registry.npmjs.org', '--config.fetch-retries=1', '--config.fetch-timeout=20000'],
    { cwd: stage, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', cancelled = false, force;
  const cancel = () => { cancelled = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} force ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000); };
  const timer = setTimeout(cancel, timeout); process.once('SIGTERM', cancel);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-4000); });
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 && !cancelled ? resolve() : reject(Error(cancelled ? '插件安装超时或取消，未启用新插件' : '依赖安装失败：' + diagnostics.slice(-1500)))); });
  } finally {
    if (cancelled) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    clearTimeout(timer); clearTimeout(force); process.removeListener('SIGTERM', cancel);
  }
}
async function inspectPackages(modules, hostVersion) {
  let files = 0, bytes = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++files > 100000) throw Error('插件依赖文件过多');
      const name = path.join(directory, entry.name), stat = await lstat(name);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(name);
      else if (stat.isFile()) {
        bytes += stat.size; if (bytes > 1024 * 1024 * 1024) throw Error('插件依赖超过 1 GB 限制');
        if (entry.name === 'package.json' && (path.basename(directory) === 'node_modules' || path.basename(path.dirname(directory)) === 'node_modules' || path.basename(path.dirname(path.dirname(directory))) === 'node_modules')) {
          const manifest = JSON.parse(await readFile(name, 'utf8'));
          if (manifest.name?.startsWith('@deepseek-ai/dsh') && manifest.version !== hostVersion) throw Error('依赖包含其他版本的 DSH 核心，未启用插件');
          if (manifest.os?.includes('!android')) throw Error('依赖明确排除 Android');
        }
      }
    }
  }
  await walk(modules);
}

/** Native carrier owns stop/backup/restart. This script never imports downloaded plugin code. */
export async function installTrial(plan, { home, tree, node = process.execPath, fetchImpl = fetch, packageManager = runPackageManager } = {}) {
  if (!packageName(plan?.name) || !version(plan.version) || protectedName(plan.name) || !['npm', 'github'].includes(plan.source)) throw Error('试装计划无效');
  artifactUrl(plan.download, plan.source);
  if (plan.source === 'npm' && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(plan.integrity ?? '')) throw Error('插件完整性校验无效');
  home = await realpath(home); tree = await realpath(tree);
  const sdk = JSON.parse(await readFile(path.join(tree, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  if (sdk.version !== plan.hostVersion) throw Error('手机核心已变化，请重新选择插件');
  const profile = path.join(home, 'profiles/phone');
  if ((await realpath(profile)) !== profile) throw Error('插件目录不能指向其他工作区');
  const manifestPath = path.join(profile, 'package.json'), original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('手机插件配置无效，请先恢复环境');
  const root = path.join(profile, 'market-plugins'); await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await realpath(root)) !== root) throw Error('插件安装目录无效');
  const stage = path.join(root, randomUUID()); await mkdir(stage, { mode: 0o700 });
  let completed = false;
  try {
    const archive = await boundedResponse(await fetchImpl(plan.download, { redirect: 'error', signal: AbortSignal.timeout(60000) }), 64 * 1024 * 1024);
    if (plan.source === 'npm' && 'sha512-' + createHash('sha512').update(archive).digest('base64') !== plan.integrity) throw Error('插件下载校验失败，未安装');
    const archivePath = path.join(stage, 'plugin.tgz'); await writeFile(archivePath, archive, { mode: 0o600 });
    const overrides = {};
    for (const entry of await readdir(path.join(tree, 'node_modules/@deepseek-ai'))) {
      // Reuse the shipped SDK by canonical path; never install another runtime generation.
      overrides['@deepseek-ai/' + entry] = 'link:' + path.join(tree, 'node_modules/@deepseek-ai', entry);
    }
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'dsh-phone-trial', private: true, dependencies: { [plan.name]: 'file:./plugin.tgz' }, pnpm: { overrides } }));
    await writeFile(path.join(stage, 'pnpm-workspace.yaml'), 'packages: []\nnodeLinker: hoisted\nautoInstallPeers: false\nstrictPeerDependencies: false\npackageImportMethod: copy\nmanagePackageManagerVersions: false\n');
    await writeFile(path.join(stage, '.npmrc'), 'registry=https://registry.npmjs.org\n');
    const isolatedHome = path.join(stage, '.installer-home'); await mkdir(isolatedHome);
    const env = Object.fromEntries(['PATH', 'LD_LIBRARY_PATH', 'OPENSSL_CONF', 'TMPDIR', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome, XDG_CACHE_HOME: isolatedHome, npm_config_userconfig: path.join(stage, '.npmrc'), CI: 'true' });
    await packageManager(node, path.join(tree, 'tools/pnpm/dist/pnpm.cjs'), stage, env);
    const modules = path.join(stage, 'node_modules'), installed = path.join(modules, plan.name);
    const actual = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    if (actual.name !== plan.name || actual.version !== plan.version) throw Error('下载内容与已确认的插件不一致');
    const patches = checkManifest(actual, sdk.version);
    for (const patch of patches) {
      const file = path.join(installed, patch), resolved = await realpath(file).catch(() => null);
      if (!resolved || !resolved.startsWith((await realpath(installed)) + path.sep) || !(await lstat(resolved)).isFile()) throw Error('插件没有可用的构建产物，需要作者提供可直接运行的发布版本');
    }
    await inspectPackages(modules, sdk.version);
    if (await readFile(manifestPath, 'utf8') !== original) throw Error('安装期间插件配置变化，请重新试装');
    const target = path.join(profile, 'node_modules', plan.name); await mkdir(path.dirname(target), { recursive: true });
    const parent = await realpath(path.dirname(target));
    if (!parent.startsWith(profile + path.sep)) throw Error('插件入口不能覆盖内置运行树');
    const temporary = target + '.' + randomUUID(); await symlink(path.relative(parent, installed), temporary, 'dir');
    await rm(target, { recursive: true, force: true }); await rename(temporary, target);
    manifest.dependencies ??= {}; manifest.dependencies[plan.name] = 'file:./market-plugins/' + path.basename(stage) + '/plugin.tgz';
    if (!manifest.dsh.profile.bundles.includes(plan.name)) manifest.dsh.profile.bundles.push(plan.name);
    const next = manifestPath + '.' + randomUUID(); await writeFile(next, JSON.stringify(manifest, null, 2), { mode: 0o600 }); await rename(next, manifestPath);
    const receipt = { ...plan, archiveSha256: createHash('sha256').update(archive).digest('hex'), installedAt: Date.now() };
    await writeFile(path.join(stage, 'trial-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    completed = true; return { name: plan.name, version: plan.version };
  } finally { if (!completed) await rm(stage, { recursive: true, force: true }); }
}
const entrypoint = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const result = await installTrial(plan, { home: process.env.DSH_HOME, tree: process.cwd() });
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) { console.log(JSON.stringify({ ok: false, message: error.message })); process.exitCode = 1; }
}
