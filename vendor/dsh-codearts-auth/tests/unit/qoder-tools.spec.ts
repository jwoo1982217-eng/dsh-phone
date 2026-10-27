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

/**
 * ⚠️ `dispose` 的**调用计数**（2026-10-12 审计补）。
 *
 * 真实缺陷：原先替身写成 `dispose: () => {}`（noop）—— 那只能证明「方法存在」，
 * **不能证明它被调用**。审计实测：删掉适配器 `buildRequest` 的 `finally` 里那句
 * `client?.dispose()`，5 个 qoder 相关 spec 共 147 条全绿，即这条交付
 * **零守卫**。故改为可计数，并由下面两条用例断言「每次构造请求都释放」。
 */
const disposeCalls = { count: 0 }

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
        // ⚠️ 替身必须**镜像真实类的接口**：适配器在 `buildRequest` 的
        // `finally` 里调 `dispose()` 释放 wasm `QoderContext`
        // （见 `src/qoder-wasm.ts` 文件头的「wasm 堆泄漏」）。
        // 替身缺这个方法会让每个用例都报 `client?.dispose is not a function`。
        // ⚠️ 计数（不是 noop）：见上面 `disposeCalls` 的注释。
        dispose: () => { disposeCalls.count += 1 },
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

/**
 * ★★ 适配器侧必须**真的调用** `dispose()`（2026-10-12 审计补的守卫）。
 *
 * ## 为什么单独立一组
 *
 * `buildRequest` 的 `finally` 里那句 `client?.dispose()` 是本次移植的**核心交付
 * 之一**（不释放则进程级 wasm 堆只增不减 ⇒ 长上下文会话 `unreachable` 暴毙）。
 * 但审计实测：**删掉它，5 个 qoder 相关 spec 共 147 条全绿** —— 即这条交付
 * **零守卫**。
 *
 * 根因是替身写法：原先 `dispose: () => {}` 只能证明「方法存在」（缺了会报
 * `client?.dispose is not a function`），**不能证明它被调用**。
 * 故改为可计数，并在下面两条用例里断言：
 * 1. 正常路径：每次构造请求都释放；
 * 2. **异常路径**：`prepareInfer` 抛错时同样释放 —— 那正是泄漏最多的那条路；
 * 3. **错误保真**：释放失败不得顶替 `try` 块的原始错误。
 */
describe('★★ QoderAdapter.buildRequest 必须释放 wasm 上下文', () => {
  async function makeAdapter(fetchImpl: typeof fetch) {
    const { QoderAdapter } = await import('../../src/qoder-adapter.js')
    const { QODER } = await import('../../src/qoder-product.js')
    const { buildQoderCredential, parseQoderTokenPayload } = await import('../../src/qoder.js')
    const credential = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
      { machineId: 'm-1' },
    )
    return new QoderAdapter({
      credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      product: QODER,
      fetchImpl,
    })
  }

  it('★ 正常路径：每次构造请求都调用 dispose（否则 wasm 堆只增不减）', async () => {
    const adapter = await makeAdapter((async () => envelope('hi')) as unknown as typeof fetch)
    disposeCalls.count = 0
    for await (const _ of adapter.stream({
      model: 'qfmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ void _ }
    expect(disposeCalls.count, 'buildRequest 没有释放 wasm 上下文').toBeGreaterThanOrEqual(1)
  })

  it('★ 异常路径：prepareInfer 抛错时**同样**必须释放（那是泄漏最多的路）', async () => {
    // ⚠️ 这条防的是「把 dispose 写在 return 之后而不是 finally 里」这类回归：
    //    顺序调用在正常路径上看着是对的，异常路径却整条泄漏。
    const wasm = await import('../../src/qoder-wasm.js')
    const spy = vi.spyOn(wasm.QoderEncryptedInfer, 'create').mockResolvedValue({
      prepareInfer: () => { throw new Error('prepareInfer 炸了') },
      dispose: () => { disposeCalls.count += 1 },
    } as never)
    try {
      const adapter = await makeAdapter((async () => envelope('hi')) as unknown as typeof fetch)
      disposeCalls.count = 0
      await expect((async () => {
        for await (const _ of adapter.stream({
          model: 'qfmodel',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        } as never)) { /* drain */ void _ }
      })()).rejects.toThrow()
      expect(disposeCalls.count, '异常路径没有释放 wasm 上下文').toBeGreaterThanOrEqual(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('★★ 释放失败**不得顶替**原始错误（错误保真红线）', async () => {
    // ⚠️⚠️ 真实缺陷（2026-10-12 审计实测）：JS 语义上 `finally` 里的 `throw`
    //    **无条件覆盖** `try` 里的 `throw`，而 `dispose()` → `freePointer()`
    //    的 catch 里**确实会 rethrow** —— 它自己的注释就写了「堆耗尽时它同样
    //    会 trap」，即**恰在本修复要治理的那个场景下**会抛。
    //
    // 后果（修复前实测）：上游的 `AUTH` 被改写成「WASM 堆耗尽」，而且
    // `describeWasmFailure` 返回**裸 `Error`**（非 `HarnessError`）⇒ 外层
    // `normalizeLlmFailure` 归 `UNKNOWN` ⇒ **连可重试性判据一起丢**。
    //
    // ⇒ 修法：`dispose()` 包 try/catch，失败**只吞不上抛**（清理动作不该改变
    //   本次请求的结论）。本用例锁的就是「原始错误必须保真」。
    const wasm = await import('../../src/qoder-wasm.js')
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    const spy = vi.spyOn(wasm.QoderEncryptedInfer, 'create').mockResolvedValue({
      prepareInfer: () => { throw new LlmError('ORIGINAL-auth-401', 'AUTH' as never) },
      dispose: () => { throw new Error('DISPOSE-wasm-heap-exhausted') },
    } as never)
    try {
      const adapter = await makeAdapter((async () => envelope('hi')) as unknown as typeof fetch)
      const caught = await (async () => {
        try {
          for await (const _ of adapter.stream({
            model: 'qfmodel',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          } as never)) { /* drain */ void _ }
          return undefined
        } catch (error) {
          return error as { message?: string; code?: string }
        }
      })()
      expect(
        caught?.message,
        `原始错误被 dispose 顶替了（实测 message=${String(caught?.message)}）`,
      ).toContain('ORIGINAL-auth-401')
      // ⚠️ `code` 同样必须保真：`describeWasmFailure` 返回的是裸 `Error`，
      //    会让外层归 `UNKNOWN` 并丢掉 `AUTH` 的重试语义。
      expect(caught?.code).toBe('AUTH')
    } finally {
      spy.mockRestore()
    }
  })
})
