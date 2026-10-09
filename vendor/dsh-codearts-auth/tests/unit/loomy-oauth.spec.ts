import { describe, expect, it, vi } from 'vitest'
import { LOOMY } from '../../src/loomy-product.js'
import {
  LOOMY_SESSION_TTL_SECONDS,
  bindLoomyCheckCode,
  bindLoomySendMsg,
  bindLoomySkip,
  bindLoomyThirdAccount,
  buildLoomyAccountBody,
  loginLoomyBySmsCode,
  sendLoomySmsCode,
} from '../../src/loomy-oauth.js'

/** 造一个成功信封响应。 */
function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: '000000', desc: '成功', trace_id: 't', data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** 造一个业务错误信封（HTTP 仍是 200）。 */
function bizError(code: string, desc: string): Response {
  return new Response(JSON.stringify({ code, desc, trace_id: 't', data: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

describe('buildLoomyAccountBody：账号请求体信封', () => {
  /**
   * 依据 `account-service.js:441-450` 的 `_makeBase()`。
   * ⚠️ `ua` 硬编码 macOS —— **Windows 上也是这个值**，照抄不要「修正」。
   */
  it('base 字段与客户端逐项一致', () => {
    const body = buildLoomyAccountBody(LOOMY, { phone: '13011112222' })
    const base = body.base as Record<string, unknown>
    expect(base.appid).toBe('GM3LOOMY')
    expect(base.modelid).toBe('Web')
    expect(base.version).toBe('1.0.0')
    expect(base.devid).toBe('web')
    expect(base.ua).toBe('Loomy|Desktop|Electron|macOS')
    // traceid 是 32 位 hex（去掉连字符的 uuid）
    expect(String(base.traceid)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('param 原样放进 body.param', () => {
    const body = buildLoomyAccountBody(LOOMY, { phone: '13011112222', ccode: '86' })
    expect(body.param).toEqual({ phone: '13011112222', ccode: '86' })
  })

  it('每次调用的 traceid 都不同', () => {
    const a = buildLoomyAccountBody(LOOMY, {})
    const b = buildLoomyAccountBody(LOOMY, {})
    expect((a.base as Record<string, unknown>).traceid)
      .not.toBe((b.base as Record<string, unknown>).traceid)
  })
})

describe('sendLoomySmsCode', () => {
  it('POST 到 /login/phone/sendMsgCode 并返回 msgid', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ msgid: 'MSG-1' }))
    const msgid = await sendLoomySmsCode('13011112222', LOOMY, fetcher as unknown as typeof fetch)

    expect(msgid).toBe('MSG-1')
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://account.xfinfr.com/login/phone/sendMsgCode')
    expect(init.method).toBe('POST')
    // 认证头前缀必须是 account
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^account /)
    // body 里 expire 是 300 秒
    const sent = JSON.parse(String(init.body)) as { param: Record<string, unknown> }
    expect(sent.param.phone).toBe('13011112222')
    expect(sent.param.ccode).toBe('86')
    expect(sent.param.expire).toBe(300)
  })

  it('响应缺 msgid 时抛错（不能返回空串让上层拿去登录）', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({}))
    await expect(sendLoomySmsCode('13011112222', LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/msgid/)
  })

  it('业务错误码抛错并带上服务端 desc', async () => {
    const fetcher = vi.fn().mockResolvedValue(bizError('020002', '手机号格式不正确'))
    await expect(sendLoomySmsCode('13011112222', LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/手机号格式不正确/)
  })
})

describe('loginLoomyBySmsCode', () => {
  it('POST 到 /login/phone/checkCode 并返回 session/userid', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ session: 'S'.repeat(32), userid: '260924225226937524' }))
    const result = await loginLoomyBySmsCode(
      '13011112222', '123456', 'MSG-1', LOOMY, fetcher as unknown as typeof fetch,
    )

    expect(result.session).toBe('S'.repeat(32))
    expect(result.userid).toBe('260924225226937524')
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://account.xfinfr.com/login/phone/checkCode')
    const sent = JSON.parse(String(init.body)) as { param: Record<string, unknown> }
    expect(sent.param.mcode).toBe('123456')
    expect(sent.param.msgid).toBe('MSG-1')
    // 14 天有效期（1209600 秒）
    expect(sent.param.expire).toBe(LOOMY_SESSION_TTL_SECONDS)
  })

  it('缺 session 或 userid 时抛错', async () => {
    const noSession = vi.fn().mockResolvedValue(ok({ userid: 'u' }))
    await expect(loginLoomyBySmsCode('1', '2', '3', LOOMY, noSession as unknown as typeof fetch))
      .rejects.toThrow(/session/)

    const noUser = vi.fn().mockResolvedValue(ok({ session: 's' }))
    await expect(loginLoomyBySmsCode('1', '2', '3', LOOMY, noUser as unknown as typeof fetch))
      .rejects.toThrow(/userid/)
  })

  it('验证码错误时抛错并带服务端文案', async () => {
    const fetcher = vi.fn().mockResolvedValue(bizError('020002', '验证码错误，请重新输入'))
    await expect(loginLoomyBySmsCode('1', '2', '3', LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/验证码错误/)
  })
})

/**
 * 微信扫码登录的账号端点（四步强制绑手机号流程）。
 *
 * 依据 `account-service.js:429-519`（注释直接引讯飞文档 §3.2.7）：
 *   1. bindAuthThirdAccount(code) → { bind, rcode, isnew, nickname, headpic }
 *        bind=1 已绑手机号 → bindSkip 拿 session
 *        bind=0 未绑     → bindSendMsg + bindCheckCode
 *   注：微信 code 只在 bindAuth 用一次；后续接口只用 rcode。
 */
describe('bindLoomyThirdAccount', () => {
  it('POST /login/thirdAccount/bind/auth，带 tcode.code 与 type=wx', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      bind: 1, rcode: 'RC-1', isnew: 0, nickname: '小明', headpic: 'http://x/y.png',
    }))
    const result = await bindLoomyThirdAccount('WXCODE', LOOMY, fetcher as unknown as typeof fetch)

    expect(result.bind).toBe(1)
    expect(result.rcode).toBe('RC-1')
    expect(result.nickname).toBe('小明')

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://account.xfinfr.com/login/thirdAccount/bind/auth')
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^account /)
    const sent = JSON.parse(String(init.body)) as { param: Record<string, unknown> }
    expect(sent.param.tcode).toEqual({ code: 'WXCODE' })
    expect(sent.param.type).toBe('wx')
  })

  it('bind=0（未绑手机号）也能正常返回', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ bind: 0, rcode: 'RC-2' }))
    const result = await bindLoomyThirdAccount('C', LOOMY, fetcher as unknown as typeof fetch)
    expect(result.bind).toBe(0)
    expect(result.rcode).toBe('RC-2')
  })

  it('缺 rcode 时抛错（后续步骤全靠它）', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ bind: 1 }))
    await expect(bindLoomyThirdAccount('C', LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/rcode/)
  })

  it('bind 字段缺失时归为 0（保守：走绑定流程而不是跳过）', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ rcode: 'RC' }))
    const result = await bindLoomyThirdAccount('C', LOOMY, fetcher as unknown as typeof fetch)
    expect(result.bind).toBe(0)
  })
})

describe('bindLoomySendMsg / bindLoomyCheckCode / bindLoomySkip', () => {
  it('bindSendMsg 带 rcode + phone，expire 为 300', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ msgid: 'MSG-9' }))
    const msgid = await bindLoomySendMsg('RC-1', '13011112222', LOOMY, fetcher as unknown as typeof fetch)

    expect(msgid).toBe('MSG-9')
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://account.xfinfr.com/login/thirdAccount/bind/sendMsg')
    const sent = JSON.parse(String(init.body)) as { param: Record<string, unknown> }
    expect(sent.param.rcode).toBe('RC-1')
    expect(sent.param.phone).toBe('13011112222')
    expect(sent.param.ccode).toBe('86')
    expect(sent.param.expire).toBe(300)
  })

  it('bindSendMsg 缺 msgid 时抛错', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({}))
    await expect(bindLoomySendMsg('RC', '13011112222', LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/msgid/)
  })

  it('bindCheckCode 返回 session/userid/phone，expire 为 14 天', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      session: 'S'.repeat(32), userid: 'u-1', phone: '13011112222',
    }))
    const result = await bindLoomyCheckCode(
      'RC-1', '123456', 'MSG-9', LOOMY, fetcher as unknown as typeof fetch,
    )

    expect(result.session).toBe('S'.repeat(32))
    expect(result.userid).toBe('u-1')
    expect(result.phone).toBe('13011112222')

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://account.xfinfr.com/login/thirdAccount/bind/checkCode')
    const sent = JSON.parse(String(init.body)) as { param: Record<string, unknown> }
    expect(sent.param.mcode).toBe('123456')
    expect(sent.param.msgid).toBe('MSG-9')
    expect(sent.param.expire).toBe(LOOMY_SESSION_TTL_SECONDS)
  })

  it('bindCheckCode 缺 session/userid 时抛错', async () => {
    const noSession = vi.fn().mockResolvedValue(ok({ userid: 'u' }))
    await expect(bindLoomyCheckCode('R', '1', 'M', LOOMY, noSession as unknown as typeof fetch))
      .rejects.toThrow(/session/)

    const noUser = vi.fn().mockResolvedValue(ok({ session: 's' }))
    await expect(bindLoomyCheckCode('R', '1', 'M', LOOMY, noUser as unknown as typeof fetch))
      .rejects.toThrow(/userid/)
  })

  it('bindSkip 只用 rcode 拿 session/userid', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ session: 'S'.repeat(32), userid: 'u-9' }))
    const result = await bindLoomySkip('RC-1', LOOMY, fetcher as unknown as typeof fetch)

    expect(result.session).toBe('S'.repeat(32))
    expect(result.userid).toBe('u-9')

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://account.xfinfr.com/login/thirdAccount/bind/skip')
    const sent = JSON.parse(String(init.body)) as { param: Record<string, unknown> }
    expect(sent.param.rcode).toBe('RC-1')
    expect(sent.param.expire).toBe(LOOMY_SESSION_TTL_SECONDS)
    // 不该带 code —— 微信 code 只在 bindAuth 用一次
    expect(sent.param.tcode).toBeUndefined()
  })

  it('bindSkip 缺 session 时抛错', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ userid: 'u' }))
    await expect(bindLoomySkip('R', LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/session/)
  })
})
