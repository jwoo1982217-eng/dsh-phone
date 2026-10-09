import { describe, expect, it, vi } from 'vitest'

import { RemoteCatalogGate, REMOTE_CATALOG_COOLDOWN_MS } from '../../src/remote-catalog-gate.js'

/**
 * 目录闸门的三条语义。
 *
 * 这些用例锁死的是一类真实缺陷：远端目录拉取失败后**立刻允许重试**，
 * 而 DSH 的 `buildModelCatalog` 会对每个模型各调一次 `resolveModel` ⇒
 * 一次网络故障被放大成 N 次串行超时，首屏「加载模型」因此长时间空转。
 */
describe('RemoteCatalogGate', () => {
  it('冷却内不再调用 run', async () => {
    const gate = new RemoteCatalogGate()
    const run = vi.fn(async () => false)
    await gate.run(run)
    await gate.run(run)
    await gate.run(run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('成功拿到目录后不再冷却（只由调用方的缓存负责短路）', async () => {
    const gate = new RemoteCatalogGate()
    const run = vi.fn(async () => true)
    await gate.run(run)
    await gate.run(run)
    // 拿到目录不算失败，闸门不该拦：调用方此时已有缓存，不会再来。
    expect(run).toHaveBeenCalledTimes(2)
    expect(gate.cooling()).toBe(false)
  })

  it('run 抛错同样进入冷却（不能只在返回 false 时冷却）', async () => {
    const gate = new RemoteCatalogGate()
    const run = vi.fn(async () => { throw new Error('network down') })
    await expect(gate.run(run)).resolves.toBeUndefined()
    await gate.run(run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(gate.cooling()).toBe(true)
  })

  it('冷却到期后允许重试', async () => {
    let now = 1_000
    const gate = new RemoteCatalogGate({ cooldownMs: 500, now: () => now })
    const run = vi.fn(async () => false)
    await gate.run(run)
    now += 499
    await gate.run(run)
    expect(run).toHaveBeenCalledTimes(1)
    now += 2
    await gate.run(run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('并发调用共享同一次加载（listModels 与 resolveModel 会被 DSH 并发触发）', async () => {
    const gate = new RemoteCatalogGate()
    let release: (() => void) | undefined
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return true
    })
    const first = gate.run(run)
    const second = gate.run(run)
    const third = gate.run(run)
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    release?.()
    await Promise.all([first, second, third])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('异常不会毁掉 in-flight 状态（下一次仍能重试）', async () => {
    let now = 0
    const gate = new RemoteCatalogGate({ cooldownMs: 100, now: () => now })
    const boom = vi.fn(async () => { throw new Error('boom') })
    await gate.run(boom)
    now = 200
    const ok = vi.fn(async () => true)
    await gate.run(ok)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(gate.cooling()).toBe(false)
  })

  it('reset 清掉冷却窗口', async () => {
    const gate = new RemoteCatalogGate()
    const run = vi.fn(async () => false)
    await gate.run(run)
    expect(gate.cooling()).toBe(true)
    gate.reset()
    await gate.run(run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('默认冷却时长是 30 秒', () => {
    expect(REMOTE_CATALOG_COOLDOWN_MS).toBe(30_000)
  })

  /**
   * ⚠ **`run` 同步抛错**（审查发现）。
   *
   * 类型签名是 `run: () => Promise<boolean>`，但 JS 挡不住 `() => { throw e }`。
   * 原实现写成 `this.inFlight = (async () => { try … finally { this.inFlight = undefined } })()`：
   * 若 `run()` 在**任何 await 之前**同步抛错，那个 IIFE 会整段**同步**跑完
   * （catch → finally 把 `inFlight` 置回 `undefined`），**然后**外层赋值又把
   * `undefined` 覆盖成一个**已 settle** 的 Promise ⇒ 此后
   * `if (this.inFlight !== undefined)` 永远先命中，该 provider **永久不再重拉**，
   * 冷却到期也救不回。
   */
  it('★ run 同步抛错不得永久占住 inFlight（冷却到期后仍能重试）', async () => {
    let now = 0
    const gate = new RemoteCatalogGate({ cooldownMs: 100, now: () => now })
    const sync = (): Promise<boolean> => { throw new Error('sync boom') }
    await expect(gate.run(sync)).resolves.toBeUndefined()

    // 冷却到期后必须能重新调用 —— 若 inFlight 被永久占住，这里 calls 会停在 1。
    now = 200
    let calls = 0
    const ok = async (): Promise<boolean> => { calls += 1; return true }
    await gate.run(ok)
    expect(calls).toBe(1)
    expect(gate.cooling()).toBe(false)
  })

  it('★ 同步抛错也算一次失败（进入冷却，不静默放过）', async () => {
    const gate = new RemoteCatalogGate()
    await gate.run((): Promise<boolean> => { throw new Error('sync boom') })
    expect(gate.cooling()).toBe(true)
  })

  /**
   * ⚠ **时钟回拨**（审查发现）：`retryAt` 用墙钟算，系统时间往后调时
   * `now() < retryAt` 成立且差值变大 ⇒ 冷却被**拉长**（回拨一天就是事实上的
   * 永久卡死）。修复后只认「剩余量不超过一个冷却周期」的窗口。
   */
  it('★ 时钟回拨不得把冷却拉长（超出周期一律按已到期）', async () => {
    let now = 1_000_000
    const gate = new RemoteCatalogGate({ cooldownMs: 100, now: () => now })
    const run = vi.fn(async () => false)
    await gate.run(run)
    expect(gate.cooling()).toBe(true)
    // 系统时间被回拨 100 秒：retryAt - now = 100_000 >> cooldownMs
    now -= 100_000
    expect(gate.cooling()).toBe(false)
    await gate.run(run)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
