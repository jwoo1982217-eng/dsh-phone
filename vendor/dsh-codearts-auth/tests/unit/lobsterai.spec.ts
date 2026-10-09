import { describe, expect, it, vi } from 'vitest'
import * as lobsteraiModule from '../../src/lobsterai.js'
import {
  LOBSTERAI_CALLBACK_PATH,
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_MODELS_PATH,
  LOBSTERAI_REFRESH_PATH,
  LobsteraiClientVersionResolver,
  applyLobsteraiRefresh,
  buildLobsteraiCredential,
  isLobsteraiExpired,
  isLobsteraiRefreshable,
  lobsteraiAnonymousHeaders,
  lobsteraiAuthHeaders,
  lobsteraiChatHeaders,
  lobsteraiDisplayNickname,
  lobsteraiModelsHeaders,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiKeyfromBody,
  lobsteraiRefreshBody,
  maskLobsteraiPhoneTail,
  parseClientVersion,
  parseClientVersionFromUpdate,
  parseLobsteraiEnvelope,
  parseLobsteraiTokenPayload,
  readNumberField,
  readStringField,
  resolveLobsteraiUid,
} from '../../src/lobsterai.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

const TEST_VERSION = '2026.9.4'

function makeCredential(overrides: Partial<LobsteraiCredential> = {}): LobsteraiCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    uid: 'uid-1',
    user_id: 'yid-1',
    nickname: '测试账号',
    uuid: '11111111-2222-4333-8444-555555555555',
    first_keyfrom: '1700000000000',
    latest_keyfrom: '1700000000000',
    ...overrides,
  }
}

/** 构造一个不带签名的假 JWT（仅 header.payload. 段，供 exp/sub 解析用）。 */
function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.signature`
}

describe('LobsterAI 端点常量', () => {
  it('路径与协议文档一致', () => {
    // 这些字面量是移植正确性的第一道防线：改错一个字符就会打到不存在的端点。
    expect(LOBSTERAI_EXCHANGE_PATH).toBe('/api/auth/exchange')
    expect(LOBSTERAI_REFRESH_PATH).toBe('/api/auth/refresh')
    expect(LOBSTERAI_MODELS_PATH).toBe('/api/models/available')
    // 积分余额端点常量定义在 src/lobsterai-credits.ts（唯一使用方）——
    // 曾经两处各定义一份同名常量，端点变更只改一处会让语义分叉且无测试失败。
    // 这里断言它在 lobsterai.js 里**不再**导出，防止重复定义回归。
    expect(lobsteraiModule).not.toHaveProperty('LOBSTERAI_PROFILE_SUMMARY_PATH')
    expect(LOBSTERAI_CHAT_PATH).toBe('/api/proxy/v1/chat/completions')
    expect(LOBSTERAI_CALLBACK_PATH).toBe('/auth/callback')
  })
})

describe('安全字段读取', () => {
  it('readStringField 兼容字符串与数字，其他类型返回空串', () => {
    expect(readStringField({ a: 'x' }, 'a')).toBe('x')
    expect(readStringField({ a: 123 }, 'a')).toBe('123')
    expect(readStringField({ a: null }, 'a')).toBe('')
    expect(readStringField({}, 'a')).toBe('')
  })

  it('readNumberField 兼容数字型字符串，非法值返回 undefined', () => {
    expect(readNumberField({ a: 5 }, 'a')).toBe(5)
    expect(readNumberField({ a: '5.5' }, 'a')).toBe(5.5)
    expect(readNumberField({ a: 'abc' }, 'a')).toBeUndefined()
    expect(readNumberField({}, 'a')).toBeUndefined()
  })
})

describe('统一信封解析', () => {
  it('code=0 且 data 为对象时成功', () => {
    expect(parseLobsteraiEnvelope({ code: 0, msg: 'OK', data: { a: 1 } }))
      .toEqual({ ok: true, data: { a: 1 } })
  })

  it('code 非 0 时失败并带上服务端 msg', () => {
    expect(parseLobsteraiEnvelope({ code: 40100, msg: 'token rejected' }))
      .toEqual({ ok: false, code: 40100, message: 'token rejected' })
  })

  it('code 非 0 且无 msg 时给出可读兜底', () => {
    expect(parseLobsteraiEnvelope({ code: 500 }))
      .toEqual({ ok: false, code: 500, message: 'code=500' })
  })

  it('code=0 但 data 为 null 时判失败（凭据失效的典型形态）', () => {
    // sigin.py:46-47 用这一条判定「accessToken 可能已失效」：
    // 上游凭据失效时倾向返回 code:0 + data:null，只看 code 会被误判为成功。
    expect(parseLobsteraiEnvelope({ code: 0, data: null })).toEqual({
      ok: false, code: 0, message: 'data 为空（accessToken 可能已失效）',
    })
  })

  it('code=0 但 data 是数组时判失败（结构不符）', () => {
    expect(parseLobsteraiEnvelope({ code: 0, data: [1, 2] })).toMatchObject({ ok: false })
  })

  it('响应体非对象时判失败', () => {
    expect(parseLobsteraiEnvelope(null)).toMatchObject({ ok: false })
    expect(parseLobsteraiEnvelope('nope')).toMatchObject({ ok: false })
    expect(parseLobsteraiEnvelope(42)).toMatchObject({ ok: false })
  })

  it('message 字段可作为 msg 的别名', () => {
    expect(parseLobsteraiEnvelope({ code: 1, message: '别名' }))
      .toEqual({ ok: false, code: 1, message: '别名' })
  })
})

describe('凭据过期与可刷新判定', () => {
  it('毫秒时间戳字符串直接解析', () => {
    const ms = Date.now() + 1000
    expect(lobsteraiCredentialExpiresAtMs(makeCredential({ expires_at: String(ms) }))).toBe(ms)
  })

  it('秒级时间戳自动换算为毫秒', () => {
    const sec = Math.floor((Date.now() + 1000) / 1000)
    expect(lobsteraiCredentialExpiresAtMs(makeCredential({ expires_at: String(sec) }))).toBe(sec * 1000)
  })

  it('ISO 字符串可解析', () => {
    const iso = new Date(Date.now() + 1000).toISOString()
    expect(lobsteraiCredentialExpiresAtMs(makeCredential({ expires_at: iso })))
      .toBe(Date.parse(iso))
  })

  it('expires_at 缺失时回退解析 JWT exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const credential = makeCredential({ expires_at: '', access_token: fakeJwt({ exp }) })
    expect(lobsteraiCredentialExpiresAtMs(credential)).toBe(exp * 1000)
  })

  it('expires_at 与 JWT 都不可用时返回 undefined', () => {
    expect(lobsteraiCredentialExpiresAtMs(makeCredential({ expires_at: '', access_token: 'not-a-jwt' })))
      .toBeUndefined()
  })

  it('无法解析过期时间时不判定为已过期（避免误报失效）', () => {
    expect(isLobsteraiExpired(makeCredential({ expires_at: '', access_token: 'x' }))).toBe(false)
  })

  it('已过期凭据判定为过期', () => {
    expect(isLobsteraiExpired(makeCredential({ expires_at: String(Date.now() - 1000) }))).toBe(true)
  })

  it('refresh_token 为空串时不可刷新', () => {
    expect(isLobsteraiRefreshable(makeCredential({ refresh_token: '' }))).toBe(false)
    expect(isLobsteraiRefreshable(makeCredential())).toBe(true)
  })
})

describe('keyfrom 身份载荷', () => {
  it('必带三字段，且有 uuid/userId 时附带', () => {
    expect(lobsteraiKeyfromBody(makeCredential(), TEST_VERSION)).toEqual({
      firstKeyfrom: '1700000000000',
      latestKeyfrom: '1700000000000',
      version: TEST_VERSION,
      uuid: '11111111-2222-4333-8444-555555555555',
      userId: 'yid-1',
    })
  })

  it('uuid/userId 缺省时**删除键**而非写空串', () => {
    // 空串可能被服务端当成非法值，Go 的 `if a.Uuid != ""` 就是「有才带」。
    const body = lobsteraiKeyfromBody(makeCredential({ uuid: '', user_id: '' }), TEST_VERSION)
    expect(body).not.toHaveProperty('uuid')
    expect(body).not.toHaveProperty('userId')
  })

  it('first_keyfrom 缺失时以空串占位（保持字段存在）', () => {
    const body = lobsteraiKeyfromBody(makeCredential({ first_keyfrom: undefined }), TEST_VERSION)
    expect(body.firstKeyfrom).toBe('')
  })

  it('latestKeyfrom 取**凭据存储值**，不是当前时刻', () => {
    // 对齐 Go 的 KeyfromBody()：读 a.LatestKeyfrom，而 RefreshToken 从不更新它。
    // 详见 lobsterai-parity.spec.ts 的一致性契约。
    expect(lobsteraiKeyfromBody(makeCredential({ latest_keyfrom: '1' }), TEST_VERSION).latestKeyfrom).toBe('1')
    expect(lobsteraiKeyfromBody(makeCredential({ latest_keyfrom: '2' }), TEST_VERSION).latestKeyfrom).toBe('2')
  })
})

describe('续期请求体', () => {
  it('在 keyfrom 载荷基础上追加 refreshToken', () => {
    expect(lobsteraiRefreshBody(makeCredential(), TEST_VERSION)).toEqual({
      firstKeyfrom: '1700000000000',
      latestKeyfrom: '1700000000000',
      version: TEST_VERSION,
      uuid: '11111111-2222-4333-8444-555555555555',
      userId: 'yid-1',
      refreshToken: 'RT',
    })
  })

  it('不包含 access_token（避免把旧 token 一起发出去）', () => {
    const body = lobsteraiRefreshBody(makeCredential(), TEST_VERSION)
    expect(JSON.stringify(body)).not.toContain('AT')
  })

  it('version 用传入的动态真值而非硬编码 0.1.0', () => {
    // Go 侧硬编码 "0.1.0" 是假值（实测真值形如 2026.9.4），此处必须可注入。
    expect(lobsteraiRefreshBody(makeCredential(), '2026.9.4').version).toBe('2026.9.4')
  })
})

describe('令牌载荷解析与 uid 回退链', () => {
  it('解析 exchange 响应的完整字段', () => {
    const payload = parseLobsteraiTokenPayload({
      accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600,
      user: { id: 'id-1', yid: 'yid-1', userId: 'acc-1', nickname: '昵称' },
    })
    expect(payload).toEqual({
      accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600,
      userId: 'id-1', yid: 'yid-1', accountUserId: 'acc-1', nickname: '昵称',
    })
  })

  it('user 缺失时字段取空串（安全读取不抛异常）', () => {
    const payload = parseLobsteraiTokenPayload({ accessToken: 'AT' })
    // 字符串字段统一走 readStringField，缺失时给空串而非 undefined ——
    // 让消费方（resolveLobsteraiUid / buildLobsteraiCredential）不必层层判空。
    expect(payload.userId).toBe('')
    expect(payload.yid).toBe('')
    expect(payload.accountUserId).toBe('')
    expect(payload.nickname).toBe('')
    // expiresIn 是唯一的可选数值字段（缺失与 0 语义不同）。
    expect(payload.expiresIn).toBeUndefined()
  })

  it('uid 回退链：user.id 优先', () => {
    expect(resolveLobsteraiUid({
      accessToken: 'AT', refreshToken: '', userId: 'id-1', accountUserId: 'acc-1', yid: 'yid-1',
    })).toBe('id-1')
  })

  it('uid 回退链：user.id 空时用 user.userId', () => {
    expect(resolveLobsteraiUid({
      accessToken: 'AT', refreshToken: '', userId: '', accountUserId: 'acc-1', yid: 'yid-1',
    })).toBe('acc-1')
  })

  it('uid 回退链：前两者空时用 user.yid', () => {
    expect(resolveLobsteraiUid({
      accessToken: 'AT', refreshToken: '', userId: '', accountUserId: '', yid: 'yid-1',
    })).toBe('yid-1')
  })

  it('uid 回退链：全部为空时用 sha256 前 16 位（**无** JWT sub 这一级）', () => {
    // 严格对齐 Go 的四级回退：user.id → user.userId → user.yid → sha256。
    // 曾经的实现多插了一级 JWT sub，会让同一账号在两边得到不同 uid。
    const uid = resolveLobsteraiUid({
      accessToken: fakeJwt({ sub: 'sub-1' }), refreshToken: '',
      userId: '', accountUserId: '', yid: '',
    })
    expect(uid).not.toBe('sub-1')
    expect(uid).toMatch(/^[0-9a-f]{16}$/)
  })

  it('uid 回退链：连 JWT 都不可解析时用 sha256 前 16 位', () => {
    // 与 Go 的 fmt.Sprintf("%x", sha256.Sum256(...))[:16] 完全一致，
    // 便于与 lobsterai2api 生成的 auths/lobsterai-{uid}.json 对照。
    const uid = resolveLobsteraiUid({
      accessToken: 'opaque-token', refreshToken: '',
      userId: '', accountUserId: '', yid: '',
    })
    expect(uid).toBe('84d3f23da9b5f51b')
    expect(uid).toHaveLength(16)
  })

  it('uid 回退链的稳定性：同一 token 恒得同一 uid', () => {
    const args = {
      accessToken: 'opaque', refreshToken: '', userId: '', accountUserId: '', yid: '',
    }
    expect(resolveLobsteraiUid(args)).toBe(resolveLobsteraiUid(args))
  })
})

describe('凭据组装', () => {
  const session = { uuid: 'uuid-1', firstKeyfrom: '1700000000000', latestKeyfrom: '1700000000000' }

  it('用 expiresIn 换算绝对毫秒时间戳（基准为当前时刻）', () => {
    const before = Date.now()
    const credential = buildLobsteraiCredential(
      { accessToken: 'AT', refreshToken: 'RT', expiresIn: 60 }, session,
    )
    const expires = Number(credential.expires_at)
    expect(expires).toBeGreaterThanOrEqual(before + 60_000)
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000)
  })

  it('expiresIn 缺失时回退 JWT exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const credential = buildLobsteraiCredential(
      { accessToken: fakeJwt({ exp }), refreshToken: 'RT' }, session,
    )
    expect(credential.expires_at).toBe(String(exp * 1000))
  })

  it('两者都不可用时 expires_at 为空串（交由「不判定过期」兜底）', () => {
    const credential = buildLobsteraiCredential(
      { accessToken: 'opaque', refreshToken: 'RT' }, session,
    )
    expect(credential.expires_at).toBe('')
  })

  it('持久化登录会话的三个身份字段（丢一个续期就会失败）', () => {
    const credential = buildLobsteraiCredential(
      { accessToken: 'AT', refreshToken: 'RT', expiresIn: 60 }, session,
    )
    expect(credential.uuid).toBe('uuid-1')
    expect(credential.first_keyfrom).toBe('1700000000000')
    expect(credential.latest_keyfrom).toBe('1700000000000')
  })

  it('user_id 优先取 user.userId，回退 yid', () => {
    const withUserId = buildLobsteraiCredential(
      { accessToken: 'AT', refreshToken: 'RT', accountUserId: 'acc-1', yid: 'yid-1' }, session,
    )
    expect(withUserId.user_id).toBe('acc-1')
    const withYid = buildLobsteraiCredential(
      { accessToken: 'AT', refreshToken: 'RT', yid: 'yid-1' }, session,
    )
    expect(withYid.user_id).toBe('yid-1')
  })
})

describe('续期结果合并', () => {
  it('更新 access_token，保留 uuid/first_keyfrom/latest_keyfrom', () => {
    const previous = makeCredential()
    const next = applyLobsteraiRefresh(
      previous, { accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 }, 1700000009999,
    )
    expect(next.access_token).toBe('AT2')
    expect(next.refresh_token).toBe('RT2')
    // 这三个服务端不返回，必须沿用旧值 —— 丢了会让下一次续期失败。
    expect(next.uuid).toBe(previous.uuid)
    expect(next.first_keyfrom).toBe(previous.first_keyfrom)
    expect(next.uid).toBe(previous.uid)
    expect(next.user_id).toBe(previous.user_id)
    expect(next.nickname).toBe(previous.nickname)
    // latest_keyfrom **刻意不更新**（对齐 Go：RefreshToken 不碰该字段）。
    expect(next.latest_keyfrom).toBe(previous.latest_keyfrom)
    expect(next.latest_keyfrom).not.toBe('1700000009999')
  })

  it('refresh 响应未带新 refreshToken 时沿用旧值（不能覆盖成空串）', () => {
    const next = applyLobsteraiRefresh(makeCredential(), { accessToken: 'AT2', refreshToken: '' }, 1)
    expect(next.refresh_token).toBe('RT')
  })

  it('expiresIn 缺失且 JWT 不可解析时保留原 expires_at', () => {
    const previous = makeCredential({ expires_at: '1700000000000' })
    const next = applyLobsteraiRefresh(previous, { accessToken: 'opaque', refreshToken: 'RT2' }, 1)
    expect(next.expires_at).toBe('1700000000000')
  })
})

describe('请求头构造', () => {
  it('认证头只带 LobsterAI 自己认的四个头', () => {
    const headers = lobsteraiAuthHeaders(makeCredential(), LOBSTERAI)
    expect(headers).toEqual({
      Authorization: 'Bearer AT',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'LobsterAI/0.1.0',
    })
  })

  it('**不**携带 CodeBuddy 系的归属头（带错会按错误客户端形态归因）', () => {
    const headers = lobsteraiAuthHeaders(makeCredential(), LOBSTERAI)
    for (const banned of ['X-Domain', 'X-Product', 'X-Product-Code', 'X-IDE-Name', 'X-IDE-Type', 'X-Enterprise-Id']) {
      expect(headers, banned).not.toHaveProperty(banned)
    }
  })

  it('对话头额外带 Capabilities 与动态版本号，Accept 为 SSE', () => {
    const headers = lobsteraiChatHeaders(makeCredential(), LOBSTERAI, TEST_VERSION)
    expect(headers['X-LobsterAI-Client-Capabilities']).toBe(LOBSTERAI.clientCapabilities)
    expect(headers['X-LobsterAI-Client-Version']).toBe(TEST_VERSION)
    expect(headers.Accept).toBe('text/event-stream, application/json')
  })

  /**
   * 模型列表头必须带 Capabilities —— 该头在 `/api/models/available` 上
   * **会改变返回的模型集合**（实测：不带时 25 个且无 `kimi-k3`，带上后 26 个）。
   *
   * 历史缺陷：早先 `fetchModels` 用的是只有 4 个基础头的 `lobsteraiAuthHeaders`，
   * 于是即使解析正确也永久缺少 `kimi-k3`。这条断言锁死该头不得被移除。
   */
  it('模型列表头带 Capabilities 与版本号，Accept 为 JSON', () => {
    const headers = lobsteraiModelsHeaders(makeCredential(), LOBSTERAI, TEST_VERSION)
    expect(headers['X-LobsterAI-Client-Capabilities']).toBe(LOBSTERAI.clientCapabilities)
    expect(headers['X-LobsterAI-Client-Version']).toBe(TEST_VERSION)
    expect(headers.Accept).toBe('application/json')
    // 仍是 Bearer 鉴权，且不夹带腾讯系归属头。
    expect(headers.Authorization).toBe('Bearer AT')
    for (const banned of ['X-Domain', 'X-Product', 'X-Product-Code']) {
      expect(headers, banned).not.toHaveProperty(banned)
    }
  })

  it('匿名头（exchange/refresh）不带 Authorization', () => {
    // 换 token 时还没有 token；续期只认请求体里的 refreshToken。
    const headers = lobsteraiAnonymousHeaders(LOBSTERAI)
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers['User-Agent']).toBe('LobsterAI/0.1.0')
  })
})

describe('客户端版本号解析', () => {
  it('接受日期式版本号', () => {
    expect(parseClientVersion('2026.9.4')).toBe('2026.9.4')
  })

  it('接受带预发布后缀的版本号', () => {
    expect(parseClientVersion('2026.9.4-beta.1')).toBe('2026.9.4-beta.1')
  })

  it('去除首尾空白', () => {
    expect(parseClientVersion('  2026.9.4  ')).toBe('2026.9.4')
  })

  it('拒绝非字符串、空串与格式异常值', () => {
    // 版本号是签到必填 query 参数，脏值必须提前拒绝，
    // 否则会以一个更费解的失败出现在更远的地方（对齐 sigin.py:27-28）。
    for (const bad of [null, undefined, 42, '', '   ', 'v2026.9.4', '2026.9.4.5.6.7.8!', '<html>']) {
      expect(parseClientVersion(bad), String(bad)).toBeUndefined()
    }
  })

  it('从更新接口响应中取出 data.value.version', () => {
    expect(parseClientVersionFromUpdate({
      data: { value: { version: '2026.9.4', date: '2026-9-4' } }, code: 0, msg: 'OK',
    })).toBe('2026.9.4')
  })

  it('更新接口响应结构不符时返回 undefined', () => {
    for (const bad of [null, {}, { data: null }, { data: {} }, { data: { value: null } }, { data: { value: {} } }]) {
      expect(parseClientVersionFromUpdate(bad)).toBeUndefined()
    }
  })
})

describe('客户端版本号解析器（缓存与兜底）', () => {
  const okResponse = () => new Response(JSON.stringify({
    data: { value: { version: '2026.9.4' } }, code: 0, msg: 'OK',
  }), { status: 200 })

  it('首次拉取走远端', async () => {
    const fetcher = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const resolver = new LobsteraiClientVersionResolver({ fetcher })
    expect(await resolver.resolve(LOBSTERAI)).toEqual({ version: '2026.9.4', source: 'remote' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('TTL 内命中缓存，不再发请求', async () => {
    const fetcher = vi.fn(async () => okResponse()) as unknown as typeof fetch
    let now = 1_000_000
    const resolver = new LobsteraiClientVersionResolver({ fetcher, now: () => now })
    await resolver.resolve(LOBSTERAI)
    now += 60_000
    expect(await resolver.resolve(LOBSTERAI)).toEqual({ version: '2026.9.4', source: 'cache' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后重新拉取', async () => {
    const fetcher = vi.fn(async () => okResponse()) as unknown as typeof fetch
    let now = 1_000_000
    const resolver = new LobsteraiClientVersionResolver({ fetcher, now: () => now, ttlMs: 1000 })
    await resolver.resolve(LOBSTERAI)
    now += 2000
    await resolver.resolve(LOBSTERAI)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('网络失败时回退兜底版本（比 sigin.py 的「放弃签到」更宽容）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    const resolver = new LobsteraiClientVersionResolver({ fetcher })
    expect(await resolver.resolve(LOBSTERAI)).toEqual({
      version: LOBSTERAI.fallbackClientVersion, source: 'fallback',
    })
  })

  it('远端返回异常版本格式时回退兜底版本', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { value: { version: 'not-a-version' } }, code: 0,
    }), { status: 200 })) as unknown as typeof fetch
    const resolver = new LobsteraiClientVersionResolver({ fetcher })
    expect(await resolver.resolve(LOBSTERAI)).toMatchObject({ source: 'fallback' })
  })

  it('HTTP 错误状态时回退兜底版本', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const resolver = new LobsteraiClientVersionResolver({ fetcher })
    expect(await resolver.resolve(LOBSTERAI)).toMatchObject({ source: 'fallback' })
  })

  it('兜底结果**不**写入缓存（一次瞬时故障不应在 TTL 内持续影响）', async () => {
    const failing = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    const resolver = new LobsteraiClientVersionResolver({ fetcher: failing })
    expect(await resolver.resolve(LOBSTERAI)).toMatchObject({ source: 'fallback' })

    const working = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const resolver2 = new LobsteraiClientVersionResolver({ fetcher: working })
    await resolver2.resolve(LOBSTERAI)
    expect(await resolver2.resolve(LOBSTERAI)).toMatchObject({ source: 'cache' })
  })

  it('clear() 后重新拉取', async () => {
    const fetcher = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const resolver = new LobsteraiClientVersionResolver({ fetcher })
    await resolver.resolve(LOBSTERAI)
    resolver.clear()
    await resolver.resolve(LOBSTERAI)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

/**
 * 手机号掩码与账号展示名。
 *
 * 用户要求（2026-09-27）：「lobsterai 的用户名字显示的手机号尾号漏出 4 位，
 * 现在也改为只漏出 2 位」。
 *
 * ⚠️ 关键事实：那个 `130****1100` 是**服务端下发的 `user.nickname` 原值**
 * （实测四个真实账号），不是本插件截取的 —— 故这里是**归一化**而非改 slice。
 */
describe('手机号掩码（只露末 2 位）', () => {
  it('服务端下发的「露 4 位」形态归一化为只露末 2 位', () => {
    // 实测原值（2026-09-27，四个真实账号）。
    expect(maskLobsteraiPhoneTail('130****1100')).toBe('130******00')
  })

  it('幂等：已归一化的值再跑一次结果不变', () => {
    const once = maskLobsteraiPhoneTail('130****1100')
    expect(maskLobsteraiPhoneTail(once)).toBe(once)
  })

  it('长度保持不变（星号个数按原串推算）', () => {
    for (const input of ['130****1100', '13000001100']) {
      expect(maskLobsteraiPhoneTail(input).length, input).toBe(input.length)
    }
  })

  it('空串与纯空白返回空串', () => {
    expect(maskLobsteraiPhoneTail('')).toBe('')
    expect(maskLobsteraiPhoneTail('   ')).toBe('')
  })

})

describe('lobsteraiDisplayNickname', () => {
  it('手机号昵称被掩码为只露末 2 位', () => {
    expect(lobsteraiDisplayNickname({ nickname: '130****1100' }, 'lobsterai-abc')).toBe('130******00')
  })

  it('真实昵称原样保留', () => {
    expect(lobsteraiDisplayNickname({ nickname: '测试账号' }, 'lobsterai-abc')).toBe('测试账号')
  })

  it('昵称为空 / 缺失时回退账号 id', () => {
    expect(lobsteraiDisplayNickname({ nickname: '' }, 'lobsterai-abc')).toBe('lobsterai-abc')
    expect(lobsteraiDisplayNickname({}, 'lobsterai-abc')).toBe('lobsterai-abc')
    expect(lobsteraiDisplayNickname(undefined, 'lobsterai-abc')).toBe('lobsterai-abc')
  })

  it('两端空白被裁掉（不显示空白昵称）', () => {
    expect(lobsteraiDisplayNickname({ nickname: '  130****1100  ' }, 'x')).toBe('130******00')
    expect(lobsteraiDisplayNickname({ nickname: '   ' }, 'x')).toBe('x')
  })
})
