import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { listIdentitySlots } from '../../src/opencode-auth.js'
import { buildOpencodeRequest } from '../../src/opencode-messages.js'
import { normalizeOpencodeResponse, createOpencodeFrameNormalizer } from '../../src/opencode-stream.js'

const toolNames = ['read', 'shell', 'edit', 'write', 'glob', 'grep']
const tools = toolNames.map((name) => ({ name, description: '客户端工具', parameters: { type: 'object' } }))
const slots = () => listIdentitySlots([{ id: 'anon-a', enabled: true, apiKey: 'public' }, { id: 'anon-b', enabled: true, apiKey: 'public' }], 'opencode/1.18.22')
const frame = (calls: unknown[], finish?: string): unknown => ({ choices: [{ index: 0, delta: { tool_calls: calls }, ...(finish ? { finish_reason: finish } : {}) }] })
const call = (name?: string, args?: string, extra: Record<string, unknown> = {}): unknown => ({ ...extra, function: { ...(name === undefined ? {} : { name }), ...(args === undefined ? {} : { arguments: args }) } })
const sse = (frames: unknown[], done = true): string => frames.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')

async function run(frames: unknown[], enabledTools = tools, done = true): Promise<{ chunks: StreamChunk[]; fetchSpy: ReturnType<typeof vi.fn> }> {
  const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(sse(frames, done), { headers: { 'content-type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetchSpy)
  const chunks: StreamChunk[] = []
  const adapter = new OpencodeAdapter({ identitySlots: async () => slots() })
  for await (const chunk of adapter.stream({ provider: 'opencode', model: 'big-pickle', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: enabledTools } as unknown as GenerateOptions)) chunks.push(chunk)
  return { chunks, fetchSpy }
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenCode 专用响应归一', () => {
  it('真实请求发 dsh_ 别名，delta/block-end 都还原原名，stop 归一为 tool-calls', async () => {
    const { chunks, fetchSpy } = await run([
      frame([call('dsh_read', '{"path":', { index: 0, id: 'A' })]),
      frame([call('', '"文件"}', { index: 0 })], 'stop'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ])
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://opencode.ai/inference/v1/chat/completions')
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([...toolNames.map((name) => `dsh_${name}`), 'read'])
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    expect(deltas.map((chunk) => chunk.argumentsDelta).join('')).toBe('{"path":"文件"}')
    expect(deltas.every((chunk) => chunk.name === 'read')).toBe(true)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'tool-call', id: 'A', name: 'read', arguments: '{"path":"文件"}' } }))
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(true)
  })
  it('跨帧名字 + 参数先到：不泄漏别名，参数不丢不重复', async () => {
    const { chunks } = await run([
      frame([call('dsh_', '{', { id: 'A', index: 0 })]),
      frame([call('re', '"x":1', { index: 0 })]),
      frame([call('ad', '}', { index: 0 })], 'tool_calls'),
    ])
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    expect(deltas.map((chunk) => chunk.argumentsDelta).join('')).toBe('{"x":1}')
    expect(deltas.every((chunk) => chunk.name === 'read')).toBe(true)
  })
  it('短别名是另一别名的前缀时，不提前发错工具名', async () => {
    const clientTools = [{ name: 'read', description: '' }, { name: 'read_1', description: '' }]
    const { chunks } = await run([
      frame([call('dsh_read', '', { id: 'A', index: 0 })]),
      frame([call('_1', '{}', { index: 0 })], 'tool_calls'),
    ], clientTools)
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta').map((chunk) => chunk.name)).toEqual(['read_1'])
  })
  it('并行无 index 的调用按 id 归并，迟到 index 不改变下游调用身份', async () => {
    const { chunks } = await run([
      frame([call('dsh_read', '{', { id: 'A' }), call('dsh_edit', '{', { id: 'B' })]),
      frame([call(undefined, '"a":1}', { id: 'A', index: 7 }), call(undefined, '"b":2}', { id: 'B', index: 3 })], 'tool_calls'),
    ])
    const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(ends.map((chunk) => chunk.block)).toEqual([
      { type: 'tool-call', id: 'A', name: 'read', arguments: '{"a":1}' },
      { type: 'tool-call', id: 'B', name: 'edit', arguments: '{"b":2}' },
    ])
  })
  it('无 index 的参数续传进入当前调用，不产生多条工具', async () => {
    const { chunks } = await run([frame([call('dsh_read', '{', { id: 'A' })]), frame([call(undefined, '}')], 'tool_calls')])
    expect(chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toHaveLength(1)
  })
  it('重复完整名字不重复拼接，只有一个客户端调用', async () => {
    const { chunks } = await run([frame([call('dsh_read', '{', { index: 0, id: 'A' })]), frame([call('dsh_read', '}', { index: 0 })], 'tool_calls')])
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta').every((chunk) => chunk.name === 'read')).toBe(true)
  })
  it('兼容 legacy function_call 的名字与参数分片', async () => {
    const { chunks } = await run([
      { choices: [{ delta: { function_call: { name: 'dsh_re', arguments: '{' } } }] },
      { choices: [{ delta: { function_call: { name: 'ad', arguments: '}' } }, finish_reason: 'function_call' }] },
    ])
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'tool-call', id: 'call_legacy_0', name: 'read', arguments: '{}' } }))
  })
  // ⚠️ 2026-10-15 真机复现：只广告门禁 `read`（= 调用方没传工具）时，
  // big-pickle 收到「读取 /tmp/a.txt」会**稳定**产出一条 `read{path}` 调用。
  // 这类名字必须**剔除该次调用**、本轮照常收尾 —— 原实现抛 PERMISSION_DENIED，
  // 用户连已经流出的正文都拿不到，是「一次模型行为打死整轮对话」。
  it.each(['read', 'shell', 'unknown', 'dsh_unknown'])('剔除保留/未知名字 %s：不整轮报错、不换槽不标额度', async (name) => {
    const fetchSpy = vi.fn(async () => new Response(sse([frame([call(name, '{}', { index: 0, id: 'A' })], 'tool_calls')])))
    const mark = vi.fn()
    const warn = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new OpencodeAdapter({ identitySlots: async () => slots(), markLimited: mark, warn })
    const emitted: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'opencode', model: 'big-pickle', messages: [], tools } as unknown as GenerateOptions)) emitted.push(chunk)
    // 剔除 ⇒ 消费器一个工具块都不建：会话里不会留下可执行的坏调用（更不会
    // 出现 `unknown tool ""` 那种会被原样重放、把整条会话打成 400 的名字）。
    expect(emitted.some((chunk) => chunk.type === 'tool-call-delta')).toBe(false)
    expect(emitted.some((chunk) => chunk.type === 'block-end')).toBe(false)
    // 且要报「模型想调工具却被剔除」的既有信号（max-tokens），不能静默 stop。
    expect(emitted).toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    // 剔除必须有痕：宿主日志里要能看到是哪个名字被扔了。
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(name)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mark).not.toHaveBeenCalled()
  })
  it.each(['finish', 'done', 'eof'])('残缺名称在 %s 路径被剔除：不发可执行块也不报错', async (ending) => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
    const warn = vi.fn()
    const response = new Response(sse([frame([call('dsh_re', '{}', { index: 0, id: 'A' })], ending === 'finish' ? 'stop' : undefined)], ending === 'done'))
    const text = await normalizeOpencodeResponse(response, request, warn).text()
    // 名字没拼全 ⇒ 别名一个字段都不许泄漏给下游（消费器据此丢弃整块）。
    expect(text).not.toContain('dsh_re')
    expect(text).not.toContain('"name"')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('dsh_re')
  })
  it('同批混入未知名字时，合法调用照常保留（剔除不得连坐）', async () => {
    const { chunks } = await run([
      frame([call('dsh_read', '{}', { index: 0, id: 'A' }), call('bash', '{}', { index: 1, id: 'B' })], 'tool_calls'),
    ])
    expect(chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block)).toEqual([
      { type: 'tool-call', id: 'A', name: 'read', arguments: '{}' },
    ])
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
  it('没有启用工具时，门禁调用与 tool_calls 收尾都不许打死本轮', async () => {
    // 没有任何调用可剔除、却声称 tool_calls：自相矛盾的帧 ⇒ 降级 stop ⇒ 零块
    // ⇒ EMPTY_RESPONSE（有明确语义的错误，不再是「权限被拒」这种误导码）。
    const empty = await run([frame([], 'tool_calls')], [])
    expect(empty.chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind: 'error' }) }))
    // 真机形态：此刻别名表为空，模型只能去调门禁 `read` ⇒ 剔除，不抛错。
    const gate = await run([frame([call('read', '{"path":"/tmp/a.txt"}', { index: 0, id: 'A' })], 'tool_calls')], [])
    expect(gate.chunks.some((chunk) => chunk.type === 'block-end')).toBe(false)
    expect(gate.chunks).toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
  // ⚠️ 以下六条来自 2026-10-15 的独立审计 + 对抗性审计（两轮均为 subagent 执行）。
  // 每条都对应一处**已被审计确证**的缺陷，判据刻意做成「变异即红」：
  describe('审计确证的边界（2026-10-15）', () => {
    /** 从归一后的帧里取出第一条工具调用的名字（`undefined` = 已被删掉，不会还原）。 */
    const wireNameOf = (target: unknown): unknown => {
      const choices = (target as { choices: { delta: { tool_calls: { function: Record<string, unknown> }[] } }[] }).choices
      return choices[0]!.delta.tool_calls[0]!.function.name
    }
    // 审计发现：`toolsDisabled ⇒ 别名表必空` 使这一行在生产链路不可达，且**全仓无用例**
    // 能证明它（把它改回 `aliases.get(name)` 全量仍全绿）。故这里**绕过请求构造器**
    // 直接喂一份「非空别名表 + toolsDisabled」——这是响应层最后一道防线的唯一守卫。
    it('toolsDisabled 时别名表非空也不还原（响应层最后一道防线有牙）', () => {
      const frameOf = (): unknown => frame([call('dsh_read', '{}', { index: 0, id: 'A' })])
      const aliases = new Map([['dsh_read', 'read']])
      const enabled = frameOf()
      createOpencodeFrameNormalizer({ toolAliases: aliases, toolsDisabled: false }).transformFrame(enabled as Record<string, unknown>)
      expect(wireNameOf(enabled)).toBe('read')
      const disabled = frameOf()
      const warn = vi.fn()
      createOpencodeFrameNormalizer({ toolAliases: aliases, toolsDisabled: true }, warn).transformFrame(disabled as Record<string, unknown>)
      expect(wireNameOf(disabled)).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    })
    // 审计发现：坏调用在消费器内部**仍登记**一条不会 announced 的块，而 `argsTruncated`
    // 遍历**全部**块 ⇒ 它的半截参数会把同批**合法**调用也拖成 max-tokens（宿主丢弃并重试）。
    it('坏调用的残缺参数不得把同批合法调用拖成 max-tokens', async () => {
      const { chunks } = await run([
        frame([call('dsh_read', '{"path":"/tmp/a.txt"}', { index: 0, id: 'A' }), call('bash', '{"cmd":', { index: 1, id: 'B' })], 'tool_calls'),
      ])
      expect(chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block)).toEqual([
        { type: 'tool-call', id: 'A', name: 'read', arguments: '{"path":"/tmp/a.txt"}' },
      ])
      expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    })
    // 审计发现：名字**从未到达**时旧判据（`upstreamName.length > 0`）让调用零告警消失 ——
    // 本仓库反复登记的「『空』被当成『正常的无』」那一类缺陷。
    it('名字从未到达的调用被剔除时也要留痕，不得零告警消失', async () => {
      const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
      const warn = vi.fn()
      const response = new Response(sse([frame([call(undefined, '{}', { index: 0, id: 'A' })], 'tool_calls')]))
      await normalizeOpencodeResponse(response, request, warn).text()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('始终没有名字')
    })
    // 审计发现：`dropCall` 在 `TransformStream.transform` 里同步调 `warn` ⇒ 日志出口抛错
    // 会把整轮打死，与被剔除的初衷正相反。
    it('告警出口抛异常不得打死本轮', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(sse([frame([call('bash', '{}', { index: 0, id: 'A' })], 'tool_calls')]))))
      const adapter = new OpencodeAdapter({ identitySlots: async () => slots(), warn: () => { throw new Error('logger 挂了') } })
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({ provider: 'opencode', model: 'big-pickle', messages: [], tools } as unknown as GenerateOptions)) chunks.push(chunk)
      expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    })
    // 审计发现：被剔除的调用仍占着 id/下标槽 ⇒ 上游在同一槽上开另一条调用时，新名字会被
    // 拼进死调用（`bash` + `dsh_glob`）而**一条新告警都没有**地消失（真机续传帧是
    // `"name":null`，不触发这条 rebind，故 fixture 用例仍只有一条 warn）。
    it('已剔除的调用占用的下标被复用时，后来的合法调用不被吞掉', async () => {
      const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
      const warn = vi.fn()
      const response = new Response(sse([
        frame([call('bash', '{}', { index: 0, id: 'A' })]),
        frame([call('dsh_glob', '{"pattern":"*"}', { index: 0 })]),
      ], 'tool_calls'))
      const text = await normalizeOpencodeResponse(response, request, warn).text()
      expect(text).toContain('"name":"glob"')
      expect(text).not.toContain('dsh_glob')
      expect(warn).toHaveBeenCalledTimes(1)
    })
    it('dsh_ 前缀的自造名字单独归因，不记成模型幻觉；残缺名称的歧义文案不混用', async () => {
      const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
      const aliased = vi.fn()
      await normalizeOpencodeResponse(new Response(sse([frame([call('dsh_ghost', '{}', { index: 0, id: 'A' })], 'stop')])), request, aliased).text()
      expect(String(aliased.mock.calls[0]![0])).toContain('别名表')
      const hallucinated = vi.fn()
      await normalizeOpencodeResponse(new Response(sse([frame([call('ghost', '{}', { index: 0, id: 'A' })], 'stop')])), request, hallucinated).text()
      expect(String(hallucinated.mock.calls[0]![0])).toContain('未声明的工具名')
      expect(String(hallucinated.mock.calls[0]![0])).not.toContain('别名表')
      // 同时启用 `read` 与 `read_image` ⇒ `dsh_read` 停在候选前缀上：文案须说「重叠」。
      // 已知代价（文件头「如实登记的边界」）：这条**本可执行**的无参调用会被剔除。
      const ambiguousTools = [{ name: 'read', description: '' }, { name: 'read_image', description: '' }]
      const ambiguousRequest = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools: ambiguousTools })
      const stopped = vi.fn()
      await normalizeOpencodeResponse(new Response(sse([frame([call('dsh_read', '', { index: 0, id: 'A' })], 'stop')])), ambiguousRequest, stopped).text()
      expect(stopped).toHaveBeenCalledTimes(1)
      expect(String(stopped.mock.calls[0]![0])).toContain('前缀重叠')
    })
  })
  // ⚠️ 真机实录（2026-10-15 匿名通道 big-pickle，`tests/fixtures/opencode-gate-call.sse.txt`）：
  // tools 只含门禁 `read` 时，「读取 /tmp/a.txt」产出的**完整上游 SSE** —— 17 个 data 帧、
  // 15 个 reasoning 帧、6 个 `{"name":null}` 参数续帧、1 条 `read` 调用、收尾 tool_calls。
  // 原实现在这里抛 PERMISSION_DENIED 打死整轮；本用例把「必须剔除而非报错」锁死。
  it('真机实录：模型调门禁 read 的完整 SSE 被剔除，本轮照常收尾', async () => {
    const raw = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'opencode-gate-call.sse.txt'), 'utf8')
    const warn = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } })))
    const adapter = new OpencodeAdapter({ identitySlots: async () => slots(), warn })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'opencode',
      model: 'big-pickle',
      messages: [{ role: 'user', content: [{ type: 'text', text: '读取 /tmp/a.txt 这个文件。' }] }],
      tools: [],
    } as unknown as GenerateOptions)) chunks.push(chunk)
    // 不抛错、不产出可执行工具块，且报「想调工具却被剔除」的既有信号。
    expect(chunks.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    // 剔除要留痕，且思考内容不得跟着一起丢。
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('read')
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-delta').length).toBeGreaterThan(0)
  })
  // ⚠️ 真机偶发（2026-10-15，约 11 次采样命中 1 次）：上游把**思考文本 + 裸闭标签**
  // 直接写进 `content`。本适配器**刻意不处理**它 —— 共享消费器的
  // `splitThinkTaggedContent`（恒开、block-end 权威覆盖，见 `tests/unit/think-tag-split.spec.ts`）
  // 负责把标签前的独白归位到 reasoning 块。本用例锁住「opencode 不自己造第二套解析」。
  // ⚠️ 注意归位发生在**收尾**：正文块先收尾、被切分出来的 reasoning 块后收尾并获得
  // 更靠后的 index（这是共享消费器的既有行为，不是本适配器的选择）；流式过程中
  // 已经发出去的 `text-delta` 仍带着该前缀 —— 全渠道同型，属既有设计。
  it('正文夹带裸闭 think 标记时由共享切分归位，本适配器不自行处理', async () => {
    const textFrame = (content: string, finish?: string): unknown => ({ choices: [{ index: 0, delta: { content }, ...(finish ? { finish_reason: finish } : {}) }] })
    const { chunks } = await run([textFrame('思考一下'), textFrame('</think>OK', 'stop')])
    expect(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => ({ index: chunk.index, block: chunk.block }))).toEqual([
      { index: 0, block: { type: 'text', text: 'OK' } },
      { index: 1, block: { type: 'reasoning', text: '思考一下' } },
    ])
  })
  it('CRLF、多行 data、UTF-8 跨网络块与 EOF 末帧正确改写', async () => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
    const text = 'event: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"中文","tool_calls":[{"id":"A","index":0,"function":{"name":"dsh_read","arguments":"{}"}}]},"finish_reason":"stop"}]} '
    const bytes = new TextEncoder().encode(text)
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } }))
    const normalized = await normalizeOpencodeResponse(response, request).text()
    expect(normalized).toContain('中文')
    expect(normalized).toContain('"name":"read"')
    expect(normalized).not.toContain('dsh_read')
    expect(normalized).toContain('event: message')
  })
  it('名称前缀有歧义时，前帧已经开始的参数也能确定短别名', async () => {
    const clientTools = [{ name: 'read', description: '' }, { name: 'read_1', description: '' }]
    const { chunks } = await run([
      frame([call('dsh_', '{}', { index: 0, id: 'A' })]),
      frame([call('read', undefined, { index: 0 })], 'tool_calls'),
    ], clientTools)
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta').map((chunk) => chunk.name)).toEqual(['read'])
  })
  it('前置流逐帧产出，不能等 EOF 才把正文交给消费器', async () => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools: [] })
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"先到"}}]}\n\n'))
      // 刻意不关闭：首个事件必须现在就可读。
    } }))
    const reader = normalizeOpencodeResponse(upstream, request).body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('先到')
    await reader.cancel()
  })
  it('HTTP 200 裸 JSON 错误不等 EOF 即透传', async () => {
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools: [] })
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":{"message":"失败"}}'))
    } }))
    const reader = normalizeOpencodeResponse(upstream, request).body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('失败')
    await reader.cancel()
  })
  it('调用方取消立即透传，不换槽不写额度标记', async () => {
    const controller = new AbortController()
    const reason = new DOMException('主动取消', 'AbortError')
    const mark = vi.fn()
    const fetchSpy = vi.fn(async () => { controller.abort(reason); throw reason })
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new OpencodeAdapter({ identitySlots: async () => slots(), markLimited: mark })
    await expect(adapter.stream({ provider: 'opencode', model: 'big-pickle', messages: [], tools, signal: controller.signal } as unknown as GenerateOptions).next()).rejects.toBe(reason)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(mark).not.toHaveBeenCalled()
  })
  it('取消前置流会取消上游，不能留后台读取', async () => {
    const cancelled = vi.fn()
    const request = buildOpencodeRequest({ model: 'big-pickle', messages: [], tools })
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))
    const response = normalizeOpencodeResponse(upstream, request)
    await response.body!.cancel()
    await Promise.resolve()
    expect(cancelled).toHaveBeenCalledOnce()
  })
})
