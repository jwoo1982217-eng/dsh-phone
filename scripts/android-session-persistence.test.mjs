import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
const { default: JsonlSessionPersistence } = await import(process.env.DSH_PERSISTENCE_MODULE ?? new URL('../runtime/overlays/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js', import.meta.url).href);
const { tryLockExclusive } = await import(process.env.DSH_FLOCK_MODULE ?? new URL('../runtime/overlays/@deepseek-ai/node-addon-system/lib/flock.js', import.meta.url).href);
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';

async function fixture(t, compression = 'none') {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-android-persistence-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const backend = Object.assign(Object.create(JsonlSessionPersistence.prototype), {
    root: join(parent, 'sessions'), compression, packChunks: false,
  });
  if (process.platform !== 'android') backend.publishNewFileAndroid = async (source, target) => {
    // Host-only filesystem surrogate; the actual Android run uses renameat2.
    await link(source, target); await rm(source);
  };
  const meta = { version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1, delegationDepth: 0, isSeeded: false };
  const path = backend.locate(meta).path;
  return { backend, meta, parent, path };
}

test('Android dispatch never calls the hard-link path and publishes readable plaintext', async t => {
  const f = await fixture(t);
  const previous = process.env.DSH_PHONE_ANDROID;
  process.env.DSH_PHONE_ANDROID = '1';
  t.after(() => previous === undefined ? delete process.env.DSH_PHONE_ANDROID : process.env.DSH_PHONE_ANDROID = previous);
  f.backend.materializePosix = () => { throw new Error('hard links forbidden'); };
  await f.backend.materialize(f.meta, 0, []);
  const text = await readFile(f.path, 'utf8');
  assert.equal(JSON.parse(text.split('\n')[0]).id, f.meta.id);
  assert.deepEqual(await readdir(f.parent), ['sessions']);
});

test('Android publishes the existing Zstandard frame format without hard links', async t => {
  const f = await fixture(t, 'zstd');
  const content = await f.backend.encodeMaterialization(f.meta, 0, []);
  await f.backend.materializeAndroid(dirname(dirname(f.path)), dirname(f.path), f.path, f.meta.id, content);
  const encoded = await readFile(f.path);
  assert.deepEqual(encoded, content);
  assert.equal(JSON.parse(zstdDecompressSync(encoded).toString().split('\n')[0]).id, f.meta.id);
});

test('two creators racing for one session publish one whole log without overwriting it', async t => {
  const f = await fixture(t);
  const second = Object.assign(Object.create(JsonlSessionPersistence.prototype), {
    root: f.backend.root, compression: 'none', packChunks: false,
  });
  if (process.platform !== 'android') second.publishNewFileAndroid = f.backend.publishNewFileAndroid;
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  for (const backend of [f.backend, second]) {
    backend.rejectExistingLog = async () => { if (++arrivals === 2) release(); await barrier; };
  }
  const results = await Promise.allSettled([f.backend, second].map(async (backend, index) => {
    const meta = { ...f.meta, createdAt: index + 10 };
    const content = await backend.encodeMaterialization(meta, 0, []);
    await backend.materializeAndroid(dirname(dirname(f.path)), dirname(f.path), f.path, meta.id, content);
    return meta.createdAt;
  }));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.find(r => r.status === 'fulfilled').value;
  assert.equal(JSON.parse((await readFile(f.path, 'utf8')).split('\n')[0]).createdAt, winner);
  assert.deepEqual(await readdir(f.parent), ['sessions']);
});

test('an existing log is preserved byte for byte', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.path), { recursive: true });
  await writeFile(f.path, 'existing private history');
  await assert.rejects(f.backend.materializeAndroid(dirname(dirname(f.path)), dirname(f.path), f.path, f.meta.id, 'new'), /already exists/);
  assert.equal(await readFile(f.path, 'utf8'), 'existing private history');
});

test('a failed old creation may leave an empty directory, which can be recovered', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.path), { recursive: true });
  await f.backend.materializeAndroid(dirname(dirname(f.path)), dirname(f.path), f.path, f.meta.id, 'complete');
  assert.equal(await readFile(f.path, 'utf8'), 'complete');
});

test('unrelated files in an existing session directory cannot be overwritten', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.path), { recursive: true });
  const other = join(dirname(f.path), 'other.txt');
  await writeFile(other, 'keep me');
  await assert.rejects(f.backend.materializeAndroid(dirname(dirname(f.path)), dirname(f.path), f.path, f.meta.id, 'new'));
  assert.equal(await readFile(other, 'utf8'), 'keep me');
  assert.deepEqual(await readdir(f.parent), ['sessions']);
});

test('first Android publication preserves the held SDK session.lock inode', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.path), { recursive: true });
  const path = join(dirname(f.path), 'session.lock');
  const held = await open(path, 'a+'); t.after(() => held.close());
  await tryLockExclusive(held.fd);
  const before = await stat(path);
  const content = await f.backend.encodeMaterialization(f.meta, 0, []);
  await f.backend.materializeAndroid(dirname(dirname(f.path)), dirname(f.path), f.path, f.meta.id, content);
  assert.equal((await stat(path)).ino, before.ino);
  const rival = await open(path, 'a+'); t.after(() => rival.close());
  await assert.rejects(tryLockExclusive(rival.fd), error => ['EAGAIN', 'EWOULDBLOCK'].includes(error.code));
  assert.deepEqual(await readFile(f.path), Buffer.from(content));
});
