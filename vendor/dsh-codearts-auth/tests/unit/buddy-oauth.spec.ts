import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RefreshTokenExpiredError,
  decorateLoginUrl,
  fetchAuthState,
  fetchModels,
  getAccount,
  loopGetToken,
  refreshToken,
  runBuddyLoginFlow,
} from '../../src/buddy-oauth.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

const STATE = 'state-abc'
const AUTH_URL = 'https://www.codebuddy.cn/login/?platform=ide&state=state-abc'

/** 构造凭据（默认 2 小时后过期）。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** 把若干个 [matcher, response] 规则组装为 stub fetch。 */
function routeFetch(routes: Array<{ when: (url: string) => boolean; respond: () => Response }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const route of routes) {
      if (route.when(url)) return route.respond()
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('buddy fetchAuthState', () => {
  it('returns state and authUrl', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v2/plugin/auth/state'),
      respond: () => new Response(JSON.stringify({ code: 0, data: { state: STATE, authUrl: AUTH_URL } }), { status: 200 }),
    }])
    const result = await fetchAuthState(fetcher)
    expect(result).toEqual({ state: STATE, authUrl: AUTH_URL })
    // 必须带 platform=ide 查询参数与免鉴权头。
    const [url, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(url).toContain('platform=ide')
    expect((init.headers as Record<string, string>)['X-No-Authorization']).toBe('true')
  })

  it('throws when the response is missing state or authUrl', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    }])
    await expect(fetchAuthState(fetcher)).rejects.toThrow('state')
  })

  it('throws on a non-200 response', async () => {
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('boom', { status: 500 }) }])
    await expect(fetchAuthState(fetcher)).rejects.toThrow('auth/state HTTP 500')
  })
})

describe('buddy loopGetToken', () => {
  it('polls until the token is ready', async () => {
    let attempts = 0
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => {
        attempts++
        // 前两次返回 11217（token 未就绪），第三次成功。
        return attempts < 3
          ? new Response(JSON.stringify({ code: 11217, message: 'not ready' }), { status: 400 })
          : new Response(JSON.stringify({
            code: 0,
            data: { accessToken: 'AT', refreshToken: 'RT', expiresAt: '2026-08-30T00:00:00Z', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
          }), { status: 200 })
      },
    }])
    const token = await loopGetToken(STATE, { fetcher, pollIntervalMs: 0 })
    expect(token.accessToken).toBe('AT')
    expect(attempts).toBe(3)
  })

  it('aborts other errors immediately', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 99999, message: 'fatal' }), { status: 400 }),
    }])
    await expect(loopGetToken(STATE, { fetcher, pollIntervalMs: 0 })).rejects.toThrow('fatal')
  })

  it('times out when the token never becomes ready', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 11217 }), { status: 400 }),
    }])
    await expect(loopGetToken(STATE, { fetcher, pollIntervalMs: 0, timeoutMs: 5 })).rejects.toThrow('超时')
  })
})

describe('buddy getAccount', () => {
  it('polls until the account is ready', async () => {
    let attempts = 0
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => {
        attempts++
        return attempts < 2
          ? new Response(JSON.stringify({ code: 12151 }), { status: 400 })
          : new Response(JSON.stringify({ code: 0, data: { uid: 'u1', nickname: 'nick', enterpriseId: '', type: 'personal' } }), { status: 200 })
      },
    }])
    const account = await getAccount(STATE, {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }, { fetcher, pollIntervalMs: 0 })
    expect(account).toEqual({ uid: 'u1', nickname: 'nick', enterpriseId: '', accountType: 'personal' })
  })

  it('times out when the account never becomes ready', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 12151 }), { status: 400 }),
    }])
    const token = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }
    await expect(getAccount(STATE, token, { fetcher, pollIntervalMs: 0, timeoutMs: 5 })).rejects.toThrow('超时')
  })

  /**
   * 回归（同型第三处）：`token.domain` 为**空串**时 X-Domain 必须回退到产品域名。
   *
   * `token` 由 `parseTokenData` → `readStringField` 产出，该函数在字段缺失/类型
   * 不符时返回**空串**（不是 `undefined`），故裸用 `token.domain` 会让 X-Domain
   * 以空值发出 —— 与 `buddy-adapter.ts`（chat 头）和 `buddy.ts`
   * （`credentialRequestHeaders`）是同一形态。前两处已由 PR!19 修复，这里是
   * 同一条链路上剩下的第三处（登录轮询的 `login/account`）。
   *
   * ⚠️ 兜底值取 `product.apiDomain` 而非常量 `API_DOMAIN`：本请求的 URL 是
   * `${product.endpoint}${LOGIN_ACCOUNT_PATH}`，X-Domain 必须与产品端点一致。
   */
  it('token.domain 为空串时 X-Domain 回退到产品域名', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0, data: { uid: 'u1', nickname: 'n', enterpriseId: '', type: 'personal' },
      }), { status: 200 }),
    }])
    const token = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: '',
    }
    await getAccount(STATE, token, { fetcher, pollIntervalMs: 0, product: WORKBUDDY })
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['X-Domain']).toBe('www.workbuddy.ai')
  })

  /**
   * 锁死「**非空时不被产品覆盖**」这条既有语义。
   *
   * 这里是登录流程：`token.domain` 是服务端**本次刚下发**的权威值，不是跨产品
   * 迁移后过期的历史快照 —— 故它与 `buddy-adapter.ts` 那处「产品优先」方向
   * 不同。差异只在「兜底值取谁」，判据一致（空串必回退）。
   *
   * ⚠️ 若将来决定把本处也改成「产品优先」，必须**同时**改本条用例，并在改动
   * 说明里讲清为什么登录阶段的即时值不再权威 —— 否则这条用例会挡住无意的
   * 语义漂移（那正是 PR!19 要修的那类缺陷）。
   */
  it('token.domain 非空时仍以服务端下发值为准（不被产品覆盖）', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0, data: { uid: 'u1', nickname: 'n', enterpriseId: '', type: 'personal' },
      }), { status: 200 }),
    }])
    const token = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }
    await getAccount(STATE, token, { fetcher, pollIntervalMs: 0, product: WORKBUDDY })
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['X-Domain']).toBe('copilot.tencent.com')
  })
})

describe('buddy refreshToken', () => {
  it('submits X-Refresh-Token and returns the new token', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v2/plugin/auth/token/refresh'),
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: '2026-09-30T00:00:00Z', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
      }), { status: 200 }),
    }])
    const token = await refreshToken(makeCredential(), fetcher)
    expect(token.accessToken).toBe('AT2')
    expect(token.refreshToken).toBe('RT2')
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Refresh-Token']).toBe('RT')
  })

  it('throws RefreshTokenExpiredError on HTTP 401', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 401, message: 'refresh token expired' }), { status: 401 }),
    }])
    await expect(refreshToken(makeCredential(), fetcher)).rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws RefreshTokenExpiredError when the message says expired', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 5000, message: 'token expired' }), { status: 400 }),
    }])
    await expect(refreshToken(makeCredential(), fetcher)).rejects.toThrow('expired')
  })

  it('treats other failures as retryable (plain Error)', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 500, message: 'upstream down' }), { status: 502 }),
    }])
    const error = await refreshToken(makeCredential(), fetcher).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws RefreshTokenExpiredError when there is no refresh_token', async () => {
    const fetcher = routeFetch([])
    await expect(refreshToken(makeCredential({ refresh_token: '' }), fetcher)).rejects.toBeInstanceOf(RefreshTokenExpiredError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  // 回归（Task 3 审查遗留）：refresh 请求此前硬编码 CodeBuddy 的 UA。
  // 两个内置产品的 userAgent 字面量暂时相同，无法观测该行为，故注入自定义 UA。
  it('续期请求使用传入 product 的 User-Agent', async () => {
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: '' },
      }), { status: 200 }),
    }])
    await refreshToken(makeCredential(), fetcher, undefined, custom)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/7.7.7')
    expect(headers['X-Refresh-Token']).toBe('RT')
  })

  it('默认续期请求仍使用 CodeBuddy 的 User-Agent', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: '' },
      }), { status: 200 }),
    }])
    await refreshToken(makeCredential(), fetcher)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(CODEBUDDY.userAgent)
  })
})

describe('登录轮询的产品身份标识', () => {
  it('loopGetToken 使用传入 product 的 User-Agent', async () => {
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: '' },
      }), { status: 200 }),
    }])
    await loopGetToken(STATE, { fetcher, pollIntervalMs: 0, product: custom })
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
  })

  it('getAccount 使用传入 product 的 User-Agent', async () => {
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0, data: { uid: 'u1', nickname: 'n', enterpriseId: '', type: 'personal' },
      }), { status: 200 }),
    }])
    const token = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }
    await getAccount(STATE, token, { fetcher, pollIntervalMs: 0, product: custom })
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
  })

  it('runBuddyLoginFlow 把产品传给 token 与 account 两步轮询', async () => {
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: '' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    await runBuddyLoginFlow({ fetcher, pollIntervalMs: 0, product: custom, openBrowser: () => {} })
    const calls = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    const tokenCall = calls.find(([url]) => url.includes('/auth/token'))!
    const accountCall = calls.find(([url]) => url.includes('/login/account'))!
    expect((tokenCall[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
    expect((accountCall[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
  })
})

describe('buddy fetchModels', () => {
  it('parses the craft agent models from /v3/config', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v3/config'),
      respond: () => new Response(JSON.stringify({
        data: { agents: [{ name: 'craft', models: ['auto', 'hy4-preview', 'glm-5.3'] }] },
      }), { status: 200 }),
    }])
    expect(await fetchModels(makeCredential(), fetcher)).toEqual([
      // `agentReferenced: true` = 服务端声明该模型可在对话里选择
      // （供 reconcileWithFallback 保留「不在兜底表但可选」的变体）。
      { id: 'hy4-preview', name: 'Hy4 Preview', agentReferenced: true },
      { id: 'glm-5.3', name: 'GLM-5.3', agentReferenced: true },
    ])
  })

  it('returns an empty list without a token or on failure', async () => {
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('nope', { status: 500 }) }])
    expect(await fetchModels(makeCredential({ access_token: '' }), fetcher)).toEqual([])
    expect(await fetchModels(makeCredential(), fetcher)).toEqual([])
  })

  // 回归（Task 3 审查遗留）：默认仍发 codebuddy 身份，传 WorkBuddy 时必须
  // 换成 workbuddy —— 否则 WorkBuddy 会拿 CodeBuddy 的产品码请求 /v3/config。
  it('默认以 codebuddy 身份请求 /v3/config', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: [] }] } }), { status: 200 }),
    }])
    await fetchModels(makeCredential(), fetcher)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Product-Code']).toBe('codebuddy')
    expect(headers['User-Agent']).toBe('CodeBuddyIDE/1.106.1')
    // X-Product 是部署类型，两个产品共用 SaaS。
    expect(headers['X-Product']).toBe('SaaS')
  })

  it('传入 WorkBuddy 时请求带 X-Product-Code: workbuddy', async () => {
    const fetcher = routeFetch([
      {
        // 企业端点返回空 → 触发回退，从而两个端点都会被请求到
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({ data: { agents: [], models: [] } }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
    const calls = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    expect(calls[0]![0]).toContain('/console/enterprises/personal/models')
    expect(calls.at(-1)![0]).toContain('/v3/config')
    for (const [url, init] of calls) {
      const headers = init.headers as Record<string, string>
      expect(headers['X-Product-Code'], `URL=${url}`).toBe('workbuddy')
      expect(headers['User-Agent']).toBe(WORKBUDDY.userAgent)
      expect(headers['X-Product']).toBe('SaaS')
    }
  })

  it('优先使用企业模型端点并解析其 cli agent', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/console/enterprises/personal/models'),
      respond: () => new Response(JSON.stringify({
        data: {
          agents: [{ name: 'cli', models: ['gpt-5.6-sol', 'glm-5.2'] }],
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', maxInputTokens: 1000000 },
            { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1000000 },
          ],
        },
      }), { status: 200 }),
    }])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'glm-5.2'])
    // ⚠️ 企业端点命中后**仍会**请求 /v3/config —— 但**只为取促销表**。
    //
    // 原因（真实缺陷，用户报障「codebuddy 的倍率显示也是没折扣的，
    // GLM-5.2 是 0.5，现在好像显示 0.79」）：企业端点**不下发**
    // `modelPromotions`，而它被优先返回，于是促销永远不显示。
    // 故这里补一次 /v3/config 取促销并与 scoped 结果合并。
    const urls = (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0])
    expect(urls.some((u) => u.includes('/v3/config'))).toBe(true)
    // 模型列表**仍以企业端点为准**（不因补取促销而换成 /v3/config 的目录）
    expect(urls.filter((u) => u.includes('/console/enterprises/personal/models'))).toHaveLength(1)
  })

  it('合并两个端点的模型 id 集合（真实缺陷回归：hy4-preview-f 被丢弃）', async () => {
    // ⚠️ 真实缺陷（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）：
    // 两个端点下发的 **id 集合不同**，而「限时免费」促销只挂在
    // `/v3/config` 独有的那个 id 上：
    //   scoped    → hy4-preview
    //   /v3/config→ hy4-preview-f（促销 modelIds 只写它）
    // 早期只返回 scoped，于是该促销永远对不上。
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({
          data: {
            agents: [{ name: 'cli', models: ['hy4-preview', 'glm-5.2'] }],
            models: [
              { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29' },
              { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79' },
            ],
          },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({
          data: {
            agents: [{ name: 'craft', models: ['hy4-preview-f'] }],
            models: [{ id: 'hy4-preview-f', name: 'Hy4 preview', credits: 'x0.29' }],
            modelPromotions: [{
              enabled: true, priority: 200, modelIds: ['hy4-preview-f'],
              discount: { discountedCredits: '0x', factor: 0 },
              schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-09-11T00:00:00+08:00', validUntil: '2026-10-11T00:00:00+08:00' },
            }],
          },
        }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    const ids = models.map((m) => m.id)
    // scoped 的模型在前（更权威），/v3/config 独有的追加在后
    expect(ids).toEqual(['hy4-preview', 'glm-5.2', 'hy4-preview-f'])
    const f = models.find((m) => m.id === 'hy4-preview-f')
    expect(f?.discountedCreditsRate).toBe('免费')
    // 被 agent 引用 → 标记保留，供 reconcileWithFallback 不丢弃它
    expect(f?.agentReferenced).toBe(true)
  })

  it('两个端点都不存在的 id 不会被凭空造出', async () => {
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({
          data: { agents: [{ name: 'cli', models: ['glm-5.2'] }], models: [{ id: 'glm-5.2' }] },
        }), { status: 200 }),
      },
      { when: (url) => url.includes('/v3/config'), respond: () => new Response('{}', { status: 200 }) },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    expect(models.map((m) => m.id)).toEqual(['glm-5.2'])
  })

  it('企业端点命中时，促销表从 /v3/config 合并进来（真实缺陷回归）', async () => {
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({
          data: {
            agents: [{ name: 'cli', models: ['glm-5.2'] }],
            // ⚠️ 企业端点**没有** modelPromotions —— 促销只由 /v3/config 下发
            models: [{ id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79 credits' }],
          },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({
          data: {
            modelPromotions: [{
              enabled: true, priority: 100, modelIds: ['glm-5.2'],
              discount: { discountedCredits: '0.50x', factor: 0.5 },
              // ⚠️ 窗口必须**全天覆盖**（`00:00`–`23:59`），不要写真实的
              // `23:00–7:50` —— 那样用例就只在夜间通过，白天跑会假失败。
              // 本用例要验证的是「促销表从 /v3/config 合并进来」，
              // 而「窗口外不生效」另有专门用例覆盖，不该混在这里。
              schedule: { daily: [{ start: '00:00', end: '23:59' }], timezone: 'Asia/Shanghai' },
            }],
          },
        }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    const glm = models.find((m) => m.id === 'glm-5.2')
    expect(glm?.creditsRate).toBe('x0.79')
    // 窗口内 → 促销价应被合并（用户要看的 0.5）
    expect(glm?.discountedCreditsRate).toBe('x0.50')
  })

  it('/v3/config 促销请求失败时不影响模型列表', async () => {
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({
          data: { agents: [{ name: 'cli', models: ['glm-5.2'] }], models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response('<html>500</html>', { status: 500 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    // 促销是展示增强，取不到不该让整个列表失败
    expect(models.map((m) => m.id)).toEqual(['glm-5.2'])
    expect(models[0]?.discountedCreditsRate).toBeUndefined()
  })

  it('企业模型端点返回非 200 时回退到 /v3/config', async () => {
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response('<html>500</html>', { status: 500 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
  })

  it('企业模型端点返回空列表时回退到 /v3/config', async () => {
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({ data: { agents: [], models: [] } }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
  })

  it('两个端点都失败时返回空列表（交由调用方回退静态目录）', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response('boom', { status: 500 }),
    }])
    expect(await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)).toEqual([])
  })

  it('企业模型端点用不带尾斜杠的路径（带斜杠会 403）', async () => {
    const seen: string[] = []
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    // 记录实际请求 URL（routeFetch 的 respond 不接收参数，故从 mock.calls 取）
    const models = await fetchModels(makeCredential(), fetcher, undefined, WORKBUDDY)
    seen.push(...(fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0]))
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
    const scopedUrl = seen.find((u) => u.includes('/console/enterprises/personal/models'))
    expect(scopedUrl).toBeDefined()
    expect(scopedUrl!.endsWith('/models')).toBe(true)
  })
})

describe('buddy runBuddyLoginFlow', () => {
  it('runs state → browser → token → account and returns the serialized credential', async () => {
    const opened: string[] = []
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { state: STATE, authUrl: AUTH_URL } }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0,
          data: { accessToken: 'AT', refreshToken: 'RT', expiresAt: '2026-08-30T00:00:00Z', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u1', nickname: 'nick', enterpriseId: '', type: 'personal' } }), { status: 200 }),
      },
    ])

    const result = await runBuddyLoginFlow({
      fetcher,
      pollIntervalMs: 0,
      openBrowser: (url) => { opened.push(url) },
    })

    expect(opened).toEqual([AUTH_URL])
    expect(result.loginUrl).toBe(AUTH_URL)
    expect(result.refreshable).toBe(true)
    expect(result.expires).toBe(Date.parse('2026-08-30T00:00:00Z'))
    const credential = JSON.parse(result.access) as BuddyCredential
    expect(credential).toMatchObject({
      access_token: 'AT', refresh_token: 'RT', user_id: 'u1', nickname: 'nick', account_type: 'personal',
    })
  })

  it('propagates auth/state failures and never opens the browser', async () => {
    const opened: string[] = []
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('boom', { status: 500 }) }])
    await expect(runBuddyLoginFlow({
      fetcher,
      pollIntervalMs: 0,
      openBrowser: (url) => { opened.push(url) },
    })).rejects.toThrow('auth/state HTTP 500')
    expect(opened).toEqual([])
  })
})

describe('产品参数化', () => {
  it('fetchAuthState 默认使用 CodeBuddy 的 platform=ide', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/auth/state'),
      respond: () => new Response(JSON.stringify({
        code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=ide&state=S' },
      }), { status: 200 }),
    }])
    await fetchAuthState(fetcher)
    const [url] = (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]
    expect(url).toContain('platform=ide')
  })

  it('fetchAuthState 传入 WorkBuddy 配置时使用 platform=workbuddy', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/auth/state'),
      respond: () => new Response(JSON.stringify({
        code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
      }), { status: 200 }),
    }])
    await fetchAuthState(fetcher, undefined, WORKBUDDY)
    const [url] = (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]
    expect(url).toContain('platform=workbuddy')
  })

  it('runBuddyLoginFlow 在 CodeBuddy 下不追加 version/loginSessionId', async () => {
    let openedUrl = ''
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=ide&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    await runBuddyLoginFlow({
      fetcher, pollIntervalMs: 0, product: CODEBUDDY,
      openBrowser: (url) => { openedUrl = url },
    })
    expect(openedUrl).not.toContain('loginSessionId')
    expect(openedUrl).not.toContain('version=')
  })

  it('runBuddyLoginFlow 在 WorkBuddy 下追加 version 与 loginSessionId', async () => {
    let openedUrl = ''
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    await runBuddyLoginFlow({
      fetcher, pollIntervalMs: 0, product: WORKBUDDY,
      openBrowser: (url) => { openedUrl = url },
    })
    expect(openedUrl).toContain(`version=${WORKBUDDY.pluginVersion as string}`)
    expect(openedUrl).toMatch(/loginSessionId=[0-9a-f-]{36}/)
    // 服务端下发的 platform 与 state 必须保留
    expect(openedUrl).toContain('platform=workbuddy')
    expect(openedUrl).toContain('state=S')
  })

  it('WorkBuddy 的 loginSessionId 每次登录都不同', async () => {
    const mk = () => routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    const urls: string[] = []
    for (let i = 0; i < 2; i++) {
      await runBuddyLoginFlow({
        fetcher: mk(), pollIntervalMs: 0, product: WORKBUDDY,
        openBrowser: (url) => { urls.push(url) },
      })
    }
    const id1 = new URL(urls[0]).searchParams.get('loginSessionId')
    const id2 = new URL(urls[1]).searchParams.get('loginSessionId')
    expect(id1).not.toBe(id2)
  })
})

describe('decorateLoginUrl', () => {
  it('只追加参数，不重建 URL（保留服务端独有参数）', () => {
    // serverOnly 不在任何 product 配置里：只有「在服务端 authUrl 上追加」的实现
    // 才能保留它；若实现改为「按 product 配置重建 URL」，platform/state 会被
    // 硬编码值覆盖（或整体丢失），认证随即失败。
    const authUrl = 'https://copilot.tencent.com/login?platform=workbuddy&state=S&serverOnly=keep-me'
    const result = decorateLoginUrl(authUrl, WORKBUDDY)
    const url = new URL(result)
    expect(url.searchParams.get('serverOnly')).toBe('keep-me')
    expect(url.searchParams.get('platform')).toBe('workbuddy')
    expect(url.searchParams.get('state')).toBe('S')
    expect(url.searchParams.get('version')).toBe(WORKBUDDY.pluginVersion)
    expect(url.searchParams.get('loginSessionId')).toBeTruthy()
    // 路径与 origin 也必须原样保留
    expect(url.origin).toBe('https://copilot.tencent.com')
    expect(url.pathname).toBe('/login')
  })

  it('appendSessionParams 为 false 时原样返回同一个字符串', () => {
    const authUrl = 'https://copilot.tencent.com/login?platform=ide&state=S'
    expect(decorateLoginUrl(authUrl, CODEBUDDY)).toBe(authUrl)
  })

  it('URL 非法时原样返回', () => {
    expect(decorateLoginUrl('not a url', WORKBUDDY)).toBe('not a url')
    expect(decorateLoginUrl('', WORKBUDDY)).toBe('')
  })

  it('pluginVersion 缺失时不追加 version 参数', () => {
    const noVersion: BuddyProduct = { ...WORKBUDDY, pluginVersion: undefined }
    const url = new URL(decorateLoginUrl('https://copilot.tencent.com/login?state=S', noVersion))
    expect(url.searchParams.has('version')).toBe(false)
    expect(url.searchParams.has('loginSessionId')).toBe(true)
  })

  it('fetchAuthState 使用 product.userAgent 作为请求头', async () => {
    // 两个内置产品的 userAgent 字面量相同，无法观测该行为；注入自定义 UA 以锁定它。
    const custom: BuddyProduct = { ...CODEBUDDY, userAgent: 'CustomAgent/9.9.9' }
    const fetcher = routeFetch([{
      when: (url) => url.includes('/auth/state'),
      respond: () => new Response(JSON.stringify({
        code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?state=S' },
      }), { status: 200 }),
    }])
    await fetchAuthState(fetcher, undefined, custom)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('CustomAgent/9.9.9')
  })
})
