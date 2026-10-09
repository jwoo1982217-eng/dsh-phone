/**
 * `GeminiAuth.repairAccountNicknames` —— 老账号展示名回填。
 *
 * ## 真实缺陷（用户报障 2026-10-03）
 *
 * 账号卡片显示成 `gemini-6a53dbca`（一串池 id），用户认不出是哪个 Google 账号。
 * 成因是**登录时**身份只剩「userinfo 那次跨域请求」一个来源：它一失败（当时还
 * 静默吞异常），凭据里就只有 token 而无 `sub`/`email`，`geminiAccountLabel`
 * 返 `undefined`，昵称回落到 `?? id`。
 *
 * 登录链路已改为优先从令牌响应的 `id_token` 解身份；**但那只影响新登录**，
 * 已经躺在磁盘上的坏昵称要靠这里在启动时补一次。
 *
 * ## 守的四条契约
 *
 * 1. **零请求优先**：凭据里已有 `email`/`sub` 时直接改名，不发任何网络请求。
 * 2. **幂等**：昵称已是目标值时不写账号池（`updateAccount` 是整体 replace，
 *    每次启动都写会平白落盘一次）。
 * 3. **拿不到就什么都不做**：绝不退回去用池 id 或空值重算昵称（会覆盖用户手改的）。
 * 4. **失败不阻塞**：单账号异常只记 warn，其余账号照修；池都列不出来时返空数组。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GeminiAuth } from '../../src/gemini-auth.js'
import { GEMINI } from '../../src/gemini.js'
import type { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountStatus } from '../../src/types.js'

/** 最小化的内存凭据提供者（与其余 provider 的 spec 同款）。 */
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

const services: GeminiAuth[] = []

afterEach(() => {
  services.length = 0
  vi.clearAllMocks()
})

function newService(ctx: Context, fetcher?: typeof fetch): GeminiAuth {
  const service = new GeminiAuth(ctx, fetcher === undefined ? {} : { fetchImpl: fetcher })
  services.push(service)
  return service
}

/** 账号池替身：记录 `updateAccount` 调用并同步条目，便于断言幂等。 */
function makePool(accounts: ProviderAccountStatus[]): {
  pool: AccountPool
  updates: Array<{ id: string; nickname: unknown }>
} {
  const updates: Array<{ id: string; nickname: unknown }> = []
  const pool = {
    listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
    updateAccount: async (id: string, patch: { nickname?: string }) => {
      updates.push({ id, nickname: patch.nickname })
      const target = accounts.find((a) => a.id === id)
      if (target !== undefined && patch.nickname !== undefined) target.nickname = patch.nickname
    },
  } as unknown as AccountPool
  return { pool, updates }
}

function accountOf(patch: Partial<ProviderAccountStatus> = {}): ProviderAccountStatus {
  return {
    id: 'gemini-6a53dbca',
    provider: GEMINI.id,
    credentialRef: 'GEMINI_ACCOUNT_0CDFBE09',
    enabled: true,
    refreshable: true,
    // ⚠️ 报障时的真实形态：昵称就是池 id。
    nickname: 'gemini-6a53dbca',
    createdAt: Date.now(),
    // ⚠️ `...patch` 必须放最后（raccoon spec 记录过这个替身陷阱：漏了它
    // `accountOf({ nickname })` 会**静默忽略覆盖值**，表现为「实现不幂等」）。
    ...patch,
  } as unknown as ProviderAccountStatus
}

/** 报障时磁盘上的凭据形态：只有 token，没有 sub/email。 */
function credentialBody(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'Bearer',
    expires_in: 3599,
    expiry: new Date(Date.now() + 3_600_000).toISOString(),
    scope: 'openid https://www.googleapis.com/auth/cloud-platform',
    ...patch,
  })
}

/** userinfo 桩（返回可辨认身份），并统计请求次数。 */
function userInfoFetcher(
  payload: Record<string, unknown> = { id: '105005203060879919709', email: 'yinghaolin12@gmail.com' },
): { fetcher: typeof fetch; calls: () => number } {
  const spy = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
  return { fetcher: spy as unknown as typeof fetch, calls: () => spy.mock.calls.length }
}

describe('repairAccountNicknames', () => {
  it('凭据已有 email 时**零请求**把池 id 昵称改回邮箱（本次报障的形态）', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set('GEMINI_ACCOUNT_0CDFBE09', credentialBody({ email: 'yinghaolin12@gmail.com' }))
    const { fetcher, calls } = userInfoFetcher()
    const service = newService(ctx, fetcher)
    const { pool, updates } = makePool([accountOf()])

    const repaired = await service.repairAccountNicknames(pool)

    expect(repaired).toEqual(['gemini-6a53dbca'])
    expect(updates).toEqual([{ id: 'gemini-6a53dbca', nickname: 'yinghaolin12@gmail.com' }])
    // ⚠️ 身份已在凭据里 ⇒ 一次网络都不该发。
    expect(calls(), '凭据已有身份时不应请求 userinfo').toBe(0)
  })

  it('凭据缺身份时发一次 userinfo，并把身份写回**凭据**再改名', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set('GEMINI_ACCOUNT_0CDFBE09', credentialBody())
    const { fetcher, calls } = userInfoFetcher()
    const service = newService(ctx, fetcher)
    const { pool, updates } = makePool([accountOf()])

    const repaired = await service.repairAccountNicknames(pool)

    expect(repaired).toEqual(['gemini-6a53dbca'])
    expect(calls()).toBe(1)
    expect(updates).toEqual([{ id: 'gemini-6a53dbca', nickname: 'yinghaolin12@gmail.com' }])
    // 身份必须**落进凭据**：账号条目会随账号操作整体重写，凭据里存一份才稳
    // （与 trae 把脱敏手机号写回凭据同款）。凭据是整体替换，回写不得丢字段。
    const stored = JSON.parse(credentials.store.get('GEMINI_ACCOUNT_0CDFBE09')!) as Record<string, unknown>
    expect(stored.email).toBe('yinghaolin12@gmail.com')
    expect(stored.sub).toBe('105005203060879919709')
    expect(stored.refresh_token).toBe('RT')
    expect(stored.expiry).toBeDefined()
  })

  it('昵称已是邮箱时幂等：不发请求、不写账号池', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set('GEMINI_ACCOUNT_0CDFBE09', credentialBody({ email: 'yinghaolin12@gmail.com' }))
    const { fetcher, calls } = userInfoFetcher()
    const service = newService(ctx, fetcher)
    const { pool, updates } = makePool([accountOf({ nickname: 'yinghaolin12@gmail.com' })])

    const repaired = await service.repairAccountNicknames(pool)

    expect(repaired).toEqual([])
    expect(updates).toEqual([])
    expect(calls()).toBe(0)
  })

  it('拿不到身份（返空 / 抛错）时保留原昵称 —— 绝不退回去用池 id 重算', async () => {
    // ⚠️ 每个 Service 必须挂在**独立的 ctx** 上（cordis 的 `provide` 同 ctx 只允许一次）。
    const emptyCtx = makeCtx()
    await emptyCtx.credentials.set('GEMINI_ACCOUNT_0CDFBE09', credentialBody())
    const { pool, updates } = makePool([accountOf()])

    const empty = newService(emptyCtx.ctx, userInfoFetcher({}).fetcher)
    await expect(empty.repairAccountNicknames(pool)).resolves.toEqual([])

    const throwingCtx = makeCtx()
    await throwingCtx.credentials.set('GEMINI_ACCOUNT_0CDFBE09', credentialBody())
    const throwing = newService(
      throwingCtx.ctx,
      (async () => { throw new Error('network down') }) as unknown as typeof fetch,
    )
    await expect(throwing.repairAccountNicknames(pool)).resolves.toEqual([])

    expect(updates).toEqual([])
  })

  it('单账号失败不中断其余账号', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set('GEMINI_ACCOUNT_AAAA1111', credentialBody())
    await credentials.set('GEMINI_ACCOUNT_BBBB2222', credentialBody({ email: 'ok@example.com' }))
    let failedOnce = false
    const fetcher = (async () => {
      if (!failedOnce) { failedOnce = true; throw new Error('boom') }
      return new Response(JSON.stringify({ id: 'sub-2', email: 'two@example.com' }), { status: 200 })
    }) as unknown as typeof fetch
    const service = newService(ctx, fetcher)
    const { pool, updates } = makePool([
      accountOf({ id: 'gemini-1', credentialRef: 'GEMINI_ACCOUNT_AAAA1111', nickname: 'gemini-1' }),
      accountOf({ id: 'gemini-2', credentialRef: 'GEMINI_ACCOUNT_BBBB2222', nickname: 'gemini-2' }),
    ])

    const repaired = await service.repairAccountNicknames(pool)

    expect(repaired, '第二个账号仍应被修复').toEqual(['gemini-2'])
    expect(updates).toEqual([{ id: 'gemini-2', nickname: 'ok@example.com' }])
  })

  it('边界：坏凭据被跳过、不越界改别的 provider、池列举失败返空数组', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set('GEMINI_ACCOUNT_BBBB2222', '{ not json')
    await credentials.set('GEMINI_ACCOUNT_CCCC3333', credentialBody({ email: 'me@example.com' }))
    const { fetcher, calls } = userInfoFetcher()
    const service = newService(ctx, fetcher)
    const { pool, updates } = makePool([
      accountOf({ id: 'gemini-1', credentialRef: 'GEMINI_ACCOUNT_MISSING' }),
      accountOf({ id: 'gemini-2', credentialRef: 'GEMINI_ACCOUNT_BBBB2222' }),
      accountOf({ id: 'gemini-3', credentialRef: 'GEMINI_ACCOUNT_CCCC3333' }),
      { ...accountOf({ id: 'zcode-1', nickname: 'zcode-1' }), provider: 'zcode' } as ProviderAccountStatus,
    ])

    const repaired = await service.repairAccountNicknames(pool)

    expect(repaired).toEqual(['gemini-3'])
    expect(updates.map((entry) => entry.id)).toEqual(['gemini-3'])
    expect(calls(), '坏凭据不该触发网络').toBe(0)

    const brokenPool = {
      listAccounts: async () => { throw new Error('pool down') },
    } as unknown as AccountPool
    await expect(newService(makeCtx().ctx, fetcher).repairAccountNicknames(brokenPool)).resolves.toEqual([])
  })
})
