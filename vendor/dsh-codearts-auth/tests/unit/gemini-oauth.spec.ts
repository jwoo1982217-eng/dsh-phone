/**
 * Gemini OAuth 单测。
 *
 * 守的是四个踩过的坑：
 * 1. token 端点**必须**带 `client_secret`（否则 `invalid_request`，症状是
 *    「浏览器授权成功但账号不出现」）；
 * 2. `state` 不匹配的回调必须拒绝；
 * 3. 续期响应里给了新 `refresh_token` 必须回写（Google 偶尔轮换）；
 * 4. 身份**必须**优先取自令牌响应自带的 `id_token` —— 只靠 userinfo 那次
 *    跨域请求时，它一失败（当时还静默吞异常）昵称就退化成池 id
 *    （2026-10-03 报障 `gemini-6a53dbca`）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  GEMINI_AUTH_ENDPOINT,
  GEMINI_CALLBACK_PATH,
  GEMINI_DEFAULT_CLIENT_ID,
  GEMINI_DEFAULT_CLIENT_SECRET,
  geminiClientId,
  geminiClientSecret,
  GEMINI_SCOPES,
  GeminiLoginCancelledError,
  buildGeminiAuthUrl,
  credentialFromGeminiGrant,
  exchangeGeminiCode,
  fetchGeminiUserInfo,
  geminiIdentityFromIdToken,
  parseGeminiTokenGrant,
  refreshGeminiCredential,
  revokeGeminiToken,
  startGeminiOAuthFlow,
} from '../../src/gemini-oauth.js'
import { geminiAccountLabel, parseGeminiCredential } from '../../src/gemini.js'

const previousId = process.env.CMDC_PAK_GOOGLE_CLIENT_ID
const previousSecret = process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET

beforeEach(() => {
  process.env.CMDC_PAK_GOOGLE_CLIENT_ID = 'fixture-google-client-id'
  process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET = 'fixture-google-client-secret'
})

afterEach(() => {
  if (previousId === undefined) delete process.env.CMDC_PAK_GOOGLE_CLIENT_ID
  else process.env.CMDC_PAK_GOOGLE_CLIENT_ID = previousId
  if (previousSecret === undefined) delete process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET
  else process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET = previousSecret
  vi.restoreAllMocks()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 造一个未签名形态的 `id_token`（只做 base64url 编码，与服务端结构同形）。 */
function idToken(payload: Record<string, unknown>): string {
  return `hdr.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.sig`
}

/** 抓取 fetch 的调用参数（工厂按调用序号产出响应）。 */
function captureFetch(response: Response | ((callIndex: number) => Response)) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const index = calls.length
    calls.push({ url: String(url), init: init ?? {} })
    return typeof response === 'function' ? response(index) : response
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe('授权 URL', () => {
  it('六项 scope + 离线访问 + consent；无 PKCE（原版带 client_secret）；env 可覆盖 client_id', () => {
    const url = new URL(buildGeminiAuthUrl({ state: 'STATE', redirectUri: 'http://localhost:1234/oauth-callback' }))
    expect(`${url.origin}${url.pathname}`).toBe(GEMINI_AUTH_ENDPOINT)
    expect(url.searchParams.get('client_id')).toBe('fixture-google-client-id')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1234/oauth-callback')
    expect(url.searchParams.get('state')).toBe('STATE')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('include_granted_scopes')).toBe('true')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GEMINI_SCOPES])
    expect(url.searchParams.get('code_challenge')).toBeNull()

    process.env.CMDC_PAK_GOOGLE_CLIENT_ID = 'custom-client'
    expect(new URL(buildGeminiAuthUrl({ state: 'S', redirectUri: 'http://localhost:1/x' }))
      .searchParams.get('client_id')).toBe('custom-client')
  })
})

describe('令牌解析', () => {
  it('正常响应逐字解析；缺 refresh_token 时沿用旧值（续期响应常不带）', () => {
    expect(parseGeminiTokenGrant({
      access_token: 'AT',
      refresh_token: 'RT',
      token_type: 'Bearer',
      expires_in: 3599,
      scope: 'openid',
    })).toEqual({
      access_token: 'AT',
      refresh_token: 'RT',
      token_type: 'Bearer',
      expires_in: 3599,
      scope: 'openid',
    })
    expect(parseGeminiTokenGrant({ access_token: 'AT2', expires_in: 3600 }, 'RT_OLD').refresh_token)
      .toBe('RT_OLD')
  })

  it('error 字段 / 缺 access_token / 非对象都给可定位的文案；token_type 与 expires_in 有兜底', () => {
    expect(() => parseGeminiTokenGrant({ error: 'invalid_grant', error_description: 'expired' }))
      .toThrowError('invalid_grant: expired')
    expect(() => parseGeminiTokenGrant({ expires_in: 3600 })).toThrowError(/未返回 access_token/)
    expect(() => parseGeminiTokenGrant('nope')).toThrowError(/无法解析/)

    const grant = parseGeminiTokenGrant({ access_token: 'AT', expires_in: -5 })
    expect(grant.token_type).toBe('Bearer')
    expect(grant.expires_in).toBe(3600)
  })

  it('id_token 被保留（身份的第一来源，不再依赖 userinfo）；缺席时不写该字段', () => {
    const token = idToken({ sub: 'sub-9', email: 'u@example.com' })
    expect(parseGeminiTokenGrant({ access_token: 'AT', expires_in: 3600, id_token: token }).id_token)
      .toBe(token)
    // 避免把 undefined 混进落盘 JSON。
    expect('id_token' in parseGeminiTokenGrant({ access_token: 'AT', expires_in: 3600 })).toBe(false)
  })
})

describe('id_token 解身份', () => {
  it('取 sub 与 email（不验签，仅 base64url 解码）', () => {
    expect(geminiIdentityFromIdToken(idToken({ sub: 's1', email: 'a@b.c', aud: 'x' })))
      .toEqual({ sub: 's1', email: 'a@b.c' })
  })

  it('形态不对 / 空字符串字段一律返回空对象（身份不该让授权失败）', () => {
    expect(geminiIdentityFromIdToken('')).toEqual({})
    expect(geminiIdentityFromIdToken('no-dots')).toEqual({})
    expect(geminiIdentityFromIdToken('hdr.!!!not-base64!!!.sig')).toEqual({})
    expect(geminiIdentityFromIdToken(`hdr.${Buffer.from('[1,2]').toString('base64url')}.sig`)).toEqual({})
    expect(geminiIdentityFromIdToken(idToken({ sub: '', email: '' }))).toEqual({})
  })
})

describe('凭据构造', () => {
  it('保留既有 sub/email/project 不因续期丢身份；落盘再解析仍等价', () => {
    const credential = credentialFromGeminiGrant(
      { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 },
      { refresh_token: 'RT_OLD', sub: 'sub-1', email: 'a@b.c', cloudaicompanionProject: 'proj' },
    )
    expect(credential).toMatchObject({
      access_token: 'AT',
      refresh_token: 'RT_OLD',
      sub: 'sub-1',
      email: 'a@b.c',
      cloudaicompanionProject: 'proj',
    })
    expect(parseGeminiCredential(JSON.stringify(credential))).toEqual(credential)
    expect(Date.parse(credential.expiry!) - Date.now()).toBeGreaterThan(3_500_000)
  })

  it('id_token 优先于既有凭据（报障根因面）；解不出时退到既有；两者都无时**不编造**', () => {
    const fresh = credentialFromGeminiGrant(
      {
        access_token: 'AT', token_type: 'Bearer', expires_in: 3600,
        id_token: idToken({ sub: 'sub-NEW', email: 'new@b.c' }),
      },
      { refresh_token: 'RT_OLD', sub: 'sub-OLD', email: 'old@b.c', cloudaicompanionProject: 'proj' },
    )
    expect(fresh).toMatchObject({
      refresh_token: 'RT_OLD', sub: 'sub-NEW', email: 'new@b.c', cloudaicompanionProject: 'proj',
    })
    // 展示名因此可算 —— 这就是 2026-10-03 报障的根因面。
    expect(geminiAccountLabel(fresh)).toBe('new@b.c')

    const broken = credentialFromGeminiGrant(
      { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, id_token: 'broken' },
      { sub: 'sub-OLD', email: 'old@b.c' },
    )
    expect(broken.sub).toBe('sub-OLD')
    expect(broken.email).toBe('old@b.c')

    const none = credentialFromGeminiGrant({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600 })
    expect(geminiAccountLabel(none), '昵称回落到池 id 是唯一诚实行为').toBeUndefined()
  })
})

describe('令牌交换与续期', () => {
  it('交换**必须**带 client_secret 与 redirect_uri、**不**带 PKCE、**不**伪装 UA', async () => {
    const { calls, fetcher } = captureFetch(json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))
    await exchangeGeminiCode('CODE', 'http://localhost:1234/oauth-callback', { fetcher })
    const body = new URLSearchParams(String(calls[0]?.init.body))
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('CODE')
    expect(body.get('redirect_uri')).toBe('http://localhost:1234/oauth-callback')
    expect(body.get('client_secret')).toBeTruthy()
    expect(body.get('code_verifier')).toBeNull()
    // ⚠️ 令牌端点不伪装 UA（伪装只用在 Cloud Code 端点）。
    expect((calls[0]?.init.headers as Record<string, string>)['User-Agent']).toBeUndefined()
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded')
  })

  it('续期用 refresh_token grant 并带旧值；空 refresh_token 直接报错不发请求', async () => {
    const { calls, fetcher } = captureFetch(json({ access_token: 'AT2', expires_in: 3600 }))
    const grant = await refreshGeminiCredential('RT_OLD', { fetcher })
    const body = new URLSearchParams(String(calls[0]?.init.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT_OLD')
    expect(grant.refresh_token).toBe('RT_OLD')

    const empty = captureFetch(json({}))
    await expect(refreshGeminiCredential('', { fetcher: empty.fetcher })).rejects.toThrowError(/需要重新授权/)
    expect(empty.calls).toHaveLength(0)
  })

  it('HTTP 非 2xx 带出 error/description；非 JSON 给出可定位的文案', async () => {
    const { fetcher } = captureFetch(json({ error: 'invalid_client', error_description: 'bad secret' }, 401))
    await expect(exchangeGeminiCode('C', 'http://localhost:1/x', { fetcher }))
      .rejects.toThrowError('invalid_client: bad secret')

    const html = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch
    await expect(exchangeGeminiCode('C', 'http://localhost:1/x', { fetcher: html }))
      .rejects.toThrowError(/无法解析（HTTP 502）/)
  })
})

describe('userinfo 与撤销', () => {
  it('取 id/email（id 就是 OIDC 的 sub），失败返回空对象并把原因经 onFailure 上报', async () => {
    const { calls, fetcher } = captureFetch(json({ id: 'sub-1', email: 'a@b.c' }))
    expect(await fetchGeminiUserInfo('AT', { fetcher })).toEqual({ sub: 'sub-1', email: 'a@b.c' })
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer AT')

    // 身份只是展示信息，失败不该让授权失败；但原因必须留痕
    // （曾经的静默吞异常让现场零线索）。
    const reasons: string[] = []
    const unauthorized = (async () => json({ error: 'x' }, 401)) as unknown as typeof fetch
    expect(await fetchGeminiUserInfo('AT', { fetcher: unauthorized, onFailure: (r) => reasons.push(r) }))
      .toEqual({})
    const boom = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await fetchGeminiUserInfo('AT', { fetcher: boom, onFailure: (r) => reasons.push(r) })).toEqual({})
    expect(reasons).toEqual(['userinfo 返回 HTTP 401', 'network down'])
  })

  it('撤销失败不上抛（登出不能被网络问题卡住）', async () => {
    const boom = (async () => { throw new Error('network') }) as unknown as typeof fetch
    await expect(revokeGeminiToken('AT', { fetcher: boom })).resolves.toBeUndefined()
    await expect(revokeGeminiToken('', { fetcher: boom })).resolves.toBeUndefined()
  })
})

describe('两步式授权流程', () => {
  it('立即返回 loginUrl；回调携带正确 state 时完成交换，身份来自 id_token ⇒ 只有一次请求', async () => {
    const { calls, fetcher } = captureFetch(json({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      id_token: idToken({ sub: 'sub-9', email: 'u@example.com' }),
    }))
    const started = await startGeminiOAuthFlow({ fetcher, callbackPort: 0 })
    try {
      const url = new URL(started.loginUrl)
      const state = url.searchParams.get('state') ?? ''
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      expect(redirect.pathname).toBe(GEMINI_CALLBACK_PATH)
      expect(state).toMatch(/^[0-9a-f]{32}$/)

      const callback = await fetch(
        `http://127.0.0.1:${redirect.port}${GEMINI_CALLBACK_PATH}?code=CODE&state=${state}`,
      )
      expect(callback.status).toBe(200)
      expect(await callback.text()).toContain('授权已完成')

      const credential = await started.result
      expect(credential).toMatchObject({
        access_token: 'AT', refresh_token: 'RT', sub: 'sub-9', email: 'u@example.com',
      })
      expect(credential.expiry).toBeDefined()
      // ⚠️ 不再打 userinfo。
      expect(calls.map((call) => call.url)).toEqual(['https://oauth2.googleapis.com/token'])
    } finally {
      await started.close()
      await started.close() // 幂等
    }
  })

  it('id_token 缺席时才兜底 userinfo，且失败只上报原因、登录本身仍成功', async () => {
    const { calls, fetcher } = captureFetch((index) => {
      // 第 0 次是 token 交换（无 id_token），第 1 次是兜底 userinfo（失败）。
      return index === 0
        ? json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
        : json({ error: 'x' }, 401)
    })
    const reasons: string[] = []
    const started = await startGeminiOAuthFlow({
      fetcher,
      callbackPort: 0,
      onIdentityFailure: (reason) => reasons.push(reason),
    })
    try {
      const url = new URL(started.loginUrl)
      const state = url.searchParams.get('state') ?? ''
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      await fetch(`http://127.0.0.1:${redirect.port}${GEMINI_CALLBACK_PATH}?code=CODE&state=${state}`)
      const credential = await started.result
      expect(credential.access_token).toBe('AT')
      expect(credential.sub).toBeUndefined()
      expect(calls.map((call) => call.url)).toEqual([
        'https://oauth2.googleapis.com/token',
        'https://www.googleapis.com/oauth2/v2/userinfo',
      ])
      expect(reasons).toEqual(['userinfo 返回 HTTP 401'])
    } finally {
      await started.close()
    }
  })

  it('state 不匹配 / 用户点取消 / 路径之外，分别 400 拒绝、抛取消异常、404', async () => {
    const wrong = captureFetch(json({ access_token: 'AT' }))
    const started = await startGeminiOAuthFlow({ fetcher: wrong.fetcher, callbackPort: 0 })
    try {
      const redirect = new URL(new URL(started.loginUrl).searchParams.get('redirect_uri') ?? '')
      // ⚠️ 顺序要紧：`result` 一旦 settle，`finally { void close() }` 就会把本地
      // 回调端口关掉，之后的请求只会拿到 ECONNREFUSED（不是 404）。
      expect(await fetch(`http://127.0.0.1:${redirect.port}/other`)).toHaveProperty('status', 404)
      const callback = await fetch(
        `http://127.0.0.1:${redirect.port}${GEMINI_CALLBACK_PATH}?code=CODE&state=WRONG`,
      )
      expect(callback.status).toBe(400)
      await expect(started.result).rejects.toThrowError(/state 校验失败/)
    } finally {
      await started.close()
    }

    const cancelled = captureFetch(json({}))
    const second = await startGeminiOAuthFlow({ fetcher: cancelled.fetcher, callbackPort: 0 })
    try {
      const url = new URL(second.loginUrl)
      const state = url.searchParams.get('state') ?? ''
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      const callback = await fetch(
        `http://127.0.0.1:${redirect.port}${GEMINI_CALLBACK_PATH}?error=access_denied&state=${state}`,
      )
      expect(callback.status).toBe(400)
      // 面板应显示「已取消」而非「失败」。
      await expect(second.result).rejects.toBeInstanceOf(GeminiLoginCancelledError)
    } finally {
      await second.close()
    }
  })
})


describe('公开版 OAuth 本地配置', () => {
  it('源码不内置客户端信息，缺配置在监听和请求前拒绝', async () => {
    expect(GEMINI_DEFAULT_CLIENT_ID).toBe('')
    expect(GEMINI_DEFAULT_CLIENT_SECRET).toBe('')
    delete process.env.CMDC_PAK_GOOGLE_CLIENT_ID
    delete process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET
    const fetcher = vi.fn()
    await expect(startGeminiOAuthFlow({ fetcher: fetcher as unknown as typeof fetch, timeoutMs: 20 })).rejects.toThrow('CMDC_PAK_GOOGLE_CLIENT_ID')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('只有客户端 ID 时拒绝；补齐配置后支持正常授权与空白清理', async () => {
    process.env.CMDC_PAK_GOOGLE_CLIENT_ID = ' fixture-google-client-id '
    process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET = ' '
    await expect(startGeminiOAuthFlow({ timeoutMs: 20 })).rejects.toThrow('CMDC_PAK_GOOGLE_CLIENT_SECRET')
    process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET = ' fixture-google-client-secret '
    expect(geminiClientId()).toBe('fixture-google-client-id')
    expect(geminiClientSecret()).toBe('fixture-google-client-secret')
    const flow = await startGeminiOAuthFlow({ timeoutMs: 10000 })
    expect(new URL(flow.loginUrl).searchParams.get('client_id')).toBe('fixture-google-client-id')
    flow.result.catch(() => {})
    await flow.close()
  })
})
