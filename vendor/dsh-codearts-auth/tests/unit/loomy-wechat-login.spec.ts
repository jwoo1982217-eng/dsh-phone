import { describe, expect, it, vi } from 'vitest'
import { LOOMY } from '../../src/loomy-product.js'
import {
  LOOMY_WECHAT_COMPLETE_PATH,
  LOOMY_WECHAT_POLL_PATH,
  LOOMY_WECHAT_QR_PATH,
  resolveOpenCommand,
  startLoomyWechatLoginFlow,
} from '../../src/loomy-wechat-login.js'

/**
 * 微信登录流程的**集成**测试：真的起本地服务器、真的发 HTTP 请求。
 *
 * 不 mock http 层 —— 该流程的价值就在于「本地服务器 + 弹窗页 + 轮询」的编排，
 * mock 掉它等于什么都没测。
 *
 * 只 mock 对**外网**的 fetch（微信与讯飞账号端点）。
 */

/** 造一个成功信封响应。 */
function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: '000000', desc: '成功', trace_id: 't', data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** 授权页 HTML（内嵌 uuid，与实测结构一致）。 */
const AUTH_HTML = '<img class="js_qrcode_img" src="/connect/qrcode/TESTUUID12345"/>'

/** 最小 JPEG（魔数 + 填充）。 */
function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(600).fill(0)])
}

/**
 * 造一个按 URL 分派的 fetch 替身。
 *
 * @param overrides - 覆盖特定 URL 片段的行为（如让 bind/auth 返回 bind=0）。
 */
function makeFetcher(overrides: {
  bind?: 0 | 1
  wechatCode?: string
  authError?: string
} = {}) {
  const bind = overrides.bind ?? 1
  const wechatCode = overrides.wechatCode ?? 'WXCODE1'
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    // 1. 微信授权页 → HTML 含 uuid
    if (url.includes('open.weixin.qq.com/connect/qrconnect')) {
      return new Response(AUTH_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    // 2. 二维码图片 → JPEG
    if (url.includes('/connect/qrcode/')) {
      return new Response(jpegBytes(), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    // 3. 长轮询 → 直接返回「已确认 + code」
    //    ⚠️ 必须是 **405**（官方 JS 里 405 = 已确认、带 wx_code）。
    //    早期这里错写成 404，与实现一起把 bug 编码进了测试 —— 两者同时错，
    //    测试因此全绿却掩盖了「扫码后卡在已确认」的真实缺陷。
    if (url.includes('long.open.weixin.qq.com')) {
      return new Response(`window.wx_errcode=405;window.wx_code='${wechatCode}';`, { status: 200 })
    }
    // 4. 讯飞账号端点
    if (url.includes('/login/thirdAccount/bind/auth')) {
      if (overrides.authError !== undefined) {
        return new Response(JSON.stringify({
          code: '020002', desc: overrides.authError, trace_id: 't', data: {},
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return ok({ bind, rcode: 'RC-1', nickname: '微信昵称' })
    }
    if (url.includes('/login/thirdAccount/bind/skip')) {
      return ok({ session: 'S'.repeat(32), userid: 'u-skip' })
    }
    if (url.includes('/login/thirdAccount/bind/sendMsg')) {
      return ok({ msgid: 'MSG-1' })
    }
    if (url.includes('/login/thirdAccount/bind/checkCode')) {
      return ok({ session: 'S'.repeat(32), userid: 'u-bind', phone: '13011112222' })
    }
    if (url.includes('/points/first-login')) {
      return ok({ alreadyProcessed: true })
    }
    throw new Error(`未预期的请求：${url}${init?.method ? ` [${init.method}]` : ''}`)
  })
}

/** 从 loginUrl 取出端口。 */
function portOf(loginUrl: string): string {
  return new URL(loginUrl).port
}

describe('startLoomyWechatLoginFlow', () => {
  it('返回本地 loginUrl，且弹窗页内联二维码（data URL）', async () => {
    const fetcher = makeFetcher()
    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: fetcher as unknown as typeof fetch,
    })
    try {
      expect(flow.loginUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/wechat\/qr$/)

      const page = await fetch(flow.loginUrl)
      expect(page.status).toBe(200)
      const html = await page.text()
      // 二维码内联，不是外链
      expect(html).toContain('data:image/jpeg;base64,')
      expect(html).not.toContain('src="https://open.weixin.qq.com/connect/qrcode')
      // 页面自带轮询与提交逻辑
      expect(html).toContain(LOOMY_WECHAT_POLL_PATH)
      expect(html).toContain(LOOMY_WECHAT_COMPLETE_PATH)
      // 首次绑定的手机号表单存在（默认隐藏）
      expect(html).toContain('id="phoneForm"')
    } finally {
      await flow.close()
    }
  })

  it('bind=1（微信已绑手机号）：轮询直接完成登录', async () => {
    const fetcher = makeFetcher({ bind: 1 })
    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: fetcher as unknown as typeof fetch,
    })
    try {
      const polled = await (await fetch(`http://127.0.0.1:${portOf(flow.loginUrl)}${LOOMY_WECHAT_POLL_PATH}`)).json()
      expect(polled.status).toBe('done')

      const result = await flow.result
      expect(result.session).toBe('S'.repeat(32))
      expect(result.userid).toBe('u-skip')
      expect(result.nickname).toBe('微信昵称')
    } finally {
      await flow.close()
    }
  })

  it('bind=0（首次扫码）：轮询返回 need_phone，随后提交手机号+验证码完成', async () => {
    const fetcher = makeFetcher({ bind: 0 })
    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: fetcher as unknown as typeof fetch,
    })
    try {
      const base = `http://127.0.0.1:${portOf(flow.loginUrl)}`
      const polled = await (await fetch(`${base}${LOOMY_WECHAT_POLL_PATH}`)).json()
      expect(polled.status).toBe('need_phone')

      // 发验证码
      const sent = await (await fetch(`${base}${LOOMY_WECHAT_COMPLETE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send_sms', phone: '13011112222' }),
      })).json()
      expect(sent.ok).toBe(true)

      // 提交验证码
      const verified = await (await fetch(`${base}${LOOMY_WECHAT_COMPLETE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_sms', phone: '13011112222', code: '123456' }),
      })).json()
      expect(verified.ok).toBe(true)
      expect(verified.done).toBe(true)

      const result = await flow.result
      expect(result.session).toBe('S'.repeat(32))
      expect(result.userid).toBe('u-bind')
      expect(result.phone).toBe('13011112222')
    } finally {
      await flow.close()
    }
  })

  it('验证码错误时就地报错但**不终止**流程（允许重试）', async () => {
    const fetcher = makeFetcher({ bind: 0 })
    // 让 checkCode 第一次失败、第二次成功
    let attempts = 0
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('bind/checkCode')) {
        attempts += 1
        if (attempts === 1) {
          return new Response(JSON.stringify({
            code: '020002', desc: '验证码错误，请重新输入', trace_id: 't', data: {},
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
      }
      return original(input, init)
    })

    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: fetcher as unknown as typeof fetch,
    })
    try {
      const base = `http://127.0.0.1:${portOf(flow.loginUrl)}`
      await fetch(`${base}${LOOMY_WECHAT_POLL_PATH}`) // 触发 need_phone

      const bad = await (await fetch(`${base}${LOOMY_WECHAT_COMPLETE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_sms', phone: '13011112222', code: '000000' }),
      })).json()
      expect(bad.ok).toBe(false)
      expect(bad.message).toMatch(/验证码错误/)

      // 流程未终止：重试成功
      const good = await (await fetch(`${base}${LOOMY_WECHAT_COMPLETE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_sms', phone: '13011112222', code: '123456' }),
      })).json()
      expect(good.done).toBe(true)
      await expect(flow.result).resolves.toBeDefined()
    } finally {
      await flow.close()
    }
  })

  it('微信授权失败时轮询返回 error 且 result 被 reject', async () => {
    const fetcher = makeFetcher({ authError: '微信授权已失效' })
    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: fetcher as unknown as typeof fetch,
    })
    try {
      const base = `http://127.0.0.1:${portOf(flow.loginUrl)}`
      const polled = await (await fetch(`${base}${LOOMY_WECHAT_POLL_PATH}`)).json()
      expect(polled.status).toBe('error')
      expect(polled.message).toMatch(/微信授权已失效/)
      await expect(flow.result).rejects.toThrow(/微信授权已失效/)
    } finally {
      await flow.close()
    }
  })

  it('未知路径返回 404', async () => {
    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: makeFetcher() as unknown as typeof fetch,
    })
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(flow.loginUrl)}/nope`)
      expect(res.status).toBe(404)
    } finally {
      await flow.close()
    }
  })

  it('close() 后端口不再可访问（不泄漏监听）', async () => {
    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: makeFetcher() as unknown as typeof fetch,
    })
    const url = flow.loginUrl
    await flow.close()
    await expect(fetch(url)).rejects.toThrow()
  })

  it('close() 幂等（重复调用不抛）', async () => {
    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY, fetcher: makeFetcher() as unknown as typeof fetch,
    })
    await flow.close()
    await expect(flow.close()).resolves.toBeUndefined()
  })

  it('超时后 result 被 reject（不永久挂起）', async () => {
    // 长轮询永远返回「待扫码」
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('qrconnect')) {
        return new Response(AUTH_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.includes('/connect/qrcode/')) {
        return new Response(jpegBytes(), { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      if (url.includes('long.open.weixin.qq.com')) {
        return new Response("window.wx_errcode=408;window.wx_code='';", { status: 200 })
      }
      throw new Error(`未预期：${url}`)
    })

    const flow = await startLoomyWechatLoginFlow({
      product: LOOMY,
      fetcher: fetcher as unknown as typeof fetch,
      timeoutMs: 300,
    })
    try {
      await expect(flow.result).rejects.toThrow(/超时/)
    } finally {
      await flow.close()
    }
  })
})

/**
 * ⚠️ **真实缺陷**（用户报障「现在不时弹出 http://127.0.0.1:1/never」）：
 *
 * 早期这里有个 `defaultOpenBrowser`，单测写成
 * `expect(() => defaultOpenBrowser('http://127.0.0.1:1/never')).not.toThrow()`
 * 并注释「不真的打开」—— **那是错的**：它内部用
 * `import('node:child_process').then(...)` **异步 spawn**，所以
 * `not.toThrow()` 必然通过（同步阶段确实不抛），但**浏览器真的被拉起来了**。
 * 每跑一次测试就弹一次。
 *
 * 修法有两层：① 删掉那个函数（本流程走两步式，由前端 `window.open`，
 * 宿主侧**根本不该**开浏览器）；② 只保留纯函数 `resolveOpenCommand`
 * 供平台分派验证，**永不 spawn**。
 */
describe('resolveOpenCommand（纯函数，不 spawn 进程）', () => {
  it('Windows 用 cmd /c start ""（空标题参数必需，否则 URL 会被当标题）', () => {
    expect(resolveOpenCommand('win32')).toEqual({ command: 'cmd', args: ['/c', 'start', ''] })
  })

  it('macOS 用 open', () => {
    expect(resolveOpenCommand('darwin')).toEqual({ command: 'open', args: [] })
  })

  it('其余平台用 xdg-open', () => {
    expect(resolveOpenCommand('linux')).toEqual({ command: 'xdg-open', args: [] })
    expect(resolveOpenCommand('freebsd')).toEqual({ command: 'xdg-open', args: [] })
  })

  it('本模块不再导出会 spawn 浏览器的函数（回归）', async () => {
    const mod = await import('../../src/loomy-wechat-login.js')
    expect(mod).not.toHaveProperty('defaultOpenBrowser')
  })
})
