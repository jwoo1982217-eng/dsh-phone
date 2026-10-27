import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { OPENCODE } from '../../src/opencode-product.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { CREDITS_CAPABILITIES } from '../../plugin-src/client/credits-capabilities.js'

/**
 * opencode 用量徽标的能力登记与 `credits.balances` 分支。
 *
 * ## ⚠️ 2026-10-08 复审：本文件里的**源码文本断言**已全部删除
 *
 * 原有一类用例是 `readFileSync('src/...')` 后正则扫**注释散文**（例如
 * 「注释里记录了『为什么不用 balance:false』」）。它有三重问题：
 *
 * 1. **断言的是注释，不是行为** —— 改一句注释就假失败，与回归价值无关；
 * 2. 它正是本 Task 要消灭的形态（「从源码文本派生判据」，历史上多次
 *    **静默漏算而照样全绿**，本仓库原注释：「保险失效比变红更糟」）；
 * 3. 「为何如此登记」属于**人工评审**的范畴，不该由单测守
 *    （同 `loomy-docs.spec.ts` 被删的理由）。
 *
 * 现改为**真跑端点**：装配真实 `AccountPool` + `registerJetHubRpc`，
 * 喂三种账号（可用 / 限额中 / 已停用），断言 `credits.balances` 的返回形状。
 * 这比扫文本强得多 —— 它能抓住「分支被挪到 `case` 之外」「语义写成伪造余额」
 * 「悄悄开始发网络请求」这类文本断言看不见的回归。
 */

/** 内存凭据存储（与其它 provider 的 spec 同款）。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true, source: 'fake' } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/**
 * 装配一套能真调 `credits.balances` 的最小 RPC（骨架抄自 `gemini-rpc.spec.ts`）。
 *
 * ⚠️ `settings.register` **必须返回可用 scope**：`createJetHubStore` 按
 * 「`settings.register` 是不是函数」选后端，给了返回 undefined 的桩会走
 * `SettingsStore` 并报 `Cannot read properties of undefined (reading 'get')`。
 */
function makeRpc() {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
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
    // ⚠️ **按 path 取处理器**：本模块除 RPC 的 POST 端点还注册了载体页 GET 路由，
    // 替身若「谁最后注册就记谁」，加一条路由就会把用例打到载体页上。
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)

  const pool = new AccountPool(ctx)
  // ⚠️ **命名对象**（2026-10-08 改，原为 13 个位置参数）：键是 **provider id**。
  // opencode 的这条分支只用 pool/ctx，不碰任何 auth 实例，故全部是空对象。
  // 位置参数时代这里要逐个补 13 个占位（历史上已错位复发 6 次）。
  registerJetHubRpc(
    ctx, pool,
    {
      codearts: {} as never,
      buddy: {} as never,
      workbuddy: {} as never,
      lobsterai: {} as never,
      qoder: {} as never,
      qodercn: {} as never,
      trae: {} as never,
      cline: {} as never,
      loomy: {} as never,
      raccoon: {} as never,
      minimax: {} as never,
      zcode: {} as never,
      gemini: {} as never,
      officeace: {} as never,
    } as never,
    undefined,
  )
  const h = handler
  if (h === undefined) throw new Error('endpoint handler 未注册')

  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
    }))
    const body = await res.json() as { result: { ok: boolean; value?: any; error?: { message: string } } }
    return body.result
  }
  return { call, pool }
}

describe('opencode 的用量徽标能力登记（用户报障「只有 opencode 没有显示」）', () => {
  it('⚠️ balance 必须为 true —— false 会让徽标组件直接 return null', () => {
    // 徽标组件第一件事就是 supportsCreditBalance(provider)，为 false 就不渲染。
    // 我曾登记 false（认为 Zen 没有可查余额），那等于**把整个徽标挡死**，
    // 用户看到的是「opencode 没有用量」，而 Zen 明明有额度（402 余额不足）。
    //
    // ⚠️ 2026-10-08 改：能力表由 registry 派生，故改为**行为断言**
    //（原先正则扫 `credits-capabilities.js` 的 `opencode: Object.freeze({…})` 文本）。
    expect(CREDITS_CAPABILITIES.opencode).toBeDefined()
    expect(CREDITS_CAPABILITIES.opencode?.balance).toBe(true)
    expect(descriptorOf('opencode')?.credits.balance).toBe(true)
  })

  it('dailyCheckin 仍为 false（Zen 没有签到概念，不能谎报）', () => {
    expect(CREDITS_CAPABILITIES.opencode?.dailyCheckin).toBe(false)
  })

  // ⚠️ 此处原有一条「注释里记录了为什么不用 balance:false」的用例
  //（`readFileSync('src/provider-registry.ts')` + 正则扫注释散文），已删除：
  // 它想守的意图（不得把 opencode 改回 `balance: false`）**已被上面第一条
  // 行为断言逐字覆盖**（`descriptorOf('opencode')?.credits.balance === true`
  // 与 `CREDITS_CAPABILITIES.opencode?.balance === true`），故删掉不丢覆盖；
  // 而「为什么这么登记」由 registry 里该字段的注释承载，属人工评审范畴。
})

describe('opencode 的 credits.balances 分支（路 A：限额状态，不查远端余额）', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /** 造三种账号：可用 / 限额中 / 已停用。 */
  async function seed(pool: AccountPool) {
    await pool.addAccount({
      id: 'oc-on', provider: OPENCODE.id, nickname: '可用号', enabled: true,
      credentialRef: 'OPENCODE_ACCOUNT_ON', createdAt: 1, refreshable: false,
    })
    await pool.addAccount({
      id: 'oc-limited', provider: OPENCODE.id, nickname: '限额号', enabled: true,
      credentialRef: 'OPENCODE_ACCOUNT_LIMITED', createdAt: 2, refreshable: false,
      modelRateLimits: { 'big-pickle': Date.now() + 3_600_000 },
    })
    await pool.addAccount({
      id: 'oc-off', provider: OPENCODE.id, nickname: '停用号', enabled: false,
      credentialRef: 'OPENCODE_ACCOUNT_OFF', createdAt: 3, refreshable: false,
    })
  }

  /** 调一次端点；期间的任何 `fetch` 都会被记为调用（用于证明零网络）。 */
  async function balances() {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      fetched.push(String(input))
      throw new Error('opencode 的余额分支不得发网络请求')
    })
    const { call, pool } = makeRpc()
    await seed(pool)
    const result = await call('credits.balances', { provider: OPENCODE.id })
    return { result, fetched }
  }

  it('⚠️ 不发任何网络请求（数据全来自本地 modelRateLimits）', async () => {
    const { result, fetched } = await balances()
    expect(result.ok).toBe(true)
    expect(fetched, 'opencode 的余额分支不得触碰网络').toEqual([])
  })

  it('语义是「可用通道数」而非伪造的余额', async () => {
    const { result } = await balances()
    const rows = result.value.accounts as Array<{
      accountId: string
      balance: { total: number; expiredTotal: number; packages: Array<{ name: string; unit: string; total: number }> } | null
      error?: string
    }>
    const on = rows.find((r) => r.accountId === 'oc-on')!
    expect(on.balance?.total).toBe(1)
    // ⚠️ 单位必须是「通道」，不能伪装成积分余额。
    expect(on.balance?.packages[0]?.unit).toBe('通道')
    expect(on.balance?.packages[0]?.total).toBe(1)
    expect(on.error).toBeUndefined()

    // 限额中的通道：可用数为 0，且记进 expiredTotal（面板显示「另有 N 限额中」）。
    const limited = rows.find((r) => r.accountId === 'oc-limited')!
    expect(limited.balance?.total).toBe(0)
    expect(limited.balance?.expiredTotal).toBe(1)
    expect(limited.balance?.packages[0]?.name).toBe('1 个模型限额中')
  })

  it('限额中的通道给出可读原因（复用 error 字段约定）', async () => {
    const { result } = await balances()
    const rows = result.value.accounts as Array<{ accountId: string; error?: string }>
    expect(rows.find((r) => r.accountId === 'oc-limited')?.error).toMatch(/限额中/)
    expect(rows.find((r) => r.accountId === 'oc-off')?.error).toBe('已停用')
  })

  it('⚠️ 不伪造余额数字（Zen 没有公开的余额查询端点）', async () => {
    const { result } = await balances()
    // 反向：结果是「逐账号通道状态」而不是一个捏造的余额读数 ——
    // 它不是 `{ total: <某数字> }` 那种全局余额信封。
    expect(result.value).toHaveProperty('accounts')
    expect(result.value).not.toHaveProperty('total')
    const rows = result.value.accounts as Array<{ balance: { packages: Array<{ used: number }> } | null }>
    for (const row of rows) {
      // `used` 恒为 0：我们表达的是「通道是否可用」，不是「花掉了多少」。
      expect(row.balance?.packages[0]?.used).toBe(0)
    }
  })
})
