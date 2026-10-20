/**
 * MiniMax 推理探针 —— 走**真实适配器**（`MinimaxAdapter.stream()`），
 * 不是手搓 fetch。
 *
 * ⚠️ 这是 2026-09-29 起**可用**的探针。此前它预期失败（HTTP 402 余额不足），
 * 现已实测通过（4 个模型全部 200）。**保留真实断言**，这样：
 * 1. 协议/端点/档位形态被改动时，本探针会拦住；
 * 2. 账号余额用尽时会明确报 402（QUOTA_EXCEEDED），而不是「推理未启用」。
 *
 * 闸门：`DSH_MINIMAX_CHAT_E2E=1` **且** `DSH_MINIMAX_CHAT_E2E_CONFIRM=yes`
 *（双重确认，因为**会消耗额度**）。
 *
 * ⚠️ 默认只测 **M2.7**（用户 2026-09-29 指定：每天有免费额度）。
 * 想测全部模型时加 `DSH_MINIMAX_CHAT_E2E_ALL=1`。
 *
 * ⚠️ token 不落盘、不打印；读的是**客户端登录态**
 *（见 `minimax-credential.ts` 的长注释：过期不代续期）。
 *
 * ---
 *
 * ## ⚠️ 计划文档那条「M3.1 必须 adaptive，否则 400」——**已由服务端证据确证**
 *
 * 2026-09-29 真实请求：
 * ```
 * POST /mavis/api/v1/llm/v1/messages  {model:"MiniMax-M3.1-Flash-Preview",
 *                                      thinking:{type:"disabled"}, ...}
 * → HTTP 400  {"type":"error","error":{"type":"invalid_request_error",
 *    "message":"invalid params, model \"MiniMax-M3.1-Flash-Preview\" requires
 *     adaptive thinking; thinking.type=\"disabled\" (including
 *     reasoning.effort=none) is not allowed (2013)"}}
 * ```
 * ⇒ 该断言从「只有计划声称」升级为**实测确证**，实现里已按此编码
 *（`MINIMAX_ADAPTIVE_ONLY_PREFIX`）。
 *
 * ⚠️ 但**不要**据此推广成「所有 anthropic-messages 请求都必须 adaptive」：
 * M3 / M2.7 / M2.7-highspeed 实测**不传 thinking 即 200**，
 * 且服务端默认会思考（M2.7 实测 `thinking_tokens: 250`）。
 */
import { describe, expect, it } from 'vitest'
import { MinimaxAdapter } from '../../src/minimax-adapter.js'
import { MINIMAX } from '../../src/minimax-product.js'
import type { Message } from '@deepseek-ai/dsh-llm'
import { readMinimaxProbeCredential } from './minimax-credential.js'

const enabled = process.env.DSH_MINIMAX_CHAT_E2E === '1'
  && process.env.DSH_MINIMAX_CHAT_E2E_CONFIRM === 'yes'
const testAll = process.env.DSH_MINIMAX_CHAT_E2E_ALL === '1'
const describeIf = enabled ? describe : describe.skip

/** 用客户端登录态直接造适配器（本 provider 尚未在插件里登录过）。 */
function makeLiveAdapter(token: string): MinimaxAdapter {
  return new MinimaxAdapter({
    credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
    resolveCredential: async () => ({ access_token: token, token_type: 'Bearer' }),
    refresh: async () => {},
    // 走兜底表即可（目录已另有只读探针覆盖）
    product: MINIMAX,
  })
}

const userMessage = (text: string): Message =>
  ({ role: 'user', content: [{ type: 'text', text }] } as Message)

/** 收集一次流，返回拼接后的文本/思考与 finish 原因。 */
async function runStream(
  adapter: MinimaxAdapter,
  model: string,
  text = '只回复两个字：收到',
  extra: Record<string, unknown> = {},
): Promise<{ text: string; reasoning: string; finish: string; chunks: number }> {
  let out = ''
  let reasoning = ''
  let finish = ''
  let chunks = 0
  for await (const chunk of adapter.stream({
    provider: 'minimax',
    model,
    messages: [userMessage(text)],
    maxTokens: 512,
    ...extra,
  } as never)) {
    chunks += 1
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason.kind
  }
  return { text: out, reasoning, finish, chunks }
}

describeIf('MiniMax 推理探针（真实适配器，会消耗额度）', () => {
  const probe = enabled ? readMinimaxProbeCredential() : undefined

  it('客户端登录态有效（过期则跳过，不代续期）', (ctx) => {
    expect(probe).toBeDefined()
    // eslint-disable-next-line no-console
    console.log(`[minimax-chat] 客户端登录态：${probe!.describe}`)
    if (probe!.expired) {
      // eslint-disable-next-line no-console
      console.log('[minimax-chat] token 已过期，跳过推理（请在客户端登录一次）。')
      ctx.skip()
    }
  })

  it('⚠️ M2.7 返回真实文本（用户指定的免费额度模型）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token)
    const result = await runStream(adapter, 'MiniMax-M2.7')
    // eslint-disable-next-line no-console
    console.log(`[minimax-chat] M2.7 → 文本=${JSON.stringify(result.text)}`
      + ` 思考字符=${result.reasoning.length} finish=${result.finish} chunks=${result.chunks}`)
    // 真实断言：必须拿到非空文本且正常结束
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.finish).toBe('stop')
  }, 120_000)

  it('⚠️ M3.1-Flash-Preview 走 adaptive 且能返回文本（它传 disabled 会 400）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token)
    // ⚠️ 显式选一个档位：实现必须把它转成 output_config.effort
    const result = await runStream(adapter, 'MiniMax-M3.1-Flash-Preview', '只回复两个字：收到', {
      reasoningEffort: 'default',
    })
    // eslint-disable-next-line no-console
    console.log(`[minimax-chat] M3.1 → 文本=${JSON.stringify(result.text)}`
      + ` 思考字符=${result.reasoning.length} finish=${result.finish}`)
    expect(result.text.length).toBeGreaterThan(0)
  }, 120_000)

  it('⚠️ 工具调用返回**结构化** tool-call 块（不是正文里的 XML）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token)
    const blocks: Array<{ name: string; arguments: string }> = []
    let finish = ''
    for await (const chunk of adapter.stream({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      messages: [userMessage('北京天气怎么样？请调用工具查询。')],
      maxTokens: 512,
      tools: [{
        name: 'get_weather',
        description: '查询指定城市的天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      }],
    } as never)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        blocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finish = chunk.reason.kind
    }
    // eslint-disable-next-line no-console
    console.log(`[minimax-chat] 工具调用：${JSON.stringify(blocks)} finish=${finish}`)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0]?.name).toBe('get_weather')
    // ⚠️ 判据是「**结构化** tool-call 块」——不是「模型在正文里说它想调工具」。
    // 后者正是 Qoder/TRAE 踩过的缺陷形态（插件没把 tools 发出去，
    // 模型只能用正文 XML 臆造，harness 认不出 → 任务终止）。
    expect(JSON.parse(blocks[0]!.arguments)).toHaveProperty('city')
    expect(finish).toBe('tool-calls')
  }, 120_000)

  it.runIf(testAll)('⚠️（可选）M3 与 M2.7-highspeed 也能返回文本', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const adapter = makeLiveAdapter(probe!.credential.access_token)
    for (const model of ['MiniMax-M3', 'MiniMax-M2.7-highspeed']) {
      const result = await runStream(adapter, model)
      // eslint-disable-next-line no-console
      console.log(`[minimax-chat] ${model} → 文本=${JSON.stringify(result.text)}`
        + ` finish=${result.finish}`)
      expect(result.text.length).toBeGreaterThan(0)
    }
  }, 180_000)
})
