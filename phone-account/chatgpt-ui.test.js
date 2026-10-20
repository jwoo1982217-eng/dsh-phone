import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyChatGpt } from './chatgpt.js';
import { CHATGPT_PROVIDER } from './chatgpt-adapter.js';
import { USAGE_URL } from './chatgpt-protocol.js';
import { createChatGptCall, chatGptAuthorizationUrl } from '../vendor/dsh-codearts-auth/plugin-src/client/chatgpt-plan-rpc.js';

test('desktop account uses this computer OAuth identity and returns to its browser account page', async t => {
  const data = new Map(), routes = new Map(), disposers = []; let rpc;
  const ctx = { credentials: { resolve: async ref => data.has(JSON.stringify(ref)) ? { value: data.get(JSON.stringify(ref)) } : undefined, set: async (ref, value) => data.set(JSON.stringify(ref), value) },
    on(event, fn) { if (event === 'dispose') disposers.push(fn); }, effect(fn) { return fn(); },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    connection: { rpc: { handle(path, handler, options) { assert.equal(path, '/phone-chatgpt'); assert.equal(options.authority, 'loopback'); rpc = handler; } } },
    llm: { registerAdapter(providers) { assert.deepEqual(providers, [CHATGPT_PROVIDER]); return () => {}; } }, get() {},
  };
  applyChatGpt(ctx, { desktop: true }); t.after(() => disposers.forEach(fn => fn()));
  const login = (await rpc('manage', { action: 'login' })).value;
  const url = new URL(login.attempt.authorizeUrl);
  assert.equal(url.searchParams.get('agent_name_hint'), 'DSH');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3080/auth/chatgpt/callback');
  const response = () => ({ writeHead(status) { this.status = status; return this; }, end(body) { this.body = String(body); } });
  const page = response(); routes.get('/phone-chatgpt')({ method: 'GET' }, page);
  assert.ok(page.body.includes('电脑网关')); assert.ok(!page.body.includes('http://127.0.0.1:8326/v1'));
  const callback = response(); await routes.get('/auth/chatgpt/callback')({ method: 'GET', url: '/auth/chatgpt/callback?state=wrong&code=do-not-reflect' }, callback);
  assert.equal(callback.status, 400); assert.ok(callback.body.includes('href="/phone-chatgpt"'));
  assert.ok(!callback.body.includes('dsh-phone://')); assert.ok(!callback.body.includes('do-not-reflect'));
});

test('account UI handles switch, logout/relogin, welcome acknowledgement and RPC failures without stale models', async () => {
  const html = await readFile(new URL('./chatgpt-page.html', import.meta.url), 'utf8');
  const elements = new Map();
  const element = () => ({ children: [], textContent: '', hidden: false, disabled: false, value: '', replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); } });
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  let snapshot = { active: 'one', planEnabled: true, signedIn: true, welcomeNeeded: true, profiles: [{ id: 'one', label: '测试连接', connected: true }, { id: 'two', label: '第二连接', connected: true }], attempt: null };
  let poll, calls = [], fail = false;
  const context = { document: { getElementById: byId, createElement: element }, crypto: { randomUUID }, confirm: () => true,
    location: { assign(url) { context.opened = url; } }, setInterval(fn) { poll = fn; }, fetch: async (_, init) => {
      const envelope = JSON.parse(init.body); calls.push(envelope); assert.equal(envelope.type, 'client-request'); assert.equal(envelope.method, 'manage');
      const { action, id } = envelope.payload;
      if (fail) return { ok: true, json: async () => ({ result: { ok: false, error: { message: '暂时不可用' } } }) };
      if (action === 'switch') snapshot = { ...snapshot, active: id };
      if (action === 'logout') snapshot = { ...snapshot, planEnabled: false, signedIn: false, welcomeNeeded: false };
      if (action === 'welcome') snapshot = { ...snapshot, welcomeNeeded: false };
      const value = action === 'models' ? { models: [{ id: snapshot.active + '-model', name: '<安全显示>' }] } : snapshot;
      return { ok: true, json: async () => ({ result: { ok: true, value } }) };
    } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const settle = () => new Promise(resolve => setImmediate(resolve)); await settle();
  assert.equal(byId('welcome').hidden, false); assert.equal(byId('models').children[0].children[0].textContent, '<安全显示>');
  assert.equal(byId('models').children[0].children[1].textContent, 'chatgpt-plan/one-model');
  await byId('understood').onclick(); assert.equal(byId('welcome').hidden, true);
  byId('accounts').value = 'two'; await byId('accounts').onchange(); assert.equal(byId('models').children[0].children[1].textContent, 'chatgpt-plan/two-model');
  byId('logout').onclick(); await settle(); assert.equal(byId('models').children.length, 0); assert.equal(byId('refresh').disabled, true);
  snapshot = { ...snapshot, planEnabled: true, signedIn: true }; await poll(); assert.equal(byId('models').children[0].children[1].textContent, 'chatgpt-plan/two-model');
  fail = true; await byId('refresh').onclick(); assert.equal(byId('message').textContent, '暂时不可用');
  assert.ok(html.includes(USAGE_URL)); assert.ok(calls.every(call => !JSON.stringify(call).includes('access_token')));
});

test('plugin mounts an isolated loopback RPC, safe callback/page and independent model registration', async t => {
  const data = new Map(), routes = new Map(), disposers = []; let rpc, authority, registered;
  const ctx = { credentials: { resolve: async ref => data.has(JSON.stringify(ref)) ? { value: data.get(JSON.stringify(ref)) } : undefined, set: async (ref, value) => data.set(JSON.stringify(ref), value) },
    on(event, fn) { if (event === 'dispose') disposers.push(fn); }, effect(fn) { return fn(); },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    connection: { rpc: { handle(path, handler, options) { assert.equal(path, '/phone-chatgpt'); rpc = handler; authority = options.authority; } } },
    llm: { registerAdapter(providers, adapter) { registered = { providers, adapter }; return () => {}; } }, get() {},
  };
  const { account } = applyChatGpt(ctx); t.after(() => disposers.forEach(fn => fn()));
  assert.equal(authority, 'loopback'); assert.deepEqual(registered.providers, [CHATGPT_PROVIDER]);
  // Exercise the Jet Hub client against the real phone handler, including PKCE login and errors.
  const controller = new AbortController();
  const call = createChatGptCall({ rpc: { call(path, method, payload, signal) {
    assert.equal(path, '/phone-chatgpt'); assert.equal(signal, controller.signal);
    return rpc(method, payload);
  } } });
  const status = await call('status', {}, controller.signal);
  assert.equal(status.signedIn, false);
  const login = await call('login', {}, controller.signal);
  const url = new URL(chatGptAuthorizationUrl(login));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3080/auth/chatgpt/callback');
  await call('cancel', {}, controller.signal);
  await assert.rejects(call('invalid', {}, controller.signal), { code: 'phone-chatgpt/bad-request' });
  assert.equal((await rpc('manage', { action: 'status' })).value.signedIn, false); assert.equal((await rpc('wrong', {})).ok, false);
  const response = () => ({ headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, end(body = '') { this.body = String(body); } });
  const page = response(); routes.get('/phone-chatgpt')({ method: 'GET' }, page);
  assert.equal(page.status, 200); assert.equal(page.headers['referrer-policy'], 'no-referrer'); assert.equal(page.headers['cache-control'], 'no-store');
  assert.ok(page.body.includes('Continue with ChatGPT')); assert.ok(!page.body.includes('fixture-access'));
  await account.login(); const callback = response();
  await routes.get('/auth/chatgpt/callback')({ method: 'GET', url: '/auth/chatgpt/callback?state=wrong&code=fixture-private-code' }, callback);
  assert.equal(callback.status, 400); assert.ok(!callback.body.includes('fixture-private-code')); assert.ok(callback.body.includes('dsh-phone://chatgpt/return'));
  assert.deepEqual(await registered.adapter.listModels(CHATGPT_PROVIDER), []);
});

test('Jet Hub only opens the exact official pending authorization URL', () => {
  const pending = authorizeUrl => ({ attempt: { phase: 'waiting-browser', authorizeUrl } });
  assert.equal(chatGptAuthorizationUrl(pending('https://auth.openai.com/api/accounts/authorize?state=fixture')), 'https://auth.openai.com/api/accounts/authorize?state=fixture');
  for (const url of ['https://auth.openai.com.evil.test/api/accounts/authorize', 'https://secret@auth.openai.com/api/accounts/authorize', 'http://auth.openai.com/api/accounts/authorize', 'https://auth.openai.com/api/accounts/authorize#fragment', 'https://auth.openai.com/other']) {
    assert.equal(chatGptAuthorizationUrl(pending(url)), null);
  }
  assert.equal(chatGptAuthorizationUrl({ attempt: { phase: 'failed', authorizeUrl: 'https://auth.openai.com/api/accounts/authorize' } }), null);
});

test('packaged account bundle includes all relative imports and the new page, excludes test credentials', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const script = String.raw`
import importlib.util, pathlib, tempfile, re, hashlib
root = pathlib.Path.cwd()
spec = importlib.util.spec_from_file_location('builder', root/'scripts/build-assets.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='dsh-chatgpt-bundle-test-') as tmp:
 out = pathlib.Path(tmp)/'bundle'; module.copy_bundle('dsh-phone-account', out, root/'phone-account')
 for name in ('index.js','chatgpt.js','chatgpt-account.js','chatgpt-protocol.js','chatgpt-adapter.js','chatgpt-page.html'):
  assert (out/name).read_bytes() == (root/'phone-account'/name).read_bytes(), name
 for source in out.rglob('*.js'):
  for relative in re.findall(r"from ['\"](\.[^'\"]+)['\"]", source.read_text()):
   assert (source.parent/relative).is_file(), (source,relative)
 assert not list(out.rglob('*.test.js'))
 assert not (out/'chatgpt-fixtures.js').exists()
print('Bundle import graph and byte hashes verified')
`;
  assert.match(execFileSync('python3', ['-c', script], { cwd: root, encoding: 'utf8' }), /verified/);
});
