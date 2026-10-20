import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RaccoonAuth } from '../../src/raccoon-auth.js'
import type { AccountPool, ProviderAccountStatus } from '../../src/account-pool.js'

/**
 * ⚠️ **真实缺陷回归**（用户报障）：
 *
 * 「凭据过期后显示过期，但是似乎是续期成功了还是没有真正的过期，
 *   我发送会话成功从 6300 扣分了。」
 *
 * UI 显示「已过期 · 自动续期」，但实际能发消息、积分真的被扣。
 *
 * ## 实测证据（本机账号 `RACCOON_ACCOUNT_ABD05EAC`）
 *
 * | 数据源 | 过期时间 | 状态 |
 * |---|---|---|
 * | 凭据里的真实 JWT `exp` | 15:09:00Z | ✅ 有效（还剩 6744 秒） |
 * | 账号池的 `expiresAt` | 12:02:54Z | ❌ 已过期 73 分钟 |
 *
 * **相差 11166 秒（≈3.1 小时）** —— 即续期**确实成功了**（新 token 的 exp 是 15:09），
 * 但续期后**没有把新的过期时间写回账号池**，账号池留着续期前的旧值。
 * 而 Jet Hub 的账号卡片读的正是账号池的 `expiresAt`。
 *
 * ## 根因
 *
 * `RaccoonAuth.refreshAll` 只调 `refreshAccountCredential`（内部仅
 * `ctx.credentials.set`），**从不 `pool.updateAccount({ expiresAt })`**。
 * 其余四个 provider（Cline / Qoder / Trae / LobsterAI）都写了，raccoon 是唯一遗漏。
 *
 * 这类缺陷的形态是「**数据源分叉**」：凭据被更新、索引没被更新，
 * 于是同一事实在两处不一致，且**只在 UI 上可见**（功能完全正常），
 * 极难从「发消息失败」这类症状入手排查。
 */

const services: RaccoonAuth[] = []

class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeCtx(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

function newService(ctx: Context, fetcher: typeof fetch): RaccoonAuth {
  const service = new RaccoonAuth(ctx, { fetcher })
  services.push(service)
  return service
}

afterEach(() => {
  for (const s of services.splice(0)) {
    const d = s as unknown as { [Symbol.dispose]?: () => void }
    d[Symbol.dispose]?.()
  }
})

/** 账号池替身：记录每次 updateAccount 的补丁。 */
function makePool(accounts: ProviderAccountStatus[]): {
  pool: AccountPool
  patches: Array<{ id: string; patch: Record<string, unknown> }>
} {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const pool = {
    listAccounts: async () => accounts,
    updateAccount: async (id: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch })
      const target = accounts.find((a) => a.id === id)
      if (target !== undefined) Object.assign(target, patch)
    },
  } as unknown as AccountPool
  return { pool, patches }
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const NOW_SEC = Math.floor(Date.now() / 1000)

/** 一个**已过期**的凭据（旧 token）。 */
const EXPIRED_CREDENTIAL = JSON.stringify({
  access_token: `${b64({ alg: 'HS256' })}.${b64({ exp: NOW_SEC - 3600, name: 'RaccoonAva' })}.sig`,
  refresh_token: 'old-refresh',
  user_id: '7445120',
  nickname: 'RaccoonAva',
  phone: '13011111100',
})

/** 续期端点返回的**新**凭据（exp 在未来 3 小时）。 */
const NEW_EXP_SEC = NOW_SEC + 3 * 3600
function refreshFetcher(): typeof fetch {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/auth/v1/refresh')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          access_token: `${b64({ alg: 'HS256' })}.${b64({ exp: NEW_EXP_SEC, name: 'RaccoonAva' })}.sig`,
          refresh_token: 'new-refresh',
        },
      }), { status: 200 })
    }
    // 其它端点（如 user_info）返回空信封
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
  }) as unknown as typeof fetch
}

function accountOf(patch: Partial<ProviderAccountStatus> = {}): ProviderAccountStatus {
  return {
    id: 'raccoon-b4c18de9',
    provider: 'raccoon',
    credentialRef: 'RACCOON_ACCOUNT_ABD05EAC',
    enabled: true,
    refreshable: true,
    nickname: 'RaccoonAva (1100)',
    createdAt: Date.now(),
    // 账号池里是**续期前的旧值**（这正是 UI 显示「已过期」的来源）
    expiresAt: (NOW_SEC - 3600) * 1000,
    ...patch,
  } as unknown as ProviderAccountStatus
}

describe('raccoon 续期后必须把新过期时间写回账号池', () => {
  it('⚠️ refreshAll 成功后更新账号池的 expiresAt（修 UI 假过期）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', EXPIRED_CREDENTIAL)
    const { pool, patches } = makePool([accountOf()])
    const auth = newService(ctx, refreshFetcher())

    await auth.refreshAll(pool)

    // 凭据被换成新 token
    const saved = JSON.parse(credentials.store.get('RACCOON_ACCOUNT_ABD05EAC') ?? '{}') as {
      access_token?: string
      refresh_token?: string
    }
    expect(saved.refresh_token).toBe('new-refresh')

    // ⚠️ 核心判据：账号池的 expiresAt 必须被更新为**新** token 的 exp
    const expiresPatch = patches.find((p) => 'expiresAt' in p.patch)
    expect(
      expiresPatch,
      '续期成功后必须 pool.updateAccount({ expiresAt })，否则 UI 会一直显示「已过期」',
    ).toBeDefined()
    expect(expiresPatch?.patch.expiresAt).toBe(NEW_EXP_SEC * 1000)
    // 且不再等于旧值
    expect(expiresPatch?.patch.expiresAt).not.toBe((NOW_SEC - 3600) * 1000)
  })

  it('更新后的 expiresAt 让 UI 判定为「未过期」', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', EXPIRED_CREDENTIAL)
    const { pool } = makePool([accountOf()])
    const auth = newService(ctx, refreshFetcher())

    await auth.refreshAll(pool)

    const entry = (await pool.listAccounts('raccoon'))[0]
    expect(
      typeof entry?.expiresAt === 'number' && entry.expiresAt > Date.now(),
      `续期后账号池的 expiresAt 应指向未来，实际 ${String(entry?.expiresAt)}`,
    ).toBe(true)
  })

  it('refreshAccountCredential（RPC account.refresh）也更新账号池', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', EXPIRED_CREDENTIAL)
    const { pool, patches } = makePool([accountOf()])
    const auth = newService(ctx, refreshFetcher())

    // 带 pool + accountId 调用（RPC 的 account.refresh 分支会传）
    await auth.refreshAccountCredential('RACCOON_ACCOUNT_ABD05EAC', pool, 'raccoon-b4c18de9')

    const expiresPatch = patches.find((p) => 'expiresAt' in p.patch)
    expect(expiresPatch?.patch.expiresAt).toBe(NEW_EXP_SEC * 1000)
  })

  it('不传 accountId 时按**凭据内容**反查（不是 ref 名）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', EXPIRED_CREDENTIAL)
    const { pool, patches } = makePool([accountOf()])
    // ⚠️ 替身实现 `findAccountIdByCredential`，并断言它收到的是 **access_token**
    // 而不是 ref 名 —— 传 ref 名会恒匹配失败且**静默无报错**（真实陷阱）。
    const seen: string[] = []
    ;(pool as unknown as Record<string, unknown>).findAccountIdByCredential =
      async (_provider: string, identity: string) => {
        seen.push(identity)
        return 'raccoon-b4c18de9'
      }
    const auth = newService(ctx, refreshFetcher())

    await auth.refreshAccountCredential('RACCOON_ACCOUNT_ABD05EAC', pool)

    expect(patches.find((p) => 'expiresAt' in p.patch)?.patch.expiresAt).toBe(NEW_EXP_SEC * 1000)
    // 传进去的必须是 JWT（access_token），不是 'RACCOON_ACCOUNT_ABD05EAC'
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe('RACCOON_ACCOUNT_ABD05EAC')
    expect(seen[0]?.startsWith('eyJ')).toBe(true)
  })

  it('回写账号池失败**不反噬已成功的续期**（只记日志）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', EXPIRED_CREDENTIAL)
    const { pool } = makePool([accountOf()])
    ;(pool as unknown as Record<string, unknown>).updateAccount = async () => {
      throw new Error('账号池写入失败')
    }
    const auth = newService(ctx, refreshFetcher())

    // 不应抛错：凭据已续期成功，索引写失败只是展示层问题
    await expect(
      auth.refreshAccountCredential('RACCOON_ACCOUNT_ABD05EAC', pool, 'raccoon-b4c18de9'),
    ).resolves.toBeUndefined()
    // 凭据确实被更新了
    const saved = JSON.parse(credentials.store.get('RACCOON_ACCOUNT_ABD05EAC') ?? '{}') as {
      refresh_token?: string
    }
    expect(saved.refresh_token).toBe('new-refresh')
  })

  it('不传 pool 时仍能续期（向后兼容既有调用方）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', EXPIRED_CREDENTIAL)
    const auth = newService(ctx, refreshFetcher())

    // 不传 pool：只更新凭据，不抛错
    await expect(
      auth.refreshAccountCredential('RACCOON_ACCOUNT_ABD05EAC'),
    ).resolves.toBeUndefined()
    const saved = JSON.parse(credentials.store.get('RACCOON_ACCOUNT_ABD05EAC') ?? '{}') as {
      refresh_token?: string
    }
    expect(saved.refresh_token).toBe('new-refresh')
  })

  it('未过期的账号不被续期（不产生多余的 expiresAt 写入）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: `${b64({ alg: 'HS256' })}.${b64({ exp: NOW_SEC + 7200 })}.sig`,
      refresh_token: 'still-good',
      phone: '13011111100',
    }))
    const { pool, patches } = makePool([accountOf({ expiresAt: (NOW_SEC + 7200) * 1000 })])
    const auth = newService(ctx, refreshFetcher())

    await auth.refreshAll(pool)
    expect(patches.filter((p) => 'expiresAt' in p.patch)).toEqual([])
  })

  /**
   * ⚠️ **存量账号的修复**（本缺陷的完整形态）：
   *
   * 只修「续期时回写」还不够 —— 存量账号的凭据**早已续期成功**
   *（JWT exp 在未来），故 `isRaccoonExpired` 为 false，续期分支被跳过，
   * 账号池的旧值**再也无人更正**，UI 会一直显示「已过期」。
   *
   * 故 `refreshAll` 必须在「凭据未过期」分支里也校正账号池的不一致值。
   */
  it('⚠️ 凭据未过期但账号池值不一致时，校正账号池（修存量账号）', async () => {
    const { ctx, credentials } = makeCtx()
    // 凭据有效（exp 在未来 3 小时）—— 这正是用户当前的真实状态
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: `${b64({ alg: 'HS256' })}.${b64({ exp: NEW_EXP_SEC })}.sig`,
      refresh_token: 'valid-refresh',
      phone: '13011111100',
    }))
    // 账号池却停留在**续期前的旧值**（已过期）—— UI 据此显示「已过期」
    const { pool, patches } = makePool([accountOf({ expiresAt: (NOW_SEC - 3600) * 1000 })])
    const auth = newService(ctx, refreshFetcher())

    await auth.refreshAll(pool)

    const expiresPatch = patches.find((p) => 'expiresAt' in p.patch)
    expect(
      expiresPatch,
      '凭据未过期时也必须校正账号池，否则存量账号的 UI 永远显示「已过期」',
    ).toBeDefined()
    expect(expiresPatch?.patch.expiresAt).toBe(NEW_EXP_SEC * 1000)
    // 校正路径**不应**发续期请求（凭据本来就有效）
    const entry = (await pool.listAccounts('raccoon'))[0]
    expect(typeof entry?.expiresAt === 'number' && entry.expiresAt > Date.now()).toBe(true)
  })

  it('校正路径不发续期请求（凭据有效时不浪费一次轮换）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: `${b64({ alg: 'HS256' })}.${b64({ exp: NEW_EXP_SEC })}.sig`,
      refresh_token: 'valid-refresh',
    }))
    const { pool } = makePool([accountOf({ expiresAt: (NOW_SEC - 3600) * 1000 })])
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)

    await auth.refreshAll(pool)
    expect(calls.some((u) => u.includes('/refresh'))).toBe(false)
  })

  it('账号池值已与凭据一致时不重复写（避免每次定时器都落盘）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: `${b64({ alg: 'HS256' })}.${b64({ exp: NEW_EXP_SEC })}.sig`,
      refresh_token: 'valid-refresh',
    }))
    const { pool, patches } = makePool([accountOf({ expiresAt: NEW_EXP_SEC * 1000 })])
    const auth = newService(ctx, refreshFetcher())

    await auth.refreshAll(pool)
    expect(patches.filter((p) => 'expiresAt' in p.patch)).toEqual([])
  })
})
