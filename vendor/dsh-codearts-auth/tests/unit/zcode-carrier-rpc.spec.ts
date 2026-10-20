/**
 * 二期 Task 3：载体页构造器 + `captcha.demand` / `captcha.contribute` 两条 RPC 的接线用例。
 *
 * ## 为什么单列一个文件（本仓库惯例：接线与原语是两类问题）
 * `captcha-supply.spec.ts` 只证明**槽本身**对；「client 真能把 param 送进槽」
 * 「载体页真带上了那三段表达式」只有**走过真实 handler** 才守得住 ——
 * 表达式忘了拼进 HTML、RPC case 写成 `capcha.demand`，原语测试全都还是绿的。
 * 故本文件既经 `registerJetHubRpc` 调 RPC 分发，也直接调载体页那条 GET 路由拿 HTML。
 *
 * ## ★ 本文件最关键的一条看守：param 的「年龄口径」
 * `captcha.contribute` 必须以 **server 到达时刻 − client 报告的 elapsedMs** 记产出时刻。
 * 两个失败方向各不相同，所以两条用例各锁一个：
 * - 只用到达时刻 ⇒ 年龄被**低估**一个跳数 ⇒ 「贡献即超龄」那条红；
 * - 收 client 的绝对时间戳 ⇒ 跨端时钟漂移把时效闸**整个弄废**（快了永不判过期、
 *   慢了一投放就过期，且日志看着像「client 没产」）⇒ 「atMs 再旧也不影响」那条红。
 *
 * ## 反向验证（逐条改坏 src 之后**实测**变红的条目，脚本见本轮报告）
 * ① `captcha.contribute` 不调 `putSuppliedParam` ⇒ 3 条红（含「真把 param 放进供给槽」）；
 * ② 载体页 HTML 去掉 mint 表达式 ⇒ 3 条红（含「三段表达式逐字同源」）；
 * ③ elapsedMs 推算改回「直接用到达时刻」⇒ ★「贡献即超龄」红（只此一条，说明它守得准）；
 * ④ 改成读 client 的绝对时间戳 `atMs` ⇒ ★「atMs 再旧也不参与时效」红（同上，只此一条）；
 * ⑤ 把 `STEALTH_PATCH` 搬进载体页 ⇒ ★「不带反检测补丁」红；
 * ⑥ 载体页配置去掉兜底分支 ⇒ ★「拉不到配置仍返回 200」红；
 * ⑦ ★（评审 I2）`captcha.contribute` 不透传 `interactive` ⇒ ★「交互式告警 + 计数」红；
 * ⑧ ★（评审 C1/C2）`captcha.carrierUrl` 不问 `zcode.carrierPageUrl()` ⇒ ★「转达地址 / null」红。
 *
 * ## ⚠ 本文件里的 param 一律用 `goodParam()` 造（评审 I1 之后）
 * 供给槽的收货口现在真的调 `validateCaptchaParam`（`src/captcha-supply.ts`），
 * 用 `'via-rpc'` 那种短串会被**当场拒收** —— 那些用例就会变成「测的是拒绝路径」。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

import { CAPTCHA_CARRIER_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import {
  captchaSupplyStats,
  PARAM_MAX_AGE_MS,
  resetCaptchaSupply,
  setCaptchaDemand,
  takeFreshParam,
} from '../../src/captcha-supply.js'
import {
  ALIYUN_CAPTCHA_SDK_URL,
  CAPTCHA_CONTAINER_ID,
  ZCODE_CAPTCHA_FALLBACK,
} from '../../src/zcode-captcha.js'
import { buildCarrierPageHtml } from '../../src/zcode-carrier-page.js'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')

/** 过 `validateCaptchaParam` 的 param（收货口有质量闸，见文件头）。 */
function goodParam (tag: string): string {
  const body = JSON.stringify({ certifyId: tag, securityToken: `${tag}-${'t'.repeat(128)}` })
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  if (encoded.length < 200) throw new Error(`假 param 太短（${String(encoded.length)}）`)
  return encoded
}

/** 与被测端点解耦：任何一次 `connection.fetch.register()` 都按 path 收下来。 */
type FetchHandler = (request: Request) => Promise<Response>

function setup (zcodeStub: unknown = {}, warns: string[] = []) {
  const routes = new Map<string, FetchHandler>()
  const ctx = {
    get: (key: string) => key === 'connection'
      ? {
          fetch: {
            register: (route: { path: string; fetch: FetchHandler }) => {
              routes.set(route.path, route.fetch)
            },
          },
        }
      : undefined,
    inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
    logger: { warn: (line: string) => { warns.push(line) }, info: () => {} },
    emit: () => {},
  }
  registerJetHubRpc(
    ctx as never,
    {} as never, // pool：这两条方法不读账号池
    // ⚠️ **位置参数陷阱**（本仓库已复发 6 次）：auth 实例按顺序传，
    // `codearts … minimax` 共 **11** 个占位之后才是 `zcode`。少一个占位，本文件的
    // zcode 桩就落到 `minimax` 形参上，载体页于是永远拿不到远端配置 ——
    // 表现是「配置那条用例假绿/假红」，判据仍是先数占位。
    {} as never, // codearts
    {} as never, // buddy
    {} as never, // workbuddy
    {} as never, // lobsterai
    {} as never, // qoder
    {} as never, // qoderCn
    {} as never, // trae
    {} as never, // cline
    {} as never, // loomy
    {} as never, // raccoon
    {} as never, // minimax
    zcodeStub as never, // zcode
  )

  const rpc = routes.get('/api/jet-hub')
  const carrier = routes.get(CAPTCHA_CARRIER_PATH)
  if (rpc === undefined || carrier === undefined) {
    throw new Error(`endpoint handlers were not registered: ${[...routes.keys()].join(', ')}`)
  }

  /** 走真实 RPC 信封（`handleMethod` 要求带 `payload` 键，返回值是 `{ok,value}`）。 */
  const call = async (method: string, payload: unknown): Promise<Record<string, any>> => {
    const response = await rpc(new Request('http://127.0.0.1/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: Record<string, any> }
    return body.result
  }

  const getCarrier = async (): Promise<Response> =>
    await carrier(new Request(`http://127.0.0.1${CAPTCHA_CARRIER_PATH}`))

  return { call, getCarrier, carrier, routes }
}

describe('captcha.demand / captcha.contribute 两条 RPC', () => {
  // 需求位与槽都是模块级状态：`resetCaptchaSupply` 连 demand 一起复位。
  beforeEach(() => {
    resetCaptchaSupply()
  })

  it('两条方法都真的出现在分派里（本仓库惯例：先锁入口存在）', () => {
    expect(rpcSource).toContain("case 'captcha.demand'")
    expect(rpcSource).toContain("case 'captcha.carrierUrl'")
    expect(rpcSource).toContain("case 'captcha.contribute'")
  })

  it('captcha.demand 默认回 active:false；server 置起需求位后回 true', async () => {
    const { call } = setup()
    expect(await call('captcha.demand', {})).toEqual({ ok: true, value: { active: false } })
    setCaptchaDemand(true)
    expect(await call('captcha.demand', {})).toEqual({ ok: true, value: { active: true } })
  })

  it('★ captcha.contribute 真把 param 放进供给槽（不是收下就丢）', async () => {
    const { call } = setup()
    const result = await call('captcha.contribute', { param: goodParam('via-rpc'), elapsedMs: 0 })
    expect(result).toEqual({ ok: true, value: { accepted: true } })
    expect(takeFreshParam(Date.now())).toBe(goodParam('via-rpc'))
  })

  it('★ 年龄 = 到达时刻 − elapsedMs：贡献进来就已超龄的 param 取不到（防低估年龄）', async () => {
    const { call } = setup()
    await call('captcha.contribute', { param: goodParam('stale-on-arrival'), elapsedMs: PARAM_MAX_AGE_MS })
    // 若 handler 直接把到达时刻当产出时刻（elapsedMs 被吃掉），这里就会拿到 param ⇒ 本条红。
    expect(takeFreshParam(Date.now())).toBeUndefined()
  })

  it('★ 不收 client 的绝对时间戳：payload 里 atMs 再旧也不参与时效（防跨端时钟漂移）', async () => {
    const { call } = setup()
    await call('captcha.contribute', { param: goodParam('skewed-clock'), atMs: 0 })
    // 若 handler 去读 req.atMs 当产出时刻，年龄就成了「1970 年至今」⇒ 本条红。
    expect(takeFreshParam(Date.now())).toBe(goodParam('skewed-clock'))
  })

  it('elapsedMs 非法（负数 / 小数 / 超 5 分钟 / 非数字）一律退回到达时刻且不抛错', async () => {
    for (const bad of [-1000, 1.5, 10 * 60_000, '500', null, undefined]) {
      resetCaptchaSupply()
      const { call } = setup()
      const param = goodParam(`p-${String(bad)}`)
      const result = await call('captcha.contribute', { param, elapsedMs: bad })
      expect(result.ok, `elapsedMs=${String(bad)}`).toBe(true)
      expect(takeFreshParam(Date.now()), `elapsedMs=${String(bad)}`).toBe(param)
    }
  })

  it('空白 param 判 accepted:false、缺 param 不炸（槽本身不收，端点不替它兜脏）', async () => {
    const { call } = setup()
    expect(await call('captcha.contribute', { param: '   ' })).toEqual({ ok: true, value: { accepted: false } })
    expect(await call('captcha.contribute', {})).toEqual({ ok: true, value: { accepted: false } })
    expect(takeFreshParam(Date.now())).toBeUndefined()
  })

  it('★ 评审 I1：SDK 降级产物（长度够但缺 securityToken）判 accepted:false', async () => {
    const { call } = setup()
    const junk = Buffer.from(JSON.stringify({ certifyId: 'x', token: 'short' }), 'utf8').toString('base64')
    expect(await call('captcha.contribute', { param: junk }))
      .toEqual({ ok: true, value: { accepted: false } })
    expect(takeFreshParam(Date.now())).toBeUndefined()
  })

  // ── 评审 I2：interactive 必须能到 host ──

  it('★ 评审 I2：interactive=true 落进供给槽统计（设备信誉预警到得了 host）', async () => {
    const { call } = setup()
    await call('captcha.contribute', { param: goodParam('ia-1'), interactive: true })
    expect(captchaSupplyStats().interactive).toBe(1)
    expect(captchaSupplyStats().pendingInteractive).toBe(true)
    // 非 true 的值一律当「无感通过」（别把读数异常说成有）
    resetCaptchaSupply()
    await call('captcha.contribute', { param: goodParam('ia-2'), interactive: 'yes' })
    expect(captchaSupplyStats().interactive).toBe(0)
  })

  it('★ 评审 I2：交互式贡献要**显式告警**（只有码没有话 = 线上什么都看不见）', async () => {
    const warns: string[] = []
    const { call } = setup({}, warns)
    await call('captcha.contribute', { param: goodParam('ia-3'), interactive: true })
    expect(warns.some((line) => line.includes('交互式验证'))).toBe(true)
  })

  it('被拒的贡献不告警（垃圾 param 报「交互式」是纯噪声）', async () => {
    const warns: string[] = []
    const { call } = setup({}, warns)
    await call('captcha.contribute', { param: '', interactive: true })
    expect(warns.some((line) => line.includes('交互式验证'))).toBe(false)
  })
})

describe('captcha.carrierUrl（评审 C1/C2：导航目标问 server 要）', () => {
  beforeEach(() => {
    resetCaptchaSupply()
  })

  it('★ 原样转达 zcode.carrierPageUrl() 给的地址', async () => {
    const { call } = setup({ carrierPageUrl: async () => 'http://127.0.0.1:19321/carrier' })
    expect(await call('captcha.carrierUrl', {}))
      .toEqual({ ok: true, value: { url: 'http://127.0.0.1:19321/carrier' } })
  })

  it('★ 服务没起时回 url:null（client 据此安静退出，不当成错误）', async () => {
    const { call } = setup({ carrierPageUrl: async () => null })
    expect(await call('captcha.carrierUrl', {})).toEqual({ ok: true, value: { url: null } })
  })

  it('zcode 没实现那方法时也不炸（回 null 即可）', async () => {
    const { call } = setup({})
    expect(await call('captcha.carrierUrl', {})).toEqual({ ok: true, value: { url: null } })
  })
})

describe('载体页 GET 路由', () => {
  beforeEach(() => {
    resetCaptchaSupply()
  })

  it('注册在 /api/jet-hub/captcha-carrier，只接 GET，且 HTML 不缓存', async () => {
    const { getCarrier, carrier } = setup()
    const response = await getCarrier()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type') ?? '').toContain('text/html')
    expect(response.headers.get('cache-control') ?? '').toContain('no-store')
    // 非 GET 必须拒掉：这条路由**不给** client 当 RPC 用（RPC 有它自己的 POST 入口）。
    const post = await carrier(new Request(`http://127.0.0.1${CAPTCHA_CARRIER_PATH}`, { method: 'POST' }))
    expect(post.status).toBe(405)
  })

  it('页面用 zcode 下发的 captcha 配置（表达式只此一份，但参数要跟着远端走）', async () => {
    const { getCarrier } = setup({
      fetchCaptchaConfig: async () => ({ region: 'sgp', prefix: 'pf-remote', sceneId: 'sc-remote' }),
    })
    const html = await (await getCarrier()).text()
    expect(html).toContain('sc-remote')
    expect(html).toContain('pf-remote')
    expect(html).not.toContain(ZCODE_CAPTCHA_FALLBACK.sceneId)
  })

  it('★ 配置拉不到（无凭据/网络失败）仍返回 200 + 兜底配置，不能把载体页变成 500', async () => {
    const { getCarrier } = setup({
      fetchCaptchaConfig: async () => { throw new Error('宿主网络请求失败') },
    })
    const response = await getCarrier()
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(ZCODE_CAPTCHA_FALLBACK.sceneId)
  })
})

describe('buildCarrierPageHtml（纯函数，输出可被单测断言）', () => {
  const html = buildCarrierPageHtml(ZCODE_CAPTCHA_FALLBACK)

  it('★ 三段表达式逐字同源：容器 + SDK + 无感验证（captcha 逻辑不留第二份）', () => {
    expect(html).toContain(CAPTCHA_CONTAINER_ID)
    expect(html).toContain(ALIYUN_CAPTCHA_SDK_URL)
    expect(html).toContain('o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js')
    expect(html).toContain('initAliyunCaptcha')
    expect(html).toContain('startTracelessVerification')
    expect(html).toContain(ZCODE_CAPTCHA_FALLBACK.sceneId)
  })

  it('结果契约：挂 window.__zcodeCaptcha，且带 stage / param / interactive / updatedAt', () => {
    expect(html).toMatch(/window\.__zcodeCaptcha\s*=\s*\{[^}]*stage:\s*['"]pending/)
    for (const key of ['stage', 'param', 'interactive', 'updatedAt']) {
      expect(html, `缺契约字段 ${key}`).toContain(key)
    }
    // ⚠ 宿主侧只 `executeJavaScript` 读它 ⇒ 页面必须自己把结果写回这个挂载位。
    expect(html).toMatch(/window\.__zcodeCaptcha\s*=/)
  })

  it('★ 不带 stealth 补丁（内部载体实测 4/4 产合法 param，搬进来属无据扩面）', () => {
    expect(html).not.toMatch(/webdriver|headless|addScriptToEvaluateOnNewDocument/i)
  })

  it('★ 不内联任何凭据字段（除 param 外页面不携带敏感数据）', () => {
    expect(html).not.toMatch(/zcode_jwt|Bearer |authorization|access_token|refresh_token|cookie/i)
  })

  /**
   * 三段表达式是**拼**进同一个 `<script>` 的 —— 拼接最容易产出的不是逻辑错，
   * 而是「整页语法错」；而载体页跑在离屏 guest 里没人会看见，表现就只是
   * 「这个 session 一次都没产过 param」。所以直接让 V8 编译一遍。
   * （`new Function` 只编译不执行，不会真去碰 document / SDK。）
   */
  it('★ 拼出来的脚本能被编译，且没被 `</script>` 提前截断', () => {
    const body = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
    expect(body.length).toBeGreaterThan(100)
    expect(body).not.toContain('</script')
    expect(() => new Function(body)).not.toThrow()
  })

  it('同一 config 两次调用输出逐字相同（纯函数，无隐藏输入）', () => {
    expect(buildCarrierPageHtml(ZCODE_CAPTCHA_FALLBACK)).toBe(html)
  })
})
