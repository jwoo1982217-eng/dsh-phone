import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { parseModelRoute, toGenerateOptions, OpenAiGatewayError, normalizeReasoningEffort, normalizeMaxTokens, type ReasoningEffortNotice } from '../../src/openai-gateway/messages.js'

/** 1×1 透明 PNG 的 data URL（图片入站用例共用，与 responses spec 同一份）。 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 附件服务替身：记录落盘次数，便于断言「图片真的到了」而非「没报错」。 */
const bridge = {
  saveImage: async ({ data, mediaType }: { data: Uint8Array; mediaType: string }) => ({
    attachmentId: `sha256:${mediaType}:${data.length}`,
    mediaType,
  }),
}

/**
 * `reasoning_effort` 的归一化。
 *
 * 背景（**实机报障**）：ZCode 经网关调 `lobsterai/MiniMax-M3.1-Flash-Preview`
 * 直接失败：
 *   `provider "lobsterai" model "..." does not support reasoning effort "high"`
 *
 * 根因：该模型**没有 `thinkingConfig`** ⇒ 适配器不声明 reasoning ⇒ 网关拿到
 * `supported.size === 0`，而那时代码是**原样透传** `high` ⇒ DSH 侧校验拒绝。
 *
 * 正确的处理是**不发** `reasoningEffort`（让模型走它自己的默认），而不是把一个
 * 该模型根本不认识的档位硬塞过去。
 */
describe('normalizeReasoningEffort', () => {
  const ON_OFF = { reasoning: { efforts: [{ id: 'on' }, { id: 'off' }] } }

  it('★ 模型未声明思考档位时不下发该参数（而不是原样透传未知的档位）', () => {
    // 原样透传会得到 DSH 侧的 UNSUPPORTED_REASONING_EFFORT（实机报障原句）。
    // ⚠️ 必须返回 **null**（明确不下发）而不是 undefined（= 用户没传）：
    // undefined 会被 toGenerateOptions 当成「没给值」而回退读 body.reasoning_effort，
    // 归一化结论被原样抵消 —— 这是本缺陷第二轮的复发形态。
    expect(normalizeReasoningEffort('high', {}, 'lobsterai', 'MiniMax-M3.1-Flash-Preview')).toBeNull()
    expect(normalizeReasoningEffort('on', {}, 'lobsterai', 'm')).toBeNull()
    expect(normalizeReasoningEffort('none', {}, 'lobsterai', 'm')).toBeNull()
  })

  it('★ null 传进 toGenerateOptions 后不得让 body 的原值复活（回归锁）', () => {
    // 这是报障的直接形态：body 里明明有 reasoning_effort:'high'，
    // 而归一化已判定「本模型不适用」，最终请求里**不能**再出现它。
    const body = {
      model: 'lobsterai/MiniMax-M3.1-Flash-Preview',
      messages: [{ role: 'user' as const, content: 'hi' }],
      reasoning_effort: 'high',
    }
    const effort = normalizeReasoningEffort(body.reasoning_effort, {}, 'lobsterai', 'MiniMax-M3.1-Flash-Preview')
    expect(effort).toBeNull()
    const options = toGenerateOptions(body, new AbortController().signal, effort)
    expect('reasoningEffort' in options).toBe(false)
  })

  it('未传该参数时（undefined）仍回退读 body，保持直连调用的老行为', async () => {
    const body = {
      model: 'qoder/qfmodel',
      messages: [{ role: 'user' as const, content: 'hi' }],
      reasoning_effort: 'high',
    }
    // 第三个参数省略 = 调用方没给 → 走 body
    const options = await toGenerateOptions(body, new AbortController().signal)
    expect(options.reasoningEffort).toBe('high')
  })

  it('模型未声明思考档位时，resolveModelInfo 整体失败也一律不下发', () => {
    // modelInfo 是 undefined 时同样不能透传：那不是「没有限制」，是「不知道」。
    expect(normalizeReasoningEffort('high', undefined, 'lobsterai', 'm')).toBeNull()
  })

  it('声明了 on/off 的模型：OpenAI 的 high/max 等一律映射成 on', () => {
    for (const requested of ['high', 'medium', 'low', 'minimal', 'xhigh', 'max']) {
      expect(normalizeReasoningEffort(requested, ON_OFF, 'lobsterai', 'm'), requested).toBe('on')
    }
  })

  it('声明了 on/off 的模型：none/off 映射成 off', () => {
    expect(normalizeReasoningEffort('none', ON_OFF, 'qoder', 'qfmodel')).toBe('off')
    expect(normalizeReasoningEffort('off', ON_OFF, 'qoder', 'qfmodel')).toBe('off')
  })

  it('已声明的档位原样透传', () => {
    expect(normalizeReasoningEffort('off', ON_OFF, 'qoder', 'qfmodel')).toBe('off')
    expect(normalizeReasoningEffort('on', ON_OFF, 'qoder', 'qfmodel')).toBe('on')
  })

  it('CodeArts 只有 on/off：任何档位都归到这两档，永不抛错', () => {
    // CodeArts 服务端只认顶层 thinking.type（llm-adapter.ts:862-866 实测），
    // 档位阶梯是假的，故这里必须二值化而不是报错。
    for (const requested of ['high', 'low', 'minimal', 'max', 'xhigh']) {
      expect(normalizeReasoningEffort(requested, {}, 'codearts', 'GLM-5.3')).toBe('on')
    }
    // 明确「关掉思考」的两���值才映射到 off。
    expect(normalizeReasoningEffort('none', {}, 'codearts', 'GLM-5.3')).toBe('off')
    expect(normalizeReasoningEffort('off', {}, 'codearts', 'GLM-5.3')).toBe('off')
  })

  it('★ 客户端只有通用档位名、模型用的是私有 id 时**就近翻译**而不是报错', () => {
    // 实机报障的第二形态：CC Switch 的档位多选器只有固定 8 档（none…ultra），
    // 而 TRAE / LobsterAI / Cline 的 wire 值是私有 id。用户照 DSH 界面上的名字填
    // （Max / Extra / Extra High），旧实现一律 400 —— 整轮对话不可用，且用户
    // 从两端都看不出为什么（客户端根本没有能表达私有 id 的写法）。
    const trae = { reasoning: { efforts: [{ id: 'light' }, { id: 'high' }, { id: 'extra_high' }] } }
    expect(normalizeReasoningEffort('low', trae, 'trae', 'deepseek-v4.1-flash')).toBe('light')
    expect(normalizeReasoningEffort('xhigh', trae, 'trae', 'deepseek-v4.1-flash')).toBe('extra_high')
    expect(normalizeReasoningEffort('high', trae, 'trae', 'deepseek-v4.1-flash')).toBe('high')
    // LobsterAI：界面上叫 Max，wire 值是 xhigh。
    const lobster = { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'xhigh' }] } }
    expect(normalizeReasoningEffort('max', lobster, 'lobsterai', 'deepseek-flash')).toBe('xhigh')
    // Cline：界面上叫 Extra，wire 值是 max。
    const cline = { reasoning: { efforts: [{ id: 'none' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }] } }
    expect(normalizeReasoningEffort('xhigh', cline, 'cline', 'm')).toBe('max')
  })

  it('★ 翻译与「无法表达」都要通过 onNotice 报出来（否则用户看不出档位被换了）', () => {
    const notices: ReasoningEffortNotice[] = []
    const trae = { reasoning: { efforts: [{ id: 'light' }, { id: 'high' }, { id: 'extra_high' }] } }
    normalizeReasoningEffort('low', trae, 'trae', 'm', notice => notices.push(notice))
    normalizeReasoningEffort('none', trae, 'trae', 'm', notice => notices.push(notice))
    normalizeReasoningEffort('high', trae, 'trae', 'm', notice => notices.push(notice))
    expect(notices).toEqual([
      { requested: 'low', outcome: 'translated', applied: 'light' },
      { requested: 'none', outcome: 'unexpressible' },
    ])
  })

  it('模型没有这一族的档位时**不下发**（例如给只声明 high 的模型要 none）', () => {
    // 客户端表达得出「关闭思考」，模型却没有关闭档 —— 这时下发什么都是错的，
    // 只能不发（按模型默认走）并留日志。返回值必须是 null（明确不下发）。
    const only = { reasoning: { efforts: [{ id: 'high' }] } }
    expect(normalizeReasoningEffort('none', only, 'workbuddy', 'm')).toBeNull()
    expect(normalizeReasoningEffort('off', only, 'workbuddy', 'm')).toBeNull()
    expect(normalizeReasoningEffort('high', only, 'workbuddy', 'm')).toBe('high')
  })

  it('★ 完全不认识的写法仍然 400，并把可用档位写进报错（拼错不该被静默翻译）', () => {
    const trae = { reasoning: { efforts: [{ id: 'light' }, { id: 'high' }] } }
    expect(() => normalizeReasoningEffort('banana', trae, 'trae', 'm'))
      .toThrow(/light, high/)
    expect(() => normalizeReasoningEffort('banana', trae, 'trae', 'm'))
      .toThrow(OpenAiGatewayError)
    // 报错必须能被客户端识别为「参数问题」而不是服务端故障。
    try {
      normalizeReasoningEffort('banana', trae, 'trae', 'm')
      expect.unreachable('应当抛错')
    } catch (error) {
      expect((error as OpenAiGatewayError).code).toBe('unsupported_reasoning_effort')
      expect((error as OpenAiGatewayError).status).toBe(400)
    }
  })

  it('就近翻译：模型缺中间档时落到更接近的那个（同距取更强）', () => {
    const graded = { reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }] } }
    // high(5) 到 medium(4) 比到 low(3) 更近。
    expect(normalizeReasoningEffort('high', graded, 'qoder', 'm')).toBe('medium')
    expect(normalizeReasoningEffort('minimal', graded, 'qoder', 'm')).toBe('low')
  })

  it('未传 reasoning_effort 时不下发该参数', () => {
    expect(normalizeReasoningEffort(undefined, ON_OFF, 'qoder', 'm')).toBeUndefined()
  })
})

describe('OpenAI gateway request conversion', () => {  it('parses a namespaced model route', () => {
    expect(parseModelRoute('qoder/qfmodel')).toEqual({ provider: 'qoder', model: 'qfmodel' })
  })

  it('rejects a model without provider namespace', () => {
    expect(() => parseModelRoute('qfmodel')).toThrow(OpenAiGatewayError)
  })

  it('converts text, assistant tool calls, tool results and tools', async () => {
    const options = await toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'file content' },
      ],
      tools: [{ type: 'function', function: { name: 'read', description: 'read file', parameters: { type: 'object' } } }],
      max_tokens: 100,
      max_completion_tokens: 200,
      reasoning_effort: 'high',
      stream: true,
    }, new AbortController().signal)

    expect(options.provider).toBe('qoder')
    expect(options.model).toBe('qfmodel')
    expect(options.maxTokens).toBe(200)
    expect(options.reasoningEffort).toBe(ReasoningEffortId('high'))
    expect(options.tools).toEqual([{ name: 'read', description: 'read file', parameters: { type: 'object' } }])
    expect(options.messages).toHaveLength(4)
    expect(options.messages[2].content).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'read' }))
    expect(options.messages[3]).toMatchObject({ role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file content' }] })
  })

  it('maps generic reasoning levels to the provider declared on/off levels', () => {
    const info = { reasoning: { efforts: [{ id: 'on' }, { id: 'off' }] } }
    expect(normalizeReasoningEffort('max', info)).toBe('on')
    expect(normalizeReasoningEffort('high', info)).toBe('on')
    expect(normalizeReasoningEffort('none', info)).toBe('off')
    expect(normalizeReasoningEffort('off', info)).toBe('off')
  })
  it('clamps CodeArts output tokens to its verified upstream limit', () => {
    expect(normalizeMaxTokens(128000, 'codearts', 'deepseek-v4-flash')).toBe(65536)
    expect(normalizeMaxTokens(32000, 'codearts', 'deepseek-v4-flash')).toBe(32000)
  })
  it('clamps GLM-5.2 output budget without changing unrelated models', () => {
    expect(normalizeMaxTokens(128000, 'codearts', 'GLM-5.2')).toBe(65536)
    expect(normalizeMaxTokens(32000, 'codearts', 'GLM-5.2')).toBe(32000)
    expect(normalizeMaxTokens(128000, 'qoder', 'qfmodel')).toBe(128000)
  })
  it.each(['glm-5.3-flash', 'deepseek-v4.1-flash'])(
    'clamps the CodeArts %s output budget', (model) => {
      expect(normalizeMaxTokens(128000, 'codearts', model)).toBe(65536)
      expect(normalizeMaxTokens(32000, 'codearts', model)).toBe(32000)
      expect(normalizeMaxTokens(undefined, 'codearts', model)).toBeUndefined()
      expect(normalizeMaxTokens(128000, 'buddy', model)).toBe(128000)
    },
  )

  /**
   * ⚠️ 判据**必须忽略大小写**，这是实测出来的真实缺陷（PR !70 审计）。
   *
   * codearts 目录本身大小写混用（`GLM-5.2` 大写与 `glm-5.3-flash` 小写并存），
   * 而 `parseModelRoute` 是纯字符串切片、**不做任何归一化**。用户照着真实存在
   * 的 `GLM-5.2` 拼出 `GLM-5.3-Flash` 完全现实。
   *
   * 更关键：`CodeArtsAdapter.resolveModel` 对目录外模型是
   * `remoteModel?.name ?? model` —— **原样放行、从不拒绝**（dsh-llm 的
   * `normalizeModelInfo` 只校验字段类型，注释明写 catalog membership is
   * advisory）⇒ 网关**不会提前 404**，绕过的值会真的发往上游。
   * 判据不归一化 ⇒ 这条路径上没有任何防线。
   *
   * ⇒ 必须**双向**覆盖：大写 `GLM-5.2` 的小写变体同样要命中（那是修复前就
   * 存在的缺口），不能只测新加的两个模型。
   */
  it.each([
    ['GLM-5.3-Flash', '照 GLM-5.2 的大写习惯拼出的 glm-5.3-flash'],
    ['GLM-5.3-FLASH', '全大写变体'],
    ['Deepseek-V4.1-Flash', '首字母大写变体'],
    ['DEEPSEEK-V4.1-FLASH', '全大写变体'],
    ['glm-5.2', '既有 GLM-5.2 的小写变体（双向缺口）'],
    ['Deepseek-V4-Flash', '既有 deepseek-v4-flash 的大写变体'],
  ])('大小写变体 %s 同样被钳制（%s）', (model) => {
    expect(normalizeMaxTokens(128000, 'codearts', model)).toBe(65536)
    expect(normalizeMaxTokens(32000, 'codearts', model)).toBe(32000)
  })

  it('大小写归一化不得误伤：真实 id 与非 CodeArts provider 保持原行为', () => {
    // 目录里的真实形态必须仍然命中（防止归一化改坏既有行为）
    expect(normalizeMaxTokens(128000, 'codearts', 'GLM-5.2')).toBe(65536)
    expect(normalizeMaxTokens(128000, 'codearts', 'glm-5.3-flash')).toBe(65536)
    expect(normalizeMaxTokens(128000, 'codearts', 'deepseek-v4.1-flash')).toBe(65536)
    expect(normalizeMaxTokens(128000, 'codearts', 'deepseek-v4-flash')).toBe(65536)
    // 别的 provider 同名模型不受影响
    expect(normalizeMaxTokens(128000, 'buddy', 'glm-5.3-flash')).toBe(128000)
    // **白名单**语义：相近但不同的 id 不得被误伤
    expect(normalizeMaxTokens(128000, 'codearts', 'deepseek-v4.1')).toBe(128000)
    expect(normalizeMaxTokens(128000, 'codearts', 'glm-5.3')).toBe(128000)
    // 钳制只压到白名单模型，带日期后缀的形态仍不在范围内（既有行为）
    expect(normalizeMaxTokens(128000, 'codearts', 'deepseek-v4-flash-0731')).toBe(128000)
  })

  it('maps CodeArts generic levels even when legacy runtime omits reasoning metadata', () => {
    expect(normalizeReasoningEffort('high', undefined, 'codearts', 'deepseek-v4-flash')).toBe('on')
    expect(normalizeReasoningEffort('max', undefined, 'codearts', 'deepseek-v4-flash')).toBe('on')
    expect(normalizeReasoningEffort('none', undefined, 'codearts', 'deepseek-v4-flash')).toBe('off')
  })

  // ⚠️ 与 Responses 路径同因同修（缺陷在共享的 `textFromContent` 判据上）：
  // `role:'tool'` 的 content 也支持图片，两条协议必须一致 ——
  // 只修一条会让「同一份历史在两个端点上一条能跑、一条 400」。
  it('★ role=tool 的内容带图时：图片落进 SDK 一等 tool 消息（Chat 路径同样修好）', async () => {
    const saved: string[] = []
    const imageBridge = {
      saveImage: async ({ data, mediaType }: { data: Uint8Array; mediaType: string }) => {
        saved.push(mediaType)
        return { attachmentId: `sha256:${mediaType}:${data.length}`, mediaType }
      },
    }
    const options = await toGenerateOptions({
      model: 'trae/deepseek-v4.1-flash',
      messages: [
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'view_image', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call-1', content: [{ type: 'image_url', image_url: { url: PNG } }] },
      ],
    }, new AbortController().signal, undefined, undefined, { bridge: imageBridge })

    const results = options.messages
      .filter(message => message.role === 'tool')
    expect(results).toHaveLength(1)
    expect(results[0].content.map(block => block.type)).toEqual(['image'])
    expect(saved).toEqual(['image/png'])
  })

  it('assistant 带图仍明确报错（没有图片通道，不得静默丢弃）', async () => {
    await expect(toGenerateOptions({
      model: 'trae/deepseek-v4.1-flash',
      messages: [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: PNG } }] }],
    }, new AbortController().signal, undefined, undefined, { bridge }))
      .rejects.toThrow(/不能包含图片/)
  })

  it('rejects forced function tool choice in the first version', async () => {
    await expect(toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: { type: 'function', function: { name: 'read' } },
    }, new AbortController().signal)).rejects.toThrow(/tool_choice/i)
  })
})
