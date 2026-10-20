import { describe, expect, it } from 'vitest'
import {
  applyClineRefresh,
  buildClineCredential,
  clineAuthHeaders,
  clineBearerValue,
  clineCredentialExpiresAtMs,
  clineHeaders,
  clineRefreshBody,
  isClineExpired,
  isClineRefreshable,
  parseClineTimestamp,
  parseClineTokenPayload,
  type ClineCredential,
} from '../../src/cline.js'
import { CLINE, ALL_CLINE_PRODUCTS, clineProductById } from '../../src/cline-product.js'

describe('Cline 产品配置', () => {
  it('端点常量与逆向结果一致', () => {
    // 依据：sidecar 的 CLINE_ENVIRONMENTS.production
    expect(CLINE.apiBase).toBe('https://api.cline.bot')
    expect(CLINE.appBase).toBe('https://app.cline.bot')
    expect(CLINE.workOsBase).toBe('https://api.workos.com')
    // workOsClientId 同时出现在 CLINE_ENVIRONMENTS 与凭据 JWT 的 client_id claim
    expect(CLINE.workOsClientId).toBe('client_01K3A541FN8TA3EPPHTD2325AR')
  })

  it('客户端标识头与源码 DEFAULT_CLINE_REQUEST_HEADERS 一致', () => {
    // 这四个头缺一不可（官方客户端身份声明）
    expect(CLINE.clientHeaders).toEqual({
      'HTTP-Referer': 'https://cline.bot',
      'X-Title': 'Cline',
      'X-IS-MULTIROOT': 'false',
      'X-CLIENT-TYPE': 'cline-sdk',
    })
  })

  it('令牌前缀是 workos:', () => {
    expect(CLINE.tokenPrefix).toBe('workos:')
  })

  it('默认凭据 ref 与其它 provider 隔离', () => {
    expect(CLINE.defaultCredentialRef).toBe('CLINE_ACCESS_TOKEN')
  })

  it('兜底表含远端 free 数组的全部免费模型', () => {
    // 远端 `recommended-models` 的 free 数组实测（2026-10-05 复测，共 **3** 个）。
    // ⚠️ 本表是**编译期快照**，上游每撤一个免费模型就要同步一次，已发生两次：
    // `gemini-3.8-flash`（2026-10-03）、`deepseek-v4.1-flash`（2026-10-05）——
    // 直连它们都回 `404 model not found`，故两处保持一致、都删掉。
    const freeIds = CLINE.fallbackModels.filter((m) => m.isFree === true).map((m) => m.id)
    expect(freeIds.sort()).toEqual([
      'cline-free/mimo-v2.6-flash',
      'cline-free/muse-spark-1.3-contributor',
      'stealth/space-bunny-alpha',
    ].sort())
  })

  it('兜底表 id 唯一', () => {
    const ids = CLINE.fallbackModels.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('免费模型是独立 id，付费同名模型不在兜底表里被标为免费', () => {
    // ⚠️ 核心不变式：`cline-free/*`（免费）与同名不带前缀的（按量计费）是
    // **两个不同的 id**，绝不能因为名字相似就把后者也当免费（用户会按免费预期
    // 使用却被计费）。
    //
    // ⚠️ 原先这里用 `cline-free/deepseek-v4.1-flash` 作免费侧；它已于 2026-10-05
    // 被 Cline 下架并从兜底表删除，故改用仍在册的免费条目。「同名也不判免费」的
    // 完整判定另见 `cline-models.spec.ts`。
    const byId = new Map(CLINE.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('cline-free/mimo-v2.6-flash')?.isFree).toBe(true)
    expect(byId.has('deepseek/deepseek-v4.1-flash')).toBe(false)
  })

  it('productById 只认 cline', () => {
    expect(clineProductById('cline')).toBe(CLINE)
    expect(clineProductById('qoder')).toBeUndefined()
    expect(ALL_CLINE_PRODUCTS).toEqual([CLINE])
  })
})

describe('Cline 令牌前缀（最容易踩的坑）', () => {
  it('已带前缀时原样返回（幂等）', () => {
    expect(clineBearerValue('workos:abc', CLINE)).toBe('workos:abc')
  })

  it('缺前缀时补上（对上游格式变更鲁棒）', () => {
    expect(clineBearerValue('abc', CLINE)).toBe('workos:abc')
  })

  it('空串保持空串（不产出裸前缀）', () => {
    expect(clineBearerValue('', CLINE)).toBe('')
    expect(clineBearerValue('   ', CLINE)).toBe('')
  })

  it('两端空白被裁掉', () => {
    expect(clineBearerValue('  workos:abc  ', CLINE)).toBe('workos:abc')
  })

  /**
   * 真实缺陷防护：源码 `resolveApiKey` **原样**使用存储值，前缀只在解码 JWT
   * 时被剥掉。实测剥掉前缀后 `/api/v1/users/me` 与推理端点**全部 401**，
   * 而报错文案是 "make sure you're using the latest version of Cline"
   * —— 与真实原因毫不相干，会让人误判成「版本过旧」。
   */
  it('鉴权头保留前缀（剥掉即 401）', () => {
    const headers = clineAuthHeaders('workos:eyJhbGci', CLINE)
    expect(headers.Authorization).toBe('Bearer workos:eyJhbGci')
    expect(headers.Authorization).not.toBe('Bearer eyJhbGci')
  })
})

describe('parseClineTimestamp', () => {
  it('ISO 8601 字符串（源码 toEpochMs 的真实形态）', () => {
    expect(parseClineTimestamp('2026-09-25T05:23:47.000Z')).toBe(Date.parse('2026-09-25T05:23:47.000Z'))
  })

  it('10 位数字视为秒', () => {
    expect(parseClineTimestamp(1790313827)).toBe(1790313827000)
  })

  it('13 位数字视为毫秒', () => {
    expect(parseClineTimestamp(1790313827000)).toBe(1790313827000)
  })

  it('非法值返回 undefined（不抛错）', () => {
    for (const value of [undefined, null, '', 'not-a-date', -1, 0, Number.NaN]) {
      expect(parseClineTimestamp(value), String(value)).toBeUndefined()
    }
  })
})

describe('parseClineTokenPayload', () => {
  /** 实测的注册/续期响应形状（`{success, data}` 信封 + 驼峰字段）。 */
  const envelope = {
    success: true,
    data: {
      accessToken: 'workos:eyJhbGciOiJSUzI1NiIs',
      refreshToken: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
      expiresAt: '2026-09-25T05:23:47.000Z',
      tokenType: 'Bearer',
      userInfo: {
        subject: 'user_01M3BCQ86DV4S9KKBT85X4GKTV',
        clineUserId: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
        email: 'ijetlee@163.com',
        firstName: '',
        lastName: '',
      },
    },
  }

  it('解析 {success, data} 信封（字段是驼峰）', () => {
    const payload = parseClineTokenPayload(envelope)
    expect(payload.accessToken).toBe('workos:eyJhbGciOiJSUzI1NiIs')
    expect(payload.refreshToken).toBe('tmgEeM2rd9ybYoWpXl8JqUfvK')
    expect(payload.expiresAt).toBe(Date.parse('2026-09-25T05:23:47.000Z'))
    expect(payload.accountId).toBe('usr-01M3BCV4FYCGJKAWD3MJG3DBQM')
    expect(payload.email).toBe('ijetlee@163.com')
  })

  it('账号 id 取 userInfo.clineUserId（余额端点必须用它）', () => {
    // ⚠️ 不是 JWT 的 sub（`user_…`）—— 实测传 sub 返回
    // `400 {"error":"Invalid request format"}`。
    const payload = parseClineTokenPayload(envelope)
    expect(payload.accountId).toBe('usr-01M3BCV4FYCGJKAWD3MJG3DBQM')
    expect(payload.accountId).not.toBe('user_01M3BCQ86DV4S9KKBT85X4GKTV')
  })

  it('兼容裸响应（无 data 信封）', () => {
    const payload = parseClineTokenPayload({ accessToken: 'workos:a', refreshToken: 'r' })
    expect(payload.accessToken).toBe('workos:a')
    expect(payload.refreshToken).toBe('r')
  })

  it('兼容下划线形态（对上游格式变更鲁棒）', () => {
    const payload = parseClineTokenPayload({
      success: true,
      data: { access_token: 'workos:a', refresh_token: 'r', expires_at: '2026-01-01T00:00:00Z' },
    })
    expect(payload.accessToken).toBe('workos:a')
    expect(payload.refreshToken).toBe('r')
    expect(payload.expiresAt).toBe(Date.parse('2026-01-01T00:00:00Z'))
  })

  it('垃圾输入返回空 accessToken 而不抛错', () => {
    for (const value of [undefined, null, 'str', 42, []]) {
      expect(parseClineTokenPayload(value).accessToken, String(value)).toBe('')
    }
  })

  it('displayName 由 firstName + lastName 拼接；全空白时不产出', () => {
    expect(parseClineTokenPayload({
      success: true,
      data: { accessToken: 'a', userInfo: { firstName: 'Jet', lastName: 'Lee' } },
    }).displayName).toBe('Jet Lee')
    // 实测该账号的 firstName/lastName 都是空串 → 不产出 displayName
    expect(parseClineTokenPayload(envelope).displayName).toBeUndefined()
  })
})

describe('Cline 凭据构造与续期合并', () => {
  it('buildClineCredential 幂等保留 workos: 前缀', () => {
    const credential = buildClineCredential(
      { accessToken: 'workos:eyJ', refreshToken: 'r', expiresAt: 123, accountId: 'usr-1', email: 'a@b.c' },
      CLINE,
    )
    expect(credential.access_token).toBe('workos:eyJ')
    expect(credential.refresh_token).toBe('r')
    expect(credential.expire_time).toBe(123)
    expect(credential.account_id).toBe('usr-1')
    expect(credential.email).toBe('a@b.c')
    // 昵称优先取邮箱（唯一且稳定）
    expect(credential.nickname).toBe('a@b.c')
  })

  it('buildClineCredential 给无前缀的令牌补前缀', () => {
    const credential = buildClineCredential({ accessToken: 'eyJ' }, CLINE)
    expect(credential.access_token).toBe('workos:eyJ')
  })

  it('applyClineRefresh 保留不在续期响应里的账号字段', () => {
    // ⚠️ 丢掉 account_id 会让余额查询永久失败（它按 account_id 拼 URL），
    // 丢掉 nickname 会让账号卡片失去展示名。
    const before: ClineCredential = {
      access_token: 'workos:old', refresh_token: 'r-old', expire_time: 1,
      account_id: 'usr-1', email: 'a@b.c', nickname: 'a@b.c',
    }
    const after = applyClineRefresh(before, { accessToken: 'workos:new', expiresAt: 2 }, CLINE)
    expect(after.access_token).toBe('workos:new')
    expect(after.expire_time).toBe(2)
    expect(after.account_id).toBe('usr-1')
    expect(after.email).toBe('a@b.c')
    expect(after.nickname).toBe('a@b.c')
  })

  it('续期响应未带新 refresh_token 时沿用旧的（不把可续期凭据变成不可续期）', () => {
    const before: ClineCredential = { access_token: 'workos:old', refresh_token: 'keep-me' }
    const after = applyClineRefresh(before, { accessToken: 'workos:new' }, CLINE)
    expect(after.refresh_token).toBe('keep-me')
    expect(isClineRefreshable(after)).toBe(true)
  })
})

describe('Cline 续期请求体（字段名是驼峰）', () => {
  it('用 refreshToken + grantType，不是 OAuth 标准的 refresh_token/grant_type', () => {
    // 依据：源码 `refreshClineToken` 的
    // `JSON.stringify({ refreshToken: current.refresh, grantType: "refresh_token" })`
    const body = clineRefreshBody({ access_token: 'workos:a', refresh_token: 'r-1' })
    expect(body).toEqual({ refreshToken: 'r-1', grantType: 'refresh_token' })
    expect(body).not.toHaveProperty('refresh_token')
    expect(body).not.toHaveProperty('grant_type')
  })

  it('无 refresh_token 时给出空串（服务端会拒，但结构完整）', () => {
    expect(clineRefreshBody({ access_token: 'workos:a' }).refreshToken).toBe('')
  })
})

describe('Cline 凭据判定', () => {
  it('isClineRefreshable 只看有无 refresh_token', () => {
    expect(isClineRefreshable({ access_token: 'a', refresh_token: 'r' })).toBe(true)
    expect(isClineRefreshable({ access_token: 'a' })).toBe(false)
    expect(isClineRefreshable({ access_token: 'a', refresh_token: '' })).toBe(false)
  })

  it('isClineExpired 无过期时间时保守视为未过期', () => {
    expect(isClineExpired({ access_token: 'a' }, Date.now())).toBe(false)
    expect(isClineExpired({ access_token: 'a', expire_time: 1000 }, 2000)).toBe(true)
    expect(isClineExpired({ access_token: 'a', expire_time: 2000 }, 1000)).toBe(false)
  })

  it('clineCredentialExpiresAtMs 读 expire_time', () => {
    expect(clineCredentialExpiresAtMs({ access_token: 'a', expire_time: 42 })).toBe(42)
    expect(clineCredentialExpiresAtMs({ access_token: 'a' })).toBeUndefined()
  })
})

describe('Cline 请求头', () => {
  it('clineHeaders 同时带前缀令牌与客户端标识头', () => {
    const headers = clineHeaders({ access_token: 'workos:eyJ' }, CLINE)
    expect(headers.Authorization).toBe('Bearer workos:eyJ')
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk')
    expect(headers['HTTP-Referer']).toBe('https://cline.bot')
  })

  it('额外头可覆盖（推理需要 text/event-stream）', () => {
    const headers = clineHeaders({ access_token: 'workos:eyJ' }, CLINE, { Accept: 'text/event-stream' })
    expect(headers.Accept).toBe('text/event-stream')
  })

  it('clineAuthHeaders 与 clineHeaders 同源（都经 clineBearerValue）', () => {
    const fromCredential = clineHeaders({ access_token: 'workos:eyJ' }, CLINE)
    const fromToken = clineAuthHeaders('workos:eyJ', CLINE)
    expect(fromToken.Authorization).toBe(fromCredential.Authorization)
  })
})
