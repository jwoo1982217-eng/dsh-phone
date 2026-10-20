/**
 * ZCode **Jet Hub 登录接入**的回归测试。
 *
 * ## 守的是什么（这是用户实际走的路径）
 *
 * 目标要求「插件内登录 + 登录状态持久化」。`ZcodeAuth.login` 那层的
 * 单测（`zcode-login.spec.ts`）只覆盖协议；**用户真正触发**的是 RPC：
 *
 * ```
 * account.create(provider=zcode)
 *   → { accountId, loginUrl }          ← 前端据此弹窗
 *   → 后台 started.result 写 ctx.credentials
 * login.poll({ accountId })
 *   → { done: true } 当凭据已落库       ← 前端据此关弹窗、刷新列表
 * ```
 *
 * ⚠ 这条路径上有**三个真实的坑**，都在实测中踩过：
 *
 * 1. **位置参数错位**：`registerJetHubRpc` 有 11 个 provider 形参，
 *    测试里少传一个就会让 zcode 落到 raccoon 位置 —— 表现为
 *    `Cannot read properties of undefined (reading 'startLogin')`。
 * 2. **settings 桩必须返回可用 scope**：`createJetHubStore` 按
 *    「`settings.register` 是不是函数」选后端；给了 `register(){}`
 *    （返回 undefined）会走 `SettingsStore` 并报
 *    `Cannot read properties of undefined (reading 'get')`。
 * 3. **必须先返回 loginUrl 再等结果**：`window.open` 只在用户手势
 *    窗口内有效（`AGENTS.md` 记过 CodeArts 的同款缺陷）。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'

/** 内存凭据存储（与其它 provider 的 spec 同款）。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/**
 * 造一个能注册 RPC 的最小 ctx。
 *
 * ⚠ `settings.register` **必须返回可用 scope**（见文件头第 2 条）。
 */
function makeCtx(): { ctx: Context; credentials: FakeCredentials; handler: () => ((req: Request) => Promise<Response>) | undefined } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    // ⚠️ **按 path 取处理器**：本模块除了 RPC 的 POST 端点，还注册了载体页的 GET
    // 路由。替身若「谁最后注册就记谁」，加一条路由就会把下面所有 RPC 用例打到
    // 载体页上（表现为成片 405/HTML，与所改的东西毫无关系）。
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)
  return { ctx, credentials, handler: () => handler }
}

/** 桩 fetch：init 立刻返回 URL；poll 第 2 次 ready。 */
function makeFetchStub(): { impl: typeof fetch; calls: { init: number; poll: number } } {
  const calls = { init: 0, poll: 0 }
  let polls = 0
  const impl = (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/oauth/cli/init')) {
      calls.init += 1
      return new Response(JSON.stringify({
        code: 0,
        data: {
          flow_id: 'spec-flow',
          authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=spec',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 1,
        },
      }), { status: 200 })
    }
    if (u.includes('/oauth/cli/poll/')) {
      calls.poll += 1
      polls += 1
      if (polls < 2) {
        return new Response(JSON.stringify({ code: 0, data: { status: 'pending' } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: {
          status: 'ready',
          token: 'SPEC-PLUGIN-JWT',
          user: { user_id: 'spec-user', name: 'Spec 用户' },
          bigmodel: { access_token: 'spec-bm' },
        },
      }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** 装配一套 RPC（zcode 用**真实 ZcodeAuth** + 桩 fetch）。 */
function makeRpc() {
  const { ctx, credentials, handler } = makeCtx()
  const pool = new AccountPool(ctx)
  const { impl, calls } = makeFetchStub()
  const zcode = new ZcodeAuth(ctx, { fetchImpl: impl })
  registerJetHubRpc(
    ctx, pool,
    // ⚠ **11 个 provider 形参**，逐个具名 —— 少一个就错位（见文件头第 1 条）。
    {} as never, // codearts
    {} as never, // buddy
    {} as never, // workbuddy
    {} as never, // lobsterai
    {} as never, // qoder
    {} as never, // qoderCn
    {} as never, // trae
    {} as never, // cline
    {} as never, // loomy
    {} as never, // raccoon
    {} as never, // minimax（2026-09-30 合并后新增，插在 zcode 前）
    zcode as never,
    undefined,
  )
  const h = handler()
  if (h === undefined) throw new Error('handler 未注册')
  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
    }))
    const body = await res.json() as { result: { ok: boolean; value?: any; error?: { message: string } } }
    return body.result
  }
  return { call, pool, credentials, calls }
}

/**
 * 等某账号的登录流程完成（`login.poll` 报 done）或超时。
 *
 * ⚠ `account.create` 是**两步式**：立刻返回授权 URL，后台轮询等授权。
 * 故测试里想「等这次添加真正落地」必须轮询，不能直接断言。
 */
async function waitForLogin(
  call: (method: string, payload: unknown) => Promise<any>,
  accountId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const polled = await call('login.poll', { accountId, provider: ZCODE.id })
    if (polled.value?.done === true) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待登录完成超时（${accountId}）`)
}

describe('ZCode Jet Hub 登录接入', () => {
  it('★ account.create 返回真实授权 URL（不是 unknown provider）', async () => {
    const { call } = makeRpc()
    const result = await call('account.create', { provider: ZCODE.id })
    expect(result.ok).toBe(true)
    expect(typeof result.value.accountId).toBe('string')
    expect(result.value.loginUrl).toMatch(/^https:\/\//)
    expect(result.value.loginUrl).toContain('bigmodel.cn')
  })

  it('★ account.create 立刻返回（不等授权完成）—— 否则 window.open 被拦', async () => {
    const { call, calls } = makeRpc()
    const started = Date.now()
    const result = await call('account.create', { provider: ZCODE.id })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(true)
    expect(calls.init).toBe(1)
    /**
     * ⚠ 断言**不能**写 `calls.poll === 0`。
     *
     * `startLogin` 内部把 `runZcodeLogin()` 作为**后台 promise 立即启动**
     * （这正是两步式的意义），所以检查时后台可能已经发了第一次轮询 ——
     * 那是**正确行为**，不是「等了授权」。
     *
     * 真正要守的是**耗时**：若实现写成 `await login()`，就会等满
     * 至少一个轮询间隔（本桩是 1 秒）才返回，届时不光 `elapsed` 变大，
     * `calls.poll` 也会是 2（拿到 ready）。故用耗时 + pending 状态判据。
     */
    expect(elapsed).toBeLessThan(1_000)
    // 后台尚未完成（只可能有 0 或 1 次 pending 轮询，不会是走完的 2 次）。
    expect(calls.poll).toBeLessThan(2)
  })

  it('account.create 登记占位账号（前端立刻可见）', async () => {
    const { call } = makeRpc()
    const created = await call('account.create', { provider: ZCODE.id })
    const listed = await call('account.list', { provider: ZCODE.id })
    const entry = listed.value.accounts.find((a: { id: string }) => a.id === created.value.accountId)
    expect(entry).toBeDefined()
    expect(entry.provider).toBe(ZCODE.id)
    // 静态凭据（JWT 无 exp），没有 refresh 端点。
    expect(entry.refreshable).toBe(false)
    expect(entry.enabled).toBe(true)
  })

  it('★ login.poll 在后台完成登录后报 done（凭据已持久化）', async () => {
    const { call } = makeRpc()
    const created = await call('account.create', { provider: ZCODE.id })
    const accountId = created.value.accountId

    let polled = await call('login.poll', { accountId, provider: ZCODE.id })
    const deadline = Date.now() + 10_000
    while (polled.value?.done !== true && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      polled = await call('login.poll', { accountId, provider: ZCODE.id })
    }
    expect(polled.value?.done).toBe(true)
  }, 20_000)

  it('★ 凭据落进 ctx.credentials，且含自建 device_mid（脱离 IDE 的核心）', async () => {
    const { call, pool, credentials } = makeRpc()
    const created = await call('account.create', { provider: ZCODE.id })
    const accountId = created.value.accountId

    // 等后台写盘。
    const deadline = Date.now() + 10_000
    let stored
    while (Date.now() < deadline) {
      const entry = (await pool.listAllAccounts()).find((a) => a.id === accountId)
      if (entry !== undefined) {
        stored = await credentials.resolve(entry.credentialRef)
        if (stored !== undefined) break
      }
      await new Promise((r) => setTimeout(r, 300))
    }

    expect(stored).toBeDefined()
    const parsed = JSON.parse(stored!.value) as Record<string, unknown>
    expect(parsed.zcode_jwt).toBe('SPEC-PLUGIN-JWT')
    expect(parsed.source).toBe('plugin')
    expect(parsed.account_label).toBe('Spec 用户')
    // ★ 自建 UUID —— 不读官方 telemetry-state.json。
    expect(String(parsed.device_mid)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  }, 20_000)

  it('登录成功后账号昵称被回填（不再显示裸 id）', async () => {
    const { call } = makeRpc()
    const created = await call('account.create', { provider: ZCODE.id })
    const accountId = created.value.accountId

    const deadline = Date.now() + 10_000
    let nickname = ''
    while (Date.now() < deadline) {
      const listed = await call('account.list', { provider: ZCODE.id })
      nickname = String(listed.value.accounts.find((a: { id: string }) => a.id === accountId)?.nickname ?? '')
      if (nickname.includes('Spec 用户')) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(nickname).toBe('ZCode Spec 用户')
  }, 20_000)

  /**
   * ★★ 去重的**接线验证**（2026-10-02）。
   *
   * ⚠ 为什么单独一条：`zcode-dedup.spec.ts` 测的是**判据本身**
   * （`findAccountIdByIdentityField`），而这里测的是「**它真的被接进了
   * 登录流程**」—— 本仓库历史上多次栽在「原语写好但没接上」
   * （`zcode-upstream.ts` 的 `fetchImpl` 曾是死参数）。
   */
  it('★★ 同一账号添加两次：第二条被自动停用，不再重复消耗额度', async () => {
    const { call, pool } = makeRpc()

    // 第一次添加。
    const first = await call('account.create', { provider: ZCODE.id })
    const firstId = first.value.accountId
    // 等它完成（凭据落盘 = `login.poll` 报 done）。
    await waitForLogin(call, firstId)

    // 第二次添加**同一个账号**（同一个 user_id = 'spec-user'）。
    const second = await call('account.create', { provider: ZCODE.id })
    const secondId = second.value.accountId
    await waitForLogin(call, secondId)

    // 等后台把第二条标停用。
    const deadline = Date.now() + 10_000
    let secondEntry
    while (Date.now() < deadline) {
      const accounts = await pool.listAllAccounts()
      secondEntry = accounts.find((a) => a.id === secondId)
      if (secondEntry?.enabled === false) break
      await new Promise((r) => setTimeout(r, 300))
    }

    /**
     * ★ 核心断言：第二条被**停用**（⇒ 不参与自动选号，这是去重的实际效果）。
     *
     * ⚠ 我们**刻意不删**它：前端 `login.poll` 靠「条目还在 + 凭据已写入」
     * 判断登录成功，删掉会让它显示成「登录失败」，而事实恰恰相反。
     */
    expect(secondEntry?.enabled).toBe(false)
    expect(String(secondEntry?.nickname)).toContain('重复')

    // 第一条**保持可用**（它的排序/改名/限流记录都不该被牺牲）。
    const firstEntry = (await pool.listAllAccounts()).find((a) => a.id === firstId)
    expect(firstEntry?.enabled).toBe(true)
  }, 30_000)

  it('★ 凭据里带上了 user_id（去重的唯一前提）', async () => {
    const { call, pool, credentials } = makeRpc()
    const created = await call('account.create', { provider: ZCODE.id })
    const accountId = created.value.accountId

    const deadline = Date.now() + 10_000
    let parsed: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      const entry = (await pool.listAllAccounts()).find((a) => a.id === accountId)
      if (entry !== undefined) {
        const stored = await credentials.resolve(entry.credentialRef)
        if (stored !== undefined) {
          parsed = JSON.parse(stored.value) as Record<string, unknown>
          break
        }
      }
      await new Promise((r) => setTimeout(r, 300))
    }

    /**
     * ⚠ 此前 `startLogin` 组装凭据时**把 userId 丢掉了** —— 于是无从去重。
     * 桩响应里 `user.user_id = 'spec-user'`（见文件上方 `makeCtx`）。
     */
    expect(parsed?.user_id).toBe('spec-user')
  }, 20_000)

  it('★ 授权发起失败时不留「幽灵账号」', async () => {
    const { ctx, credentials, handler } = makeCtx()
    const pool = new AccountPool(ctx)
    const failing = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const zcode = new ZcodeAuth(ctx, { fetchImpl: failing })
    registerJetHubRpc(
      ctx, pool,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, // minimax（合并后插在 zcode 前）
      zcode as never, undefined,
    )
    const h = handler()!
    const call = async (method: string, payload: unknown) => {
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
      }))
      return (await res.json() as { result: { ok: boolean } }).result
    }
    const result = await call('account.create', { provider: ZCODE.id })
    // ⚠ 发起就失败 → 不该登记账号（否则留下永远不可用的条目）。
    expect(result.ok).toBe(false)
    const listed = await call('account.list', { provider: ZCODE.id })
    expect(listed).toMatchObject({ ok: true })
    expect(await pool.listAccounts(ZCODE.id)).toHaveLength(0)
    void credentials
  }, 20_000)

  it('★ 其他 provider 不受影响（zcode 分支不是兜底 else）', async () => {
    const { call } = makeRpc()
    // 未注册的 provider 仍应报 unknown provider（证明 zcode 没有吃掉 else）。
    const bogus = await call('account.create', { provider: 'definitely-not-a-provider' })
    expect(bogus.ok).toBe(false)
    expect(bogus.error?.message).toMatch(/unknown provider/)
  })

  /**
   * ★ 未知 provider **不得留下任何账号池条目**（Gitee issue IKJLK3 E1 的回归锁）。
   *
   * ## 为什么上面那条不够
   *
   * 上一条只断言「返回了 bad-request」，那**证明不了池没被写脏**。
   * `account.create` 开头就拼了 `const id = \`${provider}-${shortId()}\``，
   * 任何一处分支在兜底之前误 `addAccount`（或有人日后把兜底挪到写入之后），
   * 上一条都会照样绿 —— 症状是账号池里出现一条 provider 为
   * `definitely-not-a-provider`、永远不可用的**幽灵条目**。
   *
   * ## 判据为什么用 `listAllAccounts()` 而不是 `listAccounts(provider)`
   *
   * 幽灵条目的 provider 就是那个**乱写的**值，用它去查等于自证；
   * 必须查**全池**（`listAllAccounts`）才能断言「一条都没多」。
   *
   * ## 为什么这条值得用单测锁，而不是在 `account.create` 入口加 provider 白名单
   *
   * 加白名单要多维护一份 provider 名单（客户端 `newAccountAsksChannel` 一份、
   * 服务端再一份），漏改任一处的表现是「客户端能选但服务端拒绝」——
   * 比现在「统一走 bad-request」更难排查。**链尾那道 `else` 兜底就是单一事实来源**
   * （提单人在 review 里给出的同一结论）。用测试守住它，既不失守，又不在生产
   * 路径上多一层判断。
   */
  it('★ 未知 provider 不写账号池（全池条目数不变，兜底不是「先写后拒」）', async () => {
    const { call, pool } = makeRpc()
    const before = await pool.listAllAccounts()
    const bogus = await call('account.create', { provider: 'definitely-not-a-provider' })
    expect(bogus.ok).toBe(false)
    expect(bogus.error?.message).toMatch(/unknown provider/)
    // ⚠ 用**全池**比对：幽灵条目的 provider 就是那个乱写的值，按它去查等于自证。
    const after = await pool.listAllAccounts()
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id))
    expect(after.some((a) => a.provider === 'definitely-not-a-provider')).toBe(false)
  })

  /**
   * ⚠ **`login.poll` 必须做形状校验**（审查发现）。
   *
   * 原判据只是「`ctx.credentials.resolve(ref)` 返回了非空字符串」。占位条目被
   * 写入一段**残缺 JSON**（例如只有 `zcode_jwt`、没有 `device_mid`）时它照样
   * 命中 ⇒ 前端弹「账号已添加」，而该账号一发请求就报凭据无效。
   */
  it('★ login.poll 对残缺凭据（缺 device_mid）不得报 done', async () => {
    const { ctx, credentials, handler } = makeCtx()
    const pool = new AccountPool(ctx)
    const zcode = new ZcodeAuth(ctx, { fetchImpl: (async () => new Response('{}')) as never })
    registerJetHubRpc(
      ctx, pool,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, zcode as never, undefined,
    )
    const h = handler()!
    const call = async (method: string, payload: unknown) => {
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
      }))
      return (await res.json() as { result: { ok: boolean; value?: { done?: boolean } } }).result
    }

    // 清掉可能的孤儿收编路径：直接手工造一个条目 + 残缺凭据。
    await pool.addAccount({
      id: 'zcode-broken',
      provider: ZCODE.id,
      nickname: 'broken',
      enabled: true,
      credentialRef: 'ZCODE_ACCOUNT_BROKEN',
      createdAt: Date.now(),
      refreshable: false,
    })
    await credentials.set('ZCODE_ACCOUNT_BROKEN', JSON.stringify({ zcode_jwt: 'jwt-only' }))

    const polled = await call('login.poll', { accountId: 'zcode-broken', provider: ZCODE.id })
    expect(polled.ok).toBe(true)
    expect(polled.value?.done).not.toBe(true)
  })

  it('★ login.poll 对完全合法的凭据仍报 done（不误伤）', async () => {
    const { ctx, credentials, handler } = makeCtx()
    const pool = new AccountPool(ctx)
    const zcode = new ZcodeAuth(ctx, { fetchImpl: (async () => new Response('{}')) as never })
    registerJetHubRpc(
      ctx, pool,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, zcode as never, undefined,
    )
    const h = handler()!
    const call = async (method: string, payload: unknown) => {
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
      }))
      return (await res.json() as { result: { ok: boolean; value?: { done?: boolean } } }).result
    }
    await pool.addAccount({
      id: 'zcode-ok',
      provider: ZCODE.id,
      nickname: 'ok',
      enabled: true,
      credentialRef: 'ZCODE_ACCOUNT_OK',
      createdAt: Date.now(),
      refreshable: false,
    })
    await credentials.set('ZCODE_ACCOUNT_OK', JSON.stringify({
      zcode_jwt: 'a.b.c', device_mid: 'mid-ok', user_id: 'u-ok',
    }))
    const polled = await call('login.poll', { accountId: 'zcode-ok', provider: ZCODE.id })
    expect(polled.value?.done).toBe(true)
  })

  it('位置参数顺序：zcode 必须排在 raccoon 之后（缺一个就错位）', () => {
    // 源码级断言：防止将来加 provider 时把 zcode 的顺序改乱。
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'),
      'utf8',
    )
    const call = /registerJetHubRpc\(([^)]*)\)/.exec(source)
    expect(call?.[1]).toBeDefined()
    const args = (call?.[1] ?? '').split(',').map((s) => s.trim())
    // ctx, pool, 然后 13 个 provider（minimax → zcode → gemini），最后 modelAdapters。
    // ⚠️ 新 provider 一律**追加在末尾**（gemini 排在 zcode 之后），既有调用点
    // 才不用逐个补占位 —— 见 `registerJetHubRpc` 签名上方的注释。
    expect(args.length).toBe(16)
    expect(args[args.length - 5]).toBe('raccoon')
    expect(args[args.length - 4]).toBe('minimax')
    expect(args[args.length - 3]).toBe('zcode')
    expect(args[args.length - 2]).toBe('gemini')
    expect(args[args.length - 1]).toBe('modelAdapters')
  })
})
