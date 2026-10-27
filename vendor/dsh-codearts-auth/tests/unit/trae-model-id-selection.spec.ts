/**
 * H2 回归测试：**选号必须按模型过滤限流账号**。
 *
 * ## 真实缺陷（用户报障「没有切换」的根因之一）
 *
 * 适配器写下的限流标记是**按模型**记的（`modelRateLimits[model]`），
 * 而选号时 `getAvailableAccount(provider, '')` 传的是**空串** ——
 * `AccountPool` 的限流过滤在 `modelId.length === 0` 时**整体短路**：
 *
 * ```ts
 * if (modelId.length === 0) return true    // ← 空串 → 不做限流过滤
 * ```
 *
 * 于是刚标记为「限流」的账号下次仍被选中，**换号形同虚设**。
 *
 * 实测（2026-09-28，真实 AccountPool）：acct-A 已标记 `glm-5.2` 限流，
 * 传 `''` 选回 acct-A；传 `'glm-5.2'` 才正确跳过选 acct-B。
 *
 * ## 本文件测什么（Task 6 之后：**三层全部是行为断言**）
 *
 * 1. **`AccountPool` 层**：空串短路与按模型过滤的**行为契约**（一直是行为级）；
 * 2. **适配器层**：`stream()` 是否把 `options.model` 传给 `resolveCredential`；
 * 3. **宿主层**：`apply()` 出来的**真实** `resolveCredential` 是否把 `modelId`
 *    透传给选号。
 *
 * ## ⚠️ 第三层原先的形态已被证伪并重写（Task 6）
 *
 * 重构前它扫 `src/index.ts` 源码文本：
 *
 * - `resolveCredentialBlocks(src)` 用 `/resolveCredential:\s*async\s*\([^)]*\)\s*=>\s*\{/g`
 *   切块，再断言「块内不得出现 `getAvailableAccount(X, '')`」；
 * - 另一条断言「`src/index.ts` 里接收 `modelId` 的 `resolveCredential` 闭包数量 ≥ 8」
 *   （原文见 git 历史 `d35d9e3`；此处**不复写** —— 它是核对「锚点已消失」时会
 *   grep 的字符串，写进注释会让核对假命中）。
 *
 * Task 6 把那 12 个闭包收敛成 `createCredentialResolver(...)` 之后**实测**：
 *
 * | 旧断言 | 失效形态 |
 * |---|---|
 * | 「块内不得传空串」 | 正则匹配 **0 块** ⇒ 循环体不执行 ⇒ `offenders` 恒 `[]` ⇒ **恒绿** |
 * | 「≥ 8 个接收 modelId」 | 计数恒 **0** ⇒ **恒红** |
 *
 * 前者是「守卫不守」（比没有更危险：它让人以为这条已被守着），后者只是噪音。
 * ⇒ 两条都改为**驱动真实 `apply()`** 的行为断言：不关心源码长什么样，
 * 直接看**真实闭包有没有把被限流的账号交出去**。
 *
 * ⚠️ **防空洞自检**：光断言「被限流时取不到号」挡不住「闭包恒返回 undefined」
 * 这种坏实现 —— 那样它也会绿。故每个 provider 都配一条**阳性对照**：
 * 账号**没有**限流标记时，同一个闭包**必须**返回凭据。两条一起才构成守卫。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/account-pool.js'
import { apply } from '../../src/index.js'

/** 桩 ctx：提供 credentials 与 logger；账号数据由 `replaceAll` 灌入。 */
function makeCtx(credentials: Record<string, string>) {
  return {
    credentials: {
      resolve: async (ref: unknown) => {
        const key = typeof ref === 'string'
          ? ref
          : String((ref as { id?: string; name?: string } | undefined)?.id
            ?? (ref as { name?: string } | undefined)?.name ?? '')
        const value = credentials[key.replace(/^credential:/, '')]
        return value === undefined ? undefined : { value }
      },
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  } as never
}

const ACCOUNTS = [
  { id: 'acct-A', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_A', enabled: true, refreshable: true },
  { id: 'acct-B', provider: 'trae', credentialRef: 'TRAE_ACCOUNT_B', enabled: true, refreshable: true },
]

const CREDS = {
  TRAE_ACCOUNT_A: JSON.stringify({ access_token: 'AT-A', refresh_token: 'R', uid: 'a' }),
  TRAE_ACCOUNT_B: JSON.stringify({ access_token: 'AT-B', refresh_token: 'R', uid: 'b' }),
}

/**
 * 这是**行为契约**测试：它不是测 mock，而是证明「传 modelId」与
 * 「不传 modelId」在同一份真实账号数据上会选出**不同的账号**。
 *
 * 若哪天有人把 `AccountPool` 的空串短路改掉，这条会失败并提醒重新评估 —— 这正是我们想要的。
 */
describe('H2 · AccountPool 选号按模型过滤限流账号（行为契约）', () => {
  /**
   * ⚠️ **本文件必须关掉「限额沉底」**（`DSH_RATE_LIMIT_SINK=0`）。
   *
   * 沉底会改写账号顺序，而下面两条用例正是靠「acct-A 排在首位」来区分
   * 「传空串 = 忽略限流标记」与「传模型 = 过滤限流账号」的：
   *
   * - 传空串时期望选回 **acct-A**（首位）→ 证明**没有**按模型过滤；
   * - 传模型时期望选到 acct-B → 证明过滤生效。
   *
   * 一旦沉底把被标记的 acct-A 挪到末尾，**两条都会选到 acct-B**，于是
   * 「忽略了标记」与「过滤了标记」变得无法区分 —— 用例退化成同义反复，
   * 而它偏偏是守「空串短路」这个真实缺陷的唯一断言。
   *
   * 沉底本身与**模型过滤**是正交的两件事，已由 `account-pool.spec.ts` 的
   * 「限额账号自动沉底」一组单独覆盖，故这里隔离掉它，让本契约保持判别力。
   */
  beforeEach(() => { vi.stubEnv('DSH_RATE_LIMIT_SINK', '0') })
  afterEach(() => { vi.unstubAllEnvs() })

  /** 建一个池，acct-A 已标记 modelId 限流。 */
  async function setup(modelId: string, resetAtMs: number) {
    const pool = new AccountPool(makeCtx(CREDS))
    await pool.replaceAll(ACCOUNTS as never, {} as never, false)
    await pool.updateModelRateLimit('acct-A', modelId, resetAtMs)
    return pool
  }

  it('传真实 modelId 时跳过被限流账号（acct-A → acct-B）', async () => {
    const pool = await setup('glm-5.2', Date.now() + 3_600_000)
    const picked = await pool.getAvailableAccount('trae', 'glm-5.2')
    expect(picked?.entry.id, '被限流的 acct-A 不该被选中').toBe('acct-B')
  })

  it('传空串时忽略限流标记（这正是缺陷：选回 acct-A）', async () => {
    const pool = await setup('glm-5.2', Date.now() + 3_600_000)
    const picked = await pool.getAvailableAccount('trae', '')
    expect(picked?.entry.id, '空串 = 不按模型过滤，故仍选 acct-A').toBe('acct-A')
  })

  it('标记是按模型的：别的模型仍能选中 acct-A', async () => {
    const pool = await setup('glm-5.2', Date.now() + 3_600_000)
    const picked = await pool.getAvailableAccount('trae', 'kimi-k3')
    expect(picked?.entry.id).toBe('acct-A')
  })

  it('限流标记过期后 acct-A 重新可用', async () => {
    const pool = await setup('glm-5.2', Date.now() - 1_000)
    const picked = await pool.getAvailableAccount('trae', 'glm-5.2')
    expect(picked?.entry.id).toBe('acct-A')
  })
})

/**
 * 适配器层：`stream()` 必须把 `options.model` 传给 `resolveCredential`。
 *
 * 这一组是**防回退**的：只要有人把调用改回无参形式，它就变红。
 *
 * ⚠️ 这里只对 **TRAE**（本次报障的 provider）做端到端断言；
 * 其余 provider 的同一透传由下面的**宿主层行为断言**覆盖 ——
 * 两者的组合足以防止回退，而无需为每个 provider 搭一套完整 Context。
 */
describe('H2 · 适配器把 options.model 传给 resolveCredential', () => {
  /** 造一个最小凭据（各 provider 的字段并集足够宽）。 */
  function credentialFor(): Record<string, unknown> {
    return {
      access_token: 'AT',
      refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1',
      machine_id: 'a'.repeat(32),
      device_id: 'b'.repeat(32),
      account_id: 'acct',
    }
  }

  /**
   * TRAE 是本次报障的 provider，单独做一条**端到端**的透传断言。
   */
  it('TRAE 适配器：stream() 把 options.model 传给 resolveCredential', async () => {
    const { TraeAdapter } = await import('../../src/trae-adapter.js')
    const { TRAE } = await import('../../src/trae-product.js')

    const seen: Array<string | undefined> = []
    const sse = 'event:output\ndata:{"response":"ok"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n'
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCOUNT_A' as never,
      resolveCredential: async (modelId?: string) => {
        seen.push(modelId)
        return credentialFor() as never
      },
      refresh: async () => {},
      fetchImpl: (async () => new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
      product: TRAE,
    })

    for await (const _ of adapter.stream({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* 只需消费完 */ }

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0], '必须传本轮模型，否则限流过滤被短路').toBe('glm-5.2')
  })
})

/**
 * 宿主层：**驱动真实 `apply()`**，断言每个 provider 的 `resolveCredential`
 * 把 `modelId` 真的透传给了选号（`getAvailableAccount` / 候选筛）。
 *
 * ## 为什么这样比源码文本断言强
 *
 * 旧形态扫 `src/index.ts` 找 `getAvailableAccount(<ID>, modelId ?? '')` 这个
 * **文本形**。它有两个不可修的弱点：
 * 1. **重构即假红**：调用被搬进工厂、换了实参写法，正则就失配；
 * 2. **守卫不守**：Task 6 之后那个切块正则匹配 **0 块**，循环不执行 ⇒
 *    `offenders` 恒 `[]` ⇒ 断言**恒绿**（已实测，见文件头表格）。
 *
 * 新形态**不关心源码长什么样**：往池里放一个「只被该模型限流」的账号，
 * 调真实闭包，看它有没有把这个账号交出去。漏传 `modelId` ⇒ 账号仍被选中 ⇒ 红。
 *
 * ⚠️ **必须配阳性对照**（见 `阳性对照` 一组）：只断言「被限流时取不到号」
 * 挡不住「闭包恒返回 undefined」的坏实现 —— 两条一起才构成守卫。
 */
describe('H2 · 宿主层：apply() 出来的 resolveCredential 按模型过滤（行为断言）', () => {
  /**
   * ⚠️ **codearts 刻意不在名单里**：它取号时传**空 modelId**
   * （`getAvailableAccount('codearts', '')`），模型级限流压根不参与筛选。
   * 它既不会误报「限流」也不会误报「未登录」，故本判据对它不适用
   *（`ratelimit-misreport-behavior.spec.ts` 有专门一条锁死这个现状）。
   *
   * ⚠️ 也不含 **zcode**：它的兜底 `zcode.current()` 会**再读一次账号池**
   * 且不看限流标记 ⇒ 池被筛空时它**照样返回凭据**，故「被限流的唯一账号
   * 是否被跳过」在它身上观测不到（这不是缺陷，是它的既有语义 ——
   * 见 `buddy-ratelimit-misreport.spec.ts` 的「zcode 同型缺陷判定」段）。
   */
  const MODEL_FILTERED_PROVIDERS = [
    'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae',
    'cline', 'loomy', 'raccoon', 'minimax', 'gemini',
  ] as const

  const MODEL = 'glm-5.2'
  const dirs: string[] = []

  /**
   * ⚠️ **必须把 `fetch` 换成「立刻失败」**：buddy / workbuddy / trae / lobsterai
   * 的 `resolveCredential` 会先问 `isFreeModel()`，而它内部
   * `ensureRemoteModels()` 会去拉远端目录 —— 真实网络请求在单测里既慢又不可靠。
   * 桩成失败后闸门走「没拿到目录」分支，`isFreeModel` 保守返回 false（= 付费），
   * 于是选号逻辑照常执行。余额查询同理（查不到 ⇒ `ok:false`）。
   */
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })
  })
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
    accountPool: { addAccount(entry: Record<string, unknown>): Promise<void> }
    credentials: FakeCredentials
    llm: FakeLlm
  }

  /** 跑一次真实 `apply()`（每个用例一个独立状态目录）。 */
  function boot(): TestCtx {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-h2-'))
    dirs.push(dir)
    process.env.DSH_JET_HUB_STATE_DIR = dir
    const ctx = new Context() as TestCtx
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    ctx.provide('llm', new FakeLlm() as never)
    apply(ctx as never)
    return ctx
  }

  /** 取某 provider 注册的 `resolveCredential`（`registerXxxLlm` 的入参闭包）。 */
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

  /**
   * 往池里放**一个**账号并写好凭据。
   *
   * ⚠️ 账号 id 只能含字母数字与下划线（它会被拼进凭据 ref 名，而
   * `credentialRef()` 强制校验 `^[A-Za-z_][A-Za-z0-9_]*$`）。
   */
  async function addAccount(
    ctx: TestCtx,
    provider: string,
    modelRateLimits?: Record<string, number>,
  ): Promise<string> {
    const id = `acct_${provider}_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `${provider.toUpperCase()}_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id,
      provider,
      nickname: id,
      enabled: true,
      credentialRef: ref,
      createdAt: 0,
      refreshable: true,
      ...modelRateLimits === undefined ? {} : { modelRateLimits },
    })
    await ctx.credentials.set(
      credentialRef(ref),
      JSON.stringify({ access_token: `tok-${id}`, expires_at: Date.now() + 3_600_000 }),
    )
    return id
  }

  /** 真实闭包的返回值（抛错折算成 `undefined`，即「没有交出账号」）。 */
  async function resolveOrUndefined(ctx: TestCtx, provider: string): Promise<unknown> {
    try {
      return await resolveOf(ctx, provider)(MODEL)
    } catch {
      return undefined
    }
  }

  it('⚠️ 名单非空且覆盖 codearts / zcode 之外的全部取号 provider（防空洞自检）', () => {
    // 名单为空时 `it.each` 一条都不跑 ⇒ 整组恒绿。这条把该形态钉死。
    expect(MODEL_FILTERED_PROVIDERS.length).toBe(11)
    expect(MODEL_FILTERED_PROVIDERS).not.toContain('codearts')
    expect(MODEL_FILTERED_PROVIDERS).not.toContain('zcode')
  })

  describe('被限流的唯一账号 ⇒ 真实闭包不得把它交出去', () => {
    it.each(MODEL_FILTERED_PROVIDERS)(
      '%s：唯一账号被该模型限流 ⇒ 取不到该凭据',
      async (provider) => {
        const ctx = boot()
        const id = await addAccount(ctx, provider, { [MODEL]: Date.now() + 3_600_000 })

        // ① 先证明前提成立：池层面确实因这个标记把账号筛掉了。
        const pooled = await (ctx.accountPool as unknown as {
          getAvailableAccount(p: string, m: string): Promise<unknown>
        }).getAvailableAccount(provider, MODEL)
        expect(pooled, '前提：限流标记应把唯一账号筛出候选').toBeNull()

        // ② 真实闭包必须**同样**不交出这个账号 —— 它若漏传 modelId（传空串）
        //    就会拿回那个账号，于是下面的断言红。
        const returned = await resolveOrUndefined(ctx, provider)
        expect(
          returned,
          `${provider} 把 modelId 漏成空串 ⇒ 被限流的账号 ${id} 仍被选中`,
        ).toBeUndefined()
      },
      30_000,
    )
  })

  /**
   * ⚠️ **阳性对照（防「闭包恒返回 undefined」）**。
   *
   * 上一组单独存在时，一个**永远返回 `undefined`** 的坏闭包能让它全绿 ——
   * 那种实现下「被限流的账号没被交出去」恒成立。本组断言同一个闭包在
   * **没有**限流标记时**必须**返回凭据，两条一起才真正守住「透传 modelId」。
   */
  describe('阳性对照：没有限流标记 ⇒ 同一个闭包必须返回凭据', () => {
    it.each(MODEL_FILTERED_PROVIDERS)(
      '%s：账号未受限 ⇒ 取到该凭据',
      async (provider) => {
        const ctx = boot()
        const id = await addAccount(ctx, provider)
        const returned = await resolveOrUndefined(ctx, provider) as { access_token?: string } | undefined
        expect(returned, `${provider} 在账号可用时也没交出凭据（闭包坏了，上一组会假绿）`).toBeDefined()
        expect(returned?.access_token, '取到的必须是那个账号的凭据').toBe(`tok-${id}`)
      },
      30_000,
    )
  })
})

/**
 * ## ⚠️ **续期路径刻意不看模型**（本组守的是上面那组的**反面**）
 *
 * ### 为什么它与「透传 `modelId`」同等重要
 *
 * `AccountPool` 的模型级限流过滤在 `modelId` 为空串时**整体短路**
 *（`if (modelId.length === 0) return true`）。上面那组要求**推理路径**
 * 传真实模型 id（否则换号形同虚设）；而**续期路径**必须**刻意传空串** ——
 * 它的语义是「定位要续期的那个账号」，与「本轮要发哪个模型」无关。
 *
 * 若有人「顺手统一」把续期路径也改成按模型过滤，后果是：
 * **恰好被该模型限流的那批账号永远轮不到续期** —— 而限流标记过期需要时间、
 * 续期又需要凭据新鲜，两者叠加成单向门（本仓库已有同型事故：
 * `refreshable` 被当门禁用，账号从此永不自愈）。
 *
 * ### 历史（⚠️ 别把这条当新加的洁癖）
 *
 * 本文件原先有一条**源码文本**断言守这件事（扫 `refresh:` 块里是否仍有传空串的
 * 选号调用）。Task 6 把 12 个闭包收敛进 `createCredentialResolver` 时那条断言
 * **被删掉且没有替代**，而 `src/index.ts` 里那批刻意传空串的站点**仍然存在**
 * ⇒ 守卫消失、行为却还在，属「删了守卫还说保留」。本组把它**恢复成行为断言**。
 *
 * ### 为什么是行为断言而不是恢复源码文本
 *
 * 实测（本文件编写时逐个 provider 驱动过真实 `apply()`）：**续期路径完全可驱动** ——
 * 把 auth 服务的 `refreshAccountCredential` 换成记录器、调适配器的 `refresh`，
 * 就能直接观察「池里的账号有没有被交到续期手上」。既如此就不必退回文本断言
 *（文本断言正是本文件上半部分被证伪的那种「守卫不守」形态）。
 *
 * ### 判据
 *
 * 池里放**唯一**一个账号，且它带**目标模型**的未过期限流标记 ⇒
 * 续期仍必须定位到它（`refreshAccountCredential` 收到它的 ref）。
 * 若续期改成了按模型过滤，该账号会被筛掉 ⇒ 回落到单凭据 `refresh()` ⇒ 红。
 */
describe('H2 · 续期路径刻意不按模型过滤（与上一组的反面）', () => {
  /** provider id → 它的 auth 服务名（`ctx.<name>`；服务名由产品 id 派生）。 */
  const REFRESH_SERVICES: Readonly<Record<string, string>> = {
    codearts: 'codeartsAuth',
    buddy: 'buddyAuth',
    workbuddy: 'workbuddyAuth',
    lobsterai: 'lobsteraiAuth',
    qoder: 'qoderAuth',
    qodercn: 'qodercnAuth',
    trae: 'traeAuth',
    cline: 'clineAuth',
    loomy: 'loomyAuth',
    raccoon: 'raccoonAuth',
    minimax: 'minimaxAuth',
    gemini: 'geminiAuth',
    // ⚠️ officeace 的值是 auth 服务形状的包装对象（`officeaceAuthService`），
    //    不是 `Service` 子类实例 —— 但它同样以 `ctx.officeaceAuth` 注册。
    officeace: 'officeaceAuth',
  }

  /**
   * ⚠️ **zcode 不在名单里**：它的 `refresh` 走 `refreshAll(pool)`（逐账号读**自己的**
   * ref 再写回），**根本不问池要「一个」账号** —— 故「按不按模型过滤」在它身上
   * 不是一个可观测的量。这不是豁免了某个风险，而是该风险对它不存在。
   */
  const REFRESH_PROVIDERS = Object.keys(REFRESH_SERVICES) as readonly string[]

  const MODEL = 'glm-5.2'
  const dirs: string[] = []

  beforeEach(() => {
    vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })
  })
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
    accountPool: { addAccount(entry: Record<string, unknown>): Promise<void> }
    credentials: FakeCredentials
    llm: FakeLlm
  }

  function boot(): TestCtx {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-refresh-empty-'))
    dirs.push(dir)
    process.env.DSH_JET_HUB_STATE_DIR = dir
    const ctx = new Context() as TestCtx
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    ctx.provide('llm', new FakeLlm() as never)
    apply(ctx as never)
    return ctx
  }

  /** 往池里放**唯一**一个带该模型限流标记的账号，并写好凭据。 */
  async function addRateLimitedAccount(ctx: TestCtx, provider: string): Promise<{ id: string; ref: string }> {
    const id = `acct_${provider}_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `${provider.toUpperCase()}_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id,
      provider,
      nickname: id,
      enabled: true,
      credentialRef: ref,
      createdAt: 0,
      refreshable: true,
      modelRateLimits: { [MODEL]: Date.now() + 3_600_000 },
    })
    await ctx.credentials.set(
      credentialRef(ref),
      JSON.stringify({
        access_token: `tok-${id}`,
        refresh_token: 'rt',
        expires_at: Date.now() + 3_600_000,
      }),
    )
    return { id, ref }
  }

  it('⚠️ 名单非空（防空洞自检：名单为空时 it.each 一条都不跑，整组恒绿）', () => {
    // ⚠️ 2026-10-12 加 officeace：12 → 13。
    expect(REFRESH_PROVIDERS.length).toBe(13)
    expect(REFRESH_PROVIDERS).not.toContain('zcode')
  })

  it.each(REFRESH_PROVIDERS)(
    '%s：唯一账号被该模型限流 ⇒ 续期仍必须定位到它（不得按模型过滤）',
    async (provider) => {
      const ctx = boot()
      const { ref } = await addRateLimitedAccount(ctx, provider)

      // ① 前提：池层面确实因这个标记把账号筛掉了（按模型问池拿不到它）。
      const pooled = await (ctx.accountPool as unknown as {
        getAvailableAccount(p: string, m: string): Promise<unknown>
      }).getAvailableAccount(provider, MODEL)
      expect(pooled, '前提：限流标记应把唯一账号筛出候选').toBeNull()

      // ② 把该 provider 的续期入口换成记录器：本组只关心「续期拿到了哪个 ref」，
      //    不关心各家的续期协议（那由各自的 spec 覆盖），更不能真发网络。
      const serviceName = REFRESH_SERVICES[provider]!
      const service = (ctx as unknown as Record<string, Record<string, unknown>>)[serviceName]
      expect(service, `ctx.${serviceName} 不存在 —— 该 provider 的 auth 实例没注册上`).toBeDefined()
      const seen: string[] = []
      let singleCredentialFallback = 0
      service.refreshAccountCredential = async (refName: unknown) => { seen.push(String(refName)) }
      service.refresh = async () => { singleCredentialFallback++ }

      // ③ 调**真实**续期闭包。
      const adapter = ctx.llm.adapterByProvider.get(provider) as {
        options?: { refresh?: () => Promise<void> }
      } | undefined
      const refresh = adapter?.options?.refresh
      expect(refresh, `${provider} 适配器没有 refresh 选项`).toBeTypeOf('function')
      // 各家的 refresh 都是箭头函数（闭包），故无需绑定 `this`。
      await refresh!()

      // ④ 必须命中那个被限流的账号；若续期改成了按模型过滤，它会先被筛掉，
      //    于是回落到单凭据 `refresh()`（下面的 fallback 计数会变成 1）。
      expect(
        seen,
        `${provider} 的续期按模型过滤了 ⇒ 被该模型限流的账号 ${ref} 永远轮不到续期`
        + `（回落到单凭据续期 ${singleCredentialFallback} 次）`,
      ).toEqual([ref])
      expect(singleCredentialFallback, '不得回落到单凭据续期').toBe(0)
    },
    30_000,
  )
})
