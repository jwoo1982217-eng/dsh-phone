import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { Session } from '@deepseek-ai/dsh-session';
import { NativeControlBridge } from './bridge.mjs';
import { apply, localOwner } from './index.mjs';
import { inject as phoneHostInject } from '../phone-qq/index.js';

async function server(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'phone-control-')), path = join(dir, 'native.sock'), received = [];
  const sockets = new Set();
  const native = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let body = Buffer.alloc(0);
    socket.on('data', chunk => { body = Buffer.concat([body, chunk]); });
    socket.on('end', () => {
      assert.ok(body.length > 4); assert.equal(body.readUInt32BE(0), body.length - 4);
      const request = JSON.parse(body.subarray(4).toString()); received.push(request);
      const result = handler(request, socket);
      if (result !== undefined) socket.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve, reject) => { native.once('error', reject); native.listen(path, resolve); });
  t.after(async () => { sockets.forEach(s => s.destroy()); await new Promise(r => native.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { bridge: new NativeControlBridge(path), path, received };
}
const ok = value => ({ ok: true, value });
const signal = () => new AbortController().signal;
const agent = (id = 'session-a', header = {}) => { const session = Session.create(id); return { id, session: Object.keys(header).length ? Session.create(id, [], { ...session.header, ...header }) : session }; };
async function evidence(name, value) {
  const folder = process.env.DSH_CONTROL_TEST_EVIDENCE;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name + '.json'), JSON.stringify({ runtime: 'actual pinned DSH ToolRuntime and native protocol test socket', ...value }, null, 2) + '\n');
}

test('private transport preserves JSON and exact native request framing', async t => {
  const native = await server(t, req => ok({ task: req.task }));
  assert.deepEqual(await native.bridge.call('request', { owner: 'session-a', task: '搜索天气：literal $() 和换行\n' }), { task: '搜索天气：literal $() 和换行\n' });
  assert.equal(native.received.length, 1);
});
test('execution reads the native lease epoch and makes exactly one mutation', async t => {
  const native = await server(t, req => req.command === 'status' ? ok({ grant: { epoch: 42 } }) : ok({ status: 'performed' }));
  assert.equal((await native.bridge.execute('session-a', { action: 'read' }, signal())).status, 'performed');
  assert.equal(native.received[1].epoch, 42); assert.match(native.received[1].requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(native.received.map(r => r.command), ['status', 'execute']);
});
test('a pending grant never authorizes a mutation', async t => {
  const native = await server(t, () => ok({ grant: null, request: { task: 'pending' } }));
  await assert.rejects(native.bridge.execute('session-a', { action: 'click' }), /同步现有会话权限/);
  assert.equal(native.received.length, 1);
});
test('native rejection is preserved and no action is repeated', async t => {
  const native = await server(t, () => ({ ok: false, error: '界面已经变化，未执行' }));
  await assert.rejects(native.bridge.call('execute', { owner: 'session-a', requestId: 'fixture' }), /界面已经变化/);
  assert.equal(native.received.length, 1);
});
test('abort requests native cancellation without repeating the mutation', async t => {
  let mutationStarted;
  const started = new Promise(r => { mutationStarted = r; });
  const native = await server(t, req => { if (req.command === 'execute') { mutationStarted(); return; } return ok({ status: 'cancelled' }); });
  const controller = new AbortController();
  const result = native.bridge.call('execute', { owner: 'session-a', requestId: 'fixture' }, controller.signal);
  await started; controller.abort(Error('user stopped'));
  await assert.rejects(result, /user stopped/);
  for (let i = 0; i < 30 && native.received.length < 2; i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(native.received.map(r => r.command), ['execute', 'cancel']);
});
test('timeout reports an unknown result and sends cancellation, without retry', async t => {
  const native = await server(t, req => req.command === 'cancel' ? ok({ status: 'cancelled' }) : undefined);
  native.bridge.timeout = 40;
  await assert.rejects(native.bridge.call('execute', { owner: 'session-a', requestId: 'fixture' }), /结果未知/);
  for (let i = 0; i < 30 && native.received.length < 2; i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(native.received.map(r => r.command), ['execute', 'cancel']);
});
test('missing bridge, too-large input and pre-abort never start a socket', async () => {
  await assert.rejects(new NativeControlBridge('').call('status'), /Android APK/);
  let calls = 0; const native = new NativeControlBridge('fixture', { connect: () => { calls++; throw Error('must not connect'); } });
  await assert.rejects(native.call('request', { task: 'x'.repeat(66000) }), /过大/);
  const aborted = new AbortController(); aborted.abort(Error('cancelled before start'));
  await assert.rejects(native.call('status', {}, aborted.signal), /cancelled before start/); assert.equal(calls, 0);
});
test('QQ, no-session and delegated agents cannot inherit native authority', () => {
  for (const exec of [{}, { agent: agent('qq-dm-123') }, { agent: agent('fixture', { origin: 'subagent' }) }, { agent: agent('fixture', { delegationDepth: 1 }) }]) assert.throws(() => localOwner(exec), /仅供手机本机/);
  assert.equal(localOwner({ agent: agent() }), 'session-a');
});
async function runtime(t, bridge, android = true) {
  const ctx = new Context(); await ctx.plugin(SessionProjections); await ctx.plugin(SandboxPolicy, {mode:'danger-full-access'}); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
  t.after(() => ctx.fiber.dispose()); apply(ctx, { android, bridge });
  return { ctx, run: (name, args = {}, caller = agent(), abortSignal = signal()) => ctx.tools.execute({ name, arguments: args, callId: 'fixture-call', agent: caller, signal: abortSignal }) };
}
test('the phone host declaration lets the helper read session services inside a protected Cordis plugin', async t => {
  const native = await server(t, () => ok({ status: 'ready' }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionProjections); await ctx.plugin(SandboxPolicy, { mode: 'read-only' });
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
  // A root Context permits undeclared reads and hid the integration failure.
  // Use the production host declaration at the real Cordis injection boundary.
  await ctx.plugin({
    name: 'phone-host-consumer',
    inject: phoneHostInject.filter(key => ['tools', 'systemPrompt', 'sandboxPolicy', 'sessionProjections'].includes(key)),
    apply: owner => apply(owner, { android: true, bridge: native.bridge }),
  });
  const result = await ctx.tools.execute({ name: 'phone_control_status', arguments: {}, callId: 'protected-host', agent: agent(), signal: signal() });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(JSON.parse(result.value).permissionMode, 'read-only');
  assert.equal(native.received[0].owner, 'session-a');
  await evidence('protected-host-injection', { protectedCordisContext: true, toolsRegistered: true, actualPolicyMode: JSON.parse(result.value).permissionMode });
});
test('actual DSH ToolRuntime binds caller and derives mode from the existing session policy', async t => {
  const native = await server(t, req => ok({ status: req.command === 'session' ? 'authorized' : 'read', text:'fixture' }));
  const fixture = await runtime(t, native.bridge);
  const result = await fixture.run('phone_app_logs', {package:'com.example.app',owner:'qq-dm-forged',mode:'read-only'});
  assert.equal(result.isError,false,JSON.stringify(result)); assert.equal(native.received[0].owner,'session-a'); assert.equal(native.received[0].mode,'danger-full-access');
  assert.equal(native.received[1].package,'com.example.app');
  await evidence('caller-binding', {expectedOwner:'session-a',receivedOwner:native.received[0].owner,receivedMode:native.received[0].mode,suppliedForgedOwner:'qq-dm-forged'});
});
test('actual tool runtime rejects invalid schema, QQ and cancellation before any native call', async t => {
  const native = await server(t, () => ok({})); const fixture = await runtime(t, native.bridge);
  assert.equal((await fixture.run('phone_control', { action: 'shell' })).isError, true);
  assert.equal((await fixture.run('phone_control_status', {}, agent('qq-dm-123'))).isError, true);
  const abort = new AbortController(); abort.abort(); assert.equal((await fixture.run('phone_control_status', {}, agent(), abort.signal)).isError, true);
  assert.equal(native.received.length, 0);
  await evidence('caller-boundary', { nativeCalls: native.received.length, invalidSchemaDenied: true, qqDenied: true, preCancelledDenied: true });
  const recovered = await fixture.run('phone_control_status'); assert.equal(recovered.isError, false); assert.equal(native.received.length, 1); assert.equal(native.received[0].owner, 'session-a');
  await evidence('caller-recovery', { validCallerRecovered: recovered.isError === false, nativeCallsAfterRecovery: native.received.length, receivedOwner: native.received[0].owner });
});
test('desktop mounts no phone tools', async t => {
  const fixture = await runtime(t, {}, false); assert.equal((await fixture.run('phone_control_status')).isError, true);
});
test('standalone JSON CLI invokes the bridge and requires explicit local ownership', async t => {
  const native = await server(t, req => ok({ status: 'off', owner: req.owner })); const exec = promisify(execFile);
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const result = await exec(process.execPath, [cli, '--json', 'status', '--owner', 'session-a'], { env: { ...process.env, DSH_PHONE_CONTROL_SOCKET: native.path } });
  assert.deepEqual(JSON.parse(result.stdout), ok({ status: 'off', owner: 'session-a' }));
  await assert.rejects(exec(process.execPath, [cli, '--json', 'status', '--owner', 'qq-dm-123'])); assert.equal(native.received.length, 1);
});
test('full session mode performs successive actions directly with no task request or native approval', async t => {
  const native = await server(t, req => req.command === 'status' ? ok({grant:{epoch:48,allApps:true,policyMode:'danger-full-access'}}) : ok({status:req.command === 'session' ? 'authorized' : 'performed'}));
  const fixture = await runtime(t,native.bridge);
  for (const action of ['click','long_press']) assert.equal((await fixture.run('phone_control',{action,snapshotId:'native-fresh',nodeId:'n1',x:100,y:200})).isError,false);
  assert.deepEqual(native.received.map(r=>r.command),['session','status','execute','session','status','execute']);
  assert.ok(native.received.filter(r=>r.command==='session').every(r=>r.mode==='danger-full-access'));
  await evidence('session-mode-runtime',{nativeCommands:native.received.map(r=>r.command),extraApprovalCalls:0,mutations:2});
});
test('logs and Termux tools bind the real owner and use result polling rather than repeating a command', async t => {
  const native = await server(t, req => ok({ status: req.command === 'termux_start' ? 'running' : req.command === 'logs' ? 'read' : 'completed', jobId: 'job-fixture', text: 'fixture diagnostic', exitCode: 7 }));
  const fixture = await runtime(t, native.bridge);
  assert.equal((await fixture.run('phone_app_logs', { package: 'com.example.app', lines: 200, owner: 'forged' })).isError, false);
  const started = await fixture.run('phone_termux_run', { script: 'printf fixture; exit 7', seconds: 5, owner: 'forged' }); assert.equal(started.isError, false);
  const completed = await fixture.run('phone_termux_result', { jobId: JSON.parse(started.value).jobId, owner: 'forged' }); assert.equal(JSON.parse(completed.value).exitCode, 7);
  assert.deepEqual(native.received.map(r => r.command), ['session', 'logs', 'session', 'termux_start', 'termux_result']); assert.ok(native.received.every(r => r.owner === 'session-a'));
  assert.match(native.received[3].requestId, /^[a-f0-9-]{36}$/);
});
test('cloud and delegated callers cannot reach log or Termux interfaces', async t => {
  const native = await server(t, () => ok({})); const fixture = await runtime(t, native.bridge);
  for (const caller of [agent('cloud-fixture'), agent('qq-dm-fixture'), agent('fixture', { origin: 'subagent' })]) {
    assert.equal((await fixture.run('phone_app_logs', { package: 'com.example.app' }, caller)).isError, true);
    assert.equal((await fixture.run('phone_termux_run', { script: 'echo fixture' }, caller)).isError, true);
  }
  assert.equal(native.received.length, 0);
});
test('screenshot refuses a missing attachment service instead of sending base64 as model text', async t => {
  const native = await server(t, req => req.command === 'status' ? ok({ grant: { epoch: 48 } }) : ok({ status: 'screenshot', epoch: 48, image: { mediaType: 'image/jpeg', base64: 'test-fixture' } }));
  const fixture = await runtime(t, native.bridge);
  const result = await fixture.run('phone_control', { action: 'screenshot' }); assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('test-fixture'));
});

test('existing read-only/workspace policy blocks forged full-access mutations but permits observations',async t=>{
  const native=await server(t,req=>req.command==='status'?ok({grant:{epoch:48}}):ok({status:req.command==='execute'?'observed':'authorized'}));
  const fixture=await runtime(t,native.bridge),caller=agent();
  for(const mode of ['read-only','workspace-write']){
    setSandboxMode(caller.session,mode);
    const before=native.received.length;
    assert.equal((await fixture.run('phone_control',{action:'click',mode:'danger-full-access'},caller)).isError,true);
    assert.equal((await fixture.run('phone_termux_run',{script:'echo fixture',mode:'danger-full-access'},caller)).isError,true);
    assert.equal(native.received.length,before);
    const observed=await fixture.run('phone_control',{action:'read'},caller); assert.equal(observed.isError,false,JSON.stringify(observed));
    assert.equal(native.received[before].mode,mode);
  }
  setSandboxMode(caller.session,'danger-full-access');
  assert.equal((await fixture.run('phone_control',{action:'click',snapshotId:'fresh',nodeId:'n1'},caller)).isError,false);
  await evidence('mode-boundary-recovery',{readOnlyDenied:true,workspaceDenied:true,forgedModeDenied:true,fullModeRecovered:true});
});
