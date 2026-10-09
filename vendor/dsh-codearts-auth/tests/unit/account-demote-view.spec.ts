import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

function entry(id: string, limits?: Record<string, number>): ProviderAccountEntry {
  return {
    id, provider: 'buddy', nickname: id, enabled: true,
    credentialRef: 'B_X', refreshable: true, createdAt: 0, expiresAt: 4_000_000_000_000,
    ...(limits ? { modelRateLimits: limits } : {}),
  }
}

/** 最简 mock：settingsOf 走 ctx.get('settings')（settings-compat.ts readService）⇒ 顶层 get 必须有。 */
function makePool(initial: ProviderAccountEntry[]) {
  let stored: { accounts?: ProviderAccountEntry[] } = { accounts: initial }
  const mockSettings = {
    register: () => ({
      get: () => stored,
      replace: async (v: { accounts?: ProviderAccountEntry[] }) => { stored = v },
    }),
    describe: () => [],
  }
  const ctx = {
    get: (key: string) => (key === 'settings' ? mockSettings : undefined),
    credentials: {
      async resolve() { return null },
      async describe() { return { source: 'mock' } },
      async refName() { return 'MOCK' },
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return new AccountPool(ctx as never)
}

describe('listAccounts 视图排序：限流账号沉底（工单 08）', () => {
  it('限流中的账号沉到最后（未限流者保持手动序）', async () => {
    const pool = makePool([entry('a'), entry('b'), entry('c', { m: Date.now() + 3_600_000 })])
    const listed = await pool.listAccounts('buddy')
    expect(listed.map(a => a.id)).toEqual(['a', 'b', 'c'])
    // 磁盘序不变（手动契约）
    expect((await pool.listAllAccounts()).map(a => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('限流解除 ⇒ 自动回原位（视图按磁盘序渲染，无需任何状态）', async () => {
    const pool = makePool([entry('a'), entry('b', { m: Date.now() - 1 }), entry('c')])
    const listed = await pool.listAccounts('buddy')
    expect(listed.map(a => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('多个限流账号：相互保持手动相对序，一起沉底', async () => {
    const pool = makePool([
      entry('a'), entry('b', { m: Date.now() + 9_000_000 }),
      entry('c'), entry('d', { m: Date.now() + 8_000_000 }),
    ])
    const listed = await pool.listAccounts('buddy')
    expect(listed.map(a => a.id)).toEqual(['a', 'c', 'b', 'd'])
  })
})
