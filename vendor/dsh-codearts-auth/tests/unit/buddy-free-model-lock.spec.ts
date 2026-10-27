/**
 * 免费模型**跳过永久积分锁定**的回归（`src/buddy-adapter.ts` + `src/index.ts`）。
 *
 * ## 为什么单独守这个
 *
 * 用户报障：**用免费模型**（消耗 0 积分）却报
 * 「WorkBuddy：没有可用账号。已锁定永久积分，而所有账号的『N 天内到期』积分都已用尽」，
 * 而账号余额查询正常、Jet Hub 面板显示有钱 —— 即「账户可用却提示异常失败」。
 *
 * 根因是**接线缺失**，不是算法错：旧编排只问「锁没锁 + 有没有临期积分」，
 * 从不问「这个模型要不要钱」。免费模型既不消耗临时积分也不消耗永久积分，
 * 却被那道门一并拦下。锁定要保护的是「别把永久积分烧掉」，与免费模型无关。
 *
 * ## 两条必须同时成立的约定
 *
 * 1. **确定免费才放开**：`isFreeModel` 只在能确认 0 积分时返回 true。
 *    把付费模型误判成免费会绕开锁定、**真烧掉永久积分且不可撤回** ——
 *    这是本补丁最危险的失效方向，故边界用例逐条锁死。
 * 2. **免费路径仍受模型级限流约束**：免费不等于无视限流标记。
 *
 * ## ⚠️ Task 6 的改写（2026-10-08）
 *
 * 原先「接线（源码级）」一组锚定的是 `src/index.ts` 里**已被删除**的那个编排闭包
 * 声明与它的免费判据读取处（两个锚点文本见 git 历史 `d35d9e3`）。Task 6 把闭包
 * 收敛进 `createCredentialResolver` 并删除该闭包之后，那些锚点全部消失 ⇒ 6 条红。
 *
 * 现在改为**驱动真实 `apply()`**：把「免费模型不被锁定误拦」这件事直接测出来
 * （免费模型 + 锁定 + 只剩永久积分 ⇒ 仍能取到凭据）。这比文本断言强得多 ——
 * 旧断言只能证明「源码里有一行把免费信号交给编排」，新断言证明**它真的生效**。
 *
 * ⚠️ **注释里不复写那两个被删掉的锚点原文**：它们是「该锚点已消失」这类核对会
 * grep 的字符串，写进注释会让核对**假命中**（与 `raccoon-wiring.spec.ts` 同约定）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const adapterSource = readFileSync(resolve(here, '../../src/buddy-adapter.ts'), 'utf8').replace(/\r\n/g, '\n')
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 剥掉注释后的源码。⚠️ 接线断言必须只看代码，不能因「注释里提到某符号」而误判。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)
const adapterCode = codeOnly(adapterSource)

/** 复现 `isFreeModel` 的判据（与源码同口径，供行为级用例使用）。 */
function isZeroRate(rate: string | undefined): boolean {
  return rate === 'x0' || rate === '免费'
}

function judgeFree(meta: { creditsRate?: string; discountedCreditsRate?: string } | undefined): boolean {
  if (meta === undefined) return false
  return isZeroRate(meta.creditsRate) || isZeroRate(meta.discountedCreditsRate)
}

describe('免费模型跳过永久积分锁定', () => {
  describe('判据（行为级）', () => {
    it('credits 直给 x0 视为免费', () => {
      expect(judgeFree({ creditsRate: 'x0' })).toBe(true)
    })

    it('促销价 x0 视为免费', () => {
      expect(judgeFree({ creditsRate: 'x0.5', discountedCreditsRate: 'x0' })).toBe(true)
    })

    it('促销 factor:0 写入的中文串「免费」也视为免费', () => {
      // ⚠️ 这条最容易漏：parsePromotions 在 factor === 0 时写的是 `rate = '免费'`，
      // **不是** `x0`。只认 `x0` 会让夜间免费模型仍被拦截。
      expect(judgeFree({ creditsRate: 'x0.29', discountedCreditsRate: '免费' })).toBe(true)
    })

    it('付费模型一律不视为免费（误判会绕开锁定、真烧永久积分）', () => {
      expect(judgeFree({ creditsRate: 'x0.29' })).toBe(false)
      expect(judgeFree({ creditsRate: 'x0.5', discountedCreditsRate: 'x0.17' })).toBe(false)
      expect(judgeFree({ creditsRate: 'x1.62' })).toBe(false)
    })

    it('无倍率信息 / 未知模型不视为免费（保守方向）', () => {
      expect(judgeFree(undefined)).toBe(false)
      expect(judgeFree({})).toBe(false)
      expect(judgeFree({ creditsRate: '' })).toBe(false)
    })

    it('x0 前缀的其它倍率不被误判（x0.29 不是免费）', () => {
      // 防止有人把判据写成 startsWith('x0') —— 那会把 x0.29 也判成免费。
      expect(judgeFree({ creditsRate: 'x0.29' })).toBe(false)
      expect(judgeFree({ creditsRate: 'x0.03' })).toBe(false)
    })
  })

  describe('isFreeModel 源码约定', () => {
    it('存在 isFreeModel 方法且为 async（必须先 await 远端目录）', () => {
      expect(adapterCode).toMatch(/async isFreeModel\(/)
    })

    it('先确保远端目录已加载，否则判据静默失效', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      expect(body.slice(0, end)).toContain('await this.ensureRemoteModels()')
    })

    it('只信远端 remoteMeta（兜底表没有倍率字段，不可作为免费依据）', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      const fn = body.slice(0, end)
      expect(fn).toContain('this.remoteMeta.get(modelId)')
      // 兜底表是编译期快照、不含 creditsRate；拿它判免费会恒为 false 或误判。
      expect(fn).not.toContain('productFallbackIndex')
    })

    it('同时认 x0 与中文「免费」两种形态', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      const fn = body.slice(0, end)
      expect(fn).toContain("'x0'")
      expect(fn).toContain("'免费'")
    })

    it('空 / 非字符串入参直接返回 false', () => {
      const body = adapterCode.slice(adapterCode.indexOf('async isFreeModel('))
      const end = body.indexOf('\n  }')
      expect(body.slice(0, end)).toContain('return false')
    })
  })

  /**
   * 接线（源码级）：只保留**无法用行为区分**的纯文本约定。
   *
   * ⚠️ Task 6 把「在工厂配置项里直接 await 适配器的 `isFreeModel`」这一形态改成了
   * 传一个惰性箭头（工厂内部 await，与旧闭包「在 options 字面量里 await」时序一致）。
   * 那 4 条锚定旧形态文本的断言已删除 —— 它们守的意图现在由下面的**行为组**覆盖。
   * ⚠️ 此处**不复写**旧形态的原文（那是核对「锚点已消失」时会 grep 的字符串）。
   */
  describe('接线（源码级，仅剩无法用行为区分的约定）', () => {
    it('buddy / workbuddy / trae 三家的适配器自引用仍在（免费判据的来源）', () => {
      // ⚠️ 这三行是**自引用**：`buddyAdapter` 在它自己的 `registerBuddyLlm(...)`
      // 实参里被引用。若有人把它删掉，`isFreeModel` 就永远不生效（免费模型
      // 又会被锁定误拦）—— 行为组能抓到，但这里点名能让人一眼看到原因。
      expect(indexCode).toMatch(/isFreeModel: \(modelId\) => buddyAdapter\.isFreeModel\(modelId\)/)
      expect(indexCode).toMatch(/isFreeModel: \(modelId\) => workbuddyAdapter\.isFreeModel\(modelId\)/)
      expect(indexCode).toMatch(/isFreeModel: \(modelId\) => traeAdapter\.isFreeModel\(modelId\)/)
    })

    it('LobsterAI 不传 isFreeModel（它的模型表没有倍率字段，判不出免费）', () => {
      // ⚠️ 这是**刻意的缺省**，不是漏接：`LobsteraiAdapter` 没有 `isFreeModel`
      // 方法（只有 buddy / trae 有）。给它编一个恒 false 的实现是噪音；
      // 恒 true 则会让付费模型绕开锁定、真烧永久积分。
      expect(indexCode).not.toContain('lobsteraiAdapter.isFreeModel')
    })
  })
})

/**
 * **行为级**：免费模型必须真的跳过锁定。
 *
 * ⚠️ 这一组替代了原先 6 条源码文本断言（见文件头）。它直接断言用户可见的
 * 结果：**锁定 + 只剩永久积分 + 免费模型 ⇒ 仍取到凭据**。
 *
 * ## ⚠️ 为什么桩的是 `adapter.isFreeModel` 而不是远端目录
 *
 * `isFreeModel()` 内部 `ensureRemoteModels()` 要拉 `/v3/config`（buddy 是双端点
 * provider，scoped + config **都**要成功才算拿到目录）。桩远端响应要复刻两套
 * 报文的完整形状 —— 那种桩一旦上游格式变动就假红，且**测不出**本组要测的东西
 *（本组测的是「免费短路有没有接上」，不是「目录解析对不对」；后者由
 * `buddy-adapter.spec.ts` 与 `buddy-free-model-lock.spec.ts` 的判据组负责）。
 *
 * 故直接替换注册实例上的 `isFreeModel` —— 与
 * `ratelimit-misreport-behavior.spec.ts` 替换 `adapter.options.refresh` 同一手法。
 * ⚠️ 这**不是**测 mock：被测的是 `resolveCredential` 闭包**有没有把免费信号
 * 用起来**，而信号来源（目录解析）已有独立覆盖。
 */
describe('★ 免费模型的真实行为（驱动 apply()，替代源码文本断言）', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  class FakeCredentials {
    private store = new Map<string, string>()
    private key(ref: unknown): string { return typeof ref === 'string' ? ref : String(ref) }
    async resolve(ref: unknown) {
      const value = this.store.get(this.key(ref))
      return value === undefined ? undefined : { value, source: 'fake' }
    }
    async describe(ref: unknown) {
      const configured = this.store.has(this.key(ref))
      return { configured, source: configured ? 'fake' : undefined, writable: true }
    }
    async set(ref: unknown, value: string) { this.store.set(this.key(ref), value) }
    async unset(ref: unknown) { this.store.delete(this.key(ref)) }
  }
  class FakeCommands {
    register(): () => void { return () => {} }
  }
  class FakeLlm {
    readonly adapterByProvider = new Map<string, unknown>()
    registerConfigurableProviders(): { replace: () => void } { return { replace: () => {} } }
    registerAdapter(providers: string[], adapter: unknown): { replace: () => void } {
      for (const provider of providers) this.adapterByProvider.set(provider, adapter)
      return { replace: () => {} }
    }
  }

  interface TestCtx extends Context {
    accountPool: {
      addAccount(entry: Record<string, unknown>): Promise<void>
      setPermanentLocked(provider: string, locked: boolean): Promise<void>
    }
    credentials: FakeCredentials
    llm: FakeLlm
  }

  const FREE_MODEL = 'free-model-x0'

  /**
   * 跑一次真实 `apply()`，并把该 provider 适配器上的 `isFreeModel` 钉成给定值。
   *
   * ⚠️ **必须桩掉 `fetch`**：余额查询会打上游端点（本组不需要真实余额 ——
   * 免费短路生效时根本不会查余额；不生效时查失败 ⇒ 锁定时报「无法确认」，
   * 正是我们要区分的两条路径）。
   */
  function boot(free: boolean): TestCtx {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-free-'))
    dirs.push(dir)
    process.env.DSH_JET_HUB_STATE_DIR = dir
    vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })

    const ctx = new Context() as TestCtx
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    ctx.provide('llm', new FakeLlm() as never)
    apply(ctx as never)

    // ⚠️ 钉住免费判据（理由见本组标题下的说明）。`resolveCredential` 闭包
    // 捕获的正是这个实例，故替换它的方法就改变了真实闭包看到的值。
    for (const adapter of ctx.llm.adapterByProvider.values()) {
      const target = adapter as { isFreeModel?: (m?: string) => Promise<boolean> }
      if (typeof target.isFreeModel === 'function') {
        target.isFreeModel = async () => free
      }
    }
    return ctx
  }

  function resolveOf(ctx: TestCtx, provider: string): (modelId?: string) => Promise<unknown> {
    const adapter = ctx.llm.adapterByProvider.get(provider) as {
      options?: { resolveCredential?: (modelId?: string) => Promise<unknown> }
      resolveCredential?: (modelId?: string) => Promise<unknown>
    } | undefined
    if (adapter === undefined) throw new Error(`provider ${provider} 未注册`)
    const fn = adapter.options?.resolveCredential ?? adapter.resolveCredential
    if (typeof fn !== 'function') throw new Error(`provider ${provider} 没有 resolveCredential`)
    return fn.bind(adapter.options ?? adapter) as (modelId?: string) => Promise<unknown>
  }

  async function addAccount(ctx: TestCtx, provider: string): Promise<string> {
    const id = `acct_${provider}_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `${provider.toUpperCase()}_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id, provider, nickname: id, enabled: true, credentialRef: ref, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(
      credentialRef(ref),
      JSON.stringify({ access_token: `tok-${id}`, refresh_token: 'rt', expires_at: Date.now() + 3_600_000 }),
    )
    return id
  }

  /**
   * ⚠️ **免费 + 锁定 ⇒ 必须取到凭据**（用户报障的那个场景）。
   *
   * 变异：删掉工厂里的 `if (free) { … }` 短路 ⇒ 落进余额分档 ⇒ 余额查不到
   * ⇒ 锁定时抛「无法确认」⇒ 本条红。
   */
  it.each(['buddy', 'workbuddy', 'trae'] as const)(
    '%s：锁定 + 免费模型 ⇒ 仍取到凭据（不被锁定误拦）',
    async (provider) => {
      const ctx = boot(true)
      await ctx.accountPool.setPermanentLocked(provider, true)
      const id = await addAccount(ctx, provider)
      const credential = await resolveOf(ctx, provider)(FREE_MODEL) as { access_token?: string } | undefined
      expect(credential, `${provider}：免费模型不该被「锁定永久积分」拦下`).toBeDefined()
      expect(credential?.access_token).toBe(`tok-${id}`)
    },
    30_000,
  )

  /**
   * ⚠️ **付费模型仍走锁定报错路径**（阳性对照 + 最危险的失效方向）。
   *
   * 把付费模型误判成免费会绕开锁定、**真烧掉永久积分且不可撤回**。
   * 变异：把工厂里的 `if (free)` 改成 `if (true)` ⇒ 本条红。
   */
  it.each(['buddy', 'workbuddy', 'trae'] as const)(
    '%s：付费模型仍被锁定拦下（误判免费会真烧永久积分）',
    async (provider) => {
      const ctx = boot(false)
      await ctx.accountPool.setPermanentLocked(provider, true)
      await addAccount(ctx, provider)
      const error = await resolveOf(ctx, provider)(FREE_MODEL).then(() => undefined, (e: Error) => e)
      expect(error, '付费模型 + 锁定 + 余额查不到 ⇒ 必须抛错，绝不能交出凭据').toBeDefined()
      expect(error?.message).toContain('无法确认是否有可用账号')
    },
    30_000,
  )

  /**
   * ⚠️ **免费不等于无视限流标记**：免费路径的候选仍按模型筛。
   *
   * 变异：把工厂里免费分支的候选来源改成「不过滤 modelRateLimits」⇒
   * 被限流的账号仍被选中 ⇒ 本条红。
   */
  it('免费路径仍受模型级限流约束（唯一账号被该模型限流 ⇒ 取不到号）', async () => {
    const ctx = boot(true)
    await ctx.accountPool.setPermanentLocked('buddy', true)
    const id = `acct_buddy_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `BUDDY_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id,
      provider: 'buddy',
      nickname: id,
      enabled: true,
      credentialRef: ref,
      createdAt: 0,
      refreshable: true,
      modelRateLimits: { [FREE_MODEL]: Date.now() + 3_600_000 },
    })
    await ctx.credentials.set(
      credentialRef(ref),
      JSON.stringify({ access_token: `tok-${id}`, expires_at: Date.now() + 3_600_000 }),
    )

    const outcome = await resolveOf(ctx, 'buddy')(FREE_MODEL)
      .then((v) => ({ kind: 'returned' as const, v }), () => ({ kind: 'threw' as const }))
    // 被限流的唯一账号被筛空 ⇒ 免费分支拿不到凭据 ⇒ 落到余额分档 ⇒
    // 余额查不到 + 锁定 ⇒ 抛错。**绝不能**返回那个被限流账号的凭据。
    expect(outcome.kind, '免费不得绕开模型级限流标记').toBe('threw')
  }, 30_000)

  /**
   * ⚠️ **免费路径不得退化成池内的裸 `JSON.parse`**（Task 6 的 C4）。
   *
   * 池的 `getAvailableAccount` 用裸 parse，形状校验在工厂的 `readCredential`
   * 里（TRAE / LobsterAI 那两份解析器有校验）。故写一份**合法 JSON、错误
   * 形状**的凭据：走形状校验 ⇒ 被拒；走池裸 parse ⇒ 被接受。
   *
   * 变异：把免费分支改成 `pool.getAvailableAccount(...)` ⇒ 本条红
   *（会返回 `{broken:1}`）。
   *
   * ⚠️ 与 `credential-resolver-parity.spec.ts` 的「免费模型 + 凭据**形状损坏**
   * ⇒ 两者都 undefined」是同一条不变式的两个层次：那里对拍工厂，这里证明
   * **接线层传的解析器确实带校验**（若哪天有人把 trae 的 `readCredential`
   * 换成裸 parse，本条也会红）。
   */
  it('免费路径凭据形状损坏 ⇒ 不得被当成有效凭据交出（C4）', async () => {
    const ctx = boot(true)
    const traeId = `acct_trae_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const traeRef = `TRAE_ACCOUNT_${traeId.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id: traeId, provider: 'trae', nickname: traeId, enabled: true,
      credentialRef: traeRef, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(credentialRef(traeRef), '{"broken":1}')

    const outcome = await resolveOf(ctx, 'trae')(FREE_MODEL)
      .then((v) => ({ kind: 'returned' as const, v }), (e: unknown) => ({ kind: 'threw' as const, e }))

    // ⚠️ **无条件断言**（2026-10-08 复审修正）。原实现写成
    //    `if (outcome.kind === 'returned') { expect(…) }` —— 一旦走到 `threw`
    //    分支，本条**一条断言都不执行**，vitest 记为通过。那是比「弱断言」
    //    更坏的形态：它把「抛错」当成了「通过」，而抛错可能是 `{broken:1}`
    //    在下游引发的 TypeError（正是本用例要防的那种「损坏凭据被当成有效
    //    凭据用下去」）。故改成先无条件断言「没交出去」，再单独检查抛错的形状。
    //
    // 判据：无论走哪一支，都**不得**把那份损坏凭据交出去 ——
    // 免费分支被形状校验拒 ⇒ 无候选 ⇒ 落到余额分档 ⇒ 未锁定 ⇒ 退单凭据
    //（该 ref 不存在）⇒ `undefined`。
    expect(
      outcome.kind === 'returned' ? outcome.v : undefined,
      '损坏凭据不得被当成有效凭据交出（C4：免费分支不得退化成池内裸 parse）',
    ).toBeUndefined()
    // 若抛错，必须是**可诊断的**错误，而不是下游拿损坏凭据硬用出来的 TypeError。
    if (outcome.kind === 'threw') {
      expect(outcome.e, '抛错也必须是可诊断的 Error').toBeInstanceOf(Error)
    }
  }, 30_000)
})
