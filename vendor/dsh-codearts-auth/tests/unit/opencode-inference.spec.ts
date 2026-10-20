import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deriveInferenceSessionId, genuineTool, inferenceHeaders, prepareInferencePayload,
  INFERENCE_CORE_TOOLS,
} from '../../src/opencode-inference.js'
import {
  OPENCODE, OPENCODE_INFERENCE_MODELS, isFreeOpencodeModel, mergeInferenceModels,
  usesInferenceLane,
} from '../../src/opencode-product.js'
import { OpencodeAdapter, clearOpencodeCatalogCache } from '../../src/opencode-adapter.js'
import { listIdentitySlots, newAccountFingerprint, type IdentitySlot } from '../../src/opencode-auth.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

beforeEach(() => clearOpencodeCatalogCache())
afterEach(() => vi.unstubAllGlobals())

function anon(): IdentitySlot {
  return listIdentitySlots([{
    id: 'opencode-anon-test',
    enabled: true,
    apiKey: 'public',
    fingerprint: undefined,
  }], 'opencode/latest/2.0.29/cli')[0]!
}

function account(id: string, key: string): IdentitySlot {
  return { ...anon(), id, kind: 'account', apiKey: key, fingerprint: newAccountFingerprint(key) }
}

function sseOk(): Response {
  const body = 'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n'
    + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function freeTier403(): Response {
  return new Response(
    '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}',
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}

async function run(adapter: OpencodeAdapter, model: string): Promise<StreamChunk[]> {
  const options = {
    provider: 'opencode', model, messages: [{ role: 'user', content: 'x' }], system: '', tools: [],
  } as unknown as GenerateOptions
  const out: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) out.push(chunk)
  return out
}

describe('/inference 会话 id', () => {
  it('形状必须是 ses_ + 12 位降序时间（低 12 位 0xFC0~0xFFF）+ 14 位 base62', () => {
    for (let i = 0; i < 50; i++) {
      const id = deriveInferenceSessionId()
      expect(id).toMatch(/^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/)
      expect(id).toHaveLength(4 + 26)
    }
  })

  it('同一时刻只变随机段（时间编码确定）', () => {
    const a = deriveInferenceSessionId(1_700_000_000_000)
    const b = deriveInferenceSessionId(1_700_000_000_000)
    expect(a.slice(4, 16)).toBe(b.slice(4, 16))
    expect(a).not.toBe(b)
  })
})

describe('/inference 头集', () => {
  const fingerprint = { projectId: 'a'.repeat(40), generation: 0 }
  const h = inferenceHeaders(fingerprint, 'ses_123456789ffeABCdefGHIjkl', 'opencode/latest/2.0.29/cli')

  it('四头同值 + 40 位 hex 工程头 + CLI UA', () => {
    for (const key of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'X-Session-Id']) {
      expect(h[key]).toBe('ses_123456789ffeABCdefGHIjkl')
    }
    expect(h['x-opencode-project']).toBe('a'.repeat(40))
    expect(h['x-opencode-client']).toBe('cli')
    expect(h['user-agent']).toBe('opencode/latest/2.0.29/cli')
  })

  it('⚠️ 不带旧版 x-opencode-request（带上会被 /inference 403）', () => {
    expect(h['x-opencode-request']).toBeUndefined()
  })
})

describe('prepareInferencePayload', () => {
  it('强制 stream:true 并补 include_usage', () => {
    const p = prepareInferencePayload({ messages: [], stream: false })
    expect(p.stream).toBe(true)
    expect((p.stream_options as Record<string, unknown>).include_usage).toBe(true)
  })

  it('补齐五个官方核心工具，且 description/parameters 与官方定义逐字节一致', () => {
    const p = prepareInferencePayload({ messages: [] })
    const tools = p.tools as Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
    const names = tools.map((t) => t.function.name)
    for (const name of INFERENCE_CORE_TOOLS) expect(names).toContain(name)
    for (const name of INFERENCE_CORE_TOOLS) {
      const tool = tools.find((t) => t.function.name === name)!
      const genuine = genuineTool(name)!
      expect(tool.function.description).toBe(genuine.description)
      expect(tool.function.parameters).toEqual(genuine.parameters)
      expect(tool.type).toBe('function')
    }
  })

  it('客户端同名的 read 桩会被替换成官方定义（旧 /zen 桩会 403）', () => {
    const p = prepareInferencePayload({
      messages: [],
      tools: [{ type: 'function', function: { name: 'read', description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } } }],
    })
    const read = (p.tools as Array<{ function: { name: string; description: string } }>).find((t) => t.function.name === 'read')!
    expect(read.function.description).toBe(genuineTool('read')!.description)
  })

  it('不认识客户端工具原样保留（闸门只校验它认识的工具名）', () => {
    const extra = { type: 'function', function: { name: 'execute', description: 'x', parameters: {} } }
    const p = prepareInferencePayload({ messages: [], tools: [extra] })
    expect((p.tools as unknown[])).toContainEqual(extra)
  })

  it('非 chat body（无 messages）原样返回同一引用', () => {
    const body = { input: [] }
    expect(prepareInferencePayload(body)).toBe(body)
  })
})

describe('产品常量', () => {
  it('/inference 常量与 /zen 并存', () => {
    expect(OPENCODE.baseUrl).toBe('https://opencode.ai/zen')
    expect(OPENCODE.inferenceBaseUrl).toBe('https://opencode.ai/inference')
    expect(OPENCODE.inferenceChatPath).toBe('/v1/chat/completions')
    expect(OPENCODE.inferenceUserAgent).toBe('opencode/latest/2.0.29/cli')
  })

  it('usesInferenceLane 只认实测表；免费判定包含新表', () => {
    expect(usesInferenceLane('deepseek-v4.1-flash-free')).toBe(true)
    expect(usesInferenceLane('glm-5.2')).toBe(false)
    // 旧 /zen 时代复测未覆盖的免费模型不甩到新通道
    expect(usesInferenceLane('mimo-v2.5-free')).toBe(false)
    expect(isFreeOpencodeModel('deepseek-v4.1-flash-free')).toBe(true)
    expect(isFreeOpencodeModel('glm-5.2')).toBe(false)
  })

  it('合并目录按 id 去重', () => {
    const merged = mergeInferenceModels([{ id: 'big-pickle' }])
    const ids = merged.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('big-pickle')
    expect(ids).toContain('deepseek-v4.1-flash-free')
  })
})

describe('适配器分流', () => {
  it('免费模型走 /inference：public 凭证 + 四会话头 + 无 x-opencode-request + 官方工具集', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return sseOk()
    }))
    const a = new OpencodeAdapter({ identitySlots: async () => [anon()] })
    await run(a, 'deepseek-v4.1-flash-free')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://opencode.ai/inference/v1/chat/completions')
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h['authorization']).toBe('Bearer public')
    expect(h['user-agent']).toBe('opencode/latest/2.0.29/cli')
    expect(h['x-opencode-session-id']).toBe(h['x-opencode-session'])
    expect(h['x-opencode-request']).toBeUndefined()
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      stream: boolean; tools: Array<{ function: { name: string; description: string } }>
    }
    expect(body.stream).toBe(true)
    const shell = body.tools.find((t) => t.function.name === 'shell')!
    expect(shell.function.description).toBe(genuineTool('shell')!.description)
  })

  it('付费模型仍走旧 /zen（x-opencode-request 保留）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return sseOk()
    }))
    const a = new OpencodeAdapter({ identitySlots: async () => [account('a', 'sk-a')] })
    await run(a, 'glm-5.2')

    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/chat/completions')
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h['x-opencode-request']).toBeDefined()
    expect(h['authorization']).toBe('Bearer sk-a')
  })

  it('⚠️ /inference 的 403 FreeTierError 会用新会话重试一次', async () => {
    const sessions: string[] = []
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: unknown) => {
      const h = (init as RequestInit).headers as Record<string, string>
      sessions.push(h['x-opencode-session-id']!)
      attempt++
      return attempt === 1 ? freeTier403() : sseOk()
    }))
    const a = new OpencodeAdapter({ identitySlots: async () => [anon()] })
    const out = await run(a, 'deepseek-v4.1-flash-free')
    expect(out.length).toBeGreaterThan(0)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).not.toBe(sessions[1])
  })

  it('listModels 在只有匿名槽时也包含 /inference 免费模型', async () => {
    const a = new OpencodeAdapter({
      identitySlots: async () => [anon()],
      fetchRemoteCatalog: async () => new Response('{"data":[]}', { status: 200 }),
    })
    const ids = (await a.listModels('opencode')).map((m) => m.id)
    for (const m of OPENCODE_INFERENCE_MODELS) expect(ids).toContain(m.id)
  })
})
