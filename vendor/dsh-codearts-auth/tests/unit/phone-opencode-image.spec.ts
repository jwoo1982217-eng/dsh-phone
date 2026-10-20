import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { OpencodeLocalAdapter } from '../../src/opencode-local-adapter.js'
import { OpencodeHybridAdapter, createOpencodeInferenceAdapter } from '../../src/opencode-hybrid-adapter.js'
import { clearOpencodeCapabilitiesCache, getOpencodeCapabilitiesSync, primeOpencodeCapabilities, refreshOpencodeCapabilities } from '../../src/opencode-capability.js'
import { collectOpenAiCompletion } from '../../src/openai-gateway/stream.js'
import { collectResponsesResult } from '../../src/openai-gateway/responses.js'

let home: string, oldHome: string | undefined
beforeEach(async () => {
  oldHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-phone-visual-'))
  process.env.DSH_HOME = home
  await clearOpencodeCapabilitiesCache()
})
afterEach(async () => {
  await clearOpencodeCapabilitiesCache()
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
})
async function drain<T>(stream: AsyncIterable<T>) { const chunks: T[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
function seedImageCache() {
  mkdirSync(join(home, 'cache'), { recursive: true })
  writeFileSync(join(home, 'cache/opencode-capabilities.json'), JSON.stringify({ version: 2, at: Date.now(), entries: [{
    id: 'space-bunny-free', name: '视觉夹具', modalities: ['text', 'image'], contextWindow: 65536,
    maxOutputTokens: 4096, reasoning: false, efforts: [], toolCall: true, isFree: true,
  }] }))
}
const image = { type: 'image', attachment: { attachmentId: 'local-fixture-image' } }
const request = { provider: 'opencode', model: 'space-bunny-free', messages: [{ role: 'user', content: [image] }] } as GenerateOptions
const success = () => new Response('data: {"choices":[{"index":0,"delta":{"content":"完成"}}]}\n\n'
  + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })

class LocalFixture extends LlmAdapter {
  models: Array<{ id: string; inputModalities: string[] }> = []
  service = { cachedModels: () => this.models }
  seen: GenerateOptions[] = []
  async listModels(provider: string) { return this.models.map(model => ({ provider, ...model, name: model.id })) }
  listAllModels() { return this.models.map(model => ({ id: model.id, name: model.id })) }
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: id, inputModalities: ['text', 'image'], context: { contextWindow: 32768 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.seen.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('手机既有视觉模型保留与快通道附件桥接', () => {
  it('能力表已声明视觉的型号整体走原local，元信息、准备、发送同一路，图片保持原对象', async () => {
    seedImageCache()
    const local = new LocalFixture()
    local.models = [{ id: 'space-bunny-free', inputModalities: ['text', 'image'] }]
    const network = vi.fn(async () => { throw new Error('禁止网络') })
    vi.stubGlobal('fetch', network)
    const adapter = new OpencodeHybridAdapter(local as unknown as OpencodeLocalAdapter, createOpencodeInferenceAdapter())
    const prepared = await adapter.prepareCall('opencode', request.model)
    expect(prepared.model).toMatchObject({ inputModalities: ['text', 'image'], context: { contextWindow: 32768 } })
    await drain(prepared.stream(request))
    expect(local.seen[0].messages[0].content).toBe(request.messages[0].content)
    expect(local.seen[0].messages[0].content).toContain(image)
    expect(network).not.toHaveBeenCalled()
    expect((await adapter.listModels('opencode')).find(model => model.id === request.model)?.inputModalities).toEqual(['text', 'image'])
  })

  it('能力表未知而本地目录已知视觉时仍保留local，不依赖名称猜能力', async () => {
    const local = new LocalFixture()
    local.models = [{ id: 'deepseek-v4.1-flash-free', inputModalities: ['text', 'image'] }]
    const adapter = new OpencodeHybridAdapter(local as unknown as OpencodeLocalAdapter, createOpencodeInferenceAdapter())
    expect((await adapter.prepareCall('opencode', 'deepseek-v4.1-flash-free')).model.context?.contextWindow).toBe(32768)
  })

  it('准备之后目录更新不会把同一次快通道调用改送local，下一次才采用新路线', async () => {
    const local = new LocalFixture()
    const fast = createOpencodeInferenceAdapter()
    const adapter = new OpencodeHybridAdapter(local as unknown as OpencodeLocalAdapter, fast)
    const network = vi.fn(async () => success())
    vi.stubGlobal('fetch', network)
    const prepared = await adapter.prepareCall('opencode', 'deepseek-v4.1-flash-free')
    local.models = [{ id: 'deepseek-v4.1-flash-free', inputModalities: ['text', 'image'] }]
    await drain(prepared.stream({ provider: 'opencode', model: 'deepseek-v4.1-flash-free', messages: [] }))
    expect(network).toHaveBeenCalledTimes(1)
    expect(local.seen).toHaveLength(0)
    expect((await adapter.prepareCall('opencode', 'deepseek-v4.1-flash-free')).model.context?.contextWindow).toBe(32768)
  })

  it('工厂注入附件桥后，已知图片按真实字节进入出站data URL，而非占位文字', async () => {
    seedImageCache()
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))
    const network = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(JSON.stringify(body.messages)).toContain('data:image/png;base64,AQID')
      expect(JSON.stringify(body.messages)).not.toContain('[image unavailable]')
      return success()
    })
    vi.stubGlobal('fetch', network)
    await drain(createOpencodeInferenceAdapter({ readImage }).stream(request))
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'empty', 'wrong-type', 'throws'] as const)('附件失败 %s 明确报输入错误，不联网且修复后可恢复', async mode => {
    seedImageCache()
    let restored = false
    const readImage = async () => {
      if (restored) return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
      if (mode === 'throws') throw new Error('本地附件读取失败')
      if (mode === 'missing') return undefined
      return { data: new Uint8Array(mode === 'empty' ? [] : [1]), mediaType: mode === 'wrong-type' ? 'text/plain' : 'image/png' }
    }
    const network = vi.fn(async () => success())
    vi.stubGlobal('fetch', network)
    const adapter = createOpencodeInferenceAdapter({ readImage })
    await expect(drain(adapter.stream(request))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(network).not.toHaveBeenCalled()
    restored = true
    expect((await drain(adapter.stream(request))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('后台能力刷新用禁网models.dev夹具更新缓存并通知，渲染读取不触发网络', async () => {
    const network = vi.fn(async () => new Response(JSON.stringify({ opencode: { models: { 'space-bunny-free': {
      name: '离线视觉夹具', modalities: { input: ['text', 'image'] }, limit: { context: 65536, output: 4096 }, cost: { input: 0, output: 0 },
    } } } }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', network)
    const updated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后台刷新未通知')), 1000)
      primeOpencodeCapabilities()
      refreshOpencodeCapabilities(() => { clearTimeout(timer); resolve() })
    })
    await updated
    expect(getOpencodeCapabilitiesSync()[0]).toMatchObject({ id: 'space-bunny-free', modalities: ['text', 'image'], contextWindow: 65536 })
    const count = network.mock.calls.length
    await createOpencodeInferenceAdapter().resolveModel('opencode', 'space-bunny-free')
    expect(network).toHaveBeenCalledTimes(count)
  })
})

describe('快通道失败不得伪装成额度用尽', () => {
  it('最后一个匿名slot的503保持SERVER/503，Chat和Responses可见相同真实失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream unavailable', { status: 503 })))
    const adapter = createOpencodeInferenceAdapter()
    const options = { provider: 'opencode', model: 'deepseek-v4.1-flash-free', messages: [] }
    const prepared = await adapter.prepareCall(options.provider, options.model)
    await expect(drain(prepared.stream(options))).rejects.toMatchObject({ code: 'SERVER', failure: { status: 503 } })
    await expect(collectOpenAiCompletion(prepared.stream(options), 'fixture/text'))
      .rejects.toMatchObject({ status: 503, code: 'SERVER' })
    await expect(collectResponsesResult(prepared.stream(options), 'resp_fixture', 'fixture/text', { input: '夹具', model: 'fixture/text' }))
      .rejects.toMatchObject({ status: 503, code: 'SERVER' })
  })

  it('附件输入错误从prepared.stream经过两个网关也保持UNSUPPORTED_CONTENT', async () => {
    seedImageCache()
    const adapter = createOpencodeInferenceAdapter()
    const prepared = await adapter.prepareCall(request.provider, request.model)
    await expect(collectOpenAiCompletion(prepared.stream(request), 'fixture/text'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(collectResponsesResult(prepared.stream(request), 'resp_fixture', 'fixture/text', { input: '夹具', model: 'fixture/text' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})
