import { afterEach, describe, expect, it, vi } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  RACCOON_LOGIN_PAGE_PATHS,
  renderRaccoonLoginPage,
  startRaccoonLoginFlow,
  type StartedRaccoonLoginFlow,
} from '../../src/raccoon-login-page.js'

let started: StartedRaccoonLoginFlow | undefined
afterEach(async () => {
  if (started) {
    await started.close()
    started = undefined
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 从 loginUrl 取出 origin（路径常量自带 `/raccoon` 前缀，故只需 origin）。 */
function originOf(loginUrl: string): string {
  return loginUrl.replace(/\/raccoon\/login$/, '')
}

/** 造一个最小 JWT。 */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `${header}.${body}.sig`
}

describe('RACCOON_LOGIN_PAGE_PATHS', () => {
  it('四条路径都是 /raccoon 前缀', () => {
    for (const p of Object.values(RACCOON_LOGIN_PAGE_PATHS)) {
      expect(p.startsWith('/raccoon/')).toBe(true)
    }
  })
})

describe('renderRaccoonLoginPage', () => {
  const html = renderRaccoonLoginPage(RACCOON)

  it('是完整 HTML 文档', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('</html>')
    expect(html).toContain('charset="utf-8"')
  })

  it('有两个 Tab：微信扫码与短信登录', () => {
    expect(html).toContain('微信扫码')
    expect(html).toContain('短信登录')
  })

  it('有合法的内联二维码（**必须是可解析的 SVG**，不是被转义的字符串）', () => {
    // ⚠️ 真实缺陷回归（用户报障「弹出页面二维码没显示出来」）：
    // 早期实现把 SVG 的引号转义成 `&quot;` 再内联，
    // 于是浏览器把它当作文本节点而**不渲染**二维码。
    //
    // ⚠️ 旧断言是 `toContain('viewBox')` —— 那个在**有 bug 时也会通过**
    // （`viewBox=&quot;0 0 …&quot;` 同样含子串 `viewBox`），
    // 所以缺陷没被任何用例抓住。新断言要求：
    //   1. 属性引号是**真引号**（未转义）；
    //   2. 是完整的 `<svg …>` 标签（属性顺序/形态可解析）。
    expect(html).not.toContain('&quot;')
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(html).toContain('viewBox="0 0 ')
    expect(html).toContain('</svg>')
    // SVG 必须落在二维码容器内（而不是散落在页面别处）
    const container = /<div class="qr" id="qrBox">([\s\S]*?)<\/div>/.exec(html)
    expect(container).not.toBeNull()
    expect(container?.[1]).toContain('<svg')
    expect(container?.[1]).toContain('</svg>')
  })

  it('内联二维码的 path 非空（真的画了模块，不是空图）', () => {
    const container = /<div class="qr" id="qrBox">([\s\S]*?)<\/div>/.exec(html)
    const svg = container?.[1] ?? ''
    const d = /<path d="([^"]*)"/.exec(svg)
    expect(d).not.toBeNull()
    // 每个深色模块一段 `M{x},{y}h1v1h-1z`
    const segments = (d?.[1] ?? '').split('M').length - 1
    expect(segments).toBeGreaterThan(100)
  })

  it('不引用任何外部 QR 库（二维码是宿主机自绘的）', () => {
    expect(html).not.toMatch(/cdn[^"']*qrcode/i)
    expect(html).not.toMatch(/unpkg\.com|jsdelivr\.net/)
  })

  it('加载阿里云验证码脚本（短信路径必需）', () => {
    expect(html).toContain('AliyunCaptcha.js')
    expect(html).toContain(RACCOON.aliyunCaptcha.sceneId)
    expect(html).toContain(RACCOON.aliyunCaptcha.prefix)
  })

  it('页面不含任何密钥或 token（职责边界：宿主侧持有敏感状态）', () => {
    expect(html).not.toContain(RACCOON.phoneCipherSecret)
    expect(html).not.toContain('access_token')
    expect(html).not.toContain('refresh_token')
  })

  it('轮询间隔与客户端一致（2 秒）', () => {
    expect(html).toContain('2000')
  })

  it('登录 URL 不硬编码进页面（由宿主侧按会话生成）', () => {
    // 页面只需展示二维码；URL 内容属于宿主侧会话状态
    expect(html).not.toContain('login/mp?code=')
  })
})

describe('startRaccoonLoginFlow', () => {
  it('立即返回指向 127.0.0.1 的 loginUrl（两步式的硬约束）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    expect(started.loginUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/raccoon\/login$/)
  })

  it('loginUrl 立即可访问，且返回 HTML', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const response = await fetch(started.loginUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('微信扫码')
  })

  it('只绑 127.0.0.1，不对外暴露', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    expect(started.loginUrl).toContain('127.0.0.1')
    expect(started.loginUrl).not.toContain('0.0.0.0')
  })

  it('轮询端点返回 pending（尚未扫码）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'pending' })
  })

  it('扫码成功时 result promise 解析出凭据', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = jwtWithExp(exp)
    let polls = 0
    const fetcher = vi.fn(async () => {
      polls += 1
      return polls < 2
        ? jsonResponse({ code: 0, data: { status: 'pending' } })
        : jsonResponse({ code: 0, data: { status: 'success', access_token: token, refresh_token: 'r' } })
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    const credential = await started.result
    expect(credential.access_token).toBe(token)
    expect(credential.refresh_token).toBe('r')
    expect(credential.expires_at).toBe(String(exp * 1000))
  })

  it('close() 后端口关闭（不再可访问）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    const flow = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const url = flow.loginUrl
    await flow.close()
    await expect(fetch(url)).rejects.toThrow()
  })

  it('close() 后 result 被 reject（不留悬挂 promise）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    const flow = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const pending = flow.result.catch((e: unknown) => e)
    await flow.close()
    const error = await pending
    expect(error).toBeInstanceOf(Error)
  })

  it('超时后 result 被 reject', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({
      fetcher: fetcher as unknown as typeof fetch,
      timeoutMs: 60,
    })
    const error = await started.result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(/超时/)
  })

  it('短信发送端点拒绝空手机号', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '' }),
    })
    expect(response.status).toBe(400)
  })

  it('短信发送端点成功时调用 send_sms（手机号在宿主侧加密）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'cap' }),
    })
    expect(response.status).toBe(200)
    const call = fetcher.mock.calls.find((c) => String(c[0]).includes('/send_sms'))
    expect(call).toBeDefined()
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>
    expect(body.phone).not.toBe('13800000000')
    expect(body.captcha_param).toBe('cap')
    expect(body.nation_code).toBe('86')
  })

  it('短信发送失败时返回可读原因且不终止流程', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { code: 100006, message: 'captcha_verify_error' }, 400,
    ))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'bad' }),
    })
    const payload = await response.json() as { ok: boolean; message?: string }
    expect(payload.ok).toBe(false)
    expect(String(payload.message)).toMatch(/验证码/)
  })

  it('短信验证端点成功后 result 解析出凭据', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = jwtWithExp(exp)
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/send_sms')) return jsonResponse({ code: 0, message: 'success' })
      return jsonResponse({
        code: 0,
        data: { access_token: token, refresh_token: 'r', office_identity: 'personal' },
      })
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'cap' }),
    })
    const response = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '123456' }),
    })
    expect((await response.json() as { ok: boolean }).ok).toBe(true)
    const credential = await started.result
    expect(credential.access_token).toBe(token)
    expect(credential.office_identity).toBe('personal')
  })

  it('未发过短信就提交验证码时返回可读错误', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '123456' }),
    })
    const payload = await response.json() as { ok: boolean; message?: string }
    expect(payload.ok).toBe(false)
    expect(String(payload.message)).toMatch(/手机验证码/)
  })

  it('验证码错误时不终止流程（用户可重试）', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/send_sms')) return jsonResponse({ code: 0, message: 'success' })
      return jsonResponse({ code: 100002, message: 'sms code invalid' }, 400)
    })
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsSend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800000000', captchaParam: 'cap' }),
    })
    const first = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '000000' }),
    })
    expect((await first.json() as { ok: boolean }).ok).toBe(false)
    // 再来一次仍应正常处理（未被上一次失败弄坏）
    const second = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.smsVerify}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: '000001' }),
    })
    expect(second.status).toBe(200)
  })

  it('未知路径返回 404', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { status: 'pending' } }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetch(`${base}/raccoon/nope`)
    expect(response.status).toBe(404)
  })

  it('轮询端点把二维码状态透传给页面（logging/canceled）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0, data: { status: 'logging', expired_at: '2030-01-01T00:00:00Z' },
    }))
    started = await startRaccoonLoginFlow({ fetcher: fetcher as unknown as typeof fetch })
    const base = originOf(started.loginUrl)
    const response = await fetch(`${base}${RACCOON_LOGIN_PAGE_PATHS.poll}`)
    const payload = await response.json() as { status: string; expiredAt?: string }
    expect(payload.status).toBe('logging')
    expect(payload.expiredAt).toBe('2030-01-01T00:00:00Z')
  })
})
