/**
 * CodeBuddy / WorkBuddy 的余额缓存选号器（`src/buddy-balance-selector.ts`）。
 *
 * ## 本文件锁死什么
 *
 * 1. **TTL 缓存**：同一轮对话内的多次选号不重复发余额请求（该端点响应实测可达
 *    数百 KB，一个账号可能有 105 个资源包）。
 * 2. **失败不抛错**：一个号查不到不至于让整个选号失败（凭据过期是最常见原因）。
 * 3. **锁定语义**：只剩永久积分的账号在锁定期间**不被选中**；解锁时不改变既有
 *    行为（全部无余额仍返回第一个，让上游去报真实原因）。
 * 4. **`pickBuddyAccount` 的收尾**：锁定 → `locked`（调用方必须报错，绝不回落，
 *    否则锁定形同虚设）；未锁定 → `exhausted` + tried（调用方继续走池的兜底）。
 */
import { describe, expect, it } from 'vitest'
import {
  BUDDY_BALANCE_CACHE_TTL_MS,
  BUDDY_BALANCE_ERROR_CACHE_TTL_MS,
  BuddyBalanceSelector,
  pickBuddyAccount,
  type BuddyCandidateAccount,
} from '../../src/buddy-balance-selector.js'
import { CODEBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

function pkg(overrides: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name: 'Bonus Pack',
    unit: 'credits',
    remaining: 0,
    total: 0,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime: NOW + 30 * DAY,
    ...overrides,
  }
}

function balance(...packages: CreditPackage[]): CreditBalance {
  return { total: 0, packages, expiredTotal: 0 }
}

/**
 * 造一个选号器。
 *
 * @param balances - accountId → 返回的余额（`null` = 查询失败，Error = 抛异常）
 * @param options - 凭据解析失败的账号集合、时钟、TTL
 */
function makeSelector(
  balances: Record<string, CreditBalance | null | Error>,
  options: {
    /** 这些账号的凭据解析不出来（模拟凭据缺失/损坏）。 */
    brokenRefs?: readonly string[]
    /** 现在几点（可推进以测 TTL）。 */
    clock?: { value: number }
    ttlMs?: number
    errorTtlMs?: number
  } = {},
) {
  const calls: string[] = []
  const clock = options.clock ?? { value: NOW }
  const selector = new BuddyBalanceSelector({
    product: CODEBUDDY,
    now: () => clock.value,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.errorTtlMs === undefined ? {} : { errorTtlMs: options.errorTtlMs }),
    resolveCredential: async (ref) => {
      if (options.brokenRefs?.includes(ref)) return undefined
      return { access_token: `token-of-${ref}` } as BuddyCredential
    },
    fetchBalance: async (credential) => {
      const ref = String((credential as { access_token: string }).access_token).replace('token-of-', '')
      calls.push(ref)
      const value = balances[ref]
      if (value instanceof Error) throw value
      return value ?? null
    },
  })
  return { selector, calls, clock }
}

const account = (id: string): BuddyCandidateAccount => ({ id, credentialRef: id })

/**
 * `select()` 现在返回判别联合（`{ok:true,…} | {ok:false,reason}`），
 * 断言"选中了谁"统一走这个取值器；断言"为什么没选中"则直接看 `reason`。
 */
const pickedId = (result: Awaited<ReturnType<BuddyBalanceSelector['select']>>): string | undefined =>
  result.ok ? result.account.id : undefined

describe('BuddyBalanceSelector.balanceOf（带 TTL 的余额查询）', () => {
  it('TTL 内不重复请求，过期后重查', async () => {
    const { selector, calls, clock } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
    })
    await selector.balanceOf(account('a1'))
    await selector.balanceOf(account('a1'))
    expect(calls).toEqual(['a1'])

    clock.value += BUDDY_BALANCE_CACHE_TTL_MS + 1
    await selector.balanceOf(account('a1'))
    expect(calls).toEqual(['a1', 'a1'])
  })

  /**
   * ⚠️ **真实缺陷**（用户报障 2026-09-29）：失败结果曾被按成功的那份 60 秒 TTL
   * 缓存 —— 一次网络抖动就让整池在 60 秒内全部判"不可用"，用户被告知
   * 「额度已用尽」而实际号里都有钱（实测当时 4 个 loomy 号：4965/5000/5000/0）。
   * ⇒ 失败是瞬时状态，只该缓存很短的时间。
   */
  it('失败结果只按短 TTL 缓存，5 秒后即重试（不等满 60 秒）', async () => {
    const clock = { value: NOW }
    const flaky: Record<string, CreditBalance | null> = { a1: null }
    const { selector, calls } = makeSelector(flaky, { clock })

    const first = await selector.balanceOf(account('a1'))
    expect(first.ok).toBe(false)

    // 6 秒后（< 60 秒成功 TTL，> 5 秒失败 TTL）：应该重新查一次
    clock.value += BUDDY_BALANCE_ERROR_CACHE_TTL_MS + 1_000
    flaky.a1 = balance(pkg({ remaining: 5000, deductionEndTime: NOW + 9 * DAY }))
    const second = await selector.balanceOf(account('a1'))
    expect(second.ok).toBe(true)
    expect(second.expiringBalance).toBe(5000)
    expect(calls).toEqual(['a1', 'a1'])
  })

  it('失败结果在短 TTL 内不重复请求（防同一轮里反复打）', async () => {
    const clock = { value: NOW }
    const { selector, calls } = makeSelector({ a1: null }, { clock })
    await selector.balanceOf(account('a1'))
    clock.value += BUDDY_BALANCE_ERROR_CACHE_TTL_MS - 1_000
    await selector.balanceOf(account('a1'))
    expect(calls).toEqual(['a1'])
  })

  it('invalidate 指定账号后重查；invalidate 全部同理', async () => {
    const { selector, calls } = makeSelector({
      a1: balance(pkg({ remaining: 1 })),
      a2: balance(pkg({ remaining: 2 })),
    })
    await selector.balanceOf(account('a1'))
    await selector.balanceOf(account('a2'))
    selector.invalidate('a1')
    await selector.balanceOf(account('a1'))
    expect(calls.filter(c => c === 'a1')).toHaveLength(2)
    expect(calls.filter(c => c === 'a2')).toHaveLength(1)

    selector.invalidate()
    await selector.balanceOf(account('a2'))
    expect(calls.filter(c => c === 'a2')).toHaveLength(2)
  })

  it('按账号 id 分键缓存，不同账号各自请求', async () => {
    const { selector, calls } = makeSelector({ a1: balance(), a2: balance() })
    await selector.balanceOf(account('a1'))
    await selector.balanceOf(account('a2'))
    expect(calls).toEqual(['a1', 'a2'])
  })

  /** ⚠️ 凭据不可用时**不发余额请求**，也不抛错（归入最后一档）。 */
  it('凭据解析失败 → ok: false 且不调用余额端点', async () => {
    const { selector, calls } = makeSelector({ a1: balance(pkg({ remaining: 100 })) }, { brokenRefs: ['a1'] })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(false)
    expect(entry.error).toContain('凭据未配置')
    expect(calls).toEqual([])
  })

  it('余额端点抛异常 → ok: false（不让一次抖动毁掉整个选号）', async () => {
    const { selector } = makeSelector({ a1: new Error('socket hang up') })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(false)
    expect(entry.error).toContain('socket hang up')
  })

  it('余额查询返回 null → ok: false（与「余额为 0」严格区分）', async () => {
    const { selector } = makeSelector({ a1: null })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(false)
    expect(entry.expiringBalance).toBeUndefined()
    expect(entry.permanentBalance).toBeUndefined()
  })

  it('成功时按到期时间拆出两桶并给出档位', async () => {
    const { selector } = makeSelector({
      a1: balance(
        pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY }),
        pkg({ name: 'Free Plan Subscription', remaining: 100, deductionEndTime: NOW + 3008 * DAY }),
      ),
    })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(true)
    expect(entry.split).toEqual({ expiring: 250, permanent: 100 })
    expect(entry.tier).toBe(0) // expiring
  })

  /**
   * ⚠️ 未显式注入窗口时，选号器必须**按环境变量解析**窗口。
   *
   * 实测中国版 CodeBuddy 的裂变包剩余密集落在 17～30 天：默认 15 天下整池
   * 判成永久（锁定即无可用账号），放宽到 31 天才能用。若这里把窗口写死，
   * 用户设了环境变量也不生效，而且报错文案（运行时解析）会与选号判据分叉。
   */
  /**
   * ⚠️ **本文件最重要的一条**：TTL 只抑制网络，不冻结分类。
   *
   * 「临时 / 永久」是 `DeductionEndTime - now` 与 15 天的比较结果，而宿主长期开着、
   * 时间只向前流 —— 一笔 15 天 + 30 秒的余额，30 秒后就越过了线。此时缓存还没过期
   * （60 秒），**绝不能**把上一次的分桶结果原样返回：那会让选号继续按「永久」处理
   * 一笔其实马上要作废的积分（锁定时更糟：本该可用的号被判成不可用）。
   */
  it('TTL 内命中缓存也按新时刻重新分类，且不重发请求', async () => {
    const clock = { value: NOW }
    const { selector, calls } = makeSelector(
      {
        // 距到期 = 15 天 + 30 秒：此刻还算永久
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 15 * DAY + 30_000 })),
      },
      { clock },
    )

    const first = await selector.balanceOf(account('a1'))
    expect(first.split).toEqual({ expiring: 0, permanent: 100 })
    expect(first.tier).toBe(1) // permanent

    // 时间前进 40 秒（< 60 秒 TTL）⇒ 距到期 15 天 − 10 秒 ⇒ 改判临时
    clock.value += 40_000
    const second = await selector.balanceOf(account('a1'))
    expect(second.split).toEqual({ expiring: 100, permanent: 0 })
    expect(second.tier).toBe(0) // expiring
    // 分类变了，但一次网络都没多发 —— 缓存的是原料
    expect(calls).toEqual(['a1'])
  })

  /** 锁定判据同理：越线的号在锁定时应立刻变成可用，不需要等 TTL 过期。 */
  it('锁定选号读到的是按当前时刻重算的档位（缓存未过期也生效）', async () => {
    const clock = { value: NOW }
    const { selector, calls } = makeSelector(
      { a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 15 * DAY + 30_000 })) },
      { clock },
    )
    // 此刻只剩永久积分 ⇒ 锁定时不可用（且是"确实用尽"，不是查不到）
    const blocked = await selector.select([account('a1')], { allowPermanent: false })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toEqual({ kind: 'exhausted' })

    clock.value += 40_000
    const picked = await selector.select([account('a1')], { allowPermanent: false })
    expect(picked.ok && picked.account.id).toBe('a1')
    expect(calls).toEqual(['a1'])
  })

  /**
   * 窗口同样每次重读：用户改了 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 不该等 TTL 过期。
   * 提示文案（运行时解析 env）与选号判据必须同一时刻取到同一个值。
   */
  it('改窗口 env 后立即生效（不必等缓存过期）', async () => {
    const previous = process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
    try {
      delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      const { selector } = makeSelector({
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      })
      expect((await selector.balanceOf(account('a1'))).split).toEqual({ expiring: 0, permanent: 100 })

      process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = '31'
      expect((await selector.balanceOf(account('a1'))).split).toEqual({ expiring: 100, permanent: 0 })
    } finally {
      if (previous === undefined) delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      else process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = previous
    }
  })

  it('未注入 windowMs 时按 DSH_BUDDY_EXPIRING_WINDOW_DAYS 解析', async () => {
    const previous = process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
    try {
      process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = '31'
      const { selector } = makeSelector({
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      })
      const entry = await selector.balanceOf(account('a1'))
      expect(entry.split).toEqual({ expiring: 100, permanent: 0 })
    } finally {
      if (previous === undefined) delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      else process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = previous
    }
  })

  it('默认窗口（15 天）下同一笔包算永久', async () => {
    const previous = process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
    try {
      delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      const { selector } = makeSelector({
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      })
      const entry = await selector.balanceOf(account('a1'))
      expect(entry.split).toEqual({ expiring: 0, permanent: 100 })
      // 锁定 ⇒ 该号不可用（中国版那种池的真实处境）
      const picked = await selector.select([account('a1')], { allowPermanent: false })
      expect(picked.ok).toBe(false)
    } finally {
      if (previous !== undefined) process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = previous
    }
  })
})

describe('BuddyBalanceSelector.select（分档选号）', () => {
  it('空候选返回 ok:false（exhausted，不是查询失败）', async () => {
    const { selector } = makeSelector({})
    const result = await selector.select([], {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toEqual({ kind: 'exhausted' })
  })

  it('优先选「有 15 天内到期积分」的号，即使它排在后面', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
      a2: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
    })
    const picked = await selector.select([account('a1'), account('a2')], {})
    expect(pickedId(picked)).toBe('a2')
  })

  /** ⚠️ 锁定语义的核心：只剩永久积分的账号**不能被选中**。 */
  it('锁定时只剩永久积分的账号不被选中', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await selector.select([account('a1')], { allowPermanent: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toEqual({ kind: 'exhausted' })
  })

  /**
   * ⚠️ **真实缺陷**（用户报障 2026-09-29）：一次网络抖动让所有号的余额都查失败，
   * 结果被判「今日额度都已用尽」，用户于是去解锁 / 白等，而号其实都有钱。
   * ⇒ 有号查询失败时，原因必须是 `unknown`（无法判定），不能报成"用尽"。
   */
  it('有号查询失败时原因是 unknown（不谎报"额度已用尽"）', async () => {
    const { selector } = makeSelector({
      a1: null,
      a2: balance(pkg({ remaining: 0, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason.kind).toBe('unknown')
      if (result.reason.kind === 'unknown') {
        expect(result.reason.errors).toHaveLength(1)
        expect(result.reason.errors[0]).toContain('余额查询失败')
      }
    }
  })

  /** 全部查到且确实都是 0 ⇒ 才是"用尽"。 */
  it('全部查到且为 0 时原因是 exhausted', async () => {
    const { selector } = makeSelector({ a1: balance(), a2: balance() })
    const result = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toEqual({ kind: 'exhausted' })
  })

  it('锁定时有临时积分的号仍可被选中', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
    })
    const picked = await selector.select([account('a1')], { allowPermanent: false })
    expect(pickedId(picked)).toBe('a1')
  })

  it('锁定时跳过只剩永久积分的号，选下一个有临时积分的', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
      a2: balance(pkg({ remaining: 100, deductionEndTime: NOW + 12 * DAY })),
    })
    const picked = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(pickedId(picked)).toBe('a2')
  })

  /**
   * ⚠️ **解锁时必须保持既有行为**：所有账号余额都是 0 时仍返回第一个候选
   * （让上游报真实的失败原因），不能因为加了锁定功能而改变。
   */
  it('解锁时全部无余额仍返回第一个（不改变既有行为）', async () => {
    const { selector } = makeSelector({ a1: balance(), a2: balance() })
    const picked = await selector.select([account('a1'), account('a2')], {})
    expect(pickedId(picked)).toBe('a1')
  })

  it('未锁定时只剩永久积分的号仍可用（永久积分未被锁住）', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const picked = await selector.select([account('a1')], {})
    expect(pickedId(picked)).toBe('a1')
  })

  it('查询失败的号排在最后（能确认余额的号优先）', async () => {
    const { selector } = makeSelector({ a1: null, a2: balance(pkg({ remaining: 1, deductionEndTime: NOW + 9 * DAY })) })
    const picked = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(pickedId(picked)).toBe('a2')
  })

  it('并发查所有候选（一轮只发 N 次，不串行放大）', async () => {
    const { selector, calls } = makeSelector({ a1: balance(), a2: balance(), a3: balance() })
    await selector.select([account('a1'), account('a2'), account('a3')], {})
    expect(calls).toHaveLength(3)
  })
})

describe('pickBuddyAccount（选号 + 取凭据的编排）', () => {
  /** 编排层的凭据解析器（与 selector 内部那份可以不同）。 */
  const resolver = (broken: readonly string[] = []) => async (ref: string) =>
    broken.includes(ref) ? undefined : ({ access_token: `t-${ref}` } as BuddyCredential)

  it('选中账号后返回其凭据', async () => {
    const { selector } = makeSelector({ a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })) })
    const result = await pickBuddyAccount(selector, [account('a1')], {
      allowPermanent: true,
      resolveCredential: resolver(),
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.account.id).toBe('a1')
    expect(result.credential.access_token).toBe('t-a1')
    expect(result.tried.size).toBe(0)
  })

  /** ⚠️ 选号只看余额，**不保证凭据能解析** —— 必须换下一个候选而不是失败。 */
  it('首选凭据损坏时换下一个候选', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
      a2: balance(pkg({ remaining: 100, deductionEndTime: NOW + 10 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: true,
      resolveCredential: resolver(['a1']),
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.account.id).toBe('a2')
    expect(result.tried).toEqual(new Set(['a1']))
  })

  it('未锁定且全部凭据不可解析 → exhausted 并带上 tried（调用方继续走池兜底）', async () => {
    const { selector } = makeSelector({ a1: balance(), a2: balance() })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: true,
      resolveCredential: resolver(['a1', 'a2']),
    })
    expect(result.kind).toBe('exhausted')
    expect(result.tried).toEqual(new Set(['a1', 'a2']))
  })

  /**
   * ⚠️ **锁定时绝不返回可继续兜底的信号** —— 调用方若拿 `getAvailableAccount`
   * 兜底就会绕过锁定、照样消耗永久积分，使锁定形同虚设。
   */
  it('锁定且全部只剩永久积分 → locked', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
      a2: balance(pkg({ remaining: 50, deductionEndTime: NOW + 30 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      resolveCredential: resolver(),
    })
    expect(result.kind).toBe('locked')
    expect(result.tried).toEqual(new Set())
  })

  it('锁定：有临时积分的号凭据坏了，仍会继续试下一个有临时积分的号', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
      a2: balance(pkg({ remaining: 30, deductionEndTime: NOW + 14 * DAY })),
      a3: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2'), account('a3')], {
      allowPermanent: false,
      resolveCredential: resolver(['a1']),
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.account.id).toBe('a2')
    // 只剩永久积分的 a3 绝不会被选中
    expect(result.tried).toEqual(new Set(['a1']))
  })

  it('锁定：有临时积分的号都坏 → locked（绝不退到只剩永久的号）', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
      a2: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      resolveCredential: resolver(['a1']),
    })
    expect(result.kind).toBe('locked')
    expect(result.tried).toEqual(new Set(['a1']))
  })

  it('空候选不查余额（未锁定也直接返回 exhausted）', async () => {
    const { selector, calls } = makeSelector({ a1: balance() })
    const result = await pickBuddyAccount(selector, [], {
      allowPermanent: true,
      resolveCredential: resolver(),
    })
    expect(result.kind).toBe('exhausted')
    expect(calls).toEqual([])
  })
})
