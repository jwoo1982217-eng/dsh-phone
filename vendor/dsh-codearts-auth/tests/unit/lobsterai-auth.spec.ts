import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOBSTERAI_CREDENTIAL_REF,
  LobsteraiAuth,
  RefreshTokenExpiredError,
} from '../../src/lobsterai-auth.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: LobsteraiAuth[] = []

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
  /** 测试辅助：直接读回存储内容。 */
  raw(ref: string): string | undefined { return this.store.get(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

function newService(
  ctx: Context,
  options: { fetcher?: typeof fetch } = {},
): LobsteraiAuth {
  const service = new LobsteraiAuth(ctx, options)
  services.push(service)
  return service
}

/**
 * 构造一个可刷新的凭据（默认**距过期 50 分钟**）。
 *
 * ⚠️ 不能默认给「2 小时后过期」：`refreshAll` 现在带 lead-time 过滤
 * （`src/expiry-sync.ts` 的 `shouldRefreshNow`，与单凭据时代 `REFRESH_LEAD_MS`
 * 同语义 —— 距过期超过 1 小时的账号本轮只与账号池对账、**不发续期请求**）。
 * 本文件的用例问的是「该刷的账号有没有被刷」，所以凭据必须落在 lead 窗口内。
 * 个别专测「不会立即刷 / 有效期解析」的用例各自显式覆盖 `expires_at`。
 */
function makeCredential(overrides: Partial<LobsteraiCredential> = {}): LobsteraiCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_000_000),
    uid: 'uid-1',
    user_id: 'yid-1',
    nickname: '测试账号',
    uuid: 'uuid-1',
    first_keyfrom: '1700000000000',
    latest_keyfrom: '1700000000000',
    ...overrides,
  }
}

/** 版本号接口的成功响应（供内部 versionResolver 使用）。 */
function versionResponse(): Response {
  return new Response(JSON.stringify({
    data: { value: { version: '2026.9.4' } }, code: 0, msg: 'OK',
  }), { status: 200 })
}

/** 续期成功响应。 */
function refreshSuccess(): Response {
  return new Response(JSON.stringify({
    code: 0, msg: 'OK', data: { accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 },
  }), { status: 200 })
}

/**
 * 构造一个按 URL 分派的 fetch stub：版本号接口与续期接口分别应答。
 */
function stubFetcher(
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.includes('api-overmind.youdao.com')) return versionResponse()
    return handler(target)
  }) as unknown as typeof fetch
}

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('LobsteraiAuth 注册与基本信息', () => {
  it('注册为 ctx.lobsteraiAuth', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(ctx.lobsteraiAuth).toBeInstanceOf(LobsteraiAuth)
    expect(ctx.lobsteraiAuth.name).toBe('lobsteraiAuth')
  })

  it('凭据 ref 为 LOBSTERAI_ACCESS_TOKEN', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.credentialRefName).toBe('LOBSTERAI_ACCESS_TOKEN')
    expect(LOBSTERAI_CREDENTIAL_REF).toBe('LOBSTERAI_ACCESS_TOKEN')
  })

  it('绑定 LobsterAI 产品配置', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.product.id).toBe('lobsterai')
    expect(service.product).toBe(LOBSTERAI)
  })

  it('未配置凭据时 status 报告 configured: false', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.status()).toEqual({ configured: false, refreshable: false })
  })
})

describe('LobsteraiAuth 客户端版本号', () => {
  it('resolveClientVersion 走远端拉取', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    expect(await service.resolveClientVersion()).toBe('2026.9.4')
  })

  it('拉取失败时回退兜底版本（不让登录/签到因版本接口故障而失败）', async () => {
    const { ctx } = makeContext()
    const fetcher = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    expect(await service.resolveClientVersion()).toBe(LOBSTERAI.fallbackClientVersion)
  })
})

/**
 * `fetchModels` 的端到端回归。
 *
 * 这里锁死的是两个**叠加**的历史缺陷 —— 任一个单独存在都会让远端新模型
 * （`deepseek-flash` / `glm-5.3-flash` / `kimi-k3`）在面板里看不到：
 *
 * 1. **解析**：真实响应是 `{code:0, message:'success', data:[...]}`（`data` 直接
 *    是数组），早先复用要求 `data` 为对象的 `parseLobsteraiEnvelope`，恒判失败
 *    → 空数组 → 静默回退静态兜底表；
 * 2. **请求头**：不带 `X-LobsterAI-Client-Capabilities` 时服务端只返回 25 个
 *    模型（无 `kimi-k3`）。
 */
describe('LobsteraiAuth 远端模型列表', () => {
  it('解析单层 data 数组并带上 Capabilities 头（真实线上形态）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))

    let headers: Record<string, string> = {}
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('api-overmind')) return versionResponse()
      headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: [
          { modelId: 'deepseek-flash', modelName: 'DeepSeek-V4.1-Flash', provider: 'LobsterAI', apiFormat: 'openai' },
          { modelId: 'glm-5.3-flash', modelName: 'GLM-5.3-Flash', provider: 'LobsterAI', apiFormat: 'openai' },
          { modelId: 'kimi-k3', modelName: 'Kimi-K3', provider: 'LobsterAI', apiFormat: 'openai' },
        ],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const service = newService(ctx, { fetcher })
    const models = await service.fetchModels()

    expect(models.map((m) => m.id)).toEqual(['deepseek-flash', 'glm-5.3-flash', 'kimi-k3'])
    expect(models[0]!.name).toBe('DeepSeek-V4.1-Flash')
    // 头必须带能力声明，否则服务端不返回 kimi-k3。
    expect(headers['X-LobsterAI-Client-Capabilities']).toBe(LOBSTERAI.clientCapabilities)
    expect(headers['X-LobsterAI-Client-Version']).toBe('2026.9.4')
  })

  it('远端失败时返回空数组（调用方回退兜底目录，不抛错）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response('boom', { status: 500 })),
    })
    expect(await service.fetchModels()).toEqual([])
  })
})

describe('LobsteraiAuth 续期', () => {
  it('成功时写回新令牌，且 latest_keyfrom 保持不变（对齐 Go）', async () => {
    const { ctx, credentials } = makeContext()
    const credential = makeCredential()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(credential))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refresh()

    const stored = JSON.parse(credentials.raw(LOBSTERAI_CREDENTIAL_REF)!) as LobsteraiCredential
    expect(stored.access_token).toBe('AT2')
    expect(stored.refresh_token).toBe('RT2')
    // 身份字段必须保留 —— 丢了会让下一次续期失败。
    expect(stored.uuid).toBe('uuid-1')
    expect(stored.first_keyfrom).toBe('1700000000000')
    // latest_keyfrom **刻意不更新**：Go 的 RefreshToken 不碰该字段。
    expect(stored.latest_keyfrom).toBe(credential.latest_keyfrom)
  })

  it('请求体带 refreshToken 与全部身份字段，且**不带** Authorization', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    let body: Record<string, unknown> = {}
    let headers: Record<string, string> = {}
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('api-overmind')) return versionResponse()
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      headers = (init?.headers ?? {}) as Record<string, string>
      return refreshSuccess()
    }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    await service.refresh()

    expect(body.refreshToken).toBe('RT')
    expect(body.uuid).toBe('uuid-1')
    expect(body.userId).toBe('yid-1')
    expect(body.firstKeyfrom).toBe('1700000000000')
    expect(body.version).toBe('2026.9.4')
    // 续期端点不需要旧 token（Go 的 authHeaders 同样不设该头）。
    expect(headers).not.toHaveProperty('Authorization')
  })

  it('HTTP 401 抛 RefreshTokenExpiredError（终态）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ code: 401, msg: 'unauthorized' }), { status: 401 })),
    })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('会话死亡业务码 40101 抛 RefreshTokenExpiredError（即使 HTTP 200）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ code: 40101, msg: 'token rejected' }), { status: 200 })),
    })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('网络失败**不**判为终态（抛普通 Error，交给调度器重试）', async () => {
    // 这是相对 Go 版的关键改进：Go 只判「响应里有没有 accessToken」，
    // 会把网络抖动也当成终态而停止续期。
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).includes('api-overmind')) return versionResponse()
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toMatch(/网络失败/)
  })

  it('5xx 不判为终态（可重试）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response('boom', { status: 500 })),
    })
    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('code:0 但缺 accessToken 时判为终态（需重新登录）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ code: 0, data: { refreshToken: 'x' } }), { status: 200 })),
    })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('无 refresh_token 时直接抛终态错误', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential({ refresh_token: '' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('未配置凭据时抛错提示先登录', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    await expect(service.refresh()).rejects.toThrow(/未配置凭据/)
  })

  it('终态失败后 status().refreshable 变为 false 并带 refreshError', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ code: 40101 }), { status: 200 })),
    })
    await service.refresh().catch(() => {})
    const status = await service.status()
    expect(status.refreshable).toBe(false)
    expect(status.refreshError).toMatch(/refresh_token 已失效/)
  })

  it('登出竞态：在途刷新期间 logout 后不回写凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    let releaseRefresh!: () => void
    const gate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).includes('api-overmind')) return versionResponse()
      await gate
      return refreshSuccess()
    }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    const refreshing = service.refresh()
    await service.logout()
    releaseRefresh()
    await refreshing

    // 已登出：凭据不应被在途刷新复活。
    expect(credentials.raw(LOBSTERAI_CREDENTIAL_REF)).toBeUndefined()
  })
})

describe('LobsteraiAuth 批量续期', () => {
  /** 最小账号池桩：只需 listAccounts / updateAccount。 */
  function makePool(accounts: Array<Record<string, unknown>>) {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    return {
      updates,
      async listAccounts(provider: string) {
        return accounts.filter((a) => a.provider === provider) as never
      },
      async updateAccount(id: string, patch: Record<string, unknown>) {
        updates.push({ id, patch })
      },
    }
  }

  /**
   * ⚠️ 本用例的语义已修正（原断言「停用账号不续期」是**缺陷**，不是规格）。
   *
   * 停用只应影响账号池的**自动选号**，与「凭据是否需要保持新鲜」无关 ——
   * 停用账号同样会出现在 Jet Hub 里并参与积分领取。跳过它们的续期会让
   * refresh_token 一路放到失效，用户重新启用后只能重新登录
   * （真实缺陷：两个曾停用的 CodeBuddy 账号显示「凭证过期」，领取积分报
   * `Unexpected token '<'`，因为服务端对死凭据返回 HTML 错误页）。
   *
   * 因此现在的契约是：**只按 `refreshable` 过滤，不看 `enabled`**；
   * 而 **provider 必须匹配**（绝不串用其他 provider 的凭据）。
   */
  it('续期 provider 匹配且 refreshable 的账号（含已停用）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_A', JSON.stringify(makeCredential({ access_token: 'A' })))
    await credentials.set('LOBSTERAI_ACCOUNT_B', JSON.stringify(makeCredential({ access_token: 'B' })))
    await credentials.set('LOBSTERAI_ACCOUNT_C', JSON.stringify(makeCredential({ access_token: 'C' })))
    const pool = makePool([
      { id: 'a', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_A', enabled: true, refreshable: true },
      // 停用但可续期 → 必须同样续期（见上方说明）
      { id: 'b', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_B', enabled: false, refreshable: true },
      // 其他 provider：绝不串用
      { id: 'c', provider: 'buddy', credentialRef: 'LOBSTERAI_ACCOUNT_C', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAll(pool as never)

    const a = JSON.parse(credentials.raw('LOBSTERAI_ACCOUNT_A')!) as LobsteraiCredential
    expect(a.access_token).toBe('AT2')
    // 停用的 B **也**应被续期；异 provider 的 C 不得被改动。
    const b = JSON.parse(credentials.raw('LOBSTERAI_ACCOUNT_B')!) as LobsteraiCredential
    const c = JSON.parse(credentials.raw('LOBSTERAI_ACCOUNT_C')!) as LobsteraiCredential
    expect(b.access_token, '停用账号未被续期：refreshAll 不该按 enabled 过滤').toBe('AT2')
    expect(c.access_token).toBe('C')
  })

  it('单账号失败不中断其他账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_A', JSON.stringify(makeCredential({ access_token: 'A', uid: 'a' })))
    await credentials.set('LOBSTERAI_ACCOUNT_B', JSON.stringify(makeCredential({ access_token: 'B', uid: 'b' })))
    const pool = makePool([
      { id: 'a', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_A', enabled: true, refreshable: true },
      { id: 'b', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_B', enabled: true, refreshable: true },
    ])
    // 第一次续期失败、第二次成功。
    let call = 0
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).includes('api-overmind')) return versionResponse()
      call += 1
      if (call === 1) return new Response('boom', { status: 500 })
      return refreshSuccess()
    }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    await service.refreshAll(pool as never)

    const b = JSON.parse(credentials.raw('LOBSTERAI_ACCOUNT_B')!) as LobsteraiCredential
    expect(b.access_token).toBe('AT2')
  })

  it('续期成功后回写账号的 expiresAt 与 refreshable', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_A', JSON.stringify(makeCredential()))
    const pool = makePool([
      { id: 'a', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_A', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAll(pool as never)

    expect(pool.updates).toHaveLength(1)
    expect(pool.updates[0]!.patch.refreshable).toBe(true)
    expect(typeof pool.updates[0]!.patch.expiresAt).toBe('number')
  })

  it('凭据缺失时把 refreshable 置 false', async () => {
    const { ctx } = makeContext()
    const pool = makePool([
      { id: 'a', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_MISSING', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAll(pool as never)

    expect(pool.updates).toEqual([{ id: 'a', patch: { refreshable: false } }])
  })

  it('终态失败时把该账号 refreshable 置 false', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_A', JSON.stringify(makeCredential()))
    const pool = makePool([
      { id: 'a', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_A', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ code: 40101 }), { status: 200 })),
    })

    await service.refreshAll(pool as never)

    expect(pool.updates).toContainEqual({ id: 'a', patch: { refreshable: false } })
  })
})

describe('LobsteraiAuth 登录与凭据管理', () => {
  it('loginWithCode 存凭据并返回结果', async () => {
    const { ctx, credentials } = makeContext()
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).includes('api-overmind')) return versionResponse()
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accessToken: 'AT-NEW', refreshToken: 'RT-NEW', expiresIn: 3600,
          user: { id: 'uid-9', userId: 'acc-9', nickname: '新账号' },
        },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    const result = await service.loginWithCode('code-1', { uuid: 'uuid-9', firstKeyfrom: '1700000000000' })

    expect(result.refreshable).toBe(true)
    expect(result.loginUrl).toBe('')
    const stored = JSON.parse(credentials.raw(LOBSTERAI_CREDENTIAL_REF)!) as LobsteraiCredential
    expect(stored.access_token).toBe('AT-NEW')
    expect(stored.uid).toBe('uid-9')
    expect(stored.uuid).toBe('uuid-9')
  })

  it('status 报告 configured 与过期时间', async () => {
    const { ctx, credentials } = makeContext()
    const expiresAt = Date.now() + 7_200_000
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential({ expires_at: String(expiresAt) })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.expiresAt).toBe(expiresAt)
    expect(status.refreshable).toBe(true)
    expect(status.source).toBe('fake')
  })

  it('logout 清除凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.logout()

    expect(credentials.raw(LOBSTERAI_CREDENTIAL_REF)).toBeUndefined()
    expect((await service.status()).configured).toBe(false)
    // 凭据已清，再续期会以「未配置凭据」失败（可观察的登出效果）。
    await expect(service.refresh()).rejects.toThrow(/未配置凭据/)
  })

  it('logout 停止续期调度（在途刷新不再重新武装定时器）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    // scheduleRefresh 会武装调度器（凭据可刷新且有过期时间）。
    service.scheduleRefresh()
    await vi.waitFor(() => { expect((service as unknown as { scheduler: { timer?: unknown } }).scheduler.timer).toBeDefined() })

    await service.logout()

    expect((service as unknown as { scheduler: { timer?: unknown } }).scheduler.timer).toBeUndefined()
  })

  it('checkExpired 在未配置时返回 true', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    expect(await service.checkExpired()).toBe(true)
  })

  it('checkExpired 对已过期凭据返回 true', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential({ expires_at: String(Date.now() - 1000) })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    expect(await service.checkExpired()).toBe(true)
  })

  it('checkExpired 对有效凭据返回 false', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    expect(await service.checkExpired()).toBe(false)
  })

  it('resolveStoredCredential 解析已存凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    expect((await service.resolveStoredCredential())?.access_token).toBe('AT')
  })

  it('凭据 JSON 损坏时 status 不抛异常', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOBSTERAI_CREDENTIAL_REF, '{ 损坏的 json')
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(false)
  })
})

/**
 * 老账号展示名回填。
 *
 * 用户要求（2026-09-27）：「lobsterai 的用户名字显示的手机号尾号漏出 4 位，
 * 现在也改为只漏出 2 位」。
 *
 * ⚠️ 那个 `130****1100` 是**服务端下发的 `user.nickname` 原值**，不是本插件
 * 截取的 —— 故光改代码只影响新登录账号，老账号要在启动时主动回填。
 */
describe('LobsteraiAuth 老账号展示名回填', () => {
  /** 最小账号池桩。 */
  function makePool(accounts: Array<Record<string, unknown>>) {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    return {
      updates,
      async listAccounts(provider: string) {
        return accounts.filter((a) => a.provider === provider) as never
      },
      async updateAccount(id: string, patch: Record<string, unknown>) {
        updates.push({ id, patch })
      },
    }
  }

  function accountEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: 'lobsterai-1',
      provider: 'lobsterai',
      nickname: '130****1100',
      enabled: true,
      credentialRef: 'LOBSTERAI_ACCOUNT_AAAA1111',
      createdAt: 1,
      refreshable: true,
      ...overrides,
    }
  }

  it('把露 4 位的昵称改成只露末 2 位', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_AAAA1111', JSON.stringify(makeCredential({ nickname: '130****1100' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    const pool = makePool([accountEntry()])

    const repaired = await service.repairAccountNicknames(pool as never)

    expect(repaired).toEqual(['lobsterai-1'])
    expect(pool.updates).toEqual([{ id: 'lobsterai-1', patch: { nickname: '130******00' } }])
  })

  it('幂等：昵称已是末 2 位时不写账号池', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_AAAA1111', JSON.stringify(makeCredential({ nickname: '130******00' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    const pool = makePool([accountEntry({ nickname: '130******00' })])

    expect(await service.repairAccountNicknames(pool as never)).toEqual([])
    expect(pool.updates).toEqual([])
  })

  it('真实昵称不被改写（不误伤非手机号昵称）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_AAAA1111', JSON.stringify(makeCredential({ nickname: '我的龙虾号' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    const pool = makePool([accountEntry({ nickname: '我的龙虾号' })])

    expect(await service.repairAccountNicknames(pool as never)).toEqual([])
    expect(pool.updates).toEqual([])
  })

  it('纯本地：不发任何网络请求', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_AAAA1111', JSON.stringify(makeCredential({ nickname: '130****1100' })))
    const fetcher = vi.fn(async () => refreshSuccess()) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    const pool = makePool([accountEntry()])

    await service.repairAccountNicknames(pool as never)

    // 掩码只依赖凭据里的昵称，不需要任何远端调用。
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('凭据缺失的账号被跳过（不留幽灵昵称）', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    const pool = makePool([accountEntry({ credentialRef: 'LOBSTERAI_ACCOUNT_MISSING' })])

    expect(await service.repairAccountNicknames(pool as never)).toEqual([])
    expect(pool.updates).toEqual([])
  })

  it('只处理本 provider 的账号（不碰其它 provider）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOBSTERAI_ACCOUNT_AAAA1111', JSON.stringify(makeCredential({ nickname: '130****1100' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    const pool = makePool([
      accountEntry(),
      { ...accountEntry({ id: 'buddy-1' }), provider: 'buddy' },
    ])

    const repaired = await service.repairAccountNicknames(pool as never)

    expect(repaired).toEqual(['lobsterai-1'])
  })
})
