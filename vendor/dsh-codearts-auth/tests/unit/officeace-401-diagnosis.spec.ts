/**
 * `officeace-401-diagnosis.spec.ts` —— 401 的**归因**与「续期一次再重发」的**有效性判据**。
 *
 * ## 背景（Gitee issue IKLTHB 第 ② 条，真实报障）
 *
 * 2026-10-14 23:13 起 264+ 次连续失败，报文恒为：
 *
 * ```
 * OfficeAce (华为MaaS) 返回 HTTP 401：{"error_msg":"AppKey or AppSecret is invalid",
 *                                     "error_code":"APIG.1009"}
 * （Basic 凭据失效：OfficeAce 会话已过期，请重新登录 OfficeAce 客户端）
 * ```
 *
 * 两处都错，且各有硬证据：
 *
 * | # | 症状 | 证据 |
 * |---|---|---|
 * | 1 | 那句括号里的指引**是错的** | 用户按它重新登录：`credentialRef` 变了（`OFFICEACE_ACCOUNT_651558E5` → `F1557964`）、整条 STS 变了，而 `modelAppKey`/`modelAppSecret` **逐字节不变** ⇒ 重新登录在结构上不可能修好这个 401 |
 * | 2 | 「续期一次再重发」**恒被执行**，而它没有任何意义 | 判决式 `renewed !== credential` 比的是**对象身份**，而 `resolveCredential()` 每次都 `JSON.parse` 出新对象 ⇒ 恒为真 |
 *
 * ## 本文件守的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | Basic 三元组**没变** ⇒ 不再重发（只发 1 个请求）| 每轮白撞一次（原始缺陷）|
 * | 2 | Basic 三元组**变了** ⇒ 仍然重发 | 砍掉真正有用的那一格（2026-10-13 的 host 缺陷）|
 * | 3 | 只换 `maasBaseUrl`（key 不变）也算「变了」| 打错 host 的场景重发不了 |
 * | 4 | 文案必须说出「已续期但一个字节都没变」这个**事实** | 用户重复做无效的重新登录 |
 * | 5 | 错误**不带 `code`** | `AUTH` 会被客户端整段替换，指路文案全丢 |
 * | 6 | 连续两次确定的凭据拒绝后**快速失败**（零请求）| 每轮都发一个已知结果的请求 |
 * | 7 | 重发失败时熔断记账落在**新**凭据上（续期换过 Basic 三元组）| 熔断器追不上实际在用的那份，每轮仍白撞一次 |
 *
 * ⚠️ 全部离网：`fetchImpl` 是替身，不发任何真实请求。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OfficeAceAdapter } from '../../src/officeace-adapter.js'
import { resetOfficeaceBreakerForTest, officeaceBreakerState } from '../../src/officeace-credential-health.js'
import type { OfficeAceCredential } from '../../src/officeace-auth.js'

/** 真机报文原文（issue 取证）。 */
const REAL_401_BODY = JSON.stringify({
  error_msg: 'AppKey or AppSecret is invalid',
  error_code: 'APIG.1009',
})

const ACCOUNT_BASE = 'https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com'

/** 造一份凭据；**每次都返回新对象**（与生产 `JSON.parse` 同形）。 */
function cred(overrides: Partial<OfficeAceCredential> = {}): OfficeAceCredential {
  return {
    modelAppKey: 'ffff8ba7', modelAppSecret: 'bd4da972', maasBaseUrl: ACCOUNT_BASE,
    access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'r', dpopPrivateJwk: {},
    ...overrides,
  } as unknown as OfficeAceCredential
}

const SSE_OK = 'data: [DONE]\n\n'

/** 装一个「推理恒 401」的适配器；`refreshImpl` 可换成会真的换掉凭据的实现。 */
function harness(options: {
  /** 当前凭据（每次读都 `JSON.parse` 出一份新对象；`undefined` = 读不到）。 */
  current: () => OfficeAceCredential | undefined
  refresh?: () => Promise<void>
  /** 推理失败的状态码；默认 401（真机形态）。`400` = 华为文档定义的那一侧。 */
  status?: number
}) {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/v2/chat/completions')) {
      // ⚠️ 报文恒为真机原文；只有状态码可换 —— 华为文档说 1009 是 400、真机回 401。
      return new Response(REAL_401_BODY, {
        status: options.status ?? 401, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const provider = vi.fn(async () => {
    const value = options.current()
    // ⚠️ 与生产同形：凭据是从凭据库 `JSON.parse` 出来的**新对象**（不是同一个引用）。
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as OfficeAceCredential
  })
  const adapter = new OfficeAceAdapter({
    credentialProvider: provider,
    fetchImpl,
    ...options.refresh === undefined ? {} : { refresh: options.refresh },
  })
  const chatCalls = (): number => urls.filter((u) => u.includes('/v2/chat/completions')).length
  const run = async (model = 'glm-5.2'): Promise<void> => {
    const prepared = await adapter.prepareCall('officeace', model)
    for await (const _ of prepared.stream({ messages: [{ role: 'user', content: 'hi' }] } as never)) {
      /* drain */
    }
  }
  return { adapter, provider, chatCalls, run }
}

beforeEach(() => {
  resetOfficeaceBreakerForTest()
})

describe('★ 续期后「重发一次有没有意义」的判据', () => {
  it('① 续期换了 STS 但 Basic 三元组没变 ⇒ **只发一次**（原始缺陷的核心）', async () => {
    let token = 'old'
    const h = harness({
      // ⚠️ 每次返回新对象、且 access/securityToken 真的变了 —— 这正是旧实现在
      //    对象身份判据下「自认为换过了」的场景。生产里 token 就是会变。
      current: () => cred({ access: 'ak', securityToken: token }),
      refresh: async () => { token = 'new' },
    })
    await expect(h.run()).rejects.toThrow(/HTTP 401/)
    expect(h.chatCalls(), 'Basic 没变还重发 = 每轮白撞一次（原始缺陷）').toBe(1)
  })

  it('② 续期换了 modelAppKey ⇒ 仍然重发（真有用的那一格不能砍掉）', async () => {
    let key = 'ffff8ba7'
    const h = harness({
      current: () => cred({ modelAppKey: key }),
      refresh: async () => { key = 'rotated' },
    })
    await expect(h.run()).rejects.toThrow(/HTTP 401/)
    expect(h.chatCalls(), '凭据真变了就必须重发一次').toBe(2)
  })

  it('★ ③ 只换了 maasBaseUrl（key 不变）也算「变了」⇒ 重发', async () => {
    // ⚠️ 2026-10-13 那个真实缺陷：华为按账号下发专属网关，打错 host 恒 401，
    //    而 Basic 二元组完全正确 —— 此时重发**是**唯一出路。
    let base = 'https://wrong.example'
    const h = harness({
      current: () => cred({ maasBaseUrl: base }),
      refresh: async () => { base = ACCOUNT_BASE },
    })
    await expect(h.run()).rejects.toThrow(/HTTP 401/)
    expect(h.chatCalls(), '换了网关就必须重发（否则这类 401 永远修不好）').toBe(2)
  })

  it('④ 没接 `refresh` ⇒ 不重发（与既有行为一致）', async () => {
    const h = harness({ current: () => cred() })
    await expect(h.run()).rejects.toThrow(/HTTP 401/)
    expect(h.chatCalls()).toBe(1)
  })

  it('★ ⑥ 续期换了 key ⇒ 熔断记账必须落在**新**凭据上（否则熔断追不上在用的那份）', async () => {
    // ⚠️ 缺口：这一格原先**零覆盖**。`noteOfficeaceRejection(...)` 第一版传的是
    //    进函数时那份**旧**凭据，而续期换掉 Basic 三元组后，下一轮请求用的
    //    **新**那份（凭据库已就地更新）⇒ 旧指纹上的熔断对后续请求毫无作用，
    //    每轮仍白撞一次（正是 issue 第 ③ 条）。判据必须同时看两侧：
    //    新凭据记了账、旧凭据**一个字节也不该有**。
    let key = 'ffff8ba7'
    const h = harness({
      current: () => cred({ modelAppKey: key }),
      refresh: async () => { key = 'rotated' },
    })
    await expect(h.run()).rejects.toThrow(/HTTP 401/)
    expect(h.chatCalls()).toBe(2)

    expect(
      officeaceBreakerState(cred({ modelAppKey: 'rotated' })).consecutive,
      '重发的失败必须记在**新**凭据上，否则熔断器永远追不上实际在用的凭据',
    ).toBe(1)
    expect(
      officeaceBreakerState(cred({ modelAppKey: 'ffff8ba7' })).consecutive,
      '旧凭据已经被换掉了，不该替它背一次拒绝',
    ).toBe(0)
  })

  it('⑤ 续期后**读不到**凭据 ⇒ 不重发，且文案说的是「读不到」而不是「没变」', async () => {
    // ⚠️ 两件事必须分开：`unreadable`（凭据库/登录态异常）与 `unchanged`
    //    （读到了但逐字节没变）指向完全不同的下一步动作。
    let readable = true
    const h = harness({
      current: () => (readable ? cred() : undefined),
      refresh: async () => { readable = false },
    })
    const error = await h.run().catch((e: unknown) => e as Error)
    expect(h.chatCalls()).toBe(1)
    expect(error.message).toContain('续期后读不到新凭据')
    expect(error.message, '不得把「读不到」说成「一个都没变」').not.toContain('一个都没变')
  })

  it('★ ⑥b **文档那一侧的 400** 也必须给出同一套归因与熔断（不是只认 401）', async () => {
    // ⚠️ 华为官方文档把 APIG.1009 定义为 HTTP **400**，真机回的是 401（issue 已取证）。
    //    原判据写死 `status !== 401 ⇒ false`（而它的注释却写着「不得依赖状态码」）
    //    ⇒ 一旦网关按文档回 400，就既没有 APIG.1009 的归因，也不熔断，
    //    每轮又白撞一次 —— 正是 issue 第 ③ 条。第二轮对抗性审计查出这条缺口。
    const h = harness({
      current: () => cred(),
      refresh: async () => { /* 逐字节不变 */ },
      status: 400,
    })
    const error = await h.run().catch((e: unknown) => e as Error)
    expect(error.message, 'docs 说 400 ⇒ 同样要认出 APIG.1009').toContain('APIG.1009')
    expect(error.message).toContain('重新登录 OfficeAce 改不了这个结果')
    expect(
      officeaceBreakerState(cred()).consecutive,
      '400 形态的凭据拒绝也必须记账，否则每轮继续白撞（缺陷 ③ 复发）',
    ).toBe(1)
  })
})

describe('★ 401 的归因文案（按报文与续期结果分派）', () => {
  it('① APIG.1009 + 续期没换掉任何东西 ⇒ 明确说「重新登录改不了这个结果」', async () => {
    const h = harness({
      current: () => cred(),
      refresh: async () => { /* 逐字节不变 */ },
    })
    await expect(h.run()).rejects.toThrow(/重新登录 OfficeAce 改不了这个结果/)
  })

  it('★ ② 不得再无条件断言「会话已过期，请重新登录」', async () => {
    const h = harness({ current: () => cred(), refresh: async () => undefined })
    const error = await h.run().catch((e: unknown) => e as Error)
    expect(error.message).toContain('APIG.1009')
    // ⚠️ 被证伪的那句**只能**作为「反例」出现在代码注释里，不得出现在报文里。
    expect(error.message).not.toContain('会话已过期')
    // 但它必须点名「重新登录改变不了」（用户上一版就是照着那句去重登了 264 次）。
    expect(error.message).toContain('重新登录 OfficeAce 改不了这个结果')
  })

  it('③ 报文形状未知的 401 ⇒ 指向网关/出口，而不是「重新登录」', async () => {
    const urls: string[] = []
    const adapter = new OfficeAceAdapter({
      credentialProvider: async () => cred(),
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return new Response('<html>401</html>', { status: 401, headers: { 'content-type': 'text/html' } })
      }) as typeof fetch,
    })
    const prepared = await adapter.prepareCall('officeace', 'glm-5.2')
    const error = await (async () => {
      try {
        for await (const _ of prepared.stream({ messages: [{ role: 'user', content: 'hi' }] } as never)) { /* drain */ }
        return undefined
      } catch (e: unknown) { return e as Error }
    })()
    expect(error?.message).toMatch(/不是已知的「AppKey\/AppSecret 无效」形状/)
    expect(error?.message).toContain('maasBaseUrl')
  })

  it('★ ④ 错误必须是**裸 Error**（不带 code）—— 否则指路文案会被客户端整段替换', async () => {
    const h = harness({ current: () => cred(), refresh: async () => undefined })
    const error = await h.run().catch((e: unknown) => e as Error)
    expect((error as { code?: unknown }).code).toBeUndefined()
  })

  it('⑤ 其它状态码的归因保持不变（403/404/429/5xx）', async () => {
    const cases: Array<[number, RegExp]> = [
      [403, /未订阅此模型/],
      [404, /模型不存在/],
      [429, /限流/],
      [503, /服务端错误/],
    ]
    for (const [status, pattern] of cases) {
      const adapter = new OfficeAceAdapter({
        credentialProvider: async () => cred(),
        fetchImpl: (async () => new Response('boom', { status })) as typeof fetch,
      })
      const prepared = await adapter.prepareCall('officeace', 'glm-5.2')
      const error = await (async () => {
        try {
          for await (const _ of prepared.stream({ messages: [{ role: 'user', content: 'hi' }] } as never)) { /* drain */ }
          return undefined
        } catch (e: unknown) { return e as Error }
      })()
      expect(error?.message, `HTTP ${status} 的归因被改了`).toMatch(pattern)
    }
  })
})

describe('★ 熔断：连续拒绝后快速失败（零请求）', () => {
  it('① 前两次真发（并记账），第三次**一个请求都不发**', async () => {
    const h = harness({ current: () => cred(), refresh: async () => undefined })
    await expect(h.run()).rejects.toThrow(/HTTP 401/)
    expect(h.chatCalls()).toBe(1)
    await expect(h.run()).rejects.toThrow(/HTTP 401/)
    expect(h.chatCalls()).toBe(2)
    const before = h.chatCalls()
    await expect(h.run()).rejects.toThrow(/已临时跳过本渠道/)
    expect(h.chatCalls(), '熔断期必须零请求（否则每轮白等一个往返）').toBe(before)
  })

  it('② 快速失败的文案说清三件事：与额度无关、别解锁、重新登录没用', async () => {
    const h = harness({ current: () => cred(), refresh: async () => undefined })
    await expect(h.run()).rejects.toThrow()
    await expect(h.run()).rejects.toThrow()
    const error = await h.run().catch((e: unknown) => e as Error)
    expect(error.message).toContain('连续拒绝 2 次')
    expect(error.message).toMatch(/分钟后自动重试/)
    expect(error.message).toContain('这与额度无关')
    expect(error.message).toContain('不要**去解锁')
  })

  it('★ ③ 成功响应会解除熔断（不能是单向门）', async () => {
    let ok = false
    const urls: string[] = []
    const adapter = new OfficeAceAdapter({
      credentialProvider: async () => cred(),
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input))
        if (!ok) return new Response(REAL_401_BODY, { status: 401, headers: { 'content-type': 'application/json' } })
        return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }) as typeof fetch,
      refresh: async () => undefined,
    })
    const run = async (): Promise<void> => {
      const prepared = await adapter.prepareCall('officeace', 'glm-5.2')
      for await (const _ of prepared.stream({ messages: [{ role: 'user', content: 'hi' }] } as never)) { /* drain */ }
    }
    // 一次拒绝（计数 1，未熔断）
    await expect(run()).rejects.toThrow(/HTTP 401/)
    expect(urls.length).toBe(1)
    // 服务端恢复 ⇒ 这一轮真的发出去并成功 ⇒ 记录被清掉（回到「计数 1 不熔断」）
    ok = true
    await run()
    expect(urls.length, '成功那一轮必须真的发请求').toBe(2)
    ok = false
    await expect(run()).rejects.toThrow(/HTTP 401/)
    expect(urls.length, '成功已清零 ⇒ 一次新拒绝不该立刻熔断').toBe(3)
  })
})
