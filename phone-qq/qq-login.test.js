import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { QQLogin } from './qq-login.js';

const token = 'test-only-private-web-token';
const credential = 'test-only-management-session';
const qr = 'https://txz.qq.com/p?k=test-only-qr&f=1';
const record = () => ({ phase: 'installed', webToken: token });
const ok = data => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
function fixture({ state = { isLogin: false, loginPhase: 'waiting_qrcode', qrcodeurl: qr }, makeQr, getRecord = record } = {}) {
  const calls = [], encoded = [];
  const f = { state, calls, encoded };
  f.login = new QQLogin(getRecord, {
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:16099');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      const route = new URL(url).pathname; calls.push({ route, options });
      if (route.endsWith('/auth/login')) return ok({ Credential: credential });
      assert.equal(options.headers.Authorization, 'Bearer ' + credential);
      if (route.endsWith('/RefreshQRcode')) { f.state = { ...f.state, loginError: null, qrcodeurl: qr + '2' }; return ok({ qrcodeurl: f.state.qrcodeurl }); }
      return ok(f.state);
    },
    makeQr: makeQr ?? (async url => { encoded.push(url); return 'data:image/png;base64,dGVzdA=='; }),
  });
  return f;
}
test('uninstalled setup makes no request and never implies a QQ login', async () => {
  const f = fixture({ getRecord: () => null });
  assert.equal((await f.login.status()).phase, 'not-installed');
  assert.equal(f.calls.length, 0);
});
test('inline QR uses hashed management auth and returns no token, URL or credential', async () => {
  const f = fixture();
  const value = await f.login.status();
  assert.equal(value.phase, 'waiting_qrcode');
  assert.ok(value.qrImage.startsWith('data:image/png;base64,'));
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { hash: createHash('sha256').update(token + '.napcat').digest('hex') });
  for (const secret of [token, credential, qr]) assert.ok(!JSON.stringify(value).includes(secret));
  await f.login.status();
  assert.equal(f.calls.filter(c => c.route.endsWith('/auth/login')).length, 1);
  assert.equal(f.encoded.length, 1);
  assert.equal(f.calls.some(c => c.route.endsWith('/RefreshQRcode')), false);
});
test('the shipped encoder produces a PNG of the actual QR URL without browser dependencies', async () => {
  const f = fixture();
  const real = new QQLogin(record, { fetch: f.login.fetch });
  const value = await real.status();
  assert.equal(value.phase, 'waiting_qrcode');
  const bytes = Buffer.from(value.qrImage.split(',')[1], 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 320);
  assert.equal(bytes.readUInt32BE(20), 320);
});
test('scanned, starting, recovering and offline statuses are distinct from ready', async () => {
  const f = fixture();
  for (const phase of ['qrcode_scanned', 'initializing', 'reconnecting']) {
    f.state = { isLogin: false, loginPhase: phase, qrcodeurl: qr };
    const value = await f.login.status(); assert.equal(value.phase, phase); assert.equal(value.qrImage, undefined);
  }
  f.state = { isLogin: true, coreReady: false, loginPhase: 'initializing' };
  assert.equal((await f.login.status()).phase, 'initializing');
  f.state = { isLogin: false, isOffline: true, qrcodeurl: qr };
  assert.equal((await f.login.status()).phase, 'offline');
  f.state = { isLogin: true, coreReady: true };
  assert.deepEqual(await f.login.status(), { phase: 'ready', message: 'QQ 已登录。现在可以连接机器人。' });
});
test('expired QR is hidden, explicit refresh retrieves and encodes a new QR', async () => {
  const f = fixture({ state: { isLogin: false, qrcodeurl: qr, loginError: 'QR expired ' + token } });
  let v = await f.login.status(); assert.equal(v.phase, 'expired'); assert.equal(v.qrImage, undefined); assert.ok(!v.message.includes(token));
  v = await f.login.status(true); assert.equal(v.phase, 'waiting_qrcode');
  assert.deepEqual(f.encoded, [qr + '2']);
  assert.equal(f.calls.filter(c => c.route.endsWith('/RefreshQRcode')).length, 1);
});
test('QR URLs outside the verified QQ login endpoint never reach the encoder', async () => {
  const f = fixture();
  for (const bad of ['http://txz.qq.com/p?k=a', 'https://txz.qq.com.evil.invalid/p?k=a', 'https://txz.qq.com:8443/p?k=a', 'https://user:secret@txz.qq.com/p?k=a', 'https://127.0.0.1/p?k=a', 'javascript:alert(1)', '<svg onload=alert(1)>', 'https://txz.qq.com/p', qr + 'x'.repeat(2048)]) {
    f.state = { isLogin: false, qrcodeurl: bad }; assert.equal((await f.login.status()).qrImage, undefined);
  }
  assert.equal(f.encoded.length, 0);
});
test('auth errors, additional verification and unavailable API are actionable and redact upstream data', async () => {
  for (const [reply, phase] of [[{ code: -1, message: token }, 'auth-error'], [{ code: 0, data: { require2FA: true } }, 'verification-required']]) {
    const login = new QQLogin(record, { fetch: async () => new Response(JSON.stringify(reply)) });
    const v = await login.status(); assert.equal(v.phase, phase); assert.ok(!JSON.stringify(v).includes(token));
  }
  for (const fetch of [async () => { throw Error(token); }, async () => new Response('x'.repeat(65537)), async () => new Response('bad JSON')]) {
    const v = await new QQLogin(record, { fetch }).status(); assert.equal(v.phase, 'unavailable'); assert.ok(!JSON.stringify(v).includes(token));
  }
});
test('a response for replaced setup credentials is discarded before displaying a QR', async () => {
  let current = record(); const f = fixture({ getRecord: () => current });
  const previous = f.login.fetch;
  f.login.fetch = async (...args) => { const response = await previous(...args); if (args[0].endsWith('/CheckLoginStatus')) current = { ...current, webToken: 'new-private-token' }; return response; };
  const value = await f.login.status(); assert.equal(value.phase, 'not-installed'); assert.equal(f.encoded.length, 0);
});
test('overlapping polls share a request and a later refresh does not restore the stale QR', async () => {
  const f = fixture(); let release;
  const hold = new Promise(resolve => { release = resolve; });
  const previous = f.login.fetch;
  f.login.fetch = async (...args) => { if (args[0].endsWith('/auth/login')) await hold; return previous(...args); };
  const first = f.login.status(); assert.equal(f.login.status(), first);
  const refreshed = f.login.status(true); release(); await first;
  assert.equal((await refreshed).phase, 'waiting_qrcode');
  assert.deepEqual(f.encoded, [qr, qr + '2']);
  assert.equal((await f.login.status()).qrImage, 'data:image/png;base64,dGVzdA==');
  assert.equal(f.encoded.at(-1), qr + '2');
});
