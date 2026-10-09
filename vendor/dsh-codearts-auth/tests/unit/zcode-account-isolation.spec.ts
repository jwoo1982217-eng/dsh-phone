/**
 * ZCode **多账号凭据隔离**的回归测试（真实缺陷，2026-10-02）。
 *
 * ## 用户报障
 *
 * > 登录了 2 个账号（两个不同微信各自收到 bigmodel 登录通知）。
 * > 第二个账号有余额，但**插件里刷新积分显示 0**、发消息报
 * > 「额度已用尽」；而 **IDE 里同一个账号发消息能收到回复**。
 *
 * ## 根因（实测证据）
 *
 * `refreshAll()` 与 `refreshAccountCredential()` 都拿 `this.current()` 的结果
 * **无条件写回目标 ref** —— 而 `current()` 只返回**池里第一个凭据可用的账号**。
 * 于是账号 A 的凭据被写进账号 B 的 ref，**B 的原始凭据被永久覆盖**。
 *
 * 用户机器 `~/.dsh/.credentials.yaml` 的实测：两个条目的
 * `zcode_jwt` sha256、`device_mid`、`account_label`（同一昵称）、
 * `bigmodel_access_token` **全部逐字节相同** —— 同一账号占了两条。
 * ⚠ 此处不写真实值（昵称是用户的微信账号名、device_mid 是设备标识）。
 *
 * 症状之所以像服务端问题：IDE 用它自己那份真实凭据（B）→ 正常；
 * 插件池里两条都是 A → A 已耗尽 → 报额度用尽。
 *
 * ## 本文件锁住什么
 *
 * **「A 的凭据绝不允许写进 B 的 ref」** —— 这是数据完整性的底线，
 * 比任何「把字段补齐」的便利都重要。
 *
 * ⚠ 反向验证：把 `refreshAll` 改回「`current()` 一次然后写全部」⇒
 * 第 1、2 条变红。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { ZcodeCredential } from '../../src/zcode.js'

function makeCtx(): Context {
  const ctx = new Context()
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  return ctx
}

/** 两个**不同**的账号凭据（用 label/jwt 区分）。 */
const CRED_A: ZcodeCredential = {
  zcode_jwt: 'jwt-AAAA.aaaa.aaaa',
  device_mid: 'mid-A',
  account_label: 'account-A',
  source: 'plugin',
}
const CRED_B: ZcodeCredential = {
  zcode_jwt: 'jwt-BBBB.bbbb.bbbb',
  device_mid: 'mid-B',
  account_label: 'account-B',
  source: 'plugin',
}

/** 内存版 credentials + 账号池桩。 */
function makeHarness(initial: Record<string, ZcodeCredential>): {
  auth: ZcodeAuth
  store: Map<string, string>
  pool: never
  writes: string[]
} {
  const store = new Map<string, string>(
    Object.entries(initial).map(([ref, c]) => [ref, JSON.stringify(c)]),
  )
  const writes: string[] = []
  const ctx = makeCtx()
  // `credentials` 是 ctx 上的服务；用属性注入替换成内存实现。
  ;(ctx as unknown as { credentials: unknown }).credentials = {
    resolve: async (ref: { toString(): string }) => {
      const value = store.get(String(ref))
      return value === undefined ? undefined : { value }
    },
    set: async (ref: { toString(): string }, value: string) => {
      writes.push(String(ref))
      store.set(String(ref), value)
    },
  }

  const accounts = [
    { id: 'acct-A', provider: ZCODE.id, credentialRef: 'ZCODE_ACCOUNT_AAA', enabled: true, refreshable: false },
    { id: 'acct-B', provider: ZCODE.id, credentialRef: 'ZCODE_ACCOUNT_BBB', enabled: true, refreshable: false },
  ]
  const pool = {
    listAccountsByProvider: () => accounts,
    listAccounts: async () => accounts,
  }

  const auth = new ZcodeAuth(ctx, {
    fetchImpl: (async () => { throw new Error('no network') }) as never,
    readCredential: () => undefined,
    accountPool: pool as never,
  })
  return { auth, store, pool: pool as never, writes }
}

describe('ZCode 多账号凭据隔离（真实缺陷回归）', () => {
  it('★★ refreshAll 绝不把 A 的凭据写进 B（数据完整性底线）', async () => {
    const { auth, store, pool } = makeHarness({
      ZCODE_ACCOUNT_AAA: CRED_A,
      ZCODE_ACCOUNT_BBB: CRED_B,
    })

    await auth.refreshAll(pool)

    /**
     * ★ 核心断言：B 的 ref 里必须**仍然是 B 自己的**凭据。
     * 旧实现这里会是 A（因为 `current()` 先返回 A，然后覆盖全部）。
     */
    const b = JSON.parse(store.get('ZCODE_ACCOUNT_BBB') ?? '{}') as ZcodeCredential
    expect(b.zcode_jwt).toBe(CRED_B.zcode_jwt)
    expect(b.account_label).toBe('account-B')
    expect(b.device_mid).toBe('mid-B')

    // A 也不受影响。
    const a = JSON.parse(store.get('ZCODE_ACCOUNT_AAA') ?? '{}') as ZcodeCredential
    expect(a.zcode_jwt).toBe(CRED_A.zcode_jwt)
  })

  it('★★ 账号池顺序颠倒时同样不串（不能靠「第一个恰好是自己」蒙对）', async () => {
    const { auth, store } = makeHarness({
      ZCODE_ACCOUNT_AAA: CRED_A,
      ZCODE_ACCOUNT_BBB: CRED_B,
    })
    // 池里 B 排在前面 —— 旧实现会把 B 的凭据写进 A。
    const reversedPool = {
      listAccountsByProvider: () => [
        { id: 'acct-B', provider: ZCODE.id, credentialRef: 'ZCODE_ACCOUNT_BBB', enabled: true, refreshable: false },
        { id: 'acct-A', provider: ZCODE.id, credentialRef: 'ZCODE_ACCOUNT_AAA', enabled: true, refreshable: false },
      ],
    }

    await auth.refreshAll(reversedPool as never)

    const a = JSON.parse(store.get('ZCODE_ACCOUNT_AAA') ?? '{}') as ZcodeCredential
    expect(a.zcode_jwt).toBe(CRED_A.zcode_jwt)
    expect(a.account_label).toBe('account-A')
  })

  it('★ 某账号凭据不可用时**跳过**，不拿别的账号去补它', async () => {
    const { auth, store, pool } = makeHarness({
      ZCODE_ACCOUNT_AAA: CRED_A,
      // BBB 不存在（模拟损坏/被清空）
    })

    await auth.refreshAll(pool)

    // ★ 关键：B 的 ref **不得**出现 A 的凭据（旧实现会填上 A）。
    expect(store.has('ZCODE_ACCOUNT_BBB')).toBe(false)
    // A 自己正常。
    expect(JSON.parse(store.get('ZCODE_ACCOUNT_AAA') ?? '{}').account_label).toBe('account-A')
  })

  it('★★ refreshAccountCredential 只动**目标 ref**，且用目标自己的凭据', async () => {
    const { auth, store, pool } = makeHarness({
      ZCODE_ACCOUNT_AAA: CRED_A,
      ZCODE_ACCOUNT_BBB: CRED_B,
    })

    await auth.refreshAccountCredential('ZCODE_ACCOUNT_BBB', pool, 'acct-B')

    /**
     * ★ 旧实现会写入 `current()` 的凭据（= A），把 B 覆盖掉。
     * 现在必须是 B 自己的（规范化后写回，行为上等价于幂等）。
     */
    const b = JSON.parse(store.get('ZCODE_ACCOUNT_BBB') ?? '{}') as ZcodeCredential
    expect(b.zcode_jwt).toBe(CRED_B.zcode_jwt)
    expect(b.account_label).toBe('account-B')
  })

  it('★ 目标账号凭据损坏时**如实报错**，绝不填别的账号的（宁可失败也不破坏）', async () => {
    const { auth, store, pool } = makeHarness({
      ZCODE_ACCOUNT_AAA: CRED_A,
      // BBB 缺失
    })

    await expect(
      auth.refreshAccountCredential('ZCODE_ACCOUNT_BBB', pool, 'acct-B'),
    ).rejects.toThrow(/不可用或已损坏/)

    // ★ B 的 ref 仍是空的 —— 宁可让用户重新登录，也不写进 A 的凭据。
    expect(store.has('ZCODE_ACCOUNT_BBB')).toBe(false)
  })

  it('★ 单账号失败不影响其余（逐个 try，与 BuddyAuth.refreshAll 同语义）', async () => {
    const { auth, store } = makeHarness({
      ZCODE_ACCOUNT_AAA: CRED_A,
      ZCODE_ACCOUNT_BBB: CRED_B,
    })
    // 池里混入一个会抛错的坏条目。
    const poolWithBad = {
      listAccountsByProvider: () => [
        { id: 'bad', provider: ZCODE.id, credentialRef: 'ZCODE_ACCOUNT_BAD', enabled: true, refreshable: false },
        { id: 'acct-B', provider: ZCODE.id, credentialRef: 'ZCODE_ACCOUNT_BBB', enabled: true, refreshable: false },
      ],
    }
    await auth.refreshAll(poolWithBad as never)

    // 坏条目被跳过，B 仍然正确处理。
    expect(JSON.parse(store.get('ZCODE_ACCOUNT_BBB') ?? '{}').account_label).toBe('account-B')
  })
})
