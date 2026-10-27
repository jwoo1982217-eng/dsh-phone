/**
 * `officeace-expiry.spec.ts` —— officeace 进**聚合轮换**的折算守卫。
 *
 * ## 背景（2026-10-13 用户要求）
 *
 * > 「officeace 的模型好像没有加入聚合 provider 的轮换中，我们需要加入」
 *
 * ⚠️⚠️ **这是与 accio 同款的陷阱，且症状完全静默**：
 * 决定「轮换候选表里有没有它」的是 `WIRED_EXPIRY_PROVIDERS`
 *（`aggregate-expiry.ts`），**不是** `AGGREGATE_CHANNELS`。只加后者
 * ⇒ 模型层归并了、候选层却被那道闸门剔掉，**没有任何报错**。
 *
 * 接入需要**三处同改**（少一处都是静默失效）：
 * 1. `aggregate-expiry.ts` 的 `officeaceExpiry` 折算原语；
 * 2. `WIRED_EXPIRY_PROVIDERS` 白名单；
 * 3. `provider-expiry.ts` 的 `createProviderExpiry()` 表。
 * （2 与 3 的一致性由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。）
 *
 * ## 折算判据（**必须与 `sharedPackageExpiry` 逐格同构**，本仓库红线）
 *
 * officeace 与 **buddy 系同形**：订阅的每个积分桶都带 `expiresAt`。
 *
 * | 情形 | 折算值 |
 * |---|---|
 * | 有 `remaining > 0` 且未失效的桶，至少一个给了到期时间 | 那些时刻的**最小值** |
 * | 有可用桶但都没给到期时间 | `NEVER`（长期，排最后但不剔除）|
 * | 一个可用桶都没有 | `UNUSABLE`（剔除）|
 * | 查询失败 / 未登录 | `UNUSABLE`（读不到就不猜）|
 *
 * ⚠️ **不发真实网络**：mock `fetchSubscriptionSummary` 所在的模块。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { WIRED_EXPIRY_PROVIDERS } from '../../src/aggregate-expiry.js'
import {
  noteOfficeaceRejection,
  resetOfficeaceBreakerForTest,
} from '../../src/officeace-credential-health.js'

// ⚠️ mock 掉余额入口（它内部会打云侧 V11 签名请求 + 可能触发自动签到）。
vi.mock('../../src/officeace-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/officeace-auth.js')>()
  return { ...actual, fetchSubscriptionSummary: vi.fn() }
})

const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
const { officeaceExpiry } = await import('../../src/aggregate-expiry.js')
const { createProviderExpiry } = await import('../../src/provider-expiry.js')

/** 造一份订阅摘要；`groups` 是积分桶。 */
function summary(groups: Array<{ remaining: number; expiresAt?: string; expired?: boolean }>) {
  return {
    totalCredits: groups.reduce((sum, g) => sum + g.remaining, 0),
    usedCredits: 0,
    creditGroups: groups.map((g, i) => ({
      key: `g${i}`, name: `桶${i}`, remaining: g.remaining, total: g.remaining,
      ...g.expiresAt === undefined ? {} : { expiresAt: g.expiresAt },
      ...g.expired === undefined ? {} : { expired: g.expired },
    })),
  }
}

const CREDENTIAL = {
  modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: 'https://x.example',
  access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: 'r', dpopPrivateJwk: {},
} as never

const mocked = vi.mocked(fetchSubscriptionSummary)

beforeEach(() => {
  mocked.mockReset()
})

describe('officeaceExpiry（折算判据）', () => {
  it('① 多个有效桶 ⇒ 取**最早**的到期时刻', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const later = new Date(Date.now() + 9 * 86_400_000).toISOString()
    mocked.mockResolvedValue(summary([
      { remaining: 100, expiresAt: later },
      { remaining: 50, expiresAt: soon },
    ]) as never)
    expect(await officeaceExpiry(CREDENTIAL, 'OFFICEACE_ACCOUNT_A')).toBe(Date.parse(soon))
  })

  it('② 有可用桶但都没给到期时间 ⇒ NEVER（长期，不剔除）', async () => {
    // ⚠️ 这正是「服务端没给到期时间」的诚实处理：不臆造一个时刻。
    mocked.mockResolvedValue(summary([{ remaining: 500 }, { remaining: 300 }]) as never)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(NEVER)
  })

  it('③ 一个可用桶都没有（余额为 0）⇒ UNUSABLE（剔除）', async () => {
    mocked.mockResolvedValue(summary([{ remaining: 0 }, { remaining: 0 }]) as never)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(UNUSABLE)
  })

  it('④ 只剩**已失效**的桶 ⇒ UNUSABLE（与「余额为 0」同判）', async () => {
    mocked.mockResolvedValue(summary([
      { remaining: 800, expired: true },
      { remaining: 0 },
    ]) as never)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(UNUSABLE)
  })

  it('⑤ 已失效桶的到期时刻**不参与**取最小（否则会把渠道误判成临期）', async () => {
    const expiredSoon = new Date(Date.now() - 86_400_000).toISOString()
    const real = new Date(Date.now() + 5 * 86_400_000).toISOString()
    mocked.mockResolvedValue(summary([
      { remaining: 900, expiresAt: expiredSoon, expired: true },
      { remaining: 100, expiresAt: real },
    ]) as never)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(Date.parse(real))
  })

  it('⑥ 查询返回 undefined（未登录 / 云侧读不到）⇒ UNUSABLE（读不到就不猜）', async () => {
    mocked.mockResolvedValue(undefined as never)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(UNUSABLE)
  })

  it('⑦ 查询抛错（网络 / 签名失败）⇒ UNUSABLE（不吞成 NEVER）', async () => {
    // ⚠️ 方向很重要：吞成 `NEVER` 会把「未知」说成「长期可用」，
    //    于是把请求发到一个额度未知（可能已用尽）的渠道。
    mocked.mockRejectedValue(new Error('HTTP 401'))
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(UNUSABLE)
  })

  it('⑧ 到期时间非 ISO 字符串时不参与取最小（不把 NaN 当到期）', async () => {
    const good = new Date(Date.now() + 3 * 86_400_000).toISOString()
    mocked.mockResolvedValue(summary([
      { remaining: 100, expiresAt: '不是时间' },
      { remaining: 50, expiresAt: good },
    ]) as never)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(Date.parse(good))
  })

  it('⑨ **必须把 ref 传给余额入口**（否则回落全局单 cookie ⇒ 多账号串号）', async () => {
    mocked.mockResolvedValue(summary([{ remaining: 100 }]) as never)
    await officeaceExpiry(CREDENTIAL, 'OFFICEACE_ACCOUNT_XYZ')
    // ⚠️ 判据是「第二参真的是那个 ref」。漏传时聚合会把所有账号折算成
    //    同一个余额（实测两个账号都显示 6500），而候选排序是每账号粒度 ⇒ 选错人。
    expect(mocked.mock.calls[0]?.[1]).toBe('OFFICEACE_ACCOUNT_XYZ')
  })
})

describe('接线：三处必须同改（少一处都是静默失效）', () => {
  it('⑩ WIRED_EXPIRY_PROVIDERS 含 officeace（决定候选表可见性的是它）', () => {
    expect(
      WIRED_EXPIRY_PROVIDERS.includes('officeace'),
      'officeace 不在白名单 ⇒ 聚合候选表里永远没有它，且**完全没有报错**',
    ).toBe(true)
  })

  it('⑪ createProviderExpiry() 表里有 officeace（runtime 注册的真相源）', () => {
    const table = createProviderExpiry()
    expect(typeof table.officeace?.credentialExpiry, 'officeace 未进折算表').toBe('function')
  })

  it('⑫ runtime 表里的 officeace 会把 context.credentialRef 传下去', async () => {
    mocked.mockResolvedValue(summary([{ remaining: 100 }]) as never)
    await createProviderExpiry().officeace!.credentialExpiry(CREDENTIAL, {
      credentialRef: 'OFFICEACE_ACCOUNT_FROM_CONTEXT',
    })
    expect(mocked.mock.calls[0]?.[1]).toBe('OFFICEACE_ACCOUNT_FROM_CONTEXT')
  })
})

/**
 * ## 凭据熔断 ⇒ 候选表里**没有**它（Gitee issue IKLTHB 第 ③ 条）
 *
 * ⚠️ 这是熔断真正起作用的地方：适配器里的快速失败只救「用户显式选了 officeace」
 * 那一格，而**自动路由每一轮都先撞一次墙**这件事，只能在这里解决 —— 折算判
 * `UNUSABLE` ⇒ 候选表剔除 ⇒ 连试都不试。
 *
 * ⚠️ 判据刻意包含「**没有再打余额请求**」：熔断期还去读余额除了白花时间，
 *    还会让 `EXPIRY_CACHE_TTL_MS` 的 60 秒缓存反复写入新值（掩盖熔断）。
 */
describe('熔断：熔断期内 officeaceExpiry 判 UNUSABLE 且不再请求余额', () => {
  beforeEach(() => {
    resetOfficeaceBreakerForTest()
  })

  /** 真机 401 报文（issue 取证原文）。 */
  const REAL_401 = '{"error_msg":"AppKey or AppSecret is invalid","error_code":"APIG.1009"}'

  it('★ ⑬ 两次确定的凭据拒绝 ⇒ UNUSABLE，且余额入口调用次数不再增长', async () => {
    mocked.mockResolvedValue(summary([{ remaining: 6500 }]) as never)
    // 未熔断：正常折算（有额度但无到期时间 ⇒ NEVER，与用例 ② 同判）。
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(NEVER)
    expect(mocked).toHaveBeenCalledTimes(1)
    // 两次连续拒绝 ⇒ 熔断。
    noteOfficeaceRejection(CREDENTIAL, REAL_401)
    noteOfficeaceRejection(CREDENTIAL, REAL_401)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(UNUSABLE)
    expect(mocked, '熔断期不得再去读余额').toHaveBeenCalledTimes(1)
  })

  it('★ ⑭ 熔断只影响那对 Basic 凭据（换了 key 立刻恢复折算）', async () => {
    mocked.mockResolvedValue(summary([{ remaining: 100 }]) as never)
    noteOfficeaceRejection(CREDENTIAL, REAL_401)
    noteOfficeaceRejection(CREDENTIAL, REAL_401)
    expect(await officeaceExpiry(CREDENTIAL, 'REF')).toBe(UNUSABLE)
    const rotated = { ...CREDENTIAL, modelAppKey: 'k2' } as never
    expect(await officeaceExpiry(rotated, 'REF')).toBe(NEVER)
  })
})
