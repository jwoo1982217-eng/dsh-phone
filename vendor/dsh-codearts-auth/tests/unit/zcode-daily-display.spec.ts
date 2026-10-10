import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchZcodeBalance, describeZcodePendingGrants } from '../../src/zcode-upstream.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { badgePlanFor } from '../../src/badge-subscription.js'
import { badgeView, creditSectionLabel } from '../../plugin-src/client/badge-model.js'

const NOW = 1791640778, EFFECTIVE = 1791644400, END = 1791766800
const CREDENTIAL = { zcode_jwt: 'fixture-jwt', device_mid: 'fixture', bigmodel_access_token: 'fixture-oauth', coding_plan_key_bigmodel: 'fixture-key' }
const PLAN = { plan_id: 'daily-fixture', ends_at: END, entitlements: [{ show_name: 'GLM', unit_type: 'token', grant_units: 300000000, effective_at: EFFECTIVE }] }
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }))
function fetcher(now = NOW, options: { fail?: boolean; expired?: boolean; available?: number } = {}): typeof fetch {
  return vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (options.fail && (path.endsWith('/balance') || path.endsWith('quota/limit'))) return new Response('', { status: 503 })
    if (path.endsWith('/balance')) return json({ server_time: now, plans: [{ ...PLAN, ...(options.expired ? { ends_at: now - 1 } : {}) }], balances: options.available === undefined ? [] : [{ unit_type: 'token', total_units: 300000000, available_units: options.available }] })
    if (path.endsWith('/preview')) return json({ plans: [PLAN] })
    if (path.endsWith('getCustomerInfo')) return json({ organizations: [] })
    if (path.endsWith('quota/limit')) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('fixture-key')
      return json({ limits: [{ type: 'CREDIT_LIMIT', unit: 3, remaining: 1860 }, { type: 'CREDIT_LIMIT', unit: 6, remaining: 8123 }] })
    }
    return json({})
  })
}
let dir: string | undefined, previous: string | undefined
afterEach(() => { vi.unstubAllGlobals(); if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR; else process.env.DSH_JET_HUB_STATE_DIR = previous } })
async function rpcFixture(f = fetcher()) {
  previous = process.env.DSH_JET_HUB_STATE_DIR; dir = mkdtempSync(join(tmpdir(), 'zcode-daily-')); process.env.DSH_JET_HUB_STATE_DIR = dir
  vi.stubGlobal('fetch', f)
  const ctx = new Context(), refs = new Map([[JSON.stringify(credentialRef('fixture')), JSON.stringify(CREDENTIAL)]])
  ctx.provide('credentials', { resolve: async (ref: unknown) => { const value = refs.get(JSON.stringify(ref)); return value ? { value } : undefined }, unset: async () => {}, describe: async () => ({ configured: true }) } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  let handler: ((method: string, payload: unknown, signal: AbortSignal) => Promise<any>) | undefined
  const connection = { rpc: { handle: (path: string, fn: typeof handler) => { if (path === '/jet-hub') handler = fn } } }
  ctx.provide('connection', connection as never)
  Object.defineProperty(ctx, 'connection', { value: connection })
  Object.defineProperty(ctx, 'inject', { value: (_deps: unknown, cb: (context: Context) => void) => cb(ctx) })
  const pool = new AccountPool(ctx)
  await pool.addAccount({ id: 'fixture', provider: 'zcode', credentialRef: 'fixture', nickname: 'fixture', enabled: true, refreshable: false, createdAt: 1 })
  const auth = new ZcodeAuth(ctx, { fetchImpl: f })
  registerJetHubRpc(ctx, pool,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, auth, {} as never)
  expect(handler).toBeDefined()
  const call = (method: string, payload: unknown = { provider: 'zcode' }) => handler!('manage', { method, payload }, new AbortController().signal)
  return { pool, auth, call, fetch: f }
}
describe('ZCode每日额度与当前来源的实际显示', () => {
  it('已领取3亿但尚未生效，不混入可用Token；使用服务端时间', async () => {
    const b = await fetchZcodeBalance(CREDENTIAL, fetcher())
    expect(b?.remaining).toBe(0); expect(b?.total).toBe(0)
    expect(b?.ownedPlanIds).toEqual(['daily-fixture'])
    expect(b?.pendingGrants?.[0]).toMatchObject({ amount: 300000000, unit: 'token', effectiveAt: EFFECTIVE })
    expect(describeZcodePendingGrants(b?.pendingGrants)).toContain('300,000,000 token')
    expect(describeZcodePendingGrants(b?.pendingGrants)).toContain('23:00:00')
  })
  it('生效后只使用真实余额桶；过期权益不继续报待生效', async () => {
    const b = await fetchZcodeBalance(CREDENTIAL, fetcher(EFFECTIVE, { available: 299999000 }))
    expect(b?.pendingGrants).toEqual([]); expect(b?.remaining).toBe(299999000)
    const expired = await fetchZcodeBalance(CREDENTIAL, fetcher(NOW, { expired: true }))
    expect(expired?.pendingGrants).toEqual([]); expect(expired?.ownedPlanIds).toEqual([])
  })
  it('刷新状态RPC已支持ZCode；预览仍重复下发已拥有的计划也判已领取', async () => {
    const f = await rpcFixture(), r = await f.call('credits.status')
    expect(r.ok).toBe(true); expect(r.value.accounts[0].status.todayCheckedIn).toBe(true)
    const b = await f.call('credits.balances')
    expect(b.value.accounts[0].balance.total).toBe(0)
    expect(b.value.accounts[0].balance.pendingNote).toContain('待生效 300,000,000 token')
    const s = await f.call('zcode.sources', { accountId: 'fixture', refresh: true })
    expect(s.value.sources[0].quota).toContain('23:00:00')
  })
  it('选择个人套餐后卡片及徽标读本人配额，不再显示赠送Token零余额', async () => {
    const f = await rpcFixture()
    await f.call('zcode.selectSource', { accountId: 'fixture', sourceId: 'individual' })
    const b = await f.call('credits.balances'), balance = b.value.accounts[0].balance
    expect(balance.sourceQuota.label).toContain('个人套餐')
    expect(balance.sourceQuota.text).toBe('5小时：剩余 1860；每周：剩余 8123')
    expect(badgePlanFor('zcode', balance)).toBeNull()
    const view = badgeView({ providerLabel: 'ZCode', accounts: b.value.accounts })
    expect(view.reading).toContain('剩余 1860'); expect(view.reading).not.toContain('0Token')
    expect(creditSectionLabel(view.groups)).toBe('额度')
    expect(JSON.stringify(b)).not.toMatch(/fixture-jwt|fixture-key|fixture-oauth/)
  })
  it('查询失败显示未知，保留来源；一账号凭据失败不串用另一个账号', async () => {
    const f = await rpcFixture()
    await f.call('zcode.selectSource', { accountId: 'fixture', sourceId: 'individual' })
    const normal = fetcher()
    vi.mocked(f.fetch).mockImplementation(async (url, init) => String(url).endsWith('quota/limit') ? new Response('', { status: 503 }) : normal(url, init))
    const b = await f.call('credits.balances')
    expect(b.value.accounts[0].balance).toBeNull(); expect(b.value.accounts[0].error).toContain('查询失败')
    expect(f.pool.findAccount('fixture')?.zcodeSource).toBe('individual')
    await f.pool.addAccount({ id: 'missing', provider: 'zcode', credentialRef: 'missing', nickname: 'missing', enabled: true, refreshable: false, createdAt: 2 })
    const s = await f.call('credits.status')
    expect(s.value.accounts.find((a: any) => a.accountId === 'missing').status).toBeNull()
    expect(s.value.accounts.find((a: any) => a.accountId === 'fixture').status.todayCheckedIn).toBe(true)
  })
  it('预览网络失败不误报已领取，可用余额仍能独立读取', async () => {
    const f = fetcher(), broken: typeof fetch = async (url, init) => String(url).includes('/preview') ? new Response('', { status: 503 }) : f(url, init)
    const auth = new ZcodeAuth(new Context(), { fetchImpl: broken })
    await expect(auth.fetchCheckinStatusFor(CREDENTIAL)).rejects.toThrow('状态查询失败')
    const b = await fetchZcodeBalance(CREDENTIAL, broken)
    expect(b?.remaining).toBe(0); expect(b?.claimablePlansKnown).toBe(false)
  })
})
