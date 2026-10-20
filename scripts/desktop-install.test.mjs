import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installDesktop, assertDesktopNode } from './install-desktop.mjs';
import { desktopLaunch } from './start-desktop.mjs';
import { restoreDesktopUpstream } from './install-desktop-upstream.mjs';
import { createServer } from 'node:http';
import { desktopStatePath, runningDesktop, startDesktop } from './start-desktop.mjs';

test('fresh desktop install works without an existing engine and preserves overrides on reinstall', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-fresh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = path.join(home, 'profiles/web');
  await mkdir(profile, { recursive: true });
  const preset = '- id: my-existing-preset\n  disabled: true\n';
  await writeFile(path.join(profile, 'cordis.patch.yml'), preset);
  const first = await installDesktop({ home });
  assert.equal(first.fresh, true);
  const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'));
  for (const name of ['dsh-codearts-auth', '@zseven-w/dsh-noema', 'dsh-peer', 'dsh-desktop-chatgpt']) {
    assert.ok(manifest.dsh.profile.bundles.includes(name));
    assert.ok(await realpath(path.join(profile, 'node_modules', name)));
  }
  await writeFile(path.join(profile, 'credentials-marker'), 'keep credentials');
  const second = await installDesktop({ home });
  assert.equal(second.fresh, false);
  assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), preset);
  assert.equal(await readFile(path.join(profile, 'credentials-marker'), 'utf8'), 'keep credentials');
  const launch = await desktopLaunch({ home, noOpen: true });
  assert.ok(launch.args[1].endsWith('desktop-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'));
  assert.deepEqual(launch.args.slice(2), ['--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open']);
  assert.equal(launch.env.DSH_HOME, home);
  await restoreDesktopUpstream(second.backup);
  assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), preset);
});

test('desktop launch rejects incomplete installation and unsupported Node versions', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-incomplete-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'profiles/web'), { recursive: true });
  await writeFile(path.join(home, 'profiles/web/package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  await assert.rejects(desktopLaunch({ home }), /尚未安装完整/);
  for (const version of ['20.19.0', '22.19.0', '24.10.0', 'invalid']) assert.throws(() => assertDesktopNode(version));
  for (const version of ['24.11.0', '24.14.0', '26.0.0']) assert.doesNotThrow(() => assertDesktopNode(version));
});

test('reopening a live desktop does not spawn another engine or trust a stale login URL', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-reopen-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await installDesktop({ home });
  const server = createServer((req, res) => {
    if (req.url !== '/?token=local-test') { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script>window.__DSH_BOOT__={}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, file = desktopStatePath(home, port);
  const state = { home, version: '0.2.1-alpha.1', pid: process.pid, url: `http://127.0.0.1:${port}/?token=local-test` };
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  assert.deepEqual(await runningDesktop(home, port), state);
  assert.equal(await startDesktop({ home, port, noOpen: true }), 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), state);
  for (const url of [`http://127.0.0.1:${port}/?token=expired`, 'https://example.com/?token=local-test', `http://user:password@127.0.0.1:${port}/?token=local-test`]) {
    await writeFile(file, JSON.stringify({ ...state, url }));
    assert.equal(await runningDesktop(home, port), null);
  }
});
