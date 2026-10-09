import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import { rotatingStream } from '../../src/account-rotation.js'
import { registerAdapterIdempotent } from '../../src/llm-register-compat.js'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { LoomyBalanceSelector } from '../../src/loomy-balance-selector.js'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { AutoclawIntegration } from '../../src/autoclaw.js'
import { AutoclawApi } from '../../src/autoclaw-api.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ModelGate } from '../../src/model-gate.js'
import { CODEBUDDY } from '../../src/product.js'
import { LOOMY } from '../../src/loomy-product.js'

let directory: string, previous: string | undefined
beforeEach(() => { previous = process.env.DSH_JET_HUB_STATE_DIR; directory = mkdtempSync(join(tmpdir(), 'jet-rotation-')); process.env.DSH_JET_HUB_STATE_DIR = directory })
afterEach(() => { if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR; else process.env.DSH_JET_HUB_STATE_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
async function fixture(provider = 'autoclaw') {
  const values = new Map<string, string>()
  const pool = new AccountPool({ logger: { warn: vi.fn() }, get: () => undefined,
    credentials: { resolve: async (ref: unknown) => { await Promise.resolve(); const value = values.get(JSON.stringify(ref)); return value === undefined ? undefined : { value } }, unset: async () => {} },
  } as any)
  const add = async (id: string, brand = provider) => {
    values.set(JSON.stringify(credentialRef(id)), JSON.stringify({ access_token: `token-${id}` }))
    await pool.addAccount({ id, provider: brand, credentialRef: id, enabled: true, nickname: id, createdAt: 1 })
  }
  for (const id of ['A', 'B', 'C']) await add(id)
  const call = (brand = provider, model = 'model') => rotatingStream(brand, model, async function* () {
    yield (await pool.getAvailableAccount(brand, model))?.entry.id
  })
  return { pool, values, add, call }
}
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of stream) result.push(item); return result }

describe('Jet Hub 账号耗尽接续', () => {
  it('目录读取不选号，正常请求保持A；不同模型独立', async () => {
    const f = await fixture()
    expect((await f.pool.getAvailableAccount('autoclaw', ''))?.entry.id).toBe('A')
    expect(await collect(f.call())).toEqual(['A'])
    expect((await f.pool.getAvailableAccount('autoclaw', ''))?.entry.id).toBe('A')
    expect(await collect(f.call('autoclaw', 'another-model'))).toEqual(['A'])
    expect(await collect(f.call())).toEqual(['A'])
    expect(await collect(f.call())).toEqual(['A'])
  })
  it('并发请求保持当前账号，网络请求可以同时运行', async () => {
    const f = await fixture()
    const result = await Promise.all(Array.from({ length: 9 }, () => collect(f.call())))
    expect(result.flat()).toEqual(Array(9).fill('A'))
  })
  it('停用、目标模型限流、损坏凭据跳过；恢复后重新入环', async () => {
    const f = await fixture()
    await f.pool.updateAccount('A', { enabled: false })
    await f.pool.updateModelRateLimit('B', 'model', Date.now() + 60000)
    expect(await collect(f.call())).toEqual(['C'])
    await f.pool.updateAccount('A', { enabled: true })
    f.values.set(JSON.stringify(credentialRef('A')), 'broken-json')
    expect(await collect(f.call())).toEqual(['C'])
    f.values.set(JSON.stringify(credentialRef('A')), '{}')
    expect(await collect(f.call())).toEqual(['C'])
    expect(await collect(f.call('autoclaw', 'other'))).toEqual(['A'])
  })
  it('同请求续期保持账号，限流排除后换下一位，下一请求接着走', async () => {
    const { pool, call } = await fixture()
    expect(await collect(rotatingStream('autoclaw', 'model', async function* () {
      yield (await pool.getAvailableAccount('autoclaw', ''))?.entry.id
      await Promise.resolve()
      yield (await pool.getAvailableAccount('autoclaw', ''))?.entry.id
      yield (await pool.getAvailableAccount('autoclaw', 'model', new Set(['A'])))?.entry.id
    }))).toEqual(['A', 'A', 'B'])
    expect(await collect(call())).toEqual(['B'])
  })
  it('失败换号也不能绕过余额资格；失败的选择不会堵住后续请求', async () => {
    const f = await fixture('buddy')
    f.pool.setRequestEligibility('buddy', async entry => entry.id !== 'B')
    expect(await collect(rotatingStream('buddy', 'model', async function* () {
      yield (await f.pool.getAvailableAccount('buddy', 'model'))?.entry.id
      yield (await f.pool.getAvailableAccount('buddy', 'model', new Set(['A'])))?.entry.id
    }))).toEqual(['A', 'C'])
    f.pool.setRequestEligibility('buddy', async () => { throw Error('balance failed') })
    await expect(collect(f.call())).rejects.toThrow('balance failed')
    f.pool.setRequestEligibility('buddy', async () => true)
    expect(await collect(f.call())).toEqual(['C'])
  })
  it('真实 AutoClaw 适配器的请求头随账号轮换，浏览目录保持顺位', async () => {
    const f = await fixture()
    for (const id of ['A', 'B', 'C']) f.values.set(JSON.stringify(credentialRef(id)), JSON.stringify({ access_token: `token-${id}`, refresh_token: `refresh-${id}`, user_id: id, device_id: `device-${id}`, nickname: id }))
    const seen: string[] = []
    const fetcher = async (url: any, init: any) => {
      if (String(url).includes('autoclaw-model-config')) return new Response(JSON.stringify({ models: [{ id: 'model', name: 'fixture', api: 'openai-completions', input: ['text'] }] }))
      seen.push(new Headers(init.headers).get('X-Authorization')!)
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const ctx = { logger: { warn: vi.fn() }, credentials: { resolve: async (ref: any) => ({ value: f.values.get(JSON.stringify(ref)) }) } } as any
    const integration = new AutoclawIntegration(ctx, f.pool, new AutoclawApi(fetcher as any))
    let registered: any
    registerAdapterIdempotent({ registerAdapter: (_p, a) => { registered = a }, registerConfigurableProviders: () => {} }, ['autoclaw'], integration.adapter)
    const prepared = await registered.prepareCall('autoclaw', 'model')
    for (let i = 0; i < 4; i++) {
      await integration.adapter.listModels('autoclaw')
      await collect(prepared.stream({ model: 'model', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] } as any))
    }
    expect(seen).toEqual(Array(4).fill('Bearer token-A'))
  })
  it('真实 ZCode 请求轮换独立凭据，额度错误只标记本次账号再换号', async () => {
    const f = await fixture('zcode')
    for (const id of ['A', 'B', 'C']) f.values.set(JSON.stringify(credentialRef(id)), JSON.stringify({ zcode_jwt: `jwt-${id}`, device_mid: `mid-${id}` }))
    const seen: string[] = []
    let active: string | undefined, limitB = false
    const adapter = new ZcodeAdapter({ credentialRef: credentialRef('legacy'), accountPool: f.pool,
      resolveCredential: async model => { const selected = await f.pool.getAvailableAccount('zcode', model ?? ''); active = selected?.entry.id; return selected?.credential as any },
      currentAccountId: () => f.pool.requestAccount('zcode')?.id ?? active,
      refresh: async () => {}, mintCaptcha: async () => 'fixture-param', gate: new ModelGate({ sleep: async () => {} }),
      fetchImpl: (async (_url: any, init: any) => {
        const token = new Headers(init.headers).get('authorization')!; seen.push(token)
        if (limitB && token !== 'Bearer jwt-C') return new Response('{"code":1005,"msg":"exceed quota limit"}', { status: 429 })
        return new Response([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant"}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          'event: message_stop\ndata: {"type":"message_stop"}', '',
        ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } })
      }) as any,
    })
    let registered: any
    registerAdapterIdempotent({ registerAdapter: (_p, a) => { registered = a }, registerConfigurableProviders: () => {} }, ['zcode'], adapter)
    const prepared = await registered.prepareCall('zcode', 'GLM-5.3-Flash')
    const request = { model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] } as any
    for (let i = 0; i < 4; i++) await collect(prepared.stream(request))
    expect(seen).toEqual(Array(4).fill('Bearer jwt-A'))
    limitB = true
    await collect(prepared.stream(request))
    expect(seen.slice(4)).toEqual(['Bearer jwt-A', 'Bearer jwt-B', 'Bearer jwt-C'])
    expect(f.pool.findAccount('B')?.modelRateLimits?.[request.model]).toBeGreaterThan(Date.now())
    expect(f.pool.findAccount('A')?.modelRateLimits?.[request.model]).toBeGreaterThan(Date.now())
    expect(f.pool.findAccount('C')?.modelRateLimits?.[request.model]).toBeUndefined()
    await collect(prepared.stream(request)); expect(seen.at(-1)).toBe('Bearer jwt-C')
  })
  it('厂牌隔离，删除与重新排列仍沿真实列表循环', async () => {
    const f = await fixture(); await f.add('X', 'qoder'); await f.add('Y', 'qoder')
    expect(await collect(f.call('qoder'))).toEqual(['X'])
    expect(await collect(f.call())).toEqual(['A'])
    expect(await collect(f.call('qoder'))).toEqual(['X'])
    await f.pool.removeAccount('A')
    expect(await collect(f.call())).toEqual(['B'])
    await f.pool.reorderAccounts('autoclaw', ['C', 'B'])
    expect(await collect(f.call())).toEqual(['B'])
  })
  it('取消清理保留本次上下文，随后错误和新请求均可恢复', async () => {
    const f = await fixture(); const cleanup: unknown[] = []
    const stream = rotatingStream('autoclaw', 'model', async function* () {
      try { yield (await f.pool.getAvailableAccount('autoclaw', 'model'))?.entry.id }
      finally { cleanup.push((await f.pool.getAvailableAccount('autoclaw', 'model'))?.entry.id) }
    })
    for await (const _ of stream) break
    expect(cleanup).toEqual(['A'])
    await expect(collect(rotatingStream('autoclaw', 'model', async function* () {
      await f.pool.getAvailableAccount('autoclaw', 'model'); throw Error('request failed'); yield ''
    }))).rejects.toThrow('request failed')
    expect(await collect(f.call())).toEqual(['A'])
    expect((await f.pool.getAvailableAccount('autoclaw', ''))?.entry.id).toBe('A')
  })
  it('真实注册包装覆盖 prepareCall 返回的请求，并保留 SDK 原生工具历史', async () => {
    const f = await fixture('qoder'); const histories: any[] = []
    const adapter = { async *stream(options: any) { histories.push(options.messages); yield (await f.pool.getAvailableAccount('qoder', options.model))?.entry.id },
      async prepareCall() { return { stream: (options: any) => this.stream(options) } } }
    let registered: any
    registerAdapterIdempotent({ registerAdapter: (_p, a) => { registered = a }, registerConfigurableProviders: () => {} }, ['qoder'], adapter)
    const prepared = await registered.prepareCall()
    const options = { model: 'model', messages: [{ role: 'tool', toolCallId: 'tool-1', content: [], isError: false }] }
    expect(await collect(prepared.stream(options))).toEqual(['A'])
    expect(await collect(prepared.stream(options))).toEqual(['A'])
    expect(histories[0][0].role).toBe('tool')
    expect(histories[0][0].toolCallId).toBe('tool-1')
    expect(options.messages[0].role).toBe('tool')
  })
  it('同供应商嵌套 stream 不推进第二次顺位，错误后下一请求能恢复', async () => {
    const f = await fixture()
    const nested = () => rotatingStream('autoclaw', 'model', () => f.call())
    expect(await collect(nested())).toEqual(['A'])
    expect(await collect(nested())).toEqual(['A'])
    await expect(collect(rotatingStream('autoclaw', 'model', async function* () {
      yield* f.call()
      throw Error('nested failed')
    }))).rejects.toThrow('nested failed')
    expect(await collect(nested())).toEqual(['A'])
  })
  it('余额不同也依列表顺序轮换，永久积分锁定仍排除受保护账号', async () => {
    const candidates = [{ id: 'permanent', credentialRef: 'permanent' }, { id: 'daily', credentialRef: 'daily' }]
    const loomy = new LoomyBalanceSelector({ product: LOOMY, resolveCredential: async () => ({ token: 'fixture' } as any) })
    vi.spyOn(loomy, 'balanceOf').mockImplementation(async a => ({ id: a.id, ok: true, dailyBalance: a.id === 'daily' ? 10 : 0, permanentBalance: 20 }))
    const selected = await loomy.select(candidates, { preferOrder: true })
    expect(selected.ok && selected.account.id).toBe('permanent')
    const locked = await loomy.select(candidates, { preferOrder: true, allowPermanent: false })
    expect(locked.ok && locked.account.id).toBe('daily')
    const buddy = new BuddyBalanceSelector({ product: CODEBUDDY, resolveCredential: async () => ({} as any) })
    vi.spyOn(buddy, 'balanceOf').mockImplementation(async a => ({ id: a.id, ok: true, expiringBalance: a.id === 'daily' ? 10 : 0, permanentBalance: 20 }))
    const picked = await buddy.select(candidates, { preferOrder: true, allowPermanent: false })
    expect(picked.ok && picked.account.id).toBe('daily')
  })
  it('OpenCode 免费请求轮换全部槽，收费请求仍排除匿名槽', async () => {
    const slots = [{ id: 'A', kind: 'account' }, { id: 'B', kind: 'account' }, { id: 'anonymous', kind: 'anonymous' }]
    class LocalAdapter extends OpencodeAdapter { protected async *streamVia(slot: any, _options: any): AsyncIterable<any> { yield slot.id } }
    const adapter = new LocalAdapter({ identitySlots: async () => slots } as any)
    expect(await collect(adapter.stream({ model: 'big-pickle' } as any))).toEqual(['A'])
    expect(await collect(adapter.stream({ model: 'big-pickle' } as any))).toEqual(['A'])
    expect(await collect(adapter.stream({ model: 'big-pickle' } as any))).toEqual(['A'])
    expect(await collect(adapter.stream({ model: 'paid-model' } as any))).toEqual(['A'])
  })
})
