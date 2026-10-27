/**
 * `officeace-ikm741-abandoned-login.spec.ts` —— Gitee issue IKM741 的守卫。
 *
 * ## issue 是什么（2026-10-16 用户报障）
 *
 * OfficeAce（华为 MaaS）的**账号池与凭据双向脱节**，且**面板积分与凭据状态无关**。
 * 本机实测 4 条账号 + 4 份凭据：3 条「有账号无凭据」、3 条「有凭据无账号」。
 *
 * ## 本文件守的不变量（每条都先实测确证过存在，再修）
 *
 * | # | 不变量 | 修前实测形态 |
 * |---|---|---|
 * | 1 | 按 ref 读凭据**不得**回落到**全局** `session.json` | 库里没有该 ref ⇒ 读到**别的账号**的凭据 |
 * | 2 | 凭据不存在 ⇒ 折算/读数**不得**用历史快照充数 | 报出 6493.32（那是两天前的快照） |
 * | 3 | 用户未完成授权就关窗 ⇒ 占位条目**必须被收口** | 永久残留成「凭据未配置」的幽灵卡片 |
 * | 4 | 但**正在轮询**的登录与**凭据已落库**的账号**绝不能被收口** | ——（这是新代码的安全闸） |
 * | 5 | **有凭据无账号**（B 档孤儿）⇒ 凭据**必须被回收** | 登录落库途中用户删卡片 ⇒ 凭据成孤儿、**永无入口清理** |
 * | 6 | 但**账号仍在**或**读不到池**时 ⇒ 凭据**绝不能被回收** | ——（B 档的安全闸） |
 *
 * ⚠️ 不变量 4 与 3 **同等重要**：删除不可逆（`removeAccount` 连带
 * `credentials.unset`），漏掉 4 会把用户**刚登好的账号**销毁 ——
 * 那是本仓库 `failLogin` 那节记录过的**同型事故**（两轮审计各打穿一次）。
 * 同理 6 与 5：漏掉 6 会在一次读池抖动时删掉用户**刚登好**的凭据。
 *
 * ## 与既有文件的分工
 *
 * - `officeace-refresh-guards.spec.ts`：续期三件套（锁 / lead-time / 判终态前重读）；
 * - `officeace-refresh-all.spec.ts`：批量续期把同步池当 Promise（IKLPTZ）；
 * - 本文件：**登录中止的双向脱节 + 读数与凭据绑定**（IKM741）。
 */

import { Context } from '@deepseek-ai/cordis'
import { webcrypto } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { isAbandonedOfficeAceLogin, officeacePendingTtlMs, registerJetHubRpc, JET_HUB_API_PATH }
  from '../../src/jet-hub-rpc.js'
import { fetchSubscriptionSummary, readCredential } from '../../src/officeace-auth.js'
// ⚠️ 命名空间导入：④e 需要**真实** auth 模块（兼容文件那条腿在它里面）。
import * as officeaceAuth from '../../src/officeace-auth.js'
import { officeaceExpiry } from '../../src/aggregate-expiry.js'

/** 隔离后的 OfficeAce home（`tests/setup-isolation.ts` 进程级设定）。 */
const home = process.env.DSH_OFFICEACE_HOME as string

/** 一份 P-256 私钥 JWK（DPoP 会校验，假 JWK 直接抛 `Invalid keyData`）。 */
let realJwk: Record<string, unknown> = {}
beforeAll(async () => {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  )
  realJwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey) as Record<string, unknown>
})

/** 造一份可用的 OfficeAce 凭据（可指定 `expiresAt` / `refreshToken`）。 */
function credentialOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelAppKey: 'K', modelAppSecret: 'S', maasBaseUrl: 'https://officeace.example',
    access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'R',
    dpopPrivateJwk: realJwk,
    ...overrides,
  }
}

/** 空凭据库：**任何 ref 都读不到**（模拟「该账号的凭据已不存在」）。 */
const emptyStore = {
  resolve: async () => undefined,
  set: async () => {},
  unset: async () => {},
}

describe('IKM741 ①：`readCredential` 的兜底必须带 `ref`（不得读全局 session.json）', () => {
  beforeEach(() => {
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
  })

  it('①a 库里没有该 ref、但**全局** session.json 在 ⇒ 必须 `undefined`（不得串号）', async () => {
    // 全局那份（语义 =「最后一次登录的那个账号」）—— 修前会被当成本账号的凭据。
    writeFileSync(join(home, 'session.json'), JSON.stringify(credentialOf({
      modelAppKey: 'GLOBAL-OTHER-ACCOUNT-KEY', refreshToken: 'GLOBAL-REFRESH-TOKEN',
    })), 'utf8')

    const got = await readCredential('OFFICEACE_ACCOUNT_DEADBEEF', emptyStore)
    expect(
      got,
      '读到了**别的账号**的凭据 ⇒ 这正是 issue IKM741 的根因：'
      + '跨账号烧一次性 refresh_token + 读数串号',
    ).toBeUndefined()
  })

  it('①b 库里没有该 ref、但**本 ref** 的兼容文件在 ⇒ 照常读到它（兼容性不得回退）', async () => {
    writeFileSync(
      join(home, 'session-OFFICEACE_ACCOUNT_MINE.json'),
      JSON.stringify(credentialOf({ modelAppKey: 'MY-OWN-KEY' })),
      'utf8',
    )
    // ⚠️ 同时放一份全局的：修法的判据是「按 ref」，不是「不要兜底」。
    //    全局那份**更早存在**，若实现读错文件本条会读到 `GLOBAL-...`。
    writeFileSync(join(home, 'session.json'), JSON.stringify(credentialOf({
      modelAppKey: 'GLOBAL-OTHER-ACCOUNT-KEY',
    })), 'utf8')

    const got = await readCredential('OFFICEACE_ACCOUNT_MINE', emptyStore)
    expect(got?.modelAppKey, '必须读**本 ref** 的兼容文件').toBe('MY-OWN-KEY')
  })

  it('①c 凭据真的不存在时 ⇒ 续期**一个请求都不发**（不得拿别人的 token 去消费）', async () => {
    writeFileSync(join(home, 'session.json'), JSON.stringify(credentialOf({
      refreshToken: 'GLOBAL-REFRESH-TOKEN',
      // 已过期 ⇒ 若回落全局那份，lead-time 判据会放行、真的发请求。
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    })), 'utf8')

    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ''))
      return new Response('{"error":"STS5.1806 has been used"}', { status: 400 })
    }))
    try {
      const { refreshAccountCredential } = await import('../../src/officeace-auth.js')
      await refreshAccountCredential(
        'OFFICEACE_ACCOUNT_DEADBEEF',
        { updateAccount: async () => {} },
        'officeace-x',
        emptyStore,
      )
    } finally {
      vi.unstubAllGlobals()
    }

    const tokens = bodies
      .map((b) => new URLSearchParams(b).get('refresh_token'))
      .filter((t): t is string => t !== null)
    expect(
      tokens,
      '拿**别的账号的**一次性 refresh_token 去续期了 ⇒ 会把它烧掉，'
      + '而那个 token 可能是健康账号要用的（issue 补充评论的三条 STS5.1806 即此形态）',
    ).toEqual([])
  })

  it('①d 兼容读（无参 `readStoredCredential`）**不受影响** —— 单凭据老用户零行为变化', async () => {
    writeFileSync(join(home, 'session.json'), JSON.stringify(credentialOf({
      modelAppKey: 'LEGACY-SINGLE-CREDENTIAL',
    })), 'utf8')
    const { readStoredCredential } = await import('../../src/officeace-auth.js')
    // ⚠️ 这条是**反面对照**：修法只能收窄「按 ref 那条腿」，不能连
    //    「单凭据兼容路径」一起关掉（那会让老用户登录态凭空消失）。
    expect(readStoredCredential()?.modelAppKey).toBe('LEGACY-SINGLE-CREDENTIAL')
  })
})

describe('IKM741 ②：读数必须与凭据绑定（不得用历史快照充数）', () => {
  const REF = 'OFFICEACE_ACCOUNT_DEADBEEF'

  beforeEach(() => {
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
  })

  it('②a 凭据不存在 + 该 ref 有陈旧缓存 ⇒ 必须 `undefined`（不得报出数字）', async () => {
    writeFileSync(
      join(home, `subscription-cache-${REF}.json`),
      JSON.stringify({
        totalCredits: 6493.32, usedCredits: 0,
        creditGroups: [{ key: 'plan-x', name: '套餐', remaining: 6493.32, total: 6493.32 }],
        cachedAt: '2026-10-13T14:41:15.000Z',
      }),
      'utf8',
    )
    const got = await fetchSubscriptionSummary(48, REF, undefined, emptyStore)
    expect(
      got,
      '凭据已不存在却仍报出 6493.32（两天前的快照）⇒ 用户据此以为「账号正常、还有额度」，'
      + '而它在聚合里恒 UNUSABLE。这是 issue 里「面板会说谎」那一条。',
    ).toBeUndefined()
  })

  it('②b 凭据**在**、云侧读不到 + 有该 ref 的缓存 ⇒ 照常返回 `stale` 读数（不得误伤）', async () => {
    writeFileSync(
      join(home, `subscription-cache-${REF}.json`),
      JSON.stringify({
        totalCredits: 500, usedCredits: 0,
        creditGroups: [{ key: 'plan-x', name: '套餐', remaining: 500, total: 500 }],
        cachedAt: '2026-10-16T00:00:00.000Z',
      }),
      'utf8',
    )
    // 云侧不可达 ⇒ 应当掉到该 ref 的缓存兜底（这是**正当**用法：展示层标「数据截至」）。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('网络不可达') }))
    try {
      const got = await fetchSubscriptionSummary(48, REF, credentialOf() as never, emptyStore)
      expect(got?.totalCredits, '凭据在 ⇒ 该 ref 的陈旧缓存是正当的离线兜底').toBe(500)
      expect(got?.stale).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('②c 折算层：只拿到 `stale` 缓存 ⇒ `UNUSABLE`（注释与实现必须一致）', async () => {
    writeFileSync(
      join(home, `subscription-cache-${REF}.json`),
      JSON.stringify({
        totalCredits: 1000, usedCredits: 0,
        creditGroups: [{
          key: 'bonus-x', name: '签到', remaining: 1000, total: 1000,
          expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(), expired: false,
        }],
        cachedAt: '2026-10-13T14:41:15.000Z',
      }),
      'utf8',
    )
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('网络不可达') }))
    try {
      // ⚠️ 修前实测：这里返回一个**真实时刻**（`1792165834998`），
      //    于是两天前的快照堂而皇之地参与「临期优先」排序、可能排到最前，
      //    抢走本该先用掉的别的渠道额度 —— 而本函数上方的判据表逐字写着
      //    「只拿到缓存 ⇒ UNUSABLE」。
      const got = await officeaceExpiry(credentialOf() as never, REF)
      expect(got, 'UNUSABLE = -1；陈旧快照不得参与候选排序').toBe(-1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ────────────────────────── ③④ 登录中止的收口 ──────────────────────────

/** 造一个能注册 RPC 的最小 ctx（凭据用**可观测**的内存 Map）。 */
/**
 * @param failResolve - 可选：让 `credentials.resolve` **抛错**（模拟凭据库抖动）。
 *   ⚠️ 2026-10-17 红队打穿的 P0 就是靠它复现的：**读凭据失败**曾被当成
 *   「确证没有凭据」⇒ 静默收口把健康账号连凭据一起删掉。
 */
function makeCtx(failResolve: () => boolean = () => false): {
  ctx: Context
  credentials: Map<string, string>
  handler: () => ((req: Request) => Promise<Response>) | undefined
} {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      if (failResolve()) throw new Error('凭据库读取失败（模拟磁盘/后端抖动）')
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'fake' }
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
    (_deps: string[], cb: (c: unknown) => void) => cb(ctx)
  return { ctx, credentials: store, handler: () => handler }
}

/** 桩：用户**从未完成授权**（`pollLoginCode` 恒 undefined ≈ 关掉了授权页）。 */
function neverAuthorizedStub(): Record<string, unknown> {
  return {
    startLogin: async () => ({
      authorizeUrl: 'https://auth.huaweicloud.com/stub',
      state: 'stub-state',
      _internal: {
        codeVerifier: 'v',
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      },
    }),
    pollLoginCode: async () => undefined,
    completeLogin: async () => { throw new Error('不该被调用') },
    persistLogin: async () => { throw new Error('不该被调用') },
  }
}

/** 桩：登录**立刻成功**（用于「凭据已落库 ⇒ 绝不能被收口」那条）。 */
function autoCompleteStub(): Record<string, unknown> {
  return {
    startLogin: async () => ({
      authorizeUrl: 'https://auth.huaweicloud.com/stub',
      state: 'stub-state',
      _internal: {
        codeVerifier: 'v',
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      },
    }),
    pollLoginCode: async () => 'stub-code',
    completeLogin: async () => credentialOf({ accountId: 'huawei-acct' }),
    persistLogin: async (
      credential: Record<string, unknown>,
      opts: { refName: string; credentials: { set(r: string, v: string): Promise<void> } },
    ) => {
      await opts.credentials.set(opts.refName, JSON.stringify(credential))
      return { accountId: 'huawei-acct' }
    },
  }
}

function makeRpc(officeace: Record<string, unknown>, failResolve: () => boolean = () => false) {
  const { ctx, credentials, handler } = makeCtx(failResolve)
  const pool = new AccountPool(ctx)
  registerJetHubRpc(ctx, pool, {
    codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
    lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
    trae: {} as never, cline: {} as never, loomy: {} as never,
    raccoon: {} as never, minimax: {} as never, zcode: {} as never,
    gemini: {} as never,
    officeace: officeace as never,
  } as never, undefined)
  const h = handler()
  if (h === undefined) throw new Error('handler 未注册')
  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = (await res.json()) as {
      result: { ok: boolean; value?: Record<string, unknown>; error?: { code: string; message: string } }
    }
    return body.result
  }
  return { call, pool, credentials }
}

describe('IKM741 ③：用户未完成授权就关窗 ⇒ 占位条目必须被收口', () => {
  afterEach(() => {
    delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
    vi.useRealTimers()
  })

  /**
   * ⚠️⚠️ **时钟必须被确定性地驱动，不能靠 `await` 走过一毫秒**。
   *
   * 判据是 `now - at > ttl`（`isAbandonedOfficeAceLogin`）。把 TTL 设成 0 时，
   * 「同一毫秒内」会算出 `0 > 0 === false` ⇒ 判定结果取决于**两次 `Date.now()`
   * 是否落在同一毫秒**。本仓库已实测过同型假绿（`healExpiredAccounts` 的
   * 边界用例「单文件 20 次只有 10 次变红」）⇒ 这里用 `toFake: ['Date']`
   * 只假造时钟（**不动真实定时器与微任务**，账号池的落盘仍然照常 await），
   * 把「已中止」这一格变成确定事实。
   */
  const useControlledClock = (): number => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    return t0
  }

  it('③a TTL 过后刷新账号列表 ⇒ 幽灵卡片被删掉，且**当次响应就不含它**', async () => {
    // ⚠️ TTL = 0 ⇒ 「任何中间态都已中止」，无需等真实 20 分钟。
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    const { call, pool, credentials } = makeRpc(neverAuthorizedStub())

    const t0 = useControlledClock()
    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    expect(pool.listAccountsByProvider('officeace'), '占位条目应当已登记').toHaveLength(1)
    expect(credentials.size, '此时确实还没有凭据').toBe(0)

    // 用户重新打开设置页 / 点刷新 ⇒ `account.list`（收口时机）
    vi.setSystemTime(t0 + 1)
    const listed = await call('account.list', { provider: 'officeace' })
    const shown = (listed.value?.accounts ?? []) as unknown[]
    expect(pool.listAccountsByProvider('officeace'), '幽灵占位账号必须被收口').toHaveLength(0)
    expect(
      shown,
      '收口必须发生在 `pool.listAccounts` **之前** —— 否则用户刷新一次仍会看到'
      + '那张刚被删掉的卡片，观感是「没生效」，得再刷一次',
    ).toHaveLength(0)
    expect(accountId.length).toBeGreaterThan(0)
  })

  it('③b 收口**只对 officeace** —— 别的渠道的占位条目不受影响', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    const { call, pool } = makeRpc(neverAuthorizedStub())
    // 别的 provider 的占位条目（同一 TTL 判据不该波及它）
    await pool.addAccount({
      id: 'buddy-manual', provider: 'buddy', nickname: 'buddy-manual',
      enabled: true, credentialRef: 'BUDDY_ACCOUNT_AAAAAAAA', refreshable: false,
      createdAt: Date.now(),
    })
    const t0 = useControlledClock()
    await call('account.create', { provider: 'officeace' })

    vi.setSystemTime(t0 + 1)
    await call('account.list', { provider: 'officeace' })

    expect(pool.listAccountsByProvider('officeace'), 'officeace 的幽灵应被收口').toHaveLength(0)
    expect(pool.listAccountsByProvider('buddy'), '别的渠道绝不能被牵连').toHaveLength(1)
  })
})

describe('IKM741 ④：收口的安全闸 —— 正在轮询的登录与已落库的账号**绝不能被删**', () => {
  afterEach(() => { delete process.env.DSH_OFFICEACE_PENDING_TTL_MS })

  it('④a TTL **内**（正常轮询中）⇒ 条目必须保留（不得误杀正在进行的登录）', async () => {
    // 默认 TTL（20 分钟）：刚发起的登录远未超时。
    const { call, pool } = makeRpc(neverAuthorizedStub())
    await call('account.create', { provider: 'officeace' })

    await call('account.list', { provider: 'officeace' })

    expect(
      pool.listAccountsByProvider('officeace'),
      '把正在轮询的登录删了 ⇒ 用户正常授权的登录反而会失败（比原缺陷更糟）',
    ).toHaveLength(1)
  })

  it('④b 凭据**已落库** ⇒ 即使 TTL 已过也必须保留（删除不可逆）', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    const { call, pool, credentials } = makeRpc(autoCompleteStub())

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    // 走完一次成功登录（凭据落库 + 回填条目）
    for (let i = 0; i < 5; i++) {
      const polled = await call('login.poll', { accountId })
      if (polled.value?.done === true) break
    }
    expect(credentials.size, '登录应当已把凭据落库').toBeGreaterThan(0)

    await call('account.list', { provider: 'officeace' })

    expect(
      pool.listAccountsByProvider('officeace'),
      '「TTL 已过」只是**推断**用户不会再来；若他其实完成了授权，凭据就在库里。'
      + '删掉它 = 把刚登好的账号连凭据一起销毁（不可逆），'
      + '正是 issue 正文点名要防的那条「必须区分凭据已落盘与落盘前的失败」',
    ).toHaveLength(1)
    expect(credentials.size, '凭据也必须原样还在').toBeGreaterThan(0)
  })

  it('④c 读不到账号池 ⇒ **什么都不做**（不可逆的删除不建立在失败的读上）', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    const { call, pool } = makeRpc(neverAuthorizedStub())
    await call('account.create', { provider: 'officeace' })
    expect(pool.listAccountsByProvider('officeace')).toHaveLength(1)

    // 让 `listAllAccounts` 抛错（收口函数内部会读到它）
    const spy = vi.spyOn(pool, 'listAllAccounts').mockRejectedValue(new Error('读池抖动'))
    try {
      await call('account.list', { provider: 'officeace' })
    } finally {
      spy.mockRestore()
    }
    expect(
      pool.listAccountsByProvider('officeace'),
      '读池失败时删了账号 ⇒ 一次磁盘抖动就会销毁用户数据',
    ).toHaveLength(1)
  })

  /**
   * ⚠️⚠️ **④d / ④e 是 2026-10-17 红队打穿的两个 P0**（不是作者自查发现的，登记在此）。
   *
   * ④c 已经守住「**读池**失败」。但判据 3 还有**第二条读**：`loginCredentialLanded`
   * 去读**凭据**。那条腿原先用 `await ctx.credentials.resolve(...).catch(() => undefined)`
   * 把「读失败」与「确实没有」**同一个 `false`** 返回 ⇒
   * **读凭据失败 ⇒ 当成没有凭据 ⇒ 静默收口删掉一个健康账号**（连带 unset 凭据，不可逆）。
   *
   * 红队探针实测（修前）：凭据**确实在**库里但 `resolve` 抛错 ⇒ 条目 0、凭据键 `[]`。
   */
  it('④d 凭据库**读失败** ⇒ 不得删账号（读不到 ≠ 没有；不可逆操作必须建立在确证上）', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    let failing = true
    const { call, pool, credentials } = makeRpc(neverAuthorizedStub(), () => failing)

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    // ⚠️ **刻意写成「先读成功、再开始失败」**：若一开始就失败，本用例会被
    //    `loginCredentialLanded` 里更早的那条提前返回（`'yes'`）覆盖，
    //    从而**测不到三态判据本身**（2026-10-17 变异验证实测：M2 因此全绿）。
    //    这里先用一份**不可解析**的值占位，让 `resolve` 能成功返回、但三态判据
    //    必须靠 `readCredential` 兜底才可能认出来。
    const ref = pool.findAccount(accountId)?.credentialRef as string
    credentials.set(ref, JSON.stringify(credentialOf()))

    await call('account.list', { provider: 'officeace' })

    expect(
      pool.listAccountsByProvider('officeace'),
      '凭据库读失败 ≠ 没有凭据。这是一次**静默的定时收口**，'
      + '误删用户不会收到任何提示 —— 与 ④c 的「读池失败」是同一条取向',
    ).toHaveLength(1)
    failing = false
    expect(credentials.get(ref), '凭据也绝不能被连带 unset（不可逆）').toBeDefined()
  })

  /**
   * ⚠️ **④d2 专门打 `'unknown'` 这一格**（2026-10-17 变异验证发现的守卫缺口）。
   *
   * ④d 走的是「`resolve` **抛错**」⇒ `loginCredentialLanded` 里 `readFailed = true`
   * ⇒ 返回 `'unknown'`。但变异「把收口处退回 `if (landed === 'yes')`」时
   * **④d 仍然全绿** —— 因为那条路径的账号**本来就该保留**（凭据在库里、只是读失败），
   * 退回布尔后 `landed === false` 仍会往下走……等等，那样它**应该**红。
   * 实测全绿说明 ④d 实际命中的是**另一条**提前返回（`landed` 已经是 `'yes'`）⇒
   * 「`'unknown'` 也要 continue」这条腿**没有任何用例覆盖**。
   * ⇒ 本用例把它单独钉住：**只让读取失败、不让它读到凭据**（空库 + resolve 抛错）。
   */
  it('④d2 凭据库读失败且**库里确实没有**凭据 ⇒ 仍不得删（unknown 必须 continue）', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    const { call, pool } = makeRpc(neverAuthorizedStub(), () => true)  // 恒抛错、且库是空的

    await call('account.create', { provider: 'officeace' })
    expect(pool.listAccountsByProvider('officeace'), '占位条目应当已登记').toHaveLength(1)

    await call('account.list', { provider: 'officeace' })

    expect(
      pool.listAccountsByProvider('officeace'),
      '「读不到」与「确证没有」必须分开：读失败时**无法确证**没有凭据，'
      + '不可逆的删除只能建立在确证上（哪怕这次它真的是个幽灵条目 —— 宁可留一张卡）',
    ).toHaveLength(1)
  })

  it('④e 凭据只在本 ref 的**兼容文件** `session-<ref>.json` ⇒ 账号可用 ⇒ 不得删', async () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    // ⚠️ 必须用**真实** auth 模块：兼容文件那条腿在 `officeace-auth.readCredential` 里，
    //    空桩（`{}`）会把它短路掉、让这条用例假绿（红队复核时实测踩到）。
    const { call, pool } = makeRpc({ ...officeaceAuth, ...neverAuthorizedStub() } as never)

    const created = await call('account.create', { provider: 'officeace' })
    expect(created.ok).toBe(true)
    const accountId = created.value?.accountId as string
    const ref = 'OFFICEACE_COMPAT_FIXTURE'
    await pool.updateAccount(accountId, { credentialRef: ref })
    // 只写兼容文件，**不写**凭据库
    writeFileSync(join(home, `session-${ref}.json`), JSON.stringify(credentialOf()), 'utf8')
    const usable = await readCredential(ref, {
      resolve: async () => undefined, set: async () => {}, unset: async () => {},
    } as never)
    expect(usable?.modelAppKey, '前置：兼容文件是 readCredential 的正当兜底').toBe('K')

    await call('account.list', { provider: 'officeace' })

    expect(
      pool.listAccountsByProvider('officeace'),
      '凭据在兼容文件里 ⇒ 该账号**可用** ⇒ 静默收口不得删它（判据必须与 readCredential 同源）',
    ).toHaveLength(1)
  })
})

describe('IKM741 判据的边界（纯函数，`now` 入参化 ⇒ 确定可测）', () => {
  afterEach(() => { delete process.env.DSH_OFFICEACE_PENDING_TTL_MS })

  it('⑤a 恰好等于 TTL ⇒ 仍算**进行中**（边界方向：不可逆的删除宁可多留一轮）', () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '1000'
    expect(isAbandonedOfficeAceLogin({ at: 0 }, 1000), '恰好 = TTL 不得判定为已中止').toBe(false)
  })

  it('⑤b TTL 后 1ms ⇒ 判定为已中止', () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '1000'
    expect(isAbandonedOfficeAceLogin({ at: 0 }, 1001)).toBe(true)
  })

  it('⑤c 中间态缺失（宿主重启，内存 Map 丢了）⇒ 判定为已中止', () => {
    // ⚠️ 这一格**必须**判成中止：state 随进程消失 ⇒ 该占位条目结构上再也拿不到
    //    code。但它仍要过收口的凭据那道闸（④b 覆盖）。
    expect(isAbandonedOfficeAceLogin(undefined, Date.now())).toBe(true)
  })

  it('⑤d TTL 可被 env 覆盖，且**显式 0 必须生效**（不得用 `parseInt(x) || d` 吃掉它）', () => {
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    expect(officeacePendingTtlMs(), '0 是合法值（= 立即收口），`|| default` 会吃掉它').toBe(0)
    // ⚠️ 非法值回落默认（NaN / 负数）
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = 'abc'
    expect(officeacePendingTtlMs()).toBe(20 * 60_000)
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '-5'
    expect(officeacePendingTtlMs()).toBe(20 * 60_000)
    delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
    expect(officeacePendingTtlMs()).toBe(20 * 60_000)
  })
})

/**
 * 桩：把 `persistLogin` **卡在「即将落库」那一刻**，让用例能在这个精确时点
 * 插入「用户删掉卡片」——B 档孤儿凭据的**唯一产生路径**（探针实测复现）。
 */
function gatedAuthStub(): {
  auth: Record<string, unknown>
  whenPersistStarted: () => Promise<void>
  releasePersist: () => void
} {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let markStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  return {
    whenPersistStarted: () => started,
    releasePersist: () => release(),
    auth: {
      startLogin: async () => ({
        authorizeUrl: 'https://auth.huaweicloud.com/stub',
        state: 'stub-state',
        _internal: {
          codeVerifier: 'v',
          dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
        },
      }),
      pollLoginCode: async () => 'stub-code',
      completeLogin: async () => credentialOf({ accountId: 'huawei-acct' }),
      persistLogin: async (
        credential: Record<string, unknown>,
        opts: { refName: string; credentials: { set(r: string, v: string): Promise<void> } },
      ) => {
        markStarted()
        // ⚠️ 卡在这里 = 「宿主已决定写、但还没写」。用户此刻删卡片 ⇒
        //    `removeAccount` 的 unset 是空操作（凭据还没写）⇒ 随后落库成孤儿。
        await gate
        await opts.credentials.set(opts.refName, JSON.stringify(credential))
        return { accountId: 'huawei-acct' }
      },
    },
  }
}

describe('IKM741 ⑤⑥ B 档「有凭据、无账号」：孤儿凭据必须被回收，但**账号仍在时绝不能被回收**', () => {
  it('⑥a 落库途中用户删掉卡片 ⇒ 刚写下的凭据必须被**回收**（不留孤儿）', async () => {
    const gateStub = gatedAuthStub()
    const { call, pool, credentials } = makeRpc(gateStub.auth)

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string

    // 发起轮询（会走到 persistLogin 并卡住），但**不 await** —— 否则拿不到这个时点
    const polling = call('login.poll', { accountId })
    await gateStub.whenPersistStarted()
    expect(pool.listAccountsByProvider('officeace'), '此刻占位条目还在').toHaveLength(1)

    // ⚠️ 用户此刻点「删除」那张卡片：`removeAccount` 先 unset（空操作，凭据还没写）
    await call('account.delete', { accountId })
    expect(credentials.size, '删卡片时确实还没有凭据（所以 unset 是空操作）').toBe(0)

    // 放行落库 ⇒ 凭据被写进库里，而账号条目已经没了
    gateStub.releasePersist()
    await polling

    expect(pool.listAccountsByProvider('officeace'), '账号已被用户删除').toHaveLength(0)
    expect(
      [...credentials.keys()],
      '凭据成了**孤儿**（有凭据、无账号）⇒ 修前它永不清理（issue 实测本机 3 条）。'
      + '这正是 issue「影响」第 3 条「凭据文件累积永不清理的孤儿条目」',
    ).toEqual([])
  })

  it('⑥b **账号仍在** ⇒ 凭据绝不能被回收（漏掉这条会把用户刚登好的凭据删掉）', async () => {
    const gateStub = gatedAuthStub()
    const { call, pool, credentials } = makeRpc(gateStub.auth)

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polling = call('login.poll', { accountId })
    await gateStub.whenPersistStarted()
    // ⚠️ 与 ⑥a 的唯一差别：**不删卡片**。
    gateStub.releasePersist()
    await polling

    expect(pool.listAccountsByProvider('officeace'), '账号仍在').toHaveLength(1)
    expect(
      credentials.size,
      '账号还在却把凭据回收了 ⇒ 用户刚登好的账号会立刻变成「凭据未配置」',
    ).toBe(1)
  })

  it('⑥c 读不到账号池（`poolEntryOf` 返回 `unknown`）⇒ **什么都不做**，凭据必须保留', async () => {
    const gateStub = gatedAuthStub()
    const { call, pool, credentials } = makeRpc(gateStub.auth)

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polling = call('login.poll', { accountId })
    await gateStub.whenPersistStarted()

    // 让 `findAccount` 抛错 ⇒ `poolEntryOf` 返回 `'unknown'`（而非 `undefined`）
    const spy = vi.spyOn(pool, 'findAccount').mockImplementation(() => {
      throw new Error('读池抖动')
    })
    try {
      gateStub.releasePersist()
      await polling
    } finally {
      spy.mockRestore()
    }

    expect(
      credentials.size,
      '读不到池 ≠ 账号不存在。把 `unknown` 当成「已删除」去回收凭据 ⇒ '
      + '一次读池抖动就会删掉用户刚登好的凭据（不可逆）',
    ).toBe(1)
  })
})
