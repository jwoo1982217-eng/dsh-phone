/**
 * auto 选型：**额度已尽的 zcode 必须退出候选**（真实缺陷回归，用户报障 2026-10-07）。
 *
 * ## 缺陷
 *
 * auto 选中了额度已尽的 zcode，请求直接以
 * `QUOTA_EXCEEDED: 账号在模型 "GLM-5.3" 上的额度已用尽或没有可用权益` 失败 ——
 * 而 auto 的价值主张恰恰是「挑有额度、且快作废的那个」。折算错了就挑中一个
 * **根本不能用**的渠道，比不做 auto 更糟（用户看到的是「auto 坏了」，
 * 且每次重试都撞同一个渠道）。
 *
 * 根因在 `zcodeExpiry` 把「余额为 0」折算成了**可用**的语义：
 *
 * | 形态 | 旧折算 | 后果 |
 * |---|---|---|
 * | 无桶 + 有可领活动（`claimablePlans`） | 当日 24:00 | **排最前**，优先选中 |
 * | 无桶 / 桶余额为 0，无可领 | `NEVER` | 排最后，但**不被剔除** ⇒ 池里只剩它时必被选中 |
 *
 * ⚠️ 两个折算值都是 `pickSoonestProvider` 眼里的**合法排序值**（它只剔除
 * `UNUSABLE`）—— 这类缺陷编译期抓不到，只能靠断言守住。
 *
 * ## ⚠️ 为什么这些用例断言**折算值**而不是源码文本
 *
 * 本缺陷的初版回归用例是对 `auto-adapter.ts` 源码做正则匹配（`bodyOf('zcodeExpiry')`
 * + `toMatch`）。master 把四个 `*Expiry` **搬移**到本模块后，那批用例**全部变红** ——
 * 语义一行未变、只是换了文件。**断言位置而非行为的用例会在重构时假失败**，
 * 也无法证明折算结果正确。故这里一律打桩上游、断言函数返回值。
 *
 * ## 与既有用例的分工
 *
 * `aggregate-expiry.spec.ts` 守的是控制流（未接入渠道 / 无账号 / abort / 缓存），
 * 以及 `codeArtsExpiry` 的「读不到到期时间就不猜」。本文件只守 zcode 的折算格。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createExpiryProbe, zcodeExpiry } from '../../src/aggregate-expiry.js'
import { NEVER, UNUSABLE, pickSoonestProvider } from '../../src/aggregate-core.js'
import { createProviderExpiry } from '../../src/provider-expiry.js'
import { clearProviderRuntimes, registerProviderRuntime } from '../../src/provider-runtime.js'
import { descriptorOf } from '../../src/provider-registry.js'

const CRED = {
  zcode_jwt: 'jwt',
  device_mid: 'mid',
  app_version: '3.14.4',
} as never

/**
 * 只实现 `listAvailableCredentials` 的池（走新路径，不触旧的单账号回退）。
 *
 * ⚠️ 用于 `createExpiryProbe` 的缓存用例 —— 那条用例必须走**真实的探针**，
 * 才能验证「缓存 + `clear()`」这对行为，而不是只看折算函数的返回值。
 */
function poolOf(credentials: unknown[]) {
  return {
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: `a${Math.random()}` }, credential,
    })),
  } as never
}

/**
 * 按 URL 分派 `balance` / `preview` 的响应（顺序 = 实际调用顺序）。
 *
 * ⚠️ `fetchZcodeBalance` **总是**发第二个请求（`preview`）取可领活动
 * （`zcode-upstream.ts` 的 `claimablePlans`），故两段响应都要给。
 */
function stubZcode(balanceBody: unknown, previewBody: unknown) {
  vi.stubGlobal('fetch', (async (url: string) => new Response(
    JSON.stringify(String(url).includes('/preview') ? previewBody : balanceBody),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch)
}

/** 当日 24:00（UTC+8）—— 「有额度、当天作废」的折算值。 */
const todayEnd = (): number => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 8 * 3600 * 1000
}

/**
 * 把**真实的**临期折算实现挂进 runtime。
 *
 * ⚠️ 分派已改为查 `ProviderRuntime.expiry`（Task 5）⇒ 本文件里走
 * `createExpiryProbe` 的用例（缓存 + `clear()` 那两条）必须先注册 runtime，
 * 否则探针在「未接入」短路处就返回 `UNUSABLE` 了。
 * ⚠️ 挂的是**生产那张表**（`createProviderExpiry()`），不是本文件自己写一份映射
 * —— 后者是「同一语义两套判据」（本仓库首条红线）。
 */
beforeEach(() => {
  clearProviderRuntimes()
  for (const [id, expiry] of Object.entries(createProviderExpiry())) {
    registerProviderRuntime({ descriptor: descriptorOf(id)!, expiry })
  }
})

afterEach(() => { vi.unstubAllGlobals(); clearProviderRuntimes() })

describe('★ zcode 折算：额度已尽 ⇒ UNUSABLE（退出候选）', () => {
  it('★ 无桶 + 有可领活动 ⇒ UNUSABLE（「可领」不等于「已拥有」）', async () => {
    // 实测形态（`zcode-balance-merge.spec.ts`）：`balances` 空、`preview` 有
    // `start-plan`。旧实现按当日额度算 ⇒ **排最前** ⇒ 请求必然 QUOTA_EXCEEDED
    //（额度要先 claim 才进桶，没领就是当前不可用）。
    stubZcode(
      { code: 0, data: { balances: [] } },
      { code: 0, data: { plans: [{ plan_id: 'zcode-v3-start-plan-trust-1003', name: 'GLM-5.3-Flash' }] } },
    )
    expect(await zcodeExpiry(CRED)).toBe(UNUSABLE)
  })

  it('★ 桶余额为 0 且无可领 ⇒ UNUSABLE（不是 NEVER —— NEVER 会当选）', async () => {
    // 旧实现 `return NEVER` ⇒ 排最后但**不被剔除**：池里只剩它时必被选中。
    stubZcode(
      { code: 0, data: { balances: [{ remaining_units: 0, available_units: 0 }] } },
      { code: 0, data: { plans: [] } },
    )
    const value = await zcodeExpiry(CRED)
    expect(value).toBe(UNUSABLE)
    // 方向对照：NEVER 是「可用、只是不临期」，它**参与排序且可当选**，
    // 正是本缺陷的成因，故绝不能用它表示「额度已尽」。
    expect(value).not.toBe(NEVER)
  })

  it('★ 桶余额为 0 但有可领活动 ⇒ 仍是 UNUSABLE（可领不能翻案）', async () => {
    stubZcode(
      { code: 0, data: { balances: [{ remaining_units: 0, available_units: 0 }] } },
      { code: 0, data: { plans: [{ plan_id: 'start-plan-x', name: 'GLM-5.3-Flash' }] } },
    )
    expect(await zcodeExpiry(CRED)).toBe(UNUSABLE)
  })
})

describe('★ zcode 折算：仍有额度的形态必须保留在候选里（防误伤）', () => {
  it('★ 桶有余额且有到期时间 ⇒ 取该时刻（越小越先烧）', async () => {
    const exp = 4102444800 // 2100-01-01，远期
    stubZcode(
      { code: 0, data: { balances: [{ remaining_units: 100, available_units: 100, expires_at: exp }] } },
      { code: 0, data: { plans: [] } },
    )
    expect(await zcodeExpiry(CRED)).toBe(exp * 1000)
  })

  it('★ 多个桶 ⇒ 取最早到期（临期优先的价值主张）', async () => {
    const soon = 1800000000
    const later = 4102444800
    stubZcode(
      {
        code: 0,
        data: {
          balances: [
            { remaining_units: 10, available_units: 10, expires_at: later },
            { remaining_units: 20, available_units: 20, expires_at: soon },
          ],
        },
      },
      { code: 0, data: { plans: [] } },
    )
    expect(await zcodeExpiry(CRED)).toBe(soon * 1000)
  })

  it('★★ 桶有余额但上游**未下发** `expires_at` ⇒ 当日 24:00（不得误判成不可用）', async () => {
    // ⚠️ 这一格是初版修法的**误伤点**：初版「没有有效桶就 UNUSABLE」会把这
    //    个账号剔除 —— 而 `expires_at` 缺失是上游的常见形态
    //    （`zcode-upstream.ts` 的 `num(record.expires_at)` 取不到就是 undefined），
    //    此时 `remaining_units` 可能有一个亿。剔除它 = 丢掉一个**确实有额度**的渠道。
    stubZcode(
      { code: 0, data: { balances: [{ remaining_units: 94539275, available_units: 94539275, unit_type: 'token' }] } },
      { code: 0, data: { plans: [] } },
    )
    const value = await zcodeExpiry(CRED)
    expect(value, '有余额 ⇒ 按当日额度保守估算').toBe(todayEnd())
    expect(value).not.toBe(UNUSABLE)
  })

  it('★ 只有 `remaining_units`（无 `available_units`）也算有余额', async () => {
    // 实现是 `available_units ?? remaining_units ?? 0`，两个字段名都要认。
    stubZcode(
      { code: 0, data: { balances: [{ remaining_units: 5000 }] } },
      { code: 0, data: { plans: [] } },
    )
    expect(await zcodeExpiry(CRED)).toBe(todayEnd())
  })
})

describe('★ zcode 折算：查不到 ≠ 没有余额（既有口径不得被本修复破坏）', () => {
  it('★ balance 请求失败 ⇒ UNUSABLE', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(await zcodeExpiry(CRED)).toBe(UNUSABLE)
  })

  it('★ 网络抛错 ⇒ UNUSABLE（不把异常当 NEVER）', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('network down') }) as unknown as typeof fetch)
    expect(await zcodeExpiry(CRED)).toBe(UNUSABLE)
  })

  it('★★ 企业版（`displayMode: enterprise`）⇒ NEVER（**不是** UNUSABLE —— 可用账号不得被剔除）', async () => {
    // ⚠️⚠️ 本条是**对抗审计实测证伪后改正**的（2026-10-07）。我上一版把它写成了
    //    `⇒ UNUSABLE` 并把「不下发额度数字」当成「余额为 0」—— 那正是上游
    //    `zcode-upstream.ts:257-259` **点名禁止**的推断：
    //      「企业版不下发额度数字、只给外部链接 —— 此时返回 `{enterprise:true,buckets:[]}`，
    //        **不要**显示成 0（**0 是「已用光」的语义**）」
    //    企业版账号**能正常推理**（`zcode-adapter.ts` 的推理路径不检查 `enterprise`），
    //    判成 `UNUSABLE` 会让它被永久排除出 auto 候选（`pickSoonestProvider` 剔除）。
    //
    //    ⚠️ 当时那条用例**把回归固化成了契约** —— 比单纯的 bug 更难发现，
    //    因为「测试通过」会被读成「行为正确」。教训：**期望值本身也要有上游依据**，
    //    不能只因为「代码这么写的」就把它写成契约。
    stubZcode({ code: 0, data: { displayMode: 'enterprise' } }, { code: 0, data: { plans: [] } })
    const value = await zcodeExpiry(CRED)
    expect(value).toBe(NEVER)
    expect(value).not.toBe(UNUSABLE)
  })

  it('★★ 企业版在 auto 里**必须能当选**（用真实排序函数验证，不只看折算值）', async () => {
    // ⚠️ 只断言「折算值 === NEVER」还不够 —— 真正要守的是「它没被剔除」。
    //    故这里把折算值喂给**真实的** `pickSoonestProvider`，验证它确实当选。
    stubZcode({ code: 0, data: { displayMode: 'enterprise' } }, { code: 0, data: { plans: [] } })
    const expiry = await zcodeExpiry(CRED)
    // 池里只有企业版 zcode ⇒ 它必须当选（而不是 undefined = 「没有任何可用候选」）。
    expect(pickSoonestProvider([['zcode', expiry]])).toBe('zcode')
  })
})

/**
 * ★★ 签到（claim）之后必须清临期折算缓存。
 *
 * ## 为什么这条守在这里（真实缺陷，对抗审计实测证伪，2026-10-07）
 *
 * `createExpiryProbe` 的折算缓存**也缓存 `UNUSABLE`**，而 `zcodeExpiry` 现在把
 * 「余额为 0」判成 `UNUSABLE`。zcode 的每日赠送额度**要先领取才进 `balances` 桶**
 * ⇒ 「先撞额度尽（写 `UNUSABLE`）→ 去签到成功 → 立刻用 auto」时，**最长 60 秒内
 * auto 仍说没有候选**，用户会以为签到没用。
 *
 * ⚠️ 旧实现不会暴露它（那时「余额 0 但有可领活动」返回**当日**、不写 `UNUSABLE`）——
 * 是本次收窄**引入**的时序。故必须有这条用例守住「`clear()` 能救回来」。
 */
describe('★★ 签到后折算缓存必须可清（否则 60 秒内 auto 仍说无候选）', () => {
  it('★★ clear() 之后必须重新探测（签到场景：从 UNUSABLE 变回有额度）', async () => {
    // 第 1 步：余额 0 ⇒ UNUSABLE（并写入缓存）
    stubZcode({ code: 0, data: { balances: [] } }, { code: 0, data: { plans: [] } })
    const probe = createExpiryProbe(poolOf([CRED]), async () => 'm1')
    expect(await probe('zcode')).toBe(UNUSABLE)

    // 第 2 步：用户签到成功，余额进桶（上游已变，但缓存未清）
    stubZcode(
      { code: 0, data: { balances: [{ remaining_units: 100000000, available_units: 100000000 }] } },
      { code: 0, data: { plans: [] } },
    )
    // 缓存命中 ⇒ 仍是 UNUSABLE（这正是「签到后 60 秒不可见」的现象）
    expect(await probe('zcode'), '缓存内仍是 UNUSABLE').toBe(UNUSABLE)

    // 第 3 步：清缓存（RPC 在领取成功后调它）⇒ 必须看到新余额
    probe.clear()
    const after = await probe('zcode')
    expect(after, 'clear() 后必须重新探测到额度').toBe(todayEnd())
    expect(after).not.toBe(UNUSABLE)
  })
})
