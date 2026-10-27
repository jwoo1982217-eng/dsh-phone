import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'
import { balanceCacheOf } from '../../src/provider-runtime.js'

/**
 * ★★ **后台刷新器的接线守卫**（走**真实 `apply()`**，不是源码文本断言）。
 *
 * ## ⚠️ 为什么必须有这个文件（brief Step 7 的如实结论）
 *
 * brief 的 Step 7 想验「删掉 `index.ts` 里的 `balanceRefresher.start()` ⇒ 用例变红」，
 * 但那条**做不到**：刷新器用例全部**直接 `new createBalanceRefresher(...)`**，
 * **绕过 `index.ts` 装配** ⇒ 实测把 `start()` 注释掉后那些用例**仍然全绿**。
 *
 * ⚠️ 而 brief 同时**明令禁止**用源码文本断言去凑这条守卫（本仓库实测过 5 条这类判据
 *   在 `if (false)` 死分支里恒绿）⇒ 本条**不复用**那套 `readIndexSource()` 写法。
 *
 * ## 本文件的做法（行为级，可复用 `refresh-scheduler-apply.spec.ts` 的现成辅助）
 *
 * 真跑一次 `apply()`，然后观察**真实可观测的输出**：
 * ① 刷新器 `start()` 时打的那条 `info` 日志（接了 `ctx.logger`）——
 *    删掉 `start()` 它就不出现 ⇒ 变红；
 * ② 进程级注册位里的 `balanceCacheOf()` 被真实填充 —— 证明刷新器**真的发了请求**，
 *    而不只是「武装了」。
 *
 * ## ⚠️ 为什么这两条都打在**行为**上
 *
 * 日志与缓存内容都不是源码文本；且它们都只在 `apply()` 真的跑到那段代码时才出现。
 * 探针本身（`settle()` 用 `vi.advanceTimersByTimeAsync` 而**不是** `setTimeout`）
 * 与被复用的那个文件同款，理由见那边的文件头。
 */

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

function makeCtxWithLogs(): { ctx: Context; infos: string[]; warns: string[] } {
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

  const infos: string[] = []
  const warns: string[] = []
  const logger = ctx.logger as unknown as Record<string, unknown>
  logger['info'] = (...a: unknown[]) => { infos.push(a.map(String).join(' ')) }
  logger['warn'] = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
  return { ctx, infos, warns }
}

/** 推进 fake timers 并冲干净微任务（⚠️ 不能用 setTimeout，见 `refresh-scheduler-apply.spec.ts`）。 */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('★★ 刷新器接线：真 apply() 之后确实武装并在后台刷新', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('★ apply() 之后刷新器已武装（日志落点 = start() 的唯一可观测输出）', async () => {
    const { ctx, infos } = makeCtxWithLogs()
    apply(ctx)
    await settle()

    expect(
      infos.some((s) => s.includes('余额缓存后台刷新器已武装')),
      '★★ 刷新器未武装 —— index.ts 的 ctx.effect 里没调 start()（接线缺口）',
    ).toBe(true)
  })

  it('★ 武装**不因空池而跳过**（用户登录后要立刻受益，不必重启插件）', async () => {
    // ⚠️ 与续期调度器同款的历史缺陷：空池时 `if (!accounts.length) return`
    //   ⇒ 用户登录后要等下次插件启动才被纳入。本条锁「空池也武装」。
    const { ctx, infos } = makeCtxWithLogs()
    apply(ctx)
    await settle()
    expect(
      infos.some((s) => s.includes('余额缓存后台刷新器已武装')),
      '★★ 空账号池下刷新器未武装（登录后要等重启才生效）',
    ).toBe(true)
  })

  /**
   * ★★ 刷新器**真的发了请求**（不是「只是武装了」）。
   *
   * ## ⚠️ 复审修正（2026-10-18）：这条原来是**零判别力**的，已重写
   *
   * 原标题写「刷新器真的发了请求（缓存被填充）」，断言却只有
   * `expect(cache).toBeDefined()` 与「尚未登录 ⇒ 无条目」—— 那是**纯前提校验**，
   * 对「刷新器发了请求」**零判别力**（删掉整条断言、或刷新器一轮都不刷，全绿）。
   *
   * ## ⚠️ 为什么判据**必须**点名那个凭据 ref
   *
   * 真实取数原语 `fetchBalanceReading` 在 `entry.credential === undefined` 时
   * 直接抛「凭据未提供」⇒ 刷新器若不解析凭据，它**照样会**往缓存里写一条
   * 失败读数。⇒ 「`peekStale` 有条目」这个判据分不出这两种情形
   * （恒绿形态）。⇒ 真正带牙的判别点是：**那枚 ref 被解析过**，
   * 而「凭据解析不了就不打上游」这条腿正是被它钉住的。
   *
   * ⚠️ 这与下一条（端到端那条「一个刷新周期内被纳入刷新」）**不同**：那条判的是
   *   「有条目」，本条判的是「凭据 ref 真的被解析了」—— 两者不可互相替代。
   */
  it('★★ 刷新器真的解析了凭据并把**含凭据的取数**跑起来了', async () => {
    const { ctx } = makeCtxWithLogs()
    apply(ctx)
    await settle()

    // ⚠️ 用一个**只有刷新器**会解析的 ref：面板/端点都不碰它 ⇒ 一旦被解析，
    //    只可能是刷新器干的（这条同时锁住「刷新器按 credentialRef 解析凭据」那条腿）。
    await (ctx as unknown as {
      credentials: { set(ref: string, value: string): Promise<void> }
    }).credentials.set('CODEARTS_REFRESHER_PROBE', JSON.stringify({ access_token: 'probe' }))

    const resolveSpy = vi.spyOn(
      (ctx as unknown as { credentials: { resolve(ref: string): Promise<unknown> } }).credentials,
      'resolve',
    )

    await (ctx as unknown as {
      accountPool: { addAccount(e: unknown): Promise<void> }
    }).accountPool.addAccount({
      id: 'refresher-credential-probe',
      provider: 'codearts',
      nickname: 'probe',
      enabled: true,
      credentialRef: 'CODEARTS_REFRESHER_PROBE',
      createdAt: Date.now(),
      expiresAt: Date.now() + 7_200_000,
      refreshable: true,
    })
    await settle()

    // ⚠️ 推进一个刷新周期（周期 = ttlMs 的一半 = 60s）+ 冲干净微任务。
    await vi.advanceTimersByTimeAsync(61_000)
    await settle()

    expect(
      resolveSpy.mock.calls.map((call) => String(call[0])).filter((r) => r.includes('REFRESHER_PROBE')),
      '★★ 刷新器一个周期内没有解析这个账号的凭据 ref ⇒ 它要么没刷，要么刷时传的 entry 没有 credential',
    ).not.toEqual([])

    const cache = balanceCacheOf()
    expect(cache, '★ 前提：balanceCache 已注册到进程级注册位').toBeDefined()
    expect(
      cache!.peekStale('codearts', 'refresher-credential-probe'),
      '★★ 刷新器取数之后缓存里必须留下条目（含凭据的取数才会走到这一步）',
    ).toBeDefined()
    resolveSpy.mockRestore()
  })

  it('★★ 登录一个账号后，一个刷新周期内它被纳入刷新（端到端）', async () => {
    const { ctx } = makeCtxWithLogs()
    apply(ctx)
    await settle()

    const pool = (ctx as unknown as {
      accountPool: { addAccount(e: unknown): Promise<void> }
    }).accountPool
    expect(pool, 'ctx.accountPool 未暴露').toBeDefined()
    // ⚠️⚠️ **必须先把凭据写进去**：刷新器在 `resolveCredential` 返回 undefined 时
    //   **刻意不打上游**（那一枪必然失败，纯浪费）⇒ 不写凭据的话它根本不会碰缓存。
    //   这条顺带锁住了「刷新器按 credentialRef 解析凭据」那条腿。
    await (ctx as unknown as {
      credentials: { set(ref: string, value: string): Promise<void> }
    }).credentials.set('CODEARTS_PROBE', JSON.stringify({ access_token: 'probe' }))
    await pool.addAccount({
      id: 'probe-login-1',
      provider: 'codearts',
      nickname: 'probe',
      enabled: true,
      credentialRef: 'CODEARTS_PROBE',
      createdAt: Date.now(),
      expiresAt: Date.now() + 7_200_000,
      refreshable: true,
    })
    await settle()

    // ⚠️ 推进一个刷新周期（60s = ttlMs 的一半）+ 冲干净微任务。
    //    ⚠️ 这里的真实取数会走 `fetchBalanceReading`：本用例**不能**让它打网络，
    //    靠的是「`runtimeOf('codearts').credits` 未注册 → 抛 unsupported provider」
    //    那条早退 ⇒ 记成失败读数，**但确实写了缓存**（本条只看「被纳入刷新」）。
    await vi.advanceTimersByTimeAsync(61_000)
    await settle()

    const cache = balanceCacheOf()
    expect(
      cache!.peekStale('codearts', 'probe-login-1'),
      '★★ 登录的账号在一个刷新周期内没有被刷新器纳入（缓存里连条目都没有）',
    ).toBeDefined()
  })
})
