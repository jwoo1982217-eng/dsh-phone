/**
 * ZCode **凭据解析**与**fetch 注入**的回归测试。
 *
 * ## 守的是两个实测发现的真实缺陷
 *
 * ### 缺陷 1：凭据 ref 不匹配 → 「登录成功但面板说未配置」
 *
 * RPC `account.create` 把凭据写在 **`ZCODE_ACCOUNT_XXXX`**（`refName`），
 * 而 `ZcodeAuth.current()` 早期只读固定的 **`ZCODE_CREDENTIAL`**。
 *
 * 后果（实测）：
 *   - 适配器**能用**（它读账号条目的 `credentialRef`，即 ACCOUNT_ 那个）
 *   - 但 `probe()` / `fetchBalance()` / `status()` / `fetchCheckinStatus()`
 *     全走 `current()` → **全部读不到** → 界面「未配置」、积分查询失败
 *
 * ⚠ 这个缺口**曾经**会被「回退读本机官方凭据文件」**掩盖**：装了官方
 * 客户端的机器上现象消失，只有**没装**的用户才看得到。而那条回退路已随
 * 2026-10-05 的决策（「不读本机 ZCode 数据」）整体删除 ⇒ 现在**每个**用户
 * 都会看到，缺陷 1 的回归价值反而变高了。
 *
 * ### 缺陷 2：`fetchImpl` 是死参数
 *
 * `zcode-upstream.ts` 的 `fetchWithTimeout` 早期用**全局 `fetch`**，
 * 而所有公开函数都接收 `fetchImpl` **却从不往下传** —— 于是
 * `ZcodeAuth` 注入的桩对「额度 / 签到 / captcha 配置」全部无效：
 * 单测会真的打上游，且 `fetchImpl` 沦为签名装饰。
 *
 * 症状隐蔽：`ZcodeAdapter` 的推理路径**自己**用 `this.fetchImpl`，
 * 所以「推理桩得住、额度桩不住」，看起来像额度接口的问题。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'

/** 内存凭据存储。 */
class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeCtx(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  // Jet Hub 的 account_pool 存储（AccountPool 需要 settings 或 file 后端）。
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  return { ctx, credentials }
}

/** 一份完整的凭据 JSON。 */
const CRED_JSON = JSON.stringify({
  zcode_jwt: 'POOL-JWT',
  device_mid: '11111111-2222-3333-4444-555555555555',
  account_label: '池中账号',
  source: 'plugin',
})

describe('ZCode 凭据解析：必须认账号池里的 ref（缺陷 1）', () => {
  it('★ 凭据在 ZCODE_ACCOUNT_XXXX（RPC 登录的 ref）时 current() 也能读到', async () => {
    const { ctx, credentials } = makeCtx()
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'zcode-1',
      provider: ZCODE.id,
      nickname: 'z',
      enabled: true,
      credentialRef: 'ZCODE_ACCOUNT_ABCD1234',
      refreshable: false,
      createdAt: 1,
    })
    await credentials.set('ZCODE_ACCOUNT_ABCD1234', CRED_JSON)

    const auth = new ZcodeAuth(ctx, {
      accountPool: pool,
      // ⚠ 必须屏蔽官方文件，否则会「回退读到真实凭据」而假通过。
    })

    const current = await auth.current()
    expect(current).toBeDefined()
    expect(current?.zcode_jwt).toBe('POOL-JWT')
    expect(current?.account_label).toBe('池中账号')
  })

  it('★ status() / fetchBalance() / probe() 都能用（它们都走 current()）', async () => {
    const { ctx, credentials } = makeCtx()
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'zcode-1', provider: ZCODE.id, nickname: 'z', enabled: true,
      credentialRef: 'ZCODE_ACCOUNT_X1', refreshable: false, createdAt: 1,
    })
    await credentials.set('ZCODE_ACCOUNT_X1', CRED_JSON)

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/billing/balance')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { balances: [{ show_name: 'GLM-5.3-Flash', total_units: 100, remaining_units: 77, used_units: 23 }] },
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const auth = new ZcodeAuth(ctx, {
      accountPool: pool,
      fetchImpl: fetcher,
    })

    // 这三个方法在缺修复时全部失效。
    expect((await auth.status()).configured).toBe(true)
    const balance = await auth.fetchBalance()
    expect(balance?.remaining).toBe(77)
    expect((await auth.probe()).available).toBe(true)
  })

  it('★ 账号池优先于单凭据 ref（与适配器的解析顺序一致）', async () => {
    const { ctx, credentials } = makeCtx()
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'zcode-1', provider: ZCODE.id, nickname: 'z', enabled: true,
      credentialRef: 'ZCODE_ACCOUNT_POOL', refreshable: false, createdAt: 1,
    })
    await credentials.set('ZCODE_ACCOUNT_POOL', CRED_JSON)
    // 单凭据 ref 也有一份（不同的）。
    await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify({
      zcode_jwt: 'FALLBACK-JWT', device_mid: 'aaaa-bbbb',
    }))

    const auth = new ZcodeAuth(ctx, { accountPool: pool })
    // 账号池是用户的**显式**登录，应优先。
    expect((await auth.current())?.zcode_jwt).toBe('POOL-JWT')
  })

  it('账号池为空时回退到单凭据 ref', async () => {
    const { ctx, credentials } = makeCtx()
    const pool = new AccountPool(ctx)
    await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify({
      zcode_jwt: 'FALLBACK-JWT',
      device_mid: 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }))
    const auth = new ZcodeAuth(ctx, { accountPool: pool })
    expect((await auth.current())?.zcode_jwt).toBe('FALLBACK-JWT')
  })

  it('★ 账号池里凭据损坏时继续试下一个（不整体失败）', async () => {
    const { ctx, credentials } = makeCtx()
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'zcode-bad', provider: ZCODE.id, nickname: 'bad', enabled: true,
      credentialRef: 'ZCODE_ACCOUNT_BAD', refreshable: false, createdAt: 1,
    })
    await pool.addAccount({
      id: 'zcode-good', provider: ZCODE.id, nickname: 'good', enabled: true,
      credentialRef: 'ZCODE_ACCOUNT_GOOD', refreshable: false, createdAt: 2,
    })
    await credentials.set('ZCODE_ACCOUNT_BAD', 'not-json')
    await credentials.set('ZCODE_ACCOUNT_GOOD', CRED_JSON)

    const auth = new ZcodeAuth(ctx, { accountPool: pool })
    expect((await auth.current())?.zcode_jwt).toBe('POOL-JWT')
  })

  it('★ 不看 enabled —— 停用账号的凭据仍可用于面板展示', async () => {
    const { ctx, credentials } = makeCtx()
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'zcode-disabled', provider: ZCODE.id, nickname: 'd', enabled: false,
      credentialRef: 'ZCODE_ACCOUNT_DIS', refreshable: false, createdAt: 1,
    })
    await credentials.set('ZCODE_ACCOUNT_DIS', CRED_JSON)
    const auth = new ZcodeAuth(ctx, { accountPool: pool })
    // 与 AGENTS.md 的既有约定一致：停用只影响自动选号。
    expect((await auth.current())?.zcode_jwt).toBe('POOL-JWT')
  })

  it('没有账号池时退回单凭据路径（不抛错）', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set(ZCODE.defaultCredentialRef, CRED_JSON)
    const auth = new ZcodeAuth(ctx)
    expect((await auth.current())?.zcode_jwt).toBe('POOL-JWT')
  })
})

describe('ZCode fetch 注入：必须真的生效（缺陷 2）', () => {
  it('★ fetchZcodeBalance 走注入的 fetch（不是全局 fetch）', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set(ZCODE.defaultCredentialRef, CRED_JSON)
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({
        code: 0, data: { balances: [{ show_name: 'x', total_units: 10, remaining_units: 3 }] },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: fetcher,
    })
    await auth.fetchBalance()
    expect(fetcher).toHaveBeenCalled()
    expect(calls.some((u) => u.includes('/billing/balance'))).toBe(true)
  })

  it('★ fetchZcodeCaptchaConfig 也走注入的 fetch', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set(ZCODE.defaultCredentialRef, CRED_JSON)
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({
        code: 0, data: { configs: { captcha: { region: 'cn', prefix: 'p', sceneId: 's' } } },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: fetcher,
    })
    const config = await auth.fetchCaptchaConfig()
    expect(config).toEqual({ region: 'cn', prefix: 'p', sceneId: 's' })
    expect(calls.some((u) => u.includes('/client/configs'))).toBe(true)
    // ⚠ platform 必须是 unknown（其它值上游回 400 code 3001）。
    expect(calls.some((u) => u.includes('platform=unknown'))).toBe(true)
  })

  it('★ 签到链路（激活上报 + preview）也走注入的 fetch', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set(ZCODE.defaultCredentialRef, CRED_JSON)
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/billing/preview')) {
        return new Response(JSON.stringify({ code: 0, data: { plans: [] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: fetcher,
    })
    await auth.fetchCheckinStatus()
    // 两条激活上报 + 一次 preview。
    expect(calls.filter((u) => u.includes('/event/report'))).toHaveLength(2)
    expect(calls.some((u) => u.includes('/billing/preview'))).toBe(true)
  })

  it('全部请求都由注入的 fetch 发出（没有任何真实网络调用）', async () => {
    const { ctx, credentials } = makeCtx()
    await credentials.set(ZCODE.defaultCredentialRef, CRED_JSON)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { balances: [], plans: [] },
    }), { status: 200 })) as unknown as typeof fetch
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: fetcher,
    })
    await Promise.all([
      auth.fetchBalance(),
      auth.fetchCaptchaConfig(),
      auth.fetchCheckinStatus(),
    ])
    expect(fetcher).toHaveBeenCalled()
    const calls = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls
    // 每个 URL 都应当是 zcode 上游。
    for (const call of calls) {
      expect(String(call[0])).toMatch(/^https:\/\/zcode\.z\.ai\//)
    }
  })
})
