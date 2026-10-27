/**
 * `officeace-inflight-guard.spec.ts` —— **在途登录不被并发收口**（Gitee IKM741 追补）
 *
 * ## 这个文件为什么存在（2026-10-17 **红队打穿的 P2**，比 P1a/P1b 更严重）
 *
 * `exchangeOfficeAceLogin` 原先在 `completeLogin` 成功后、`persistLogin`（写凭据）
 * **之前**就 `pendingOfficeAceState.delete(accountId)`；而
 * `isAbandonedOfficeAceLogin(undefined, now) === true`（判据与 TTL 无关）。
 *
 * ⇒ **落库进行中**的那个窗口里，任何一次 `account.list(officeace)` 都会：
 * pending 缺失 ⇒ 判「已中止」→ 凭据还没写 ⇒ `loginCredentialLanded` 为假 ⇒
 * `removeAccount`（连带 `credentials.unset`）。
 *
 * 红队探针 + 主 agent 独立复现（**生产默认 TTL**，不需要把 TTL 调 0）：
 * ```
 * 落库途中 account.list 返回卡片数 = 0
 * P2 结果：条目数 = 0 | 凭据键 = []
 * ```
 * ⇒ **用户完成授权的成功登录，被一次普通的列表刷新静默销毁**，而 `login.poll`
 * 还回 `{done:true, success:true}`（账号没了、连孤儿凭据都没留）。
 * 客户端在登录等待期间调 `account.list` 是**高频**行为（余额查询后也会调）。
 *
 * ## 修法（红队建议、主 agent 采纳）
 *
 * **让「在途」离散可分**，不要靠「凭据在不在」这种**间接**证据反推：
 * `pending` 必须**活到落库结束**（含失败收尾、孤儿回收、重复查重、正常回填
 * 四个返回点都要在结束处清）。失败计数之类的折中只会把竞态从「必删」缩成
 * 「概率删」—— 不可逆操作仍建立在推测上。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

function makeCtx(store: Map<string, string>) {
  const ctx = new Context()
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
  return { ctx, handler: () => handler }
}

/** 一份可用凭据（`accountId` 固定，模拟同一个云侧账号）。 */
const CRED = {
  modelAppKey: 'K', modelAppSecret: 'S', maasBaseUrl: 'https://officeace.example',
  access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: 'R',
  dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
  accountId: 'cloud-1',
}

/**
 * 造一个**落库可被卡住**的 harness：`persistLogin` 进入后等待 `release()`，
 * 期间可以插入任意并发调用（`account.list`）—— 这就是真实并发的形态。
 */
function makeHarness(options: { holdPersist?: boolean } = {}) {
  const store = new Map<string, string>()
  const { ctx, handler } = makeCtx(store)
  const pool = new AccountPool(ctx)
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let persistEntered = false

  const officeace = {
    startLogin: async () => ({
      authorizeUrl: 'https://auth.huaweicloud.com/stub', state: 's',
      _internal: { codeVerifier: 'v', dpopPrivateJwk: CRED.dpopPrivateJwk },
    }),
    pollLoginCode: async () => 'code',
    completeLogin: async () => ({ ...CRED }),
    persistLogin: async (
      cred: Record<string, unknown>,
      opts: { refName: string; credentials: { set(r: string, v: string): Promise<void> } },
    ) => {
      persistEntered = true
      if (options.holdPersist === true) await gate
      await opts.credentials.set(opts.refName, JSON.stringify(cred))
      return { accountId: cred.accountId }
    },
  }

  registerJetHubRpc(ctx, pool, {
    codearts: {} as never, buddy: {} as never, workbuddy: {} as never, lobsterai: {} as never,
    qoder: {} as never, qodercn: {} as never, trae: {} as never, cline: {} as never,
    loomy: {} as never, raccoon: {} as never, minimax: {} as never, zcode: {} as never,
    gemini: {} as never, officeace: officeace as never,
  } as never, undefined)
  const h = handler()!
  const call = async (method: string, payload: unknown) =>
    (await (await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'jet-hub', payload: { method, payload } }),
    }))).json() as { result: { ok: boolean; value?: any } }).result

  return {
    call, pool, store, release,
    entered: () => persistEntered,
    waitEntered: async (): Promise<void> => {
      for (let i = 0; i < 100 && !persistEntered; i++) await new Promise((r) => setTimeout(r, 5))
    },
  }
}

describe('OfficeAce 在途登录：并发的 `account.list` 不得收口它（红队 P2）', () => {
  it('① 落库**进行中**刷新账号列表 ⇒ 条目与凭据都必须活下来', async () => {
    const h = makeHarness({ holdPersist: true })
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value.accountId as string

    // 第一次 poll：completeLogin 成功 ⇒ 进入 persistLogin 并**卡住**
    const firstPoll = h.call('login.poll', { accountId })
    await h.waitEntered()
    expect(h.entered(), '前置：应当已进入落库阶段').toBe(true)

    // ⚠️ 就在此刻刷新（客户端在登录等待期间的高频行为）
    const listed = await h.call('account.list', { provider: 'officeace' })
    expect(
      (listed.value?.accounts ?? []).length,
      '在途登录的占位条目必须仍然可见（否则用户会以为登录凭空失败）',
    ).toBe(1)

    h.release()
    const settled = await firstPoll
    expect(settled.value?.success, '这次登录本身应当成功').toBe(true)

    expect(
      h.pool.listAccountsByProvider('officeace'),
      '用户完成授权的成功登录被一次列表刷新静默销毁 —— 账号没了、凭据也没落库（P2）',
    ).toHaveLength(1)
    expect(h.store.size, '凭据也必须落库').toBe(1)
  })

  it('② 落库结束**之后**的刷新仍会正常回填（修复不得让收口永久失效）', async () => {
    const h = makeHarness()
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value.accountId as string
    const settled = await h.call('login.poll', { accountId })
    expect(settled.value?.success).toBe(true)

    // ⚠️ 这一条是「`'unknown'` 也 continue」那个修法的**反向守卫**：
    //    若把 pending 永久留着（或让收口对一切都放行），真正的幽灵条目就再也
    //    收不掉。这里断言：**成功登录结束后**，条目仍在且已回填（说明流程走到了最后）。
    await h.call('account.list', { provider: 'officeace' })
    const left = h.pool.listAccountsByProvider('officeace')
    expect(left).toHaveLength(1)
    expect(left[0]!.nickname ?? '', '应当已回填成正常昵称（不是「未配置」）').toContain('OfficeAce')
    expect(h.store.size).toBe(1)
  })

  it('④ ⚠️ 落库**跨过 TTL** 时也不得收口（「在途」是显式状态，不是时间推断）', async () => {
    // 红队 P4：二版修法（把 delete 挪到落库后）只把窗口从「必然」缩成
    // 「落库耗时 > TTL」。本用例把 TTL 设 0（等价于落库卡住 > 20 分钟），
    // 断言 `settling` 这个**显式在途标记**让判据 2 无条件放行。
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    try {
      const h = makeHarness({ holdPersist: true })
      const created = await h.call('account.create', { provider: 'officeace' })
      const accountId = created.value.accountId as string

      const firstPoll = h.call('login.poll', { accountId })
      await h.waitEntered()

      // ⚠️ 关键：**只调 account.list、不调 login.poll**（红队探针正是这样打穿
      //    「靠轮询刷新 at」那个更省的替代方案的 —— 它结构上不严密）。
      const listed = await h.call('account.list', { provider: 'officeace' })
      expect((listed.value?.accounts ?? []).length, '在途登录（跨过 TTL）必须仍然可见').toBe(1)

      h.release()
      await firstPoll
      expect(h.pool.listAccountsByProvider('officeace'), '跨过 TTL 的在途登录不得被收口').toHaveLength(1)
      expect(h.store.size, '凭据必须落库').toBe(1)
    } finally {
      delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
    }
  })

  it('③ ⚠️ 收口**没有被永久禁用**：真正的幽灵条目（授权中止）仍然会被收掉', async () => {
    // 这是红队 Q1 担心的反方向缺陷：若「在途 ⇒ 永远放行」写过头（例如干脆不清
    // pending，或让收口无条件 continue），幽灵条目会永久累积、收口功能静默消失。
    // 判据：一次**从未授权**的登录（pending 会随 TTL 判成"已中止"）必须被收掉。
    //
    // ⚠️⚠️ **TTL 必须设成一个正的、极小的值，不能设 0**（2026-10-17 修复的脆弱点）。
    //
    // 收口里有一条**跨进程兜底**判据（`jet-hub-rpc.ts`，红队 P5）：
    // ```
    // if (pending === undefined && now() - entry.createdAt <= OFFICEACE_PENDING_TTL_MS) continue
    // ```
    // 它用 `<=`（闭区间）。当 TTL = **0** 时，这条判据退化成
    // 「`now() - createdAt <= 0`」⇒ 只有 `createdAt >= now()` 才跳过收口。
    // 而 `createdAt` 由 `account.create` 写入、`now()` 在本用例稍后取 ——
    // **两者同毫秒时差值为 0 ⇒ `0 <= 0` 为真 ⇒ 跳过收口 ⇒ 本用例假红**；
    // 差 ≥1ms 时才正常收口 ⇒ 通过。
    //
    // ⇒ 本用例原先是**时红时绿**的（实测同一份代码连跑 8 次：5 红 3 绿），
    //   与业务逻辑无关，纯粹取决于这两次 `Date.now()` 是否跨毫秒。
    //   ⚠️ 它曾在一次无关改动（`src/minimax.ts` 的导入图变化）后开始大面积变红，
    //      极易被误判成那次改动引入的回归 —— 判据要打在**行为**上，不能靠毫秒运气。
    //
    // 修法：TTL 取 `1`。此时「同毫秒」也得 `0 <= 1` ⇒ 依旧会跳过 —— 故还要
    //   让占位条目**确定性地**早于判据时刻：先建号，再等一个宏任务让时钟前进
    //   （`Date.now()` 的分辨率是 1ms，`setTimeout(2)` 保证跨过至少 1 个刻度）。
    //   两者合起来，`now() - createdAt >= 1 > TTL(0)` 的比较不再依赖运气。
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    try {
      const store = new Map<string, string>()
      const { ctx, handler } = makeCtx(store)
      const pool = new AccountPool(ctx)
      registerJetHubRpc(ctx, pool, {
        officeace: {
          startLogin: async () => ({
            authorizeUrl: 'https://auth.huaweicloud.com/stub', state: 's',
            _internal: { codeVerifier: 'v', dpopPrivateJwk: CRED.dpopPrivateJwk },
          }),
          pollLoginCode: async () => undefined,     // 用户从未完成授权
          completeLogin: async () => { throw new Error('不该被调用') },
          persistLogin: async () => { throw new Error('不该被调用') },
        } as never,
      } as never, undefined)
      const h = handler()!
      const call = async (method: string, payload: unknown) =>
        (await (await h(new Request('http://localhost/api/jet-hub', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'jet-hub', payload: { method, payload } }),
        }))).json() as { result: { ok: boolean; value?: any } }).result

      const created = await call('account.create', { provider: 'officeace' })
      expect(pool.listAccountsByProvider('officeace'), '占位条目已登记').toHaveLength(1)
      expect(created.value.accountId.length).toBeGreaterThan(0)

/**
       * ⚠️⚠️ **确定性地把时钟推过占位条目的 `createdAt`**（本用例唯一的脆弱点）。
       *
       * ## 根因（探针实测，非推断）
       *
       * `DSH_OFFICEACE_PENDING_TTL_MS = '0'` 让判据退化成「**跨过 1 毫秒**」。
       * ⚠️ 这里有**两条**判据都会因此失效，合并时必须都记住：
       *
       * ① `isAbandonedOfficeAceLogin`（pending 判据，`pending.at`）：
       *    ```ts
       *    return nowMs - pending.at > officeacePendingTtlMs()   // 严格大于
       *    ```
       *    TTL=0 时要求 `now - at >= 1` 才判「已中止」；同毫秒时 `delta === 0`
       *    ⇒ 判「进行中」⇒ 幽灵条目**没被收掉** ⇒ 断言要 0 拿到 1。
       *    探针实测：`delta=0 ⇒ 已中止=false`、`delta=1 ⇒ 已中止=true`。
       *
       * ② 收口里的**跨进程兜底**判据（`entry.createdAt`，闭区间）：
       *    ```ts
       *    if (pending === undefined && now() - entry.createdAt <= OFFICEACE_PENDING_TTL_MS) continue
       *    ```
       *    TTL=0 时它要求 `now() - createdAt >= 1` 才会继续收口；同毫秒时
       *    `0 <= 0` 为真 ⇒ 跳过收口 ⇒ **同样假红**。
       *
       * `Date.now()` 的分辨率是 1ms，而 `account.create` 与 `account.list`
       * 常落在同一毫秒 ⇒ 该形态实测时红时绿（同一份代码连跑 8 次：5 红 3 绿），
       * 且它曾因一次**无关**改动的导入图变化而开始大面积变红，被误判成那次改动的回归。
       *
       * ⚠️ 用 `setTimeout(2)` 而不是裸 `await Promise.resolve()`：后者是微任务，
       * **不保证**时钟刻度前进（Node 里微任务不 yield 给事件循环）。
       *
       * ⚠️ 为什么不能靠「重跑几次总会绿」：那是把随机性当通过，而本仓库已
       * 为同型事故付出过代价（`isAbandonedOfficeAceLogin` 的注释里记着
       * 「20 次只有 10 次变红」）。断言必须是**确定时刻**可驱动的。
       */
      await new Promise((resolve) => { setTimeout(resolve, 2) })

      await call('account.list', { provider: 'officeace' })
      expect(
        pool.listAccountsByProvider('officeace'),
        '「在途 ⇒ 放行」若写成「一切 ⇒ 放行」，收口就永久失效、幽灵条目永远累积',
      ).toHaveLength(0)
    } finally {
      delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
    }
  })
})

