import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialBrowseDirectory, phoneStorageRoot, phoneStorageShortcut, storageFailureHint } from '../runtime/overlays/@deepseek-ai/dsh-host-directory-picker-browse/lib/android-storage.js';

test('Android permission changes are rechecked on the next directory picker opening', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'private'), storage = join(root, 'shared');
  await mkdir(home); await mkdir(storage);
  const denied = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
  assert.equal(await initialBrowseDirectory(home, { platform: 'android', storage, open: denied }), home);
  assert.equal(await initialBrowseDirectory(home, { platform: 'android', storage, open: opendir }), storage);
  const shortcut = phoneStorageShortcut(home, home, 'android', storage);
  assert.equal(shortcut[0].path, storage);
  assert.deepEqual(phoneStorageShortcut(storage, home, 'android', storage), []);
});

test('desktop browsing stays at home and Android denial explains the system permission', async () => {
  assert.equal(await initialBrowseDirectory('/private', { platform: 'darwin', open: () => { throw Error('must not probe phone storage'); } }), '/private');
  assert.deepEqual(phoneStorageShortcut('/private', '/private', 'darwin'), []);
  assert.equal(storageFailureHint('/Users/project', { code: 'EACCES' }, 'darwin'), '');
  assert.match(storageFailureHint('/storage/emulated/0', { code: 'EACCES' }, 'android'), /文件访问权限/);
  assert.equal(storageFailureHint('/storage/emulated/0', { code: 'ENOENT' }, 'android'), '');
  assert.equal(phoneStorageRoot({ DSH_PHONE_STORAGE: '/storage/ABCD-1234' }), '/storage/ABCD-1234');
  assert.equal(phoneStorageRoot({ DSH_PHONE_STORAGE: 'relative' }), '/storage/emulated/0');
});
