import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  MinimaxAuth,
  MinimaxRefreshTokenExpiredError,
  parseMinimaxCredential,
} from '../../src/minimax-auth.js'

const CRED = {
  access_token: 'a'.repeat(60),
  refresh_token: 'r'.repeat(60),
  token_type: 'Bearer',
  expires_at: String(Date.now() + 3_600_000),
  scope: 'agent.default',
}

/** 造一个 JSON `Response`。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 一次**成功**的续期响应（形状满足 `parseMinimaxTokenGrant` 的硬校验：
 * `token_type` 必须 Bearer、`expires_in` 必须正数、`scope` 必须含 `agent.default`）。
 */
function refreshOk(overrides: Record<string, unknown> = {}): Response {
  return json({
    access_token: 'n'.repeat(60),
    refresh_token: 'r2'.repeat(30),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'agent.default',
    ...overrides,
  })
}

/** 取凭据 ref 的键名（`credentialRef(name)` 返回 `{ name }` 形态）。 */
function keyOf(ref: unknown): string {
  if (typeof ref === 'string') return ref
  if (ref !== null && typeof ref === 'object' && 'name' in ref) {
    return String((ref as { name: unknown }).name)
  }
  return String(ref)
}

/**
 * 造一个**真实** `Context`。
 *
 * ⚠️ brief 里的 `new MinimaxAuth({} as never, ...)` 以及 refreshAll 段的**裸对象 ctx**
 * 在运行期**跑不起来**：cordis 的 `Service` 构造函数会执行
 * `ctx.reflect.provide(name, this, ...)`，裸对象没有 `reflect`，直接
 * `TypeError: Cannot read properties of undefined (reading 'provide')`。
 * 故这里与 `tests/unit/cline-auth.spec.ts` 同法：用真实 `Context` +
 * `ctx.provide('credentials', ...)`。**断言本身逐字未动。**
 */
function makeContext(
  credentials: {
    resolve?: (ref: unknown) => Promise<{ value: string } | undefined>
    set?: (ref: unknown, value: string) => Promise<void>
  } = {},
): Context {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async () => undefined,
    set: async () => {},
    ...credentials,
  } as never)
  return ctx
}

describe('parseMinimaxCredential', () => {
  it('解析合法凭据', () => {
    expect(parseMinimaxCredential(JSON.stringify(CRED))?.access_token).toBe(CRED.access_token)
  })

  it('⚠️ 缺 access_token 时返回 undefined（它是账号池的匹配依据）', () => {
    expect(parseMinimaxCredential(JSON.stringify({ ...CRED, access_token: undefined })))
      .toBeUndefined()
  })

  it('非法 JSON 返回 undefined 而不抛错', () => {
    expect(parseMinimaxCredential('{not json')).toBeUndefined()
  })
})

describe('fetchModels', () => {
  it('⚠️ 远端优先，且用 region/buildEnv 查询参数', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: '1.0',
      ttlSeconds: 300,
      providers: [{
        providerId: 'minimax',
        config: {
          models: {
            'MiniMax-M3.1-Flash-Preview': {
              name: 'M3.1-Flash-Preview',
              limit: { context: 512_000, output: 128_000 },
              context_window_options: [512_000, 1_000_000],
              modalities: { input: ['text', 'image'] },
              effort_options: ['default', 'max'],
              default_effort: 'default',
            },
          },
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    // 直接测纯函数路径：通过注入的 fetcher 观察 URL
    const models = await (auth as unknown as {
      fetchModelsWith: (c: unknown) => Promise<readonly unknown[]>
    }).fetchModelsWith(CRED)

    const url = String(fetcher.mock.calls[0]?.[0])
    expect(url).toContain('region=cn')
    expect(url).toContain('buildEnv=prod')
    expect(url).toContain('/mavis/api/v1/models')
    const first = models[0] as { id: string; contextWindow: number }
    expect(first.id).toBe('MiniMax-M3.1-Flash-Preview')
    expect(first.contextWindow).toBe(1_000_000)
  })

  it('⚠️ 远端失败时回退兜底表（不抛错、不空列表）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const models = await (auth as unknown as {
      fetchModelsWith: (c: unknown) => Promise<readonly { id: string }[]>
    }).fetchModelsWith(CRED)
    expect(models.map((m) => m.id)).toEqual([
      'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7',
    ])
  })

  it('⚠️ 远端响应缺 minimax provider 时回退兜底表', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: '1.0', ttlSeconds: 300, providers: [{ providerId: 'other', config: { models: {} } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const models = await (auth as unknown as {
      fetchModelsWith: (c: unknown) => Promise<readonly { id: string }[]>
    }).fetchModelsWith(CRED)
    expect(models).toHaveLength(4)
  })

  /**
   * ⚠ **接线契约**：适配器判「这次拿到目录了吗」靠的是「返回空数组」，故
   * 接线必须用 `fetchRemoteModelsOnly()`。若误用 `fetchModels()`（失败时回吐
   * 兜底表），判据永不命中 ⇒ 兜底表被当成远端结果永久缓存，用户登录 / 网络
   * 恢复后再也不会重拉。下面三条把两种语义钉死，防止以后有人「顺手统一」。
   */
  const only = (auth: MinimaxAuth, pool?: unknown): Promise<readonly { id: string }[]> =>
    (auth as unknown as {
      fetchRemoteModelsOnly: (p?: unknown) => Promise<readonly { id: string }[]>
    }).fetchRemoteModelsOnly(pool)

  it('★ fetchRemoteModelsOnly 在远端失败时返回空数组（不回吐兜底表）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
    }), { fetchImpl: fetcher as never })
    expect(await only(auth)).toEqual([])
  })

  it('★ fetchRemoteModelsOnly 在未登录时返回空数组（不发请求）', async () => {
    const fetcher = vi.fn()
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    expect(await only(auth)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('★ fetchRemoteModelsOnly 在远端成功时原样返回', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      providers: [{
        providerId: 'minimax',
        config: {
          models: {
            'MiniMax-M3': { name: 'MiniMax-M3', limit: { context: 512_000, output: 128_000 } },
          },
        },
      }],
    }))
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
    }), { fetchImpl: fetcher as never })
    expect((await only(auth)).map((m) => m.id)).toEqual(['MiniMax-M3'])
  })
})

describe('refreshAll', () => {
  it('⚠️ 只按 refreshable 过滤，不看 enabled', async () => {
    const updated: { id: string; patch: unknown }[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: false, expiresAt: 0 },
        { id: 'a2', credentialRef: 'MINIMAX_ACCOUNT_A2', refreshable: false, enabled: true, expiresAt: 0 },
      ],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    // ⚠️ brief 此处未注入 fetchImpl → 会走**真实网络**且必然抛错，
    // 续期失败后 `updateAccount` 不会被调用，断言恒为假（实测确认）。
    // 故注入一个返回合法令牌的桩 fetch —— 断言逐字未动。
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
      set: async () => {},
    }), { fetchImpl: (async () => refreshOk()) as never })
    await auth.refreshAll(pool as never)
    // a1 虽然 enabled:false 但 refreshable:true，必须被处理
    expect(updated.some((u) => u.id === 'a1')).toBe(true)
    // a2 refreshable:false，必须被跳过
    expect(updated.some((u) => u.id === 'a2')).toBe(false)
  })

  it('⚠️ 凭据仍在有效期内时只对账池值、不发续期请求（共享实现的行为）', async () => {
    // 凭据 1 小时后过期 → shouldRefreshNow 为 true；改成 3 小时后过期则不刷
    const fresh = { ...CRED, expires_at: String(Date.now() + 3 * 3_600_000) }
    const updated: { id: string; patch: unknown }[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: true, expiresAt: 1 },
      ],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(fresh) }),
      set: async () => {},
    }), { fetchImpl: (() => { throw new Error('不应发请求') }) as never })
    await auth.refreshAll(pool as never)
    // 池值 expiresAt=1 与凭据不一致 → 必须对账回写
    expect(updated.some((u) => u.id === 'a1')).toBe(true)
  })

  it('⚠️ 按账号条目自身的 credentialRef 读写凭据（写错 ref 会续错账号）', async () => {
    const read: string[] = []
    const written: string[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: true, expiresAt: 0 },
      ],
      updateAccount: async () => {},
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async (ref) => { read.push(keyOf(ref)); return { value: JSON.stringify(CRED) } },
      set: async (ref) => { written.push(keyOf(ref)) },
    }), { fetchImpl: (async () => refreshOk()) as never })
    await auth.refreshAll(pool as never)
    expect(read).toEqual(['MINIMAX_ACCOUNT_A1'])
    expect(written).toEqual(['MINIMAX_ACCOUNT_A1'])
  })
})

describe('refreshCredentialFor', () => {
  it('⚠️ 续期申请必须带上旧的 refresh_token（丢失会让账号在下次续期时报废）', async () => {
    const fetcher = vi.fn().mockResolvedValue(refreshOk())
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const next = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'old-refresh-token',
    })
    // 请求体里必须出现旧 refresh_token（服务端靠它轮换）
    const body = String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(body).toContain('refresh_token=old-refresh-token')
    expect(next.refresh_token).toBe('r2'.repeat(30))
  })

  it('⚠️ 响应缺 refresh_token 时要沿用旧值（不能续成无 refresh_token 的残疾凭据）', async () => {
    const fetcher = vi.fn().mockResolvedValue(refreshOk({ refresh_token: undefined }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const next = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'old-refresh-token',
    })
    expect(next.refresh_token).toBe('old-refresh-token')
  })

  it('⚠️ refresh_token 失效时抛 MinimaxRefreshTokenExpiredError（name 精确，供调度器判终态）', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({ error: 'invalid_grant' }, 400),
    )
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const error = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'dead',
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MinimaxRefreshTokenExpiredError)
    // ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'`（不是本类名）——
    // `src/refresh.ts:23` 的 `RefreshScheduler` 终态判据就是按这个字符串比较的。
    // 写成 `'MinimaxRefreshTokenExpiredError'` 会让该分支恒不命中，
    // 退化成靠 message 正则兜底，文案一改即无限重试。
    expect((error as Error).name).toBe('RefreshTokenExpiredError')
    // 与项目级判据同源：用 refresh.ts 的逻辑验证它**确实**被判为终态。
    expect((error as Error).name === 'RefreshTokenExpiredError').toBe(true)
  })

  it('⚠️ 新凭据的 expires_at 必须由响应 expires_in 自算（access_token 非 JWT，解不出来）', async () => {
    const before = Date.now()
    const fetcher = vi.fn().mockResolvedValue(refreshOk({ expires_in: 7200 }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const next = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'old-refresh-token',
    })
    const expiresAt = Number(next.expires_at)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7_200_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7_200_000 + 5_000)
  })
})

describe('refreshAccountCredential', () => {
  it('⚠️ 未给 accountId 时按 access_token 反查账号（传 ref 名会恒匹配失败且静默）', async () => {
    const fresh = { ...CRED, expires_at: String(Date.now() + 3 * 3_600_000) }
    const seen: Array<[string, string]> = []
    const pool = {
      updateAccount: async () => {},
      findAccountIdByCredential: async (provider: string, identity: string) => {
        seen.push([provider, identity])
        return 'a1'
      },
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(fresh) }),
      set: async () => {},
    }), { fetchImpl: (() => { throw new Error('不应发请求') }) as never })
    await auth.refreshAccountCredential('MINIMAX_ACCOUNT_A1', pool as never)
    expect(seen).toEqual([['minimax', fresh.access_token]])
  })

  it('⚠️ 不给账号池时退化为「直接续期 + 落盘到同一个 ref」', async () => {
    const written: Array<[string, string]> = []
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
      set: async (ref, value) => { written.push([keyOf(ref), value]) },
    }), { fetchImpl: (async () => refreshOk()) as never })
    await auth.refreshAccountCredential('MINIMAX_ACCOUNT_A1')
    expect(written).toHaveLength(1)
    expect(written[0]?.[0]).toBe('MINIMAX_ACCOUNT_A1')
    expect(JSON.parse(String(written[0]?.[1])).access_token).toBe('n'.repeat(60))
  })
})

describe('persistLogin / fetchModels', () => {
  it('⚠️ 默认凭据 ref 由产品配置派生，persistLogin 只写调用方给的 refName', async () => {
    const written: string[] = []
    const auth = new MinimaxAuth(makeContext({
      set: async (ref) => { written.push(keyOf(ref)) },
    }), {})
    expect(auth.credentialRefName).toBe('MINIMAX_ACCESS_TOKEN')
    const result = await auth.persistLogin({ ...CRED }, { refName: 'MINIMAX_ACCOUNT_X1', nickname: 'X1' })
    expect(written).toEqual(['MINIMAX_ACCOUNT_X1'])
    expect(result).toEqual({})
  })

  it('⚠️ fetchModels 从 getAvailableAccount 的 credential 字段取凭据（两层结构，不是 available.id）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      providers: [{ providerId: 'minimax', config: { models: { 'MiniMax-M3': { name: 'M3' } } } }],
    }))
    const pool = {
      getAvailableAccount: async () => ({
        entry: { id: 'acc-1', credentialRef: 'MINIMAX_ACCOUNT_1' },
        credential: { access_token: 'from-pool' },
      }),
    }
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const models = await auth.fetchModels(pool as never)
    expect(models.map((m) => m.id)).toEqual(['MiniMax-M3'])
    const headers = (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer from-pool')
  })
})

describe('startLogin', () => {
  it('⚠️ 立即返回含 user_code 的 loginUrl，后台轮询（不阻塞等授权完成）', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        device_code: 'd'.repeat(43),
        user_code: '98FJ-WYXZ',
        verification_uri: 'https://account.minimax.cn/oauth-authorize',
        verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=98FJ-WYXZ',
        expires_in: 300,
        interval: 3,
      }))
      .mockResolvedValueOnce(json({ status: 'denied' }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never, sleep: async () => {} })
    const flow = await auth.startLogin()
    expect(flow.loginUrl).toBe('https://account.minimax.cn/oauth-authorize?user_code=98FJ-WYXZ')
    await expect(flow.result).rejects.toThrow('用户取消了 MiniMax 授权')
    flow.close()
  })
})
