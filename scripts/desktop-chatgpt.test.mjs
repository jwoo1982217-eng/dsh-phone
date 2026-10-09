import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installDesktopChatGpt } from './install-desktop-chatgpt.mjs';
import { installDesktopJetHubChatGpt } from './install-desktop-jet-hub-chatgpt.mjs';
test('desktop installation and reinstall preserve existing bundles and account-independent profile files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-chatgpt-')); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), modules = path.join(root, 'node_modules'); await mkdir(profile);
  for (const name of ['dsh', 'schemastery', 'dsh-credentials', 'dsh-llm']) {
    const dir = path.join(modules, '@deepseek-ai', name); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '0.2.1-alpha.1' }));
  }
  const manifest = { dependencies: { existing: 'file:./existing' }, dsh: { profile: { bundles: ['existing', 'dsh-peer'] } } };
  await writeFile(path.join(profile, 'package.json'), JSON.stringify(manifest)); await writeFile(path.join(profile, 'credentials-marker'), 'preserve this');
  await installDesktopChatGpt(profile, modules); await installDesktopChatGpt(profile, modules);
  await assert.rejects(access(path.join(profile, 'node_modules/dsh-desktop-chatgpt/client.js')), { code: 'ENOENT' });
  const result = JSON.parse(await readFile(path.join(profile, 'package.json')));
  assert.deepEqual(result.dsh.profile.bundles, ['existing', 'dsh-peer', 'dsh-desktop-chatgpt']); assert.equal(result.dependencies.existing, manifest.dependencies.existing);
  assert.equal(await readFile(path.join(profile, 'credentials-marker'), 'utf8'), 'preserve this');
  for (const name of ['chatgpt-account.js', 'chatgpt-adapter.js', 'chatgpt.js']) assert.equal(await readFile(path.join(profile, 'node_modules/dsh-desktop-chatgpt', name), 'utf8'), await readFile(new URL('../phone-account/' + name, import.meta.url), 'utf8'));
  const before = await readFile(path.join(profile, 'package.json'), 'utf8');
  await writeFile(path.join(modules, '@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.9.0' }));
  await assert.rejects(installDesktopChatGpt(profile, modules), /0.2.1-alpha.1/);
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), before);
});

test('Jet Hub rebuild and reinstall preserve server and settings files; unknown source is refused before writes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-jet-hub-chatgpt-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../vendor/dsh-codearts-auth/', import.meta.url));
  await cp(path.join(source, 'plugin-src'), path.join(root, 'plugin-src'), { recursive: true });
  await mkdir(path.join(root, 'lib/client'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh-codearts-auth' }));
  await symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'lib/index.js'), 'existing server');
  await writeFile(path.join(root, 'settings-marker'), 'existing settings');
  const first = await installDesktopJetHubChatGpt(root), second = await installDesktopJetHubChatGpt(root);
  assert.deepEqual(first.files, second.files);
  assert.equal(await readFile(path.join(root, 'lib/index.js'), 'utf8'), 'existing server');
  assert.equal(await readFile(path.join(root, 'settings-marker'), 'utf8'), 'existing settings');
  const bundled = await readFile(path.join(root, 'lib/client/jet-hub.js'), 'utf8');
  assert.ok(bundled.includes('ChatGPT 会员账号'));
  const file = path.join(root, 'plugin-src/client/index.js');
  const changed = (await readFile(file, 'utf8')) + '\n// unrelated edit\n'; await writeFile(file, changed);
  await assert.rejects(installDesktopJetHubChatGpt(root), /未覆盖任何文件/);
  assert.equal(await readFile(file, 'utf8'), changed);
  assert.equal(await readFile(path.join(root, 'lib/client/jet-hub.js'), 'utf8'), bundled);
});
