import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_ID, REDIRECT_PATH, STS_TOKEN_ENDPOINT,
  RefreshTokenExpiredError, credentialFromTokenResponse,
  exchangeAuthorizationCode, exchangeRefreshToken,
  generateDpopKeyPair, generatePkcePair, requestToken, signDpopJws,
} from '../../src/oauth.js'

describe('generatePkcePair', () => {
  it('produces a 43-128 char verifier and a base64url S256 challenge', () => {
    const pair = generatePkcePair()
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128)
    const expected = createHash('sha256').update(pair.codeVerifier).digest('base64url')
    expect(pair.codeChallenge).toBe(expected)
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('generateDpopKeyPair / signDpopJws', () => {
  it('generates a P-256 ES256 JWK pair and signs a dpop+jwt JWS', async () => {
    const pair = await generateDpopKeyPair()
    expect(pair.publicKeyJwk.kty).toBe('EC')
    expect(pair.publicKeyJwk.crv).toBe('P-256')
    expect(pair.privateKeyJwk.d).toBeTruthy()

    const jws = await signDpopJws(pair, 'POST', STS_TOKEN_ENDPOINT)
    const [headerB64, payloadB64] = jws.split('.')
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString())
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    expect(header).toMatchObject({ alg: 'ES256', typ: 'dpop+jwt' })
    expect(header.jwk).toEqual(pair.publicKeyJwk)
    expect(payload.htm).toBe('POST')
    expect(payload.htu).toBe(STS_TOKEN_ENDPOINT)
    expect(typeof payload.iat).toBe('number')
    expect(payload.jti).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exports the client constants expected by the portal', () => {
    expect(CLIENT_ID).toBe('codearts-agent')
    expect(REDIRECT_PATH).toBe('/oauth/callback')
    expect(STS_TOKEN_ENDPOINT).toBe('https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens')
  })
})

describe('requestToken / exchangeAuthorizationCode', () => {
  it('posts form-encoded body with DPoP header and resolves credentials', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({
        credentials: {
          access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
          expiration: '2026-08-15T00:00:00Z',
        },
        refresh_token: 'RT',
      }), { status: 200 }))
    const pair = await generateDpopKeyPair()
    const token = await exchangeAuthorizationCode('CODE', 'VERIFIER', 43123, pair, fetcher as unknown as typeof fetch)
    expect(token.credentials?.access_key_id).toBe('AK')
    expect(token.refresh_token).toBe('RT')

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(STS_TOKEN_ENDPOINT)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('client_id')).toBe('codearts-agent')
    expect(body.get('code')).toBe('CODE')
    expect(body.get('code_verifier')).toBe('VERIFIER')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:43123/oauth/callback')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const dpop = headers['DPoP']
    expect(dpop).toBeTruthy()
    const payload = JSON.parse(Buffer.from(dpop!.split('.')[1], 'base64url').toString())
    expect(payload).toMatchObject({ htm: 'POST', htu: STS_TOKEN_ENDPOINT })
  })

  it('throws RefreshTokenExpiredError on invalid_grant', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 }))
    const pair = await generateDpopKeyPair()
    await expect(exchangeRefreshToken('RT', 'VERIFIER', pair, fetcher as unknown as typeof fetch))
      .rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('⚠️ error_code InvalidDPoPHeader 归为**可重试**，不是 refresh_token 失效', async () => {
    // 旧实现把 InvalidDPoPHeader 也当终态（理由写的是「避免每 10 分钟无限重试」），
    // 真实代价却是一个**材料完好**的账号被永久标成「不可续期」：
    // 用户报障「两个 codearts 账号 401、自动续期没工作、重启也还是 401」，
    // 取证时凭据里的 refresh_token 还剩 18 天寿命、code_verifier 与 DPoP 私钥都在。
    // DPoP proof 没过校验说的是「这一次证明不合格」（时钟偏差让 iat 落窗外、
    // proof 被判重放、网关抖动），与「refresh_token 还能不能用」无关 ——
    // 归为可重试最多是 10 分钟后再发一个 HTTP 请求，远比作废一个账号便宜。
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        error: 'invalid_dpop', error_code: 'InvalidDPoPHeader', error_msg: 'DPoP proof invalid',
      }), { status: 400 }))
    const pair = await generateDpopKeyPair()
    await expect(exchangeRefreshToken('RT', 'VERIFIER', pair, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/InvalidDPoPHeader|failed/)
    const caught = await exchangeRefreshToken('RT', 'VERIFIER', pair, fetcher as unknown as typeof fetch)
      .then(() => undefined, (error: unknown) => error as Error)
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('error_code ExpiredRefreshToken 仍是终态（refresh_token 真失效）', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error_code: 'ExpiredRefreshToken', error_msg: 'gone' }), { status: 400 }))
    const pair = await generateDpopKeyPair()
    await expect(exchangeRefreshToken('RT', 'VERIFIER', pair, fetcher as unknown as typeof fetch))
      .rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws a plain Error on other failures', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }))
    const pair = await generateDpopKeyPair()
    await expect(requestToken({ grant_type: 'refresh_token' }, pair, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/failed/)
  })
})

describe('credentialFromTokenResponse', () => {
  it('maps credentials + refresh fields into the stored JSON shape', () => {
    const pair = { privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }
    const pkce = { codeVerifier: 'V', codeChallenge: 'C' }
    const credential = credentialFromTokenResponse({
      credentials: { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expiration: '2026-08-15T00:00:00Z' },
      refresh_token: 'RT',
    }, pkce, pair)
    expect(credential).toMatchObject({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT',
      code_verifier: 'V',
    })
    expect(credential.dpop_private_key_jwk).toEqual(pair.privateKeyJwk)
  })
})
