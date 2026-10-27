import { describe, expect, it } from 'vitest'
import { AggregateAdapter } from '../../src/aggregate-adapter.js'
import { LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

function fixture() {
  let now = 100_000
  const metadata: Record<string, { context?: { contextWindow: number }; defaultMaxTokens?: number }> = {
    buddy: { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 65_536 },
    workbuddy: { context: { contextWindow: 131_072 }, defaultMaxTokens: 8_192 },
    codearts: { context: { contextWindow: 262_144 }, defaultMaxTokens: 32_768 },
  }
  const expiry: Record<string, number> = { buddy: 10, workbuddy: 20, codearts: 30 }
  const calls: string[] = [], resolves: string[] = []
  let rejected: Record<string, Record<string, Record<string, boolean>>> = {}
  let failover = false, overflow = true
  const ctx = {
    logger: { warn() {} },
    llm: {
      listProviders: () => Object.keys(metadata).map(id => ({ id, name: id })),
      listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
      resolveModelInfo: async (provider: string, id: string) => {
        resolves.push(provider)
        return { provider, id, name: id, ...metadata[provider] }
      },
      stream: (options: GenerateOptions) => (async function* (): AsyncIterable<StreamChunk> {
        calls.push(options.provider)
        if (failover && options.provider === 'buddy') throw new LlmError('额度用完', 'QUOTA_EXCEEDED')
        if (failover && overflow && options.provider === 'workbuddy') throw new LlmError('上游上下文超限', CONTEXT_WINDOW_EXCEEDED_CODE)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '测试完成' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '测试完成' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
  }
  const adapter = new AggregateAdapter(ctx as never, {
    contextWindowPolicy: 'preferred',
    accountPool: { disabledModelsFor: () => new Set() } as never,
    now: () => now, expiryProbe: async provider => expiry[provider]!, rejections: () => rejected,
  })
  return { adapter, metadata, expiry, calls, resolves,
    advance() { now += 60_001 }, rejectBuddy() { rejected = { 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } } },
    failover() { failover = true }, recovered() { overflow = false } }
}
const request: GenerateOptions = { provider: 'aggregate', model: 'deepseek-v4-1-flash', messages: [] }
async function drain(stream: AsyncIterable<StreamChunk>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

describe('聚合上下文容量跟随实际候选元数据', () => {
  it('按首选渠道读取容量，与 prepareCall 共用能力查询，原输出预算保持', async () => {
    const f = fixture(); await f.adapter.refreshCatalog()
    const info = await f.adapter.resolveModel('aggregate', request.model)
    expect(info.context?.contextWindow).toBe(1_000_000)
    expect(info.defaultMaxTokens).toBeUndefined()
    const call = await f.adapter.prepareCall('aggregate', request.model)
    expect(call.model.context).toEqual(info.context)
    expect(f.resolves).toEqual(['buddy', 'workbuddy', 'codearts'])
    await drain(call.stream(request)); expect(f.calls).toEqual(['buddy'])
  })
  it('auto 也使用选中的上游容量', async () => {
    const f = fixture(); await f.adapter.refreshCatalog()
    expect((await f.adapter.resolveModel('aggregate', 'auto')).context?.contextWindow).toBe(1_000_000)
  })
  it('选型缓存到期后重新识别首选渠道及其变化后的容量', async () => {
    const f = fixture(); await f.adapter.refreshCatalog()
    await f.adapter.resolveModel('aggregate', request.model)
    f.expiry.workbuddy = 1; f.metadata.workbuddy!.context!.contextWindow = 524_288; f.advance()
    const call = await f.adapter.prepareCall('aggregate', request.model)
    expect(call.model.context?.contextWindow).toBe(524_288)
    expect(call.model.defaultMaxTokens).toBeUndefined()
    await drain(call.stream(request)); expect(f.calls).toEqual(['workbuddy'])
  })
  it('关闭某候选后，容量随新的首选渠道立即变化', async () => {
    const f = fixture(); await f.adapter.refreshCatalog()
    await f.adapter.resolveModel('aggregate', request.model); f.rejectBuddy()
    expect((await f.adapter.resolveModel('aggregate', request.model)).context?.contextWindow).toBe(131_072)
  })
  it('首选渠道未上报容量时保留兼容预算，不能借用别的渠道容量', async () => {
    const f = fixture(); await f.adapter.refreshCatalog(); delete f.metadata.buddy!.context
    expect((await f.adapter.resolveModel('aggregate', request.model)).context?.contextWindow).toBe(200_000)
  })
  it.each([0, -1, NaN, 1.5])('不采用非法上下文元数据 %s', async value => {
    const f = fixture(); await f.adapter.refreshCatalog(); f.metadata.buddy!.context!.contextWindow = value
    expect((await f.adapter.resolveModel('aggregate', request.model)).context?.contextWindow).toBe(200_000)
  })
  it('备用渠道超限后交给压缩，短期容量按该渠道收敛，恢复后仍能完成请求', async () => {
    const f = fixture(); await f.adapter.refreshCatalog(); f.failover()
    const call = await f.adapter.prepareCall('aggregate', request.model)
    await expect(drain(call.stream(request))).rejects.toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
    expect(f.calls).toEqual(['buddy', 'workbuddy'])
    const recovered = await f.adapter.resolveModel('aggregate', request.model)
    expect(recovered.context?.contextWindow).toBe(131_072)
    expect(recovered.defaultMaxTokens).toBeUndefined()
    f.recovered(); await drain((await f.adapter.prepareCall('aggregate', request.model)).stream(request))
    expect(f.calls.slice(-2)).toEqual(['buddy', 'workbuddy'])
    f.advance()
    expect((await f.adapter.resolveModel('aggregate', request.model)).context?.contextWindow).toBe(1_000_000)
  })
  it('清缓存也清超限恢复预算，不影响原候选优先级', async () => {
    const f = fixture(); await f.adapter.refreshCatalog(); f.failover()
    await expect(drain((await f.adapter.prepareCall('aggregate', request.model)).stream(request))).rejects.toBeDefined()
    f.adapter.clearChoiceCache()
    expect((await f.adapter.resolveModel('aggregate', request.model)).context?.contextWindow).toBe(1_000_000)
  })
})
