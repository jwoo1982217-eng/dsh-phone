import { describe, expect, it, vi } from 'vitest'
import {
  refreshAccountWithReconcile,
  shouldRefreshNow,
  shouldRefreshNowWithRefreshExpiry,
  syncAccountExpiry,
  type ExpiryAccessors,
} from '../../src/expiry-sync.js'
import { REFRESH_LEAD_MS } from '../../src/refresh.js'
import { refreshTokenExpiresAt } from '../../src/oauth.js'
import type { AccountPool, ProviderAccountStatus } from '../../src/account-pool.js'

/**
 * `src/expiry-sync.ts` 的回归用例（Gitee issue !IKIRTT）。
 *
 * 该模块承载两条修复，各自对应一条用户可见的症状：
 *
 * 1. **lead-time 判据**（`shouldRefreshNow`）：多账号续期调度器从「每 30 分钟
 *    无脑全量刷」恢复成单凭据时代的「距过期不足 1 小时才刷」。
 * 2. **有效期回写**（`syncAccountExpiry`）：按需续期（RPC `account.refresh`）
 *    过去七个 provider 都只更新凭据、不回写账号池，于是凭据续好了、UI 仍挂
 *    「已过期」，而「重测」按钮的 refresh 是刻意的 no-op —— 用户没有任何自救手段。
 *
 * 三条从 raccoon 既有实现继承的硬规矩都有单独用例锁死：失败不反噬、
 * 优先用调用方的 accountId、反查必须传**凭据内容**而非 ref 名。
 */

interface FakeCredential {
  access_token: string
  refresh_token?: string
  expires_at?: string
  /** 仅测试用：refresh_token 自身的到期时刻（毫秒时间戳字符串）。 */
  refresh_expires_at?: string
}

const ACCESSORS: ExpiryAccessors<FakeCredential> = {
  expiresAtOf: (c) => (c.expires_at ? Number(c.expires_at) : undefined),
  refreshableOf: (c) => Boolean(c.refresh_token),
  identityOf: (c) => c.access_token,
}

interface PoolSpy {
  pool: AccountPool
  patches: Array<{ id: string; patch: Record<string, unknown> }>
  lookups: string[]
}

/**
 * 账号池替身。
 *
 * @param lookupResult 不提供 `accountId` 时反查返回的 id
 * @param failWrite   为真时 `updateAccount` 抛错（验证「回写失败不反噬」）
 */
function makePool(
  lookupResult = '',
  failWrite = false,
): PoolSpy {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const lookups: string[] = []
  const pool = {
    listAccounts: async (): Promise<ProviderAccountStatus[]> => [],
    updateAccount: async (id: string, patch: Record<string, unknown>) => {
      if (failWrite) throw new Error('账号池写入失败')
      patches.push({ id, patch })
    },
    findAccountIdByCredential: async (_provider: string, identity: string) => {
      lookups.push(identity)
      return lookupResult
    },
  } as unknown as AccountPool
  return { pool, patches, lookups }
}

const CRED: FakeCredential = {
  access_token: 'TOKEN-BODY',
  refresh_token: 'RT',
  expires_at: String(Date.now() + 7_200_000),
}

function sync(overrides: Partial<Parameters<typeof syncAccountExpiry<FakeCredential>>[0]> = {}) {
  return syncAccountExpiry<FakeCredential>({
    provider: 'fake',
    credential: CRED,
    accessors: ACCESSORS,
    tag: '[fake]',
    ...overrides,
  } as Parameters<typeof syncAccountExpiry<FakeCredential>>[0])
}

describe('shouldRefreshNow：lead-time 判据', () => {
  const NOW = 1_800_000_000_000

  it('读不到过期时间 → 刷（保守：宁可多刷一次）', () => {
    expect(shouldRefreshNow(undefined, NOW)).toBe(true)
    expect(shouldRefreshNow(Number.NaN, NOW)).toBe(true)
  })

  it('已过期 → 刷', () => {
    expect(shouldRefreshNow(NOW - 1, NOW)).toBe(true)
    expect(shouldRefreshNow(NOW - 86_400_000, NOW)).toBe(true)
  })

  it('距过期 30 分钟 → 刷（已进入 lead 窗口）', () => {
    expect(shouldRefreshNow(NOW + 30 * 60_000, NOW)).toBe(true)
  })

  it('距过期恰好等于 lead → 刷（判据是 `<=`，边界必须包含）', () => {
    expect(shouldRefreshNow(NOW + REFRESH_LEAD_MS, NOW)).toBe(true)
  })

  it('距过期 2 小时 → 跳过（这正是「长寿命账号每 30 分钟被无谓刷一次」的老缺陷）', () => {
    expect(shouldRefreshNow(NOW + 2 * 3_600_000, NOW)).toBe(false)
    expect(shouldRefreshNow(NOW + 720 * 3_600_000, NOW)).toBe(false)
  })
})

describe('syncAccountExpiry：把凭据的有效期回写账号池', () => {
  it('不传 pool 时静默跳过（兼容既有单参调用方）', async () => {
    const { patches } = makePool('a1')
    await sync({ pool: undefined, accountId: 'a1' })
    expect(patches).toEqual([])
  })

  it('优先用调用方给的 accountId，**不做反查**', async () => {
    const { pool, patches, lookups } = makePool('should-not-be-used')
    await sync({ pool, accountId: 'a1' })
    expect(lookups).toEqual([])
    expect(patches).toEqual([{ id: 'a1', patch: { expiresAt: Number(CRED.expires_at), refreshable: true } }])
  })

  it('⚠️ 缺 accountId 时反查必须传**凭据内容**（access_token），不是 ref 名', async () => {
    // 传 ref 名会恒匹配失败且**静默无报错** —— 那是这条路径最阴的坑。
    const { pool, lookups, patches } = makePool('a1')
    await sync({ pool, accountId: undefined })
    expect(lookups).toEqual(['TOKEN-BODY'])
    expect(patches).toHaveLength(1)
  })

  it('反查也匹配不到时不写、也不抛', async () => {
    const { pool, patches } = makePool('')
    await sync({ pool })
    expect(patches).toEqual([])
  })

  it('池内现值一致时不重复写盘（否则定时器每 30 分钟全量重写账号列表）', async () => {
    const { pool, patches } = makePool()
    await sync({ pool, accountId: 'a1', current: { expiresAt: Number(CRED.expires_at), refreshable: true } })
    expect(patches).toEqual([])
  })

  it('1 秒内的差异视为一致（JWT 的 `exp` 是秒级，换算后会有舍入）', async () => {
    const { pool, patches } = makePool()
    const actual = Number(CRED.expires_at)
    await sync({ pool, accountId: 'a1', current: { expiresAt: actual - 999, refreshable: true } })
    expect(patches).toEqual([])
    await sync({ pool, accountId: 'a1', current: { expiresAt: actual - 1001, refreshable: true } })
    expect(patches).toHaveLength(1)
  })

  it('⚠️ 凭据里读不到过期时间时**不覆盖**池内旧值', async () => {
    // `{ ...entry, expiresAt: undefined }` 落盘时被 JSON.stringify 整个丢弃，
    // UI 于是从「已过期」变成「未知」—— 保留旧信息比抹掉它更有价值。
    const { pool, patches } = makePool()
    await sync({
      pool,
      accountId: 'a1',
      // 无 `expires_at`（读不到过期时间）、且已不可续期（值得写一次）
      credential: { access_token: 'X' },
      current: { expiresAt: 123, refreshable: true },
    })
    expect(patches).toEqual([{ id: 'a1', patch: { refreshable: false } }])
    expect('expiresAt' in patches[0]!.patch).toBe(false)
  })

  it('过期时间与可续期状态都无变化时完全不写盘', async () => {
    const { pool, patches } = makePool()
    await sync({
      pool,
      accountId: 'a1',
      credential: { access_token: 'X' },
      current: { expiresAt: 123, refreshable: false },
    })
    expect(patches).toEqual([])
  })

  it('⚠️ 不提供 refreshableOf 时只同步 expiresAt（Loomy 的硬契约）', async () => {
    // `isLoomyRefreshable` **恒为 false**（服务端无 refresh 端点，是诚实标记）。
    // 若共享实现据此回写，会把账号池改成与该产品设计不符的状态。
    const { pool, patches } = makePool()
    await sync({
      pool,
      accountId: 'a1',
      accessors: { expiresAtOf: ACCESSORS.expiresAtOf, identityOf: ACCESSORS.identityOf },
      current: { expiresAt: 1, refreshable: true },
    })
    expect(patches).toEqual([{ id: 'a1', patch: { expiresAt: Number(CRED.expires_at) } }])
    expect('refreshable' in patches[0]!.patch).toBe(false)
  })

  it('回写失败**只记日志、不上抛**：凭据已续成功，索引不该反噬它', async () => {
    const { pool } = makePool('', true)
    const warn = vi.fn()
    await expect(sync({ pool, accountId: 'a1', warn })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('[fake]')
  })
})

describe('refreshAccountWithReconcile：需要刷就刷，不需要就对账', () => {
  const build = (overrides: Partial<Parameters<typeof refreshAccountWithReconcile<FakeCredential>>[0]> = {}) => {
    const poolSpy = makePool()
    const calls = { refresh: 0, save: 0 }
    const params: Parameters<typeof refreshAccountWithReconcile<FakeCredential>>[0] = {
      pool: poolSpy.pool,
      provider: 'fake',
      tag: '[fake]',
      accountId: 'a1',
      credential: CRED,
      accessors: ACCESSORS,
      refresh: (c) => {
        calls.refresh += 1
        return Promise.resolve({ ...c, access_token: 'NEW', expires_at: String(Date.now() + 7_200_000) })
      },
      save: () => {
        calls.save += 1
        return Promise.resolve()
      },
      ...overrides,
    }
    return { poolSpy, calls, params }
  }

  it('⚠️ 仍在有效期内：**不发续期请求，但必须校正账号池**（存量账号的修法）', async () => {
    // 只修「续期时回写」不够 —— 存量账号的凭据早已在别处续好，若不在此处对账，
    // 账号池的旧值再也无人更正，UI 会永远显示「已过期」。
    const { poolSpy, calls, params } = build({
      current: { expiresAt: Date.now() - 3_600_000, refreshable: true },
    })
    const refreshed = await refreshAccountWithReconcile(params)
    expect(calls.refresh).toBe(0)
    expect(calls.save).toBe(0)
    expect(poolSpy.patches).toHaveLength(1)
    expect(refreshed).toBe(false)
    // 校正后的值指向未来 → UI 不再判「已过期」
    expect(Number(poolSpy.patches[0]!.patch.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('已进入 lead 窗口 → 续期、落盘、回写池，并返回 true', async () => {
    const { poolSpy, calls, params } = build({
      credential: { ...CRED, expires_at: String(Date.now() + 60_000) },
      current: { expiresAt: Date.now() + 60_000, refreshable: true },
    })
    const refreshed = await refreshAccountWithReconcile(params)
    expect(calls).toEqual({ refresh: 1, save: 1 })
    expect(refreshed).toBe(true)
    expect(poolSpy.patches).toHaveLength(1)
  })

  it('续期响应缺少令牌时**绝不落盘**（否则把一份好凭据覆盖成 "undefined"）', async () => {
    const { calls, params } = build({
      credential: { ...CRED, expires_at: String(Date.now() - 1) },
      refresh: () => Promise.resolve(undefined as unknown as FakeCredential),
    })
    await expect(refreshAccountWithReconcile(params)).rejects.toThrow(/缺少访问令牌/)
    expect(calls.save).toBe(0)
  })

  it('池值本就一致时不写盘（避免每轮定时器全量落盘）', async () => {
    const { poolSpy, params } = build({
      current: { expiresAt: Number(CRED.expires_at), refreshable: true },
    })
    await refreshAccountWithReconcile(params)
    expect(poolSpy.patches).toEqual([])
  })
})

/**
 * ⚠️⚠️ 第二条腿：refresh_token 自身的到期时刻（2026-10-18 真实事故）。
 *
 * ## 事故事实（全部来自解开用户真实凭据的 JWT，不是构造）
 *
 * 华为 STS 的 refresh_token JWT 里 `exp` **恒等于「登录时刻 + 30 天」，续期
 * 不延长它** —— 该账号 09-25 / 10-16×3 / 10-18 共五次续期签发的 refresh_token，
 * `exp` 全部收敛到同一时刻。access_token 寿命则恒为 2 小时。
 *
 * ⇒ 最后一天两侧严重不对称。实测 `codearts-3a02cb09`：
 *
 * | | 时刻 |
 * |---|---|
 * | 最后一次**成功**续期（access 换新到 2 小时后） | 19:05:48 |
 * | refresh_token 死线 D | 19:59:58 |
 * | access 到期 A | 21:05:48 |
 * | lead-time 最早放行时刻 A−60m | 20:05:48 |
 *
 * 放行时刻比死线**晚 5.8 分钟**，而调度周期是 30 分钟 ⇒ **必然错过**，
 * 账号在 21:05 access 到期后彻底不可用。`a0bf4fb8` 同理（余量 9.3 分钟）。
 *
 * ## 为什么必须补这条腿
 *
 * 原判据只读 access 的到期，在 refresh 寿命更短时**于死线之后才放行**。
 * 补上第二条腿后，「refresh 剩余不足一个 lead 周期」会提前放行。
 */
describe('shouldRefreshNowWithRefreshExpiry：refresh 寿命腿（CodeArts 30 天硬上限）', () => {
  const NOW = 1_800_000_000_000
  const H = 3_600_000

  it('access 还在 2 小时外、refresh 也还早 → 不续（与从前逐字节一致）', () => {
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: NOW + 2 * H,
      refreshExpiresAtMs: NOW + 20 * 24 * H,
      nowMs: NOW,
    })).toBe(false)
  })

  it('⚠️ **access 还早、但 refresh 只剩 50 分钟 → 必须提前续**（事故当天的形状）', () => {
    // 这就是实测那一刻：access 剩 2 小时（未进 lead 窗口），refresh 只剩 50 分钟。
    // 旧判据在这里返回 false ⇒ 一直等到 20:05 才放行，而那时牌已经死了。
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: NOW + 2 * H,
      refreshExpiresAtMs: NOW + 50 * 60_000,
      nowMs: NOW,
    })).toBe(true)
  })

  it('⚠️ 两条腿必须取「或」：refresh 还早但 access 进窗口时照样续', () => {
    // 取「与」会制造新缺陷：refresh 剩 3 天、access 剩 2 分钟（正常态）反而不续，
    // access 一过期账号就报废，而此刻 refresh 明明还活着。
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: NOW + 60_000,
      refreshExpiresAtMs: NOW + 3 * 24 * H,
      nowMs: NOW,
    })).toBe(true)
  })

  it('refresh 已过期 → 放行，让真实请求去否决（云端可能已重签过）', () => {
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: NOW + 2 * H,
      refreshExpiresAtMs: NOW - 1,
      nowMs: NOW,
    })).toBe(true)
  })

  it('⚠️ 读不到 refresh 到期时**退化成单腿判据**，不得 fail-closed 成「每次都刷」', () => {
    // CodeArts 读不到只可能是旧 ticket 凭据（没有 refresh_token），那种情况由
    // isCodeArtsRefreshable 拦下。若这里 fail-closed 成 true，所有读不到腿的凭据
    // 会被每 30 分钟无谓刷一次。
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: NOW + 2 * H,
      refreshExpiresAtMs: undefined,
      nowMs: NOW,
    })).toBe(false)
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: NOW + 2 * H,
      refreshExpiresAtMs: Number.NaN,
      nowMs: NOW,
    })).toBe(false)
  })

  it('不提供 refresh 腿时，与旧判据在所有取值上逐格一致（其余八家的行为不变）', () => {
    for (const offset of [2 * H, H - 1, 1, -1, -86_400_000, Number.NaN, undefined]) {
      expect(shouldRefreshNowWithRefreshExpiry({
        expiresAtMs: NOW + offset,
        nowMs: NOW,
      })).toBe(shouldRefreshNow(NOW + offset, NOW))
    }
  })
})

describe('refreshTokenExpiresAt：解 JWT 取 exp（只估时，不作信任判定）', () => {
  const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj))
    .toString('base64url')

  const jwt = (payload: Record<string, unknown>): string =>
    `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`

  it('解出秒级 exp 并换算成毫秒', () => {
    const exp = 1_800_000_000
    expect(refreshTokenExpiresAt({ refresh_token: jwt({ exp }) })).toBe(exp * 1000)
  })

  it('⚠️ 读不到时返回 undefined，**不得抛错也不得返回 0**', () => {
    // 0 会被误当成「1970 年就过期了」⇒ fail-closed 成终态 ⇒ 误伤全部旧凭据。
    for (const token of ['', 'not-a-jwt', 'a.b', 'a.!!!.c', 'a.${$$.c']) {
      expect(refreshTokenExpiresAt({ refresh_token: token })).toBeUndefined()
    }
    expect(refreshTokenExpiresAt({})).toBeUndefined()
  })

  it('载荷里没有 exp / 类型不对 / 量级离谱 → 一律 undefined', () => {
    expect(refreshTokenExpiresAt({ refresh_token: jwt({ iat: 1 }) })).toBeUndefined()
    expect(refreshTokenExpiresAt({ refresh_token: jwt({ exp: 'soon' }) })).toBeUndefined()
    // 秒级 × 1000 后 > 1e14 意味着「这根本不是秒级时间戳」（毫秒当秒传了）。
    expect(refreshTokenExpiresAt({ refresh_token: jwt({ exp: 1.8e15 }) })).toBeUndefined()
  })

  it('能解 base64url 的 `-` / `_` 与无 padding 的尾段', () => {
    // 载荷字节里必然出现 0xFB/0xFF 之类 → base64url 用 `-`/`_` 且尾段常无 padding。
    const raw = JSON.stringify({ exp: 1_700_000_000, pad: 'ÿþýü' })
    const token = `${b64url({})}.${Buffer.from(raw).toString('base64url')}.s`
    expect(refreshTokenExpiresAt({ refresh_token: token })).toBe(1_700_000_000 * 1000)
  })
})

describe('refreshAccountWithReconcile：refresh 腿真的改变了「要不要发请求」', () => {
  const build = (overrides: Partial<Parameters<typeof refreshAccountWithReconcile<FakeCredential>>[0]> = {}) => {
    const poolSpy = makePool()
    const calls = { refresh: 0, save: 0 }
    const params: Parameters<typeof refreshAccountWithReconcile<FakeCredential>>[0] = {
      pool: poolSpy.pool,
      provider: 'fake',
      tag: '[fake]',
      accountId: 'a1',
      credential: CRED,
      accessors: ACCESSORS,
      refresh: (c) => {
        calls.refresh += 1
        return Promise.resolve({ ...c, access_token: 'NEW', expires_at: String(Date.now() + 7_200_000) })
      },
      save: () => {
        calls.save += 1
        return Promise.resolve()
      },
      ...overrides,
    }
    return { poolSpy, calls, params }
  }

  const ACCESSORS_WITH_REFRESH: ExpiryAccessors<FakeCredential> = {
    ...ACCESSORS,
    refreshExpiresAtOf: (c) => Number(c.refresh_expires_at),
  }

  it('⚠️ access 未进窗口但 refresh 快到死线 → 真的会发请求（不是只对账）', async () => {
    const { calls, params } = build({
      accessors: ACCESSORS_WITH_REFRESH,
      credential: {
        ...CRED,
        expires_at: String(Date.now() + 7_200_000),
        refresh_expires_at: String(Date.now() + 50 * 60_000),
      } as FakeCredential,
      current: { expiresAt: Date.now() + 7_200_000, refreshable: true },
    })
    expect(await refreshAccountWithReconcile(params)).toBe(true)
    expect(calls).toEqual({ refresh: 1, save: 1 })
  })

  it('⚠️ 两条腿都还早 → 不发请求（防止无谓打爆上游）', async () => {
    const { calls, params } = build({
      accessors: ACCESSORS_WITH_REFRESH,
      credential: {
        ...CRED,
        expires_at: String(Date.now() + 7_200_000),
        refresh_expires_at: String(Date.now() + 20 * 86_400_000),
      } as FakeCredential,
      current: { expiresAt: Date.now() + 7_200_000, refreshable: true },
    })
    expect(await refreshAccountWithReconcile(params)).toBe(false)
    expect(calls.refresh).toBe(0)
  })
})
