/**
 * ZCode 插件内登录（`zcode-login.ts`）的单元测试。
 *
 * ## 守的是什么
 *
 * 登录是**唯一让 provider 脱离官方客户端**的路径，且它的失败形态很隐蔽：
 *
 * - 协议字段名写错 → 前端拿到 `undefined` 的 loginUrl → 「添加账号」报
 *   「后端未返回登录地址」，而**后端其实成功了**；
 * - 把 5xx/网络抖动当终态失败 → 用户授权成功却被判失败（官方把它当重试）；
 * - 把 4xx 当重试 → 用户被拒后一直轮询到超时（官方把它当终态）；
 * - `device_mid` 用错来源 → 又变回「依赖 IDE」。
 *
 * 故这里的用例都以「实测观测到的协议细节」为准绳。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ZCODE_OAUTH_CLI_INIT_URL,
  ZcodeLoginError,
  generateDeviceMid,
  generateFlowSecret,
  pollZcodeLogin,
  runZcodeLogin,
  startZcodeLogin,
  zcodeOauthCliPollUrl,
} from '../../src/zcode-login.js'

/** 造一个 init 响应（字段名逐字来自实测响应）。 */
function initResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: '',
    data: {
      flow_id: 'ed3c813afe034d1e59d39ab17ca8faaa',
      poll_token: 'deadbeef'.repeat(8),
      authorize_url: 'https://bigmodel.cn/login?appId=zcode&redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel&state=abc',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      poll_interval_sec: 2,
      ...overrides,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('ZCode 登录：协议常量', () => {
  it('init 端点与实测一致', () => {
    expect(ZCODE_OAUTH_CLI_INIT_URL).toBe('https://zcode.z.ai/api/v1/oauth/cli/init')
  })

  it('poll URL 会正确编码 flow_id', () => {
    expect(zcodeOauthCliPollUrl('abc-123')).toBe('https://zcode.z.ai/api/v1/oauth/cli/poll/abc-123')
    expect(zcodeOauthCliPollUrl('a/b')).toContain('a%2Fb')
  })
})

describe('ZCode 登录：身份生成', () => {
  it('flowSecret 是 64 字符 hex（官方 UH(32).toString("hex")）', () => {
    const s = generateFlowSecret()
    expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(generateFlowSecret()).not.toBe(s)
  })

  it('★ device_mid 是合法 UUID，且每次不同', () => {
    const a = generateDeviceMid()
    const b = generateDeviceMid()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })
})

describe('ZCode 登录：① 发起', () => {
  it('解析出 flowId / authorizeUrl / 轮询间隔', async () => {
    const fetchImpl = vi.fn(async () => initResponse()) as unknown as typeof fetch
    const flow = await startZcodeLogin(fetchImpl)
    expect(flow.flowId).toBe('ed3c813afe034d1e59d39ab17ca8faaa')
    expect(flow.authorizeUrl).toContain('https://bigmodel.cn/login')
    expect(flow.pollIntervalSec).toBe(2)
    expect(flow.flowSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('★ 用**自己生成的** flowSecret 作 Bearer（不是用户凭据）', async () => {
    let seenAuth: string | undefined
    let seenBody: unknown
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      seenAuth = headers?.Authorization
      seenBody = JSON.parse(String(init?.body))
      return initResponse()
    }) as unknown as typeof fetch
    const flow = await startZcodeLogin(fetchImpl)
    expect(seenAuth).toBe(`Bearer ${flow.flowSecret}`)
    expect(seenBody).toEqual({ provider: 'bigmodel' })
  })

  it('★ 缺 flow_id 时抛可读错误（而不是让前端拿到 undefined）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { authorize_url: 'https://x/' },
    }), { status: 200 })) as unknown as typeof fetch
    await expect(startZcodeLogin(fetchImpl)).rejects.toThrow(/flow_id/)
  })

  it('authorize_url 必须是 https（否则可能是钓鱼/被篡改）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { flow_id: 'x', authorize_url: 'http://evil/' },
    }), { status: 200 })) as unknown as typeof fetch
    await expect(startZcodeLogin(fetchImpl)).rejects.toThrow(/authorize_url/)
  })

  it('HTTP 非 2xx 抛 init 失败', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    await expect(startZcodeLogin(fetchImpl)).rejects.toMatchObject({ kind: 'init' })
  })

  it('网络异常抛 init 失败且带原因', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(startZcodeLogin(fetchImpl)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('poll_interval_sec 非法时回落到 2 秒', async () => {
    const fetchImpl = vi.fn(async () => initResponse({ poll_interval_sec: 0 })) as unknown as typeof fetch
    expect((await startZcodeLogin(fetchImpl)).pollIntervalSec).toBe(2)
  })
})

describe('ZCode 登录：③ 轮询', () => {
  const flow = { flowId: 'f1', flowSecret: generateFlowSecret() }

  it('status=pending → pending', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { status: 'pending' },
    }), { status: 200 })) as unknown as typeof fetch
    expect(await pollZcodeLogin(flow, fetchImpl)).toEqual({ kind: 'pending' })
  })

  it('★ status=ready → 解析出三个必需字段', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        status: 'ready',
        token: 'jwt-token-value',
        user: { user_id: '45441770981804656', name: '测试用户' },
        bigmodel: { access_token: 'bm-access', refresh_token: 'bm-refresh' },
      },
    }), { status: 200 })) as unknown as typeof fetch
    const outcome = await pollZcodeLogin(flow, fetchImpl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      expect(outcome.result.zcodeJwt).toBe('jwt-token-value')
      expect(outcome.result.bigmodelAccessToken).toBe('bm-access')
      expect(outcome.result.bigmodelRefreshToken).toBe('bm-refresh')
      expect(outcome.result.userId).toBe('45441770981804656')
      expect(outcome.result.displayName).toBe('测试用户')
    }
  })

  it('★ 缺任一必需字段 → failed（而不是把半截凭据当成功）', async () => {
    for (const broken of [
      { status: 'ready', user: { user_id: 'u' }, bigmodel: { access_token: 'a' } },      // 缺 token
      { status: 'ready', token: 't', user: { user_id: 'u' } },                          // 缺 access_token
      { status: 'ready', token: 't', bigmodel: { access_token: 'a' } },                 // 缺 user_id
    ]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: broken }), { status: 200 })) as unknown as typeof fetch
      const outcome = await pollZcodeLogin(flow, fetchImpl)
      expect(outcome.kind, JSON.stringify(broken)).toBe('failed')
    }
  })

  it('status=failed（用户拒绝）→ failed', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { status: 'failed' },
    }), { status: 200 })) as unknown as typeof fetch
    const outcome = await pollZcodeLogin(flow, fetchImpl)
    expect(outcome.kind).toBe('failed')
  })

  /**
   * `zai`（chat.z.ai 国际版）登录的 ready 响应把第三方 token 放在 `data.zai`
   * 而不是 `data.bigmodel`。
   *
   * 权威依据是官方 bundle 的 ready 解析器（`zcode.cjs` 的 `W7s`），它只读
   * `data.zai.access_token` 并把 `zai` 作为**通用**第三方凭据分支。
   *
   * 历史缺陷：解析器把 `bigmodel.access_token` 写成**必需**，于是 `zai` 登录
   * 在「缺关键字段」处失败 —— 用户拿到授权却存不进凭据。
   */
  it('★ status=ready 且只有 data.zai → 解析成功（zai 登录）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        status: 'ready',
        token: 'zai-jwt-token',
        user: { user_id: '88321783240281243', name: 'zai 用户' },
        zai: { access_token: 'zai-access', refresh_token: 'zai-refresh' },
      },
    }), { status: 200 })) as unknown as typeof fetch
    const outcome = await pollZcodeLogin(flow, fetchImpl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      expect(outcome.result.zcodeJwt).toBe('zai-jwt-token')
      expect(outcome.result.zaiAccessToken).toBe('zai-access')
      // bigmodel 侧必须留空，不能把 zai 的 token 张冠李戴
      expect(outcome.result.bigmodelAccessToken).toBeUndefined()
      expect(outcome.result.bigmodelRefreshToken).toBe('zai-refresh')
      expect(outcome.result.userId).toBe('88321783240281243')
    }
  })

  it('★ data.zai 与 data.bigmodel 同时存在 → 两者各自解析（不互相覆盖）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        status: 'ready',
        token: 'jwt',
        user: { user_id: 'u1' },
        zai: { access_token: 'zai-tok' },
        bigmodel: { access_token: 'bm-tok' },
      },
    }), { status: 200 })) as unknown as typeof fetch
    const outcome = await pollZcodeLogin(flow, fetchImpl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      expect(outcome.result.zaiAccessToken).toBe('zai-tok')
      expect(outcome.result.bigmodelAccessToken).toBe('bm-tok')
    }
  })

  it('★ 两个第三方块都缺 → failed（不能拿半截凭据当成功）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { status: 'ready', token: 't', user: { user_id: 'u' } },
    }), { status: 200 })) as unknown as typeof fetch
    const outcome = await pollZcodeLogin(flow, fetchImpl)
    expect(outcome.kind).toBe('failed')
  })

  it('★ startZcodeLogin 透传 provider=zai（授权页走 chat.z.ai）', async () => {
    let seenBody: unknown
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        code: 0,
        data: {
          flow_id: 'flow-zai',
          authorize_url: 'https://chat.z.ai/api/oauth/authorize?client_id=x',
          expires_at: Math.floor(Date.now() / 1000) + 600,
          poll_interval_sec: 2,
        },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const flowZai = await startZcodeLogin(fetchImpl, { provider: 'zai' })
    expect(seenBody).toEqual({ provider: 'zai' })
    expect(flowZai.authorizeUrl).toContain('chat.z.ai')
  })

  it('★ startZcodeLogin 缺省 provider 仍为 bigmodel（既有行为不变）', async () => {
    let seenBody: unknown
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        code: 0,
        data: {
          flow_id: 'flow-bm',
          authorize_url: 'https://bigmodel.cn/login?appId=zcode',
          expires_at: Math.floor(Date.now() / 1000) + 600,
          poll_interval_sec: 2,
        },
      }), { status: 200 })
    }) as unknown as typeof fetch
    await startZcodeLogin(fetchImpl)
    expect(seenBody).toEqual({ provider: 'bigmodel' })
  })

  it('★ 网络抖动 → pending（**不算失败**，否则会误报授权失败）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    expect((await pollZcodeLogin(flow, fetchImpl)).kind).toBe('pending')
  })

  it('★ 5xx → pending（服务端暂时故障，应继续等）', async () => {
    const fetchImpl = vi.fn(async () => new Response('oops', { status: 502 })) as unknown as typeof fetch
    expect((await pollZcodeLogin(flow, fetchImpl)).kind).toBe('pending')
  })

  it('★ 408 / 429 → pending（超时与限流都该重试）', async () => {
    for (const status of [408, 429]) {
      const fetchImpl = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch
      expect((await pollZcodeLogin(flow, fetchImpl)).kind, String(status)).toBe('pending')
    }
  })

  it('★ 4xx（非 408/429）→ failed（终态，别再轮询到超时）', async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      const fetchImpl = vi.fn(async () => new Response('denied', { status })) as unknown as typeof fetch
      const outcome = await pollZcodeLogin(flow, fetchImpl)
      expect(outcome.kind, String(status)).toBe('failed')
    }
  })

  it('响应不是 JSON → pending（不抛错）', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    expect((await pollZcodeLogin(flow, fetchImpl)).kind).toBe('pending')
  })

  it('code !== 0 → pending', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 1, data: { status: 'ready', token: 't' } }), { status: 200 })) as unknown as typeof fetch
    expect((await pollZcodeLogin(flow, fetchImpl)).kind).toBe('pending')
  })

  it('status 不认识的值 → failed（不静默当成 ready）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { status: 'weird' },
    }), { status: 200 })) as unknown as typeof fetch
    expect((await pollZcodeLogin(flow, fetchImpl)).kind).toBe('failed')
  })
})

describe('ZCode 登录：端到端编排', () => {
  it('★ onAuthorizeUrl 在**首次轮询之前**就被调用（前端要立刻弹窗）', async () => {
    const order: string[] = []
    let polls = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/oauth/cli/init')) { order.push('init'); return initResponse() }
      polls += 1
      order.push(`poll${polls}`)
      if (polls < 2) return new Response(JSON.stringify({ code: 0, data: { status: 'pending' } }), { status: 200 })
      return new Response(JSON.stringify({
        code: 0, data: { status: 'ready', token: 't', user: { user_id: 'u', name: 'n' }, bigmodel: { access_token: 'a' } },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await runZcodeLogin({
      fetchImpl,
      pollIntervalMs: 5,
      onAuthorizeUrl: (url) => order.push('url:' + (url.includes('bigmodel.cn') ? 'ok' : 'bad')),
    })
    expect(result.zcodeJwt).toBe('t')
    expect(order[0]).toBe('init')
    expect(order[1]).toMatch(/^url:ok$/)
    expect(order[2]).toMatch(/^poll/)
  })

  it('信号已中止 → 抛 cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(async () => initResponse()) as unknown as typeof fetch
    await expect(runZcodeLogin({
      fetchImpl, signal: controller.signal, pollIntervalMs: 5,
    })).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('轮询返回 failed → 抛 denied（带服务端原因）', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/oauth/cli/init')) return initResponse()
      return new Response(JSON.stringify({ code: 0, data: { status: 'failed' } }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(runZcodeLogin({ fetchImpl, pollIntervalMs: 5 }))
      .rejects.toMatchObject({ kind: 'denied' })
  })

  it('超时 → 抛 timeout，且文案提示重新发起', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/oauth/cli/init')) {
        // 让 expires_at 很近，从而让 runZcodeLogin 很快超时
        return initResponse({ expires_at: Math.floor(Date.now() / 1000) + 1 })
      }
      return new Response(JSON.stringify({ code: 0, data: { status: 'pending' } }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(runZcodeLogin({ fetchImpl, pollIntervalMs: 5 }))
      .rejects.toMatchObject({ kind: 'timeout' })
  })

  it('ZcodeLoginError 的 name 与 kind 都正确', () => {
    const err = new ZcodeLoginError('x', 'timeout')
    expect(err.name).toBe('ZcodeLoginError')
    expect(err.kind).toBe('timeout')
    expect(err).toBeInstanceOf(Error)
  })
})
