import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import LocalSandbox from '../runtime/overlays/@deepseek-ai/dsh-sandbox-local/lib/index.js';
const { default: LocalFileSystem } = await import(process.env.DSH_FS_LOCAL_MODULE ??
  new URL('../runtime/overlays/@deepseek-ai/dsh-fs-local/lib/index.js', import.meta.url).href);

test('Android probes its only sandbox candidate and keeps an unavailable verdict closed', async () => {
  let probes = 0;
  const provider = Object.assign(Object.create(LocalSandbox.prototype), {
    internals: { platform: 'android', landlockLauncher: '/installed/libdshlandlock.so',
      probeLandlock: () => { probes++; return 'unusable'; } },
  });
  for (const mode of ['workspace-write', 'read-only']) {
    await assert.rejects(provider.confine(['/installed/libbash.so', '-c', 'echo hello'],
      { mode, workspaceRoot: tmpdir() }), { code: 'SANDBOX_UNAVAILABLE' });
  }
  assert.equal(probes, 1);
});

test('Android enforcing candidate wraps exact argv; desktop runner selection remains intact', async () => {
  const provider = Object.assign(Object.create(LocalSandbox.prototype), {
    internals: { platform: 'android', landlockLauncher: '/installed/libdshlandlock.so', probeLandlock: () => 'full' },
  });
  const command = ['/installed/libbash.so', '-c', 'echo "literal $()"'];
  const result = await provider.confine(command, { mode: 'read-only', workspaceRoot: tmpdir() });
  assert.equal(result.argv[0], '/installed/libdshlandlock.so');
  assert.deepEqual(result.argv.slice(-4), ['--', ...command]);
  assert.equal(result.enforcement, 'full');
  const desktop = Object.assign(Object.create(LocalSandbox.prototype), { internals: { platform: 'darwin' } });
  assert.deepEqual(desktop.selectRunner('read-only'), { runner: 'seatbelt', enforcement: 'full' });
});

async function filesFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-android-file-tools-'));
  const fibers = [];
  t.after(async () => { for (const fiber of fibers) await fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  async function backend() {
    const ctx = new Context(); const fiber = ctx.plugin(LocalFileSystem, { cwd: root }); fibers.push(fiber); await fiber;
    ctx.fs.internals.platform = 'android';
    ctx.fs.internals.linkFile = () => { throw Error('Android hard links forbidden'); };
    // Host surrogate for the no-replace syscall; actual renameat2 is tested on Android.
    ctx.fs.internals.publishNewFileAndroid = async (source, target) => { await link(source, target); await rm(source); };
    return ctx.fs;
  }
  return { root, backend };
}

test('Android guarded file creation preserves the winning creator and cleans staging directories', async t => {
  const f = await filesFixture(t), one = await f.backend(), two = await f.backend();
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  for (const fs of [one, two]) fs.internals.inspectTemp = async () => { if (++arrivals === 2) release(); await barrier; };
  const target = await one.resolve('new.txt');
  const results = await Promise.allSettled([one, two].map((fs, i) => fs.writeText(target, 'winner-' + i, { kind: 'createIfAbsent' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'FS_NOT_OBSERVED');
  const winner = results[0].status === 'fulfilled' ? 'winner-0' : 'winner-1';
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), winner);
  assert.deepEqual(await readdir(f.root), ['new.txt']);
  await assert.rejects(one.writeText(target, 'overwrite', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' });
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), winner);
});

test('cancelled Android creation publishes nothing and cleans its staged data', async t => {
  const f = await filesFixture(t), fs = await f.backend(), abort = new AbortController();
  fs.internals.inspectTemp = async () => abort.abort();
  await assert.rejects(fs.writeText(await fs.resolve('cancelled.txt'), 'complete', { kind: 'createIfAbsent' }, abort.signal),
    { code: 'FS_ABORTED' });
  assert.deepEqual(await readdir(f.root), []);
});
