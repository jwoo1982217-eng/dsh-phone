/**
 * captcha **预取池**的单测（吸收自 `dsh-free-glm` 的 `captchaPool`，2026-09-30）。
 *
 * ## 这个池解决什么
 *
 * 那边实测：captcha param 在「**用一次就废**」之外还有一条性质 ——
 * **未使用**时 60 秒内仍有效（120 秒失效）。故可以提前产好放池里，
 * 把 `zcode-captcha.ts` 那 0.5-3.7 秒的成本从**关键路径**移到**后台**。
 *
 * ## 反向验证（别写成同义反复）
 *
 * 把 `CaptchaPool.take()` 里「现产之后的那次 `prefetch()`」删掉 ⇒
 * 第 1 条用例（`现产后必须补池`）变红 —— 这正是那边记录过的实现陷阱：
 * 少了它，首次请求现产之后池**永远是空的**，之后每次都走现产，
 * 整个优化形同虚设。
 */
import { describe, expect, it } from 'vitest'

import {
  CAPTCHA_POOL_DEFAULT_ENABLED,
  CaptchaPool,
  DEFAULT_CAPTCHA_POOL_TTL_MS,
  captchaPoolConfigFromEnv,
} from '../../src/captcha-pool.js'

/** 让 fire-and-forget 的预取跑完（它的内部只有 await + 同步赋值）。 */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ZCode captcha 预取池', () => {
  it('★ 池空时现产，并**补池**（否则池永远空，优化形同虚设）', async () => {
    let minted = 0
    const pool = new CaptchaPool({ mint: async () => `p${++minted}` })

    const first = await pool.take()
    expect(first).toBe('p1')

    await tick()
    // ★ 关键断言：现产**也**要触发补池，否则下一次请求又得现产。
    expect(pool.hasFresh()).toBe(true)
    expect(minted).toBe(2)
    // 且「看一眼」不得把补好的 param 吃掉（`hasFresh()` 必须只读）。
    const second = await pool.take()
    expect(second).toBe('p2')
  })

  it('★ 池命中时直接用预取产物，并在后台补下一个（不阻塞本次）', async () => {
    let minted = 0
    const pool = new CaptchaPool({ mint: async () => `p${++minted}` })

    pool.prefetch()
    await tick()
    expect(pool.hasFresh()).toBe(true)

    const taken = await pool.take()
    // 拿到的是**预取的那个**（p1），而不是即兴现产的 p2。
    expect(taken).toBe('p1')
    await tick()
    // 取走之后补了下一个。
    expect(pool.hasFresh()).toBe(true)
    expect(minted).toBe(2)
  })

  it('池内超过 TTL 的 param 必须丢弃（宁可现产，也不发一个大概率被拒的）', async () => {
    let nowMs = 1_000
    let minted = 0
    const pool = new CaptchaPool({
      mint: async () => `p${++minted}`,
      now: () => nowMs,
    })

    pool.prefetch()
    await tick()
    expect(pool.hasFresh()).toBe(true)

    // 时间推过 TTL —— 池里那个已经不可信。
    nowMs += DEFAULT_CAPTCHA_POOL_TTL_MS + 1
    const taken = await pool.take()
    expect(taken).toBe('p2') // 现产，而不是 p1
  })

  it('validate 拒绝的 param 不入池、也不从池里取出（降级产物发了必 3007）', async () => {
    let minted = 0
    const warn: string[] = []
    // 奇数号是「降级产物」（长度不足），偶数号合法 —— 模拟 SDK 的两种输出。
    const pool = new CaptchaPool({
      mint: async () => `p${++minted}`,
      validate: (param) => param === 'p2' || param === 'p4',
      onWarn: (message) => warn.push(message),
    })

    pool.prefetch() // 产出 p1 → 被 validate 拒绝
    await tick()
    expect(pool.hasFresh()).toBe(false)
    expect(warn.some((m) => m.includes('不可用'))).toBe(true)

    const taken = await pool.take()
    expect(taken).toBe('p2') // 现产，且这次是合法的
  })

  it('预取失败只告警、不影响 take（下次请求自己现产）', async () => {
    let calls = 0
    const warn: string[] = []
    const pool = new CaptchaPool({
      mint: async () => {
        calls += 1
        if (calls === 1) throw new Error('F001')
        return 'p2'
      },
      onWarn: (message) => warn.push(message),
    })

    pool.prefetch() // 第一次预取失败
    await tick()
    expect(warn.some((m) => m.includes('预取失败'))).toBe(true)
    expect(pool.hasFresh()).toBe(false)

    // 主流程不受影响：take 自己现产成功。
    expect(await pool.take()).toBe('p2')
  })

  it('连续 prefetch 只启动一次 mint（去重，避免白耗 captcha 配额）', async () => {
    let minted = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pool = new CaptchaPool({
      mint: async () => {
        minted += 1
        await gate
        return `p${minted}`
      },
    })

    pool.prefetch()
    pool.prefetch()
    pool.prefetch()
    await tick()
    expect(minted).toBe(1) // 三次调用只产一次

    release()
    await tick()
    expect(pool.hasFresh()).toBe(true)
  })

  it('关闭预取后 take 每次现产、prefetch 是空操作（回到引入池之前的行为）', async () => {
    let minted = 0
    const pool = new CaptchaPool({ mint: async () => `p${++minted}`, enabled: false })

    pool.prefetch()
    await tick()
    expect(pool.hasFresh()).toBe(false)
    expect(minted).toBe(0)

    expect(await pool.take()).toBe('p1')
    expect(await pool.take()).toBe('p2')
    await tick()
    expect(pool.hasFresh()).toBe(false)
  })

  it('clear() 清空池（关停路径）', async () => {
    const pool = new CaptchaPool({ mint: async () => 'p1' })
    pool.prefetch()
    await tick()
    expect(pool.hasFresh()).toBe(true)
    pool.clear()
    expect(pool.hasFresh()).toBe(false)
  })

  it('环境变量解析：**默认关闭**、显式 1=开、显式 0=关、TTL 可覆盖（且非法值回落默认）', () => {
    /**
     * ★ 默认值已于 2026-10-01 **翻转为关闭**，依据三条：
     * 1. 官方根本没有预取机制（每请求现产 + 严格串行）；
     * 2. `dsh-free-glm` 的池默认也是关的（`=1` 才启用）；
     * 3. 它让 captcha 消耗**翻倍**，而阿里云按**同设备每小时 150 次**限流。
     *
     * ⚠ 反向验证：把 `CAPTCHA_POOL_DEFAULT_ENABLED` 改回 `true` ⇒ 本条变红。
     */
    expect(CAPTCHA_POOL_DEFAULT_ENABLED).toBe(false)
    expect(captchaPoolConfigFromEnv({}).enabled).toBe(false)
    expect(captchaPoolConfigFromEnv({}).ttlMs).toBe(DEFAULT_CAPTCHA_POOL_TTL_MS)
    expect(captchaPoolConfigFromEnv({ DSH_ZCODE_CAPTCHA_POOL: '1' }).enabled).toBe(true)
    expect(captchaPoolConfigFromEnv({ DSH_ZCODE_CAPTCHA_POOL: '0' }).enabled).toBe(false)
    expect(captchaPoolConfigFromEnv({ DSH_ZCODE_CAPTCHA_POOL_TTL_MS: '45000' }).ttlMs).toBe(45_000)
    // ⚠ `0` 是**非法** TTL（不是「立即过期」语义）⇒ 回落默认值，而不是把池废掉。
    expect(captchaPoolConfigFromEnv({ DSH_ZCODE_CAPTCHA_POOL_TTL_MS: '0' }).ttlMs)
      .toBe(DEFAULT_CAPTCHA_POOL_TTL_MS)
    expect(captchaPoolConfigFromEnv({ DSH_ZCODE_CAPTCHA_POOL_TTL_MS: 'abc' }).ttlMs)
      .toBe(DEFAULT_CAPTCHA_POOL_TTL_MS)
  })
})
