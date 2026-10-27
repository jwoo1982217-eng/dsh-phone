import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDesktopPeer } from './install-desktop-peer.mjs';

const run = promisify(execFile);
const modules = path.resolve(process.env.DSH_PHONE_TEST_MODULES || 'desktop-runtime/node_modules');
const core = await realpath(path.join(modules, '@deepseek-ai/dsh'));
const runtime = createRequire(path.join(core, 'package.json'));
const expectedSdk = await realpath(runtime.resolve('@deepseek-ai/dsh-http-proxy'));
const expectedSdkDirectory = path.dirname(await realpath(runtime.resolve('@deepseek-ai/dsh-http-proxy/package.json')));
async function temporary(t) { const dir = await mkdtemp(path.join(tmpdir(), 'peer-proxy-install-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function profileAt(dir) {
  const profile = path.join(dir, 'profile'); await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
  return profile;
}
async function probeInstalled(dir, plugin, expected, sdkFile = expected) {
  const child = path.join(dir, 'probe.mjs');
  await writeFile(child, `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
const sdk = await import(${JSON.stringify(pathToFileURL(sdkFile).href)});
const installed = createRequire(${JSON.stringify(path.join(plugin, 'package.json'))});
assert.equal(realpathSync(installed.resolve('@deepseek-ai/dsh-http-proxy')), ${JSON.stringify(expected)});
const transport = await import(${JSON.stringify(pathToFileURL(path.join(plugin, 'transport-proxy.mjs')).href)});
const snapshot = {HTTP_PROXY:'http://127.0.0.1:19192',HTTPS_PROXY:'http://127.0.0.1:19192'};
const restore = await sdk.installProxyFromEnvironment({get:name=>snapshot[name]?{value:snapshot[name]}:undefined},()=>{});
try {
  for(const name of ['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy']) delete process.env[name];
  const url = new URL('https://synthetic-peer.invalid/relay');
  const actual = await transport.runtimeRoute(url), coreRoute = sdk.proxyRouteFor(url);
  assert.equal(actual.proxied,true); assert.equal(actual.proxy,snapshot.HTTPS_PROXY); assert.equal(actual.dispatcher,coreRoute.dispatcher);
  console.log(JSON.stringify({sameModule:true,launchSnapshotPreserved:true}));
} finally { await restore(); }
`);
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  // No --import/test hooks: this must prove the actual installed dependency.
  const result = await run(process.execPath, [child], { env, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { sameModule: true, launchSnapshotPreserved: true });
}
async function fixtureModules(dir, { nestedSdk = false, decoy = false } = {}) {
  const selected = path.join(dir, 'selected/node_modules'); await mkdir(selected, { recursive: true });
  // Share exact dependency inputs using links; never copy a runtime tree.
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    if (entry.name.startsWith('@')) {
      await mkdir(path.join(selected, entry.name));
      for (const child of await readdir(path.join(modules, entry.name))) {
        const name = entry.name + '/' + child;
        if (['@deepseek-ai/dsh', '@deepseek-ai/dsh-http-proxy'].includes(name)) continue;
        await symlink(await realpath(path.join(modules, name)), path.join(selected, name), 'dir');
      }
    } else await symlink(await realpath(path.join(modules, entry.name)), path.join(selected, entry.name), 'dir');
  }
  const selectedCore = path.join(selected, '@deepseek-ai/dsh'); await mkdir(selectedCore, { recursive: true });
  await writeFile(path.join(selectedCore, 'package.json'), await readFile(path.join(core, 'package.json')));
  if (nestedSdk) {
    const nested = path.join(selectedCore, 'node_modules/@deepseek-ai/dsh-http-proxy'); await mkdir(path.dirname(nested), { recursive: true }); await symlink(expectedSdkDirectory, nested, 'dir');
  }
  if (decoy) {
    const wrong = path.join(selected, '@deepseek-ai/dsh-http-proxy'); await mkdir(wrong, { recursive: true });
    await writeFile(path.join(wrong, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-http-proxy', type: 'module', exports: { '.': './index.mjs', './package.json': './package.json' } }));
    await writeFile(path.join(wrong, 'index.mjs'), 'export const proxyRouteFor=()=>({proxied:false});\n');
  }
  return { modules: selected, core: selectedCore };
}

test('fresh and repeated installation links the exact supplied core SDK and its launch proxy snapshot', async t => {
  const dir = await temporary(t), profile = await profileAt(dir);
  for (let i = 0; i < 2; i++) {
    const installed = await installDesktopPeer(profile, modules);
    await probeInstalled(dir, installed.plugin, expectedSdk);
  }
});

test('core-nested SDK wins over an unrelated top-level proxy module', async t => {
  const dir = await temporary(t), selected = await fixtureModules(dir, { nestedSdk: true, decoy: true });
  const selectedRuntime = createRequire(path.join(selected.core, 'package.json'));
  assert.equal(await realpath(selectedRuntime.resolve('@deepseek-ai/dsh-http-proxy')), expectedSdk);
  const installed = await installDesktopPeer(await profileAt(dir), selected.modules);
  await probeInstalled(dir, installed.plugin, expectedSdk);
});

test('optional SDK absence in the supplied core stays absent and installed transport retains environment fallback', async t => {
  const dir = await temporary(t), selected = await fixtureModules(dir);
  const selectedRuntime = createRequire(path.join(selected.core, 'package.json'));
  assert.throws(() => selectedRuntime.resolve('@deepseek-ai/dsh-http-proxy'), { code: 'MODULE_NOT_FOUND' });
  const installed = await installDesktopPeer(await profileAt(dir), selected.modules);
  await assert.rejects(lstat(path.join(installed.plugin, 'node_modules/@deepseek-ai/dsh-http-proxy')), { code: 'ENOENT' });
  const child = path.join(dir, 'fallback.mjs');
  await writeFile(child, `const {runtimeRoute}=await import(${JSON.stringify(pathToFileURL(path.join(installed.plugin, 'transport-proxy.mjs')).href)});const result=await runtimeRoute(new URL('https://synthetic-peer.invalid'));if(!result.proxied||result.proxy!=='http://127.0.0.1:19193')throw Error('Missing SDK did not retain environment fallback');console.log('fallback-preserved');`);
  const env = { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:19193' }; for (const name of ['NODE_OPTIONS','https_proxy','NO_PROXY','no_proxy']) delete env[name];
  assert.equal((await run(process.execPath, [child], { env })).stdout.trim(), 'fallback-preserved');
});

test('missing core proxy plus inherited profile decoy rejects before replacing the old peer or manifest', async t => {
  const dir = await temporary(t), selected = await fixtureModules(dir), profile = await profileAt(dir);
  const target = path.join(profile, 'node_modules/dsh-peer'), inherited = path.join(profile, 'node_modules/@deepseek-ai/dsh-http-proxy');
  await mkdir(target, { recursive: true }); await mkdir(inherited, { recursive: true });
  const originals = new Map([
    [path.join(profile, 'package.json'), '{\n  "dependencies":{"dsh-peer":"file:./node_modules/dsh-peer","unrelated":"1.0.0"},\n  "dsh":{"profile":{"bundles":["unrelated","dsh-peer"]}},\n  "userMarker":"preserve"\n}\n'],
    [path.join(target, 'package.json'), '{"name":"dsh-peer","version":"old-fixture"}\n'],
    [path.join(target, 'index.mjs'), 'export const oldPeer = true;\n'],
    [path.join(target, 'user-marker'), 'existing-target-must-remain\n'],
    [path.join(inherited, 'package.json'), '{"name":"@deepseek-ai/dsh-http-proxy","type":"module","exports":"./index.mjs"}\n'],
    [path.join(inherited, 'index.mjs'), 'export const proxyRouteFor=()=>({proxied:false,wrongProfileModule:true});\n'],
  ]);
  for (const [file, value] of originals) await writeFile(file, value);
  const targetIdentity = await lstat(target);
  assert.throws(() => createRequire(path.join(selected.core, 'package.json')).resolve('@deepseek-ai/dsh-http-proxy'), { code: 'MODULE_NOT_FOUND' });
  assert.equal(await realpath(createRequire(path.join(target, 'package.json')).resolve('@deepseek-ai/dsh-http-proxy')), path.join(inherited, 'index.mjs'));
  await assert.rejects(installDesktopPeer(profile, selected.modules), { code: 'PEER_PROXY_DEPENDENCY_CONFLICT' });
  for (const [file, value] of originals) assert.equal(await readFile(file, 'utf8'), value, 'Preflight rejection must preserve ' + file);
  assert.equal((await lstat(target)).ino, targetIdentity.ino);
  assert.deepEqual((await readdir(path.join(profile, 'node_modules'))).sort(), ['@deepseek-ai', 'dsh-peer']);
});
