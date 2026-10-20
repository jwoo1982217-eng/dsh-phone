import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = process.env.DSH_FLOCK_MODULE ?? new URL('../runtime/overlays/@deepseek-ai/node-addon-system/lib/flock.js', import.meta.url).href;
const { tryLockExclusive } = await import(moduleUrl);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-flock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.lock');
  const source = `
    const {tryLockExclusive} = await import(process.argv[1]);
    const {open} = await import('node:fs/promises');
    const fd = await open(process.argv[2], 'a+');
    await tryLockExclusive(fd.fd);
    console.log('locked');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async () => { await fd.close(); console.log('closed'); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, moduleUrl, path], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', text => { errors += text; });
  const ready = once(child.stdout, 'data');
  const result = await Promise.race([ready, once(child, 'exit').then(() => { throw Error(errors || 'lock holder exited'); })]);
  assert.equal(result[0].toString().trim(), 'locked');
  const fd = await open(path, 'a+'); t.after(() => fd.close());
  await assert.rejects(tryLockExclusive(fd.fd), error => ['EAGAIN', 'EWOULDBLOCK'].includes(error.code) && error.syscall === 'flock' && error.errno > 0);
  return { child, fd };
}

test('another process owns the session lock until its descriptor is closed', { timeout: 10000 }, async t => {
  const { child, fd } = await fixture(t);
  const closed = once(child.stdout, 'data'); child.stdin.write('close\n');
  assert.equal((await closed)[0].toString().trim(), 'closed');
  await tryLockExclusive(fd.fd);
});

test('a killed session owner releases its kernel lock without deleting the lock file', { timeout: 10000 }, async t => {
  const { child, fd } = await fixture(t);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await tryLockExclusive(fd.fd);
});

test('invalid descriptors fail with EBADF rather than granting a session lock', async () => {
  await assert.rejects(tryLockExclusive(-1), error => error.code === 'EBADF' && error.syscall === 'flock');
});
