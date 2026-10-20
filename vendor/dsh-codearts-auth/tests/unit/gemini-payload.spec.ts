/**
 * Gemini 信封的**字节级金标准**单测。
 *
 * ⚠️ 核心用例是**逐字节断言**，不是形状断言：上游对信封字段顺序敏感
 * （Go 侧 `marshalAlphabetical` 按键名排序后再发），TS 的 `JSON.stringify`
 * 按**插入序**输出，两者不一致时请求仍能成功，但会偏离已抓包验证过的形态。
 *
 * 故：**不要**为了「看起来更整齐」调整本文件里的期望字符串。
 */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  GEMINI_DEFAULT_PROJECT,
  GEMINI_EFFORT_IDS,
  GEMINI_FALLBACK_MODELS,
  GEMINI_SESSION_ID_INFER,
  geminiCanonicalModelId,
  geminiEffortLabel,
  geminiEffortToTier,
  geminiModelSpec,
  geminiReasoningInfo,
  marshalAlphabetical,
  newGeminiRequestId,
  sanitizeGeminiSchema,
  sortedStringify,
} from '../../src/gemini.js'
import { translateGeminiRequest } from '../../src/gemini-messages.js'
import type { Message } from '@deepseek-ai/dsh-llm'

const msg = (role: 'user' | 'assistant', content: unknown[]): Message =>
  ({ role, content } as Message)

/** 最小请求：一条 user 文本。 */
function minimalEnvelope(effort: string, maxTokens: number) {
  return translateGeminiRequest({
    modelId: 'gemini-3.8-flash',
    spec: geminiModelSpec('gemini-3.8-flash', effort),
    messages: [msg('user', [{ type: 'text', text: 'reply one word: ok' }])],
    sessionId: GEMINI_SESSION_ID_INFER,
    requestId: 'agent/1790868102000/f37baaa0',
    maxTokens,
  })
}

describe('信封字节金标准（计划 §六）', () => {
  const GOLDEN =
    '{"model":"gemini-3.8-flash-high","project":"aicode-consumers","request":{"contents":[{"parts":[{"text":"reply one word: ok"}],"role":"user"}],"generationConfig":{"maxOutputTokens":50,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":10000}},"sessionId":"3124275334370613369"},"requestId":"agent/1790868102000/f37baaa0","userAgent":"antigravity"}'

  it('high 档 + 50 输出预算 → 353 字节逐字一致', () => {
    const wire = marshalAlphabetical(minimalEnvelope('high', 50))
    expect(wire).toBe(GOLDEN)
    expect(Buffer.byteLength(wire, 'utf8')).toBe(353)
  })

  it('递归按键名升序（数组保序）；纯标量与 JSON.stringify 一致', () => {
    expect(sortedStringify({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    )
    expect(sortedStringify('x')).toBe('"x"')
    expect(sortedStringify(null)).toBe('null')
  })

  it('档位决定模型后缀与 thinkingBudget；tiered 只带 includeThoughts', () => {
    const thinkingOf = (effort: string): unknown =>
      (minimalEnvelope(effort, 50).request.generationConfig as { thinkingConfig: unknown })
        .thinkingConfig

    expect(minimalEnvelope('high', 50).model).toBe('gemini-3.8-flash-high')
    expect(thinkingOf('high')).toEqual({ includeThoughts: true, thinkingBudget: 10_000 })
    expect(minimalEnvelope('low', 50).model).toBe('gemini-3.8-flash-low')
    expect(thinkingOf('low')).toEqual({ includeThoughts: true, thinkingBudget: 1_000 })
    // tiered = 让上游自适应，发 thinkingBudget 反而把它钉死。
    expect(minimalEnvelope('tiered', 50).model).toBe('gemini-3.8-flash-tiered')
    expect(thinkingOf('tiered')).toEqual({ includeThoughts: true })
  })

  it('project 默认 aicode-consumers，userAgent 恒 antigravity，requestId 每请求随机', () => {
    const envelope = minimalEnvelope('medium', 50)
    expect(envelope.project).toBe(GEMINI_DEFAULT_PROJECT)
    expect(envelope.userAgent).toBe('antigravity')
    expect(newGeminiRequestId(1_790_868_102_000)).toMatch(/^agent\/1790868102000\/[0-9a-f]{8}$/)
    expect(newGeminiRequestId(1)).not.toBe(newGeminiRequestId(1))

    const custom = translateGeminiRequest({
      modelId: 'gemini-3.8-flash',
      spec: geminiModelSpec('gemini-3.8-flash', 'medium'),
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      sessionId: GEMINI_SESSION_ID_INFER,
      requestId: 'agent/1/aaaaaaaa',
      project: 'other-project',
    })
    expect(custom.project).toBe('other-project')
  })
})

describe('模型目录与档位声明', () => {
  it('模型表只有 1 条（lite 已移除：上游恒 404，暴露即坑），声明 4 档 + defaultEffort=medium', () => {
    expect(GEMINI_FALLBACK_MODELS.map((entry) => entry.id)).toEqual(['gemini-3.8-flash'])
    expect(GEMINI_EFFORT_IDS).toEqual(['low', 'medium', 'high', 'tiered'])
    expect(GEMINI_EFFORT_IDS.map(geminiEffortLabel)).toEqual(['低', '中', '高', '自适应'])

    const info = geminiReasoningInfo(GEMINI_FALLBACK_MODELS[0]!)
    expect(info?.efforts.map((effort) => String(effort.id))).toEqual([...GEMINI_EFFORT_IDS])
    expect(String(info?.defaultEffort)).toBe('medium')
  })

  it('未知档位退化为 medium（不报错、不编造）', () => {
    expect(geminiEffortToTier(undefined)).toBe('medium')
    expect(geminiEffortToTier('xhigh')).toBe('medium')
  })
})

describe('模型 id 严格校验（未知 id 必须拒绝，不得静默落回 3.8）', () => {
  it('合法 id 带档位后缀；带档位的 3.8 名放行（限流标记 / account.test 探测传的就是它）', () => {
    expect(geminiModelSpec('gemini-3.8-flash', 'high').upstream).toBe('gemini-3.8-flash-high')
    // 缺省档位 = medium（同 geminiEffortToTier 默认分支）
    expect(geminiModelSpec('gemini-3.8-flash').upstream).toBe('gemini-3.8-flash-medium')
    // 归一化剥掉档位后缀后命中目录；upstream 仍由 effort 决定。
    expect(geminiModelSpec('gemini-3.8-flash-tiered', 'high').upstream).toBe('gemini-3.8-flash-high')

    expect(geminiCanonicalModelId('gemini-3.8-flash-high')).toBe('gemini-3.8-flash')
    expect(geminiCanonicalModelId('gemini-3.8-flash')).toBe('gemini-3.8-flash')
    // 非档位后缀不动
    expect(geminiCanonicalModelId('gemini-3.7-flash')).toBe('gemini-3.7-flash')
  })

  it('未知 id 抛 INVALID_REQUEST 且带 status 404（曾实测假名 200 静默跑 3.8）', () => {
    for (const bad of ['gemini-3.7-flash', 'gemini-9.9-fake', 'totally-bogus', '']) {
      let thrown: unknown
      try {
        geminiModelSpec(bad)
      } catch (error) {
        thrown = error
      }
      expect(thrown, `id "${bad}" 应被拒绝`).toBeInstanceOf(LlmError)
      expect((thrown as LlmError).failure.code).toBe('INVALID_REQUEST')
      // ⚠️ 必须带 404：网关只读 `failure.status`（顶层没有 status），缺了它
      // 模型名写错会以 502 离开网关并被 OpenAI 客户端反复重试（白耗额度）。
      expect((thrown as LlmError).failure.status).toBe(404)
    }
  })
})

describe('schema 清洗（白名单）', () => {
  it('递归删白名单外的键（含 items / anyOf），enum 含非字符串值时整删', () => {
    const cleaned = sanitizeGeminiSchema({
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件路径', examples: ['a.go'] },
        list: { type: 'array', items: { type: 'string', $comment: 'drop me' } },
      },
      anyOf: [{ type: 'number', exclusiveMinimum: 0 }],
    })
    expect(cleaned).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        list: { type: 'array', items: { type: 'string' } },
      },
      anyOf: [{ type: 'number' }],
    })

    expect(sanitizeGeminiSchema({ type: 'string', enum: ['a', 1] })).toEqual({ type: 'string' })
  })

  it('type 为数组时收敛成单值 + nullable', () => {
    expect(sanitizeGeminiSchema({ type: ['string', 'null'] })).toEqual({
      type: 'string',
      nullable: true,
    })
  })
})
