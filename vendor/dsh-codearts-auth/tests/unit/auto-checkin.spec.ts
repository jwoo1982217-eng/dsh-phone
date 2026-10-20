import { describe, expect, it } from 'vitest'
import {
  AUTO_CHECKIN_DELAY_MS,
  DEFAULT_AUTO_CHECKIN,
  DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS,
  autoCheckinDelayMs,
  createAutoCheckin,
  describeChannel,
  describeRun,
  isAutoCheckinExcluded,
  isUnsupportedCheckin,
  sanitizeAutoCheckin,
  shouldMarkToday,
  utc8DateString,
  type AutoCheckinDeps,
  type AutoCheckinDoc,
  type AutoCheckinStore,
} from '../../src/auto-checkin.js'
import type { BadgeRpcResult } from '../../src/usage-badge.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { RpcCreditsClaimAllResponse } from '../../src/types.js'

/**
 * 「每日首次启动自动签到」的回归测试。
 *
 * 锁六件事，每件都对应一个真实会出问题的场景：
 * 1. **日界是 UTC+8**（各渠道的每日额度都按 UTC+8 结算）—— 取本机时区会
 *    「偏东漏签一天 / 偏西一天跑两次」；
 * 2. **开关默认关闭**，关闭时**一个上游请求都不发**（这是代用户打的写操作）；
 * 3. **当天只跑一次**（用户要求「不多次重复触发」）；
 * 4. **不支持的渠道不算失败**（判据交给 `claimAll` 的信封，本模块不建第二份名单）；
 * 5. **整轮零成功零已领时「今天」不记账** ⇒ 下次启动重试（凭据还没续上 / 网络不通）；
 * 6. **在飞去重**：启动排定与「刚打开开关」同时想跑时只跑一轮。
 *
 * ⚠️ 全部用例零网络、零文件系统、零等待（`schedule` 注入、时钟注入）。
 */

/** 可控时钟（用例里只用它推进时间）。 */
function clock(start: number) {
  let now = start
  return { now: () => now, set: (value: number) => { now = value } }
}

/** 2026-10-02 12:00（UTC+8）= 04:00Z。 */
const NOON_UTC8 = Date.UTC(2026, 9, 2, 4, 0, 0)

/** 内存文档后端（记录写入次数，便于断言「今天只记一次」）。 */
function memoryStore(initial: Partial<AutoCheckinDoc> = {}) {
  let doc: AutoCheckinDoc = { ...DEFAULT_AUTO_CHECKIN, ...initial }
  const saves: AutoCheckinDoc[] = []
  const store: AutoCheckinStore = {
    kind: 'memory',
    load: () => ({ ...doc }),
    save: async (next) => {
      doc = { ...next }
      saves.push({ ...next })
    },
  }
  return { store, saves, current: () => ({ ...doc }) }
}

/** 构造一个 claimAll 成功信封。 */
function ok(partial: Partial<RpcCreditsClaimAllResponse['summary']> = {}): BadgeRpcResult<RpcCreditsClaimAllResponse> {
  const summary = { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, ...partial }
  return { ok: true, value: { results: [], summary } }
}

/** 构造一个「不支持每日签到」的错误信封（`claimAll` 的 cline / raccoon / workbuddy 分支）。 */
function unsupported(message = 'Cline 不支持每日签到（其后端没有签到接口）'): BadgeRpcResult<RpcCreditsClaimAllResponse> {
  return { ok: false, error: { code: 'bad-request', message } }
}

/** 组装执行体：默认「开关开着、今天没跑过、两个渠道」。 */
function makeRunner(options: {
  initial?: Partial<AutoCheckinDoc>
  providers?: string[]
  claim?: AutoCheckinDeps['claim']
  now?: () => number
  delayMs?: number
} = {}) {
  const time = clock(options.now === undefined ? NOON_UTC8 : options.now())
  const store = memoryStore({ enabled: true, ...options.initial })
  const calls: string[] = []
  const warnings: string[] = []
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const deps: AutoCheckinDeps = {
    store: store.store,
    listProviderIds: async () => options.providers ?? ['buddy', 'qoder'],
    claim: options.claim ?? (async (provider) => {
      calls.push(provider)
      return ok({ claimed: 1, totalCredit: 100 })
    }),
    now: options.now === undefined ? time.now : options.now,
    delayMs: options.delayMs,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      scheduled.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    warn: (message) => warnings.push(message),
  }
  return { runner: createAutoCheckin(deps), store, calls, warnings, scheduled, time }
}

describe('自动签到：日界与配置', () => {
  it('日界按 UTC+8 算（跨 16:00Z 才换日）', () => {
    // 2026-10-02 15:59Z = UTC+8 的 10-02 23:59
    expect(utc8DateString(Date.UTC(2026, 9, 2, 15, 59, 0))).toBe('2026-10-02')
    // 2026-10-02 16:00Z = UTC+8 的 10-03 00:00 —— 换日
    expect(utc8DateString(Date.UTC(2026, 9, 2, 16, 0, 0))).toBe('2026-10-03')
    // 本机时区不影响结果（这里只断言与 UTC+8 平移一致）
    expect(utc8DateString(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01')
  })

  it('开关默认**打开**（用户 2026-10-02：「自动签到默认保持打开状态」）', () => {
    expect(DEFAULT_AUTO_CHECKIN.enabled).toBe(true)
    expect(sanitizeAutoCheckin(undefined).enabled).toBe(true)
    // ⚠️ 只有**显式 `false`** 才算关闭：旧文档没有该字段、以及非布尔脏数据
    // （`'false'` / `0` 都不是用户点出来的值）都按默认打开处理。
    expect(sanitizeAutoCheckin({}).enabled).toBe(true)
    expect(sanitizeAutoCheckin({ enabled: 'false' }).enabled).toBe(true)
    expect(sanitizeAutoCheckin({ enabled: 0 }).enabled).toBe(true)
    expect(sanitizeAutoCheckin({ enabled: false }).enabled).toBe(false)
  })

  it('缺新字段的旧文档照常读出来（channels / lastAt / dismissedRunAt 都是追加的）', () => {
    const old = sanitizeAutoCheckin({ enabled: true, lastDate: '2026-10-01', lastResult: '2 个渠道：1 个账号领取成功' })
    expect(old).toMatchObject({ enabled: true, lastDate: '2026-10-01', lastAt: 0, dismissedRunAt: 0 })
    expect(old.channels).toEqual([])
  })

  it('逐渠道结果与 dismiss 标记的归一化（脏数据不撑大文档）', () => {
    const doc = sanitizeAutoCheckin({
      enabled: true,
      lastAt: 1234,
      dismissedRunAt: 1234,
      channels: [
        { provider: 'buddy', text: '2 个 +800积分' },
        { provider: '', text: 'x' }, // 无 provider → 丢弃
        { provider: 'qoder' }, // 无 text → 丢弃
        'not-an-object',
        { provider: 'cline', text: 'y'.repeat(500) }, // 超长 → 截断
      ],
    })
    expect(doc.channels).toEqual([
      { provider: 'buddy', text: '2 个 +800积分' },
      { provider: 'cline', text: 'y'.repeat(120) },
    ])
    expect(doc.dismissedRunAt).toBe(1234)
    // 非法时间戳回落 0
    expect(sanitizeAutoCheckin({ lastAt: -5, dismissedRunAt: 'x' })).toMatchObject({ lastAt: 0, dismissedRunAt: 0 })
  })

  it('lastDate 必须是 YYYY-MM-DD，否则回落空串（脏数据不该让当天被判为已跑）', () => {
    expect(sanitizeAutoCheckin({ lastDate: '2026-10-02' }).lastDate).toBe('2026-10-02')
    expect(sanitizeAutoCheckin({ lastDate: '2026/10/02' }).lastDate).toBe('')
    expect(sanitizeAutoCheckin({ lastDate: 20261002 }).lastDate).toBe('')
    expect(sanitizeAutoCheckin({ lastDate: '' }).lastDate).toBe('')
  })

  it('延迟配置：0 是合法值（不能被 || 吃掉），非法值回落默认', () => {
    expect(autoCheckinDelayMs({})).toBe(AUTO_CHECKIN_DELAY_MS)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '0' })).toBe(0)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '1500' })).toBe(1500)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '-1' })).toBe(AUTO_CHECKIN_DELAY_MS)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: 'abc' })).toBe(AUTO_CHECKIN_DELAY_MS)
  })
})

describe('自动签到：执行判据', () => {
  it('开关关闭时一个请求都不发，也不写盘', async () => {
    const { runner, calls, store } = makeRunner({ initial: { enabled: false } })
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.saves).toEqual([])
    expect(runner.state()).toMatchObject({ enabled: false, ranToday: false, running: false })
  })

  it('跑过之后：遍历全部有账号的渠道，写盘一次，状态变「今天已跑」', async () => {
    const { runner, calls, store } = makeRunner({
      claim: async (provider) => {
        calls.push(provider)
        return ok({ claimed: 2, totalCredit: 300 })
      },
    })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
    expect(store.saves).toHaveLength(1)
    expect(store.current()).toMatchObject({ lastDate: '2026-10-02', enabled: true })
    expect(store.current().lastResult).toContain('2 个渠道')
    expect(runner.state()).toMatchObject({ ranToday: true, running: false })
    // 同一天再跑：一次请求都不发（用户要求「不多次重复触发」）
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.saves).toHaveLength(1)
  })

  it('换到第二天会重新跑（lastDate 不等于今天）', async () => {
    const time = clock(NOON_UTC8)
    const { runner, calls } = makeRunner({ now: time.now, initial: { lastDate: '2026-10-01' } })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('「不支持每日签到」计为跳过，不算失败、不重试', async () => {
    const { runner, calls, warnings } = makeRunner({
      providers: ['buddy', 'cline', 'raccoon', 'workbuddy', 'qoder'],
      claim: async (provider) => {
        calls.push(provider)
        if (provider === 'cline' || provider === 'raccoon') return unsupported()
        if (provider === 'workbuddy') return unsupported('WorkBuddy 国际版不支持每日签到（其后端没有签到接口）')
        return ok({ alreadyClaimed: 1 })
      },
    })
    await runner.runIfDue()
    const state = runner.state()
    expect(calls).toHaveLength(5)
    // 跳过 3 个、正常 2 个；摘要里明说跳过的数量，且不出现「失败」
    expect(state.lastResult).toContain('3 个渠道不支持签到')
    expect(state.lastResult).not.toContain('失败')
    expect(warnings.some((w) => w.includes('不支持每日签到'))).toBe(false)
  })

  it('整轮零成功零已领 ⇒ 不记「今天」（下次启动重试）', async () => {
    const { runner, store, warnings } = makeRunner({
      claim: async () => ({ ok: false, error: { code: 'unauthorized', message: '凭据已过期' } }),
    })
    await runner.runIfDue()
    expect(store.saves).toEqual([])
    expect(runner.state().ranToday).toBe(false)
    expect(warnings.some((w) => w.includes('未记入今日'))).toBe(true)
  })

  it('有成功也有失败 ⇒ 记账（否则一个坏账号会让好账号每次启动都被重领）', async () => {
    const { runner, store } = makeRunner({
      providers: ['buddy', 'qoder'],
      claim: async (provider) => provider === 'buddy'
        ? ok({ claimed: 1, totalCredit: 100 })
        : { ok: false, error: { code: 'unauthorized', message: '凭据已过期' } },
    })
    await runner.runIfDue()
    expect(store.saves).toHaveLength(1)
    expect(runner.state().lastResult).toContain('1 个渠道出错')
  })

  it('账号池读不出来 ⇒ 不记账（不把「读不到」当成「今天跑过了」）', async () => {
    const store = memoryStore({ enabled: true })
    const warnings: string[] = []
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => { throw new Error('store broken') },
      claim: async () => ok({ claimed: 1 }),
      now: () => NOON_UTC8,
      warn: (m) => warnings.push(m),
    })
    await runner.runIfDue()
    expect(store.saves).toEqual([])
    expect(warnings.some((w) => w.includes('读取账号池失败'))).toBe(true)
  })

  it('在飞去重：并发调用只跑一轮', async () => {
    let claimCalls = 0
    const { runner } = makeRunner({
      providers: ['buddy'],
      claim: async () => {
        claimCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return ok({ claimed: 1 })
      },
    })
    await Promise.all([runner.runIfDue(), runner.runIfDue(), runner.runIfDue()])
    expect(claimCalls).toBe(1)
  })
})

describe('自动签到：开关与启动排定', () => {
  it('打开开关会立刻尝试一轮（今天没跑过），且 running 立刻为 true', async () => {
    const { runner, calls } = makeRunner({ initial: { enabled: false } })
    const state = await runner.setEnabled(true)
    expect(state.enabled).toBe(true)
    // runIfDue 在 setEnabled 内被同步启动 ⇒ 这一瞬间 running 已为 true
    expect(state.running).toBe(true)
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('今天已跑过时打开开关不会重跑', async () => {
    const { runner, calls } = makeRunner({ initial: { enabled: false, lastDate: '2026-10-02' } })
    const state = await runner.setEnabled(true)
    expect(state).toMatchObject({ enabled: true, ranToday: true, running: false })
    await runner.runIfDue()
    expect(calls).toEqual([])
  })

  it('关闭开关不触发任何请求，但保留当日记录（避免关一下又开就重跑）', async () => {
    const { runner, calls, store } = makeRunner({ initial: { enabled: true, lastDate: '2026-10-02' } })
    const state = await runner.setEnabled(false)
    expect(state).toMatchObject({ enabled: false, ranToday: true })
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.current().lastDate).toBe('2026-10-02')
  })

  it('start() 按延迟排定一次；stop() 能取消', async () => {
    const { runner, scheduled, calls } = makeRunner({ delayMs: 30_000 })
    runner.start()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(30_000)
    runner.stop()
    expect(scheduled[0]!.cancelled).toBe(true)
    expect(calls).toEqual([])
  })

  it('延迟为 0 时立刻跑（不经过调度器）', async () => {
    const { runner, scheduled, calls } = makeRunner({ delayMs: 0 })
    runner.start()
    expect(scheduled).toEqual([])
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('start() 被重复调用只排定一次（插件热替换时不该叠加定时器）', () => {
    const { runner, scheduled } = makeRunner({ delayMs: 1_000 })
    runner.start()
    runner.start()
    expect(scheduled).toHaveLength(1)
  })
})

/**
 * 「常驻状态文字 + 手动关闭」的行为回归（用户 2026-10-02 第三轮要求）。
 *
 * 关键语义（写错就会变成「关一次以后再也看不到」或「关不掉」）：
 * - 状态文字**不自动消失**，由用户点文字上方的小叉关闭；
 * - 关闭记的是**这一轮**（`lastAt`）⇒ 下一轮跑出新结果时它**重新出现**；
 * - 逐渠道结果要能列出每个渠道的简短状态。
 */
describe('自动签到：常驻状态文字与手动关闭', () => {
  it('跑完记录逐渠道结果与时刻，且默认未关闭', async () => {
    const { runner, store } = makeRunner({
      providers: ['buddy', 'cline', 'qoder'],
      claim: async (provider) => {
        if (provider === 'cline') return unsupported()
        if (provider === 'buddy') return ok({ claimed: 2, totalCredit: 800 })
        return ok({ alreadyClaimed: 1 })
      },
    })
    await runner.runIfDue()
    const state = runner.state()
    expect(state.channels).toEqual([
      { provider: 'buddy', text: '2 个 +800积分' },
      { provider: 'cline', text: '无签到接口' },
      { provider: 'qoder', text: '1 个今天已领' },
    ])
    expect(state.lastAt).toBe(NOON_UTC8)
    expect(state.dismissed).toBe(false)
    // 逐渠道文本要落盘（重启后仍能看到上次各渠道状态）
    expect(store.current().channels).toHaveLength(3)
  })

  it('dismiss() 只关掉**当前这一轮**：下一轮结果会重新出现', async () => {
    const time = clock(NOON_UTC8)
    const { runner } = makeRunner({ now: time.now, providers: ['buddy'] })
    await runner.runIfDue()
    expect(runner.state().dismissed).toBe(false)

    const afterDismiss = await runner.dismiss()
    expect(afterDismiss.dismissed).toBe(true)

    // 换到第二天再跑一轮 ⇒ lastAt 变了，关闭标记失效，文字自动回来
    time.set(NOON_UTC8 + 86_400_000)
    await runner.runIfDue()
    expect(runner.state().dismissed).toBe(false)
  })

  it('从未跑过时 dismiss 不产生「已关闭」的假状态', async () => {
    const { runner } = makeRunner({ initial: { enabled: false } })
    const state = await runner.dismiss()
    // lastAt 为 0 ⇒ 没有可关闭的那一轮，不该显示成 dismissed（否则会永远看不到第一次结果）
    expect(state.dismissed).toBe(false)
  })

  it('describeChannel 逐渠道短文案（不含渠道名，展示层补）', () => {
    // ★ 单位感知（2026-10-04）：积分渠道现在也带上单位名（`+800积分`）。
    //   改动前是裸数字 `+800` —— 那让 ZCode 的 `+100000000` 完全看不出单位，
    //   正是用户报障的核心。带上单位后两个渠道的形态一致、可互相区分。
    expect(describeChannel({ claimed: 2, totalCredit: 800, alreadyClaimed: 0, inactive: 0, failed: 0 })).toBe('2 个 +800积分')
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 3, inactive: 0, failed: 0 })).toBe('3 个今天已领')
    // ⚠️「领到但 +0 分」不能说成「已领」：会和 alreadyClaimed 撞词，看不出这次有没有动作
    expect(describeChannel({ claimed: 1, totalCredit: 0, alreadyClaimed: 1, inactive: 0, failed: 1 }))
      .toBe('1 个领取成功，1 个今天已领，1 个失败')
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 2, failed: 0 })).toBe('2 个未开启')
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0 })).toBe('无可领')
  })

  /**
   * ★ 用户报障（2026-10-04）：「Zcode 获得的是 token 数量，但是这里显示成获得积分」。
   *
   * 报障原文给的期望文案是 `+100Mtoken`（逐渠道）/ `+100Mtoken, +100积分`（汇总）。
   * 这两条锁死那个形态 —— 它是本缺陷的**验收判据**，不是描述。
   */
  it('★ ZCode 的 token 按 token 报，不冒充积分（用户报障的核心）', () => {
    const zcode = { claimed: 1, totalCredit: 100_000_000, alreadyClaimed: 0, inactive: 0, failed: 0 }
    // ① 逐渠道：1 亿 token 必须压成 `100.00M` 并标 Token
    expect(describeChannel({ ...zcode, totalByUnit: { token: 100_000_000, credit: 0 } }))
      .toBe('1 个 +100.00MToken')
    // ② 汇总：token 与积分**分列**，不做跨单位求和
    expect(describeRun({
      providers: 2, claimed: 2, totalCredit: 100_000_100, totalByUnit: { token: 100_000_000, credit: 100 },
      alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 2,
    })).toBe('2 个渠道：2 个账号领取成功（+100.00MToken, +100积分）')  })

  it('★ 缺 totalByUnit 的旧响应回落到「按积分」（不误伤旧宿主）', () => {
    // 旧宿主只回 totalCredit ⇒ 行为与改动前一致，只是多了单位名。
    expect(describeChannel({ claimed: 1, totalCredit: 300, alreadyClaimed: 0, inactive: 0, failed: 0 }))
      .toBe('1 个 +300积分')
    expect(describeRun({
      providers: 1, claimed: 1, totalCredit: 300, alreadyClaimed: 0,
      inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 1,
    })).toBe('1 个渠道：1 个账号领取成功（+300积分）')
  })
})

describe('自动签到：摘要与判据的纯函数', () => {
  it('isUnsupportedCheckin 只认两个窄短语', () => {
    expect(isUnsupportedCheckin('Cline 不支持每日签到（其后端没有签到接口）')).toBe(true)
    expect(isUnsupportedCheckin('unsupported provider: foo')).toBe(true)
    // 反面：真正的错误不能被吞掉
    expect(isUnsupportedCheckin('凭据已过期')).toBe(false)
    expect(isUnsupportedCheckin('unsupported reasoning effort')).toBe(false)
  })

  it('describeRun 汇总各计数；无内容时给可读文案', () => {
    expect(describeRun({
      providers: 3, claimed: 2, totalCredit: 300, alreadyClaimed: 1, inactive: 0, failed: 0, skipped: 1, errors: 0, coversToday: 3,
    })).toBe('3 个渠道：2 个账号领取成功（+300积分），1 个今天已领，1 个渠道不支持签到')
    expect(describeRun({
      providers: 2, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 0,
    })).toBe('2 个渠道：没有需要领取的账号')
  })

  it('shouldMarkToday：只看「能证明今天已被处理」的条数（`coversToday`）', () => {
    const base = {
      providers: 1, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 0,
    }
    expect(shouldMarkToday({ ...base, coversToday: 1 })).toBe(true)
    expect(shouldMarkToday({ ...base, claimed: 1, coversToday: 1 })).toBe(true)
    expect(shouldMarkToday({ ...base, alreadyClaimed: 1, coversToday: 1 })).toBe(true)
    expect(shouldMarkToday({ ...base, failed: 2 })).toBe(false)
    expect(shouldMarkToday({ ...base, errors: 1 })).toBe(false)
    expect(shouldMarkToday(base)).toBe(false)
  })

  /**
   * ⚠️⚠️ **真实缺陷回归（2026-10-02 审查 PR !33 定位）**：`claimed` / `alreadyClaimed`
   * 为正但 `coversToday` 为 0 时**不得**记账。
   *
   * 场景：Qoder 活动每日 10:00（UTC+8）才刷新。上午 9 点那轮看到的是**昨天**
   * 那条 `CLAIMED`（`alreadyClaimed:1, coversToday:0`）。修复前按
   * `claimed + alreadyClaimed` 记账 ⇒ 当天新额度**整天不会再被领**，而面板
   * 还显示「1 个今天已领」，用户毫无提示。
   */
  it('只有「非今日轮次」的痕迹时 ⇒ 不记账（否则当天刷新后的额度整天漏领）', () => {
    const base = { providers: 1, totalCredit: 0, inactive: 0, failed: 0, skipped: 0, errors: 0 }
    expect(shouldMarkToday({ ...base, claimed: 0, alreadyClaimed: 1, coversToday: 0 })).toBe(false)
    expect(shouldMarkToday({ ...base, claimed: 1, totalCredit: 100, alreadyClaimed: 0, coversToday: 0 })).toBe(false)
  })

  it('describeChannel 会标出「非今日轮次」，不把昨天的痕迹说成「今天已领」', () => {
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 1, inactive: 0, failed: 0, coversToday: 0 }))
      .toBe('1 个今天已领，非今日轮次')
    // 缺 coversToday（旧响应）时按 claimed+alreadyClaimed 兜底，行为不变
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 3, inactive: 0, failed: 0 }))
      .toBe('3 个今天已领')
  })

  /**
   * ⚠️ **B1 端到端**：整轮只有 Qoder 且赶在 10:00 刷新前 → 不写 `lastDate`，
   * 当天还有机会补领（修复前会写，于是 10 点刷新的额度永远领不到）。
   */
  it('端到端：整轮 coversToday=0 ⇒ 不写 lastDate（刷新后还有机会）', async () => {
    const { runner, store, warnings } = makeRunner({
      providers: ['qoder'],
      claim: async () => ok({ alreadyClaimed: 1, coversToday: 0 }),
    })
    await runner.runIfDue()
    expect(store.saves).toEqual([])
    expect(runner.state().ranToday).toBe(false)
    expect(warnings.some((w) => w.includes('未记入今日'))).toBe(true)
  })

  it('端到端：coversToday=1 ⇒ 照常记账（防止把上面那条修成「永不记账」）', async () => {
    const { runner, store } = makeRunner({
      providers: ['qoder'],
      claim: async () => ok({ claimed: 1, totalCredit: 100, coversToday: 1 }),
    })
    await runner.runIfDue()
    expect(store.saves).toHaveLength(1)
    expect(runner.state().ranToday).toBe(true)
  })

  it('旧响应没有 coversToday 字段时回落到 claimed+alreadyClaimed（不误伤旧宿主）', async () => {
    const { runner, store } = makeRunner({
      providers: ['buddy'],
      // 构造一个**没有** coversToday 键的响应（模拟宿主未升级）
      claim: async () => ({ ok: true, value: { results: [], summary: { claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0, failed: 0 } } }),
    })
    await runner.runIfDue()
    expect(store.saves).toHaveLength(1)
  })
})

/**
 * ⚠️ **B2 回归（2026-10-02 审查 PR !33 定位）**：自动签到**不能**碰 zcode。
 *
 * zcode 有签到，但每次领取都要现场产一个阿里云 captcha param（web 版会拉起
 * headful Chromium，约 200–400MB；阿里云按**设备**限流 150 次/小时）。
 * 默认开启的自动签到 + 排除表漏了它 = 用户什么都没点，开 DSH 就起浏览器进程树；
 * 失败时又不写 `lastDate` ⇒ 每次启动都重来。
 *
 * 「等 `claimAll` 返回错误再判定」在这里**来不及** —— 代价发生在调用期间。
 */
describe('自动签到：排除「签到有代价」的渠道', () => {
  it('isAutoCheckinExcluded 只认 zcode（其余渠道照常自动）', () => {
    expect(isAutoCheckinExcluded('zcode')).toBe(true)
    for (const provider of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'minimax']) {
      expect(isAutoCheckinExcluded(provider)).toBe(false)
    }
  })

  it('端到端：zcode **一个上游请求都不发**，只计为跳过', async () => {
    const { runner, calls, store } = makeRunner({
      providers: ['buddy', 'qoder', 'zcode'],
      claim: async (provider) => {
        calls.push(provider)
        return ok({ claimed: 1, totalCredit: 100, coversToday: 1 })
      },
    })
    await runner.runIfDue()
    expect(calls).not.toContain('zcode')
    expect(calls).toEqual(['buddy', 'qoder'])
    const state = runner.state()
    expect(state.channels).toContainEqual({ provider: 'zcode', text: '需手动签到' })
    // 跳过 zcode 不影响其余渠道记账
    expect(state.ranToday).toBe(true)
    expect(store.saves).toHaveLength(1)
  })

  it('只有 zcode 一个渠道时：不记账（跳过不构成「今天跑过」）', async () => {
    const { runner, calls, store } = makeRunner({ providers: ['zcode'] })
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.saves).toEqual([])
    expect(runner.state().ranToday).toBe(false)
  })

  /**
   * ⚠️ **反向守护**：把「自动签到不该碰的渠道」与「claim 分支真的要产 captcha」
   * 两件事**绑在一起**断言。
   *
   * 只测排除表会漏掉一种回归：将来 zcode 的签名变了、或**新增**了一个同样要
   * 产 captcha 的 provider，而没人记得登记。这里锁的不变式是：
   * **会产 captcha 的 claim 分支，必须逐个登记进排除表。**
   *
   * 做法：按 `if (req.provider === X)` 把 `claimAll` 切成一段段，看哪几段里
   * 出现了 `mintCaptcha`。（不用「X 前后 4000 字符」那种窗口 —— 分支体长度
   * 一变就悄悄失配，那正是本仓库反复吃过的那类假绿。）
   */
  it('反向守护：会产 captcha 的 claim 分支必须登记进排除表', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf-8')
    // 只看 `credits.claimAll` 这一段：`req.provider === ZCODE.id` 在余额端点里
    // 也会出现，不按 `case` 边界切就会把两个端点混进来数成两个分支。
    const claimAllAt = source.indexOf("case 'credits.claimAll':")
    expect(claimAllAt).toBeGreaterThan(-1)
    const nextCase = source.indexOf("case '", claimAllAt + 1)
    const claimAll = source.slice(claimAllAt, nextCase === -1 ? undefined : nextCase)
    const heads = [...claimAll.matchAll(/if \(req\.provider === (ZCODE\.id)\)/g)]
    expect(heads.length).toBe(1)
    const body = claimAll.slice(heads[0]!.index)
    // 该分支体取到下一个 provider 分支（或 case 结束）为止
    const nextBranch = body.slice(1).search(/if \(req\.provider === /)
    const branchBody = nextBranch === -1 ? body : body.slice(0, nextBranch + 1)
    expect(branchBody).toContain('mintCaptcha')
    expect(isAutoCheckinExcluded(ZCODE.id)).toBe(true)
  })
})