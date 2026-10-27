/**
 * 模型目录的 20 分钟 TTL：**A 类四家**（loomy / minimax / raccoon / zcode）
 * 与 **B 类四家**（trae / lobsterai / accio / codearts 系），
 * 外加 **buddy 的「重测无视 TTL」路径分离**。
 *
 * ⚠️ 判据打在**行为**上：`fetchRemoteModels` 的调用次数 + 返回的目录内容，
 *    不锁内部字段（`remoteModels` / `catalogAt` / `remoteComplete` 是实现细节）。
 *
 * ⚠️ 两类的**代码形态不同**，故用例结构也刻意不同：
 *    - A 类的短路有两处（`loadModels` 的「方法入口」+「gate 后复查」，
 *      见 `loomy-adapter.ts`）；短路条件是「有值 **且** 未超期」。
 *    - B 类的短路只有一处（`ensureRemoteModels` 入口）；codearts / buddy 还多一条
 *      「完整性」腿（`remoteComplete`）与 `RemoteCatalogGate` 包裹。
 *    两类**共享**的只有「调用次数」这一条可观测面。
 *
 * ⚠️⚠️ buddy 的断言落在**两条路径的分离**上：
 *    `refreshCatalog()`（用户主动重测）**必须无视 TTL 强制重拉**，
 *    而 `ensureRemoteModels`（日常保鲜）**必须**在 20 分钟内短路。
 *    两者共用同一份「拉取次数」观测面，故这两条用例合起来才锁住分离。
 *
 * ⚠️⚠️ 本仓库实测过「源码文本断言」在 `if (false)` 死分支里恒绿（5 条）。
 *    ⇒ 本文件**一条源码判据都没有**，全是调用次数 / 返回内容。
 */
import { describe, expect, it, vi } from 'vitest'
import { CATALOG_REFRESH_INTERVAL_MS } from '../../src/model-catalog.js'
import { AccioAdapter } from '../../src/accio-adapter.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { MinimaxAdapter } from '../../src/minimax-adapter.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'

/**
 * 造一个**可推进的假时钟**。
 *
 * ⚠️ 这里**只造时钟、不造适配器** —— 适配器由各用例自己构造（两类的构造选项
 *    形状不同，见下）。返回 `{ now, advance }`：`now` 塞进适配器的 `now` 选项，
 *    `advance` 用来推进 TTL / 冷却窗口。
 *
 * ⚠️ `accountPool` 一律不给：`createModelCatalog` 的 `listModels` 首行就是
 *    `providerCatalogVisible(deps.accountPool, id)`，无池时它放行（返回 true），
 *    于是目录读取路径一定会被走到 —— 否则这条用例会退化成「什么都没发生也绿」。
 */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let clock = 1_000_000
  return { now: () => clock, advance: (ms: number) => { clock += ms } }
}

/** A 类四家共同的那份最小构造集。 */
interface AOptions {
  fetchRemoteModels: () => Promise<readonly unknown[]>
  now: () => number
}

/**
 * A 类四家的构造表。
 *
 * ⚠️ 四家的**选项形状不同**（zcode 的 `listModels` 额外先过一道 `ready()`），
 *    故用一张表统一驱动 —— 参数化正是为了让「A 类四家都满 20 分钟会重拉」
 *    这条**每家各跑一次**，而不是只有 loomy 有覆盖。
 */
const A_FAMILY: readonly {
  /** provider id（也是用例标题里显示的名字）。 */
  id: string
  build: (options: AOptions) => { listModels: (provider: string) => Promise<readonly unknown[]> }
}[] = [
  { id: 'loomy', build: (o) => new LoomyAdapter(o as never) },
  { id: 'minimax', build: (o) => new MinimaxAdapter(o as never) },
  { id: 'raccoon', build: (o) => new RaccoonAdapter(o as never) },
  { id: 'zcode', build: (o) => new ZcodeAdapter(o as never) },
]

/**
 * A 类四家共用的构造参数。
 *
 * ⚠️ `resolveCredential` 返回**非空**是必需的：zcode 的 `listModels` 先 `await
 *    this.ready()`，缺省实现读 `resolveCredential()`，返回 `undefined` 会让它
 *    整条短路成 `[]` ⇒ fetch 一次都不发生 ⇒ 那格覆盖静默归零。
 */
function aOptions(
  fetchRemoteModels: () => Promise<readonly unknown[]>,
  now: () => number,
): AOptions & Record<string, unknown> {
  return {
    credentialRef: 'CRED',
    resolveCredential: async () => ({ token: 't' }),
    refresh: async () => {},
    fetchRemoteModels,
    now,
  }
}

describe('A 类：目录缓存的 20 分钟 TTL', () => {
  /**
   * 用一个**全新的适配器**跑（无缓存）。
   * ⚠️ `model-catalog-parity.spec.ts` 的 (j) 守着「冷缓存下 listAllModels 非空」，
   *    本文件刻意不依赖它 —— 那是另一条不变式。
   */
  it.each(A_FAMILY)('⚪️ 冷缓存首次 listModels 必拉一次远端（$id）', async ({ id, build }) => {
    const fetchRemoteModels = vi.fn(async () => [
      { id: 'm1', name: 'M1' },
      { id: 'm2', name: 'M2' },
    ])
    const adapter = build(aOptions(fetchRemoteModels, makeClock().now))
    const models = await adapter.listModels(id)
    expect(fetchRemoteModels, '⚪️ 冷缓存必须真拉').toHaveBeenCalledTimes(1)
    expect(models.length, '⚪️ 拉到的目录必须可见').toBe(2)
  })

  it.each(A_FAMILY)('⚪️ 周期内再调 listModels **不再**打远端（$id）', async ({ id, build }) => {
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = build(aOptions(fetchRemoteModels, makeClock().now))
    await adapter.listModels(id)
    await adapter.listModels(id)
    await adapter.listModels(id)
    expect(fetchRemoteModels, '⚪️ 周期内零额外请求（这是「有缓存」的全部意义）')
      .toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️⚠️ **参数化到四家**：只测 loomy 的话，把 minimax / raccoon / zcode 的
   *    `isCatalogFresh` 换成 `() => true` 全仓测试仍会绿 —— 那正是
   *    「上一轮把 A 类整段删掉」造成的后果（A 类 TTL 行为零覆盖）。
   *    闸门本身也要一并验：把 `isCatalogFresh` 换成恒假同样会红。
   */
  it.each(A_FAMILY)('⚪️ $id 超过 20 分钟后重新拉远端（差 1ms 仍新鲜）', async ({ id, build }) => {
    // ⚠️ 必须能推进时钟，否则这条恒绿 —— 那正是「TTL 判据没生效」的形态。
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = build(aOptions(fetchRemoteModels, clock.now))
    await adapter.listModels(id)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS - 1)
    await adapter.listModels(id)
    expect(fetchRemoteModels, '⚪️ 差 1ms 仍不重拉').toHaveBeenCalledTimes(1)
    clock.advance(1)
    await adapter.listModels(id)
    expect(fetchRemoteModels, '⚪️ 满 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  /**
   * ⚠️ 失败时**不得返回空目录**：`listModels` 返回 `[]` 会让 DSH 的
   *    `buildModelCatalog` 把**整个 provider 分组隐藏**（用户界面上一个模型都
   *    不剩，且无日志）。本条的实测落点是「回落兜底表 / TTL 内的旧读数」，
   *    而**不是**「原样返回上次那份远端」—— A 类的 `loadModels` 在 TTL 已过时
   *    会落到兜底表那一行返回。断言只锁「非空」这条契约，不锁具体是哪一份。
   */
  it.each(A_FAMILY)('⚪️ 拉取失败不得返回空目录（$id）', async ({ id, build }) => {
    const clock = makeClock()
    let broken = false
    const fetchRemoteModels = vi.fn(async () => {
      if (broken) throw new Error('上游 503')
      return [{ id: 'm1', name: 'M1' }]
    })
    const adapter = build(aOptions(fetchRemoteModels, clock.now))
    await adapter.listModels(id)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
    broken = true
    const models = await adapter.listModels(id)
    expect(models.length, '⚪️ 上游挂了也必须留得住模型（空列表会让 DSH 隐藏整个分组）')
      .toBeGreaterThan(0)
  })
})

describe('B 类：目录缓存的 20 分钟 TTL', () => {
  // ⚠️ 四条都以「周期内零额外请求 → 差 1ms 仍不重拉 → 满 20 分钟必须重拉」三拍推进：
  //    上一版只测了「到期」那一侧 ⇒ 边界判据 `age < ttlMs`（`isCatalogFresh` 里那个
  //    写死的 `<`）在「写成 `<=` / `>` / `>=` 的变异下仍全绿。补中间那一拍把它钉住。
  it('⚠️ trae 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new TraeAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: clock.now,
    } as never)
    await adapter.listModels('trae')
    await adapter.listModels('trae')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS - 1)
    await adapter.listModels('trae')
    expect(fetchRemoteModels, '⚠️ 差 1ms 仍新鲜，不得重拉').toHaveBeenCalledTimes(1)
    clock.advance(1)
    await adapter.listModels('trae')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ lobsterai 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new LobsteraiAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: clock.now,
    } as never)
    await adapter.listModels('lobsterai')
    await adapter.listModels('lobsterai')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS - 1)
    await adapter.listModels('lobsterai')
    expect(fetchRemoteModels, '⚠️ 差 1ms 仍新鲜，不得重拉').toHaveBeenCalledTimes(1)
    clock.advance(1)
    await adapter.listModels('lobsterai')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ accio 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    const adapter = new AccioAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      now: clock.now,
    } as never)
    await adapter.listModels('accio')
    await adapter.listModels('accio')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS - 1)
    await adapter.listModels('accio')
    expect(fetchRemoteModels, '⚠️ 差 1ms 仍新鲜，不得重拉').toHaveBeenCalledTimes(1)
    clock.advance(1)
    await adapter.listModels('accio')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ codearts 周期内不重拉、超期重拉', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
    // ⚠️ `catalogComplete` 必须上报**完整**：codearts 的短路判据是
    //    「已完整 **且** 未超期」，只给「有值」这一半 ⇒ 残缺目录永不重拉。
    //    本用例测 TTL 那一半，故必须显式给出完整判定。
    const adapter = new CodeArtsAdapter({
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('codearts')
    await adapter.listModels('codearts')
    expect(fetchRemoteModels, '⚠️ 周期内零额外请求').toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS - 1)
    await adapter.listModels('codearts')
    expect(fetchRemoteModels, '⚠️ 差 1ms 仍新鲜，不得重拉').toHaveBeenCalledTimes(1)
    clock.advance(1)
    await adapter.listModels('codearts')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟必须重拉').toHaveBeenCalledTimes(2)
  })

  /**
   * ⚠️⚠️ **codearts 的残缺目录必须仍能被后续成功拉取替换**。
   *
   * 这是加 TTL 前必须核实的那条不变式（见 `llm-adapter.ts` 的 `ensureRemoteModels`）：
   * 两个独立目录端点下，一个成功一个失败时 `models.length > 0` 但**残缺**。
   * 加 TTL 若误把残缺判成「新鲜」，残缺就会**永久固化**（原缺陷的翻版）。
   */
  it('⚠️ codearts 残缺目录不得被判为「新鲜」（TTL 不得掩盖完整性判据）', async () => {
    const clock = makeClock()
    // ⚠️⚠️ `RemoteCatalogGate` 的冷却走**墙钟**（`Date.now`），而 codearts 的
    //    闸门构造**没有**注入 `options.now`（见 `llm-adapter.ts` 的构造）。
    //    ⇒ 本用例必须让墙钟与注入时钟**同步推进**，否则第二次拉取会被 30 秒
    //    冷却挡掉 —— 那样断言的就不再是「完整性判据」，而是「冷却」。
    //    这是 `Date.now` 替身，与 `vi.useFakeTimers()` 不同：只在本用例内生效。
    const realNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.now())
    try {
      let complete = false
      const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1' }])
      const adapter = new CodeArtsAdapter({
        fetchRemoteModels: fetchRemoteModels as never,
        catalogComplete: () => complete,
        now: clock.now,
      } as never)
      // 第一次：残缺（两个端点只有一个成功）。
      await adapter.listModels('codearts')
      expect(fetchRemoteModels).toHaveBeenCalledTimes(1)

      // ⚠️ **只推进 31 秒**（越过冷却，**远在 20 分钟 TTL 之内**）：
      //    此刻若 TTL 被当成唯一判据，残缺目录会被判「新鲜」⇒ 永远不重拉 ⇒
      //    残缺固化。完整性判据必须**独立**生效。
      clock.advance(31_000)
      await adapter.listModels('codearts')
      expect(
        fetchRemoteModels,
        '⚠️ 残缺目录必须在周期内也继续重拉（完整性判据不得被 TTL 吞掉）',
      ).toHaveBeenCalledTimes(2)

      // 第二个端点恢复后目录变完整 ⇒ 此后进入 TTL 的**保鲜**语义。
      complete = true
      clock.advance(31_000)
      await adapter.listModels('codearts')
      const callsAfterComplete = fetchRemoteModels.mock.calls.length
      // ⚠️ 冷却已过、但仍远在 TTL 之内 ⇒ 完整目录必须短路。
      clock.advance(31_000)
      await adapter.listModels('codearts')
      expect(
        fetchRemoteModels.mock.calls.length,
        '⚠️ 完整目录进入 20 分钟保鲜（周期内零额外请求）',
      ).toBe(callsAfterComplete)
    } finally {
      realNow.mockRestore()
    }
  })

  /**
   * ⚠️⚠️ **这条曾经是恒绿的**（2026-10-18 复审实测）。
   *
   * 原文只断言「超期后真的又试了一次」（`calls === 2`）⇒ 变异「失败时**也**把
   * `catalogAt` 写成 `now`」在本用例里**观察不到**：失败后没有再调一次
   * `listModels`，少的那一次请求根本没机会被数到。
   * ⇒ 关键在**第三拍**：失败后再调一次，且落点选在
   * 「已越过闸门冷却、但仍在 20 分钟 TTL 之内」—— 这时它「本该重试」
   * 只可能因为「失败刷新了时刻」而不重试。
   *
   * ⚠️ 冷却时长已核实：`REMOTE_CATALOG_COOLDOWN_MS = 30_000`
   *    （`src/remote-catalog-gate.ts`），且 `run()` 把**抛错**与「返回空目录」
   *    同等对待（catch 后返回 `{ got:false, complete:false }`）⇒ **失败确实
   *    会写 `retryAt = now + 30s`**。故 31s 就是越过冷却的最小值。
   *
   * ⚠️⚠️ **必须让墙钟跟着一起推进**：trae 的闸门构造**没有**注入 `now`
   *    （走 `Date.now`，见 `trae-adapter.ts` 的 `catalogGate` 构造）⇒ 只推进
   *    注入时钟的话第三拍会被 30 秒冷却挡掉，那断言量的就变成「冷却」而非
   *    「失败有没有刷新时刻」。这是 `Date.now` 替身，只在本用例内生效。
   */
  it('⚠️ 上游失败不得刷新时刻（失败不写 catalogAt）', async () => {
    const clock = makeClock()
    const realNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.now())
    try {
      let broken = false
      const fetchRemoteModels = vi.fn(async () => {
        if (broken) throw new Error('上游 503')
        return [{ id: 'm1', name: 'M1' }]
      })
      const adapter = new TraeAdapter({
        fetchRemoteModels: fetchRemoteModels as never,
        now: clock.now,
      } as never)
      await adapter.listModels('trae')
      expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
      clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
      broken = true
      await adapter.listModels('trae')
      expect(fetchRemoteModels, '⚠️ 超期后必须真的再试一次（时刻已被刷新会短路）')
        .toHaveBeenCalledTimes(2)

      // ⚠️ 关键：失败后**再调一次** —— 若失败时把时刻刷新成「新鲜」，
      //    这一拍就会短路、fetch 停在 2 次 ⇒ 这条断言才有牙。
      // ⚠️ 31s 是越过闸门冷却（30s）的最小值，且远小于 20 分钟 TTL ⇒
      //    这一拍「本该重试」只可能因为「失败刷新了时刻」而失败。
      broken = false
      clock.advance(31_000)
      await adapter.listModels('trae')
      expect(
        fetchRemoteModels,
        '★★ 失败不得把时刻刷新掉（否则越过闸门冷却后也不再重试，要再等满 20 分钟）',
      ).toHaveBeenCalledTimes(3)
    } finally {
      realNow.mockRestore()
    }
  })
})

/**
 * buddy：重测与日常保鲜是**两条路**。
 *
 * ⚠️ 入口说明：本家的 `refreshCatalog()` 是**公开方法**（`BuddyAdapter` 上），
 *    不必绕 `registerBuddyLlm` 的回调。
 *    ⚠️⚠️ **真实的生产调用点只有一个**：`stream()` 里「该模型贴图能力未知时」
 *    补拉一次目录（`buddy-adapter.ts` 的图片分支）。
 *    ⚠️ 原先这里写的「② 客户端『重测』按钮经 RPC 触发的宿主路径」**不成立**
 *    （复审核实：`refreshCatalog` 在 `src/` 全目录只有 `buddy-adapter.ts` 自身与
 *    `aggregate-adapter.ts` 那个**不同类**命中，`src/index.ts` 与
 *    `src/jet-hub-rpc.ts` **零命中**）⇒ 面板上的「重测」按钮目前没有接线点。
 *    **但用例本身有效**：它守的是「`refreshCatalog` 无条件清字段 + 越过节流后
 *    必重拉」这条不变量，而不是某条 UI 路径的存在性。
 */
describe('buddy：重测与日常保鲜是两条路', () => {
  it('⚠️ refreshCatalog 无视 TTL，强制重拉（无条件的重拉路径不得变哑）', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1', supportsImages: true }])
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('buddy')
    expect(fetchRemoteModels, '⚠️ 冷缓存首拉').toHaveBeenCalledTimes(1)

    // ⚠️ **只推 11 秒** —— 越过「距上次尝试 ≥10 秒」的节流，却**远在 20 分钟 TTL
    //    之内**。这正是让断言可识别的窗口：若 refreshCatalog 也带 TTL 判据，
    //    此刻 `catalogAt` 未超期 ⇒ 会被短路 ⇒ 这条变红。
    //    （「推 11 秒就重拉」与下面「10 秒内不重拉」不矛盾：量的正是两条判据的分工。）
    clock.advance(11_000)
    await adapter.refreshCatalog()
    expect(
      fetchRemoteModels,
      '⚠️ 周期内点重测也必须重拉（这条变绿说明 TTL 吞掉了用户主动操作）',
    ).toHaveBeenCalledTimes(2)
  })

  it('⚠️ 日常保鲜仍受 TTL 约束（重测路径不得反向污染 ensureRemoteModels）', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1', supportsImages: true }])
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('buddy')
    await adapter.listModels('buddy')
    await adapter.resolveModel('buddy', 'm1')
    expect(
      fetchRemoteModels,
      '⚠️ listModels/resolveModel 共用同一条保鲜路径，周期内零额外请求',
    ).toHaveBeenCalledTimes(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS)
    await adapter.listModels('buddy')
    expect(fetchRemoteModels, '⚠️ 超 20 分钟后日常路径必须重拉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ 重测后拉取失败仍保住*旧*目录（不得把列表清空）', async () => {
    const clock = makeClock()
    let broken = false
    const fetchRemoteModels = vi.fn(async () => {
      if (broken) throw new Error('目录端点挂了')
      return [{ id: 'm1', name: 'M1', supportsImages: true }]
    })
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    const before = await adapter.listModels('buddy')
    clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
    broken = true
    await adapter.refreshCatalog()
    const after = await adapter.listModels('buddy')
    expect(after.length, '⚠️ 重测失败后目录不得被清空').toBeGreaterThan(0)
    expect(after.length, '⚠️ 重测失败后仍应是上次那份').toBe(before.length)
  })

  it('⚠️ 重测仍受「距上次尝试 ≥10 秒」节流约束（用户定的规则不得被绕过）', async () => {
    const clock = makeClock()
    const fetchRemoteModels = vi.fn(async () => [{ id: 'm1', name: 'M1', supportsImages: true }])
    const adapter = new BuddyAdapter({
      credentialRef: 'CRED' as never,
      resolveCredential: async () => ({ token: 't' } as never),
      refresh: async () => {},
      fetchRemoteModels: fetchRemoteModels as never,
      catalogComplete: () => true,
      now: clock.now,
    } as never)
    await adapter.listModels('buddy')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
    // ⚠️ 不推时钟 ⇒ 距上次尝试不足 10 秒 ⇒ 节流命中，**不得**重拉。
    //    这条与上面那条「周期内必须重拉」看似矛盾，量的正是**两条判据的分工**：
    //    节流（10s，拉取频率）与 TTL（20min，缓存保鲜）是**两件事**。
    await adapter.refreshCatalog()
    expect(fetchRemoteModels, '⚠️ 10 秒节流内不得重复拉取').toHaveBeenCalledTimes(1)
  })
})