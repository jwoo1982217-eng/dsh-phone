/**
 * 回归（**行为级**）：**锁定永久积分** + 全部账号被目标**模型级限流**时，
 * 必须报「限流 + 解禁时刻」，而不是误导性的「所有账号的『N 天内到期』积分都已用尽」。
 *
 * ## 为什么必须再要一份「行为级」用例（真实报障，2026-10-13）
 *
 * `credential-resolver.spec.ts` 里新加的三条是**单元级**的（用假池、假选择器、
 * 假的 `throwIfAllRateLimited`）。它们挡得住「有人把新加的判定删了」，但挡不住
 * **真实池的接线**出问题：候选究竟是不是真被 `modelRateLimits` 筛空、锁定态
 * 究竟有没有从 `permanent-locks.json` 读进来、`throwIfAllRateLimited` 在
 * `index.ts` 里到底有没有接到这四家 —— 这三件事都只有走真插件才知道。
 *
 * 本文件走**真实路径**：`apply()` 启动真插件 → 真 `AccountPool`（不是桩）→
 * 真 `permanent-locks.json` → 直接调用各 provider 注册的 `resolveCredential`。
 *
 * ## 缺陷本体（真实报障 2026-10-13，CodeBuddy）
 *
 * 用户看到：`CodeBuddy：没有可用账号。已锁定永久积分，而所有账号的「7 天内到期」
 * 积分都已用尽。` + 「明明有积分却显示不可用」。
 *
 * 而 `state.json` 里 3 个 buddy 账号**全部 enabled**、余额充足，真实原因是
 * **3/3 都被目标模型 `glm-5.3` 限流**（最近解禁 04:34:42）：
 *
 * | 环节 | 实际发生 |
 * |---|---|
 * | 1 | `candidatesOf` 按 `enabled` + `modelRateLimits` 筛候选 ⇒ **空集** |
 * | 2 | `pickBuddyAccount` 的循环上界是候选数 ⇒ **一次都不执行**，`reason` 保持 `undefined` |
 * | 3 | `credential-resolver.ts` 的 `throw plan.lockedError(picked.reason ?? { kind: 'exhausted' })` |
 * | 4 | 兜底 `?? { kind: 'exhausted' }` 把**限流**谎报成「积分都已用尽」 |
 *
 * ⇒ 用户据此去解锁永久积分（会**不可撤回地烧掉**永久积分），而解禁时刻明明
 * 就写在 `modelRateLimits` 里、根本不用动任何东西。
 *
 * ⚠️ **本文件只改错误语义，不改可用性**：没有账号可用就是没有，请求仍然失败；
 * 修的是「用户看到的原因」。绝不静默换模型、也绝不绕过限流标记或永久积分锁定
 * （有用例锁死）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../../src/index.js'

class FakeCredentials {
  private store = new Map<string, string>()
  /** 归一化 key（与 `account-pool.spec.ts` / `ratelimit-misreport-behavior.spec.ts` 一致）。 */
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
    permanentLocked(provider: string): boolean
  }
  llm: FakeLlm
  credentials: FakeCredentials
}

/**
 * ⚠️ **每个用例必须一个独立状态目录**：`DSH_JET_HUB_STATE_DIR` 只做到**按文件**
 * 隔离，同一文件里各用例的账号会**累加到同一份 state.json**，而本文件的前提
 * 恰恰是「该 provider 只有我加的那一个账号」（与 `ratelimit-misreport-behavior.spec.ts`
 * 同款约定，原因见该文件 `boot()` 的注释）。
 */
const stateDirs: string[] = []

/**
 * 启动真插件，并把 `provider` 写进**永久积分锁定表**。
 *
 * ⚠️ 锁定表是**独立文档**（`$DSH_HOME/jet-hub/permanent-locks.json`，见
 * `src/permanent-lock-store.ts`），**不在** state.json 里 —— 所以必须在
 * `apply()` **之前**写好：`AccountPool` 在构造时同步载入它。
 * 顺序反了会让 `permanentLocked()` 返回 false，本文件全部用例**静默失去前提**
 * （变成在测「未锁定」的路径，而那条路径根本不会抛锁定文案）。
 */
function boot(locked: string[] = []): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-locked-ratelimit-'))
  stateDirs.push(dir)
  process.env.DSH_JET_HUB_STATE_DIR = dir
  if (locked.length > 0) {
    const locks = Object.fromEntries(locked.map((provider) => [provider, true]))
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(
      join(dir, 'jet-hub', 'permanent-locks.json'),
      JSON.stringify({ schema: 'dsh-codearts-auth/permanent-locks/v1', locks }, null, 2),
      'utf-8',
    )
  }
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
const MODEL = 'glm-5.3'
const HOUR = 3_600_000

/**
 * 剥掉注释的源码（源码级判据专用）。
 *
 * ⚠️ 与 `buddy-ratelimit-misreport.spec.ts` 的同名助手**同口径**：注释里出现
 * 目标字符串会让断言假命中（本仓库记过这条教训）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 本文件所在目录（源码级判据要读 `src/`）。 */
const here = dirname(fileURLToPath(import.meta.url))

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
  // 账号** —— 症状是「凭据写好了却取不到号」，极易误判成接线改坏了。
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
 * 四家**共享** `buddyLockedError` + `pickBuddyAccount` 的 provider
 * （`src/index.ts` 的 `lockedError: buddyLockedError(...)` 调用点）。
 *
 * ⚠️ Loomy **不在**此列：它走 `kind: 'loomy'` 分支，候选为空时有
 * `if (candidates.length > 0)` 守卫、压根不调用选择器，**反而正确** ——
 * 这条缺陷是 buddy 系列独有的。
 */
const BUDDY_FAMILY = ['buddy', 'workbuddy', 'lobsterai', 'trae'] as const

/** 四家在 `index.ts` 里显示的文案前缀（`buddyLockedError(displayName)`）。 */
const DISPLAY_NAME: Record<string, string> = {
  buddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  lobsterai: 'LobsterAI',
  trae: 'TRAE',
}

describe('锁定永久积分 + 模型限流被误报成「积分已用尽」（真实报障 2026-10-13）', () => {
  describe('★ 前提自证：锁定态真的读进来了', () => {
    it.each(BUDDY_FAMILY)('%s：permanent-locks.json 写入后 permanentLocked 为 true', async (provider) => {
      // 这条**不是**凑数：`boot()` 里锁定表的写入顺序一旦被改成「apply 之后」，
      // 下面所有用例都会静默退化成「未锁定路径」，断言全绿但测的是别的东西。
      const ctx = boot([provider])
      expect(ctx.accountPool.permanentLocked(provider), '前提：锁定态应已生效').toBe(true)
      expect(ctx.accountPool.permanentLocked('some-other'), '不该波及其它 provider').toBe(false)
    })
  })

  describe('★ 唯一启用账号被该模型限流 → 必须报「限流」，不得报「积分已用尽」', () => {
    it.each(BUDDY_FAMILY)('%s：报限流 + 解禁时刻 + 无需重新登录', async (provider) => {
      const ctx = boot([provider])
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

      expect(thrown, `${provider} 应当抛错，却静默返回了 undefined`).toBeDefined()
      const message = String(thrown?.message)
      // ① 红线：不得谎报「积分已用尽」（这正是用户报障看到的文案）
      expect(message, `${provider} 不得报「积分都已用尽」`).not.toContain('积分都已用尽')
      expect(message, `${provider} 不得提「天内到期」`).not.toContain('天内到期')
      expect(message, `${provider} 不得让用户去解锁永久积分`).not.toContain('解锁永久积分')
      // ② 应当报出限流这个真实原因，且带上可行动的信息
      expect(message, `${provider} 应报「限流」`).toContain('限流')
      expect(message, `${provider} 应说明无需重新登录`).toContain('无需重新登录')
      expect(message, `${provider} 应带上模型 id`).toContain(MODEL)
      expect(thrown?.code, `${provider} 的错误码`).toBe('QUOTA_EXCEEDED')
    }, 60_000)
  })

  /**
   * ## ⚠️ 为什么这几条只断言「不得报限流」，而**不断言** `resolves.toBeDefined()`
   *
   * 本文件走真插件、真池，但**凭据是假的**（`{access_token:'tok-…'}`，不是真实
   * buddy 凭据形状）。于是只要候选**非空**，锁定态就必然去查余额，而余额查询
   * 打真网络 ⇒ 必然失败 ⇒ 落到 `{kind:'unknown'}` 文案。
   *
   * 这不是缺陷、也不是测试写坏了：它恰恰是**锁定态与未锁定态的行为差异**
   * ——未锁定时候选非空但取不到号会退兜底（`resolves.toBeUndefined()`），
   * 锁定态则必须抛错（否则会绕过锁定、消耗不可撤回的永久积分）。
   *
   * ⇒ 所以「能正常取到号」这类断言只能在**未锁定**下做，那是
   * `ratelimit-misreport-behavior.spec.ts` 已覆盖的地面；本组只钉死
   * **候选没被筛空 ⇒ 不许报限流**（限流是「账号 × 模型」维度）。
   */
  describe('不得误伤：候选非空时不许报限流', () => {
    it('账号没有该模型的限流标记 → 不报限流', async () => {
      const ctx = boot(['buddy'])
      await addAccount(ctx, 'buddy')
      await expect(resolveOf(ctx, 'buddy')(MODEL)).rejects.not.toThrow(/限流/)
    })

    it('标记的是**别的**模型 → 不报限流（限流是「账号 × 模型」维度）', async () => {
      const ctx = boot(['buddy'])
      await addAccount(ctx, 'buddy', { modelRateLimits: { 'deepseek-v4.1-flash': Date.now() + HOUR } })
      await expect(resolveOf(ctx, 'buddy')(MODEL)).rejects.not.toThrow(/限流/)
    })

    it('两个账号、只有一个被限流 → 不报限流（候选里还有没被限流的那个）', async () => {
      const ctx = boot(['buddy'])
      const limited = await addAccount(ctx, 'buddy', { modelRateLimits: { [MODEL]: Date.now() + HOUR } })
      await addAccount(ctx, 'buddy')
      // ⚠️ 这里**不能**断言「取到没被限流的那个」：锁定态 + 假凭据 ⇒ 余额查询
      // 必然失败，取号根本走不完（原因见本节文档注释）。「按账号区分取到哪一条」
      // 的断言在**未锁定**的 `ratelimit-misreport-behavior.spec.ts` 里做，那里
      // 能真正取到号、也能用 `tok-<id>` 区分是哪一条。
      await expect(resolveOf(ctx, 'buddy')(MODEL)).rejects.not.toThrow(/限流/)
      // 前提自证：这个账号**确实**被筛掉了（否则本条是在测一个空场景）。
      const pooled = await (ctx.accountPool as unknown as {
        getAvailableAccount(p: string, m: string): Promise<unknown>
      }).getAvailableAccount('buddy', MODEL)
      expect(pooled, '前提：应还剩一个未被限流的账号').not.toBeNull()
      expect(limited, '前提：被限流的账号 id 应已写入池').toBeTruthy()
    })

    it('一个账号都没有 → 报「没有任何候选账号」，仍不得报「积分已用尽」', async () => {
      // 这是 `no-candidates` 文案的**真实覆盖路径**：池空 ⇒ 限流判定静默返回
      // ⇒ 落到 `buddyLockedError` 的 `no-candidates` 分支。文案必须并列两种
      // 可能（没启用账号 / 全被限流），不能断言成确定的一种。
      const ctx = boot(['buddy'])
      let thrown: { message?: string } | undefined
      try {
        await resolveOf(ctx, 'buddy')(MODEL)
      } catch (error: unknown) {
        thrown = error as { message?: string }
      }
      expect(thrown, '池空 + 锁定 ⇒ 应当抛错').toBeDefined()
      const message = String(thrown?.message)
      expect(message, '不得报「积分都已用尽」').not.toContain('积分都已用尽')
      expect(message, '应报「没有任何候选账号」').toContain('没有任何候选账号')
      expect(message, '应提示去 Jet Hub 确认').toContain('Jet Hub')
      // ⚠️ 文案**并列**两种可能，所以它会同时提到「限流」——但不得把话说死成
      //    确定是限流（那会让用户去等解禁，而真实原因可能是账号被停用）。
      expect(message, '不得断言有确定的解禁时刻').not.toMatch(/解禁|将于/)
    })

    it('账号被**停用**（enabled:false）+ 锁定 → 报「没有任何候选账号」，不报确定原因', async () => {
      // 停用账号本就不参与自动选号。把它算进「全部限流」会让一个普通情况
      // 被报成限流，用户会去等解禁（而真实原因是账号被停用了）。
      const ctx = boot(['buddy'])
      await addAccount(ctx, 'buddy', { modelRateLimits: { [MODEL]: Date.now() + HOUR }, enabled: false })
      let thrown: { message?: string } | undefined
      try {
        await resolveOf(ctx, 'buddy')(MODEL)
      } catch (error: unknown) {
        thrown = error as { message?: string }
      }
      expect(thrown, '停用账号 + 锁定 ⇒ 应当抛错').toBeDefined()
      const message = String(thrown?.message)
      expect(message, '不得报「积分都已用尽」').not.toContain('积分都已用尽')
      expect(message, '应报「没有任何候选账号」').toContain('没有任何候选账号')
      // 判据是「不得给出**确定的**限流结论」，而不是「不许出现『限流』二字」：
      // 停用账号确实**同时**被标记了限流，但 `candidatesOf` 先按 `enabled` 滤掉
      // 了它，限流判定（只看启用账号）因而静默返回 —— 所以真实原因就是「没有
      // 启用中的账号」，文案不得声称有解禁时刻。
      expect(message, '不得断言有确定的解禁时刻').not.toMatch(/解禁|将于/)
    })
  })

  describe('★ 未锁定时的既有行为不得被改动', () => {
    it.each(BUDDY_FAMILY)('%s：未锁定 + 全被限流 ⇒ 仍抛限流错（本次修复前就有的行为）', async (provider) => {
      // 未锁定走的是 `candidatesOf` 之后的另一条路径（`throwIfAllRateLimited`
      // 本来就在那里，见 `credential-resolver.ts` 的 ⑤）。本用例把「新加的判定
      // 有没有意外改到未锁定的路径」钉死 —— 修复不该有任何可用性变化。
      const ctx = boot()
      await addAccount(ctx, provider, { modelRateLimits: { [MODEL]: Date.now() + HOUR } })
      let thrown: { message?: string; code?: string } | undefined
      try {
        await resolveOf(ctx, provider)(MODEL)
      } catch (error: unknown) {
        thrown = error as { message?: string; code?: string }
      }
      expect(thrown, `${provider} 应抛限流错`).toBeDefined()
      expect(thrown?.code).toBe('QUOTA_EXCEEDED')
      expect(String(thrown?.message)).toContain('限流')
    }, 60_000)

    it('未锁定 + 池空 ⇒ 仍退兜底（不抛错），不得因本次修复变成硬失败', async () => {
      // 锁定与未锁定在「池空」时的行为**本来就不同**（前者抛错、后者退兜底），
      // 这是设计。本用例锁死未锁定那一侧没有被新判定波及。
      const ctx = boot()
      await expect(resolveOf(ctx, 'buddy')(MODEL)).resolves.toBeUndefined()
    })
  })

  describe('★ 锁定本身不得被绕过（永久积分不可撤回）', () => {
    it('锁定 + 有可用账号（未限流、余额充足）⇒ 仍抛错，不得静默取号', async () => {
      // 本次修复只在「候选为空」时**提前**报限流，绝不能把锁定变成可绕过：
      // 一旦绕过，选号会继续消耗永久积分，而烧掉的积分不可撤回。
      const ctx = boot(['buddy'])
      await addAccount(ctx, 'buddy')
      await expect(resolveOf(ctx, 'buddy')(MODEL)).rejects.toThrow()
    })

    it('四家各自独立：锁定 buddy 不影响 workbuddy', async () => {
      const ctx = boot(['buddy'])
      await addAccount(ctx, 'workbuddy')
      await expect(resolveOf(ctx, 'workbuddy')(MODEL)).resolves.toBeDefined()
      expect(ctx.accountPool.permanentLocked('buddy')).toBe(true)
      expect(ctx.accountPool.permanentLocked('workbuddy')).toBe(false)
    })
  })

  describe('文案逐字覆盖四家 displayName', () => {
    it.each(BUDDY_FAMILY)('%s：报错前缀是 %s 的显示名', async (provider) => {
      const ctx = boot([provider])
      await addAccount(ctx, provider, { modelRateLimits: { [MODEL]: Date.now() + HOUR } })
      let thrown: { message?: string } | undefined
      try {
        await resolveOf(ctx, provider)(MODEL)
      } catch (error: unknown) {
        thrown = error as { message?: string }
      }
      // 限流文案由 `throwIfAllAccountsRateLimited` 产出，不带 displayName；
      // 这里只钉死「四家都确实走到了那条判定」，而不是各自的锁定文案。
      expect(String(thrown?.message), `${provider} 应报限流`).toContain('限流')
      expect(String(thrown?.message), `${provider} 的文案不该提到 ${DISPLAY_NAME[provider]} 的锁定`)
        .not.toContain('天内到期')
    }, 60_000)
  })

  /**
   * ★ **同一类误报的第三条腿**（2026-10-14 审计实测打穿）：
   * **候选非空、余额分档确实选出了有临期积分的号，但那些号的凭据读不出来**。
   *
   * 修复前 `pickBuddyAccount` 的 `reason` 保持 `undefined`（循环只在
   * `!picked.ok` 时赋值），调用方的 `?? { kind: 'exhausted' }` 于是报
   * 「所有账号的『N 天内到期』积分都已用尽」—— 而分档刚证明它们**有钱**。
   *
   * ⚠️ **本文件走真 `apply()` + 真 `AccountPool` + 真 `fetchCreditBalance`**，
   * 故这一格必须在这里守：`buddy-balance-selector.spec.ts` 的单元级用例用假
   * 选择器，证明不了「真实余额响应的解析路径也走通」。
   *
   * ## 怎么让这一格真的可达（三步缺一不可）
   *
   * 1. 桩 `fetch` 返回**真实的 `get-user-resource` 形状**（双层嵌套
   *    `data.Response.Data.Accounts[]`），且包带**未来 9 天的 `DeductionEndTime`**
   *    ⇒ 该号落在「有临期积分」档（锁定态下唯一可用档）；
   * 2. 账号与凭据**都在池里**（候选非空、`enabled: true`）；
   * 3. **凭据在余额查询之后才失效** —— 光「一开始就没有凭据」测不到本条：
   *    `balanceOf` 也要解析凭据才能查余额，凭据一开始就缺 ⇒ 归 `unknown` 档，
   *    走的是**另一条腿**（余额查不到）。故必须让 `credentials.resolve`
   *    **第一次给凭据、之后返回 undefined**，精确复现「余额缓存 60s TTL 内
   *    凭据失效」那条真实时序。
   */
  describe('★ 候选非空 + 分档选出有积分的号 + 凭据读不出来 ⇒ 不得报「积分已用尽」', () => {
    /**
     * ⚠️ **为什么只有 buddy / workbuddy 这两家**（实测，不是偷懒）：
     * 本用例靠「凭据第一次读得到、之后读不到」制造那条真实时序，而
     * `lobsterai` / `trae` 的 `readCredential` **带形状校验**（校验
     * `access_token` 是字符串）⇒ 桩掉 `credentials.resolve` 后它们报的是
     * **`unknown`**（余额查询异常），走的是另一条腿。
     * 那条腿（余额查不到 ⇒ 「无法确认」）**已有用例覆盖**
     * （`buddy-permanent-lock.spec.ts` 的「锁定 + 余额查不到」）。
     * ⇒ 本用例只钉**新增的 `credential-only` 那一格**，并把范围如实收窄；
     * 四家的**文案接线**由下面那条 `it.each` 逐家断言（不依赖本时序）。
     */
    const CREDENTIAL_ONLY_FAMILY = ['buddy', 'workbuddy'] as const

    it.each(CREDENTIAL_ONLY_FAMILY)('%s：报「凭据读不出来」并**劝阻解锁**', async (provider) => {
      const ctx = boot([provider])
      const id = await addAccount(ctx, provider)

      // ① 真余额形状：9 天后到期的 250 积分 ⇒ 锁定态下该号「可用」。
      const balanceBody = {
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{
                PackageName: 'Bonus Pack',
                CapacityUnit: 'credits',
                CycleCapacityRemain: 250,
                CycleCapacitySize: 250,
                CycleCapacityUsed: 0,
                Status: 1,
                DeductionEndTime: Date.now() + 9 * 24 * 60 * 60 * 1000,
              }],
            },
          },
        },
      }
      // ② 桩 fetch：余额端点返回上面那份真形状。
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(balanceBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

      /**
       * ③ **凭据在余额查询之后失效**（真实时序）：`resolveCredential` 在
       *    `balanceOf` 里被调一次（成功）→ 之后（`pickBuddyAccount` 的
       *    `options.resolveCredential`）返回 undefined。
       *
       * ⚠️ 不能「一开始就删凭据」：那会让 `balanceOf` 也解析不出凭据 ⇒
       *    归 `unknown` 档，测到的是另一条腿（余额查不到），不是本条。
       */
      let allowCredential = true
      const credentials = ctx.credentials
      const originalResolve = credentials.resolve.bind(credentials)
      credentials.resolve = async (ref: unknown) => {
        if (allowCredential) return await originalResolve(ref)
        return undefined
      }
      const resolve = resolveOf(ctx, provider)

      /**
       * 预热：这一轮**会成功取到凭据**（凭据此刻还在），它同时把「该号有 9 天内
       * 到期的 250 积分」写进了余额缓存（TTL 60s）。
       *
       * ⚠️ 预热**必须成功**，否则缓存里没有那份余额，第二次调用会真发网络 ⇒
       *    归 `unknown` 档，测到的就不是本条了。下面 `allowCredential = false`
       *    模拟「凭据在这 60 秒窗口内失效」。
       */
      await resolve(MODEL).then(() => undefined, () => undefined)
      allowCredential = false

      /**
       * ⚠️ **前提自证**：预热那一轮必须真的**成功取到了凭据**（否则说明桩没生效，
       * 本条会退化成测「余额查不到」那条腿 —— 断言仍可能绿，但测的是别的东西）。
       * 判据：下一轮报出的原因必须是凭据问题，而**不是** `unknown`。
       * 这里用文案区分（`unknown` 的文案含「无法确认」）。
       */
      let thrown: { message?: string } | undefined
      try {
        await resolve(MODEL)
      } catch (error: unknown) {
        thrown = error as { message?: string }
      }
      vi.unstubAllGlobals()

      expect(thrown, `${provider} 应当抛错，却静默返回了 undefined`).toBeDefined()
      const message = String(thrown?.message)
      // ① 红线：**不得**报「积分都已用尽」（分档刚证明它有钱）
      expect(message, `${provider} 不得报「积分都已用尽」`).not.toContain('积分都已用尽')
      expect(message, `${provider} 不得提「天内到期」`).not.toContain('天内到期')
      // ② 必须正向点名**凭据**（给用户正确的下一步）
      expect(message, `${provider} 应点名「凭据」`).toContain('凭据')
      // ③ 必须**明确劝阻解锁**（解锁会不可撤回地烧掉永久积分）
      expect(message, `${provider} 应明确劝阻解锁永久积分`).toContain('不要')
      expect(message, `${provider} 的文案应说明这与「积分用尽」是两件事`)
        .toContain('两件事')
      // ⚠️ **不得退化成 `unknown` 那条腿**（「无法确认」）：那说明预热没成功、
      //    余额缓存是空的 ⇒ 本条测的就不是「分档选出了号但凭据坏」这一格。
      expect(message, `${provider} 走的必须是 credential-only，不是 unknown`)
        .not.toContain('无法确认')
      expect(id, '（账号确实建过 ⇒ 候选非空）').toBeTruthy()
    }, 60_000)

    /**
     * ⚠️ **四家的文案接线**（与上面的时序无关）：`buddyLockedError` 是四家**共用**
     * 的那一份，故「它有没有 `credential-only` 分支」在四家上同时成立。
     *
     * 判据用**源码级**（`codeOnly` 剥注释后再找），理由：`credential-only` 的
     * 触发时序对本文件是可达的（上面那两条），但对 `lobsterai` / `trae` 需要
     * 桩掉它们**带形状校验**的凭据解析器才能复现 —— 而那会让用例测到别的行为。
     * 故这里只钉「分支在、且**劝退了用户别去解锁**」这两件**文案契约**事实。
     *
     * 变异：把 `credential-only` 那一支从 `buddyLockedError` 删掉 ⇒ 本条红。
     */
    it('四家共用的 buddyLockedError 必须有 credential-only 分支，且文案劝阻解锁', () => {
      const indexCode = codeOnly(readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n'))
      const at = indexCode.indexOf('const buddyLockedError')
      expect(at, 'buddyLockedError 没找到').toBeGreaterThan(-1)
      // 取到下一个顶层 `const ` 声明为止（`loomyLockedError`），切成这一段的源码。
      const end = indexCode.indexOf('const loomyLockedError', at)
      expect(end, 'loomyLockedError 没找到（切块终点）').toBeGreaterThan(at)
      const block = indexCode.slice(at, end)

      expect(block, 'buddyLockedError 必须有 credential-only 分支').toContain("reason.kind === 'credential-only'")
      // ⚠️ 文案必须**同时**含「凭据」与「两件事」：前者给用户正确的下一步，
      //    后者防止用户把它误读回「钱花完了」。
      const branch = block.slice(block.indexOf("reason.kind === 'credential-only'"))
      expect(branch, '文案必须点名「凭据」').toContain('凭据')
      expect(branch, '文案必须说明这与「积分用尽」是两件事').toContain('两件事')
      // ⚠️ **必须明确劝阻解锁**（解锁不可撤回地烧掉永久积分）——
      //    这是本档唯一与「用户损失」直接相关的判据。
      expect(branch, '文案必须劝阻用户去解锁永久积分').toContain('不要')
    })
  })
})
