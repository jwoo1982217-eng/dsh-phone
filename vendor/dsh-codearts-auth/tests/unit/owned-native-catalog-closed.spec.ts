import { expect, it, vi } from 'vitest'
import { OpencodeLocalAdapter } from '../../src/opencode-local-adapter.js'
import { OrcaTermAdapter } from '../../src/orcaterm-adapter.js'
it('原生 OpenCode 关闭时不预热服务，完整目录仍能管理；重新开启保留图片与容量', async () => {
  let closed = true
  const model = { id: 'fixture', name: 'fixture', inputModalities: ['text', 'image'], contextWindow: 1_000_000, variants: [] }
  const service = { warm: vi.fn(), cachedModels: () => [model], catalog: vi.fn(async () => [model]) }
  const adapter = new OpencodeLocalAdapter(service as never, { providerClosed: () => closed })
  expect(await adapter.listModels('opencode')).toEqual([]); expect(service.warm).not.toHaveBeenCalled()
  expect(adapter.listAllModels()).toHaveLength(1)
  closed = false
  expect((await adapter.listModels('opencode'))[0]?.inputModalities).toEqual(['text', 'image'])
  expect((await adapter.resolveModel('opencode', 'fixture')).context?.contextWindow).toBe(1_000_000)
  closed = true; expect(await adapter.listModels('opencode')).toEqual([])
})
it('自家 OrcaTerm 遵守同一关闭意图，不丢失完整目录或擅自登录', async () => {
  let closed = true
  const resolveCredential = vi.fn(async () => undefined)
  const adapter = new OrcaTermAdapter({ resolveCredential, providerClosed: () => closed })
  expect(await adapter.listModels('orcaterm')).toEqual([]);expect(adapter.listAllModels().length).toBeGreaterThan(0)
  closed = false;expect((await adapter.listModels('orcaterm')).length).toBeGreaterThan(0)
  expect(resolveCredential).not.toHaveBeenCalled()
})
