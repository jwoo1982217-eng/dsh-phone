import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { toOpenAiUsage } from '../../src/openai-gateway/usage.js'
import { collectOpenAiCompletion, toOpenAiSse } from '../../src/openai-gateway/stream.js'
import { collectResponsesResult, toResponsesSse, type OpenAiResponsesRequest } from '../../src/openai-gateway/responses.js'

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* values
}

/**
 * 网关用量口径。
 *
 * ## 守的是什么（真实缺陷，用户报障 2026-10-04）
 *
 * 接入 Codex 后，同一会话用 `raccoon` 时上下文进度条「搞半天只占 5%」，
 * 换 `trae` 就「正常显示占了 300k 多」。
 *
 * 根因：DSH 的 `inputTokens` **只含未命中缓存**（命中单列 `cacheReadTokens`），
 * 而 OpenAI 官方 `input_tokens` / `prompt_tokens` **含缓存**。旧实现把 DSH 口径
 * 原样发出，Codex 再按官方口径算 `input_tokens - cached_tokens`，
 * `saturating_sub` 夹到 0 ⇒ 总数只剩 output ⇒ 少算上百倍，
 * 且 `model_auto_compact_token_limit` 永不触发。
 *
 * 完整事故记录见 `src/openai-gateway/usage.ts` 文件头。
 */
describe('网关用量口径：DSH（互斥）→ OpenAI 官方（含缓存）', () => {
  it('★ 缓存命中必须计入 inputTokens（本缺陷的核心一行）', () => {
    const usage = toOpenAiUsage({ inputTokens: 770, outputTokens: 633, cacheReadTokens: 207488 })
    // DSH 内部：770 未命中 + 207488 命中 = 208258 真实输入
    expect(usage.inputTokens).toBe(770 + 207488)
    expect(usage.cachedTokens).toBe(207488)
    expect(usage.totalTokens).toBe(770 + 207488 + 633)
  })

  it('★ cachedTokens 是 inputTokens 的**子集**，不是可相加的并列项', () => {
    const usage = toOpenAiUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 })
    // 若把 cached 当并列项会得到 100+900+900=1900（重复计数）。
    expect(usage.inputTokens).toBe(1000)
    expect(usage.cachedTokens).toBe(900)
    expect(usage.cachedTokens).toBeLessThan(usage.inputTokens)
  })

  it('缓存写入也算真实输入（Anthropic 的 cache_creation），但**不算命中**', () => {
    const usage = toOpenAiUsage({ inputTokens: 10, outputTokens: 1, cacheWriteTokens: 5 })
    expect(usage.inputTokens).toBe(15)
    expect(usage.cachedTokens).toBe(0)
  })

  it('无缓存时与旧口径完全一致（trae 这类不报缓存的 provider 不受影响）', () => {
    const usage = toOpenAiUsage({ inputTokens: 326134, outputTokens: 608 })
    expect(usage.inputTokens).toBe(326134)
    expect(usage.cachedTokens).toBe(0)
    expect(usage.totalTokens).toBe(326742)
  })

  it('⚠️ 上游报的 total 若**不含缓存**也不得采信（只会多算、绝不漏算）', () => {
    // 上游报 1000，但含缓存拼出来是 5000 —— 取较大者。
    const usage = toOpenAiUsage({ inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cacheReadTokens: 4000 })
    expect(usage.totalTokens).toBe(5000)
  })

  it('上游报的 total 更大时采信它（gemini 的 totalTokenCount 含思考）', () => {
    const usage = toOpenAiUsage({ inputTokens: 10, outputTokens: 1, totalTokens: 99 })
    expect(usage.totalTokens).toBe(99)
  })

  it('非法/负数用量一律当 0，绝不抛错中断整轮对话', () => {
    const usage = toOpenAiUsage({
      inputTokens: -5 as never, outputTokens: Number.NaN as never, cacheReadTokens: -1 as never,
    })
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(usage.cachedTokens).toBe(0)
    expect(usage.totalTokens).toBe(0)
  })

  it('reasoningTokens 为 0 时省略（不给客户端一个假的「有思考」）', () => {
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 1 }).reasoningTokens).toBeUndefined()
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }).reasoningTokens).toBeUndefined()
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 7 }).reasoningTokens).toBe(7)
  })
})

describe('两个端点的 usage 口径必须一致（只改一个就会「换个 URL 用量就变了」）', () => {
  /** 用户报障里的真实一帧：raccoon 会话末。 */
  const raccoon = { inputTokens: 770, outputTokens: 633, cacheReadTokens: 207488 }
  const request: OpenAiResponsesRequest = { model: 'raccoon/sn-deepseek-v4-1-flash', input: 'hi' }

  it('/v1/responses：Codex 按官方口径反解出的上下文占用 ≈ 真实值', async () => {
    const result = await collectResponsesResult(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'resp_x', 'raccoon/sn-deepseek-v4-1-flash', request,
    )
    const usage = result.usage as Record<string, any>
    // Codex 的算法：input_tokens - cached_tokens（saturating）后仍应等于真实输入。
    const codexInput = usage.input_tokens - usage.input_tokens_details.cached_tokens
    expect(codexInput).toBe(770)                       // 未命中部分，没有被夹到 0
    expect(usage.total_tokens).toBe(208258 + 633)
    // 用户报障时这里只有 1403（= 770+633），少算 148 倍。
    expect(usage.total_tokens).toBeGreaterThan(200000)
  })

  it('/v1/chat/completions：同一帧给出同一个总数（含官方明细字段）', async () => {
    const result = await collectOpenAiCompletion(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'chatcmpl_x', 'raccoon/sn-deepseek-v4-1-flash',
    )
    const usage = result.usage as Record<string, any>
    expect(usage.prompt_tokens).toBe(208258)
    expect(usage.total_tokens).toBe(208891)
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 207488 })
  })

  it('★ 两个端点对同一份用量给出**相同**的 input/output/total', async () => {
    const responses = await collectResponsesResult(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'resp_y', 'raccoon/sn-deepseek-v4-1-flash', request,
    )
    const chat = await collectOpenAiCompletion(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'chatcmpl_y', 'raccoon/sn-deepseek-v4-1-flash',
    )
    const r = responses.usage as Record<string, any>
    const c = chat.usage as Record<string, any>
    expect(r.input_tokens).toBe(c.prompt_tokens)
    expect(r.output_tokens).toBe(c.completion_tokens)
    expect(r.total_tokens).toBe(c.total_tokens)
    expect(r.input_tokens_details.cached_tokens).toBe(c.prompt_tokens_details.cached_tokens)
  })

  it('SSE 两条路径同样带官方明细字段', async () => {
    const responsesFrames: string[] = []
    for await (const item of toResponsesSse(
      chunks([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'resp_z', 'raccoon/sn-deepseek-v4-1-flash', request,
    )) responsesFrames.push(item)
    const completed = JSON.parse(
      responsesFrames.filter(f => f.includes('response.completed')).at(-1)!.split('\n').find(l => l.startsWith('data: '))!.slice(6),
    )
    expect(completed.response.usage.input_tokens).toBe(208258)
    expect(completed.response.usage.total_tokens).toBe(208891)

    const chatFrames: string[] = []
    for await (const item of toOpenAiSse(
      chunks([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'req_z', 'raccoon/sn-deepseek-v4-1-flash',
    )) chatFrames.push(item)
    const usageFrame = chatFrames.map(f => f.startsWith('data: ') ? f.slice(6).trim() : '')
      .filter(f => f.length > 0 && f !== '[DONE]')
      .map(f => JSON.parse(f)).find(d => d.usage !== undefined)
    expect(usageFrame.usage.prompt_tokens).toBe(208258)
    expect(usageFrame.usage.total_tokens).toBe(208891)
    expect(usageFrame.usage.prompt_tokens_details).toEqual({ cached_tokens: 207488 })
    // 私有兼容字段仍在（本仓库多个适配器在读它）。
    expect(usageFrame.usage.prompt_cache_hit_tokens).toBe(207488)
  })
})
