import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Appearance } from './appearance.mjs';
test('skin selection persists, rejects stale or external styles, and restores the original skin', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-appearance-')); t.after(() => rm(home, { recursive: true, force: true }));
  const appearance = new Appearance(home); await appearance.init(); assert.equal(appearance.status().skin, 'peach');
  await appearance.change('mint', 0); const saved = await readFile(appearance.file);
  await assert.rejects(appearance.change('peach', 0), /另一页面/);
  await assert.rejects(appearance.change('https://external/style.css', 1), /内置/); assert.deepEqual(await readFile(appearance.file), saved);
  const restart = new Appearance(home); await restart.init(); assert.equal(restart.status().skin, 'mint');
  await restart.change('original', 1); const restored = new Appearance(home); await restored.init(); assert.equal(restored.status().skin, 'original');
});
