import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { AUTH_ORIGIN, RESOURCE, PLAN_SCOPE, SCOPES, CALLBACK_PATH, USAGE_URL, ChatGptNetwork, ChatGptIdentity, accountError, modelCatalog, officialUrl } from './chatgpt-protocol.js';

export const CONNECTION_REF = 'DSH_PHONE_CHATGPT_CONNECTIONS';
export const HOST_REF = 'DSH_PHONE_CHATGPT_HOST';
const validClient = value => typeof value === 'string' && value.length <= 256 && /^[\x21-\x7e]+$/.test(value) && value !== 'dynamic_agent_client';
const hasPlan = profile => Boolean(profile?.tokens?.accessToken && profile.scopes?.includes(PLAN_SCOPE));
const contact = value => value?.replace(/^(.{2})[^@]*(@.*)$/, '$1***$2') ?? '';

/** All renewable credentials stay in DSH's credential service, never in a page or URL. */
export class ChatGptAccount {
  constructor(store, { network = new ChatGptNetwork(), callbackOrigin = 'http://127.0.0.1:3080', agentName = 'DSH 手机版', identity, timeoutMs = 600000 } = {}) {
    const callback = new URL(callbackOrigin);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/') {
      throw accountError('AUTH_PROTOCOL', 'ChatGPT 授权回调必须是本机 HTTP 地址。');
    }
    Object.assign(this, { store, network, timeoutMs, agentName, callbackUri: callback.origin + CALLBACK_PATH });
    this.identity = identity ?? new ChatGptIdentity(network);
    this.selectionChain = Promise.resolve(); this.rotationLast = new Map(); this.cooldowns = new Map();
    this.mutations = Promise.resolve(); this.cache = new Map(); this.attempt = null; this.disposed = false;
    this.ready = this.mutate(async () => {
      const raw = await store.get(CONNECTION_REF);
      if (raw) {
        try {
          this.state = JSON.parse(raw);
          if (this.state.version !== 1 || this.state.issuer !== AUTH_ORIGIN || !Array.isArray(this.state.profiles)) throw Error();
        } catch { throw accountError('ACCOUNT_STORAGE_INVALID', 'ChatGPT 账号存储格式不正确，请检查本机账号配置。', 500); }
      } else this.state = { version: 1, issuer: AUTH_ORIGIN, active: null, pendingRegistration: null, profiles: [] };
      this.hostId = await store.get(HOST_REF);
      if (!this.hostId) { this.hostId = `urn:uuid:${randomUUID()}`; await store.set(HOST_REF, this.hostId); }
      if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(this.hostId)) throw accountError('ACCOUNT_STORAGE_INVALID', '本机 ChatGPT 安装标识格式不正确。', 500);
    });
    void this.ready.catch(() => {});
  }

  mutate(action) {
    const operation = this.mutations.then(action); this.mutations = operation.catch(() => {}); return operation;
  }
  save() { return this.store.set(CONNECTION_REF, JSON.stringify(this.state)); }
  find(id = this.state.active) { return this.state.profiles.find(p => p.id === id); }

  async session(id) {
    await this.ready;
    const profile = this.find(id);
    if (!profile?.identity || !profile.tokens?.accessToken) throw accountError('ACCOUNT_SIGN_IN_REQUIRED', '请在“设置 → Jet Hub → ChatGPT 会员”中登录。', 401);
    if (!hasPlan(profile)) throw accountError('ACCOUNT_SCOPE_REQUIRED', '已登录 ChatGPT，但尚未授权使用会员方案，请再次授权。', 403);
    return structuredClone(profile);
  }

  /** 仅实际推理请求推进顺位；不改变设置页当前查看的连接。 */
  async nextSession(modelId, { signal, exclude = new Set() } = {}) {
    const select = this.selectionChain.catch(() => {}).then(async () => {
      await this.ready;
      signal?.throwIfAborted();
      const all = this.state.profiles;
      const last = all.findIndex(p => p.id === this.rotationLast.get(modelId));
      const active = all.findIndex(p => p.id === this.state.active);
      const start = last >= 0 ? last : Math.max(0, active);
      const ordered = [...all.slice(start), ...all.slice(0, start)];
      let failure;
      for (const candidate of ordered) {
        signal?.throwIfAborted();
        if (!hasPlan(candidate) || exclude.has(candidate.id)) continue;
        if ((this.cooldowns.get(candidate.id)?.get(modelId) ?? 0) > Date.now()) continue;
        try {
          const models = await this.models(candidate.id, { signal });
          const model = models.find(row => row.id === modelId);
          if (!model) continue;
          const profile = await this.session(candidate.id);
          this.rotationLast.set(modelId, candidate.id);
          return { profile, model };
        } catch (error) { signal?.throwIfAborted(); failure = error; }
      }
      if (failure) throw failure;
      throw accountError('MODEL_NOT_AVAILABLE', '没有可用账号支持此会员模型，请检查登录、额度或刷新模型列表。');
    });
    this.selectionChain = select.catch(() => {});
    return select;
  }

  coolDown(profileId, modelId, milliseconds = 60000) {
    const models = this.cooldowns.get(profileId) ?? new Map();
    models.set(modelId, Date.now() + milliseconds); this.cooldowns.set(profileId, models);
  }

  async status() {
    await this.ready;
    const profile = this.find(); const a = this.attempt;
    return {
      signedIn: Boolean(profile?.tokens?.accessToken), planEnabled: hasPlan(profile), active: profile?.id ?? null,
      welcomeNeeded: hasPlan(profile) && !profile.welcomed, usageUrl: USAGE_URL,
      profiles: this.state.profiles.map(p => ({ id: p.id, label: `${p.identity?.name || 'ChatGPT 连接'} · ${contact(p.identity?.email) || p.id.slice(0, 6)}`,
        connected: Boolean(p.tokens?.accessToken), planEnabled: hasPlan(p), active: p.id === this.state.active })),
      attempt: a ? { phase: a.phase, expiresAt: a.expiresAt, message: a.message ?? '',
        ...(a.phase === 'waiting-browser' ? { authorizeUrl: a.authorizeUrl } : {}) } : null,
    };
  }

  async login({ newProfile = false, profileId } = {}) {
    await this.ready;
    if (this.disposed) throw accountError('ACCOUNT_CLOSED', '账号服务已关闭。', 503);
    if (this.attempt && ['waiting-browser', 'exchanging'].includes(this.attempt.phase)) return this.status();
    const retryId = this.attempt?.phase === 'failed' ? this.state.pendingRegistration : null;
    const profile = newProfile ? undefined : this.find(profileId ?? retryId ?? this.state.active ?? this.state.pendingRegistration);
    if (profileId && !profile) throw accountError('ACCOUNT_NOT_FOUND', '所选 ChatGPT 连接不存在。');
    const a = {
      profileId: profile?.id ?? randomUUID(), clientId: profile?.clientId,
      expectedSubject: profile?.identity?.subject, state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      controller: new AbortController(), phase: 'waiting-browser', expiresAt: Date.now() + this.timeoutMs,
    };
    this.attempt = a;
    const url = new URL(`${AUTH_ORIGIN}/api/accounts/authorize`);
    const params = { client_id: a.clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.hostId,
      response_type: 'code', redirect_uri: this.callbackUri, scope: SCOPES, resource: RESOURCE,
      state: a.state, nonce: a.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(a.verifier).digest('base64url'),
      ...(!a.clientId ? { agent_name_hint: this.agentName } : {}),
    };
    // Omit the optional id_token_hint: a retained identity token must never enter the UI.
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    a.authorizeUrl = url.href;
    a.timer = setTimeout(() => { if (this.attempt === a) this.cancel('expired'); }, this.timeoutMs); a.timer.unref?.();
    return this.status();
  }

  check(a) {
    if (this.disposed || this.attempt !== a || a.controller.signal.aborted || Date.now() >= a.expiresAt) {
      throw accountError('AUTH_EXPIRED', '本次 ChatGPT 授权已过期或取消，请重新登录。', 410);
    }
  }

  cancel(reason = 'cancelled') {
    const a = this.attempt;
    if (!a || !['waiting-browser', 'exchanging'].includes(a.phase)) return;
    a.controller.abort(); clearTimeout(a.timer); a.phase = reason; a.authorizeUrl = undefined;
    a.message = reason === 'expired' ? '登录已超时，请重新登录。' : '本次登录已取消。';
  }

  async callback(url) {
    await this.ready;
    const a = this.attempt;
    if (!a || a.phase !== 'waiting-browser') throw accountError('AUTH_EXPIRED', '本次授权已结束，请返回 DSH 重新登录。', 410);
    this.check(a);
    if (url.origin + url.pathname !== this.callbackUri || ['state', 'code', 'client_id', 'error'].some(key => url.searchParams.getAll(key).length > 1)) {
      throw accountError('AUTH_PROTOCOL', '授权回调地址或参数不正确。');
    }
    const state = url.searchParams.get('state') ?? '';
    const receivedState = Buffer.from(state), expectedState = Buffer.from(a.state);
    if (receivedState.length !== expectedState.length || !timingSafeEqual(receivedState, expectedState)) {
      throw accountError('AUTH_STATE_INVALID', '授权状态不匹配，请返回 DSH 重新登录。', 400);
    }
    if (url.searchParams.has('error')) {
      a.phase = 'failed'; clearTimeout(a.timer); a.authorizeUrl = undefined;
      a.message = '本次登录或会员授权未完成，原账号仍保留。';
      throw accountError('AUTH_DECLINED', a.message, 403);
    }
    const supplied = url.searchParams.get('client_id');
    if (a.clientId && supplied && supplied !== a.clientId) throw accountError('AUTH_CLIENT_INVALID', '官方返回的连接与所选账号不匹配。');
    const clientId = a.clientId ?? supplied;
    const code = url.searchParams.get('code');
    if (!validClient(clientId) || typeof code !== 'string' || !code || code.length > 4096) {
      throw accountError('AUTH_CLIENT_INVALID', '官方未返回完整注册结果，请重新登录。');
    }
    a.phase = 'exchanging'; a.authorizeUrl = undefined;
    try {
      await this.mutate(async () => {
        this.check(a);
        let profile = this.find(a.profileId);
        if (!profile) {
          profile = { id: a.profileId, clientId, identity: null, tokens: null, scopes: [], welcomed: false };
          this.state.profiles.push(profile); this.state.pendingRegistration = profile.id;
          await this.save(); // Preserve the issued client ID even if the one-use code expires.
        }
        a.clientId = clientId;
        const tokens = await this.network.json(`${AUTH_ORIGIN}/api/accounts/oauth/token`, {
          form: { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: a.verifier, redirect_uri: this.callbackUri, resource: RESOURCE }, signal: a.controller.signal,
        });
        this.check(a);
        const identity = await this.identity.verify(tokens.id_token, clientId, { nonce: a.nonce, subject: a.expectedSubject, signal: a.controller.signal });
        this.check(a);
        const next = this.tokenRecord(tokens);
        const previous = structuredClone(this.state);
        profile.identity = identity; profile.tokens = next.tokens; profile.scopes = next.scopes;
        this.state.active = profile.id; this.state.pendingRegistration = null; this.cache.delete(profile.id);
        await this.save();
        try { this.check(a); } catch (error) { this.state = previous; await this.save(); throw error; }
        a.phase = 'complete'; a.message = hasPlan(profile) ? 'ChatGPT 会员授权已完成。' : '账号已登录，但尚未授权使用会员方案，请再次授权。';
      });
    } catch (error) {
      if (a.phase === 'exchanging') { a.phase = 'failed'; a.message = error?.failure?.message ?? 'ChatGPT 授权未完成，请重试。'; }
      throw error;
    } finally { clearTimeout(a.timer); }
    return this.status();
  }

  tokenRecord(value, previous) {
    const safe = v => typeof v === 'string' && v.length > 0 && v.length <= 32768 && /^[\x21-\x7e]+$/.test(v);
    if (!safe(value.access_token) || String(value.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) || value.expires_in <= 0
      || (value.refresh_token !== undefined && !safe(value.refresh_token))) throw accountError('AUTH_PROTOCOL', '官方返回的账号凭证不完整，请重新登录。', 502);
    return {
      tokens: { accessToken: value.access_token, refreshToken: value.refresh_token ?? previous?.tokens?.refreshToken,
        idToken: value.id_token ?? previous?.tokens?.idToken, expiresAt: Date.now() + value.expires_in * 1000,
        earliestRefreshAt: Number.isFinite(value.earliest_refresh_at) ? value.earliest_refresh_at * 1000 : 0 },
      scopes: typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [],
    };
  }

  async access(profileId, signal) {
    await this.ready;
    return this.mutate(async () => {
      signal?.throwIfAborted();
      const profile = this.find(profileId);
      if (!profile?.identity || !profile.tokens?.accessToken) throw accountError('ACCOUNT_SIGN_IN_REQUIRED', '此 ChatGPT 连接已退出，请重新登录。', 401);
      if (!hasPlan(profile)) throw accountError('ACCOUNT_SCOPE_REQUIRED', '请重新授权使用 ChatGPT 会员方案。', 403);
      if (profile.tokens.expiresAt > Date.now() + 60000) return profile.tokens.accessToken;
      if (profile.tokens.earliestRefreshAt > Date.now() && profile.tokens.expiresAt > Date.now()) return profile.tokens.accessToken;
      if (!profile.tokens.refreshToken) throw accountError('ACCOUNT_TOKEN_INVALID', 'ChatGPT 登录需要续期，请重新登录。', 401);
      let tokens;
      try {
        tokens = await this.network.json(`${AUTH_ORIGIN}/api/accounts/oauth/token`, { form: {
          grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: profile.tokens.refreshToken, resource: RESOURCE,
        }, signal });
      } catch (error) {
        if (error?.failure?.status === 401) { profile.tokens = null; this.cache.delete(profile.id); await this.save(); }
        throw error;
      }
      if (!tokens.refresh_token) throw accountError('AUTH_PROTOCOL', '官方续期未返回完整凭证，请重新登录。', 502);
      if (tokens.id_token) await this.identity.verify(tokens.id_token, profile.clientId, { subject: profile.identity.subject, signal });
      const next = this.tokenRecord(tokens, profile); profile.tokens = next.tokens; profile.scopes = next.scopes;
      this.cache.delete(profile.id);
      await this.save();
      if (!hasPlan(profile)) throw accountError('ACCOUNT_SCOPE_REQUIRED', '续期后未取得会员权限，请再次授权。', 403);
      return profile.tokens.accessToken;
    });
  }

  async models(profileId, { force = false, signal } = {}) {
    signal?.throwIfAborted();
    const profile = await this.session(profileId);
    const token = await this.access(profile.id, signal);
    const cached = this.cache.get(profile.id);
    if (!force && cached?.token === token && cached.expiresAt > Date.now()) return structuredClone(cached.models);
    let rows;
    try { rows = modelCatalog(await this.network.json(`${RESOURCE}/models`, { token, signal })); }
    catch (error) {
      if (error?.code === 'ACCOUNT_TOKEN_INVALID') await this.rejectAccess(profile.id, token).catch(() => {});
      throw error;
    }
    // A sign-out or a reauthorization during model discovery must not repopulate its cache.
    if (this.find(profile.id)?.tokens?.accessToken === token) this.cache.set(profile.id, { token, expiresAt: Date.now() + 60000, models: rows });
    return structuredClone(rows);
  }

  async rejectAccess(profileId, token) {
    await this.ready;
    await this.mutate(async () => {
      const profile = this.find(profileId);
      if (profile?.tokens?.accessToken !== token) return;
      profile.tokens = null; profile.scopes = []; this.cache.delete(profile.id); await this.save();
    });
  }

  async switchAccount(id) {
    await this.ready;
    await this.mutate(async () => {
      if (!this.find(id)) throw accountError('ACCOUNT_NOT_FOUND', '所选 ChatGPT 连接不存在。');
      this.cancel(); this.attempt = null; this.state.active = id; this.rotationLast.clear(); await this.save();
    });
    return this.status();
  }

  async welcome() {
    await this.ready;
    await this.mutate(async () => { const profile = this.find(); if (hasPlan(profile)) { profile.welcomed = true; await this.save(); } });
    return this.status();
  }

  async logout() {
    await this.ready;
    let revoked = false;
    await this.mutate(async () => {
      this.cancel(); const profile = this.find();
      if (!profile) return;
      if (profile.tokens?.refreshToken) {
        try {
          const discovery = await this.identity.discovery();
          const endpoint = officialUrl(discovery.revocation_endpoint, AUTH_ORIGIN);
          await this.network.open(endpoint, { form: { client_id: profile.clientId, token: profile.tokens.refreshToken, token_type_hint: 'refresh_token' } });
          revoked = true;
        } catch {}
      }
      profile.tokens = null; profile.scopes = []; this.cache.delete(profile.id); await this.save();
    });
    return { ...await this.status(), message: revoked ? '已退出并撤销这条连接的登录会话。' : '本机已退出；未确认远程撤销，可在 ChatGPT 设置中断开 DSH 手机版。' };
  }

  dispose() { this.disposed = true; this.cancel(); this.cache.clear(); }
}
