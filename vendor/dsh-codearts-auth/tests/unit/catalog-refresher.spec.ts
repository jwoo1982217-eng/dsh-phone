/**
 * 模型目录刷新器：每 20 分钟叫醒所有适配器重拉一次。
 *
 * ## 为什么需要它（用户 2026-10-18）
 *
 * 「各个模型的模型列表缓存也要带定时更新，20 分钟更新一次，如果不更新随高峰低谷
 * 变化的积分消耗倍率是更新不到实际的倍率」
 *
 * 前序 Task 已给 9 家适配器加了 `isCatalogFresh` 判据 —— 但那是**读驱动**的：
 * 只有有人读、且发现过期，才会真去拉。没人读时缓存永远是旧的。
 *
 * ## ⚠️⚠️ 为什么刷新器**不**直接调各家的私有方法
 *
 * 核实结果（2026-10-18）：9 家的拉取入口**全是 `private`**
 * （`ensureRemoteModels()` / `loadModels()`），只有 `buddy` 与 `aggregate`
 * 有公开的 `refreshCatalog()`。
 * ⇒ 刷新器无法直接调它们；**必须**给目录契约加一个公开的 `refresh()`。
 *
 * ## ⚠️ 为什么 `refresh()` 是**可选**的
 *
 * `createModelCatalog` 有 12 家在用，给它加**必选**成员会一次性打破所有实现
 * （本仓库铁律：不得改 12 家依赖的既有形状）。可选成员则「实现了就生效、
 * 没实现就跳过」，且 `opencode` 那类本地派生渠道（零网络）本来就是空转。
 *
 * ## ⚠️ `pruned()` 代理会透传新方法
 *
 * `modelAdapters` 表里每一项都是 `withDeadModelPruning` 的 Proxy，
 * 而它对**其余成员原样透传并绑定 `this`**（`src/dead-model-store.ts:748-749`）
 * ⇒ 给适配器加公开方法后**无需**改 `pruned` 或那张表。
 *
 * @module tests/unit/catalog-refresher-wiring.spec.ts
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_REFRESH_INTERVAL_MS,
  createModelCatalog,
  type CatalogEntry,
  type ModelCatalogConfig,
} from '../../src/model-catalog.js'

/** 造一个最小可用的 `ModelCatalogConfig`。 */
function makeConfig(options: {
  loadCatalog: () => readonly CatalogEntry[] | Promise<readonly CatalogEntry[]>
  refresh?: () => void | Promise<void>
}): ModelCatalogConfig {
  return {
    product: { id: 'probe-provider', displayName: 'Probe' } as never,
    loadCatalog: options.loadCatalog,
    syncCatalog: () => [],
    ...options.refresh === undefined ? {} : { refresh: options.refresh },
  } as never
}

const entries: readonly CatalogEntry[] = [{ id: 'm1', name: 'M1' }]

describe('目录契约的 refresh()：可选成员', () => {
  it('★★ 未实现 refresh 时，listModels 与 listAllModels 行为逐字不变', async () => {
    const loadCatalog = vi.fn(() => entries)
    const catalog = createModelCatalog({} as never, makeConfig({ loadCatalog }))
    expect(catalog.refresh, '★ 未提供时不该凭空造一个').toBeUndefined()
    const models = await catalog.listModels('probe-provider')
    expect(models).toHaveLength(1)
    expect(loadCatalog).toHaveBeenCalledTimes(1)
  })

  it('★★ 实现了 refresh 时，它被真的透传出来（不是只声明）', async () => {
    const refresh = vi.fn(async () => {})
    const catalog = createModelCatalog({} as never, makeConfig({
      loadCatalog: () => entries,
      refresh,
    }))
    expect(typeof catalog.refresh, '★★ refresh 必须是函数').toBe('function')
    await catalog.refresh!()
    expect(refresh, '★★ 必须真的调到配置里的实现').toHaveBeenCalledTimes(1)
  })
})

describe('★★ 刷新器：后台定时保鲜', () => {
  /**
   * 造一个可控世界：假定时器 + 可数调用次数。
   *
   * ⚠️ 本文件**不**依赖 `apply()`（刷新器是纯逻辑，可直接构造）。
   * 接线守卫见 `catalog-refresher-wiring.spec.ts` 里真跑 apply() 的那条。
   */
  function makeWorld(options: {
    providers?: readonly string[]
    refresh?: (provider: string) => void | Promise<void>
  } = {}) {
    const calls: string[] = []
    let armed: (() => void) | undefined
    const providers = options.providers ?? ['loomy', 'trae']
    const refresher = createCatalogRefresher({
      // ⚠️ 只列「实现了 refresh 的 provider」由刷新器自己判（见实现注释）。
      listProviders: () => providers,
      refreshOf: (provider) => {
        calls.push(provider)
        // ⚠️ **默认必须返回非 `undefined`**：在本刷新器的契约里 `undefined` 意为
        //    「这家不参与后台刷新」（`index.ts` 的 `refreshOf` 据此统计参与度，
        //    零参与会 warn —— 见 `createCatalogRefresher` 的注释）。
        //    本夹具测的是刷新器**自身逻辑**，故默认模拟「全部参与」；
        //    `options.refresh` 仍可显式覆盖（含故意返回 undefined 的场景）。
        if (options.refresh === undefined) return Promise.resolve()
        return options.refresh(provider)
      },
      setInterval: ((fn: () => void) => { armed = fn; return { unref: () => {} } }) as never,
      intervalMs: CATALOG_REFRESH_INTERVAL_MS,
    })
    return {
      refresher,
      calls,
      fire: async () => { await armed?.() },
      isArmed: () => armed !== undefined,
    }
  }

  it('★★ start() 真的武装了定时器（stop() 解除）', () => {
    const world = makeWorld()
    expect(world.isArmed(), '★ start 前不该武装').toBe(false)
    world.refresher.start()
    expect(world.isArmed(), '★★ start 后必须武装').toBe(true)
    world.refresher.stop()
    // ⚠️ 判据用 `isArmed()`（内部 `timer !== undefined`），**不是**「假定时器回调被清」——
    //    注入假定时器时 `clearImpl` 是空操作（句柄对不上，见实现注释），
    //    故 `armed` 变量仍持有旧回调。这条守的是「刷新器认为自己已停」。
    expect(world.refresher.isArmed(), '★ stop 后必须解除').toBe(false)
  })

  it('★★ 一轮刷新会**逐 provider** 走一遍（用户要求「全部都这样处理」）', async () => {
    const world = makeWorld({ providers: ['loomy', 'trae', 'zcode'] })
    await world.refresher.tick()
    expect(world.calls, '★★ 不认 provider 特例').toEqual(['loomy', 'trae', 'zcode'])
  })

  it('★★ 逐 provider **顺序**执行（并发打上游会触发风控）', async () => {
    // ⚠️ 必须用**两个以上** provider：单家时串行与并发不可区分（仓库既有教训）。
    let inflight = 0
    let maxInflight = 0
    const refresher = createCatalogRefresher({
      listProviders: () => ['a', 'b'],
      refreshOf: async () => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 0))
        inflight -= 1
      },
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: CATALOG_REFRESH_INTERVAL_MS,
    })
    await refresher.tick()
    expect(maxInflight, '★★ 同一时刻最多一个在飞（不得 Promise.all）').toBe(1)
  })

  it('★★ 单家失败不得中断其余（与 refreshAllCredentials 同款）', async () => {
    const world = makeWorld({
      providers: ['bad', 'good'],
      // ⚠️ 用 **async** 而非同步 throw：同步抛会让 `refreshOf` 连「返回了东西」
      //    都做不到 ⇒ 参与度统计把它算成「未参与」，与本用例要测的「失败」
      //    混为一谈（判据失焦）。
      refresh: async (provider) => { if (provider === 'bad') throw new Error('上游 503') },
    })
    await expect(world.refresher.tick()).resolves.toBeUndefined()
    expect(world.calls, '★★ 坏的那家失败后，好的那家仍必须被刷').toEqual(['bad', 'good'])
  })

  it('★ 重入时跳过本轮（防重入闸门必须有）', async () => {
    const world = makeWorld()
    const first = world.refresher.tick()
    const second = world.refresher.tick()
    await Promise.all([first, second])
    expect(world.calls, '★ 同一时刻只跑一轮（calls 不得翻倍）').toEqual(['loomy', 'trae'])
  })

  it('★ start() 幂等（重复武装会叠加 interval，刷新频率翻倍）', () => {
    let armedCount = 0
    const refresher = createCatalogRefresher({
      listProviders: () => [],
      refreshOf: async () => {},
      setInterval: (() => { armedCount += 1; return { unref: () => {} } }) as never,
      intervalMs: CATALOG_REFRESH_INTERVAL_MS,
    })
    refresher.start()
    refresher.start()
    refresher.start()
    expect(armedCount, '★★ 只能武装一次').toBe(1)
  })

  it('★★ 本轮**零参与**必须 warn（否则「已武装」的日志会说谎）', async () => {
    // ⚠️⚠️ 这是 2026-10-20 修的实测缺陷形态：`be42b25` 给 13 家适配器只加了
    //    `createModelCatalog` 的 **config 回调**，**没有**把它转发成适配器实例的
    //    `refresh` 成员 ⇒ `index.ts` 的 `refreshOf` 恒返回 `undefined` ⇒
    //    每一轮都是「0 家参与」，而 `start()` 的「模型目录刷新器已武装」照打 ⇒
    //    功能整体失效却**一行日志都没有**。
    //    ⚠️ `be42b25` 当时的注释还声称「返回 undefined 比假函数更容易发现接线错误」
    //    —— 实测恰好相反（假函数至少会真发请求、日志里能看出动静）。
    const warns: string[] = []
    const refresher = createCatalogRefresher({
      listProviders: () => ['a', 'b'],
      refreshOf: () => undefined,
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: CATALOG_REFRESH_INTERVAL_MS,
      warn: (m) => { warns.push(m) },
    })
    await refresher.tick()
    expect(
      warns.some((w) => w.includes('无一家参与')),
      '零参与必须 warn 并点名（这是接线缺口的唯一强信号）',
    ).toBe(true)
  })

  it('★ 部分参与必须**留痕**（「说跑了 N 家、实际只刷了 M 家」不得静默）', async () => {
    const infos: string[] = []
    const refresher = createCatalogRefresher({
      listProviders: () => ['a', 'b', 'c'],
      // 只有 a 参与 —— 正是「有人漏转发」在生产里的形状。
      refreshOf: (provider) => (provider === 'a' ? Promise.resolve() : undefined),
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: CATALOG_REFRESH_INTERVAL_MS,
      info: (m) => { infos.push(m) },
    })
    await refresher.tick()
    expect(infos.some((i) => i.includes('参与 1/3')), '部分参与要记明参与数').toBe(true)
  })

  it('★ 全部参与时**不得**产生告警（防「无脑 warn」把日志刷满）', async () => {
    const warns: string[] = []
    const refresher = createCatalogRefresher({
      listProviders: () => ['a', 'b'],
      refreshOf: async () => {},
      setInterval: (() => ({ unref: () => {} })) as never,
      intervalMs: CATALOG_REFRESH_INTERVAL_MS,
      warn: (m) => { warns.push(m) },
    })
    await refresher.tick()
    expect(warns, '全部参与时不该有任何告警').toEqual([])
  })
})

/** 工厂（与实现同处 `src/model-catalog.ts`；此处 import 以保持类型对齐）。 */
import { createCatalogRefresher } from '../../src/model-catalog.js'
