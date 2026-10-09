/**
 * 内部载体「供给槽」的单测。
 *
 * ## 槽必须同时满足三条互相拉扯的性质（本文件逐条锁住）
 * 1. **一次性**：取走即清空（param 复用必 `3007`，与 `captcha-requirement` 同源）；
 * 2. **有时效**：age 达到 `PARAM_MAX_AGE_MS` 的 param 一律丢弃（边界含等号）——
 *    时效本身**未实测**，所以宁可丢也不能发
 *    （发了就是白吃一次 3007 + 白扣一次信誉）；
 *    ⚠ 且这条闸**只有一处**：入口取货与被唤醒取货都得过它，
 *    「投放时顺手把 param 递给等待者」= 绕过它（见「唤醒≠交付」那条用例）。
 * 3. **有界等待**：等不到不能挂死 —— `zcode-captcha.ts` 历史上出过
 *    「无超时的等待把整轮请求钉住」的真实缺陷（2026-09-29），这里必须可中断 + 可超时。
 *
 * ## 时钟口径（缺陷 1 上一轮测不出的根因，别再犯）
 * 投放时刻一律用注入的 `now()`，**不许**混 `Date.now()` —— 混用会让「等待侧的年龄判定」与
 * 「投放时刻」落在两个刻度上（`T0` 与真实当前时间相差约 20 亿秒），任何过期场景都测不出来。
 * 唯一合法的 `Date.now()` 用法是量**真实墙钟耗时**（超时类用例），那与注入时钟无关。
 *
 * ## 反向验证（本仓库惯例：证明不是同义反复；七组变异逐个真跑、核对归因、全部还原）
 * 按用例标题引用，不用编号（编号会随插入漂移，引用一旦错就是注释骗人）：
 * - 去掉 `takeFreshParam` 的「取走即清」⇒「取走即清空」+「槽里已有 ⇒ 等待入口立刻给」两条红
 *   （两个取用分支各自看守同一约束）；
 * - 把过期判定改成恒不过期 ⇒「过期一律丢弃」「边界」「唤醒≠交付」「超龄那次不算数之后」四条红；
 * - 把边界 `>=` 放宽成 `>` ⇒ 只有「边界」一条红；
 * - 让等待入口**不**先收现成 param ⇒ 只有「槽里已有 ⇒ 等待入口立刻给」一条红（1019ms，断言判红）；
 * - ★ **把唤醒改回直投 param（评审缺陷 1 的旧写法）**⇒ 只有「唤醒≠交付」+「超龄那次不算数之后」
 *   两条红：前者红在真拿到了超龄 param，后者红在它拿到的是本该被丢弃的那一个、不是新鲜的那个；
 * - 让 `waitForFreshParam` 忽略 signal ⇒ 只有「中断要立刻返回」一条红（1015ms，由该用例内的 race
 *   哨兵判红，**不靠**框架 5 秒超时兜底）；
 * - 默认 `maxWaitMs` 不引用 `DEFAULT_CARRIER_WAIT_MS`（改成 5 秒）⇒ 只有「不传 maxWaitMs」一条红
 *   （3020ms，同样由 race 哨兵判红；直接 `await` 会只剩框架超时在看守，归因不干净）。
 *
 * ## 本轮新增（评审 I1 / I2）
 * - **I1**：收货口要过 `validateCaptchaParam`（**与 chromium 腿对齐**）——
 *   把该判据去掉 ⇒ 只有「降级产物不收」那条红；
 * - **I2**：`interactive`（SDK 被降级成交互式验证 = 设备信誉预警）必须能落到 host：
 *   把透传砍掉 ⇒ 「交互式贡献被记下来」+「槽里那条带标记」两条红。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  captchaDemand,
  captchaSupplyStats,
  DEFAULT_CARRIER_WAIT_MS,
  PARAM_MAX_AGE_MS,
  putSuppliedParam,
  resetCaptchaSupply,
  setCaptchaDemand,
  takeFreshParam,
  waitForFreshParam,
} from '../../src/captcha-supply.js'
import { validateCaptchaParam } from '../../src/zcode-captcha.js'

const T0 = 1_700_000_000_000
let clock = T0
const now = () => clock

/**
 * 一个**过 `validateCaptchaParam`** 的 param（长度 ≥200 + base64 解出 JSON +
 * `certifyId` + `securityToken`≥50）。⚠ 槽的收货口现在真的调那个判据（评审 I1），
 * 所以本文件里**所有**「该被收下」的 param 都必须用这个造 —— 用 `'p-1'` 那种短串
 * 会让每条用例都变成「测的是拒绝路径」。
 */
function goodParam(tag: string): string {
  const body = JSON.stringify({ certifyId: tag, securityToken: `${tag}-${'t'.repeat(128)}` })
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  if (encoded.length < 200) throw new Error(`假 param 太短（${String(encoded.length)}）`)
  return encoded
}

/** SDK 静默降级时的**垃圾产物**（约 76 字符、base64 合法但没有 `securityToken`）。 */
function degradedParam(): string {
  return Buffer.from(JSON.stringify({ certifyId: 'degraded', token: 'x'.repeat(40) }), 'utf8').toString('base64')
}

beforeEach(() => {
  resetCaptchaSupply()
  clock = T0
})

describe('captcha 供给槽', () => {
  it('空槽取不到东西（web 版就长期停在这里 ⇒ 直接走 chromium）', () => {
    expect(takeFreshParam(T0)).toBeUndefined()
  })

  it('★ 取走即清空：同一个 param 不可能被用第二次', () => {
    expect(putSuppliedParam(goodParam('p-1'), T0)).toBe(true)
    expect(takeFreshParam(T0)).toBe(goodParam('p-1'))
    expect(takeFreshParam(T0)).toBeUndefined()
  })

  it('★ 过期一律丢弃（时效未实测 ⇒ 宁可丢也不发）', () => {
    putSuppliedParam(goodParam('p-old'), T0)
    expect(takeFreshParam(T0 + PARAM_MAX_AGE_MS + 1)).toBeUndefined()
    expect(captchaSupplyStats().stale).toBe(1)
  })

  it('边界：正好在时效内可用，超出即废', () => {
    putSuppliedParam(goodParam('p-2'), T0)
    expect(takeFreshParam(T0 + PARAM_MAX_AGE_MS - 1)).toBe(goodParam('p-2'))
    putSuppliedParam(goodParam('p-3'), T0)
    expect(takeFreshParam(T0 + PARAM_MAX_AGE_MS)).toBeUndefined()
  })

  it('空串 param 不收（SDK 降级会回空/短串，收了就是收脏）', () => {
    expect(putSuppliedParam('', T0)).toBe(false)
    expect(takeFreshParam(T0)).toBeUndefined()
  })

  it('新供给覆盖旧供给（槽内最多 1 个，绝不囤）', () => {
    putSuppliedParam(goodParam('p-a'), T0)
    putSuppliedParam(goodParam('p-b'), T0 + 10)
    expect(takeFreshParam(T0 + 10)).toBe(goodParam('p-b'))
  })

  // ── 评审 I1：收货口的**质量闸** ──

  it('★ I1：SDK 降级产物（约 76 字符、缺 securityToken）不收 —— 与 chromium 腿同一道判据', () => {
    const junk = degradedParam()
    expect(validateCaptchaParam(junk).ok, '前提：本地判据认定它是降级产物').toBe(false)
    expect(putSuppliedParam(junk, T0)).toBe(false)
    expect(takeFreshParam(T0)).toBeUndefined()
    expect(captchaSupplyStats().supplied).toBe(0)
  })

  it('★ I1：被拒的贡献不唤醒等待者（不收的东西不许惊动整条链）', async () => {
    const waiting = waitForFreshParam(now, 40)
    setTimeout(() => { putSuppliedParam(degradedParam(), now()) }, 5)
    expect(await waiting).toBeUndefined()
    expect(captchaSupplyStats().waitTimeouts).toBe(1)
  })

  it('I1：判据就是 `validateCaptchaParam`（同一份，不许在这里重写一份）', () => {
    // 造一个「长度够但解不出 JSON」的东西：只有真的调了那个判据才会被拒
    const notJson = Buffer.from('x'.repeat(400), 'utf8').toString('base64')
    expect(validateCaptchaParam(notJson).ok).toBe(false)
    expect(putSuppliedParam(notJson, T0)).toBe(false)
    expect(putSuppliedParam(goodParam('p-ok'), T0)).toBe(true)
  })

  // ── 评审 I2：交互式验证（设备信誉预警）必须能到 host ──

  it('★ I2：交互式贡献被记下来（SDK 静默降级成交互式是唯一的信誉预警）', () => {
    putSuppliedParam(goodParam('p-ia'), T0, { interactive: true })
    expect(captchaSupplyStats().interactive).toBe(1)
    putSuppliedParam(goodParam('p-plain'), T0 + 1)
    expect(captchaSupplyStats().interactive).toBe(1)
  })

  it('★ I2：槽里那条 param 是不是交互式，看得见（取走即清 ⇒ 之后不再挂着标记）', () => {
    expect(captchaSupplyStats().pendingInteractive).toBe(false)
    putSuppliedParam(goodParam('p-ia'), T0, { interactive: true })
    expect(captchaSupplyStats().pendingInteractive).toBe(true)
    takeFreshParam(T0)
    expect(captchaSupplyStats().pendingInteractive).toBe(false)
  })

  it('★ 等不到必须在 maxWaitMs 内返回 undefined，并记一次 waitTimeouts', async () => {
    const started = Date.now()
    const got = await waitForFreshParam(now, 30)
    expect(got).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(captchaSupplyStats().waitTimeouts).toBe(1)
  })

  it('不传 maxWaitMs ⇒ 默认上限就是 DEFAULT_CARRIER_WAIT_MS（不许是没人用的死数）', async () => {
    // ⚠ 断言基准是**常量本身**，不写死毫秒数。
    // ⚠ 不能直接 `await waitForFreshParam(now)` 然后量耗时：默认值一旦偏大（变异 B 改成 5 秒），
    //   红是红了，但判红的是 vitest 的 5 秒框架超时、不是断言（归因不干净）。
    //   故 race 一个「常量 + 宽限」的哨兵：默认偏大 ⇒ 哨兵先赢 ⇒ 由断言判红。
    const started = Date.now()
    const outcome = await Promise.race([
      waitForFreshParam(now).then((param) => ({ done: true, param })),
      new Promise<{ done: false }>((resolve) => {
        const timer = setTimeout(() => resolve({ done: false }), DEFAULT_CARRIER_WAIT_MS + 1_500)
        timer.unref?.()
      }),
    ])
    const elapsed = Date.now() - started
    expect(outcome).toEqual({ done: true, param: undefined })
    expect(captchaSupplyStats().waitTimeouts).toBe(1)
    // 默认值偏小（例如退化成 0 = 不等）⇒ 这里判红
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_CARRIER_WAIT_MS - 50)
  })

  it('★ 三条退出路径之一：槽里已有 ⇒ 等待入口立刻给，不等满也不走投放', async () => {
    // 与下一条「等待期间被投放」是**两个不同分支**：这条走入口的 `takeFreshParam`，
    // 那条走 waiter 回调。少了这条，入口分支在预期调用序列下几乎不可达（= 无人看守）。
    putSuppliedParam(goodParam('p-ready'), T0)
    const outcome = await Promise.race([
      waitForFreshParam(now, 5_000).then((param) => ({ done: true, param })),
      new Promise<{ done: false }>((resolve) => {
        const timer = setTimeout(() => resolve({ done: false }), 1_000)
        timer.unref?.()
      }),
    ])
    expect(outcome).toEqual({ done: true, param: goodParam('p-ready') })
    // 一次性照样成立：入口取走后再取为空
    expect(takeFreshParam(T0)).toBeUndefined()
  })

  it('等待期间被投放 ⇒ 立刻拿到，不用等满', async () => {
    const waiting = waitForFreshParam(now, 5_000)
    // ⚠ 必须用**同一个注入时钟**（`now()`），不能混 `Date.now()`：
    //   混用过 ⇒ 投放时刻与等待侧的年龄判定不在同一刻度上，下一条那种过期场景根本测不出来。
    setTimeout(() => { putSuppliedParam(goodParam('p-late'), now()) }, 5)
    expect(await waiting).toBe(goodParam('p-late'))
  })

  it('★ 唤醒≠交付：投放已超龄的 param，等待者拿不到它、记一次 stale、以超时收场', async () => {
    // 评审缺陷 1：旧实现 `putSuppliedParam` 直接 `waiter?.(slot.param)`，
    // 等待侧不再查年龄 ⇒ client 回传慢于 `PARAM_MAX_AGE_MS` 时，过期 param 会被当作有效发出去，
    // 违反约束 2「时效未知宁可丢也不发」。本条就是那道闸的看守。
    const waiting = waitForFreshParam(now, 40)
    setTimeout(() => {
      // server 时钟先推进到「这条 param 早已超龄」，之后才收到它的贡献（到达时刻 = T0）
      clock = T0 + PARAM_MAX_AGE_MS + 5_000
      putSuppliedParam(goodParam('p-very-old'), T0)
    }, 5)
    expect(await waiting).toBeUndefined()
    const s = captchaSupplyStats()
    expect(s.stale).toBe(1) // 被时效闸丢掉一次，不是被发出去
    expect(s.used).toBe(0) // ⚠ used 必须为 0：一旦 +1 就说明过期 param 被当成有效交付了
    expect(s.waitTimeouts).toBe(1) // 没拿到就继续等到超时，超时计数语义不变
  })

  it('超龄那次不算数之后，同一个等待者仍可被下一次投放救活（唤醒后不出队）', async () => {
    // 看守「取到 undefined ⇒ 留在队列里继续等」这一分支：
    // 若唤醒时顺手把等待者摘出队列，它会只剩超时一条出口，内部载体就白等了一场。
    const waiting = waitForFreshParam(now, 5_000)
    setTimeout(() => {
      clock = T0 + PARAM_MAX_AGE_MS + 5_000
      putSuppliedParam(goodParam('p-very-old'), T0) // 已超龄 ⇒ 这次唤醒空手而归
      putSuppliedParam(goodParam('p-fresh'), now()) // 紧接着一个新鲜的 ⇒ 还是这个等待者该拿到
    }, 5)
    expect(await waiting).toBe(goodParam('p-fresh'))
    expect(captchaSupplyStats().stale).toBe(1)
    expect(captchaSupplyStats().waitTimeouts).toBe(0)
  })

  it('★ 中断要立刻返回（不能重演「点停止也停不下来」）', async () => {
    const controller = new AbortController()
    const waiting = waitForFreshParam(now, 5_000, { signal: controller.signal })
    controller.abort()
    // ⚠ 不能直接 `await waiting`：忽略 signal 的实现**也会**在 5 秒超时后 resolve
    //   `undefined`，值一样、只是慢 —— 那条变异就只剩「测试框架超时」在替我们看守
    //   （实测红耗时 5013ms，恰好压在 vitest 默认 5 秒线上，换个超时配置就假绿）。
    //   「立刻」才是本条的约束本体，故用 race 把它变成显式断言。
    const outcome = await Promise.race([
      waiting.then((param) => ({ done: true, param })),
      new Promise<{ done: false }>((resolve) => {
        const timer = setTimeout(() => resolve({ done: false }), 1_000)
        timer.unref?.()
      }),
    ])
    expect(outcome).toEqual({ done: true, param: undefined })
  })

  it('拿到一个已 abort 的 signal 时不进等待（调用方不必自己先判 aborted）', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await Promise.race([
      waitForFreshParam(now, 5_000, { signal: controller.signal })
        .then((param) => ({ done: true, param })),
      new Promise<{ done: false }>((resolve) => {
        const timer = setTimeout(() => resolve({ done: false }), 1_000)
        timer.unref?.()
      }),
    ])
    expect(outcome).toEqual({ done: true, param: undefined })
    // 且 abort 早退不该被记成超时（超时计数只属于「等满了」那条路径）
    expect(captchaSupplyStats().waitTimeouts).toBe(0)
  })

  it('需求位默认关；打开后 client 才该产 param', () => {
    expect(captchaDemand()).toBe(false)
    setCaptchaDemand(true)
    expect(captchaDemand()).toBe(true)
  })

  it('统计只读不回写内部状态（防两处真相）', () => {
    putSuppliedParam(goodParam('p-x'), T0)
    takeFreshParam(T0)
    const s = captchaSupplyStats()
    expect(s).toEqual({
      supplied: 1, used: 1, stale: 0, waitTimeouts: 0, interactive: 0, pendingInteractive: false,
    })
    s.used = 99
    expect(captchaSupplyStats().used).toBe(1)
  })
})
