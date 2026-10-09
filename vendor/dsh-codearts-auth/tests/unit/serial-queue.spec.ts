/**
 * 串行队列与 TTL 缓存的单测（2026-10-01，对齐官方 ZCode 的 captcha 护栏）。
 *
 * ## 依据（都来自官方闭源版 `app.asar` 的渲染层产物）
 *
 * | 机制 | 官方实现 |
 * |---|---|
 * | **全局串行队列** | `wnn` promise 链 + `jnn()`，日志 `verification queue slot acquired` |
 * | **配置 TTL 缓存** | `f3()`：`expiresAt: t + 6e4`（60 秒）+ 在飞去重 `d3` |
 *
 * 而阿里云按**设备维度**限流（官方文档：同设备每小时默认 150 次），
 * 所以并发产出与重复拉配置都是纯浪费。
 */
import { describe, expect, it } from 'vitest'

import { QueueAbortedError, SerialQueue } from '../../src/serial-queue.js'
import { TtlCache } from '../../src/ttl-cache.js'

const tick = async (ms = 5): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('SerialQueue（对齐官方的 captcha 串行队列）', () => {
  it('★ 串行：并发任务里同时在飞的永远只有 1 个', async () => {
    const queue = new SerialQueue()
    let inFlight = 0
    let maxInFlight = 0
    const task = async (): Promise<void> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(5)
      inFlight -= 1
    }

    await Promise.all([queue.run(task), queue.run(task), queue.run(task)])
    expect(maxInFlight).toBe(1)
    expect(queue.stats().pending).toBe(0)
    expect(queue.stats().completed).toBe(3)
  })

  it('★ 先进先出（公平）：按**调用顺序**执行，不是按完成顺序抢', async () => {
    const queue = new SerialQueue()
    const order: number[] = []
    await Promise.all([
      queue.run(async () => { await tick(20); order.push(1) }),
      queue.run(async () => { order.push(2) }),
      queue.run(async () => { order.push(3) }),
    ])
    // 第 1 个最慢，但它先入队 ⇒ 必须先完成，后两个才轮到。
    expect(order).toEqual([1, 2, 3])
  })

  it('★ 任务抛错也必须放行下一个（否则队列被永久焊死）', async () => {
    const queue = new SerialQueue()
    await expect(queue.run(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    // 尾巴已释放：下一个任务能正常执行。
    expect(await queue.run(async () => 'ok')).toBe('ok')
    expect(queue.stats().pending).toBe(0)
  })

  it('★ 等待期间中断必须生效（否则后面全被前一个拖死）', async () => {
    const queue = new SerialQueue()
    let releaseFirst!: () => void
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = queue.run(async () => {
      await blocker
    })
    await tick()

    const controller = new AbortController()
    const second = queue.run(async () => 'never', { signal: controller.signal })
    await tick()
    controller.abort()

    await expect(second).rejects.toBeInstanceOf(QueueAbortedError)

    releaseFirst()
    await first
  })

  it('已 abort 的 signal 直接拒绝（不执行任务）', async () => {
    const queue = new SerialQueue()
    const controller = new AbortController()
    controller.abort()
    let ran = false
    await expect(queue.run(async () => {
      ran = true
    }, { signal: controller.signal })).rejects.toBeInstanceOf(QueueAbortedError)
    expect(ran).toBe(false)
  })

  it('关闭后不排队（回到引入前行为）', async () => {
    const queue = new SerialQueue({ enabled: false })
    let inFlight = 0
    let maxInFlight = 0
    const task = async (): Promise<void> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(10)
      inFlight -= 1
    }
    await Promise.all([queue.run(task), queue.run(task)])
    expect(maxInFlight).toBe(2)
  })
})

describe('TtlCache（对齐官方的 captcha 配置缓存）', () => {
  it('★ 命中缓存期间不重复加载', async () => {
    let loads = 0
    let nowMs = 1_000
    const cache = new TtlCache({
      ttlMs: 60_000,
      load: async () => {
        loads += 1
        return `v${loads}`
      },
      now: () => nowMs,
    })

    expect(await cache.get()).toBe('v1')
    nowMs += 59_000
    expect(await cache.get()).toBe('v1')
    expect(loads).toBe(1)
  })

  it('★ 超过 TTL 自动重取（这是与「永久缓存」的关键差异）', async () => {
    let loads = 0
    let nowMs = 1_000
    const cache = new TtlCache({
      ttlMs: 60_000,
      load: async () => {
        loads += 1
        return `v${loads}`
      },
      now: () => nowMs,
    })

    expect(await cache.get()).toBe('v1')
    // 官方是 `t + 6e4`，到点即失效。
    nowMs += 60_000
    expect(await cache.get()).toBe('v2')
    expect(loads).toBe(2)
  })

  it('★ 在飞去重：并发调用只加载一次（官方 `d3` 的同款语义）', async () => {
    let loads = 0
    const cache = new TtlCache({
      ttlMs: 60_000,
      load: async () => {
        loads += 1
        await tick(10)
        return `v${loads}`
      },
    })

    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()])
    expect([a, b, c]).toEqual(['v1', 'v1', 'v1'])
    expect(loads).toBe(1)
  })

  it('★ 加载失败**不得**被固化（旧 `??=` 实现的缺陷）', async () => {
    let calls = 0
    const cache = new TtlCache<string>({
      ttlMs: 60_000,
      load: async () => {
        calls += 1
        if (calls === 1) throw new Error('network down')
        return 'recovered'
      },
    })

    await expect(cache.get()).rejects.toThrow('network down')
    /**
     * ★ 关键：第一次失败后，第二次必须**真的重试**。
     * 旧的 `??=` 写法会把失败 promise 永久留在变量里 ⇒ 永远返回失败。
     */
    expect(await cache.get()).toBe('recovered')
    expect(calls).toBe(2)
  })

  it('force 绕过缓存强制重取（服务端拒绝后刷新配置用）', async () => {
    let loads = 0
    const cache = new TtlCache({
      ttlMs: 60_000,
      load: async () => `v${++loads}`,
    })
    expect(await cache.get()).toBe('v1')
    expect(await cache.get({ force: true })).toBe('v2')
  })

  it('set 写入已知值可避免下一次白加载；clear 清空', async () => {
    let loads = 0
    const cache = new TtlCache({
      ttlMs: 60_000,
      load: async () => `v${++loads}`,
    })
    cache.set('preset')
    expect(await cache.get()).toBe('preset')
    expect(loads).toBe(0)

    cache.clear()
    expect(await cache.get()).toBe('v1')
  })

  it('peek 只读：过期时返回 undefined 且**不触发**加载', async () => {
    let loads = 0
    let nowMs = 0
    const cache = new TtlCache({
      ttlMs: 100,
      load: async () => `v${++loads}`,
      now: () => nowMs,
    })
    await cache.get()
    expect(cache.peek()?.value).toBe('v1')
    nowMs += 100
    expect(cache.peek()).toBeUndefined()
    expect(loads).toBe(1)
  })
})
