import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxBash from '@deepseek-ai/dsh-bash-sandbox';
import { apply as applyBashTool } from '@deepseek-ai/dsh-tool-bash';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import { applyGlobTool, applyGrepTool, resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search';

assert.equal(process.platform, 'android');
const native = dirname(realpathSync(process.execPath));
const probe = spawnSync(join(native, 'libdshlandlock.so'), ['--probe'], { encoding: 'utf8', timeout: 3000 });
console.log('LANDLOCK_PROBE', JSON.stringify({ status: probe.status, signal: probe.signal, stdout: probe.stdout, stderr: probe.stderr }));
const root = join(dirname(tmpdir()), 'android-tool-fixtures');
const workspace = join(root, '工作区 with spaces');
const outside = join(root, 'outside');
// Outside must not be the granted TMPDIR; keep it in the test app's files tree.
const protectedDir = join(dirname(tmpdir()), 'protected-tools-fixture');
await mkdir(join(workspace, '目录'), { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(protectedDir, { recursive: true });
await writeFile(join(workspace, '目录/你好.md'), 'hello model\n中文内容\n');
await writeFile(join(workspace, '.hidden.md'), 'hidden marker\n');
await writeFile(join(protectedDir, 'keep.txt'), 'unchanged');
await symlink(join(protectedDir, 'keep.txt'), join(workspace, 'outside-link'));

const ctx = new Context();
const fibers = [];
try {
  const subprocessFiber = ctx.plugin(LocalSubprocess); fibers.push(subprocessFiber); await subprocessFiber;
  const sandboxFiber = ctx.plugin(LocalSandbox, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 2000 }); fibers.push(sandboxFiber); await sandboxFiber;
  const searchTools = new Map();
  const searchContext = {
    subprocess: ctx.subprocess,
    tools: { register: tool => searchTools.set(tool.name, tool) },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    on() {},
  };
  const caps = { maxResults: 100, maxMatches: 100, maxLineBytes: 1000, maxMetaBytes: 65536,
    rawOutputMaxBytes: 1000000, graceMs: 1000, stderrMaxBytes: 65536, timeoutMs: 3000 };
  applyGlobTool(searchContext, caps);
  applyGrepTool(searchContext, caps);
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } } };
  assert.equal(await resolveRgPath(), join(native, 'libdshrg.so'));
  const glob = await searchTools.get('glob').execute({ pattern: '**/*.md' }, exec);
  assert.deepEqual(new Set(glob.paths), new Set(['目录/你好.md', '.hidden.md']));
  const grep = await searchTools.get('grep').execute({ pattern: 'hello|中文', include: '*.md' }, exec);
  assert.equal(grep.matches.length, 2);
  assert.equal(grep.matches[1].line, '中文内容');
  const empty = await searchTools.get('grep').execute({ pattern: 'not-present-at-all' }, exec);
  assert.deepEqual(empty.matches, []);
  await assert.rejects(searchTools.get('grep').execute({ pattern: '[' }, exec), /pattern rejected/);
  const cancelledSearch = new AbortController(); cancelledSearch.abort();
  await assert.rejects(searchTools.get('glob').execute({ pattern: '*' }, { ...exec, signal: cancelledSearch.signal }),
    { code: 'SEARCH_ABORTED' });
  console.log('PASS Android glob/grep: Unicode, spaces, hidden paths, no matches, invalid regex');

  const shell = Object.create(SandboxBash.prototype);
  Object.defineProperty(shell, 'ctx', { value: ctx });
  shell.processFacts = new Map();
  shell.mode = 'workspace-write';
  shell.config = Object.fromEntries(Object.entries({ cwd: workspace, timeoutMs: 3000, maxTimeoutMs: 5000,
    maxOutputBytes: 64000, maxSpillBytes: 64000, graceMs: 1000 }).map(([k, v]) => [k, { get: () => v }]));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const run = async (command, mode) => (await shell.execute(shell.resolve({ command, workdir: workspace,
    sandboxPolicy: { mode, workspaceRoot: workspace }, signal: new AbortController().signal }))).result();
  if (probe.status === 0) {
    const read = await run('cat ' + quote(join(workspace, '目录/你好.md')), 'read-only');
    assert.equal(read.exitCode, 0);
    assert.match(read.stdout.text, /中文内容/);
    const denied = await run('printf changed > ' + quote(join(workspace, '目录/你好.md')), 'read-only');
    assert.notEqual(denied.exitCode, 0);
    assert.equal(denied.sandbox.denied, true);
    assert.equal(await readFile(join(workspace, '目录/你好.md'), 'utf8'), 'hello model\n中文内容\n');
    const write = await run('printf allowed > ' + quote(join(workspace, 'written.txt')), 'workspace-write');
    assert.equal(write.exitCode, 0);
    assert.equal(await readFile(join(workspace, 'written.txt'), 'utf8'), 'allowed');
    for (const target of [join(protectedDir, 'keep.txt'), join(workspace, 'outside-link')]) {
      const deniedOutside = await run('printf changed > ' + quote(target), 'workspace-write');
      assert.notEqual(deniedOutside.exitCode, 0);
      assert.equal(deniedOutside.sandbox.denied, true);
      assert.equal(await readFile(join(protectedDir, 'keep.txt'), 'utf8'), 'unchanged');
    }
    const temp = await run('printf temp-ok > ' + quote(join(tmpdir(), 'shell-temp.txt')), 'workspace-write');
    assert.equal(temp.exitCode, 0);
    console.log('PASS Android bash: read-only enforcement, workspace writes, protected path/symlink denial, private temp');
  } else {
    await assert.rejects(run('printf changed > ' + quote(join(protectedDir, 'keep.txt')), 'workspace-write'),
      error => error.code === 'SANDBOX_UNAVAILABLE' && error.message.includes('未获准不得执行'));
    assert.equal(await readFile(join(protectedDir, 'keep.txt'), 'utf8'), 'unchanged');
    console.log('PASS unavailable Android kernel: fail closed, protected file unchanged');
  }

  // Exercise the actual bash tool approval choreography, never a direct fallback.
  let outcome = 'rejected', approvals = 0;
  const approval = { async request(request) {
    approvals++;
    assert.match(request.displayReason.zh, /无法限制为仅工作区/);
    return outcome;
  } };
  const policy = { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) };
  const bashTools = new Map();
  const bashContext = { shell, systemPrompt: searchContext.systemPrompt, tools: { register: tool => bashTools.set(tool.name, tool) },
    shellEnv: { collect: () => ({}) }, get: name => ({ sandboxPolicy: policy, approval })[name] };
  applyBashTool(bashContext, { enableRunInBackground: false });
  const args = { description: 'Write a synthetic Android test file',
    command: 'printf authorized > ' + quote(join(workspace, 'approved.txt')),
    sandbox_permissions: 'danger-full-access', justification: 'Synthetic test command in the disposable test app' };
  await assert.rejects(bashTools.get('bash').execute(args, exec), /user rejected/);
  await assert.rejects(readFile(join(workspace, 'approved.txt')), { code: 'ENOENT' });
  outcome = 'allowed-once';
  const approved = await bashTools.get('bash').execute(args, exec);
  assert.equal(approved.exitCode, 0);
  assert.equal(await readFile(join(workspace, 'approved.txt'), 'utf8'), 'authorized');
  assert.equal(approvals, 2);
  assert.equal(shell.sandboxMode, 'workspace-write');
  const timed = await bashTools.get('bash').execute({ ...args, command: 'sleep 10', timeoutMs: 60 }, exec);
  assert.equal(timed.timedOut, true);
  // The next ordinary command still uses the standing mode; no durable widening.
  if (probe.status !== 0) await assert.rejects(run('printf unsafe', 'workspace-write'), { code: 'SANDBOX_UNAVAILABLE' });
  console.log('PASS actual bash tool: denied approval executes nothing; allowed-once executes; standing policy unchanged');

  const fsFiber = ctx.plugin(LocalFileSystem, { cwd: workspace }); fibers.push(fsFiber); await fsFiber;
  Object.setPrototypeOf(ctx.fs, SandboxedFileSystem.prototype);
  const writable = { mode: 'workspace-write', workspaceRoot: workspace };
  const fsTarget = await ctx.fs.resolve('file-tool.txt');
  await ctx.fs.writeText(fsTarget, 'original text', { kind: 'createIfAbsent' }, undefined, writable);
  await assert.rejects(ctx.fs.writeText(fsTarget, 'overwrite', { kind: 'createIfAbsent' }, undefined, writable), { code: 'FS_NOT_OBSERVED' });
  await ctx.fs.editText(fsTarget, { oldString: 'original', newString: 'edited', replaceAll: false }, undefined, undefined, writable);
  assert.equal(await ctx.fs.readText(fsTarget), 'edited text');
  for (const [target, mode] of [[fsTarget, 'read-only'], [await ctx.fs.resolve(join(protectedDir, 'keep.txt')), 'workspace-write'],
    [await ctx.fs.resolve('outside-link'), 'workspace-write']]) {
    await assert.rejects(ctx.fs.writeText(target, 'changed', undefined, undefined, { mode, workspaceRoot: workspace }),
      error => error.code === 'FS_SANDBOX_DENIED');
  }
  assert.equal(await readFile(join(protectedDir, 'keep.txt'), 'utf8'), 'unchanged');
  console.log('PASS actual file backend: read/write/edit; read-only, outside path and symlink restrictions');
  if (process.env.DSH_TEST_EXTERNAL_FILES) {
    const external = await ctx.fs.resolve(join(process.env.DSH_TEST_EXTERNAL_FILES, '中文 new file.txt'));
    const externalPolicy = { mode: 'workspace-write', workspaceRoot: process.env.DSH_TEST_EXTERNAL_FILES };
    await ctx.fs.writeText(external, 'external original', { kind: 'createIfAbsent' }, undefined, externalPolicy);
    await assert.rejects(ctx.fs.writeText(external, 'overwrite', { kind: 'createIfAbsent' }, undefined, externalPolicy),
      { code: 'FS_NOT_OBSERVED' });
    await ctx.fs.editText(external, { oldString: 'original', newString: 'edited', replaceAll: false }, undefined, undefined, externalPolicy);
    assert.equal(await ctx.fs.readText(external), 'external edited');
    console.log('PASS external Android storage: native guarded creation, collision protection, read/edit');
  } else throw Error('External storage fixture unavailable');
  console.log('DSH_ANDROID_TOOLS_OK');
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  await rm(root, { recursive: true, force: true });
  await rm(protectedDir, { recursive: true, force: true });
}
