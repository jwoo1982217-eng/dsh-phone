/**
 * 载体链的行为单测：内部载体优先、等不到/被拒都**不许**把失败抛给用户。
 *
 * ## 这个类存在的理由（三件事必须同时成立，本文件逐条锁住）
 * 1. **内部载体优先** ⇒ 摆脱外挂 chromium（用例 1、10）；
 * 2. **未验证的假设不许让用户买单**：内部载体的 param 能否被上游接受**从未在真实
 *    校验窗口验证过**（普通即时推理 6 个采样点上游都不校验这个头，见
 *    `docs/superpowers/specs/2026-10-01-zcode-captcha-lazy-mint-design.md` 9.2 节）
 *    ⇒ 被 `3007` 拒的**当次**必须改用 chromium 重产重发，外面看不出失败（用例 5）；
 * 3. **赌错不许反复赌**：累计被拒到阈值 ⇒ 本次运行禁用内部载体，之后**既不等也不取槽**
 *    （用例 6、7；理由同 `src/captcha-backoff.ts` 的「继续请求不会让信誉恢复，
 *    只会更糟」）。
 *
 * ## 为什么要显式摆 `captchaDemand`（与本计划任务书的一处差别）
 * 供给槽的需求位默认关（`src/captcha-supply.ts` 的 `captchaDemand`），而「等不等」这个
 * 分支**只在需求位为真时才存在**。任务书那两条写着「有界等待」的用例若不置位，
 * 走的是「不等、直接 chromium」那条路 ⇒ 断言**看着绿、其实什么都没测**，
 * 尤其抓不住「禁用后不再等待」。故本文件把等待相关的用例都显式 `setCaptchaDemand(true)`，
 * 并补一条「需求位关时不白等」把 web 版的常态也锁住（用例 3）。
 *
 * ## 反向验证（已逐条实测，见 p2-task-2-report.md）
 * - 阈值判断写成 `> CARRIER_REJECT_DISABLE_THRESHOLD` ⇒ 用例 6、7 红；
 * - 去掉「被拒即当次回退」（直接 `return outcome`）⇒ 用例 5 红；
 * - 去掉 `mint()` 入口的 `disabled` 短路 ⇒ 用例 6 红（禁用后仍把槽里的 param 交出去）；
 * - 把 `source !== 'internal'` 那条不计数改成也计数 ⇒ 用例 8 红；
 * - 从 `mintWithChromium(options)` 拿掉 options ⇒ 用例 9 红。
 *
 * ## ⚠ 本文件的 param 一律用 `goodParam()` 造（评审 I1，2026-10-02）
 * 供给槽的收货口现在真的调 `validateCaptchaParam`（`src/captcha-supply.ts`），
 * 短串会被**当场拒收** ⇒ 用 `'internal-1'` 那种占位会让每条用例退化成
 * 「测的是拒绝路径」而不是「测载体链的取舍」。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  CaptchaCarrier,
  CARRIER_REJECT_DISABLE_THRESHOLD,
  type CaptchaCarrierDeps,
} from '../../src/captcha-carrier.js'
import {
  putSuppliedParam,
  resetCaptchaSupply,
  setCaptchaDemand,
} from '../../src/captcha-supply.js'

const T0 = 1_700_000_000_000
let clock = T0
const now = () => clock

/** 过 `validateCaptchaParam` 的 param（长度 ≥200 + base64 JSON + certifyId + securityToken≥50）。 */
function goodParam (tag: string): string {
  const body = JSON.stringify({ certifyId: tag, securityToken: `${tag}-${'t'.repeat(128)}` })
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  if (encoded.length < 200) throw new Error(`假 param 太短（${String(encoded.length)}）`)
  return encoded
}

/** 造一个载体：chromium 桩按调用次数产出可区分的 param，并记下每次收到的 options。 */
function make(over: Partial<CaptchaCarrierDeps> = {}) {
  const chromiumCalls: Array<{ signal?: AbortSignal }> = []
  const lines: string[] = []
  const carrier = new CaptchaCarrier({
    mintWithChromium: async (options?: { signal?: AbortSignal }) => {
      chromiumCalls.push(options ?? {})
      return `chromium-${String(chromiumCalls.length)}`
    },
    waitMs: 20,
    now,
    log: (m: string) => { lines.push(m) },
    ...over,
  })
  return { carrier, chromiumCalls, lines }
}

/** 把内部载体打到「已禁用」：贡献 → 取用 → 被上游拒，反复到阈值。 */
async function disableByRejections(carrier: CaptchaCarrier): Promise<void> {
  for (let i = 0; i < CARRIER_REJECT_DISABLE_THRESHOLD; i += 1) {
    putSuppliedParam(goodParam(`reject-${String(i)}`), now())
    const got = await carrier.mint()
    await carrier.mintWithFallbackAfterRejection(got)
  }
}

beforeEach(() => {
  resetCaptchaSupply()
  clock = T0
})

describe('CaptchaCarrier 降级链', () => {
  it('★ 槽里有新鲜 param ⇒ 用内部载体，且完全不碰 chromium', async () => {
    // 需求位**故意不置**：这条锁的就是「槽里有新鲜货就立刻用，与需求位无关」——
    // 上一轮评审留过一条顾虑说「入口 take 分支在生产路径可能不可达」，
    // 这条用例就是它的反证（拿掉入口 take、改成只走等待，本条立刻变红）。
    const { carrier, chromiumCalls } = make()
    putSuppliedParam(goodParam('internal-1'), T0)
    const out = await carrier.mint()
    expect(out).toEqual({ param: goodParam('internal-1'), source: 'internal' })
    expect(chromiumCalls).toHaveLength(0)
  })

  it('★ 需求位开 + 槽空 ⇒ 有界等待超时后回退 chromium（用户不该感觉到这次差异）', async () => {
    setCaptchaDemand(true)
    const { carrier, chromiumCalls } = make({ waitMs: 20 })
    const started = Date.now()
    const out = await carrier.mint()
    expect(out).toEqual({ param: 'chromium-1', source: 'chromium' })
    expect(chromiumCalls).toHaveLength(1)
    // 下界：证明确实走了「等一会儿」这条路（不是直接跳过等待）
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('需求位关（web 版常态）+ 槽空 ⇒ 不白等那一段，立刻走 chromium', async () => {
    // 不校验的窗口里每条消息都白等 waitMs 就等于把「懒 mint」省下的延迟又赔回去。
    const { carrier, chromiumCalls } = make({ waitMs: 50 })
    const started = Date.now()
    const out = await carrier.mint()
    expect(out.source).toBe('chromium')
    expect(chromiumCalls).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(40)
  })

  it('等待期间被投放 ⇒ 用内部载体，不去碰 chromium', async () => {
    // 覆盖「等」这条路的**正向**出口：没有它，`waitForFreshParam` 的返回值无人校验。
    setCaptchaDemand(true)
    const { carrier, chromiumCalls } = make({ waitMs: 500 })
    const waiting = carrier.mint()
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    putSuppliedParam(goodParam('late-1'), now())
    const out = await waiting
    expect(out).toEqual({ param: goodParam('late-1'), source: 'internal' })
    expect(chromiumCalls).toHaveLength(0)
  })

  it('过期 param 不用（宁可白等一轮也不发出去吃 3007）', async () => {
    // 99 秒远超 `PARAM_MAX_AGE_MS`（20 秒）；边界本身由 `captcha-supply.spec.ts` 锁。
    const { carrier } = make()
    putSuppliedParam(goodParam('stale-1'), T0 - 99_000)
    const out = await carrier.mint()
    expect(out.source).toBe('chromium')
  })

  it('★ 内部 param 被上游拒 ⇒ 记一次并当次改用 chromium 重产（不外抛失败）', async () => {
    const { carrier, chromiumCalls } = make()
    putSuppliedParam(goodParam('internal-2'), T0)
    const first = await carrier.mint()
    expect(first.source).toBe('internal')
    const second = await carrier.mintWithFallbackAfterRejection(first)
    expect(second).toEqual({ param: 'chromium-1', source: 'chromium' })
    expect(chromiumCalls).toHaveLength(1)
    expect(carrier.stats().internalRejected).toBe(1)
    expect(carrier.internalDisabled()).toBe(false)
  })

  it('★ 累计拒绝到阈值 ⇒ 本次运行禁用内部载体，之后连槽里的新鲜 param 都不取', async () => {
    setCaptchaDemand(true)
    const { carrier } = make()
    await disableByRejections(carrier)
    expect(carrier.internalDisabled()).toBe(true)
    putSuppliedParam(goodParam('p-after'), T0)
    const after = await carrier.mint()
    expect(after.source).toBe('chromium')
    expect(after.param).not.toBe(goodParam('p-after'))
  })

  it('禁用后不再走「等待」这条慢路（mint 立即返回 chromium，不等 waitMs）', async () => {
    setCaptchaDemand(true)
    const { carrier } = make({ waitMs: 50 })
    await disableByRejections(carrier)
    const started = Date.now()
    const out = await carrier.mint()
    expect(out.source).toBe('chromium')
    expect(Date.now() - started).toBeLessThan(40)
  })

  it('★ chromium 的 param 也被拒 ⇒ 不记在载体头上（不推进禁用阈值）', async () => {
    /**
     * `source === 'chromium'` 时被拒是「param 自身过期/被降级」，与内部载体无关。
     * 若这里也计数，上游一次抖动就能把内部载体冤枉禁掉 —— 与
     * `src/captcha-backoff.ts` 只数「产出失败」、不数「上游回 3007」是同一个归因纪律。
     */
    const { carrier, chromiumCalls } = make()
    const out = await carrier.mint()
    expect(out.source).toBe('chromium')
    const again = await carrier.mintWithFallbackAfterRejection(out)
    expect(again.source).toBe('chromium')
    expect(carrier.stats().internalRejected).toBe(0)
    expect(carrier.internalDisabled()).toBe(false)
    expect(chromiumCalls).toHaveLength(2)
  })

  it('★ signal 必须透传给 chromium 产出（mint 与当次回退两条路都要，历史上有无超时等待）', async () => {
    const { carrier, chromiumCalls } = make()
    const controller = new AbortController()
    await carrier.mint({ signal: controller.signal })
    expect(chromiumCalls[0]?.signal).toBe(controller.signal)
    // 回退那条路同样在用户按「停止」时该被取消 —— 漏一处就等于停不下来。
    putSuppliedParam(goodParam('internal-3'), T0)
    const internal = await carrier.mint({ signal: controller.signal })
    await carrier.mintWithFallbackAfterRejection(internal, { signal: controller.signal })
    expect(chromiumCalls[1]?.signal).toBe(controller.signal)
  })

  it('统计口径：内部/外部各计一次，不多不少', async () => {
    const { carrier } = make()
    putSuppliedParam(goodParam('s-1'), T0)
    await carrier.mint()
    await carrier.mint()
    const s = carrier.stats()
    expect(s.internalUsed).toBe(1)
    expect(s.chromiumUsed).toBe(1)
    expect(s.internalRejected).toBe(0)
    expect(s.disabledAfter).toBe(CARRIER_REJECT_DISABLE_THRESHOLD)
  })
})
