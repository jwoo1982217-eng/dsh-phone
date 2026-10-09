import { createPublicKey, verify } from 'node:crypto';
import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';

export const AUTH_ORIGIN = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const CALLBACK_PATH = '/auth/chatgpt/callback';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';

export function accountError(code, message, status = 400) {
  return new LlmError(message, code, { status });
}

export function officialUrl(value, origin) {
  let url;
  try { url = new URL(value); } catch { throw accountError('AUTH_PROTOCOL', '官方账号地址格式不正确。', 502); }
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw accountError('AUTH_PROTOCOL', '账号请求必须发往指定的 OpenAI 官方服务。', 502);
  }
  return url.href;
}

export function upstreamError(data, status, requestId) {
  const raw = data?.error?.code ?? data?.code;
  const upstream = typeof raw === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(raw) ? raw : 'unknown';
  const messages = {
    subscription_sharing_usage_limit_exceeded: ['QUOTA_EXCEEDED', 'ChatGPT 会员使用额度已达到限制，请到 ChatGPT 设置中管理用量。', 429],
    subscription_sharing_usage_unavailable: ['CHATGPT_USAGE_UNAVAILABLE', 'ChatGPT 会员用量暂时不可用，请稍后重试或检查 ChatGPT 设置。', 503],
    subscription_sharing_user_not_eligible: ['ACCOUNT_SCOPE_REQUIRED', '此账号或工作区暂不支持这项会员调用。', 403],
    subscription_sharing_unsupported_capability: ['UNSUPPORTED_CONTENT', '此能力不在 ChatGPT 会员接口支持范围内。', 400],
    subscription_sharing_route_not_supported: ['UNSUPPORTED_CONTENT', '此请求路线不在 ChatGPT 会员接口支持范围内。', 400],
    chatpass_v2_scope_not_authorized: ['ACCOUNT_SCOPE_REQUIRED', '请重新授权应用使用 ChatGPT 会员方案。', 403],
    invalid_grant: ['ACCOUNT_TOKEN_INVALID', '登录凭证已失效，请重新登录 ChatGPT。', 401],
  };
  const [code, message, http] = messages[upstream] ?? (status === 401
    ? ['ACCOUNT_TOKEN_INVALID', 'ChatGPT 登录需要续期，请重新登录。', 401]
    : status === 429 ? ['RATE_LIMITED', 'ChatGPT 请求过于频繁，请稍后重试。', 429]
      : ['CHATGPT_UPSTREAM_ERROR', `OpenAI 请求未完成（${upstream}）。`, status >= 400 && status <= 599 ? status : 502]);
  // Provider messages can echo request content or credentials. Expose codes only.
  return new LlmError(message, code, {
    status: http,
    ...(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(requestId) ? { requestId } : {}),
  });
}

export class ChatGptNetwork {
  constructor(fetcher = globalThis.fetch) { this.fetcher = fetcher; }

  async open(url, { form, data, token, signal, timeoutMs = 30000 } = {}) {
    const origin = new URL(url).origin;
    if (![AUTH_ORIGIN, new URL(RESOURCE).origin].includes(origin)) {
      throw accountError('AUTH_PROTOCOL', '不支持此账号请求地址。', 502);
    }
    officialUrl(url, origin);
    const response = await this.fetcher(url, {
      method: form || data ? 'POST' : 'GET', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: {
        ...attributionHeaders(),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : data ? { 'content-type': 'application/json', accept: 'text/event-stream' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) {
      let body;
      try { body = await response.json(); } catch {}
      throw upstreamError(body, response.status, response.headers.get('x-request-id'));
    }
    return response;
  }

  async json(url, options) {
    const response = await this.open(url, options);
    try { return await response.json(); } catch { throw accountError('AUTH_PROTOCOL', '官方返回的数据格式不正确。', 502); }
  }
}

export class ChatGptIdentity {
  constructor(network) { this.network = network; this.keyCache = null; }

  async discovery(signal) {
    const value = await this.network.json(`${AUTH_ORIGIN}/.well-known/openid-configuration`, { signal });
    if (value.issuer !== AUTH_ORIGIN || typeof value.jwks_uri !== 'string') {
      throw accountError('AUTH_PROTOCOL', '官方身份配置不正确。', 502);
    }
    officialUrl(value.jwks_uri, AUTH_ORIGIN);
    return value;
  }

  async keys(signal, force = false) {
    if (!force && this.keyCache?.expiresAt > Date.now()) return this.keyCache.keys;
    const discovery = await this.discovery(signal);
    const value = await this.network.json(discovery.jwks_uri, { signal });
    if (!Array.isArray(value.keys)) throw accountError('AUTH_PROTOCOL', '官方身份公钥格式不正确。', 502);
    this.keyCache = { keys: value.keys, expiresAt: Date.now() + 300000 };
    return value.keys;
  }

  async verify(token, clientId, { nonce, subject, signal } = {}) {
    const invalid = () => accountError('ACCOUNT_IDENTITY_INVALID', 'ChatGPT 身份校验未通过，请重新登录。', 401);
    if (typeof token !== 'string' || token.length > 65536) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw invalid();
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw invalid(); }
    if (!['RS256', 'ES256'].includes(header.alg) || header.crit) throw invalid();
    const matching = keys => keys.filter(k => (!header.kid || k.kid === header.kid) && (!k.alg || k.alg === header.alg) && (!k.use || k.use === 'sig')
      && (header.alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-256'));
    let keys = matching(await this.keys(signal));
    if (keys.length !== 1) keys = matching(await this.keys(signal, true));
    if (keys.length !== 1) throw invalid();
    try {
      const key = createPublicKey({ key: keys[0], format: 'jwk' });
      if (!verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'))) throw invalid();
    } catch { throw invalid(); }
    const now = Date.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== AUTH_ORIGIN || !audience.includes(clientId) || (claims.azp && claims.azp !== clientId)
      || (audience.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now
      || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))
      || (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now + 30))
      || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)
      || (subject !== undefined && claims.sub !== subject)) throw invalid();
    return { subject: claims.sub, name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : '', email: typeof claims.email === 'string' ? claims.email.slice(0, 200) : '' };
  }
}

export function modelCatalog(value) {
  if (!Array.isArray(value?.models)) throw accountError('MODEL_CATALOG_ERROR', '官方会员模型列表格式不正确，请刷新。', 502);
  const seen = new Set();
  return value.models.filter(row => row && row.visibility === 'list' && typeof row.slug === 'string' && row.slug && !seen.has(row.slug) && seen.add(row.slug)).map(row => {
    const efforts = Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts.filter(e => typeof e === 'string' && e.length <= 40) : [];
    return {
      id: row.slug, name: typeof row.display_name === 'string' && row.display_name ? row.display_name : row.slug,
      inputModalities: ['text', ...(Array.isArray(row.input_modalities) && row.input_modalities.includes('image') ? ['image'] : [])],
      ...(Number.isSafeInteger(row.context_window) && row.context_window > 0 ? { context: { contextWindow: row.context_window } } : {}),
      ...(efforts.length ? { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } } : {}),
    };
  });
}

export async function* responseEvents(body, signal) {
  if (!body) throw accountError('EMPTY_RESPONSE', 'OpenAI 返回了空响应。', 502);
  const reader = body.getReader(); const decoder = new TextDecoder();
  let pending = '', data = [], dataBytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length + dataBytes > 4 * 1024 * 1024) throw accountError('MALFORMED_RESPONSE', 'OpenAI 响应事件过大。', 502);
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1);
        if (line.startsWith('data:')) { const text = line.slice(5).replace(/^ /, ''); data.push(text); dataBytes += text.length; }
        else if (line === '') {
          if (data.length) {
            const payload = data.join('\n'); data = []; dataBytes = 0;
            if (payload !== '[DONE]') {
              let event;
              try { event = JSON.parse(payload); } catch { throw accountError('MALFORMED_RESPONSE', 'OpenAI 流式响应格式不正确。', 502); }
              yield event;
            }
          }
        }
      }
      if (done) break;
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
