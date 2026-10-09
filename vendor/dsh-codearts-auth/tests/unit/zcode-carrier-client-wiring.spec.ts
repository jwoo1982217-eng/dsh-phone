/**
 * 二期 Task 4：桌面版 client 侧「内部载体贡献循环」的接线用例。
 *
 * ## 为什么本文件是「两层混合」，而不是整份 readFileSync（先说清楚，免得后来人照抄错的）
 * 真实的 `<webview>` guest 只在 DSH Desktop（Electron 主进程发租约）里存在：
 * 单测环境是 `environment: 'node'`（见 `vitest.config.ts`），既没有 `dshDesktop`、
 * 也没有 `document` / webview 元素；而**装一个假 Electron 不等于验了真的** ——
 * `executeJavaScript` 读的是真载体页、`partition` 是主进程发的真租约。
 * 所以按「能不能真跑」分两层：
 *
 * | 层 | 覆盖对象 | 手法 |
 * |---|---|---|
 * | **行为层**（本文件主体） | 循环的**取舍判定**：web 版零动作、demand=false 就不建 guest、elapsedMs 的锚点、失败分类、停止/异常要真的回收 guest | 注入 `desktop` / `doc` / `timing`，跑**真的** `startCarrierContribution` |
 * | **源码层**（最后两组） | 只有真浏览器里才成立的东西：`<webview>` 属性形状、事件名、绝不能用 `getURL()` 判导航、一行 captcha 逻辑都不写 | `readFileSync` 断言（`zcode-wiring.spec.ts` 同法） |
 *
 * ⚠ 别把源码层当主力：`readFileSync` 的断言**改个写法就会假红，一段注释就能把它喂绿**
 * （下表第 ① 行就是活例）。之所以还留着，是因为那几条判据（尤其 URL getter 那条）在
 * 假对象下**测不出真假** —— 只有真 Electron 才会在 `did-finish-load` 时仍回
 * `about:blank#<lease>`；假 guest 也回这个值，是**我照实测抄的**，不是它自带的。
 *
 * ⚠ 调 `FAST_TIMING` 前先读它旁边的注释：Windows 的 `setTimeout` 粒度约 15.6ms，
 * 一轮「导航 + 三次轮询」实测就要 ~50ms；预算压太小会得到**看起来像实现错了**的假红
 * （本轮真踩过一次，别再来一次）。
 *
 * ## ★ 2026-10-02 修订：导航目标改成「每轮问 server」（评审 C1/C2）
 * 原先 `CARRIER_PATH` 是 client 里的一个常量（与 `src/jet-hub-rpc.ts` 的
 * `CAPTCHA_CARRIER_PATH` 靠断言对齐），指向插件自己的 `/api/jet-hub/captcha-carrier`。
 * 真机证据（DSH Desktop 0.2.0-rc.2 的 `app.asar/lib/main.js`）证明那条路**根本走不通**：
 * `allowedNavigation()` / `onBeforeRequest` 都以 `isApplicationHost(url)` 拒绝
 * 「**端口相同** 且 主机相同/回环」的地址 ⇒ guest 每一轮都在第一个判断退出，收益恒为 0。
 * 现在改成每轮问 `captcha.carrierUrl` 要一个**独立回环端口**上的地址
 * （`CARRIER_URL` 就是那个形状：`http://127.0.0.1:<端口>/carrier`）。
 * ⇒ 本文件里所有「期望 origin」都从 `GUI_ORIGIN` 换成了 `CARRIER_ORIGIN`，
 * 因为载体页**不再与 GUI 同源**。
 *
 * ## 反向验证（本轮**实跑**结果，逐条改坏 `zcode-carrier.js` 后看哪条红）
 *
 * | 变异 | 变红 | 说明 |
 * |---|---|---|
 * | ① 去掉 `protocolVersion === 1` 判据 | A 组 2 条 | ⚠ 源码层那条**没红** —— 注释里写了这个字面量就把它喂绿了。 |
 * | ② 导航判据改用 guest 的 URL getter | B/C/D 共 9 条 + F 那条 | 假 guest 的 `getURL()` 照真机返回 `about:blank#<lease>` ⇒ 行为层当场全部产不出 |
 * | ③ 去掉 demand 门禁 | 「demand=false 一次都不产」+「demand=true 的形状」2 条 | 后者红是因为不门禁就会多产一轮，`loads` 从 1 变 2 |
 * | ④ `elapsedMs` 锚点挪到导航之后 | **只有**「锚点在导航之前」那 1 条 | 说明这条用例咬得准，不是一片连带红 |
 * | ⑤ 把 401 塌缩进 `mint-timeout` | 分类表 + 「401 就说 401」2 条 | 三种分类的可分辨性是真断言 |
 * | ⑥ 复用 guest 时不再重新导航 | **只有**规则 5 那 1 条 | |
 * | ⑦ 异常路径不 `destroyGuest` | **只有**「坏 guest 立刻回收」1 条 | |
 * | ⑧ 失败时不发状态码探针 | 「401 就说 401」1 条 | 探针是 401 分类的唯一来源，去掉就退化成含混分类 |
 * | ⑨ ★ 导航 URL 改回 `GUI_ORIGIN + '/api/jet-hub/captcha-carrier'` | C 组「导航到问来的那条地址」+ F 组「不许硬编码 /api」+ D 组 origin 相关 | 本轮新增的反向验证 |
 * | ⑩ ★ 租约形状异常那条早退不 `release` | E 组「坏形状也要归还租约」1 条 | 评审 I6 |
 * | ⑪ ★ 载荷里不传 `interactive` | C 组「交互式标记回传」1 条 | 评审 I2 |
 *
 * ⚠ ①那条的教训请留着：**源码级断言可以被注释、字符串字面量喂绿**，它守不住语义。
 * 所以本文件把判据抽成纯函数（`readDesktopBridge` / `classifyCarrierOutcome`）真跑，
 * `readFileSync` 只留给「装了假 Electron 也测不出真假」的那几条（见下组 F）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PARAM_MAX_AGE_MS } from '../../src/captcha-supply.js'
import {
  buildContributePayload,
  CARRIER_FAILURE,
  CARRIER_PENDING,
  classifyCarrierOutcome,
  DEFAULT_CARRIER_TIMING,
  readDesktopBridge,
  startCarrierContribution,
} from '../../plugin-src/client/zcode-carrier.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(
  resolve(HERE, '../../plugin-src/client/zcode-carrier.js'), 'utf8',
)
const indexSource = readFileSync(resolve(HERE, '../../plugin-src/client/index.js'), 'utf8')
/** 剥掉注释后的 client 源码（「代码里不许有 X」类断言一律用它，别被注释喂绿）。 */
const clientCode = stripComments(clientSource)

/** GUI 自己的 origin（桌面版是 `dsh-app://app`，web 版才是 http —— 载体页**不再**用它）。 */
const GUI_ORIGIN = 'http://127.0.0.1:3080'
/**
 * ★ 载体页现在住在**独立回环端口**上（评审 C1/C2）——
 * 端口必须**不同于** Host 那个，否则主进程的 `isApplicationHost` 根本不放行。
 */
const CARRIER_URL = 'http://127.0.0.1:19321/carrier'
const CARRIER_ORIGIN = 'http://127.0.0.1:19321'

/**
 * 剥掉注释，只留**可执行代码**。
 *
 * ⚠ 为什么必须剥：本文件 F 组是源码级断言，而源码级断言有个众所周知的弱点 ——
 *   **注释里写一句话就能把它喂绿**（文件头那条「变异 ① 没红」就是活例）。
 *   「不许出现某个常量/路径」这类看守尤其容易被注释里的取证文字触发
 *   （本轮就踩了一次：文件头为了记录旧实现写了那条路径字面量）。
 *   ⇒ 断言「代码里没有它」时，一律对剥掉注释的文本断言。
 */
function stripComments (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 载体页在 guest 里的表现（`window.__zcodeCaptcha` 的读数 + 网络层事实）。 */
interface PageScript {
  origin?: string
  href?: string
  mounted?: boolean
  /** 依次消费的 stage 序列（最后一个之后重复它）：用来演「先 pending 后 success」。 */
  stages?: string[]
  param?: string
  error?: string
  /** 页面自己报「这一发被降级成了交互式验证」（评审 I2）。 */
  interactive?: boolean
  /** guest 自己去 `fetch` 载体页时看到的 HTTP 状态（401 就是那条认证风险）。 */
  probeStatus?: number
  /** 探针回**不是数字**的东西（真机里可能是被扩展改写的响应）⇒ 必须归一成 probe-failed。 */
  probeRaw?: string
  failLoad?: { code: number, description: string }
  evaluateThrows?: boolean
}

/**
 * 可控时钟：`value` 是当前假时刻（ms），`advance()` 单调推进。
 *
 * ★ 为什么需要它：`elapsedMs` 由「到达时刻 − 本轮开始产」两个**墙钟**读数推算，
 * 而假guest 用 `setTimeout(…, 5)` 模拟导航耗时 —— 那个定时器会略微提前触发，
 * 于是两个墙钟之差偶尔落到 5 以下，断言假红（Windows 因定时器粒度 ~15.6ms
 * 反倒恒过，是平台不对称而非随机）。故让假 guest 在**同一个时钟源**上把导航
 * 那 5ms 补上：判据从「墙钟差值够大」换成「同一时钟源上的先后顺序」，
 * 与时间分辨率无关，且不会变弱 —— 锚点若被挪到导航之后，推进的 5ms 会落到
 * `mintStartedAt` 之前，`elapsedMs` 变0 → 变红。
 */
class FakeClock {
  value: number
  constructor (start = 1_700_000_000_000) { this.value = start }
  advance (ms: number): void { this.value += ms }
  now = (): number => this.value
}

class FakeGuest {
  readonly attributes = new Map<string, string>()
  readonly style: Record<string, string> = {}
  readonly page: PageScript
  readonly clock: FakeClock
  readonly listeners = new Map<string, Array<(event: any) => void>>()
  url = ''
  loads = 0
  evaluates = 0
  attached = false
  removed = false
  private stageIndex = 0

  constructor (page: PageScript, clock: FakeClock) {
    this.page = page
    this.clock = clock
  }

  setAttribute (name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute (name: string): string | undefined { return this.attributes.get(name) }

  addEventListener (name: string, handler: (event: any) => void): void {
    const list = this.listeners.get(name) ?? []
    list.push(handler)
    this.listeners.set(name, list)
  }

  removeEventListener (name: string, handler: (event: any) => void): void {
    const list = this.listeners.get(name) ?? []
    const at = list.indexOf(handler)
    if (at >= 0) list.splice(at, 1)
  }

  emit (name: string, event: unknown = {}): void {
    for (const handler of [...(this.listeners.get(name) ?? [])]) handler(event)
  }

  /** 真 webview 一样：导航完成是**异步事件**，不是 loadURL 的返回值。 */
  /** ⚠ 事件字段名照 Electron 的真形状写（`errorCode` / `errorDescription`，不是 code/description）：
   *  假对象自己发明字段名，实现就会「跟着假的一起绿」——那正是同义反复。 */
  loadURL (url: string): Promise<void> {
    this.loads += 1
    this.url = url
    return new Promise((resolveLoad) => {
      setTimeout(() => {
        // 假时钟补上「导航耗时」：真机上这段是墙钟，此处由同一个时钟源记账，
        // 于是 elapsedMs 不再依赖 setTimeout 的调度抖动。
        this.clock.advance(NAVIGATE_FAKE_MS)
        if (this.page.failLoad !== undefined) {
          this.emit('did-fail-load', {
            isMainFrame: true,
            errorCode: this.page.failLoad.code,
            errorDescription: this.page.failLoad.description,
            validatedURL: url,
          })
        } else {
          this.emit('did-finish-load', {})
        }
        resolveLoad()
      }, 5)
    })
  }

  executeJavaScript (code: string): Promise<string> {
    this.evaluates += 1
    if (this.page.evaluateThrows === true) return Promise.reject(new Error('guest 已失联'))
    // 状态读数与响应码探针是两段不同的表达式：探针的特征就是它自己发 fetch。
    if (code.includes('fetch(')) {
      return Promise.resolve(this.page.probeRaw ?? String(this.page.probeStatus ?? 0))
    }
    const stages = this.page.stages ?? ['pending']
    const stage = stages[Math.min(this.stageIndex, stages.length - 1)]
    this.stageIndex += 1
    return Promise.resolve(JSON.stringify({
      origin: this.page.origin ?? CARRIER_ORIGIN,
      href: this.page.href ?? CARRIER_URL,
      title: this.page.mounted === false ? 'Sign in' : 'dsh captcha carrier',
      mounted: this.page.mounted ?? true,
      stage,
      param: stage === 'success' ? (this.page.param ?? '') : '',
      error: this.page.error ?? '',
      interactive: this.page.interactive === true,
    }))
  }

  /**
   * ⚠ **刻意**照真机实测的形状返回：真 Electron 里 `did-finish-load` 那一刻
   * 它仍然是初始的 `about:blank#<lease>`（载体页的初始 src 就是这个形状）。
   * 假对象如果这里返回「导航后的 url」，那「拿 URL getter 判导航」这种写法在单测里
   * 反而能过 —— 变异 ② 就抓不住了。**假对象必须复刻真机的坑，而不是复刻我的预期。**
   */
  getURL (): string {
    return this.attributes.get('src') ?? ''
  }

  /** ⚠ 真 Electron 会在元素被摘掉时补发 `destroyed` —— 回收路径必须扛得住这个重入。 */
  remove (): void {
    this.removed = true
    this.attached = false
    this.emit('destroyed', {})
  }
}

function makeDoc (page: PageScript, clock: FakeClock) {
  const doc: any = {
    URL: `${GUI_ORIGIN}/settings`,
    location: { href: `${GUI_ORIGIN}/settings`, origin: GUI_ORIGIN },
    created: [] as FakeGuest[],
    body: {
      children: [] as FakeGuest[],
      append (element: FakeGuest): void {
        this.children.push(element)
        element.attached = true
        setTimeout(() => element.emit('dom-ready', {}), 0)
      },
      /** ⚠ 用 `attached` 而不是「曾在 children 里」：remove() 之后它就不该被算作在文档里了。 */
      contains (element: FakeGuest): boolean {
        return element.attached === true
      },
    },
    createElement (tag: string): FakeGuest {
      const guest = new FakeGuest(page, clock)
      ;(guest as any).tag = tag
      doc.created.push(guest)
      return guest
    },
  }
  doc.body.append = doc.body.append.bind(doc.body)
  doc.body.contains = doc.body.contains.bind(doc.body)
  return doc
}

function makeBridge (options: { reservation?: unknown } = {}) {
  const state = { acquires: 0, released: [] as string[] }
  return {
    state,
    browser: {
      async acquire (workspace: string) {
        state.acquires += 1
        if (options.reservation !== undefined) return options.reservation
        return { lease: `lease-${String(state.acquires)}`, partition: `dsh-sidebar-browser-${workspace}` }
      },
      async release (lease: string) {
        state.released.push(lease)
      },
    },
  }
}

function makeRpc (routes: Record<string, (payload: any) => any>) {
  const calls: Array<{ endpoint: string, payload: any }> = []
  const rpcCall = async (endpoint: string, payload: any): Promise<any> => {
    calls.push({ endpoint, payload })
    const route = routes[endpoint]
    if (route === undefined) throw new Error(`没有注册的方法：${endpoint}`)
    return route(payload)
  }
  return { calls, rpcCall }
}

/**
 * 快到毫秒级的节奏（只喂给单测；生产走模块内默认值）。
 * ⚠ 别把 `mintTimeoutMs` 压到几十毫秒：Windows 的 `setTimeout` 粒度约 15.6ms，
 * 「导航 1 跳 + 轮询 3 次」实测就要 ~50ms，预算给小了会让「先 pending 后 success」
 * 那类用例**永远等不到终态**（我第一版就被这个坑了一次，表现是假红）。
 */
/** 假 guest 模拟「导航耗时」的毫秒数；与 `loadURL` 里那个 `setTimeout` 同值。 */
const NAVIGATE_FAKE_MS = 5

const FAST_TIMING = {
  demandPollMs: 1,
  mintPollMs: 1,
  mintTimeoutMs: 150,
  navigateTimeoutMs: 300,
  domReadyTimeoutMs: 300,
  evaluateTimeoutMs: 300,
  successCooldownMs: 1,
  failureCooldownMs: 5,
}

/** 等异步循环走到某个状态的上限（同样要大于定时器粒度 × 步数）。 */
const WAIT_FOR = { timeout: 3_000, interval: 2 }
function setup (options: {
  page: PageScript
  demand?: boolean | boolean[]
  accepted?: boolean
  desktop?: unknown
  contributeThrows?: boolean
  /** `captcha.carrierUrl` 的回答（`null` = 「现在没有可用地址」，评审 C1/C2）。 */
  carrierUrl?: string | null
  /** 覆盖 `acquire` 的返回形状（造「租约形状异常」那一支，评审 I6）。 */
  reservation?: unknown
  /**
   * 覆盖 `now`（生产代码早有此注入点：`zcode-carrier.js` 的
   * `typeof options.now === 'function' ? options.now : () => Date.now()`）。
   * 缺省仍是真墙钟，故其余用例行为逐字不变。
   */
  now?: () => number
  /**
   * 传入即启用**可控时钟**：假 guest 在导航事件处推进它，且 `now` 改从它取值。
   *
   * ⚠ 缺省**不传**：此时 `now` 仍走真墙钟，其余用例的行为与断言语义逐字不变
   * ——这条修复只对显式 opt-in 的用例生效。
   */
  clock?: FakeClock
}) {
  const logs: Array<{ level: string, message: string }> = []
  const clock = options.clock ?? new FakeClock()
  const doc = makeDoc(options.page, clock)
  const bridge = makeBridge(options.reservation === undefined ? {} : { reservation: options.reservation })
  const demands = Array.isArray(options.demand) ? options.demand : [options.demand ?? false]
  let demandIndex = 0
  const { calls, rpcCall } = makeRpc({
    // 数组用完之后重复最后一项 ⇒ 传 `[false, true]` 就是「头两轮不产，之后一直要」。
    'captcha.demand': () => {
      const active = demands[Math.min(demandIndex, demands.length - 1)] === true
      demandIndex += 1
      return { active }
    },
    // ⚠ 评审 C1/C2：载体页地址**每轮问一次**（端口是 server 运行时挑的）。
    //   传 `carrierUrl: null` 就是「env 关掉 / 端口全被占」那一支。
    'captcha.carrierUrl': () => ({
      url: 'carrierUrl' in options ? options.carrierUrl : CARRIER_URL,
    }),
    'captcha.contribute': (payload: any) => (
      options.contributeThrows === true
        ? (() => { throw new Error('RPC 通道断了') })()
        : { accepted: options.accepted !== false }),
  })
  const stop = startCarrierContribution({
    rpcCall,
    // ⚠ 用 `in` 而不是 `=== undefined` 判「有没有传」：`desktop: undefined` 是 web 版那一类用例
    //   故意传的（拿不到 bridge），它必须**不被**默认值覆盖成桌面版。
    desktop: 'desktop' in options ? options.desktop : { protocolVersion: 1, browser: bridge.browser },
    doc,
    timing: FAST_TIMING,
    // ⚠ 只在调用方**显式**传入 clock 时才切到假时钟；缺省走真墙钟，
    // 故这条修复不影响本文件其余用例（它们依赖墙钟预算，不该被换掉）。
    now: options.now ?? (options.clock === undefined ? () => Date.now() : clock.now),
    log: (level: string, message: string) => { logs.push({ level, message }) },
  })
  return { stop, logs, doc, bridge, calls, rpcCall, clock }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('A. 桌面判据（规则 1：web 版零动作）', () => {
  it('只有 protocolVersion===1 且带 browser 的 dshDesktop 才算内部载体可用', () => {
    expect(readDesktopBridge(undefined)).toBeUndefined()
    expect(readDesktopBridge({})).toBeUndefined()
    // 协议版本不对 ⇒ 形状可能已经变了，一律不认（不是「试试看」）。
    expect(readDesktopBridge({ protocolVersion: 2, browser: { acquire: () => {} } })).toBeUndefined()
    expect(readDesktopBridge({ protocolVersion: 1 })).toBeUndefined()
    expect(readDesktopBridge({ protocolVersion: 1, browser: {} })).toBeUndefined()
    expect(readDesktopBridge({ protocolVersion: 1, browser: null })).toBeUndefined()
    const browser = { acquire: () => {}, release: () => {} }
    expect(readDesktopBridge({ protocolVersion: 1, browser })).toBe(browser)
  })

  it('★ web 版（拿不到 bridge）：不查 demand、不建 guest、一行日志都不打', async () => {
    const { stop, logs, doc, calls } = setup({ page: { stages: ['success'] }, demand: true, desktop: undefined })
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toHaveLength(0)
    expect(doc.created).toHaveLength(0)
    expect(logs).toHaveLength(0)
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })

  it('★ 桌面版但只给了旧版壳（protocolVersion 不是 1）同样零动作', async () => {
    const { stop, calls, doc, logs } = setup({
      page: { stages: ['success'] },
      demand: true,
      desktop: { protocolVersion: 0, browser: makeBridge().browser },
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toHaveLength(0)
    expect(doc.created).toHaveLength(0)
    expect(logs).toHaveLength(0)
    stop()
  })
})

describe('B. 不主动预产（规则 2：每轮先问 demand）', () => {
  it('★ demand=false 的窗口里一次都不产：只问 demand，绝不 acquire / 绝不建 webview', async () => {
    const { stop, calls, doc, bridge, logs } = setup({ page: { stages: ['success'] }, demand: false })
    await new Promise((r) => setTimeout(r, 40))
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((call) => call.endpoint === 'captcha.demand')).toBe(true)
    expect(doc.created).toHaveLength(0)
    expect(bridge.state.acquires).toBe(0)
    expect(logs).toHaveLength(0)
    stop()
  })

  it('demand 从 false 翻成 true 才开始产（需求位是唯一开关）', async () => {
    const { stop, calls, doc } = setup({ page: { stages: ['success'], param: 'P-1' }, demand: [false, false, true] })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(true)
    }, WAIT_FOR)
    expect(doc.created.length).toBe(1)
    stop()
  })
})

describe('C. 一轮贡献的形状（导航 → 读回 → 回传）', () => {
  it('★ demand=true ⇒ 建 guest、导航到载体页、把 success 的 param 经 captcha.contribute 送回', async () => {
    const { stop, calls, doc } = setup({ page: { stages: ['success'], param: 'P-1' }, demand: [true, false] })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(true)
    }, WAIT_FOR)
    const guest = doc.created[0]
    // ★ 导航目标是**问 server 来的那条独立回环地址**，不是 GUI 自己的 origin
    //   （评审 C1/C2：挂在 GUI 那个端口上主进程根本不放行，见变异 ⑨）。
    expect(guest.url).toBe(CARRIER_URL)
    expect(guest.loads).toBe(1)
    // ⚠ 这里断言**属性**而不是「现在还挂在 DOM 上」：需求位落下去后循环会主动归还租约
    //   （见下面 E 组那条），届时 attached 就变了 —— 断在它上面就是一句会随节奏翻脸的假红。
    expect(guest.getAttribute('name'), 'webview 的 name 必须是主进程发的租约号').toBe('lease-1')
    // ⚠ partition 由主进程命名（`dsh-sidebar-browser-<uuid>`，**无 `persist:`** ⇒ 内存 session）
    expect(guest.getAttribute('partition')).toBe('dsh-sidebar-browser-zcode-captcha-carrier')
    expect(guest.getAttribute('src')).toBe('about:blank#lease-1')
    const contribute = calls.find((call) => call.endpoint === 'captcha.contribute')
    expect(contribute?.payload.param).toBe('P-1')
    stop()
  })

  it('★ 评审 C1/C2：每轮都问一次 captcha.carrierUrl（端口是 server 挑的，缓存下来就会失效）', async () => {
    const { stop, calls } = setup({ page: { stages: ['success'], param: 'P-url' }, demand: true })
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.endpoint === 'captcha.contribute').length).toBeGreaterThanOrEqual(2)
    }, WAIT_FOR)
    const asked = calls.filter((call) => call.endpoint === 'captcha.carrierUrl')
    expect(asked.length).toBeGreaterThanOrEqual(2)
    // 载荷里不许有凭据类字段（这条 RPC 同样是无凭据的）
    for (const call of asked) {
      expect(JSON.stringify(call.payload)).not.toMatch(/jwt|token|cookie|authorization/i)
    }
    stop()
  })

  it('★ server 回 null（没有可用地址）⇒ 记 no-carrier-url、安静退出、不建 guest', async () => {
    const { stop, logs, doc, bridge, calls } = setup({
      page: { stages: ['success'], param: 'P-null' },
      demand: true,
      carrierUrl: null,
    })
    await vi.waitFor(() => {
      expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.noCarrierUrl}`))).toBe(true)
    }, WAIT_FOR)
    // ⚠ 「安静」的关键：不建 guest（不占一个真的 renderer 进程）、不导航、不贡献。
    expect(doc.created).toHaveLength(0)
    expect(bridge.state.acquires).toBe(0)
    expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(false)
    stop()
  })

  it('★ 评审 I2：交互式标记随 param 一起回传（host 侧唯一的设备信誉预警）', async () => {
    const { stop, calls } = setup({
      page: { stages: ['success'], param: 'P-ia', interactive: true },
      demand: [true, false],
    })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(true)
    }, WAIT_FOR)
    const payload = calls.find((call) => call.endpoint === 'captcha.contribute')?.payload
    expect(payload.interactive).toBe(true)
    stop()
  })

  it('无交互式时载荷显式带 interactive:false（别把「没读到」传成 undefined 让 server 猜）', async () => {
    const { stop, calls } = setup({ page: { stages: ['success'], param: 'P-plain' }, demand: [true, false] })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(true)
    }, WAIT_FOR)
    const payload = calls.find((call) => call.endpoint === 'captcha.contribute')?.payload
    expect(payload.interactive).toBe(false)
    stop()
  })

  it('★ elapsedMs 锚在「本轮开始产」= 导航之前（含导航 + SDK + 等待的全部时间）', async () => {
    // ★ 显式 opt-in 可控时钟：假 guest 在导航事件处把**同一个**时钟源推进 5ms，
    //   而 `mintStartedAt`（锚点）与 `elapsedMs`（到达）都取它。判据于是从
    //   「两个墙钟读数之差 ≥ 5ms」换成「同一时钟源上锚点在导航之前」——
    //   与 setTimeout 调度延迟／平台定时器粒度无关（Windows 15.6ms / macOS 更精准）。
    const clock = new FakeClock()
    const { stop, calls } = setup({
      page: { stages: ['success'], param: 'P-2' },
      demand: [true, false],
      clock,
    })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(true)
    }, WAIT_FOR)
    const payload = calls.find((call) => call.endpoint === 'captcha.contribute')?.payload
    expect(Number.isSafeInteger(payload.elapsedMs)).toBe(true)
    // 精确等于 5：假 guest 在导航事件处把**同一个**假时钟推进了 5ms，
    // 于是这是「锚点在导航之前」的确定性证明，不受setTimeout 抖动影响。
    expect(payload.elapsedMs).toBe(NAVIGATE_FAKE_MS)
    stop()
  })

  it('先 pending 后 success ⇒ 轮询到终态才回传（不把 pending 的空 param 发出去）', async () => {
    const { stop, calls } = setup({
      page: { stages: ['pending', 'pending', 'success'], param: 'P-3' },
      demand: [true, false],
    })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(true)
    }, WAIT_FOR)
    const sent = calls.filter((call) => call.endpoint === 'captcha.contribute')
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.param).toBe('P-3')
    stop()
  })

  it('★ 规则 5：guest 复用但每轮都重新导航（载体页只自动产一次）', async () => {
    const { stop, calls, doc, bridge } = setup({ page: { stages: ['success'], param: 'P-4' }, demand: true })
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.endpoint === 'captcha.contribute').length).toBeGreaterThanOrEqual(2)
    }, WAIT_FOR)
    expect(doc.created).toHaveLength(1)          // 同一个 guest
    expect(bridge.state.acquires).toBe(1)         // 一次租约
    expect(doc.created[0].loads).toBeGreaterThanOrEqual(2)  // 但每轮都重新 loadURL
    stop()
  })

  it('贡献被供给槽拒（accepted=false）也算本轮失败：报 slot-rejected 且不抛到外面', async () => {
    const { stop, logs } = setup({ page: { stages: ['success'], param: 'P-5' }, demand: [true, false], accepted: false })
    await vi.waitFor(() => {
      expect(logs.some((line) => line.message.includes('reason=slot-rejected'))).toBe(true)
    }, WAIT_FOR)
    stop()
  })
})

describe('D. 失败要能自我诊断（Task 5 实测 401 的前提）', () => {
  it('★ 分类表：三种必须分得开的原因都在，且值互不相同', () => {
    expect(CARRIER_FAILURE.unauthenticated).toBe('unauthenticated')
    expect(CARRIER_FAILURE.originMismatch).toBe('origin-mismatch')
    expect(CARRIER_FAILURE.mintTimeout).toBe('mint-timeout')
    const values = Object.values(CARRIER_FAILURE)
    expect(new Set(values).size).toBe(values.length)
    for (const value of values) {
      expect(typeof value).toBe('string')
    }
  })

  it('★ classifyCarrierOutcome 把 401 / origin 不符 / mint 超时判成三个不同值', () => {
    const base = {
      expectedOrigin: CARRIER_ORIGIN,
      origin: CARRIER_ORIGIN,
      mounted: true,
      stage: 'pending',
      loadFailed: false,
      probeStatus: 0,
      timedOut: false,
    }
    expect(classifyCarrierOutcome({ ...base, mounted: false, probeStatus: 401 }))
      .toBe(CARRIER_FAILURE.unauthenticated)
    expect(classifyCarrierOutcome({ ...base, mounted: false, probeStatus: 403 }))
      .toBe(CARRIER_FAILURE.unauthenticated)
    expect(classifyCarrierOutcome({ ...base, origin: 'http://evil.test' }))
      .toBe(CARRIER_FAILURE.originMismatch)
    expect(classifyCarrierOutcome({ ...base, timedOut: true }))
      .toBe(CARRIER_FAILURE.mintTimeout)
    // 仍然正常在产 ⇒ 别误判成失败
    expect(classifyCarrierOutcome(base)).toBe(CARRIER_PENDING)
    expect(classifyCarrierOutcome({ ...base, stage: 'success' })).toBeNull()
    // 载体页自己上报的终态失败 ⇒ 与超时分开（它带 SDK 的 err，比「client 等超时」有用得多）
    expect(classifyCarrierOutcome({ ...base, stage: 'init-throw' })).toBe(CARRIER_FAILURE.mintFailed)
    // 导航层失败优先于 origin 判断（about:blank 的 origin 是 'null'，不先挡会误报成 origin 不符）
    expect(classifyCarrierOutcome({ ...base, origin: 'null', loadFailed: true }))
      .toBe(CARRIER_FAILURE.loadFailed)
    // origin 对、页面却不是载体页（被反代改写/返回了别的 HTML）⇒ 第四类，别混进 401
    expect(classifyCarrierOutcome({ ...base, mounted: false, stage: '', probeStatus: 200 }))
      .toBe(CARRIER_FAILURE.notCarrierPage)
    // 探针自己的 fetch 抛了（调用方把它归一成 -1）⇒ 第五类：离线/被拦，与「服务器明确回了码」不同
    expect(classifyCarrierOutcome({ ...base, mounted: false, stage: '', probeStatus: -1 }))
      .toBe(CARRIER_FAILURE.probeFailed)
  })

  it('★ 日志里 401 就说 401：同一行不许出现「mint 超时」这种误导分类', async () => {
    const { stop, logs } = setup({
      page: { mounted: false, probeStatus: 401 },
      demand: [true, false],
    })
    await vi.waitFor(() => {
      expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.unauthenticated}`))).toBe(true)
    }, WAIT_FOR)
    expect(logs.some((line) => line.message.includes('401'))).toBe(true)
    expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.mintTimeout}`))).toBe(false)
    expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.originMismatch}`))).toBe(false)
    stop()
  })

  it('探针回的不是数字 ⇒ 归一成 probe-failed（NaN 不许掉进「不是载体页」那个筐）', async () => {
    const { stop, logs } = setup({ page: { mounted: false, probeRaw: 'undefined' }, demand: [true, false] })
    await vi.waitFor(() => {
      expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.probeFailed}`))).toBe(true)
    }, WAIT_FOR)
    expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.notCarrierPage}`))).toBe(false)
    stop()
  })

  it('★ 导航到了别的 origin ⇒ 报 origin-mismatch（并带上读回来的实际值）', async () => {
    const { stop, logs } = setup({ page: { origin: 'http://elsewhere.test' }, demand: [true, false] })
    await vi.waitFor(() => {
      expect(logs.some((line) =>
        line.message.includes(`reason=${CARRIER_FAILURE.originMismatch}`)
        && line.message.includes('http://elsewhere.test'))).toBe(true)
    }, WAIT_FOR)
    stop()
  })

  it('★ 页面一直 pending ⇒ 报 mint-timeout（不是「client 没产」那种含混话）', async () => {
    const { stop, logs } = setup({ page: { stages: ['pending'] }, demand: true })
    await vi.waitFor(() => {
      expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.mintTimeout}`))).toBe(true)
    }, WAIT_FOR)
    stop()
  })

  it('不向日志里写 param 原文（一次性凭据类内容不进日志）', async () => {
    const { stop, logs } = setup({ page: { stages: ['success'], param: 'SECRET-ONE-TIME-PARAM' }, demand: [true, false] })
    await vi.waitFor(() => {
      expect(logs.length).toBeGreaterThan(0)
    }, WAIT_FOR)
    await new Promise((r) => setTimeout(r, 20))
    expect(logs.map((line) => line.message).join('\n')).not.toContain('SECRET-ONE-TIME-PARAM')
    stop()
  })
})

describe('E. 回收与异常路径', () => {
  it('★ 停止函数真的停：清 timer、释放租约、摘掉元素，之后不再发任何 RPC', async () => {
    const { stop, calls, doc, bridge } = setup({ page: { stages: ['success'], param: 'P-9' }, demand: true })
    await vi.waitFor(() => {
      expect(doc.created.length).toBeGreaterThan(0)
    }, WAIT_FOR)
    stop()
    const seenAfterStop = calls.length
    const guestsAfterStop = doc.created.length
    await new Promise((r) => setTimeout(r, 60))
    expect(calls.length).toBe(seenAfterStop)
    expect(doc.created.length).toBe(guestsAfterStop)
    expect(bridge.state.released).toHaveLength(1)
    expect(doc.created[0].removed).toBe(true)
    expect(() => stop()).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))
    expect(bridge.state.released).toHaveLength(1)   // 重复 stop 不重复 release
  })

  it('★ executeJavaScript 抛错 ⇒ 立刻回收坏 guest，下一轮重建（不把坏的留原地）', async () => {
    const page: PageScript = { stages: ['pending'], evaluateThrows: true }
    const { stop, logs, doc, bridge } = setup({ page, demand: true })
    await vi.waitFor(() => {
      expect(bridge.state.released.length).toBeGreaterThanOrEqual(1)
    }, WAIT_FOR)
    expect(doc.created[0].removed).toBe(true)
    await vi.waitFor(() => {
      expect(doc.created.length).toBeGreaterThanOrEqual(2)
    }, WAIT_FOR)
    expect(logs.some((line) => line.message.includes('reason='))).toBe(true)
    stop()
  })

  it('★ 需求位落下来就归还租约（内部载体不是常驻服务：不留 idle 的离屏 renderer）', async () => {
    // 只有「先要、后不要」这一段能验到：demand 恒真是不会触发回收的，恒假则根本没建过 guest。
    const { stop, calls, doc, bridge } = setup({ page: { stages: ['success'], param: 'P-idle' }, demand: [true, false] })
    await vi.waitFor(() => {
      expect(doc.created.length).toBe(1)
    }, WAIT_FOR)
    expect(bridge.state.released).toHaveLength(0)   // 要的时候必须留着（每轮重新导航即可）
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.contribute')).toBe(true)
    }, WAIT_FOR)
    await vi.waitFor(() => {
      expect(bridge.state.released).toHaveLength(1)  // 不要了就得还
    }, WAIT_FOR)
    expect(doc.created[0].removed).toBe(true)
    stop()
    expect(bridge.state.released).toHaveLength(1)
  })

  it('★ 评审 I6：租约形状异常那条早退**也**要归还租约（否则主进程 leases map 永久残留）', async () => {
    // 真实故障形态：主进程回了 `{ lease, partition: '' }`（或 partition 名字段缺失）。
    // ⚠ 那条早退原先直接 `return null` ⇒ `bridge.release` 一次都没被调
    //   ⇒ 主进程 `leases` map 里那条永远留着（只有 releaseAll 才清），
    //   每撞一次坏形状就漏一条租约。守住「三条早退都要 release」。
    const { stop, logs, bridge } = setup({
      page: { stages: ['success'], param: 'P-bad-lease' },
      demand: true,
      reservation: { lease: 'lease-bad', partition: '' },
    })
    await vi.waitFor(() => {
      expect(bridge.state.released.length).toBeGreaterThanOrEqual(1)
    }, WAIT_FOR)
    expect(bridge.state.released[0]).toBe('lease-bad')
    expect(logs.some((line) => line.message.includes(`reason=${CARRIER_FAILURE.acquireFailed}`))).toBe(true)
    stop()
  })

  it('lease 本身不是个非空串时**不**去 release（没有可还的东西，别拿空气换空气）', async () => {
    const { stop, bridge } = setup({
      page: { stages: ['success'] },
      demand: true,
      reservation: { partition: 'dsh-sidebar-browser-x' },
    })
    await vi.waitFor(() => {
      expect(bridge.state.acquires).toBeGreaterThanOrEqual(1)
    }, WAIT_FOR)
    await new Promise((r) => setTimeout(r, 30))
    expect(bridge.state.released).toHaveLength(0)
    stop()
  })

  it('render-process-gone ⇒ 本轮作废并回收，下一轮拿新 guest', async () => {
    const { stop, doc, bridge } = setup({ page: { stages: ['pending'] }, demand: true })
    await vi.waitFor(() => {
      expect(doc.created.length).toBeGreaterThan(0)
    }, WAIT_FOR)
    doc.created[0].emit('render-process-gone', {})
    await vi.waitFor(() => {
      expect(bridge.state.released.length).toBeGreaterThanOrEqual(1)
    }, WAIT_FOR)
    await vi.waitFor(() => {
      expect(doc.created.length).toBeGreaterThanOrEqual(2)
    }, WAIT_FOR)
    stop()
  })

  it('导航失败（did-fail-load）⇒ 报 load-failed 并回收，不当成「载体页没产」', async () => {
    const { stop, logs, bridge } = setup({
      page: { failLoad: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } },
      demand: true,
    })
    await vi.waitFor(() => {
      expect(logs.some((line) =>
        line.message.includes(`reason=${CARRIER_FAILURE.loadFailed}`)
        && line.message.includes('ERR_NAME_NOT_RESOLVED'))).toBe(true)
    }, WAIT_FOR)
    await vi.waitFor(() => {
      expect(bridge.state.released.length).toBeGreaterThanOrEqual(1)
    }, WAIT_FOR)
    stop()
  })

  it('rpcCall 整体抛错也不掀桌（只记日志，循环继续）', async () => {
    const { stop, logs, doc } = setup({ page: { stages: ['success'] }, demand: true, contributeThrows: true })
    await vi.waitFor(() => {
      expect(logs.length).toBeGreaterThan(0)
    }, WAIT_FOR)
    expect(() => stop()).not.toThrow()
    expect(doc.created.length).toBeGreaterThanOrEqual(0)
  })

  it('demand 走的是 RPC，且参数里没有凭据类字段', async () => {
    const { stop, calls } = setup({ page: { stages: ['success'], param: 'P-x' }, demand: [false, true] })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.endpoint === 'captcha.demand')).toBe(true)
    }, WAIT_FOR)
    for (const call of calls) {
      expect(JSON.stringify(call.payload)).not.toMatch(/jwt|token|cookie|authorization/i)
    }
    stop()
  })
})

describe('F. 源码层（只有真 Electron 里才成立的形状，跑不了 ⇒ 只能锁文本）', () => {
  it('★ 导航判据用注入读回的 location.origin，绝不用 getURL()', () => {
    expect(clientSource).toMatch(/location\.origin/)
    // 实测：did-finish-load 时 guest 的 URL getter 仍是 about:blank#<lease>，用它判会静默失效。
    // ⚠ 禁的是「在 guest 上调它」（`.getURL(`）——注释里提到这个名字是必要的文档。
    expect(clientSource).not.toMatch(/\.getURL\s*\(/)
  })

  it('用 protocolVersion===1 的 dshDesktop.browser，拿不到就整体 return', () => {
    expect(clientSource).toMatch(/protocolVersion === 1/)
    expect(clientSource).toMatch(/dshDesktop/)
    expect(clientSource).toMatch(/browser/)
    expect(clientSource).toMatch(/return\s*\(\)\s*=>\s*\{\s*\}/)
  })

  it('★ 规则 3：client 一行 captcha 逻辑都不写（不含 SDK 与初始化调用）', () => {
    expect(clientSource).toMatch(/__zcodeCaptcha/)
    expect(clientSource).not.toMatch(/initAliyunCaptcha/)
    expect(clientSource).not.toMatch(/AliyunCaptcha\.js/)
    expect(clientSource).not.toMatch(/startTracelessVerification/)
    expect(clientSource).not.toMatch(/validateCaptchaParam/)
    expect(clientSource).not.toMatch(/SceneId/)
  })

  it('webview 的形状与官方 sidebar-browser 一致（name=租约、partition、about:blank#lease）', () => {
    expect(clientSource).toMatch(/createElement\(['"]webview['"]\)/)
    expect(clientSource).toMatch(/setAttribute\(['"]name['"]/)
    expect(clientSource).toMatch(/setAttribute\(['"]partition['"]/)
    expect(clientSource).toMatch(/about:blank#/)
    expect(clientSource).toMatch(/render-process-gone/)
    expect(clientSource).toMatch(/\.\s*release\s*\(/)
  })

  it('★ 评审 C1/C2：client **不硬编码**载体页地址，每轮问 `captcha.carrierUrl`', () => {
    // 行为层已经证明「导航到问来的那条地址」（C 组）；这里是防回退的源码锁：
    // 插件同源的那条路径**根本不可能被 guest 加载**（主进程 isApplicationHost 判定）。
    expect(clientCode).toContain("rpcCall('captcha.carrierUrl'")
    expect(clientCode).not.toContain('CAPTCHA_CARRIER_PATH')
    // ⚠ 对**剥掉注释**的代码断言：文件头为了记录旧实现写了那条路径字面量，
    //   直接对整份源码断言会被注释喂绿（本轮真踩过一次，见 stripComments 的注释）。
    //   ⚠ 断言的是「整条路径都不许出现在代码里」，不是「不许以引号开头」——
    //   后者会被 `'http://host' + '/api/…'` 这类拼接绕过去（变异 ① 就是这么溜过去的）。
    expect(clientCode).not.toContain('/api/jet-hub/captcha-carrier')
  })

  it('★ 评审 I4：不再声称 partition 由主进程「持久化」（无 `persist:` ⇒ 内存 session）', () => {
    // 取证：主进程 `acquire()` 里是 `dsh-sidebar-browser-${randomUUID()}`，没有 persist: 前缀。
    // 「跨启动信誉不保留」必须作为**事实**写进注释（它抬高降级概率，排查时会用到）。
    expect(clientCode).not.toContain('persist:carrier-')
    expect(clientSource).toMatch(/无 `persist:`|没有 `persist:`/)
    expect(clientSource).toMatch(/内存 session/)
  })

  it('index.js 真的启动了贡献循环，并把停止函数交给 ctx.effect 清理', () => {
    expect(indexSource).toMatch(/startCarrierContribution/)
    expect(indexSource).toMatch(/ctx\.effect\(\(\)\s*=>\s*startCarrierContribution/)
    expect(indexSource).toMatch(/rpcCall/)
  })
})

describe('G. 纯函数契约（不碰 DOM 的部分，真跑）', () => {
  it('buildContributePayload：elapsedMs = 现在 − 本轮开始产的时刻（整数、非负）', () => {
    expect(buildContributePayload({ param: 'P', mintStartedAt: 240, now: () => 1_000 }))
      .toEqual({ param: 'P', elapsedMs: 760, interactive: false })
    // 时钟回跳（NTP/休眠）⇒ 只能夹到 0，绝不能给负数（server 侧会当非法值丢掉整条）。
    expect(buildContributePayload({ param: 'P', mintStartedAt: 5_000, now: () => 1_000 }).elapsedMs).toBe(0)
    expect(Number.isSafeInteger(buildContributePayload({ param: 'P', mintStartedAt: 100, now: () => 1_000.7 }).elapsedMs)).toBe(true)
    // 交互式标记只认严格 true（'true'/1 都当没有 ⇒ 别把「读数异常」说成「有」）
    expect(buildContributePayload({ param: 'P', mintStartedAt: 0, now: () => 10, interactive: true }).interactive).toBe(true)
    expect(buildContributePayload({ param: 'P', mintStartedAt: 0, now: () => 10, interactive: 'yes' as never }).interactive).toBe(false)
  })

  it('classifyCarrierOutcome 对缺字段不误判成失败（读数拿不到就继续等）', () => {
    expect(classifyCarrierOutcome({})).toBe(CARRIER_PENDING)
    expect(classifyCarrierOutcome({ expectedOrigin: CARRIER_ORIGIN })).toBe(CARRIER_PENDING)
  })

  /**
   * ★ 跨模块不变式：client 的**整轮预算**必须明显小于 server 侧 param 的时效。
   *
   * 为什么必须锁住：`elapsedMs` 从「本轮开始产」起算（见上面那条锚点用例），而 server 用
   * 「到达时刻 − elapsedMs」反推产出时刻 —— 于是**一轮走多久，param 一到手就先老多久**。
   * `mintTimeoutMs` 一旦被人调到 ≥ `PARAM_MAX_AGE_MS`，慢轮次产出的东西就是「一投放即超龄」：
   * 白烧一次设备配额（阿里云按同设备限 150 次/小时），日志里还全绿，只表现为「槽一直没货」。
   * 这个耦合是**跨两个文件**的，靠注释约定挡不住改其中一个的人 ⇒ 用断言钉。
   */
  it('★ 一轮预算（含读数超时余量）小于 PARAM_MAX_AGE_MS', () => {
    const worstRound = DEFAULT_CARRIER_TIMING.mintTimeoutMs + DEFAULT_CARRIER_TIMING.evaluateTimeoutMs
    expect(worstRound).toBeLessThan(PARAM_MAX_AGE_MS)
    // 心跳也要压在 server 那趟有界等待之前问到，否则「等内部载体」永远等不到。
    expect(DEFAULT_CARRIER_TIMING.demandPollMs).toBeLessThan(1_500)
    // 成功后的冷却必须**跨过**上一发的时效，否则就是拿新 param 覆盖还新鲜的旧 param。
    expect(DEFAULT_CARRIER_TIMING.successCooldownMs).toBeGreaterThan(PARAM_MAX_AGE_MS)
  })
})
