import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  buildMinimaxDeviceCodeBody,
  buildMinimaxPollBody,
  createMinimaxPkce,
  parseMinimaxDeviceAuthorization,
  parseMinimaxTokenGrant,
  pollMinimaxDeviceToken,
  refreshMinimaxCredential,
  startMinimaxDeviceAuthorization,
  type MinimaxDeviceAuthorization,
} from '../../src/minimax-oauth.js'

/** 造一个合法的 access_token（三段 JWT，payload 含 sub/exp）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`
}

const DEVICE_BODY = {
  device_code: 'd'.repeat(43),
  user_code: '98FJ-WYXZ',
  verification_uri: 'https://account.minimax.cn/oauth-authorize',
  verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=98FJ-WYXZ',
  expires_in: 300,
  interval: 3,
}

/** 造一个 JSON `Response`（文件级：多个 describe 共用）。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('设备码请求体', () => {
  it('带 PKCE S256 与官方常量', () => {
    const body = buildMinimaxDeviceCodeBody('CHALLENGE')
    expect(body.get('client_id')).toBe('mcode-public')
    expect(body.get('scope')).toBe('agent.default')
    expect(body.get('audience')).toBe('agent-backend')
    expect(body.get('code_challenge')).toBe('CHALLENGE')
    expect(body.get('code_challenge_method')).toBe('S256')
  })

  it('轮询体用 device_code grant', () => {
    // ⚠️ 必须**自己构造** auth（带已知 codeVerifier），不能拿
    // `parseMinimaxDeviceAuthorization` 的返回值 —— 它返回的 `codeVerifier` **恒为 `''`**
    //（PKCE verifier 由 `startMinimaxDeviceAuthorization` 注入，解析器不产生它）。
    // 若照抄返回值，`expect(body.get('code_verifier')).toBe(auth.codeVerifier)`
    // 就变成断言 `'' === ''`，**永远通过、零判别力**。
    const auth: MinimaxDeviceAuthorization = {
      deviceCode: 'd'.repeat(43),
      codeVerifier: 'the-real-verifier',
      userCode: '98FJ-WYXZ',
      verificationUri: DEVICE_BODY.verification_uri,
      verificationUriComplete: DEVICE_BODY.verification_uri_complete,
      expiresInSec: 300,
      intervalSec: 3,
    }
    const body = buildMinimaxPollBody(auth)
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(body.get('device_code')).toBe('d'.repeat(43))
    expect(body.get('client_id')).toBe('mcode-public')
    expect(body.get('code_verifier')).toBe('the-real-verifier')
  })
})

describe('createMinimaxPkce —— S256 算法本身的正确性', () => {
  // ⚠️ PKCE 的 challenge 算错会让**登录在服务端被拒**，而错误信息通常指向
  // 「invalid_grant」/「code_verifier 不匹配」而非 PKCE 实现 —— 最难定位的一类。
  // 故必须直接锁住算法，而不是只断言「两个字段非空」。
  it('⚠️ code_challenge 必须是 SHA256(code_verifier) 的 base64url 摘要', () => {
    const { codeVerifier, codeChallenge } = createMinimaxPkce()
    const expected = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
    expect(codeChallenge).toBe(expected)
  })

  it('⚠️ 每次调用都不同（verifier 必须随机）', () => {
    const a = createMinimaxPkce()
    const b = createMinimaxPkce()
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
    expect(a.codeChallenge).not.toBe(b.codeChallenge)
  })

  it('⚠️ 用 base64url 字符集（含 - / _、不含 + / / / =，否则 URL 里会被转义）', () => {
    const { codeVerifier, codeChallenge } = createMinimaxPkce()
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(codeVerifier).not.toContain('=')
    expect(codeChallenge).not.toContain('=')
  })

  it('⚠️ verifier 长度足够（32 字节随机 ⇒ base64url 43 字符）', () => {
    expect(createMinimaxPkce().codeVerifier).toHaveLength(43)
  })
})

describe('parseMinimaxDeviceAuthorization', () => {
  it('解析标准响应并回退 verification_uri', () => {
    const auth = parseMinimaxDeviceAuthorization({ ...DEVICE_BODY, verification_uri_complete: undefined })
    expect(auth?.verificationUriComplete).toBe(DEVICE_BODY.verification_uri)
    expect(auth?.intervalSec).toBe(3)
  })

  it('缺 device_code / user_code / verification_uri 时返回 undefined', () => {
    expect(parseMinimaxDeviceAuthorization({ ...DEVICE_BODY, device_code: undefined })).toBeUndefined()
    expect(parseMinimaxDeviceAuthorization({ ...DEVICE_BODY, user_code: undefined })).toBeUndefined()
    expect(parseMinimaxDeviceAuthorization({ ...DEVICE_BODY, verification_uri: undefined })).toBeUndefined()
  })

  it('⚠️ interval 按**秒**处理（不是毫秒）', () => {
    const auth = parseMinimaxDeviceAuthorization({ ...DEVICE_BODY, interval: 5 })
    expect(auth?.intervalSec).toBe(5)
  })
})

describe('parseMinimaxTokenGrant', () => {
  // ⚠️ 用**真实的** token 形态（`mmoat_` 前缀、60 字符、0 个点 = **不是 JWT**）。
  // 不要用 `makeJwt` 造 token 当主用例 —— 那会掩盖「过期时间必须来自 expires_in」
  // 这一实测事实（复审者 2026-09-28 发现：本机凭据根本不是 JWT）。
  const REAL_ACCESS = `mmoat_${'a'.repeat(54)}`
  const valid = {
    access_token: REAL_ACCESS,
    refresh_token: 'r'.repeat(60),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'agent.default',
  }

  it('解析成功并保留 refresh_token', () => {
    const credential = parseMinimaxTokenGrant(valid)
    expect(credential.access_token).toBe(REAL_ACCESS)
    expect(credential.refresh_token).toBe('r'.repeat(60))
    expect(credential.token_type).toBe('Bearer')
  })

  it('⚠️⚠️ 过期时间来自 expires_in（真实 token 不是 JWT，解不出 exp）', () => {
    const before = Date.now()
    const credential = parseMinimaxTokenGrant(valid)
    const expiresAt = Number(credential.expires_at)
    expect(Number.isFinite(expiresAt)).toBe(true)
    // 必须落在 [before+3600s, after+3600s] 区间内
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
  })

  it('⚠️ 非 JWT 的 token 不产出 account_id（不编造）', () => {
    expect(parseMinimaxTokenGrant(valid).account_id).toBeUndefined()
  })

  it('JWT 形态的 token 仍能解出 exp 与 sub（上游将来改发时的兼容路径）', () => {
    const credential = parseMinimaxTokenGrant({
      ...valid,
      access_token: makeJwt({ sub: 'acct-1', exp: 4_000_000_000 }),
    })
    expect(credential.account_id).toBe('acct-1')
    expect(credential.expires_at).toBe(String(4_000_000_000 * 1000))
  })

  it('⚠️ 缺 refresh_token 时回退上一个（续期响应可能不下发）', () => {
    const credential = parseMinimaxTokenGrant(
      { ...valid, refresh_token: undefined },
      'previous-refresh',
    )
    expect(credential.refresh_token).toBe('previous-refresh')
  })

  it('⚠️ scope 必须含 agent.default，否则抛错（asar parseTokenGrant 的硬校验）', () => {
    expect(() => parseMinimaxTokenGrant({ ...valid, scope: 'other.scope' })).toThrow()
  })

  it('token_type 非 bearer 时抛错', () => {
    expect(() => parseMinimaxTokenGrant({ ...valid, token_type: 'mac' })).toThrow()
  })

  it('缺 access_token 或 expires_in 时抛错', () => {
    expect(() => parseMinimaxTokenGrant({ ...valid, access_token: undefined })).toThrow()
    expect(() => parseMinimaxTokenGrant({ ...valid, expires_in: undefined })).toThrow()
  })
})

describe('pollMinimaxDeviceToken', () => {
  const auth: MinimaxDeviceAuthorization = {
    deviceCode: 'd'.repeat(43),
    codeVerifier: 'verifier',
    userCode: '98FJ-WYXZ',
    verificationUri: 'https://account.minimax.cn/oauth-authorize',
    verificationUriComplete: 'https://account.minimax.cn/oauth-authorize?user_code=98FJ-WYXZ',
    expiresInSec: 300,
    intervalSec: 1,
  }
  const grant = {
    access_token: makeJwt({ sub: 'acct-1', exp: 4_000_000_000 }),
    refresh_token: 'r'.repeat(60),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'agent.default',
  }

  /**
   * ⚠️ 每个 `Response` 的 body **只能读一次**（已实测：
   * 第二次 `response.json()` 报 `Body is unusable: Body has already been read`）。
   *
   * brief 原文的 `mockResolvedValue(json(...))` 会让**同一个 Response 实例**
   * 被反复返回 —— 第二轮起 `json()` 解析失败、body 退化为 `{}`，
   * 于是 `status` 读成 undefined、直接掉进 `parseMinimaxTokenGrant({})`，
   * 抛的是「**令牌响应不是对象**」而不是期望的「**过期**」。
   * 故凡「同一响应要重复使用」的用例，必须让 fetcher **每次现造一个新的 Response**。
   */
  const jsonEach = (body: unknown, status = 200) => () => json(body, status)

  it('⚠️ HTTP 200 + status=pending 必须继续轮询（不是错误）', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ status: 'pending' }))
      .mockResolvedValueOnce(json({ status: 'pending' }))
      .mockResolvedValueOnce(json(grant))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const credential = await pollMinimaxDeviceToken(auth, { fetcher, sleep })
    expect(credential.access_token).toBe(grant.access_token)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('⚠️ 非 200 + error=authorization_pending 也要继续轮询', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ error: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(json(grant))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const credential = await pollMinimaxDeviceToken(auth, { fetcher, sleep })
    expect(credential.access_token).toBe(grant.access_token)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('status=slow_down 增加间隔', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ status: 'slow_down' }))
      .mockResolvedValueOnce(json(grant))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await pollMinimaxDeviceToken(auth, { fetcher, sleep })
    // ⚠️ 只应**睡一次**，且这次必须是**加大后**的 6000ms。
    //
    // brief 原文此处断言 `nth(1)===1000` + `nth(2)===6000`（即期待两次 sleep），
    // 那要求「每次轮询**之前**先睡」的语义。但同文件的
    // `⚠️ HTTP 200 + status=pending 必须继续轮询` 一条断言
    // 「3 次 fetch 只对应 **2 次** sleep」—— 那要求「**收到等待响应之后**才睡」。
    // 两者**互相矛盾，不存在能同时满足的实现**（已用脚本穷举两种语义证实）。
    //
    // 以 asar 权威实现为准（`.minimax-forensics/oauth-core/oauth-client.js:89-93`）：
    // `slow_down` 分支先 `intervalMs += 5_000` 再 `sleep(intervalMs)` ——
    // 即**只睡加大后的那一次**。故此处按该语义锁住「间隔确实被加大」。
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenNthCalledWith(1, 6000)
  })

  it('status=denied 抛取消错误', async () => {
    const fetcher = vi.fn().mockImplementation(jsonEach({ status: 'denied' }))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(pollMinimaxDeviceToken(auth, { fetcher, sleep })).rejects.toThrow(/取消|拒绝/)
  })

  it('status=expired 抛过期错误', async () => {
    const fetcher = vi.fn().mockImplementation(jsonEach({ status: 'expired' }))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(pollMinimaxDeviceToken(auth, { fetcher, sleep })).rejects.toThrow(/过期/)
  })

  it('超过 expiresInSec 抛过期错误', async () => {
    let now = 0
    const fetcher = vi.fn().mockImplementation(jsonEach({ status: 'pending' }))
    const sleep = vi.fn().mockImplementation(async (ms: number) => { now += ms })
    await expect(
      pollMinimaxDeviceToken(auth, { fetcher, sleep, now: () => now }),
    ).rejects.toThrow(/过期/)
  })
})

describe('startMinimaxDeviceAuthorization', () => {
  /**
   * ⚠️ 这是 PKCE 真正生效的**唯一**补偿点。
   *
   * `parseMinimaxDeviceAuthorization` 返回的 `codeVerifier` **恒为 `''`**
   *（verifier 只有发起方知道，响应里不会有），故 `startMinimaxDeviceAuthorization`
   * 必须把本地生成的 verifier 注入进去。若这一行漏了或注错了：
   * - 轮询体里的 `code_verifier` 会是空串 ⇒ 服务端**拒绝**（`invalid_grant`），
   *   且错误信息不指向 PKCE，极难定位；
   * - 而其余 23 条用例**全都抓不到**（它们都自己构造 auth）。
   * 故本条锁的是「注入链路存在且与 challenge 同源」。
   */
  it('⚠️ 必须把本地 PKCE verifier 注入返回值（且与请求里的 challenge 同源）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(DEVICE_BODY))
    const auth = await startMinimaxDeviceAuthorization(fetcher as never)

    // ① verifier 非空 —— 否则轮询必被服务端拒
    expect(auth.codeVerifier).not.toBe('')
    expect(auth.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // ② 请求体里的 challenge 必须正是该 verifier 的 S256 摘要。
    //    （只断言「body 里有 challenge」不够 —— 与 verifier 不同源照样是废的。）
    const sent = fetcher.mock.calls[0]?.[1] as RequestInit
    const body = new URLSearchParams(sent.body as string)
    const expected = createHash('sha256').update(auth.codeVerifier, 'ascii').digest('base64url')
    expect(body.get('code_challenge')).toBe(expected)

    // ③ 解析出的设备信息一并保留
    expect(auth.deviceCode).toBe(DEVICE_BODY.device_code)
    expect(auth.userCode).toBe(DEVICE_BODY.user_code)
    expect(auth.intervalSec).toBe(3)
  })

  it('HTTP 非 200 抛错（不返回半成品）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}, 500))
    await expect(startMinimaxDeviceAuthorization(fetcher as never)).rejects.toThrow(/设备码/)
  })

  it('响应无法解析时抛错', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ nope: 1 }))
    await expect(startMinimaxDeviceAuthorization(fetcher as never)).rejects.toThrow(/无法解析/)
  })
})

describe('refreshMinimaxCredential', () => {
  /**
   * ⚠️ 续期响应**可能不下发 `refresh_token`**（服务端未必轮换）。
   * 此时必须**保留旧的那个** —— 丢了它账号就再也刷不动，只能重新登录。
   * 故这条锁的是「把旧 refresh_token 作为 previous 传进 parseMinimaxTokenGrant」。
   */
  it('⚠️ 响应未下发 refresh_token 时保留旧值（否则账号报废）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      access_token: `mmoat_${'a'.repeat(54)}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent.default',
    }))
    const credential = await refreshMinimaxCredential('OLD-REFRESH-TOKEN', fetcher as never)
    expect(credential.refresh_token).toBe('OLD-REFRESH-TOKEN')
    expect(credential.access_token).toBe(`mmoat_${'a'.repeat(54)}`)
  })

  it('请求体用 refresh_token grant，且带上旧 token', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      access_token: `mmoat_${'a'.repeat(54)}`,
      refresh_token: 'NEW-REFRESH',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent.default',
    }))
    const credential = await refreshMinimaxCredential('OLD-REFRESH-TOKEN', fetcher as never)
    const sent = fetcher.mock.calls[0]?.[1] as RequestInit
    const body = new URLSearchParams(sent.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('OLD-REFRESH-TOKEN')
    // 服务端下发了新的就以新的为准（轮换）
    expect(credential.refresh_token).toBe('NEW-REFRESH')
  })

  it('HTTP 非 200 时把服务端 error 带进消息（便于排查）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: 'invalid_grant' }, 400))
    await expect(refreshMinimaxCredential('X', fetcher as never))
      .rejects.toThrow(/invalid_grant/)
  })
})
