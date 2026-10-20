/**
 * 真实会话回放回归（离线、只读、无网络）。
 *
 * ## 为什么需要它
 *
 * 单测用的消息是**自造的精简形状**，可能恰好通过、却在真实数据上失效。
 * 本用例读一条**真实会话**（由 DSH 0.1.7 的解析器迁移后）喂给插件，
 * 直接锁住用户报障的那个缺陷。
 *
 * ## 缺陷与判据
 *
 * DSH 0.1.7 把工具结果改为一等 `role:'tool'` 消息后，插件原按
 * `type === 'tool-result'` 识别结果 → 结果 id 集合恒空 →
 * `resolveToolPairing` 把 assistant 的**全部 tool_calls 剔除**。
 * 模型在 wire 上看不到自己调用过什么，表现为「无工具调用即判对话结束」
 * 或「陷入循环思考」。
 *
 * 实测（`session-54cbd95c`，2492 行 v3 日志）：修复前保留 **0** 条工具调用，
 * 修复后 **512** 条，与 0.1.5 形状对照完全一致。
 *
 * ## 数据来源与跳过条件
 *
 * 会话日志在用户机器上，不入库。用例通过 `DSH_SESSION_FIXTURE` 指向
 * 一个**已由 0.1.7 解析器导出**的 JSON 文件（消息数组），未设置则跳过。
 * 导出脚本：`scripts/export-session-messages.mjs`。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serializeMessages } from '../../src/llm-adapter.js'
import { resolveToolPairing } from '../../src/sse.js'

/** 已由 0.1.7 解析器迁移后的消息数组（含一等 `role:'tool'` 消息）。 */
type HarnessMessage = Record<string, unknown>

const fixturePath = process.env['DSH_SESSION_FIXTURE']

/** 把一等 `tool` 消息包回 0.1.5 形状，用作等价性对照。 */
function toLegacy(messages: readonly HarnessMessage[]): HarnessMessage[] {
  return messages.map(message => message['role'] !== 'tool'
    ? message
    : {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: message['toolCallId'],
        content: message['content'],
        isError: message['isError'],
      }],
    })
}

const countToolCalls = (wire: readonly Record<string, unknown>[]): number => wire
  .filter(message => message['role'] === 'assistant' && Array.isArray(message['tool_calls']))
  .reduce((sum, message) => sum + (message['tool_calls'] as unknown[]).length, 0)

describe.skipIf(fixturePath === undefined)('真实会话回放（0.1.7 消息形状）', () => {
  // ⚠️ **必须惰性读取**：`describe.skipIf` 仍会执行回调体来收集用例，
  // 在文件顶层读 `undefined` 会让未设 fixture 时的整份套件变成 Failed Suite
  // （而不是干净地 skip）。
  let cached: HarnessMessage[] | undefined
  const sessionMessages = (): HarnessMessage[] => {
    cached ??= JSON.parse(readFileSync(fixturePath!, 'utf8')) as HarnessMessage[]
    return cached
  }

  it('会话里确实含一等 tool 消息（否则本用例无意义）', () => {
    // 防止 fixture 退化成 0.1.5 形状时用例静默变成同义反复。
    expect(sessionMessages().some(message => message['role'] === 'tool')).toBe(true)
  })

  it('工具调用一条都不丢（用户报障的缺陷）', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing(sessionMessages())
    expect(keepCallIds.size).toBeGreaterThan(0)
    expect(keepResultIds.size).toBe(keepCallIds.size)
  })

  it('0.1.7 形状与 0.1.5 形状的配对结果完全一致', () => {
    const messages = sessionMessages()
    const now = resolveToolPairing(messages)
    const legacy = resolveToolPairing(toLegacy(messages))
    expect([...now.keepCallIds].sort()).toEqual([...legacy.keepCallIds].sort())
    expect([...now.keepResultIds].sort()).toEqual([...legacy.keepResultIds].sort())
  })

  it('序列化产出的 tool_calls 与 role:tool 消息数量与 0.1.5 形状一致', () => {
    const messages = sessionMessages()
    const now = serializeMessages(messages)
    const legacy = serializeMessages(toLegacy(messages))
    expect(countToolCalls(now)).toBe(countToolCalls(legacy))
    expect(countToolCalls(now)).toBeGreaterThan(0)
    expect(now.filter(message => message['role'] === 'tool').length)
      .toBe(legacy.filter(message => message['role'] === 'tool').length)
  })
})
