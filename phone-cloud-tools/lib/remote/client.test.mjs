import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HermesRemote, normalizeServer } from './client.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'hermes-remote-')); let saved = '', saveFail = false;
  const calls = [], runs = new Map(), keyed = new Map();
  let drop = false, statusCode = 200, changedApproval = false;
  const key = 'test-hermes-connection-32-characters';
  const caps = { platform: 'hermes-agent', model: 'my-profile', features: { run_submission: true, run_status: true, run_stop: true, runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 } } };
  const server = createServer(async (req, res) => {
    const data = []; for await (const c of req) data.push(c); const raw = Buffer.concat(data).toString(); const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'], body });
    const out = (value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (statusCode !== 200) return out({ error: key }, statusCode);
    if (req.headers.authorization !== 'Bearer ' + key) return out({}, 401);
    if (req.url === '/p/my-profile/v1/capabilities') return out(caps);
    if (req.url === '/p/my-profile/v1/runs' && req.method === 'POST') {
      const existing = keyed.get(req.headers['idempotency-key']);
      if (existing) { assert.deepEqual(existing.body, body); return out({ run_id: existing.id, status: 'started' }, 202); }
      const id = 'run_' + (runs.size + 1); runs.set(id, { run_id: id, session_id: body.session_id, status: 'running' }); keyed.set(req.headers['idempotency-key'], { id, body });
      if (drop) { drop = false; req.socket.destroy(); return; } return out({ run_id: id, status: 'started' }, 202);
    }
    const m = /^\/p\/my-profile\/v1\/runs\/(run_\d+)(\/stop|\/approval)?$/.exec(req.url); if (!m || !runs.has(m[1])) return out({}, 404);
    const run = runs.get(m[1]);
    if (m[2] === '/stop') { run.status = 'stopping'; return out({ status: 'stopping' }); }
    if (m[2] === '/approval') { assert.equal(body.request_id, 'approval_1'); assert.ok(['once','deny'].includes(body.choice)); run.status = 'running'; delete run.approval; return out({ run_id: run.run_id, choice: body.choice, resolved: 1 }); }
    return out(changedApproval ? { ...run, approval: { ...run.approval, command: 'changed' } } : run);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const credentials = { get: async () => saved, set: async value => { if (saveFail) throw Error('disk failed'); saved = value; } };
  const options = { home, credentials, timeout: 1000 };
  const remote = new HermesRemote(options); await remote.init();
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/p/my-profile';
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  return { remote, options, key, caps, baseUrl, runs, calls, home, drop: () => { drop = true; }, failSave: v => { saveFail = v; }, status: v => { statusCode = v; }, changeApproval: () => { changedApproval = true; } };
}

test('real HTTP: configured model stays server-side; conversations continue and do not ship local DSH histories or keys', async t => {
  const f = await fixture(t), c = f.remote; assert.equal(c.status().configured, false);
  await c.call('configure', { baseUrl: f.baseUrl + '/v1', key: f.key, name: '自己的 Hermes' }); await c.call('check');
  const id = (await c.call('create')).selectedId; await c.call('send', { id, text: '第一条任务' });
  assert.deepEqual(f.calls.find(x => x.method === 'POST').body, { input: '第一条任务', session_id: c.conversation(id).sessionId });
  f.runs.get('run_1').status = 'completed'; f.runs.get('run_1').output = '结果'; f.runs.get('run_1').runtime = { provider: 'custom', model: 'my-model' };
  await c.call('refresh', { id }); await c.call('refresh', { id }); assert.equal(c.conversation(id).messages.length, 2);
  await c.call('send', { id, text: '继续' }); assert.equal(f.runs.get('run_2').session_id, f.runs.get('run_1').session_id);
  assert.equal(c.status().conversations[0].run.id, 'run_2'); assert.ok(!JSON.stringify(c.status()).includes(f.key));
  assert.equal((await stat(c.file)).mode & 0o777, 0o600);
});

test('connection loss + process restart: exact durable key recovers existing run with one server-side execution', async t => {
  const f = await fixture(t); await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key });
  const id = (await f.remote.call('create')).selectedId; f.drop(); await f.remote.call('send', { id, text: '只执行一次' });
  assert.equal(f.remote.conversation(id).run.status, 'submission_unknown'); assert.equal(f.runs.size, 1);
  const restarted = new HermesRemote(f.options); await restarted.init(); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  await restarted.call('recover', { id }); assert.equal(restarted.conversation(id).run.id, 'run_1'); assert.equal(f.runs.size, 1);
  const sent = f.calls.filter(c => c.method === 'POST'); assert.equal(sent[0].idem, sent[1].idem); assert.deepEqual(sent[0].body, sent[1].body);
});

test('queued tasks and server-side session compaction preserve the client conversation address', async t => {
  const f = await fixture(t); await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key });
  const id = (await f.remote.call('create')).selectedId, original = f.remote.conversation(id).sessionId;
  await f.remote.call('send', { id, text: '排队任务' });
  const run = f.runs.get('run_1'); run.status = 'queued'; run.session_id = 'server_compacted_session';
  await f.remote.call('refresh', { id }); assert.equal(f.remote.conversation(id).run.status, 'queued');
  run.status = 'completed'; run.output = '已压缩并完成'; await f.remote.call('refresh', { id });
  await f.remote.call('send', { id, text: '继续同一对话' });
  assert.equal(f.runs.get('run_2').session_id, original);
});

test('local persistence failure blocks submission and leaves the previous conversation intact', async t => {
  const f = await fixture(t); await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key });
  const id = (await f.remote.call('create')).selectedId, previousFile = f.remote.file;
  const blocker = path.join(f.home, 'ordinary-file'); await writeFile(blocker, 'unchanged'); f.remote.file = path.join(blocker, 'conversations.json');
  await assert.rejects(f.remote.call('send', { id, text: '不应交给服务器' }));
  assert.equal(f.runs.size, 0); assert.equal(f.remote.conversation(id).messages.length, 0);
  f.remote.file = previousFile; await f.remote.call('send', { id, text: '恢复后正常发送' }); assert.equal(f.runs.size, 1);
});

test('unknown submission without durable storage cannot be retried; active tasks block switching credentials', async t => {
  const f = await fixture(t); f.caps.features.runs_idempotency.durable = false;
  await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key }); const id = (await f.remote.call('create')).selectedId;
  f.drop(); await f.remote.call('send', { id, text: '不能重发' });
  await assert.rejects(f.remote.call('recover', { id }), /不能安全/);
  await assert.rejects(f.remote.call('send', { id, text: '换编号重跑' }), /尚未结束/);
  await assert.rejects(f.remote.call('configure', { baseUrl: 'https://different.invalid', key: 'another-key' }), /原连接还有/);
  assert.equal(f.runs.size, 1);
});

test('server approvals bind fresh content and exact request; once/deny only, no permanent approval', async t => {
  const f = await fixture(t); await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key }); const id = (await f.remote.call('create')).selectedId;
  await f.remote.call('send', { id, text: '需要确认的任务' }); const run = f.runs.get('run_1'); run.status = 'waiting_for_approval'; run.approval = { request_id: 'approval_1', command: 'sample', choices: ['once','deny'] };
  await f.remote.call('refresh', { id }); await assert.rejects(f.remote.call('approve', { id, requestId: 'approval_1', choice: 'always' }), /无效/);
  await f.remote.call('approve', { id, requestId: 'approval_1', choice: 'once' }); assert.equal(run.status, 'running');
  run.status = 'waiting_for_approval'; run.approval = { request_id: 'approval_1', command: 'sample', choices: ['once','deny'] }; await f.remote.call('refresh', { id }); f.changeApproval();
  await assert.rejects(f.remote.call('approve', { id, requestId: 'approval_1', choice: 'once' }), /内容已经变化/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/approval')).length, 1);
});

test('read-only checks report auth/errors without leaking upstream credential text; save failure keeps old config', async t => {
  const f = await fixture(t); await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key }); f.failSave(true);
  await assert.rejects(f.remote.call('configure', { baseUrl: 'https://another.invalid', key: 'other' })); assert.equal(f.remote.config.baseUrl, f.baseUrl);
  f.failSave(false); f.status(401); await assert.rejects(f.remote.call('check'), /API_SERVER_KEY/); assert.equal(f.runs.size, 0);
  f.status(200); const id = (await f.remote.call('create')).selectedId; await f.remote.call('send', { id, text: '停止测试' });
  await f.remote.call('stop', { id }); assert.equal(f.remote.conversation(id).run.status, 'stopping');
  f.runs.get('run_1').status = 'cancelled'; f.runs.get('run_1').output = 'echo ' + f.key;
  await f.remote.call('refresh', { id }); assert.ok(!(await readFile(f.remote.file, 'utf8')).includes(f.key));
});

test('server URLs reject plaintext public hosts, credentials, query keys and redirects; profile prefixes preserved', async t => {
  assert.equal(normalizeServer('https://example.invalid/p/mine/v1/'), 'https://example.invalid/p/mine');
  for (const url of ['http://public.invalid', 'https://user:pass@example.invalid', 'https://example.invalid?key=secret', 'file:///tmp/secret', 'https://example.invalid/a%2fb']) assert.throws(() => normalizeServer(url));
  const f = await fixture(t); await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key });
  let targetHits = 0; const target = createServer((_req,res) => { targetHits++; res.end('{}'); }); await new Promise(r => target.listen(0,'127.0.0.1',r));
  const redirect = createServer((_req,res) => { res.writeHead(302,{ location: 'http://127.0.0.1:' + target.address().port }); res.end(); }); await new Promise(r => redirect.listen(0,'127.0.0.1',r));
  t.after(() => { target.close(); redirect.close(); });
  await f.remote.call('configure', { baseUrl: 'http://127.0.0.1:' + redirect.address().port, key: f.key });
  await assert.rejects(f.remote.call('check'), /连接中断/); assert.equal(targetHits, 0);
});

test('corrupt persistent conversations fail closed without replacing the old file', async t => {
  const f = await fixture(t); await f.remote.call('configure', { baseUrl: f.baseUrl, key: f.key }); await f.remote.call('create');
  await writeFile(f.remote.file, '{corrupt'); const other = new HermesRemote(f.options);
  await assert.rejects(other.init(), /已保留原文件/); assert.equal(await readFile(f.remote.file,'utf8'), '{corrupt');
});
