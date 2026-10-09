import { describe, expect, it } from 'vitest'
import { unwrapQoderEnvelopeStream } from '../../src/qoder-envelope.js'
import { consumeOpenAiSse } from '../../src/openai-compat.js'

/**
 * 构造 Qoder 加密端点风格的**信封 SSE**。
 *
 * 真实形态（实测 2026-09-20）：
 * ```
 * data:{"headers":{"Content-Type":["application/json"]},"body":"{\"choices\":[...]}","statusCodeValue":200,"statusCode":"OK"}
 * ```
 * 内层 `body` 是**标准 OpenAI chunk 的 JSON 字符串**（未加密）。
 */
function envelopeSse(innerFrames: readonly string[], trailing = '\n\n'): string {
  return innerFrames
    .map((inner) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: inner,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('') + trailing
}

/** 一段标准 OpenAI 正文帧。 */
const textFrame = (text: string): string =>
  JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })

/** 标准结束帧。 */
const finishFrame = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })

/** 把字符串包成 Response（模拟网络流）。 */
function asResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集适配器产出的 chunk。 */
async function collect(response: Response): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeOpenAiSse(response, {}, {
    label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
  })) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('Qoder 信封 SSE 解包', () => {
  it('剥掉信封后正文可被适配器消费', async () => {
    const sse = envelopeSse([textFrame('你'), textFrame('好'), finishFrame])
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text as string)
      .join('')
    expect(text).toBe('你好')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reasoning_content 也要能透出（思考模型）', async () => {
    const reasoning = JSON.stringify({ choices: [{ delta: { reasoning_content: '思考中' }, index: 0 }] })
    const sse = envelopeSse([reasoning, textFrame('答'), finishFrame])
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    expect(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')).toBe('思考中')
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('答')
  })

  it('分块到达（跨 chunk 截断）也要正确拼接', async () => {
    const sse = envelopeSse([textFrame('跨'), textFrame('块')], '')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(sse)
        // 故意在 JSON 中间切开
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.subarray(i, i + 7))
        }
        controller.close()
      },
    })
    const chunks = await collect(
      unwrapQoderEnvelopeStream(new Response(stream, { status: 200 }), 'qoder'),
    )
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('跨块')
  })

  it('业务错误帧必须抛错，不得静默 finish', async () => {
    // 真实错误形态：内层 body 是 [FAIL]node:... 的业务 JSON
    const fail = JSON.stringify({
      code: '400',
      message: '[FAIL]node:oa_qwen-plus-2025-04-28 msg:Execution failed: null',
    })
    const sse = envelopeSse([fail])
    await expect(collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))).rejects.toThrow(
      /Execution failed/,
    )
  })

  it('错误信息里保留 code 便于定位', async () => {
    const fail = JSON.stringify({ code: '400', message: '[FAIL]node:x msg:boom' })
    const error = await collect(unwrapQoderEnvelopeStream(asResponse(envelopeSse([fail])), 'qoder'))
      .catch((e: unknown) => e)
    expect((error as Error).message).toContain('400')
    expect((error as Error).message).toContain('boom')
  })

  it('非信封的标准帧原样透传（容错）', async () => {
    const sse = `data: ${textFrame('原生')}\n\ndata: ${finishFrame}\n\n`
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('原生')
  })

  it('event: 行保留（event: error 对诊断有价值）', async () => {
    const sse = `event: error\ndata: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`
    await expect(collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))).rejects.toThrow(/boom/)
  })

  it('没有 body 的响应要明确报错', () => {
    const response = { body: null, status: 200, statusText: 'OK' } as unknown as Response
    expect(() => unwrapQoderEnvelopeStream(response, 'qoder')).toThrow(/body/)
  })
})

/**
 * issue IKJOZ8：`body:"null"` 心跳帧被判成业务错误 ⇒ 模型正常回完内容却报失败。
 *
 * ⚠️ 根因是**字符串嗅探**判据（`!inner.includes('"choices"')` 即业务错误）：
 * `body: null` 经 `innerTextOf` 的 `JSON.stringify(null)` 变成 `'null'`，
 * 不含 `choices` ⇒ 被打成 `{message:"null", type:"model_error"}` ⇒ 抛
 * `SERVER`，而 `SERVER` **在** harness 的可重试集合里 ⇒ 整轮对话白重发 5 次。
 */
describe('信封心跳帧不得判成业务错误（IKJOZ8）', () => {
  /** 显式指定 `body` 的信封帧（不强制转字符串，以复刻 `body: null`）。 */
  const rawEnvelope = (body: unknown): string =>
    `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`

  it('body:null 心跳被跳过，正文完整送达', async () => {
    const sse = rawEnvelope(textFrame('收到')) + rawEnvelope(null) + rawEnvelope(finishFrame)
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('收到')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('body 为空串 / "null" 字符串 / 空对象 / 裸标量同样跳过', async () => {
    for (const body of ['', 'null', '   ', {}, 0, '0', '[]'] as const) {
      const sse = rawEnvelope(body) + rawEnvelope(textFrame('好')) + rawEnvelope(finishFrame)
      const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
      expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('好')
    }
  })

  it('心跳出现在**末尾无换行**时也不得透传成 `data: null`（否则抛未包装 TypeError）', async () => {
    // flush 分支：旧实现把 `null` 原样透传 → 消费器 `JSON.parse('null')` 得到
    // `null` → 读 `.error` 抛 `Cannot read properties of null`，绕过全部错误归类。
    const sse = rawEnvelope(textFrame('A')).slice(0, -1) + rawEnvelope(null).trimEnd()
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('A')
  })

  it('usage-only 末帧（无 choices）必须透传，不得当成错误', async () => {
    // 判据改为「解析 JSON 结构」的直接收益：`{usage:{…}}` 既无 choices 也无
    // 错误字段，旧嗅探判据会把它打成业务错误 ⇒ 丢掉整轮的 usage 统计。
    const usage = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 3 } })
    const stripped = await unwrapQoderEnvelopeStream(
      asResponse(rawEnvelope(textFrame('A')) + rawEnvelope(usage)),
      'qoder',
    ).text()
    expect(stripped).toContain('"usage"')
    expect(stripped).not.toContain('model_error')
  })

  it('choices 为空数组也算正常帧', async () => {
    const empty = JSON.stringify({ choices: [] })
    const stripped = await unwrapQoderEnvelopeStream(asResponse(rawEnvelope(empty)), 'qoder').text()
    expect(stripped).toContain('"choices"')
    expect(stripped).not.toContain('model_error')
  })

  it('错误文案里恰好含 `"choices"` 的帧必须仍被判成错误（反向缺陷）', async () => {
    // 旧嗅探判据的**另一个方向**的缺陷：`includes('"choices"')` 成立 ⇒
    // 错误帧被当正常帧**静默透传** ⇒ 消费器解析不出 choices，最终表现为
    // 「没有任何报错就停止」。
    const fail = JSON.stringify({ code: 500, message: 'bad frame: no "choices" here' })
    await expect(collect(unwrapQoderEnvelopeStream(asResponse(rawEnvelope(fail)), 'qoder')))
      .rejects.toThrow(/no "choices" here/)
  })

  it('既有业务错误形态全部仍然抛错（code / message / type / statusCodeValue）', async () => {
    const cases: Array<[string, string, string]> = [
      ['顶层 code+message', JSON.stringify({ code: '400', message: '[FAIL]node:oa_x msg:boom' }), 'SERVER'],
      ['排队 10605', JSON.stringify({ code: 403, message: JSON.stringify({ code: '10605', message: '{"isQueued":true}' }) }), 'QUEUE'],
      ['额度 110', JSON.stringify({ code: 110, message: 'Billing daily count exceeded' }), 'QUOTA_EXCEEDED'],
      ['网关形态', JSON.stringify({ statusCodeValue: 403, message: 'gateway says no' }), 'SERVER'],
      ['模型名错误', JSON.stringify({ type: 'invalid_model_error', message: 'Unsupported model' }), 'SERVER'],
      ['纯文本错误体', 'plain text error', 'SERVER'],
    ]
    for (const [name, inner, expectedCode] of cases) {
      const error = await collect(unwrapQoderEnvelopeStream(asResponse(rawEnvelope(inner)), 'qoder'))
        .catch((e: unknown) => e)
      expect(error, name).toBeInstanceOf(Error)
      expect((error as { code?: string }).code, name).toBe(expectedCode)
    }
  })
})
