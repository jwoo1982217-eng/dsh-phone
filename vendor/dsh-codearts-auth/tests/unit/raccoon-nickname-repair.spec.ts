import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RaccoonAuth } from '../../src/raccoon-auth.js'
import { buildRaccoonNickname } from '../../src/jet-hub-rpc.js'
import type { AccountPool, ProviderAccountStatus } from '../../src/account-pool.js'

/** 所有已创建的 service；afterEach 统一释放。 */
const services: RaccoonAuth[] = []

/** 最小化的内存凭据提供者。 */
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

function newService(ctx: Context, fetcher?: typeof fetch): RaccoonAuth {
  const service = new RaccoonAuth(ctx, fetcher === undefined ? {} : { fetcher })
  services.push(service)
  return service
}

afterEach(() => {
  for (const s of services.splice(0)) {
    const d = s as unknown as { [Symbol.dispose]?: () => void }
    d[Symbol.dispose]?.()
  }
})

/** 账号池替身：记录 updateAccount 调用。 */
function makePool(accounts: ProviderAccountStatus[]): {
  pool: AccountPool
  updates: Array<{ id: string; nickname: unknown }>
} {
  const updates: Array<{ id: string; nickname: unknown }> = []
  const pool = {
    listAccounts: async () => accounts,
    updateAccount: async (id: string, patch: { nickname?: string }) => {
      updates.push({ id, nickname: patch.nickname })
      // 同步更新条目，便于多次调用的一致性
      const target = accounts.find((a) => a.id === id)
      if (target !== undefined && patch.nickname !== undefined) target.nickname = patch.nickname
    },
  } as unknown as AccountPool
  return { pool, updates }
}

function accountOf(patch: Partial<ProviderAccountStatus> = {}): ProviderAccountStatus {
  return {
    id: 'raccoon-b4c18de9',
    provider: 'raccoon',
    credentialRef: 'RACCOON_ACCOUNT_ABD05EAC',
    enabled: true,
    refreshable: true,
    nickname: 'RaccoonAva',
    createdAt: Date.now(),
    // ⚠️ `...patch` 必须放最后 —— 早期漏了这一行，导致 `accountOf({nickname})`
    // **静默忽略传入的覆盖值**，两个用例因此假失败（表现为「实现不幂等」，
    // 实际是被测代码正确、测试替身没生效）。这类「参数被无声丢弃」的替身缺陷
    // 比实现缺陷更难查，因为失败现象与实现缺陷一模一样。
    ...patch,
  } as unknown as ProviderAccountStatus
}

/** 模拟远端 user_info（字段值取自本机实测）。 */
function userInfoFetcher(overrides: Record<string, unknown> = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({
    code: 0,
    data: {
      name: 'RaccoonAva',
      id: '7445120',
      phone: '13011111100',
      office_identity: '',
      ...overrides,
    },
  }), { status: 200 })) as unknown as typeof fetch
}

const JWT = (() => {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
})()

describe('repairAccountNicknames', () => {
  it('**补 phone 并把昵称改为 `原名 (尾号)`**（修已登录的老账号）', async () => {
    const { ctx, credentials } = makeCtx()
    // 老凭据：有 nickname 但**没有 phone**（旧实现没提取它）
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: JWT, refresh_token: 'r', user_id: '7445120', nickname: 'RaccoonAva',
    }))
    const { pool, updates } = makePool([accountOf()])
    const auth = newService(ctx, userInfoFetcher())

    const repaired = await auth.repairAccountNicknames(pool, buildRaccoonNickname)

    // 昵称被改为带尾号的形态
    expect(repaired).toEqual(['raccoon-b4c18de9'])
    expect(updates).toEqual([{ id: 'raccoon-b4c18de9', nickname: 'RaccoonAva (1100)' }])
    // 凭据被补上 phone
    const saved = JSON.parse(credentials.store.get('RACCOON_ACCOUNT_ABD05EAC') ?? '{}') as { phone?: string }
    expect(saved.phone).toBe('13011111100')
  })

  it('**幂等**：昵称已是目标形态时不重复写', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: JWT, refresh_token: 'r', user_id: '7445120',
      nickname: 'RaccoonAva', phone: '13011111100',
    }))
    // 账号池里的昵称已是目标值
    const { pool, updates } = makePool([accountOf({ nickname: 'RaccoonAva (1100)' })])
    const auth = newService(ctx, userInfoFetcher())

    const repaired = await auth.repairAccountNicknames(pool, buildRaccoonNickname)
    expect(repaired).toEqual([])
    expect(updates).toEqual([])
  })

  it('凭据已有 phone 时不发 user_info 请求（省一次网络往返）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: JWT, refresh_token: 'r', user_id: '7445120', phone: '13011111100',
    }))
    const { pool } = makePool([accountOf()])
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)

    await auth.repairAccountNicknames(pool, buildRaccoonNickname)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('user_info 失败时仍能修复（退化为用户 id 后缀）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: JWT, refresh_token: 'r', user_id: '7445120', nickname: 'RaccoonAva',
    }))
    const { pool, updates } = makePool([accountOf()])
    const fetcher = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)

    const repaired = await auth.repairAccountNicknames(pool, buildRaccoonNickname)
    expect(repaired).toEqual(['raccoon-b4c18de9'])
    // 无 phone → 用 user_id 作后缀
    expect(updates[0]?.nickname).toBe('RaccoonAva (7445120)')
  })

  it('单个账号失败不影响其他账号', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('OK', JSON.stringify({
      access_token: JWT, refresh_token: 'r', user_id: '1111', nickname: 'A', phone: '13000001111',
    }))
    // BAD 故意放非法 JSON → parseRaccoonCredential 返回 undefined → 跳过
    credentials.store.set('BAD', 'not json')
    const { pool } = makePool([
      accountOf({ id: 'a-ok', credentialRef: 'OK', nickname: 'A' }),
      accountOf({ id: 'a-bad', credentialRef: 'BAD', nickname: 'B' }),
    ])
    const auth = newService(ctx, userInfoFetcher())

    const repaired = await auth.repairAccountNicknames(pool, buildRaccoonNickname)
    expect(repaired).toEqual(['a-ok'])
  })

  it('凭据缺失的账号被跳过（不抛错）', async () => {
    const { ctx } = makeCtx()
    const { pool, updates } = makePool([accountOf({ credentialRef: 'NOT_THERE' })])
    const auth = newService(ctx, userInfoFetcher())
    const repaired = await auth.repairAccountNicknames(pool, buildRaccoonNickname)
    expect(repaired).toEqual([])
    expect(updates).toEqual([])
  })

  it('账号池读取失败时安全返回空（不抛错、不阻塞启动）', async () => {
    const { ctx } = makeCtx()
    const pool = {
      listAccounts: async () => { throw new Error('pool broken') },
    } as unknown as AccountPool
    const auth = newService(ctx, userInfoFetcher())
    await expect(auth.repairAccountNicknames(pool, buildRaccoonNickname)).resolves.toEqual([])
  })

  it('不调用任何写端点（只读 user_info）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCOUNT_ABD05EAC', JSON.stringify({
      access_token: JWT, refresh_token: 'r', user_id: '7445120', nickname: 'RaccoonAva',
    }))
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({
        code: 0, data: { name: 'RaccoonAva', id: '7445120', phone: '13011111100' },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const { pool } = makePool([accountOf()])
    const auth = newService(ctx, fetcher)

    await auth.repairAccountNicknames(pool, buildRaccoonNickname)
    // 只应有 user_info（GET），不得触碰积分领取（POST /login/points/grant）
    expect(calls.every((u) => u.includes('/user_info'))).toBe(true)
    expect(calls.some((u) => u.includes('/points/grant'))).toBe(false)
  })
})
