import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChatGptAccount, CONNECTION_REF, HOST_REF } from './chatgpt-account.js';
import { AUTH_ORIGIN, RESOURCE, SCOPES, PLAN_SCOPE, modelCatalog, officialUrl } from './chatgpt-protocol.js';
import { fixture, connected, callback, identityToken } from './chatgpt-fixtures.js';
const rejects = code => error => error.code === code;

test('official registration has fresh PKCE/state/nonce, stable installation and issued token client', async t => {
  const { account, data, calls, storage } = fixture(); t.after(() => account.dispose());
  const first = new URL((await account.login()).attempt.authorizeUrl);
  assert.equal(first.origin, AUTH_ORIGIN); assert.equal(first.pathname, '/api/accounts/authorize');
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('resource'), RESOURCE); assert.equal(first.searchParams.get('scope'), SCOPES);
  assert.equal(first.searchParams.get('redirect_uri'), account.callbackUri);
  assert.equal(first.searchParams.get('code_challenge'), createHash('sha256').update(account.attempt.verifier).digest('base64url'));
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256'); assert.equal(first.searchParams.get('agent_name_hint'), 'DSH 手机版');
  const host = data.get(HOST_REF); account.cancel(); const second = new URL((await account.login()).attempt.authorizeUrl);
  for (const key of ['state', 'nonce', 'code_challenge']) assert.notEqual(second.searchParams.get(key), first.searchParams.get(key));
  assert.equal(second.searchParams.get('ext_agent_host_id'), host);
  await account.callback(callback(account));
  const exchange = calls.find(c => c.url.endsWith('/oauth/token'));
  assert.equal(exchange.init.redirect, 'error'); assert.ok(exchange.init.headers['User-Agent'] || exchange.init.headers['user-agent']);
  const form = new URLSearchParams(exchange.init.body); assert.equal(form.get('client_id'), 'oaiapp_fixture'); assert.equal(form.get('resource'), RESOURCE);
  assert.equal(form.get('client_secret'), null); assert.equal(form.get('redirect_uri'), account.callbackUri);
  const returning = new URL((await account.login()).attempt.authorizeUrl);
  assert.equal(returning.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(returning.searchParams.get('id_token_hint'), null);
  assert.equal(returning.searchParams.get('agent_name_hint'), null);
  const publicState = JSON.stringify(await account.status());
  for (const credential of ['fixture-access', 'fixture-refresh', account.find().tokens.idToken]) assert.ok(!publicState.includes(credential));
  account.cancel(); const restarted = new ChatGptAccount(storage, { network: account.network }); t.after(() => restarted.dispose());
  await restarted.ready; assert.equal(restarted.hostId, host); assert.equal((await restarted.status()).planEnabled, true);
});

test('callback rejects state/duplicate/origin/registration mistakes without changing existing session', async t => {
  const { account } = await connected(); t.after(() => account.dispose()); const previous = (await account.session()).id;
  await account.login({ newProfile: true });
  const wrong = callback(account); wrong.searchParams.set('state', '中'.repeat(account.attempt.state.length));
  await assert.rejects(account.callback(wrong), rejects('AUTH_STATE_INVALID'));
  const duplicate = callback(account); duplicate.searchParams.append('state', account.attempt.state);
  await assert.rejects(account.callback(duplicate), rejects('AUTH_PROTOCOL'));
  const remote = callback(account); remote.host = 'evil.invalid'; await assert.rejects(account.callback(remote), rejects('AUTH_PROTOCOL'));
  const missing = callback(account); missing.searchParams.delete('client_id'); await assert.rejects(account.callback(missing), rejects('AUTH_CLIENT_INVALID'));
  const decline = callback(account); decline.searchParams.set('error', 'access_denied'); await assert.rejects(account.callback(decline), rejects('AUTH_DECLINED'));
  assert.equal((await account.session()).id, previous);
});

test('expired one-use code retains issued registration for a fresh authorization', async t => {
  let fail = true;
  const { account, data } = fixture({ fetcher: async url => url.endsWith('/oauth/token') && fail ? new Response('{"error":{"code":"invalid_grant","message":"fixture-private-message"}}', { status: 400 }) : undefined });
  t.after(() => account.dispose()); await account.login(); const firstState = account.attempt.state;
  await assert.rejects(account.callback(callback(account, 'oaiapp_retry')), rejects('ACCOUNT_TOKEN_INVALID'));
  assert.equal(JSON.parse(data.get(CONNECTION_REF)).profiles[0].clientId, 'oaiapp_retry');
  const url = new URL((await account.login()).attempt.authorizeUrl);
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_retry'); assert.notEqual(account.attempt.state, firstState);
  fail = false; await account.callback(callback(account, 'oaiapp_retry')); assert.equal((await account.status()).planEnabled, true);
});

test('real JWT verification rejects wrong issuer/audience/nonce/subject/expiry/signature', async t => {
  const { account } = fixture(); t.after(() => account.dispose()); const client = 'oaiapp_identity', nonce = 'fixture-nonce';
  const identity = await account.identity.verify(identityToken(client, nonce), client, { nonce }); assert.equal(identity.subject, 'fixture-subject');
  for (const extra of [{ iss: 'https://evil.invalid' }, { aud: 'wrong' }, { nonce: 'wrong' }, { exp: 1 }, { sub: 'wrong' }, { aud: [client, 'other'] }, { azp: 'wrong' }, { nbf: Date.now() / 1000 + 600 }]) {
    await assert.rejects(account.identity.verify(identityToken(client, nonce, extra), client, { nonce, subject: 'fixture-subject' }), rejects('ACCOUNT_IDENTITY_INVALID'));
  }
  const token = identityToken(client, nonce), parts = token.split('.'); parts[2] = Buffer.alloc(256).toString('base64url');
  await assert.rejects(account.identity.verify(parts.join('.'), client, { nonce }), rejects('ACCOUNT_IDENTITY_INVALID'));
});

test('identity-only sign-in does not silently enable plan usage', async t => {
  const { account } = fixture({ fetcher: async (url, init, account) => url.endsWith('/oauth/token') ? new Response(JSON.stringify({ access_token: 'fixture-identity-access', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email', id_token: identityToken('oaiapp_fixture', account.attempt.nonce) })) : undefined });
  t.after(() => account.dispose()); await account.login(); await account.callback(callback(account));
  assert.equal((await account.status()).signedIn, true); assert.equal((await account.status()).planEnabled, false);
  await assert.rejects(account.session(), rejects('ACCOUNT_SCOPE_REQUIRED')); await assert.rejects(account.models(), rejects('ACCOUNT_SCOPE_REQUIRED'));
});

test('concurrent expiry refresh rotates once, preserves granted scope, and respects earliest refresh time', async t => {
  const { account, calls } = await connected(); t.after(() => account.dispose()); const id = account.find().id;
  account.find().tokens.expiresAt = Date.now() + 10000; account.find().tokens.earliestRefreshAt = Date.now() + 5000;
  assert.equal(await account.access(id), 'fixture-access');
  account.find().tokens.earliestRefreshAt = 0;
  assert.deepEqual(await Promise.all([account.access(id), account.access(id), account.access(id)]), Array(3).fill('fixture-refreshed-access'));
  const refresh = calls.filter(c => new URLSearchParams(c.init.body).get('grant_type') === 'refresh_token'); assert.equal(refresh.length, 1);
  const form = new URLSearchParams(refresh[0].init.body); assert.equal(form.get('refresh_token'), 'fixture-refresh'); assert.equal(form.get('scope'), null);
  assert.equal(account.find().tokens.refreshToken, 'fixture-rotated-refresh'); assert.ok(account.find().scopes.includes(PLAN_SCOPE));
});

test('same identity retains separate registrations, scoped caches and scoped logout', async t => {
  const { account, calls } = await connected(); t.after(() => account.dispose()); const first = account.find().id;
  await account.models(); await account.welcome(); assert.equal((await account.status()).welcomeNeeded, false);
  await account.login({ newProfile: true }); await account.callback(callback(account, 'oaiapp_other')); const second = account.find().id;
  assert.notEqual(first, second); assert.equal(account.state.profiles.length, 2); assert.equal((await account.status()).welcomeNeeded, true);
  await account.models(); await account.switchAccount(first); await account.models();
  assert.equal(calls.filter(c => c.url === `${RESOURCE}/models`).length, 2);
  await account.logout(); assert.equal(account.find(first).tokens, null); assert.ok(account.find(second).tokens);
  const revocation = new URLSearchParams(calls.find(c => c.url.endsWith('/fixture-revoke')).init.body); assert.equal(revocation.get('client_id'), 'oaiapp_fixture');
  await account.switchAccount(second); assert.equal((await account.status()).planEnabled, true);
  const controller = new AbortController(); controller.abort(); await assert.rejects(account.models(second, { signal: controller.signal }), error => error.name === 'AbortError');
});

test('late cancellation, including persistence, cannot activate a cancelled login', async t => {
  const data = new Map(); let account, cancelOnSave = false;
  const f = fixture({ store: { get: async key => data.get(key), set: async (key, value) => { data.set(key, value); if (cancelOnSave && key === CONNECTION_REF && JSON.parse(value).profiles.some(p => p.tokens)) { cancelOnSave = false; account.cancel(); } } } });
  account = f.account; t.after(() => account.dispose()); await account.login(); cancelOnSave = true;
  await assert.rejects(account.callback(callback(account)), rejects('AUTH_EXPIRED'));
  assert.equal((await account.status()).signedIn, false); assert.equal(JSON.parse(data.get(CONNECTION_REF)).profiles[0].tokens, null);
});

test('late 401 clears only the captured credential, preserving a replacement session', async t => {
  const { account } = await connected(); t.after(() => account.dispose()); const id = account.find().id;
  account.find().tokens.accessToken = 'fixture-replacement-access';
  await account.rejectAccess(id, 'fixture-access'); assert.equal(account.find().tokens.accessToken, 'fixture-replacement-access');
  await account.rejectAccess(id, 'fixture-replacement-access'); assert.equal(account.find().tokens, null);
});

test('catalog keeps official order/visibility/slugs and declares capabilities conservatively', () => {
  const rows = modelCatalog({ models: [{ slug: 'second', visibility: 'list', display_name: '第二' }, { slug: 'hidden', visibility: 'hide' },
    { slug: 'first', visibility: 'list', display_name: '第一', input_modalities: ['text', 'image'], context_window: 1234 }, { slug: 'second', visibility: 'list' }] });
  assert.deepEqual(rows.map(r => r.id), ['second', 'first']); assert.deepEqual(rows[0].inputModalities, ['text']); assert.deepEqual(rows[1].inputModalities, ['text', 'image']);
  assert.equal(rows[0].reasoning, undefined); assert.throws(() => modelCatalog({ data: [] }), rejects('MODEL_CATALOG_ERROR'));
  for (const url of ['https://evil.invalid', 'https://user@auth.openai.com/path', `${AUTH_ORIGIN}/path#bad`]) assert.throws(() => officialUrl(url, AUTH_ORIGIN), rejects('AUTH_PROTOCOL'));
});
