import { normalizeHarnessMessages } from '../../src/message-shape.js'
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
  // ⚠️ 顺序按真实声明（强度序：`off` 在 `on` 前，Issue IKLIDV）。
  // 翻译层按 rank 就近匹配、**不看位置**，故顺序在此不影响任何结论。
  const ON_OFF = { reasoning: { efforts: [{ id: 'off' }, { id: 'on' }] } }

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
    const info = { reasoning: { efforts: [{ id: 'off' }, { id: 'on' }] } }
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

  // ⚠️⚠️ **真实缺陷回归**（Gitee issue IKLRIK，2026-10-14 用户报障）：
  // 「空名 function_call 在网关两条入口都硬 400 —— 客户端每轮重放坏块，整条会话报废」。
  //
  // 客户端（Claude Desktop → cc-switch → 本机网关）历史里落了一条 `name: ""` 的
  // `tool_use`，客户端回 `No such tool available:` —— 此后**每轮必 400**
  //（`assistant.tool_calls contains an invalid function call`，实测 37ms）。
  //
  // 关键在于**位置**：下游每一层（`resolveToolPairing`，九个适配器都调它）对同一份
  // 坏数据都是「剔除并继续」，而网关站在所有那些防线**之前**。同一个仓库里两套口径，
  // 更严的那套在最外层 —— 于是可恢复数据在最外层变成致命参数错误。
  // ⇒ 网关必须按同一取舍处理：**剔除，不拒绝**。
  describe('★ 空名 tool_call 是剔除而不是 400（Issue IKLRIK）', () => {
    const emptyNameCall = (id: string, args = '{"command":"ls"}') => ({
      id, type: 'function', function: { name: '', arguments: args },
    })

    it('name 为空串：剔除该调用与配对的 tool 结果，其余历史照常发给上游（不再 400）', async () => {
      const options = await toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: null, tool_calls: [emptyNameCall('call_bad')] },
          { role: 'tool', tool_call_id: 'call_bad', content: 'No such tool available: ' },
        ],
      }, new AbortController().signal)

      // 剔除的是**坏块本身**：不得在 wire 上留下空名调用。
      expect(JSON.stringify(options.messages)).not.toContain('call_bad')
      const blocks = normalizeHarnessMessages(options.messages).flatMap(message => message.content ?? [])
      expect(blocks.filter(block => block.type === 'tool-call')).toHaveLength(0)
      // ⚠️ 配对的工具结果必须**一并**剔除：孤儿 `tool-result` 上游照样拒。
      expect(blocks.filter(block => block.type === 'tool-result')).toHaveLength(0)
      // 正常历史不受影响（用户那句话还在）。
      expect(options.messages[0].role).toBe('user')
    })

    it('同批里的其它调用不受影响（剔除是按条，不是整批）', async () => {
      const options = await toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: null, tool_calls: [
            emptyNameCall('call_bad'),
            { id: 'call_ok', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
          ] },
          { role: 'tool', tool_call_id: 'call_bad', content: 'No such tool available: ' },
          { role: 'tool', tool_call_id: 'call_ok', content: 'file list' },
        ],
      }, new AbortController().signal)

      const calls = normalizeHarnessMessages(options.messages)
        .flatMap(message => message.content ?? [])
        .filter(block => block.type === 'tool-call')
      // 好的那条必须原样保留（含名字与参数）。
      expect(calls).toEqual([{ type: 'tool-call', id: 'call_ok', name: 'Bash', arguments: '{"command":"ls"}' }])
      const results = normalizeHarnessMessages(options.messages)
        .flatMap(message => message.content ?? [])
        .filter(block => block.type === 'tool-result')
      // 只有好调用的结果留下 —— 坏调用那条结果已剔除，好调用的结果**不能**被连带剔掉。
      expect(results.map((block: any) => block.toolCallId)).toEqual(['call_ok'])
    })

    // ⚠️ 判据必须用共享的 `hasUsableToolName`（**trim 后**非空），不能自己写
    // `length > 0`：后者会把全空白名放过去，而上游同样拒它。
    it('全空白名同样剔除（判据是 trim 后非空，不是 length > 0）', async () => {
      const options = await toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: null, tool_calls: [
            { id: 'call_blank', type: 'function', function: { name: '   ', arguments: '{}' } },
          ] },
          { role: 'tool', tool_call_id: 'call_blank', content: 'nope' },
        ],
      }, new AbortController().signal)
      expect(JSON.stringify(options.messages)).not.toContain('call_blank')
    })

    // ⚠️ 反向边界：**只放宽「名字」这一格**。`id` 缺失是真·形状错误，不能一并放行 ——
    // 那会让这条用例变成「什么都放过」的空断言。
    it('id 缺失仍然报错（放宽的只有 name 这一格）', async () => {
      await expect(toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'assistant', content: null, tool_calls: [
            { type: 'function', function: { name: 'Bash', arguments: '{}' } },
          ] },
        ],
      }, new AbortController().signal)).rejects.toThrow(/invalid function call/)
    })

    it('名字可用但 arguments 不是字符串仍然报错', async () => {
      await expect(toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'assistant', content: null, tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: { command: 'ls' } } },
          ] },
        ],
      }, new AbortController().signal)).rejects.toThrow(/invalid function call/)
    })

    // ⚠️⚠️ **判据一致性守卫**（本仓库首条红线：同一语义不得有两套判据）。
    // 本修法要在**两处**判断同一调用「坏不坏」：主转换（`convertToolCalls`）与
    // 预扫（`collectUnusableCallIds`）。两处若各写一遍 id/名字判据，改一处忘另一处
    // 就会**静默漂移**。
    //
    // ⚠️ **第一版这条用例没有牙**（反向验证实测：把预扫的 id 判据改成 trim、与主转换
    // 漂移后，它**仍全绿**）—— 因为原用例的 id 都是「规整」的，两套判据结论恰好相同。
    // **有区分力的输入是「id 带首尾空格」的坏调用**：客户端回传结果时用的就是**原样**
    // id，于是预扫 trim 成 `call_bad` 去查、结果那侧是 `  call_bad  ` ⇒ 查不中 ⇒
    // **孤儿 tool-result 泄漏到 wire 上**（漂移探针实测确有此残迹，而上游照样 400）。
    // ⇒ 判据必须落在「原样 id」上：id 是不透明标识符，`trim` 会配错对象。
    it('★ 预扫与主转换必须对同一条调用给出一致结论（id 带空格也不得漂移）', async () => {
      // 混合历史：坏调用（空名）与好调用共存，且坏调用的 id 长度/形态各异，
      // **含带首尾空格、含全空白名**两份。
      const messages = [
        { role: 'user', content: 'ping' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call_bad_1', type: 'function', function: { name: '', arguments: '{}' } },
          { id: 'call_ok', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
          { id: 'call_bad_2', type: 'function', function: { name: '   ', arguments: '{}' } },
          { id: '  call_bad_3  ', type: 'function', function: { name: '', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_bad_1', content: 'no tool' },
        { role: 'tool', tool_call_id: 'call_ok', content: 'ok' },
        { role: 'tool', tool_call_id: 'call_bad_2', content: 'no tool' },
        // ⚠️ 结果的 id 与调用**逐字符相同**（含首尾空格）—— 客户端就是这么回传的。
        { role: 'tool', tool_call_id: '  call_bad_3  ', content: 'no tool' },
      ]
      const options = await toGenerateOptions(
        { model: 'hub/hub-deepseek-v4.1-flash', messages },
        new AbortController().signal,
      )
      const blocks = normalizeHarnessMessages(options.messages).flatMap(message => message.content ?? [])
      const wire = JSON.stringify(options.messages)
      // 三条坏调用**都**必须被剔除，且**都不留残迹**（含那条带空格的 id）。
      expect(wire).not.toContain('call_bad_1')
      expect(wire).not.toContain('call_bad_2')
      expect(wire).not.toContain('call_bad_3')
      // 好调用及其结果**都**必须保留。
      expect(blocks.filter(block => block.type === 'tool-call')).toEqual([
        { type: 'tool-call', id: 'call_ok', name: 'Bash', arguments: '{"command":"ls"}' },
      ])
      expect(blocks.filter(block => block.type === 'tool-result').map((block: any) => block.toolCallId))
        .toEqual(['call_ok'])
    })

    // ⚠️⚠️ **重复 `call_id` 时好调用的回执被连带剔除**（对抗审计实测打穿的真回归，
    // 两个端点同形）：第一版剔除判据是「结果 id 在**坏调用** id 集合里」，当同一个
    // `call_id` 上**既有坏调用、又有好调用**时它无法区分两者 ⇒ 好调用的回执也被剔掉
    // ⇒ **留下孤儿 `tool-call`**（上游照样拒）。实测 `tool-calls=["dup"], results=[]`。
    // ⇒ 判据必须是「**该 id 上是否还有任何可用调用**」（`dropped && !kept`）。
    it('★ 重复 call_id：坏调用不得连带剔掉好调用的回执（否则好调用变孤儿）', async () => {
      const options = await toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: null, tool_calls: [
            { id: 'dup', type: 'function', function: { name: '', arguments: '{}' } },
            { id: 'dup', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } },
          ] },
          { role: 'tool', tool_call_id: 'dup', content: 'file list' },
        ],
      }, new AbortController().signal)

      const blocks = normalizeHarnessMessages(options.messages).flatMap(message => message.content ?? [])
      expect(blocks.filter(block => block.type === 'tool-call')).toEqual([
        { type: 'tool-call', id: 'dup', name: 'Bash', arguments: '{"cmd":"ls"}' },
      ])
      expect(blocks.filter(block => block.type === 'tool-result').map((block: any) => block.toolCallId))
        .toEqual(['dup'])
    })

    // ⚠️⚠️ **tool_calls 全被剔光时，整条 assistant 消息也必须剔除**（独立审计实测指出）。
    // 否则「剔除坏调用」只是把 400 从网关挪到了上游：这条 assistant 会变成
    // **content 为空**的助手消息、成为 wire 上的**开头发言**（实测经
    // `serializeMessages` 产出 `[{role:'assistant',content:''}]` 且**无任何 user 消息**）
    // ⇒ 对 OpenAI 兼容端点是典型的 `model_param_invalid` 400。
    //
    // ⚠️ 边界（必须一起锁）：**正文非空**的 assistant 即使调用被剔光也要保留 ——
    // 那是模型真实的发言、用户在界面上真看到的内容，剔掉会让它从历史里消失。
    it('★ 坏调用全被剔光且正文为空：整条 assistant 必须剔除（不是留一条空的）', async () => {
      const options = await toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: null, tool_calls: [emptyNameCall('call_bad')] },
          { role: 'tool', tool_call_id: 'call_bad', content: 'No such tool available: ' },
        ],
      }, new AbortController().signal)

      // 不得留下「content 为空」的 assistant（它会成为 wire 上的开头发言）。
      const emptyAssistant = options.messages.filter(
        message => message.role === 'assistant' && (message.content ?? []).length === 0,
      )
      expect(emptyAssistant).toHaveLength(0)
      // 用户那句话照常在。
      expect(options.messages.map(message => message.role)).toEqual(['user'])
    })

    it('★ 边界：正文非空的 assistant（调用被剔光）必须保留（那是模型真实发言）', async () => {
      const options = await toGenerateOptions({
        model: 'hub/hub-deepseek-v4.1-flash',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: '我先看看', tool_calls: [emptyNameCall('call_bad')] },
        ],
      }, new AbortController().signal)

      const assistant = options.messages.find(message => message.role === 'assistant')
      expect(assistant).toBeDefined()
      expect(assistant!.content).toEqual([{ type: 'text', text: '我先看看' }])
    })
  })
})
