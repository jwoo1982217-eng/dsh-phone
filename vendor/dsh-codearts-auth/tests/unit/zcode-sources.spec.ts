import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import { ZcodeSources } from '../../src/zcode-sources.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ModelGate } from '../../src/model-gate.js'
import { wrapAdapterWithRotation } from '../../src/llm-register-compat.js'
import { buildChannelRequest, resolveChannelFor } from '../../src/zcode-transport.js'
let dir: string, old: string | undefined
beforeEach(() => { old = process.env.DSH_JET_HUB_STATE_DIR; dir = mkdtempSync(join(tmpdir(), 'zcode-sources-')); process.env.DSH_JET_HUB_STATE_DIR = dir })
afterEach(() => { if (old === undefined) delete process.env.DSH_JET_HUB_STATE_DIR; else process.env.DSH_JET_HUB_STATE_DIR = old; rmSync(dir, { recursive: true, force: true }) })
async function fixture() {
  const credential = { zcode_jwt: 'fake-jwt', device_mid: 'fixture', bigmodel_access_token: 'fake-oauth' }
  const values = new Map([[JSON.stringify(credentialRef('A')), JSON.stringify(credential)]])
  const ctx = { get: () => undefined, logger: { warn: vi.fn() }, credentials: { resolve: async (ref: any) => ({ value: values.get(JSON.stringify(ref)) }), unset: async () => {} } } as any
  const pool = new AccountPool(ctx); await pool.addAccount({ id: 'A', provider: 'zcode', credentialRef: 'A', nickname: 'fixture', enabled: true, refreshable: false, createdAt: 1 })
  let fail = false, teamUnassigned = false, numericUnit = false
  const requests: { url: string; method: string; headers: Headers }[] = []
  const fetcher = vi.fn(async (url: any, init: any) => {
    const pathname = new URL(url).pathname; requests.push({ url: String(url), method: init.method, headers: new Headers(init.headers) })
    const json = (data: any) => new Response(JSON.stringify({ code: 0, data }))
    if (fail) return new Response('', { status: 503 })
    if (pathname.endsWith('getCustomerInfo')) return json({ organizations: [{ organizationId: 'org', organizationName: '默认机构', projects: [{ projectId: 'proj', projectName: '默认项目', projectType: 1 }, { projectId: 'team', projectName: '团队', projectType: 2 }] }] })
    if (pathname.endsWith('api_keys')) return json(pathname.includes('/team/') ? [{ name: 'zcode-team-api-key', keyType: 2, apiKey: 'team-key' }] : [{ name: 'zcode-api-key', keyType: 1, apiKey: 'personal-key' }])
    if (pathname.includes('/copy/')) return json({ secretKey: 'secret-fixture' })
    if (pathname.endsWith('querySubscribeDetail')) return json({ hasSubscription: true, status: 'EFFECTIVE', memberGrantStatus: teamUnassigned ? 'UNASSIGNED' : 'VALID' })
    if (pathname.endsWith('quota/limit') && numericUnit) { const team = new URL(url).searchParams.get('type') === '2'; return json({limits:[{type:'CREDIT_LIMIT',unit:3,number:5,remaining:team ? 14998 : 2000},{type:'CREDIT_LIMIT',unit:6,number:1,remaining:team ? 63931 : 8262}]}) }
    if (pathname.endsWith('quota/limit')) return json({ limits: [{ type: 'TIME_LIMIT', remaining: 20, unit: '积分' }, { type: 'WEEKLY_LIMIT', percentage: 30 }] })
    if (pathname.endsWith('/balance')) return json({ balances: [{ show_name: 'GLM', remaining_units: 123, unit_type: 'token' }] })
    return json({ plans: [] })
  }) as any
  const service = new ZcodeSources(ctx, pool, fetcher)
  return { pool, ctx, credential, service, requests, numeric: () => { numericUnit = true }, fail: () => { fail = true }, unassigned: () => { teamUnassigned = true } }
}
describe('ZCode独立额度来源', () => {
  it('赠送、个人、默认机构流量与机构套餐分别展示，不泄露密钥，只GET已有key', async () => {
    const f = await fixture(); const result = await f.service.list('A')
    expect(result.sources.map(s => s.kind)).toEqual(['start-plan', 'individual', 'organization-flow', 'team'])
    expect(result.sources.every(s => s.available)).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/fake-oauth|fake-jwt|personal-key|secret-fixture|team-key/)
    expect(f.requests.every(r => r.method === 'GET')).toBe(true)
    expect(result.sources[1].quota).toContain('剩余 20积分')
  })
  it('选择个人套餐必须走BigModel国内端点与个人key，失败不回赠送', async () => {
    const f = await fixture(); await f.service.select('A', 'individual')
    const c = await f.service.resolve(f.pool.findAccount('A')!, f.credential)
    expect(resolveChannelFor(c, 'glm-5.3-flash')).toBe('coding-plan')
    const request = buildChannelRequest(c, 'coding-plan', '{}')
    expect(request.url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer personal-key.secret-fixture')
    expect(request.headers['HTTP-Referer']).toBeUndefined()
    expect(f.pool.findAccount('A')!.zcodeSource).toBe('individual')
  })
  it('机构流量使用通用接口；机构套餐保留组织项目隔离', async () => {
    const f = await fixture(); const rows = (await f.service.list('A')).sources
    await f.service.select('A', rows.find(s => s.kind === 'organization-flow')!.id)
    let c = await f.service.resolve(f.pool.findAccount('A')!, f.credential)
    expect(c.source_selection!.url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    await f.service.select('A', rows.find(s => s.kind === 'team')!.id)
    c = await f.service.resolve(f.pool.findAccount('A')!, f.credential)
    expect(c.source_selection!.key).toBe('team-key.secret-fixture')
    expect(buildChannelRequest(c, 'coding-plan', '{}').headers['bigmodel-project']).toBe('team')
  })
  it('未知来源、无席位及刷新失败不改变已保存选择；旧凭据原值保留', async () => {
    const f = await fixture(); await f.service.select('A', 'start-plan')
    await expect(f.service.select('A', 'foreign:org')).rejects.toThrow()
    expect(f.pool.findAccount('A')!.zcodeSource).toBe('start-plan')
    f.unassigned(); const rows = (await f.service.list('A', true)).sources
    const team = rows.find(s => s.kind === 'team')!; expect(team.available).toBe(false)
    await expect(f.service.select('A', team.id)).rejects.toThrow('席位')
    f.fail(); await f.service.list('A', true)
    expect(f.pool.findAccount('A')!.zcodeSource).toBe('start-plan')
    expect(f.credential).toEqual({ zcode_jwt: 'fake-jwt', device_mid: 'fixture', bigmodel_access_token: 'fake-oauth' })
  })
  it('真实机构流量适配器走通用接口并保留工具历史，来源选择重载后仍在', async () => {
    const f = await fixture(); const row = (await f.service.list('A')).sources.find(s => s.kind === 'organization-flow')!
    await f.service.select('A', row.id)
    const reloaded = new AccountPool(f.ctx)
    expect(reloaded.findAccount('A')!.zcodeSource).toBe(row.id)
    const seen: any[] = []
    const adapter = wrapAdapterWithRotation(['zcode'], new ZcodeAdapter({ credentialRef: credentialRef('A'), accountPool: f.pool,
      resolveCredential: async model => { const a = (await f.pool.getAvailableAccount('zcode', model ?? ''))!; return f.service.resolve(a.entry, a.credential as any) },
      refresh: async () => {}, mintCaptcha: async () => 'fixture', gate: new ModelGate({ sleep: async () => {} }),
      fetchImpl: (async (url: any, init: any) => { seen.push({url, headers: new Headers(init.headers), body: JSON.parse(init.body)}); return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}}) }) as any,
    }))
    const prepared = await adapter.prepareCall('zcode', 'GLM-5.3-Flash')
    const chunks = []
    for await (const c of prepared.stream({model:'GLM-5.3-Flash',messages:[{role:'assistant',content:[{type:'tool-call',id:'call-1',name:'read',arguments:{path:'a'}}]},{role:'tool',toolCallId:'call-1',content:[{type:'text',text:'tool result'}]}]} as any)) chunks.push(c)
    expect(seen).toHaveLength(1);expect(seen[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(seen[0].body.model).toBe('glm-5.3-flash');expect(seen[0].headers.get('bigmodel-project')).toBe('proj')
    expect(seen[0].body.messages.some((m:any)=>m.role==='tool' && m.tool_call_id==='call-1')).toBe(true)
    expect(chunks.some((c:any)=>c.type==='text-delta' && c.text==='ok')).toBe(true)
  })

  it('真实平台的数字周期枚举不改变剩余额度数量', async () => {
    const f = await fixture();f.numeric();const result = await f.service.list('A',true)
    const quota = result.sources.find(s=>s.kind==='individual')!.quota
    expect(quota).toBe('5小时：剩余 2000；每周：剩余 8262')
    expect(quota).not.toContain('CREDIT_LIMIT')
  })

  it('团队查询必须同时携带type=2与组织/项目，个人查询保持独立', async () => {
    const f = await fixture(); f.numeric(); const result = await f.service.list('A', true)
    const quota = f.requests.filter(r => new URL(r.url).pathname.endsWith('quota/limit'))
    expect(quota.some(r => new URL(r.url).searchParams.get('type') === '2')).toBe(true)
    expect(quota.some(r => !new URL(r.url).searchParams.has('type'))).toBe(true)
    const team = quota.find(r => new URL(r.url).searchParams.get('type') === '2')!
    expect(team.headers.get('bigmodel-organization')).toBe('org')
    expect(team.headers.get('bigmodel-project')).toBe('team')
    expect(result.sources.find(s => s.kind === 'individual')?.quota).toContain('剩余 2000')
    expect(result.sources.find(s => s.kind === 'team')?.quota).toBe('5小时：剩余 14998；每周：剩余 63931')
  })

})
