/**
 * 与参考实现 `lobsterai2api` 的行为一致性测试（对齐契约）。
 *
 * 这些用例的价值在于**防止无声漂移**：上面每一条都对应 Go 侧一处具体的实现，
 * 一旦有人「凭直觉优化」（比如「刷新时应该更新 latest_keyfrom」、
 * 「400 换号没意义」），测试会立刻指出那会偏离参考实现。
 *
 * 每条断言都标注了 Go 侧的依据位置，便于回头核对。
 */

import { describe, expect, it } from 'vitest'
import {
  applyLobsteraiRefresh,
  lobsteraiKeyfromBody,
  lobsteraiRefreshBody,
  parseLobsteraiEnvelope,
  resolveLobsteraiUid,
} from '../../src/lobsterai.js'
import {
  classifyLobsteraiError,
  isLobsteraiTerminalError,
  recordsLobsteraiRateLimit,
  shouldRotateLobsteraiAccount,
} from '../../src/lobsterai-errors.js'
import { fetchLobsteraiCreditBalance } from '../../src/lobsterai-credits.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

const CLIENT_VERSION = '2026.9.4'

/** 构造一个假 JWT（带指定 claims），用于验证「不解 sub」这条契约。 */
function fakeJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function makeCredential(overrides: Partial<LobsteraiCredential> = {}): LobsteraiCredential {
  return {
    access_token: 'AT', refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    uid: 'uid-1', user_id: 'yid-1', nickname: '测试',
    uuid: 'uuid-1', first_keyfrom: '1700000000000', latest_keyfrom: '1700000000000',
    ...overrides,
  }
}

describe('uid 回退链严格四级（对齐 main.go:297-306）', () => {
  it('user.id → user.userId → user.yid → sha256 前 16 位', () => {
    expect(resolveLobsteraiUid({ accessToken: 'AT', refreshToken: '', userId: 'a', accountUserId: 'b', yid: 'c' })).toBe('a')
    expect(resolveLobsteraiUid({ accessToken: 'AT', refreshToken: '', userId: '', accountUserId: 'b', yid: 'c' })).toBe('b')
    expect(resolveLobsteraiUid({ accessToken: 'AT', refreshToken: '', userId: '', accountUserId: '', yid: 'c' })).toBe('c')
  })

  it('**不**使用 JWT sub 作回退（Go 没有这一级）', () => {
    // 这是曾经的缺陷：yid 与 sha256 之间插了一级 JWT sub，
    // 导致「服务端 user 字段皆空」的账号在本插件得到 sub、
    // 在 Go 得到 16 位哈希 —— 同一账号两种 uid，破坏与
    // auths/lobsterai-{uid}.json 的逐字节对照能力。
    const token = fakeJwt({ sub: 'jwt-subject-value' })
    const uid = resolveLobsteraiUid({
      accessToken: token, refreshToken: '', userId: '', accountUserId: '', yid: '',
    })
    expect(uid).not.toBe('jwt-subject-value')
    // 必须是 sha256(accessToken) 的前 16 位 hex。
    expect(uid).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('keyfrom 载荷（对齐 auth.go:37-50）', () => {
  it('latestKeyfrom 用**存储值**，不是当前时刻', () => {
    // Go 的 KeyfromBody() 读的是 a.LatestKeyfrom，而 RefreshToken 从不更新它。
    const body = lobsteraiKeyfromBody(makeCredential({ latest_keyfrom: '111' }), CLIENT_VERSION)
    expect(body.latestKeyfrom).toBe('111')
    // 若实现改为取当前时刻，这里会失败（当前时刻不可能恰好是 111）。
    expect(body.latestKeyfrom).not.toBe(String(Date.now()))
  })

  it('firstKeyfrom 同样用存储值', () => {
    const body = lobsteraiKeyfromBody(makeCredential({ first_keyfrom: '222' }), CLIENT_VERSION)
    expect(body.firstKeyfrom).toBe('222')
  })

  it('缺 first/latest 时以空串占位（字段仍存在，对齐 Go 的 map 构造）', () => {
    const body = lobsteraiKeyfromBody(
      makeCredential({ first_keyfrom: undefined, latest_keyfrom: undefined }), CLIENT_VERSION,
    )
    expect(body).toHaveProperty('firstKeyfrom', '')
    expect(body).toHaveProperty('latestKeyfrom', '')
  })

  it('uuid / userId 为空时**删除键**（对齐 Go 的 if != "" 写法）', () => {
    const body = lobsteraiKeyfromBody(makeCredential({ uuid: '', user_id: '' }), CLIENT_VERSION)
    expect(body).not.toHaveProperty('uuid')
    expect(body).not.toHaveProperty('userId')
  })

  it('refresh body = keyfrom + refreshToken（对齐 client.go:117-118）', () => {
    const body = lobsteraiRefreshBody(makeCredential({ latest_keyfrom: '333' }), CLIENT_VERSION)
    expect(body).toMatchObject({ latestKeyfrom: '333', refreshToken: 'RT' })
  })
})

describe('续期合并（对齐 client.go:137-145）', () => {
  it('只改 token 与过期时间，latest_keyfrom **保持不变**', () => {
    // Go 的 RefreshToken 不碰 LatestKeyfrom。语义上「刷新即活动」更直觉，
    // 但参考实现不更新，且它是唯一生产验证过的行为。
    const previous = makeCredential({ latest_keyfrom: '1700000000000' })
    const next = applyLobsteraiRefresh(
      previous, { accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 }, 1800000000000,
    )
    expect(next.access_token).toBe('AT2')
    expect(next.latest_keyfrom).toBe('1700000000000')
    expect(next.latest_keyfrom).not.toBe('1800000000000')
  })

  it('uuid / first_keyfrom 沿用旧值（丢了会让下次续期失败）', () => {
    const previous = makeCredential()
    const next = applyLobsteraiRefresh(previous, { accessToken: 'AT2', refreshToken: 'RT2' }, 1)
    expect(next.uuid).toBe('uuid-1')
    expect(next.first_keyfrom).toBe('1700000000000')
  })

  it('refresh 响应不带新 refreshToken 时沿用旧值（对齐 client.go:138-140）', () => {
    const next = applyLobsteraiRefresh(makeCredential(), { accessToken: 'AT2', refreshToken: '' }, 1)
    expect(next.refresh_token).toBe('RT')
  })

  it('expiresIn 优先、JWT exp 兜底（对齐 client.go:141-145）', () => {
    const withIn = applyLobsteraiRefresh(makeCredential(), { accessToken: 'AT2', refreshToken: 'R', expiresIn: 60 }, 1000)
    expect(withIn.expires_at).toBe('61000')
    const exp = Math.floor(Date.now() / 1000) + 3600
    const withJwt = applyLobsteraiRefresh(
      makeCredential(), { accessToken: fakeJwt({ exp }), refreshToken: 'R' }, 1,
    )
    expect(withJwt.expires_at).toBe(String(exp * 1000))
  })
})

describe('信封校验（对齐 sigin.py:44-48 与 main.go:147-149）', () => {
  it('code!=0 判失败', () => {
    expect(parseLobsteraiEnvelope({ code: 40100, msg: 'x' })).toMatchObject({ ok: false, code: 40100 })
  })

  it('code==0 但 data 为 null 判失败（凭据失效形态）', () => {
    expect(parseLobsteraiEnvelope({ code: 0, data: null })).toMatchObject({ ok: false })
  })

  it('code==0 且 data 为对象才算成功', () => {
    expect(parseLobsteraiEnvelope({ code: 0, data: { a: 1 } })).toEqual({ ok: true, data: { a: 1 } })
  })
})

describe('错误分类判定顺序（对齐 classify.go:66-93）', () => {
  it('402 优先于一切', () => {
    expect(classifyLobsteraiError(402, '40101 token rejected')).toBe('hard-credit')
  })

  it('中文关键词优先于状态码（上游用 400 + 中文表达余额耗尽）', () => {
    expect(classifyLobsteraiError(400, '你的积分不足')).toBe('hard-credit')
    expect(classifyLobsteraiError(400, 'insufficient credit')).toBe('hard-credit')
  })

  it('session-dead 优先于 429 / 404', () => {
    expect(classifyLobsteraiError(429, 'code 40101')).toBe('session-dead')
    expect(classifyLobsteraiError(404, 'token rejected')).toBe('session-dead')
  })

  it('状态码分支：429 / 404 / 5xx / 其他 4xx / 成功', () => {
    expect(classifyLobsteraiError(429, 'x')).toBe('soft-rate')
    expect(classifyLobsteraiError(404, 'x')).toBe('not-found')
    expect(classifyLobsteraiError(503, 'x')).toBe('server')
    expect(classifyLobsteraiError(400, 'x')).toBe('client')
    expect(classifyLobsteraiError(200, 'x')).toBe('none')
  })
})

describe('轮转策略（对齐 handler.go:218-243：每个分支都 continue）', () => {
  it('**所有**非成功类别都触发换号（含 404 / 5xx / client / session-dead）', () => {
    // Go 的 switch 每个 case 都以 continue 结尾，即「任何非 2xx 都轮转」。
    // 曾经只对 hard-credit / soft-rate 换号，并在注释里错误地声称
    // 「Go 对 client 类也不换号」—— 实际 NoteError 之后紧跟的就是 continue。
    for (const kind of ['hard-credit', 'soft-rate', 'session-dead', 'not-found', 'server', 'client'] as const) {
      expect(shouldRotateLobsteraiAccount(kind), kind).toBe(true)
    }
  })

  it('成功不触发换号', () => {
    expect(shouldRotateLobsteraiAccount('none')).toBe(false)
  })

  it('只有 Go 里真正 Cooldown 的三类记限流徽章', () => {
    // hard-credit→CoolHard、soft-rate→CoolSoft、not-found→CoolSoft
    // （handler.go:221-237）。session-dead 走 Disable、default 走 NoteError，
    // 都不写冷却时间 —— 若给它们也留徽章，会把「账号出过错」
    // 显示成「该模型限流 1 小时」，那是虚假信息。
    expect(recordsLobsteraiRateLimit('hard-credit')).toBe(true)
    expect(recordsLobsteraiRateLimit('soft-rate')).toBe(true)
    expect(recordsLobsteraiRateLimit('not-found')).toBe(true)
    expect(recordsLobsteraiRateLimit('session-dead')).toBe(false)
    expect(recordsLobsteraiRateLimit('server')).toBe(false)
    expect(recordsLobsteraiRateLimit('client')).toBe(false)
    expect(recordsLobsteraiRateLimit('none')).toBe(false)
  })

  it('只有 session-dead 是终态（此为本插件相对 Go 的**有意**改进）', () => {
    // Go 只判「响应里有没有 accessToken」，把网络抖动也当终态；
    // 本插件收敛为 401/403 或 40100/40101，避免误让用户重新登录。
    expect(isLobsteraiTerminalError('session-dead')).toBe(true)
    expect(isLobsteraiTerminalError('soft-rate')).toBe(false)
    expect(isLobsteraiTerminalError('client')).toBe(false)
  })
})

describe('余额 clamp（对齐 client.go:303-308）', () => {
  it('负余额 clamp 到 0（不显示「-12.5 积分」）', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      code: 0,
      data: { totalCreditsRemaining: -12.5, creditItems: [{ type: 'x', creditsRemaining: 5 }] },
    }), { status: 200 })) as unknown as typeof fetch
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.total).toBe(0)
  })

  it('失效包的负余额不拉低 expiredTotal', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        totalCreditsRemaining: 100,
        creditItems: [
          { type: 'valid', creditsRemaining: 100, expiresAt: '2099-01-01 00:00:00' },
          { type: 'expired-neg', creditsRemaining: -30, expiresAt: '2000-01-01 00:00:00' },
        ],
      },
    }), { status: 200 })) as unknown as typeof fetch
    const balance = await fetchLobsteraiCreditBalance(makeCredential(), LOBSTERAI, fetcher)
    expect(balance?.expiredTotal).toBe(0)
  })
})
