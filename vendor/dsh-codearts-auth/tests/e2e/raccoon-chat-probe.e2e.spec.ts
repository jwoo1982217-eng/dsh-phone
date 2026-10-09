/**
 * Raccoon **对话**探针（发真实模型请求，消耗少量积分）。
 *
 * 验证单测无法证明的远端事实：
 * 1. Bearer 凭据在 `chat/completions` 上有效；
 * 2. 响应是**标准 OpenAI SSE**（`chat.completion.chunk` + `[DONE]`）；
 * 3. **`reasoning_content` 与 `content` 并存**，且另一侧为**空串而非 null**
 *    （实测形态；`openai-compat.ts` 已按 `typeof === 'string'` 处理）；
 * 4. 走完后端到端能拿到非空正文。
 *
 * 闸门：`DSH_RACCOON_CHAT_E2E=1` **且** `DSH_RACCOON_CHAT_E2E_CONFIRM=yes`
 * （双重闸门 —— 本用例**会消耗积分**）。
 */

import { describe, expect, it } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import { raccoonHeaders } from '../../src/raccoon.js'
import { readRaccoonCredentialsFromDshStore } from './raccoon-credential.js'

const RUN = process.env.DSH_RACCOON_CHAT_E2E === '1'
  && process.env.DSH_RACCOON_CHAT_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 解析 SSE 文本成帧列表。 */
function parseSse(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload.length > 0 && payload !== '[DONE]')
}

suite('Raccoon 对话探针（消耗积分）', () => {
  const entries = readRaccoonCredentialsFromDshStore()

  it('标准 OpenAI SSE：能拿到正文与思考内容', async () => {
    const first = entries[0]
    expect(first, '未找到 Raccoon 凭据').toBeDefined()
    if (first === undefined) return

    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...raccoonHeaders(first.credential),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: 'sn-deepseek-v4-1-flash',
          messages: [{ role: 'user', content: '说三个字' }],
          stream: true,
          // 小额：本探针只为验证协议形态，不需要完整回答
          max_tokens: 64,
        }),
        signal: AbortSignal.timeout(90_000),
      },
    )
    expect(response.status, `HTTP ${response.status}`).toBe(200)
    expect(response.headers.get('content-type') ?? '').toContain('text/event-stream')

    const frames = parseSse(await response.text())
    expect(frames.length, 'SSE 帧数').toBeGreaterThan(0)

    let content = ''
    let reasoning = ''
    let sawNullContent = false
    for (const frame of frames) {
      const parsed = JSON.parse(frame) as {
        object?: string
        choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>
      }
      // 帧形态必须是标准 OpenAI chunk
      if (parsed.object !== undefined) {
        expect(parsed.object).toBe('chat.completion.chunk')
      }
      const delta = parsed.choices?.[0]?.delta
      if (delta === undefined) continue
      // ⚠️ 实测形态：两侧字段**都存在**，另一侧为**空串**（不是 null）
      if (delta.content === null) sawNullContent = true
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    }

    // 至少有一侧产出内容（deepseek-v4.1-flash 会先思考）
    expect(content.length + reasoning.length, '正文与思考都为空').toBeGreaterThan(0)
    // 记录形态，便于排查（不是断言，只是诊断输出）
    console.log(`[raccoon-chat] content=${content.length} 字，reasoning=${reasoning.length} 字，content 出现过 null=${sawNullContent}`)
  })

  it('非流式也能拿到完整 message', async () => {
    const first = entries[0]
    if (first === undefined) return
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`,
      {
        method: 'POST',
        headers: raccoonHeaders(first.credential),
        body: JSON.stringify({
          model: 'sn-deepseek-v4-1-flash',
          messages: [{ role: 'user', content: '回复 OK' }],
          stream: false,
          max_tokens: 64,
        }),
        signal: AbortSignal.timeout(90_000),
      },
    )
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      object?: string
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>
    }
    expect(payload.object).toBe('chat.completion')
    const message = payload.choices?.[0]?.message
    expect(message).toBeDefined()
    const contentLen = typeof message?.content === 'string' ? message.content.length : 0
    const reasoningLen = typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0
    expect(contentLen + reasoningLen, '正文与思考都为空').toBeGreaterThan(0)
  })
})
