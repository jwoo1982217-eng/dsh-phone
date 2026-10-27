import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {gunzipSync} from 'node:zlib';import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {applyPhoneCompatibility} from '../app/src/main/assets/dsh-ofm-compat.mjs';
const fixture=JSON.parse(gunzipSync(fs.readFileSync(new URL('./fixtures/upstream-2.5.7.json.gz',import.meta.url))));
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ofm257-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));for(const[n,v]of Object.entries(fixture)){fs.mkdirSync(path.dirname(path.join(root,n)),{recursive:true});fs.writeFileSync(path.join(root,n),v);}return root;}
const snapshot=root=>Object.fromEntries(Object.keys(fixture).map(n=>[n,fs.readFileSync(path.join(root,n),'utf8')]));
test('2.5.7 preserves signed outlet, upstream manual benchmark/managed update and local SSE/shared routes',t=>{const root=setup(t);const r=applyPhoneCompatibility(root);assert.equal(r.version,'2.5.7');const read=n=>fs.readFileSync(path.join(root,n),'utf8');assert.match(read('index.js'),/fetchSigned: \(input, init, send\) => egressFetch\(input, init, send\)/);assert.match(read('index.js'),/testModel: \(id, effort, options\) => modelRuntime.testModel\(id, effort, options\)/);assert.match(read('client.js'),/source = sharedPushSource\(`/);assert.match(read('client.js'),/330_000/);assert.match(read('client.js'),/summary: data/);assert.match(read('src/vault.js'),/profileName === 'tauri'/);assert.deepEqual(applyPhoneCompatibility(root).changed,[]);});
test('unreviewed 2.5.7 mount rejects before writes and retry after restoring source succeeds',t=>{const root=setup(t);fs.writeFileSync(path.join(root,'index.js'),fixture['index.js'].replace('fetchSigned: (input, init, send)','fetchSigned: (custom, init, send)'));const b=snapshot(root);assert.throws(()=>applyPhoneCompatibility(root),/Unreviewed/);assert.deepEqual(snapshot(root),b);fs.writeFileSync(path.join(root,'index.js'),fixture['index.js']);assert.equal(applyPhoneCompatibility(root).state,'ready');});
test('2.5.7 mid-commit failure restores exact bytes and removes newly added adapter',t=>{const root=setup(t),b=snapshot(root);let fail=true;const io={...fs,renameSync(a,b){if(fail&&b===path.join(root,'client.js')){fail=false;throw Error('injected257');}return fs.renameSync(a,b);}};assert.throws(()=>applyPhoneCompatibility(root,{io}),/injected257/);assert.deepEqual(snapshot(root),b);assert.equal(fs.existsSync(path.join(root,'src/host-channels.js')),false);assert.equal(applyPhoneCompatibility(root).state,'ready');});
test('unknown future package version cannot borrow reviewed recipe hashes',t=>{const root=setup(t);const manifest=JSON.parse(fixture['package.json']);manifest.version='2.5.8';fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(manifest));const b=snapshot(root);assert.throws(()=>applyPhoneCompatibility(root),/Unreviewed OFM version/);assert.deepEqual(snapshot(root),b);});

function cliFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Android exposes the same files through /data/user/0 and /data/data. Use a
  // real directory alias rather than mocking Node's entry-module resolution.
  const files = path.join(root, '真实 files');
  const alias = path.join(root, 'data-alias');
  const home = path.join(files, 'dsh-home');
  const packageDir = path.join(home, 'profiles/phone/node_modules/dsh-our-free-model');
  fs.mkdirSync(files, { recursive: true });
  fs.symlinkSync(files, alias, 'dir');
  for (const name of ['dsh-ofm-compat.mjs', 'dsh-ofm-compat-data.json']) {
    fs.copyFileSync(new URL('../app/src/main/assets/' + name, import.meta.url), path.join(files, name));
  }
  for (const [name, value] of Object.entries(fixture)) {
    const file = path.join(packageDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  const env = { ...process.env, DSH_PHONE_ANDROID: '1', DSH_HOME: path.join(alias, 'dsh-home') };
  const run = (entry, args = []) => spawnSync(process.execPath, [...args, entry], {
    encoding: 'utf8', env, timeout: 30_000,
  });
  return { files, alias, packageDir, run, env };
}

test('CLI directory alias emits a real JSON receipt, patches 2.5.7 and is idempotent', t => {
  const { alias, packageDir, run } = cliFixture(t);
  const entry = path.join(alias, 'dsh-ofm-compat.mjs');
  const first = run(entry);
  assert.equal(first.status, 0, first.stderr);
  assert.notEqual(first.stdout.trim(), '', 'a successful CLI may not return an empty receipt');
  const receipt = JSON.parse(first.stdout).ofmPhoneCompatibility;
  assert.equal(receipt.state, 'ready');
  assert.equal(receipt.version, '2.5.7');
  assert.ok(receipt.changed.includes('src/host-channels.js'));
  assert.match(fs.readFileSync(path.join(packageDir, 'client.js'), 'utf8'), /sharedPushSource/);
  const repeated = run(entry);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).ofmPhoneCompatibility.changed, []);
});

test('CLI direct path and preserved-symlink entry both execute and emit JSON', t => {
  const { files, alias, run } = cliFixture(t);
  const direct = run(fs.realpathSync(path.join(files, 'dsh-ofm-compat.mjs')));
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).ofmPhoneCompatibility.state, 'ready');
  const preserved = run(path.join(alias, 'dsh-ofm-compat.mjs'), ['--preserve-symlinks-main']);
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.deepEqual(JSON.parse(preserved.stdout).ofmPhoneCompatibility.changed, []);
});

test('importing through a directory alias does not invoke the CLI or modify OFM', t => {
  const { alias, files, packageDir, env } = cliFixture(t);
  const before = snapshot(packageDir);
  const imported = pathToFileURL(path.join(alias, 'dsh-ofm-compat.mjs')).href;
  const importer = path.join(files, 'caller.mjs');
  fs.writeFileSync(importer, `const { applyPhoneCompatibility } = await import(${JSON.stringify(imported)});\nif (typeof applyPhoneCompatibility !== 'function') throw Error('missing export');\n`);
  const result = spawnSync(process.execPath, [importer], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(snapshot(packageDir), before);
  assert.equal(fs.existsSync(path.join(packageDir, 'src/host-channels.js')), false);
});

test('CLI alias rejects an unknown version with a failure receipt before any write', t => {
  const { alias, packageDir, run } = cliFixture(t);
  const manifest = JSON.parse(fixture['package.json']);
  manifest.version = '2.5.8';
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest));
  const before = snapshot(packageDir);
  const rejected = run(path.join(alias, 'dsh-ofm-compat.mjs'));
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(rejected.stdout, '');
  const receipt = JSON.parse(rejected.stderr).ofmPhoneCompatibility;
  assert.equal(receipt.state, 'failed');
  assert.match(receipt.error, /Unreviewed OFM version: 2\.5\.8/);
  assert.deepEqual(snapshot(packageDir), before);
  assert.equal(fs.existsSync(path.join(packageDir, 'src/host-channels.js')), false);
});
