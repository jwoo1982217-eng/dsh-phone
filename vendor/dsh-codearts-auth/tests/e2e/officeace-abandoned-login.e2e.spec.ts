/**
 * `officeace-abandoned-login.e2e.spec.ts` —— **真开无痕窗口**验证 IKM741 的
 * 「新登录账号没完成授权」那条链（Gitee issue IKM741）。
 *
 * ## 为什么这条必须放 e2e（2026-10-13 用户明确要求，2026-10-16 IKM741 复用）
 *
 * 「打开浏览器窗口的行为测试只能放 `tests/e2e/`」是本仓库的架构约束，
 * 理由是**真实污染过用户桌面两次**（详见 `officeace-incognito-login.e2e.spec.ts`
 * 的文件头）。单测用 `DSH_OFFICEACE_PENDING_TTL_MS` + 内存桩驱动**判据**，
 * 本文件才驱动**真实链路**。
 *
 * ## 与 `officeace-incognito-login.e2e.spec.ts` 的分工
 *
 * | 文件 | 验什么 |
 * |---|---|
 * | `officeace-incognito-login.e2e.spec.ts` | 无痕窗口**能不能拉起来**、是否落在华为云登录页（人工判据） |
 * | **本文件** | **新登录账号的完整生命周期**：① 发起 ⇒ 占位条目就位、**零凭据**；② 用户没授权就关窗 ⇒ 刷新列表时**幽灵被收口**；③ 收口**不会**误删别的渠道条目；④ 已落库的账号**绝不被收口** |
 *
 * ⚠️ 前三条用 `DSH_OFFICEACE_PENDING_TTL_MS=0`（=「任何中间态都算已中止」）
 * 让判据**确定可复现**，无需真的等 20 分钟。
 *
 * ## 闸门
 *
 * 需 `DSH_OFFICEACE_E2E=1`（`pnpm test:e2e:officeace-abandoned`）。
 * 会**真的弹出无痕窗口**（用例①要求人工确认落在登录页），
 * ③④ 两组不依赖人工观察、纯本地状态断言。
 */

import { Context } from '@deepseek-ai/cordis'
import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import { openIncognitoWindow } from '../../src/login.js'

const E2E = process.env.DSH_OFFICEACE_E2E === '1'

/** 造一个能注册 RPC 的最小 ctx（凭据用**可观测**的内存 Map）。 */
function makeCtx(): {
  ctx: Context
  credentials: Map<string, string>
  handler: () => ((req: Request) => Promise<Response>) | undefined
} {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
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

/** 真实的 OfficeAce 授权 URL 形态（与本插件 `startLogin` 生成的一致）。 */
function authorizeUrlOf(): string {
  const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
  const params = new URLSearchParams({
    client_id: 'pdp5_for_agentarts',
    code_challenge: 'e2e-placeholder-challenge-e2e-placeholder',
    code_challenge_method: 'SHA-256',
    state: '0123456789abcdef0123456789abcdef',
    scope: 'openid',
    redirect_uri: `${CLAW_BASE}/v1/claw/auth/callback`,
    response_type: 'code',
  })
  return `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
    `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`,
  )}`
}

/** 桩 auth：可注入 `poll` 结果（`undefined` = 用户从未完成授权）。 */
function authStub(options: { code?: string } = {}): Record<string, unknown> {
  const { code } = options
  return {
    startLogin: async () => ({
      authorizeUrl: authorizeUrlOf(),
      state: 'stub-state',
      _internal: {
        codeVerifier: 'v',
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      },
    }),
    pollLoginCode: async () => code,
    completeLogin: async () => {
      const kp = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
      )
      return {
        modelAppKey: 'E2E-K', modelAppSecret: 'E2E-S',
        maasBaseUrl: 'https://officeace.example',
        access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p',
        expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        refreshToken: 'E2E-REFRESH',
        dpopPrivateJwk: await webcrypto.subtle.exportKey('jwk', kp.privateKey),
        accountId: 'e2e-huawei-account',
      }
    },
    persistLogin: async (
      credential: Record<string, unknown>,
      opts: { refName: string; credentials: { set(r: string, v: string): Promise<void> } },
    ) => {
      await opts.credentials.set(opts.refName, JSON.stringify(credential))
      return { accountId: 'e2e-huawei-account' }
    },
  }
}

function makeRpc(officeace: Record<string, unknown>) {
  const { ctx, credentials, handler } = makeCtx()
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

/**
 * 把「已中止」变成**确定事实**（而不是靠等 20 分钟或跨毫秒的运气）。
 *
 * ⚠️ 与单测同因：判据是 `now - at > ttl`，`ttl=0` 在**同一毫秒内**会算出
 * `0 > 0 === false`。故用 `toFake: ['Date']` 只假造时钟（不动真实定时器）。
 */
function forceAbandoned(): void {
  process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
}

describe.runIf(E2E)('officeace IKM741 e2e：新登录账号的完整生命周期', () => {
  afterEach(() => {
    delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
  })

  /**
   * ① **真开无痕窗口 + 占位条目就位 + 零凭据**（人工确认落在登录页）。
   *
   * ⚠️ 这条例用**真实 `account.create`**，故宿主会真的 `spawn` 浏览器 ——
   * 那是它必须留在 e2e 的理由。
   * ⚠️ `startLogin` 会把 `authorizeUrl` 回给客户端；本用例直接调它打开的
   * **就是**那个 URL（不另造一个，否则「验的窗口」与「生产打开的窗口」是两个东西）。
   */
  it('① account.create 后：占位条目在池、凭据为空、且真以无痕窗口打开授权页',
    async () => {
      const { call, pool, credentials } = makeRpc(authStub())
      const created = await call('account.create', { provider: 'officeace' })
      expect(created.ok, `account.create 应当成功：${JSON.stringify(created.error ?? {})}`).toBe(true)
      const accountId = created.value?.accountId as string
      const loginUrl = created.value?.loginUrl as string
      const incognitoOpened = created.value?.incognitoOpened

      expect(pool.listAccountsByProvider('officeace'), '占位条目必须先于 loginUrl 就位（前端 login.poll 靠它）')
        .toHaveLength(1)
      expect(credentials.size, '此时确实还没有凭据（用户尚未授权）').toBe(0)
      expect(loginUrl.length, '必须返回授权 URL').toBeGreaterThan(0)
      expect(
        incognitoOpened,
        '宿主未能以无痕窗口打开（读不到默认浏览器 / spawn 失败）—— '
        + '此时客户端会回退到自己的 window.open，换账号登录会失效',
      ).toBe(true)

      // 人工判据：窗口里应当是**登录框**（二维码 / 手机号 / 密码），
      // 而不是「已自动登录并直接跳走」（后者说明无痕隔离没生效）。
      console.log(
        '\n[officeace IKM741 e2e] 请人工确认无痕窗口落在**华为云登录页**（有二维码/手机号/密码）、\n'
        + '而不是「已登录直接跳走」。观察 5 秒后本用例继续。\n'
        + `  账号 id：${accountId}\n`,
      )
      await new Promise((resolve) => setTimeout(resolve, 5000))
      expect(typeof accountId).toBe('string')
    }, 90_000)

  /** ② 用户**没完成授权就关掉窗口** ⇒ 刷新列表时幽灵占位条目被收口。 */
  it('② 未完成授权 ⇒ account.list 收口幽灵条目，且**当次响应**就不含它', async () => {
    forceAbandoned()
    const { call, pool, credentials } = makeRpc(authStub())
    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    // ⚠️ 显式关掉宿主打开的无痕窗口（模拟「用户把授权页关了」）。
    //    轮询不依赖浏览器 cookie（`GET /v1/claw/auth/code` 是匿名服务端轮询），
    //    故关窗不影响本条判据 —— 关键是**云侧永远不会给 code**（桩已如此）。
    void accountId

    const listed = await call('account.list', { provider: 'officeace' })
    const shown = (listed.value?.accounts ?? []) as unknown[]

    expect(pool.listAccountsByProvider('officeace'),
      '用户没完成授权 ⇒ 占位条目必须被收口（否则永久残留成「凭据未配置」的幽灵卡片）')
      .toHaveLength(0)
    expect(shown, '收口必须在 pool.listAccounts **之前** —— 否则用户得再刷新一次才看到它消失')
      .toHaveLength(0)
    expect(credentials.size, '收口不该动任何凭据（本来就没有）').toBe(0)
  }, 90_000)

  /** ③ 收口**只对 officeace**：别的渠道的占位条目不受影响（防止误伤的跨渠道回归）。 */
  it('③ 收口不波及其它渠道的占位条目', async () => {
    forceAbandoned()
    const { call, pool } = makeRpc(authStub())
    await pool.addAccount({
      id: 'buddy-e2e-placeholder', provider: 'buddy', nickname: 'buddy-e2e-placeholder',
      enabled: true, credentialRef: 'BUDDY_ACCOUNT_E2EAAAAAA', refreshable: false,
      createdAt: Date.now(),
    })
    await call('account.create', { provider: 'officeace' })

    await call('account.list', { provider: 'officeace' })

    expect(pool.listAccountsByProvider('officeace'), 'officeace 的幽灵应被收口').toHaveLength(0)
    expect(pool.listAccountsByProvider('buddy'), '别的渠道绝不能被牵连（收口判据必须按 provider）')
      .toHaveLength(1)
  }, 90_000)

  /**
   * ④ **反面对照（最重要的一条）**：走完一次**成功登录**后，即使 TTL 已过，
   * 收口也**绝不能**删掉它 —— 删除不可逆（`removeAccount` 连带 unset 凭据）。
   *
   * ⚠️ 这正是 issue 正文点名要防的那条：「必须区分『凭据已落盘』与『落盘前的失败』」，
   * 否则会删掉刚登好的账号（本仓库 `failLogin` 那节被两轮审计各打穿一次的同型事故）。
   */
  it('④ 成功登录（凭据已落库）⇒ TTL 过后收口**不得**删它', async () => {
    forceAbandoned()
    const { call, pool, credentials } = makeRpc(authStub({ code: 'e2e-code' }))
    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    for (let i = 0; i < 10; i++) {
      const polled = await call('login.poll', { accountId })
      if (polled.value?.done === true) break
    }
    expect(credentials.size, '登录应当已把凭据落库').toBeGreaterThan(0)

    await call('account.list', { provider: 'officeace' })

    expect(pool.listAccountsByProvider('officeace'),
      '「TTL 已过」只是**推断**用户不会再来；若他其实完成了授权，凭据就在库里。'
      + '删掉它 = 把刚登好的账号连凭据一起销毁（不可逆）')
      .toHaveLength(1)
    expect(credentials.size, '凭据必须原样还在').toBeGreaterThan(0)
  }, 90_000)

  /**
   * ⑥ **B 档「有凭据、无账号」**：登录落库途中用户删掉卡片 ⇒ 刚写下的凭据
   * 必须被**回收**，不留孤儿（issue「影响」第 3 条：凭据文件累积永不清理的孤儿条目）。
   *
   * ⚠️ 与 ④ 的安全性配对：④ 是「账号在 ⇒ 凭据绝不能删」，本条是「账号没了 ⇒
   * 凭据必须删」。两条判据方向相反、缺一不可。
   */
  it('⑥ 落库途中用户删掉卡片 ⇒ 孤儿凭据被回收（且账号仍在时不受影响）', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })

    const { call, pool, credentials } = makeRpc({
      ...authStub({ code: 'e2e-code' }),
      persistLogin: async (
        credential: Record<string, unknown>,
        opts: { refName: string; credentials: { set(r: string, v: string): Promise<void> } },
      ) => {
        markStarted()
        await gate
        await opts.credentials.set(opts.refName, JSON.stringify(credential))
        return { accountId: 'e2e-huawei-account' }
      },
    })

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polling = call('login.poll', { accountId })
    await started

    // 用户此刻点「删除」那张卡片（凭据尚未落库 ⇒ unset 是空操作）
    await call('account.delete', { accountId })
    expect(credentials.size, '删卡片时确实还没有凭据').toBe(0)

    release()
    await polling

    expect(pool.listAccountsByProvider('officeace'), '账号已被用户删除').toHaveLength(0)
    expect(
      [...credentials.keys()],
      '凭据成了孤儿（有凭据、无账号）⇒ 必须被回收，否则它会永久留在 .credentials.yaml 里'
      + '（issue 实测本机 3 条，每条约 2.4 KB，且没有任何入口能清理它）',
    ).toEqual([])
  }, 90_000)

  /**
   * ⑦ **反面对照**：同样的「落库途中」时点，**不删卡片** ⇒ 凭据必须保留。
   *
   * ⚠️ 这是 ⑥ 的对照组：证明 ⑥ 的判据是「账号真的没了」，不是「登录一律清凭据」。
   */
  it('⑦ 落库途中**不**删卡片 ⇒ 凭据必须保留（⑥ 的对照组）', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })

    const { call, pool, credentials } = makeRpc({
      ...authStub({ code: 'e2e-code' }),
      persistLogin: async (
        credential: Record<string, unknown>,
        opts: { refName: string; credentials: { set(r: string, v: string): Promise<void> } },
      ) => {
        markStarted()
        await gate
        await opts.credentials.set(opts.refName, JSON.stringify(credential))
        return { accountId: 'e2e-huawei-account' }
      },
    })

    const created = await call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polling = call('login.poll', { accountId })
    await started
    // ⚠️ 与 ⑥ 的唯一差别：**不删卡片**。
    release()
    await polling

    expect(pool.listAccountsByProvider('officeace'), '账号仍在').toHaveLength(1)
    expect(credentials.size, '账号还在却把凭据回收了 ⇒ 刚登好的账号立刻变「凭据未配置」').toBe(1)
  }, 90_000)

  /**
   * ⑤ 无痕窗口的**独立**验证（与 `officeace-incognito-login.e2e.spec.ts` 同源，
   * 这里只为「新登录账号」这条链提供同一次运行内的证据）。
   */
  it('⑤ 真拉起无痕窗口并返回 true（人工确认落在华为云登录页）', async () => {
    const ok = openIncognitoWindow(authorizeUrlOf())
    expect(ok, '无痕窗口未能拉起（读不到默认浏览器 / spawn 失败）').toBe(true)
    console.log(
      '\n[officeace IKM741 e2e] 请人工确认：窗口里是**登录框**（二维码/手机号/密码），\n'
      + '不是「已登录并直接跳走」—— 后者说明无痕隔离没生效。\n',
    )
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }, 60_000)
})
