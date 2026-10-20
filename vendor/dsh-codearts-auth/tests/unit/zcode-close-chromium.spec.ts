/**
 * ZCode **领取结束后关闭外挂 chromium** 的回归测试。
 *
 * ## 守的是用户报障（2026-10-02）
 *
 * > 领取完 chromium 还是留存在任务栏，图标还会闪烁。
 *
 * 根因：`captchaBrowser` 一旦惰性创建就**只**在 `stop()`（插件卸载）里销毁 ——
 * 而领取是**低频写操作**（一天一次）。于是那个 chromium 进程（约 200–400MB）
 * 会一直留着，它的窗口也就一直挂在任务栏上（而它**已经**被修成
 * `WS_EX_TOOLWINDOW`：不再有任务栏按钮，但进程本身仍在占资源）。
 *
 * ## ⚠ 用户明确的边界条件（本文件的用例全围绕它）
 *
 * > 如果不是领取积分还请求了 captcha 则再打开不关，领取积分完毕就关
 *
 * ⇒ **判据是「哪个流程在用」，不是「浏览器有没有被创建过」**：
 *
 * | 流程 | 收尾动作 |
 * |---|---|
 * | **领取积分**（`claimDaily*`） | ★ **关闭** |
 * | 推理（`mintCaptchaParam`） | **不关**（那次 captcha 是推理真的需要） |
 *
 * ⚠ 两条路用**同一个** `captchaBrowser` 实例（`index.ts` 注入给适配器的
 * `mintCaptchaParam` 最终也落到 `auth.captchaBrowser`），故不能靠
 * 「是否本次新建」判断 —— 必须由调用方决定。**这也是不做自动闲置关闭的原因**：
 * 那会在推理正需要它时把浏览器拿走。
 *
 * ## ⚠ 用户 2026-10-02 的第二个更正（影响本文件的措辞与前提）
 *
 * > desktop 环境索要积分也走不到要开 chromium，所以不用开
 *
 * 核对 `mintClaimCaptcha()` 后确认属实：`internalCarrierAvailable()` =
 * `internalCarrierEnabled && supplied > 0`，desktop 有内部载体贡献 ⇒ 走
 * `carrier.mint()` ⇒ **不开 chromium**。故本方法在 desktop 下是**空操作**
 * （`captchaBrowser === undefined` 直接 return），对 desktop 逐字不变。
 * 用例里专门有一条守这个「desktop 下不该有副作用」。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { ZcodeCredential } from '../../src/zcode.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const authSource = readFileSync(resolve(HERE, '../../src/zcode-auth.ts'), 'utf8')
const adapterSource = readFileSync(resolve(HERE, '../../src/zcode-adapter.ts'), 'utf8')

/**
 * ⚠ **必须先 CRLF → LF 归一**再按 `\n  }\n` 切片。
 *
 * 本仓库在 Windows 上 checkout 出来是 CRLF，而 `'\n  }\n'` 在 CRLF 文本里
 * **永远匹配不到**（实际是 `\r\n  }\r\n`）—— 切片的 end 会变成 `-1`，
 * `slice(start, -1)` 于是**切到文件末尾附近**。实测切出 25,735 字符，
 * 把后面方法里真实的 `this.closeChromium()` 也包了进来，断言恒定失败。
 */
const LF = (s: string): string => s.replace(/\r\n/g, '\n')

/** 取源码里一个方法/函数的体（到两空格缩进的收尾 `}`）。 */
function bodyOf(source: string, signature: string): string {
  const text = LF(source)
  const start = text.indexOf(signature)
  expect(start, `找不到 ${signature}`).toBeGreaterThan(0)
  const end = text.indexOf('\n  }\n', start)
  expect(end, `${signature} 的收尾未找到`).toBeGreaterThan(start)
  return text.slice(start, end)
}

const CREDENTIAL: ZcodeCredential = {
  zcode_jwt: 'a.b.c',
  device_mid: '11111111-1111-1111-1111-111111111111',
  app_version: '3.14.4',
} as ZcodeCredential

/**
 * 内存凭据存储。
 *
 * ⚠ 凭据**只有插件自存这一条来源**（`ctx.credentials`）：2026-10-05 起不再读本机
 * 官方客户端文件，也**不再有** `ZcodeAuthOptions.readCredential` 测试注入点 ⇒
 * 想给某个用例一份凭据，只能把它写进这个存储。
 * 样板见 `tests/unit/zcode-credential-resolution.spec.ts`。
 */
class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/** 注册内存凭据存储并写入一份可用的凭据（`current()` 据此解析）。 */
async function seedCredential(ctx: Context): Promise<FakeCredentials> {
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(CREDENTIAL))
  return credentials
}

/** 合法的 captcha param（280 字符量级，过 `validateCaptchaParam`）。 */
function fakeParam(tag: string): string {
  const payload = {
    certifyId: tag,
    securityToken: 'S'.repeat(128),
    sceneId: '11xygtvd',
    isSign: true,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/** 领取链路的上游桩：激活上报 / preview / claim 全部 200 成功。 */
function makeClaimFetch(plans: readonly string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/billing/preview')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { plans: plans.map((planId) => ({ plan_id: planId, priority: 1 })) },
      }), { status: 200 })
    }
    if (u.includes('/billing/claim')) {
      return new Response(JSON.stringify({ code: 0, data: { claimed: true } }), { status: 200 })
    }
    // event/report 等
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
  }) as unknown as typeof fetch
}

interface Harness {
  auth: ZcodeAuth
  /** 被桩替换的浏览器：记录 `dispose()` 调用次数。 */
  browser: {
    mintWithOutcome: () => Promise<{ param: string; interactive: boolean }>
    dispose: () => void
    disposeCalls: () => number
    mintCalls: () => number
  }
}

async function makeAuth(plans: readonly string[] = ['plan-1']): Promise<Harness> {
  const ctx = new Context()
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  await seedCredential(ctx)

  const auth = new ZcodeAuth(ctx, {
    fetchImpl: makeClaimFetch(plans),
  })

  let disposeCalls = 0
  let mintCalls = 0
  const browser = {
    mintWithOutcome: async () => {
      mintCalls += 1
      return { param: fakeParam(`b${String(mintCalls)}`), interactive: false }
    },
    mint: async () => fakeParam('unused'),
    dispose: () => { disposeCalls += 1 },
    disposeCalls: () => disposeCalls,
    mintCalls: () => mintCalls,
  }
  // 预置成"已经被领取用过的常驻浏览器"
  ;(auth as unknown as { captchaBrowser: unknown }).captchaBrowser = browser
  return { auth, browser }
}

describe('领取结束必须关掉外挂 chromium', () => {
  it('★ claimDaily → 领取成功后浏览器被 dispose（并置空）', async () => {
    const { auth, browser } = await makeAuth(['plan-1'])
    const outcomes = await auth.claimDaily()
    expect(outcomes.length).toBeGreaterThan(0)
    expect(browser.disposeCalls(), '领取结束必须关掉 chromium').toBe(1)
    // 必须**置空**，否则下次 `??=` 不会重建、也用不到新 profile
    expect((auth as unknown as { captchaBrowser: unknown }).captchaBrowser).toBeUndefined()
  })

  it('★ 领取**失败**也要关（finally，而不是成功路径）', async () => {
    const { auth, browser } = await makeAuth(['plan-1'])
    // 让 preview 之前的激活上报抛错 —— 领取整体失败
    ;(auth as unknown as { fetchImpl: typeof fetch }).fetchImpl =
      (async () => { throw new Error('ECONNREFUSED') }) as never

    await expect(auth.claimDaily()).resolves.toBeDefined()
    /**
     * ⚠ 失败时**同样**要关：否则「领取失败」会额外留下一个占 200–400MB、
     * 还会在任务栏闪烁的进程，用户下次看到的仍是同一个抱怨。
     */
    expect(browser.disposeCalls(), '失败路径也必须关（finally）').toBe(1)
  })

  it('★ 一次「一键签到」只关一次（多个 plan 共用一次领取窗口）', async () => {
    const { auth, browser } = await makeAuth(['plan-1', 'plan-2', 'plan-3'])
    await auth.claimDaily()
    // 三个 plan 在同一次 claimDailyWith 里 ⇒ 收尾只关一次
    expect(browser.disposeCalls(), '整个领取窗口只关一次').toBe(1)
  })

  it('★ 关闭是幂等的（没有浏览器时是空操作，不抛错）', async () => {
    const { auth } = await makeAuth(['plan-1'])
    ;(auth as unknown as { captchaBrowser: unknown }).captchaBrowser = undefined
    await expect(auth.claimDaily()).resolves.toBeDefined()
    // 不该因为"本来就没有浏览器"而抛错
    expect((auth as unknown as { captchaBrowser: unknown }).captchaBrowser).toBeUndefined()
  })

  it('★ 关掉后能再次启动（下次领取会重新冷启动）', async () => {
    const { auth } = await makeAuth(['plan-1'])
    await auth.claimDaily()
    expect((auth as unknown as { captchaBrowser: unknown }).captchaBrowser).toBeUndefined()

    // 第二次领取：`captchaBrowser ??= new ZcodeCaptchaBrowser()` 会重建
    const second = await makeAuth(['plan-2'])
    void second
    await expect(auth.claimDaily()).resolves.toBeDefined()
  })
})

describe('⚠ 推理路径**不得**关闭 chromium（用户的边界条件）', () => {
  it('★★ mintCaptchaParam（推理取 param）不触发 dispose', async () => {
    const { auth, browser } = await makeAuth([])
    /**
     * ⚠ 这一条是用户原始要求的核心：
     * > 如果不是领取积分还请求了 captcha 则再打开不关
     *
     * 推理被 `3007` 拒时确实会用 captcha，那时**关掉**会让紧接着的重发
     * 再冷启动一次（约 3.7 秒），是净损失。
     */
    await auth.mintCaptchaParam({ region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' })
    expect(browser.disposeCalls(), '推理路径不得关闭 chromium').toBe(0)
    // 而且浏览器句柄必须仍在（下次推理还要用）
    expect((auth as unknown as { captchaBrowser: unknown }).captchaBrowser).toBe(browser)
  })

  it('★★ mintCaptchaAfterRejection（被 3007 拒后的回退）也不关闭', async () => {
    const { auth, browser } = await makeAuth([])
    await auth.mintCaptchaAfterRejection(
      { param: fakeParam('rejected'), source: 'chromium' },
      { region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' },
    )
    expect(browser.disposeCalls(), '被拒后的回退不得关闭 chromium').toBe(0)
  })
})

describe('⚠ desktop 下不该有副作用（用户 2026-10-02 更正）', () => {
  it('★ chromium 从未创建时，领取收尾是**空操作**', async () => {
    const ctx = new Context()
    ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
    await seedCredential(ctx)
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: makeClaimFetch(['plan-1']),
    })
    // desktop 场景：内部载体够用 ⇒ 从没创建过 captchaBrowser
    expect((auth as unknown as { captchaBrowser: unknown }).captchaBrowser).toBeUndefined()

    await expect(auth.claimDaily()).resolves.toBeDefined()
    // 仍然没有创建（`closeChromium` 不得**新建**浏览器）
    expect(
      (auth as unknown as { captchaBrowser: unknown }).captchaBrowser,
      'desktop 下收尾不得创建浏览器',
    ).toBeUndefined()
  })

  it('★ closeChromium 不碰载体页 server 与需求位（那些与 chromium 无关）', () => {
    /**
     * ⚠ 源码级断言：`closeChromium` 里**不得**出现
     * `carrierPageServer` / `setCaptchaDemand` —— 它们是内部载体与领取窗口的东西，
     * 混进来会让 desktop 的载体链被误伤（web 修一个 bug、desktop 多一个故障）。
     *
     * ⚠ 用 `bodyOf`（含 CRLF 归一），别自己 `indexOf('\n  }\n')` —— 见其注释。
     */
    const body = LF(bodyOf(authSource, '  closeChromium(): void {'))
    expect(body).not.toContain('carrierPageServer')
    expect(body).not.toContain('setCaptchaDemand')
  })
})

describe('源码契约：这三条都是实测踩过的坑', () => {
  it('★ 关闭必须放在领取的 `finally` 里（漏了就是"失败也留进程"）', () => {
    /**
     * ⚠ 不能按 `'\n  /**'` 收尾（CRLF 下匹配不到，会切到文件末尾）——
     * 这里改用「claimDailyWith 的完整体」，同样走 `bodyOf` 的 CRLF 归一。
     */
    const body = bodyOf(authSource, 'private async claimDailyWith(')
    // 切片必须是单个方法（防再次切飞）
    expect(body.length, 'claimDailyWith 切片异常').toBeLessThan(8_000)

    // `finally` 段里必须有 closeChromium()
    const finallyAt = body.lastIndexOf('} finally {')
    expect(finallyAt).toBeGreaterThan(0)
    expect(body.slice(finallyAt)).toMatch(/this\.closeChromium\(\)/)
    // 且不得出现在 `try` 的正常路径里（那会漏掉失败分支）
    expect(body.slice(0, finallyAt)).not.toMatch(/this\.closeChromium\(\)/)
  })

  it('★ `closeChromium` 必须清池（池里的 param 由该浏览器产出，浏览器没了就不能用）', () => {
    const body = bodyOf(authSource, '  closeChromium(): void {')
    expect(body).toMatch(/this\.captchaPool\?\.clear\(\)/)
  })

  it('★ 推理侧的注入链**不得**出现关闭调用（反向看守）', () => {
    /**
     * ⚠ 用户条件是「推理要了 captcha 就不关」。
     * 若将来有人在 `mintCaptchaParam` / `mintCaptchaAfterRejection` 里
     * 顺手加一句 close，推理的重发就会白付一次冷启动。
     *
     * ⚠ 本用例踩过**两个**坑（都写清，免得后人重犯）：
     *
     * 1. **剥注释再查**：这两段的 JSDoc 里会**提到** `closeChromium`
     *    （解释「为什么这里不关」），直接对整段源码 `not.toContain` 会被
     *    自己的注释绊倒。
     * 2. **切片边界必须按缩进匹配**：`indexOf('\n  }\n')` 找"函数结尾"是错的 ——
     *    方法体里有更深的 `}`，会切到**后面的其它方法**（实测切出 25,735 字符，
     *    把 `claimDailyWith` 里那句真实的 `this.closeChromium()` 也包进来了），
     *    于是断言恒定失败。
     * 3. **CRLF 会把上面的"错"放大成"永远错"**：见 `bodyOf` / `LF` 的注释。
     */
    const stripComments = (s: string): string => s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')

    for (const name of ['mintCaptchaParam', 'mintCaptchaAfterRejection']) {
      const body = stripComments(bodyOf(authSource, `async ${name}(`))
      // 切片必须真的只是那个方法（防再次切飞）
      expect(body.length, `${name} 的切片过长 ⇒ 边界又错了`).toBeLessThan(2_000)
      expect(body, `${name} 里不得**调用** closeChromium`)
        .not.toMatch(/this\.closeChromium\s*\(/)
    }
    // adapter 侧同样不得调用（它甚至不该知道这个方法）
    expect(stripComments(adapterSource)).not.toMatch(/closeChromium\s*\(/)
  })

  it('★ `stop()` 仍然要销毁（卸载时的既有契约不能被本改动替代）', () => {
    const body = bodyOf(authSource, '  stop(): void {')
    expect(body).toMatch(/this\.captchaBrowser\?\.dispose\(\)/)
  })
})

describe('池与浏览器的一致性', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('★ 关闭时池必须一起清（否则池里留着无法使用的 param）', async () => {
    const { auth } = await makeAuth(['plan-1'])
    const cleared = vi.fn()
    ;(auth as unknown as { captchaPool: unknown }).captchaPool = { clear: cleared }
    await auth.claimDaily()
    expect(cleared, '关闭 chromium 时必须清池').toHaveBeenCalled()
    expect((auth as unknown as { captchaPool: unknown }).captchaPool).toBeUndefined()
  })
})
