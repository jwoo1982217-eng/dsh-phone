import { describe, expect, it } from 'vitest'
import { trimBackupPayload, describeBackupAccounts } from '../../plugin-src/client/backup-payload.js'

/**
 * 备份载荷裁剪的纯逻辑测试。
 *
 * 组件无法在本仓库单测里渲染（react 不在依赖内），但「只导入一个账号」最容易
 * 出错的地方正是**发请求前裁掉了什么** —— 裁多了账号丢了，裁少了会把别人的
 * 凭据回写覆盖本机现有账号。抽成纯函数后就能用真实断言覆盖。
 */

/** 造一份带两个账号的备份载荷。 */
function payload() {
  return {
    format: 'dsh-codearts-auth/backup',
    version: 1,
    exportedAt: '2026-09-29T00:00:00.000Z',
    credentials: {
      BUDDY_ACCOUNT_B1: '{"access_token":"t1"}',
      BUDDY_ACCOUNT_B2: '{"access_token":"t2"}',
      // 账号池之外的独立凭据 ref（各 provider 的默认单凭据）
      BUDDY_ACCESS_TOKEN: '{"access_token":"default"}',
    },
    accounts: [
      { id: 'buddy-b1', provider: 'buddy', nickname: 'B1', enabled: true, credentialRef: 'BUDDY_ACCOUNT_B1', refreshable: true, createdAt: 1 },
      { id: 'buddy-b2', provider: 'buddy', nickname: 'B2', enabled: true, credentialRef: 'BUDDY_ACCOUNT_B2', refreshable: true, createdAt: 2 },
    ],
    disabledModels: { buddy: { 'glm-5.2': true } },
    permanentLocks: { buddy: true },
  }
}

describe('trimBackupPayload（合并导入前裁剪）', () => {
  it('只保留选中的账号', () => {
    const out = trimBackupPayload(payload(), ['buddy-b2'])
    expect(out.accounts.map(a => a.id)).toEqual(['buddy-b2'])
  })

  it('凭据只保留被选中账号引用的那些', () => {
    const out = trimBackupPayload(payload(), ['buddy-b2'])
    // ⚠️ 关键：BUDDY_ACCOUNT_B1 与 BUDDY_ACCESS_TOKEN 都不能留下 ——
    // 它们会被后端写进凭据存储，可能覆盖本机现有账号的凭据。
    expect(Object.keys(out.credentials)).toEqual(['BUDDY_ACCOUNT_B2'])
  })

  it('独立凭据 ref（不属于任何选中账号）一律裁掉', () => {
    const out = trimBackupPayload(payload(), ['buddy-b1', 'buddy-b2'])
    // 即使两个账号都选中，账号池之外的默认 ref 也不该被带走。
    expect(Object.keys(out.credentials)).toEqual(['BUDDY_ACCOUNT_B1', 'BUDDY_ACCOUNT_B2'])
  })

  it('黑名单**原样保留**：空表会谎称「没有任何模型被关闭」，被当成 replace 时清空用户开关', () => {
    // ⚠️ 反向验证（对抗审计实测证伪）：把实现改回 `disabledModels: {}` → 本用例变红。
    //
    // 空表**不是**中性值：`replaceAll` 收到空表会执行
    // `modelCache = sanitizeDisabledModels({})` = `{}`，即**整体清空黑名单**，
    // 而原先的注释却声称这样「无论被当成哪种模式都不会改动模型开关」，与实现相反。
    // `accountIds` 的语义本就只作用于 `accounts` / `credentials` 两个字段。
    const out = trimBackupPayload(payload(), ['buddy-b1'])
    expect(out.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
  })

  it('黑名单字段缺失/非法时退化为空表（不抛错，也不伪造内容）', () => {
    expect(trimBackupPayload({ ...payload(), disabledModels: null }, ['buddy-b1']).disabledModels).toEqual({})
    expect(trimBackupPayload({ ...payload(), disabledModels: [] }, ['buddy-b1']).disabledModels).toEqual({})
    expect(trimBackupPayload({ ...payload(), disabledModels: 'x' }, ['buddy-b1']).disabledModels).toEqual({})
  })

  it('保留 format / version / exportedAt 等元字段（后端要校验格式）', () => {
    const out = trimBackupPayload(payload(), ['buddy-b1'])
    expect(out.format).toBe('dsh-codearts-auth/backup')
    expect(out.version).toBe(1)
    expect(out.exportedAt).toBe('2026-09-29T00:00:00.000Z')
  })

  it('不修改入参（原载荷必须原样可用于「整体还原」）', () => {
    const original = payload()
    trimBackupPayload(original, ['buddy-b1'])
    expect(original.accounts).toHaveLength(2)
    expect(Object.keys(original.credentials)).toHaveLength(3)
    expect(original.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
  })

  it('选中不存在的 id → 得到空载荷而不是抛错', () => {
    const out = trimBackupPayload(payload(), ['ghost'])
    expect(out.accounts).toEqual([])
    expect(out.credentials).toEqual({})
  })

  it('入参畸形（null / 无 accounts）时安全降级', () => {
    expect(trimBackupPayload(null, ['a']).accounts).toEqual([])
    expect(trimBackupPayload({}, ['a']).credentials).toEqual({})
    expect(trimBackupPayload({ accounts: 'nope' }, ['a']).accounts).toEqual([])
  })

  it('缺 credentialRef 的坏条目不会污染凭据表', () => {
    const out = trimBackupPayload({
      accounts: [{ id: 'bad' }],
      credentials: { SOMETHING: 'x' },
    }, ['bad'])
    expect(out.accounts.map(a => a.id)).toEqual(['bad'])
    expect(out.credentials).toEqual({})
  })
})

describe('describeBackupAccounts（导入弹窗的账号列表）', () => {
  it('列出 id / provider / 昵称 / 启用状态', () => {
    expect(describeBackupAccounts(payload())).toEqual([
      { id: 'buddy-b1', provider: 'buddy', nickname: 'B1', enabled: true },
      { id: 'buddy-b2', provider: 'buddy', nickname: 'B2', enabled: true },
    ])
  })

  it('缺昵称时回退成 id（列表不能出现空白行）', () => {
    const list = describeBackupAccounts({ accounts: [{ id: 'x', provider: 'buddy' }] })
    expect(list).toEqual([{ id: 'x', provider: 'buddy', nickname: 'x', enabled: true }])
  })

  it('丢坏条目（缺 id / 非对象），不抛错', () => {
    const list = describeBackupAccounts({ accounts: [{ provider: 'buddy' }, null, 'x', { id: 'ok', provider: 'buddy' }] })
    expect(list.map(a => a.id)).toEqual(['ok'])
  })

  it('入参畸形时返回空数组', () => {
    expect(describeBackupAccounts(null)).toEqual([])
    expect(describeBackupAccounts({ accounts: {} })).toEqual([])
  })
})
