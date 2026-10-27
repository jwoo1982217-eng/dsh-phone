/**
 * `usage.badge` 对 `jet-hub-auto` 的**改写接线**回归 —— 真跑端点，不做源码文本断言。
 *
 * ## 为什么需要本文件（PR !84 复审实测的守卫缺口）
 *
 * PR !84 把判定逻辑抽成纯函数 `resolveAutoBadgeRewrite` 并补了 29 条行为用例，
 * 但**判定函数正确 ≠ 它被正确调用**：`jet-hub-rpc.ts` 里的调用点与响应拼装
 * 只有源码文本断言，而**文本断言对「短路禁用」天然免疫**（作者本人也在注释里
 * 记录了这一点）。复审实测：把下面任一处改坏，`auto-badge-restore.spec.ts` +
 * `aggregate-badge.spec.ts` + `aggregate-adapter.spec.ts` **140 条全绿**：
 *
 * | 变异 | 后果 |
 * |---|---|
 * | `modelAdapters?.[AUTO_PROVIDER_ID]?.autoState?.()` → `undefined` | 拿 auto 去查余额 ⇒ 徽标永远报「选型不可用」 |
 * | 响应里丢掉 `autoActual` | 胶囊退化成裸 `jet-hub-auto`（用户报障的形态） |
 * | `effectiveProvider` 不取改写值（直接用 `provider`） | **回到缺陷态**：按 auto 查余额必然失败 |
 *
 * ⇒ 本文件按 `opencode-usage-badge.spec.ts` 的模式**装配真实 `AccountPool` +
 * `registerJetHubRpc`**，真调 `usage.badge` 端点。这类断言能抓住上面三格，
 * 而文本断言一个都抓不住。
 *
 * ## 锁住的不变式
 *
 * 1. auto 请求被改写成**实际用过的渠道**的余额（真实历史优先）；
 * 2. 响应 `provider` 改回 auto —— 客户端用它做「这份读数属不属于我」的对号
 *   （`usage-badge.js` 的 `value.provider !== provider` 守卫），透传被改写后的
 *   provider 会被客户端丢弃 ⇒ 徽标停在初始态；
 * 3. `autoActual` / `autoPrice` / `autoExpiryAt` 真的回传（胶囊三要素的数据来源）；
 * 4. 无真实历史时回退预测，且仍带 `autoActual`；
 * 5. 非 auto 渠道原样透传（其余 15 家的行为不得被带跑）；
 * 6. 适配器没挂上时报**可行动**错误，绝不拿 auto 去查一个必然失败的余额；
 * 7. auto 那一路读的是胜者渠道的**本地**数据，不发多余网络；
 * 8. `pruned(id, adapter, { enabled: false })` 返回**原适配器** ⇒ `autoState()` 原样可取
 *   （装配层 `index.ts` 就是靠这条把实例传进 `modelAdapters` 的）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { AUTO_PROVIDER, AutoAdapter } from '../../src/auto-adapter.js'
import { withDeadModelPruning } from '../../src/dead-model-store.js'
import { resolveAutoBadgeRewrite, UNUSABLE_EXPIRY } from '../../src/auto-badge.js'
import { UNUSABLE } from '../../src/aggregate-core.js'

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

function makeRpc(modelAdapters: Record<string, unknown> | undefined) {
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
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)

  const pool = new AccountPool(ctx)
  registerJetHubRpc(
    ctx, pool,
    {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never, lobsterai: {} as never,
      qoder: {} as never, qodercn: {} as never, trae: {} as never, cline: {} as never,
      loomy: {} as never, raccoon: {} as never, minimax: {} as never, zcode: {} as never,
      gemini: {} as never,
      officeace: {} as never,
    } as never,
    modelAdapters as never,
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

/**
 * 桩里用的固定临期时刻。
 *
 * ⚠️ 必须是**常量**而不能是 `Date.now() + …`：这条用例要断言「宿主回传的
 * `autoExpiryAt` 恰好等于适配器给出的时刻」，动态值会让断言退化成
 * 「只要是个数字就行」，从而漏掉「回传了**别的**渠道/别的来源的时刻」。
 */
const STUB_EXPIRY = 1_800_000_000_000

/** **适配器**桩：`modelAdapters['jet-hub-auto']` 上要挂的是它 ——
 * `usage.badge` 调的是 `adapter.autoState()`，拿到下面的 `autoStub()` 返回值。 */
function adapterStub(overrides: Record<string, unknown> = {}) {
  return { listAllModels: () => [], autoState: () => autoStub(overrides) }
}

/** autoState() 的返回值：有真实历史（used opencode / big-pickle，倍率 0.06）。 */
function autoStub(overrides: Record<string, unknown> = {}) {
  return {
    lastDecision: {
      provider: 'opencode', model: 'big-pickle', viaImageFallback: false,
      // ⚠️ 真实形状：`dispatch()` 记录时把当时的 `lastExpiryAt` 一并带上
      //（真实历史路径的倒计时读的是它，不是 `lastWinnerExpiryAt`）。
      expiryAt: STUB_EXPIRY,
    },
    lastWinnerExpiryAt: STUB_EXPIRY,
    selectProvider: async () => undefined,
    priceOf: (provider: string, model: string) => (provider === 'opencode' && model === 'big-pickle' ? 0.06 : undefined),
    ...overrides,
  }
}

describe('★ 用量徽标：usage.badge 的 auto 改写接线（真跑端点）', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('★ auto 请求被改写成实际渠道，且 autoActual / autoPrice / provider 回写都对', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      fetched.push(String(input))
      throw new Error('本用例不应发网络请求（opencode 余额来自本地池）')
    })
    const { call, pool } = makeRpc({ [AUTO_PROVIDER]: adapterStub() })
    await pool.addAccount({
      id: 'oc-on', provider: 'opencode', nickname: '可用号', enabled: true,
      credentialRef: 'OPENCODE_ACCOUNT_ON', createdAt: 1, refreshable: false,
    })

    const result = await call('usage.badge', { provider: AUTO_PROVIDER, force: true })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.value.provider, 'provider 必须改回 auto（客户端按它认领读数）').toBe(AUTO_PROVIDER)
    expect(result.value.autoActual).toEqual({ provider: 'opencode', model: 'big-pickle', viaImageFallback: false })
    expect(result.value.autoPrice, '倍率必须回传（用户报障「没倍率显示？」）').toBe(0.06)
    expect(result.value.autoExpiryAt, '临期倒计时必须回传').toBeGreaterThan(Date.now())
    expect(fetched, '读的是胜者渠道的本地余额，不得发网络').toEqual([])
  })

  it('★ 无真实历史时回退预测，且仍带 autoActual / autoPrice / autoExpiryAt', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('不应发网络') })
    const { call, pool } = makeRpc({
      [AUTO_PROVIDER]: adapterStub({
        lastDecision: null,
        selectProvider: async () => ({ provider: 'opencode', model: 'big-pickle' }),
      }),
    })
    await pool.addAccount({
      id: 'oc-on', provider: 'opencode', nickname: '可用号', enabled: true,
      credentialRef: 'OPENCODE_ACCOUNT_ON', createdAt: 1, refreshable: false,
    })

    const result = await call('usage.badge', { provider: AUTO_PROVIDER, force: true })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.value.provider).toBe(AUTO_PROVIDER)
    expect(result.value.autoActual?.provider).toBe('opencode')
    expect(result.value.autoPrice).toBe(0.06)
    // ⚠️ 这条断言原先**缺席**（复审指出的覆盖缺口）：预测路径的倒计时取自
    //    `autoState().lastWinnerExpiryAt`，而它曾经是**值快照** ⇒ 恒 `undefined`。
    //    少了这行，D1 那个「重启后首轮永远没有倒计时」的缺陷在本文件里看不出来。
    expect(result.value.autoExpiryAt, '预测路径也必须带倒计时（D1 的守卫）').toBe(STUB_EXPIRY)
  })

  it('★ 适配器没挂上时报可行动错误（不得静默按 auto 查余额）', async () => {
    const { call } = makeRpc(undefined)
    const result = await call('usage.badge', { provider: AUTO_PROVIDER, force: true })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('适配器未挂载')
  })

  it('★ 非 auto 渠道原样透传（buddy 不会被改写）', async () => {
    const { call } = makeRpc({ [AUTO_PROVIDER]: adapterStub() })
    const result = await call('usage.badge', { provider: 'opencode', force: true })
    // opencode 无账号 ⇒ 空读数是正常的；关键是它**不该**带 autoActual。
    expect(result.value?.autoActual).toBeUndefined()
  })

  /**
   * ★★ **其余 15 家的行为逐字不变** —— 逐 provider 对拍（本 PR 的硬要求）。
   *
   * ⚠️ 为什么需要它：`usage.badge` 现在**无条件**先过一遍
   * `resolveAutoBadgeRewrite`，只用它的返回值决定改写。对非 auto 的输入，该函数
   * 必须回 `passthrough`，于是 `effectiveProvider === provider`、
   * `rewrite.kind !== 'rewrite'` ⇒ **响应形状与原实现逐字相同**（不新增任何字段）。
   *
   * 这条链路上任何一处写反（例如把 passthrough 也当 rewrite 处理），都会让其余
   * 15 个渠道凭空多出/丢掉字段。故这里对**全部**渠道逐个断言：
   * 1. 收到的读数 `provider` 就是传进去的那个（没被改写）；
   * 2. 响应**不含** `autoActual` / `autoPrice` / `autoExpiryAt`（auto 专属字段）。
   */
  it('★★ 其余渠道逐字不变：全部 provider 都不被改写、也不带 auto 专属字段', async () => {
    // 与客户端 `PROVIDERS` / 宿主注册表一致的 15 家（auto 之外的全体）。
    const providers = [
      'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
      'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini', 'opencode',
      // `aggregate` 也走本分支（它的改写由客户端重定向负责，不在这里）。
      'aggregate',
    ]
    const { call, pool } = makeRpc({ [AUTO_PROVIDER]: adapterStub() })
    // 给每个渠道放一个账号，确保读数路径真的被执行（而不是因空池提前返回）。
    for (const [index, provider] of providers.entries()) {
      await pool.addAccount({
        id: `${provider}-1`, provider, nickname: '号', enabled: true,
        credentialRef: `${provider.toUpperCase()}_ACCOUNT_1`, createdAt: index + 1, refreshable: false,
      })
    }

    for (const provider of providers) {
      const result = await call('usage.badge', { provider, force: true })
      // ⚠️ 不断言 `ok`：多数渠道在单测里没有真实凭据，回失败信封是正常的。
      //    要守的是「**没被 auto 的改写逻辑污染**」，故对成功与否都检查形状。
      const value = result.value as Record<string, unknown> | undefined
      if (value !== undefined) {
        if (value.provider !== undefined) {
          expect(value.provider, `${provider} 的读数 provider 不得被改写`).toBe(provider)
        }
        for (const field of ['autoActual', 'autoPrice', 'autoExpiryAt']) {
          expect(value[field], `${provider} 不得带 auto 专属字段 ${field}`).toBeUndefined()
        }
      }
    }
  })

  it('★ pruned(id, adapter, { enabled: false }) 返回原适配器 ⇒ autoState 原样可取', () => {
    const adapter = { listAllModels: () => [], autoState: () => autoStub() }
    const wrapped = withDeadModelPruning([AUTO_PROVIDER], adapter, { enabled: false })
    expect(wrapped, 'enabled:false 必须直接返回原适配器').toBe(adapter)
    expect(typeof (wrapped as { autoState?: unknown }).autoState).toBe('function')
  })

  it('★ 判定函数与真适配器状态形状兼容（纯函数 ← → autoState 契约）', async () => {
    const rewrite = await resolveAutoBadgeRewrite(AUTO_PROVIDER, AUTO_PROVIDER, autoStub() as never)
    expect(rewrite.kind).toBe('rewrite')
    expect(rewrite.kind === 'rewrite' && rewrite.effectiveProvider).toBe('opencode')
  })

  /**
   * ★★ **真适配器**上的 D1 守卫：`autoState()` 必须是**活值**，不能是值快照。
   *
   * ## 为什么不复用上面的桩用例
   *
   * 上面的回退用例把 `lastWinnerExpiryAt` **在调用前就写死在桩对象上**，而真实
   * 实现是「`selectProvider` 内部写入 → 消费方在它**之后**读」。桩的时序与真实
   * 实现**不符** ⇒ 那条断言对 D1 天然免疫（这正是本仓库红线第 3 条「恒真的假用例」
   * 形态：把实现改成恒 `undefined` 的快照后，桩用例照样全绿）。
   *
   * ⇒ 本条用**真实 `AutoAdapter`** + 真实调用序（`autoState()` → `selectProvider()`
   * → 读快照），才能抓住「快照冻在取值那一刻」。
   *
   * ## 缺陷形态（复审实测）
   *
   * ```
   * 快照时 lastWinnerExpiryAt      = undefined
   * selectProvider 返回            = buddy/m1
   * 适配器真实 lastWinnerExpiryAt  = 100
   * ★ 但快照里的值仍是             = undefined   ⇒ autoExpiryAt 缺席
   * ```
   * 症状：插件重启后首轮（无真实历史）的胶囊**永远没有临期倒计时**，发过消息后
   * 才出现 —— 而倒计时是「止损工具」三要素里唯一回答「还剩多久」的那个。
   */
  it('★★ 无历史回退路径必须真的带回倒计时（真适配器：autoState 不得是值快照）', async () => {
    const adapter = new AutoAdapter({
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'm1', name: 'M1 · x0.1', inputModalities: ['text'] }]
          : []),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
      } as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    /** 主胜者 buddy 的临期时刻（本用例要观察的就是它）。 */
    const WINNER_EXPIRY = 100
    adapter.expiryOf = async (provider: string) => (provider === 'buddy' ? WINNER_EXPIRY : -1)

    // ⚠️ 严格复刻 `jet-hub-rpc.ts` 的调用序：先取快照，再让它去选型。
    const state = adapter.autoState()
    const rewrite = await resolveAutoBadgeRewrite(AUTO_PROVIDER, AUTO_PROVIDER, state as never)

    expect(rewrite.kind, JSON.stringify(rewrite)).toBe('rewrite')
    expect(rewrite.kind === 'rewrite' && rewrite.autoActual?.provider).toBe('buddy')
    // ⛔ 值快照实现下这里是 `undefined`（倒计时恒缺席）。
    expect(
      rewrite.kind === 'rewrite' ? rewrite.autoExpiryAt : undefined,
      '无历史回退路径必须带回主胜者的临期时刻',
    ).toBe(WINNER_EXPIRY)
  })

  /**
   * ★★ `UNUSABLE` 哨兵**不得**被当成到期时刻发出去（复审实测，D4）。
   *
   * `expiryOf` 正常返回 `UNUSABLE = -1`（「该渠道当前不可用」）。`-1` 既非
   * `undefined` 也非 `Infinity`，且 `Number.isFinite(-1) === true` ⇒ 一旦放行，
   * 它能穿过宿主与客户端**两道**守卫，最终被 `expiryCountdownText` 渲染成
   * `1/1 07:59过期`（1970 派生的荒谬时间）—— 实测：
   *
   * ```
   * expiryCountdownText(-1, now)         -> "1/1 07:59过期"
   * autoBadgeName({ expiryAt: -1 })      -> "自动 → buddy GLM-5.3-Flash · 1/1 07:59过期"
   * ```
   *
   * 本用例直接断言「哨兵不会进入响应」，从而在**边界处**挡住它（而不是在客户端
   * 再加一道判断 —— 那会是同一语义两套实现）。
   */
  it('★★ UNUSABLE(-1) 哨兵不得被回传成到期时刻（否则渲染成 1970 年份的倒计时）', async () => {
    const { call, pool } = makeRpc({
      [AUTO_PROVIDER]: adapterStub({
        lastDecision: { provider: 'opencode', model: 'big-pickle', viaImageFallback: false, expiryAt: UNUSABLE_EXPIRY },
        lastWinnerExpiryAt: UNUSABLE_EXPIRY,
      }),
    })
    await pool.addAccount({
      id: 'oc-on', provider: 'opencode', nickname: '可用号', enabled: true,
      credentialRef: 'OPENCODE_ACCOUNT_ON', createdAt: 1, refreshable: false,
    })

    const result = await call('usage.badge', { provider: AUTO_PROVIDER, force: true })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    // ⛔ 修前这里是 `-1`，客户端会渲染出 `1/1 07:59过期`。
    expect(result.value.autoExpiryAt, 'UNUSABLE 哨兵不得回传').toBeUndefined()
  })

  /**
   * ★ 哨兵字面量必须与**权威**（`aggregate-core.ts`）一致。
   *
   * `src/auto-badge.ts` 刻意**零 import**（避免拖进运行时依赖），故 `-1` 是复刻的
   * 字面量 —— 这条对拍用例是防止「改了一侧忘另一侧」的唯一防线（本仓库对
   * 「两处写死必然漂移」有明确教训）。
   */
  it('★ auto-badge 的哨兵字面量必须与 aggregate-core 的 UNUSABLE 相等', () => {
    expect(UNUSABLE_EXPIRY).toBe(UNUSABLE)
  })

  /**
   * ★★ `prepareCall` 期间的中止必须以 `AbortError` 逃逸，不得被吞成「倒计时缺席」
   * （复审实测，D3）。
   *
   * ⚠️ 这是本仓库的成文红线（AGENTS.md）：「abort 必须**立刻**以 AbortError 结束，
   * 绝不能被降级」。`dispatchTargetOf` 新增的临期查询为此加了一层 `catch`，
   * 裸 `catch {}` 会把中止静默吞掉 —— 而同文件的 `hasUsableAccountFor` 是按
   * **三条判据**原样重抛的（`signal.aborted` / `name === 'AbortError'` /
   * `code === 'ABORTED'`），本处必须逐格同构。
   *
   * ## ⚠️ 必须**隔离**这条 catch（否则用例会被下游顺带满足，变成假用例）
   *
   * 第一版用例让 `expiryOf` 先 `controller.abort()` 再 `throwIfAborted()` —— 那样
   * `signal.aborted` 已为真，**后续**的 `resolveModelInfo(..., signal)` 自己也会抛
   * 中止 ⇒ 即使把这整段 catch 改成裸 `catch {}`，用例**照样通过**（实测：改成裸
   * catch 后 40 条全绿）。那样的断言对该防护**没有覆盖**，属本仓库禁止的恒真形态。
   *
   * ⇒ 改为「只抛 AbortError、但**不**把 signal 置为 aborted」，且让
   * `resolveModelInfo` 正常返回 —— 于是中止**只能**由本处的三条判据带出去：
   * 裸 `catch {}` 会把它吞成「倒计时缺席」并让 `prepareCall` 成功返回。
   */
  it('★★ prepareCall 中途 abort 必须逃逸（不得被临期查询的 catch 吞掉）', async () => {
    const adapter = new AutoAdapter({
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'm1', name: 'M1', inputModalities: ['text'] }]
          : []),
        // ⚠️ 刻意**不**碰 signal 且正常返回：把中止的出口**只**留给被测的那段 catch。
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
      } as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    // ⚠️ 必须让**选型阶段**（`selectProvider` 自己的 `expiryOf` 循环）全部正常返回，
    //    只有**选型之后**那次（即 `dispatchTargetOf` 里的）抛中止 —— 否则中止会在
    //    选型循环里就逃逸出去，被测的那段 catch 根本执行不到（实测：那样写时把它
    //    改成裸 `catch {}` 依然 10 条全绿，属假用例）。
    //    `selectProvider` 会按 `AUTO_PROVIDERS` 逐个探测，故用「本次调用次数」定位。
    const probed = new Set<string>()
    adapter.expiryOf = async (provider: string) => {
      // 同一 provider 的**第二次**查询才来自 `dispatchTargetOf`。
      if (probed.has(provider)) {
        const abort = new Error('aborted')
        abort.name = 'AbortError'
        throw abort
      }
      probed.add(provider)
      return provider === 'buddy' ? 100 : -1
    }

    await expect(
      adapter.prepareCall('jet-hub-auto', 'auto', new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
