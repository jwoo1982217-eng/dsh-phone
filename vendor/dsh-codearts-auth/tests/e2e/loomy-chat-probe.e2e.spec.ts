/**
 * Loomy **对话**探针（会消耗积分，故有独立闸门）。
 *
 * 验证单测无法证明的端到端事实：适配器的 `stream()` 真的能收发 ——
 * 即「消息序列化 → 两套头构造 → SSE 消费」这条完整链路。
 *
 * 闸门：`DSH_LOOMY_CHAT_E2E=1` **且** `DSH_LOOMY_CHAT_E2E_CONFIRM=yes`
 * （用 `pnpm test:e2e:loomy-chat` 运行）。
 *
 * ⚠️ 默认模型是 **`qwen3.8-flash`（x0.8）**，与 `GLM-5.3-Flash` 并列为
 * 全表最便宜的两个模型；`max_tokens` 压到 16，单次消耗约 1 积分。
 * 可用 `DSH_LOOMY_CHAT_MODEL` 覆盖。
 */

import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { LOOMY } from '../../src/loomy-product.js'
import type { LoomyCredential } from '../../src/loomy.js'
import { readLoomyCredentialsFromDshStore } from './loomy-credential.js'

const RUN = process.env.DSH_LOOMY_CHAT_E2E === '1'
  && process.env.DSH_LOOMY_CHAT_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 默认用最便宜的模型之一（x0.8）。 */
const MODEL = process.env.DSH_LOOMY_CHAT_MODEL ?? 'qwen3.8-flash'

suite('Loomy 对话探针（消耗积分，默认 qwen3.8-flash）', () => {
  const entries = readLoomyCredentialsFromDshStore()
  const credential = entries[0]?.credential

  /** 造一个只解析固定凭据的适配器。 */
  function makeAdapter(cred: LoomyCredential): LoomyAdapter {
    return new LoomyAdapter({
      credentialRef: credentialRef('LOOMY_E2E'),
      resolveCredential: async () => cred,
      // Loomy 无续期端点：探测失败即抛，符合真实语义。
      refresh: async () => { throw new Error('Loomy 不可续期') },
      accountPool: undefined,
      product: LOOMY,
    })
  }

  it('适配器 stream() 能收到真实 SSE 内容', async () => {
    expect(credential, '未找到 Loomy 凭据').toBeDefined()
    const adapter = makeAdapter(credential!)

    console.log(`\n===== 对话探针 model=${MODEL} =====`)
    const chunks: string[] = []
    let sawText = false
    let sawFinish = false
    let finishReason = ''

    for await (const chunk of adapter.stream({
      provider: 'loomy',
      model: MODEL,
      messages: [{ role: 'user', content: '只回复两个字：你好' }],
      maxTokens: 16,
    })) {
      // ⚠️ 增量类型是 `text-delta`（不是 `block-delta`）——
      // 见 dsh-llm 的 `StreamChunk` 联合类型。
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.text)
        sawText = true
      }
      if (chunk.type === 'finish') {
        sawFinish = true
        finishReason = chunk.reason
      }
      if (chunks.length <= 5) console.log('  chunk:', JSON.stringify(chunk).slice(0, 160))
    }

    const text = chunks.join('')
    console.log(`  收到文本长度 = ${text.length}`)
    console.log(`  文本 = ${JSON.stringify(text.slice(0, 80))}`)
    console.log(`  finish.reason = ${finishReason}`)

    expect(sawText, '未收到任何文本增量').toBe(true)
    expect(sawFinish, '未收到终止帧').toBe(true)
    expect(text.length).toBeGreaterThan(0)
  }, 120_000)

  it('适配器 resolveModel 能解析该模型的上下文窗口', async () => {
    const adapter = makeAdapter(credential!)
    const resolved = await adapter.resolveModel('loomy', MODEL)
    console.log(`  resolveModel(${MODEL}) → name=${resolved.name} ctx=${resolved.context?.contextWindow}`)
    expect(resolved.id).toBe(MODEL)
    // name 不带倍率（价格只属于选择列表语境）
    expect(resolved.name).not.toContain('· x')
  })
})
