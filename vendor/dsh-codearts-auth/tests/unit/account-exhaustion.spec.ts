import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AccountPool } from '../../src/account-pool.js'
import { rotatingStream } from '../../src/account-rotation.js'
import { wrapAdapterWithRotation } from '../../src/llm-register-compat.js'
import { AutoclawIntegration } from '../../src/autoclaw.js'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { AutoclawApi } from '../../src/autoclaw-api.js'
let dir: string, old: string | undefined
beforeEach(() => { old = process.env.DSH_JET_HUB_STATE_DIR; dir = mkdtempSync(join(tmpdir(), 'exhaustion-')); process.env.DSH_JET_HUB_STATE_DIR = dir })
afterEach(() => { if (old === undefined) delete process.env.DSH_JET_HUB_STATE_DIR; else process.env.DSH_JET_HUB_STATE_DIR = old; rmSync(dir, { recursive: true, force: true }) })
async function fixture(provider = 'autoclaw', count = 3) {
  const values = new Map<string, string>()
  const ctx = { get: () => undefined, logger: { warn: vi.fn(), info: vi.fn() }, credentials: { resolve: async (ref: unknown) => ({ value: values.get(JSON.stringify(ref)) }), unset: async () => {} } } as any
  const pool = new AccountPool(ctx)
  for (const id of ['A', 'B', 'C', 'D', 'E'].slice(0, count)) {
    values.set(JSON.stringify(credentialRef(id)), JSON.stringify({ access_token: `token-${id}`, refresh_token: 'fixture', user_id: id, device_id: 'fixture' }))
    await pool.addAccount({ id, provider, credentialRef: id, enabled: true, nickname: id, refreshable: true, createdAt: 1 })
  }
  return { pool, ctx }
}
async function collect(stream: AsyncIterable<any>) { const chunks = []; for await (const c of stream) chunks.push(c); return chunks }
describe('账号额度用完再换', () => {
  it('同模型保持当前账号，各模型独立；目录不改变选号', async () => {
    const { pool } = await fixture()
    const run = (model = 'm') => collect(rotatingStream('autoclaw', model, async function* () { yield (await pool.getAvailableAccount('autoclaw', model))?.entry.id }))
    expect(await run()).toEqual(['A']); expect(await run()).toEqual(['A'])
    await pool.updateModelRateLimit('A', 'm', Date.now() + 60000)
    expect(await run()).toEqual(['B']); expect(await run()).toEqual(['B'])
    expect(await run('other')).toEqual(['A'])
  })
  it('所有启用账号依次顶上，超过3个账号也能到最后一个', async () => {
    const { pool } = await fixture('qoder', 5); const seen: string[] = []
    const chunks = await collect(rotatingStream('qoder', 'm', async function* () {
      const id = (await pool.getAvailableAccount('qoder', 'm'))!.entry.id; seen.push(id)
      yield { type: 'message-start' }
      if (id !== 'E') throw new LlmError('quota exhausted', 'QUOTA_EXCEEDED')
      yield { type: 'text-delta', text: 'ok' }
    }))
    expect(seen).toEqual(['A', 'B', 'C', 'D', 'E']); expect(chunks).toEqual([{ type: 'message-start' }, { type: 'text-delta', text: 'ok' }])
    expect((await pool.getAvailableAccount('qoder', 'm'))?.entry.id).toBe('E')
  })
  it('输出已开始后不重放；普通网络错误、共享模型饱和不换号', async () => {
    const { pool } = await fixture(); const seen: string[] = []
    const run = (output: boolean, error: Error) => collect(rotatingStream('autoclaw', 'm', async function* () {
      seen.push((await pool.getAvailableAccount('autoclaw', 'm'))!.entry.id)
      if (output) yield { type: 'text-delta', text: 'prefix' }
      throw error
    }))
    await expect(run(true, new LlmError('quota exhausted', 'QUOTA_EXCEEDED'))).rejects.toThrow()
    await expect(run(false, Error('network failed'))).rejects.toThrow()
    await expect(run(false, new LlmError('model saturated 14003', 'RATE_LIMITED'))).rejects.toThrow()
    expect(seen).toEqual(['A', 'A', 'A'])
  })
  it('finish error在输出前可切号；禁用账号不会被选择', async () => {
    const { pool } = await fixture(); await pool.updateAccount('B', { enabled: false }); const seen: string[] = []
    const chunks = await collect(rotatingStream('autoclaw', 'm', async function* () {
      const id = (await pool.getAvailableAccount('autoclaw', 'm'))!.entry.id; seen.push(id)
      yield id === 'A' ? { type: 'finish', reason: { kind: 'error', error: new LlmError('quota exhausted', 'QUOTA_EXCEEDED') } } : { type: 'text-delta', text: 'ok' }
    }))
    expect(seen).toEqual(['A', 'C']); expect(chunks).toEqual([{ type: 'text-delta', text: 'ok' }])
  })
  it('全部账号耗尽只各试一次，返回原额度错误', async () => {
    const { pool } = await fixture(); const seen: string[] = []
    await expect(collect(rotatingStream('autoclaw', 'm', async function* () {
      seen.push((await pool.getAvailableAccount('autoclaw', 'm'))!.entry.id)
      throw new LlmError('all quota exhausted', 'QUOTA_EXCEEDED'); yield ''
    }))).rejects.toThrow('all quota exhausted')
    expect(seen).toEqual(['A', 'B', 'C'])
  })
  it('实际AutoClaw prepareCall HTTP402/429依次A B C成功，续用C', async () => {
    const { pool, ctx } = await fixture(); const seen: string[] = []
    const fetcher = vi.fn(async (url: any, init: any) => {
      if (String(url).includes('autoclaw-model-config')) return new Response(JSON.stringify({ models: [{ id: 'm', input: ['text'] }] }))
      const id = new Headers(init.headers).get('X-Authorization')!.slice(-1); seen.push(id)
      if (id !== 'C') return new Response('{"error":{"code":"QUOTA_EXCEEDED","message":"quota exhausted"}}', { status: id === 'A' ? 402 : 429 })
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }) as any
    const adapter = wrapAdapterWithRotation(['autoclaw'], new AutoclawIntegration(ctx, pool, new AutoclawApi(fetcher)).adapter)
    const call = await adapter.prepareCall('autoclaw', 'm'); const opts = { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] } as any
    expect((await collect(call.stream(opts))).some(c => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    await collect(call.stream(opts)); expect(seen).toEqual(['A', 'B', 'C', 'C'])
  })
  it('ZCode旧来源的在途失败不会冷却刚选的新来源', async () => {
    const { pool } = await fixture('zcode'); await pool.updateAccount('A', { zcodeSource: 'start-plan' })
    await collect(rotatingStream('zcode', 'm', async function* () {
      await pool.getAvailableAccount('zcode', 'm'); pool.setRequestSource('zcode', 'A', 'start-plan')
      await pool.updateAccount('A', { zcodeSource: 'individual' }); await pool.updateModelRateLimit('A', 'm', Date.now() + 60000); yield ''
    }))
    expect(pool.findAccount('A')!.modelRateLimits!['m · start-plan']).toBeGreaterThan(Date.now())
    expect(await collect(rotatingStream('zcode', 'm', async function* () { yield (await pool.getAvailableAccount('zcode', 'm'))?.entry.id }))).toEqual(['A'])
  })
  it('OpenCode业务额度错误也换账号，成功后续用当前槽；元数据不算正文', async () => {
    const seen: string[] = [], marks: string[] = []
    class Local extends OpencodeAdapter {
      protected async *streamVia(slot: any, _options: any): AsyncIterable<any> {
        seen.push(slot.id);yield {type:'usage',usage:{inputTokens:1,outputTokens:0,totalTokens:1}}
        if(slot.id==='A') throw new LlmError('quota exhausted','QUOTA_EXCEEDED')
        yield {type:'text-delta',index:0,text:'ok'}
      }
    }
    const adapter = new Local({identitySlots:async()=>[{id:'A',kind:'account'},{id:'B',kind:'account'}] as any,markLimited:async id=>{marks.push(id)}})
    const chunks = await collect(adapter.stream({model:'paid-model'} as any));await collect(adapter.stream({model:'paid-model'} as any))
    expect(seen).toEqual(['A','B','B']);expect(marks).toEqual(['A']);expect(chunks.filter(c=>c.type==='usage')).toHaveLength(1)
  })

})
