import { describe, expect, it } from 'vitest'
import { parseModelRoute, toGenerateOptions } from '../../src/openai-gateway/messages.js'
import { collectOpenAiCompletion, toOpenAiSse, failureToOpenAiError } from '../../src/openai-gateway/stream.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> { yield* values }

/** 最小合法 PNG（1×1）。用真实字节而非随手写的 base64 —— 附件服务会校验
 * 「声明类型与字节是否相符」，伪图片会被它拒（探针实测：
 * `AttachmentError: Declared image type does not match its bytes.`）。 */
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('OpenAI gateway edge cases', () => {
  it('accepts model ids that contain slashes after the provider', () => {
    expect(parseModelRoute('cline/cline-free/deepseek-v4.1-flash'))
      .toEqual({ provider: 'cline', model: 'cline-free/deepseek-v4.1-flash' })
  })

  it('图片不再被整体拒绝，而是真的落成 ImageBlock（初版是「收到图就报不支持」）', async () => {
    const options = await toGenerateOptions(
      { model: 'qoder/qfmodel', messages: [{ role: 'user', content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1x1}` } },
      ] }] },
      new AbortController().signal,
      undefined,
      undefined,
      { bridge: { saveImage: async () => ({ attachmentId: 'sha256:abc', mediaType: 'image/png' }) } },
    )
    const content = options.messages[0]!.content as Array<{ type: string }>
    // ⚠️ 关键不是「没报错」，而是**图与配文都还在** —— 静默丢图会让用户以为
    // 模型看到了图，而答案其实是基于文本生成的。
    expect(content).toContainEqual(expect.objectContaining({ type: 'text', text: '这是什么' }))
    expect(content).toContainEqual(expect.objectContaining({ type: 'image' }))
  })

  it('⚠️ 没有附件服务时仍然明确报错，绝不静默丢图', async () => {
    await expect(toGenerateOptions(
      { model: 'qoder/qfmodel', messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1x1}` } },
      ] }] },
      new AbortController().signal,
    )).rejects.toThrow(/附件服务/)
  })

  it('⚠️ 图片只接受 base64 data URL，http 链接明确拒绝（SSRF）', async () => {
    await expect(toGenerateOptions(
      { model: 'qoder/qfmodel', messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ] }] },
      new AbortController().signal,
      undefined,
      undefined,
      { bridge: { saveImage: async () => ({ attachmentId: 'x', mediaType: 'image/png' }) } },
    )).rejects.toThrow(/SSRF/)
  })

  it('never converts a DSH stream error to successful completion', async () => {
    await expect(collectOpenAiCompletion(chunks([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'No quota' } } },
    ]), 'request', 'qoder/qfmodel')).rejects.toThrow('No quota')
  })

  it('额度失败在异常、非流式和 SSE 路径都保留业务原因，不再包装成 502', async () => {
    const failure = { code: 'QUOTA_EXCEEDED', message: '该账号无可用权益' }
    expect(failureToOpenAiError(failure)).toEqual({ status: 429, body: { error: {
      message: failure.message, type: 'insufficient_quota', code: failure.code,
    } } })
    const events: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure } }]
    await expect(collectOpenAiCompletion(chunks(events), 'request', 'zcode/GLM-5.3'))
      .rejects.toMatchObject({ status: 429, type: 'insufficient_quota', code: failure.code })
    const frames: string[] = []
    for await (const frame of toOpenAiSse(chunks(events), 'request', 'zcode/GLM-5.3')) frames.push(frame)
    expect(frames.join('')).toContain('"type":"insufficient_quota"')
    expect(frames.join('')).toContain(failure.message)
  })

  it('does not pretend an incomplete stream has stopped', async () => {
    await expect(collectOpenAiCompletion(chunks([{ type: 'text-delta', index: 0, text: 'partial' }]), 'request', 'qoder/qfmodel'))
      .rejects.toThrow(/finish/i)
  })

  it('emits an SSE error rather than DONE-only when no finish arrives', async () => {
    const events: string[] = []
    for await (const frame of toOpenAiSse(chunks([{ type: 'text-delta', index: 0, text: 'partial' }]), 'request', 'qoder/qfmodel')) events.push(frame)
    expect(events.join('')).toContain('"error"')
  })
})
