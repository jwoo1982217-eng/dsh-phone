import { describe, expect, it, vi } from 'vitest'
import {
  buildLoginUrl,
  buildOAuthLoginUrl,
  buildPortalLoginResultUrl,
  expiresFromCredential,
  generateRandomSecret,
  LOGIN_PLUGIN_NAME,
  LOGIN_PLUGIN_VERSION,
  parseCredentialResponse,
  pollForCredential,
  PORTAL_AUTHORIZE_BASE,
  runLoginFlow,
  runOAuthFlow,
  startCallbackServer,
  startOAuthCallbackServer,
} from '../../src/login.js'
import { generateDpopKeyPair } from '../../src/oauth.js'
import type { CodeArtsCredential } from '../../src/types.js'

describe('generateRandomSecret', () => {
  it('produces 64 lowercase hex chars and differs across calls', () => {
    const a = generateRandomSecret()
    const b = generateRandomSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildLoginUrl', () => {
  it('wraps the redirect into the Huawei auth page', () => {
    const { redirectUrl, loginUrl } = buildLoginUrl(43123, 'ticket-123')
    expect(redirectUrl).toBe(
      'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
        + '?IdeaType=jetbrains'
        + `&auth_callback_url=${encodeURIComponent('http://127.0.0.1:43123/authentication')}`
        + '&plugin-name=snap_jetbrains&plugin-version=26.3.3'
        + '&ticket_id=ticket-123',
    )
    expect(loginUrl).toBe(
      'https://auth.huaweicloud.com/authui/login.html'
        + `?service=${encodeURIComponent(redirectUrl)}`,
    )
  })
})

describe('parseCredentialResponse', () => {
  it('parses the credential branch', () => {
    const c = parseCredentialResponse({
      credential: {
        access: 'AK',
        secret: 'SK',
        securitytoken: 'ST',
        expires_at: '2026-08-15T00:00:00Z',
      },
      domain_id: 'dom', user_id: 'uid', user_name: 'uname',
    })
    expect(c).toEqual({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
      domain_id: 'dom', user_id: 'uid', user_name: 'uname',
    })
  })

  it('parses the result branch (camelCase)', () => {
    const c = parseCredentialResponse({
      result: { accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST', expiration: '2026-08-15T00:00:00Z' },
    })
    expect(c).toEqual({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
    })
  })

  it('returns null when a branch is incomplete', () => {
    expect(parseCredentialResponse({ credential: { access: 'AK' } })).toBeNull()
    expect(parseCredentialResponse({})).toBeNull()
  })
})

describe('expiresFromCredential', () => {
  it('parses expires_at and falls back to +24h', () => {
    const parsed: CodeArtsCredential = {
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
    }
    expect(expiresFromCredential(parsed)).toBe(Date.parse('2026-08-15T00:00:00Z'))
    expect(expiresFromCredential({ ...parsed, expires_at: 'garbage' })).toBeGreaterThan(Date.now())
  })
})

describe('pollForCredential', () => {
  const complete = JSON.stringify({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-08-15T00:00:00Z' },
  })

  it('returns the first complete credential', async () => {
    const fetcher = vi.fn(async () => new Response(complete, { status: 200 }))
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 3 })
    expect(credential.access_key_id).toBe('AK')
    expect(credential.security_token).toBe('ST')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('skips non-ok responses, unparseable bodies, and incomplete branches', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('nope', { status: 500 })
      if (calls === 2) return new Response('not json', { status: 200 })
      if (calls === 3) return new Response(JSON.stringify({ credential: { access: 'AK' } }), { status: 200 })
      return new Response(complete, { status: 200 })
    })
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 4 })
    expect(credential.access_key_id).toBe('AK')
    expect(calls).toBe(4)
  })

  it('survives transient network errors', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return new Response(complete, { status: 200 })
    })
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 2 })
    expect(credential.access_key_id).toBe('AK')
  })

  it('throws when the budget is exhausted', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 2 }))
      .rejects.toThrow('CodeArts login timed out')
  })

  it('builds the expected endpoint URL with encoded query values', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(pollForCredential('a b', 'c&d', { fetcher, maxAttempts: 1 })).rejects.toThrow()
    const url = new URL(fetcher.mock.calls[0][0] as string)
    expect(url.searchParams.get('ticket_id')).toBe('a b')
    expect(url.searchParams.get('secret')).toBe('c&d')
  })
})

describe('startCallbackServer', () => {
  const complete = JSON.stringify({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-08-15T00:00:00Z' },
  })

  async function hit(port: number, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, init)
  }

  it('resolves a direct token callback', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      const response = await hit(server.port, '/authentication?token=abc')
      expect(response.status).toBe(200)
      const result = await server.result
      expect(result.access).toBe('abc')
      expect(result.expires).toBeGreaterThan(Date.now())
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('resolves the fingerprint branch (base64 URL containing a token)', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      const inner = `http://host/cb?access_token=fp-token`
      const fingerprint = Buffer.from(inner).toString('base64')
      const response = await hit(server.port, `/authentication?fingerprint=${encodeURIComponent(fingerprint)}`)
      expect(response.status).toBe(200)
      const result = await server.result
      expect(result.access).toBe('fp-token')
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('resolves the secret branch through polling', async () => {
    const fetcher = vi.fn(async () => new Response(complete, { status: 200 }))
    const server = await startCallbackServer('ticket-1', 'secret-1', { fetcher, maxAttempts: 3 })
    try {
      const response = await hit(server.port, '/authentication?secret=cb-secret')
      expect(response.status).toBe(200)
      const result = await server.result
      const credential = JSON.parse(result.access) as CodeArtsCredential
      expect(credential.access_key_id).toBe('AK')
      expect(credential.security_token).toBe('ST')
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('answers 404 for foreign paths and 400 for a tokenless callback', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      expect((await hit(server.port, '/other')).status).toBe(404)
      expect((await hit(server.port, '/authentication')).status).toBe(400)
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })
})

describe('runLoginFlow', () => {
  it('opens the login URL, resolves through a direct token callback, and closes the server', async () => {
    const opened: string[] = []
    const flow = runLoginFlow({ openBrowser: (url) => void opened.push(url) })
    // 服务器在 promise 完成后启动；通过流程的 loginUrl 等待端口。
    // 通过从 login URL 中解码端口号来模拟浏览器回调。
    const loginUrl = await waitFor(() => opened[0])
    const service = new URL(loginUrl).searchParams.get('service') as string
    const redirect = new URL(decodeURIComponent(service))
    const callback = new URL(redirect.searchParams.get('auth_callback_url') as string)
    const response = await fetch(`http://127.0.0.1:${callback.port}/authentication?token=from-browser`)
    expect(response.status).toBe(200)
    const result = await flow
    expect(result.access).toBe('from-browser')
    expect(result.loginUrl).toBe(loginUrl)
  })
})

async function waitFor<T>(get: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('buildOAuthLoginUrl', () => {
  it('matches the reverse-engineered portal authorize parameters', () => {
    const pkce = { codeVerifier: 'VERIFIER', codeChallenge: 'CHALLENGE' }
    const url = buildOAuthLoginUrl(43123, pkce, 'a'.repeat(64))
    expect(url).toBe(
      `${PORTAL_AUTHORIZE_BASE}?theme=${'2'}&locale=${'zh-cn'}`
      + '&uri_scheme=codearts-agent&client_id=codearts-agent&port=43123'
      // code_challenge_method 对齐真实插件（SHA-256 而非 S256）。
      + '&code_challenge=CHALLENGE&code_challenge_method=SHA-256'
      + `&ticket_id=${'a'.repeat(64)}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`,
    )
  })
})

describe('startOAuthCallbackServer', () => {
  it('exchanges the authorization code and resolves the stored credential JSON', async () => {
    // 模拟 STS 端点：返回完整凭据。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expiration: '2026-08-15T00:00:00Z',
      },
      refresh_token: 'RT',
    }), { status: 200 }))
    const pkce = { codeVerifier: 'VERIFIER', codeChallenge: 'CHALLENGE' }
    const keyPair = await generateDpopKeyPair()
    const { port, server, result } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, { fetcher: fetcher as unknown as typeof fetch })

    // 以真实 HTTP 请求触发回调：/oauth/callback?code=CODE
    // redirect: 'manual' —— 不自动跟随 307，以便断言重定向本身。
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=CODE`, { redirect: 'manual' })
    expect(res.status).toBe(307)
    // 换取成功后浏览器被 307 重定向到 portal 登录结果页（对齐真实插件）。
    expect(res.headers.get('location')).toBe(buildPortalLoginResultUrl(true))
    const outcome = await result
    const credential = JSON.parse(outcome.access) as Record<string, string>
    expect(credential).toMatchObject({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT', code_verifier: 'VERIFIER',
    })
    await new Promise((resolve) => server.close(resolve))
  })

  it('falls back to the legacy ticket poll when the portal sends a secret callback', async () => {
    // 模拟 snap-manager ticket 端点：返回完整凭据（旧流程回退路径）。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credential: {
        access: 'AK', secret: 'SK', securitytoken: 'ST',
        expires_at: '2026-08-15T00:00:00Z',
      },
      user_id: 'u-1', user_name: 'tester', domain_id: 'd-1',
    }), { status: 200 }))
    const pkce = { codeVerifier: 'VERIFIER', codeChallenge: 'CHALLENGE' }
    const keyPair = await generateDpopKeyPair()
    const { port, server, result } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, { fetcher: fetcher as unknown as typeof fetch })

    // 以真实 HTTP 请求触发回调：/oauth/callback?secret=<portal secret>&redirect=<portal login 页>
    const redirectTarget = 'https://codearts.huaweicloud.com/portal/login?login_succeed=true&uri_scheme=codearts-agent&locale=zh-cn'
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?secret=PORTAL-SECRET&redirect=${encodeURIComponent(redirectTarget)}`, { redirect: 'manual' })
    expect(res.status).toBe(307)
    // 旧流程回退：立即 307 重定向到 portal 回传的 redirect 地址（对齐真实插件）。
    expect(res.headers.get('location')).toBe(redirectTarget)
    const outcome = await result
    const credential = JSON.parse(outcome.access) as Record<string, string>
    expect(credential.access_key_id).toBe('AK')
    expect(credential.security_token).toBe('ST')
    // 旧流程凭据无 refresh_token → refreshable 由服务层判定为 false。
    expect(credential.refresh_token).toBeUndefined()
    // 轮询请求头使用新式插件名（对齐真实插件的 snap_AIIDE/5.2.0）。
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/login/ticket')
    const headers = init.headers as Record<string, string>
    expect(headers['plugin-name']).toBe(LOGIN_PLUGIN_NAME)
    expect(headers['plugin-version']).toBe(LOGIN_PLUGIN_VERSION)
    await new Promise((resolve) => server.close(resolve))
  })

  it('responds 400 without an authorization code or secret', async () => {
    const pkce = { codeVerifier: 'V', codeChallenge: 'C' }
    const keyPair = await generateDpopKeyPair()
    const { port, server } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, {})
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback`)
    expect(res.status).toBe(400)
    await new Promise((resolve) => server.close(resolve))
  })

  it('listens on a callback port >= 10000 (portal requirement)', async () => {
    const pkce = { codeVerifier: 'V', codeChallenge: 'C' }
    const keyPair = await generateDpopKeyPair()
    const { port, server } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, {})
    expect(port).toBeGreaterThanOrEqual(10_000)
    await new Promise((resolve) => server.close(resolve))
  })
})

describe('runOAuthFlow', () => {
  it('opens the login URL, exchanges the code and returns access/expires/loginUrl', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expiration: '2026-08-15T00:00:00Z',
      },
      refresh_token: 'RT',
    }), { status: 200 }))
    const opened: string[] = []
    const openBrowser = (url: string) => { opened.push(url) }
    // runOAuthFlow 会 await openBrowser 的返回值；同步返回即可。
    const flowPromise = runOAuthFlow({ fetcher: fetcher as unknown as typeof fetch, openBrowser })

    // 等待回调服务器就绪（runOAuthFlow 内部先起服务器再开浏览器）——用短轮询。
    await vi.waitFor(async () => {
      expect(opened.length).toBe(1)
    }, { timeout: 2000 })
    const loginUrl = opened[0]
    const url = new URL(loginUrl)
    const codeChallenge = url.searchParams.get('code_challenge')
    expect(codeChallenge).toBeTruthy()
    // 从打开的 URL 解析端口并发起回调。
    const port = url.searchParams.get('port')
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=CODE`, { redirect: 'manual' })
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(buildPortalLoginResultUrl(true))

    const outcome = await flowPromise
    expect(outcome.loginUrl).toBe(loginUrl)
    expect(outcome.expires).toBe(Date.parse('2026-08-15T00:00:00Z'))
    const credential = JSON.parse(outcome.access) as Record<string, string>
    expect(credential.refresh_token).toBe('RT')
  })
})
