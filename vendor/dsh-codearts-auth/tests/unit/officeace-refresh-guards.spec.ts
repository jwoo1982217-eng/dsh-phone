/**
 * `officeace-refresh-guards.spec.ts` —— OfficeAce 续期路径的三条硬约束。
 *
 * ## 为什么需要这个文件（2026-10-13 审计）
 *
 * `officeace-auth.ts` 的模块头自己写着「`refresh_token` **一次性**」，
 * 且 `doRefreshCredential` 的失败分支打印「若报 STS5.1806 已被消费，
 * 必须重新登录」—— 但实现上：
 *
 * 1. `refreshAccountCredential`（**生产主路径**：`refreshAll` / 适配器 401 兜底 /
 *    `account.refresh` RPC / 积分自愈全走它）**直连** `doRefreshCredential`，
 *    原先只有 `refreshStoredCredential` 那条**兼容文件**腿有 in-flight 闸
 *    ⇒ **加了锁但加错了一条腿**，并发照样烧 token；
 * 2. 它**无任何过期判据** ⇒ 定时器每 30 分钟对每个账号发一次续期，
 *    一天 48 个一次性 token（STS 寿命约 2 小时，根本不需要这么频繁）；
 * 3. 续期失败时**不回读凭据** ⇒ 并发下把「他处已续成功」误判成本账号失效。
 *
 * 三条都属 AGENTS.md 记过的「codearts 单向门」同型事故。
 * 本文件逐条锁死，并**逐条做过反向验证**（改坏实现 → 对应用例变红）。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { webcrypto } from 'node:crypto'
import * as officeaceAuth from '../../src/officeace-auth.js'
import type { OfficeAceCredential } from '../../src/officeace-auth.js'

/**
 * ⚠️ **必须用真实的 P-256 密钥对**（不能写 `'x'/'y'/'d'` 这种占位）：
 * `doRefreshCredential` 会拿 `dpopPrivateJwk` 真的去 `importKey` 签 DPoP
 * proof，而 WebCrypto 对占位 JWK 抛 `Invalid JWK EC key`。
 * 这也顺带让本文件覆盖到「续期时用的是**同一把**已持久化的私钥」这条真实路径。
 */
let realJwkPromise: Promise<{ kty: string; crv: string; x: string; y: string; d: string }> | undefined
function realJwk(): Promise<{ kty: string; crv: string; x: string; y: string; d: string }> {
  realJwkPromise ??= webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ).then(async (pair) => {
    const jwk = await webcrypto.subtle.exportKey('jwk', (pair as CryptoKeyPair).privateKey)
    return { kty: jwk.kty ?? 'EC', crv: jwk.crv ?? 'P-256', x: jwk.x ?? '', y: jwk.y ?? '', d: jwk.d ?? '' }
  })
  return realJwkPromise
}

/** 造一份结构完整的凭据（只需本文件关心的字段是真值）。 */
async function makeCredential(overrides: Partial<OfficeAceCredential> = {}): Promise<OfficeAceCredential> {
  return {
    modelAppKey: 'ak',
    modelAppSecret: 'sk',
    maasBaseUrl: 'https://example.invalid',
    access: 'access-key',
    secret: 'secret-key',
    securityToken: 'sts-token',
    projectId: 'proj',
    // 默认给一个「还有 10 分钟就过期」的 STS —— 落在 lead-time 窗口内。
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    refreshToken: 'refresh-1',
    dpopPrivateJwk: await realJwk(),
    ...overrides,
  }
}

/** 内存凭据库（实现本文件需要的最小 `CredentialStore` 形状）。 */
function makeStore(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial))
  const set = vi.fn(async (ref: string, value: string) => { map.set(ref, value) })
  const store = {
    resolve: async (ref: string) => {
      const value = map.get(ref)
      return value === undefined ? undefined : { value }
    },
    set,
    map,
  }
  return store
}

/** 记录调用次数的池替身（`writebackExpiry` 只需要 `updateAccount`）。 */
function makePool() {
  const updateAccount = vi.fn(async () => {})
  return { updateAccount, pool: { updateAccount } }
}

const savedFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = savedFetch
  vi.restoreAllMocks()
})

describe('OfficeAce 续期：lead-time 判据（不在有效期内就不烧一次性 token）', () => {
  it('凭据还有 2 小时才过期 ⇒ 一个请求都不发（只对账池值）', async () => {
    const credential = await makeCredential({
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    })
    const store = makeStore({ 'OFFICEACE_ACCOUNT_A': JSON.stringify(credential) })
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as never
    const { updateAccount, pool } = makePool()

    await officeaceAuth.refreshAccountCredential('OFFICEACE_ACCOUNT_A', pool, 'acct-1', store as never)

    // ⚠️ 这是本用例的核心断言：**零请求**。原实现无条件续期 ⇒ 这里会是 1。
    expect(fetchMock, '距过期还远时不该发续期请求（每 30 分钟烧一个一次性 token）').toHaveBeenCalledTimes(0)
    expect(store.set, '也不该重写凭据').not.toHaveBeenCalled()
    // 「本轮不刷」的分支仍必须对账 —— 否则存量账号的池值永远无人更正。
    expect(updateAccount, '有效期内仍须对账账号池').toHaveBeenCalledTimes(1)
    expect(updateAccount.mock.calls[0]?.[1]).toMatchObject({
      expiresAt: Date.parse(credential.expiresAt),
    })
  })

  it('凭据只剩 10 分钟（落入 lead 窗口）⇒ 真发一次续期并回写池', async () => {
    const renewed = await makeCredential({
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      refreshToken: 'refresh-2',
    })
    const store = makeStore({ 'OFFICEACE_ACCOUNT_B': JSON.stringify(await makeCredential()) })
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/oauth2/tokens')) {
        return new Response(JSON.stringify({
          credentials: {
            access_key_id: 'access-key',
            secret_access_key: 'secret-key',
            security_token: 'sts-token',
            project_id: 'proj',
            expiration: renewed.expiresAt,
          },
          refresh_token: renewed.refreshToken,
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    globalThis.fetch = fetchMock as never
    const { updateAccount, pool } = makePool()

    await officeaceAuth.refreshAccountCredential('OFFICEACE_ACCOUNT_B', pool, 'acct-2', store as never)

    expect(fetchMock, '临期时必须真续期').toHaveBeenCalled()
    expect(store.set, '续期成功必须落盘新 token').toHaveBeenCalledTimes(1)
    expect(updateAccount, '续期成功必须回写池').toHaveBeenCalledTimes(1)
  })
})

describe('OfficeAce 续期：per-ref 串行（并发不得烧掉两个一次性 token）', () => {
  it('同一 ref 并发两次续期 ⇒ 只发一次 STS 请求（后到者等前者的结果）', async () => {
    const credential = await makeCredential({ refreshToken: 'refresh-1' })
    const store = makeStore({ 'OFFICEACE_ACCOUNT_C': JSON.stringify(credential) })
    let tokenCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/oauth2/tokens')) {
        tokenCalls += 1
        return new Response(JSON.stringify({
          credentials: {
            access_key_id: 'access-key',
            secret_access_key: 'secret-key',
            security_token: 'sts-token',
            project_id: 'proj',
            expiration: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          },
          refresh_token: 'refresh-2',
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    globalThis.fetch = fetchMock as never
    const { pool } = makePool()

    await Promise.all([
      officeaceAuth.refreshAccountCredential('OFFICEACE_ACCOUNT_C', pool, 'acct-3', store as never),
      officeaceAuth.refreshAccountCredential('OFFICEACE_ACCOUNT_C', pool, 'acct-3', store as never),
    ])

    // ⚠️ 原实现下这里是 **2**（两次并发消费同一份一次性 token，
    //    后到者拿 STS5.1806；若先到者写盘前被打断，新 token 永久丢失）。
    expect(tokenCalls, '同一 ref 的并发续期必须被串行成一次').toBe(1)
  })
})

describe('OfficeAce 续期：判终态前重读（他处已续成功不得误判为本账号失效）', () => {
  it('续期被拒、但磁盘上 refresh_token 已换新且未过期 ⇒ 用最新凭据对账，不发终态', async () => {
    // 本次尝试用的是**旧** token；等请求发出期间，「别处」已经续过一次。
    const stale = await makeCredential({ refreshToken: 'refresh-OLD' })
    const fresh = await makeCredential({
      refreshToken: 'refresh-NEW',
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    })
    const store = makeStore({ 'OFFICEACE_ACCOUNT_D': JSON.stringify(stale) })
    const { updateAccount, pool } = makePool()

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/oauth2/tokens')) {
        // 模拟「服务端拒了旧 token」的同时，另一条入口已把新 token 写进凭据库。
        store.map.set('OFFICEACE_ACCOUNT_D', JSON.stringify(fresh))
        return new Response('{"error":"STS5.1806 has been used"}', { status: 400 })
      }
      return new Response('{}', { status: 200 })
    })
    globalThis.fetch = fetchMock as never

    await officeaceAuth.refreshAccountCredential('OFFICEACE_ACCOUNT_D', pool, 'acct-4', store as never)

    // ⚠️ 判据不是「有没有失败」，而是「**有没有更新且可用**的凭据」——
    //    少这一层会把好账号永久标死，用户只能重新登录。
    expect(updateAccount, '他处已续成功时应改用最新凭据对账').toHaveBeenCalledTimes(1)
    expect(updateAccount.mock.calls[0]?.[1]).toMatchObject({
      expiresAt: Date.parse(fresh.expiresAt),
    })
  })

  it('真终态（磁盘上还是同一份 token）⇒ 不对账、不写池', async () => {
    const credential = await makeCredential({ refreshToken: 'refresh-OLD' })
    const store = makeStore({ 'OFFICEACE_ACCOUNT_E': JSON.stringify(credential) })
    const { updateAccount, pool } = makePool()
    globalThis.fetch = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as never

    await officeaceAuth.refreshAccountCredential('OFFICEACE_ACCOUNT_E', pool, 'acct-5', store as never)

    // ⚠️ 真终态下**不得**用一份已过期的旧值覆盖池里的信息
    //    （`updateAccount` 落盘时 `undefined` 会被 `JSON.stringify` 丢弃，
    //    写 NaN 会让卡片误显示「已过期」—— 两者都比保留旧值更糟）。
    expect(updateAccount).not.toHaveBeenCalled()
  })
})
