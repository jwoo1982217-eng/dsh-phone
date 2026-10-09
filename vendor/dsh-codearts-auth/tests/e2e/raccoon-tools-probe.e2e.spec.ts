/**
 * Raccoon **工具调用**探针（设计文档 §7.4 的头号待定项）。
 *
 * ## 为什么必须有这个探针
 *
 * AGENTS.md 记录过两次**同型真实缺陷**：
 *
 * - **Qoder**：适配器从不消费 `options.tools`、WASM 又把请求体的 `tools`
 *   硬编码为 `[]` → 模型在 wire 上拿不到任何函数 schema，
 *   只能用**正文里的 XML 文本**臆造工具调用，harness 认不出 → 任务终止；
 * - **TRAE**：同类问题（工具历史被丢、模型反复重调同一工具）。
 *
 * 两次的根因**都不是「服务端不支持」**，而是**插件没把 tools 发出去**。
 * 故判据必须落在响应上：**必须看到结构化的 `tool_calls`**，
 * 而不是「模型在正文里说它想调用某工具」—— 后者恰恰是缺陷的形态。
 *
 * ## 间接证据（说明为何预期支持）
 *
 * - 桌面端 `model-profiles.json` 指向的正是本端点；
 * - 该端点背后的 agent 运行时 `box-agent-acp.exe` 内含 `tool_choice`（37 次命中）
 *   与 `function_call`（15 次命中），以及完整的 `openai.types.*` 类型表
 *   —— 说明它构造的是**带 tools 的 OpenAI 请求体**。
 *
 * 但这些只是间接证据 —— **本探针给出直接判据**。
 *
 * 闸门：`DSH_RACCOON_TOOLS_E2E=1` **且** `DSH_RACCOON_TOOLS_E2E_CONFIRM=yes`
 * （双重闸门 —— 本用例**会消耗积分**）。
 */

import { describe, expect, it } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import { raccoonHeaders } from '../../src/raccoon.js'
import { readRaccoonCredentialsFromDshStore } from './raccoon-credential.js'

const RUN = process.env.DSH_RACCOON_TOOLS_E2E === '1'
  && process.env.DSH_RACCOON_TOOLS_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 一个明显的工具：模型没理由不用它回答问题。 */
const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询指定城市的当前天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名，如「北京」' } },
      required: ['city'],
    },
  },
}

suite('Raccoon 工具调用探针（消耗积分）', () => {
  const entries = readRaccoonCredentialsFromDshStore()

  it('带 tools 的请求返回**结构化 tool_calls**（不是正文里的 XML）', async () => {
    const first = entries[0]
    expect(first, '未找到 Raccoon 凭据').toBeDefined()
    if (first === undefined) return

    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`,
      {
        method: 'POST',
        headers: raccoonHeaders(first.credential),
        body: JSON.stringify({
          model: 'sn-deepseek-v4-1-flash',
          messages: [
            { role: 'user', content: '北京今天天气怎么样？请调用工具查询，不要凭记忆回答。' },
          ],
          tools: [WEATHER_TOOL],
          tool_choice: 'auto',
          stream: false,
          max_tokens: 256,
        }),
        signal: AbortSignal.timeout(90_000),
      },
    )
    expect(response.status, `HTTP ${response.status}`).toBe(200)

    const payload = await response.json() as {
      choices?: Array<{
        finish_reason?: string
        message?: { content?: unknown; tool_calls?: unknown }
      }>
      error?: unknown
    }
    expect(payload.error, `服务端返回错误：${JSON.stringify(payload.error)}`).toBeUndefined()

    const choice = payload.choices?.[0]
    const message = choice?.message ?? {}
    const toolCalls = message.tool_calls

    console.log(
      `[raccoon-tools] finish_reason=${String(choice?.finish_reason)} `
      + `tool_calls=${JSON.stringify(toolCalls)?.slice(0, 200) ?? 'undefined'}`,
    )

    // ── 核心判据 ──
    expect(
      Array.isArray(toolCalls) && toolCalls.length > 0,
      '❌ 端点未返回结构化 tool_calls。\n'
      + '  若正文里出现 XML/标签，那正是 Qoder/TRAE 缺陷的形态（模型在正文里臆造工具调用）——\n'
      + '  不要采用「system prompt 注入 + 正文 XML 解析」的回退方案。\n'
      + `  实测响应：${JSON.stringify(message).slice(0, 500)}`,
    ).toBe(true)

    const firstCall = (toolCalls as Array<{
      id?: unknown
      type?: unknown
      function?: { name?: unknown; arguments?: unknown }
    }>)[0]
    expect(firstCall?.id, 'tool_call 缺 id').toBeTruthy()
    expect(firstCall?.type).toBe('function')
    expect(firstCall?.function?.name).toBe('get_weather')
    // arguments 是 JSON 字符串（OpenAI 规范）
    expect(typeof firstCall?.function?.arguments).toBe('string')
    const args = JSON.parse(String(firstCall?.function?.arguments)) as Record<string, unknown>
    expect(args.city, 'arguments 里应带 city').toBeTruthy()
  })

  it('不带 tools 时不应出现 tool_calls（排除「服务端总是返回」的误判）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`,
      {
        method: 'POST',
        headers: raccoonHeaders(first.credential),
        body: JSON.stringify({
          model: 'sn-deepseek-v4-1-flash',
          messages: [{ role: 'user', content: '北京今天天气怎么样？' }],
          stream: false,
          max_tokens: 128,
        }),
        signal: AbortSignal.timeout(90_000),
      },
    )
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      choices?: Array<{ message?: { tool_calls?: unknown } }>
    }
    // 没有声明工具时不该凭空产出 tool_calls —— 否则上一条用例的判据就不成立
    expect(payload.choices?.[0]?.message?.tool_calls).toBeUndefined()
  })

  it('流式模式下的 tool_calls 按 index 分片（首片带 id/name）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`,
      {
        method: 'POST',
        headers: { ...raccoonHeaders(first.credential), Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: 'sn-deepseek-v4-1-flash',
          messages: [
            { role: 'user', content: '上海呢？请再次调用工具。' },
          ],
          tools: [WEATHER_TOOL],
          tool_choice: 'auto',
          stream: true,
          max_tokens: 256,
        }),
        signal: AbortSignal.timeout(90_000),
      },
    )
    expect(response.status).toBe(200)

    const text = await response.text()
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((p) => p.length > 0 && p !== '[DONE]')

    let sawToolCalls = false
    let sawName = false
    for (const frame of frames) {
      const parsed = JSON.parse(frame) as {
        choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
      }
      for (const call of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
        sawToolCalls = true
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) sawName = true
      }
    }

    console.log(`[raccoon-tools] 流式：出现 tool_calls=${sawToolCalls}，出现完整 name=${sawName}`)
    expect(sawToolCalls, '流式模式下未出现 tool_calls').toBe(true)
    expect(sawName, '流式 tool_calls 里未出现工具名（首片应带 name）').toBe(true)
  })
})
