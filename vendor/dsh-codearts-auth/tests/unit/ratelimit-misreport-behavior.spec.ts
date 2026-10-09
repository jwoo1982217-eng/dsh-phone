/**
 * 回归（**行为级**）：唯一启用账号被目标**模型级限流**时，必须报「限流 + 解禁时刻」，
 * 而不是误导性的 `no usable credential; log in first`。
 *
 * ## 为什么要有这份「行为级」用例（源码级断言不够，真实缺陷，2026-10-05）
 *
 * `buddy-ratelimit-misreport.spec.ts` 里的接线断言是**源码级**的（读 `index.ts`
 * 找调用点）。它挡得住「有人把接线删了」，但**挡不住接线写错位置**：比如把判定
 * 放到了 `getAvailableAccount` **之前**，池里明明还有号也会被报成限流。
 *
 * 本文件走**真实路径**：`apply()` 启动真插件 → 真 `AccountPool`（不是桩）→
 * 直接调用各 provider 注册的 `resolveCredential`。断言的是**行为**：
 * 该抛 `QUOTA_EXCEEDED` 就抛，该正常取号就别抛。
 *
 * ## 缺陷本体（Gitee issue IKJOZ9）
 *
 * 用户的 qoder 单账号撞上当日额度用尽：
 *
 * | 第几次请求 | 修复前 | 原因 |
 * |---|---|---|
 * | 第 1 次 | `Billing daily count exceeded` | 额度用尽（正确） |
 * | 第 2 次 | `no usable credential; log in first` | **模型级限流标记**把唯一账号筛掉 → 候选空 → 误报「未登录」 |
 *
 * 用户据此去重新登录，而凭据一直是好的 —— 白跑一趟。
 *
 * ⚠️ **本文件只改错误语义，不改可用性**：没有账号可用就是没有，请求仍然失败；
 * 修的是「用户看到的原因」。绝不静默换模型、也绝不绕过限流标记（有用例锁死）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../src/index.js'
import { buildQoderCredential, parseQoderTokenPayload } from '../../src/qoder.js'

class FakeCredentials {
  private store = new Map<string, string>()
  /**
   * 归一化 key（与 `account-pool.spec.ts` 的既有做法一致）。
   *
   * ⚠️ 本文件第一版的真正坑**不在这里**，而是账号 id 的字符集（见
   * {@link addAccount}）：`credentialRef()` 会校验名字必须匹配
   * `^[A-Za-z_][A-Za-z0-9_]*$`，而池里 `getAvailableAccount` 把这个抛错
   * **吞成「读取凭据失败」并跳过该账号** —— 症状是「凭据明明写好了却取不到号」，
   * 看起来像接线改坏了。本层保持归一化只是与既有替身写法一致。
   */
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
  /** 路由名 → 适配器实例（`registerAdapter` 的实参）。 */
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
    findAccount(id: string): { modelRateLimits?: Record<string, number> } | undefined
  }
  llm: FakeLlm
  credentials: FakeCredentials
}

/**
 * ⚠️ **刻意不 provide `settings`**：一旦提供带 `register` 的替身，
 * Jet Hub 存储会走「≤0.1.6 老契约」分支并从它手里取 scope，而替身没有
 * get/replace → 任何一次 `addAccount` 都会抛
 * `Cannot read properties of undefined (reading 'replace')`（写用例时实测到）。
 * 不提供时它落到 `DSH_JET_HUB_STATE_DIR`（`tests/setup-isolation.ts` 按文件隔离）。
 *
 * ⚠️⚠️ **每个用例必须一个独立状态目录**：`DSH_JET_HUB_STATE_DIR` 只做到
 * **按文件**隔离，同一文件里各用例的账号会**累加到同一份 state.json**。
 * 本文件的前提恰恰是「该 provider 只有我加的那一个账号」，一旦被前面的用例
 * 污染，断言就变成在测一个不存在的场景 —— 症状极隐蔽：端到端那条在修复后
 * 仍报 `MISSING_CREDENTIAL`，看起来像「接线没生效」，其实是池里多了别的账号
 * （写用例时实测到，白查了一轮）。
 */
const stateDirs: string[] = []

function boot(): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ikjoz9-'))
  stateDirs.push(dir)
  process.env.DSH_JET_HUB_STATE_DIR = dir
  const ctx = new Context() as TestCtx
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  apply(ctx as never)
  return ctx
}

afterAll(() => {
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true })
  stateDirs.length = 0
})

/** 目标模型：用一个**真实模型 id** 才有意义（限流按模型记）。 */
const MODEL = 'qfmodel'
const HOUR = 3_600_000

/** 取某 provider 注册的 `resolveCredential`（它是 `registerXxxLlm` 的入参闭包）。 */
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

/** 往池里放一个账号，并写好它的凭据。 */
async function addAccount(
  ctx: TestCtx,
  provider: string,
  options: { modelRateLimits?: Record<string, number>; enabled?: boolean; credential?: string } = {},
): Promise<string> {
  // ⚠️ **id 只能含字母数字与下划线**：它会被拼进凭据 ref 名，而
  // `credentialRef()` 强制校验 `^[A-Za-z_][A-Za-z0-9_]*$`。用 `-` 会抛错，
  // 而 `AccountPool.getAvailableAccount` 把该抛错**吞成「读取凭据失败」并跳过
  // 账号** —— 症状是「凭据写好了却取不到号」，极易误判成接线改坏了
  // （本文件第一版就这样全红过）。
  const id = `acct_${provider}_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
  const ref = `${provider.toUpperCase()}_ACCOUNT_${id.toUpperCase()}`
  await ctx.accountPool.addAccount({
    id,
    provider,
    nickname: id,
    enabled: options.enabled ?? true,
    credentialRef: ref,
    createdAt: 0,
    refreshable: true,
    ...options.modelRateLimits === undefined ? {} : { modelRateLimits: options.modelRateLimits },
  })
  await ctx.credentials.set(
    credentialRef(ref),
    options.credential ?? JSON.stringify({ access_token: `tok-${id}`, expires_at: Date.now() + HOUR }),
  )
  return id
}

/**
 * 走「按模型限流的取号」且**兜底读不到东西**的全部 provider。
 *
 * ⚠️ **不含两个例外**（各自的原因见对应小节）：
 * - `codearts`：取号时传**空 modelId**，模型级限流压根不参与筛选；
 * - `zcode`：兜底 `zcode.current()` 会**再读一次账号池**（且不看 `enabled` /
 *   限流），所以池被筛空时它仍返回凭据 —— 它本就不会误报「未登录」。
 *   把它们列进来会让「全部限流 ⇒ 必须抛限流错」这个前提不成立。
 *
 * ⚠️ 每个账号 id 都唯一：单测的状态目录是**按文件**隔离的，同一文件里
 * 多次 `addAccount` 会累加到**同一份** state.json；id 重复会让
 * `updateModelRateLimit` 只改到第一条（同 id 的旧条目），造成难查的串扰。
 */
const PAIRED_PROVIDERS = [
  'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae',
  'cline', 'loomy', 'raccoon', 'minimax', 'gemini',
] as const

describe('模型级限流被误报成「未登录」（IKJOZ9）', () => {
  describe('唯一启用账号被该模型限流 → 必须报限流', () => {
    it.each(PAIRED_PROVIDERS)('%s：抛 QUOTA_EXCEEDED 而不是返回 undefined', async (provider) => {
      const ctx = boot()
      // 先证明前提成立：池层面确实因为这个标记把账号筛掉了。
      await addAccount(ctx, provider, { modelRateLimits: { [MODEL]: Date.now() + HOUR } })
      const pooled = await (ctx.accountPool as unknown as {
        getAvailableAccount(p: string, m: string): Promise<unknown>
      }).getAvailableAccount(provider, MODEL)
      expect(pooled, '前提：限流标记应把唯一账号筛出候选').toBeNull()

      let thrown: { message?: string; code?: string } | undefined
      try {
        await resolveOf(ctx, provider)(MODEL)
      } catch (error: unknown) {
        thrown = error as { message?: string; code?: string }
      }
      // 红线：绝不能静默返回 undefined —— 那正是适配器抛「请先登录」的前置条件。
      expect(thrown, `${provider} 应当抛限流错误，却静默返回了 undefined`).toBeDefined()
      expect(thrown?.code, `${provider} 的错误码`).toBe('QUOTA_EXCEEDED')
      expect(String(thrown?.message), `${provider} 的文案`).toContain('限流')
      expect(String(thrown?.message), `${provider} 的文案`).toContain('无需重新登录')
      expect(String(thrown?.message), `${provider} 的文案`).toContain(MODEL)
    }, 60_000)
  })

  describe('不得误伤：三种「不是全部限流」的情形', () => {
    it('账号没有该模型的限流标记 → 正常取号，不报限流', async () => {
      const ctx = boot()
      await addAccount(ctx, 'qoder')
      await expect(resolveOf(ctx, 'qoder')(MODEL)).resolves.toBeDefined()
    })

    it('标记的是**别的**模型 → 本次照常取号（限流是「账号 × 模型」维度）', async () => {
      const ctx = boot()
      await addAccount(ctx, 'qoder', { modelRateLimits: { '另一个模型': Date.now() + HOUR } })
      await expect(resolveOf(ctx, 'qoder')(MODEL)).resolves.toBeDefined()
    })

    it('两个账号、只有一个被限流 → 取到**没被限流**的那个（候选非空就不该报限流）', async () => {
      const ctx = boot()
      const limited = await addAccount(ctx, 'qoder', { modelRateLimits: { [MODEL]: Date.now() + HOUR } })
      const free = await addAccount(ctx, 'qoder')
      const credential = await resolveOf(ctx, 'qoder')(MODEL) as { access_token?: string }
      expect(credential, '应取到可用的那个账号').toBeDefined()
      // ⚠️ 断言必须**逐账号区分**（2026-10-06 对抗性审计发现本条曾是假绿）：
      // `addAccount` 给每个账号的 token 是 `tok-<id>`，所以能分辨拿到的是哪一条。
      // 旧写法给两个账号写**同一个** `'tok'`，于是即使限流过滤被改坏、返回了
      // **被限流**的那条，本条照样绿 —— 与它自己的注释直接矛盾。
      expect(credential.access_token, '取到的应是没被限流的那个账号').toBe(`tok-${free}`)
      expect(credential.access_token, '不该是被限流的那个账号').not.toBe(`tok-${limited}`)
    })

    it('账号被**停用**（enabled:false）→ 仍走「未登录」，不得报成限流', async () => {
      // 停用账号本就不参与自动选号；把它算进「全部限流」会让一个普通情况
      // 被报成限流，用户会去等解禁（而真实原因是账号被停用了）。
      const ctx = boot()
      await addAccount(ctx, 'qoder', { modelRateLimits: { [MODEL]: Date.now() + HOUR }, enabled: false })
      await expect(resolveOf(ctx, 'qoder')(MODEL)).resolves.toBeUndefined()
    })

    it('一个账号都没有 → 仍走「未登录」，不得报成限流', async () => {
      const ctx = boot()
      await expect(resolveOf(ctx, 'qoder')(MODEL)).resolves.toBeUndefined()
    })
  })

  describe('端到端：qoder 额度用尽后的第二次请求（issue 原症状）', () => {
    it('第 1 次报额度 → 标记落下 → 第 2 次报「限流」而不是「请先登录」', async () => {
      const ctx = boot()
      const adapter = ctx.llm.adapterByProvider.get('qoder') as {
        fetchImpl?: typeof fetch
        options: { refresh: () => Promise<void> }
        stream(options: unknown): AsyncIterable<unknown>
      }
      await addAccount(ctx, 'qoder', {
        credential: JSON.stringify(buildQoderCredential(
          // ⚠️ `uid` 是加密推理必需（`generate_runtime_auth_fields` 用它派生签名），
          // 缺了 WASM 会挂起。
          parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
          { machineId: 'm-1' },
        )),
      })

      // 只拦网络：回**实测形态**的额度错误帧（`{code:110,…}`，HTTP 200 + SSE 内嵌）。
      adapter.fetchImpl = (async () => new Response(
        `data:${JSON.stringify({
          headers: {},
          body: JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' }),
          statusCodeValue: 200,
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch
      // 续期走网络；真实场景下它会成功（空 modelId 取号不按模型过滤），这里替身掉。
      const realRefresh = adapter.options.refresh
      adapter.options.refresh = async () => {}

      const run = async (): Promise<{ message: string; code: string }> => {
        try {
          for await (const _chunk of adapter.stream({
            provider: 'qoder', model: MODEL,
            messages: [{ role: 'user', content: 'hi' }], tools: [],
          })) { void _chunk }
          return { message: '<<没有抛错>>', code: '-' }
        } catch (error: unknown) {
          const e = error as { message?: string; code?: string }
          return { message: String(e.message ?? error), code: String(e.code ?? '') }
        }
      }

      // ⚠️ 替身必须**覆盖两次请求**：第 2 次请求仍会因 `resolveCredential`
      // 返回 undefined 而先调 `refresh()`。把还原放进单次 run 的 finally
      // 会让第 2 次走真续期（发网络请求），抛出的错与本用例要验证的路径无关。
      let first: { message: string; code: string }
      let second: { message: string; code: string }
      try {
        first = await run()
        second = await run()
      } finally {
        adapter.options.refresh = realRefresh
      }

      // ① 第 1 次：额度用尽（这条一直是对的）
      expect(first.code, '第 1 次应是额度错误').toBe('QUOTA_EXCEEDED')
      expect(first.message).toContain('Billing daily count exceeded')
      // ② 第 2 次：**这才是缺陷所在** —— 修复前是 MISSING_CREDENTIAL「请先登录」
      expect(second.code, '第 2 次应报限流，而不是「未登录」').toBe('QUOTA_EXCEEDED')
      expect(second.message).toContain('限流')
      expect(second.message).toContain('无需重新登录')
      expect(second.message).not.toContain('log in')
    }, 60_000)
  })

  describe('已知例外：codearts 不做模型级过滤', () => {
    it('codearts 取号传空 modelId → 限流标记不参与筛选，能取到凭据', async () => {
      // ⚠️ 本条**锁死现状**，不是「正确行为」的背书。codearts 刻意不做模型级
      // 限流（取号时传 `''`），所以它既不会误报「限流」也不会误报「未登录」。
      // 若将来有人给 codearts 加上模型过滤，这里会红 —— 那时需要**同步**给
      // codearts 接线判定，否则就会变成第 13 个受害者。
      const ctx = boot()
      await addAccount(ctx, 'codearts', { modelRateLimits: { [MODEL]: Date.now() + HOUR } })
      await expect(resolveOf(ctx, 'codearts')(MODEL)).resolves.toBeDefined()
    })
  })

  describe('ZCode耗尽接续不绕回停用或已冷却账号', () => {
    const zcodeCredential = (token: string) => JSON.stringify({ zcode_jwt: `jwt-${token}`, device_mid: `mid-${token}` })
    it('唯一启用账号被限流时如实报告额度错误', async () => {
      const ctx = boot()
      await addAccount(ctx, 'zcode', { modelRateLimits: { [MODEL]: Date.now() + HOUR }, credential: zcodeCredential('A') })
      await expect(resolveOf(ctx, 'zcode')(MODEL)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })
    it('停用的健康账号不会被兜底选中', async () => {
      const ctx = boot()
      await addAccount(ctx, 'zcode', { enabled: false, credential: zcodeCredential('B') })
      await addAccount(ctx, 'zcode', { modelRateLimits: { [MODEL]: Date.now() + HOUR }, credential: zcodeCredential('A') })
      await expect(resolveOf(ctx, 'zcode')(MODEL)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })
  })
})
