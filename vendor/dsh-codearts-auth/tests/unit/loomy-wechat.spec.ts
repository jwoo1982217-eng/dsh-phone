import { describe, expect, it, vi } from 'vitest'
import {
  LOOMY_WECHAT_APP_ID,
  LOOMY_WECHAT_REDIRECT_URI,
  buildLoomyWechatAuthUrl,
  buildLoomyWechatQrImageUrl,
  extractLoomyWechatUuid,
  fetchLoomyWechatUuid,
  fetchLoomyWechatQrImage,
  pollLoomyWechatOnce,
  LOOMY_WECHAT_POLL_STATUS,
} from '../../src/loomy-wechat.js'

/**
 * 微信扫码的纯函数与协议常量。
 *
 * ⚠️ 全部依据 2026-09-26 的**实测**（`scripts/loomy-probe-wechat-qr.mjs`），
 * 不是照抄官方 Electron 实现 —— 官方靠 BrowserWindow 的 will-redirect
 * 截获 code，那条路在外部浏览器里不存在。
 */
describe('微信扫码常量', () => {
  it('appid 与 redirect_uri 取自客户端 .env.prod', () => {
    expect(LOOMY_WECHAT_APP_ID).toBe('wx18d60be432287cf8')
    expect(LOOMY_WECHAT_REDIRECT_URI).toBe('https://loomy.xunfei.cn/oauth/wechat/callback')
  })

  /**
   * ⚠️ **redirect_uri 必须用官方地址**：实测换成 `127.0.0.1:<port>` 或任意域名，
   * 微信直接返回「redirect_uri 参数错误」（872 字节），官方地址才返回正常授权页
   * （42KB）。微信校验域名白名单，故**不能**用本地回调服务器收 code。
   */
  it('redirect_uri 是官方域名（换别的微信会报参数错误）', () => {
    expect(LOOMY_WECHAT_REDIRECT_URI).toContain('loomy.xunfei.cn')
    expect(LOOMY_WECHAT_REDIRECT_URI).not.toContain('127.0.0.1')
  })
})

describe('buildLoomyWechatAuthUrl', () => {
  it('拼出 qrconnect 授权 URL，含 appid/redirect_uri/scope/state', () => {
    const url = buildLoomyWechatAuthUrl('state-abc')
    expect(url).toContain('https://open.weixin.qq.com/connect/qrconnect')
    expect(url).toContain(`appid=${LOOMY_WECHAT_APP_ID}`)
    expect(url).toContain('scope=snsapi_login')
    expect(url).toContain('state=state-abc')
    // redirect_uri 必须被编码
    expect(url).toContain(encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI))
    expect(url).toContain('#wechat_redirect')
  })
})

describe('extractLoomyWechatUuid', () => {
  /**
   * ⚠️ 实测授权页 HTML **直接内嵌 uuid**，无需执行 JS：
   *   `<img class="js_qrcode_img" src="/connect/qrcode/<uuid>"/>`
   *   `var fordevtool = "https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>"`
   * 两条都能提取，互为兜底。
   */
  it('从 img src 提取 uuid（主路径）', () => {
    const html = '<img class="js_qrcode_img web_qrcode_img" src="/connect/qrcode/0713Y9iC4gqQkl25"/>'
    expect(extractLoomyWechatUuid(html)).toBe('0713Y9iC4gqQkl25')
  })

  it('从 fordevtool 长轮询 URL 提取 uuid（兜底）', () => {
    const html = 'var fordevtool = "https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=001ZDsw64Vu7ll2E"'
    expect(extractLoomyWechatUuid(html)).toBe('001ZDsw64Vu7ll2E')
  })

  it('uuid 含 = / + / _ / - 等 base64 字符时也认', () => {
    const html = 'src="/connect/qrcode/4Y0N_jyVQg=="'
    expect(extractLoomyWechatUuid(html)).toBe('4Y0N_jyVQg==')
  })

  it('提取不到时返回空串（不抛）', () => {
    expect(extractLoomyWechatUuid('')).toBe('')
    expect(extractLoomyWechatUuid('<html>no uuid here</html>')).toBe('')
    expect(extractLoomyWechatUuid(null as never)).toBe('')
  })
})

describe('buildLoomyWechatQrImageUrl', () => {
  it('拼出二维码图片地址', () => {
    expect(buildLoomyWechatQrImageUrl('ABC123'))
      .toBe('https://open.weixin.qq.com/connect/qrcode/ABC123')
  })
})

describe('fetchLoomyWechatUuid', () => {
  it('GET 授权页并提取 uuid', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      '<img class="js_qrcode_img" src="/connect/qrcode/UUID123"/>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    ))
    const uuid = await fetchLoomyWechatUuid('state-x', fetcher as unknown as typeof fetch)

    expect(uuid).toBe('UUID123')
    const [url] = fetcher.mock.calls[0] as [string]
    expect(url).toContain('open.weixin.qq.com/connect/qrconnect')
  })

  it('提取不到 uuid 时抛错（不返回空串让上层拿去轮询）', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>no uuid</html>', { status: 200 }))
    await expect(fetchLoomyWechatUuid('s', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/uuid/)
  })

  it('HTTP 非 2xx 时抛错', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(fetchLoomyWechatUuid('s', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/500/)
  })
})

describe('fetchLoomyWechatQrImage', () => {
  /**
   * ⚠️ 实测返回的是 **JPEG**（`image/jpeg`，约 47KB），不是 PNG ——
   * 早期只判 PNG 魔数会误报「不是图片」。
   */
  it('返回 data URL，且认 JPEG 魔数', async () => {
    // 最小 JPEG 头
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(600).fill(0)])
    const fetcher = vi.fn().mockResolvedValue(new Response(jpeg, {
      status: 200, headers: { 'content-type': 'image/jpeg' },
    }))
    const dataUrl = await fetchLoomyWechatQrImage('UUID1', fetcher as unknown as typeof fetch)

    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(dataUrl.length).toBeGreaterThan(100)
  })

  it('PNG 也认', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(600).fill(0)])
    const fetcher = vi.fn().mockResolvedValue(new Response(png, {
      status: 200, headers: { 'content-type': 'image/png' },
    }))
    expect(await fetchLoomyWechatQrImage('U', fetcher as unknown as typeof fetch))
      .toMatch(/^data:image\/png;base64,/)
  })

  it('非图片内容抛错（避免把 HTML 错误页当二维码渲染）', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>err</html>', { status: 200 }))
    await expect(fetchLoomyWechatQrImage('U', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/不是图片/)
  })
})

/**
 * 长轮询状态机。
 *
 * ⚠️ 语义**以微信授权页内嵌的官方 JS 为准**（`switch(window.wx_errcode)`）：
 *
 * ```js
 * case 405:  // 已确认 → 用 wx_code 拼回调 URL 跳转
 *   t += "?…&code=" + wx_code
 * case 404:  // 已扫码**待确认** → 显示 js_wx_after_scan，**继续轮询**
 * case 403:  // 用户取消
 * case 402:  // 二维码失效 → 刷新
 * case 408:  // 待扫码 → 继续轮询
 * ```
 *
 * ⚠️ **真实缺陷**（用户报障「扫码后显示已扫码，但没有后续跳转」）：
 * 早期实现把 **404 当「已确认」、405 当「待确认」**，恰好**读反**。
 * 而当时的单测也照错写（断言 `404 → confirmed`）—— **测试把 bug 一起编码了**，
 * 所以全绿却掩盖了缺陷。本组用例现在严格对齐官方 JS。
 */
describe('pollLoomyWechatOnce', () => {
  function pollResponse(body: string): Response {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } })
  }

  it('408 → waiting（待扫码）', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=408;window.wx_code='';"))
    const result = await pollLoomyWechatOnce('U', '', fetcher as unknown as typeof fetch)
    expect(result.status).toBe(LOOMY_WECHAT_POLL_STATUS.waiting)
  })

  /** ⚠️ 404 = 已扫码**待确认**（官方 JS 显示 js_wx_after_scan 并继续轮询）。 */
  it('404 → scanned（已扫码待确认，继续轮询）', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=404;window.wx_code='';"))
    const result = await pollLoomyWechatOnce('U', '408', fetcher as unknown as typeof fetch)
    expect(result.status).toBe(LOOMY_WECHAT_POLL_STATUS.scanned)
  })

  /** ⚠️ 405 = **已确认**（官方 JS 在此分支用 wx_code 拼回调 URL）。 */
  it('405 → confirmed，并带回 wx_code', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=405;window.wx_code='CODE123';"))
    const result = await pollLoomyWechatOnce('U', '404', fetcher as unknown as typeof fetch)
    expect(result.status).toBe(LOOMY_WECHAT_POLL_STATUS.confirmed)
    expect(result.code).toBe('CODE123')
  })

  it('403 → cancelled（用户取消）', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=403;window.wx_code='';"))
    const result = await pollLoomyWechatOnce('U', '408', fetcher as unknown as typeof fetch)
    expect(result.status).toBe(LOOMY_WECHAT_POLL_STATUS.cancelled)
  })

  it('402 → expired（二维码失效）', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=402;window.wx_code='';"))
    const result = await pollLoomyWechatOnce('U', '408', fetcher as unknown as typeof fetch)
    expect(result.status).toBe(LOOMY_WECHAT_POLL_STATUS.expired)
  })

  it('未知 errcode 归为 waiting（保守，不误判成功）', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=999;window.wx_code='';"))
    const result = await pollLoomyWechatOnce('U', '', fetcher as unknown as typeof fetch)
    expect(result.status).toBe(LOOMY_WECHAT_POLL_STATUS.waiting)
  })

  /**
   * ⚠️ 405 却没带 code 属异常形态：保守判 scanned（继续轮询），
   * **绝不**拿空 code 去换 session。
   */
  it('405 但 wx_code 为空时**不**判成功', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=405;window.wx_code='';"))
    const result = await pollLoomyWechatOnce('U', '404', fetcher as unknown as typeof fetch)
    expect(result.status).not.toBe(LOOMY_WECHAT_POLL_STATUS.confirmed)
    expect(result.code).toBe('')
  })

  /**
   * ⚠️ **反向验证**：404 **不得**被判成 confirmed。
   *
   * 这正是原始缺陷的形态 —— 用户确认后微信回 405，而旧实现按 404 分支
   * 去等「带 code 的 404」，永远等不到，卡在「已扫码」。
   */
  it('404 绝不能被判成 confirmed（原始缺陷形态）', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=404;window.wx_code='';"))
    const result = await pollLoomyWechatOnce('U', '408', fetcher as unknown as typeof fetch)
    expect(result.status).not.toBe(LOOMY_WECHAT_POLL_STATUS.confirmed)
  })

  it('带 last 参数时拼进 URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(pollResponse("window.wx_errcode=408;window.wx_code='';"))
    await pollLoomyWechatOnce('U', '404', fetcher as unknown as typeof fetch)
    const [url] = fetcher.mock.calls[0] as [string]
    expect(url).toContain('last=404')
  })

  it('网络异常返回 error 状态（不抛，让轮询循环继续）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const result = await pollLoomyWechatOnce('U', '', fetcher as unknown as typeof fetch)
    expect(result.status).toBe(LOOMY_WECHAT_POLL_STATUS.error)
  })
})
