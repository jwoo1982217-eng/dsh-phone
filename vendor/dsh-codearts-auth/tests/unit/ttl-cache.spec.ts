import { describe, expect, it } from 'vitest'
import { TtlCache } from '../../src/ttl-cache.js'

/**
 * `TtlCache` 的回归测试。
 *
 * 本文件在 2026-10-01 新增 `ttlFor`（按结果决定这一条自己的有效期）之后编写：
 * 需求来自「用量徽标」——**成功读数缓存久、全部失败缓存短**，与
 * `buddy-balance-selector.ts` 的「成功 60s / 失败 5s」同源。
 *
 * ⚠️ 反向验证（防止用例写成同义反复）：
 * - 把 `peek()` 改回用构造参数 `ttlMs` 比较 → 「失败短 TTL」用例变红；
 * - 把 `effectiveTtl` 的非法值分支改成返回 0 → 「非法值回落」用例变红。
 */
describe('TtlCache', () => {
  /** 可控时钟：所有用例都用它推进时间，避免依赖真实等待。 */
  function clock(start = 1_000) {
    let now = start
    return { now: () => now, advance: (ms: number) => { now += ms } }
  }

  it('缺省 ttlFor 时行为与改造前一致（命中 / 过期 / set / clear）', async () => {
    const time = clock()
    let calls = 0
    const cache = new TtlCache<number>({ ttlMs: 1_000, now: time.now, load: async () => ++calls })

    expect(await cache.get()).toBe(1)
    expect(await cache.get()).toBe(1)
    expect(calls).toBe(1)

    time.advance(999)
    expect(await cache.get()).toBe(1)
    time.advance(1)
    expect(await cache.get()).toBe(2)

    cache.set(9)
    expect(cache.peek()?.value).toBe(9)
    cache.clear()
    expect(cache.peek()).toBeUndefined()
  })

  it('ttlFor 按**结果**决定这一条的有效期', async () => {
    const time = clock()
    let value = 1
    let calls = 0
    const cache = new TtlCache<number>({
      ttlMs: 10_000,
      now: time.now,
      ttlFor: (v) => (v === 1 ? 100 : 10_000),
      load: async () => { calls += 1; return value },
    })

    // 短 TTL 的结果：过 100ms 就该重新加载（而不是按构造参数的 10s）
    expect(await cache.get()).toBe(1)
    time.advance(100)
    expect(await cache.get()).toBe(1)
    expect(calls).toBe(2)

    // 换成长 TTL 的结果（强制载入一次）：同样的时间里**不再**重新加载
    value = 2
    expect(await cache.get({ force: true })).toBe(2)
    expect(calls).toBe(3)
    time.advance(9_999)
    expect(await cache.get()).toBe(2)
    expect(calls).toBe(3)
    // 越过长 TTL 才重新加载
    time.advance(1)
    expect(await cache.get()).toBe(2)
    expect(calls).toBe(4)
  })

  it('ttlFor 返回非法值（负数 / NaN / Infinity / 非数字）时回落到 ttlMs', async () => {
    const time = clock()
    const invalid: unknown[] = [-1, Number.NaN, Number.POSITIVE_INFINITY]
    for (const bad of invalid) {
      let calls = 0
      const cache = new TtlCache<number>({
        ttlMs: 500,
        now: time.now,
        ttlFor: () => bad as number,
        load: async () => ++calls,
      })
      expect(await cache.get()).toBe(1)
      time.advance(499)
      expect(await cache.get()).toBe(1)
      time.advance(1)
      expect(await cache.get()).toBe(2)
      expect(calls).toBe(2)
    }
  })

  it('ttlFor 允许返回 0（= 不缓存，每次都重新加载）', async () => {
    const time = clock()
    let calls = 0
    const cache = new TtlCache<number>({ ttlMs: 10_000, now: time.now, ttlFor: () => 0, load: async () => ++calls })

    expect(await cache.get()).toBe(1)
    expect(await cache.get()).toBe(2)
    expect(calls).toBe(2)
  })

  it('force 绕过缓存，且不改变已存条目的有效期', async () => {
    const time = clock()
    let calls = 0
    const cache = new TtlCache<number>({ ttlMs: 1_000, now: time.now, load: async () => ++calls })

    expect(await cache.get()).toBe(1)
    time.advance(900)
    // 强制刷新后时间戳跟着更新 ⇒ 原来的 100ms 剩余被替换成完整 1000ms
    expect(await cache.get({ force: true })).toBe(2)
    time.advance(900)
    expect(await cache.get()).toBe(2)
    expect(calls).toBe(2)
  })

  it('在飞去重：并发调用共用同一次 load', async () => {
    const cache = new TtlCache<number>({
      ttlMs: 1_000,
      load: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 7
      },
    })
    const [a, b] = await Promise.all([cache.get(), cache.get()])
    expect(a).toBe(7)
    expect(b).toBe(7)
  })

  it('失败不缓存：load 抛错时向上抛，且下一次会重新加载', async () => {
    let calls = 0
    const cache = new TtlCache<number>({
      ttlMs: 10_000,
      load: async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return 5
      },
    })

    await expect(cache.get()).rejects.toThrow('boom')
    expect(cache.peek()).toBeUndefined()
    expect(await cache.get()).toBe(5)
    expect(calls).toBe(2)
  })
})
