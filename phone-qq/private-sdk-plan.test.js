import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildPrivateSdkPlan } from './private-sdk-plan.js';
const hash = b => createHash('sha256').update(b).digest('hex');
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-plan-')); t.after(() => rm(root, { recursive: true, force: true })); const tree = root + '/tree', variantsDirectory = root + '/variants'; const put = async (r, b) => { await mkdir(path.dirname(r), { recursive: true }); await writeFile(r, b); }; const pkg = (n, v, d = {}) => JSON.stringify({ name: n, version: v, dependencies: d }); await put(tree + '/node_modules/@deepseek-ai/dsh/package.json', pkg('@deepseek-ai/dsh', '0.2.1-rc.2')); await put(tree + '/node_modules/@deepseek-ai/dsh-session/package.json', pkg('@deepseek-ai/dsh-session', '0.2.1-rc.2', { 'dep': '1' })); await put(tree + '/node_modules/@deepseek-ai/dsh-session/index.js', 'new official'); await put(tree + '/node_modules/dep/package.json', pkg('dep', '1')); await put(tree + '/node_modules/dep/index.js', 'dependency'); await put(root + '/baseline.json', JSON.stringify({ id: 'old', files: [{ relative: '@deepseek-ai/dsh-session/package.json', sha256: hash('old') }] })); await mkdir(variantsDirectory); return { root, tree, variantsDirectory, baselineFiles: [root + '/baseline.json'], bootPackage: null, put }; }
test('builds only transitive complete closure and content-addressed private variants', async (t) => { const f = await fixture(t); await f.put(f.variantsDirectory + '/@deepseek-ai/dsh-session/index.js', 'new plus rewind'); await f.put(f.variantsDirectory + '/@deepseek-ai/dsh-session/helper.js', 'helper'); const plan = await buildPrivateSdkPlan(f); assert.equal(plan.packages.length, 2); assert.equal(plan.files.length, 5); const row = plan.files.find(r => r.relative.endsWith('session/index.js')); assert.equal(row.sha256, hash('new plus rewind')); assert.equal(await readFile(f.tree + '/node_modules/dsh-phone-qq/' + row.source.slice(7), 'utf8'), 'new plus rewind'); assert.equal(plan.packages.some(p => p.name === '@deepseek-ai/dsh'), false); });
test('known private semantic delta needs an explicit tested preservation receipt', async (t) => { const f = await fixture(t); f.requiredPreservations = [{ relative: '@deepseek-ai/dsh-session/index.js', sha256: hash('old rewind') }]; await assert.rejects(buildPrivateSdkPlan(f), /Unverified private SDK preservation/); f.preservations = [{ relative: f.requiredPreservations[0].relative, beforeSha256: hash('old rewind'), afterSha256: hash('new official'), disposition: 'maintained-upstream', verification: 'isolated fixture test' }]; assert.equal((await buildPrivateSdkPlan(f)).preservations.length, 1); });
test('missing transitive dependency and mixed SDK versions are not ignored', async (t) => { const f = await fixture(t); await rm(f.tree + '/node_modules/dep', { recursive: true }); await assert.rejects(buildPrivateSdkPlan(f), /missing dependency/); await f.put(f.tree + '/node_modules/@deepseek-ai/dsh-session/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-session', version: 'alpha' })); await assert.rejects(buildPrivateSdkPlan(f), /version mismatch/); });
test('community compatibility ships only five public replacements and bound private inventory fingerprints',async t=>{const f=await fixture(t);const {buildCompatibilityPackagePlans}=await import('./private-sdk-plan.js');const names=['package.json','lib/core.js','lib/community-profile.js','lib/community-recover.js','lib/core-version-guard.js'];for(const r of names)await f.put(f.tree+'/node_modules/dsh-purge/'+r,r==='package.json'?JSON.stringify({name:'dsh-purge',version:'community.same'}):'maintained guard '+r);const old=[{relative:'package.json',sha256:hash('old manifest')},{relative:'private-extra-do-not-publish.js',sha256:hash('private installed bytes')}];const baseline=f.root+'/private-full-baseline.json';await f.put(baseline,JSON.stringify({id:'complete-community',files:old}));const spec={name:'dsh-purge',target:'profiles/phone/node_modules/dsh-purge',baselineFiles:[baseline],replacementPaths:names,verification:'actual old/rc2 guard and loader tests'};const [p]=await buildCompatibilityPackagePlans(f.tree,[spec]);assert.equal(p.replacements.length,5);assert(!JSON.stringify(p).includes('private-extra-do-not-publish'));assert(!JSON.stringify(p).includes('private installed bytes'));assert.equal(p.baselines[0].filesBefore,2);assert.equal(p.baselines[0].filesAfter,6);const digestOnly=f.root+'/public-fingerprint.json';await f.put(digestOnly,JSON.stringify(p.baselines[0]));assert.deepEqual(await buildCompatibilityPackagePlans(f.tree,[{...spec,baselineFiles:[digestOnly]}]),[p]);await f.put(f.tree+'/node_modules/dsh-purge/lib/core-version-guard.js','changed guard');await assert.rejects(buildCompatibilityPackagePlans(f.tree,[{...spec,baselineFiles:[digestOnly]}]),/bound to different replacements/)});
test('identical maintained variant remains a tree source instead of a duplicate payload',async t=>{const f=await fixture(t);await f.put(f.variantsDirectory+'/@deepseek-ai/dsh-session/index.js','new official');const p=await buildPrivateSdkPlan(f),row=p.files.find(r=>r.relative==='@deepseek-ai/dsh-session/index.js');assert.equal(row.source,'tree:node_modules/@deepseek-ai/dsh-session/index.js');await assert.rejects(readFile(f.tree+'/node_modules/dsh-phone-qq/private-sdk-patches/v2-'+row.sha256+'.dat'),{code:'ENOENT'})});
test('variant fixture dependency link is not followed or included in deployment',async t=>{const f=await fixture(t);const {symlink}=await import('node:fs/promises');await symlink(f.tree+'/node_modules',f.variantsDirectory+'/node_modules','dir');const plan=await buildPrivateSdkPlan(f);assert(plan.files.every(r=>!r.relative.startsWith('node_modules/')));assert.equal(plan.packages.length,2)});

async function cliFixture(t) {
  const f = await fixture(t);
  delete f.bootPackage;
  const sdk = '0.2.1-rc.2', modules = f.tree + '/node_modules';
  const pkg = (name, dependencies, extra = {}) => JSON.stringify({ name, version: sdk, type: 'module', main: 'index.js', dependencies, ...extra });
  await f.put(modules + '/@deepseek-ai/dsh/package.json', pkg('@deepseek-ai/dsh', { '@deepseek-ai/dsh-app-boot': sdk }, { bin: { dsh: './lib/bin.js' } }));
  await f.put(modules + '/@deepseek-ai/dsh/lib/bin.js', `import { scopeIdentity, origin as appBoot } from '@deepseek-ai/dsh-app-boot';
import { identity, origin as scope } from '@deepseek-ai/dsh-scope';
console.log(JSON.stringify({same: scopeIdentity === identity, appBoot, scope, cli: import.meta.url}));\n`);
  await f.put(modules + '/@deepseek-ai/dsh-app-boot/package.json', pkg('@deepseek-ai/dsh-app-boot', { '@deepseek-ai/dsh-scope': sdk }));
  await f.put(modules + '/@deepseek-ai/dsh-app-boot/index.js', `export { identity as scopeIdentity } from '@deepseek-ai/dsh-scope'; export const origin = import.meta.url;\n`);
  await f.put(modules + '/@deepseek-ai/dsh-scope/package.json', pkg('@deepseek-ai/dsh-scope', {}));
  await f.put(modules + '/@deepseek-ai/dsh-scope/index.js', `export const identity = Symbol('fixture.scope'); export const origin = import.meta.url;\n`);
  return f;
}

test('the production default includes physical CLI and its indirect bootstrap/scope in one closure', async t => {
  const f = await cliFixture(t);
  const baseline = JSON.parse(await readFile(f.baselineFiles[0], 'utf8'));
  const plan = await buildPrivateSdkPlan(f);
  assert.deepEqual(plan.boot, { package: '@deepseek-ai/dsh', entry: '@deepseek-ai/dsh/lib/bin.js' });
  assert.deepEqual(plan.baselines, [baseline]);
  assert.deepEqual(plan.packages.map(x => x.name).sort(), ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session', 'dep'].sort());
  const installed = f.root + '/installed/node_modules';
  for (const row of plan.files) {
    assert.ok(row.source.startsWith('tree:'));
    const source = f.tree + '/' + row.source.slice(5), destination = path.join(installed, row.relative);
    await f.put(destination, await readFile(source));
  }
  const entry = path.join(installed, plan.boot.entry);
  assert.equal((await lstat(entry)).isSymbolicLink(), false);
  const result = JSON.parse(execFileSync(process.execPath, [entry], { encoding: 'utf8' }));
  assert.equal(result.same, true);
  assert.equal(result.cli, pathToFileURL(await realpath(entry)).href);
  assert.equal(result.appBoot, pathToFileURL(await realpath(path.join(installed, '@deepseek-ai/dsh-app-boot/index.js'))).href);
  assert.equal(result.scope, pathToFileURL(await realpath(path.join(installed, '@deepseek-ai/dsh-scope/index.js'))).href);
  assert.ok(!JSON.stringify(result).includes(f.tree));
});

test('missing CLI entry and a required CLI dependency reject the default build', async t => {
  const f = await cliFixture(t), entry = f.tree + '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const bytes = await readFile(entry);
  await rm(entry);
  await assert.rejects(buildPrivateSdkPlan(f), /CLI.*entry|boot.*entry/);
  await f.put(entry, bytes);
  await rm(f.tree + '/node_modules/@deepseek-ai/dsh-app-boot', { recursive: true });
  await assert.rejects(buildPrivateSdkPlan(f), /missing dependency.*dsh-app-boot/);
  await rm(f.tree + '/node_modules/@deepseek-ai/dsh', { recursive: true });
  await assert.rejects(buildPrivateSdkPlan(f), { code: 'ENOENT' });
});

test('unexpected CLI identity, linked bin, and arbitrary bootstrap names are refused', async t => {
  const f = await cliFixture(t), entry = f.tree + '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  await assert.rejects(buildPrivateSdkPlan({ ...f, bootPackage: '@deepseek-ai/other' }), /boot package|bootstrap/);
  const { symlink } = await import('node:fs/promises');
  await rm(entry); await f.put(f.tree + '/other-bin.js', 'export {};'); await symlink(f.tree + '/other-bin.js', entry);
  await assert.rejects(buildPrivateSdkPlan(f), /CLI.*regular|CLI.*entry|boot.*entry/);
  await rm(entry); await f.put(entry, 'export {};');
  const manifest = f.tree + '/node_modules/@deepseek-ai/dsh/package.json';
  const metadata = JSON.parse(await readFile(manifest, 'utf8')); metadata.name = '@deepseek-ai/not-dsh';
  await f.put(manifest, JSON.stringify(metadata));
  await assert.rejects(buildPrivateSdkPlan(f), /CLI.*identity|core.*identity|boot.*identity/);
});

test('only an explicit build-fixture opt-out omits the CLI; preserved baseline deltas remain required', async t => {
  const f = await fixture(t);
  await assert.rejects(buildPrivateSdkPlan({ ...f, bootPackage: undefined }), /CLI.*entry|boot.*entry|CLI.*identity/);
  const fixtureOnly = await buildPrivateSdkPlan(f);
  assert.equal(fixtureOnly.boot, null);
  assert.equal(fixtureOnly.packages.some(x => x.name === '@deepseek-ai/dsh'), false);
  await assert.rejects(buildPrivateSdkPlan({ ...f, outputFile: f.root + '/nonboot-published-plan.json' }), /fixture.*publish|fixture.*output/);
  f.bootPackage = undefined;
  const real = await cliFixture(t);
  real.requiredPreservations = [{ relative: '@deepseek-ai/dsh-session/index.js', sha256: hash('old rewind') }];
  await assert.rejects(buildPrivateSdkPlan(real), /Unverified private SDK preservation/);
  real.preservations = [{ relative: '@deepseek-ai/dsh-session/index.js', beforeSha256: hash('old rewind'), afterSha256: hash('new official'), disposition: 'maintained-upstream', verification: 'isolated closure bootstrap and retained session fixture' }];
  assert.equal((await buildPrivateSdkPlan(real)).preservations.length, 1);
});
