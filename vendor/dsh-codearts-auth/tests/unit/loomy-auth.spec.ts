import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOOMY_CREDENTIAL_REF,
  LoomyAuth,
  RefreshTokenExpiredError,
} from '../../src/loomy-auth.js'
import { LOOMY } from '../../src/loomy-product.js'
import { LOOMY_SESSION_TTL_SECONDS } from '../../src/loomy-oauth.js'
import { credentialExpiresAtMs, isLoomyRefreshable, type LoomyCredential } from '../../src/loomy.js'
import type { AccountPool } from '../../src/account-pool.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免定时器泄漏。 */
const services: LoomyAuth[] = []

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
  raw(ref: string): string | undefined { return this.store.get(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

function newService(ctx: Context, options: { fetcher?: typeof fetch } = {}): LoomyAuth {
  const service = new LoomyAuth(ctx, options)
  services.push(service)
  return service
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
})

/** 造一个成功信封响应。 */
function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: '000000', desc: '成功', trace_id: 't', data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}
/** 造一个业务错误信封（HTTP 仍是 200）。 */
function bizError(code: string, desc: string): Response {
  return new Response(JSON.stringify({ code, desc, trace_id: 't', data: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** 构造一个 Loomy 凭据（默认 14 天后过期）。 */
function makeCredential(overrides: Partial<LoomyCredential> = {}): LoomyCredential {
  return {
    access_token: 'S'.repeat(32),
    userid: '260924225226937524',
    phone: '13011112222',
    expires_at: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000),
    ...overrides,
  }
}

describe('凭据构造', () => {
  /**
   * ⚠️ 本用例的**语义边界**（容易被误读，故写清楚）：
   *
   * `buildCredential` 只在**登录完成的那一刻**被调用
   *（`persistWechatLogin` / `loginWithSmsCode`），
   * 所以它算出的 `expires_at` 就是「**登录时刻** + 14 天」——
   * 这个值当场写进凭据并**持久化**，之后读取时**不重算**
   *（`credentialExpiresAtMs` 只解析已存的值）。
   *
   * 因此本用例断言的是「**新造**凭据的 TTL 是 14 天」，
   * 与「凭据是什么时候登录的」无关 —— 旧凭据的 `expires_at` 是历史值，
   * 本来就该随真实时间流逝而减少（那不是缺陷，正是它能表达过期的原因）。
   */
  it('新建凭据的 expires_at = 构建时刻 + 14 天（登录时写入，之后不重算）', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    const now = Date.now()
    const credential = service.buildCredential('S'.repeat(32), 'u1', '13011112222')

    const expiresAt = credentialExpiresAtMs(credential)
    expect(expiresAt).toBeDefined()
    // 14 天 = 1_209_600_000 毫秒（允许少量执行耗时）
    const delta = expiresAt! - now
    expect(delta).toBeGreaterThan(LOOMY_SESSION_TTL_SECONDS * 1000 - 5_000)
    // ⚠️ 上界也要留余量：`buildCredential` 内部的 `Date.now()` 晚于本用例捕获的
    // `now`，故 delta 会**略大于** 14 天整。原先写 `toBeLessThanOrEqual(14天)`
    // 单跑时恰好通过（差值常为 0–1 ms），但**全量并发**下机器负载高，
    // 该差值可达数毫秒 → 偶发假失败（与具体 provider 改动无关的既有抖动）。
    expect(delta).toBeLessThanOrEqual(LOOMY_SESSION_TTL_SECONDS * 1000 + 5_000)
  })

  it('字段名是 access_token（AccountPool 的匹配依据）', () => {
    const { ctx } = makeContext()
    const credential = newService(ctx).buildCredential('X'.repeat(32), 'u', '13011112222')
    expect(credential.access_token).toBe('X'.repeat(32))
    expect(credential.userid).toBe('u')
    expect(credential.phone).toBe('13011112222')
  })

  it('nickname 为空时不写该字段（不产生空串昵称）', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.buildCredential('S', 'u', 'p')).not.toHaveProperty('nickname')
    expect(service.buildCredential('S', 'u', 'p', 'Loomy 2222').nickname).toBe('Loomy 2222')
  })

  /**
   * ⚠️ 这是本 provider 与其余 7 个最重要的差异：**不能续期**。
   */
  it('凭据恒为不可续期（Loomy 无 refresh 端点）', () => {
    const { ctx } = makeContext()
    const credential = newService(ctx).buildCredential('S'.repeat(32), 'u', '13011112222')
    expect(isLoomyRefreshable(credential)).toBe(false)
  })
})

describe('短信登录', () => {
  it('sendSmsCode 返回 msgid', async () => {
    const { ctx } = makeContext()
    const fetcher = vi.fn().mockResolvedValue(ok({ msgid: 'MSG-9' }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    expect(await service.sendSmsCode('13011112222')).toBe('MSG-9')
    const [url] = fetcher.mock.calls[0] as [string]
    expect(url).toBe('https://account.xfinfr.com/login/phone/sendMsgCode')
  })

  it('loginWithSmsCode 落盘凭据并返回 refreshable: false', async () => {
    const { ctx, credentials } = makeContext()
    const fetcher = vi.fn()
      // checkCode
      .mockResolvedValueOnce(ok({ session: 'S'.repeat(32), userid: 'u-1' }))
      // 登录后的 first-login（尽力而为）
      .mockResolvedValueOnce(ok({ alreadyProcessed: true, dailyQuota: 5000, dailyBalance: 5000 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    const result = await service.loginWithSmsCode('13011112222', '123456', 'MSG-9')

    expect(result.refreshable).toBe(false)
    expect(result.expires).toBeGreaterThan(Date.now())
    // 凭据已写入默认 ref
    const raw = credentials.raw(LOOMY_CREDENTIAL_REF)
    expect(raw).toBeDefined()
    const stored = JSON.parse(raw!) as LoomyCredential
    expect(stored.access_token).toBe('S'.repeat(32))
    expect(stored.userid).toBe('u-1')
  })

  it('登录后尽力调用 first-login 初始化每日额度', async () => {
    const { ctx } = makeContext()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ session: 'S'.repeat(32), userid: 'u-1' }))
      .mockResolvedValueOnce(ok({ alreadyProcessed: true }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.loginWithSmsCode('13011112222', '123456', 'MSG-9')

    const urls = fetcher.mock.calls.map((call) => String(call[0]))
    expect(urls.some((u) => u.includes('/points/first-login'))).toBe(true)
  })

  /**
   * ⚠️ 额度初始化失败**不能**影响登录 —— 登录本身已经成功，
   * 让它抛错会让用户以为登录失败而重试。
   */
  it('first-login 失败不影响登录成功', async () => {
    const { ctx, credentials } = makeContext()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ session: 'S'.repeat(32), userid: 'u-1' }))
      .mockRejectedValueOnce(new Error('network down'))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await expect(service.loginWithSmsCode('13011112222', '123456', 'MSG-9')).resolves.toBeDefined()
    expect(credentials.raw(LOOMY_CREDENTIAL_REF)).toBeDefined()
  })

  it('登录失败（验证码错）时抛错且不写凭据', async () => {
    const { ctx, credentials } = makeContext()
    const fetcher = vi.fn().mockResolvedValue(bizError('020002', '验证码错误，请重新输入'))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await expect(service.loginWithSmsCode('13011112222', '000000', 'MSG-9'))
      .rejects.toThrow(/验证码错误/)
    expect(credentials.raw(LOOMY_CREDENTIAL_REF)).toBeUndefined()
  })
})

describe('status', () => {
  it('无凭据时 configured: false', async () => {
    const { ctx } = makeContext()
    expect(await newService(ctx).status()).toEqual({ configured: false, refreshable: false })
  })

  it('有凭据时 configured: true 且 refreshable 恒 false', async () => {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx)
    await credentials.set(LOOMY_CREDENTIAL_REF, JSON.stringify(makeCredential()))

    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(false)
    expect(status.expiresAt).toBeGreaterThan(Date.now())
  })
})

/**
 * ⚠️ 本 provider 的核心语义差异：`refresh()` 是**有效性探测**而非续期。
 */
describe('refresh（探测而非续期）', () => {
  it('凭据有效时探测通过，凭据不被改写', async () => {
    const { ctx, credentials } = makeContext()
    const original = JSON.stringify(makeCredential())
    await credentials.set(LOOMY_CREDENTIAL_REF, original)

    const fetcher = vi.fn().mockResolvedValue(ok({ balance: 100, dailyBalance: 50 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refresh()

    // 探测是只读的：凭据逐字节不变
    expect(credentials.raw(LOOMY_CREDENTIAL_REF)).toBe(original)
    const [url] = fetcher.mock.calls[0] as [string]
    expect(url).toContain('/points/records')
  })

  it('收到 100002 时抛 RefreshTokenExpiredError（提示重新登录）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOOMY_CREDENTIAL_REF, JSON.stringify(makeCredential()))

    // ⚠️ 必须每次返回**新的** Response：body 只能被读一次，
    // 复用同一个对象会让第二次 response.json() 抛错（测试自身的坑）。
    const fetcher = vi.fn().mockImplementation(
      async () => bizError('100002', '登录已失效，请重新登录'),
    )
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
    await expect(service.refresh()).rejects.toThrow(/重新登录/)
  })

  it('无凭据时抛 RefreshTokenExpiredError', async () => {
    const { ctx } = makeContext()
    await expect(newService(ctx).refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  /**
   * ⚠️ 网络抖动**不能**判为终态：否则一次网络故障会让用户被迫重新登录。
   */
  it('网络失败抛普通 Error（不是终态错误）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(LOOMY_CREDENTIAL_REF, JSON.stringify(makeCredential()))

    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    const error = await service.refresh().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('RefreshTokenExpiredError 的 name 恰为 RefreshTokenExpiredError（refresh.ts 的结构化判据）', () => {
    expect(new RefreshTokenExpiredError('x').name).toBe('RefreshTokenExpiredError')
  })
})

describe('refreshAccountCredential（按 ref 探测）', () => {
  it('探测指定 ref 的凭据（不是默认 ref）', async () => {
    const { ctx, credentials } = makeContext()
    const refName = 'LOOMY_ACCOUNT_AAAA1111'
    await credentials.set(refName, JSON.stringify(makeCredential({ access_token: 'A'.repeat(32) })))

    const fetcher = vi.fn().mockResolvedValue(ok({ balance: 1 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAccountCredential(refName)

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit]
    // 用的是该 ref 里的 token，不是默认 ref 的
    expect((init.headers as Record<string, string>).token).toBe('A'.repeat(32))
  })

  it('凭据未配置时抛错', async () => {
    const { ctx } = makeContext()
    await expect(newService(ctx).refreshAccountCredential('LOOMY_ACCOUNT_NOPE'))
      .rejects.toThrow(/未配置/)
  })

  it('凭据解析失败时抛错', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOOMY_ACCOUNT_BAD', 'not json')
    await expect(newService(ctx).refreshAccountCredential('LOOMY_ACCOUNT_BAD'))
      .rejects.toThrow(/解析失败/)
  })
})

describe('refreshAll（只探测已过期账号）', () => {
  /** 最小账号池替身。 */
  function makePool(accounts: { id: string; credentialRef: string }[]): AccountPool {
    return { listAccounts: async () => accounts } as unknown as AccountPool
  }

  it('未过期的账号不发任何请求（Loomy 不可续期，探测它们纯属浪费）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('LOOMY_ACCOUNT_FRESH', JSON.stringify(makeCredential()))
    const fetcher = vi.fn().mockResolvedValue(ok({}))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(makePool([{ id: 'a1', credentialRef: 'LOOMY_ACCOUNT_FRESH' }]))

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('已过期的账号会被探测', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(
      'LOOMY_ACCOUNT_STALE',
      JSON.stringify(makeCredential({ expires_at: String(Date.now() - 1000) })),
    )
    const fetcher = vi.fn().mockResolvedValue(ok({ balance: 1 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(makePool([{ id: 'a1', credentialRef: 'LOOMY_ACCOUNT_STALE' }]))

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('单账号失败不影响其它账号（且不抛）', async () => {
    const { ctx, credentials } = makeContext()
    const stale = JSON.stringify(makeCredential({ expires_at: String(Date.now() - 1000) }))
    await credentials.set('LOOMY_ACCOUNT_1', stale)
    await credentials.set('LOOMY_ACCOUNT_2', stale)
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok({ balance: 1 }))
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await expect(service.refreshAll(makePool([
      { id: 'a1', credentialRef: 'LOOMY_ACCOUNT_1' },
      { id: 'a2', credentialRef: 'LOOMY_ACCOUNT_2' },
    ]))).resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('凭据缺失的账号被跳过（不抛）', async () => {
    const { ctx } = makeContext()
    const fetcher = vi.fn()
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await expect(service.refreshAll(makePool([{ id: 'a1', credentialRef: 'LOOMY_ACCOUNT_MISSING' }])))
      .resolves.toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('logout / 生命周期', () => {
  it('logout 清除默认凭据', async () => {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx)
    await credentials.set(LOOMY_CREDENTIAL_REF, JSON.stringify(makeCredential()))

    await service.logout()

    expect(credentials.raw(LOOMY_CREDENTIAL_REF)).toBeUndefined()
    expect((await service.status()).configured).toBe(false)
  })

  /**
   * ⚠️ `scheduleRefresh()` / `stop()` 是**有意为之的空实现** ——
   * Loomy 无续期端点，武装调度器只会得到一串无意义的探测。
   * 但契约要求它们存在（`index.ts` 对全部 provider 统一调用）。
   */
  it('scheduleRefresh 与 stop 可安全调用（空实现，不抛）', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(() => service.scheduleRefresh()).not.toThrow()
    expect(() => service.stop()).not.toThrow()
  })
})

describe('业务能力转发', () => {
  it('fetchCreditBalance / claimDailyQuota / fetchOnboardingTasks 可用', async () => {
    const { ctx } = makeContext()
    // ⚠️ 每次返回**新的** Response：body 只能被读一次。
    const responses = [
      () => ok({ balance: 15000, dailyBalance: 4992, availableBalance: 19992 }),
      () => ok({ alreadyProcessed: true, dailyQuota: 5000, dailyBalance: 4992 }),
      () => ok({ tasks: { first_message: true }, earned: 500, total: 10000 }),
    ]
    let call = 0
    const fetcher = vi.fn().mockImplementation(async () => responses[call++]!())
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const credential = makeCredential()

    const balance = await service.fetchCreditBalance(credential)
    expect(balance?.total).toBe(19992)

    const claim = await service.claimDailyQuota(credential)
    expect(claim.kind).toBe('already-claimed')

    const tasks = await service.fetchOnboardingTasks(credential)
    expect(tasks.earned).toBe(500)
  })

  /**
   * `claimOnboardingTasks` 会先 GET 列表、再对**每个未完成**的任务 POST。
   * 故 mock 必须按「列表里有几个 false」准备足够多次响应。
   */
  it('claimOnboardingTasks 对未完成任务逐个 POST（幂等重放也算成功）', async () => {
    const { ctx } = makeContext()
    const allFalse = {
      first_message: false, pick_skill: false, generate_ppt: false, set_schedule: false,
      install_skill: false, configure_remote: false, create_soul: false, share_soul: false,
    }
    let call = 0
    const fetcher = vi.fn().mockImplementation(async () => {
      call += 1
      // 第 1 次是 GET 列表，其余是 complete
      return call === 1
        ? ok({ tasks: allFalse, earned: 0, total: 10000 })
        : ok({ alreadyCompleted: true, balance: 0 })
    })
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    const result = await service.claimOnboardingTasks(makeCredential())

    expect(result.claimed).toHaveLength(8)
    expect(result.earned).toBe(10000)
    expect(call).toBe(9) // 1 次 GET + 8 次 POST
  })
})

describe('产品配置', () => {
  it('默认凭据 ref 与其它 provider 隔离', () => {
    expect(LOOMY.defaultCredentialRef).toBe('LOOMY_ACCESS_TOKEN')
    expect(LOOMY_CREDENTIAL_REF).toBe('LOOMY_ACCESS_TOKEN')
  })

  it('服务名由产品 id 派生（loomyAuth）', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.name).toBe('loomyAuth')
  })
})
