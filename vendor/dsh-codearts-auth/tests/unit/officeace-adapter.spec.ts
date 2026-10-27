/**
 * `officeace-adapter.spec.ts` —— OfficeAce 目录的 **20 分钟 TTL**（Task 4）。
 *
 * ## 背景：它是 23 家里**唯一**没接 `createModelCatalog` 的一家
 *
 * 其余 22 家要么走 `createModelCatalog`，要么已按同一形态自带
 * `private catalogAt` + `isCatalogFresh(...)`。本家此前**每轮 `listModels` 都真打
 * 两个上游端点**：
 *
 * | 端点 | 由谁发起 | 签名面 |
 * |---|---|---|
 * | `{maasBaseUrl}/v2/models` | `probe()`（只判断 200 + JSON） | Basic |
 * | `{defaultBaseUrl}/v1/model-token-rates` | `fetchModelTokenRates()`（倍率） | V11（管理面） |
 *
 * 实测日志稳定 80~340ms，其余 22 家是 1~17ms 的纯本地读。
 * ⇒ 两个端点**共用同一个 `catalogAt`**：只缓存其一时，另一处仍每轮打上游。
 *
 * ⚠️ 用户 2026-10-18 决定：**不迁进 `createModelCatalog`**（12 家依赖它的契约），
 *    只要求「有缓存 + 会定期更新」。
 *
 * ## 本文件守的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 冷缓存首调必真打上游 | 目录永不刷新 |
 * | 2 | **周期内零额外请求** | 这就是「有缓存」的全部意义 |
 * | 3 | 差 1ms 仍新鲜 / 满 20 分钟必重拉 | 边界判据 `<` 漂移成 `<=` |
 * | 4 | **拉取失败保留旧目录**（不得清空） | 空列表让 DSH 隐藏整个分组 |
 * | 5 | **失败不得刷新时刻** | 一次抖动要等满 20 分钟才重试 |
 * | 6 | `listAllModels` **同步**且冷缓存**非空** | async ⇒ `not iterable`；空 ⇒ aggregate 被误显示「已关闭」（`model-catalog.ts:182`）|
 *
 * ⚠️ **判据一律打在行为上**（调用次数 / 返回值），本文件**一条源码文本断言都没有**
 *    —— 本仓库实测过 5 条源码判据在 `if (false)` 死分支里恒绿。
 * ⚠️ 不发真实网络：`fetchImpl` 分流 `/v2/models`；倍率端点由 `fetchModelTokenRates()`
 *    内部自读，`tests/setup-isolation.ts` 已把 `DSH_OFFICEACE_HOME` 指向临时目录
 *    ⇒ 读不到本机凭据 ⇒ 它直接返回空表（**优雅降级**，与「未装 OfficeAce」同形），
 *    不会打真实上游。
 */

import { describe, expect, it, vi } from 'vitest'
import { OfficeAceAdapter } from '../../src/officeace-adapter.js'
import { CATALOG_REFRESH_INTERVAL_MS } from '../../src/model-catalog.js'
import type { OfficeAceCredential } from '../../src/officeace-auth.js'

/** 可推进的假时钟：TTL 的推进必须可控，否则「过期必重拉」那条恒绿。 */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let clock = 1_000_000
  return { now: () => clock, advance: (ms: number) => { clock += ms } }
}

function cred(): OfficeAceCredential {
  return {
    modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: 'https://officeace.example',
    access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'r', dpopPrivateJwk: {},
  } as unknown as OfficeAceCredential
}

/**
 * 造一个适配器，并把**真实观测面**（`/v2/models` 的请求次数）暴露出来。
 *
 * @param broken - 置真后 `/v2/models` 一律 401（模拟上游不可达 / 凭据失效）。
 * @returns 适配器与探针
 */
function makeAdapter(options: { now: () => number; broken?: () => boolean }): {
  adapter: OfficeAceAdapter
  probeCalls: () => number
} {
  const clock = { n: 0 }
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/v2/models')) {
      clock.n += 1
      if (options.broken?.() === true) {
        return new Response('APIG.1009', { status: 401, headers: { 'content-type': 'text/plain' } })
      }
      return new Response(JSON.stringify({ data: [{ id: 'glm-5.2' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const adapter = new OfficeAceAdapter({
    credentialProvider: async () => cred(),
    fetchImpl,
    now: options.now,
  } as never)
  return { adapter, probeCalls: () => clock.n }
}

describe('officeace：目录缓存的 20 分钟 TTL', () => {
  it('★ 冷缓存首次 listModels 必真打上游（否则目录永不刷新）', async () => {
    const clock = makeClock()
    const { adapter, probeCalls } = makeAdapter({ now: clock.now })
    const models = await adapter.listModels('officeace')
    expect(probeCalls(), '★ 冷缓存必须真拉一次').toBe(1)
    expect(models.length, '★ 拉到的目录必须可见').toBeGreaterThan(0)
  })

  it('★★ 周期内再调 listModels 零额外请求，超 20 分钟才重拉（差 1ms 仍新鲜）', async () => {
    const clock = makeClock()
    const { adapter, probeCalls } = makeAdapter({ now: clock.now })
    await adapter.listModels('officeace')
    await adapter.listModels('officeace')
    await adapter.listModels('officeace')
    expect(probeCalls(), '★★ 周期内零额外请求（这是「有缓存」的全部意义）').toBe(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS - 1)
    await adapter.listModels('officeace')
    expect(probeCalls(), '★★ 差 1ms 仍新鲜，不得重拉').toBe(1)
    clock.advance(1)
    await adapter.listModels('officeace')
    expect(probeCalls(), '★★ 满 20 分钟必须重拉').toBe(2)
  })

  it('★★ 超期拉取失败必须**保留旧目录**（不得清空，否则 DSH 隐藏整个分组）', async () => {
    const clock = makeClock()
    let broken = false
    const { adapter, probeCalls } = makeAdapter({ now: clock.now, broken: () => broken })
    const before = await adapter.listModels('officeace')
    expect(before.length).toBeGreaterThan(0)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
    broken = true
    const after = await adapter.listModels('officeace')
    expect(probeCalls(), '★ 超期后必须真的再试一次').toBe(2)
    expect(after.length, '★★ 上游挂了也必须留得住模型（空列表会让 DSH 隐藏整个分组）')
      .toBeGreaterThan(0)
    expect(after.map((m) => m.id), '★★ 且应仍是上次那份目录').toEqual(before.map((m) => m.id))
  })

  it('★★ 失败**不得刷新时刻**（否则一次抖动要等满 20 分钟才重试）', async () => {
    const clock = makeClock()
    let broken = false
    const { adapter, probeCalls } = makeAdapter({ now: clock.now, broken: () => broken })
    await adapter.listModels('officeace')
    expect(probeCalls()).toBe(1)
    clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
    broken = true
    await adapter.listModels('officeace')
    expect(probeCalls(), '超期后必须真的再试一次（时刻被刷新会短路）').toBe(2)
    // ⚠️ 关键：失败后**再调一次**，只推进 1ms（仍在 TTL 之内）。
    // 这一拍「本该重试」只可能因为「失败时把时刻刷新了」而不重试。
    broken = false
    clock.advance(1)
    await adapter.listModels('officeace')
    expect(probeCalls(), '★★ 失败不得把时刻刷新掉（否则越过冷却后也不再重试）').toBe(3)
  })

  it('★ 冷缓存下凭据不可达仍诚实返回空（既有约定逐字不变：隐藏不可恢复的分组）', async () => {
    const clock = makeClock()
    let broken = true
    const { adapter } = makeAdapter({ now: clock.now, broken: () => broken })
    await expect(adapter.listModels('officeace')).resolves.toEqual([])
    // ⚠️ 对照：修好之后仍保留旧读数 ⇒ 上游一恢复，目录立刻回来。
    broken = false
    const back = await adapter.listModels('officeace')
    expect(back.length, '★ 冷启动失败必须能在下一次重试时自愈').toBeGreaterThan(0)
  })
})

describe('officeace：listAllModels 的同步 + 非空契约', () => {
  it('★★ 冷缓存下 listAllModels **同步**返回非空数组（aggregate 不得被误显示为「已关闭」）', () => {
    // ⚠️ `provider.status` 会**同步**调它算 `total`，判据是
    //    `closed = total > 0 && disabled === total`（`model-catalog.ts:182` 记着
    //    真实缺陷：aggregate 冷缓存 `total=1`，关掉 auto 就掉进「已关闭」分组）。
    const adapter = new OfficeAceAdapter({} as never)
    const all = adapter.listAllModels()
    expect(Array.isArray(all), '★ 必须同步返回数组（改成 async 会抛 not iterable）').toBe(true)
    expect(all.length, '★★ 冷缓存不得为空数组，否则 aggregate 掉进「已关闭」分组').toBeGreaterThan(0)
  })
})
