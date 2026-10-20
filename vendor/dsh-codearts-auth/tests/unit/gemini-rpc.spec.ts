/**
 * Gemini **Jet Hub 登录接入**的回归测试。
 *
 * ## 守的是什么（用户实际走的路径）
 *
 * ```
 * account.create(provider=gemini)
 *   → { accountId, loginUrl }            前端据此弹窗（Google 授权页）
 *   → 用户在浏览器里授权 → Google 回调本地 http://localhost:PORT/oauth-callback
 *   → 后台 result 换令牌 → persistLogin 写 ctx.credentials
 * login.poll({ accountId })
 *   → { done: true }                     前端据此关弹窗、刷新列表
 * ```
 *
 * ⚠️ 与 zcode 那份的区别：Gemini 走**真实本地回调服务器**（`startGeminiOAuthFlow`
 * 绑 127.0.0.1 + ::1），故这里必须真的把浏览器那一步**模拟出来**（用返回的
 * `loginUrl` 取出 `state` 与 `redirect_uri`，再对 `redirect_uri` 发一次带 code 的
 * GET）。只断言 `loginUrl` 长得像 URL 的话，`persistLogin` / 昵称回填 / 凭据落盘
 * 全都没被走过 —— 而这三条正是历史上反复出问题的地方。
 *
 * ## 本文件锁死的三个已知坑
 *
 * 1. **位置参数错位**：`registerJetHubRpc` 的 provider 形参是按顺序传的，
 *    新 provider 一律**追加在末尾**（gemini 排在 zcode 之后），少传/插队会让
 *    后面的 `modelAdapters` 整体错位 —— 本仓库已复发 6 次。
 * 2. **必须立刻返回 loginUrl**：`window.open` 只在用户手势窗口内有效。
 * 3. **`login.poll` 靠「凭据是否已写入」判定**，与 provider 无关；故占位账号
 *    存在但凭据未写时必须回 `done:false`（前端据此继续轮询，而不是提前关窗）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { GeminiAuth } from '../../src/gemini-auth.js'
import { GEMINI, GEMINI_ENDPOINT_SANDBOX, GEMINI_QUOTA_PATH } from '../../src/gemini.js'
import { clearGeminiCreditCache } from '../../src/gemini-credits.js'

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
  /** 全量快照，用于断言「什么都没写进去」。 */
  snapshot(): Array<[string, string]> { return [...this.store.entries()] }
}

/**
 * 造一个能注册 RPC 的最小 ctx。
 *
 * ⚠️ `settings.register` **必须返回可用 scope**：`createJetHubStore` 按
 * 「`settings.register` 是不是函数」选后端，给了返回 undefined 的桩会走
 * `SettingsStore` 并报 `Cannot read properties of undefined (reading 'get')`。
 */
function makeCtx(): {
  ctx: Context
  credentials: FakeCredentials
  handler: () => ((req: Request) => Promise<Response>) | undefined
} {
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

/**
 * 桩 fetch：只认 Google 令牌端点与 userinfo，其余一律 404。
 *
 * ⚠️ 回调那一步（用户浏览器 → 本地 server）**不走这个桩** —— 它必须真的发到
 * `startGeminiOAuthFlow` 起的本地服务器上，见 `authorize()`。
 *
 * ⚠️ 令牌响应**默认带 `id_token`**：授权 URL 带 `openid` scope，真实 Google
 * 必然返回它，身份就该从这里解（`withIdToken: false` 才模拟缺席、走 userinfo 兜底）。
 */
function makeFetchStub(
  calls: { token: number; userinfo: number },
  options: { withIdToken?: boolean } = {},
): typeof fetch {
  const withIdToken = options.withIdToken !== false
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      calls.token += 1
      return new Response(JSON.stringify({
        access_token: 'SPEC-AT',
        refresh_token: 'SPEC-RT',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid https://www.googleapis.com/auth/cloud-platform',
        ...withIdToken
          ? { id_token: specIdToken({ sub: 'spec-sub-1234', email: 'spec@example.com' }) }
          : {},
      }), { status: 200 })
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      calls.userinfo += 1
      return new Response(JSON.stringify({ id: 'spec-sub-1234', email: 'spec@example.com' }), { status: 200 })
    }
    return new Response('{"error":"unexpected"}', { status: 404 })
  }) as unknown as typeof fetch
}

/** 造一个未签名形态的 `id_token`（只 base64url 编码，与真实结构同形）。 */
function specIdToken(payload: Record<string, unknown>): string {
  return `hdr.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.sig`
}

/**
 * 装配一套 RPC。
 *
 * 默认 gemini 位用**真实 `GeminiAuth` + 桩 fetch**（登录链路要真跑）；传
 * `gemini` 可换成只记录实参的桩（用于 `account.refresh` 的分派断言）。
 */
function makeRpc(options: { withIdToken?: boolean; gemini?: unknown } = {}) {
  const { ctx, credentials, handler } = makeCtx()
  const pool = new AccountPool(ctx)
  const calls = { token: 0, userinfo: 0 }
  const gemini = options.gemini ?? new GeminiAuth(ctx, { fetchImpl: makeFetchStub(calls, options) })
  registerJetHubRpc(
    ctx, pool,
    // ⚠️ **13 个 provider 形参**，逐个具名 —— 少一个就错位（见文件头第 1 条）。
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
    {} as never, // minimax
    {} as never, // zcode
    gemini as never, // gemini（追加在末尾）
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
 * 扮演浏览器：按 `loginUrl` 里的 `state` 与 `redirect_uri` 打一次真实回调。
 *
 * 这一步是整份用例的**要害**：不真的打通回调，`persistLogin`、昵称回填、
 * `login.poll` 报 done 三件事都不会发生，用例会变成「只测了 loginUrl 长啥样」。
 */
async function authorize(loginUrl: string, options: { code?: string; state?: string; error?: string } = {}): Promise<number> {
  const parsed = new URL(loginUrl)
  const redirectUri = parsed.searchParams.get('redirect_uri')
  const state = options.state ?? parsed.searchParams.get('state') ?? ''
  if (redirectUri === null) throw new Error('loginUrl 里没有 redirect_uri')
  const callback = new URL(redirectUri)
  if (options.error !== undefined) callback.searchParams.set('error', options.error)
  if (options.code !== undefined) callback.searchParams.set('code', options.code)
  callback.searchParams.set('state', state)
  const response = await fetch(callback.toString())
  return response.status
}

/** 轮询直到条件成立（默认 10 秒）。 */
async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`等待超时：${label}`)
}

/** 轮询 `login.poll` 直到 done。 */
async function waitForLogin(
  call: (method: string, payload: unknown) => Promise<any>,
  accountId: string,
): Promise<void> {
  await waitUntil(async () => {
    const polled = await call('login.poll', { accountId, provider: GEMINI.id })
    return polled.value?.done === true
  }, `登录完成（${accountId}）`)
}

/**
 * 轮询直到占位账号**消失**。
 *
 * 授权被拒/state 不符时，后台 `.catch` 会把占位账号删掉 —— 不能留着一条永远
 * 拿不到凭据的坏账号在列表里（用户会反复点「重新登录」）。这里等的是那次清理，
 * 而不是「等一个不存在的成功」。
 */
async function waitForGone(
  call: (method: string, payload: unknown) => Promise<any>,
  accountId: string,
): Promise<void> {
  await waitUntil(async () => {
    const listed = await call('account.list', { provider: GEMINI.id })
    return !(listed.value.accounts as Array<{ id: string }>).some((a) => a.id === accountId)
  }, `占位账号被清理（${accountId}）`)
}

describe('Gemini Jet Hub 登录接入', () => {
  it('★ account.create 立刻返回真实 Google 授权 URL，并登记一个不可续期的占位账号', async () => {
    const { call, calls } = makeRpc()
    const started = Date.now()
    const created = await call('account.create', { provider: GEMINI.id })
    expect(created.ok).toBe(true)
    // ⚠️ 必须立刻返回：`window.open` 只在用户手势窗口内有效，等授权完成再返回
    // 弹窗就会被浏览器拦掉。
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls.token).toBe(0)
    expect(calls.userinfo).toBe(0)

    const url = new URL(created.value.loginUrl as string)
    expect(url.origin).toBe('https://accounts.google.com')
    // `access_type=offline` + `prompt=consent` 才能拿到 refresh_token（少了它们
    // 只有 1 小时有效的 access_token，到期即掉线）。
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/)
    // ⚠️ 刻意**不做 PKCE**（用户拍板：与上游 Go 实现一致）。
    expect(url.searchParams.get('code_challenge')).toBeNull()

    const accountId = created.value.accountId as string
    expect(accountId.startsWith('gemini-')).toBe(true)
    const listed = await call('account.list', { provider: GEMINI.id })
    const entry = listed.value.accounts.find((a: { id: string }) => a.id === accountId)
    expect(entry.provider).toBe(GEMINI.id)
    expect(entry.enabled).toBe(true)
    // 尚未拿到凭据 ⇒ 不可续期（拿到后由后台回填）。
    expect(entry.refreshable).toBe(false)
  })

  it('★ 占位账号存在但凭据未写入时 login.poll 必须回 done:false', async () => {
    const { call } = makeRpc()
    const created = await call('account.create', { provider: GEMINI.id })
    const polled = await call('login.poll', { accountId: created.value.accountId, provider: GEMINI.id })
    expect(polled.ok).toBe(true)
    expect(polled.value.done).toBe(false)
  })

  it('★ 走完真实本地回调：换令牌一次、不查 userinfo、凭据落盘、昵称回填邮箱、refreshable 回填', async () => {
    const { call, pool, credentials, calls } = makeRpc()
    const created = await call('account.create', { provider: GEMINI.id })
    const accountId = created.value.accountId as string

    // 扮演浏览器点「允许」。
    expect(await authorize(created.value.loginUrl as string, { code: 'SPEC-CODE' })).toBe(200)
    await waitForLogin(call, accountId)
    expect(calls.token).toBe(1)
    // ⚠️ 身份来自令牌响应自带的 `id_token` ⇒ **一次 userinfo 都不该发**。
    // 2026-10-03 报障（昵称退化成 `gemini-6a53dbca`）就是因为原来只靠这次
    // 可静默失败的跨域请求。
    expect(calls.userinfo).toBe(0)

    // 凭据以 JSON 落进 ctx.credentials；refresh_token 是「下次续期不要求用户
    // 重新登录」的唯一凭据，必须落盘。
    const entry = (await pool.listAllAccounts()).find((a) => a.id === accountId)
    expect(entry).toBeDefined()
    expect(entry?.refreshable).toBe(true)
    // `expiresAt` 也要写回，否则卡片一直显示「已过期」。
    expect(entry!.expiresAt! - Date.now()).toBeGreaterThan(3_000_000)

    const stored = await credentials.resolve(entry!.credentialRef)
    const parsed = JSON.parse(stored!.value) as Record<string, unknown>
    expect(parsed.access_token).toBe('SPEC-AT')
    expect(parsed.refresh_token).toBe('SPEC-RT')
    expect(parsed.sub).toBe('spec-sub-1234')
    expect(parsed.email).toBe('spec@example.com')

    // 昵称回填是后台 `.then` 的最后一步，可能晚于 `login.poll` 报 done。
    await waitUntil(async () => {
      const listed = await call('account.list', { provider: GEMINI.id })
      const nickname = listed.value.accounts.find((a: { id: string }) => a.id === accountId)?.nickname
      return nickname !== accountId
    }, '昵称回填')
    const listed = await call('account.list', { provider: GEMINI.id })
    const nickname = String(listed.value.accounts.find((a: { id: string }) => a.id === accountId)?.nickname)
    // `geminiAccountLabel` 邮箱优先 —— 邮箱来自桩令牌响应里的 `id_token`。
    // ⚠️ 曾经这里断言 `'Gemini spec-sub'`（`sub` 前 8 位），那是**不可辨认**的
    // 展示名，2026-10-03 用户报障后改为邮箱优先，见 `geminiAccountLabel`。
    expect(nickname).toBe('spec@example.com')
    expect(nickname.startsWith('Gemini ')).toBe(false)
  }, 20_000)

  it('★ 令牌响应缺 id_token 时才兜底 userinfo（且登录仍然成功）', async () => {
    const { call, calls } = makeRpc({ withIdToken: false })
    const created = await call('account.create', { provider: GEMINI.id })
    const accountId = created.value.accountId as string
    await authorize(created.value.loginUrl as string, { code: 'SPEC-CODE' })

    await waitForLogin(call, accountId)
    expect(calls.token).toBe(1)
    expect(calls.userinfo).toBe(1)
  }, 20_000)

  it('★ state 不符 / 用户点取消：400 拒、不换令牌、占位账号被清理、凭据一行不写', async () => {
    const forged = makeRpc()
    const forgedCreated = await forged.call('account.create', { provider: GEMINI.id })
    const forgedId = forgedCreated.value.accountId as string
    expect(await authorize(forgedCreated.value.loginUrl as string, {
      code: 'SPEC-CODE', state: 'forged-state',
    })).toBe(400)
    // 换令牌一次都不该发生。
    expect(forged.calls.token).toBe(0)
    // ⚠️ 失败的登录会被后台清理：占位账号**被删掉**（不是留个坏账号在列表里）。
    await waitForGone(forged.call, forgedId)
    expect(forged.credentials.snapshot()).toHaveLength(0)

    const denied = makeRpc()
    const deniedCreated = await denied.call('account.create', { provider: GEMINI.id })
    const deniedId = deniedCreated.value.accountId as string
    expect(await authorize(deniedCreated.value.loginUrl as string, { error: 'access_denied' })).toBe(400)
    expect(denied.calls.token).toBe(0)
    await waitForGone(denied.call, deniedId)
    expect(denied.credentials.snapshot()).toHaveLength(0)
  }, 20_000)
})

/**
 * `account.refresh` 的分派（行为级）。
 *
 * ⚠️ 用桩 auth 而非真实 `GeminiAuth`：这里要守的是「RPC 把哪个实例、哪三个实参
 * 交给了谁」，真实续期协议已由 oauth / credits 侧覆盖。
 *
 * 三个实参缺一不可 —— 尤其是 `pool` + `entry.id`（issue !IKIRTT：早先只有
 * raccoon 传了，其余 provider「刷新」下去凭据续好了、UI 纹丝不动）。
 */
describe('Gemini account.refresh 分派', () => {
  it('★ gemini 账号走 gemini 实例，且带上 pool + entry.id', async () => {
    const seen: Array<{ ref: string; accountId?: string; withPool: boolean }> = []
    const { call, pool } = makeRpc({
      gemini: {
        async refreshAccountCredential(ref: string, p?: unknown, accountId?: string) {
          seen.push({ ref, accountId, withPool: p !== undefined })
        },
      },
    })
    await pool.addAccount({
      id: 'gemini-1', provider: GEMINI.id, nickname: 'spec', enabled: true,
      credentialRef: 'GEMINI_ACCOUNT_SPEC', createdAt: 1, refreshable: true,
    })

    const result = await call('account.refresh', { accountId: 'gemini-1' })
    expect(result.ok).toBe(true)
    expect(result.value.success).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.ref).toBe('GEMINI_ACCOUNT_SPEC')
    // ⚠️ 这两条是本组用例的核心：不传 pool/id 的话续期结果写不回账号池，
    // 界面会一直显示「已过期」。
    expect(seen[0]?.accountId).toBe('gemini-1')
    expect(seen[0]?.withPool).toBe(true)
  })
})

/**
 * `credits.balances` 的 gemini 分支（行为级）。
 *
 * 与其它 provider 的**关键差异**：Gemini 的「未授权」与「查询失败」是两回事，
 * 走的是 `fetchBalanceDetailed`（`{balance, error}` 原样透传给卡片），
 * 而不是「失败就补一句『余额查询失败』」。
 */
describe('Gemini credits.balances', () => {
  beforeEach(() => { clearGeminiCreditCache() })
  afterEach(() => { vi.unstubAllGlobals() })

  const QUOTA = {
    groups: [{
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', resetTime: '2030-01-01T00:00:00Z', remainingFraction: 0.8 },
        { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2030-01-07T00:00:00Z', remainingFraction: 0.6 },
      ],
    }],
  }

  async function seedAccount(pool: AccountPool, credentialRef: string) {
    await pool.addAccount({
      id: 'gemini-1', provider: GEMINI.id, nickname: 'spec', enabled: true,
      credentialRef, createdAt: 1, refreshable: true,
    })
  }

  it('★ 配额窗口转成两个包（5 小时 + 周）且汇总是平均值；未授权回可读文案', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, 'GEMINI_ACCOUNT_SPEC')
    await credentials.set('GEMINI_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-QUOTA' }))

    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(JSON.stringify(QUOTA), { status: 200 })
    })

    const result = await call('credits.balances', { provider: GEMINI.id })
    expect(result.ok).toBe(true)
    const rows = result.value.accounts as Array<{ accountId: string; balance: { total: number; packages: Array<{ name: string }> } | null; error?: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.accountId).toBe('gemini-1')
    expect(rows[0]?.error).toBeUndefined()
    expect(rows[0]?.balance?.total).toBe(70) // (80 + 60) / 2
    expect(rows[0]?.balance?.packages.map((p) => p.name)).toEqual(['5 小时窗口', '周窗口'])
    // ⚠️ 配额查询走 sandbox 端点（与推理端点的首选不同）。
    // 用 `toContain` 而不是 `seen[0]`：同一次调用里还会**并行**发
    // `loadCodeAssist`（取账号规格），两个请求的先后不该被这条断言锁死。
    expect(seen).toContain(`${GEMINI_ENDPOINT_SANDBOX}${GEMINI_QUOTA_PATH}`)

    // 凭据缺失 ⇒ 「凭据未配置」（账号池层面），而不是「余额查询失败」。
    vi.unstubAllGlobals()
    const bare = makeRpc()
    await seedAccount(bare.pool, 'GEMINI_ACCOUNT_SPEC')
    const missing = await bare.call('credits.balances', { provider: GEMINI.id })
    expect(missing.value.accounts[0]?.balance).toBeNull()
    expect(missing.value.accounts[0]?.error?.length).toBeGreaterThan(0)
  })
})

describe('Gemini 接线点（源码断言）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')
  const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
  const probeSource = readFileSync(resolve(here, '../../src/account-probe.ts'), 'utf8')

  it('⚠️ index.ts 接线点齐全，且签名缓存在卸载时落盘', () => {
    expect(indexSource).toContain("from './gemini-auth.js'")
    expect(indexSource).toContain("'llm-gemini'")
    expect(indexSource).toContain('new GeminiAuth(ctx)')
    expect(indexSource).toContain('registerGeminiLlm(ctx, {')
    // ⚠️ 漏了这一条 ⇒ 续期定时器**永不武装**（不是「刷得慢」，是压根不刷）。
    expect(indexSource).toContain("['gemini', (p) => gemini.refreshAll(p)]")
    expect(indexSource).toMatch(/gemini: pruned\([^)]*,\s*geminiAdapter\)/)
    expect(indexSource).toMatch(/loomy, raccoon, minimax, zcode, gemini, modelAdapters/)
    // 丢的是下一轮能不能带签名。
    expect(indexSource).toContain('geminiSigStore.flush()')
  })

  it('⚠️ jet-hub-rpc 三处分支齐全；account-probe 的分派表已含 gemini', () => {
    expect(rpcSource).toContain('provider === GEMINI.id')
    expect(rpcSource).toContain('case GEMINI.id:')
    expect(rpcSource).toContain('fetchGeminiCreditBalance(credential, GEMINI)')
    // ⚠️ 漏了会被华为云 HMAC 签名发 Google 凭据。
    expect(probeSource).toContain('entry.provider === GEMINI.id')
    expect(probeSource).toContain('new GeminiAdapter({')
  })
})
