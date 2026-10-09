import { readFile, readdir, mkdir, lstat, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

async function manifest(directory) {
  try { return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Old phone profiles contain copied SDK packages which shadow the new tree.
 * Keep recoverable copies, and resolve only shipped official packages to the
 * current deployment. User plugins and all account/session files stay in place.
 */
export async function migratePhoneCore(tree, home) {
  tree = path.resolve(tree); home = path.resolve(home);
  const modules = path.join(tree, 'node_modules');
  const core = await manifest(path.join(modules, '@deepseek-ai/dsh'));
  if (!core?.version) throw Error('Phone core manifest missing');
  const shippedScope = path.join(modules, '@deepseek-ai');
  const shippedPackages = new Map();
  for (const entry of (await readdir(shippedScope)).sort()) {
    const name = '@deepseek-ai/' + entry, source = path.join(shippedScope, entry);
    const shipped = await manifest(source);
    if (!shipped || shipped.name !== name) continue;
    if ((entry === 'dsh' || entry.startsWith('dsh-')) && shipped.version !== core.version) {
      throw Error('Phone SDK version mismatch: ' + name + '@' + shipped.version);
    }
    shippedPackages.set(name, { source, canonical: await realpath(source), shipped });
  }
  const planned = [];
  const canonicalHome = await realpath(home);
  const visitedScopes = new Set([await realpath(shippedScope)]);
  // Older releases also projected SDK packages into the shared profiles
  // directory. Node searches it before home/node_modules, so those copies
  // can shadow the deployment even when the active profile is clean.
  for (const base of ['profiles/phone/node_modules', 'profiles/node_modules', 'node_modules']) {
    const scope = path.join(home, base, '@deepseek-ai');
    let entries;
    try { entries = await readdir(scope); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const canonicalScope = await realpath(scope);
    if (visitedScopes.has(canonicalScope)) continue;
    if (!canonicalScope.startsWith(canonicalHome + path.sep)) {
      throw Error('Cannot safely migrate SDK directory outside phone home');
    }
    visitedScopes.add(canonicalScope);
    for (const entry of entries.sort()) {
      const name = '@deepseek-ai/' + entry, supplied = shippedPackages.get(name);
      if (!supplied) continue;
      const target = path.join(scope, entry), stat = await lstat(target);
      // /data/data and /data/user/0 may name the same Android directory.
      const current = await realpath(target).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      if (current === supplied.canonical) continue;
      const installed = await manifest(target);
      if ((!installed || installed.name !== name) && !(stat.isSymbolicLink() && current === null)) {
        throw Error('Cannot safely migrate SDK package ' + name);
      }
      planned.push({ name, target, source: supplied.source, previousVersion: installed?.version ?? null,
        backupRelative: path.join(base, name) });
    }
  }
  if (!planned.length) return { version: core.version, migrated: [] };
  const backup = path.join(home, '.phone-core-backups', core.version + '-' + randomUUID());
  await mkdir(backup, { recursive: true, mode: 0o700 });
  // Save the complete plan before moving anything so interrupted upgrades are recoverable.
  await writeFile(path.join(backup, 'restore.json'), JSON.stringify(planned, null, 2), { mode: 0o600 });
  for (const row of planned) {
    const saved = path.join(backup, row.backupRelative);
    await mkdir(path.dirname(saved), { recursive: true, mode: 0o700 });
    await rename(row.target, saved);
    try { await symlink(row.source, row.target, 'dir'); }
    catch (error) { await rename(saved, row.target); throw error; }
  }
  return { version: core.version, migrated: [...new Set(planned.map(row => row.name))], locations: planned.map(row => row.backupRelative) };
}

// Node canonicalizes the module URL but preserves the launch path in argv.
// Android may expose the same app directory through /data/data and
// /data/user/0, so compare physical paths before deciding this is the CLI.
const entrypoint = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  if (!process.env.DSH_HOME) throw Error('DSH_HOME required');
  console.log(JSON.stringify({ phoneCoreMigration: await migratePhoneCore(process.cwd(), process.env.DSH_HOME) }));
}
