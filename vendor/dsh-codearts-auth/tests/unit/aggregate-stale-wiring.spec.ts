/**
 * ★★ **生产 `balanceOf` 的接线守卫**（走**真实 `apply()`**，不是源码文本断言，
 *   也不是测试侧镜像）。
 *
 * ## ⚠️⚠️ 为什么本文件必须独立于 `aggregate-stale.spec.ts`（实测记录）
 *
 * `aggregate-stale.spec.ts` 的用例全部驱动 `balanceOfViaCache` —— 那是
 * `src/index.ts` 里 `balanceOf` 的**镜像**（测试侧的第二份实现）。
 *
 * ⚠️⚠️ **实测（2026-10-18）：把 `src/index.ts` 里 `if (reading.stale === true) return null`
 * 那一行删掉，`aggregate-stale.spec.ts` 实测 6/6 仍然全绿。**
 *
 * ⇒ 那个 spec 对生产改动**零判别力**。这正是本仓库红线「同一语义两套判据」的
 * 典型形态：**镜像不会跟着生产代码变**，于是「守卫全绿」什么也证明不了
 * （与 `docs/agent-notes/client-ui.md` 记的「`if (false)` 恒绿」同族）。
 *
 * ## 本文件的做法（行为级，与 `balance-refresher-wiring.spec.ts` 同款思路）
 *
 * 真跑一次 `apply()`，**拦截** `createExpiryProbe`（`src/index.ts` 用它装配折算），
 * 把装配时真正传进去的 `balanceOf` 闭包**截获**出来 ⇒ 再用真实的
 * `balanceCacheOf()`（`apply()` 注册的共享缓存）驱动它。
 *
 * ⚠️ 判据是**返回值**与**折算结果** —— 都是可观测量，**不是**源码文本。
 * 严禁改成读 `src/index.ts` 源码文本做正则断言（本仓库实测过 5 条那类判据
 * 在 `if (false)` 死分支里恒绿）。
 *
 * ## ⚠️ 怎么让**真实缓存**读到陈旧值
 *
 * 共享缓存的 `now` 缺省是 `() => Date.now()`，而 `ttlMs` = 120 秒 ⇒ 不能真等。
 * ⇒ 用 `vi.useFakeTimers()` + `vi.setSystemTime()` 推进**系统时钟**（这是
 * `Date.now()` 的真实来源，故共享缓存能看见）。
 * ⚠️ 只 `setSystemTime`、不 `advanceTimersByTime` ⇒ 刷新器的定时器**不**触发，
 *   不会有后台请求干扰本用例（读路径本身一个请求都不发，见 `balance-cache.ts`）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type BalanceOf = (provider: string, accountId: string, credential: unknown) => Promise<unknown>

/**
 * ⚠️⚠️ **必须先 mock 再 import `index.ts`**：`vi.mock` 是提升的，
 *   而 `src/index.ts` 在模块顶层就把 `createExpiryProbe` 绑进闭包 ⇒
 *   不拦截就只能拿到**已经装配好**的实例，拿不到回调本身。
 */
const captured = vi.hoisted(() => ({ balanceOf: undefined as BalanceOf | undefined }))

vi.mock('../../src/aggregate-expiry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/aggregate-expiry.js')>()
  return {
    ...actual,
    createExpiryProbe: (
      pool: never,
      firstModelIdOf: never,
      options?: { balanceOf?: BalanceOf },
    ) => {
      // ⚠️ 只截获回调，**原样转发** ⇒ 被测逻辑仍是真实实现。
      captured.balanceOf = options?.balanceOf
      return actual.createExpiryProbe(pool, firstModelIdOf, options)
    },
  }
})

const { apply } = await import('../../src/index.js')
const { balanceCacheOf } = await import('../../src/provider-runtime.js')
const { UNUSABLE } = await import('../../src/aggregate-core.js')

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: 'fake', writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/** 最小可用的 ctx（与 `balance-refresher-wiring.spec.ts` 同款）。 */
function makeCtx(): Context {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace: () => {} }),
    registerAdapter: () => ({ replace: () => {} }),
  } as never)
  let stored: unknown = { accounts: [], disabledModels: {} }
  ctx.provide('settings', {
    register: () => ({
      get: () => stored,
      replace: async (value: unknown) => { stored = value },
    }),
    describe: () => [],
    configure: () => () => {},
  } as never)
  return ctx
}

/** 冲干净微任务（真实取数会走 `await`，本文件不需要推进定时器）。 */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

/** 跑一次真实装配，取回截获到的生产 `balanceOf` 与真实的共享缓存。 */
async function assemble(): Promise<{ balanceOf: BalanceOf; cache: NonNullable<ReturnType<typeof balanceCacheOf>> }> {
  captured.balanceOf = undefined
  const ctx = makeCtx()
  apply(ctx)
  await settle()
  const cache = balanceCacheOf()
  expect(cache, '★ 前提：apply() 已把共享余额缓存注册到进程级注册位').toBeDefined()
  expect(captured.balanceOf, '★★ 没截获到 balanceOf（index.ts 的装配变了？）').toBeDefined()
  return { balanceOf: captured.balanceOf!, cache: cache! }
}

const ACCOUNT = 'stale-balance-probe'
const UPSTREAM_VALUE = { total: 100, packages: [] }

describe('★★ 生产 balanceOf：陈旧读数判 UNUSABLE（真 apply() 接线守卫）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('★★ 新鲜读数照常折算（不得把正常读数误判成不可用）', async () => {
    const { balanceOf, cache } = await assemble()
    cache.write('buddy', ACCOUNT, { at: Date.now(), value: UPSTREAM_VALUE })

    const value = await balanceOf('buddy', ACCOUNT, { access_token: 't' })
    expect(value, '★★ 新鲜读数必须可用（否则本改动会让聚合恒空）').toEqual(UPSTREAM_VALUE)
    expect(value, '★★ 新鲜读数绝不能是 null（那是 UNUSABLE 的信号）').not.toBeNull()
  })

  it('★★ 陈旧读数返回 null（= 折算判 UNUSABLE）', async () => {
    const { balanceOf, cache } = await assemble()
    cache.write('buddy', ACCOUNT, { at: Date.now(), value: UPSTREAM_VALUE })

    // ⚠️ 跨过共享缓存的 120s TTL（只用 setSystemTime，不触发刷新器定时器）。
    vi.setSystemTime(new Date(Date.now() + 130_000))

    expect(
      cache.peekStale('buddy', ACCOUNT)?.stale,
      '★ 前提：这条读数确实已经陈旧（否则本用例什么都没验）',
    ).toBe(true)

    const value = await balanceOf('buddy', ACCOUNT, { access_token: 't' })
    // ⚠️⚠️ **必须是 `null` 而不是 `undefined`**：契约（`aggregate-expiry.ts:275`）
    //   规定 `undefined` = 「没有共享读数 ⇒ 回落到自己发请求」，而 `null` 才是
    //   「结论：不可用」（`sharedPackageExpiry` 对 `null` 判 `UNUSABLE`）。
    //   写成 `undefined` 的实测后果：陈旧账号每次折算**多打一次上游请求**。
    expect(value, '★★ 陈旧读数必须返回 null（UNUSABLE 的结论信号）').toBeNull()
    expect(
      value,
      '★★ 绝不能是 undefined —— 那个值会让折算回落到自己发请求（缺陷未修）',
    ).not.toBeUndefined()
  })

  it('★ 上游恢复后重新可用（反向对照：不得把 UNUSABLE 永久钉住）', async () => {
    // ⚠️ 反向对照：没有这条，上一条可能因「陈旧恒 null」而全绿。
    const { balanceOf, cache } = await assemble()
    cache.write('buddy', ACCOUNT, { at: Date.now(), value: UPSTREAM_VALUE })
    vi.setSystemTime(new Date(Date.now() + 130_000))
    expect(await balanceOf('buddy', ACCOUNT, { access_token: 't' }), '★ 前置：陈旧时判不可用')
      .toBeNull()

    // 上游恢复并把新值写回缓存（`write` 是 `credits.balances` 端点回写的同一条腿）
    cache.write('buddy', ACCOUNT, { at: Date.now(), value: UPSTREAM_VALUE })

    const value = await balanceOf('buddy', ACCOUNT, { access_token: 't' })
    expect(value, '★ 恢复后必须重新可用（`stale` 是读数的属性，不是账号的判决）')
      .toEqual(UPSTREAM_VALUE)
  })

  it('★★ 失败读数返回 undefined（不得把「取数失败」误判成 UNUSABLE）', async () => {
    // ⚠️ 与「陈旧 ⇒ null」方向相反的一条：失败读数**必须**是 `undefined`。
    //   写成 `null` 会让折算**跳过回落** ⇒ 缓存一坏就静默少一个候选渠道
    //   （正是 `balance-cache-wiring.spec.ts` 记的「不得把失败当结论」）。
    const { balanceOf } = await assemble()
    // 从未读过的账号 ⇒ 无可兼顶值 ⇒ 走回源；真实取数会失败（未注册 credits
    // runtime ⇒ `unsupported provider`）⇒ 记成失败读数。
    const value = await balanceOf('buddy', 'never-read-account', { access_token: 't' })
    expect(value, '★★ 失败读数必须折算成 undefined（= 回落自己取）').toBeUndefined()
    expect(value, '★★ 失败读数绝不能是 null').not.toBeNull()
    expect(UNUSABLE, '（确认上面两条不是碰巧在比同一个哨兵值）').toBe(-1)
  })
})