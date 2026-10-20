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
    uid: 'u', user_id: 'y', uuid: 'uid-1',
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

/** 逐次返回不同响应，并支持断言「响应体是否已被消费」。 */
function sequencedFetcher(responses: Array<() => Response>) {
  let i = 0
  const consumed: boolean[] = []
  const fetcher = vi.fn(async () => {
    const make = responses[Math.min(i, responses.length - 1)]!
    i += 1
    const res = make()
    const originalText = res.text.bind(res)
    res.text = async () => { consumed[responses.indexOf(make)] = true; return originalText() }
    return res
  }) as unknown as typeof fetch
  return { fetcher, consumed, calls: () => i }
}

describe('换号循环的耗尽路径（诊断信息完整性）', () => {
  it('全部账号失败时，最终错误必须带上**最后一次**的真实原因', async () => {
    // 关键：第一轮错误体与后续轮的错误体不同，用于检测
    // 「用 A 账号的 errorText 配 B 账号的 status」这类错配。
    const { fetcher } = sequencedFetcher([
      () => new Response('第一个账号的原因：频率限制', { status: 429 }),
      () => new Response('第二个账号的原因：余额不足', { status: 402 }),
    ])
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_T'),
      resolveCredential: async () => makeCredential('AT-1'),
      refresh: async () => {},
      fetchImpl: fetcher,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => ({
          entry: { id: 'acc-2', provider: 'lobsterai' },
          credential: makeCredential('AT-2'),
        }),
      } as never,
    })

    const error = await (async () => {
      try {
        for await (const _ of adapter.stream(options())) { /* consume */ }
        return undefined
      } catch (e) { return e as { message: string; status?: number } }
    })()

    expect(error).toBeDefined()
    // 必须反映「最后试过的那个账号」的失败原因。
    expect(error!.message).toMatch(/余额不足/)
  })

  it('耗尽后不重复消费已 drain 的响应体（不抛 Body is unusable）', async () => {
    // 回归：换号循环里 `await response.text()` 会 drain 响应体；
    // 若退出循环后又对同一个 response 调用 text()/json()，会抛
    // `TypeError: Body is unusable`，把真实错误掩盖成解析异常。
    const { fetcher } = sequencedFetcher([
      () => new Response('第一个账号失败', { status: 429 }),
      () => new Response('第二个账号失败', { status: 503 }),
    ])
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_T2'),
      resolveCredential: async () => makeCredential('AT-1'),
      refresh: async () => {},
      fetchImpl: fetcher,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => null,
      } as never,
    })

    const error = await (async () => {
      try {
        for await (const _ of adapter.stream(options())) { /* consume */ }
        return undefined
      } catch (e) { return e as Error }
    })()

    expect(error).toBeDefined()
    // 绝不能是响应体二次消费导致的 TypeError。
    expect(error!.message).not.toMatch(/Body is unusable/i)
    expect(error!.message).not.toMatch(/body used already/i)
  })
})
