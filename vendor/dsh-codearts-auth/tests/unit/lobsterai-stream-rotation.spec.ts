/**
 * 流内错误帧（HTTP 200 + SSE `{error:{message}}`）必须参与换号的回归测试。
 *
 * ## 真实缺陷（用户报障）
 *
 * 「本插件出现 lobsterai 一个账号用完出错但是没有从账号切换的问题，应该能自动切换，
 *   web 显示：失败原因：lobsterai: 免费额度已用完，请升级套餐 …… 账号还有 2 个能用的」
 *
 * 根因有两处，缺一不可：
 *
 * 1. **换号循环整体位于 `if (!response.ok)` 之内**，而额度耗尽是以
 *    **HTTP 200 + SSE 流内错误帧** 表达的（Web 上那句文案正是
 *    `consumeSse` 里 `lobsterai: ${data.error.message}` 模板的产物）。
 *    流内错误在 `yield* this.consumeSse(...)` 处抛出，**完全绕过了换号逻辑**，
 *    于是还有可用账号也不会被尝试。
 * 2. `LOBSTERAI_HARD_CREDIT_MARKERS` 不含「免费额度已用完」这类文案 ——
 *    即便把流内错误接进分类，也会判成 `none`（`shouldRotate` 为 false）。
 *
 * 注意 HTTP 200 下 `classifyLobsteraiError` 的**状态码分支全部失效**
 * （它只在 402/429/404/4xx/5xx 上生效），流内错误只能靠关键词判定。
 */
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { classifyLobsteraiStreamError } from '../../src/lobsterai-errors.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

/** 用户报障时 Web 上显示的原文（不得改写，它是判定关键词的依据）。 */
const QUOTA_MESSAGE = '免费额度已用完，请升级套餐'

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

function sseResponse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 上游表达「额度耗尽」的真实形态：HTTP 200，首帧即错误。 */
function inStreamError(message: string): Response {
  return sseResponse([JSON.stringify({ error: { message } })])
}

function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])
}

/** 先产出正文、随后才报错（用于验证「已产出内容不换号」的守卫）。 */
function partialThenError(text: string, message: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ error: { message } }),
  ])
}

/** 构造带账号池的适配器；`responses` 按请求顺序返回。 */
function makeAdapter(config: {
  responses: Array<() => Response>
  poolAccounts?: Array<{ id: string; token: string }>
}) {
  let call = 0
  const rateLimitWrites: Array<{ accountId: string; modelId: string }> = []
  const fetcher = vi.fn(async () => {
    const make = config.responses[Math.min(call, config.responses.length - 1)]!
    call += 1
    return make()
  }) as unknown as typeof fetch

  const accounts = config.poolAccounts ?? []
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
      updateModelRateLimit: async (accountId: string, modelId: string) => {
        rateLimitWrites.push({ accountId, modelId })
      },
      getAvailableAccount: async () => {
        const next = accounts[pick]
        pick += 1
        return next === undefined
          ? null
          : { entry: { id: next.id, provider: 'lobsterai' }, credential: makeCredential(next.token) }
      },
    } as never,
  })
  return { adapter, rateLimitWrites, callCount: () => call }
}

interface ThrownLlmError { code?: string; message: string; failure?: { status?: number } }

async function drain(adapter: LobsteraiAdapter): Promise<{ error?: ThrownLlmError; chunks: unknown[] }> {
  const chunks: unknown[] = []
  try {
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    return { chunks }
  } catch (e) {
    return { error: e as ThrownLlmError, chunks }
  }
}

/** 取最终文本块的正文。 */
function textOf(chunks: readonly unknown[]): string | undefined {
  const end = chunks.find((c) => {
    const chunk = c as { type?: string; block?: { type?: string } }
    return chunk.type === 'block-end' && chunk.block?.type === 'text'
  }) as { block?: { text?: string } } | undefined
  return end?.block?.text
}

describe('流内错误分类（HTTP 200，状态码分支全部失效）', () => {
  it('「免费额度已用完，请升级套餐」判为 hard-credit', () => {
    // 回归：关键词表只有「额度用尽」「积分用完」等，不含真实文案「额度已用完」，
    // 于是这个最主要的失败模式被判成 none → 不换号、也不记徽章。
    expect(classifyLobsteraiStreamError(QUOTA_MESSAGE)).toBe('hard-credit')
  })

  it('未命中关键词的流内业务错误仍可轮转（对齐 Go 的 default 分支）', () => {
    // Go `handler.go:218-243` 的每个分支都以 continue 结尾（含 default，
    // 注释明写「轮转下一个账号，不直接返回（防雪崩）」）。流内错误既然
    // 是明确的业务失败，就不该原地抛给用户。
    const kind = classifyLobsteraiStreamError('某种未登记的上游业务错误')
    expect(kind).toBe('client')
  })
})

describe('额度耗尽必须换号（用户报障的主路径）', () => {
  it('A 返回流内额度错误 → 自动换到 B 并正常返回 B 的内容', async () => {
    const { adapter, rateLimitWrites, callCount } = makeAdapter({
      responses: [
        () => inStreamError(QUOTA_MESSAGE),
        () => textSse('来自账号 B 的回复'),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })

    const { error, chunks } = await drain(adapter)

    // 核心断言：必须真的换号重试，而不是把 A 的错误直接抛给用户。
    expect(error).toBeUndefined()
    expect(callCount()).toBe(2)
    expect(textOf(chunks)).toBe('来自账号 B 的回复')
    // 额度耗尽应给**真正失败的账号 A** 记上限流徽章（hard-credit 属 Cooldown 类）。
    expect(rateLimitWrites).toEqual([{ accountId: 'acc-A', modelId: 'glm-5.2' }])
  })

  it('所有账号都额度耗尽 → 抛 QUOTA_EXCEEDED，并保留真实原因', async () => {
    const { adapter, callCount } = makeAdapter({
      responses: [() => inStreamError(QUOTA_MESSAGE)],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })

    const { error } = await drain(adapter)

    expect(callCount()).toBe(2)
    expect(error!.code).toBe('QUOTA_EXCEEDED')
    // 诊断信息不得被吞掉：用户必须能看到「免费额度已用完」这个真实原因。
    expect(error!.message).toMatch(/免费额度已用完/)
  })

  it('已产出正文后才报错 → 不换号（否则触发 harness 的重复 block-start 崩溃）', async () => {
    const { adapter, callCount } = makeAdapter({
      responses: [() => partialThenError('前半段', QUOTA_MESSAGE)],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })

    const { error, chunks } = await drain(adapter)

    // 换号会重放一次请求，而新的 `consumeSse` 是**全新生成器**（nextIndex 从 0 重来），
    // 于是会再发一次 `block-start(index=0)`。而 DSH 对重复块索引是**硬失败**：
    //
    //   dsh-llm/lib/invariant.js:
    //     case "block-start":
    //       if (open.has(chunk.index)) fail(`LLM stream repeated block-start index ${chunk.index}`)
    //
    // 即：已产出内容后换号会把「额度耗尽」这个可读错误升级成 invariant 崩溃。
    // 所以这里必须**不换号**，如实抛出，由 harness 重试整个回合。
    expect(callCount()).toBe(1)
    expect(error).toBeDefined()

    // 直接锁死「绝不出现重复的 block-start 索引」——这是 DSH 的硬契约。
    const started = chunks
      .filter((c) => (c as { type?: string }).type === 'block-start')
      .map((c) => (c as { index?: number }).index)
    expect(new Set(started).size).toBe(started.length)

    // 已产出的增量文本已经流给用户了（错误在 block-end 之前抛出，
    // 故这里断言的是 text-delta 而非最终文本块）。
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '前半段' })
  })
})
