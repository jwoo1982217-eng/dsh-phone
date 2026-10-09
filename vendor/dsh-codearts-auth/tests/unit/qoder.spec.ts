import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildQoderAuthUrl, buildQoderPollUrl, createQoderPkce, createQoderDeviceSession,
  parseQoderTokenPayload, buildQoderCredential, qoderCredentialExpiresAtMs,
  isQoderRefreshable, isQoderExpired, qoderRefreshBody, qoderBearerToken,
  applyQoderRefresh, qoderChatHeaders, QODER_POLL_PATH,
} from '../../src/qoder.js'
import { QODER } from '../../src/qoder-product.js'

describe('PKCE', () => {
  it('verifier 长度 43..128 且只用 unreserved 字符', () => {
    // 依据：源码 Y_a() 取 43 + floor(86*random)，字符集 66 个 unreserved 字符
    for (let i = 0; i < 20; i++) {
      const { verifier } = createQoderPkce()
      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(verifier.length).toBeLessThanOrEqual(128)
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    }
  })

  it('challenge = base64url(sha256(verifier)) 且无 padding', () => {
    const { verifier, challenge } = createQoderPkce()
    const expected = createHash('sha256').update(verifier).digest()
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(challenge).toBe(expected)
    expect(challenge).not.toContain('=')
    expect(challenge).not.toMatch(/[+/]/)
  })
})

describe('设备会话与 URL', () => {
  it('session 含 pkce / nonce / machineId', () => {
    const s = createQoderDeviceSession()
    expect(s.nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.machineId.length).toBeGreaterThan(0)
    expect(s.pkce.verifier.length).toBeGreaterThan(0)
  })

  it('authUrl 指向 /device/selectAccounts 且带全部必需参数', () => {
    // 依据：设计文档 §2.3 步骤 3
    const s = createQoderDeviceSession()
    const url = new URL(buildQoderAuthUrl(s, QODER))
    expect(url.origin).toBe('https://qoder.com')
    expect(url.pathname).toBe('/device/selectAccounts')
    expect(url.searchParams.get('challenge')).toBe(s.pkce.challenge)
    expect(url.searchParams.get('challenge_method')).toBe('S256')
    expect(url.searchParams.get('nonce')).toBe(s.nonce)
    expect(url.searchParams.get('machine_id')).toBe(s.machineId)
    expect(url.searchParams.get('client_id')).toBe(QODER.clientId)
  })

  it('prod 环境用 J_a（IDE client id），不是 G_a', () => {
    // 真实缺陷（用户报障）：GitHub 授权后页面报「参数无效」。
    // 根因：源码 `__a(A,e,t,i=!0,n,r)` 的 client_id 是 `i ? J_a : G_a`，
    // 而调用点（loginWithDeviceFlow）传的第 4 参是 `isProd()`——prod 为 true，
    // 即 **prod 用 J_a**。早期把第 4 参误读成「useIdeClientId」，
    // 于是 prod 用了 G_a（那是 test 环境的 id），服务端在授权回调阶段拒绝。
    const s = createQoderDeviceSession()
    const cid = new URL(buildQoderAuthUrl(s, QODER)).searchParams.get('client_id')
    expect(cid).toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
    expect(cid).not.toBe('e93fe488-5778-4c35-a6fc-0f54ed7b3139')
  })

  it('pollUrl 指向 openapi 基址的 /api/v1/deviceToken/poll', () => {
    // ⚠️ host 必须是 openapi.qoder.sh，不是 qoder.com（实测 401 vs 404）
    const s = createQoderDeviceSession()
    const url = new URL(buildQoderPollUrl(s, QODER))
    expect(url.origin).toBe('https://openapi.qoder.sh')
    expect(url.pathname).toBe(QODER_POLL_PATH)
    expect(url.searchParams.get('nonce')).toBe(s.nonce)
    expect(url.searchParams.get('verifier')).toBe(s.pkce.verifier)
    expect(url.searchParams.get('challenge_method')).toBe('S256')
  })
})

describe('凭据解析', () => {
  const payload = {
    token: 'tok-1',
    refresh_token: 'ref-1',
    expires_at: '2030-01-01T00:00:00.000Z',
    refresh_token_expires_at: '2031-01-01T00:00:00.000Z',
  }

  it('parseQoderTokenPayload 读 token / refresh_token', () => {
    expect(parseQoderTokenPayload(payload)).toEqual({
      accessToken: 'tok-1',
      refreshToken: 'ref-1',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
      refreshTokenExpiresAt: Date.parse('2031-01-01T00:00:00.000Z'),
    })
  })

  it('parseQoderTokenPayload 容忍 device_token 字段名（续期响应用它）', () => {
    expect(parseQoderTokenPayload({ device_token: 'dt', refresh_token: 'r' }).accessToken).toBe('dt')
  })

  it('parseQoderTokenPayload 对垃圾输入返回空 token 而非抛错', () => {
    expect(parseQoderTokenPayload(null).accessToken).toBe('')
    expect(parseQoderTokenPayload('x').accessToken).toBe('')
    expect(parseQoderTokenPayload({}).accessToken).toBe('')
  })

  it('buildQoderCredential 双写 security_oauth_token 与 access_token', () => {
    // 依据：源码取用顺序 `security_oauth_token ?? access_token`
    const c = buildQoderCredential(parseQoderTokenPayload(payload), { machineId: 'm-1' })
    expect(c.security_oauth_token).toBe('tok-1')
    expect(c.access_token).toBe('tok-1')
    expect(c.refresh_token).toBe('ref-1')
    expect(c.machine_id).toBe('m-1')
    expect(c.expire_time).toBe(Date.parse('2030-01-01T00:00:00.000Z'))
  })

  it('qoderBearerToken 优先 security_oauth_token', () => {
    expect(qoderBearerToken({ security_oauth_token: 'a', access_token: 'b' } as never)).toBe('a')
    expect(qoderBearerToken({ access_token: 'b' } as never)).toBe('b')
    expect(qoderBearerToken({} as never)).toBe('')
  })

  it('过期判定与可续期判定', () => {
    const c = buildQoderCredential(parseQoderTokenPayload(payload), { machineId: 'm' })
    expect(qoderCredentialExpiresAtMs(c)).toBe(Date.parse('2030-01-01T00:00:00.000Z'))
    expect(isQoderExpired(c, Date.parse('2029-01-01T00:00:00.000Z'))).toBe(false)
    expect(isQoderExpired(c, Date.parse('2031-01-01T00:00:00.000Z'))).toBe(true)
    expect(isQoderRefreshable(c)).toBe(true)
    expect(isQoderRefreshable({ ...c, refresh_token: undefined })).toBe(false)
  })

  it('无过期时间时保守视为未过期', () => {
    const c = buildQoderCredential(parseQoderTokenPayload({ token: 't' }), { machineId: 'm' })
    expect(qoderCredentialExpiresAtMs(c)).toBeUndefined()
    expect(isQoderExpired(c, Date.now())).toBe(false)
  })
})

describe('续期', () => {
  it('refreshBody 只带 refresh_token 与 machine_id（machine_token 可选不发）', () => {
    // 依据：设计文档 §2.4
    const c = buildQoderCredential(
      parseQoderTokenPayload({ token: 't', refresh_token: 'r' }), { machineId: 'm-9' })
    expect(qoderRefreshBody(c)).toEqual({ refresh_token: 'r', machine_id: 'm-9' })
  })

  it('applyQoderRefresh 用新 token 覆盖并保留 machine_id', () => {
    const old = buildQoderCredential(
      parseQoderTokenPayload({ token: 'old', refresh_token: 'r1' }), { machineId: 'm-9' })
    const next = applyQoderRefresh(old, parseQoderTokenPayload({
      device_token: 'new', refresh_token: 'r2',
    }))
    expect(next.access_token).toBe('new')
    expect(next.security_oauth_token).toBe('new')
    expect(next.refresh_token).toBe('r2')
    expect(next.machine_id).toBe('m-9')
  })

  it('续期响应缺 refresh_token 时沿用旧的（不把可续期凭据变不可续期）', () => {
    const old = buildQoderCredential(
      parseQoderTokenPayload({ token: 'old', refresh_token: 'r1' }), { machineId: 'm-9' })
    const next = applyQoderRefresh(old, parseQoderTokenPayload({ device_token: 'new' }))
    expect(next.refresh_token).toBe('r1')
    expect(isQoderRefreshable(next)).toBe(true)
  })

  it('applyQoderRefresh 保留 nickname', () => {
    const old = buildQoderCredential(
      parseQoderTokenPayload({ token: 'old', refresh_token: 'r1' }),
      { machineId: 'm-9', nickname: 'iJetLi' })
    const next = applyQoderRefresh(old, parseQoderTokenPayload({ device_token: 'new' }))
    expect(next.nickname).toBe('iJetLi')
  })
})

describe('推理请求头', () => {
  it('带 Bearer 与请求/会话 id，Accept 为 SSE', () => {
    const c = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok' }), { machineId: 'm' })
    const headers = qoderChatHeaders(c, QODER, 'req-1', 'sess-1')
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers.Accept).toBe('text/event-stream')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Request-ID']).toBe('req-1')
    expect(headers['X-Session-ID']).toBe('sess-1')
  })
})
