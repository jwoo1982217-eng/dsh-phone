import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUDDY_CREDENTIAL_REF, BuddyAuth } from '../../src/buddy-auth.js'
import { RefreshTokenExpiredError, runBuddyLoginFlow } from '../../src/buddy-oauth.js'
import type { BuddyCredential } from '../../src/buddy.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'

vi.mock('../../src/buddy-oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/buddy-oauth.js')>()
  return {
    ...actual,
    runBuddyLoginFlow: vi.fn(),
  }
})

const mockedRunBuddyLoginFlow = vi.mocked(runBuddyLoginFlow)

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: BuddyAuth[] = []

/** 最小化的内存凭据提供者，形状与 ctx.credentials 一致。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

/** 返回一个已注入内存凭据提供者的 Context（无需在测试内解构 credentials）。 */
function createMockContext(): Context & { credentials: FakeCredentials } {
  return makeContext().ctx as Context & { credentials: FakeCredentials }
}

function newService(ctx: Context, options: { fetcher?: typeof fetch } = {}): BuddyAuth {
  const service = new BuddyAuth(ctx, options)
  services.push(service)
  return service
}

/** 构造一个可刷新的凭据（默认 2 小时后过期）。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    refresh_expires_at: String(Date.now() + 2_592_000_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    user_id: 'u1',
    nickname: 'nick',
    enterprise_id: '',
    account_type: 'personal',
    ...overrides,
  }
}

/** 返回刷新成功响应的 fetch stub。 */
function refreshFetcher(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({
    code: 0,
    data: {
      accessToken: 'AT2',
      refreshToken: 'RT2',
      expiresAt: String(Date.now() + 7_200_000),
      refreshExpiresAt: String(Date.now() + 2_592_000_000),
      tokenType: 'Bearer',
      scope: '',
      domain: 'copilot.tencent.com',
    },
  }), { status: 200 })) as unknown as typeof fetch
}

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('BuddyAuth', () => {
  it('registers as ctx.buddyAuth on construction', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(ctx.buddyAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyAuth.name).toBe('buddyAuth')
  })

  it('login stores the credential JSON under the fixed ref', async () => {
    const credential = makeCredential()
    mockedRunBuddyLoginFlow.mockResolvedValue({
      access: JSON.stringify(credential),
      expires: Date.now() + 7_200_000,
      loginUrl: 'https://www.codebuddy.cn/login/?platform=ide&state=s',
      refreshable: true,
    })
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: refreshFetcher() })
    const result = await service.login()
    expect(result.refreshable).toBe(true)
    expect(result.loginUrl).toContain('codebuddy.cn/login')
    expect(String(result.ref)).toBe(BUDDY_CREDENTIAL_REF)
    const stored = JSON.parse((await credentials.resolve(BUDDY_CREDENTIAL_REF))!.value) as BuddyCredential
    expect(stored.access_token).toBe('AT')
    expect(stored.user_id).toBe('u1')
  })

  it('login propagates flow failures', async () => {
    mockedRunBuddyLoginFlow.mockRejectedValue(new Error('获取 token 超时（5 分钟）'))
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: refreshFetcher() })
    await expect(service.login()).rejects.toThrow('获取 token 超时（5 分钟）')
  })

  it('status reports unconfigured without a stored value', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.status()).toEqual({ configured: false, refreshable: false })
  })

  it('status parses expires_at and reports refreshable', async () => {
    const { ctx, credentials } = makeContext()
    const expires = Date.now() + 7_200_000
    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential({ expires_at: String(expires) })))
    const service = newService(ctx)
    expect(await service.status()).toEqual({
      configured: true,
      source: 'fake',
      expiresAt: expires,
      refreshable: true,
    })
  })

  it('status tolerates a credential without expiry metadata', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential({ expires_at: undefined })))
    const service = newService(ctx)
    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.expiresAt).toBeUndefined()
  })

  it('logout removes the stored credential', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx)
    await service.logout()
    expect(await credentials.resolve(BUDDY_CREDENTIAL_REF)).toBeUndefined()
  })
})

describe('BuddyAuth silent refresh', () => {
  it('refresh exchanges the refresh_token and rewrites the credential', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const fetcher = refreshFetcher()
    const service = newService(ctx, { fetcher })

    await service.refresh()

    const stored = JSON.parse((await credentials.resolve(BUDDY_CREDENTIAL_REF))!.value) as BuddyCredential
    expect(stored.access_token).toBe('AT2')
    expect(stored.refresh_token).toBe('RT2')
    // 账户信息必须保留（刷新响应不含 account 字段）。
    expect(stored.user_id).toBe('u1')
    expect(stored.nickname).toBe('nick')
    expect(stored.account_type).toBe('personal')

    const [url, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(url).toContain('/v2/plugin/auth/token/refresh')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Refresh-Token']).toBe('RT')
    expect(headers['X-Auth-Refresh-Source']).toBe('ide-main')
    expect(headers.Authorization).toBe('Bearer AT')
  })

  it('refresh reports an explicit error when the credential lacks a refresh_token', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential({ refresh_token: '' })))
    const service = newService(ctx)
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
    expect(await service.status()).toMatchObject({ refreshable: false })
  })

  it('refresh throws when no credential is configured', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    await expect(service.refresh()).rejects.toThrow('未配置凭据，请先登录')
  })

  it('refresh_token expiry stops scheduling and surfaces refreshError', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, credentials } = makeContext()
      // 凭据已过期 → scheduleRefresh 立即武装并触发刷新。
      await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(
        makeCredential({ expires_at: String(Date.now() - 60_000) }),
      ))
      const fetcher = vi.fn(async () => new Response(JSON.stringify({
        code: 401,
        message: 'refresh token expired',
      }), { status: 401 })) as unknown as typeof fetch

      const service = newService(ctx, { fetcher })
      await service.scheduleRefresh()
      await vi.runAllTimersAsync()

      const status = await service.status()
      expect(status.refreshError).toContain('已失效')
      expect(status.refreshable).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logout during an in-flight refresh prevents credential resurrection', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    // 可控 Promise：模拟刷新请求在途，直到手动 resolve。
    let release!: () => void
    const fetcher = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accessToken: 'AT3', refreshToken: 'RT3',
          expiresAt: String(Date.now() + 7_200_000), refreshExpiresAt: '',
          tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const service = newService(ctx, { fetcher })
    const scheduleSpy = vi.spyOn(service, 'scheduleRefresh')
    const refreshing = service.refresh()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())

    await service.logout()
    release()
    await refreshing

    // 凭据未被在途刷新回写；调度未被重新武装。
    expect(await credentials.resolve(BUDDY_CREDENTIAL_REF)).toBeUndefined()
    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('checkExpired reflects the stored expiry', async () => {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx)
    expect(await service.checkExpired()).toBe(true)

    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential({ expires_at: String(Date.now() + 7_200_000) })))
    expect(await service.checkExpired()).toBe(false)

    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential({ expires_at: String(Date.now() - 60_000) })))
    expect(await service.checkExpired()).toBe(true)
  })

  it('fetchModels returns an empty list when not logged in', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.fetchModels()).toEqual([])
  })

  it('fetchModels parses the craft agent list from /v3/config', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(BUDDY_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { agents: [{ name: 'craft', models: ['auto', 'glm-5.3', 'kimi-k3-1'] }] },
    }), { status: 200 })) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    expect(await service.fetchModels()).toEqual([
      { id: 'glm-5.3', name: 'GLM-5.3', agentReferenced: true },
      { id: 'kimi-k3-1', name: 'Kimi K3-1', agentReferenced: true },
    ])
  })
})

describe('产品参数化', () => {
  it('默认构造使用 CodeBuddy 配置', () => {
    const auth = new BuddyAuth(createMockContext() as never)
    expect(auth.product.id).toBe('buddy')
    expect(auth.credentialRefName).toBe('BUDDY_ACCESS_TOKEN')
  })

  it('传入 WorkBuddy 配置时使用其 platform 与凭据 ref', () => {
    const auth = new BuddyAuth(createMockContext() as never, { product: WORKBUDDY })
    expect(auth.product.id).toBe('workbuddy')
    expect(auth.credentialRefName).toBe('WORKBUDDY_ACCESS_TOKEN')
  })

  it('WorkBuddy 实例的 status 读取自己的凭据 ref', async () => {
    const ctx = createMockContext()
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY })
    // 只写入 WorkBuddy 的 ref
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCESS_TOKEN'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    const status = await auth.status()
    expect(status.configured).toBe(true)
  })

  it('WorkBuddy 实例看不到 CodeBuddy 的凭据', async () => {
    const ctx = createMockContext()
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY })
    await ctx.credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    const status = await auth.status()
    expect(status.configured).toBe(false)
  })

  // 以下为 brief 4 条之外的补充：brief 未覆盖 logout/refreshAll/fetchModels/pool 注册
  // 这四处替换点，任何一处漏改都会让 WorkBuddy 误动 CodeBuddy 的凭据，故逐点设防。

  it('WorkBuddy 的 logout 不会清除 CodeBuddy 的凭据', async () => {
    const ctx = createMockContext()
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY })
    const buddyValue = JSON.stringify(makeCredential())
    await ctx.credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), buddyValue)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCESS_TOKEN'), buddyValue)

    await auth.logout()

    expect(await ctx.credentials.resolve(credentialRef('WORKBUDDY_ACCESS_TOKEN'))).toBeUndefined()
    expect((await ctx.credentials.resolve(credentialRef('BUDDY_ACCESS_TOKEN')))?.value).toBe(buddyValue)
  })

  it('WorkBuddy 的 checkExpired 只看自己的凭据', async () => {
    const ctx = createMockContext()
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY })
    // 只写 CodeBuddy 的有效凭据 → WorkBuddy 仍视为未配置（即已过期）
    await ctx.credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), JSON.stringify(makeCredential()))
    expect(await auth.checkExpired()).toBe(true)

    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCESS_TOKEN'), JSON.stringify(makeCredential()))
    expect(await auth.checkExpired()).toBe(false)
  })

  it('WorkBuddy 的 fetchModels 只解析自己的凭据', async () => {
    const ctx = createMockContext()
    // 用 CodeBuddy 的凭据：若 WorkBuddy 误读它，会发出请求并返回模型列表。
    await ctx.credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), JSON.stringify(makeCredential()))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { agents: [{ name: 'craft', models: ['auto', 'glm-5.3'] }] },
    }), { status: 200 })) as unknown as typeof fetch
    // 记录账号池查询用的 provider：传入 pool 才能覆盖池优先分支。
    const queried: string[] = []
    const pool = {
      getAvailableAccount: async (provider: string) => { queried.push(provider); return undefined },
    }
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY, fetcher })

    expect(await auth.fetchModels(pool as never)).toEqual([])
    expect(queried).toEqual(['workbuddy'])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('WorkBuddy 的 login 以自身 ref 与 provider 写入账号池，并把自身 product 传给登录流程', async () => {
    const ctx = createMockContext()
    const credential = makeCredential()
    mockedRunBuddyLoginFlow.mockResolvedValue({
      access: JSON.stringify(credential),
      expires: Date.now() + 7_200_000,
      loginUrl: 'https://www.codebuddy.cn/login/?platform=workbuddy&state=s',
      refreshable: true,
    })
    const added: Array<{ provider: string; credentialRef: string }> = []
    const pool = {
      addAccount: async (entry: { provider: string; credentialRef: string }) => { added.push(entry) },
    }
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY, fetcher: refreshFetcher() })
    services.push(auth)

    const result = await auth.login({ accountId: 'wb-1', pool: pool as never })

    expect(String(result.ref)).toBe('WORKBUDDY_ACCESS_TOKEN')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ provider: 'workbuddy', credentialRef: 'WORKBUDDY_ACCESS_TOKEN' })
    expect(mockedRunBuddyLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({ product: WORKBUDDY }),
    )
    expect(await ctx.credentials.resolve(credentialRef('WORKBUDDY_ACCESS_TOKEN'))).toBeDefined()
    expect(await ctx.credentials.resolve(credentialRef('BUDDY_ACCESS_TOKEN'))).toBeUndefined()
  })

  it('WorkBuddy 的 refreshAll 只续期本产品账号', async () => {
    const ctx = createMockContext()
    const credential = makeCredential({ refresh_token: '' })
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_T1'), JSON.stringify(credential))
    const listed: string[] = []
    const updated: string[] = []
    const pool = {
      listAccounts: async (provider: string) => {
        listed.push(provider)
        return [{ id: 'wb-1', provider, enabled: true, refreshable: true, credentialRef: 'WORKBUDDY_ACCOUNT_T1' }]
      },
      updateAccount: async (id: string) => { updated.push(id) },
    }
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY, fetcher: refreshFetcher() })
    services.push(auth)

    await auth.refreshAll(pool as never)

    // 只查自己的 provider，且无 refresh_token 的账号被标记为不可续期。
    expect(listed).toEqual(['workbuddy'])
    expect(updated).toEqual(['wb-1'])
  })

  /**
   * 真实缺陷（用户报障）：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，
   * 且领取积分时报 `Unexpected token '<'`（服务端返回 HTML 错误页）。
   *
   * 根因是 `refreshAll` 里的 `if (!entry.enabled || ...) continue`：
   * **停用账号被跳过续期**，refresh_token 一路放到失效，用户重新启用后
   * 拿到的是死凭据，只能重新登录。
   *
   * 停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
   * 停用账号同样会出现在 Jet Hub 里并参与积分领取。
   */
  it('refreshAll 也续期已停用账号（停用不等于放弃凭据）', async () => {
    const ctx = createMockContext()
    await ctx.credentials.set(
      credentialRef('BUDDY_ACCOUNT_D1'),
      JSON.stringify(makeCredential()),
    )
    const updated: string[] = []
    const pool = {
      listAccounts: async (provider: string) => [
        { id: 'enabled-1', provider, enabled: true, refreshable: true, credentialRef: 'BUDDY_ACCOUNT_E1' },
        // 停用但可续期 —— 必须同样被续期
        { id: 'disabled-1', provider, enabled: false, refreshable: true, credentialRef: 'BUDDY_ACCOUNT_D1' },
      ],
      updateAccount: async (id: string) => { updated.push(id) },
    }
    // 两个账号的凭据都写入，确保续期路径真的被走到。
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_E1'), JSON.stringify(makeCredential()))
    const auth = new BuddyAuth(ctx as never, { product: CODEBUDDY, fetcher: refreshFetcher() })
    services.push(auth)

    await auth.refreshAll(pool as never)

    expect(
      updated,
      '停用账号未被续期：refreshAll 不该按 enabled 过滤',
    ).toContain('disabled-1')
  })

  it('refreshAll 仍跳过不可续期账号（refreshable 为 false）', async () => {
    // 与上一条互补：去掉 enabled 过滤不等于不过滤 —— 真正不可续期的
    // （无 refresh_token）仍应跳过，否则每个周期都白跑一次网络请求。
    const ctx = createMockContext()
    const updated: string[] = []
    const pool = {
      listAccounts: async (provider: string) => [
        { id: 'no-refresh', provider, enabled: true, refreshable: false, credentialRef: 'BUDDY_ACCOUNT_N1' },
      ],
      updateAccount: async (id: string) => { updated.push(id) },
    }
    const auth = new BuddyAuth(ctx as never, { product: CODEBUDDY, fetcher: refreshFetcher() })
    services.push(auth)

    await auth.refreshAll(pool as never)

    expect(updated).toEqual([])
  })

  it('WorkBuddy 的 refresh 只续期自己的凭据', async () => {
    const ctx = createMockContext()
    // 只有 CodeBuddy 的凭据 → WorkBuddy 必须报「未配置」，且不得发出刷新请求。
    await ctx.credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), JSON.stringify(makeCredential()))
    const fetcher = refreshFetcher()
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY, fetcher })

    await expect(auth.refresh()).rejects.toThrow('未配置凭据，请先登录')
    expect(fetcher).not.toHaveBeenCalled()

    // 写入自己的凭据后可正常续期。
    await ctx.credentials.set(
      credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      JSON.stringify(makeCredential({ refresh_token: '' })),
    )
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('WorkBuddy 的 scheduleRefresh 只读取自己的凭据来武装续期', async () => {
    vi.useFakeTimers()
    try {
      const ctx = createMockContext()
      // 只有 CodeBuddy 的（已过期）凭据：若 WorkBuddy 误读，会武装调度并发出刷新请求。
      await ctx.credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), JSON.stringify(
        makeCredential({ expires_at: String(Date.now() - 60_000) }),
      ))
      const fetcher = refreshFetcher()
      const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY, fetcher })
      services.push(auth)
      const refreshSpy = vi.spyOn(auth, 'refresh')

      auth.scheduleRefresh()
      await vi.runAllTimersAsync()

      expect(refreshSpy).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Task 3 审查遗留：buddy-oauth 的 UA / X-Product-Code 参数化 ──
  // 这两条测试锁定「BuddyAuth 把 this.product 透传给 buddy-oauth」这一关键
  // 契约：漏传时 WorkBuddy 会以 CodeBuddy 的身份标识请求后端。

  it('WorkBuddy 的 refresh 发出的请求带 WorkBuddy 的 User-Agent', async () => {
    const ctx = createMockContext()
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCESS_TOKEN'), JSON.stringify(makeCredential()))
    const fetcher = refreshFetcher()
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY, fetcher })

    await auth.refresh()

    const init = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1]
    // 两个内置产品的 UA 字面量相同，故这里比对 product.userAgent 而非字面量，
    // 鉴别力由 buddy-oauth.spec.ts 的注入式用例提供。
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(WORKBUDDY.userAgent)
  })

  it('WorkBuddy 的 fetchModels 请求带 X-Product-Code: workbuddy', async () => {
    const ctx = createMockContext()
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCESS_TOKEN'), JSON.stringify(makeCredential()))
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // 企业模型端点返回空 → 触发回退，使两个端点都被请求到
      if (url.includes('/console/enterprises/personal/models')) {
        return new Response(JSON.stringify({ data: { agents: [], models: [] } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = new BuddyAuth(ctx as never, { product: WORKBUDDY, fetcher })

    expect((await auth.fetchModels()).map((m) => m.id)).toEqual(['glm-5.3'])

    const calls = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    // 企业模型端点优先，回退到 /v3/config；两次请求都必须带 workbuddy 身份。
    expect(calls[0]![0]).toContain('/console/enterprises/personal/models')
    expect(calls.at(-1)![0]).toContain('/v3/config')
    for (const [, init] of calls) {
      const headers = init.headers as Record<string, string>
      expect(headers['X-Product-Code']).toBe('workbuddy')
      expect(headers['User-Agent']).toBe(WORKBUDDY.userAgent)
    }
  })

  it('默认 CodeBuddy 实例的 fetchModels 仍带 codebuddy 产品码', async () => {
    const ctx = createMockContext()
    await ctx.credentials.set(credentialRef('BUDDY_ACCESS_TOKEN'), JSON.stringify(makeCredential()))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] },
    }), { status: 200 })) as unknown as typeof fetch
    const auth = new BuddyAuth(ctx as never, { fetcher })

    expect((await auth.fetchModels()).map((m) => m.id)).toEqual(['glm-5.3'])

    const init = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1]
    expect((init.headers as Record<string, string>)['X-Product-Code']).toBe('codebuddy')
  })
})
