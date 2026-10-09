import { describe, expect, it } from 'vitest'
import {
  MINIMAX,
  MINIMAX_DEVICE_CODE_PATH,
  MINIMAX_MODELS_PATH,
  MINIMAX_SIGNIN_CLAIM_PATH,
  MINIMAX_SIGNIN_STATUS_PATH,
  MINIMAX_CREDIT_DETAILS_PATH,
} from '../../src/minimax-product.js'
import {
  minimaxCredentialExpiresAtMs,
  normalizeMinimaxModel,
  type MinimaxCredential,
} from '../../src/minimax.js'

/**
 * 造一个**真实形态**的 MiniMax token。
 *
 * ⚠️ 实测（复审者 2026-09-28 读本机凭据形状）：`access_token` 前缀 `mmoat_`、
 * **60 字符、0 个点** —— **不是 JWT**。用 JWT 造 token 会掩盖「过期时间必须来自
 * `expires_in`」这一实测事实，故真实形态的用例**必须**用这个 helper。
 */
function realAccessToken(): string {
  return `mmoat_${'a'.repeat(54)}`
}

/** 造一个三段式 JWT（仅用于验证「上游将来改发 JWT」的兼容路径）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`
}

describe('MINIMAX 产品配置', () => {
  it('中国版 prod 的 host 与 OAuth 常量', () => {
    expect(MINIMAX.id).toBe('minimax')
    expect(MINIMAX.accountHost).toBe('https://account.minimax.cn')
    expect(MINIMAX.apiHost).toBe('https://agent.minimax.cn')
    expect(MINIMAX.region).toBe('cn')
    expect(MINIMAX.buildEnv).toBe('prod')
    expect(MINIMAX.clientId).toBe('mcode-public')
    expect(MINIMAX.audience).toBe('agent-backend')
    expect(MINIMAX.scope).toBe('agent.default')
    expect(MINIMAX.defaultCredentialRef).toBe('MINIMAX_ACCESS_TOKEN')
  })

  it('端点路径', () => {
    expect(MINIMAX_DEVICE_CODE_PATH).toBe('/oauth2/device/code')
    expect(MINIMAX_MODELS_PATH).toBe('/mavis/api/v1/models')
    expect(MINIMAX_SIGNIN_STATUS_PATH).toBe('/minimax-cloud/api/v1/signin/status')
    expect(MINIMAX_SIGNIN_CLAIM_PATH).toBe('/minimax-cloud/api/v1/signin/claim')
    expect(MINIMAX_CREDIT_DETAILS_PATH).toBe('/minimax-cloud/api/v1/credit/details')
  })

  it('兜底表逐条镜像远端实测值', () => {
    expect(MINIMAX.fallbackModels.map((m) => m.id)).toEqual([
      'MiniMax-M3.1-Flash-Preview',
      'MiniMax-M3',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.7',
    ])
    const [m31, m3, hs, m27] = MINIMAX.fallbackModels
    // ⚠️ 档位表有 1M 档就填 1M（与 Qoder 同口径）
    expect(m31.contextWindow).toBe(1_000_000)
    expect(m3.contextWindow).toBe(1_000_000)
    expect(hs.contextWindow).toBe(200_000)
    expect(m27.contextWindow).toBe(200_000)
    expect(m31.maxTokens).toBe(128_000)
    expect(m3.supportsImage).toBe(true)
    expect(hs.supportsImage).toBe(false)
  })

  it('⚠️ 只有 M3.1-Flash-Preview 有档位', () => {
    const withEffort = MINIMAX.fallbackModels.filter((m) => m.effortOptions !== undefined)
    expect(withEffort.map((m) => m.id)).toEqual(['MiniMax-M3.1-Flash-Preview'])
    expect(withEffort[0]?.effortOptions).toEqual([
      'default', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(withEffort[0]?.defaultEffort).toBe('default')
  })

  it('⚠️ 兜底表的窗口与远端归一口径一致（改归一规则忘改兜底表时这条会红）', () => {
    // 兜底表的值是**人工按实测口径填好的字面量**，`fallbackToEntry` 只搬运、
    // 不调用 `normalizeMinimaxModel` —— 两条路径只共用**形状**，不共用规则。
    // 故必须用这条断言把「口径一致性」显式锁住。
    const fallback = MINIMAX.fallbackModels.find((m) => m.id === 'MiniMax-M3.1-Flash-Preview')
    expect(fallback?.contextWindow).toBe(1_000_000)

    // 等价远端输入（实测原文）
    const remote = normalizeMinimaxModel({
      id: 'MiniMax-M3.1-Flash-Preview',
      name: 'M3.1-Flash-Preview',
      limit: { context: 512_000, output: 128_000 },
      context_window_options: [512_000, 1_000_000],
      modalities: { input: ['text', 'image'] },
      effort_options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'default',
    })
    expect(remote).toBeDefined()
    // 窗口口径：档位表最大档（**不是** limit.context 的 512K）
    expect(remote?.contextWindow).toBe(fallback?.contextWindow)
    expect(remote?.contextWindow).toBe(1_000_000)
  })
})

describe('normalizeMinimaxModel —— 远端与兜底共用', () => {
  it('取 context_window_options 最大档作为窗口', () => {
    const entry = normalizeMinimaxModel({
      id: 'MiniMax-M3.1-Flash-Preview',
      name: 'M3.1-Flash-Preview',
      limit: { context: 512_000, output: 128_000 },
      context_window_options: [512_000, 1_000_000],
      modalities: { input: ['text', 'image'] },
      effort_options: ['default', 'max'],
      default_effort: 'default',
    })
    expect(entry?.id).toBe('MiniMax-M3.1-Flash-Preview')
    expect(entry?.name).toBe('M3.1-Flash-Preview')
    expect(entry?.contextWindow).toBe(1_000_000)
    expect(entry?.maxTokens).toBe(128_000)
    expect(entry?.supportsImage).toBe(true)
    expect(entry?.effortOptions).toEqual(['default', 'max'])
    expect(entry?.defaultEffort).toBe('default')
  })

  it('⚠️ id 与 name 分别取（远端 key 是长名、name 是短名）', () => {
    const entry = normalizeMinimaxModel({ id: 'MiniMax-M3', name: 'M3', limit: { context: 1000 } })
    expect(entry?.id).toBe('MiniMax-M3')
    expect(entry?.name).toBe('M3')
  })

  it('缺 name 时用 id 兜底', () => {
    const entry = normalizeMinimaxModel({ id: 'MiniMax-M3', limit: { context: 1000 } })
    expect(entry?.name).toBe('MiniMax-M3')
  })

  it('无档位表时回退 limit.context', () => {
    const entry = normalizeMinimaxModel({
      id: 'MiniMax-M2.7',
      name: 'M2.7',
      limit: { context: 200_000, output: 128_000 },
      modalities: { input: ['text'] },
    })
    expect(entry?.contextWindow).toBe(200_000)
    expect(entry?.effortOptions).toBeUndefined()
  })

  it('⚠️ default_effort 不在 effort_options 内时丢弃该字段（不发非法默认档）', () => {
    const entry = normalizeMinimaxModel({
      id: 'X',
      limit: { context: 1000 },
      effort_options: ['low', 'high'],
      default_effort: 'max',
    })
    expect(entry?.effortOptions).toEqual(['low', 'high'])
    expect(entry?.defaultEffort).toBeUndefined()
  })

  it('⚠️ 非法 maxTokens 被丢弃（0 / 负数 / NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS）', () => {
    expect(normalizeMinimaxModel({ id: 'A', limit: { context: 1000, output: 0 } })?.maxTokens)
      .toBeUndefined()
    expect(normalizeMinimaxModel({ id: 'A', limit: { context: 1000, output: -5 } })?.maxTokens)
      .toBeUndefined()
  })

  it('⚠️ 合法 limit.output 产出 maxTokens；非法时**整个键不产出**（`in` 与 undefined 语义不同）', () => {
    // 合法：键存在且值正确
    const ok = normalizeMinimaxModel({ id: 'A', limit: { context: 1000, output: 128_000 } })
    expect(ok).toBeDefined()
    expect(ok?.maxTokens).toBe(128_000)
    expect('maxTokens' in (ok as object)).toBe(true)

    // 非法：**键本身不存在** —— 不是「存在且为 undefined」。
    // 两者对 `Object.keys` / 展开 / `in` 判定不同，故用 `in` 锁住，
    // 避免将来把实现改成 `maxTokens: undefined`（那会让 `in` 恒为 true，
    // 并让「可选键未产出」这一约定静默失效）。
    for (const output of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '128000', null]) {
      const bad = normalizeMinimaxModel({ id: 'A', limit: { context: 1000, output } })
      expect(bad).toBeDefined()
      expect('maxTokens' in (bad as object)).toBe(false)
      expect(bad?.maxTokens).toBeUndefined()
    }

    // 缺失 limit.output 同样不产出该键
    const missing = normalizeMinimaxModel({ id: 'A', limit: { context: 1000 } })
    expect('maxTokens' in (missing as object)).toBe(false)
  })

  it('缺 id 与 name 时返回 undefined', () => {
    expect(normalizeMinimaxModel({ limit: { context: 1000 } })).toBeUndefined()
    expect(normalizeMinimaxModel(null)).toBeUndefined()
  })

  it('⚠️ 读不到窗口时用 0 哨兵（0 不是合法窗口，调用方必须判 >0）', () => {
    const entry = normalizeMinimaxModel({ id: 'A' })
    expect(entry).toBeDefined()
    expect(entry?.contextWindow).toBe(0)
    // 而且 0 不是「编造的小窗口」—— 它就是「未知」
    expect(entry?.contextWindow).not.toBeGreaterThan(0)
  })
})

describe('minimaxCredentialExpiresAtMs', () => {
  it('⚠️⚠️ 真实形态 token（非 JWT）下，过期时间取 expires_at', () => {
    const credential: MinimaxCredential = {
      access_token: realAccessToken(),
      expires_at: '1800000000000',
    }
    expect(minimaxCredentialExpiresAtMs(credential)).toBe(1_800_000_000_000)
  })

  it('⚠️ 真实形态 token 且无 expires_at → undefined（不编造过期时间）', () => {
    // 这正是「登录时必须写入 expires_at」的理由：写漏了这里就永远读不到过期时间
    expect(minimaxCredentialExpiresAtMs({ access_token: realAccessToken() })).toBeUndefined()
  })

  it('JWT 形态 token 无 expires_at 时能从 exp 解出（上游改发 JWT 的兼容路径）', () => {
    const credential: MinimaxCredential = {
      access_token: makeJwt({ exp: 4_000_000_000 }),
    }
    expect(minimaxCredentialExpiresAtMs(credential)).toBe(4_000_000_000 * 1000)
  })

  it('⚠️⚠️ 两者都给且**冲突**时以 expires_at 为准（这条锁住优先序本身）', () => {
    // 只用「非 JWT token」或「只有其中一方」的用例**无法区分优先序** ——
    // 因为真实 token 不是 JWT，两个顺序的结果恰好相同。
    // 唯一能区分的是：**JWT 形态的 token + 与之冲突的 expires_at**。
    const credential: MinimaxCredential = {
      access_token: makeJwt({ exp: 4_000_000_000 }),
      expires_at: '1800000000000',
    }
    expect(minimaxCredentialExpiresAtMs(credential)).toBe(1_800_000_000_000)
    expect(minimaxCredentialExpiresAtMs(credential)).not.toBe(4_000_000_000 * 1000)
  })

  it('⚠️ expires_at 非法时回退 JWT，而不是返回 NaN', () => {
    // ⚠️ 必须**参数化**覆盖：只测 `'not-a-number'` 抓不住「丢掉 `> 0` 守卫」的变异
    //（实测：删掉 `&& parsed > 0` 后全部用例仍绿）。`'0'` / `'-1'` 正是该守卫的防线
    // ——放行 `'0'` 会让 `isMinimaxExpired` 的 `nowMs >= 0` 恒真 ⇒ **误报过期**、
    // 每次使用都触发无谓续期。
    for (const bad of ['not-a-number', '0', '-1', '', '   ', '1e12', '123abc']) {
      const credential: MinimaxCredential = {
        access_token: makeJwt({ exp: 4_000_000_000 }),
        expires_at: bad,
      }
      expect(minimaxCredentialExpiresAtMs(credential)).toBe(4_000_000_000 * 1000)
    }
  })

  it('⚠️ 无 JWT 且 expires_at 非法 → undefined（不得产出 NaN / 0 / 负数）', () => {
    for (const bad of ['0', '-1', '', 'not-a-number']) {
      const value = minimaxCredentialExpiresAtMs({
        access_token: realAccessToken(),
        expires_at: bad,
      })
      expect(value).toBeUndefined()
    }
  })

  it('⚠️ expires_at 兼容**秒级**时间戳（照 buddy 的既有约定）', () => {
    // 秒级值若不换算，会被当成 1970 年 ⇒ 恒判已过期
    const credential: MinimaxCredential = {
      access_token: realAccessToken(),
      expires_at: '1790607756',
    }
    expect(minimaxCredentialExpiresAtMs(credential)).toBe(1_790_607_756_000)
  })

  it('⚠️ JWT 的 exp 极大（乘 1000 溢出成 Infinity）时返回 undefined', () => {
    // Infinity 会被下游当成「永不过期」的有效时刻 —— 宁可返回 undefined
    const value = minimaxCredentialExpiresAtMs({
      access_token: makeJwt({ exp: 1e308 }),
    })
    expect(value).toBeUndefined()
  })
})
