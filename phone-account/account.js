import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { platform, arch, release } from 'node:os';
import { requestPlatform, requestAccount, initialization, exchange, browserUrl, logoutAccount, PlatformAuthError } from './vendor/protocol.js';

export const ORIGIN = 'https://platform.deepseek.com';
export const INFERENCE = 'https://api.deepseek.com';
export const GRANT_REF = 'DSH_PHONE_DEEPSEEK_ACCOUNT';
export const DEVICE_REF = 'DSH_PHONE_DEEPSEEK_DEVICE';
const headers = {
  'x-client-bundle-id': '', 'x-client-platform': 'web',
  'x-client-version': '0.1.1', 'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
};

function publicProfile(user) {
  if (!user || typeof user !== 'object') return null;
  const contact = user.mobile || user.mobile_number || user.email;
  return {
    name: typeof user.id_profile?.name === 'string' ? user.id_profile.name.slice(0, 100) : null,
    contact: typeof contact === 'string' ? contact.replace(/(\d{3})\d+(\d{4})/, '$1****$2').replace(/^(.{2})[^@]+(@.*)$/, '$1***$2').slice(0, 100) : null,
  };
}

/** Account credentials remain in the phone's credential service; views never contain a token. */
export class PhoneAccount {
  constructor(store, { origin = ORIGIN, callbackOrigin = 'http://127.0.0.1:3080', request = requestPlatform, query = requestAccount, revoke = logoutAccount, timeoutMs = 600000 } = {}) {
    Object.assign(this, { store, origin, callbackOrigin, request, query, revoke, timeoutMs });
    this.attempt = null;
    this.mutations = Promise.resolve();
  }

  mutate(action) {
    const operation = this.mutations.then(action);
    this.mutations = operation.catch(() => {});
    return operation;
  }

  async grant() {
    const raw = await this.store.get(GRANT_REF);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return value.version === 1 && value.issuer === this.origin && typeof value.token === 'string' && /^[\x21-\x7e]+$/.test(value.token) ? value : null;
    } catch { return null; }
  }

  async status() {
    const grant = await this.grant();
    const a = this.attempt;
    return { signedIn: Boolean(grant), profile: grant?.profile || null, attempt: a ? {
      phase: a.phase, error: a.error || null, expiresAt: a.expiresAt,
      ...(a.phase === 'waiting-browser' ? { authorizeUrl: a.authorizeUrl } : {}),
    } : null };
  }

  async login() {
    if (this.attempt && ['initializing', 'waiting-browser', 'exchanging'].includes(this.attempt.phase)) return this.status();
    const verifier = randomBytes(32).toString('base64url');
    const a = { id: randomUUID(), verifier, state: randomBytes(32).toString('base64url'), controller: new AbortController(), phase: 'initializing', expiresAt: Date.now() + this.timeoutMs };
    this.attempt = a;
    a.timer = setTimeout(() => this.cancel('expired'), this.timeoutMs);
    a.timer.unref?.();
    try {
      const value = initialization.parse(await this.request(this.origin, 'auth_init', {
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', state: a.state,
        redirect_uri: this.callbackOrigin + '/oauth/callback', locale: 'zh_CN', login_source: 'web',
      }, AbortSignal.any([a.controller.signal, AbortSignal.timeout(30000)]), headers));
      this.check(a);
      a.authorizeId = value.authorize_id;
      a.authorizeUrl = browserUrl(value.authorize_url, this.origin, '/dsh/authorize');
      a.expiresAt = Math.min(a.expiresAt, Date.now() + value.expires_in * 1000);
      clearTimeout(a.timer);
      a.timer = setTimeout(() => this.cancel('expired'), a.expiresAt - Date.now());
      a.timer.unref?.();
      a.phase = 'waiting-browser';
    } catch (e) {
      if (!a.controller.signal.aborted) { a.phase = 'failed'; a.error = e instanceof PlatformAuthError ? e.code : 'protocol'; clearTimeout(a.timer); }
    }
    return this.status();
  }

  check(a) {
    if (this.attempt !== a || a.controller.signal.aborted || Date.now() >= a.expiresAt) throw new PlatformAuthError('expired');
  }

  cancel(reason = 'cancelled') {
    const a = this.attempt;
    if (!a || !['initializing', 'waiting-browser', 'exchanging'].includes(a.phase)) return;
    a.controller.abort(); clearTimeout(a.timer); a.phase = reason;
    if (a.authorizeId) void this.request(this.origin, 'auth_cancel', {
      authorize_id: a.authorizeId, code_verifier: a.verifier,
    }, AbortSignal.timeout(10000), headers).catch(() => {});
  }

  async callback(url) {
    const a = this.attempt;
    if (!a || a.phase !== 'waiting-browser') return { status: 410 };
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || !code || Buffer.byteLength(state) !== Buffer.byteLength(a.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(a.state))) return { status: 400 };
    try {
      this.check(a); a.phase = 'exchanging';
      let device = await this.store.get(DEVICE_REF);
      if (!device || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(device)) { device = randomUUID(); await this.store.set(DEVICE_REF, device); }
      const result = exchange.parse(await this.request(this.origin, 'auth_exchange', {
        code, code_verifier: a.verifier, redirect_uri: this.callbackOrigin + '/oauth/callback',
        device_id: device, device_model: platform() + '-' + arch(), os_version: release(),
      }, AbortSignal.any([a.controller.signal, AbortSignal.timeout(30000)]), headers));
      const location = new URL(browserUrl(result.authorized_url, this.origin, '/dsh/authorized'));
      location.searchParams.set('login_source', 'web');
      await this.mutate(async () => {
        this.check(a);
        await this.store.set(GRANT_REF, JSON.stringify({ version: 1, issuer: this.origin, token: result.token, profile: publicProfile(result.user) }));
        if (a.controller.signal.aborted) {
          const current = await this.grant();
          if (current?.token === result.token) await this.store.remove(GRANT_REF);
          throw new PlatformAuthError('expired');
        }
      });
      a.phase = 'succeeded'; clearTimeout(a.timer);
      if (!result.user) {
        try {
          const user = await this.query(this.origin, '/auth-api/v0/users/current', result.token, AbortSignal.timeout(6000), headers);
          await this.mutate(async () => {
            const current = await this.grant();
            if (current?.token === result.token) await this.store.set(GRANT_REF, JSON.stringify({ ...current, profile: publicProfile(user) }));
          });
        } catch { /* Profile availability cannot change the saved login. */ }
      }
      return { status: 303, location: location.href };
    } catch (e) {
      if (!a.controller.signal.aborted) { a.phase = 'failed'; a.error = e instanceof PlatformAuthError ? e.code : 'protocol'; }
      clearTimeout(a.timer);
      return { status: a.controller.signal.aborted ? 410 : 502 };
    }
  }

  async token(destination) {
    const url = new URL(destination);
    if (url.origin !== INFERENCE || url.username || url.password) return null;
    return (await this.grant())?.token || null;
  }

  async rejectToken(token) {
    return this.mutate(async () => {
      if ((await this.grant())?.token === token) await this.store.remove(GRANT_REF);
    });
  }

  async logout() {
    this.cancel();
    const old = await this.mutate(async () => { const grant = await this.grant(); await this.store.remove(GRANT_REF); return grant; });
    if (old) void this.revoke(this.origin, old.token, AbortSignal.timeout(10000), headers).catch(() => {});
    return this.status();
  }

  dispose() { this.cancel(); }
}
