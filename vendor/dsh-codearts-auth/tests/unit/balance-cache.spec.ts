/**
 * 余额读数共享缓存（`src/balance-cache.ts`）的回归。
 *
 * 规格：`docs/superpowers/specs/2026-10-15-aggregate-gating-manual-order-design.md` §5.7
 *
 * ⚠️ 本文件的判据都打在**行为**上（调用次数、顺序、TTL 边界），而不是断言内部字段 ——
 *    内部结构（`TtlCache` 实例、槽）是实现细节，锁死它们会让重构变成假失败。
 */
import { describe, expect, it } from 'vitest'
import { createBalanceCache, createBalanceRefresher, type BalanceReading } from '../../src/balance-cache.js'

/** 造一个可控时钟 + 可数调用次数的世界。 */
function makeWorld(options: {
  ttlMs?: number
  failureTtlMs?: number
  fetch?: (provider: string, entry: { id: string }) => Promise<unknown>
  isAbort?: (error: unknown) => boolean
} = {}) {
  let clock = 1_000_000
  const calls: string[] = []
  const cache = createBalanceCache({
    ttlMs: options.ttlMs ?? 120_000,
    ...options.failureTtlMs === undefined ? {} : { failureTtlMs: options.failureTtlMs },
    ...options.isAbort === undefined ? {} : { isAbort: options.isAbort },
    now: () => clock,
    fetch: options.fetch ?? (async (provider: string, entry: { id: string }) => {
      calls.push(`${provider}:${entry.id}`)
      return { provider, id: entry.id, balance: 42 }
    }),
  })
  return {
    cache,
    calls,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
  }
}

const acct = (id: string) => ({ id })

describe('createBalanceCache：TTL 命中与回源', () => {
  it('★ 同一账号 TTL 内只回源一次（第二次 read 不调 fetch）', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('buddy', [acct('a1')])
    expect(calls).toEqual(['buddy:a1'])
  })

  /**
   * ★ TTL 内命中新鲜值；跨过 TTL 之后**改走兼顶**（读路径不回源）。
   *
   * ## ⚠️⚠️ 本条的语义在「读路径不再发后台重取」那次修复里**变了**，如实登记
   *
   * 原断言是「超过 TTL 必须重取」（`calls` 长度 2）。它现在**必然失败**，而且
   * **这是该修复的直接后果、不是新缺陷**：读路径陈旧命中被改成**一个请求都不发**
   * （并发重叠回归，见文件末尾那条守卫）⇒ 跨过 TTL 后 `read` 返回旧值 + `stale: true`，
   * `calls` 恒为 1。
   *
   * ⇒ 「终将重新取数」这条**更强**的不变量，职责已移交给 **Task 2 的后台刷新器**
   *   （尚未实现）。⚠️ **本仓库还有一个已登记的缺口（Important-2，控制方明确
   *   留给后续）**：`getServingStale` 目前**根本没有读 `staleTtlMs`** ⇒ 陈旧值事实上
   *   会被**无限期**供应。所以本条**不再**锁「终将重取」，它只锁下面这两格。
   *
   * ⚠️ 因此这条用例比修复前**弱**：它锁住「TTL 内绝不回源」+「跨 TTL 改走兼顶并
   *   如实标注 stale」，但**不再**防「永久钉住」。要恢复那条更强的不变量，必须等
   *   Task 2 的刷新器（或兼顶上界的实现），届时本条要重新加断言。
   */
  it('★ TTL 内命中新鲜值；跨过 TTL 改走兼顶（标 stale、不回源）', async () => {
    const { cache, calls, advance } = makeWorld({ ttlMs: 120_000 })
    await cache.read('buddy', [acct('a1')])
    expect(calls, '首次必须回源').toHaveLength(1)

    advance(119_999)
    const fresh = await cache.read('buddy', [acct('a1')])
    expect(calls, '★ TTL 内绝不回源').toHaveLength(1)
    expect(fresh.get('a1')!.stale, '★ TTL 内是新鲜值（不得标 stale）').not.toBe(true)

    advance(2)
    const stale = await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 跨过 TTL 也不回源（读路径零请求；重取归 Task 2 的后台刷新器）').toHaveLength(1)
    expect(stale.get('a1')!.stale, '★★ 跨过 TTL 必须标 stale（用户要看到「数据来自 HH:MM」）').toBe(true)
    expect(stale.get('a1')!.value, '★ 值仍是上一次的读数').toEqual({ provider: 'buddy', id: 'a1', balance: 42 })
  })

  it('★ 不同渠道的同名 accountId 是**两条**缓存（键必须含 provider）', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    expect(calls).toEqual(['buddy:a1', 'workbuddy:a1'])
  })

  it('★ force: true 绕过缓存（面板「刷新」的语义）', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('buddy', [acct('a1')], { force: true })
    expect(calls, '★ 显式刷新必须真重查').toHaveLength(2)
  })

  it('★★ force 只影响**这一次**读取，**不作废**其它消费者的读数', async () => {
    // ⚠️⚠️ 这条锁的是本模块的**核心价值**（用户 2026-10-15 的更正）：积分面板
    //    「刷新」不该顺手把用量徽标正在用的读数也作废 —— 两者**共享**这份缓存。
    //    若实现把 force 写成 `clear()` + `get()`（一个很自然的错误走法），
    //    那么「面板点刷新 ⇒ 徽标下一轮也重查」⇒ 上游请求量翻倍。
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('buddy', [acct('a1')], { force: true })
    expect(calls).toHaveLength(2)   // 本次确实重查了
    // ★ 但缓存里已是**新的**读数 ⇒ 紧接着的普通读取必须命中它（不再回源）。
    await cache.read('buddy', [acct('a1')])
    expect(calls, '★ force 不得把缓存清成空的（否则每个消费者都要重查）').toHaveLength(2)
  })

  it('★ 只读本次传入的账号（取舍在调用方，不在缓存）', async () => {
    const { cache, calls } = makeWorld()
    const all = [acct('a1'), acct('a2')]
    await cache.read('buddy', all)
    // 徽标只要启用账号：只传 a1 ⇒ 不得因为 a2 在别处被读过就把它带回来。
    const only1 = await cache.read('buddy', [acct('a1')])
    expect([...only1.keys()]).toEqual(['a1'])
    expect(calls).toEqual(['buddy:a1', 'buddy:a2'])
  })

  it('★ 畸形条目（缺 id）被跳过，不让整次读取失败', async () => {
    const { cache } = makeWorld()
    const result = await cache.read('buddy', [acct('a1'), { id: undefined } as never, null as never])
    expect([...result.keys()]).toEqual(['a1'])
  })
})

describe('createBalanceCache：失败读数（值而非抛错）', () => {
  const failing = () => {
    let fail = true
    const world = makeWorld({
      failureTtlMs: 15_000,
      fetch: async (provider: string, entry: { id: string }) => {
        world.calls.push(`${provider}:${entry.id}`)
        if (fail) throw new Error('上游 503')
        return { ok: true }
      },
    })
    return { ...world, recover: () => { fail = false } }
  }

  it('★ 失败被表达为**读数**（带 error），不是抛错', async () => {
    const { cache } = failing()
    const result = await cache.read('buddy', [acct('a1')])
    const reading = result.get('a1') as BalanceReading
    expect(reading.error).toContain('503')
    expect(reading.value).toBeUndefined()
  })

  it('★ 失败按 failureTtlMs 缓存 ⇒ 一次抖动不会被反复重试（但很快能自愈）', async () => {
    const { cache, calls, advance, recover } = failing()
    await cache.read('buddy', [acct('a1')])
    expect(calls).toHaveLength(1)
    advance(14_999)
    await cache.read('buddy', [acct('a1')])
    expect(calls, 'failureTtlMs 内不重试').toHaveLength(1)
    advance(2)
    recover()
    const result = await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 失败 TTL 一过就要重试').toHaveLength(2)
    expect((result.get('a1') as BalanceReading).error, '★ 自愈后不得再报错').toBeUndefined()
  })

  it('★ 一个账号失败不影响同批其它账号的读数（逐账号独立）', async () => {
    const { cache } = makeWorld({
      fetch: async (_provider: string, entry: { id: string }) => {
        if (entry.id === 'bad') throw new Error('boom')
        return { id: entry.id }
      },
    })
    const result = await cache.read('buddy', [acct('bad'), acct('good')])
    expect(result.get('bad')!.error).toBeDefined()
    expect(result.get('good')!.error).toBeUndefined()
    expect(result.get('good')!.value).toEqual({ id: 'good' })
  })

  it('★★ 失败读数**不得**用成功的 TTL（否则一次抖动锁死两分钟）', async () => {
    const { cache, calls, advance } = makeWorld({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      fetch: async (provider: string, entry: { id: string }) => {
        // ⚠️ 自建 fetch **必须自己记录**（`makeWorld` 只在缺省 fetch 里记）——
        //    我第一版漏了这行，用例看到的是空数组，失败原因看着像实现错了。
        calls.push(`${provider}:${entry.id}`)
        throw new Error('down')
      },
    })
    await cache.read('buddy', [acct('a1')])
    advance(16_000)
    await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 16 秒后必须已能重试（若用了 120 秒 TTL 这里会是 1）').toHaveLength(2)
  })
})

describe('createBalanceCache：取数顺序必须是串行', () => {
  it('★★ 双账号**顺序**执行（并发会在同一时刻有两个在飞）', async () => {
    // ⚠️⚠️ 单账号时「串行」与「并发」**不可区分** ⇒ 必须用两个账号，并记录
    //    「进入 / 退出」的时刻序。判据照 `credits-balance-self-heal.spec.ts` 的同款理由。
    let inflight = 0
    let maxInflight = 0
    const order: string[] = []
    const { cache } = makeWorld({
      fetch: async (_provider: string, entry: { id: string }) => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        order.push(`start:${entry.id}`)
        // 让出事件循环（若实现并发，第二个会在这里插进来）
        await new Promise((resolve) => setTimeout(resolve, 0))
        order.push(`end:${entry.id}`)
        inflight -= 1
        return { id: entry.id }
      },
    })
    await cache.read('buddy', [acct('a1'), acct('a2')])
    expect(maxInflight, '★ 同一时刻最多一个在飞（不得 Promise.all）').toBe(1)
    expect(order, '★ 必须逐个跑完再跑下一个').toEqual([
      'start:a1', 'end:a1', 'start:a2', 'end:a2',
    ])
  })
})

describe('createBalanceCache：中止必须原样逃逸（铁律的第四种形态）', () => {
  it('★★ fetch 抛 AbortError ⇒ read() 原样上抛（不得记成 error 读数）', async () => {
    // ⚠️ 若被记成读数：撤回请求的用户会看到「余额查询失败」（静默把取消伪装成故障），
    //    而且失败 TTL 15 秒 ⇒ 下一轮**再打一次**上游（取消本该立刻停下）。
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { cache, calls } = makeWorld({
      fetch: async () => { throw abort },
    })
    await expect(cache.read('buddy', [acct('a1')])).rejects.toThrow(/aborted/)
    expect(calls, '本用例的 fetch 不记录 calls（它抛错）').toEqual([])
  })

  it('★ 中止**不写缓存**（TtlCache 的「抛错不缓存」）⇒ 下一次会重试', async () => {
    let fail = true
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { cache, calls } = makeWorld({
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        if (fail) throw abort
        return { ok: true }
      },
    })
    await expect(cache.read('buddy', [acct('a1')])).rejects.toThrow()
    fail = false
    const result = await cache.read('buddy', [acct('a1')])
    expect(calls, '★ 中止不得留下任何缓存条目').toHaveLength(2)
    expect(result.get('a1')!.error).toBeUndefined()
  })

  it('★ 中止在**批中间**：前面的账号已入缓存，后面的不再尝试', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { cache, calls } = makeWorld({
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        if (entry.id === 'a2') throw abort
        return { id: entry.id }
      },
    })
    await expect(cache.read('buddy', [acct('a1'), acct('a2'), acct('a3')])).rejects.toThrow()
    expect(calls, '★ 不得继续尝试 a3').toEqual(['buddy:a1', 'buddy:a2'])
    // a1 的读数真的进了缓存（「本次上游填充会跑完，不浪费」）。
    expect(cache.peek('buddy', 'a1')?.value).toEqual({ id: 'a1' })
  })

  it('★ 注入的 isAbort 被真的用上（不是只声明）', async () => {
    // ⚠️ 上游有多种中止形状（`code: 'ABORTED'`、499 报文）。本模块**不**自带那套判据
    //（避免第 5 份同义实现），而是注入 —— 本用例锁「注入的判据真的生效」。
    const weird = Object.assign(new Error('provider: client has aborted request HTTP_499'), { code: 'ABORTED' })
    const { cache } = makeWorld({
      fetch: async () => { throw weird },
      isAbort: (error) => (error as { code?: string }).code === 'ABORTED',
    })
    await expect(cache.read('buddy', [acct('a1')])).rejects.toThrow(/499/)
  })

  it('★ 缺省 isAbort 只认 AbortError（保守）⇒ 其它错误仍是失败读数', async () => {
    const { cache } = makeWorld({ fetch: async () => { throw new Error('普通网络错') } })
    const result = await cache.read('buddy', [acct('a1')])
    expect(result.get('a1')!.error).toContain('普通网络错')
  })
})

describe('createBalanceCache：peek 与 clear', () => {
  it('★ peek 是同步零网络读；未知键 / 未读过的账号 ⇒ undefined', async () => {
    const { cache, calls } = makeWorld()
    expect(cache.peek('buddy', 'a1')).toBeUndefined()
    expect(calls, '★ peek 不得触发取数').toEqual([])
    await cache.read('buddy', [acct('a1')])
    expect(cache.peek('buddy', 'a1')?.value).toEqual({ provider: 'buddy', id: 'a1', balance: 42 })
    // 不同渠道的同一个 id 互不干扰
    expect(cache.peek('workbuddy', 'a1')).toBeUndefined()
  })

  it('★ peek 过期后返回 undefined（与 get 的 TTL 判据同源，不是第二套）', async () => {
    const { cache, advance } = makeWorld({ ttlMs: 1000 })
    await cache.read('buddy', [acct('a1')])
    advance(1001)
    expect(cache.peek('buddy', 'a1')).toBeUndefined()
  })

  it('★ clear(provider) 只清该渠道', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    cache.clear('buddy')
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    expect(calls, 'buddy 被清（重查）、workbuddy 未清（命中）').toEqual([
      'buddy:a1', 'workbuddy:a1', 'buddy:a1',
    ])
  })

  it('★ clear() 清全部', async () => {
    const { cache, calls } = makeWorld()
    await cache.read('buddy', [acct('a1')])
    await cache.read('workbuddy', [acct('a1')])
    cache.clear()
    expect(cache.peek('buddy', 'a1')).toBeUndefined()
    expect(cache.peek('workbuddy', 'a1')).toBeUndefined()
    await cache.read('buddy', [acct('a1')])
    expect(calls).toHaveLength(3)
  })

  it('★ clear 后仍可正常工作（不得把实例弄坏）', async () => {
    const { cache } = makeWorld()
    cache.clear('buddy')      // 清一个从没读过的渠道
    cache.clear()
    const result = await cache.read('buddy', [acct('a1')])
    expect(result.get('a1')!.error).toBeUndefined()
  })
})

describe('createBalanceCache：在飞去重（并发读取同一账号只回源一次）', () => {
  it('★ 两个并发 read 对同一账号共用同一次取数', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined
    const { cache, calls } = makeWorld({
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return await new Promise((resolve) => { resolveFetch = resolve })
      },
    })
    const first = cache.read('buddy', [acct('a1')])
    const second = cache.read('buddy', [acct('a1')])
    // 让两次 read 都跑到 load（await 一个 tick）
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveFetch?.({ ok: true })
    await Promise.all([first, second])
    expect(calls, '★ 在飞去重：并发只发一次').toHaveLength(1)
  })
})

/**
 * ★★ 陈旧兼顶（`readStale`）—— 用户 2026-10-16 的明确要求：
 * 「用底层缓存；加载如果得不到新数据，应该读出旧数据，不能直接返回错误
 * （除非旧数据也没有）」。
 *
 * ⚠️ 判据打在**返回值**上（value / stale / error / 复取次数），不打内部字段。
 */
describe('★★ readStale：拿不到新数据就回落旧数据（用户 2026-10-16）', () => {
  /** 建一个「先成功、后失败」的世界。 */
  function flakyWorld(overrides: { staleTtlMs?: number } = {}) {
    let clock = 1_000_000
    const calls: string[] = []
    let fail = false
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      ...overrides.staleTtlMs === undefined ? {} : { staleTtlMs: overrides.staleTtlMs },
      now: () => clock,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        if (fail) throw new Error('上游超时')
        return { provider, id: entry.id, balance: 42 }
      },
    })
    return {
      cache,
      calls,
      advance: (ms: number) => { clock += ms },
      now: () => clock,
      breakIt: () => { fail = true },
      // ⚠️ 上游**恢复**（审计 P1-2 的反向对照用例需要：没有它，
      //    「stale 标注保留」那条可能因「stale 恒为 true」而恒绿）。
      heal: () => { fail = false },
    }
  }

  it('★★ 首次取数成功 ⇒ 原样返回，`stale` 为 false', async () => {
    const { cache } = flakyWorld()
    const reading = await cache.readStale('loomy', 'a1', { credential: {} })
    expect(reading.value, '★ 本次成功就用新值').toEqual({ provider: 'loomy', id: 'a1', balance: 42 })
    expect(reading.stale, '★ 本次成功不得标陈旧').toBe(false)
    expect(reading.error).toBeUndefined()
  })

  it('★★ 过期后取数失败 ⇒ 返回**旧值** + stale:true + 本次失败原因', async () => {
    const world = flakyWorld()
    const first = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(first.stale).toBe(false)

    // 过期（跨过 120s TTL）且上游开始失败
    world.advance(130_000)
    world.breakIt()
    const second = await world.cache.readStale('loomy', 'a1', { credential: {} })

    // ★ 核心断言：拿回的是**旧值**，不是错误
    expect(second.value, '★★ 取数失败必须回落旧值而不是报错').toEqual(first.value)
    expect(second.stale, '★★ 回落值必须标陈旧').toBe(true)
    // 失败原因**仍然如实带回**（供 UI 显示「本次查询失败」）
    expect(second.error, '★ 本次失败原因不得丢').toContain('上游超时')
    // 陈旧值的时间戳是**当初**取到的时刻，不是现在
    expect(second.at, '★ 陈旧值的 at 是当初取数的时刻').toBe(first.at)
  })

  it('★★ 没有旧数据可回落 ⇒ 仍如实报错（用户原话的「除非旧数据也没有」）', async () => {
    const world = flakyWorld()
    world.breakIt()
    const reading = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(reading.value, '★ 无旧值可兼顶 ⇒ 不得编造').toBeUndefined()
    expect(reading.error).toBeDefined()
    expect(reading.stale).toBe(true)
  })

  it('★★ 兼顶失败**不得**让旧值消失（下一轮还能顶）', async () => {
    // ⚠⚠️ 这是本实现最容易写错的一格：`get()` 失败时会把失败读数写进唯一的槽位
    //    ⇒ 若不回滚，下一轮兼顶时 `previous` 已经是失败读数 ⇒ 兼顶能力**只活一轮**。
    const world = flakyWorld()
    await world.cache.readStale('loomy', 'a1', { credential: {} })
    world.advance(130_000)
    world.breakIt()

    const second = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(second.value, '第一轮兼顶').toBeDefined()
    // ⚠️ 必须**再**推进时间，让失败读数的短 TTL 也过期——否则第二轮会命中
    //    失败读数的缓存，测不到「回滚是否真的保住了旧值」。
    world.advance(130_000)
    const third = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(third.value, '★★ 兼顶能力必须持续有效，不得只活一轮').toBeDefined()
    expect(third.stale).toBe(true)
    // 时间戳仍是**最初**那次成功的时刻（旧值一直被覆盖）
    expect(third.at, '★ 旧值没被失败读数顶掉').toBe(second.at)
  })

  /**
   * ★★ **陈旧标注不得在第二次读取时消失**（2026-10-16 审计 P1-2，实测复现的真缺陷）。
   *
   * ## 缺陷形态
   *
   * `readStale` 兼顶成功时**回滚写入** `{ at: 旧时刻, value: 旧值 }` 保住兼顶能力。
   * 那条读数**不带 `error`** ⇒ 被 `ttlFor` 判成**成功读数** ⇒ 落盘 120 秒 TTL
   * ⇒ 紧接着再打开一次面板时 `get()` 在 TTL 内**直接命中、不回源**
   * ⇒ 返回 `{ stale: false }`、「本次查询失败」标注凭空消失。
   *
   * ⇒ 用户第一次看到「本次查询失败，显示的是 HH:MM 的数据」，第二次看到一条
   *   **看起来完全正常**的余额，会据此认为「上游已恢复」—— 而上游还挂着。
   *
   * ⚠️ **为什么上面那条用例抓不到**：它只断言 `third.value` 非空，
   *   **从不断言 `stale` 的语义** ⇒ 回滚丢标注时它照样全绿（恒绿漏洞）。
   */
  it('★★ 上游仍失败时，第二次读取**仍须**标 stale（标注不得消失）', async () => {
    const world = flakyWorld()
    await world.cache.readStale('loomy', 'a1', { credential: {} })
    world.advance(130_000)
    world.breakIt()

    const second = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(second.stale, '第一次兼顶须标 stale').toBe(true)

    // ⚠️ **不推进时间**：这一轮要测的正是「回滚值落盘后、下次读取是否还标 stale」。
    //   若推进超过 120 秒 TTL，会回源并重新兼顶，`stale` 自然为 true ——
    //   那样测的就不是这个缺陷了（我第一版就犯了这个错，靠变异验证才发现）。
    const third = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(third.stale, '★★ 陈旧标注不得在第二次读取时消失').toBe(true)
    expect(third.error, '★★ 且必须仍带失败原因（UI 要显示「本次查询失败」）').toBeDefined()
    expect(third.value, '★ 值仍是旧值').toBeDefined()
  })

  it('★★ 上游**恢复**后不再标 stale（别把陈旧标注永远钉住）', async () => {
    // ⚠️ **反向对照**：没有这条，上面那条可能是因为「stale 恒为 true」而全绿。
    const world = flakyWorld()
    await world.cache.readStale('loomy', 'a1', { credential: {} })
    world.advance(130_000)
    world.breakIt()
    await world.cache.readStale('loomy', 'a1', { credential: {} })

    // 上游恢复，且跨过回滚值的 120s TTL ⇒ 必定回源成功
    world.heal()
    world.advance(130_000)
    const after = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(after.stale, '★ 上游恢复后不得继续标 stale').toBe(false)
    expect(after.error).toBeUndefined()
  })

  /**
   * ★★ **并发 `readStale` 时每个调用方都必须拿到兼顶值**
   * （2026-10-16 对抗审计 P2，实测复现）。
   *
   * ## 缺陷形态
   *
   * 初版兼顶靠 `peekStale()` 读 `TtlCache` 槽位 + 失败后**回滚写入**。
   * 顺序调用下能工作，但**并发**下失效：第一个把失败读数写进槽位后，
   * 第二个的 `previous` 已经是那条失败读数 ⇒ 拿不到旧值。
   *
   * 实测（对照提交原文）：`x` 拿到兼顶值、`y` 拿到 `undefined`。
   * ⇒ 生产路径复刻显示：面板轮询与对话请求并发时，**面板显示有余额、
   *   选号器同时报「余额查询失败」** —— 正是 IKMCOO 要消灭的那个矛盾。
   *
   * ⚠️ **探针写法要当心**：我第一版探针让 `fetch` **每次都抛**，
   *   于是压根没有旧成功值 ⇒ 测到的是「本来就没有兼顶」，假绿/假红都可能出现。
   *   必须「先成功一次制造旧值，再让上游失败」。
   */
  it('★★ 并发两个 readStale ⇒ 两者都拿到兼顶值', async () => {
    let clock = 1_000_000
    let broken = false
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async () => {
        // ⚠️ 真实取数有网络耗时 ⇒ 制造「peek 与 set 之间」的窗口
        await new Promise((resolve) => setTimeout(resolve, 10))
        if (broken) throw new Error('上游超时')
        return { n: 1 }
      },
    })

    // ① 先成功一次，制造「可兼顶的旧值」
    await cache.readStale('loomy', 'a1', { credential: {} })
    // ② TTL 过期 + 上游开始失败
    clock += 130_000
    broken = true

    // ③ 两个并发（面板轮询 + 对话请求撞在一起）
    const [x, y] = await Promise.all([
      cache.readStale('loomy', 'a1', { credential: {} }),
      cache.readStale('loomy', 'a1', { credential: {} }),
    ])

    expect(x.value, '★ 第一个并发者须拿到兼顶值').toBeDefined()
    expect(
      y.value,
      '★★ 并发时**每个**调用方都必须拿到兼顶值（否则面板与选号器结论矛盾）',
    ).toBeDefined()
    expect(y.stale, '★ 兼顶值须标 stale').toBe(true)
  })

  /**
   * ★★ **`write` 回写的成功读数也必须成为兼顶来源**
   * （2026-10-16 对抗审计 P2 衍生）。
   *
   * `credits.balances` 端点走的是 **`write`**（它自己取数后回写），**不**走
   * `readStale` ⇒ 若 `write` 不更新兼顶表，则「只有面板查过的账号」才可能兼顶，
   * 而**选号器 / 聚合侧**的 `readStale` 会读到 `undefined` —— 那正是
   * IKMCOO 要消灭的「面板有、请求无」。
   */
  it('★★ write 回写的读数也能被 readStale 兼顶', async () => {
    let clock = 1_000_000
    let broken = false
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async () => {
        if (broken) throw new Error('上游超时')
        return { viaWrite: true }
      },
    })

    // ① 端点回写（模拟 `credits.balances` 取数后 writeBalance）
    cache.write('loomy', 'a1', { at: clock, value: { viaWrite: true } })
    // ② 过期 + 上游失败 ⇒ 选号器侧的 readStale 必须能兼顶到那条值
    clock += 130_000
    broken = true
    const reading = await cache.readStale('loomy', 'a1', { credential: {} })

    expect(
      reading.value,
      '★★ write 回写的读数必须成为兼顶来源（否则选号器读不到面板查过的值）',
    ).toEqual({ viaWrite: true })
    expect(reading.stale).toBe(true)
  })

  /**
   * ★★ **`read` / `readOne` 取到的成功读数**也必须能兼顶
   * （2026-10-16 对抗审计 P2 的衍生缺口，**由全量测试实测暴露**）。
   *
   * `credits.balances` 走 `write`、聚合折算走 `readOne`、面板可能走 `read` ——
   * 三条路径**都必须**成为兼顶来源。缺任何一条，那个渠道就兼顶不到值 ⇒
   * 面板与选号器结论矛盾（IKMCOO 的核心症状）原样复现。
   *
   * ⚠️ 这条是**真被测出来的**：我最初只在 `write` 与 `readStale` 里记账，
   *   全量测试里那条「兼顶读数 ⇒ 回传旧值」的用例（经 `cache.read` 预热）
   *   **当场变红** ⇒ 缺口属实，不是理论担忧。
   */
  it('★★ read / readOne 取到的读数同样能兼顶（三条路径都必须）', async () => {
    let clock = 1_000_000
    let broken = false
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async () => {
        if (broken) throw new Error('上游超时')
        return { via: 'read' }
      },
    })

    // ① 经 `read` 取一次成功
    await cache.read('loomy', [{ id: 'a1' }])
    // ② 经 `readOne` 取另一个账号的成功
    await cache.readOne('loomy', 'a2', { credential: {} })

    // ③ 过期 + 上游失败 ⇒ 两者都必须能兼顶
    clock += 130_000
    broken = true
    const viaRead = await cache.readStale('loomy', 'a1', { credential: {} })
    const viaReadOne = await cache.readStale('loomy', 'a2', { credential: {} })

    expect(viaRead.value, '★★ read 取到的读数必须能兼顶').toEqual({ via: 'read' })
    expect(viaReadOne.value, '★★ readOne 取到的读数必须能兼顶').toEqual({ via: 'read' })
    expect(viaRead.stale, '★ 须标 stale').toBe(true)
    expect(viaReadOne.stale, '★ 须标 stale').toBe(true)
  })

  it('★ clear 后兼顶值一并消失（账号删了不能还显示余额）', async () => {
    let clock = 1_000_000
    let broken = false
    const cache = createBalanceCache({
      ttlMs: 120_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async () => {
        if (broken) throw new Error('上游超时')
        return { n: 1 }
      },
    })
    await cache.readStale('loomy', 'a1', { credential: {} })
    clock += 130_000
    broken = true
    // ⚠️ 先确认「清之前确实能兼顶」，否则本条是恒真断言
    expect((await cache.readStale('loomy', 'a1', { credential: {} })).value,
      '★ 前提：clear 前能兼顶').toBeDefined()

    // ⚠️ **必须真的 clear**（我第一版漏了这一行 ⇒ 变异「不清兼顶表」实测全绿）。
    cache.clear('loomy')

    // ⚠️⚠️ clear 后**上游仍然失败**（`broken` 是闭包变量，clear 不重置它），
    //   所以这里若还能兼顶出旧值，就说明**兼顶表没被清掉** ——
    //   症状是「账号删了仍显示余额」，且**零报错**。
    const after = await cache.readStale('loomy', 'a1', { credential: {} })
    expect(
      after.value,
      '★ clear 后不得还能兼顶出旧值（否则账号删了仍显示余额，且零报错）',
    ).toBeUndefined()
    expect(after.error, '★ 无旧值可顶 ⇒ 如实报错').toBeDefined()
  })

  it('★★ 兼顶**有上界**：超龄的旧值不再使用（否则一次命中就永久生效）', async () => {
    // ⚠️⚠️ 时间轴必须同时跨过**两个**阈值，缺一个测的就不是兼顶：
    //   - `ttlMs`（120s）—— 不跨过它就**根本不会回源**，拿到的是新鲜缓存值，
    //     判据会假绿（我第一版只 advance 90s，实测打穿：拿到的是新鲜值而非旧值）；
    //   - `staleTtlMs`（60s）—— 这是本条真正要验的上界。
    const world = flakyWorld({ staleTtlMs: 60_000 })
    await world.cache.readStale('loomy', 'a1', { credential: {} })
    world.breakIt()
    world.advance(130_000)   // > 120s TTL（触发回源）且 > 60s 兼顶上界（触发超龄）
    const reading = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(reading.value, '★★ 超过兼顶上界后不得再用旧值').toBeUndefined()
    expect(reading.error, '★ 无值可兼顶 ⇒ 如实报错').toBeDefined()
  })

  it('★★ 兼顶**上界之内**仍可回落（证明上一条不是「永远不兼顶」）', async () => {
    // ⚠️ 这是上一条的**反向对照**：没有它，「兼顶上界」那条可能是因为
    //    兼顶功能压根没实现而全绿（恒真风险，见 AGENTS.md 的变异验证纪律）。
    const world = flakyWorld({ staleTtlMs: 600_000 })
    await world.cache.readStale('loomy', 'a1', { credential: {} })
    world.breakIt()
    world.advance(130_000)   // 跨过成功 TTL，但远未到 10 分钟兼顶上界
    const reading = await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(reading.value, '★ 上界内必须兼顶').toBeDefined()
    expect(reading.stale).toBe(true)
  })

  it('★ 兼顶**不重复打上游**：TTL 内再次 readStale 直接命中、不回源', async () => {
    const world = flakyWorld()
    await world.cache.readStale('loomy', 'a1', { credential: {} })
    const before = world.calls.length
    await world.cache.readStale('loomy', 'a1', { credential: {} })
    expect(world.calls.length, '★ TTL 内命中不得回源').toBe(before)
  })

  it('★★ 中止**不得**被兼顶吞掉（它不是「查不到」，是「被取消了」）', async () => {
    // ⚠️ 铁律（`balance-cache.ts` 模块头约束 1）：中止必须原样上抛。
    //   若 readStale 把中止也当成普通失败去顶旧值，用户点「取消」会看到
    //   一条「数据陈旧」的提示，而真正的取消信号消失。
    const cache = createBalanceCache({
      ttlMs: 120_000,
      isAbort: (error) => (error as { name?: unknown })?.name === 'AbortError',
      fetch: async () => { const e = new Error('取消'); e.name = 'AbortError'; throw e },
    })
    await expect(cache.readStale('loomy', 'a1', { credential: {} }))
      .rejects.toThrow('取消')
  })
})

/**
 * ★★ 读路径命中陈旧值**不等待网络**（本设计的核心不变量）。
 *
 * ## 缺陷形态
 *
 * `read` / `readOne` 走 `TtlCache.get()`，条目一过 `ttlMs` 就同步回源
 * ⇒ 切 provider 面板时用户必须等一次完整的上游往返（loomy 上限 60s）。
 */
describe('★★ 读路径：命中陈旧值立刻返回，不等网络', () => {
  /**
   * ⚠️ 造一个「fetch 卡住不返回」的世界，用来证明读路径没有 await 它。
   *
   * ⚠️ `unstick` 存在，但**只允许冷启动 / `force` 那几条真 await 取数的用例收尾**
   *   时调用 —— 它 resolve 的是「`read` 真的在等的那次取数」。**陈旧读不得调它**：
   *   调了就等于把「读路径发了后台请求」这条**已被判违规**的行为藏回测试里
   *   （恒绿漏洞）。
   */
  function stuckWorld() {
    let clock = 1_000_000
    const calls: string[] = []
    let release: ((value: unknown) => void) | undefined
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return await new Promise((resolve) => { release = resolve })
      },
    })
    return {
      cache,
      calls,
      advance: (ms: number) => { clock += ms },
      unstick: () => { release?.({ provider: 'loomy', id: 'a1', balance: 42 }) },
    }
  }

  it('★★ read 命中陈旧值时**不等** fetch（fetch 不 resolve 也要返回）', async () => {
    const world = stuckWorld()
    // ① 先成功一次，制造旧值（这次是真的 await ⇒ 需要 unstick）
    const first = world.cache.read('loomy', [acct('a1')])
    await new Promise((resolve) => setTimeout(resolve, 0))
    world.unstick()
    await first
    const before = world.calls.length

    // ② 让它过期
    world.advance(130_000)
    const second = world.cache.read('loomy', [acct('a1')])
    // ⚠️ 只让出一个 tick：若实现仍在 await fetch，这里会超时/悬挂
    const reading = (await Promise.race([
      second,
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 50)),
    ])) as Map<string, BalanceReading> | string

    expect(reading, '★★ read 必须不等网络就返回（fetch 还没 resolve）').not.toBe('TIMEOUT')
    const row = (reading as Map<string, BalanceReading>).get('a1')!
    expect(row.value, '★★ 返回的是旧值而不是 undefined').toEqual({ provider: 'loomy', id: 'a1', balance: 42 })
    expect(row.stale, '★★ 兼顶值必须标 stale').toBe(true)
    // ⚠️ 这里**不能**断言「后台取数已发起」——读路径已明确不发起任何请求
    //   （并发重叠的回归，见文件末尾那条守卫）。
  })

  it('★★ readOne 同样不等网络', async () => {
    const world = stuckWorld()
    // ① 预热（真的 await ⇒ 需要 unstick）
    const first = world.cache.readOne('loomy', 'a1', { credential: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    world.unstick()
    await first
    const before = world.calls.length

    world.advance(130_000)
    const raced = await Promise.race([
      world.cache.readOne('loomy', 'a1', { credential: {} }),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 50)),
    ])
    expect(raced, '★★ readOne 必须不等网络').not.toBe('TIMEOUT')
    expect((raced as BalanceReading).stale, '★★ readOne 须标 stale').toBe(true)
    // ⚠️ 同上：陈旧读**不得**调 `unstick()`，也**必须**零请求
    //   （若这里调了 unstick，测试就把违规行为藏起来了）。
    expect(world.calls.length, '★★ readOne 陈旧命中也不得发任何请求').toBe(before)
  })

  it('★ force:true 仍然同步等真实取数（不兼顶）', async () => {
    // ⚠️ 这是 Task 1 的**反向对照**：若实现把 force 也改成「返回旧值」，
    //    面板「刷新积分」会变成假按钮（仓库已因同类问题出过一次回归，
    //    见 jet-hub.js:3014 的注释「120 秒内点了等于没点，而按钮写着可刷新」）。
    const world = stuckWorld()
    const first = world.cache.read('loomy', [acct('a1')])
    await new Promise((resolve) => setTimeout(resolve, 0))
    world.unstick()
    await first
    world.advance(130_000)

    const forced = world.cache.read('loomy', [acct('a1')], { force: true })
    const raced = await Promise.race([
      forced,
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 50)),
    ])
    expect(raced, '★★ force 必须同步等真实取数').toBe('TIMEOUT')
    world.unstick()
    await forced
  })

  it('★ 没有旧值可兼顶时仍如实回源（冷启动不得返回 undefined）', async () => {
    // ⚠️ 这条锁住「兼顶不得取代真实取数能力」：从未读过的账号必须真去查，
    //    否则未接线的渠道会恒不可用（balance-cache.ts 既有约束）。
    const world = stuckWorld()
    const reading = world.cache.read('loomy', [acct('fresh')])
    const raced = await Promise.race([
      reading,
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 50)),
    ])
    expect(raced, '★ 冷启动必须真回源（不得凭空兼顶）').toBe('TIMEOUT')
    world.unstick()
    await reading
  })
})

/**
 * ★★ **陈旧读路径一个请求都不发**（模块头约束 2「逐账号串行」的真正守门人）。
 *
 * ## ⚠️ 为什么必须与上面那条「冷启动双账号串行」形状不同
 *
 * 既有那条用例（`describe('…取数顺序必须是串行')` 里的 `maxInflight === 1`）
 * 只跑**冷启动**路径：缓存为空 ⇒ 走真实回源 ⇒ `for…of` + `await` **天然串行**
 * ⇒ 它对陈旧命中路径**零覆盖**。
 *
 * ## 缺陷形态（实测确证）
 *
 * stale-while-revalidate 版本在陈旧命中时写了 `void cache.get().catch(() => {})`。
 * `read` 的 `for…of` 里 `await getServingStale(...)` 在陈旧命中时**立即 resolve**，
 * 但那个后台取数的 promise **仍在飞** ⇒ 循环随即进入下一个账号 ⇒
 * `a2` 的重取与 `a1` 的**重叠**。
 *
 * 实测：`maxInflight = 2`，`order = ["start:a1","start:a2","end:a1","end:a2"]`
 * （基线版本恒为 1）⇒ 用户症状「切 provider 面板时一次性向同一上游打出 N 个并发
 * 请求」⇒ 触发风控。
 *
 * ## 现在的不变量（本条用例锁的就是它）
 *
 * 读路径**彻底不发请求**，重取全部交给后台刷新器（Task 2，尚未实现）⇒
 * `maxInflight` 必须是 **0**，不是 1。
 *
 * ⚠️ **必须断言 `calls` 长度为 0，而不只是断言 `stale` 标记**：只断言 `stale: true`
 *   的话，「发了后台重取」这一支照样全绿（恒绿漏洞）。
 */
describe('★★ 陈旧读路径：read 一个请求都不发（并发重叠的回归守卫）', () => {
  it('★★ 两个陈旧账号的 read ⇒ fetch 零调用、零重叠、两行都标 stale', async () => {
    let clock = 1_000_000
    const calls: string[] = []
    let inflight = 0
    let maxInflight = 0
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        // 让出事件循环：**若**读路径发后台重取，第二个会在这里插进来
        await new Promise((resolve) => setTimeout(resolve, 0))
        inflight -= 1
        return { provider, id: entry.id, balance: 42 }
      },
    })

    // ① 冷启动：两次真实回源 ⇒ 天然串行（顺带确认探针本身能测出并发）
    await cache.read('loomy', [acct('a1'), acct('a2')])
    expect(calls, '前提：冷启动真的各回源一次').toEqual(['loomy:a1', 'loomy:a2'])
    expect(maxInflight, '前提：冷启动路径本身是串行的').toBe(1)

    // ② 跨过 TTL，让两个账号同时变成陈旧
    clock += 130_000
    calls.length = 0
    maxInflight = 0

    // ③ 陈旧读两个账号
    const result = await cache.read('loomy', [acct('a1'), acct('a2')])

    // ★★★ 核心断言：一个请求都不许发
    expect(calls, '★★★ 陈旧读路径不得发起任何取数（否则相邻账号的后台重取会重叠）').toHaveLength(0)
    expect(maxInflight, '★★★ 同一时刻零个在飞（不是 1）').toBe(0)

    // ★ 两行都必须返回旧值并标 stale
    for (const id of ['a1', 'a2']) {
      const row = result.get(id) as BalanceReading
      expect(row.stale, `★★ ${id} 必须标 stale`).toBe(true)
      expect(row.value, `★★ ${id} 必须返回旧值而不是 undefined`).toEqual({ provider: 'loomy', id, balance: 42 })
    }
  })

  it('★★ readOne 的陈旧命中同样零请求（另一条读入口）', async () => {
    // ⚠️ `readOne` 与 `read` 共用 `getServingStale` ⇒ 同一个不变量必须在两条
    //    入口上都成立；只锁 `read` 的话，把 `readOne` 改回后台重取不会被发现。
    let clock = 1_000_000
    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return { provider, id: entry.id, balance: 42 }
      },
    })

    await cache.readOne('loomy', 'a1', { credential: {} })
    expect(calls, '前提：首次真的回源').toHaveLength(1)

    clock += 130_000
    calls.length = 0
    const reading = await cache.readOne('loomy', 'a1', { credential: {} })

    expect(calls, '★★ readOne 的陈旧命中也不得发请求').toHaveLength(0)
    expect(reading.stale, '★★ 须标 stale').toBe(true)
    expect(reading.value, '★★ 须返回旧值').toEqual({ provider: 'loomy', id: 'a1', balance: 42 })
  })
})

/**
 * ★★ 后台刷新器 —— 用户 2026-10-18：「后台的积分定期刷新，所有用积分和账号信息的
 * 都是通过调用这个缓存来的」。
 *
 * ## ⚠️ 它是上面那条「陈旧读路径零请求」守卫的**另一半**
 *
 * `a725101` 把读路径的后台重取整个删掉（实测 `maxInflight = 2` ⇒ 触发风控），
 * 代价是**没有任何东西会再取新数据** ⇒ 缓存会永远陈旧。本组补上「后台」那一半，
 * 而**串行铁律改由本组自己承担**（`maxInflight === 1`，两个账号才可区分）。
 *
 * ⚠️ 判据全部打在**行为**上（`fetch` 的调用序列 / 次数 / 时间戳），无源码文本断言。
 */
describe('★★ 刷新器：后台定时保鲜', () => {
  /** 造一个可控时钟 + 假定时器的世界。 */
  function refresherWorld(options: { staleTtlMs?: number; fail?: () => boolean } = {}) {
    let clock = 1_000_000
    const calls: string[] = []
    let armed: (() => void) | undefined
    /** 假定时器被**武装了几次**（`start()` 幂等性的行为判据）。 */
    let armCount = 0
    /** 上游是否失败（由用例用 `setFail` 切换；`options.fail` 是初始值）。 */
    let broken = options.fail?.() === true
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      ...options.staleTtlMs === undefined ? {} : { staleTtlMs: options.staleTtlMs },
      now: () => clock,
      fetch: async (provider: string, entry: { id: string; credential?: unknown }) => {
        calls.push(`${provider}:${entry.id}`)
        if (broken) throw new Error('上游 503')
        return { provider, id: entry.id, balance: 42 }
      },
    })
    const accounts = [
      { id: 'a-on', provider: 'loomy', nickname: 'on', enabled: true, credentialRef: 'R1' },
      { id: 'a-off', provider: 'loomy', nickname: 'off', enabled: false, credentialRef: 'R2' },
      { id: 'b-on', provider: 'trae', nickname: 'b', enabled: true, credentialRef: 'R3' },
    ]
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => accounts,
      // ⚠️ `resolveCredential` 必须**真被调用**才有牙（见下面「凭据腿」那条用例）。
      resolveCredential: async (ref: string) => ({ ref }),
      // ⚠️⚠️ **必须与缓存那份一起传**：刷新器有**自己的** `staleTtlMs` 缺省值
      //    （15 分钟），不同步就等于「停用账号 / 失败条目」那两条用例在按
      //    300 秒判、而实现按 900 秒判 ⇒ **恒假、恒绿**。
      ...options.staleTtlMs === undefined ? {} : { staleTtlMs: options.staleTtlMs },
      now: () => clock,
      // ⚠️ 假定时器：只捕获回调与武装次数，由用例自己推进。
      // ⚠️ 「已武装」必须读**刷新器自己的标志**而不是「回调是否被捕获」——
      //    注入的假定时器句柄停不掉（`clearImpl` 对注入分支是空操作，那是
      //    brief 指定的写法），否则测的只是替身的生命周期。
      setInterval: ((fn: () => void) => {
        armed = fn
        armCount += 1
        return { unref: () => {} }
      }) as never,
      intervalMs: 60_000,
    })
    return {
      cache,
      refresher,
      calls,
      advance: (ms: number) => { clock += ms },
      fire: async () => { await armed?.() },
      armCount: () => armCount,
      setFail: (v: boolean) => { broken = v },
      isArmed: () => refresher.isArmed(),
    }
  }

  it('★★ start() 真的武装了定时器', () => {
    const world = refresherWorld()
    expect(world.isArmed(), '★ start 前未武装').toBe(false)
    world.refresher.start()
    expect(world.isArmed(), '★★ start 后必须武装').toBe(true)
    world.refresher.stop()
    expect(world.isArmed(), '★ stop 后解除武装').toBe(false)
  })

  it('★★ start() **幂等**（重复武装不得让刷新频率翻倍）', () => {
    // ⚠️ 重复武装会**叠加** interval ⇒ 每轮刷新次数随启动次数线性增长。
    //    判据打在「武装次数」这个行为上（假定时器每被调一次就换一次句柄）。
    let armCount = 0
    const cache = createBalanceCache({ ttlMs: 120_000, fetch: async () => ({}) })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [],
      setInterval: (() => { armCount += 1; return { unref: () => {} } }) as never,
    })
    refresher.start()
    refresher.start()
    refresher.start()
    expect(armCount, '★★ start() 三次只许武装一次（否则频率翻三倍）').toBe(1)
    refresher.stop()
    refresher.start()
    expect(armCount, '★ stop 之后允许重新武装').toBe(2)
  })

  /**
   * ★★ `stop()` **必须真的停掉真定时器**（用全局 `setInterval` 那条分支）。
   *
   * ## ⚠️ 为什么这条不能省（`clearImpl` 分流的无牙登记）
   *
   * `clearImpl` 在**注入假定时器**的分支里是**空操作**（brief 指定的写法：句柄对不上）
   * ⇒ 本组其余用例**永远验不到它** ⇒ 把 `clearImpl(timer)` 整行删掉实测**全绿**。
   *
   * ⇒ 修法：这里**不注入** `setInterval`（走全局那条分支），让真实的 interval
   *    在测试里跑起来，再断言「stop 之后回调不再触发」。
   *
   * ⚠️ 用**极短**的周期（5ms）+ 真等待，保证一定观察到回调；并断言 stop 之后
   *    计数**不再增长**（不是「变慢」—— 那分不出是停了还是慢了）。
   */
  it('★★ stop() 真能停掉全局 interval（注入分支验不到的那条腿）', async () => {
    let ticks = 0
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => Date.now(),
      fetch: async () => ({}),
    })
    const refresher = createBalanceRefresher(cache, {
      // ⚠️ **不传 setInterval** ⇒ 走全局那条分支，`clearImpl` 才是真的 `clearInterval`。
      // ⚠️ `listAccounts` 被调几次 = 定时器回调跑了几次（读路径够不着它）。
      listAccounts: () => { ticks += 1; return [] },
      intervalMs: 5,
    })
    refresher.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const running = ticks
    expect(refresher.isArmed(), '★ 前提：已武装').toBe(true)

    refresher.stop()
    const atStop = ticks
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(
      ticks,
      '★★ stop() 之后定时器必须真的停下来（否则插件卸载后仍在上游打请求）',
    ).toBe(atStop)
    expect(refresher.isArmed(), '★ stop 后未武装').toBe(false)
    expect(running >= 1, `★ 前提：停之前确实跑过（实测 ${running} 次）`).toBe(true)
  })

  it('★★ 一轮刷新会把**所有 provider** 的启用账号刷一遍（用户要求「全部都这样处理」）', async () => {
    const world = refresherWorld()
    await world.refresher.tick()
    expect(world.calls.sort(), '★★ 刷新器不认 provider 特例').toEqual(['loomy:a-on', 'trae:b-on'])
  })

  /**
   * ★★ **周期内不刷**（省上游的那条腿）。
   *
   * ## ⚠️ 这条为什么必须有（实测无牙登记）
   *
   * 第一版**没有**这一格 ⇒ 把 `age >= periodMs` 改成恒真**实测全绿**。
   * 后果形态：刷新器每轮（60s）都把**全部**账号重取一遍，而共享缓存的 `ttlMs`
   * 是 120s ⇒ **上游请求量直接翻倍**（且与面板/徽标的读请求叠加）⇒ 触发风控。
   *
   * ⚠️ 时序必须卡在「已成功刷过一次、但距上次还不足一个周期」这个窗口里，
   *   且要**跨过缓存 TTL 的那一半**才有意义 —— 这里取 30s（> 0 且 < 60s 周期）。
   */
  it('★★ 距上次刷新**不足一个周期**时不刷（否则上游请求量翻倍）', async () => {
    const world = refresherWorld()
    await world.refresher.tick()
    expect(world.calls, '★ 前提：首轮各刷一次').toHaveLength(2)
    // ⚠️ 推进 30s：< 周期 60s ⇒ 读请求会命中缓存，不该再打上游。
    world.advance(30_000)
    await world.refresher.tick()
    expect(
      world.calls,
      '★★ 周期内的第二轮不得重取（读请求本来会命中，省一次上游）',
    ).toHaveLength(2)
    // ⚠️ 推到周期之后 ⇒ 这一轮**必须**刷（否则缓存永远不保鲜）。
    world.advance(31_000)
    await world.refresher.tick()
    expect(world.calls.length, '★★ 过周期后必须重取（常新）').toBe(4)
  })

  it('★★ 停用账号**低频**刷（首轮不刷，跨过 staleTtlMs 才刷）', async () => {
    const world = refresherWorld({ staleTtlMs: 300_000 })
    await world.refresher.tick()
    expect(world.calls, '★ 停用账号首轮不刷').toEqual(['loomy:a-on', 'trae:b-on'])
    world.advance(300_001)
    await world.refresher.tick()
    expect(world.calls, '★★ 停用账号到点必须被刷（否则重新启用时是死凭据）').toContain('loomy:a-off')
  })

  it('★★ 失败条目被**跳过**（否则每 15 秒打一次上游，比现状更糟）', async () => {
    const world = refresherWorld({ staleTtlMs: 300_000 })
    await world.refresher.tick()          // 成功
    world.advance(200_000)                 // 成功条目已过 TTL
    world.setFail(true)
    await world.refresher.tick()          // 这一轮失败
    const after = world.calls.length
    // ⚠️ 时序必须**远小于** `staleTtlMs`(300s)：此刻离上次刷过才 60s ⇒ 两条腿
    //    （`age >= staleTtlMs` 与 `lastFlushedAt` 兜底）都不成立 ⇒ 不该再刷。
    world.advance(60_000)
    await world.refresher.tick()
    expect(
      world.calls.length,
      '★★ 失败条目不得被反复重试（failureTtlMs 短档的语义就在这里）',
    ).toBe(after)
  })

  it('★★ 失败条目超过兼顶上界后**必须**被重试（不得永久卡在失败）', async () => {
    const world = refresherWorld({ staleTtlMs: 300_000 })
    await world.refresher.tick()
    world.advance(200_000)
    world.setFail(true)
    await world.refresher.tick()
    const after = world.calls.length
    world.advance(400_000)                 // > staleTtlMs，两条腿都成立
    await world.refresher.tick()
    expect(world.calls.length, '★★ 超兼顶上界后必须重试').toBeGreaterThan(after)
  })

  it('★★ 刷新**逐账号串行**（并发会触发风控）', async () => {
    // ⚠️ 必须用**两个**账号：单账号时串行与并行不可区分（仓库既有教训）。
    let inflight = 0
    let maxInflight = 0
    const order: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async (_p: string, entry: { id: string }) => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        order.push(`start:${entry.id}`)
        await new Promise((r) => setTimeout(r, 0))
        inflight -= 1
        order.push(`end:${entry.id}`)
        return { id: entry.id }
      },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' },
        { id: 'a2', provider: 'loomy', nickname: '2', enabled: true, credentialRef: 'R2' },
      ],
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: 60_000,
    })
    await refresher.tick()
    expect(maxInflight, '★★ 同一时刻最多一个在飞（不得 Promise.all）').toBe(1)
    // ⚠️ 顺序腿：串行时 a2 必须等到 a1 结束**之后**才开始。
    expect(order, '★★ 第二个账号不得与第一个重叠').toEqual(
      ['start:a1', 'end:a1', 'start:a2', 'end:a2'],
    )
  })

  /**
   * ★★ 防重入闸门（`running` 布尔）**必须有牙**。
   *
   * ## ⚠️ 为什么不能用「同一组账号连打两次 tick」（第一版的实测无牙）
   *
   * 那样即使把 `if (running)` 改成 `if (false)`，**实测全绿** ——
   * 第二轮照样对**同一批键**调 `refreshOne`，而 `TtlCache.get({force:true})` 的
   * **在飞去重**把两次并发的 `load` 合成一次 ⇒ `fetch` 仍只被调 2 次。
   * ⇒ 判据被缓存层的**去重**遮住了（守卫全绿 ≠ 守卫有牙）。
   *
   * ⇒ 正确形状：**两轮看到的是不同的账号集合**（去重管不到），
   * 再加 `async listAccounts` 让两轮必然交错。
   */
  it('★★ 重入时跳过本轮（两轮交错，账号集合不同 ⇒ 缓存去重遮不住）', async () => {
    const calls: string[] = []
    let accounts: { id: string; provider: string; nickname: string; enabled: boolean; credentialRef: string }[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      // ⚠️ 让出事件循环 ⇒ 两次 `tick` 必然在 `await` 处交错。
      fetch: async (p: string, e: { id: string }) => {
        calls.push(`${p}:${e.id}`)
        await new Promise((r) => setTimeout(r, 0))
        return {}
      },
    })
    const one = (id: string) => ({
      id, provider: 'loomy', nickname: id, enabled: true, credentialRef: `R-${id}`,
    })
    accounts = [one('a1')]
    const refresher = createBalanceRefresher(cache, {
      // ⚠️ 每被调一次换一批账号 ⇒ 两轮真的在做**不同**的工作。
      listAccounts: async () => accounts,
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
    })

    const first = refresher.tick()
    accounts = [one('b1'), one('b2')]
    const second = refresher.tick()
    await Promise.all([first, second])

    expect(
      calls.sort(),
      '★★ 第二轮必须被闸门挡下（否则两条账号会被一起刷，上游请求翻倍）',
    ).toEqual(['loomy:a1'])
  })
  it('★★ 失败条目超兼顶上界必须重试（独立验：单账号，计数不会被别的账号顶上去）', async () => {
    // ⚠️⚠️ 第一版**两条**都无牙，逐条实测记录：
    //   ① 原用例把时钟推 400_000 ⇒ **同时**满足「槽位年龄 ≥ staleTtlMs」与
    //     「距上次刷过 ≥ staleTtlMs」⇒ 删掉任一条腿都照样全绿。
    //   ② 我第一版的修补版改用**共享 helper**（三个账号、含一个停用账号）⇒
    //     停用账号那条「到点必刷」的腿在同一轮替它发了一次请求 ⇒
    //     	oBeGreaterThan(after) 被**旁路的请求顶起来** ⇒ 仍然全绿。
    // ⇒ 修法：**单账号、无停用账号** ⇒ 计数只能来自被测那条腿。
    let clock = 1_000_000
    let broken = false
    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 300_000,
      now: () => clock,
      fetch: async (p: string, e: { id: string }) => {
        calls.push(p + ":" + e.id)
        if (broken) throw new Error('上游 503')
        return {}
      },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' },
      ],
      // ⚠️ 必须与缓存那份**同步**：两边各有缺省值，不同步就是按 900s 判（恒绿）。
      staleTtlMs: 300_000,
      now: () => clock,
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: 60_000,
    })
    await refresher.tick()
    clock += 200_000
    broken = true
    await refresher.tick()                  // 失败读数写入槽位（at = 1_200_000）
    const after = calls.length

    // ⚠️ 推 200_000：槽位年龄 200_000 < 300_000（第一条腿不成立），
    //    距上次刷过 200_000 < 300_000（第二条腿也不成立）⇒ 本轮不该刷。
    clock += 200_000
    await refresher.tick()
    expect(calls.length, '★★ 两个窗口都没到 ⇒ 不得重试').toBe(after)

    // ⚠️ 再推 100_000：槽位年龄 300_000 ≥ 300_000 ⇒ 放行重试。
    // ⚠️ **如实登记：此刻两条腿同时成立**（槽位 `at` 与 `lastFlushedAt` 是同一轮写入的），
    //    所以本条**不能**单独证明第一条腿有牙 —— 真正让两条腿分开的形状在下一条。
    clock += 100_000
    await refresher.tick()
    expect(calls.length, '★★ 槽位年龄超上界后必须重试').toBe(after + 1)
  })

  /**
   * ★★ 失败读数由**别的路径**（`readStale`）写入时，到点仍必须被重试。
   *
   * ## ⚠️ 为什么这条形状与上面那条不同
   *
   * 上一条里刷新器**自己**写过失败读数 ⇒ 槽位 at 与 lastFlushedAt 同一轮写入
   * ⇒ 两条重试腿恒等价（实测：删掉任一条都全绿 ⇒ 已把那两条腿**合并成一条**
   * 槽位年龄判据，见 isDue 的注释）。
   *
   * 本条锁的是**另一条真实路径**：面板 / 选号器的 `readStale` 自己回源、
   * 自己把失败读数写进槽位，**刷新器完全不知情**（lastFlushedAt 里没有这条记录）
   * ⇒ 这时槽位年龄**仍然**在走（peekStale 永不丢弃条目）⇒ 到点必然重试。
   *
   * ⚠️ 若实现把失败条目**永久**跳过（不重试），用户会永远看着「查询失败」
   *   直到插件重启 —— 而这是**可观察**的（面板一直报失败）。
   */
  it('★★ 失败读数由 readStale 写入时，到点仍必须被重试（另一条真实路径）', async () => {
    let clock = 1_000_000
    let broken = false
    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 300_000,
      now: () => clock,
      fetch: async (p: string, e: { id: string }) => {
        calls.push(p + ':' + e.id)
        if (broken) throw new Error('上游 503')
        return {}
      },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' },
      ],
      staleTtlMs: 300_000,
      now: () => clock,
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: 60_000,
    })
    //    失败读数由 readStale（面板路径）写入槽位。
    broken = true
    await cache.readStale('loomy', 'a1', { credential: {} })
    const after = calls.length

    // ⚠️ 推 200_000：槽位年龄 200_000 < 300_000 ⇒ 本轮不该刷。
    clock += 200_000
    await refresher.tick()
    expect(calls.length, '★ 前提：未到上界 ⇒ 不刷').toBe(after)

    // ⚠️ 再推 100_000：槽位年龄 300_000 ≥ 300_000 ⇒ 必须重试。
    clock += 100_000
    await refresher.tick()
    expect(calls.length, '★★ readStale 写的失败读数到点后必须被重试').toBe(after + 1)
  })
  it('★ abort 不得让刷新器崩掉（异常已被消费）', async () => {
    const abort = new Error('取消')
    abort.name = 'AbortError'
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async () => { throw abort },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [{ id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' }],
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: 60_000,
    })
    await expect(refresher.tick()).resolves.toBeUndefined()
  })

  it('★★ 取数原语必须拿到**已解析的凭据**（否则生产每一轮都记成失败读数）', async () => {
    // ⚠️⚠️ 真实的缺陷形态：`fetchBalanceReading`（`src/index.ts`）在
    //    `entry.credential === undefined` 时直接抛「凭据未提供」⇒ 若刷新器传空
    //    entry，**每一轮都失败**，而外面看「刷新器在跑、只是读数总是失败」。
    const seen: (unknown | undefined)[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async (_p: string, entry: { credential?: unknown }) => {
        seen.push(entry.credential)
        return { ok: true }
      },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'LOOMY_ACCOUNT_X' },
      ],
      resolveCredential: async (ref: string) => ({ token: `凭据(${ref})` }),
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
    })
    await refresher.tick()
    expect(seen, '★★ 取数必须带上按 credentialRef 解析出来的凭据').toEqual([
      { token: '凭据(LOOMY_ACCOUNT_X)' },
    ])
  })

  it('★ 凭据解析失败时**跳过**该账号（不得把它记成失败读数打上上游）', async () => {
    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async (p: string, e: { id: string }) => { calls.push(`${p}:${e.id}`); return {} },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' },
      ],
      resolveCredential: async () => undefined,
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
    })
    await refresher.tick()
    expect(calls, '★ 解析不出凭据就不得打上游（必然失败，纯浪费）').toHaveLength(0)
  })

  it('★★ 一轮刷新之后读路径**不再陈旧**（这就是刷新器的全部意义）', async () => {
    // ⚠️⚠️ 本条是把上面「陈旧读路径零请求」守卫**补回来**的那格：
    //    `a725101` 之后缓存没有任何东西会重取（实测 `calls` 永远停在 1），
    //    而本条断言「刷新器跑过 ⇒ `read` 拿到的是**新鲜值**（`stale` 不为 true）」。
    let clock = 1_000_000
    let generation = 0
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async () => ({ balance: ++generation }),
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' },
      ],
      now: () => clock,
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: 60_000,
    })
    await cache.read('loomy', [acct('a1')])          // generation 1 落缓存
    clock += 130_000
    const stale = await cache.read('loomy', [acct('a1')])
    expect(stale.get('a1')!.stale, '★ 前提：刷新器介入前它确实是陈旧的').toBe(true)

    // 跨过一个刷新周期（60s）后跑一轮 ⇒ 条目已过周期，刷新器判「该刷」并取 generation 2
    clock += 61_000
    await refresher.tick()

    const fresh = await cache.read('loomy', [acct('a1')])
    expect(fresh.get('a1')!.stale, '★★ 刷新器跑过后读路径不得再供应陈旧值').not.toBe(true)
    expect(fresh.get('a1')!.value, '★★ 且必须是**刷新器取到的新值**').toEqual({ balance: 2 })

    // ⚠️ 再推进一个 TTL：**只有刷新器**能让它重新新鲜（读路径一个请求都不发），
    //    这正是 cache-aside 做不到、而刷新器要买的那半。
    clock += 130_000
    const before = await cache.read('loomy', [acct('a1')])
    expect(before.get('a1')!.stale, '★ 前提：过 TTL 后确实又陈旧了（读路径不重取）').toBe(true)

    clock += 61_000
    await refresher.tick()
    const keptFresh = await cache.read('loomy', [acct('a1')])
    expect(keptFresh.get('a1')!.stale, '★★ 刷新器在后台把缓存补新了（读路径不再供应陈旧值）').not.toBe(true)
    expect(keptFresh.get('a1')!.value, '★★ 新值来自刷新器的后台取数').toEqual({ balance: 3 })
  })

  /**
   * ★★ `peekStale` 的返回**形状**（刷新器全部判据的承重件）。
   *
   * ## ⚠️ 这条为什么必须存在（第一版的实测缺陷）
   *
   * `peekStale` 转发 `TtlCache.peekStale()?.value` ⇒ 返回的**就是** `BalanceReading`
   * 本体（顶层 `{ at, value, error? }`）。而刷新器初版按 `held.value.at` 读年龄
   * ⇒ `.at` 恒 `undefined` ⇒ `age` 恒 `NaN` ⇒ **两条年龄判据全恒假**
   * ⇒ 刷新器**一轮都不刷**、**零报错**、日志照打。
   *
   * ⚠️ 这就是「恒绿漏洞」的典型形态：**实现全对、判据全假**，测试若只断言
   * 「刷新器跑完了」就照样通过。本条把**形状**钉死，并额外钉住 `stale` 标记 ——
   * 转发 `.value` 时它会被丢掉，而签名承诺了它。
   */
  it('★★ peekStale 返回的是 BalanceReading 本体（顶层 `at`）+ `stale` 标记', async () => {
    let clock = 1_000_000
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => clock,
      fetch: async () => ({ balance: 42 }),
    })
    await cache.read('loomy', [acct('a1')])

    const fresh = cache.peekStale('loomy', 'a1')
    expect(fresh, '★★ 读过之后必须能拿到条目').toBeDefined()
    expect(fresh!.at, '★★ `at` 必须在**顶层**（不是 value.at，否则 age 恒 NaN）')
      .toBe(1_000_000)
    expect(fresh!.value, '★★ 上游原样返回值在 `value`').toEqual({ balance: 42 })
    expect(fresh!.stale, '★★ 新鲜条目标记必须是 false').toBe(false)

    clock += 130_000
    const stale = cache.peekStale('loomy', 'a1')
    expect(stale!.at, '★★ 过期条目**不丢弃**，`at` 仍是写入时刻').toBe(1_000_000)
    expect(stale!.stale, '★★ 过期条目标记必须是 true').toBe(true)

    expect(cache.peekStale('loomy', 'never-read'), '未知键返回 undefined').toBeUndefined()
  })

  it('★ 空账号池不得抛错（不得因空池拒绝武装）', async () => {
    const cache = createBalanceCache({ ttlMs: 120_000, fetch: async () => ({}) })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [],
      setInterval: (() => ({ unref: () => {} })) as never,
    })
    await expect(refresher.tick()).resolves.toBeUndefined()
    refresher.start()
    expect(refresher.isArmed(), '★★ 空池也必须武装（否则用户登录后要等下次插件启动）').toBe(true)
    refresher.stop()
  })

  it('★ listAccounts 返回 Promise 也吃（生产 `pool.listAllAccounts()` 是 async）', async () => {
    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async (p: string, e: { id: string }) => { calls.push(`${p}:${e.id}`); return {} },
    })
    const refresher = createBalanceRefresher(cache, {
      // ⚠️ 实测 `pool.listAllAccounts()` 是 **async**（`src/account-pool.ts:1308`）
      //    ⇒ 内部必须 `await`，不能把它当数组直接 `for…of`。
      // ⚠️ 两条账号：单账号时「遍历了空集」与「遍历了一个 Promise 的碎片」不可区分。
      listAccounts: async () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' },
        { id: 'a2', provider: 'trae', nickname: '2', enabled: true, credentialRef: 'R2' },
      ],
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
    })
    await refresher.tick()
    expect(calls.sort(), '★ Promise 返回值必须被 await 后再遍历').toEqual(['loomy:a1', 'trae:a2'])
  })

  it('★★ listAccounts 抛错**不得**让一轮停摆（定时器必须还活着）', async () => {
    // ⚠️ 缺陷形态：`setInterval` 的回调是 `void tick()` —— 一轮抛错在 Node 里会变成
    //    **未捕获的 promise 拒绝**（进程级崩溃），而它本该只是一次「这轮没刷成」。
    let boom = true
    const warns: string[] = []
    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async (p: string, e: { id: string }) => { calls.push(`${p}:${e.id}`); return {} },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => {
        if (boom) throw new Error('账号池未落盘')
        return [{ id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' }]
      },
      warn: (m) => warns.push(m),
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
    })
    await expect(refresher.tick(), '★★ 抛错不得逃出 tick').resolves.toBeUndefined()
    expect(warns.join('|'), '★★ 必须留下日志（否则故障完全静默）').toContain('账号池未落盘')

    // ⚠️ 自愈那一格：下一轮池子正常了 ⇒ 刷新必须恢复（闸门已复位）。
    boom = false
    await refresher.tick()
    expect(calls, '★★ 下一轮必须恢复刷新（running 闸门要复位）').toEqual(['loomy:a1'])
  })

  it('★★ abort 的一轮**不得**逃出 tick（后台没有调用方可通知）', async () => {
    const abort = new Error('取消')
    abort.name = 'AbortError'
    const warns: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async () => { throw abort },
    })
    const refresher = createBalanceRefresher(cache, {
      listAccounts: () => [
        { id: 'a1', provider: 'loomy', nickname: '1', enabled: true, credentialRef: 'R1' },
        { id: 'a2', provider: 'trae', nickname: '2', enabled: true, credentialRef: 'R2' },
      ],
      warn: (m) => warns.push(m),
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
    })
    // ⚠️ 两个账号：abort 是**抛错**（不是失败读数）⇒ 若不被吃掉，第一个账号就会
    //    中断整轮循环，第二个**永远轮不到**。
    await expect(refresher.tick()).resolves.toBeUndefined()
    expect(warns.length, '★★ abort 必须被记成一条日志而不是静默').toBe(2)
  })

  /**
   * ★★★ 畸形 `credentialRef` **不得**让整轮刷新全部作废（2026-10-18 复审 Important）。
   *
   * ## ⚠️ 缺陷形态（「一个坏账号毒死整轮」+ 措辞错误的 warn）
   *
   * 凭据解析原先**不在**逐账号的 `try` 内 ⇒ `credentialRef()` 对非法名**同步抛
   * `TypeError``，`ctx.credentials.resolve` 也可能 reject ⇒ 被**外层那个兜底**接住
   * ⇒ **排在坏账号后面的账号一个都轮不到**，而用户只看到一条文案为
   * 「读账号列表失败」的 warn（账号池读得好好的，坏的是某一个账号的凭据名）。
   *
   * ## ⚠️ 可达性（不是假想敌）
   *
   * `sanitizeAccounts`（`src/jet-hub-store.ts`）只校验 `credentialRef` 是非空字符串、
   * **不校验命名法**；账号池又可从**用户可编辑的备份**导入 ⇒ 一份手改备份就能造出
   * 该条目。⇒ 症状是本仓库最怕的形态：**功能整体死掉 + 只有一条措辞错误的 warn**。
   *
   * ## ⚠️ 判据打在**行为**上（源码文本断言在本仓库恒绿，见文件头）
   *
   * ① `fetch` 的**调用集合**：正常账号必须仍被刷到（判别「坏账号是否毒死了后面的人」）；
   * ② warn 的**内容**：必须有一条**指向真因**的日志（判别「诊断是否可用」）。
   * ⚠️ 两条**缺一不可**：只判①的话，把 warn 文案写回「读账号列表失败」仍全绿。
   */
  it('★★★ 畸形 credentialRef 只跳过它自己，后面的账号照刷，且 warn 指向真因', async () => {
    const calls: string[] = []
    const warns: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      now: () => 1_000_000,
      fetch: async (p: string, e: { id: string }) => { calls.push(`${p}:${e.id}`); return {} },
    })
    const refresher = createBalanceRefresher(cache, {
      // ⚠️ **坏账号排在第一个** ⇒ 它的异常会当场截断这一轮。
      //    只有「凭据解析在逐账号 try 内」才轮得到后面的好账号。
      listAccounts: () => [
        { id: 'bad-1', provider: 'loomy', nickname: '坏', enabled: true, credentialRef: 'bad name' },
        { id: 'good-1', provider: 'loomy', nickname: '好', enabled: true, credentialRef: 'R_OK' },
      ],
      // ⚠️ 复刻生产装配层的**第一行**：`credentialRef(name)` 对不匹配
      //    `/^[A-Za-z_][A-Za-z0-9_]*$/` 的名字**同步抛 `TypeError``。
      resolveCredential: async (ref: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
          throw new TypeError(`credential ref "${ref}" must match ...`)
        }
        return { token: ref }
      },
      warn: (m) => warns.push(m),
      now: () => 1_000_000,
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: 60_000,
    })
    await expect(refresher.tick(), '★★ 抛错不得逃出 tick').resolves.toBeUndefined()

    expect(
      calls,
      '★★ 一个畸形 credentialRef 不得让后面正常账号整轮不刷（毒化整轮）',
    ).toEqual(['loomy:good-1'])
    const joined = warns.join('|')
    expect(
      joined,
      '★★ 必须留下一条**指向真因**的 warn（否则与「上游整体挂了」同形，无法排查）',
    ).toMatch(/凭据/)
    expect(
      joined,
      '★★ warn 必须点名那个账号（否则维护者无从知道是哪一条坏数据）',
    ).toContain('bad-1')
    // ⚠️ 反向格：**不得**出现那条措辞错误的兜底文案。它出现即证明异常冒到了外层。
    expect(
      joined,
      '★★ 不得退化成「读账号列表失败」（账号池读得好好的，那条文案与真因不符）',
    ).not.toContain('读账号列表失败')
  })
})
