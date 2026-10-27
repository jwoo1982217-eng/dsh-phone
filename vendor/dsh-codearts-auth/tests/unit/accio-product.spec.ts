import { describe, expect, it } from 'vitest'
import {
  ACCIO,
  ACCIO_REGIONS,
  ACCIO_TOKEN_EXCHANGE_PATH,
  ACCIO_REFRESH_PATH,
  ACCIO_LLM_PATH,
  ACCIO_CATALOG_PATH,
  ACCIO_USERINFO_PATH,
  ACCIO_SUBSCRIPTION_PATH,
  ACCIO_QUOTA_PATH,
  ACCIO_REQUEST_TIMEOUT_MS,
  ACCIO_LOGIN_TIMEOUT_MS,
} from '../../src/accio-product.js'
import {
  accioCredentialExpiresAtMs,
  accioExpiresAtMs,
  isAccioExpired,
  isAccioRefreshable,
  accioToSnake,
  accioMessageId,
  buildAccioBody,
} from '../../src/accio.js'
import type { AccioCredential } from '../../src/accio.js'

describe('ACCIO 产品配置', () => {
  it('id 与展示名', () => {
    expect(ACCIO.id).toBe('accio')
    expect(ACCIO.displayName).toBe('Accio (阿里)')
  })

  it('⚠️ gateway 恒同一个，与区域无关', () => {
    expect(ACCIO.gatewayBaseUrl).toBe('https://phoenix-gw.alibaba.com')
  })

  it('⚠️ 区域 → 登录域映射', () => {
    expect(ACCIO_REGIONS).toEqual(['cn', 'global'])
    expect(ACCIO.loginBaseUrlOf('cn')).toBe('https://www.accio-ai.com')
    expect(ACCIO.loginBaseUrlOf('global')).toBe('https://zh.accio.com')
  })

  it('公开客户端常量', () => {
    expect(ACCIO.clientId).toBe('accio-work')
    expect(ACCIO.appKey).toBe('OneChat')
    expect(ACCIO.defaultCredentialRef).toBe('ACCIO_ACCESS_TOKEN')
  })

  it('端点路径', () => {
    expect(ACCIO_TOKEN_EXCHANGE_PATH).toBe('/api/oauth/token')
    expect(ACCIO_REFRESH_PATH).toBe('/api/auth/refresh_token')
    expect(ACCIO_LLM_PATH).toBe('/api/adk/llm/generateContent')
    expect(ACCIO_CATALOG_PATH).toBe('/api/llm/config/v2')
    expect(ACCIO_USERINFO_PATH).toBe('/api/auth/userinfo')
    expect(ACCIO_SUBSCRIPTION_PATH).toBe('/api/entitlement/currentSubscription')
    expect(ACCIO_QUOTA_PATH).toBe('/api/entitlement/quota')
  })

  it('超时', () => {
    expect(ACCIO_REQUEST_TIMEOUT_MS).toBe(30_000)
    expect(ACCIO_LOGIN_TIMEOUT_MS).toBe(600_000)
  })

  it('兜底表逐条镜像 2026-10-12 实测的 15 个可见模型', () => {
    expect(ACCIO.fallbackModels).toHaveLength(15)
    const cheapest = ACCIO.fallbackModels[0]
    expect(cheapest?.id).toBe('1Drift-N8kP2Q7wR5mX')
    expect(cheapest?.multiple).toBe(0.013)
    expect(cheapest?.contextWindow).toBe(512_000)
    expect(cheapest?.supportsImage).toBe(true)
    // ⚠️ 倍率升序：便宜的在前，无倍率的排最后
    const mults = ACCIO.fallbackModels.map((m) => m.multiple ?? Number.POSITIVE_INFINITY)
    expect([...mults]).toEqual([...mults].sort((a, b) => a - b))
  })
})

describe('AccioCredential 过期判定', () => {
  const base: AccioCredential = {
    access_token: 'a'.repeat(32),
    refresh_token: 'r'.repeat(128),
    expires_at: 1_700_000_000_000,
    region: 'cn',
  }

  it('⚠️⚠️ expires_at 是毫秒：秒级值会被判成「早已过期」', () => {
    // 上游给的是秒（约 2026-11-11）。若忘了 ×1000，这个值会让账号永远"过期"。
    const seconds = 1_794_407_698
    const asMs = seconds * 1000
    expect(new Date(asMs).getFullYear()).toBeGreaterThan(2025)
    // 直接当毫秒用 → 1970
    expect(new Date(seconds).getFullYear()).toBe(1970)
    expect(accioCredentialExpiresAtMs({ ...base, expires_at: asMs })).toBe(asMs)
  })

  it('过期判定用「当前时刻」比较', () => {
    expect(isAccioExpired({ ...base, expires_at: Date.now() - 1000 })).toBe(true)
    expect(isAccioExpired({ ...base, expires_at: Date.now() + 3_600_000 })).toBe(false)
  })

  it('可续期只要求 refresh_token 非空', () => {
    expect(isAccioRefreshable(base)).toBe(true)
    expect(isAccioRefreshable({ ...base, refresh_token: '' })).toBe(false)
  })

  it('expires_at 缺失/非法时返回 undefined（不伪装成 0）', () => {
    expect(accioCredentialExpiresAtMs({ ...base, expires_at: Number.NaN })).toBeUndefined()
  })
})

describe('accioExpiresAtMs —— 秒→毫秒归一化（量纲是安全关键）', () => {
  it('⚠️⚠️ 秒级入参必须 ×1000（去掉乘法此条必红）', () => {
    // 上游 expiresAt 实测是秒（约 2026-11-11）。忘了 ×1000 会让账号被判"永久过期"。
    expect(accioExpiresAtMs(1_794_407_698)).toBe(1_794_407_698_000)
  })

  it('已是毫秒时不得再乘（> 1e12 防御分支）', () => {
    expect(accioExpiresAtMs(1_794_407_698_000)).toBe(1_794_407_698_000)
  })

  it('非正数 / 非法值返回 undefined（不伪装成 0）', () => {
    expect(accioExpiresAtMs(0)).toBeUndefined()
    expect(accioExpiresAtMs(-1)).toBeUndefined()
    expect(accioExpiresAtMs('nope')).toBeUndefined()
  })
})

describe('buildAccioBody —— 信封硬约束', () => {
  const body = buildAccioBody({
    model: 'M',
    accessToken: 'TOK',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    utdid: 'U',
    requestId: 'R',
  })

  it('⚠️ token 必须在 body（放 Authorization 头恒流内 402）', () => {
    expect(body.token).toBe('TOK')
  })

  it('⚠️ empid / tenant / iai_tag 恒空串', () => {
    expect(body.empid).toBe('')
    expect(body.tenant).toBe('')
    expect(body.iai_tag).toBe('')
  })

  it('⚠️ message_id 必填且是 32 位小写十六进制', () => {
    expect(String(body.message_id)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('⚠️ properties 子树保持实测形状：appKey 驼峰 + normalized_response snake', () => {
    expect(body.properties).toEqual({
      utdid: 'U',
      version: '0.34.4',
      appKey: 'OneChat',
      normalized_response: 'true',
    })
  })

  it('systemInstruction 为空时不产出 system_instruction 键', () => {
    expect(Object.hasOwn(body, 'system_instruction')).toBe(false)
  })

  it('⚠️⚠️ system_instruction 必须是【字符串】，不是 { parts: [...] } 对象', () => {
    // 真机实测（Task 6）：对象形态**恒回 HTTP 200 + 流内 400**。
    // 权威证据（官方 proto，gateway-worker.js）：
    //   systemInstruction: gt(e.systemInstruction) ? globalThis.String(e.systemInstruction) : …
    // 初版照 Gemini 的 systemInstruction.parts 形态产出对象 ⇒ 缺陷；
    // 本用例是那条缺陷的守卫（改回对象形态会立刻变红）。
    const withSystem = buildAccioBody({
      model: 'M',
      accessToken: 'TOK',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: '你是助手',
      utdid: 'U',
      requestId: 'R',
    })
    expect(typeof withSystem.system_instruction).toBe('string')
    expect(withSystem.system_instruction).toBe('你是助手')
  })

  it('键名已 snake_case 化（request_id / message_id）', () => {
    expect(Object.hasOwn(body, 'request_id')).toBe(true)
    expect(Object.hasOwn(body, 'message_id')).toBe(true)
  })
})

describe('accioToSnake —— camelCase → snake_case（递归）', () => {
  it('递归转换对象键，数组逐项', () => {
    expect(accioToSnake({ maxOutputTokens: 32, systemInstruction: { parts: [] } }))
      .toEqual({ max_output_tokens: 32, system_instruction: { parts: [] } })
    expect(accioToSnake({ contents: [{ functionCall: { argsJson: '{}' } }] }))
      .toEqual({ contents: [{ function_call: { args_json: '{}' } }] })
  })

  it('⚠️ undefined 的键整个丢掉（不能产出 undefined 值）', () => {
    expect(accioToSnake({ a: 1, b: undefined })).toEqual({ a: 1 })
    expect(Object.hasOwn(accioToSnake({ a: 1, b: undefined }), 'b')).toBe(false)
  })

  it('标量与 null 原样', () => {
    expect(accioToSnake('x')).toBe('x')
    expect(accioToSnake(1)).toBe(1)
    expect(accioToSnake(null)).toBeNull()
  })
})

describe('accioMessageId', () => {
  it('⚠️ 是 md5 hex（32 位小写十六进制）—— 上游缺它即 400', () => {
    const id = accioMessageId('req-123')
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('同一入参两次调用不相同（掺了随机量）', () => {
    expect(accioMessageId('req-123')).not.toBe(accioMessageId('req-123'))
  })
})
