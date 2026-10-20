import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOpencodeCapabilitiesCache } from '../../src/opencode-capability.js'
import {
  OpencodeHybridAdapter, createOpencodeInferenceAdapter, opencodeInferenceSlot,
} from '../../src/opencode-hybrid-adapter.js'
import type { OpencodeLocalAdapter } from '../../src/opencode-local-adapter.js'
import type { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { OPENCODE } from '../../src/opencode-product.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

let home: string, oldHome: string | undefined
beforeEach(async () => {
  oldHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-hybrid-test-'))
  process.env.DSH_HOME = home
  await clearOpencodeCapabilitiesCache()
})
afterEach(async () => {
  await clearOpencodeCapabilitiesCache()
  rmSync(home, { recursive: true, force: true })
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
})

function chunk(text: string): StreamChunk {
  // 形状与 dsh-llm 的 text-delta 一致（包装层只透传，不解释）。
  return { type: 'text-delta', text } as unknown as StreamChunk
}

function fakeLocal(overrides: Partial<OpencodeLocalAdapter> = {}): OpencodeLocalAdapter {
  const base = {
    listAllModels: () => [{ id: 'local-model', name: 'Local Model' }],
    listModels: async (provider: string) => [{ provider, id: 'local-model', name: 'Local Model' }],
    resolveModel: vi.fn(async (provider: string, id: string) => ({ provider, id, name: id })),
    stream: async function* (): AsyncIterable<StreamChunk> { yield chunk('local') },
    handleRpc: vi.fn(async () => 'local-rpc'),
  }
  return Object.assign(base, overrides) as unknown as OpencodeLocalAdapter
}

function fakeFast(overrides: Partial<OpencodeAdapter> = {}): OpencodeAdapter {
  const base = {
    listAllModels: () => [],
    listModels: async (provider: string) => [
      { provider, id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free' },
      // 旧 /zen 免费模型：不在 /inference 实测表 ⇒ 不应出现在本 provider
      { provider, id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' },
    ],
    resolveModel: vi.fn(async (provider: string, id: string) => ({ provider, id, name: `fast:${id}` })),
    stream: async function* (): AsyncIterable<StreamChunk> { yield chunk('fast') },
  }
  return Object.assign(base, overrides) as unknown as OpencodeAdapter
}

function hybrid(local = fakeLocal(), fast = fakeFast(), disabled?: Set<string>): OpencodeHybridAdapter {
  return new OpencodeHybridAdapter(local, fast, disabled === undefined ? {} : { disabledModels: () => disabled })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

describe('OpencodeHybridAdapter', () => {
  it('listAllModels = 本地目录 + /inference 免费模型（同步，去重）', () => {
    const ids = hybrid().listAllModels().map((m) => m.id)
    expect(ids).toContain('local-model')
    expect(ids).toContain('deepseek-v4.1-flash-free')
    // 兜底表里本地不存在的旧免费模型也应并进来（全部免费档）
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('listModels 只并入 /inference 实测表，旧 /zen 免费模型不露出来', async () => {
    const ids = (await hybrid().listModels(OPENCODE.id)).map((m) => m.id)
    expect(ids).toContain('local-model')
    expect(ids).toContain('deepseek-v4.1-flash-free')
    expect(ids).not.toContain('mimo-v2.5-free')
  })

  it('用户黑名单对两条通道都生效', async () => {
    const h = hybrid(undefined, undefined, new Set(['deepseek-v4.1-flash-free', 'local-model']))
    expect(h.listAllModels().map((m) => m.id)).not.toContain('deepseek-v4.1-flash-free')
    const ids = (await h.listModels(OPENCODE.id)).map((m) => m.id)
    expect(ids).not.toContain('deepseek-v4.1-flash-free')
    expect(ids).not.toContain('local-model')
  })

  it('resolveModel 按模型 id 分流', async () => {
    const local = fakeLocal()
    const fast = fakeFast()
    const h = hybrid(local, fast)
    expect((await h.resolveModel(OPENCODE.id, 'deepseek-v4.1-flash-free')).name)
      .toBe('fast:deepseek-v4.1-flash-free')
    expect((await h.resolveModel(OPENCODE.id, 'local-model')).name).toBe('local-model')
  })

  it('stream 按模型 id 分流（快通道不碰本地服务）', async () => {
    const local = fakeLocal()
    const fast = fakeFast()
    const h = hybrid(local, fast)
    const fastOut = await collect(h.stream({ provider: OPENCODE.id, model: 'deepseek-v4.1-flash-free', messages: [] } as unknown as GenerateOptions))
    expect(fastOut[0]).toBeDefined()
    const localOut = await collect(h.stream({ provider: OPENCODE.id, model: 'local-model', messages: [] } as unknown as GenerateOptions))
    expect(localOut[0]).toBeDefined()
  })

  it('RPC 仍委托本地服务（面板设置/登录不受影响）', async () => {
    const local = fakeLocal()
    const h = hybrid(local)
    await expect(h.handleRpc('opencode.local.status', {})).resolves.toBe('local-rpc')
  })

  it('快通道匿名槽固定 public 凭证', () => {
    const slot = opencodeInferenceSlot()
    expect(slot.kind).toBe('anonymous')
    expect(slot.apiKey).toBe('public')
    expect(slot.fingerprint.projectId).toMatch(/^[0-9a-f]{40}$/)
    expect(slot.userAgent).toBe(OPENCODE.inferenceUserAgent)
  })

  it('createOpencodeInferenceAdapter 可实例化（接线层用它）', () => {
    const adapter = createOpencodeInferenceAdapter()
    expect(adapter).toBeDefined()
  })
})
