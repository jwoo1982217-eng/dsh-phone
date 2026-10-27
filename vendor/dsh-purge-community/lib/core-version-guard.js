// Native patch recipes and .dshpurge.bak files are SDK-generation-specific.
// This gate does not certify arbitrary code signatures or port alpha recipes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const REVIEWED_NATIVE_SDK = '0.2.1-alpha.1';
const CODE = 'DSH_PURGE_CORE_VERSION_UNSUPPORTED';
function error(operation, detail) {
  const failure = new Error(`${operation}: native recipes/backups are reviewed only for DSH ${REVIEWED_NATIVE_SDK}; ${detail}. 当前 SDK 需要对应版本的适配，禁止跨版套用旧补丁或还原 .dshpurge.bak。已迁移的私有功能保留；未执行此次宿主写入。`);
  failure.code = CODE;
  return failure;
}
function manifestAt(file, operation) {
  let value;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a physical manifest');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw error(operation, 'the current package identity cannot be verified'); }
  if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(value?.name || '') || typeof value.version !== 'string') throw error(operation, 'the current package identity is unknown');
  if (value.version !== REVIEWED_NATIVE_SDK) throw error(operation, `${value.name} version ${JSON.stringify(value.version)} is not reviewed`);
  return { name: value.name, version: value.version };
}
/** Read-only early gate, before an Apply/Revert can prepare a new private copy. */
export function assertCurrentNativeRecipe(profile, operation = 'Apply') {
  let file;
  try { file = createRequire(profile.installAnchor).resolve('@deepseek-ai/dsh-app-boot/package.json'); }
  catch { throw error(operation, 'the launcher SDK identity cannot be resolved'); }
  const value = manifestAt(fs.realpathSync(file), operation);
  if (value.name !== '@deepseek-ai/dsh-app-boot') throw error(operation, 'the launcher SDK identity changed');
  return value;
}
/** Gate every native entry point independently, including directly imported recovery helpers. */
export function assertNativeRecipeBase(aiBase, operation = 'Native operation') {
  let entries;
  try {
    const stat = fs.lstatSync(aiBase);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a physical package root');
    entries = fs.readdirSync(aiBase, { withFileTypes: true });
  } catch { throw error(operation, 'the current private SDK package root is unavailable'); }
  const packages = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('dsh-')) continue;
    if (!/^dsh-[a-z0-9-]+$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw error(operation, 'the current private SDK contains an unknown or linked package');
    const value = manifestAt(path.join(aiBase, entry.name, 'package.json'), operation);
    if (value.name !== '@deepseek-ai/' + entry.name) throw error(operation, 'a private package identity does not match its directory');
    packages.push(value);
  }
  if (packages.length === 0) throw error(operation, 'no current private SDK package identity is available');
  return packages;
}
