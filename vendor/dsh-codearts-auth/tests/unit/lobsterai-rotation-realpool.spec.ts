import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

function cred(token: string): LobsteraiCredential {
  return {
    access_token: token, refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'u', user_id: 'y', uuid: 'uuid-1', first_keyfrom: '1', latest_keyfrom: '1',
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
 * 复刻**真实** `AccountPool.getAvailableAccount` 的行为：
 * 按 `modelRateLimits` 升序排序、过滤掉仍在重置期内的账号，
 * 但**不支持排除已试过的账号**（这正是真实实现的签名）。
 */
function realisticPool(accounts: Array<{ id: string; token: string; resetAt?: number }>) {
  const limits = new Map<string, number>()
  for (const a of accounts) if (a.resetAt !== undefined) limits.set(a.id, a.resetAt)
  return {
    findAccountIdByCredential: async () => accounts[0]!.id,
    updateModelRateLimit: async (accountId: string, _m: string, resetAtMs: number) => {
      limits.set(accountId, resetAtMs)
    },
    getAvailableAccount: async (
      _provider: string,
      modelId: string,
      exclude?: ReadonlySet<string>,
    ) => {
      const candidates = accounts
        .filter((a) => exclude === undefined || !exclude.has(a.id))
        .filter((a) => {
          const resetAt = limits.get(a.id)
          return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
        })
        .sort((a, b) => (limits.get(a.id) ?? 0) - (limits.get(b.id) ?? 0))
      const first = candidates[0]
      return first === undefined
        ? null
        : { entry: { id: first.id, provider: 'lobsterai' as const }, credential: cred(first.token) }
    },
  }
}

async function run(
  responses: Array<() => Response>,
  accounts: Array<{ id: string; token: string }>,
) {
  let call = 0
  const fetcher = vi.fn(async () => {
    const make = responses[Math.min(call, responses.length - 1)]!
    call += 1
    return make()
  }) as unknown as typeof fetch
  const adapter = new LobsteraiAdapter({
    credentialRef: credentialRef('LOBSTERAI_ACCOUNT_A'),
    resolveCredential: async () => cred('AT-A'),
    refresh: async () => {},
    fetchImpl: fetcher,
    resolveClientVersion: async () => '2026.9.4',
    product: LOBSTERAI,
    accountPool: realisticPool(accounts) as never,
  })
  try {
    for await (const _ of adapter.stream(options())) { /* consume */ }
    return { calls: call }
  } catch {
    return { calls: call }
  }
}

describe('换号在非限流错误下是否真的发生（真实账号池语义）', () => {
  it('A=500(server) → B=200：应当换到 B 并成功', async () => {
    // server 类**不写**限流标记（Go 也是 NoteError 不写 Cooldown），
    // 因此 A 在池里依然是「可用」的。
    const { calls } = await run(
      [
        () => new Response('上游 500', { status: 500 }),
        () => new Response(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })
          + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
          + '\n\ndata: [DONE]\n\n',
          { status: 200 },
        ),
      ],
      [{ id: 'acc-A', token: 'AT-A' }, { id: 'acc-B', token: 'AT-B' }],
    )
    // 期望：2 次请求（A 失败 → B 成功）
    expect(calls).toBe(2)
  })

  it('A=400(client) → B=200：应当换到 B', async () => {
    const { calls } = await run(
      [
        () => new Response('bad request', { status: 400 }),
        () => new Response(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })
          + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
          + '\n\ndata: [DONE]\n\n',
          { status: 200 },
        ),
      ],
      [{ id: 'acc-A', token: 'AT-A' }, { id: 'acc-B', token: 'AT-B' }],
    )
    expect(calls).toBe(2)
  })
})
