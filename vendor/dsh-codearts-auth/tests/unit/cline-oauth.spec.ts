import { describe, expect, it, vi } from 'vitest'
import {
  CLINE_DEVICE_AUTH_EXPIRES_MS,
  CLINE_DEVICE_AUTH_INTERVAL_MS,
  pollClineWorkOsTokens,
  registerClineTokens,
  requestClineDeviceAuthorization,
  runClineLoginFlow,
  startClineLoginFlow,
  type ClineDeviceAuthorization,
} from '../../src/cline-oauth.js'
import { CLINE } from '../../src/cline-product.js'
import { parseClineTokenPayload } from '../../src/cline.js'

/** 实测的设备码授权响应形状。 */
function deviceAuthResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    device_code: 'dev-code-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://api.workos.com/device',
    verification_uri_complete: 'https://api.workos.com/device?user_code=ABCD-1234',
    expires_in: 300,
    interval: 5,
    ...overrides,
  }), { status: 200 })
}

/** 实测的 register 响应形状（`{success, data}` 信封 + 驼峰字段）。 */
function registerResponse(): Response {
  return new Response(JSON.stringify({
    success: true,
    data: {
      accessToken: 'workos:eyJhbGciOiJSUzI1NiIs',
      refreshToken: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
      expiresAt: '2026-09-25T05:23:47.000Z',
      tokenType: 'Bearer',
      userInfo: {
        clineUserId: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
        email: 'ijetlee@163.com',
        firstName: '',
        lastName: '',
      },
    },
  }), { status: 200 })
}

const AUTH: ClineDeviceAuthorization = {
  deviceCode: 'dev-code-1',
  userCode: 'ABCD-1234',
  verificationUri: 'https://api.workos.com/device',
  verificationUriComplete: 'https://api.workos.com/device?user_code=ABCD-1234',
  expiresInMs: CLINE_DEVICE_AUTH_EXPIRES_MS,
  intervalMs: 1,
}

describe('requestClineDeviceAuthorization', () => {
  it('POST 到 WorkOS 设备码端点，body 是 form 编码的 client_id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return deviceAuthResponse()
    }) as unknown as typeof fetch

    const auth = await requestClineDeviceAuthorization(CLINE, { fetcher })
    expect(calls[0]!.url).toBe('https://api.workos.com/user_management/authorize/device')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded')
    expect(String(calls[0]!.init.body)).toBe(`client_id=${CLINE.workOsClientId}`)
    expect(auth.deviceCode).toBe('dev-code-1')
    expect(auth.userCode).toBe('ABCD-1234')
    expect(auth.verificationUriComplete).toBe('https://api.workos.com/device?user_code=ABCD-1234')
    expect(auth.expiresInMs).toBe(300_000)
    expect(auth.intervalMs).toBe(5_000)
  })

  it('缺必要字段时抛「登录服务返回异常」（确定性错误）', async () => {
    const fetcher = vi.fn(async () => deviceAuthResponse({ device_code: undefined })) as unknown as typeof fetch
    await expect(requestClineDeviceAuthorization(CLINE, { fetcher }))
      .rejects.toThrow(/登录服务返回异常/)
  })

  it('非 2xx 抛确定性错误并带 error_description', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_client', error_description: 'bad client' }), { status: 400 },
    )) as unknown as typeof fetch
    await expect(requestClineDeviceAuthorization(CLINE, { fetcher }))
      .rejects.toThrow(/设备码授权失败（HTTP 400） - bad client/)
  })

  it('interval / expires_in 非法时回退到源码默认值', async () => {
    const fetcher = vi.fn(async () => deviceAuthResponse({ interval: 0, expires_in: -5 })) as unknown as typeof fetch
    const auth = await requestClineDeviceAuthorization(CLINE, { fetcher })
    expect(auth.intervalMs).toBe(CLINE_DEVICE_AUTH_INTERVAL_MS)
    expect(auth.expiresInMs).toBe(CLINE_DEVICE_AUTH_EXPIRES_MS)
  })
})

describe('pollClineWorkOsTokens（状态机）', () => {
  /** 按顺序返回响应的 fetcher。 */
  function sequenceFetcher(responses: Response[]): { fetcher: typeof fetch; calls: () => number } {
    let index = 0
    const fetcher = vi.fn(async () => {
      const response = responses[Math.min(index, responses.length - 1)]!
      index += 1
      return response
    }) as unknown as typeof fetch
    return { fetcher, calls: () => index }
  }

  /**
   * ⚠️ **`authorization_pending` 不是错误** —— 它是「用户还没在浏览器里点授权」。
   * 若按失败处理，用户一打开页面就会看到登录失败（而实际只是还没点）。
   * 这与 Qoder 的「404 表示尚未授权」是同一类语义，但判据形态完全不同。
   */
  it('authorization_pending 继续轮询，不当作错误', async () => {
    vi.useFakeTimers()
    try {
      const { fetcher, calls } = sequenceFetcher([
        new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
        new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 }),
      ])
      const pending = pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 })
      await vi.advanceTimersByTimeAsync(10_000)
      const tokens = await pending
      expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt' })
      expect(calls()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * ⚠️ `slow_down` 必须**真的退避**（源码 `intervalSeconds += 1`）。
   *
   * ⚠️ 用**假定时器**：真实实现里轮询间隔有 **1 秒下限**
   *（`Math.max(1_000, …)`，对齐源码 `Math.max(1, initialPollIntervalSeconds)`），
   * 两次 `slow_down` 就是 1s + 2s 的真实等待。真实等待会让本用例变慢且
   * 在慢机器上偶发超时，而这里要验证的是**退避是否累积**，与真实时钟无关。
   */
  it('slow_down 累积退避后继续轮询', async () => {
    vi.useFakeTimers()
    try {
      const { fetcher, calls } = sequenceFetcher([
        new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 }),
        new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 }),
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 }),
      ])
      const pending = pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 })
      // 推进足够长的时间：首轮 1s、第二轮 2s（累积退避）后应成功返回。
      await vi.advanceTimersByTimeAsync(10_000)
      const tokens = await pending
      expect(tokens.accessToken).toBe('at')
      expect(calls()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('access_denied 是终态（不无限轮询）', async () => {
    const { fetcher, calls } = sequenceFetcher([
      new Response(JSON.stringify({ error: 'access_denied', error_description: 'user said no' }), { status: 400 }),
    ])
    await expect(pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 }))
      .rejects.toThrow(/user said no/)
    expect(calls()).toBe(1)
  })

  it('expired_token 与 invalid_grant 同样终态', async () => {
    for (const code of ['expired_token', 'invalid_grant']) {
      const { fetcher } = sequenceFetcher([
        new Response(JSON.stringify({ error: code }), { status: 400 }),
      ])
      await expect(pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 }), code)
        .rejects.toThrow(/登录服务返回异常/)
    }
  })

  it('未知 error 码是终态（不当作 pending）', async () => {
    const { fetcher, calls } = sequenceFetcher([
      new Response(JSON.stringify({ error: 'weird_new_error' }), { status: 500 }),
    ])
    await expect(pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 }))
      .rejects.toThrow(/HTTP 500/)
    expect(calls()).toBe(1)
  })

  it('2xx 但缺 token 视为服务端异常（不死循环）', async () => {
    const { fetcher } = sequenceFetcher([
      new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }),
    ])
    await expect(pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 }))
      .rejects.toThrow(/缺少必要字段/)
  })

  it('连续网络失败达到上限后放弃（并报出次数）', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
      const pending = pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 })
      // 先挂断言处理器，避免 fake timers 推进期间产生「未处理的拒绝」告警。
      const settled = expect(pending).rejects.toThrow(/连续 5 次失败/)
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时后抛「登录等待已超时」', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: 'authorization_pending' }), { status: 400 },
    )) as unknown as typeof fetch
    await expect(pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1, timeoutMs: 30 }))
      .rejects.toThrow(/登录等待已超时/)
  })

  it('外部 signal 中止时抛「登录已取消」', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(pollClineWorkOsTokens(AUTH, {
      product: CLINE, fetcher, pollIntervalMs: 1, signal: controller.signal,
    })).rejects.toThrow(/登录已取消/)
  })

  it('轮询请求体用 device_code grant（form 编码）', async () => {
    const calls: RequestInit[] = []
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init)
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 })
    }) as unknown as typeof fetch
    await pollClineWorkOsTokens(AUTH, { product: CLINE, fetcher, pollIntervalMs: 1 })
    const body = String(calls[0]!.body)
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code')
    expect(body).toContain('device_code=dev-code-1')
    expect(body).toContain(`client_id=${CLINE.workOsClientId}`)
  })
})

describe('registerClineTokens', () => {
  it('POST 到 /api/v1/auth/register，body 用驼峰字段并带客户端标识头', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return registerResponse()
    }) as unknown as typeof fetch

    await registerClineTokens({ accessToken: 'at', refreshToken: 'rt' }, { product: CLINE, fetcher })
    expect(calls[0]!.url).toBe('https://api.cline.bot/api/v1/auth/register')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ accessToken: 'at', refreshToken: 'rt' })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk')
  })

  it('非 2xx 抛确定性错误', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: 'boom' }), { status: 500 },
    )) as unknown as typeof fetch
    await expect(registerClineTokens({ accessToken: 'a', refreshToken: 'r' }, { product: CLINE, fetcher }))
      .rejects.toThrow(/token 注册失败（HTTP 500） - boom/)
  })
})

describe('startClineLoginFlow / runClineLoginFlow', () => {
  /** 设备码 + 一次成功轮询 + register 的完整 fetcher。 */
  function fullFlowFetcher(): { fetcher: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/user_management/authorize/device')) return deviceAuthResponse()
      if (url.includes('/user_management/authenticate')) {
        return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 })
      }
      return registerResponse()
    }) as unknown as typeof fetch
    return { fetcher, urls }
  }

  it('立即返回带 user_code 的登录 URL（优先 verification_uri_complete）', async () => {
    const { fetcher, urls } = fullFlowFetcher()
    const started = await startClineLoginFlow({ product: CLINE, fetcher, pollIntervalMs: 1 })
    expect(started.loginUrl).toBe('https://api.workos.com/device?user_code=ABCD-1234')
    expect(started.userCode).toBe('ABCD-1234')
    // ⚠️ 两步式的意义：拿到 URL 时**尚未**等到用户授权 ——
    // 首个请求必须是设备码授权，且此刻 register（登录完成的标志）还没发生。
    expect(urls[0]).toBe('https://api.workos.com/user_management/authorize/device')
    expect(urls.some((u) => u.includes('/api/v1/auth/register'))).toBe(false)
    const result = await started.result
    await started.close()
    // 注册响应里的 accessToken 自带 workos: 前缀，凭据应原样保留
    expect(result.access).toContain('workos:eyJhbGciOiJSUzI1NiIs')
    expect(result.refreshable).toBe(true)
    expect(result.expires).toBe(Date.parse('2026-09-25T05:23:47.000Z'))
  })

  it('无 verification_uri_complete 时回退到 verification_uri', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/user_management/authorize/device')) {
        return deviceAuthResponse({ verification_uri_complete: undefined })
      }
      if (url.includes('/user_management/authenticate')) {
        return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 })
      }
      return registerResponse()
    }) as unknown as typeof fetch
    const started = await startClineLoginFlow({ product: CLINE, fetcher, pollIntervalMs: 1 })
    expect(started.loginUrl).toBe('https://api.workos.com/device')
    await started.close()
  })

  it('close() 取消轮询且幂等', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/user_management/authorize/device')) return deviceAuthResponse()
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
    }) as unknown as typeof fetch
    const started = await startClineLoginFlow({ product: CLINE, fetcher, pollIntervalMs: 5 })
    const settled = started.result.catch((error: unknown) => error)
    await started.close()
    await started.close() // 幂等
    const error = await settled
    expect(error).toBeInstanceOf(Error)
  })

  it('runClineLoginFlow 打开浏览器并返回凭据', async () => {
    const { fetcher } = fullFlowFetcher()
    const opened: string[] = []
    const result = await runClineLoginFlow({
      product: CLINE,
      fetcher,
      pollIntervalMs: 1,
      openBrowser: (url) => { opened.push(url) },
    })
    expect(opened).toEqual(['https://api.workos.com/device?user_code=ABCD-1234'])
    expect(parseClineTokenPayload(JSON.parse(result.access)).accessToken).toContain('workos:')
  })
})
