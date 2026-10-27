/**
 * Accio 协议层单测：**帧归一化**（Accio 顶层 → 标准 Gemini `candidates`）
 * 与消息 / 工具序列化。
 *
 * ## 守的是什么
 *
 * 本模块存在的**唯一理由**是两种帧形状的差异（见 agent-notes §4.1 / §4.4）：
 *
 * | | Accio | 标准 Gemini |
 * |---|---|---|
 * | 帧 | `{content:{parts}, usage_metadata, partial}` ← **顶层** | `{candidates:[{content}], usageMetadata}` |
 * | 工具 | `parts[].function_call`（snake） | `parts[].functionCall`（camel） |
 *
 * ⚠️ **`consumeGeminiSse` 不接受「帧变换」回调**（它对每帧自己 `JSON.parse`），
 * 所以归一化必须在 `consumeAccioSse` 的 `TransformStream` 里**流式**完成 ——
 * 故下面第三段**真的驱动整条流**，而不是只测纯函数。漏测这一段的代价是：
 * 纯函数全绿、而接线上游帧仍进不去共享消费器（表现为「模型没返回任何内容块」）。
 *
 * ⚠️ 反向验证要求：让 `normalizeAccioFrame` 恒返回 `frame`（= 去掉归一化）
 * 必须让本文件变红 —— 若不会，说明这里的断言全是同义反复。
 */
import { describe, expect, it } from 'vitest'
import {
  ACCIO_IMAGE_PIXEL_BUDGET,
  accioUserParts,
  consumeAccioSse,
  normalizeAccioFrame,
  toAccioTools,
  serializeAccioMessages,
} from '../../src/accio-messages.js'

describe('normalizeAccioFrame —— Accio 顶层帧 → 标准 Gemini candidates', () => {
  it('⚠️ content 在顶层（不包 candidates）⇒ 必须包一层，否则 consumeGeminiSse 命中不了', () => {
    const raw = { content: { role: 'model', parts: [{ text: 'hi' }] }, partial: true }
    const out = normalizeAccioFrame(raw) as Record<string, unknown>
    expect(Array.isArray(out.candidates)).toBe(true)
    const cands = out.candidates as Array<Record<string, unknown>>
    expect(cands[0]?.content).toEqual({ role: 'model', parts: [{ text: 'hi' }] })
  })

  it('⚠️ usage_metadata（snake）→ usageMetadata（camel）', () => {
    const raw = {
      content: { parts: [{ text: 'x' }] },
      usage_metadata: { prompt_token_count: 3, candidates_token_count: 5, total_token_count: 8 },
    }
    const out = normalizeAccioFrame(raw) as Record<string, unknown>
    expect(out.usageMetadata).toEqual({
      promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8,
    })
  })

  it('thought 标记原样保留（由 consumeGeminiSse 映射到 reasoning）', () => {
    const raw = { content: { parts: [{ text: 'why', thought: true }] } }
    const out = normalizeAccioFrame(raw) as Record<string, unknown>
    const parts = ((out.candidates as any[])[0].content.parts) as any[]
    expect(parts[0].thought).toBe(true)
  })

  it('🔴 空/无效帧返回 undefined（不能包成空 candidates，那会让消费侧以为有内容）', () => {
    expect(normalizeAccioFrame(undefined)).toBeUndefined()
    expect(normalizeAccioFrame(null)).toBeUndefined()
    expect(normalizeAccioFrame('nope')).toBeUndefined()
    expect(normalizeAccioFrame({})).toBeUndefined()
    expect(normalizeAccioFrame({ content: null })).toBeUndefined()
  })

  it('已有 candidates 的帧原样透传（容忍上游某天改成标准形状）', () => {
    const raw = { candidates: [{ content: { parts: [{ text: 'a' }] } }] }
    expect(normalizeAccioFrame(raw)).toBe(raw)
  })

  // ⚠️ 下面三条锁的是**差异表的第二行**（brief 的测试漏了它、实现初版也漏了它）：
  // `parts[].function_call`（snake，参数是 `args_json` **字符串**）→
  // `parts[].functionCall`（camel，参数是 `args` **对象**）。
  // 漏掉的运行时后果不是「参数丢了」而是**整帧被当纯 usageMetadata 帧**，
  // `consumeGeminiSse` 于是判定「模型未返回任何内容块」并抛错。
  describe('⚠️ part 级：function_call（snake）→ functionCall（camel）', () => {
    it('args_json 字符串被解析成 args 对象（消费器的契约是对象）', () => {
      const raw = {
        content: {
          role: 'model',
          parts: [{ function_call: { id: 'c1', name: 'read_file', args_json: '{"path":"a"}' } }],
        },
      }
      const out = normalizeAccioFrame(raw) as Record<string, unknown>
      const parts = ((out.candidates as any[])[0].content.parts) as any[]
      expect(parts).toEqual([{ functionCall: { name: 'read_file', args: { path: 'a' } } }])
    })

    it('🔴 无 name 的调用整块丢弃（不能产出无名工具调用）', () => {
      const raw = { content: { parts: [{ function_call: { args_json: '{}' } }] } }
      const out = normalizeAccioFrame(raw) as Record<string, unknown>
      const parts = ((out.candidates as any[])[0].content.parts) as any[]
      expect(parts).toEqual([])
    })

    it('text / thought part 原样保留（归一化不得吃掉正文与思考标记）', () => {
      const raw = { content: { parts: [{ text: 'why', thought: true }, { text: '正文' }] } }
      const out = normalizeAccioFrame(raw) as Record<string, unknown>
      const parts = ((out.candidates as any[])[0].content.parts) as any[]
      expect(parts).toEqual([{ text: 'why', thought: true }, { text: '正文' }])
    })

    it('⚠️ args_json 不是合法 JSON 时回退空对象（不抛错，不让整轮失败）', () => {
      const raw = {
        content: { parts: [{ function_call: { id: 'c1', name: 'f', args_json: 'NOT JSON' } }] },
      }
      const out = normalizeAccioFrame(raw) as any
      expect(out.candidates[0].content.parts[0].functionCall.args).toEqual({})
    })
  })

  // ⚠️⚠️ 2026-10-13 真实缺陷（用户报障「accio 思考一下就中断」的根因）：
  // 旧判据「无 content 一律 return undefined」把三类**有语义**的帧整帧丢弃 ——
  // 顶层 function_call（task-6-report 逐字记录的真实形状，不带 content）、
  // 终帧的 usage_metadata / finish_reason（工具轮次的终帧只有它们没有正文）。
  // 运行时后果：模型思考完决定调工具 → 工具帧被丢 → 流里只剩思考 → 兜底 stop
  // → 「思考一下就中断、无正文无工具、轮次显示正常完成」，且 usage 恒归零。
  // 实测证据：session 35b01df3（accio/deepseek-v4-1-flash）13 轮静默 stop，
  // 每轮思考结尾都是工具意图（"Let me call get_goal."）。
  describe('⚠️⚠️ 无 content 但有语义的帧不得丢弃（2026-10-13 静默 stop 根因）', () => {
    it('🔴 顶层 function_call（无 content 信封）⇒ 包成 candidates[0].content.parts（snake→camel）', () => {
      const raw = { function_call: { id: 'call_c3a3', name: 'read_file' } }
      const out = normalizeAccioFrame(raw) as any
      expect(Array.isArray(out?.candidates)).toBe(true)
      const parts = out.candidates[0].content.parts as any[]
      expect(parts[0].functionCall).toEqual({ name: 'read_file', args: {} })
    })

    it('🔴 顶层 function_call 带 args_json 字符串 ⇒ 解析成 args 对象', () => {
      const raw = { function_call: { id: 'c1', name: 'f', args_json: '{"path":"a"}' } }
      const out = normalizeAccioFrame(raw) as any
      expect(out.candidates[0].content.parts[0].functionCall.args).toEqual({ path: 'a' })
    })

    it('🔴 无 content 的终帧：finish_reason + usage_metadata 都必须保住', () => {
      const raw = {
        turn_complete: true,
        finish_reason: 'MAX_TOKENS',
        usage_metadata: { prompt_token_count: 10, candidates_token_count: 7, total_token_count: 17 },
      }
      const out = normalizeAccioFrame(raw) as any
      // finish 必须挂在**非空** candidate 上（空 candidates 在读 finishReason 前就 return）
      expect(out.candidates[0].finishReason).toBe('MAX_TOKENS')
      expect(out.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 7, totalTokenCount: 17 })
    })

    it('🔴 纯 usage 帧（无 finish）⇒ 空 candidates + usageMetadata（消费侧只记用量不算内容）', () => {
      const raw = { usage_metadata: { prompt_token_count: 3, total_token_count: 5 } }
      const out = normalizeAccioFrame(raw) as any
      expect(out.candidates).toEqual([])
      expect(out.usageMetadata).toEqual({ promptTokenCount: 3, totalTokenCount: 5 })
    })

    it('🔴 无 content 且无任何语义字段 ⇒ 仍返回 undefined（真无用帧不编造）', () => {
      expect(normalizeAccioFrame({ turn_complete: true })).toBeUndefined()
      expect(normalizeAccioFrame({ partial: true })).toBeUndefined()
    })

    it('🔴 顶层 function_call 无 name ⇒ 仍丢弃（与 content.parts 内的判据同口径）', () => {
      expect(normalizeAccioFrame({ function_call: { args_json: '{}' } })).toBeUndefined()
    })

    it('🔴 无名顶层 call **不得连坐**丢掉 usage/finish（MAX_TOKENS 不得伪装成 stop）', () => {
      // ⚠️ 2026-10-13 审计修正：调用无名时该调用整块丢弃（既有约定），
      // 但 usage / finish 必须保住 —— 否则 `MAX_TOKENS` 截断被伪装成正常结束、
      // harness 不会重试（正是本 PR 要消灭的那类失败）。
      // ⚠️ 这一格必须**直测纯函数**：走完整管线时，顶层 call 会先被合并层
      // 包成 `{function_call:{id:'anon-N',name:''}}`（合并层会补一个 id 键），
      // 于是永远命不中「无名」这条分支 —— 端到端用例锁不住它（实测变异 M8 零红）。
      const out = normalizeAccioFrame({
        function_call: { args_json: '{}' },
        usage_metadata: { prompt_token_count: 7, candidates_token_count: 3, total_token_count: 9 },
        finish_reason: 'MAX_TOKENS',
      }) as { candidates?: Array<{ finishReason?: string }>; usageMetadata?: Record<string, unknown> } | undefined
      expect(out).toBeDefined()
      expect(out?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS')
      expect(out?.usageMetadata?.totalTokenCount).toBe(9)
      // 与「`function_call: null`」「完全无 call」两格**同形**（判据一致）
      const nullCall = normalizeAccioFrame({
        function_call: null,
        usage_metadata: { prompt_token_count: 7, candidates_token_count: 3, total_token_count: 9 },
        finish_reason: 'MAX_TOKENS',
      }) as { usageMetadata?: Record<string, unknown> } | undefined
      expect(nullCall?.usageMetadata?.totalTokenCount).toBe(9)
    })
  })
})

describe('serializeAccioMessages', () => {
  it('system 抽到 systemInstruction，其余进 contents', () => {
    const out = serializeAccioMessages([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ])
    expect(out.systemInstruction).toBe('你是助手')
    expect(out.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
  })

  it('⚠️ assistant → role: "model"，tool_calls → functionCall(argsJson 是字符串)', () => {
    const out = serializeAccioMessages([
      {
        role: 'assistant',
        content: '让我看看',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a"}' },
        }],
      },
    ])
    expect(out.contents).toEqual([{
      role: 'model',
      parts: [
        { text: '让我看看' },
        { functionCall: { id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' } },
      ],
    }])
  })

  it('⚠️ 工具结果（role:tool）→ user + functionResponse(id/name/responseJson)', () => {
    const out = serializeAccioMessages([
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: '{"ok":true}' },
    ])
    expect(out.contents).toEqual([{
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'read_file', responseJson: '{"ok":true}' } }],
    }])
  })

  it('content 为数组时取全部 text 块（拼接）', () => {
    const out = serializeAccioMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ])
    expect(out.contents).toEqual([{ role: 'user', parts: [{ text: 'ab' }] }])
  })

  it('空内容不产出空 parts 条目', () => {
    expect(serializeAccioMessages([{ role: 'user', content: '' }]).contents).toEqual([])
    expect(serializeAccioMessages([]).contents).toEqual([])
  })

  /**
   * ## 图片内联（issue IKLR7V 接线，2026-10-14）
   *
   * 上游形状由真机实测确定：Gemini 风格的 `parts[].inline_data = {mime_type,data}`
   * （四象限色块图**四色全对**）。本层产出 camelCase `inlineData`，由
   * `buildAccioBody` 的 `accioToSnake` 转成 snake（形状断言见 `accio-product.spec.ts`）。
   */
  describe('图片内联', () => {
    const IMAGES = new Map([['att-1', { mediaType: 'image/png', data: 'QUJD' }]])

    it('⚠️⚠️ 有图时产出 inlineData（文本与图在同一条 parts 里）', () => {
      const out = serializeAccioMessages([
        { role: 'user', content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ] },
      ], IMAGES)
      expect(out.contents).toEqual([{
        role: 'user',
        parts: [
          { text: '看图' },
          { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
        ],
      }])
    })

    it('⚠️⚠️ images 为 undefined 时**不得**产出 inlineData（无图请求格式逐字节不变）', () => {
      // 无图请求必须保持原来的纯文本路径 —— 升级成多模态形态会破坏前缀缓存。
      const out = serializeAccioMessages([
        { role: 'user', content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ] },
      ])
      expect(out.contents).toEqual([{ role: 'user', parts: [{ text: '看图' }] }])
    })

    it('⚠️⚠️ 有图但拿不到字节 ⇒ **抛错**（绝不静默丢弃整张图）', () => {
      // 静默丢弃会让用户以为模型看到了图（本仓库首条红线）。
      expect(() => serializeAccioMessages([
        { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'missing' } }] },
      ], IMAGES)).toThrow(/图片未能内联/)
    })

    it('⚠️ `attachmentId` 缺失/非字符串时同样抛错（不得产出空图）', () => {
      expect(() => serializeAccioMessages([
        { role: 'user', content: [{ type: 'image', attachment: {} }] },
      ], IMAGES)).toThrow(/图片未能内联/)
    })

    it('⚠️⚠️ tool-result 内嵌图片必须**递归**取出（深层图片不得被静默丢弃）', () => {
      // 与 `collectImages` 的递归深度对称：收集侧任意深度、序列化侧只走一层
      // ⇒ 深层图片被收进 refs 却在序列化时静默消失（连占位符都没有）。
      const out = serializeAccioMessages([
        { role: 'user', content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: '截图' },
            { type: 'image', attachment: { attachmentId: 'att-1' } },
          ],
        }] },
      ], IMAGES)
      const parts = (out.contents[0] as { parts: Array<Record<string, unknown>> }).parts
      expect(parts, '内嵌文本仍要保留').toContainEqual({ text: '截图' })
      expect(parts.some((p) => p.inlineData !== undefined), '深层图片必须被取出').toBe(true)
    })

    it('无图时 user 消息仍走字符串路径（不因传了 images 就升级）', () => {
      // ⚠️ `images` 非 undefined（含空 Map）**不等于**本消息有图 —— 判据必须是
      // 「这条消息自己有没有 image 块」，而不是「请求里有没有图」。
      const out = serializeAccioMessages([
        { role: 'user', content: [{ type: 'text', text: '纯文本' }] },
      ], IMAGES)
      expect(out.contents).toEqual([{ role: 'user', parts: [{ text: '纯文本' }] }])
    })
  })

  describe('accioUserParts（纯函数）', () => {
    it('无图时返回 undefined（调用方据此走纯文本路径）', () => {
      expect(accioUserParts([{ type: 'text', text: 'x' }], undefined)).toBeUndefined()
    })

    it('ACCIO_IMAGE_PIXEL_BUDGET 是正数（接线后真的被用，不再是死常量）', () => {
      expect(ACCIO_IMAGE_PIXEL_BUDGET).toBeGreaterThan(0)
    })
  })
})

describe('toAccioTools', () => {
  it('OpenAI 工具定义 → { name, description, parametersJson }', () => {
    const out = toAccioTools([{
      type: 'function',
      function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } },
    }])
    expect(out).toEqual([{
      name: 'read_file', description: '读文件', parametersJson: '{"type":"object","properties":{}}',
    }])
  })

  it('空/非法输入返回 undefined（不产出空数组）', () => {
    expect(toAccioTools([])).toBeUndefined()
    expect(toAccioTools([{ type: 'function' }])).toBeUndefined()
  })
})

/** 把若干 SSE 文本行做成一个 ReadableStream（模拟上游响应体）。 */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line))
      controller.close()
    },
  })
}

/**
 * 与 {@link sseStream} 同形，但**额外**把 `consumeAccioSse` 改写层的产物也交出来。
 *
 * ## 为什么需要这个缝
 *
 * `consumeGeminiSse` 的 `consumeSseLine` 会**跳过** `:`（注释心跳）与 `event:`
 * 行 —— 于是「改写层把非 data 行丢了」这个缺陷在消费侧**完全观测不到**
 * （实测：删掉透传分支，只断言正文的版本照样全绿）。要真正锁住「非 data 行原样
 * 发回」，只能直接看改写层的字节。
 *
 * 做法：拦下 `pipeThrough`，用 `tee()` 把改写结果**分流一份**给检查用，
 * 另一份照常交给消费器。`pipeTo` 的 rejection 与检查流的读取都**吞掉异常**
 * （错误帧用例会让它们 reject，而那不是本缝要断言的东西）。
 *
 * @returns `body` 交给 `consumeAccioSse`；`rewritten` 解析为改写层产出的全部文本。
 */
function tapRewrittenBody(lines: string[]): {
  body: ReadableStream<Uint8Array>
  rewritten: Promise<string>
} {
  const source = sseStream(lines)
  let resolveRewritten: (text: string) => void = () => {}
  const rewritten = new Promise<string>((resolve) => { resolveRewritten = resolve })
  const body = {
    pipeThrough(ts: TransformStream<Uint8Array, Uint8Array>): ReadableStream<Uint8Array> {
      const [forConsumer, forInspection] = ts.readable.tee()
      source.pipeTo(ts.writable).catch(() => {})
      void (async () => {
        const decoder = new TextDecoder()
        let text = ''
        const reader = forInspection.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
          }
        } catch {
          // 改写层抛错（错误帧用例）：已收到的部分照样交出去。
        }
        resolveRewritten(text + decoder.decode())
      })()
      return forConsumer
    },
  } as unknown as ReadableStream<Uint8Array>
  return { body, rewritten }
}

describe('consumeAccioSse —— 归一化后交给共享消费器', () => {
  it('thinking 与正文各自成块（thought 不得混入正文）', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"role":"model","parts":[{"text":"想想","thought":true}]},"partial":true}\n',
        'data: {"content":{"role":"model","parts":[{"text":"你好"}]}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const kinds = chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType)
    expect(kinds).toEqual(['reasoning', 'text'])

    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    expect(reasoning).toBe('想想')
    expect(text).toBe('你好')          // ⚠️ 正文里绝不能出现思维链
  })

  it('工具调用产出 tool-call 块，参数是完整 JSON 串', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"role":"model","parts":[{"function_call":{"id":"c1","name":"read_file","args_json":"{\\"path\\":\\"a\\"}"}}]}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const call = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(call).toBeDefined()
    expect(call.block.name).toBe('read_file')
    expect(JSON.parse(call.block.arguments)).toEqual({ path: 'a' })
  })

  it('usage_metadata 的 snake 字段被认出来（取最大 total）', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"parts":[{"text":"a"}]},"usage_metadata":{"prompt_token_count":3,"candidates_token_count":1,"total_token_count":4}}\n',
        'data: {"content":{"parts":[{"text":"b"}]},"usage_metadata":{"prompt_token_count":3,"candidates_token_count":9,"total_token_count":12}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage).toBeDefined()
    expect(usage.usage.outputTokens).toBe(9)   // 取 total 最大的那一份
  })

  it('🔴 空流必须抛错（静默结束 harness 不会重试）', async () => {
    const drain = async () => {
      for await (const _ of consumeAccioSse({ body: sseStream(['data: [DONE]\n']) })) { /* drain */ }
    }
    await expect(drain()).rejects.toThrow()
  })

  // ⚠️ 下面三条锁的是**流内错误帧**（HTTP 200 + `error_code`）。这类帧**没有
  // `content`** ⇒ `normalizeAccioFrame` 恒返回 `undefined` ⇒ 若判据缺失，整帧会被
  // `continue` 丢掉，最终由共享消费器抛 `gemini: 模型未返回任何内容块` ——
  // 用户看到「模型没返回内容」而不是「额度/认证失败」（agent-notes §4.3 记的
  // 那条误导性症状）。实测报文见 agent-notes §4.2 的第 2/4 格。
  it('🔴 流内 error_code:402 必须抛额度错误（不能退化成「没返回内容」）', async () => {
    const drain = async () => {
      for await (const _ of consumeAccioSse({
        body: sseStream(['data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n']),
      })) { /* drain */ }
    }
    await expect(drain()).rejects.toThrow(/402|unauthorized|QUOTA/i)
  })

  it('error_code:200 是成功哨兵，不得抛错', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"error_code":"200","content":{"parts":[{"text":"ok"}]}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
  })

  it('⚠️ 其它非 200 的 error_code 也必须抛，且逐字带上服务端原文', async () => {
    const drain = async () => {
      for await (const _ of consumeAccioSse({
        body: sseStream(['data: {"error_code":"500","error_message":"internal boom"}\n']),
      })) { /* drain */ }
    }
    // ⚠️ 断言服务端原文**逐字**在 message 里：本仓库铁律是绝不丢服务端原文
    //（丢了就只能靠猜，排障成本极高）。
    await expect(drain()).rejects.toThrow(/500/)
    await expect(drain()).rejects.toThrow(/internal boom/)
  })

  it('⚠️ 注释行心跳与非 data 行不炸（跨 chunk 切分的帧也要还原）', async () => {
    const { body, rewritten } = tapRewrittenBody([
      // ⚠️ 故意把一个 data: 行**切成两块**，验证 TransformStream 的缓冲
      ': keep-alive\n',
      'event: ping\n',
      'data: {"content":{"parts":[{"te',
      'xt":"拼起来"}]}}\n',
      'data: [DONE]\n',
    ])
    const chunks = []
    for await (const c of consumeAccioSse({ body })) chunks.push(c)

    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('拼起来')
    // ⚠️ 光断言正文**锁不住非 data 行的透传**：`consumeGeminiSse` 的
    // `consumeSseLine` 会跳过 `:` 与 `event:` 行，所以「改写层把这两行丢了」
    // 在消费侧完全观测不到（实测：删掉透传分支，只断言正文的版本照样全绿）。
    // 故这里直接断言**改写层的产物**里含这两行。
    // ⚠️ 措辞如实：改写层会裁掉行尾的 `\r`，所以是「原样发回」而非「逐字透传」。
    expect(await rewritten).toContain(': keep-alive')
    expect(await rewritten).toContain('event: ping')
  })

  // ⚠️⚠️ 2026-10-13 真实缺陷的**端到端**回归（session 35b01df3 的真实形状）：
  // 思考（content.parts 里的 thought）→ 顶层 function_call 分片（**无 content 信封**，
  // task-6-report 逐字记录的 frame#8/#9/#10 形状）→ 无 content 的终帧。
  // 修复前：工具帧与终帧全被归一化层丢弃 ⇒ 流里只剩思考 ⇒ 兜底 stop ⇒
  // 「思考一下就中断」，usage 全零、无工具调用、轮次显示正常完成。
  // ⚠️ 走**完整管线**（先 accioToolCallMergeTransform 合并、再归一化消费）：
  // 顶层 function_call 分片必须被合并成恰好一个调用 —— 只测归一化层会看到
  // 2 个块（合并不在那一层），那不是真实链路。
  it('🔴 端到端：思考 → 顶层 function_call 分片 → 终帧 ⇒ 必须产出工具调用 + 真实 usage + tool-calls 收尾', async () => {
    const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
    const merged = sseStream([
      'data: {"content":{"role":"model","parts":[{"text":"Let me call get_goal.","thought":true}]},"partial":true}\n',
      'data: {"function_call":{"id":"call_c3a3","name":"get_goal"}}\n',
      'data: {"function_call":{"id":"call_c3a3","name":"get_goal","args_json":"{}"}}\n',
      'data: {"turn_complete":true,"finish_reason":"stop","usage_metadata":{"prompt_token_count":100,"candidates_token_count":50,"thoughts_token_count":30,"total_token_count":150}}\n',
      'data: [DONE]\n',
    ]).pipeThrough(accioToolCallMergeTransform())
    const chunks = []
    for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)

    // 思考块必须在（不被工具帧吞掉）
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    expect(reasoning).toBe('Let me call get_goal.')
    // 工具调用必须在，且分片合并成**恰好一个**块
    const calls = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(calls.length).toBe(1)
    expect((calls[0]!.block as { name: string }).name).toBe('get_goal')
    // 终帧的 usage 必须真实到达（修复前恒为 {0,0}）
    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage?.usage.inputTokens).toBe(100)
    expect(usage?.usage.outputTokens).toBe(50)
    expect(usage?.usage.reasoningTokens).toBe(30)
    // finish 必须是 tool-calls（修复前是兜底 stop）
    const finish = chunks.find((c) => c.type === 'finish')
    expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('tool-calls')
  })

  it('🔴 端到端：无 content 的 MAX_TOKENS 终帧 ⇒ finish 必须是 max-tokens（不得伪装成 stop）', async () => {
    const chunks = []
    for await (const c of consumeAccioSse({
      body: sseStream([
        'data: {"content":{"role":"model","parts":[{"text":"想想","thought":true}]},"partial":true}\n',
        'data: {"turn_complete":true,"finish_reason":"MAX_TOKENS","usage_metadata":{"prompt_token_count":10,"candidates_token_count":64,"total_token_count":74}}\n',
        'data: [DONE]\n',
      ]),
    })) chunks.push(c)

    const finish = chunks.find((c) => c.type === 'finish')
    expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('max-tokens')
  })

  // ⚠️⚠️ 2026-10-13 深夜 wire 探针定罪的**双重丢失**（第一轮修复后仍复发的那条）：
  //
  // 上游真实形状（probe-wire-frames 抓的 frame#13/#14）：终帧把**最后一个
  // function_call 分片**与 `turn_complete`/`usage_metadata`/`finish_reason` 放在
  // **同一帧**，且整条流**没有 `[DONE]`**。两处缺陷叠加：
  //
  // 1. **合并层吞元数据**：`accioToolCallMergeTransform` 把带 function_call 的
  //    终帧吸收进 pending 缓冲，flush 只吐工具 part ⇒ usage/finish 丢失；
  // 2. **归一化层 flush 裸透尾行**：合并层 flush 产物**不带尾换行** ⇒
  //    `consumeAccioSse` 的 transform 把它留在 buffer ⇒ flush 原样吐出
  //    **未归一化**的顶层帧 ⇒ `consumeGeminiSse` 当纯 usageMetadata 帧 ⇒
  //    工具调用/usage/finish 全丢。
  //
  // 复合症状 = 用户报障「思考一下就中断」：思考正常、无工具调用、usage 全零、
  // finish 兜底 stop、轮次显示正常完成。
  describe('⚠️⚠️ 终帧与最后一个工具分片同帧 + 流无 [DONE]（wire 实测形状）', () => {
    /** 复刻 wire 探针抓到的真实帧序列（截短 raw_response_json）。 */
    const realWireLines = [
      'data: {"content":{"role":"model","parts":[{"text":"Use","thought":true}]},"partial":true}\n',
      'data: {"content":{"role":"model","parts":[{"text":" the","thought":true}]},"partial":true}\n',
      'data: {"content":{"role":"model","parts":[{"text":" tool.","thought":true}]},"partial":true}\n',
      'data: {"content":{"role":"model","parts":[{"function_call":{"id":"call_00","name":"get_current_time"}}]},"partial":true}\n',
      // ⚠️ 终帧：最后一个分片 + 元数据同帧，且**没有后续 [DONE]**（真实流如此）
      'data: {"content":{"role":"model","parts":[{"function_call":{"id":"call_00","name":"get_current_time","args_json":"{}"}}]},"turn_complete":true,"usage_metadata":{"prompt_token_count":301,"candidates_token_count":36,"total_token_count":337,"thoughts_token_count":13},"finish_reason":"STOP"}\n',
    ]

    it('🔴 完整管线：工具调用 + 真实 usage + tool-calls 收尾（终帧元数据不得被合并缓冲吞掉）', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream(realWireLines).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)

      const calls = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
      expect(calls.length).toBe(1)
      expect((calls[0]!.block as { name: string }).name).toBe('get_current_time')
      const usage = chunks.find((c) => c.type === 'usage')
      expect(usage?.usage.inputTokens).toBe(301)
      expect(usage?.usage.outputTokens).toBe(36)
      expect(usage?.usage.reasoningTokens).toBe(13)
      const finish = chunks.find((c) => c.type === 'finish')
      expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('tool-calls')
    })

    it('🔴 归一化层 flush 不得裸透尾行（无 [DONE] 的流，尾行必须照常归一化）', async () => {
      // 不走合并层，直接喂归一化层：终帧是**最后一行且无尾换行**，
      // transform 会把它留在 buffer —— flush 必须对它跑同一条归一化路径。
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(
            'data: {"content":{"role":"model","parts":[{"text":"想想","thought":true}]},"partial":true}\n'
            // ⚠️ 无换行结尾：模拟合并层 flush 产物 / 上游不带 [DONE] 的收尾
            + 'data: {"content":{"role":"model"},"turn_complete":true,"usage_metadata":{"prompt_token_count":5,"candidates_token_count":2,"total_token_count":7},"finish_reason":"STOP"}',
          ))
          controller.close()
        },
      })
      const chunks = []
      for await (const c of consumeAccioSse({ body })) chunks.push(c)

      const usage = chunks.find((c) => c.type === 'usage')
      expect(usage?.usage.inputTokens).toBe(5)
      expect(usage?.usage.outputTokens).toBe(2)
      const finish = chunks.find((c) => c.type === 'finish')
      expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('stop')
    })
  })

  // ⚠️⚠️ 2026-10-13 **独立审计 + 对抗性审计**（本轮双审计）查出的净回归：
  // 本 PR 新增的「顶层 function_call 改写」跑在 `consumeAccioSse` 的错误判据
  // **之前**，而它新造了一个只含 `content.parts` 的帧 ⇒ 同帧的 `error_code` /
  // `error_message` 被吞 ⇒ **额度/认证失败被反转成「工具调用成功」**。
  // 触发条件：「错误码与工具 part 同帧」—— 上游确实会在帧上混发 `error_code`
  // （见 §4.3「判成功的口径：有 content.parts、**无 error_code**」），故必须守卫。
  // ⚠️ 这一格原先**零守卫**（实测：把修复回退，118 条用例全绿）—— 故本组是新增防线。
  describe('⚠️⚠️ 错误帧绝不可被合并层吸收（审计修正：额度失败不得反转成成功）', () => {
    /** 走完整管线（合并层 → 归一化消费层），返回抛出的错误或「未抛」。 */
    async function drain(lines: string[]): Promise<{ thrown?: Error; text: string; calls: number }> {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream(lines).pipeThrough(accioToolCallMergeTransform())
      const chunks: Array<{ type: string; text?: string; block?: { type?: string } }> = []
      try {
        for await (const c of consumeAccioSse({ body: merged })) chunks.push(c as never)
      } catch (e) {
        return {
          thrown: e as Error,
          text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text ?? '').join(''),
          calls: chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').length,
        }
      }
      return {
        text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text ?? '').join(''),
        calls: chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').length,
      }
    }

    it('🔴 顶层 function_call 与 error_code:402 同帧 ⇒ 必须抛额度错误，且不得产出工具调用', async () => {
      const r = await drain([
        'data: {"function_call":{"id":"c1","name":"read_file","args_json":"{}"},"error_code":"402","error_message":"unauthorized"}\n',
        'data: [DONE]\n',
      ])
      expect(r.thrown).toBeDefined()
      expect(String(r.thrown?.message)).toContain('402')
      expect(String(r.thrown?.message)).toContain('unauthorized')
      expect(r.calls).toBe(0)
    })

    it('🔴 content.parts 内的 function_call 与 error_code 同帧 ⇒ 同样必须抛', async () => {
      const r = await drain([
        'data: {"content":{"parts":[{"function_call":{"id":"c1","name":"f","args_json":"{}"}}]},"error_code":"500","error_message":"internal boom"}\n',
        'data: [DONE]\n',
      ])
      expect(r.thrown).toBeDefined()
      expect(String(r.thrown?.message)).toContain('500')
      expect(String(r.thrown?.message)).toContain('internal boom')
      expect(r.calls).toBe(0)
    })

    it('🔴 错误帧前的正常正文必须照常交付（错误不得吞掉已产出的帧）', async () => {
      const r = await drain([
        'data: {"content":{"parts":[{"text":"甲"}]}}\n'
        + 'data: {"content":{"parts":[{"text":"乙"}]}}\n'
        + 'data: {"function_call":{"id":"c1","name":"f","args_json":"{}"},"error_code":"402","error_message":"unauthorized"}\n',
      ])
      expect(r.thrown).toBeDefined()
      expect(r.text).toBe('甲乙')
    })

    it('🔴 error_code:"200" 成功哨兵与工具同帧 ⇒ 不得抛错（哨兵语义不得被本判据破坏）', async () => {
      const r = await drain([
        'data: {"function_call":{"id":"c1","name":"f","args_json":"{}"},"error_code":"200"}\n',
        'data: [DONE]\n',
      ])
      expect(r.thrown).toBeUndefined()
      expect(r.calls).toBe(1)
    })
  })

  // ⚠️ 2026-10-13 双审计查出的另两处净回归：合并层吸收工具 part 时
  // ① 对 `function_call: null` 抛**裸 TypeError**（不是 LlmError ⇒ harness 归类
  //    UNKNOWN、不在可重试集合），且异常发生在 `enqueue` 之前 ⇒ **同一个 chunk 里
  //    已解析出的正文一起丢失**；
  // ② 参数只认 snake `args_json` ⇒ camel `argsJson` / 对象 `args` 被**静默清空为 `{}`**
  //    （模型以为执行了，实际用空参数跑工具）。
  describe('⚠️ 合并层：畸形帧只跳过、参数三形态同口径（审计修正）', () => {
    it('🔴 function_call:null 与正常正文同 chunk ⇒ 正文必须全部交付（原先裸 TypeError 全丢）', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      // ⚠️ 全部放在**同一个 chunk** 里：这样才能证明「坏帧不吞同 chunk 已产出的帧」。
      const oneChunk =
        'data: {"content":{"parts":[{"text":"甲"}]}}\n'
        + 'data: {"content":{"parts":[{"text":"乙"}]}}\n'
        + 'data: {"function_call":null}\n'
        + 'data: {"content":{"parts":[{"text":"丙"}]}}\n'
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(enc.encode(oneChunk)); controller.close() },
      })
      const chunks = []
      for await (const c of consumeAccioSse({ body: body.pipeThrough(accioToolCallMergeTransform()) })) chunks.push(c)
      const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
      expect(text).toBe('甲乙丙')
    })

    it('🔴 camel functionCall:null 与标准 candidates 帧同 chunk ⇒ 正文必须交付', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const oneChunk =
        'data: {"candidates":[{"content":{"parts":[{"text":"标准正文"}]}}]}\n'
        + 'data: {"functionCall":null}\n'
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(enc.encode(oneChunk)); controller.close() },
      })
      const chunks = []
      for await (const c of consumeAccioSse({ body: body.pipeThrough(accioToolCallMergeTransform()) })) chunks.push(c)
      const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
      expect(text).toBe('标准正文')
    })

    it('🔴 `content.parts` 内的 function_call:null 与正文同帧 ⇒ 正文必须交付（裸 TypeError 不得吞 chunk）', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      // ⚠️ 这一格走的是 `absorbCallParts` 的**另一条入口**（`content.parts` 路径，
      // 不经顶层改写分支）—— 该守卫必须**自身独立正确**，不能靠上层遮蔽。
      const merged = sseStream([
        'data: {"content":{"parts":[{"text":"正文甲"}]}}\n',
        'data: {"content":{"parts":[{"function_call":null},{"text":"正文乙"}]}}\n',
        'data: {"content":{"parts":[{"text":"正文丙"}]}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
      expect(text).toBe('正文甲正文乙正文丙')
      // ⚠️ 畸形 part 只该被跳过，绝不产出工具块
      expect(chunks.filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call').length).toBe(0)
    })

    it('🔴 顶层 call 的 camel `argsJson` 参数不得被清空', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"function_call":{"id":"c1","name":"read_file","argsJson":"{\\"file_path\\":\\"a.txt\\"}"}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const call = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
      expect(JSON.parse((call!.block as { arguments: string }).arguments)).toEqual({ file_path: 'a.txt' })
    })

    it('🔴 顶层 call 的对象 `args` 参数不得被清空', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"function_call":{"id":"c1","name":"read_file","args":{"file_path":"a.txt"}}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const call = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
      expect(JSON.parse((call!.block as { arguments: string }).arguments)).toEqual({ file_path: 'a.txt' })
    })

    it('🔴 `args_json` 为空串时必须回退到同帧的 `args` 对象（不得静默变空参数）', async () => {
      // ⚠️ 2026-10-13 对抗验证查出：空串也是字符串，初版直接 return ⇒ **永不回退**，
      // 而归一化层（`parseArgsJson` 对空串返回 undefined）**会**回退 ⇒
      // 同一个帧「合并层得 {}、归一化层得真实参数」= 两层判据不一致。
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"function_call":{"id":"c1","name":"read_file","args_json":"","args":{"file_path":"a.txt"}}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const call = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
      expect(JSON.parse((call!.block as { arguments: string }).arguments)).toEqual({ file_path: 'a.txt' })
      // 与归一化层纯函数的结论**必须一致**（同口径的判据）
      const norm = normalizeAccioFrame({ function_call: { id: 'c1', name: 'read_file', args_json: '', args: { file_path: 'a.txt' } } }) as
        { candidates: Array<{ content: { parts: Array<{ functionCall: { args: unknown } }> } }> }
      expect(norm.candidates[0]!.content.parts[0]!.functionCall.args).toEqual({ file_path: 'a.txt' })
    })

    it('🔴 匿名调用键不得与上游显式 id 撞车（两个调用必须分别产出）', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"function_call":{"id":"anon-1","name":"alpha","args_json":"{\\"a\\":1}"}}\n',
        'data: {"function_call":{"name":"beta","args_json":"{\\"b\\":2}"}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const calls = chunks
        .filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
        .map((c) => [((c.block as { name: string }).name), JSON.parse((c.block as { arguments: string }).arguments)])
      expect(calls.length).toBe(2)
      expect(calls).toContainEqual(['alpha', { a: 1 }])
      expect(calls).toContainEqual(['beta', { b: 2 }])
    })
  })

  // ⚠️ 2026-10-13 双审计查出的另两处：本 PR 新纳入合并路径的帧形状被漏判，
  // 以及 usage 合并语义弱于消费侧。三格都实测可达。
  describe('⚠️ 合并层：漏判的帧形状与 usage 合并语义（审计修正）', () => {
    it('🔴 content 有值但**无 parts** + 顶层 call ⇒ 工具调用不得丢（PR 文档自记的真实终帧形状）', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"content":{"role":"model","parts":[{"text":"Let me call get_goal.","thought":true}]},"partial":true}\n',
        // ⚠️ 终帧：**有 content 但无 parts**，顶层带 call + usage + finish（无尾换行、无 [DONE]）
        'data: {"content":{"role":"model"},"function_call":{"id":"call_x","name":"get_goal","args_json":"{}"},"usage_metadata":{"prompt_token_count":301,"total_token_count":337},"finish_reason":"STOP"}',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const calls = chunks.filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
      expect(calls.length).toBe(1)
      expect((calls[0]!.block as { name: string }).name).toBe('get_goal')
      const finish = chunks.find((c) => c.type === 'finish')
      expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('tool-calls')
    })

    it('🔴 标准 candidates 帧 + 顶层 call ⇒ 正文不得被改写吞掉', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"标准正文"}]}}],"function_call":{"id":"c1","name":"f","args_json":"{}"}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
      expect(text).toBe('标准正文')
    })

    it('🔴 被吸收帧的 usage 取**最大 total**（不得被后到的偏小/空 usage 抹掉，与消费侧同口径）', async () => {
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"content":{"parts":[{"function_call":{"id":"c","name":"f"}}]},"usage_metadata":{"prompt_token_count":300,"cached_content_token_count":100,"candidates_token_count":10,"thoughts_token_count":4,"total_token_count":310}}\n',
        // ⚠️ 终帧 usage **total 偏小**（310 → 4）：取最大 ⇒ 必须保住 310 那一份的**全部键**
        //（回退前的实现会取到 4 那份，`inputTokens`/`cacheReadTokens`/`reasoningTokens` 全丢）
        'data: {"content":{"parts":[{"function_call":{"id":"c","name":"f","args_json":"{}"}}]},"usage_metadata":{"prompt_token_count":3,"candidates_token_count":1,"total_token_count":4},"finish_reason":"STOP"}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const usage = chunks.find((c) => c.type === 'usage')
      expect(usage?.usage.totalTokens).toBe(310)
      expect(usage?.usage.inputTokens).toBe(200)
      expect(usage?.usage.cacheReadTokens).toBe(100)
      expect(usage?.usage.reasoningTokens).toBe(4)
    })

    it('🔴 **首帧**同时带 snake+camel 两个 usage 键 ⇒ 必须收敛且取最大（不得让陈旧 snake 胜出）', async () => {
      // ⚠️ 2026-10-13 对抗验证查出：初版在 `prev === undefined` 时**早退**，
      // 于是首帧的两个 usage 键**都被保留** ⇒ 归一化层恒取 snake
      // （`f.usage_metadata ?? f.usageMetadata`）⇒ **陈旧的小值胜出**。
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"content":{"parts":[{"function_call":{"id":"c","name":"f"}}]},"usage_metadata":{"prompt_token_count":10,"total_token_count":10},"usageMetadata":{"promptTokenCount":3000,"totalTokenCount":3100}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const usage = chunks.find((c) => c.type === 'usage')
      expect(usage?.usage.totalTokens).toBe(3100)
      expect(usage?.usage.inputTokens).toBe(3000)
    })

    it('🔴 被吸收帧的**帧级**附加字段不得被改写/合成丢掉（`usage_metadata` 之外仍须保留语义）', async () => {
      // ⚠️ 如实登记：被吸收帧最终由 `flushPending` **重新合成**，故 `content` 内的
      // **非 `parts`** 字段（如 `extra`）**确实不会**出现在合成帧里 —— 实测下游不读它，
      // 故刻意不补（见 `handleLine` 的注释）。本条锁的是**帧级**字段：改写用
      // `{...frame}` 保留，且元数据照常被 `frameMetaOf` 抽走。
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"content":{"role":"model"},"function_call":{"id":"c","name":"f","args_json":"{}"},"usage_metadata":{"prompt_token_count":7,"total_token_count":9}}\n',
        'data: [DONE]\n',
      ]).pipeThrough(accioToolCallMergeTransform())
      const dec = new TextDecoder()
      const reader = merged.getReader()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += dec.decode(value, { stream: true })
      }
      text += dec.decode()
      // 帧级 `usage_metadata` 被改写分支保留（并经 frameMetaOf 拼进合成帧）
      expect(text).toContain('usage_metadata')
      // `content` 级附加字段**已知会丢**，如实断言（避免注释与行为再次不一致）
      expect(text).not.toContain('"extra"')
    })

    it('🔴 无名顶层 call 不得连坐丢掉 usage/finish（端到端：该形状经合并层后仍须保住元数据）', async () => {
      // ⚠️ **本条是回归锁，不是「无名分支」的防线**（2026-10-13 对抗验证指出）：
      // 走完整管线时，合并层会给匿名 call 补 `id:"anon-N"` ⇒ 归一化层的
      // 「无名」分支**根本不会命中**（实测：把该修复回退，本条**照样通过**）。
      // 真正锁住「无名不连坐」的是上面 `normalizeAccioFrame` describe 里的
      // **纯函数版**（同名用例，变异实测 1 红）。两者同名易误判，故在此注明。
      // 本条的价值：锁住「该形状端到端不崩、元数据能到达」这条整体性质。
      const { accioToolCallMergeTransform } = await import('../../src/accio-adapter.js')
      const merged = sseStream([
        'data: {"content":{"parts":[{"text":"想想","thought":true}]},"partial":true}\n',
        'data: {"function_call":{"args_json":"{}"},"usage_metadata":{"prompt_token_count":7,"candidates_token_count":3,"total_token_count":9},"finish_reason":"MAX_TOKENS"}',
      ]).pipeThrough(accioToolCallMergeTransform())
      const chunks = []
      for await (const c of consumeAccioSse({ body: merged })) chunks.push(c)
      const finish = chunks.find((c) => c.type === 'finish')
      expect((finish as { reason?: { kind?: string } })?.reason?.kind).toBe('max-tokens')
      const usage = chunks.find((c) => c.type === 'usage')
      expect(usage?.usage.totalTokens).toBe(9)
    })
  })
})
