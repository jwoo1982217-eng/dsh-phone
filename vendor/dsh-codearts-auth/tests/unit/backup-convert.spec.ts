import { describe, expect, it } from 'vitest'
import {
  convertForeignAccounts,
  decodeJwtPayload,
  deriveRefreshExpiresAt,
  looksLikeForeignAccountList,
  providerFromIssuer,
  stableShortId,
} from '../../plugin-src/client/backup-convert.js'

/**
 * 第三方账号列表 → 插件备份载荷的转换器测试。
 *
 * 基准是**本机一个真实可用的 CodeBuddy 凭据**的字段形态（已实测核对）：
 * ```
 * access_token/refresh_token 原样、expires_at 毫秒字符串、
 * refresh_expires_at = expires_at + (refreshExpiresIn-expiresIn)*1000、
 * domain = access_token 的 iss 主机、user_id = iss 的 sub、
 * enterprise_id = ''（个人版）、account_type = 'personal'、无 scope
 * ```
 */

/** 造一个已 base64url 编码的假 JWT（内容任意，只为让 payload 可解）。 */
function fakeJwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`
}

/** 一条典型的第三方记录（字段取自用户真实文件）。 */
function foreignRecord(overrides = {}) {
  const accessToken = fakeJwt({
    iss: 'https://www.codebuddy.cn/auth/realms/copilot',
    sub: '30317387-39ee-4130-a01c-ee58f9f3c46a',
    exp: 1795442580,
  })
  const refreshToken = fakeJwt({ exp: 1795874579 })
  return {
    id: 'codebuddy_cn_3312275cb7a5bac360f99ec6d1085997',
    email: '17030827532',
    uid: '30317387-39ee-4130-a01c-ee58f9f3c46a',
    nickname: '17030827532',
    tags: ['淘宝1'],
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_at: 1795442580022,
    auth_raw: { accessToken, refreshToken, expiresIn: 4752000, refreshExpiresIn: 5184000, tokenType: 'Bearer' },
    created_at: 1790673660,
    payment_type: 'free',
    ...overrides,
  }
}

describe('decodeJwtPayload', () => {
  it('解出 payload 里的声明', () => {
    const token = fakeJwt({ iss: 'https://a.example/x', sub: 'u-1' })
    expect(decodeJwtPayload(token)).toMatchObject({ iss: 'https://a.example/x', sub: 'u-1' })
  })

  it('非 token / 坏 base64 返回 undefined（不抛错）', () => {
    expect(decodeJwtPayload(undefined)).toBeUndefined()
    expect(decodeJwtPayload('not-a-jwt')).toBeUndefined()
    expect(decodeJwtPayload('a.!!!not-base64!!!.c')).toBeUndefined()
  })

  it('正确解码非 ASCII（昵称/中文声明不能变乱码）', () => {
    const token = fakeJwt({ name: '稳重如山' })
    expect(decodeJwtPayload(token).name).toBe('稳重如山')
  })
})

describe('stableShortId', () => {
  it('同输入同输出（可重复导入而不产生重复账号）', () => {
    expect(stableShortId('buddy:uid-1')).toBe(stableShortId('buddy:uid-1'))
  })

  it('不同输入不同输出', () => {
    expect(stableShortId('buddy:uid-1')).not.toBe(stableShortId('buddy:uid-2'))
  })

  it('恒为 8 位 hex（与插件自己生成的 id 形态一致）', () => {
    for (const input of ['a', '', 'buddy:30317387-39ee-4130-a01c-ee58f9f3c46a', '很长的中文输入'.repeat(20)]) {
      expect(stableShortId(input)).toMatch(/^[0-9a-f]{8}$/)
    }
  })
})

describe('providerFromIssuer', () => {
  it('CodeBuddy 中国版 realm → buddy', () => {
    expect(providerFromIssuer('https://www.codebuddy.cn/auth/realms/copilot')).toBe('buddy')
    expect(providerFromIssuer('https://copilot.tencent.com/auth/realms/copilot')).toBe('buddy')
  })

  it('WorkBuddy 国际版 realm → workbuddy（不能认错端点）', () => {
    expect(providerFromIssuer('https://www.workbuddy.ai/auth/realms/copilot')).toBe('workbuddy')
  })

  it('认不出时保守回落 buddy', () => {
    expect(providerFromIssuer(undefined)).toBe('buddy')
    expect(providerFromIssuer('')).toBe('buddy')
  })
})

describe('deriveRefreshExpiresAt', () => {
  it('优先用记录里直接给的值', () => {
    expect(deriveRefreshExpiresAt({ refresh_expires_at: 123 }, '100')).toBe('123')
    expect(deriveRefreshExpiresAt({ refreshExpiresAt: '456' }, '100')).toBe('456')
  })

  /** ⚠️ 这条公式是与本机真实凭据逐毫秒对上的那个（差值 432000000ms）。 */
  it('由 auth_raw 的 expiresIn/refreshExpiresIn 差值补算', () => {
    const record = { auth_raw: { expiresIn: 4752000, refreshExpiresIn: 5184000 } }
    // (5184000 - 4752000) * 1000 = 432000000
    expect(deriveRefreshExpiresAt(record, '1795442580022')).toBe('1795874580022')
  })

  it('退回 refresh_token 自身的 JWT exp（秒 → 毫秒）', () => {
    const record = { refresh_token: fakeJwt({ exp: 1795874579 }) }
    expect(deriveRefreshExpiresAt(record, '1795442580022')).toBe('1795874579000')
  })

  it('都取不到时返回 undefined（缺它不影响凭据可用）', () => {
    expect(deriveRefreshExpiresAt({}, '100')).toBeUndefined()
    expect(deriveRefreshExpiresAt({}, undefined)).toBeUndefined()
  })
})

describe('looksLikeForeignAccountList', () => {
  it('裸数组且含令牌 → true', () => {
    expect(looksLikeForeignAccountList([foreignRecord()])).toBe(true)
  })

  it('包装成 { accounts: [...] } / { data: [...] } 也认', () => {
    expect(looksLikeForeignAccountList({ accounts: [foreignRecord()] })).toBe(true)
    expect(looksLikeForeignAccountList({ data: [foreignRecord()] })).toBe(true)
  })

  /** ⚠️ 本插件备份里 credentials 也是对象，必须靠 format 排除，不能误判。 */
  it('本插件自己的备份 → false（认 format 标记）', () => {
    expect(looksLikeForeignAccountList({
      format: 'dsh-codearts-auth/backup',
      version: 1,
      accounts: [],
      credentials: { BUDDY_ACCOUNT_X: '{"access_token":"a","refresh_token":"r"}' },
    })).toBe(false)
  })

  it('账号数组里全是没有令牌的条目 → false（不误吞无关 JSON）', () => {
    expect(looksLikeForeignAccountList([{ id: 'a', nickname: 'b' }])).toBe(false)
    expect(looksLikeForeignAccountList({ accounts: [{ id: 'a' }] })).toBe(false)
    expect(looksLikeForeignAccountList({})).toBe(false)
    expect(looksLikeForeignAccountList(null)).toBe(false)
    expect(looksLikeForeignAccountList('[]')).toBe(false)
  })
})

describe('convertForeignAccounts', () => {
  it('把第三方列表转成合法的插件备份载荷', () => {
    const result = convertForeignAccounts([foreignRecord()])
    expect(result).not.toBeNull()
    const { payload } = result
    expect(payload.format).toBe('dsh-codearts-auth/backup')
    expect(payload.version).toBe(1)
    expect(payload.accounts).toHaveLength(1)
    expect(payload.disabledModels).toEqual({})
    // ⚠️ 不带锁定表：合并导入要「保持当前值」，不能借这份载荷去改锁定状态。
    expect(payload.permanentLocks).toBeUndefined()
    expect(result.providers).toEqual(['buddy'])
  })

  it('凭据与真实登录产物同构（domain/user_id/企业字段/无 scope）', () => {
    const { payload } = convertForeignAccounts([foreignRecord()])
    const ref = payload.accounts[0].credentialRef
    const credential = JSON.parse(payload.credentials[ref])
    expect(credential.access_token).toBe(foreignRecord().access_token)
    expect(credential.refresh_token).toBe(foreignRecord().refresh_token)
    // expires_at 统一成**字符串**毫秒（与真实凭据一致）
    expect(credential.expires_at).toBe('1795442580022')
    expect(credential.refresh_expires_at).toBe('1795874580022')
    expect(credential.token_type).toBe('Bearer')
    // domain / user_id 由 access_token 的 JWT 推出（实测与真实凭据一致）
    expect(credential.domain).toBe('www.codebuddy.cn')
    expect(credential.user_id).toBe('30317387-39ee-4130-a01c-ee58f9f3c46a')
    expect(credential.nickname).toBe('17030827532')
    expect(credential.enterprise_id).toBe('')
    expect(credential.account_type).toBe('personal')
    // 真实凭据里有 scope，但插件从不读它，且第三方没有 → 不猜。
    expect(credential.scope).toBeUndefined()
  })

  it('账号条目字段齐备（含 expiresAt 与 refreshable）', () => {
    const { payload } = convertForeignAccounts([foreignRecord()])
    const entry = payload.accounts[0]
    expect(entry.id).toMatch(/^buddy-[0-9a-f]{8}$/)
    expect(entry.provider).toBe('buddy')
    expect(entry.credentialRef).toMatch(/^BUDDY_ACCOUNT_[0-9A-F]{8}$/)
    expect(entry.expiresAt).toBe(1795442580022)
    expect(entry.refreshable).toBe(true)
    // created_at 是**秒**，必须换算成毫秒
    expect(entry.createdAt).toBe(1790673660000)
  })

  it('同一份文件转两次得到完全相同的 id（重复导入会全被判重）', () => {
    const a = convertForeignAccounts([foreignRecord()])
    const b = convertForeignAccounts([foreignRecord()])
    expect(a.payload.accounts[0].id).toBe(b.payload.accounts[0].id)
    expect(Object.keys(a.payload.credentials)).toEqual(Object.keys(b.payload.credentials))
  })

  it('跳过没有令牌的坏条目并记 warning，不中断整份转换', () => {
    const result = convertForeignAccounts([
      foreignRecord(),
      { id: 'x', nickname: '坏的' },
      foreignRecord({ uid: 'other-uid', nickname: '第二个' }),
    ])
    expect(result.payload.accounts).toHaveLength(2)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('第 2 条')
  })

  it('同 uid 重复出现时分配独立 id（文件里粘了两遍同一个人）', () => {
    const result = convertForeignAccounts([foreignRecord(), foreignRecord()])
    expect(result.payload.accounts).toHaveLength(2)
    expect(result.payload.accounts[0].id).not.toBe(result.payload.accounts[1].id)
    expect(result.warnings.some((w) => w.includes('重复'))).toBe(true)
  })

  it('WorkBuddy 记录转成 workbuddy provider（端点不能认错）', () => {
    const accessToken = fakeJwt({ iss: 'https://www.workbuddy.ai/auth/realms/copilot', sub: 'wb-1' })
    const result = convertForeignAccounts([foreignRecord({
      access_token: accessToken,
      refresh_token: fakeJwt({ exp: 1 }),
      auth_raw: { accessToken, expiresIn: 1, refreshExpiresIn: 2 },
    })])
    expect(result.payload.accounts[0].provider).toBe('workbuddy')
    expect(result.payload.accounts[0].id).toMatch(/^workbuddy-/)
    expect(result.providers).toEqual(['workbuddy'])
  })

  it('包装对象（{ accounts }）里的数组同样能转', () => {
    const result = convertForeignAccounts({ accounts: [foreignRecord()] })
    expect(result.payload.accounts).toHaveLength(1)
  })

  it('不是第三方列表时返回 null（调用方据此走原路径）', () => {
    expect(convertForeignAccounts(null)).toBeNull()
    expect(convertForeignAccounts({})).toBeNull()
    expect(convertForeignAccounts({ format: 'dsh-codearts-auth/backup', accounts: [], credentials: {} })).toBeNull()
  })

  it('空数组 → 转出空载荷（而不是 null，让上层能提示「里面没有账号」）', () => {
    const result = convertForeignAccounts([])
    expect(result).not.toBeNull()
    expect(result.payload.accounts).toEqual([])
  })

  it('缺 expires_at 时不硬编造该字段', () => {
    const result = convertForeignAccounts([foreignRecord({ expires_at: undefined })])
    const ref = result.payload.accounts[0].credentialRef
    expect(JSON.parse(result.payload.credentials[ref]).expires_at).toBeUndefined()
    expect(result.payload.accounts[0].expiresAt).toBeUndefined()
  })
})
