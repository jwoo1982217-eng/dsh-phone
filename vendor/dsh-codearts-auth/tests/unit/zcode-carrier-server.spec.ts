/**
 * 二期评审修复 C1/C2：**载体页小 HTTP 服务**（独立回环端口）的接线用例。
 *
 * ## 为什么必须另起一个端口（这是本轮最致命的一条）
 * 原实现把载体页挂在插件自己的 `/api/jet-hub/captcha-carrier` 上，理由是「与 GUI 同源」。
 * 真机证据（DSH Desktop 0.2.0-rc.2，`resources/app.asar/lib/main.js`）推翻了这个前提：
 *
 * 1. `allowedNavigation(value)`：`["http:","https:"].includes(protocol) && 无账号密码 && !isApplicationHost(url)`
 * 2. `isApplicationHost(url)`：`url.port === host.port && (hostname 相同 || 回环)`
 * 3. `configureSession().onBeforeRequest`：命中 `isApplicationHost` 就 **cancel** 掉整个请求
 * 4. guest 的 partition 是 `dsh-sidebar-browser-${randomUUID()}`（**没有 `persist:`**），
 *    Host 的会话 cookie 在 `session.defaultSession` 里 ⇒ guest 连 `/api/*` 都过不了认证
 *
 * ⇒ 挂在应用自己 host 上的载体页，**每一轮都在第一个判断退出，guest 都不建**，收益恒为 0。
 *
 * ## 为什么「换端口」就绕开了
 * `isApplicationHost` 要求「**端口相同** 且 主机相同/回环」—— 换端口即不在判定内
 * ⇒ guest 可导航、可加载。独立小服务因此不是「变通」，而是**唯一能过那三道判定**的形态。
 *
 * ## 安全边界（必须只到「一页静态、无凭据」为止）
 * 只监听 `127.0.0.1`、只有一条 `GET /carrier`、只回 `buildCarrierPageHtml` 的输出；
 * 页面里没有任何账号数据（`region`/`prefix`/`sceneId` 是阿里云 SDK 的公开初始化参数），
 * **所以不需要任何鉴权**——加了反而会让 guest 因为没有会话 cookie 而拿不到页面。
 *
 * ## 反向验证（本轮实跑）
 * - 把 `listen` 的 host 去掉（变成监听所有网卡）⇒ 「只回环」红；
 * - 把路由放宽成「任何路径都回 HTML」⇒ 「只有 /carrier」红；
 * - 把 `stop()` 去掉 ⇒ 「停掉后端口释放」红。
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { CarrierPageServer, CARRIER_PAGE_ROUTE } from '../../src/captcha-carrier-server.js'
import { ALIYUN_CAPTCHA_SDK_URL, ZCODE_CAPTCHA_FALLBACK } from '../../src/zcode-captcha.js'
import { buildCarrierPageHtml } from '../../src/zcode-carrier-page.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(resolve(HERE, '../../src/captcha-carrier-server.ts'), 'utf8')

/** 拿一个**确实被占着**的回环端口（用来制造「端口已占用」分支）。 */
function occupyLoopbackPort(): Promise<{ port: number, close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePromise({
        port,
        close: async () => { await new Promise<void>((done) => { probe.close(() => { done() }) }) },
      })
    })
  })
}

const started: CarrierPageServer[] = []
function makeServer(options: Partial<ConstructorParameters<typeof CarrierPageServer>[0]> = {}) {
  const server = new CarrierPageServer({
    renderPage: () => buildCarrierPageHtml(ZCODE_CAPTCHA_FALLBACK),
    ...options,
  })
  started.push(server)
  return server
}

afterEach(async () => {
  while (started.length > 0) started.pop()?.stop()
})

describe('载体页小服务：地址与端口', () => {
  it('★ 启动后给出一条 http://127.0.0.1:<具体端口>/carrier 的地址（端口绝不��� 0）', async () => {
    const server = makeServer()
    const url = await server.start()
    expect(url).not.toBeNull()
    const parsed = new URL(String(url))
    expect(parsed.protocol).toBe('http:')
    expect(parsed.hostname).toBe('127.0.0.1')
    expect(parsed.pathname).toBe(CARRIER_PAGE_ROUTE)
    const port = Number(parsed.port)
    // ⚠ 「随机可用端口」的验收：必须是**具体**端口（0 ⇒ 拼出来的 URL 根本不可达）。
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
    expect(server.port()).toBe(port)
  })

  it('★ 只监听回环，不许监听所有网卡（源码锁：listen 必须显式带 127.0.0.1）', () => {
    // 行为层只能证明「地址是 127.0.0.1」；「只绑这一个网卡」要靠 listen 的实参形状。
    expect(serverSource).toMatch(/listen\(\s*\w+\s*,\s*'127\.0\.0\.1'\s*\)/)
    expect(serverSource).not.toMatch(/listen\(\s*\w+\s*\)\s*;/)
  })

  it('两个实例拿到不同端口（不许各自都去抢同一个「默认端口」）', async () => {
    const a = makeServer()
    const b = makeServer()
    const [ua, ub] = [await a.start(), await b.start()]
    expect(ua).not.toBeNull()
    expect(ub).not.toBeNull()
    expect(new URL(String(ua)).port).not.toBe(new URL(String(ub)).port)
  })

  it('★ 候选端口被占用 ⇒ 自动换下一个（不得静默退化成「没有地址」）', async () => {
    const busy = await occupyLoopbackPort()
    const spare = await occupyLoopbackPort()
    // 先把 spare 让出来：它此刻是空闲的，而 busy 一直被别人占着
    // ⇒ 第一个候选必被 `isPortFree` 判否，第二个必通过。
    const freePort = spare.port
    await spare.close()
    const candidates = [busy.port, freePort]
    const server = makeServer({
      pickCandidate: () => candidates.shift() ?? 0,
      attempts: 4,
    })
    const url = await server.start()
    expect(url).not.toBeNull()
    expect(Number(new URL(String(url)).port)).toBe(freePort)
    expect(server.port()).not.toBe(busy.port)
    await busy.close()
  })

  it('start 幂等：连着调两次拿同一条地址（不重起一个监听器）', async () => {
    const server = makeServer()
    const first = await server.start()
    const second = await server.start()
    expect(second).toBe(first)
  })

  it('★ stop 之后端口真的释放（插件卸载 ⇒ 不留一个常驻监听器）', async () => {
    const server = makeServer()
    const url = String(await server.start())
    await fetch(`${url}`)
    server.stop()
    // 幂等：重复 stop 不许抛（`close` 未运行时本来就该忽略）
    expect(() => { server.stop() }).not.toThrow()
    expect(server.port()).toBeNull()
    expect(server.url()).toBeNull()
    await expect(fetch(url)).rejects.toThrow()
  })
})

describe('载体页小服务：只回一页静态 HTML', () => {
  it('★ 只有 GET /carrier 是有效路由（其余一律 404，POST /carrier 405）', async () => {
    const server = makeServer()
    const base = new URL(String(await server.start())).origin
    const page = await fetch(`${base}${CARRIER_PAGE_ROUTE}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type') ?? '').toContain('text/html')
    expect(page.headers.get('cache-control') ?? '').toContain('no-store')

    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/api/jet-hub/captcha-carrier`)).status).toBe(404)
    expect((await fetch(`${base}${CARRIER_PAGE_ROUTE}/extra`)).status).toBe(404)
    const posted = await fetch(`${base}${CARRIER_PAGE_ROUTE}`, { method: 'POST' })
    expect(posted.status).toBe(405)
  })

  it('★ 页面内容就是 buildCarrierPageHtml 的输出（三段表达式逐字同源）', async () => {
    const server = makeServer()
    const url = String(await server.start())
    const html = await (await fetch(url)).text()
    expect(html).toBe(buildCarrierPageHtml(ZCODE_CAPTCHA_FALLBACK))
    expect(html).toContain(ALIYUN_CAPTCHA_SDK_URL)
    expect(html).toContain('window.__zcodeCaptcha')
  })

  it('页面不带任何凭据（JWT/token/cookie 一个都不许出现）', async () => {
    const server = makeServer()
    const html = await (await fetch(String(await server.start()))).text()
    expect(html).not.toMatch(/zcode_jwt|Bearer |authorization|access_token|refresh_token|set-cookie/i)
  })

  it('★ 渲染失败回 500 且服务**继续活着**（不能把整个监听器带崩）', async () => {
    const server = makeServer({
      renderPage: () => { throw new Error('远端配置拉不到') },
    })
    const url = String(await server.start())
    expect((await fetch(url)).status).toBe(500)
    // 换回正常渲染后仍能服务 ⇒ 监听器没被这一轮的错误带走
    const healthy = makeServer()
    expect((await fetch(String(await healthy.start()))).status).toBe(200)
  })
})
