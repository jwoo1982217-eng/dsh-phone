import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClineAuth, RefreshTokenExpiredError } from '../../src/cline-auth.js'
import { CLINE } from '../../src/cline-product.js'
import { buildClineCredential, clineRefreshBody, parseClineTokenPayload } from '../../src/cline.js'
import { AccountPool } from '../../src/account-pool.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: ClineAuth[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
})

/**
 * 内存凭据提供者，形状与 ctx.credentials 一致。
 *
 * 用真实 `Context` + `ctx.provide('credentials', ...)`（而非裸对象 mock）：
 * cordis 的 `Service` 构造会调用 `ctx.provide`，裸对象会在
 * `Cannot read properties of undefined (reading 'provide')` 处炸掉。
 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: unknown) {
    const value = this.store.get(keyOf(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const has = this.store.has(keyOf(ref))
    return { configured: has, source: has ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) { this.store.set(keyOf(ref), value) }
  async unset(ref: unknown) { this.store.delete(keyOf(ref)) }
  has(ref: unknown): boolean { return this.store.has(keyOf(ref)) }
  raw(ref: unknown): string | undefined { return this.store.get(keyOf(ref)) }
}

/** 取凭据 ref 的键名（credentialRef(name) 返回 `{ name }` 形态）。 */
function keyOf(ref: unknown): string {
  if (typeof ref === 'string') return ref
  if (ref !== null && typeof ref === 'object' && 'name' in ref) {
    return String((ref as { name: unknown }).name)
  }
  return String(ref)
}

/** 建立带凭据存储的 Context。 */
function makeCtx(entries: Array<[string, string]> = []): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  for (const [ref, value] of entries) void credentials.set(ref, value)
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

/** 构造 service 并登记以便 afterEach 清理。 */
function newService(ctx: Context, fetcher: typeof fetch): ClineAuth {
  const service = new ClineAuth(ctx, { product: CLINE, fetcher })
  services.push(service)
  return service
}

/** 读回已存凭据的 JSON。 */
function readCred(credentials: FakeCredentials, ref: string): Record<string, unknown> {
  return JSON.parse(credentials.raw(ref)!) as Record<string, unknown>
}

const credJson = JSON.stringify(buildClineCredential(
  parseClineTokenPayload({
    success: true,
    data: {
      accessToken: 'workos:tok-1',
      refreshToken: 'ref-1',
      expiresAt: '2030-01-01T00:00:00Z',
      userInfo: { clineUserId: 'usr-1', email: 'a@b.c' },
    },
  }),
  CLINE,
))

/**
 * 「**已进入 lead 窗口**」的凭据（距过期 5 分钟）。
 *
 * `refreshAll` 现在带 lead-time 过滤（`src/expiry-sync.ts` 的 `shouldRefreshNow`，
 * 与单凭据时代 `REFRESH_LEAD_MS` 同语义）：距过期**超过 1 小时**的账号本轮
 * 只与账号池对账、不发续期请求。上面的 `credJson` 过期时间在 2030 年，
 * 用它做「会不会被续期」的用例必然得到 0 次请求 —— 那是判据在生效，
 * 不是缺陷。所以这类用例必须拿一份「该刷了」的凭据。
 */
const dueCredJson = JSON.stringify(buildClineCredential(
  parseClineTokenPayload({
    success: true,
    data: {
      accessToken: 'workos:tok-1',
      refreshToken: 'ref-1',
      expiresAt: String(Date.now() + 300_000),
      userInfo: { clineUserId: 'usr-1', email: 'a@b.c' },
    },
  }),
  CLINE,
))

/** 成功的续期响应（与注册同构的 `{success, data}` 信封）。 */
function refreshOk(accessToken = 'workos:tok-2', refreshToken = 'ref-2'): Response {
  return new Response(JSON.stringify({
    success: true,
    data: { accessToken, refreshToken, expiresAt: '2030-01-01T00:00:00Z' },
  }), { status: 200 })
}

describe('ClineAuth 续期', () => {
  it('401 抛 RefreshTokenExpiredError 且 name 精确（refresh.ts 按 name 判定）', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).name).toBe('RefreshTokenExpiredError')
  })

  it('403 同样视为终态', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('200 但缺 accessToken 视为终态（不是可重试故障）', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ success: true, data: {} }), { status: 200 },
    )) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('5xx 是可重试错误（普通 Error，不判终态）', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).name).not.toBe('RefreshTokenExpiredError')
  })

  it('网络失败不判终态（网络抖动不该让用户重新登录）', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toContain('网络失败')
  })

  it('续期请求打到 /api/v1/auth/refresh 且 body 用驼峰字段', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return refreshOk()
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refresh()
    expect(calls[0]!.url).toBe('https://api.cline.bot/api/v1/auth/refresh')
    // ⚠️ 字段名是驼峰 refreshToken / grantType（不是 OAuth 标准的 snake_case）
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      refreshToken: 'ref-1',
      grantType: 'refresh_token',
    })
    expect((calls[0]!.init.headers as Record<string, string>)['X-CLIENT-TYPE']).toBe('cline-sdk')
  })

  it('续期成功后回写新令牌并保留 workos: 前缀', async () => {
    const { ctx, credentials } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refresh()
    const stored = readCred(credentials, 'CLINE_ACCESS_TOKEN')
    expect(stored.access_token).toBe('workos:tok-2')
    expect(stored.refresh_token).toBe('ref-2')
  })

  it('续期响应不带前缀时自动补上（对上游变更鲁棒）', async () => {
    const { ctx, credentials } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => refreshOk('tok-3', 'ref-3')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refresh()
    expect(readCred(credentials, 'CLINE_ACCESS_TOKEN').access_token).toBe('workos:tok-3')
  })

  it('无 refresh_token 时报终态（提示重新登录）', async () => {
    const noRefresh = JSON.stringify({ access_token: 'workos:a', expire_time: Date.now() + 1000 })
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', noRefresh]])
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('未配置凭据时给出可操作错误', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(/未配置凭据/)
  })
})

describe('ClineAuth refreshAccountCredential（按账号 ref）', () => {
  it('刷新的是指定 ref，不是默认单凭据 ref', async () => {
    const { ctx, credentials } = makeCtx([
      ['CLINE_ACCOUNT_ABC', credJson],
      ['CLINE_ACCESS_TOKEN', credJson],
    ])
    const fetcher = vi.fn(async () => refreshOk('workos:acc-2', 'ref-acc-2')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refreshAccountCredential('CLINE_ACCOUNT_ABC')

    // 账号 ref 被更新
    expect(readCred(credentials, 'CLINE_ACCOUNT_ABC').access_token).toBe('workos:acc-2')
    // 默认单凭据 ref **不受影响**（用 refresh() 刷账号池会刷错对象）
    expect(readCred(credentials, 'CLINE_ACCESS_TOKEN').access_token).toBe('workos:tok-1')
  })

  it('不触碰单凭据的失效状态（避免 UI 显示错误的失效提示）', async () => {
    const { ctx } = makeCtx([['CLINE_ACCOUNT_ABC', credJson]])
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refreshAccountCredential('CLINE_ACCOUNT_ABC')).rejects.toThrow(RefreshTokenExpiredError)
    // status() 读的是默认 ref（未配置）→ 不应因账号级失败而变成「已失效」
    const status = await auth.status()
    expect(status.configured).toBe(false)
    expect(status.refreshError).toBeUndefined()
  })
})

describe('ClineAuth refreshAll', () => {
  /** 建立带账号池的 Context。 */
  function makePoolCtx(): { ctx: Context; credentials: FakeCredentials; pool: AccountPool } {
    const { ctx, credentials } = makeCtx()
    const pool = new AccountPool(ctx)
    return { ctx, credentials, pool }
  }

  it('只按 refreshable 过滤，**不看 enabled**（停用账号也要保持凭据新鲜）', async () => {
    const { ctx, credentials, pool } = makePoolCtx()
    await credentials.set('CLINE_ACCOUNT_ENABLED', dueCredJson)
    await credentials.set('CLINE_ACCOUNT_DISABLED', dueCredJson)
    await pool.addAccount({
      id: 'acc-enabled', provider: 'cline', nickname: 'a', enabled: true,
      credentialRef: 'CLINE_ACCOUNT_ENABLED', createdAt: 1, refreshable: true,
    })
    await pool.addAccount({
      id: 'acc-disabled', provider: 'cline', nickname: 'b', enabled: false,
      credentialRef: 'CLINE_ACCOUNT_DISABLED', createdAt: 2, refreshable: true,
    })

    const fetcher = vi.fn(async () => refreshOk('workos:new', 'ref-new')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refreshAll(pool)

    // 两个账号都被续期（停用的那个也必须刷，否则重新启用时只能重新登录）
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(readCred(credentials, 'CLINE_ACCOUNT_ENABLED').access_token).toBe('workos:new')
    expect(readCred(credentials, 'CLINE_ACCOUNT_DISABLED').access_token).toBe('workos:new')
  })

  it('终态失败把该账号标记为不可续期（不再重试）', async () => {
    const { ctx, credentials, pool } = makePoolCtx()
    await credentials.set('CLINE_ACCOUNT_X', dueCredJson)
    await pool.addAccount({
      id: 'acc-x', provider: 'cline', nickname: 'x', enabled: true,
      credentialRef: 'CLINE_ACCOUNT_X', createdAt: 1, refreshable: true,
    })
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refreshAll(pool)

    const accounts = await pool.listAccounts('cline')
    expect(accounts[0]!.refreshable).toBe(false)
  })

  it('单账号失败不中断其余账号', async () => {
    const { ctx, credentials, pool } = makePoolCtx()
    await credentials.set('CLINE_ACCOUNT_1', dueCredJson)
    await credentials.set('CLINE_ACCOUNT_2', dueCredJson)
    await pool.addAccount({
      id: 'a1', provider: 'cline', nickname: '1', enabled: true,
      credentialRef: 'CLINE_ACCOUNT_1', createdAt: 1, refreshable: true,
    })
    await pool.addAccount({
      id: 'a2', provider: 'cline', nickname: '2', enabled: true,
      credentialRef: 'CLINE_ACCOUNT_2', createdAt: 2, refreshable: true,
    })
    let call = 0
    const fetcher = vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response('boom', { status: 500 })
        : refreshOk('workos:second', 'ref-2')
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refreshAll(pool)

    // 第一个失败（可重试），第二个仍被处理
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(readCred(credentials, 'CLINE_ACCOUNT_2').access_token).toBe('workos:second')
  })

  it('⚠️ 距过期还有 2 小时的账号本轮**不**被续期（lead-time 过滤）', async () => {
    // 多账号调度器早期是「每 30 分钟无脑全量刷」。现恢复单凭据时代的
    // `REFRESH_LEAD_MS` 语义：距过期不足 1 小时才刷 —— 长寿命 provider
    // （buddy / lobsterai / qoder / qodercn 的令牌寿命 720 小时）从此不再
    // 每半小时被无谓轮换一次。
    const { ctx, credentials, pool } = makePoolCtx()
    await credentials.set('CLINE_ACCOUNT_1', credJson)
    await pool.addAccount({
      id: 'a1', provider: 'cline', nickname: '1', enabled: true,
      credentialRef: 'CLINE_ACCOUNT_1', createdAt: 1, refreshable: true,
    })
    const fetcher = vi.fn(async () => refreshOk('workos:new', 'ref-new')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)

    await auth.refreshAll(pool)

    expect(fetcher, '凭据还很新鲜，不该发续期请求').not.toHaveBeenCalled()
    expect(readCred(credentials, 'CLINE_ACCOUNT_1').access_token).toBe('workos:tok-1')
  })

  it('⚠️ 按需续期（RPC account.refresh）成功后把新 expiresAt 写回账号池', async () => {
    // issue !IKIRTT 的连带缺陷：UI 读的正是账号池的 `expiresAt`。
    // 早先 cline 只 `credentials.set`，于是续期成功、凭据也换新了，
    // 卡片却**一直显示「已过期」**，且「重测」按钮不救急 —— 没有任何自救手段。
    const { ctx, credentials, pool } = makePoolCtx()
    await credentials.set('CLINE_ACCOUNT_ABC', dueCredJson)
    await pool.addAccount({
      id: 'acc-abc', provider: 'cline', nickname: 'abc', enabled: true,
      credentialRef: 'CLINE_ACCOUNT_ABC', createdAt: 1, refreshable: true,
      expiresAt: Date.now() - 60_000,
    })
    const auth = newService(ctx, vi.fn(async () => refreshOk()) as unknown as typeof fetch)

    await auth.refreshAccountCredential('CLINE_ACCOUNT_ABC', pool, 'acc-abc')

    const [entry] = await pool.listAccounts('cline')
    expect(entry?.expiresAt, '刷新后账号池仍是旧值 → UI 会继续挂「已过期」')
      .toBeGreaterThan(Date.now())
  })

  it('回写账号池失败**不反噬**已成功的续期（只记日志）', async () => {
    const { ctx, credentials, pool } = makePoolCtx()
    await credentials.set('CLINE_ACCOUNT_ABC', dueCredJson)
    const auth = newService(ctx, vi.fn(async () => refreshOk()) as unknown as typeof fetch)
    // 让索引写入抛错：凭据已经续好了，不该因为写索引失败而要求用户重新登录。
    vi.spyOn(pool, 'updateAccount').mockRejectedValue(new Error('账号池写入失败'))

    await expect(
      auth.refreshAccountCredential('CLINE_ACCOUNT_ABC', pool, 'missing-id'),
    ).resolves.toBeUndefined()
    expect(readCred(credentials, 'CLINE_ACCOUNT_ABC').access_token).toBe('workos:tok-2')
  })

  it('凭据缺失时把账号标记为不可续期（避免永远刷不动）', async () => {
    const { ctx, pool } = makePoolCtx()
    await pool.addAccount({
      id: 'ghost', provider: 'cline', nickname: 'g', enabled: true,
      credentialRef: 'CLINE_ACCOUNT_MISSING', createdAt: 1, refreshable: true,
    })
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refreshAll(pool)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await pool.listAccounts('cline'))[0]!.refreshable).toBe(false)
  })
})

describe('ClineAuth status / logout', () => {
  it('未配置时 status 报 configured:false', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    expect(await auth.status()).toEqual({ configured: false, refreshable: false })
  })

  it('已配置时可续期', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const status = await auth.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(true)
  })

  it('logout 清掉凭据', async () => {
    const { ctx, credentials } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.logout()
    expect(credentials.has('CLINE_ACCESS_TOKEN')).toBe(false)
  })

  it('checkExpired 在无凭据时报 true', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    expect(await auth.checkExpired()).toBe(true)
  })

  it('resolveStoredCredential 读回凭据（供 e2e 探针使用）', async () => {
    const { ctx } = makeCtx([['CLINE_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const credential = await auth.resolveStoredCredential()
    expect(credential?.access_token).toBe('workos:tok-1')
    expect(credential?.account_id).toBe('usr-1')
  })
})

describe('ClineAuth 续期载荷与产品配置联动', () => {
  it('clineRefreshBody 与产品无关（纯凭据派生）', () => {
    const body = clineRefreshBody({ access_token: 'a', refresh_token: 'r' })
    expect(body).toEqual({ refreshToken: 'r', grantType: 'refresh_token' })
  })

  it('服务名由 product.id 派生为 clineAuth', () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    expect(auth.product.id).toBe('cline')
    expect(auth.credentialRefName).toBe('CLINE_ACCESS_TOKEN')
  })
})
