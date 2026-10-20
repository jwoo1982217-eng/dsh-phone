/**
 * zcode-transport 的通道描述与选路（纯函数，零网络）。
 *
 * ## 为什么单独测这一层
 * 两条通道的可用性与选路是**纯函数**（只读凭据字段），不需要任何网络 ——
 * 把它单独测住，就能在不起浏览器、不发请求的情况下锁住路由决策。
 *
 * 背景见 `docs/superpowers/specs/2026-10-03-zcode-dual-channel-design.md`：
 * 官方按**套餐**分派 8 条网关规则（实测自 `resources/config/provider/zcode-builtin.json`）。
 */
import { describe, expect, it } from 'vitest'
import {
  ZCODE_BIZ_ORIGIN,
  buildChannelRequest,
  describeChannels,
  fetchCodingPlanApiKey,
  resolveChannelFor,
  shouldFallbackToOtherChannel,
} from '../../src/zcode-transport.js'
import type { ZcodeCredential } from '../../src/zcode.js'

/** 最小可用凭据（只给 transport 会读的字段）。 */
const base = (extra: Partial<ZcodeCredential> = {}): ZcodeCredential =>
  ({ zcode_jwt: 'jwt', device_mid: 'mid', ...extra }) as ZcodeCredential

describe('describeChannels', () => {
  it('★ 只有 zcode_jwt ⇒ 只有 start-plan 可用', () => {
    const byChannel = Object.fromEntries(describeChannels(base()).map((i) => [i.channel, i]))
    expect(byChannel['start-plan'].available).toBe(true)
    expect(byChannel['coding-plan'].available).toBe(false)
  })

  it('★ 有 coding_plan_key_zai ⇒ coding-plan 也可用', () => {
    const byChannel = Object.fromEntries(
      describeChannels(base({ coding_plan_key_zai: 'key' })).map((i) => [i.channel, i]),
    )
    expect(byChannel['coding-plan'].available).toBe(true)
  })

  it('★ 始终返回两条通道（available 只是标记，不隐藏）', () => {
    expect(describeChannels(base()).map((i) => i.channel).sort())
      .toEqual(['coding-plan', 'start-plan'])
  })

  it('★ coding-plan 认 bigmodel 侧的 key（两条腿对称）', () => {
    const byChannel = Object.fromEntries(
      describeChannels(base({ coding_plan_key_bigmodel: 'k' })).map((i) => [i.channel, i]),
    )
    expect(byChannel['coding-plan'].available).toBe(true)
  })

  it('★ 空字符串的 key 不算可用（避免"字段在但没值"被误判）', () => {
    const byChannel = Object.fromEntries(
      describeChannels(base({ coding_plan_key_zai: '' })).map((i) => [i.channel, i]),
    )
    expect(byChannel['coding-plan'].available).toBe(false)
  })

  it('★ 每条通道都声明自己承载的模型', () => {
    for (const info of describeChannels(base())) {
      expect(info.models.length, `${info.channel} 应声明模型`).toBeGreaterThan(0)
    }
  })

  it('★ coding-plan 只开官方 builtinModelIds 确认过的两个', () => {
    const coding = describeChannels(base()).find((i) => i.channel === 'coding-plan')
    // ⚠ 远端 /v1/models 有 11 个，但官方只承认 2 个（见 spec §9）
    expect([...(coding?.models ?? [])].sort()).toEqual(['glm-5.3', 'glm-5.3-flash'])
  })
})

describe('resolveChannelFor（start-plan 优先）', () => {
  it('★ 两条都可用时，GLM-5.3-Flash 走 start-plan（积分优先）', () => {
    expect(resolveChannelFor(base({ coding_plan_key_zai: 'k' }), 'GLM-5.3-Flash'))
      .toBe('start-plan')
  })

  it('★ coding-plan 专属的模型在两条都可用时走 coding-plan', () => {
    expect(resolveChannelFor(base({ coding_plan_key_zai: 'k' }), 'GLM-5.3'))
      .toBe('coding-plan')
  })

  it('★ coding-plan 不可用时 GLM-5.3 退回 start-plan（不抛错）', () => {
    expect(resolveChannelFor(base(), 'GLM-5.3')).toBe('start-plan')
  })

  it('★ 未知模型走 start-plan（保守：已验证可用的一条腿）', () => {
    expect(resolveChannelFor(base({ coding_plan_key_zai: 'k' }), 'GLM-9.9'))
      .toBe('start-plan')
  })

  it('★ 大小写不敏感（上游模型名形态不固定）', () => {
    expect(resolveChannelFor(base({ coding_plan_key_zai: 'k' }), 'glm-5.3'))
      .toBe('coding-plan')
    expect(resolveChannelFor(base({ coding_plan_key_zai: 'k' }), '  GLM-5.3  '))
      .toBe('coding-plan')
  })

  it('★ start-plan 的模型集合含 GLM-5.2 / GLM-5-Turbo（实测兜底表）', () => {
    for (const m of ['GLM-5.2', 'GLM-5-Turbo']) {
      expect(resolveChannelFor(base(), m), `${m} 应走 start-plan`).toBe('start-plan')
    }
  })
})

describe('常量', () => {
  it('ZCODE_BIZ_ORIGIN 是 https 绝对地址（2026-10-03 实测得出）', () => {
    expect(ZCODE_BIZ_ORIGIN).toMatch(/^https:\/\//)
  })

  it('★ ZCODE_BIZ_ORIGIN 是 api.z.ai（实测：chat.z.ai 回 404）', () => {
    expect(ZCODE_BIZ_ORIGIN).toBe('https://api.z.ai')
  })
})

describe('buildChannelRequest（URL + 凭据 + 头）', () => {
  it('★ start-plan 用 zcode.z.ai + zcode_jwt', () => {
    const req = buildChannelRequest(base(), 'start-plan', '{}')
    expect(req.url).toBe('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
    expect(req.headers.Authorization).toBe('Bearer jwt')
  })

  it('★ coding-plan 用 api.z.ai + coding_plan_key_zai', () => {
    const req = buildChannelRequest(base({ coding_plan_key_zai: 'ckey' }), 'coding-plan', '{}')
    expect(req.url).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(req.headers.Authorization).toBe('Bearer ckey')
  })

  it('★ coding-plan 在只有 bigmodel key 时用它', () => {
    const req = buildChannelRequest(base({ coding_plan_key_bigmodel: 'bkey' }), 'coding-plan', '{}')
    expect(req.headers.Authorization).toBe('Bearer bkey')
  })

  it('★ zai key 优先于 bigmodel key', () => {
    const req = buildChannelRequest(
      base({ coding_plan_key_zai: 'zkey', coding_plan_key_bigmodel: 'bkey' }),
      'coding-plan', '{}',
    )
    expect(req.headers.Authorization).toBe('Bearer zkey')
  })

  it('★ 两条通道都带 anthropic-version 与 X-Device-Mid', () => {
    for (const ch of ['start-plan', 'coding-plan'] as const) {
      const req = buildChannelRequest(base({ coding_plan_key_zai: 'k' }), ch, '{}')
      expect(req.headers['anthropic-version'], `${ch} 缺 anthropic-version`).toBe('2023-06-01')
      expect(req.headers['X-Device-Mid'], `${ch} 缺 X-Device-Mid`).toBe('mid')
      expect(req.headers['Content-Type'], `${ch} 缺 Content-Type`).toBe('application/json')
    }
  })

  it('★ ★ coding-plan 缺 key 时不返回 Authorization（由调用方判不可用）', () => {
    const req = buildChannelRequest(base(), 'coding-plan', '{}')
    expect(req.headers.Authorization).toBeUndefined()
  })

  it('★ ★ coding-plan 不带 zcode 的 HTTP-Referer（那是 zcode.z.ai 专属头）', () => {
    const withRef = buildChannelRequest(base(), 'start-plan', '{}')
    expect(withRef.headers['HTTP-Referer']).toBeDefined()
    const coding = buildChannelRequest(base({ coding_plan_key_zai: 'k' }), 'coding-plan', '{}')
    expect(coding.headers['HTTP-Referer'], 'coding-plan 不该带 HTTP-Referer').toBeUndefined()
  })

  it('★ 每次调用返回独立的头对象（不污染下一次）', () => {
    const first = buildChannelRequest(base({ coding_plan_key_zai: 'k1' }), 'coding-plan', '{}')
    first.headers.Authorization = 'Bearer tampered'
    const second = buildChannelRequest(base({ coding_plan_key_zai: 'k2' }), 'coding-plan', '{}')
    expect(second.headers.Authorization).toBe('Bearer k2')
  })
})

describe('fetchCodingPlanApiKey（三步，只 GET）', () => {
  const oauth = { ...base(), zai_access_token: 'oauth-tok' } as ZcodeCredential

  /**
   * `getCustomerInfo` 的**真实**响应形状（2026-10-03 实测）。
   * ⚠ 是 `data.organizations`（**数组**），不是 `data.organizationId` ——
   *   第一版按后者写，字段取不到，换取永远失败。
   */
  const INFO = {
    code: 200,
    data: {
      organizations: [{
        organizationId: 'org1',
        organizationName: '默认机构',
        projects: [{ projectId: 'proj1', projectName: '默认项目', projectType: '1' }],
      }],
    },
  }

  /**
   * 桩 fetch：按 URL 片段返回预设响应。
   *
   * ⚠ **必须用 if/else 链，不能用 `find` + 片段匹配** ——
   * `.../api_keys/copy/AK` 这个 URL **同时含** `/api_keys` 与 `/copy/`，
   * 任何「按片段长短排序」的写法都会先命中 `/api_keys`（它更长），
   * 于是 copy 那一步拿到数组而非 `{secretKey}`。
   * 第一版按插入顺序、第二版按长度降序，**都假失败了 4 条**。
   * ⇒ 正确做法是按**实际调用顺序**逐段判定。
   */
  function stubFetch(handlers: Record<string, unknown>) {
    return (async (url: string) => {
      const u = String(url)
      // 顺序 = 实际调用顺序：info → list → copy
      const pick = ['getCustomerInfo', '/copy/', '/api_keys']
        .find((k) => u.includes(k))
      if (pick === undefined) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(handlers[pick] ?? {}), { status: 200 })
    }) as unknown as typeof fetch
  }

  it('★ 完整链路返回 `{apiKey}.{secretKey}`', async () => {
    const r = await fetchCodingPlanApiKey(oauth, stubFetch({
      'getCustomerInfo': INFO,
      '/api_keys': [{ name: 'zcode-api-key', apiKey: 'AK' }],
      '/copy/': { secretKey: 'SK' },
    }))
    expect(r.key).toBe('AK.SK')
  })

  it('★ 没有 OAuth token ⇒ no-oauth-token（一个请求都不发）', async () => {
    const r = await fetchCodingPlanApiKey(base(), stubFetch({}))
    expect(r).toEqual({ key: undefined, reason: 'no-oauth-token' })
  })

  it('★ ★ key 名的正式值是 `zcode-api-key`（**不是** `zcode`）', async () => {
    const r = await fetchCodingPlanApiKey(oauth, stubFetch({
      'getCustomerInfo': INFO,
      '/api_keys': [{ name: 'zcode', apiKey: 'WRONG' }, { name: 'zcode-api-key', apiKey: 'AK' }],
      '/copy/': { secretKey: 'SK' },
    }))
    expect(r.key).toBe('AK.SK')
  })

  it('★ projectType==="2" 的条目被过滤（官方同款，否则取到错 projectId）', async () => {
    const seen: string[] = []
    const spy = (async (url: string) => {
      seen.push(String(url))
      const u = String(url)
      if (u.includes('getCustomerInfo')) {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            organizations: [{
              organizationId: 'org1',
              organizationName: '默认机构',
              projects: [
                { projectId: 'BAD', projectName: '默认项目', projectType: '2' },
                { projectId: 'proj1', projectName: '默认项目', projectType: '1' },
              ],
            }],
          },
        }))
      }
      return new Response('[]')
    }) as unknown as typeof fetch
    await fetchCodingPlanApiKey(oauth, spy)
    // 过滤生效 ⇒ URL 里的 projectId 是 proj1 而不是 BAD
    expect(seen.some((u) => u.includes('BAD'))).toBe(false)
    expect(seen.some((u) => u.includes('proj1'))).toBe(true)
  })

  it('★ 非「默认机构」时取第一个（官方同款兜底）', async () => {
    const r = await fetchCodingPlanApiKey(oauth, stubFetch({
      'getCustomerInfo': {
        code: 200,
        data: {
          organizations: [{
            organizationId: 'orgX',
            organizationName: '我的机构',
            projects: [{ projectId: 'projX', projectName: '我的项目', projectType: '1' }],
          }],
        },
      },
      '/api_keys': [{ name: 'zcode-api-key', apiKey: 'AK' }],
      '/copy/': { secretKey: 'SK' },
    }))
    expect(r.key).toBe('AK.SK')
  })

  it('★ organizations 为空 ⇒ no-org', async () => {
    const r = await fetchCodingPlanApiKey(oauth, stubFetch({
      'getCustomerInfo': { code: 200, data: { organizations: [] } },
    }))
    expect(r).toEqual({ key: undefined, reason: 'no-org' })
  })

  it('★ 没有 projects 的机构被跳过（官方同款 filter）', async () => {
    const r = await fetchCodingPlanApiKey(oauth, stubFetch({
      'getCustomerInfo': {
        code: 200,
        data: {
          organizations: [
            { organizationId: 'orgA', organizationName: '默认机构', projects: [] },
            { organizationId: 'orgB', organizationName: '别的', projects: [{ projectId: 'pB', projectName: 'x', projectType: '1' }] },
          ],
        },
      },
      '/api_keys': [{ name: 'zcode-api-key', apiKey: 'AK' }],
      '/copy/': { secretKey: 'SK' },
    }))
    expect(r.key).toBe('AK.SK')
  })

  it('★ ★ 绝不 POST 建 key（只用 GET）', async () => {
    const seen: string[] = []
    const spy = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'}`)
      const u = String(url)
      if (u.includes('getCustomerInfo')) return new Response(JSON.stringify(INFO))
      if (u.includes('/copy/')) return new Response(JSON.stringify({ secretKey: 'SK' }))
      return new Response(JSON.stringify([{ name: 'zcode-api-key', apiKey: 'AK' }]))
    }) as unknown as typeof fetch
    await fetchCodingPlanApiKey(oauth, spy)
    expect(seen.every((m) => m === 'GET')).toBe(true)
  })

  it('★ list 为空 ⇒ no-key（**不建 key**，官方那一支 POST 不复刻）', async () => {
    const r = await fetchCodingPlanApiKey(oauth, stubFetch({
      'getCustomerInfo': INFO,
      '/api_keys': [],
      '/copy/': { secretKey: 'SK' },
    }))
    expect(r).toEqual({ key: undefined, reason: 'no-key' })
  })

  it('★ 拿不到 secretKey ⇒ no-secret', async () => {
    const r = await fetchCodingPlanApiKey(oauth, stubFetch({
      'getCustomerInfo': INFO,
      '/api_keys': [{ name: 'zcode-api-key', apiKey: 'AK' }],
      '/copy/': {},
    }))
    expect(r).toEqual({ key: undefined, reason: 'no-secret' })
  })

  it('★ org/project 做 URL 编码（防注入）', async () => {
    const seen: string[] = []
    const spy = (async (url: string) => {
      seen.push(String(url))
      if (String(url).includes('getCustomerInfo')) {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            organizations: [{
              organizationId: 'o/../x',
              organizationName: '默认机构',
              projects: [{ projectId: 'p 1', projectName: '默认项目', projectType: '1' }],
            }],
          },
        }))
      }
      return new Response('[]')
    }) as unknown as typeof fetch
    await fetchCodingPlanApiKey(oauth, spy)
    expect(seen.some((u) => u.includes('o%2F..%2Fx'))).toBe(true)
    expect(seen.some((u) => u.includes('p%201'))).toBe(true)
  })

  it('★ 网络异常不抛出，返回 http-error', async () => {
    const boom = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const r = await fetchCodingPlanApiKey(oauth, boom)
    expect(r.key).toBeUndefined()
  })
})

describe('shouldFallbackToOtherChannel（哪些错误换腿，哪些不换）', () => {
  it('★ 1005 额度不足 ⇒ 换腿', () => {
    expect(shouldFallbackToOtherChannel(429, '{"code":1005}')).toBe(true)
  })
  it('★ 1113 无可用资源包 ⇒ 换腿', () => {
    expect(shouldFallbackToOtherChannel(429, '{"code":1113}')).toBe(true)
  })
  it('★ ★ 401/1002 凭据失效 ⇒ **不**换腿（换通道也是同一份凭据）', () => {
    expect(shouldFallbackToOtherChannel(401, '{"code":1002}')).toBe(false)
  })
  it('★ ★ 3012 风控 ⇒ 不换腿（重试会加重 30 分钟→24 小时→停用的冷却惩罚）', () => {
    expect(shouldFallbackToOtherChannel(403, '{"code":3012}')).toBe(false)
  })
  it('★ 3009 并发限流 ⇒ 不换腿（走既有退避，换腿治不了）', () => {
    expect(shouldFallbackToOtherChannel(429, '{"code":3009}')).toBe(false)
  })
  it('★ 500 服务端错 ⇒ 不换腿', () => {
    expect(shouldFallbackToOtherChannel(500, 'boom')).toBe(false)
  })
  it('★ 1005 但 HTTP 非 429 ⇒ 不换腿（判据含状态码，避免误伤别的端点）', () => {
    expect(shouldFallbackToOtherChannel(400, '{"code":1005}')).toBe(false)
    expect(shouldFallbackToOtherChannel(200, '{"code":1005}')).toBe(false)
  })
  it('★ 空 body ⇒ 不换腿', () => {
    expect(shouldFallbackToOtherChannel(429, '')).toBe(false)
  })
})
