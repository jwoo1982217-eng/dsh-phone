import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOpencodeCapabilitiesCache } from '../../src/opencode-capability.js'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpencodeHybridAdapter, createOpencodeInferenceAdapter } from '../../src/opencode-hybrid-adapter.js'
import type { OpencodeLocalAdapter } from '../../src/opencode-local-adapter.js'
import { collectResponsesResult, toResponsesSse } from '../../src/openai-gateway/responses.js'

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of source) result.push(item)
  return result
}

let home: string, oldHome: string | undefined
beforeEach(async () => {
  oldHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-phone-sdk-'))
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

describe('手机版 SDK 的混合供应商契约', () => {
  it('继承 SDK 的 prepareCall 后，精确元信息与流都走免费快通道，本地服务不参与', async () => {
    const local = {
      resolveModel: vi.fn(), stream: vi.fn(),
    } as unknown as OpencodeLocalAdapter
    const requests: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => {
      requests.push({ url: String(url), headers: init.headers as Record<string, string> })
      return new Response('data: {"choices":[{"delta":{"content":"本机夹具"},"index":0}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n'
        + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }))
    const adapter = new OpencodeHybridAdapter(local, createOpencodeInferenceAdapter())
    expect(adapter).toBeInstanceOf(LlmAdapter)
    const prepared = await adapter.prepareCall('opencode', 'deepseek-v4.1-flash-free')
    // 此用例隔离能力缓存，只验证本地已声明的fallback，不发远端能力请求。
    expect(prepared.model).toMatchObject({ provider: 'opencode', id: 'deepseek-v4.1-flash-free', context: { contextWindow: 1_000_000 } })
    const chunks = await drain(prepared.stream({ provider: 'opencode', model: prepared.model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: '夹具' }] }],
    } as GenerateOptions))
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === '本机夹具')).toBe(true)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: 'https://opencode.ai/inference/v1/chat/completions', headers: { authorization: 'Bearer public' } })
    expect(local.resolveModel).not.toHaveBeenCalled()
    expect(local.stream).not.toHaveBeenCalled()
  })

  it('不在快通道表中的模型仍按手机已有本地服务准备和发送，不接触网络', async () => {
    const local = {
      prepareCall: LlmAdapter.prototype.prepareCall,
      resolveModel: vi.fn(async (provider: string, id: string) => ({ provider, id, name: '本地模型', context: { contextWindow: 262_144 } })),
      stream: vi.fn(async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }),
    } as unknown as OpencodeLocalAdapter
    const fetch = vi.fn(async () => { throw new Error('本测试禁止网络') })
    vi.stubGlobal('fetch', fetch)
    const adapter = new OpencodeHybridAdapter(local, createOpencodeInferenceAdapter())
    const prepared = await adapter.prepareCall('opencode', 'local-fixture')
    expect(prepared.model.context?.contextWindow).toBe(262_144)
    await drain(prepared.stream({ provider: 'opencode', model: 'local-fixture', messages: [] }))
    expect(local.resolveModel).toHaveBeenCalledWith('opencode', 'local-fixture', undefined)
    expect(local.stream).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('手机版 Responses 的终止失败状态', () => {
  it.each([
    { code: 'AUTH', upstream: 403, expected: 403 },
    { code: 'SERVER', upstream: 503, expected: 503 },
    { code: 'INVALID_REQUEST', upstream: 400, expected: 400 },
    { code: 'RATE_LIMIT', upstream: 429, expected: 429 },
  ])('$code 在完整响应与 SSE 失败事件中保留状态', async ({ code, upstream, expected }) => {
    const failure = async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { code, status: upstream, message: '离线失败夹具' } } }
    }
    const request = { model: 'fixture/text', input: '离线夹具' }
    await expect(collectResponsesResult(failure(), 'resp_fixture', request.model, request))
      .rejects.toMatchObject({ status: expected, code })
    const events = (await drain(toResponsesSse(failure(), 'resp_fixture', request.model, request))).join('')
    const last = events.trim().split('\n\n').at(-1)!
    expect(last).toContain('event: response.failed')
    const data = JSON.parse(last.split('\ndata: ')[1]!)
    expect(data.response.error).toMatchObject({ status: expected, dsh_code: code })
  })
})
