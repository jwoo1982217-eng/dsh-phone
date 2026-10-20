import { describe, it, expect } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BackupFormatError,
  assertBackupPayload,
  exportBackup,
  importBackup,
  type BackupCredentials,
  type BackupPool,
} from '../../src/backup.js'
import { BACKUP_FORMAT, BACKUP_VERSION } from '../../src/types.js'
import type { JetHubState } from '../../src/jet-hub-store.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 构造一份最小账号条目。 */
function account(partial: Partial<ProviderAccountEntry> & { id: string; provider: string; credentialRef: string }): ProviderAccountEntry {
  return {
    nickname: partial.id,
    enabled: true,
    refreshable: true,
    createdAt: 1000,
    ...partial,
  }
}

/** 内存凭据服务（与 ctx.credentials 同构的最小实现）。 */
function createCredentials(): BackupCredentials & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    resolve: async (ref) => {
      const value = store.get(String(ref))
      return value === undefined ? undefined : { value }
    },
    set: async (ref, value) => {
      store.set(String(ref), value)
    },
  }
}

/** 内存账号池（记录最后一次 replaceAll 调用）。 */
function createPool(initial?: JetHubState): BackupPool & {
  replaced: {
    accounts: ProviderAccountEntry[]
    disabledModels: Record<string, Record<string, boolean>>
    /** 第三参：`undefined` = 备份里没有锁定信息（池应保持当前值）。 */
    permanentLocks?: Record<string, boolean>
  } | null
} {
  let state = initial ?? { accounts: [], disabledModels: {} }
  const record: { replaced: {
    accounts: ProviderAccountEntry[]
    disabledModels: Record<string, Record<string, boolean>>
    permanentLocks?: Record<string, boolean>
  } | null } = { replaced: null }
  return {
    get replaced() { return record.replaced },
    getStateSnapshot: () => ({
      accounts: [...state.accounts],
      disabledModels: { ...state.disabledModels },
      ...state.loomyPermanentLocked !== undefined ? { loomyPermanentLocked: state.loomyPermanentLocked } : {},
    }),
    // 锁定表的权威在独立文档里，备份导出单独取这一份。
    permanentLocksSnapshot: () => ({ ...(state.permanentLocks ?? {}) }),
    replaceAll: async (accounts, disabledModels, permanentLocks) => {
      state = { accounts: [...accounts], disabledModels: { ...disabledModels } }
      record.replaced = {
        accounts: [...accounts],
        disabledModels: { ...disabledModels },
        ...(permanentLocks === undefined ? {} : { permanentLocks }),
      }
      return undefined
    },
  }
}

describe('backup export', () => {
  it('收集全部账号的凭据原文与黑名单', async () => {
    const credentials = createCredentials()
    const codeartsCredential = JSON.stringify({ access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST' })
    await credentials.set(credentialRef('CODEARTS_ACCOUNT_A1B2'), codeartsCredential)
    const pool = createPool({
      accounts: [
        account({ id: 'codearts-a1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_A1B2' }),
      ],
      disabledModels: { buddy: { 'glm-5.2': true } },
    })

    const result = await exportBackup(pool, credentials)

    expect(result.warnings).toEqual([])
    expect(result.payload.format).toBe('dsh-codearts-auth/backup')
    expect(result.payload.version).toBe(1)
    expect(typeof result.payload.exportedAt).toBe('string')
    // 凭据以**原文**保存（与 ctx.credentials 存储形态一致），不做任何改写
    expect(result.payload.credentials['CODEARTS_ACCOUNT_A1B2']).toBe(codeartsCredential)
    expect(result.payload.accounts).toHaveLength(1)
    expect(result.payload.accounts[0]!.id).toBe('codearts-a1')
    expect(result.payload.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
  })

  it('凭据缺失/损坏只记 warnings，不中断整体导出', async () => {
    const credentials = createCredentials()
    // 只给第二个账号配凭据；第一个账号的凭据缺失
    await credentials.set(credentialRef('BUDDY_ACCOUNT_B2C3'), '{"access_token":"t"}')
    const pool = createPool({
      accounts: [
        account({ id: 'buddy-b1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B1' }),
        account({ id: 'buddy-b2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B2C3' }),
      ],
      disabledModels: {},
    })

    const result = await exportBackup(pool, credentials)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('buddy-b1')
    expect(Object.keys(result.payload.credentials)).toEqual(['BUDDY_ACCOUNT_B2C3'])
    // 坏账号不影响其余账号与整体导出
    expect(result.payload.accounts).toHaveLength(2)
  })
})

describe('backup format validation', () => {
  it('非对象输入抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    await expect(importBackup(credentials, pool, null)).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, 'string')).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, [1])).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('format 不符抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    await expect(importBackup(credentials, pool, {
      format: 'other/format',
      version: 1,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [],
      disabledModels: {},
    })).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('版本不符抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    await expect(importBackup(credentials, pool, {
      format: 'dsh-codearts-auth/backup',
      version: 99,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [],
      disabledModels: {},
    })).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('字段缺失/类型错误抛 BackupFormatError', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const base = {
      format: 'dsh-codearts-auth/backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [],
      disabledModels: {},
    }
    await expect(importBackup(credentials, pool, { ...base, credentials: 'nope' })).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, { ...base, accounts: 'nope' })).rejects.toBeInstanceOf(BackupFormatError)
    await expect(importBackup(credentials, pool, { ...base, disabledModels: null })).rejects.toBeInstanceOf(BackupFormatError)
  })
})

describe('backup import', () => {
  it('先写凭据再整体替换账号池', async () => {
    const credentials = createCredentials()
    const pool = createPool({ accounts: [{ id: 'old', provider: 'buddy', nickname: 'old', enabled: true, refreshable: false, credentialRef: 'OLD_REF', createdAt: 1 }], disabledModels: {} })
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        'CODEARTS_ACCOUNT_A1B2': JSON.stringify({ access_key_id: 'AK' }),
        'BUDDY_ACCOUNT_B2C3': JSON.stringify({ access_token: 't' }),
      },
      accounts: [
        account({ id: 'codearts-a1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_A1B2' }),
      ],
      disabledModels: { trae: { 'qwen3.8-flash': true } },
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(2)
    expect(result.accountsImported).toBe(1)
    expect(result.skipped).toEqual([])
    // 凭据已写入
    expect((await credentials.resolve(credentialRef('CODEARTS_ACCOUNT_A1B2')))?.value).toContain('"access_key_id":"AK"')
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_B2C3')))?.value).toContain('"access_token":"t"')
    // 账号池整体替换（旧账号被清掉）
    expect(pool.replaced).not.toBeNull()
    expect(pool.replaced!.accounts.map(a => a.id)).toEqual(['codearts-a1'])
    expect(pool.replaced!.disabledModels).toEqual({ trae: { 'qwen3.8-flash': true } })
  })

  it('值非字符串的凭据条目被跳过并记录', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        'BUDDY_ACCOUNT_B1': { access_token: 'not-a-string' },
        'BUDDY_ACCOUNT_B2': '{"access_token":"ok"}',
      },
      accounts: [],
      disabledModels: {},
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(1)
    expect(result.skipped).toEqual(['BUDDY_ACCOUNT_B1'])
  })

  it('非法凭据 ref 被跳过，不中断整体导入', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        '': '{"x":1}', // 空 ref：credentialRef 校验必失败
        'BUDDY_ACCOUNT_B2': '{"access_token":"ok"}',
      },
      accounts: [],
      disabledModels: {},
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(1)
    expect(result.skipped).toContain('')
    // 合法条目不受影响
    expect((await credentials.resolve(credentialRef('BUDDY_ACCOUNT_B2')))?.value).toContain('"access_token":"ok"')
  })

  it('统计已过期账号（expiresAt <= now），缺失/非法 expiresAt 不算过期', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const now = Date.now()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {},
      accounts: [
        // 已过期
        account({ id: 'buddy-expired', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_E1', expiresAt: now - 1000 }),
        // 未来（未过期）
        account({ id: 'buddy-future', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_F1', expiresAt: now + 3600000 }),
        // 无有效期（自动恢复产物，不算"已过期"）
        account({ id: 'buddy-unknown', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_U1' }),
        // 非法 expiresAt（NaN，不算过期）
        account({ id: 'buddy-nan', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_N1', expiresAt: Number.NaN }),
      ],
      disabledModels: {},
    }

    const result = await importBackup(credentials, pool, payload)

    expect(result.expiredAccounts).toBe(1)
    expect(result.accountsImported).toBe(4)
  })

  it('统计凭据缺失账号（credentialRef 不在字典 / 被 skipped）', async () => {
    const credentials = createCredentials()
    const pool = createPool()
    const payload = {
      format: 'dsh-codearts-auth/backup' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      credentials: {
        'BUDDY_ACCOUNT_1': '{"access_token":"ok"}',
        'BUDDY_ACCOUNT_2': '{"access_token":"also-ok"}',
      },
      accounts: [
        // 凭据存在（不缺失）
        account({ id: 'buddy-1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_1' }),
        // credentialRef 不在 credentials 字典（缺失）
        account({ id: 'buddy-2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_MISSING' }),
        // credentialRef 在字典但值非字符串 → 被 skipped（也算缺失）
        account({ id: 'buddy-3', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_2' }),
      ],
      disabledModels: {},
    }
    // BUDDY_ACCOUNT_2 的值是对象（非字符串）→ 会被 skipped
    payload.credentials['BUDDY_ACCOUNT_2'] = { access_token: 'not-a-string' } as unknown as string

    const result = await importBackup(credentials, pool, payload)

    expect(result.credentialsImported).toBe(1)
    expect(result.skipped).toEqual(['BUDDY_ACCOUNT_2'])
    // buddy-2（缺 ref）与 buddy-3（ref 被 skipped）都算凭据缺失
    expect(result.missingCredentials).toBe(2)
    expect(result.accountsImported).toBe(3)
  })
})

describe('backup round-trip', () => {
  it('导出 → 导入可还原全部账号与凭据', async () => {
    // 源侧
    const sourceCredentials = createCredentials()
    await sourceCredentials.set(credentialRef('CODEARTS_ACCOUNT_A1B2'), '{"access_key_id":"AK"}')
    await sourceCredentials.set(credentialRef('BUDDY_ACCOUNT_B2C3'), '{"access_token":"t","refresh_token":"r"}')
    const sourcePool = createPool({
      accounts: [
        account({ id: 'codearts-a1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_A1B2' }),
        account({ id: 'buddy-b2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_B2C3' }),
      ],
      disabledModels: { qoder: { 'qfmodel': true } },
    })

    const exported = await exportBackup(sourcePool, sourceCredentials)
    expect(exported.warnings).toEqual([])

    // 目标侧（全新空状态）
    const targetCredentials = createCredentials()
    const targetPool = createPool()
    const result = await importBackup(targetCredentials, targetPool, exported.payload)

    expect(result.credentialsImported).toBe(2)
    expect(result.accountsImported).toBe(2)
    expect(result.skipped).toEqual([])
    // 备份里的账号未带 expiresAt（未知），不算已过期
    expect(result.expiredAccounts).toBe(0)
    // 凭据原文逐条还原
    expect((await targetCredentials.resolve(credentialRef('CODEARTS_ACCOUNT_A1B2')))?.value).toBe('{"access_key_id":"AK"}')
    expect((await targetCredentials.resolve(credentialRef('BUDDY_ACCOUNT_B2C3')))?.value).toBe('{"access_token":"t","refresh_token":"r"}')
    // 账号与黑名单还原
    expect(targetPool.replaced!.accounts.map(a => a.id)).toEqual(['codearts-a1', 'buddy-b2'])
    expect(targetPool.replaced!.disabledModels).toEqual({ qoder: { qfmodel: true } })
  })
})

/**
 * ⚠️ **永久积分锁定表**的导出 / 导入（CodeBuddy 与 WorkBuddy 加入后新增）。
 *
 * 这件事的风险与其他字段不同：**误解锁的后果是用户真的把永久积分烧掉**，
 * 不可撤回。所以「备份里没说」与「备份里说不锁」必须区分开。
 */
describe('永久积分锁定表', () => {
  /** 造一份合法载荷（只关心锁定相关字段）。 */
  function payloadOf(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '2026-09-29T00:00:00.000Z',
      credentials: {},
      accounts: [],
      disabledModels: {},
      ...extra,
    }
  }

  it('导出同时写新表与 Loomy 兼容副本（同源）', async () => {
    const pool = createPool({
      accounts: [],
      disabledModels: {},
      permanentLocks: { buddy: true, loomy: true },
    })
    const { payload } = await exportBackup(pool, createCredentials())
    expect(payload.permanentLocks).toEqual({ buddy: true, loomy: true })
    expect(payload.loomyPermanentLocked).toBe(true)
  })

  it('导出时表为空 → 兼容副本必须是 false（不能让 Loomy 跟着 buddy 一起锁上）', async () => {
    const pool = createPool({ accounts: [], disabledModels: {}, permanentLocks: { buddy: true } })
    const { payload } = await exportBackup(pool, createCredentials())
    expect(payload.permanentLocks).toEqual({ buddy: true })
    expect(payload.loomyPermanentLocked).toBe(false)
  })

  it('导入新表 → 整体替换（buddy 的锁定不丢，未记录的 provider 被解锁）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({
      permanentLocks: { buddy: true, workbuddy: true },
    }))
    expect(pool.replaced!.permanentLocks).toEqual({ buddy: true, workbuddy: true })
  })

  /**
   * ⚠️ 老备份（本次改动之前导出的）只有 `loomyPermanentLocked` 一个字段。
   * 不认它 = 导入老备份后 Loomy 的锁定悄悄失效；
   * 把它当「无从得知」= 用户明明在备份里说过「锁着」却解了。
   */
  it('导入只有老字段且为 true 的老备份 → 恢复 Loomy 那一项', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({ loomyPermanentLocked: true }))
    expect(pool.replaced!.permanentLocks).toEqual({ loomy: true })
  })

  /** 老字段为 false 是**明确的「不锁」**，与「没有这个字段」不同。 */
  it('导入只有老字段且为 false 的老备份 → 明确解锁（传空表，不是 undefined）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({ loomyPermanentLocked: false }))
    expect(pool.replaced!.permanentLocks).toEqual({})
  })

  /**
   * ⚠️ 两个字段都没有（更早的备份）→ 必须传 `undefined`，
   * 让池**保持当前值**；传空表会把用户的锁定静默清空。
   */
  it('两个字段都没有时传 undefined（保持当前锁定状态）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf())
    expect(pool.replaced).not.toBeNull()
    expect(pool.replaced!.permanentLocks).toBeUndefined()
  })

  it('新表存在时仍以老字段补齐表里没有的 Loomy 项（两处口径不分裂）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({
      permanentLocks: { buddy: true },
      loomyPermanentLocked: true,
    }))
    expect(pool.replaced!.permanentLocks).toEqual({ buddy: true, loomy: true })
  })

  it('表里的脏值被过滤（只认显式 true）', async () => {
    const pool = createPool()
    await importBackup(createCredentials(), pool, payloadOf({
      permanentLocks: { buddy: 'yes', workbuddy: true, loomy: false },
    }))
    expect(pool.replaced!.permanentLocks).toEqual({ workbuddy: true })
  })

  it('permanentLocks 是数组时拒绝整份备份（typeof [] 也是 object，必须单独判）', async () => {
    const pool = createPool()
    expect(() => assertBackupPayload(payloadOf({ permanentLocks: ['buddy'] })))
      .toThrowError(BackupFormatError)
  })

  it('round-trip 锁定状态不丢', async () => {
    const source = createPool({
      accounts: [],
      disabledModels: {},
      permanentLocks: { buddy: true, workbuddy: true },
    })
    const { payload } = await exportBackup(source, createCredentials())
    const target = createPool()
    await importBackup(createCredentials(), target, payload)
    expect(target.replaced!.permanentLocks).toEqual({ buddy: true, workbuddy: true })
  })
})
