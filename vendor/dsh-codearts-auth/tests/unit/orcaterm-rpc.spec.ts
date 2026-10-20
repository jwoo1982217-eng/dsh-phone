import { expect, it, vi } from 'vitest'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

it('取消后的腾讯登录复用空账号，成功保存后才能创建下一账号', async () => {
  const accounts: any[] = []
  let stored: { value: string } | undefined
  let handler: (request: Request) => Promise<Response>
  const pool = {
    listAccounts: async () => accounts,
    listAllAccounts: async () => accounts,
    addAccount: async (entry: any) => accounts.push(entry),
    updateAccount: async (id: string, value: any) => Object.assign(accounts.find(x => x.id === id), value),
  }
  const credentials = { resolve: async () => stored, set: vi.fn(async (_ref, value) => { stored = { value } }) }
  const connection = { fetch: { register: (route: any) => { if (route.path === JET_HUB_API_PATH) handler = route.fetch } } }
  const ctx = { credentials, get: (id: string) => id === 'connection' ? connection : undefined,
    inject: (_ids: any, callback: any) => callback(ctx), emit: vi.fn(), logger: { warn: vi.fn() } }
  registerJetHubRpc(ctx as never, pool as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never)
  const call = async (method: string, payload: unknown) => (await (await handler(new Request('http://localhost/jet-hub/manage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'manage', payload: { method, payload } }),
  }))).json()).result
  const first = await call('account.create', { provider: 'orcaterm' })
  const retry = await call('account.create', { provider: 'orcaterm', newAccount: true })
  expect(retry.value.accountId).toBe(first.value.accountId)
  expect(accounts).toHaveLength(1)
  expect(credentials.set).not.toHaveBeenCalled()
  expect((await call('account.setCookie', { accountId: first.value.accountId, value: 'language=zh' })).ok).toBe(false)
  expect(credentials.set).not.toHaveBeenCalled()
  expect((await call('account.setCookie', { accountId: first.value.accountId, value: 'uin=o123; skey=sample' })).ok).toBe(true)
  expect(credentials.set).toHaveBeenCalledTimes(1)
  expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
  const next = await call('account.create', { provider: 'orcaterm', newAccount: true })
  expect(next.value.accountId).not.toBe(first.value.accountId)
  expect(accounts).toHaveLength(2)
})
