/**
 * Qoder **工具下发与工具历史**的回归测试。
 *
 * ## 真实缺陷（用户报障）
 *
 * 「使用本插件的 qoder 的 qwen3.8-flash，执行任务出现任务调用 xml 泄露任务终止」。
 *
 * 根因是**适配器从不下发 `options.tools`**：
 * - `src/qoder-adapter.ts` 从不消费 `options.tools`（其余四个适配器都消费）；
 * - `src/qoder-wasm.ts` 把请求体的 `tools` **硬编码为 `[]`**。
 *
 * 模型因此在 wire 上拿不到任何工具 schema。系统提示告诉它「你有这些工具」，
 * 但 API 层没有函数定义，于是它只能用**正文里的 XML 文本**臆造工具调用
 * （`<tool_call>…</tool_call>` 一类）—— harness 认不出这种文本，任务终止。
 * 这正是用户看到的「工具调用 XML 泄露 + 任务终止」。
 *
 * ## 客户端的真实形态（本次实测，见测试内的取值）
 *
 * 加密端点 `agent_chat_generation` 走的是 **OpenAI 风格**的消息与工具：
 *
 * - 工具定义：`$Hc(A) => {type:"function", function:{name, description?, parameters?}}`
 *   写入请求体**顶层** `tools`（客户端源码：`tools: o?.tools ?? []`）。
 * - assistant 工具调用：`t2c()` 把 `tool_use` 块转成
 *   `{id, type:"function", index, function:{name, arguments}}` 挂到 `tool_calls`。
 * - 工具结果：`A2c()` 产出 `{role:"tool", content, tool_call_id}`。
 *
 * ⚠️ **不是** Anthropic 块风格：客户端另有 `tool_use`/`tool_result` 那套
 * （`input_schema` / `tool_use_id`），但那是给 Anthropic BYOK 用的分支，
 * 加密端点不吃那套。
 *
 * ## 为什么单测依赖纯函数
 *
 * 加密端点的请求体由 WASM 加密，**本地不可解**（朴素 `JSON.parse` 会抛）。
 * 因此把「payload 构造」与「wire → Qoder 消息映射」抽成纯函数，
 * 直接断言其产物 —— 比源码级字符串断言更能锁死行为。
 */
import { describe, expect, it, vi } from 'vitest'
import { buildQoderInferPayload, type QoderInferAsk } from '../../src/qoder-wasm.js'
import { buildQoderHistory, buildQoderTools } from '../../src/qoder-adapter.js'

/**
 * 捕获适配器交给 WASM 加密的 ask **与其真实 payload**。
 *
 * 加密端点的请求体在本地不可解，因此**替身掉 WASM**、直接截获 `prepareInfer`
 * 的入参，并调用**真实的** `buildQoderInferPayload` —— 这样
 * 「适配器 → ask → payload」整条链都被端到端断言，任一处回归都会失败。
 */
const captured: { ask?: QoderInferAsk; payload?: Record<string, unknown> } = {}

vi.mock('../../src/qoder-wasm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/qoder-wasm.js')>()
  return {
    ...actual,
    QoderEncryptedInfer: {
      create: async () => ({
        prepareInfer: (ask: QoderInferAsk) => {
          captured.ask = ask
          // 用真实构造器产出 payload（不加解密也能断言其内容）。
          captured.payload = actual.buildQoderInferPayload(ask, 'fixed-request-id')
          return { url: 'https://example.invalid/x', headers: {}, body: 'enc' }
        },
      }),
    },
  }
})

/** 一段标准 OpenAI 正文帧的**信封**响应（加密端点的真实响应形态）。 */
function envelope(text: string): Response {
  const inner = JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })
  const finish = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  const body = [inner, finish]
    .map((frame) => `data:${JSON.stringify({ body: frame, statusCodeValue: 200, statusCode: 'OK' })}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 一个最小可用的 ask。 */
function ask(overrides: Partial<QoderInferAsk> = {}): QoderInferAsk {
  return { modelKey: 'qfmodel', userText: 'hi', ...overrides }
}

describe('buildQoderTools：DSH 工具 schema → 加密端点的 tools[]', () => {
  it('映射为 {type:"function", function:{name,description,parameters}}', () => {
    // 客户端 `$Hc()` 的产物形态：description / parameters 缺省时**不出现该键**。
    const tools = buildQoderTools([
      { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    ])
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      },
    ])
  })

  it('无工具时返回空数组（保持请求体恒定带 tools 键）', () => {
    // 客户端是 `tools: o?.tools ?? []` —— 无工具时是**空数组**而非缺字段。
    expect(buildQoderTools(undefined)).toEqual([])
    expect(buildQoderTools([])).toEqual([])
  })

  it('保留多个工具的顺序', () => {
    const tools = buildQoderTools([
      { name: 'a', description: 'A', parameters: { type: 'object' } },
      { name: 'b', description: 'B', parameters: { type: 'object' } },
    ])
    expect(tools.map((t) => t.function.name)).toEqual(['a', 'b'])
  })
})

describe('buildQoderHistory：保留 assistant 的 tool_calls 与 tool 的 tool_call_id', () => {
  it('assistant 的 tool_calls 不被丢弃（content 为 null 时也不丢）', () => {
    // 真实缺陷：早期实现把 history 过滤成「仅 content 为字符串」的消息，
    // 而 assistant 带工具调用时 `content` 是 **null** → 整条消息被丢掉，
    // 模型看不到自己调用过什么，于是反复重调同一个工具或凭空编造结果。
    const history = buildQoderHistory([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"a":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'file body' },
    ])
    expect(history).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"a":1}' } }],
      },
      { role: 'tool', content: 'file body', tool_call_id: 'c1' },
    ])
  })

  it('普通文本消息原样保留', () => {
    const history = buildQoderHistory([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
    expect(history).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
  })

  it('缺 role 的畸形条目被跳过（不让整轮请求失败）', () => {
    const history = buildQoderHistory([{ content: 'no role' }, { role: 'user', content: 'ok' }])
    expect(history).toEqual([{ role: 'user', content: 'ok' }])
  })

  /**
   * ## 真实缺陷（用户报障）：「给 qodercn 的 qwen3.8-flash 发送图片，说没读到图片」
   *
   * 根因**不在** `chat_context.imageUrls` —— 客户端官方实现 `Hyc()` 就把那个字段
   * **恒置 `null`**（obf 产物原文：
   * `function Hyc(A,e,t){return{text:A,features:[],extra:{…},chatPrompt:"",imageUrls:null}}`），
   * 我们那行是忠实复刻。图片的正确通道是 **`messages[].content` 的多模态数组**：
   * 客户端 `eQc()` 把 `{type:'base64',media_type,data}` 转成
   * `{type:'image_url',image_url:{url:'data:…'}}`，`bJc()` 再转成 `input_image`。
   *
   * 而 `buildQoderHistory` 用 `qoderContentText()` 把 content **压成纯文本**，
   * 图片块因此在下游全部消失。上游 `serializeMessages` 明明已经产出了正确的
   * 多模态数组（见下方用例第 1 段断言），是这里把它吃掉的。
   *
   * ⚠️ 这是本文件第三个同型缺陷（前两个：`tools` 不下发、工具历史丢
   * `tool_calls`）—— 都是「序列化层没保留多模态结构」。
   */
  it('带图片的 user 消息必须保留 content 数组（图片不能被压成纯文本）', () => {
    const wire = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这个图片描述了什么内容' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]
    const history = buildQoderHistory(wire)
    expect(history).toHaveLength(1)
    // 关键：content 必须仍是数组，且图片块原样保留。
    expect(Array.isArray(history[0]!.content), '图片消息的 content 被压成了字符串').toBe(true)
    expect(history[0]!.content).toEqual([
      { type: 'text', text: '这个图片描述了什么内容' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })

  it('纯文本消息仍输出字符串（不要为了图片把既有形态一起改掉）', () => {
    // 上游对字符串 content 的兼容性最好，且既有用例锁死了这一形态。
    // 只让**含图**的消息升级为数组，纯文本保持原样。
    const history = buildQoderHistory([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: 'world' },
    ])
    expect(history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
  })

  it('多张图片与图片在文本之前都按原顺序保留', () => {
    const wire = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'text', text: '对比这两张' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
        ],
      },
    ]
    const history = buildQoderHistory(wire)
    expect(history[0]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: '对比这两张' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
    ])
  })

  it('只有图片、没有文本的消息不能被当成空消息丢掉', () => {
    // 旧实现按「压平后的文本长度 + tool 字段」判空，纯图片消息会被判空而整条丢弃。
    const history = buildQoderHistory([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
      },
    ])
    expect(history, '纯图片消息被丢弃了').toHaveLength(1)
    expect(history[0]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
  })

  it('图片块里的未知/畸形字段被剔除（只留协议认识的形态）', () => {
    // 与「逐字段搬运」的既有约定一致：不要把调用方的内部字段发给上游。
    const history = buildQoderHistory([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' }, internalId: 'x', source: 'y' },
        ],
      },
    ])
    expect(history[0]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
  })
})

describe('buildQoderInferPayload：tools 必须真的进入请求体', () => {
  it('传入的工具出现在 payload.tools（**回归：曾硬编码为 []**）', () => {
    const payload = buildQoderInferPayload(ask({
      tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } }],
    }))
    expect(payload.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } },
    ])
  })

  it('未传工具时 tools 为空数组（与客户端一致，不是缺字段）', () => {
    expect(buildQoderInferPayload(ask()).tools).toEqual([])
  })

  it('工具调用的历史进入 payload.messages（含 tool_calls / tool_call_id）', () => {
    const payload = buildQoderInferPayload(ask({
      history: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      ],
    }))
    const messages = payload.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    })
    expect(messages[1]).toMatchObject({ role: 'tool', content: 'ok', tool_call_id: 'c1' })
  })

  it('`business` 仍在（缺了服务端会路由到坏节点）', () => {
    expect(buildQoderInferPayload(ask({ business: { type: 'agent' } })).business)
      .toEqual({ type: 'agent' })
  })
})

describe('QoderAdapter 真的把工具与工具历史交给加密请求（端到端）', () => {
  it('options.tools 被下发到 ask.tools（**回归：曾硬编码为空**）', async () => {
    const { QoderAdapter } = await import('../../src/qoder-adapter.js')
    const { QODER } = await import('../../src/qoder-product.js')
    const { buildQoderCredential, parseQoderTokenPayload } = await import('../../src/qoder.js')

    const credential = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
      { machineId: 'm-1' },
    )
    const adapter = new QoderAdapter({
      credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      product: QODER,
      fetchImpl: (async () => envelope('hi')) as unknown as typeof fetch,
    })

    for await (const _ of adapter.stream({
      model: 'qfmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    } as never)) { /* drain */ }

    // 这是用户报障的直接防线：没有它，模型只能用正文 XML 臆造工具调用。
    expect(captured.ask?.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } },
    ])
    // 且它必须真的落到**加密前的 payload** 顶层 `tools`。
    expect(captured.payload?.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } },
    ])
  })

  it('无工具时 ask.tools 为空数组（键恒在，与客户端一致）', async () => {
    const { QoderAdapter } = await import('../../src/qoder-adapter.js')
    const { QODER } = await import('../../src/qoder-product.js')
    const { buildQoderCredential, parseQoderTokenPayload } = await import('../../src/qoder.js')

    const credential = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
      { machineId: 'm-1' },
    )
    const adapter = new QoderAdapter({
      credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      product: QODER,
      fetchImpl: (async () => envelope('hi')) as unknown as typeof fetch,
    })

    for await (const _ of adapter.stream({
      model: 'qfmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }

    expect(captured.ask?.tools).toEqual([])
    expect(captured.payload?.tools).toEqual([])
  })

  it('assistant 的 tool_calls 与 tool 的 tool_call_id 进入历史', async () => {
    const { QoderAdapter } = await import('../../src/qoder-adapter.js')
    const { QODER } = await import('../../src/qoder-product.js')
    const { buildQoderCredential, parseQoderTokenPayload } = await import('../../src/qoder.js')

    const credential = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
      { machineId: 'm-1' },
    )
    const adapter = new QoderAdapter({
      credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      product: QODER,
      fetchImpl: (async () => envelope('hi')) as unknown as typeof fetch,
    })

    for await (const _ of adapter.stream({
      model: 'qfmodel',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] }],
        },
      ],
    } as never)) { /* drain */ }

    const history = captured.ask?.history ?? []
    const assistant = history.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.[0]).toMatchObject({
      id: 'c1',
      type: 'function',
      function: { name: 'read' },
    })
    const tool = history.find((m) => m.role === 'tool')
    expect(tool).toMatchObject({ role: 'tool', content: 'file body', tool_call_id: 'c1' })

    // 同样断言它们进入了加密前的 payload.messages。
    const payloadMessages = captured.payload?.messages as Array<Record<string, unknown>>
    expect(payloadMessages.find((m) => m.role === 'assistant')?.tool_calls).toBeDefined()
    expect(payloadMessages.find((m) => m.role === 'tool')).toMatchObject({
      role: 'tool', content: 'file body', tool_call_id: 'c1',
    })
  })
})
