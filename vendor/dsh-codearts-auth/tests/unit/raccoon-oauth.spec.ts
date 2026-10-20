import { describe, expect, it, vi } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  buildQrImageUrl,
  exchangeRaccoonAuthorizationCode,
  fetchRaccoonUserInfo,
  generateQrCode,
  loginRaccoonWithSmsCode,
  pollRaccoonQrLogin,
  refreshRaccoonCredential,
  sendRaccoonSmsCode,
} from '../../src/raccoon-oauth.js'

/** 造一个最小 JWT（exp 在指定秒数）。 */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: expSeconds, name: 'RaccoonAva' })).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('generateQrCode', () => {
  it('生成 32 位 hex（16 字节随机）', () => {
    const code = generateQrCode()
    expect(code).toMatch(/^[0-9a-f]{32}$/)
  })

  it('每次不同', () => {
    expect(generateQrCode()).not.toBe(generateQrCode())
  })
})

describe('buildQrImageUrl', () => {
  it('指向公开的微信登录页，带 code 与 appname', () => {
    const url = buildQrImageUrl(RACCOON, 'abc123')
    expect(url).toContain('https://xiaohuanxiong.com/login/mp?code=abc123')
    expect(url).toContain('appname=')
  })
})

describe('pollRaccoonQrLogin', () => {
  it('pending 状态原样返回', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('pending')
    expect(fetcher).toHaveBeenCalledWith(
      `${RACCOON.apiBase}${RACCOON.authApiPrefix}/login_with_qrcode_code`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('success 时取出 token 并推算 expires_at（毫秒字符串）', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { status: 'success', access_token: jwtWithExp(exp), refresh_token: 'r1' },
    }))
    const result = await pollRaccoonQrLogin(RACCOON, 'c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('success')
    expect(result.accessToken).toBe(jwtWithExp(exp))
    expect(result.refreshToken).toBe('r1')
    expect(result.expiresAt).toBe(String(exp * 1000))
  })

  it('logging 时带出 expired_at（供页面续期计时）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0, data: { status: 'logging', expired_at: '2030-01-01T00:00:00Z' },
    }))
    const result = await pollRaccoonQrLogin(RACCOON, 'c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('logging')
    expect(result.expiredAt).toBe('2030-01-01T00:00:00Z')
  })

  it('网络异常时降级为 pending（不打断轮询）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down') })
    const result = await pollRaccoonQrLogin(RACCOON, 'c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('pending')
  })

  it('未知 status 也降级为 pending（不误判成成功）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'weird' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('pending')
  })

  it('success 但缺 access_token 时不当作成功', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'success' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('pending')
  })

  it('canceled 状态透传', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'canceled' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('canceled')
  })
})

describe('sendRaccoonSmsCode', () => {
  it('加密手机号后提交，带 captcha_param 与 nation_code', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    await sendRaccoonSmsCode(RACCOON, '13800000000', 'captcha-token', fetcher as unknown as typeof fetch)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${RACCOON.apiBase}${RACCOON.authApiPrefix}/send_sms`)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.nation_code).toBe('86')
    expect(body.captcha_param).toBe('captcha-token')
    // 手机号必须是密文（不是明文）
    expect(body.phone).not.toBe('13800000000')
    expect(typeof body.phone).toBe('string')
  })

  it('captcha_verify_error 时抛出可读错误（提示重新过滑块）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { code: 100006, message: 'captcha_verify_error', details: 'captcha verify failed' }, 400,
    ))
    await expect(sendRaccoonSmsCode(RACCOON, '13800000000', 'bad', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/验证码/)
  })
})

describe('loginRaccoonWithSmsCode', () => {
  it('成功后返回完整凭据（含 expires_at）', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { access_token: jwtWithExp(exp), refresh_token: 'r', office_identity: 'personal' },
    }))
    const credential = await loginRaccoonWithSmsCode(
      RACCOON, '13800000000', '123456', fetcher as unknown as typeof fetch,
    )
    expect(credential.access_token).toBe(jwtWithExp(exp))
    expect(credential.refresh_token).toBe('r')
    expect(credential.expires_at).toBe(String(exp * 1000))
    expect(credential.office_identity).toBe('personal')
  })

  it('缺少 access_token 时抛错（不产出半截凭据）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { refresh_token: 'r' } }))
    await expect(loginRaccoonWithSmsCode(RACCOON, '13800000000', '1', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/access_token/)
  })

  it('验证码错误时透传服务端文案', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { code: 100002, message: 'params_invalid_error', details: 'sms code invalid' }, 400,
    ))
    await expect(loginRaccoonWithSmsCode(RACCOON, '13800000000', 'bad', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/sms code invalid/)
  })
})

describe('refreshRaccoonCredential', () => {
  it('用 refresh_token 换新 token，并保留旧凭据的附加字段', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0, data: { access_token: jwtWithExp(exp), refresh_token: 'r2' },
    }))
    const next = await refreshRaccoonCredential(
      RACCOON,
      { access_token: 'old', refresh_token: 'r1', office_identity: 'personal', nickname: 'Ava' },
      fetcher as unknown as typeof fetch,
    )
    expect(next.access_token).toBe(jwtWithExp(exp))
    expect(next.refresh_token).toBe('r2')
    expect(next.expires_at).toBe(String(exp * 1000))
    // 服务端不返回的字段要保留，否则昵称/身份会丢
    expect(next.office_identity).toBe('personal')
    expect(next.nickname).toBe('Ava')
  })

  it('服务端未返回新 refresh_token 时保留旧的', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { access_token: jwtWithExp(exp) } }))
    const next = await refreshRaccoonCredential(
      RACCOON, { access_token: 'old', refresh_token: 'r1' }, fetcher as unknown as typeof fetch,
    )
    expect(next.refresh_token).toBe('r1')
  })

  it('401 时抛出「请重新登录」（不重试）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 200003, message: 'authorization_verify_error' }, 401))
    await expect(refreshRaccoonCredential(
      RACCOON, { access_token: 'old', refresh_token: 'r1' }, fetcher as unknown as typeof fetch,
    )).rejects.toThrow(/重新登录/)
  })
})

describe('exchangeRaccoonAuthorizationCode', () => {
  it('用授权码换凭据（官方桌面端链路，供将来复用）', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { access_token: jwtWithExp(exp), refresh_token: 'r', office_identity: 'personal' },
    }))
    const credential = await exchangeRaccoonAuthorizationCode(
      RACCOON, 'auth-code', fetcher as unknown as typeof fetch,
    )
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${RACCOON.apiBase}${RACCOON.authApiPrefix}/login_with_authorization_code`)
    expect(JSON.parse(String(init.body))).toEqual({ authorization_code: 'auth-code' })
    expect(credential.access_token).toBe(jwtWithExp(exp))
  })

  it('授权码失效（200035）时给出可操作提示', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 200035, message: 'not found' }, 400))
    await expect(exchangeRaccoonAuthorizationCode(
      RACCOON, 'stale', fetcher as unknown as typeof fetch,
    )).rejects.toThrow(/授权码已失效/)
  })
})

describe('fetchRaccoonUserInfo', () => {
  it('取出用户 id、昵称与身份', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { id: '7445120', name: 'RaccoonAva', office_identity: 'personal' },
    }))
    const info = await fetchRaccoonUserInfo(
      RACCOON, { access_token: 't', refresh_token: 'r' }, fetcher as unknown as typeof fetch,
    )
    expect(info.userId).toBe('7445120')
    expect(info.nickname).toBe('RaccoonAva')
    expect(info.officeIdentity).toBe('personal')
  })

  it('失败时返回空对象（用户信息是展示用，不该让登录失败）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 1, message: 'err' }, 500))
    const info = await fetchRaccoonUserInfo(
      RACCOON, { access_token: 't', refresh_token: 'r' }, fetcher as unknown as typeof fetch,
    )
    expect(info).toEqual({})
  })

  it('网络异常时也返回空对象', async () => {
    const fetcher = vi.fn(async () => { throw new Error('down') })
    const info = await fetchRaccoonUserInfo(
      RACCOON, { access_token: 't', refresh_token: 'r' }, fetcher as unknown as typeof fetch,
    )
    expect(info).toEqual({})
  })
})
