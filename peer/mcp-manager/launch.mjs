import path from 'node:path';
import fs from 'node:fs';

const nativePackage = value => value?.match(/^\/data\/app\/(?:[^/]+\/)*([A-Za-z0-9_.]+)-[^/]+\/lib\/[^/]+(?:\/libnode\.so)?$/)?.[1];
function currentAndroidNode(runtime) {
  if(runtime.env.DSH_PHONE_ANDROID !== '1' || !nativePackage(runtime.execPath)) return null;
  // This stable link is refreshed by NodeRunner.prepareEnvironment at startup.
  const node = runtime.env.DSH_PHONE_FILES ? fs.realpathSync(path.join(runtime.env.DSH_PHONE_FILES,'bin/node')) : runtime.execPath;
  if(nativePackage(node) !== nativePackage(runtime.execPath)) throw Error('内置 Node 入口与当前应用不一致，请重启 DSH');
  return node;
}

// Only a path prefix is expanded; no shell or general environment substitution.
export function expandHome(value, home) {
  if (typeof value !== 'string') return value;
  return value.replace(/^(?:\$DSH_HOME|\$\{DSH_HOME\})(?=\/|$)/, () => home);
}
export function stdioLaunch(row, home, runtime = process) {
  let command = expandHome(row.command, home);
  const node = currentAndroidNode(runtime);
  // Android changes /data/app/<install-id>/lib on each APK replacement.
  // An external Termux node or another app's executable is never substituted.
  const installedPackage = nativePackage(node), commandPackage = nativePackage(command);
  const linkedNode = node && path.isAbsolute(command) && fs.existsSync(command) && fs.realpathSync(command) === node;
  if (node && (command === 'node' || linkedNode || command.endsWith('/libnode.so') && commandPackage === installedPackage)) {
    command = node;
  }
  return { command, args: (row.args || []).map(x => expandHome(x, home)), cwd: expandHome(row.cwd, home) };
}
export function stdioEnvironment(launch, parent, explicit, runtime = process) {
  const env = {...parent, ...explicit}, node = currentAndroidNode(runtime);
  if(!node || launch.command !== node) return env;
  const pkg = nativePackage(node), libDir = path.dirname(node);
  // Explicit saved env used to override the fresh launcher env with a deleted
  // APK directory. Repair only our native paths, retaining every other entry.
  const others = (env.LD_LIBRARY_PATH || '').split(':').filter(x => x && nativePackage(x) !== pkg);
  env.LD_LIBRARY_PATH = [libDir, ...others].join(':');
  return env;
}
export function launchNotice(row, home) {
  if (row.transport !== 'stdio') return '';
  const launch = stdioLaunch(row, home), tree = path.resolve(home, '../tree');
  const files = [launch.command, launch.cwd, ...launch.args].filter(x => typeof x === 'string' && path.isAbsolute(x));
  if (files.some(x => x === tree || x.startsWith(tree + path.sep))) return '启动文件位于程序目录；安卓升级会尝试迁移独立扩展，请保留扩展原包。核心代码补丁需要适配。';
  if (files.some(x => x.startsWith(path.join(home, 'extensions') + path.sep))) return '扩展保存在用户目录，覆盖升级保留；卸载或清除应用数据仍会删除。';
  return '';
}
