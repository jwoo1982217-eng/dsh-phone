import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhoneToolHub } from './hub.mjs';
import { newPair, parsePair, connectionLink, makeCipher } from './protocol.mjs';
import { makeCipher as oldCipher, connectionLink as oldLink } from '../../peer/protocol.mjs';
import { createRelay } from './relay.mjs';
import { ToolTunnel } from './tunnel.mjs';
import { serveMcp } from './mcp.mjs';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { LocalTools } from './registry.mjs';

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'phone-tools-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await cp(new URL('../sample-tools/', import.meta.url), path.join(home, 'cloud-tool-hub/tools'), { recursive: true });
  const calls = [], bridge = { async call(command, args) { calls.push({ command, ...args }); return { apps: [{ package: 'org.example.notes', name: 'Notes' }], grant: null }; }, async execute(owner, args) { calls.push({ owner, args }); return { status: 'done' }; } };
  let now = Date.now();
  const hub = new PhoneToolHub({ home, bridge, now: () => now, getSkills: async () => [{ id: 'selected', name: 'selected', content: 'workflow', enabled: true }, { id: 'private', name: 'private', content: 'SECRET', enabled: true }] });
  hub.config = { enabled: true, skillIds: ['selected'], toolIds: ['note-normalize'] }; hub.online = true;
  const request = () => hub.call('phone_task_request', { requestId: 'task-' + Math.random().toString().slice(2), title: '整理笔记', packages: ['org.example.notes'] });
  const task = await request();
  return { hub, task, home, calls, request, advance(ms) { now += ms; hub.expire(); } };
}

test('task is pending until local consent; private skills and local approval endpoints stay unavailable', async t => {
  const { hub, task } = await fixture(t);
  assert.equal(task.status, 'pending');
  await assert.rejects(hub.call('phone_workspace_list', { taskId: task.taskId }), /未授权/);
  await assert.rejects(hub.call('task.approve', { taskId: task.taskId }), /未授权/);
  const status = await hub.call('phone_status'); assert.equal(JSON.stringify(status).includes(task.taskId), false);
  await hub.approveTask(task.taskId, true);
  assert.deepEqual((await hub.call('phone_skill_list', task)).skills.map(s => s.id), ['selected']);
  await assert.rejects(hub.call('phone_skill_read', { ...task, skillId: 'private' }), /未在手机共享/);
  await assert.rejects(hub.call('operation.approve', task), /不属于/);
});

test('exact once file consent, changed file rejected, path traversal and symlink blocked', async t => {
  const { hub, task, home } = await fixture(t); await hub.approveTask(task.taskId, true);
  const args = { ...task, requestId: 'write-1', filename: 'notes.txt', content: 'approved text' };
  const op = await hub.call('phone_workspace_write', args);
  await assert.rejects(hub.call('phone_operation_execute', { ...task, ...op }), /尚未在手机确认/);
  hub.approveOperation(op.operationId, true);
  const a = await hub.call('phone_operation_execute', { ...task, ...op }); assert.equal(a.status, 'done');
  assert.deepEqual(await hub.call('phone_operation_execute', { ...task, ...op }), a);
  assert.deepEqual(await hub.call('phone_workspace_write', args), a);
  await assert.rejects(hub.call('phone_workspace_write', { ...args, content: 'different' }), /不能改变/);
  assert.equal((await hub.call('phone_workspace_read', { ...task, filename: 'notes.txt' })).content, 'approved text');
  await assert.rejects(hub.call('phone_workspace_read', { ...task, filename: '../credentials.json' }), /文件名/);
  const root = hub.tasks.get(task.taskId).workspace;
  await writeFile(path.join(home, 'secret'), 'SECRET'); await symlink(path.join(home, 'secret'), path.join(root, 'link'));
  await assert.rejects(hub.call('phone_workspace_read', { ...task, filename: 'link' }), /安全读取/);
  const change = await hub.call('phone_workspace_write', { ...args, requestId: 'write-2' }); hub.approveOperation(change.operationId, true);
  await writeFile(path.join(root, 'notes.txt'), 'changed locally');
  const refused = await hub.call('phone_operation_execute', { ...task, ...change }); assert.equal(refused.status, 'failed');
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'changed locally');
});

test('actual local script produces artifact from frozen approved source, rejects unknown args and is never repeated', async t => {
  const { hub, task, home } = await fixture(t); await hub.approveTask(task.taskId, true);
  await assert.rejects(hub.call('phone_local_run', { ...task, requestId: 'bad', toolId: 'note-normalize', args: { shell: 'whoami' } }), /未声明/);
  const op = await hub.call('phone_local_run', { ...task, requestId: 'run-1', toolId: 'note-normalize', args: { text: 'hello  \r\nworld  ' } });
  await writeFile(path.join(home, 'cloud-tool-hub/tools/note-normalize/tool.mjs'), 'throw Error("new, unapproved code");');
  hub.approveOperation(op.operationId, true);
  const done = await hub.call('phone_operation_execute', { ...task, ...op }); assert.equal(done.status, 'done'); assert.equal(done.result.exitCode, 0);
  const file = path.join(hub.tasks.get(task.taskId).workspace, 'note.txt'); assert.equal(await readFile(file, 'utf8'), 'hello\nworld\n');
  await writeFile(file, 'later change');
  assert.deepEqual(await hub.call('phone_operation_execute', { ...task, ...op }), done); assert.equal(await readFile(file, 'utf8'), 'later change');
});

test('native requests use phone-generated owner and root fields; App retry receipt prevents duplicate execution', async t => {
  const { hub, task, calls } = await fixture(t); await hub.approveTask(task.taskId, true);
  await hub.call('phone_app_request', { ...task, owner: 'forged' });
  const request = calls.find(c => c.command === 'request'); assert.match(request.owner, /^cloud-/); assert.equal(request.task, '整理笔记'); assert.deepEqual(request.packages, ['org.example.notes']);
  const args = { ...task, requestId: 'app-1', owner: 'forged', action: { action: 'read', owner: 'forged' } };
  await hub.call('phone_app_control', args); await hub.call('phone_app_control', args);
  assert.equal(calls.filter(c => c.args).length, 1); assert.equal(calls.find(c => c.args).owner, request.owner);
  await assert.rejects(hub.call('phone_app_control', { ...args, action: { action: 'back' } }), /不能改变/);
});

test('disconnect and expiry revoke grants and pending operations without affecting other native owners', async t => {
  const { hub, task, calls, request, advance } = await fixture(t); await hub.approveTask(task.taskId, true);
  const op = await hub.call('phone_workspace_write', { ...task, requestId: 'pending', filename: 'note.txt', content: 'x' });
  hub.disconnect(); assert.equal(hub.operations.get(op.operationId).status, 'cancelled');
  await assert.rejects(hub.call('phone_operation_execute', { ...task, ...op }), /未授权/);
  assert.ok(calls.every(c => c.owner?.startsWith('cloud-')));
  hub.online = true; const next = await request(); advance(300001); await assert.rejects(hub.approveTask(next.taskId, true), /已处理/);
});

test('separate pair namespace, directional encryption, replay and cross-product ciphertext rejected', () => {
  const pair = newPair('ws://127.0.0.1:8789/relay'); assert.deepEqual(parsePair(connectionLink(pair)), pair);
  assert.throws(() => parsePair(oldLink(pair))); assert.throws(() => newPair('ws://example.org/relay'));
  assert.throws(() => parsePair(connectionLink(pair).replace('#dsh-tools:1:', '#dsh-tools:1::')));
  const phone = makeCipher(pair, 'phone'), cloud = makeCipher(pair, 'computer'), packet = phone.seal({ ok: true });
  assert.deepEqual(cloud.open(packet), { ok: true }); assert.throws(() => cloud.open(packet)); assert.throws(() => phone.open(packet));
  assert.throws(() => oldCipher(pair, 'computer').open(phone.seal({ secret: 'x' })));
});

test('trusted local tool import is opt-in, preserves existing version and permits recovery after invalid import', async t => {
  const { hub, home } = await fixture(t), registry = new LocalTools(path.join(home, 'cloud-tool-hub/tools'));
  const bundle = { id: 'custom-note', title: 'Custom note', description: 'Write one local artifact', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, source: 'console.log("trusted");', exampleArgs: { text: 'example' } };
  await assert.rejects(registry.install({ ...bundle, id: '../bad' }), /标识/);
  await registry.install(bundle); assert.equal((await registry.list()).some(t => t.id === bundle.id), true);
  assert.equal(hub.config.toolIds.includes(bundle.id), false);
  await assert.rejects(registry.install({ ...bundle, source: 'throw Error("overwrite");' }), /旧版保留/);
  assert.equal((await registry.snapshot(bundle.id)).source, bundle.source);
});

test('concurrent requests with the same operation ID converge on a single approval', async t => {
  const { hub, task } = await fixture(t); await hub.approveTask(task.taskId, true);
  const args = { ...task, requestId: 'concurrent', filename: 'same.txt', content: 'once' };
  const proposals = await Promise.all(Array.from({ length: 8 }, () => hub.call('phone_workspace_write', args)));
  assert.equal(new Set(proposals.map(p => p.operationId)).size, 1); assert.equal(hub.operations.size, 1);
});

test('script nonzero exit is a failed receipt and invalid UTF-8 is not returned as text', async t => {
  const { hub, task, home } = await fixture(t); await hub.approveTask(task.taskId, true);
  await writeFile(path.join(home, 'cloud-tool-hub/tools/note-normalize/tool.mjs'), 'console.error("expected failure");process.exitCode=2;');
  const op = await hub.call('phone_local_run', { ...task, requestId: 'exit-fail', toolId: 'note-normalize', args: { text: 'x' } }); hub.approveOperation(op.operationId, true);
  const result = await hub.call('phone_operation_execute', { ...task, ...op }); assert.equal(result.status, 'failed'); assert.equal(result.result.exitCode, 2);
  await writeFile(path.join(hub.tasks.get(task.taskId).workspace, 'binary.dat'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(hub.call('phone_workspace_read', { ...task, filename: 'binary.dat' }), /UTF-8/);
});

test('cancelled actual script keeps an uncertain receipt and never reruns partial effects', async t => {
  const { hub, task, home } = await fixture(t); await hub.approveTask(task.taskId, true);
  await writeFile(path.join(home, 'cloud-tool-hub/tools/note-normalize/tool.mjs'), "import {writeFile} from 'node:fs/promises'; await writeFile('partial.txt','once'); await new Promise(r=>setTimeout(r,20000));");
  const op = await hub.call('phone_local_run', { ...task, requestId: 'cancel-run', toolId: 'note-normalize', args: { text: 'x' } }); hub.approveOperation(op.operationId, true);
  const execution = hub.call('phone_operation_execute', { ...task, ...op });
  const file = path.join(hub.tasks.get(task.taskId).workspace, 'partial.txt');
  for (let i = 0; i < 50; i++) { try { await readFile(file); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
  assert.equal(await readFile(file, 'utf8'), 'once'); hub.disconnect();
  const receipt = await execution; assert.equal(receipt.status, 'unknown'); assert.equal(receipt.result.doNotRetry, true);
  await assert.rejects(hub.call('phone_operation_execute', { ...task, ...op }), /未授权/);
});

test('real relay and MCP stdio perform gated file roundtrip, offline never triggers execution', async t => {
  const { hub } = await fixture(t), relay = createRelay();
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const pair = newPair(`ws://127.0.0.1:${relay.server.address().port}/relay`), phone = new ToolTunnel(pair, 'phone');
  phone.handler = (name, args) => hub.call(name, args); phone.on('offline', () => hub.disconnect()); phone.start(); t.after(() => phone.stop());
  const input = new PassThrough(), output = new PassThrough(), server = serveMcp(pair, { input, output }); t.after(() => server.close());
  const responses = new Map(); let buffer = ''; output.on('data', bytes => { buffer += bytes; let i; while ((i = buffer.indexOf('\n')) >= 0) { const r = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); responses.get(r.id)?.(r); } });
  let id = 0;
  const rpc = (method, params) => new Promise(resolve => { const requestId = ++id; responses.set(requestId, resolve); input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); });
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); assert.equal(r.result.isError, false, r.result.content[0].text); return JSON.parse(r.result.content[0].text); };
  await rpc('initialize', { protocolVersion: '2025-11-25' }); assert.equal((await rpc('tools/list')).result.tools.length, 15);
  await once(server.tunnel, 'online');
  const task = await call('phone_task_request', { requestId: 'mcp-task', title: 'MCP 实际文件回环' }); await hub.approveTask(task.taskId, true);
  const op = await call('phone_workspace_write', { ...task, requestId: 'mcp-write', filename: 'result.txt', content: 'roundtrip verified' }); hub.approveOperation(op.operationId, true);
  assert.equal((await call('phone_operation_execute', { ...task, ...op })).status, 'done');
  assert.equal((await call('phone_workspace_read', { ...task, filename: 'result.txt' })).content, 'roundtrip verified');
  phone.stop(); await once(server.tunnel, 'offline');
  const offline = await rpc('tools/call', { name: 'phone_operation_execute', arguments: { ...task, ...op } }); assert.equal(offline.result.isError, true);
});
