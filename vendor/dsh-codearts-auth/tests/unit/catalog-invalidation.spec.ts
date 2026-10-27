/**
 * 用户主动改设置时，目录缓存必须**立即**失效。
 *
 * ## 为什么这不是「优化」而是**正确性**（规格 §6）
 *
 * 前序 Task 给各家适配器的目录缓存放了 20 分钟 TTL（`CATALOG_REFRESH_INTERVAL_MS`）。
 * 但只做 TTL 有个缺口：用户在 Jet Hub 改「显示列表」开关后，**最坏要等满 20 分钟**
 * 才看到效果 —— 期间界面上那一条模型仍在、点了却按旧的开关路由。
 *
 * ## ⚠️⚠️ 判据全部打在**行为**上
 *
 * 本仓库实测过 5 条「源码文本断言」在 `if (false)` 的死分支里恒绿 ⇒ 本文件
 * **一条源码判据都没有**：只数 `fetchRemoteModels` 的调用次数、只看返回的 id 集合、
 * 只比时间戳。**不断言** `catalogAt` / `remoteModels` 这些实现细节。
 *
 * ## ⚠️ 落点说明（与 brief 的差异，已核实）
 *
 * brief 的 Step 1 import 的是 `../../src/model-catalog.js` 的 `invalidateCatalogCache`
 * —— 本实现**沿用了这个落点**（`src/model-catalog.ts`），故 import 与实现一致。
 *
 * 但 brief 的 Step 3「各适配器构造时登记闭包」**没有采用**，理由写在
 * `src/model-catalog.ts` 的 `catalogInvalidations` 注释里（三行表）：
 * 「最后构造者赢」会让 `src/index.ts` 的 `probeById` 每次「重测」`new` 出来的
 * **临时**适配器把生产实例的登记挤掉 ⇒ 症状是「重测过一次之后，改开关就再也不
 * 生效了」。现方案是 `provider → 失效时刻` 的 Map + `isCatalogFreshFor()`
 * （给唯一判据 `isCatalogFresh` 加一个**正交**输入，各家既有时序一行未动）。
 *
 * ## ⚠️⚠️ 失效时刻必须与适配器的时钟**同源**
 *
 * 判据是 `catalogAt <= invalidatedAt`，而 `catalogAt` 由各适配器注入的 `now`
 * 写入。本文件因此把假时钟的值**显式**传给 `invalidateCatalogCache(id, clock.now())`
 * —— 只传一个参数（缺省 `Date.now()`）在生产里正确，但与本文件的假时钟
 * （从 `1_000_000` 起）不可比。**这不是绕开实现，而是把实现写明的契约用对**
 * （见该函数 `@param at`）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_REFRESH_INTERVAL_MS,
  catalogInvalidatedAt,
  clearCatalogInvalidations,
  invalidateCatalogCache,
  isCatalogFresh,
  isCatalogFreshFor,
} from '../../src/model-catalog.js'
import { AccioAdapter } from '../../src/accio-adapter.js'
import { AggregateAdapter } from '../../src/aggregate-adapter.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { MinimaxAdapter } from '../../src/minimax-adapter.js'
import { MINIMAX, MINIMAX_INTL } from '../../src/minimax-product.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'

/**
 * ⚠️ **失效表是进程级全局状态** ⇒ 每条用例之间必须清干净。
 *
 * 不清的后果与 `dead-model-store` 那组用例同型：上一条把 `loomy` 置失效后，
 * 下一条的「周期内不得重拉」会**假失败**（症状是「莫名其妙多一次请求」）。
 */
afterEach(() => {
  clearCatalogInvalidations()
})

/** 造一个**可推进**的假时钟（不推进它正是「立即失效」可判别的关键）。 */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let clock = 1_000_000
  return { now: () => clock, advance: (ms: number) => { clock += ms } }
}

/** 造一个「已就绪」的最小构造集（各家共用的那一份）。 */
function baseOptions(
  fetchRemoteModels: () => Promise<readonly unknown[]>,
  now: () => number,
): Record<string, unknown> {
  return {
    credentialRef: 'CRED',
    resolveCredential: async () => ({ token: 't' }),
    refresh: async () => {},
    fetchRemoteModels,
    now,
  }
}

/**
 * 接了线的家的构造表。
 *
 * ⚠️ 每家的构造选项形状不同（zcode 的 `listModels` 先 `ready()`；
 * codearts / buddy 有「完整性」腿），故用一张表统一驱动 —— 参数化正是为了
 * 「接线漏一家」不再静默：漏了会点名到具体哪一家。
 *
 * ## ⚠️⚠️ 两个「共用类、双站」的组必须显式传 `product`
 *
 * `minimax` / `minimaxintl` 与 `buddy` / `workbuddy` **各共用一个适配器类**，
 * provider id 只来自构造时的 `options.product`（缺省分别是 `MINIMAX` / `CODEBUDDY`）。
 * 不传 `product` 时两个实例都登记在**缺省那个 id** 上 ⇒ 用例会把「第二个实例」
 * 的 TTL 短路误读成「失效没生效」。这本身正是要守的东西：
 * **登记键是实例的 `product.id`，不是类名**。
 *
 * ⚠️ `catalogComplete: () => true`：codearts / buddy 的短路判据是
 * 「已完整 **且** 未超期」，只给「有值」那一半 ⇒ 它们会每轮重拉，
 * 那样用例就量不到「失效」这一腿了。
 *
 * ## ⚠️ `remoteId` 是「远端独有的模型 id」的**归一后形态**
 *
 * 「失效不删内容」那组用例靠它判别「读到的是旧远端列表」还是「兜底表」。
 * 取 `remote-only-model` 在**该家目录里的实际 id**：
 * - accio 会把展示名归一成 slug（`normalizeNameKey`）⇒ `Remote Only Model` →
 *   `remote-only-model`，故喂 `name` 而不是乱码 id；
 * - buddy 系有**白名单式重建**（`reconcileWithFallback`）：远端独有的 id 只有
 *   在「被 agent 引用」或「远端明确声明收图」时才留下 ⇒ 必须带上这两个字段之一，
 *   否则那条用例量到的是「buddy 的既有白名单」而不是「失效有没有删内容」。
 */
const WIRED: readonly {
  id: string
  /** 喂给 `fetchRemoteModels` 的那一条（各家的字段形状不同，见上注）。 */
  remoteModel: Record<string, unknown>
  /** 它在 `listModels` 结果里的 id（见上注）。 */
  remoteId: string
  build: (options: Record<string, unknown>) => { listModels(provider: string): Promise<readonly { id: string }[]> }
}[] = [
  { id: 'loomy', remoteModel: { id: 'm1', name: 'M1' }, remoteId: 'm1', build: (o) => new LoomyAdapter(o as never) },
  {
    id: 'minimax',
    remoteModel: { id: 'm1', name: 'M1' },
    remoteId: 'm1',
    build: (o) => new MinimaxAdapter({ ...o, product: MINIMAX } as never),
  },
  {
    id: 'minimaxintl',
    remoteModel: { id: 'm1', name: 'M1' },
    remoteId: 'm1',
    build: (o) => new MinimaxAdapter({ ...o, product: MINIMAX_INTL } as never),
  },
  { id: 'raccoon', remoteModel: { id: 'm1', name: 'M1' }, remoteId: 'm1', build: (o) => new RaccoonAdapter(o as never) },
  {
    id: 'zcode',
    remoteModel: { id: 'm1', name: 'M1' },
    remoteId: 'm1',
    build: (o) => new ZcodeAdapter({ ...o, isReady: async () => true } as never),
  },
  { id: 'trae', remoteModel: { id: 'm1', name: 'M1' }, remoteId: 'm1', build: (o) => new TraeAdapter(o as never) },
  {
    id: 'lobsterai',
    remoteModel: { id: 'm1', name: 'M1' },
    remoteId: 'm1',
    build: (o) => new LobsteraiAdapter(o as never),
  },
  {
    id: 'accio',
    remoteModel: { id: 'internal-code', name: 'Remote Only Model' },
    remoteId: 'remote-only-model',
    build: (o) => new AccioAdapter(o as never),
  },
  {
    id: 'codearts',
    remoteModel: { id: 'remote-only-model', name: 'R' },
    remoteId: 'remote-only-model',
    build: (o) => new CodeArtsAdapter({ ...o, catalogComplete: () => true } as never),
  },
  {
    id: 'buddy',
    remoteModel: { id: 'remote-only-model', name: 'R', supportsImages: true },
    remoteId: 'remote-only-model',
    build: (o) => new BuddyAdapter({ ...o, product: CODEBUDDY, catalogComplete: () => true } as never),
  },
  {
    id: 'workbuddy',
    remoteModel: { id: 'remote-only-model', name: 'R', supportsImages: true },
    remoteId: 'remote-only-model',
    build: (o) => new BuddyAdapter({ ...o, product: WORKBUDDY, catalogComplete: () => true } as never),
  },
]

/**
 * ★★ **主用例：失效后下一次 `listModels` 立刻重拉远端。**
 *
 * ⚠️ 关键在「**不推进时钟**」：TTL 是 20 分钟，不推进它就绝不可能因超期而重拉
 * ⇒ 观察到的第二次请求只可能来自「失效」这条路径。
 * ⚠️ 这条若恒绿，说明失效只是「把 TTL 改小」而没真失效（例如登记了闭包但
 * 作用在了另一个实例上）。
 */
describe('★★ 失效后立刻重拉（不推进时钟）', () => {
  it.each(WIRED)('★★ $id：失效后下一次 listModels 立刻重新拉远端', async ({ id, remoteModel, build }) => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [remoteModel])
    const adapter = build(baseOptions(fetchRemoteModels, clock.now))
    await adapter.listModels(id)
    expect(fetchRemoteModels, '⚪️ 冷缓存首拉').toHaveBeenCalledTimes(1)
    // 周期内再读一次：不重拉（证明「本来有缓存」）。
    await adapter.listModels(id)
    expect(fetchRemoteModels, '⚪️ 周期内零额外请求').toHaveBeenCalledTimes(1)

    // ⚠️ **不推进时钟** —— 正是「不推进」让「立即失效」成为可判别的行为。
    invalidateCatalogCache(id, clock.now())
    await adapter.listModels(id)
    expect(
      fetchRemoteModels,
      `★★ ${id} 失效后必须立刻重拉（恒绿 = 该家没接 isCatalogFreshFor）`,
    ).toHaveBeenCalledTimes(2)
  })

  /**
   * ★ **失效会自愈**：成功重拉之后 `catalogAt` 晚于失效时刻 ⇒ 不再无限重拉。
   *
   * ⚠️ 这条守的是「标记不需要清理」那半设计：没有它，一个失效标记会让该 provider
   * **永久**每轮重拉（每次都打一次上游），而症状是「目录能用、但流量莫名翻倍」。
   */
  it('★ 成功重拉后失效自动解除（不再每轮重拉）', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new LoomyAdapter(baseOptions(fetchRemoteModels, clock.now) as never)
    await adapter.listModels('loomy')
    invalidateCatalogCache('loomy', clock.now())
    // ⚠️ 推进 1ms 再读：真实时钟下网络往返必然 > 1ms ⇒ 新 `catalogAt` 严格大于标记。
    clock.advance(1)
    await adapter.listModels('loomy')
    expect(fetchRemoteModels, '★ 失效后重拉一次').toHaveBeenCalledTimes(2)
    // 标记已被「更晚的 catalogAt」越过 ⇒ 回到 TTL 语义，周期内不再拉。
    clock.advance(1)
    await adapter.listModels('loomy')
    expect(fetchRemoteModels, '★ 重拉成功后必须回到 TTL 语义（否则每轮都打上游）')
      .toHaveBeenCalledTimes(2)
  })
})

/**
 * ★★ **规格 §7 的核心取舍：失效不删内容。**
 *
 * 删掉已缓存的目录会让用户读到**编译期兜底表**，而它是远端的**子集**
 * （`docs/agent-notes/client-ui.md`：cline 实测 3/460）⇒ 用户会看到
 * 「刚关掉一个开关，模型反而少了几十个」。
 *
 * ⚠️ 判据用**远端独有的 id**（`remote-only-model` 不在任何兜底表里）：
 * 只断言「列表非空」是恒真的（兜底表本身非空），那样的用例零牙。
 */
describe('★★ 失效不删内容（用户看到的是旧列表，不是兜底表）', () => {
  it.each(WIRED)('★★ 失效瞬间仍能看到上次的远端模型（$id）', async ({ id, remoteModel, remoteId, build }) => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [remoteModel])
    const adapter = build(baseOptions(fetchRemoteModels, clock.now))
    await adapter.listModels(id)
    invalidateCatalogCache(id, clock.now())
    const models = await adapter.listModels(id)
    expect(
      models.map((m) => m.id),
      '★★ 失效瞬间用户仍应看到上次的远端模型（远端独有的 id 不能消失）',
    ).toContain(remoteId)
  })

  /**
   * ⚠️⚠️ **更硬的一条：远端**拉取失败**时也必须保住旧列表。**
   *
   * 这是 A 类四家（loomy / minimax / raccoon / zcode）的**真实风险点**：它们的
   * `loadModels` 有**两处**判据（入口 + gate 之后复查）。若把「失效」也加到
   * 第二处，一次失败的刷新就会把手上那份**完整旧目录**判成不可用 ⇒ 回落兜底表
   * （子集）⇒ 正是规格 §7 要避免的形态。
   */
  it.each(WIRED)('★★ 失效后拉取失败也必须保住旧列表（$id）', async ({ id, remoteModel, remoteId, build }) => {
    const clock = makeClock()
    let broken = false
    const fetchRemoteModels = vi.fn(async () => {
      if (broken) throw new Error('上游 503')
      return [remoteModel]
    })
    const adapter = build(baseOptions(fetchRemoteModels, clock.now))
    await adapter.listModels(id)
    broken = true
    invalidateCatalogCache(id, clock.now())
    const models = await adapter.listModels(id)
    expect(
      models.map((m) => m.id),
      '★★ 失效只该让下一次**去拉**，不该把已有内容丢掉（否则用户看到兜底子集）',
    ).toContain(remoteId)
  })
})

/**
 * ★ **按 provider 粒度**：失效一个不得连带作废其余。
 *
 * ⚠️ 一个「全局一个 at」的实现会让这条变红：那正是本 Task 明确禁止的
 * 糊弄方式（改一个开关 ⇒ 下次打开面板打十几个上游）。
 */
describe('★ 按 provider 粒度', () => {
  it('★ 失效 loomy 不影响 zcode（跨 provider 隔离）', async () => {
    const clock = makeClock()
    const fetchA = vi.fn(async () => [{ id: 'a1', name: 'A' }])
    const fetchB = vi.fn(async () => [{ id: 'b1', name: 'B' }])
    const loomy = new LoomyAdapter(baseOptions(fetchA, clock.now) as never)
    const zcode = new ZcodeAdapter(baseOptions(fetchB, clock.now) as never)
    await loomy.listModels('loomy')
    await zcode.listModels('zcode')
    invalidateCatalogCache('loomy', clock.now())
    await loomy.listModels('loomy')
    await zcode.listModels('zcode')
    expect(fetchA.mock.calls.length, '★ 被失效的那个要重拉').toBe(2)
    expect(fetchB.mock.calls.length, '★ 无关的那个不得重拉（改一个开关不该打十几个上游）').toBe(1)
  })

  it('★ minimax 与 minimaxintl 是两个独立键（双站互不牵连）', async () => {
    const clock = makeClock()
    const fetchCn = vi.fn(async () => [{ id: 'cn1', name: 'CN' }])
    const fetchIntl = vi.fn(async () => [{ id: 'intl1', name: 'INTL' }])
    // ⚠️ 两站**共用一个类**，provider id 只来自各自的 `options.product`
    //    （缺省是 `MINIMAX`）⇒ 必须显式传，否则两个实例都登记在国内站键上。
    const cn = new MinimaxAdapter({ ...baseOptions(fetchCn, clock.now), product: MINIMAX } as never)
    const intl = new MinimaxAdapter({ ...baseOptions(fetchIntl, clock.now), product: MINIMAX_INTL } as never)
    await cn.listModels('minimax')
    await intl.listModels('minimaxintl')
    invalidateCatalogCache('minimax', clock.now())
    await cn.listModels('minimax')
    await intl.listModels('minimaxintl')
    expect(fetchCn.mock.calls.length, '★ 国内站被失效 ⇒ 重拉').toBe(2)
    expect(fetchIntl.mock.calls.length, '★ 国际站不受牵连（两站是不同 provider id）').toBe(1)
  })

  it('★ buddy / workbuddy 的复用类按各自 product.id 分键', async () => {
    // ⚠️ 这一组同样**共用一个类**，provider id 只能来自构造时的 `options.product`
    //    （缺省是 `CODEBUDDY`）。本用例证明「登记的是实例的 product.id 而不是类名」
    //    —— 若实现按类名登记，两个站会挤成同一个键，失效一个连带作废另一个。
    const clock = makeClock()
    const fetchBuddy = vi.fn(async () => [{ id: 'b1', name: 'B', supportsImages: true }])
    const fetchWork = vi.fn(async () => [{ id: 'w1', name: 'W', supportsImages: true }])
    const buddy = new BuddyAdapter({
      ...baseOptions(fetchBuddy, clock.now), product: CODEBUDDY, catalogComplete: () => true,
    } as never)
    const work = new BuddyAdapter({
      ...baseOptions(fetchWork, clock.now), product: WORKBUDDY, catalogComplete: () => true,
    } as never)
    await buddy.listModels('buddy')
    await work.listModels('workbuddy')
    invalidateCatalogCache('buddy', clock.now())
    await buddy.listModels('buddy')
    await work.listModels('workbuddy')
    expect(fetchBuddy.mock.calls.length, '★ buddy 被失效 ⇒ 重拉').toBe(2)
    expect(fetchWork.mock.calls.length, '★ workbuddy 不受牵连（两站是不同 provider id）').toBe(1)
  })
})

/**
 * ★ **未登记的 provider 静默无操作、不抛错。**
 *
 * RPC 端点不该因为一个陌生 provider id 让「已落盘的开关」变成失败。
 */
describe('★ 未登记的 provider 静默无操作', () => {
  it('★ 对任意陌生 id 调用不抛错，也不影响任何已接线渠道', async () => {
    expect(() => { invalidateCatalogCache('no-such-provider') }).not.toThrow()
    expect(() => { invalidateCatalogCache('') }).not.toThrow()

    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new LoomyAdapter(baseOptions(fetchRemoteModels, clock.now) as never)
    await adapter.listModels('loomy')
    await adapter.listModels('loomy')
    expect(fetchRemoteModels, '★ 陌生 id 的失效不得影响 loomy').toHaveBeenCalledTimes(1)
  })

  it('★ 失效标记只按 provider 分键，不认实例（同一 id 的两个实例都看到信号）', async () => {
    const clock = makeClock()
    const fetchA = vi.fn(async () => [{ id: 'a1', name: 'A' }])
    const fetchB = vi.fn(async () => [{ id: 'b1', name: 'B' }])
    const a = new LoomyAdapter(baseOptions(fetchA, clock.now) as never)
    const b = new LoomyAdapter(baseOptions(fetchB, clock.now) as never)
    await a.listModels('loomy')
    await b.listModels('loomy')
    invalidateCatalogCache('loomy', clock.now())
    await a.listModels('loomy')
    await b.listModels('loomy')
    expect(fetchA.mock.calls.length, '★ 同 provider 的实例 1 要重拉').toBe(2)
    expect(fetchB.mock.calls.length, '★ 同 provider 的实例 2 也要重拉').toBe(2)
  })
})

/**
 * ★★ **聚合自己的目录缓存**（`aggregate` 也有 `catalogAt`，TTL 60 秒）。
 *
 * ⚠️ 判据打在行为上：失效后 `refreshCatalog()` 必须**重推**一次（表现为
 * `ctx.llm.listModels` 被逐渠道再问一遍）。不推进时钟 ⇒ 60 秒 TTL 未过
 * ⇒ 观察到的重推只可能来自「失效」。
 */
describe('★★ aggregate 自己的目录缓存也立即失效', () => {
  function makeAggregateCtx(): { ctx: never; calls: () => number } {
    let calls = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'loomy', name: 'loomy' }],
        listModels: async () => {
          calls += 1
          return [{ id: 'm1', name: 'M1' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    }
    return { ctx: ctx as never, calls: () => calls }
  }

  function makePool(): never {
    return {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
  }

  it('★★ 失效 aggregate 后 refreshCatalog 立刻重推（不等 60 秒 TTL）', async () => {
    const clock = makeClock()
    const { ctx, calls } = makeAggregateCtx()
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: { expiryOf: async () => Number.MAX_SAFE_INTEGER } as never,
      now: clock.now,
    } as never)

    await adapter.refreshCatalog()
    const afterFirst = calls()
    expect(afterFirst, '⚪️ 冷启动必须真的读一轮渠道目录').toBeGreaterThan(0)

    // ⚠️ 不推进时钟：60 秒 TTL 未过 ⇒ 正常应直接吃缓存。
    await adapter.refreshCatalog()
    expect(calls(), '⚪️ TTL 内零额外渠道读取').toBe(afterFirst)

    invalidateCatalogCache('aggregate', clock.now())
    await adapter.refreshCatalog()
    expect(
      calls(),
      '★★ 失效后必须立刻重推（恒绿 = aggregate 自己的 catalogAt 没接上失效）',
    ).toBeGreaterThan(afterFirst)
  })

  it('★★ 失效一个渠道不得连带作废 aggregate（反之亦然）', async () => {
    const clock = makeClock()
    const { ctx, calls } = makeAggregateCtx()
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: { expiryOf: async () => Number.MAX_SAFE_INTEGER } as never,
      now: clock.now,
    } as never)
    await adapter.refreshCatalog()
    const afterFirst = calls()
    invalidateCatalogCache('loomy', clock.now())
    await adapter.refreshCatalog()
    expect(calls(), '★★ 失效一个渠道不该让聚合目录跟着重推').toBe(afterFirst)
  })
})

/**
 * ★★ **`isCatalogFresh` 的既有语义逐字不变**（仓库红线：它是唯一判据）。
 *
 * 新加的「被强制失效」是**正交输入**：不传它时（既有全部调用点与既有全部用例
 * 都是这样）判据必须与加入该参数**之前**逐字相同。
 *
 * ⚠️ 本组直接钉住那条等价性，因为它是「动唯一判据」这一动作的**唯一**安全网。
 */
describe('★★ `isCatalogFresh` 的既有语义逐字不变（正交输入）', () => {
  const NOW = 1_000_000

  it('★★ 不传失效时刻 ⇒ 与既有语义逐字一致', () => {
    // 从未成功读过 ⇒ 恒不新鲜（不能被当成「刚读过」）。
    expect(isCatalogFresh(0, NOW)).toBe(false)
    expect(isCatalogFresh(undefined, NOW)).toBe(false)
    // 周期内 / 边界 / 超期（边界是 `age < ttlMs`，差 1ms 仍新鲜）。
    expect(isCatalogFresh(NOW - 1, NOW)).toBe(true)
    expect(isCatalogFresh(NOW - (CATALOG_REFRESH_INTERVAL_MS - 1), NOW)).toBe(true)
    expect(isCatalogFresh(NOW - CATALOG_REFRESH_INTERVAL_MS, NOW)).toBe(false)
    expect(isCatalogFresh(NOW - CATALOG_REFRESH_INTERVAL_MS - 1, NOW)).toBe(false)
    // 时钟回拨（`at` 在未来）判**新鲜**：否则一次 NTP 校时会让全部目录同时判陈旧。
    expect(isCatalogFresh(NOW + 1_000, NOW)).toBe(true)
  })

  it('★★ 显式给出「从未失效」（0）⇒ 与不传逐格等价', () => {
    for (const at of [0, 1, NOW - 1, NOW - CATALOG_REFRESH_INTERVAL_MS, NOW + 1_000]) {
      expect(isCatalogFresh(at, NOW, CATALOG_REFRESH_INTERVAL_MS, 0))
        .toBe(isCatalogFresh(at, NOW))
    }
  })

  it('★★ 失效只作用于「不晚于失效时刻」的读数，且不改变 TTL 那一腿', () => {
    const invalidatedAt = NOW - 5_000
    // 在失效**之前**读到 ⇒ 陈旧（该重拉）。
    expect(isCatalogFresh(NOW - 6_000, NOW, CATALOG_REFRESH_INTERVAL_MS, invalidatedAt)).toBe(false)
    // 同一毫秒也判陈旧（宁可多拉一次，也不要「点完开关纹丝不动」）。
    expect(isCatalogFresh(NOW - 5_000, NOW, CATALOG_REFRESH_INTERVAL_MS, invalidatedAt)).toBe(false)
    // 失效**之后**读到 ⇒ 回到 TTL 判据（这里 TTL 内 ⇒ 新鲜）。
    expect(isCatalogFresh(NOW - 4_000, NOW, CATALOG_REFRESH_INTERVAL_MS, invalidatedAt)).toBe(true)
    // 且 TTL 那一腿仍在：失效之后读到但已超期 ⇒ 仍陈旧。
    const old = NOW - CATALOG_REFRESH_INTERVAL_MS - 1
    expect(isCatalogFresh(old, NOW, CATALOG_REFRESH_INTERVAL_MS, invalidatedAt)).toBe(false)
  })

  it('★ `isCatalogFreshFor` 只在登记过的 provider 上生效（未登记 ⇒ 等价于旧判据）', () => {
    clearCatalogInvalidations()
    expect(isCatalogFreshFor('loomy', NOW - 1, NOW), '未失效 ⇒ 周期内新鲜').toBe(true)
    invalidateCatalogCache('loomy', NOW)
    expect(isCatalogFreshFor('loomy', NOW - 1, NOW), '失效后 ⇒ 陈旧').toBe(false)
    expect(isCatalogFreshFor('zcode', NOW - 1, NOW), '别的 provider 不受影响').toBe(true)
    expect(catalogInvalidatedAt('loomy'), '★ 失效时刻可读（诊断用）').toBe(NOW)
    expect(catalogInvalidatedAt('zcode'), '★ 从未失效 ⇒ 0').toBe(0)
  })
})
