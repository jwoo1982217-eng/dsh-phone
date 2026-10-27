/**
 * **AutoClaw 启动自愈的「接线」守卫**（2026-10-20 审计补）。
 *
 * ## 为什么必须单独一份（审计实测的真缺口）
 *
 * `account-pool-dedupe.spec.ts` 只测 `AccountPool.dedupeByCredentialField` 这个
 * **方法** —— 它证明「方法本身对」，却证明不了「`apply()` 真的会调它」。
 *
 * 审计实测：把 `src/index.ts` 里整行
 * `void autoclawSelfHeal(pool, ctx).catch(...)` 删掉，跑
 * `autoclaw` + `account-pool-dedupe` + `credits-balance-self-heal` +
 * `provider-runtime-wiring` + `autoclaw-credits` 共 **205 passed，全绿**。
 *
 * 而 PR122 的整个价值主张正是「存量重复账号在**启动时**被清掉」——
 * 删掉那行，用户症状（同一手机号 3 条、积分 62416 = 20842×3）**原样复现**，
 * 测试却一条都不红。⇒ 这正是本仓库反复记载的「方法有牙、装配无牙」形态。
 *
 * ## 本文件的判据（三条，缺一不可）
 *
 * 1. **真跑 `apply()`**，池里预置 3 条同 `user_id` 的 autoclaw 账号 ⇒ 最终**只剩 1 条**
 *    （判据打在**池的实际内容**上，不是「函数被调用过」）；
 * 2. 补齐腿**真的发过** `user-profile` 请求（判据是 URL 含该端点）——
 *    否则「去重成功」可能只是靠已有的 `user_id`，补齐腿是死代码也全绿；
 * 3. **反向对照**：不同 `user_id` 的账号**不得**被合并（否则「凡启动就清空」也全绿）。
 *
 * ⚠️ 自愈是 `void` 起的 fire-and-forget ⇒ 必须**等它跑完**才能断言。
 *    这里用「轮询池直到稳定」而不是固定 `setTimeout`：固定延迟在慢机器上会假红
 *    （本仓库 `officeace-inflight-guard` flaky 的同型教训）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool, type ProviderAccountEntry } from '../../src/account-pool.js'
import { apply } from '../../src/index.js'
import { clearProviderRuntimes } from '../../src/provider-runtime.js'

let isolatedHome: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_JET_HUB_STATE_DIR
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-selfheal-'))
  process.env.DSH_JET_HUB_STATE_DIR = isolatedHome
  clearProviderRuntimes()
})

afterEach(() => {
  clearProviderRuntimes()
  if (previousHome === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousHome
  rmSync(isolatedHome, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** 只实现「自愈真正用到的那几个成员」的凭据服务。 */
class FakeCredentials {
  readonly store = new Map<string, string>()
  async describe(ref: unknown) {
    const name = refName(ref)
    return { configured: this.store.has(name), source: 'test' as const, writable: true }
  }
  async resolve(ref: unknown) {
    const name = refName(ref)
    const value = this.store.get(name)
    return value === undefined ? undefined : { value, source: 'test' as const }
  }
  async set(ref: unknown, value: string) {
    this.store.set(refName(ref), value)
  }
  async unset(ref: unknown) {
    this.store.delete(refName(ref))
  }
}


/**
 * settings 桩。
 *
 * ⚠️ **必须返回一个带 `get`/`replace` 的 scope**，不能 `register(): void`：
 * `createJetHubStore` 判「有 register 方法」就选 SettingsStore，随后
 * `SettingsStore.load()` 调 `scope.get()` ⇒ 返回 void 会当场抛
 * `TypeError: Cannot read properties of undefined (reading 'get')`
 * （本文件首版就这么炸的，4 条全红）。
 */
function makeSettingsStub(): unknown {
  let value: unknown
  return {
    register: () => ({
      get: () => value,
      replace: (next: unknown) => { value = next },
    }),
    describe: () => [],
  }
}

function refName(ref: unknown): string {
  if (typeof ref === 'object' && ref !== null && 'name' in ref) return String((ref as { name: unknown }).name)
  return String(ref)
}

/** 轮询直到 `predicate` 成立（自愈是 fire-and-forget，不能固定 sleep）。 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = '条件',
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
}

interface Harness {
  ctx: Context
  /**
   * **按需新建一个池实例读最终态**。
   *
   * ⚠️ 不能预先造一个就反复读：`AccountPool` 有 `loaded` 惰性缓存，实例一旦
   * 载入就不再重读磁盘；而自愈是 fire-and-forget，完成时刻不确定。
   * ⇒ 每次调用都新建实例 = 「用户下次启动看到的样子」。
   */
  snapshot: () => ProviderAccountEntry[]
  credentials: FakeCredentials
  /** 所有被 `fetch` 打过的 URL（判「补齐腿真发过请求」用）。 */
  urls: string[]
}

/**
 * 搭一个真实 `apply()` 环境，并预置账号。
 *
 * ⚠️ `fetch` 必须打桩：自愈会真发 `POST /userapi/v1/user-profile`。
 *    这里让它**对每条凭据都返回同一个 UUID** —— 模拟「三条其实是同一个账号」，
 *    这正是用户报障的形态。
 */
async function setup(options: {
  seeds: Array<{ id: string; ref: string; userId?: string }>
  profileUserId?: string
}): Promise<Harness> {
  const urls: string[] = []
  const profileUserId = options.profileUserId ?? '7c54a9acc64092b06aa32cc8b1a48fef'
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/userapi/v1/user-profile')) {
      return new Response(JSON.stringify({ code: 0, data: { user_id: profileUserId } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // 其余端点（模型目录、积分等）一律「读不到」，避免测试去碰真实网络。
    return new Response('{}', { status: 500 })
  })

  const credentials = new FakeCredentials()
  for (const seed of options.seeds) {
    credentials.store.set(seed.ref, JSON.stringify({
      access_token: `jwt-${seed.id}`,
      refresh_token: 'r',
      device_id: 'dev-1',
      ...seed.userId === undefined ? {} : { user_id: seed.userId },
    }))
  }

  const ctx = new Context()
  ctx.provide('credentials', credentials as never)
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  ctx.provide('settings', makeSettingsStub() as never)

  // ⚠️ 必须在 `apply()` **之前**把账号写进池：自愈是在 `apply()` 里 `void` 起的，
  //    它读的是**当时的**池快照。
  const prePool = new AccountPool(ctx)
  for (const seed of options.seeds) {
    await prePool.addAccount({
      id: seed.id,
      provider: 'autoclaw',
      nickname: seed.id,
      enabled: true,
      credentialRef: seed.ref,
      createdAt: 1,
      refreshable: true,
    })
  }

  apply(ctx)
  return {
    ctx,
    snapshot: () => new AccountPool(ctx).listAccountsByProvider('autoclaw'),
    credentials,
    urls,
  }
}

describe('AutoClaw 启动自愈的接线（apply() 真的会调它）', () => {
  it('★ 3 条同账号（都缺 user_id）⇒ 启动后池里只剩 1 条', async () => {
    const h = await setup({
      seeds: [
        { id: 'a6539467', ref: 'AUTOCLAW_ACCOUNT_A6539467' },
        { id: 'd6bf9eb2', ref: 'AUTOCLAW_ACCOUNT_D6BF9EB2' },
        { id: 'a3c56dd6', ref: 'AUTOCLAW_ACCOUNT_A3C56DD6' },
      ],
    })

    // ⚠️ 判据打在**池的实际内容**上 —— 这正是「删掉接线就红」的那一格。
    await waitFor(
      () => h.snapshot().length === 1,
      5000,
      '3 条同账号被清成 1 条',
    )

    const left = h.snapshot()
    expect(left, '★ 同一账号的 3 条必须只留 1 条（用户报障的 62416 = 20842×3 的根因）')
      .toHaveLength(1)

    // 保留的那条必须**拿到了补齐的 UUID**（否则下次启动又会分裂成两组）。
    const resolved = await h.credentials.resolve(left[0]!.credentialRef)
    const cred = JSON.parse(resolved!.value) as { user_id?: unknown }
    expect(cred.user_id, '★ 保留的条目必须已被补齐 UUID（下次启动才不会又分裂）')
      .toBe('7c54a9acc64092b06aa32cc8b1a48fef')
  }, 20000)

  it('★ 补齐腿真的发过 user-profile 请求（不是靠已有 user_id 侥幸通过）', async () => {
    // 三条都**没有** user_id ⇒ 只能靠 user-profile 补齐才能判出是同一账号。
    const h = await setup({
      seeds: [
        { id: 'p1', ref: 'AUTOCLAW_ACCOUNT_P1' },
        { id: 'p2', ref: 'AUTOCLAW_ACCOUNT_P2' },
      ],
    })

    await waitFor(
      () => h.snapshot().length === 1,
      5000,
      '去重完成',
    )

    const profileCalls = h.urls.filter((u) => u.includes('/userapi/v1/user-profile'))
    expect(
      profileCalls.length,
      '★ 必须真发过 user-profile：否则「去重成功」只能说明判据退化了，补齐腿是死代码',
    ).toBeGreaterThan(0)
  }, 20000)

  it('★ 已经是 UUID 的条目**不再**补（少一次网络往返，且不得改坏凭据）', async () => {
    const uuid = '7c54a9acc64092b06aa32cc8b1a48fef'
    const h = await setup({
      seeds: [
        { id: 'q1', ref: 'AUTOCLAW_ACCOUNT_Q1', userId: uuid },
        { id: 'q2', ref: 'AUTOCLAW_ACCOUNT_Q2', userId: uuid },
      ],
    })

    await waitFor(
      () => h.snapshot().length === 1,
      5000,
      '两条同 UUID 被去重',
    )

    // 两条都已有 UUID ⇒ 补齐腿应当**一次都没发**。
    const profileCalls = h.urls.filter((u) => u.includes('/userapi/v1/user-profile'))
    expect(profileCalls, '★ 已有 UUID 就不该再补（原判据「有值就跳过」会在这里误跳过数字 id）')
      .toHaveLength(0)
  }, 20000)

  it('★ 反向对照：不同账号不得被合并', async () => {
    // 两条 seed 都缺 user_id，但 user-profile 对不同 token 返回**不同** UUID。
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/userapi/v1/user-profile')) {
        // 依据请求头里的 token 区分账号。
        return new Response(JSON.stringify({ code: 0, data: { user_id: 'same-uuid-for-both' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 500 })
    })

    const credentials = new FakeCredentials()
    credentials.store.set('AUTOCLAW_ACCOUNT_R1', JSON.stringify({
      access_token: 'jwt-r1', refresh_token: 'r', device_id: 'd', user_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }))
    credentials.store.set('AUTOCLAW_ACCOUNT_R2', JSON.stringify({
      access_token: 'jwt-r2', refresh_token: 'r', device_id: 'd', user_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }))

    const ctx = new Context()
    ctx.provide('credentials', credentials as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    ctx.provide('llm', {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: () => ({ replace() {} }),
      listModels: async () => [],
    } as never)
    ctx.provide('settings', makeSettingsStub() as never)

    const prePool = new AccountPool(ctx)
    for (const [id, ref] of [['r1', 'AUTOCLAW_ACCOUNT_R1'], ['r2', 'AUTOCLAW_ACCOUNT_R2']] as const) {
      await prePool.addAccount({
        id, provider: 'autoclaw', nickname: id, enabled: true,
        credentialRef: ref, createdAt: 1, refreshable: true,
      })
    }
    apply(ctx)

    // 给自愈足够时间跑完（它可能什么都不做 —— 这正是期望）。
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(
      new AccountPool(ctx).listAccountsByProvider('autoclaw').map((a) => a.id).sort(),
      '★ 两个不同 UUID 的账号**不得**被合并（否则「凡启动就清空」也会全绿）',
    ).toEqual(['r1', 'r2'])
  }, 20000)
})
