import { installNativeLockFixture } from './migration.test-support.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, readdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { migratePhoneCore } from './core-migration.js';
const sha = b => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), '完整 closure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tree = root + '/tree', home = root + '/home', active = home + '/profiles/phone/.dsh-purge-runtime/one', plugin = tree + '/node_modules/dsh-phone-qq', current = active + '/../current.json';
    const put = async (f, b) => { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, b); };
    const pkg = (name, version, dependencies = {}) => JSON.stringify({ name, version, type: 'module', main: 'index.js', dependencies });
    await put(tree + '/node_modules/@deepseek-ai/dsh/package.json', pkg('@deepseek-ai/dsh', '0.2.1-rc.2'));
    const old = { '@deepseek-ai/dsh-session/package.json': pkg('@deepseek-ai/dsh-session', '0.2.1-alpha.1'), '@deepseek-ai/dsh-session/index.js': 'export const version="old-rewind";', '@deepseek-ai/dsh-session/original.bak': 'original bytes' };
    const next = { '@deepseek-ai/dsh-session/package.json': pkg('@deepseek-ai/dsh-session', '0.2.1-rc.2', { 'helper': '1.0.0' }), '@deepseek-ai/dsh-session/index.js': 'import {value} from "helper"; export const version="new-rewind-"+value;', 'helper/package.json': pkg('helper', '1.0.0'), 'helper/index.js': 'export const value="closure";' };
    for (const [r, b] of Object.entries(old))
        await put(active + '/node_modules/' + r, b);
    for (const [r, b] of Object.entries(next))
        await put(tree + '/node_modules/' + r, b);
    const state = JSON.stringify({ owner: 'dsh-purge-community-private-runtime-v1', token: 'one', phase: 'installed', privateEntry: pathToFileURL(active + '/node_modules/@deepseek-ai/dsh-session/index.js').href });
    await put(current, state);
    const plan = { version: 2, sdkVersion: '0.2.1-rc.2', baselines: [{ id: 'fixture-alpha', files: Object.entries(old).map(([relative, b]) => ({ relative, sha256: sha(b) })) }], files: Object.entries(next).map(([relative, b]) => ({ relative, sha256: sha(b), source: 'tree:node_modules/' + relative })), packages: [{ relative: '@deepseek-ai/dsh-session', name: '@deepseek-ai/dsh-session', version: '0.2.1-rc.2' }, { relative: 'helper', name: 'helper', version: '1.0.0' }] };
    const save = () => put(plugin + '/private-sdk-patches.json', JSON.stringify(plan));
    await save();
    await put(home + '/profiles/phone/node_modules/@deepseek-ai/dsh-session/package.json', pkg('@deepseek-ai/dsh-session', '0.2.1-alpha.1'));
    await put(home + '/sessions/keep', 'personal');
    await installNativeLockFixture(tree);
    return { root, tree, home, active, plugin, current, state, plan, save, put, old, next };
}
test('v2 replaces complete private closure at stable file URLs, preserves state and backup, idempotent', async (t) => { const f = await fixture(t); const r = await migratePhoneCore(f.tree, f.home); assert.equal((await import(pathToFileURL(f.active + '/node_modules/@deepseek-ai/dsh-session/index.js').href)).version, 'new-rewind-closure'); assert.equal(await readFile(f.current, 'utf8'), f.state); assert.equal(await readFile(f.home + '/sessions/keep', 'utf8'), 'personal'); assert.equal(await readFile(r.backup + '/private-sdk/node_modules/@deepseek-ai/dsh-session/original.bak', 'utf8'), 'original bytes'); assert.equal((await migratePhoneCore(f.tree, f.home)).locations.length, 0); });
test('unknown private edits prevent both closure swap and ordinary SDK relink', async (t) => { const f = await fixture(t); await f.put(f.active + '/node_modules/@deepseek-ai/dsh-session/index.js', 'unknown'); await assert.rejects(migratePhoneCore(f.tree, f.home), /Unrecognized private SDK/); assert.equal((await lstat(f.home + '/profiles/phone/node_modules/@deepseek-ai/dsh-session')).isSymbolicLink(), false); assert.equal(await readFile(f.current, 'utf8'), f.state); });
test('missing dependency rejects the prepared candidate before any original changes', async (t) => { const f = await fixture(t); f.plan.files = f.plan.files.filter(r => !r.relative.startsWith('helper/')); f.plan.packages = f.plan.packages.filter(r => r.name !== 'helper'); await f.save(); await assert.rejects(migratePhoneCore(f.tree, f.home), /dependency.*helper/); assert.equal(await readFile(f.active + '/node_modules/@deepseek-ai/dsh-session/index.js', 'utf8'), f.old['@deepseek-ai/dsh-session/index.js']); });
test('checksum, traversal and escaping private symlinks refuse without relinking', async (t) => { const f = await fixture(t); await f.put(f.tree + '/node_modules/helper/index.js', 'bad'); await assert.rejects(migratePhoneCore(f.tree, f.home), /checksum/); await f.put(f.tree + '/node_modules/helper/index.js', f.next['helper/index.js']); f.plan.files[0].relative = '../escape'; await f.save(); await assert.rejects(migratePhoneCore(f.tree, f.home), /path/); f.plan.files[0].relative = '@deepseek-ai/dsh-session/package.json'; await f.save(); await symlink(f.root, f.active + '/node_modules/escape'); await assert.rejects(migratePhoneCore(f.tree, f.home), /link|regular|Unrecognized/); });
// Faults are injected by a child fixture process only; product code has no test bypass.
const childScript = `import {migratePhoneCore} from ${JSON.stringify(new URL('./core-migration.js', import.meta.url).href)};await migratePhoneCore(process.argv[1],process.argv[2]);`;
test('persisted interrupted directory exchange rolls back on retry, then upgrades', async (t) => { const f = await fixture(t); const backup = f.home + '/.phone-core-backups/interrupted'; await mkdir(backup, { recursive: true }); const old = f.active + '/node_modules', saved = backup + '/private-sdk/node_modules'; await mkdir(path.dirname(saved), { recursive: true }); const { rename } = await import('node:fs/promises'); const { snapshot } = await import('./core-transaction.js'); const before = await snapshot(old); await rename(old, saved); const journal = { version: 1, state: 'committing', guards: [{ relative: path.relative(f.home, f.current), sha256: sha(f.state) }], rows: [{ target: path.relative(f.home, old), saved: 'private-sdk/node_modules', stage: 'stage/node_modules', before, after: { kind: 'absent' } }] }; await f.put(backup + '/journal.json', JSON.stringify(journal)); await migratePhoneCore(f.tree, f.home); assert.equal(JSON.parse(await readFile(backup + '/journal.json')).state, 'rolled-back'); assert.equal(await readFile(f.current, 'utf8'), f.state); });
test('a failed second exchange rolls back private closure and all earlier relinks', async (t) => { const f = await fixture(t); const { runTransaction, snapshot } = await import('./core-transaction.js'); const target = f.active + '/node_modules'; const before = await snapshot(target); const backup = f.home + '/.phone-core-backups/injected'; await mkdir(backup + '/stage', { recursive: true }); await f.put(backup + '/stage/new/index.js', 'new'); const after = await snapshot(backup + '/stage/new'); const outside = f.home + '/second'; await f.put(outside, 'old'); await assert.rejects(runTransaction(f.home, backup, [{ target: path.relative(f.home, target), saved: 'private-sdk/node_modules', stage: 'stage/new', before, after }, { target: 'second', saved: 'second', stage: 'stage/missing', before: await snapshot(outside), after: { kind: 'absent' } }], []), /ENOENT/); assert.deepEqual(await snapshot(target), before); assert.equal(await readFile(outside, 'utf8'), 'old'); });
test('interrupted recovery refuses to overwrite concurrent user changes', async (t) => { const f = await fixture(t); const { snapshot, recoverTransactions } = await import('./core-transaction.js'); const target = f.home + '/marker', backup = f.home + '/.phone-core-backups/interrupted'; await f.put(target, 'old'); const before = await snapshot(target); await f.put(backup + '/saved', 'old'); await f.put(target, 'concurrent user'); await f.put(backup + '/journal.json', JSON.stringify({ version: 1, state: 'committing', guards: [], rows: [{ target: 'marker', saved: 'saved', stage: 'stage', before, after: { kind: 'file', sha256: sha('new'), mode: 384 } }] })); await assert.rejects(recoverTransactions(f.home), /changed|conflict/); assert.equal(await readFile(target, 'utf8'), 'concurrent user'); assert.equal(await readFile(backup + '/saved', 'utf8'), 'old'); });
test('real readonly projection failure restores exchanged private SDK and keeps all profile bytes', async (t) => {
    const f = await fixture(t);
    const { chmod } = await import('node:fs/promises');
    const parent = f.home + '/profiles/phone/node_modules/@deepseek-ai';
    await chmod(parent, 0o500);
    try {
        await assert.rejects(migratePhoneCore(f.tree, f.home), /EACCES/);
        assert.equal(await readFile(f.active + '/node_modules/@deepseek-ai/dsh-session/index.js', 'utf8'), f.old['@deepseek-ai/dsh-session/index.js']);
        assert.equal(await readFile(f.current, 'utf8'), f.state);
        assert.equal((await lstat(parent + '/dsh-session')).isDirectory(), true);
    }
    finally {
        await chmod(parent, 0o700);
    }
    await migratePhoneCore(f.tree, f.home);
});
test('live migration lock excludes another invocation and then releases normally', async (t) => { const f = await fixture(t); const { withMigrationLock } = await import('./core-transaction.js'); await withMigrationLock(f.tree, f.home, async () => { await assert.rejects(migratePhoneCore(f.tree, f.home), /already running/); }); await migratePhoneCore(f.tree, f.home); });
test('real SIGKILL after private directory exchange recovers dead owner and replays safely', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 700; i++) {
        const relative = 'helper/f' + i + '.js', bytes = 'export const x=' + i + ';';
        await f.put(f.tree + '/node_modules/' + relative, bytes);
        f.plan.files.push({ relative, sha256: sha(bytes), source: 'tree:node_modules/' + relative });
    }
    await f.save();
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, f.tree, f.home], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', b => stderr += b);
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    let killed = false;
    const limit = Date.now() + 15000;
    while (Date.now() < limit) {
        let dirs = [];
        try {
            dirs = await readdir(f.home + '/.phone-core-backups');
        }
        catch { }
        for (const d of dirs) {
            try {
                await lstat(f.home + '/.phone-core-backups/' + d + '/private-sdk/node_modules');
                assert.equal(JSON.parse(await readFile(f.active + '/node_modules/@deepseek-ai/dsh-session/package.json')).version, '0.2.1-rc.2');
                child.kill('SIGKILL');
                killed = true;
                break;
            }
            catch { }
        }
        if (killed || child.exitCode !== null)
            break;
        await new Promise(r => setTimeout(r, 1));
    }
    if (!killed)
        child.kill('SIGKILL');
    const exit = await exited;
    assert.equal(killed, true, stderr);
    assert.equal(exit.signal, 'SIGKILL');
    await migratePhoneCore(f.tree, f.home);
    assert.equal(await readFile(f.current, 'utf8'), f.state);
    assert.equal(JSON.parse(await readFile(f.active + '/node_modules/helper/package.json')).version, '1.0.0');
    assert.equal((await migratePhoneCore(f.tree, f.home)).locations.length, 0);
});
test('known private delta without its tested preservation receipt cannot activate', async (t) => { const f = await fixture(t); const relative = '@deepseek-ai/dsh-session/index.js'; f.plan.baselines[0].requiredPreservations = [{ relative, sha256: sha(f.old[relative]) }]; await f.save(); await assert.rejects(migratePhoneCore(f.tree, f.home), /Unverified.*preservation/); f.plan.preservations = [{ relative, beforeSha256: sha(f.old[relative]), afterSha256: sha(f.next[relative]), disposition: 'merged', verification: 'controlled closure fixture' }]; await f.save(); await migratePhoneCore(f.tree, f.home); });
test('backup directory redirected outside home is refused before any staging writes', async (t) => { const f = await fixture(t); const outside = f.root + '/outside'; await mkdir(outside); await symlink(outside, f.home + '/.phone-core-backups'); await assert.rejects(migratePhoneCore(f.tree, f.home), /outside home/); assert.deepEqual(await readdir(outside), []); assert.equal(await readFile(f.active + '/node_modules/@deepseek-ai/dsh-session/index.js', 'utf8'), f.old['@deepseek-ai/dsh-session/index.js']); });
test('empty permanent native-lock inode has no stale receipt window and symlink locks are refused', async (t) => { const f = await fixture(t); await f.put(f.home + '/.phone-core-migration.flock', ''); await migratePhoneCore(f.tree, f.home); assert.equal((await lstat(f.home + '/.phone-core-migration.flock')).size, 0); await rm(f.home + '/.phone-core-migration.flock'); await f.put(f.root + '/outside-lock', 'unchanged'); await symlink(f.root + '/outside-lock', f.home + '/.phone-core-migration.flock'); await assert.rejects(migratePhoneCore(f.tree, f.home), /ELOOP|symlink/); assert.equal(await readFile(f.root + '/outside-lock', 'utf8'), 'unchanged'); });
test('real native flock excludes another process and SIGKILL releases without owner-record repair', async (t) => { const f = await fixture(t); const { spawn } = await import('node:child_process'); const script = `import{withMigrationLock}from${JSON.stringify(new URL('./core-transaction.js', import.meta.url).href)};await withMigrationLock(process.argv[1],process.argv[2],async()=>{console.log('LOCKED');await new Promise(()=>setInterval(()=>{},1000));});`; const p = spawn(process.execPath, ['--input-type=module', '-e', script, f.tree, f.home], { stdio: ['ignore', 'pipe', 'pipe'] }); const exit = new Promise(r => p.on('exit', r)); t.after(() => p.kill('SIGKILL')); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('native lock fixture did not acquire')), 3000); p.stdout.once('data', b => { clearTimeout(timer); b.toString().includes('LOCKED') ? resolve() : reject(Error('unexpected native fixture output')); }); p.once('error', reject); }); await assert.rejects(migratePhoneCore(f.tree, f.home), /already running/); p.kill('SIGKILL'); await exit; await migratePhoneCore(f.tree, f.home); assert.equal((await lstat(f.home + '/.phone-core-migration.flock')).size, 0); });
async function communityFixture(f){
 const root=f.home+'/profiles/phone/node_modules/dsh-purge';
 const old={'package.json':JSON.stringify({name:'dsh-purge',version:'community.same',peerDependencies:{'@deepseek-ai/dsh-session':'=0.2.1-alpha.1'}}),'index.js':'export const guarded=false;','extras/retained-private-code.js':'private installed bytes never shipped'};
 const next={...old,'package.json':JSON.stringify({name:'dsh-purge',version:'community.same',peerDependencies:{'@deepseek-ai/dsh-session':'=0.2.1-alpha.1 || =0.2.1-rc.2'}}),'index.js':'export const guarded=true;','guard.js':'export const expected="rc2";'};
 for(const[r,b]of Object.entries(old))await f.put(root+'/'+r,b);
 for(const[r,b]of Object.entries(next))if(old[r]!==b)await f.put(f.tree+'/node_modules/dsh-purge/'+r,b);
 const {inventoryKey}=await import('./private-sdk-v2.js');const {compatibilityActionDigest}=await import('./compatibility-packages.js');
 const files=o=>Object.entries(o).map(([relative,b])=>({relative,sha256:sha(b)}));
 const replacements=Object.entries(next).filter(([r,b])=>old[r]!==b).map(([relative,b])=>({relative,sha256:sha(b),bytes:Buffer.byteLength(b),source:'tree:node_modules/dsh-purge/'+relative}));
 f.plan.compatibilityPackages=[{mode:'preserve-installed-with-replacements-v1',name:'dsh-purge',target:'profiles/phone/node_modules/dsh-purge',version:'community.same',baselines:[{id:'community-known',beforeSha256:sha(inventoryKey(files(old))),afterSha256:sha(inventoryKey(files(next))),filesBefore:Object.keys(old).length,filesAfter:Object.keys(next).length,boundActionSha256:compatibilityActionDigest(replacements)}],replacements}];
 await f.save();return{root,old,next};
}
test('known independent community package swaps in same transaction without changing user enablement', async (t) => { const f = await fixture(t), p = await communityFixture(f); await f.put(f.home + '/profiles/phone/package.json', '{"dsh":{"profile":{"bundles":["dsh-purge"]}}}'); const before = await readFile(f.home + '/profiles/phone/package.json'); const r = await migratePhoneCore(f.tree, f.home); assert.equal(await readFile(p.root + '/index.js', 'utf8'), p.next['index.js']);
    assert.equal(await readFile(p.root+'/extras/retained-private-code.js','utf8'),p.old['extras/retained-private-code.js']); assert.equal(await readFile(r.backup + '/profiles/phone/node_modules/dsh-purge/index.js', 'utf8'), p.old['index.js']); assert.deepEqual(await readFile(f.home + '/profiles/phone/package.json'), before); assert.equal(await readFile(f.current, 'utf8'), f.state); assert.equal((await migratePhoneCore(f.tree, f.home)).locations.length, 0); });
test('unknown independent community edits refuse private SDK swap and projection too', async (t) => { const f = await fixture(t), p = await communityFixture(f); await f.put(p.root + '/extra-user-code.js', 'unknown'); await assert.rejects(migratePhoneCore(f.tree, f.home), /Unrecognized.*compatibility|Unrecognized.*community/); assert.equal(await readFile(f.active + '/node_modules/@deepseek-ai/dsh-session/index.js', 'utf8'), f.old['@deepseek-ai/dsh-session/index.js']); assert.equal((await lstat(f.home + '/profiles/phone/node_modules/@deepseek-ai/dsh-session')).isDirectory(), true); });
test('community failure and later projection EACCES restore SDK and community together', async (t) => { const f = await fixture(t), p = await communityFixture(f); const { chmod } = await import('node:fs/promises'), scope = f.home + '/profiles/phone/node_modules/@deepseek-ai'; await chmod(scope, 0o500); try {
    await assert.rejects(migratePhoneCore(f.tree, f.home), /EACCES/);
    assert.equal(await readFile(p.root + '/index.js', 'utf8'), p.old['index.js']);
    assert.equal(await readFile(f.active + '/node_modules/@deepseek-ai/dsh-session/index.js', 'utf8'), f.old['@deepseek-ai/dsh-session/index.js']);
}
finally {
    await chmod(scope, 0o700);
} await migratePhoneCore(f.tree, f.home); assert.equal(await readFile(p.root + '/index.js', 'utf8'), p.next['index.js']); });
test('absent community plugin is not installed or enabled, present plugin can upgrade without an active private generation', async (t) => { const f = await fixture(t), p = await communityFixture(f); await rm(f.current); await migratePhoneCore(f.tree, f.home); assert.equal(await readFile(p.root + '/index.js', 'utf8'), p.next['index.js']); await rm(p.root, { recursive: true }); await migratePhoneCore(f.tree, f.home); await assert.rejects(lstat(p.root), { code: 'ENOENT' }); });
test('community keeps only its known shipped SDK link and refuses an escaping link',async t=>{const f=await fixture(t),p=await communityFixture(f);await symlink(f.tree+'/node_modules',p.root+'/node_modules','dir');await migratePhoneCore(f.tree,f.home);assert.equal(await import('node:fs/promises').then(m=>m.realpath(p.root+'/node_modules')),await import('node:fs/promises').then(m=>m.realpath(f.tree+'/node_modules')));assert.equal((await migratePhoneCore(f.tree,f.home)).locations.length,0);await rm(p.root+'/node_modules');await symlink(f.root,p.root+'/node_modules','dir');await assert.rejects(migratePhoneCore(f.tree,f.home),/Unrecognized.*link/)});
test('community source corruption stages neither final package nor private SDK, repaired source retries',async t=>{const f=await fixture(t),p=await communityFixture(f);await f.put(f.tree+'/node_modules/dsh-purge/guard.js','corrupt');await assert.rejects(migratePhoneCore(f.tree,f.home),/checksum/);assert.equal(await readFile(p.root+'/index.js','utf8'),p.old['index.js']);assert.equal(await readFile(f.active+'/node_modules/@deepseek-ai/dsh-session/index.js','utf8'),f.old['@deepseek-ai/dsh-session/index.js']);await f.put(f.tree+'/node_modules/dsh-purge/guard.js',p.next['guard.js']);await migratePhoneCore(f.tree,f.home);assert.equal(await readFile(p.root+'/index.js','utf8'),p.next['index.js'])});
test('complete installed community clone keeps empty directories and executable extras',async t=>{const f=await fixture(t),p=await communityFixture(f);await mkdir(p.root+'/empty-runtime-dir');const {chmod}=await import('node:fs/promises');await chmod(p.root+'/extras/retained-private-code.js',0o700);await migratePhoneCore(f.tree,f.home);assert((await lstat(p.root+'/empty-runtime-dir')).isDirectory());assert.equal((await lstat(p.root+'/extras/retained-private-code.js')).mode&0o777,0o700);assert.equal(await readFile(p.root+'/extras/retained-private-code.js','utf8'),p.old['extras/retained-private-code.js'])});
async function secondCompatibilityFixture(f){const name='oh-my-dsh',target='profiles/phone/node_modules/'+name,root=f.home+'/'+target,old={'package.json':JSON.stringify({name,version:'2.5.3'}),'index.js':'old upstream code','obsolete.js':'old owned deprecated file','private-user-extra.json':'keep private local bytes'};const next={'package.json':JSON.stringify({name,version:'2.5.7'}),'index.js':'new reviewed upstream code','private-user-extra.json':old['private-user-extra.json']};for(const[r,b]of Object.entries(old))await f.put(root+'/'+r,b);const replacements=Object.entries(next).filter(([r,b])=>old[r]!==b).map(([relative,b])=>({relative,sha256:sha(b),bytes:Buffer.byteLength(b),source:'tree:node_modules/'+name+'/'+relative}));for(const r of replacements)await f.put(f.tree+'/node_modules/'+name+'/'+r.relative,next[r.relative]);const removals=[{relative:'obsolete.js',beforeSha256:sha(old['obsolete.js'])}],{inventoryDigest,compatibilityActionDigest}=await import('./compatibility-packages.js'),rows=o=>Object.entries(o).map(([relative,b])=>({relative,sha256:sha(b)}));f.plan.compatibilityPackages.push({mode:'preserve-installed-with-replacements-v1',name,target,version:'2.5.7',baselines:[{id:'reviewed-independent-upgrade',beforeSha256:inventoryDigest(rows(old)),afterSha256:inventoryDigest(rows(next)),filesBefore:Object.keys(old).length,filesAfter:Object.keys(next).length,boundActionSha256:compatibilityActionDigest(replacements,removals)}],replacements,removals});await f.save();return{root,old,next};}
test('two independent compatibility packages, reviewed removal and SDK share one all-or-nothing transaction',async t=>{const f=await fixture(t),community=await communityFixture(f),other=await secondCompatibilityFixture(f),scope=f.home+'/profiles/phone/node_modules/@deepseek-ai';const {chmod}=await import('node:fs/promises');await chmod(scope,0o500);try{await assert.rejects(migratePhoneCore(f.tree,f.home),/EACCES/);assert.equal(await readFile(community.root+'/index.js','utf8'),community.old['index.js']);assert.equal(await readFile(other.root+'/index.js','utf8'),other.old['index.js']);assert.equal(await readFile(other.root+'/obsolete.js','utf8'),other.old['obsolete.js'])}finally{await chmod(scope,0o700)}await migratePhoneCore(f.tree,f.home);assert.equal(await readFile(other.root+'/index.js','utf8'),other.next['index.js']);assert.equal(await readFile(other.root+'/private-user-extra.json','utf8'),other.old['private-user-extra.json']);await assert.rejects(lstat(other.root+'/obsolete.js'),{code:'ENOENT'});assert.equal((await migratePhoneCore(f.tree,f.home)).locations.length,0)});
test('unknown extra in the second compatibility package prevents every staged package from activating',async t=>{const f=await fixture(t),community=await communityFixture(f),other=await secondCompatibilityFixture(f);await f.put(other.root+'/index.js','unknown user enhancement');await assert.rejects(migratePhoneCore(f.tree,f.home),/Unrecognized.*compatibility/);assert.equal(await readFile(community.root+'/index.js','utf8'),community.old['index.js']);assert.equal(await readFile(f.active+'/node_modules/@deepseek-ai/dsh-session/index.js','utf8'),f.old['@deepseek-ai/dsh-session/index.js']);assert.equal(await readFile(other.root+'/index.js','utf8'),'unknown user enhancement')});

test('explicit installed npm aliases retain their exact planned package identity',async t=>{
 const f=await fixture(t),relative='helper/package.json';
 const body=JSON.stringify({name:'phone-helper-alias',version:'1.0.0',type:'module',main:'index.js'});
 await f.put(f.tree+'/node_modules/'+relative,body);
 f.plan.files.find(r=>r.relative===relative).sha256=sha(body);
 f.plan.packages.find(p=>p.relative==='helper').name='phone-helper-alias';
 await f.save();await migratePhoneCore(f.tree,f.home);
 assert.equal((await import(pathToFileURL(f.active+'/node_modules/@deepseek-ai/dsh-session/index.js').href)).version,'new-rewind-closure');
 assert.equal((await migratePhoneCore(f.tree,f.home)).locations.length,0);
});
test('a dependency identity not declared in the plan refuses the complete migration',async t=>{
 const f=await fixture(t),relative='helper/package.json';
 const body=JSON.stringify({name:'undeclared-other-package',version:'1.0.0',type:'module',main:'index.js'});
 await f.put(f.tree+'/node_modules/'+relative,body);f.plan.files.find(r=>r.relative===relative).sha256=sha(body);await f.save();
 await assert.rejects(migratePhoneCore(f.tree,f.home),/identity|version mismatch/);
 assert.equal(await readFile(f.active+'/node_modules/@deepseek-ai/dsh-session/index.js','utf8'),f.old['@deepseek-ai/dsh-session/index.js']);assert.equal(await readFile(f.current,'utf8'),f.state);
});
