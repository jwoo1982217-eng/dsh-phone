import { readFile, readdir, mkdir, lstat, realpath, rename, symlink, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {withMigrationLock,recoverTransactions,runTransaction,snapshot,durableJson,contained} from './core-transaction.js';
import {preparePrivateSdkV2} from './private-sdk-v2.js';
import {prepareCompatibilityPackages} from './compatibility-packages.js';

async function manifest(directory) {
  try { return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}


/** Refresh only hash-recognized files in the active community private runtime.
 * Explicit file URLs bypass normal Node resolution. Preserve registered URLs,
 * private rewind patches and all unlisted files; an unknown edit fails closed.
 */
async function migratePrivateSdkV1(tree, home) {
  const root = path.join(home, 'profiles/phone/.dsh-purge-runtime');
  let current;
  try { current = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { locations: [] }; throw error; }
  if (current.owner !== 'dsh-purge-community-private-runtime-v1') return { locations: [] };
  if (current.phase !== 'installed' || !/^[A-Za-z0-9_-]+$/.test(current.token ?? '')) throw Error('Invalid active private SDK path/state');
  const plugin = path.join(tree, 'node_modules/dsh-phone-qq');
  const plan = JSON.parse(await readFile(path.join(plugin, 'private-sdk-patches.json'), 'utf8'));
  if (plan.version !== 1 || plan.sdkVersion !== '0.2.1-alpha.1' || !Array.isArray(plan.files)) throw Error('Invalid private SDK patch version');
  const active = path.join(root, current.token), modules = path.join(active, 'node_modules');
  const physicalHome = await realpath(home), physicalActive = await realpath(active);
  if (!physicalActive.startsWith(physicalHome + path.sep)) throw Error('Private SDK outside phone home');
  const hash = b => createHash('sha256').update(b).digest('hex');
  const pending = [], seen = new Set();
  for (const row of plan.files) {
    if (!/^@deepseek-ai\/dsh-(session|api-session-controller|client-ui-chat|client-ui-conversation)\//.test(row.relative) || row.relative.split('/').some(s => !s || s === '.' || s === '..') || seen.has(row.relative)) throw Error('Invalid private SDK patch path');
    seen.add(row.relative);
    const packageName = row.relative.split('/').slice(0,2).join('/');
    const metadata = await manifest(path.join(modules, packageName));
    if (metadata?.name !== packageName || metadata.version !== plan.sdkVersion) throw Error('Private SDK version mismatch: ' + packageName);
    const target = path.join(modules, row.relative);
    // Check the parent too: missing helper files must not follow an escaping link.
    const physicalParent = await realpath(path.dirname(target));
    if (!physicalParent.startsWith(physicalActive + path.sep)) throw Error('Private SDK file outside active runtime');
    let previous = null;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Private SDK patch requires a regular file');
      previous = hash(await readFile(target));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (row.variants.some(v => v.after === previous)) continue;
    const variant = row.variants.find(v => v.before === previous);
    if (!variant) throw Error('Unrecognized private SDK edit: ' + row.relative);
    const parts = /^(tree|plugin):(.+)$/.exec(variant.source);
    if (!parts || parts[2].split('/').some(s => !s || s === '.' || s === '..')) throw Error('Invalid private SDK source path');
    const source = path.join(parts[1] === 'tree' ? tree : plugin, parts[2]);
    const bytes = await readFile(source);
    if (hash(bytes) !== variant.after) throw Error('Private SDK source checksum mismatch: ' + row.relative);
    pending.push({ relative: row.relative, target, bytes, previous, after: variant.after });
  }
  if (!pending.length) return { locations: [] };
  const backup = path.join(home, '.phone-core-backups', 'private-sdk-' + randomUUID());
  await contained(home,path.relative(home,backup));
  await mkdir(path.join(backup, 'files'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(backup, 'restore.json'), JSON.stringify({ active: path.relative(home, active), files: pending.map(({relative, previous, after}) => ({relative, previous, after})) }, null, 2), { mode: 0o600 });
  const written = [];
  try {
    // Save every original before replacing the first file.
    for (const row of pending) if (row.previous !== null) {
      const saved = path.join(backup, 'files', row.relative);
      await mkdir(path.dirname(saved), { recursive: true, mode: 0o700 });
      await copyFile(row.target, saved);
      if (hash(await readFile(saved)) !== row.previous) throw Error('Private SDK changed during backup');
    }
    for (const row of pending) {
      let actual = null;
      try { actual = hash(await readFile(row.target)); } catch(error) { if(error.code !== 'ENOENT') throw error; }
      if (actual !== row.previous) throw Error('Private SDK changed during migration');
      const stage = row.target + '.upgrade-' + randomUUID();
      try {
        await writeFile(stage, row.bytes, { flag: 'wx', mode: 0o600 });
        await rename(stage, row.target); written.push(row);
      } finally { await rm(stage, { force: true }); }
    }
  } catch (error) {
    for (const row of written.reverse()) {
      if (row.previous === null) await rm(row.target, { force: true });
      else await copyFile(path.join(backup, 'files', row.relative), row.target);
    }
    throw error;
  }
  return { backup, locations: pending.map(row => path.relative(home, row.target)) };
}

async function privateContext(tree,home) {
  const currentFile=path.join(home,'profiles/phone/.dsh-purge-runtime/current.json');
  let bytes;try{bytes=await readFile(currentFile);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const stat=await lstat(currentFile);if(!stat.isFile()||stat.isSymbolicLink()||!(await realpath(path.dirname(currentFile))).startsWith((await realpath(home))+path.sep))throw Error('Private SDK state outside phone home or not regular');
  const current=JSON.parse(bytes);
  if(current.owner!=='dsh-purge-community-private-runtime-v1')return null;
  if(current.phase!=='installed'||!/^[A-Za-z0-9_-]+$/.test(current.token??''))throw Error('Invalid active private SDK path/state');
  const plugin=path.join(tree,'node_modules/dsh-phone-qq');
  const plan=JSON.parse(await readFile(path.join(plugin,'private-sdk-patches.json'),'utf8'));
  return{currentFile,current,plugin,plan,guard:{relative:path.relative(home,currentFile),sha256:createHash('sha256').update(bytes).digest('hex')}};
}
export async function migratePrivateSdk(tree,home){
  tree=path.resolve(tree);home=path.resolve(home);
  return withMigrationLock(tree,home,async()=>{
    await recoverTransactions(home);
    const p=await privateContext(tree,home);
    if(!p||p.plan.version!==2)return migratePrivateSdkV1(tree,home);
    const backup=path.join(home,'.phone-core-backups','private-sdk-'+randomUUID());
    const row=await preparePrivateSdkV2(tree,home,p.plugin,p.currentFile,p.current,p.plan,backup);
    if(!row)return{locations:[]};
    await runTransaction(home,backup,[row],[p.guard]);
    return{backup,locations:[row.target]};
  });
}

/** Old phone profiles contain copied SDK packages which shadow the new tree.
 * Keep recoverable copies, and resolve only shipped official packages to the
 * current deployment. User plugins and all account/session files stay in place.
 */
async function migratePhoneCoreUnlocked(tree, home) {
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
        backupRelative: path.join(base, name), before:await snapshot(target) });
    }
  }
  const p=await privateContext(tree,home);
  let deploymentPlan=p?.plan;
  if(!deploymentPlan){try{deploymentPlan=JSON.parse(await readFile(path.join(tree,'node_modules/dsh-phone-qq/private-sdk-patches.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  const backup=path.join(home,'.phone-core-backups',core.version+'-'+randomUUID());
  const privateRow=p?.plan.version===2?await preparePrivateSdkV2(tree,home,p.plugin,p.currentFile,p.current,p.plan,backup):null;
  const privateSdk=p?.plan.version===2?{locations:privateRow?[privateRow.target]:[]}:await migratePrivateSdkV1(tree,home);
  const compatibilityRows=await prepareCompatibilityPackages(tree,home,deploymentPlan,backup);
  if(!planned.length&&!privateRow&&!compatibilityRows.length)return{version:core.version,migrated:[],...privateSdk};
  await contained(home,path.relative(home,backup));await mkdir(backup,{recursive:true,mode:0o700});
  const rows=[...(privateRow?[privateRow]:[]),...compatibilityRows];
  for(let index=0;index<planned.length;index++){
    const row=planned[index],stage='stage/projection-'+index;
    await mkdir(path.dirname(path.join(backup,stage)),{recursive:true,mode:0o700});
    await symlink(row.source,path.join(backup,stage),'dir');
    rows.push({target:path.relative(home,row.target),saved:row.backupRelative,stage,before:row.before,after:await snapshot(path.join(backup,stage))});
  }
  await durableJson(path.join(backup,'restore.json'),planned);
  await runTransaction(home,backup,rows,p?.plan.version===2?[p.guard]:[]);
  return{version:core.version,backup,migrated:[...new Set(planned.map(row=>row.name))],locations:[...planned.map(row=>row.backupRelative),...privateSdk.locations,...compatibilityRows.map(row=>row.target)]};
}
export async function migratePhoneCore(tree,home){
  tree=path.resolve(tree);home=path.resolve(home);
  return withMigrationLock(tree,home,async()=>{await recoverTransactions(home);return migratePhoneCoreUnlocked(tree,home);});
}

// Node canonicalizes the module URL but preserves the launch path in argv.
// Android may expose the same app directory through /data/data and
// /data/user/0, so compare physical paths before deciding this is the CLI.
const entrypoint = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  if (!process.env.DSH_HOME) throw Error('DSH_HOME required');
  console.log(JSON.stringify({ phoneCoreMigration: await migratePhoneCore(process.cwd(), process.env.DSH_HOME) }));
}
