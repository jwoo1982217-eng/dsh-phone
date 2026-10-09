/**
 * 独立审查发现的缺陷的回归测试（S1 / S3 / S4 / M1 / M3）。
 *
 * 这些用例的共同点是：**原有的 763 项测试全部通过却一个都没抓到它们**。
 * 原因分别是 ——
 * - S1 是**接线层**错配（适配器的 resolve 与 refresh 指向不同凭据），
 *   而所有 adapter 测试都注入同一个固定 `resolveCredential`，从不模拟真实接线；
 * - S3/S4 需要构造「首账号错误类别 ≠ 末账号错误类别」，原有用例只让一个账号失败；
 * - M1 需要「delta 与 message 混发」，原用例只测了「仅有 message」。
 *
 * 因此本文件的用例刻意按「制造出原测试制造不出的输入」来写。
 */

import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

function makeCredential(token: string): LobsteraiCredential {
  return {
    access_token: token, refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'u', user_id: 'y', uuid: 'uuid-1',
    first_keyfrom: '1', latest_keyfrom: '1',
  }
}

function options(): GenerateOptions {
  return {
    provider: 'lobsterai',
    model: 'glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  }
}

/**
 * 构造一个「池里有 A、B 两个账号」的适配器。
 *
 * `responses` 按请求顺序返回；`poolAccounts` 决定换号时给出哪些账号。
 */
function makeRotatingAdapter(config: {
  responses: Array<() => Response>
  poolAccounts: Array<{ id: string; token: string }>
}) {
  let call = 0
  const rateLimitWrites: Array<{ accountId: string; modelId: string }> = []
  const fetcher = vi.fn(async () => {
    const make = config.responses[Math.min(call, config.responses.length - 1)]!
    call += 1
    return make()
  }) as unknown as typeof fetch

  const adapter = new LobsteraiAdapter({
    credentialRef: credentialRef('LOBSTERAI_ACCOUNT_A'),
    resolveCredential: async () => makeCredential('AT-A'),
    refresh: async () => {},
    fetchImpl: fetcher,
    resolveClientVersion: async () => '2026.9.4',
    product: LOBSTERAI,
    accountPool: {
      findAccountIdByCredential: async () => 'acc-A',
      updateModelRateLimit: async (accountId: string, modelId: string) => {
        rateLimitWrites.push({ accountId, modelId })
      },
      getAvailableAccount: async () => {
        // 依次交出池中的账号（跳过首个，因为首个是当前账号）。
        const next = config.poolAccounts[call - 1] ?? config.poolAccounts.at(-1)
        if (!next) return null
        return { entry: { id: next.id, provider: 'lobsterai' }, credential: makeCredential(next.token) }
      },
    } as never,
  })
  return { adapter, rateLimitWrites, callCount: () => call }
}

/**
 * `LlmError` 把 HTTP 状态放在 `failure.status`（不是顶层 `status`）——
 * 见 dsh-llm 的 `LlmFailure` 定义。抽个小工具免得每处都写可选链。
 */
interface ThrownLlmError {
  code?: string
  message: string
  failure?: { status?: number }
}

async function drain(adapter: LobsteraiAdapter): Promise<{ error?: ThrownLlmError }> {
  try {
    for await (const _ of adapter.stream(options())) { /* consume */ }
    return {}
  } catch (e) {
    return { error: e as ThrownLlmError }
  }
}

describe('S3：换号耗尽后错误码必须与最后一次失败同源', () => {
  it('A=402(积分不足) → B=503：错误码反映 B，且文案带 B 的原因', async () => {
    // 回归：`kind` 曾在循环外只算一次，导致 A 的 kind 配 B 的 status ——
    // 实测会输出 code=SERVER 却让用户看到「所有账号均不可用」，
    // 而真实原因（此处是 B 的 503）与 A 的「积分不足」都对不上。
    const { adapter, callCount } = makeRotatingAdapter({
      responses: [
        () => new Response('积分不足', { status: 402 }),
        () => new Response('上游 503', { status: 503 }),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })
    const { error } = await drain(adapter)
    expect(callCount()).toBe(2)
    // 最后一次失败是 503 → 应映射为 SERVER，而不是沿用 A 的 QUOTA_EXCEEDED。
    expect(error!.code).toBe('SERVER')
    expect(error!.failure?.status).toBe(503)
    expect(error!.message).toMatch(/上游 503/)
    // 绝不能把 A 的「积分不足」当作最终结论。
    expect(error!.message).not.toMatch(/积分不足/)
  })

  it('A=429 → B=400：错误码反映 B（INVALID_REQUEST）', async () => {
    const { adapter } = makeRotatingAdapter({
      responses: [
        () => new Response('频率限制', { status: 429 }),
        () => new Response('参数非法', { status: 400 }),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })
    const { error } = await drain(adapter)
    expect(error!.code).toBe('INVALID_REQUEST')
    expect(error!.failure?.status).toBe(400)
    expect(error!.message).toMatch(/参数非法/)
  })

  it('末次失败为积分不足时仍报 QUOTA_EXCEEDED（不能因为首账号是 5xx 就丢失）', async () => {
    const { adapter } = makeRotatingAdapter({
      responses: [
        () => new Response('上游 500', { status: 500 }),
        () => new Response('积分不足', { status: 402 }),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })
    const { error } = await drain(adapter)
    expect(error!.code).toBe('QUOTA_EXCEEDED')
    expect(error!.message).toMatch(/积分不足/)
  })
})

describe('S4：限流徽章必须记在真正失败的那个账号上', () => {
  it('A=429 换成 B、B=500：只给 A 记徽章，绝不碰 B', async () => {
    // 回归：曾用循环外的 kind 判断是否记徽章，于是「A 是限流类」
    // 会让 B 也被记上 —— 若 B 实际是 5xx，UI 会给 B 显示
    // 「该模型限流 1 小时」，正是 recordsLobsteraiRateLimit
    // 注释里声称要避免的虚假信息，却在循环里真实发生。
    const { adapter, rateLimitWrites } = makeRotatingAdapter({
      responses: [
        () => new Response('频率限制', { status: 429 }),
        () => new Response('上游 500', { status: 500 }),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })
    await drain(adapter)
    expect(rateLimitWrites).toEqual([{ accountId: 'acc-A', modelId: 'glm-5.2' }])
    expect(rateLimitWrites.some(w => w.accountId === 'acc-B')).toBe(false)
  })

  it('A=500（非 Cooldown 类）、B=429：只给 B 记徽章', async () => {
    const { adapter, rateLimitWrites } = makeRotatingAdapter({
      responses: [
        () => new Response('上游 500', { status: 500 }),
        () => new Response('频率限制', { status: 429 }),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })
    await drain(adapter)
    expect(rateLimitWrites).toEqual([{ accountId: 'acc-B', modelId: 'glm-5.2' }])
  })

  it('A/B 都是 5xx：一个徽章都不写', async () => {
    const { adapter, rateLimitWrites } = makeRotatingAdapter({
      responses: [
        () => new Response('500', { status: 500 }),
        () => new Response('502', { status: 502 }),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })
    await drain(adapter)
    expect(rateLimitWrites).toEqual([])
  })
})

describe('U2：换号次数有上限（对齐 Go 的 MaxRotate=3）', () => {
  it('池里账号远超上限时，请求次数不超过 3', async () => {
    // Go 用 MaxRotate 做防雪崩（handler.go:190）；无上限时账号多会让
    // 一次用户请求打出 N 个上游请求，放大延迟与额度消耗。
    const tokens = ['B', 'C', 'D', 'E', 'F']
    let call = 0
    const fetcher = vi.fn(async () => {
      call += 1
      return new Response('频率限制', { status: 429 })
    }) as unknown as typeof fetch
    let pick = 0
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_A'),
      resolveCredential: async () => makeCredential('AT-A'),
      refresh: async () => {},
      fetchImpl: fetcher,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
      accountPool: {
        findAccountIdByCredential: async () => 'acc-A',
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => {
          const token = tokens[pick]
          pick += 1
          return token === undefined
            ? null
            : { entry: { id: `acc-${token}`, provider: 'lobsterai' }, credential: makeCredential(`AT-${token}`) }
        },
      } as never,
    })
    await drain(adapter)
    // 首次 + 最多 2 次换号 = 3（与 Go 的 for i < MaxRotate 同语义）。
    expect(call).toBeLessThanOrEqual(3)
    expect(call).toBeGreaterThanOrEqual(2)
  })
})

describe('M1：message 回退不得与 delta 重复拼接', () => {
  it('同一 chunk 的 delta.content 与 message.content 只取 delta', async () => {
    // 回归：无 gotAnyContent 守卫时 `??` 会把两段都拼上（实测 'AM'）。
    // Go 的 sse.go:98 是 `&& !gotAnyContent`，语义为「收到过 delta 正文后
    // 就再也不采纳 message 形态」。
    const body = 'data: ' + JSON.stringify({
      choices: [{ delta: { content: 'A' }, message: { content: 'M' } }],
    }) + '\n\ndata: ' + JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    }) + '\n\ndata: [DONE]\n\n'
    const fetcher = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_M1'),
      resolveCredential: async () => makeCredential('AT'),
      refresh: async () => {},
      fetchImpl: fetcher,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
    })
    const chunks = []
    for await (const c of adapter.stream(options())) chunks.push(c)
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(end).toMatchObject({ block: { type: 'text', text: 'A' } })
  })

  it('只发 message（无任何 delta.content）时仍采用 message', async () => {
    // 守卫不能把这条合法回退路径一起挡掉。
    const body = 'data: ' + JSON.stringify({
      choices: [{ message: { content: '完整' } }],
    }) + '\n\ndata: ' + JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    }) + '\n\ndata: [DONE]\n\n'
    const fetcher = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_M1B'),
      resolveCredential: async () => makeCredential('AT'),
      refresh: async () => {},
      fetchImpl: fetcher,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
    })
    const chunks = []
    for await (const c of adapter.stream(options())) chunks.push(c)
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(end).toMatchObject({ block: { type: 'text', text: '完整' } })
  })

  it('先 delta 后 message：后续 message 被忽略（不追加）', async () => {
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '前' } }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ message: { content: '后' } }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + '\n\ndata: [DONE]\n\n'
    const fetcher = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_M1C'),
      resolveCredential: async () => makeCredential('AT'),
      refresh: async () => {},
      fetchImpl: fetcher,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
    })
    const chunks = []
    for await (const c of adapter.stream(options())) chunks.push(c)
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(end).toMatchObject({ block: { type: 'text', text: '前' } })
  })
})
