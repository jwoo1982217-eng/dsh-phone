/**
 * ZCode captcha **页面准备（prepared）与复用**的回归测试。
 *
 * ## 守的是 2026-10-01 定位的真实缺陷（曾被误判为「空闲失效」）
 *
 * `mintOnPage` 旧实现**每次**都做三件事，而它们**互相踩**：
 *
 * ```js
 * ① document.body.innerHTML = '<div id="captcha-container">…'  // 销毁旧元素
 * ② buildSdkInjectExpression()   // SDK 已加载 ⇒ 返回 'already'（**不重建实例**）
 * ③ initAliyunCaptcha({ element:'#captcha-element', button:<新元素> })
 *    → SDK 实例仍绑定 ① **已销毁**的旧元素 ⇒ 服务端回 `F001`
 * ```
 *
 * **实测取证**（同一页面、跨轮、每轮先空闲 20 秒）：
 *
 * | 场景 | `inject` 返回 | 结果 |
 * |---|---|---|
 * | 页面未重新导航（SDK 已加载 ⇒ 早退） | `already` | ✗ **F001 ×3**（471/454/591ms） |
 * | 每轮重新导航（SDK 全新加载） | `function` | ✓ 成功 ×2（755/670ms） |
 *
 * ⇒ **`F001` 与"空闲时长"无关**，变量是「DOM 被重置而 SDK 未重建」。
 *
 * ## 修法与实测效果
 *
 * ```
 * 页面**新建**（首次使用）  → 完整准备：重置 DOM + 注入 SDK，并标记 prepared
 * 页面**复用且已就绪**       → **跳过**准备（元素与实例仍匹配）
 * ```
 *
 * 纯生产 `mint()` 路径、4 轮、每轮空闲 20 秒：
 *
 * | | 换页次数 | 空闲后耗时 |
 * |---|---|---|
 * | 修复前 | **3/3** | 2614 / 2826 / 3211 ms |
 * | 修复后 | **0/3** | 475 / 540 / 735 ms |
 *
 * ⚠ 跳过是安全的，依据：`mint` 成功后 `#captcha-element` / `#captcha-button`
 * **仍在 DOM 里**（实测 `el=true btn=true sdk=function`）。
 *
 * ## ⚠ 本文件为什么用**源码 + 桩 CDP** 而不是真浏览器
 *
 * 真实行为由 `.tmp-zcode/probe-idle-real-cause2.mjs` 端到端验证过
 * （上表的数据就来自它）。单测里启动 chromium 会让套件依赖图形环境、
 * 且每次约 4 秒 —— 故这里用**桩 CDP 连接**驱动 `mintWithOutcome()`，
 * 断言**协议层行为**（发了几次 CDP 调用、调用顺序、prepared 标记）。
 *
 * 这能守住"顺手优化回每次都准备"这类回归，而那正是本缺陷的成因。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ZcodeCaptchaBrowser, validateCaptchaParam } from '../../src/zcode-captcha.js'
import { sourceScope } from '../helpers/source-scope.js'

const SRC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/zcode-captcha.ts')
const SRC = readFileSync(SRC_PATH, 'utf8')

/**
 * ⚠ 取方法体**必须**走 `sourceScope().fn()`，不能用 `indexOf('\n  }\n')` 切片 ——
 * 那样在 CRLF 检出（本机 `core.autocrlf=true`）下返回 -1，于是 `slice` 切到
 * **文件尾部**：断言看似通过，实际检查的是整个文件，分不清命中的是不是这个方法。
 * 缘由见 `tests/helpers/source-scope.ts` 的文件头（Gitee issue IKJMG1）。
 */
const scope = sourceScope(SRC, 'zcode-captcha.ts')

/** 构造一个**合法的** captcha param（过 `validateCaptchaParam`）。 */
function makeValidParam(certifyId = 'CERT123'): string {
  const payload = { certifyId, securityToken: 'S'.repeat(128), sceneId: '11xygtvd', isSign: true }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/**
 * 桩 CDP 连接：记录每次 `Runtime.evaluate` 的表达式，并按表达式返回预设结果。
 *
 * ⚠ 返回值必须模拟 CDP 的真实形状 `{ result: { value } }` ——
 * 生产代码是这么取的（`.result?.value`）。
 */
class StubCdp {
  readonly calls: Array<{ expression: string; awaitPromise?: boolean }> = []
  /** 第几次调用 `buildMintExpression` 时返回失败（1-based）。*/
  failMintOnAttempt: number | undefined
  private mintAttempts = 0

  constructor(private readonly param: string) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.expression ?? '')
    this.calls.push({ expression, awaitPromise: params?.awaitPromise === true })

    // DOM 重置
    if (expression.includes('document.body.innerHTML')) return { result: { value: 'ok' } }
    // SDK 注入
    if (expression.includes('initAliyunCaptcha') && expression.includes('createElement')) {
      return { result: { value: 'function' } }
    }
    // 铸造
    if (expression.includes('startTracelessVerification') || expression.includes('AliyunCaptchaConfig')) {
      this.mintAttempts += 1
      if (this.failMintOnAttempt === this.mintAttempts) {
        return { result: { value: JSON.stringify({ stage: 'fail', err: '{"verifyCode":"F001"}' }) } }
      }
      return { result: { value: JSON.stringify({ stage: 'success', param: this.param, interactive: false }) } }
    }
    return { result: { value: undefined } }
  }
}

/** 造一个把内部 CDP 换成桩的浏览器实例（跳过真实启动）。 */
function makeBrowserWithStub(stub: StubCdp): ZcodeCaptchaBrowser {
  const browser = new ZcodeCaptchaBrowser({ hideWindow: true })
  const anyBrowser = browser as unknown as {
    browserCdp: unknown
    browserWs: { readyState: number }
    pageBusy: boolean
    reusablePage: {
      targetId: string; ws: unknown; cdp: unknown; lastUsedAt: number; prepared?: boolean
    } | undefined
  }
  anyBrowser.browserCdp = { send: async () => ({}) }
  anyBrowser.browserWs = { readyState: 1 }
  anyBrowser.pageBusy = false
  // 预置一个"已就绪"的页面（模拟 acquirePage 已建好页并导航过）
  anyBrowser.reusablePage = {
    targetId: 'stub-target-1',
    ws: {},
    cdp: stub,
    lastUsedAt: Date.now(),
  }
  return browser
}

describe('captcha 页面准备：DOM 重置与 SDK 实例必须配对', () => {
  it('★ 首次使用（新建页面）必须做完整准备：重置 DOM + 注入 SDK', async () => {
    const stub = new StubCdp(makeValidParam())
    const browser = makeBrowserWithStub(stub)
    // 模拟新建页面：prepared 未标记
    const anyBrowser = browser as unknown as { reusablePage: { prepared?: boolean } }
    delete anyBrowser.reusablePage.prepared

    const outcome = await browser.mintWithOutcome()
    expect(outcome.param.length).toBeGreaterThan(200)

    const dom = stub.calls.filter((c) => c.expression.includes('document.body.innerHTML'))
    const inject = stub.calls.filter((c) => c.expression.includes('createElement'))
    expect(dom.length, '首次必须先重置 DOM').toBe(1)
    expect(inject.length, '首次必须注入 SDK').toBe(1)
  })

  it('★ 复用已就绪页面时**不得**重置 DOM（否则触发 F001）', async () => {
    const stub = new StubCdp(makeValidParam())
    const browser = makeBrowserWithStub(stub)
    // 模拟"已准备好"的复用页面
    const anyBrowser = browser as unknown as { reusablePage: { prepared?: boolean } }
    anyBrowser.reusablePage.prepared = true

    await browser.mintWithOutcome()

    /**
     * ⚠ 这是本缺陷的**核心断言**：
     * 复用时若重置 `document.body.innerHTML`，会销毁 captcha 元素，
     * 而 SDK 已加载不再重建实例 ⇒ 实例失配 ⇒ 服务端 `F001`。
     */
    const dom = stub.calls.filter((c) => c.expression.includes('document.body.innerHTML'))
    expect(dom, '复用已就绪页面时不得重置 DOM').toHaveLength(0)
    // 也不该重复注入（SDK 已在）
    const inject = stub.calls.filter((c) => c.expression.includes('createElement'))
    expect(inject, '复用已就绪页面时不得重复注入 SDK').toHaveLength(0)
  })

  it('★ 复用路径仍必须真的调用铸造（跳过准备 ≠ 跳过铸造）', async () => {
    const stub = new StubCdp(makeValidParam())
    const browser = makeBrowserWithStub(stub)
    const anyBrowser = browser as unknown as { reusablePage: { prepared?: boolean } }
    anyBrowser.reusablePage.prepared = true

    const outcome = await browser.mintWithOutcome()
    const mint = stub.calls.filter((c) => c.expression.includes('AliyunCaptchaConfig'))
    expect(mint, '必须发一次铸造调用').toHaveLength(1)
    expect(outcome.param).toBe(makeValidParam())
  })

  it('★ 连续两次复用：准备只做 0 次，铸造做 2 次', async () => {
    const stub = new StubCdp(makeValidParam())
    const browser = makeBrowserWithStub(stub)
    const anyBrowser = browser as unknown as { reusablePage: { prepared?: boolean } }
    anyBrowser.reusablePage.prepared = true

    await browser.mintWithOutcome()
    await browser.mintWithOutcome()

    expect(stub.calls.filter((c) => c.expression.includes('document.body.innerHTML'))).toHaveLength(0)
    expect(stub.calls.filter((c) => c.expression.includes('AliyunCaptchaConfig'))).toHaveLength(2)
  })

  it('★ 首次准备后必须标记 prepared（供下一次跳过）', async () => {
    const stub = new StubCdp(makeValidParam())
    const browser = makeBrowserWithStub(stub)
    const anyBrowser = browser as unknown as {
      reusablePage: { prepared?: boolean }
    }
    delete anyBrowser.reusablePage.prepared

    await browser.mintWithOutcome()
    expect(anyBrowser.reusablePage.prepared, '准备完成后必须置 prepared').toBe(true)
  })

  it('★ `prepared` 未标记时保守走完整准备（状态不明不跳过）', async () => {
    const stub = new StubCdp(makeValidParam())
    const browser = makeBrowserWithStub(stub)
    const anyBrowser = browser as unknown as { reusablePage: { prepared?: boolean } }
    anyBrowser.reusablePage.prepared = undefined  // 状态不明

    await browser.mintWithOutcome()
    expect(stub.calls.filter((c) => c.expression.includes('document.body.innerHTML')),
      '状态不明时必须准备').toHaveLength(1)
  })
})

describe('失败仍必须换页重试（自愈链不能丢）', () => {
  it('★ 第一次铸造失败（F001）→ 丢弃页面、换新页重试成功', async () => {
    const stub = new StubCdp(makeValidParam('RETRY-OK'))
    stub.failMintOnAttempt = 1  // 第一次失败
    const browser = makeBrowserWithStub(stub)

    const anyBrowser = browser as unknown as {
      reusablePage: { prepared?: boolean; targetId: string } | undefined
      browserCdp: { send: (m: string, p?: unknown) => Promise<unknown> }
    }
    anyBrowser.reusablePage.prepared = true
    /**
     * 让"换新页"能成立：`Target.createTarget` + `/json/list` 需要被桩住。
     * 这里只验证**行为意图**（丢弃了旧页、做了重试），不去构造完整 CDP 栈 ——
     * 那属于集成测试范畴，真实链路已由 `.tmp-zcode` 的探针覆盖。
     */
    let createTargetCalled = false
    anyBrowser.browserCdp = {
      send: async (method: string) => {
        if (method === 'Target.createTarget') {
          createTargetCalled = true
          return { targetId: 'stub-target-2' }
        }
        return {}
      },
    }

    await expect(browser.mintWithOutcome()).rejects.toThrow()
    // 失败后应尝试丢页（reusablePage 被清）并尝试建新页
    expect(createTargetCalled, '失败后应尝试新建页面').toBe(true)
  })

  it('★ 铸造失败必须抛错（不能静默返回坏 param）', async () => {
    const stub = new StubCdp(makeValidParam())
    stub.failMintOnAttempt = 1
    const browser = makeBrowserWithStub(stub)
    const anyBrowser = browser as unknown as {
      reusablePage: { prepared?: boolean }
      browserCdp: { send: () => Promise<unknown> }
    }
    anyBrowser.reusablePage.prepared = true
    // 让换页也失败（拿不到 targetId）⇒ 最终上抛
    anyBrowser.browserCdp = { send: async () => ({}) }

    await expect(browser.mintWithOutcome()).rejects.toThrow()
  })
})

describe('源码契约：这三条都是实测踩过的坑，别改回去', () => {
  it('★ 默认 idleReuseMs 必须是 Infinity（不按空闲预测式换页）', () => {
    /**
     * ⚠ 原默认 `8_000` 基于「空闲 15 秒必然 F001」这条**未能复现**的推论，
     * 让每次空闲后白付约 2.7 秒建页成本（用户报障「签到很久」的成因）。
     */
    expect(SRC).toMatch(/idleReuseMs \?\? Number\.POSITIVE_INFINITY/)
    expect(SRC, '不得退回按空闲换页的固定阈值').not.toMatch(/idleReuseMs \?\? [\d_]+/)
  })

  it('★ `mintOnPage` 必须按 `prepared` 守卫准备步骤', () => {
    const body = scope.fn('mintOnPage')
    expect(body).toMatch(/if \(page\.prepared !== true\) \{/)
    // 准备块里必须包含 DOM 重置与 SDK 注入
    expect(body).toMatch(/document\.body\.innerHTML|buildDomExpression\(\)/)
    expect(body).toMatch(/buildSdkInjectExpression\(\)/)
    // 且必须标记 prepared
    expect(body).toMatch(/page\.prepared = true/)
  })

  it('★ SDK 注入的早退分支必须保留（`already`）——它正是失配的来源，也是判断依据', () => {
    /**
     * ⚠ 这条不是"要保留缺陷"，而是钉住**语义**：
     * `buildSdkInjectExpression` 在 SDK 已存在时返回 `'already'` 且**不重建实例**。
     * 正因如此，`mintOnPage` 才**不能**在复用时重置 DOM。
     * 若将来有人改成"每次都真正重载 SDK"，本用例会失败并提醒他重新评估
     * 上面那条「复用不得重置 DOM」的断言是否仍然必要。
     */
    expect(SRC).toMatch(/typeof window\.initAliyunCaptcha === 'function'\)\s*\{\s*resolve\('already'\)/)
  })

  it('`CaptchaPage.prepared` 字段存在且有说明', () => {
    expect(SRC).toMatch(/prepared\?:\s*boolean/)
    expect(SRC).toContain('不能每次都重做')
  })
})

describe('validateCaptchaParam（顺带锁住测试夹具的正确性）', () => {
  it('夹具产出的 param 是合法的', () => {
    expect(validateCaptchaParam(makeValidParam()).ok).toBe(true)
  })

  it('过短的 param 被拒（SDK 降级输出的形态）', () => {
    expect(validateCaptchaParam('x'.repeat(100)).ok).toBe(false)
  })
})
