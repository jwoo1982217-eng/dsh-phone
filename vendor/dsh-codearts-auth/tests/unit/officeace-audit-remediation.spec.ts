/**
 * `officeace-audit-remediation.spec.ts` —— **独立审计 + 红队对抗审计**打穿后的守卫
 * （2026-10-17；审计对象 = 提交 `a86b7a5`，本文件锁的是整改后的行为）。
 *
 * ## 为什么单独成文件
 *
 * 这四条缺陷**都不是作者自查发现的**，而是审计方（另一个 agent，独立上下文 +
 * `git archive` 隔离副本）用可复现探针打穿的。它们的共同形态是
 * **「不可逆操作建立在间接证据上」**，故判据必须逐格钉死、且要防**反方向**的过度修复。
 *
 * | # | 缺陷 | 来源 | 修前实测 |
 * |---|---|---|---|
 * | P0-3 | `poolEntryOf === 'unknown'` 被当成「确证没有凭据」⇒ 删健康账号 | 常规审计 | 条目 0、凭据键 `[]` |
 * | P2 | 重复登录命中**已停用**原卡 ⇒ 新卡也停用 ⇒ **零可用卡却报成功** | 常规审计 | 可用卡数 0，poll `{done:true,success:true}` |
 * | P5 | `pending` 是**进程内** Map，另一进程的在途登录被恒判「已中止」 | 红队 | 结构必然（未做双进程实测） |
 * | P2′ | 面板把**两天前的快照**当实时余额且**不标注**（折算层却判 UNUSABLE） | 常规审计 | total 6493.32 且 `error === undefined` |
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

const home = process.env.DSH_OFFICEACE_HOME as string

function credentialOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelAppKey: 'K', modelAppSecret: 'S', maasBaseUrl: 'https://officeace.example',
    access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'R',
    dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    accountId: 'acct-X', ...overrides,
  }
}

interface CtxBundle {
  ctx: Context
  store: Map<string, string>
  handler: () => ((req: Request) => Promise<Response>) | undefined
}

function makeCtx(store: Map<string, string>, opts: { findAccountThrows?: boolean } = {}): CtxBundle {
  const ctx = new Context()
  ;(ctx as unknown as Record<string, unknown>).logger = {
    warn: () => {}, info: () => {}, error: () => {}, debug: () => {},
  }
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const v = store.get(ref)
      return v === undefined ? undefined : { value: v, source: 'fake' }
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
    describe() { return [] },
  } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject =
    (_d: string[], cb: (c: unknown) => void) => cb(ctx)
  ;(ctx as unknown as Record<string, unknown>).__findAccountThrows = opts.findAccountThrows === true
  return { ctx, store, handler: () => handler }
}

function makeCall(h: (req: Request) => Promise<Response>) {
  return async (method: string, payload: unknown) =>
    (await (await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'jet-hub', payload: { method, payload } }),
    }))).json() as { result: { ok: boolean; value?: any } }).result
}

describe('审计整改 · P0-3：读不到账号池 ≠ 确证没有凭据', () => {
  beforeEach(() => { rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true }) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('`findAccount` 抛错 ⇒ 收口不得删账号（一次凭据都没读到 ⇒ 无法确证）', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    try {
      const store = new Map<string, string>()
      const { ctx, handler } = makeCtx(store)
      const pool = new AccountPool(ctx)
      registerJetHubRpc(ctx, pool, { officeace: {} as never } as never, undefined)
      const call = makeCall(handler()!)

      const REF = 'OFFICEACE_ACCOUNT_HEALTHY'
      await pool.addAccount({
        id: 'officeace-healthy', provider: 'officeace', nickname: '健康账号',
        enabled: true, credentialRef: REF, refreshable: true, createdAt: Date.now(),
      })
      store.set(REF, JSON.stringify(credentialOf()))

      // ⚠️ 让 `findAccount` 抛错（`listAllAccounts` 仍正常）⇒ `poolEntryOf` 返回 `'unknown'`
      const spy = vi.spyOn(pool, 'findAccount').mockImplementation(() => { throw new Error('读池抖动') })
      try {
        await call('account.list', { provider: 'officeace' })
      } finally {
        spy.mockRestore()
      }

      expect(
        pool.listAccountsByProvider('officeace'),
        '池读不到 ⇒ 连该查哪个 ref 都不知道 ⇒ 必须判「无法确证」，不得走不可逆删除',
      ).toHaveLength(1)
      expect(store.get(REF), '凭据也绝不能被连带 unset').toBeDefined()
    } finally {
      delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
    }
  })
})

describe('审计整改 · P2：重复登录命中「已停用」原卡', () => {
  beforeEach(() => { rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true }) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('原卡已停用时同号重登 ⇒ **必须留下可用卡**（不得零可用卡却报成功）', async () => {
    const store = new Map<string, string>()
    const { ctx, handler } = makeCtx(store)
    const pool = new AccountPool(ctx)
    const officeace = {
      startLogin: async () => ({
        authorizeUrl: 'https://auth.huaweicloud.com/stub', state: 's',
        _internal: { codeVerifier: 'v', dpopPrivateJwk: credentialOf().dpopPrivateJwk },
      }),
      pollLoginCode: async () => 'code',
      completeLogin: async () => credentialOf({ accountId: 'same-cloud-id' }),
      persistLogin: async (
        cred: Record<string, unknown>,
        opts: { refName: string; credentials: { set(r: string, v: string): Promise<void> } },
      ) => {
        await opts.credentials.set(opts.refName, JSON.stringify(cred))
        return { accountId: cred.accountId }
      },
    }
    registerJetHubRpc(ctx, pool, { officeace: officeace as never } as never, undefined)
    const call = makeCall(handler()!)

    // 第一次登录 → 手动停用那张卡（既有语义：不参与自动选号）
    const first = await call('account.create', { provider: 'officeace' })
    const firstId = first.value.accountId as string
    await call('login.poll', { accountId: firstId })
    await pool.updateAccount(firstId, { enabled: false })

    // 第二次登录同一个云侧号
    const second = await call('account.create', { provider: 'officeace' })
    const secondId = second.value.accountId as string
    const polled = await call('login.poll', { accountId: secondId })
    expect(polled.value?.success).toBe(true)

    const accounts = pool.listAccountsByProvider('officeace')
    const usable = accounts.filter((a) => a.enabled)
    expect(
      usable.length,
      '零可用卡却报登录成功 ⇒ 用户以为登好了，实际该渠道没有可用账号（唯一账号时整组从模型选择器消失）',
    ).toBeGreaterThanOrEqual(1)
    expect(accounts.find((a) => a.id === secondId)?.enabled, '新卡（本次登录刚换成凭据的那张）应当可用').toBe(true)
  })
})

describe('审计整改 · P5：跨进程在途登录（池条目 `createdAt` 兜底）', () => {
  beforeEach(() => { rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true }) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('本进程**没有** pending，但条目是刚建出来的 ⇒ 不得收口（视作另一进程在途）', async () => {
    // ⚠️ 这是**结构性**守卫：`pendingOfficeAceState` 是进程内 Map，而池/凭据同机共享
    //   （AGENTS.md 声明 dsh web 与 desktop 两实例并存）⇒ 另一进程刚建的占位条目
    //   在本进程看来「pending 缺失」，旧判据恒判「已中止」，窗口是整个登录等待期。
    //   本用例模拟「另一个进程刚建的条目」：直接写进池、**不**建本进程 pending。
    const store = new Map<string, string>()
    const { ctx, handler } = makeCtx(store)
    const pool = new AccountPool(ctx)
    registerJetHubRpc(ctx, pool, { officeace: {} as never } as never, undefined)
    const call = makeCall(handler()!)

    await pool.addAccount({
      id: 'officeace-other-proc', provider: 'officeace', nickname: 'officeace-other-proc',
      enabled: true, credentialRef: 'OFFICEACE_ACCOUNT_OTHERPROC',
      refreshable: false, createdAt: Date.now(),      // ← 刚建出来
    })

    await call('account.list', { provider: 'officeace' })

    expect(
      pool.listAccountsByProvider('officeace'),
      '本进程看不到 pending 不等于「用户已中止」—— 它可能正被**另一个进程**的登录使用',
    ).toHaveLength(1)
  })

  it('但**年老**的残留（createdAt 早于 TTL）仍必须被收口（不得让收口永久失效）', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    try {
      const store = new Map<string, string>()
      const { ctx, handler } = makeCtx(store)
      const pool = new AccountPool(ctx)
      registerJetHubRpc(ctx, pool, { officeace: {} as never } as never, undefined)
      const call = makeCall(handler()!)

      await pool.addAccount({
        id: 'officeace-stale-ghost', provider: 'officeace', nickname: 'officeace-stale-ghost',
        enabled: true, credentialRef: 'OFFICEACE_ACCOUNT_STALEGHOST',
        refreshable: false, createdAt: Date.now() - 3_600_000,   // ← 一小时前
      })

      await call('account.list', { provider: 'officeace' })
      expect(
        pool.listAccountsByProvider('officeace'),
        '跨进程兜底只该保护「刚建的」；年老且无凭据的残留必须照常收口',
      ).toHaveLength(0)
    } finally {
      delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
    }
  })
})

describe('审计整改 · P2′：面板不得把陈旧快照当实时余额（无标注）', () => {
  beforeEach(() => { rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true }) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('读数 `stale === true` ⇒ 余额可照常回传，但**必须**带 `error` 标注', async () => {
    const store = new Map<string, string>()
    const { ctx, handler } = makeCtx(store)
    const pool = new AccountPool(ctx)
    const officeace = {
      fetchSubscriptionSummary: async () => ({
        planName: 'x', totalCredits: 6493.32, usedCredits: 0,
        creditGroups: [{ name: 'g', remaining: 6493.32, total: 6493.32, used: 0, expired: false }],
        stale: true,
      }),
    }
    registerJetHubRpc(ctx, pool, { officeace: officeace as never } as never, undefined)
    const call = makeCall(handler()!)

    const REF = 'OFFICEACE_ACCOUNT_STALE'
    await pool.addAccount({
      id: 'officeace-stale', provider: 'officeace', nickname: 'officeace-stale',
      enabled: true, credentialRef: REF, refreshable: true, createdAt: Date.now(),
    })
    store.set(REF, JSON.stringify(credentialOf()))

    const res = await call('credits.balances', { provider: 'officeace' })
    const row = (res.value?.accounts ?? [])[0]
    expect(row?.balance?.total, '陈旧数据照样展示（用户宁可看到旧数字也不要空白）').toBe(6493.32)
    expect(
      row?.error,
      '把两天前的快照当实时余额显示且不标注 —— 与同 PR 折算层「stale ⇒ UNUSABLE」的口径相反',
    ).toBeDefined()
  })
})
