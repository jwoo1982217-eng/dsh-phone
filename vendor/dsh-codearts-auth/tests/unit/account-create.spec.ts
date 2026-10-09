import { Context } from '@deepseek-ai/cordis'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

let directory: string, previous: string | undefined
beforeEach(() => { previous = process.env.DSH_JET_HUB_STATE_DIR; directory = mkdtempSync(join(tmpdir(), 'jet-add-account-')); process.env.DSH_JET_HUB_STATE_DIR = directory })
afterEach(() => { if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR; else process.env.DSH_JET_HUB_STATE_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

it('同厂牌显式添加第二账号启动独立授权，不复用旧身份或覆盖现有条目', async () => {
  const ctx = new Context()
  const values = new Map<string, string>()
  ctx.provide('credentials', { resolve: async (r: unknown) => ({ value: values.get(JSON.stringify(r)) }), set: async (r: unknown, v: string) => { values.set(JSON.stringify(r), v) }, unset: async () => {} } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', { listModels: async () => [] } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as any).connection = { fetch: { register: (spec: any) => { if (spec.path === JET_HUB_API_PATH) handler = spec.fetch } } }
  ;(ctx as any).inject = (_deps: unknown, callback: any) => callback(ctx)
  const pool = new AccountPool(ctx)
  await pool.addAccount({ id: 'existing', provider: 'zcode', credentialRef: 'existing-ref', nickname: 'existing', enabled: true, refreshable: false, createdAt: 1 })
  const zcode = { adoptIntoOrphanAccount: vi.fn(async () => 'existing'), localCredential: vi.fn(async () => undefined),
    startLogin: vi.fn(async () => ({ loginUrl: 'https://bigmodel.cn/fixture-authorize', result: new Promise(() => {}) })) }
  registerJetHubRpc(ctx, pool, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, zcode as never)
  const create = async (newAccount?: boolean) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'jet-hub', payload: { method: 'account.create', payload: { provider: 'zcode', newAccount } } }) }))
    return (await response.json()).result
  }
  const added = await create(true)
  expect(added.ok).toBe(true)
  expect(added.value.loginUrl).toBe('https://bigmodel.cn/fixture-authorize')
  expect(added.value.accountId).not.toBe('existing')
  expect(pool.listAccountsByProvider('zcode')).toHaveLength(2)
  expect(zcode.startLogin).toHaveBeenCalledOnce()
  expect(zcode.adoptIntoOrphanAccount).not.toHaveBeenCalled()
  expect(zcode.localCredential).not.toHaveBeenCalled()
  expect(pool.findAccount('existing')?.credentialRef).toBe('existing-ref')
})
