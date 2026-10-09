import { describe, expect, it } from 'vitest'
import { createDecipheriv } from 'node:crypto'
import {
  RACCOON_PHONE_CIPHER_SECRET,
  RACCOON_TOKEN_REFRESH_WINDOW_SECONDS,
  decodeJwtExpMs,
  encryptRaccoonPhone,
  isRaccoonExpired,
  isRaccoonRefreshable,
  raccoonCredentialExpiresAtMs,
  raccoonDisplayName,
  type RaccoonCredential,
  type RaccoonModelMeta,
} from '../../src/raccoon.js'

/** 造一个最小可用的 JWT（header.payload.signature，签名不校验）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function credentialOf(patch: Partial<RaccoonCredential> = {}): RaccoonCredential {
  return { access_token: 'a', refresh_token: 'r', ...patch }
}

function metaOf(patch: Partial<RaccoonModelMeta> = {}): RaccoonModelMeta {
  return {
    id: 'sn-glm-5-3',
    description: 'GLM-5-3',
    effectiveMultiplier: 0.75,
    baseMultiplier: 0.75,
    status: 'normal',
    statusNote: '',
    ...patch,
  }
}

describe('decodeJwtExpMs', () => {
  it('从 payload 的 exp（秒）换算出毫秒时间戳', () => {
    const token = makeJwt({ exp: 1_790_412_721 })
    expect(decodeJwtExpMs(token)).toBe(1_790_412_721_000)
  })

  it('exp 缺失时返回 undefined（不编造过期时间）', () => {
    expect(decodeJwtExpMs(makeJwt({ sub: 'x' }))).toBeUndefined()
  })

  it('非 JWT 字符串返回 undefined 而不抛错', () => {
    expect(decodeJwtExpMs('not-a-jwt')).toBeUndefined()
    expect(decodeJwtExpMs('')).toBeUndefined()
    // base64url 段是合法 JSON 但类型不对
    expect(decodeJwtExpMs('a.' + Buffer.from('"str"').toString('base64url') + '.c')).toBeUndefined()
  })

  it('exp 不是正数时返回 undefined', () => {
    expect(decodeJwtExpMs(makeJwt({ exp: 0 }))).toBeUndefined()
    expect(decodeJwtExpMs(makeJwt({ exp: -1 }))).toBeUndefined()
    expect(decodeJwtExpMs(makeJwt({ exp: 'x' }))).toBeUndefined()
  })
})

describe('过期判定', () => {
  it('无 expires_at 时视为不过期（宁可试，也不凭猜测阻止用户）', () => {
    expect(isRaccoonExpired(credentialOf())).toBe(false)
    expect(raccoonCredentialExpiresAtMs(credentialOf())).toBeUndefined()
  })

  it('expires_at 已过则判过期', () => {
    const past = String(Date.now() - 1000)
    expect(isRaccoonExpired(credentialOf({ expires_at: past }))).toBe(true)
  })

  it('expires_at 未到则不过期', () => {
    const future = String(Date.now() + 3_600_000)
    expect(isRaccoonExpired(credentialOf({ expires_at: future }))).toBe(false)
  })

  it('expires_at 非法（空串/NaN）时**回退到 JWT 的 exp**（不是当作永不过期）', () => {
    // ⚠️ 真实缺陷回归：早期实现只读 expires_at，缺它时过期判定恒为 false
    // → refreshAll 永远跳过这些账号 → 凭据悄悄过期、续期从不触发。
    const futureMs = (Math.floor(Date.now() / 1000) + 3600) * 1000
    const pastMs = (Math.floor(Date.now() / 1000) - 3600) * 1000

    // JWT 未过期 + expires_at 脏值 → 不过期
    expect(raccoonCredentialExpiresAtMs(credentialOf({
      access_token: makeJwt({ exp: futureMs / 1000 }), expires_at: 'abc',
    }))).toBe(futureMs)
    expect(isRaccoonExpired(credentialOf({
      access_token: makeJwt({ exp: futureMs / 1000 }), expires_at: '',
    }))).toBe(false)

    // JWT 已过期 + 无 expires_at → 判过期（这样续期才会触发）
    expect(isRaccoonExpired(credentialOf({
      access_token: makeJwt({ exp: pastMs / 1000 }),
    }))).toBe(true)
    expect(raccoonCredentialExpiresAtMs(credentialOf({
      access_token: makeJwt({ exp: pastMs / 1000 }),
    }))).toBe(pastMs)
  })

  it('expires_at 优先于 JWT（显式字段更权威）', () => {
    const explicit = Date.now() + 1000
    expect(raccoonCredentialExpiresAtMs(credentialOf({
      access_token: makeJwt({ exp: (Date.now() + 999_999_999) / 1000 }),
      expires_at: String(explicit),
    }))).toBe(explicit)
  })

  it('既无 expires_at 也非 JWT 时返回 undefined（视为无过期信息）', () => {
    expect(raccoonCredentialExpiresAtMs(credentialOf({ access_token: 'not-a-jwt' }))).toBeUndefined()
    expect(isRaccoonExpired(credentialOf({ access_token: 'not-a-jwt' }))).toBe(false)
  })
})

describe('isRaccoonRefreshable', () => {
  it('有非空 refresh_token 才可续期', () => {
    expect(isRaccoonRefreshable(credentialOf({ refresh_token: 'r' }))).toBe(true)
    expect(isRaccoonRefreshable(credentialOf({ refresh_token: '' }))).toBe(false)
    expect(isRaccoonRefreshable(credentialOf({ refresh_token: '   ' }))).toBe(false)
  })
})

describe('encryptRaccoonPhone', () => {
  it('固定 iv 时输出确定（用于单测；生产路径用随机 iv）', () => {
    const iv = Buffer.alloc(16, 0)
    const out = encryptRaccoonPhone('13800000000', iv)
    // 结构：Base64(iv ‖ ciphertext)，iv 16 字节 + 明文 11 字节 = 27 字节
    const raw = Buffer.from(out, 'base64')
    expect(raw.length).toBe(27)
    expect(raw.subarray(0, 16).equals(iv)).toBe(true)
  })

  it('密文可解密还原（验证算法是 AES-128-CFB 且无填充）', () => {
    const out = encryptRaccoonPhone('13800000000', Buffer.alloc(16, 0))
    const raw = Buffer.from(out, 'base64')
    const d = createDecipheriv(
      'aes-128-cfb',
      Buffer.from(RACCOON_PHONE_CIPHER_SECRET, 'utf8'),
      raw.subarray(0, 16),
    )
    d.setAutoPadding(false)
    const plain = Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8')
    expect(plain).toBe('13800000000')
  })

  it('两次调用（随机 iv）产生不同密文，但长度一致', () => {
    const a = encryptRaccoonPhone('13800000000')
    const b = encryptRaccoonPhone('13800000000')
    expect(a).not.toBe(b)
    expect(Buffer.from(a, 'base64').length).toBe(Buffer.from(b, 'base64').length)
  })
})

describe('raccoonDisplayName', () => {
  it('常态拼 x 倍率', () => {
    expect(raccoonDisplayName(metaOf({ description: 'GLM-5-3', effectiveMultiplier: 0.75 })))
      .toBe('GLM-5-3 · x0.75')
  })

  it('倍率为 0 显示「免费」而不是 x0', () => {
    expect(raccoonDisplayName(metaOf({
      description: 'SenseNova-6.8-Flash', effectiveMultiplier: 0, baseMultiplier: 0.5,
    }))).toBe('SenseNova-6.8-Flash · 免费')
  })

  it('促销时显示 原价→折后价（与 TRAE/buddy 形态统一）', () => {
    expect(raccoonDisplayName(metaOf({
      description: 'GLM-5-3-Flash', baseMultiplier: 0.2, effectiveMultiplier: 0.1,
      status: 'discount', statusNote: '限时折扣',
    }))).toBe('GLM-5-3-Flash · x0.2→x0.1')
  })

  it('倍率非有限数时不追加后缀（不产出「模型名 · 」这种孤立分隔符）', () => {
    expect(raccoonDisplayName(metaOf({ description: 'X', effectiveMultiplier: Number.NaN })))
      .toBe('X')
  })

  it('**倍率恒为 1 时也要显示**（用户报障：IDE 显示 1 倍，我们也必须显示）', () => {
    // ⚠️ 早期按「1 倍是默认，显示属噪声」省略，导致该模型看起来没有计费信息
    // —— 用户无法区分「它就是 1 倍」与「我们没取到倍率」。
    expect(raccoonDisplayName(metaOf({ description: 'Kimi-K3', effectiveMultiplier: 1 })))
      .toBe('Kimi-K3 · x1')
  })

  it('description 为空时回退到 id（倍率照常追加）', () => {
    expect(raccoonDisplayName(metaOf({ id: 'sn-x', description: '', effectiveMultiplier: 1 })))
      .toBe('sn-x · x1')
  })
})

describe('常量', () => {
  it('刷新提前窗口是 300 秒（与官方 scheduleAuth.js 一致）', () => {
    expect(RACCOON_TOKEN_REFRESH_WINDOW_SECONDS).toBe(300)
  })
  it('手机号加密密钥与客户端一致', () => {
    expect(RACCOON_PHONE_CIPHER_SECRET).toBe('senseraccoon2023')
  })
})
