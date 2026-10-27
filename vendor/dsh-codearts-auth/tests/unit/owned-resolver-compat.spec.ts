import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import { rotatingStream } from '../../src/account-rotation.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'

let directory: string, previous: string | undefined
beforeEach(() => { previous = process.env.DSH_JET_HUB_STATE_DIR; directory = mkdtempSync(join(tmpdir(), 'owned-resolver-')); process.env.DSH_JET_HUB_STATE_DIR = directory })
afterEach(() => { if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR; else process.env.DSH_JET_HUB_STATE_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
async function fixture(kind: 'buddy' | 'loomy', free = false) {
  const raw = new Map<string, string>()
  const ctx = { get: () => undefined, logger: { warn: vi.fn(), info: vi.fn() }, credentials: { resolve: async (ref: unknown) => raw.has(JSON.stringify(ref)) ? { value: raw.get(JSON.stringify(ref)) } : undefined, unset: async () => {} } }
  const pool = new AccountPool(ctx as never, { preserveAccountOrder: true })
  for (const id of ['A', 'B', 'C']) { raw.set(JSON.stringify(credentialRef(id)), JSON.stringify({ access_token: id })); await pool.addAccount({ id, provider: kind, credentialRef: id, enabled: true, refreshable: true, nickname: id, createdAt: 1 }) }
  const read = async (ref: string) => { try { return JSON.parse(raw.get(JSON.stringify(credentialRef(ref))) ?? '') as { access_token: string } } catch { return undefined } }
  const selections: string[][] = []
  const selector = { select: async (candidates: readonly { id: string; credentialRef: string }[], options: { preferOrder?: boolean }) => { selections.push(candidates.map(a => a.id)); const account = options.preferOrder ? candidates[0] : candidates.at(-1); return account ? { ok: true, account, balance: {} } : { ok: false, reason: { kind: 'empty' } } } }
  const balance = kind === 'buddy' ? { kind, selector, isFreeModel: () => free, lockedError: () => Error('locked') } : { kind, selector, lockedError: () => Error('locked') }
  const resolve = createCredentialResolver({ pool }, { product: { id: kind, displayName: kind }, readCredential: read, fallback: { kind: 'ref', refName: 'LEGACY' }, balance } as never)
  const run = async (model = 'm') => { const out = []; for await (const value of rotatingStream(kind, model, async function* () { yield (await resolve(model)) as { access_token?: string } | undefined })) out.push(value?.access_token); return out }
  return { pool, raw, run, selections }
}
it.each(['buddy', 'loomy'] as const)('新工厂接真实池：%s 同模型粘性、并发一致、冷却换号及模型隔离', async kind => {
  const f = await fixture(kind)
  expect(await f.run()).toEqual(['A'])
  expect((await Promise.all([f.run(), f.run(), f.run()])).flat()).toEqual(['A', 'A', 'A'])
  await f.pool.updateModelRateLimit('A', 'm', Date.now() + 60_000)
  expect(await f.run()).toEqual(['B']); expect(await f.run()).toEqual(['B'])
  expect(await f.run('other')).toEqual(['A'])
  expect(f.selections.every(ids => ids.length > 0)).toBe(true)
})
it('免费模型也遵守资格过滤；全部不可用不能回退到旧固定凭据', async () => {
  const f = await fixture('buddy', true)
  f.pool.setRequestEligibility('buddy', async entry => entry.id !== 'A')
  expect(await f.run()).toEqual(['B'])
  for (const account of f.pool.listAccountsByProvider('buddy')) await f.pool.updateAccount(account.id, { enabled: false })
  f.raw.set(JSON.stringify(credentialRef('LEGACY')), JSON.stringify({ access_token: 'must-not-be-used' }))
  expect(await f.run()).toEqual([undefined])
})
it('Loomy 余额缓存仍有效但凭据损坏时继续下一候选，随后可恢复', async () => {
  const f = await fixture('loomy')
  f.raw.set(JSON.stringify(credentialRef('A')), 'broken')
  expect(await f.run()).toEqual(['B'])
  f.raw.set(JSON.stringify(credentialRef('A')), JSON.stringify({ access_token: 'A' }))
  expect(await f.run()).toEqual(['B'])
  expect(await f.run('new-model')).toEqual(['A'])
})

it('真实插件接线显式保留自家顺序与首选上下文策略，而非只在测试夹具开启', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8')
  expect(source).toMatch(/new AccountPool\(ctx, \{ preserveAccountOrder: true \}\)/)
  expect(source).toMatch(/registerAggregateLlm\(ctx, \{\s*contextWindowPolicy: 'preferred'/)
})
