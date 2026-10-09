import { generateKeyPairSync, sign } from 'node:crypto';
import { ChatGptAccount } from './chatgpt-account.js';
import { AUTH_ORIGIN, RESOURCE, SCOPES, ChatGptNetwork } from './chatgpt-protocol.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
export function identityToken(clientId, nonce, extra = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: AUTH_ORIGIN, aud: clientId, sub: 'fixture-subject', nonce,
    exp: Math.floor(Date.now() / 1000) + 3600, name: '测试账号', email: 'fixture@example.invalid', ...extra })}`;
  return `${payload}.${sign('sha256', Buffer.from(payload), privateKey).toString('base64url')}`;
}
export const textOutput = text => ({ id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
export const completed = (output = [textOutput('你好')], usage) => ({ type: 'response.completed', response: { status: 'completed', output, ...(usage ? { usage } : {}) } });
export const frames = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
export function fixture({ fetcher, store } = {}) {
  const data = new Map(), calls = [];
  const storage = store ?? { get: async key => data.get(key), set: async (key, value) => { data.set(key, value); } };
  let account;
  const network = new ChatGptNetwork(async (url, init) => {
    calls.push({ url, init });
    const custom = await fetcher?.(url, init, account); if (custom) return custom;
    if (url === `${AUTH_ORIGIN}/.well-known/openid-configuration`) return json({ issuer: AUTH_ORIGIN, jwks_uri: `${AUTH_ORIGIN}/fixture-jwks`, revocation_endpoint: `${AUTH_ORIGIN}/fixture-revoke` });
    if (url === `${AUTH_ORIGIN}/fixture-jwks`) return json({ keys: [jwk] });
    if (url === `${AUTH_ORIGIN}/fixture-revoke`) return json({});
    if (url === `${AUTH_ORIGIN}/api/accounts/oauth/token`) {
      const form = new URLSearchParams(init.body), refresh = form.get('grant_type') === 'refresh_token';
      return json({ access_token: refresh ? 'fixture-refreshed-access' : 'fixture-access', refresh_token: refresh ? 'fixture-rotated-refresh' : 'fixture-refresh',
        token_type: 'Bearer', expires_in: 3600, scope: SCOPES, ...(refresh ? {} : { id_token: identityToken(form.get('client_id'), account.attempt.nonce) }) });
    }
    if (url === `${RESOURCE}/models`) return json({ models: [{ slug: 'fixture-model', display_name: '测试模型', visibility: 'list' }] });
    if (url === `${RESOURCE}/responses`) return new Response(frames([completed()]), { headers: { 'content-type': 'text/event-stream' } });
    throw Error(`Unexpected mocked request: ${url}`);
  });
  account = new ChatGptAccount(storage, { network });
  return { account, data, calls, storage, network };
}
export function callback(account, clientId = 'oaiapp_fixture') {
  const url = new URL(account.callbackUri);
  url.searchParams.set('state', account.attempt.state); url.searchParams.set('code', 'fixture-code'); url.searchParams.set('client_id', clientId);
  return url;
}
export async function connected(options) {
  const f = fixture(options); await f.account.login(); await f.account.callback(callback(f.account)); return f;
}
export async function collect(iterable) { const rows = []; for await (const row of iterable) rows.push(row); return rows; }
