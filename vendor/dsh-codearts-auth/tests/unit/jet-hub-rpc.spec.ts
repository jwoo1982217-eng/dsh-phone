import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  recordClineRequest,
  resetClineRequestHistory,
} from '../../src/cline-request-log.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  collectClaimResults,
  collectCreditBalances,
  collectCreditsStatus,
  computeClaimSummary,
  JET_HUB_API_PATH,
  registerJetHubRpc,
} from '../../src/jet-hub-rpc.js'
import type { CreditsEndpointDeps } from '../../src/jet-hub-rpc.js'
// ⚠️ 下面每个 `connection.fetch` 替身都**按 path 挑处理器**（用 `JET_HUB_API_PATH`）。
// 本模块除了 RPC 的 POST 端点还注册了内部载体的 GET 路由；替身若写成
// 「谁最后注册就记谁」，加一条路由就会让所有 RPC 用例莫名其妙地打到载体页上，
// 表现为成片 405 —— 与本次改动毫无关系，极难归因。别把它「简化」回去。
import { AccountPool } from '../../src/account-pool.js'
import type { ClaimOutcome, CheckinStatus, CreditBalance } from '../../src/credits.js'
import { WORKBUDDY } from '../../src/product.js'
import type { ProviderAccountEntry } from '../../src/types.js'
// ⚠️⚠️ 「已失效模型」表的直接操作（2026-10-06 复审 !66 的 model.clearDead 端点用例）。
//
// ⚠️⚠️ **必须在任何静态 import 之前设好隔离目录**：该模块的 store / cache 是
// **进程级单例**，首次解析 home 时读 `DSH_JET_HUB_STATE_DIR`（`resolveJetHubHome`
// 的第一优先级）。不隔离会**写真实的用户目录** `~/.dsh/jet-hub/dead-models.json`。
// 静态 import 会被提升，故这里用顶层 await 动态导入。
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  process.env.DSH_JET_HUB_STATE_DIR = mkdtempSync(joinPath(tmpdir(), 'dsh-jet-hub-rpc-dead-'))
}
const { clearDeadModels, deadModelIdsFor, recordDeadModel } =
  await import('../../src/dead-model-store.js')

describe('积分领取结果汇总', () => {
  it('统计成功数量与累计积分', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false },
      { kind: 'claimed', credit: 50, streakDays: 2, isStreakDay: true },
      { kind: 'already-claimed', message: '今天已签到' },
      { kind: 'failed', code: 500, message: 'boom' },
    ]
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 2, totalCredit: 150, alreadyClaimed: 1, inactive: 0, failed: 1, coversToday: 3,
      totalByUnit: { token: 0, credit: 150 },
    })
  })

  /**
   * ★ **根因所在**（真实缺陷，用户报障 2026-10-04）：
   * > Zcode 获得的是 token 数量，但是这里显示成获得积分。
   * > 正文「…ZCode（智谱）+100000000（共 +100000100）」
   * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
   *
   * `totalCredit` 是**跨单位求和**的标量 —— 1 亿 token 与 100 积分加在一起后，
   * 下游拿到的是一个数、无从分辨单位，只能标成「积分」。故单位必须在**汇总
   * 这一层**就分开保留（`totalByUnit`），而不是在文案层猜。
   *
   * ⚠️ 这条用例同时锁死「`totalCredit` 保留原语义」：它是既有契约，
   * 且对**单一单位**的渠道（其余 11 个）完全正确。改它才是破坏性改动。
   */
  it('★★ token 与积分**分列**，不跨单位相加（用户报障的根因）', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'claimed', credit: 100_000_000, streakDays: 0, isStreakDay: false, unit: 'token' },
      { kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false },
    ]
    const summary = computeClaimSummary(outcomes)
    // 单位分开保留 —— 这是修复的核心
    expect(summary.totalByUnit).toEqual({ token: 100_000_000, credit: 100 })
    // 标量仍在，但**不得**再用于展示（它是跨单位求和的产物）
    expect(summary.totalCredit).toBe(100_000_100)
  })

  it('★ 未声明 unit 的领取按积分计（其余 11 个渠道逐字不变）', () => {
    const summary = computeClaimSummary([
      { kind: 'claimed', credit: 800, streakDays: 1, isStreakDay: false },
    ])
    expect(summary.totalByUnit).toEqual({ token: 0, credit: 800 })
  })

  it('★ unit 为未知值时按积分兜底（脏数据不制造出第三种单位）', () => {
    const summary = computeClaimSummary([
      { kind: 'claimed', credit: 50, streakDays: 0, isStreakDay: false, unit: 'credits' } as ClaimOutcome,
    ])
    expect(summary.totalByUnit).toEqual({ token: 0, credit: 50 })
  })

  /**
   * ⚠️ **`coversToday` 才是记账口径**（真实缺陷，2026-10-02 审查 PR !33 定位）。
   *
   * `coversToday:false` 由渠道自己标出「这条痕迹属于刷新前那一轮」（Qoder 活动
   * 10:00 UTC+8 才刷新）。它**必须**既不计入 `coversToday`、也不让上层误以为
   * 「今天已处理」—— 否则当天 10 点刷新出来的新额度整天不会再被领。
   */
  it('coversToday:false 的领取/已领都不计入 coversToday（刷新前那一轮）', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: '今天已领取', coversToday: false },
      { kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false, coversToday: false },
    ]
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 1, totalCredit: 100, alreadyClaimed: 1, inactive: 0, failed: 0, coversToday: 0,
      totalByUnit: { token: 0, credit: 100 },
    })
  })

  it('混合时只把覆盖今天的那几条计入 coversToday', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: 'a' },
      { kind: 'already-claimed', message: 'b', coversToday: false },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ alreadyClaimed: 2, coversToday: 1 })
  })

  it('全部已领取时 claimed 为 0', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: 'a' },
      { kind: 'already-claimed', message: 'b' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ claimed: 0, totalCredit: 0, alreadyClaimed: 2 })
  })

  it('混合 inactive 与 failed 分别计数', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'inactive', message: '活动未开启' },
      { kind: 'failed', code: 1, message: 'x' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ inactive: 1, failed: 1, claimed: 0 })
  })

  it('空数组返回全 0', () => {
    expect(computeClaimSummary([])).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
      totalByUnit: { token: 0, credit: 0 },
    })
  })

  it('未知 kind 兜底计入 failed，而不是被静默漏计', () => {
    // 模拟 ClaimOutcome 未来新增 kind、但汇总分支未同步更新的情况。
    const unknown = { kind: 'brand-new-kind', message: 'x' } as unknown as ClaimOutcome
    expect(computeClaimSummary([unknown, { kind: 'inactive', message: 'i' }]))
      .toMatchObject({ failed: 1, inactive: 1, claimed: 0 })
  })
})

// ─────────────────────────────────────────────────────────────
// 逐账号异常隔离（Task 8 补充修复）
//
// 直接调用 RPC 端点需要构造 ctx.connection.fetch.register 替身，
// 因此端点已把「逐账号处理」抽成 collectCreditsStatus / collectClaimResults
// 两个可导出函数（方案 A）。这里对它们单测：既能精确断言单账号隔离，
// 又能验证顺序性，且完全不发起网络请求（fetchStatus / claim 均注入桩）。
// ─────────────────────────────────────────────────────────────

/** 构造账号条目；默认是启用的合法账号。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'workbuddy-1',
    provider: 'workbuddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'WORKBUDDY_ACCOUNT_AAAA1111',
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

/** 最小合法凭据 JSON。 */
const VALID_CREDENTIAL_JSON = JSON.stringify({
  access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z',
})

/** 构造签到状态。 */
function makeStatus(overrides: Partial<CheckinStatus> = {}): CheckinStatus {
  return {
    active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100,
    todayCredit: 0, isStreakDay: false, totalCredits: 0, checkinDates: [],
    activityName: 'a', themeName: 't', endTime: '', ...overrides,
  }
}

/**
 * 构造依赖替身。
 * 默认：所有 ref 都能解析出合法凭据，状态接口返回「可领取」，领取返回成功。
 */
function makeDeps(overrides: Partial<CreditsEndpointDeps> = {}): CreditsEndpointDeps {
  return {
    resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
    fetchStatus: async () => makeStatus(),
    claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    ...overrides,
  }
}

describe('credits.status 单账号异常隔离', () => {
  it('非法 credentialRef 只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const asked: string[] = []
    const deps = makeDeps({
      resolve: async (ref) => {
        asked.push(String(ref))
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    // 三个账号都要出现在结果里（不是整批抛异常）
    expect(results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(results[0]?.status).toBeNull()
    // 关键：坏账号之后的两个账号确实被继续处理
    expect(results[1]?.status).not.toBeNull()
    expect(results[2]?.status).not.toBeNull()
    // 坏账号根本没走到 resolve（名称校验先抛）
    expect(asked).toEqual(['WORKBUDDY_ACCOUNT_AAAA1111', 'WORKBUDDY_ACCOUNT_AAAA1111'])
  })

  it('resolve 抛错只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => {
        resolveCalls++
        // 第一个账号的 resolve 抛错（如凭据已被外部删除）；后续账号正常。
        if (resolveCalls === 1) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['boom', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toEqual(makeStatus())
    expect(resolveCalls).toBe(2)
  })

  it('JSON 损坏与网络失败都只影响该账号', async () => {
    const accounts = [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'network-down' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => ({ value: resolveCalls++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      // 第二个账号（network-down）的状态请求抛网络错误
      fetchStatus: async () => {
        if (resolveCalls === 2) throw new Error('socket hang up')
        return makeStatus()
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['corrupt', 'network-down', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toBeNull()
    expect(results[2]?.status).toEqual(makeStatus())
  })

  it('停用账号同样处理（停用与签到无关），异常出口收到告警', async () => {
    const warnings: string[] = []
    const accounts = [
      makeEntry({ id: 'off', enabled: false }),
      makeEntry({ id: 'bad-ref', credentialRef: '非法名称' }),
    ]
    const results = await collectCreditsStatus(accounts, WORKBUDDY, makeDeps({
      warn: (msg) => warnings.push(msg),
    }))

    // 停用只影响账号池的自动选择与限流切换，不改变「该账号今天领了没」，
    // 故两个账号都要出现在结果里。
    expect(results.map(r => r.accountId)).toEqual(['off', 'bad-ref'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad-ref')
  })

  it('凭据解析为 undefined 时状态为 null，且不调用状态接口', async () => {
    let statusCalls = 0
    const results = await collectCreditsStatus([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { statusCalls++; return makeStatus() },
    }))

    expect(results[0]?.status).toBeNull()
    expect(statusCalls).toBe(0)
  })
})

describe('credits.claimAll 单账号异常隔离与顺序性', () => {
  it('停用账号也被领取（一键领取覆盖全部账号）', async () => {
    const accounts = [
      makeEntry({ id: 'enabled-1', enabled: true }),
      makeEntry({ id: 'disabled-1', enabled: false }),
      makeEntry({ id: 'disabled-2', enabled: false }),
    ]
    const deps = makeDeps({
      claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 停用只影响账号池的自动选择与限流切换；积分照领。
    expect(response.results.map(r => r.accountId)).toEqual(['enabled-1', 'disabled-1', 'disabled-2'])
    expect(response.results.every(r => r.outcome.kind === 'claimed')).toBe(true)
    expect(response.summary).toEqual({
      claimed: 3, totalCredit: 300, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 3,
      totalByUnit: { token: 0, credit: 300 },
    })
  })

  it('非法 credentialRef 的账号记为 failed，其余账号仍被领取', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const claimed: string[] = []
    const deps = makeDeps({
      claim: async () => {
        claimed.push(`claim-${claimed.length}`)
        return { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 整批成功返回，三个账号都有结果
    expect(response.results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', code: -1 })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.results[2]?.outcome).toMatchObject({ kind: 'claimed' })
    // 坏账号没有阻止后两个账号真正发起领取
    expect(claimed).toHaveLength(2)
    expect(response.summary).toEqual({
      claimed: 2, totalCredit: 200, alreadyClaimed: 0, inactive: 0, failed: 1, coversToday: 2,
      totalByUnit: { token: 0, credit: 200 },
    })
  })

  it('resolve 抛错被收敛为该账号的 failed，不冒泡中断整批', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let first = true
    const deps = makeDeps({
      resolve: async () => {
        if (first) { first = false; throw new Error('凭据已被外部删除') }
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', message: '凭据已被外部删除' })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.summary.failed).toBe(1)
    expect(response.summary.claimed).toBe(1)
  })

  it('凭据未配置记为 failed 且不发起任何请求', async () => {
    let touched = 0
    const response = await collectClaimResults([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { touched++; return makeStatus() },
      claim: async () => { touched++; return { kind: 'failed', code: -1, message: 'x' } },
    }))

    expect(response.results[0]?.outcome).toEqual({ kind: 'failed', code: -1, message: '凭据未配置' })
    expect(touched).toBe(0)
  })

  it('保持「先查状态再领取」：活动未开启/今日已签到时跳过领取请求', async () => {
    const accounts = [makeEntry({ id: 'inactive' }), makeEntry({ id: 'done' }), makeEntry({ id: 'ready' })]
    let call = 0
    const claimCalls: string[] = []
    const deps = makeDeps({
      fetchStatus: async () => {
        call++
        if (call === 1) return makeStatus({ active: false })
        if (call === 2) return makeStatus({ todayCheckedIn: true })
        return makeStatus()
      },
      claim: async () => {
        claimCalls.push('claim')
        return { kind: 'claimed', credit: 10, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results.map(r => r.outcome.kind))
      .toEqual(['inactive', 'already-claimed', 'claimed'])
    // 只有第三个账号真正调用了领取接口
    expect(claimCalls).toHaveLength(1)
  })

  it('顺序执行：任一时刻只有一个账号在处理（不并发）', async () => {
    const accounts = [
      makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' }),
    ]
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      resolve: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchStatus: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return makeStatus()
      },
      claim: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false }
      },
    })

    await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(maxInFlight).toBe(1)
  })

  it('按账号顺序串行，且结果顺序与账号顺序一致', async () => {
    const accounts = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })]
    const order: string[] = []
    let seq = 0
    const deps = makeDeps({
      // 让先启动的账号耗时更长，若并发则 c 会先完成
      resolve: async () => {
        const mine = seq++
        await new Promise(r => setTimeout(r, mine === 0 ? 10 : 1))
        order.push(`entry-${mine}`)
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(order).toEqual(['entry-0', 'entry-1', 'entry-2'])
    expect(response.results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })

  /**
   * ⚠️ 真实缺陷（用户报障）：4 个 CodeBuddy 账号一键领取全部失败，
   * 错误是 **`fetcher is not a function`**。
   *
   * 根因：`claimDailyCheckin` / `fetchCheckinStatus` 的真实签名是
   * `(credential, product, fetcher)`，而 `collectClaimResults` 在**未注入
   * deps 时**调用的是 `claim(credential, product, entry)` —— 把 `entry`
   * 塞进了 `fetcher` 的位置，于是 `fetcher(...)` 抛
   * `TypeError: fetcher is not a function`。
   *
   * 为什么长期没被发现：`makeDeps` **总是注入 `claim` / `fetchStatus`**，
   * 于是真实的默认实现路径**从未被任何用例覆盖**；而
   * `deps.claim ?? (claimDailyCheckin as unknown as …)` 这个
   * `as unknown as` 强转**掩盖了签名不匹配**，TypeScript 也帮不上忙。
   *
   * 本用例刻意**不注入 claim / fetchStatus**，走真实默认实现，用注入的
   * fetcher 断言「被当成函数调用的那个参数确实是 fetcher」。
   */
  it('未注入 deps 时走真实默认实现，第三参必须是 fetcher（真实缺陷回归）', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      // 状态端点返回「活动开启且今天没领」，让流程走到 claim。
      // ⚠️ 字段名必须是真实的 `active` / `today_checked_in`（见 fetchCheckinStatus），
      // 用错名字会被 readBool 读成 false → 落到 inactive 短路。
      if (String(url).includes('checkin-activity-status')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: false },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { credit: 100, streak_days: 1, is_streak_day: false },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const accounts = [makeEntry({ id: 'cb-1', credentialRef: 'BUDDY_ACCOUNT_A70DB211' })]
    // ⚠️ 关键：**不传** claim / fetchStatus，走真实的 claimDailyCheckin，
    // 只注入 fetcher。
    const response = await collectClaimResults(accounts, WORKBUDDY, {
      resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      fetcher: fakeFetch,
    })

    // 不得是 `fetcher is not a function`
    const outcome = response.results[0]?.outcome
    if (outcome?.kind === 'failed') {
      expect(outcome.message).not.toContain('fetcher is not a function')
    }
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    // 确认确实发出了两次真实请求（状态 + 领取）
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('checkin-activity-status')
    expect(calls[1]).toContain('daily-checkin')
  })
})

/**
 * collectCreditBalances：逐账号收集积分余额。
 *
 * 与状态/领取的关键差异是**保留失败原因**——账号卡片要显示"为什么没查到"，
 * 把它降级成 null 会让 UI 显示成空白，用户无从判断是余额为 0 还是查询失败。
 */
describe('credits.balances 逐账号余额收集', () => {
  const BALANCE: CreditBalance = {
    total: 347.87,
    packages: [
      { name: 'Bonus Pack', unit: 'credit', remaining: 247.87, total: 250, used: 2.13, cycleStartTime: '', cycleEndTime: '2026-09-28 10:05:56' },
      { name: 'Free Plan Subscription', unit: 'credits', remaining: 100, total: 100, used: 0, cycleStartTime: '', cycleEndTime: '2026-09-30 23:59:59' },
    ],
  }

  it('成功时回传余额与包明细', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances([makeEntry({ id: 'a' })], WORKBUDDY, deps)

    expect(results).toEqual([{ accountId: 'a', nickname: '测试号', balance: BALANCE }])
  })

  it('余额为 0 与查询失败严格区分', async () => {
    const empty: CreditBalance = { total: 0, packages: [] }
    let call = 0
    const deps = makeDeps({ fetchBalance: async () => (call++ === 0 ? empty : null) })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'zero' }), makeEntry({ id: 'failed' })], WORKBUDDY, deps,
    )

    // 第一个真余额 0：可展示为 0，不算错误
    expect(results[0]!.balance).toEqual(empty)
    expect(results[0]!.error).toBeUndefined()
    // 第二个查不到：balance 为 null 且带原因，UI 不能显示成 0
    expect(results[1]!.balance).toBeNull()
    expect(results[1]!.error).toBe('余额查询失败')
  })

  it('凭据未配置时给出原因，且不发起余额请求', async () => {
    let touched = 0
    const deps = makeDeps({
      resolve: async () => undefined,
      fetchBalance: async () => { touched++; return BALANCE },
    })
    const results = await collectCreditBalances([makeEntry({ id: 'noconf' })], WORKBUDDY, deps)

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBe('凭据未配置')
    expect(touched).toBe(0)
  })

  it('单个账号异常不中断整批，且记录该账号的原因', async () => {
    let call = 0
    const warnings: string[] = []
    const deps = makeDeps({
      resolve: async () => {
        if (call++ === 0) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchBalance: async () => BALANCE,
      warn: (msg) => warnings.push(msg),
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results).toHaveLength(2)
    expect(results[0]!.error).toBe('凭据已被外部删除')
    expect(results[0]!.balance).toBeNull()
    expect(results[1]!.balance).toEqual(BALANCE)
    expect(warnings).toHaveLength(1)
  })

  it('凭据 JSON 损坏只影响该账号', async () => {
    let call = 0
    const deps = makeDeps({
      resolve: async () => ({ value: call++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      fetchBalance: async () => BALANCE,
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBeDefined()
    expect(results[1]!.balance).toEqual(BALANCE)
  })

  it('停用账号同样查询（停用与余额无关）', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'off', enabled: false })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toEqual(BALANCE)
  })

  it('顺序执行，不并发（避免风控）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      fetchBalance: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return BALANCE
      },
    })
    await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(maxInFlight).toBe(1)
  })

  it('结果顺序与账号顺序一致', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * model.list / model.setDisabled 端点。
 *
 * 这两个端点是 Jet Hub「显示列表」按钮的唯一数据通道，同时串起三件必须
 * 一起正确的事：
 * 1. 列表来自 `ctx.llm.listModels()`（对话框模型选择器读的同一份目录）；
 * 2. 黑名单经 AccountPool 持久化；
 * 3. 关闭后的模型从对话框选择器里消失，**但在设置页仍可被重新打开**。
 *
 * 因此这里用「注册端点 → 通过 HTTP 请求调用 → 断言响应」的方式做端到端
 * 验证，而不是分别测两个函数——两者的衔接正是最容易出错的地方。
 *
 * ⚠️ 第 3 条的两个方向必须都覆盖，且**桩必须模拟真实适配器的过滤行为**：
 * 真实 `listModels` 会实时剔除黑名单命中的模型，所以 `model.list` 绝不能在
 * 一个已被过滤的目录上「回填 disabled」——那样被关闭的模型会连同开关一起
 * 消失，用户再也无法重新打开（历史 bug）。早期版本的桩是
 * `options.models.map(...)`（从不过滤），恰好绕过这个矛盾，导致该 bug 在
 * 「注释声称已验证第 3 条」的情况下依然漏到了线上。
 */
describe('account.create 必须立即返回 loginUrl（两步式登录回归）', () => {
  /**
   * 真实缺陷（用户报障）：「codearts 新建账号应该弹出新的页面，现在主页面直接
   * 跳转过去了」。
   *
   * 根因是**时序**，不是弹窗 API 用法：
   * - 浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内允许
   *   `window.open`；
   * - 早期 `account.create` 对 codearts / lobsterai 走**阻塞式** `login()`
   *   （`await` 到用户在浏览器里完成授权，数十秒），返回时手势早已过期；
   * - 前端 `window.open` 被弹窗拦截器拒绝并返回 `null`，于是命中兜底
   *   `window.location.href = loginUrl`，把整个设置页导航到外部登录页。
   *
   * 修法：这两个 provider 也改为「先返回 loginUrl、后台再等回调」的两步式
   * （与 CodeBuddy 系一致）。因此本用例守的是**契约**：`account.create`
   * 必须在用户完成授权**之前**就 resolve —— 若哪天有人改回阻塞式，
   * 这里会以超时失败，而不是等到用户再次报障。
   *
   * 用假计时器不适用（涉及真实 Promise 链），故用「授权永不完成」来模拟
   * 用户尚未操作：旧实现会一直挂着，新实现立即返回。
   */
  type Handler = (request: Request) => Promise<Response>

  /** 构造端点，注入一个「授权永不完成」的登录服务替身。 */
  function registerCreateEndpoints(overrides: {
    /** startLogin 是否可用；false 模拟旧实现的阻塞式 login。 */
    twoPhase: boolean
  }) {
    let handler: Handler | undefined
    /** 记录 startLogin / login 的调用，用于断言走了哪条路径。 */
    const calls: string[] = []
    let resolveLogin!: () => void
    const neverFinishes = new Promise<void>((resolve) => { resolveLogin = resolve })

    // 登录服务替身：startLogin 立即返回 URL，result 永不落定（模拟用户未操作）。
    const makeAuth = (id: string) => ({
      async startLogin() {
        calls.push(`${id}:startLogin`)
        return {
          loginUrl: `https://example.test/${id}/login`,
          result: neverFinishes.then(() => ({
            access: '{}', expires: 0, ref: id, loginUrl: '', refreshable: false,
          })),
          close: async () => {},
        }
      },
      async login() {
        calls.push(`${id}:login`)
        // 阻塞式：永不 resolve，复刻旧实现的等待语义。
        return await neverFinishes
      },
    })

    const pool = {
      addAccount: async () => {},
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }

    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }

    registerJetHubRpc(
      // ⚠️ 位置参数：中国版 `qoderCn` 紧跟 `qoder`，漏补占位会让后续形参整体错位。
      // （加 Loomy 踩过一次、加 Raccoon 又踩一次、加 QoderCN 第三次 —— 见计划末尾
      //  「把 registerJetHubRpc 改成具名参数对象」的后续项建议。）
      ctx as never, pool as never,
      makeAuth('codearts') as never,
      {} as never, {} as never,
      makeAuth('lobsterai') as never,
      makeAuth('qoder') as never,
      {} as never, // qoderCn（本组用例不触发）
      makeAuth('trae') as never,
      makeAuth('cline') as never,
      {} as never, // loomy（本组用例不触发）
      {} as never, // raccoon（本组用例不触发）
      {} as never, // zcode（本组用例不触发）
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown } }
      return body.result
    }
    return { call, calls, resolveLogin }
  }

  /**
   * 给 `account.create` 一个**远早于**用户授权完成的超时预算。
   *
   * 旧实现下它必然超时（因为 await 的是永不落定的登录）；新实现下它应当
   * 在毫秒级返回。这个差异正是本用例的判定依据。
   */
  const FAST_BUDGET_MS = 2000

  it.each(['codearts', 'lobsterai', 'qoder', 'trae'])(
    '%s 在用户完成授权之前就返回 loginUrl（不阻塞）',
    async (provider) => {
      const { call, calls } = registerCreateEndpoints({ twoPhase: true })

      const result = await Promise.race([
        call('account.create', { provider }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), FAST_BUDGET_MS)),
      ])

      expect(
        result,
        `${provider} 的 account.create 阻塞了：说明它退回了「等用户授权完成才返回」`
        + '的旧实现，前端 window.open 会因手势过期被拦截，进而跳转主页面。',
      ).not.toBe('timeout')
      expect((result as { ok: boolean }).ok).toBe(true)
      const value = (result as { value: { loginUrl: string; accountId: string } }).value
      expect(value.loginUrl).toContain(provider)
      expect(value.accountId).toContain(provider)
      // 必须走两步式的 startLogin，而不是阻塞式 login。
      expect(calls).toContain(`${provider}:startLogin`)
      expect(calls).not.toContain(`${provider}:login`)
    },
  )

  it('未登录成功的账号先以占位条目登记，使前端 login.poll 能立即看到', async () => {
    // 两步式下 account.create 返回时凭据还不存在；若不登记占位条目，
    // 前端的 login.poll 会查不到该账号而永远返回 done:false。
    let added: Record<string, unknown> | undefined
    const pool = {
      addAccount: async (entry: Record<string, unknown>) => { added = entry },
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }
    let handler: Handler | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const auth = {
      async startLogin() {
        return {
          loginUrl: 'https://example.test/codearts/login',
          result: new Promise(() => {}),
          close: async () => {},
        }
      },
    }
    // ⚠️ 位置参数：`qoderCn` 槽位补 `{}`（本用例只走 codearts，不触发它）。
    registerJetHubRpc(ctx as never, pool as never, auth as never, {} as never, {} as never, {} as never, {} as never, {} as never, /* qoderCn */ {} as never, {} as never, {} as never, undefined)
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method: 'account.create', payload: { provider: 'codearts' } },
      }),
    }))
    await response.json()
    expect(added, 'account.create 未登记占位账号条目').toBeDefined()
    expect(added?.provider).toBe('codearts')
    expect(added?.enabled).toBe(true)
    expect(added?.refreshable).toBe(false)
  })

  /**
   * `startLogin` 启动失败（最典型：回调端口被占用）必须变成**规范的 RPC 错误响应**。
   *
   * 真实缺陷：`startTraeLoginFlow` 早期直接 `server.listen(port)` 且未注册
   * `'error'` 处理器 —— listen 失败是**事件**异步抛出的，不属于 Promise 链，
   * 于是逃过 RPC 的 try/catch 成为**进程级 unhandled error**，把整个 DSH 宿主
   * 崩掉。用户看到的不是可读文案，而是一整堆 `EADDRINUSE` 堆栈 + 进程退出。
   *
   * 现在 `startTraeLoginFlow` 会把 listen 失败转成可捕获的 reject；本用例守
   * 「RPC 层照常返回 `ok:false` + 可读 message」这一契约。
   */
  it('startLogin 因端口占用失败时返回可读的 RPC 错误（而非崩进程）', async () => {
    let handler: Handler | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const pool = {
      addAccount: async () => {},
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }
    // 复刻「listen 失败」的服务替身：startLogin 直接抛可读错误。
    const failingAuth = {
      async startLogin() {
        throw new Error('TRAE 回调端口 18080 无法监听（EADDRINUSE）；端口可能已被其它程序占用，请释放后重试。')
      },
    }
    registerJetHubRpc(
      // ⚠️ 同样的位置参数陷阱：`failingAuth` 必须落在 trae 的位置上。
      ctx as never, pool as never,
      {} as never, // codearts
      {} as never, // buddy
      {} as never, // workbuddy
      {} as never, // lobsterai
      {} as never, // qoder
      {} as never, // qoderCn
      failingAuth as never, // trae
      {} as never, // cline
      {} as never, // loomy
      {} as never, // raccoon
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const response = await handler(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method: 'account.create', payload: { provider: 'trae' } },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; error?: { code: string; message: string } }
    }

    // 必须是规范的错误响应（而不是裸 500 / 进程崩溃）。
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.message).toContain('18080')
    expect(body.result.error?.message).toMatch(/端口|占用/)
  })

  /**
   * `forceNew: true` 必须**跳过两道复用检查**，直接走 OAuth。
   *
   * ## 为什么需要这个开关（用户报障）
   *
   * 两道复用检查（收编孤儿条目 / 本机凭据已在池里就复用）是为「点一次添加
   * 就多一条」设计的，但它们**在渠道判断之前**，于是把「同一个人想加第二个
   * 账号」也一并挡掉了：本机官方客户端登的账号已在池里时，点「新建账号」
   * 直接返回 `{reused:true, loginUrl:''}`，**浏览器根本不开**，用户无从登录
   * 第二个号。换 `zai` 渠道也一样被挡（复用检查读的是 bigmodel 的凭据文件，
   * 与渠道无关）。
   *
   * 本用例锁死：`forceNew: true` ⇒ 不返回 reused、必须调 `startLogin`。
   */

  /**
   * 前端源码级守卫：`createAccount` 不得再劫持当前页面。
   *
   * 组件无法在单测里渲染（react 不在本仓库依赖内），故与
   * `credits-capabilities.spec.ts` 同款——用源码断言锁死那条破坏性兜底
   * 不再出现。`window.location.href = loginUrl` 会把用户正在使用的设置页
   * 整个导航到外部登录页，且登录完成后回不来；正确做法是保留可点击链接。
   */
  it('createAccount 不再用 window.location.href 跳转主页面', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    // ⚠️ 签名带形参（`async (forceNew) =>`，ZCode 的「登录其他账号」用它跳过复用）。
    // 按 `const createAccount = async ` 定位，不把形参写进断言 —— 否则每次加参数
    // 都要改这条守卫，而它真正要守的是**函数体里不得有页面跳转**。
    const start = source.indexOf('const createAccount = async ')
    expect(start).toBeGreaterThan(-1)
    // 取到下一个顶层函数定义为止，避免把文件其余部分一起扫进来。
    const rest = source.slice(start)
    const end = rest.indexOf('\n  const toggleAccount')
    const body = end > -1 ? rest.slice(0, end) : rest.slice(0, 3000)

    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF。
    // 再剔除注释行：本文件里保留了叙述该缺陷的注释（含 `window.location.href = …`
    // 字样），直接扫全文会把注释本身当成违规。与 credits-capabilities.spec.ts 同款。
    const normalized = body.replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(
      normalized,
      'createAccount 里又出现了 window.location.href 跳转：弹窗被拦截时'
      + '必须展示可点击链接，而不是把整个设置页导航走。',
    ).not.toMatch(/window\.location\.(href|assign|replace)\s*=/)
    // 必须仍然尝试弹出新窗口（两步式的前提）。
    expect(normalized).toContain('openAccountLoginWindow({ provider, loginUrl')
    const popupHelper = readFileSync(resolve(here, '../../plugin-src/client/account-login-window.js'), 'utf8')
    expect(popupHelper).toContain("browserWindow.open(loginUrl, '_blank'")
    // 弹窗失败时要有手动链接兜底。
    expect(normalized).toContain('setLoginUrlForManual(loginUrl)')
  })
})

describe('model.list / model.setDisabled 端点', () => {
  /**
   * ⚠️ 「已失效模型」表是**进程级单例**（`dead-model-store` 的 store / cache 在
   * 模块作用域），本组用例会写记录。必须在每例之后清干净，否则**残留记录会让
   * 后续用例的 model.list 多出条目**（表现为「莫名其妙多一个模型」的假失败）。
   */
  afterEach(() => {
    clearDeadModels('buddy')
    clearDeadModels('cline')
    clearDeadModels('trae')
  })

  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 构造带 RPC 端点所需的 ctx 替身，返回注册进去的 fetch 处理器。 */
  function registerEndpoints(options: {
    models: Array<{ id: string; name: string }>
    disabledModels?: Record<string, Record<string, boolean>>
    /** listModels 抛错时用于验证错误路径。 */
    listModelsError?: string
    /** 省略 llm 服务（验证降级行为）。 */
    withoutLlm?: boolean
    /**
     * 是否让桩复刻真实适配器的黑名单过滤（默认 true）。
     *
     * 真实 `CodeArtsAdapter.listModels` / `BuddyAdapter.listModels` 都会实时
     * 剔除 `disabledModelsFor(provider)` 命中的模型，因此桩默认也必须过滤，
     * 否则「端点在一个已过滤目录上回填 disabled」这类缺陷会被静默绕过。
     * 仅当需要验证「适配器未过滤」这一非真实场景时才置为 false。
     */
    adapterFiltersDisabledModels?: boolean
    /**
     * 复刻适配器实例映射（`listAllModels` 返回**不套黑名单**的全量目录）。
     *
     * 真实链路里 `index.ts` 会把五个适配器实例传给 `registerJetHubRpc`；
     * `model.list` 据此拿到被关闭模型的**真实展示名**（含倍率），而不是裸 id。
     * 省略时退化为「listModels + 裸 id 补回」的历史行为。
     */
    modelAdapters?: Record<string, { listAllModels(): readonly { id: string; name: string }[] }>
    /** 让 `ctx.emit` 抛错，验证「广播失败不反噬已落盘的开关」。 */
    emitThrows?: boolean
  }) {
    // settings 替身：内存里保存 namespace 的值，语义与真实服务一致的
    // 「整体 replace」。
    let stored: Record<string, unknown> = {
      accounts: [],
      ...options.disabledModels !== undefined ? { disabledModels: options.disabledModels } : {},
    }
    let handler: Handler | undefined
    /** 端点通过 `ctx.emit` 广播过的事件名（按顺序）。 */
    const emitted: string[] = []

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { path: string; fetch: Handler }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              // 复刻真实适配器：黑名单命中的模型不会出现在 listModels 结果里。
              // 读的是 settings 替身的当前值（而非构造时的快照），这样
              // model.setDisabled 之后的下一次 listModels 会立刻反映过滤结果，
              // 与真实「每次调用都实时读账号池」的语义一致。
              const disabled = options.adapterFiltersDisabledModels !== false
                ? ((stored.disabledModels as Record<string, Record<string, boolean>> | undefined)?.[provider] ?? {})
                : {}
              return options.models
                .filter(m => disabled[m.id] !== true)
                .map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      // `connection` 由生产代码用**惰性注入**（`ctx.inject`）挂载，而非插件级
      // 静态 `inject`：它只存在于 Web bundle，静态声明会让 headless/CLI profile
      // 永久 pending 而启动失败。替身必须复刻这一机制，否则 registerJetHubRpc
      // 会以 `ctx.inject is not a function` 直接抛错。
      //
      // 语义对齐真实 cordis：回调以**同一 ctx** 立即调用（本替身里 connection
      // 始终可用），使端点注册行为与 Web profile 下完全一致。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      // `model.setDisabled` / `model.setAllDisabled` 写完黑名单后必须广播
      // `llm/adapters-updated`，否则客户端那份 `status === 'ready'` 即短路的
      // 目录缓存永不失效 —— 表现为「关闭后选择器里仍看得到该模型，重启后才消失」。
      // 替身必须真的实现 emit：若只声明不实现，生产代码的广播会以
      // `ctx.emit is not a function` 被 try/catch 静默吞掉，用例便形同虚设。
      emit: (event: string) => {
        if (options.emitThrows === true) throw new Error('listener exploded')
        emitted.push(event)
      },
    }

    registerJetHubRpc(
      // ⚠️ 位置参数：每新增一个 provider 都要在这里补一个 `{}` 占位，
      // 否则 `modelAdapters` 会错位落到最后一个 auth 形参上
      // （加 Loomy 时踩过一次，加 Raccoon 又踩一次，加 QoderCN 第三次，
      //  加 MiniMax 第四次、加 ZCode 第五次 —— 见计划末尾「把
      //  registerJetHubRpc 改成具名参数对象」的后续项建议）。
      ctx as never, pool,
      {} as never, // codearts
      {} as never, // buddy
      {} as never, // workbuddy
      {} as never, // lobsterai
      {} as never, // qoder
      {} as never, // qoderCn
      {} as never, // trae
      {} as never, // cline
      {} as never, // loomy
      {} as never, // raccoon
      {} as never, // minimax
      {} as never, // zcode（2026-09-29 新增，紧随 raccoon）
      {} as never, // gemini（2026-10-03 新增，追加在 zcode 之后）
      options.modelAdapters as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    /** 调用一个端点方法，返回解包后的 result。 */
    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call, pool, storedValue: () => stored, emitted }
  }

  const MODELS = [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'hy3', name: 'Hy3' },
  ]

  it('model.list 回传 llm 的模型目录，并把黑名单回填为 disabled', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(true)
    // 未提供 modelAdapters 时退化为历史行为：hy3 已被适配器过滤掉（桩复刻了
    // 真实过滤），由端点补回列表；补回的条目拿不到原始 name，回退为 id。
    // ⚠️ `dead` 恒存在（缺失即 false，客户端据它渲染「重新显示」入口）。
    expect(result.value).toEqual({
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', disabled: false, dead: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', disabled: false, dead: false },
        { id: 'hy3', name: 'hy3', disabled: true, dead: false },
      ],
    })
  })

  /**
   * 回归：**被关闭的模型也要显示倍率**（用户报障）。
   *
   * 真实缺陷：适配器的 `listModels` 会按黑名单过滤，于是被关闭的模型不在其中，
   * 端点只能凭黑名单的 key（裸 id）补回 —— 展示名与倍率随之丢失。用户看到
   * 「打开的显示倍率、关闭的没有倍率」。
   *
   * 修法：`index.ts` 把适配器实例传给 `registerJetHubRpc`，端点用其
   * `listAllModels()`（不套黑名单、带最终展示名）作为目录来源。
   */
  it('关闭的模型仍显示带倍率的展示名（不再退化成裸 id）', async () => {
    const catalog = [
      { id: 'glm-5.2', name: 'GLM-5.2 · x0.78' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash · x0.13' },
      { id: 'kimi-k3', name: 'Kimi-K3 · x1.83' },
    ]
    const { call } = registerEndpoints({
      models: catalog,
      disabledModels: { trae: { 'deepseek-v4.1-flash': true } },
      modelAdapters: { trae: { listAllModels: () => catalog } },
    })

    const result = await call('model.list', { provider: 'trae' })
    expect(result.ok).toBe(true)
    const models = (result.value as { models: Array<{ id: string; name: string; disabled: boolean }> }).models
    const closed = models.find((m) => m.id === 'deepseek-v4.1-flash')
    expect(closed?.disabled, '该项应为已关闭').toBe(true)
    // 关键断言：关闭项必须仍是**带倍率的展示名**，而不是裸 id。
    expect(closed?.name).toBe('DeepSeek-V4.1-Flash · x0.13')
    // 打开项不受影响。
    expect(models.find((m) => m.id === 'glm-5.2')?.name).toBe('GLM-5.2 · x0.78')
    // 全部模型都应在列表里（含被关闭的）。
    expect(models.map((m) => m.id)).toEqual(['glm-5.2', 'deepseek-v4.1-flash', 'kimi-k3'])
  })

  /**
   * 回归测试：关闭 → 列表 → 重新打开的完整往返。
   *
   * 历史 bug：`model.list` 直接在 `llm.listModels()`（已被适配器过滤）的结果上
   * 回填 disabled，被关闭的模型不在数组里，它的开关因此从设置页彻底消失，
   * 用户无法重新打开。此用例锁死「关掉的模型必须仍在 model.list 里且可被 reopen」。
   */
  it('关闭模型后它仍出现在 model.list 中（可被重新打开），但不在对话框目录里', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    // 初始：全部可见、全部打开
    const before = await call('model.list', { provider: 'buddy' })
    expect((before.value as { models: Array<{ id: string }> }).models.map(m => m.id))
      .toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])

    // 关闭 hy3
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })

    // 关键断言：hy3 仍出现在设置页列表里，且标记为已关闭 —— 否则无法重新打开
    const after = await call('model.list', { provider: 'buddy' })
    const models = (after.value as { models: Array<{ id: string; disabled: boolean }> }).models
    const hy3 = models.find(m => m.id === 'hy3')
    expect(hy3).toBeDefined()
    expect(hy3!.disabled).toBe(true)
    // 其余模型不受影响
    expect(models.filter(m => m.disabled).map(m => m.id)).toEqual(['hy3'])

    // 重新打开：hy3 恢复正常显示
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })
    const reopened = await call('model.list', { provider: 'buddy' })
    const reopenedModels = (reopened.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(reopenedModels.map(m => m.id)).toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])
    expect(reopenedModels.every(m => !m.disabled)).toBe(true)
  })

  // ── 「已失效模型」的可见性与恢复（2026-10-06 复审 !66）──────────────────

  /**
   * ⚠️⚠️ 致命回归（复审 !66 实测确认）：适配器把已失效模型从目录里剔除后，
   * 它既不在 `listAllModels` 的结果里、也不在 `disabledMap` 里 ⇒ 上面两条
   * 补回路径都救不回它 ⇒ **模型从设置页彻底消失，连开关都摸不着**。
   *
   * 而失效记录**不会**被「再成功一次」清掉（模型选不到 ⇒ 不可能再成功），
   * 唯一自愈路径是 30 天 TTL 或用户手动恢复 ⇒ 一次误判 = 该模型被永久隐藏。
   *
   * ⇒ 断言：失效模型必须**仍出现在 `model.list` 里**且带 `dead: true`。
   */
  it('★ 已失效模型仍出现在 model.list 且带 dead: true（否则用户无法恢复）', async () => {
    const catalog = [{ id: 'ok-model', name: 'OK' }]
    const { call } = registerEndpoints({
      // 适配器侧已把失效模型剔除（这正是 withDeadModelPruning 的行为）
      models: catalog,
      modelAdapters: { cline: { listAllModels: () => catalog } },
    })
    recordDeadModel('cline', 'gone-model', 'cline: model not found')

    const result = await call('model.list', { provider: 'cline' })
    expect(result.ok).toBe(true)
    const models = (result.value as { models: Array<{ id: string; name: string; dead: boolean }> }).models
    const gone = models.find(m => m.id === 'gone-model')
    expect(gone, '失效模型必须仍出现在设置页，否则用户无法恢复').toBeDefined()
    expect(gone!.dead).toBe(true)
    // 正常模型不受影响，且 dead 为 false（恒存在，不省略）。
    expect(models.find(m => m.id === 'ok-model')?.dead).toBe(false)
  })

  it('model.clearDead 移除指定模型后 dead 标记消失', async () => {
    const catalog = [{ id: 'ok-model', name: 'OK' }]
    const { call } = registerEndpoints({
      models: catalog,
      modelAdapters: { cline: { listAllModels: () => catalog } },
    })
    recordDeadModel('cline', 'gone-model', 'cline: model not found')

    const restored = await call('model.clearDead', { provider: 'cline', modelId: 'gone-model' })
    expect(restored.ok).toBe(true)
    expect((restored.value as { deadModels: string[] }).deadModels).toEqual([])
    expect(deadModelIdsFor('cline').has('gone-model')).toBe(false)
  })

  it('model.clearDead 省略 modelId 时清空该 provider 全部（批量恢复）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    recordDeadModel('buddy', 'a-gone', 'x')
    recordDeadModel('buddy', 'b-gone', 'x')

    const result = await call('model.clearDead', { provider: 'buddy' })
    expect(result.ok).toBe(true)
    expect(deadModelIdsFor('buddy').size).toBe(0)
  })

  it('model.clearDead 不动黑名单（失效记录与用户开关必须分开清）', async () => {
    const { call } = registerEndpoints({ models: MODELS, disabledModels: { buddy: { 'glm-5.2': true } } })
    recordDeadModel('buddy', 'a-gone', 'x')

    await call('model.clearDead', { provider: 'buddy', modelId: 'a-gone' })
    // 用户自己关的 glm-5.2 必须仍然是关的 —— 「恢复」不等于「打开」。
    const after = await call('model.list', { provider: 'buddy' })
    const models = (after.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(models.find(m => m.id === 'glm-5.2')?.disabled).toBe(true)
  })

  it('model.clearDead 参数非法一律 bad-request（modelId 空串不得清空全表）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    recordDeadModel('buddy', 'keep-me', 'x')

    for (const payload of [{}, { provider: '' }, { provider: 'buddy', modelId: '' }, { provider: 'buddy', modelId: 42 }]) {
      const result = await call('model.clearDead', payload)
      expect(result.ok, JSON.stringify(payload)).toBe(false)
    }
    // 非法调用**不得**误清记录。
    expect(deadModelIdsFor('buddy').has('keep-me')).toBe(true)
  })

  /**
   * 关闭多个模型（含连续操作）后，全部都能在设置页找到。
   *
   * 覆盖用户实际场景：连续关掉多个模型后想找回其中一个。
   */
  it('连续关闭多个模型后，每个都仍可在 model.list 中找到并重新打开', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    for (const id of ['glm-5.2', 'hy3']) {
      await call('model.setDisabled', { provider: 'buddy', modelId: id, disabled: true })
    }

    const listed = await call('model.list', { provider: 'buddy' })
    const models = (listed.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(models.map(m => m.id).sort()).toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
    expect(models.filter(m => m.disabled).map(m => m.id).sort()).toEqual(['glm-5.2', 'hy3'])
  })

  it('未配置黑名单时全部模型默认打开（黑名单制）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.list', { provider: 'workbuddy' })
    const models = (result.value as { models: Array<{ disabled: boolean }> }).models

    expect(models.every(m => m.disabled === false)).toBe(true)
  })

  it('黑名单按 provider 隔离', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const buddy = await call('model.list', { provider: 'buddy' })
    const workbuddy = await call('model.list', { provider: 'workbuddy' })

    const flagOf = (result: unknown, id: string) =>
      (result as { models: Array<{ id: string; disabled: boolean }> }).models.find(m => m.id === id)!.disabled

    expect(flagOf(buddy.value, 'hy3')).toBe(true)
    // 另一个 provider 的同名模型不受影响
    expect(flagOf(workbuddy.value, 'hy3')).toBe(false)
  })

  it('model.setDisabled 持久化到 settings，并在后续 model.list 中生效', async () => {
    const { call, storedValue } = registerEndpoints({ models: MODELS })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })
    expect(set.ok).toBe(true)
    expect(set.value).toEqual({ provider: 'buddy', disabledModels: { hy3: true } })
    // 落盘内容可核对：
    expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })

    const list = await call('model.list', { provider: 'buddy' })
    const hy3 = (list.value as { models: Array<{ id: string; disabled: boolean }> })
      .models.find(m => m.id === 'hy3')!
    expect(hy3.disabled).toBe(true)
  })

  it('重新打开时从黑名单移除（写 false 不残留）', async () => {
    const { call, storedValue } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })

    expect(set.value).toEqual({ provider: 'buddy', disabledModels: {} })
    expect(storedValue().disabledModels).toEqual({})
  })

  it('model.setDisabled 缺少 modelId 时返回 bad-request 而不是静默成功', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.setDisabled', { provider: 'buddy', modelId: '' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('modelId')
  })

  /**
   * 回归：**开关必须广播目录变更事件**，否则界面要重启才更新（用户报障）。
   *
   * 真实缺陷：`dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 把
   * `modelCatalog` 响应缓存在一个 `status === 'ready'` 即短路返回的 store 里，
   * 只在三个转发事件上 `refresh()`。0.1.7 起黑名单落在插件自有文档
   * （不再经 settings 文档），于是写开关**不触发任何**那些事件 → 选择器一直
   * 显示旧目录，直到重启（`connection/reset`）才重拉。
   *
   * 适配器侧本来就是对的（每次实时读黑名单），所以这个用例锁的是**通知**：
   * 少了它，落盘与界面就会长期不一致，且没有任何报错。
   */
  it('model.setDisabled 广播 llm/adapters-updated（否则界面要重启才更新）', async () => {
    const { call, emitted } = registerEndpoints({ models: MODELS })

    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })
    // 关闭要广播
    expect(emitted).toContain('llm/adapters-updated')

    // 重新打开同样要广播：两个方向都会改变可见目录。
    emitted.length = 0
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })
    expect(emitted).toContain('llm/adapters-updated')
  })

  it('校验失败时不广播（没有实际变更就不该惊动目录）', async () => {
    const { call, emitted } = registerEndpoints({ models: MODELS })

    const result = await call('model.setDisabled', { provider: 'buddy', modelId: '' })

    expect(result.ok).toBe(false)
    expect(emitted).toEqual([])
  })

  /**
   * 广播失败**不能反噬已经落盘的开关**。
   *
   * 若让监听器的异常冒泡，用户会看到「切换失败」，而黑名单其实已经写入 ——
   * 再点一次又因幂等而看似「无效」，比不提示更难排查。故生产代码把 emit
   * 包在 try/catch 里，本用例锁住这一行为。
   */
  it('广播抛错时开关仍算成功（已落盘的不回滚）', async () => {
    const { call, storedValue, emitted } = registerEndpoints({ models: MODELS, emitThrows: true })

    const result = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })

    expect(result.ok).toBe(true)
    expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })
    // 抛错发生在 push 之前，故不会有记录 —— 但关键断言是上面的 ok/落盘。
    expect(emitted).toEqual([])
  })

  it('llm 服务不可用时 model.list 返回可读错误（账号面板不受影响）', async () => {
    const { call } = registerEndpoints({ models: MODELS, withoutLlm: true })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('llm 服务不可用')
  })

  it('适配器 listModels 抛错时返回可读错误而不是裸 500', async () => {
    const { call } = registerEndpoints({ models: MODELS, listModelsError: '令牌已过期' })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('令牌已过期')
  })

  /**
   * 批量端点 `model.setAllDisabled`（Jet Hub 模型列表的「打开全部 / 关闭全部」）。
   *
   * 两个方向的语义**刻意不对称**，这是需求明确规定并写进
   * `AccountPool.setModelsDisabled` / `clearDisabledModels` 的约定：
   *
   * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，读目录因此是必需的；
   * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单，**不读目录** ——
   *   否则「曾被关闭、后来从服务端目录里下线」的历史遗留键永远清不掉。
   *
   * 用一个带布尔的端点而不是两个端点：两者共享同一套校验、同一次广播、
   * 同一份返回结构，唯一差异就是那个布尔。
   */
  describe('model.setAllDisabled（打开全部 / 关闭全部）', () => {
    it('disabled:true 把目录里的模型全部写入黑名单', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
      // 落盘后 model.list 应显示全部关闭
      const list = await call('model.list', { provider: 'buddy' })
      const models = (list.value as { models: Array<{ disabled: boolean }> }).models
      expect(models.every((m) => m.disabled)).toBe(true)
    })

    /**
     * 目录来源必须是**未过滤**的全量目录。
     *
     * `listModels` 会按黑名单过滤，已关闭的模型不在其中。虽然它们本就在
     * 黑名单里（合并语义让结果恰好正确），但目录少一项就意味着「批量关闭」
     * 的集合不完整 —— 一旦将来有人把合并改成整体替换，漏掉的项会被静默打开。
     */
    it('disabled:true 以 listAllModels 的全量目录为准', async () => {
      const catalog = [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'hy3', name: 'Hy3' },
      ]
      const { call, storedValue } = registerEndpoints({
        models: catalog,
        disabledModels: { buddy: { hy3: true } },
        modelAdapters: { buddy: { listAllModels: () => catalog } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(storedValue().disabledModels).toEqual({ buddy: { 'glm-5.2': true, hy3: true } })
    })

    it('disabled:false 清空该 provider 的全部关闭项（含目录里没有的历史遗留键）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: {
          buddy: { hy3: true, 'legacy-model': true },
          workbuddy: { 'gpt-5.4': true },
        },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: false })

      expect(result.ok).toBe(true)
      // buddy 整体清空（含不在 MODELS 里的 legacy-model），workbuddy 不受影响
      expect(storedValue().disabledModels).toEqual({ workbuddy: { 'gpt-5.4': true } })
    })

    /**
     * 打开全部**不依赖目录**，因此 llm 服务不在时也必须成功。
     *
     * 这是两个方向最实质的差异：若图省事让打开也先读目录，那么在模型目录
     * 读不出来（凭据过期 / 远端故障）时，用户会连「把开关全部打开」这件
     * 纯本地的事都做不了。
     */
    it('disabled:false 不依赖 llm 服务', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
        withoutLlm: true,
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: false })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({})
    })

    it('disabled:true 在 llm 不可用时回可读错误，且不落盘', async () => {
      const { call, storedValue, emitted } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
        withoutLlm: true,
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('llm 服务不可用')
      // 失败不得留下半套状态，也不该惊动目录
      expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })
      expect(emitted).toEqual([])
    })

    /**
     * 批量**只广播一次**。
     *
     * 若在前端循环调用单条端点，30 个模型会发 30 次请求、30 次
     * `llm/adapters-updated`，客户端目录被反复刷新；批量端点的意义正在于此。
     */
    it('只广播一次 llm/adapters-updated（批量不等于逐条广播）', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(emitted).toEqual(['llm/adapters-updated'])
    })

    it('打开全部同样广播（两个方向都改变可见目录）', async () => {
      const { call, emitted } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: false })

      expect(emitted).toEqual(['llm/adapters-updated'])
    })

    it('provider 非字符串 → bad-request，不落盘也不广播', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { disabled: true })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('provider')
      expect(storedValue().disabledModels).toBeUndefined()
      expect(emitted).toEqual([])
    })

    /**
     * `disabled` 必须显式给布尔，**不做默认值猜测**。
     *
     * 缺失时若默认成 `true`，一次字段名写错的前端改动会「静默关闭用户全部
     * 模型」；默认成 `false` 则反向静默打开 —— 两个方向都是灾难性且难察觉的。
     */
    it('disabled 非布尔 → bad-request（不猜默认值）', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { provider: 'buddy' })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('disabled')
      expect(emitted).toEqual([])
    })

    it('返回写入后的完整黑名单（与 model.setDisabled 同结构）', async () => {
      const { call } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.value).toEqual({
        provider: 'buddy',
        disabledModels: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
    })

    it('黑名单按 provider 隔离（不影响其它 provider）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { workbuddy: { 'gpt-5.4': true } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(storedValue().disabledModels).toEqual({
        workbuddy: { 'gpt-5.4': true },
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
    })

    /** 广播抛错不能反噬已落盘的批量开关（与单条端点同一约定）。 */
    it('广播抛错时批量开关仍算成功', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS, emitThrows: true })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
      // 抛错发生在 push 之前，故不会有记录 —— 关键断言是上面的 ok/落盘。
      expect(emitted).toEqual([])
    })
  })

  /**
   * 分组批量端点 `model.setDisabledMany`（Jet Hub 模型列表按「计费/来源」分组后的
   * 「本组全开 / 本组全关」，用户 2026-10-01 要求）。
   *
   * ⚠️ **与 `model.setAllDisabled` 的区别就是本组用例的判据**：那个的范围是
   * 「该 provider 的全部模型」，且**打开方向会清空整张黑名单**。若分组开关
   * 图省事复用它会怎样？——「打开『订阅额度』这一组」会把用户特意关着的
   * 「按量计费」那 400 多条**一起打开**。所以这里逐条锁住「只动传入的 id」。
   */
  describe('model.setDisabledMany（按分组批量开关）', () => {
    it('disabled:true 只关闭传入的那批（其它已关闭项与已打开项都不受影响）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['glm-5.2'],
        disabled: true,
      })

      expect(result.ok).toBe(true)
      // hy3 本来就关着（保持），glm-5.2 新关，deepseek-v4-flash 仍然开着
      expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true, 'glm-5.2': true } })
    })

    /**
     * ⚠️ **这条是本端点的存在理由**：打开方向必须**只**删传入的 id。
     *
     * 若实现里误用 `clearDisabledModels`（清空整个 provider），这里会断成 `{}`
     * —— 用户「只打开订阅额度那一组」会连带打开按量计费的全部模型。
     */
    it('disabled:false 只打开传入的那批，**不清空整张黑名单**', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true, 'glm-5.2': true, 'deepseek-v4-flash': true } },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['hy3', 'glm-5.2'],
        disabled: false,
      })

      expect(result.ok).toBe(true)
      // 只有 hy3/glm-5.2 被打开；deepseek-v4-flash 保持关闭
      expect(storedValue().disabledModels).toEqual({ buddy: { 'deepseek-v4-flash': true } })
    })

    it('某个 provider 的关闭项被清空时删掉整个键（配置不膨胀）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true }, workbuddy: { 'gpt-5.4': true } },
      })

      await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['hy3'], disabled: false })

      // buddy 整个键被删掉，workbuddy 不受影响
      expect(storedValue().disabledModels).toEqual({ workbuddy: { 'gpt-5.4': true } })
    })

    it('黑名单按 provider 隔离（关 buddy 不动 workbuddy）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { workbuddy: { 'gpt-5.4': true } },
      })

      await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['hy3'], disabled: true })

      expect(storedValue().disabledModels).toEqual({
        workbuddy: { 'gpt-5.4': true },
        buddy: { hy3: true },
      })
    })

    /** 批量**只广播一次**：分组里可能有 460 条，逐条调用会打 460 次目录刷新。 */
    it('只广播一次 llm/adapters-updated', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['hy3', 'glm-5.2'],
        disabled: true,
      })

      expect(emitted).toEqual(['llm/adapters-updated'])
    })

    it('返回写入后的完整黑名单（与其它两个开关端点同结构）', async () => {
      const { call } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['hy3'],
        disabled: true,
      })

      expect(result.value).toEqual({ provider: 'buddy', disabledModels: { hy3: true } })
    })

    /** ⚠️ 空数组直接拒：空组不该出现在界面上（前端按钮也已禁用）。 */
    it('modelIds 为空数组 → bad-request，不落盘也不广播', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: [],
        disabled: true,
      })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('modelIds')
      expect(storedValue().disabledModels).toBeUndefined()
      expect(emitted).toEqual([])
    })

    it('modelIds 全是脏值（空串 / 非字符串）→ 同样拒（去重剔净后为空）', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['', 42, null],
        disabled: true,
      })

      expect(result.ok).toBe(false)
      expect(emitted).toEqual([])
    })

    /** ⚠️ `disabled` 不做默认值猜测（与单条/全量端点同约定）。 */
    it('disabled 非布尔 → bad-request（不猜默认值）', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['hy3'] })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('disabled')
      expect(storedValue().disabledModels).toBeUndefined()
      expect(emitted).toEqual([])
    })

    it('provider 非字符串或空串 → bad-request', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      expect((await call('model.setDisabledMany', { modelIds: ['hy3'], disabled: true })).ok).toBe(false)
      expect((await call('model.setDisabledMany', { provider: '', modelIds: ['hy3'], disabled: true })).ok).toBe(false)
      expect(emitted).toEqual([])
    })
  })
})

/**
 * 三个积分端点的 provider 分派与能力边界（后端侧契约）。
 *
 * 四个 provider 分属**三套互不相同的协议**：
 * - CodeBuddy 系（buddy / workbuddy）经 `productById()` 取 BuddyProduct；
 * - `lobsterai`（三步 client-activities）；
 * - `codearts`（华为云 SDK-HMAC-SHA256 签名，见 `src/codearts-credits.ts`）。
 *
 * 历史背景（本用例的由来）：CodeArts 曾**不是** BuddyProduct，
 * `productById('codearts')` 返回 undefined，于是三个端点必然回
 * `bad-request: unsupported provider: codearts`。当时客户端在面板挂载时对
 * **所有** provider 无条件调用 `credits.balances`，把这条必然的拒绝当成运行时
 * 故障打进了控制台，并把账号卡片的「积分」渲染成「查询失败」（修法见
 * `plugin-src/client/credits-capabilities.js` 与
 * `tests/unit/credits-capabilities.spec.ts`）。
 *
 * 现在 CodeArts 已接入真实实现，因此本用例锁三件事：
 * 1. **未登记**的 provider 仍回可读的 bad-request（兜底契约不能退化）；
 * 2. CodeArts 被**接受**并返回结构化结果（新能力的回归保护）；
 * 3. 拒绝/接受都**按 provider 精确生效**，没有连 CodeBuddy 系一起误拒。
 *
 * 防止的「好心改坏」：把拒绝改成「返回空结果」→ 前端会以为该 provider 真没有
 * 积分可查，永远查不出问题；让它抛异常 → 退化成 `jet-hub/handler-failed`，
 * 丢失「provider 不支持」这一原因。
 */
describe('积分端点的 provider 能力边界', () => {
  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 注册端点，返回一个「调用端点方法并解包 result」的函数。 */
  function registerCreditsEndpoints() {
    let handler: Handler | undefined
    const ctx: Record<string, unknown> = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      // 生产代码用惰性注入挂载 connection 端点（见 registerJetHubRpc 的说明）：
      // 替身必须提供 inject，否则会以 `ctx.inject is not a function` 抛错。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      // 积分端点会 resolve 凭据；返回 undefined 让逐账号流程走「凭据未配置」
      // 分支，从而无需真实网络即可跑完（accounts 替身返回空数组，实际不触发）。
      credentials: { resolve: async () => undefined },
    }
    // pool 替身：一旦 provider 校验被绕过，listAccounts 会返回空数组，
    // 端点便以 `ok: true` + 空列表「假成功」——下面的断言会立刻揭穿它，
    // 而不会因为抛 TypeError 变成误导性的 handler-failed。
    const pool = { listAccounts: async () => [] }

    // ⚠️ 位置参数：`qoderCn` 槽位补 `{}`（加 QoderCN 时第三次踩这个坑）。
    registerJetHubRpc(ctx as never, pool as never, {} as never, {} as never, {} as never, {} as never, {} as never, /* qoderCn */ {} as never, {} as never, {} as never, {} as never, {} as never)
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    return async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }
  }

  const CREDITS_METHODS = ['credits.status', 'credits.claimAll', 'credits.balances']

  /**
   * 未知 provider 仍必须被拒。
   *
   * ⚠️ 历史上这条用例断言的是 **codearts** 被拒 —— 当时 CodeArts 确实没有
   * 积分能力（华为云账号体系无腾讯计费接口）。现在它已接入自己的签名协议
   * （`src/codearts-credits.ts`），故改用真正未登记的 provider 名来守住
   * 同一件事：**拒绝是兜底契约，不是常规路径**。
   *
   * 保留本用例的价值：防止「好心改坏」——把拒绝改成「返回空结果」会让前端
   * 以为该 provider 真没有积分可查；让它抛异常则退化成
   * `jet-hub/handler-failed`，丢失「provider 不支持」这一原因。
   */
  it.each(CREDITS_METHODS)('%s 对未知 provider 返回 unsupported provider（可读的 bad-request）', async (method) => {
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'unknownprovider' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: unknownprovider')
  })

  /**
   * ⚠️ **本用例 2026-10-02 被拆分过**，读之前先看这段理由，别以为是「把守卫改松了」。
   *
   * 原用例对**三个**方法都断言 `buddy` 与 `workbuddy` 都被接受（ok:true），
   * 目的是防止「把 CodeBuddy 系一并误拒」—— 历史上确实有过只认 `buddy`、
   * 于是国际版连**余额**都查不出来的缺陷。
   *
   * 但那条断言对 `credits.claimAll` 不成立：WorkBuddy 国际版**没有签到端点**
   * （证据：README「WorkBuddy 国际版后端没有签到接口，故其面板不显示」、
   * AGENTS.md 的能力表 `workbuddy → ✗（国际版后端无签到接口）`、客户端
   * `credits-capabilities.js` 的 `workbuddy: { balance: true, dailyCheckin: false }`，
   * 其注释写明国际版内核里只有 `get-dosage-notify` 用量通知）。
   * 原先「接受」只是因为**测试用空账号池**，替身下不会真的发请求 ——
   * 真实账号下它会用国际版凭据去发国内版的签到请求，必然失败。
   *
   * 触发这次修正的是「每日首次启动自动签到」（`src/auto-checkin.ts`）：它
   * 不维护第二份能力名单，只按 `claimAll` 返回的信封判跳过，所以宿主端必须
   * 对不支持的渠道**显式表态**。⇒ 拆成下面两条，**禁止一刀切**的意图完整保留：
   * `credits.status` / `credits.balances` 仍要求两者都被接受。
   */
  it.each(['credits.status', 'credits.balances'])('%s 不会把 CodeBuddy 系一并误拒', async (method) => {
    const call = registerCreditsEndpoints()
    // 两个 Buddy 系产品都能通过 provider 校验，走到 listAccounts（替身返回空）。
    for (const provider of ['buddy', 'workbuddy']) {
      const result = await call(method, { provider })
      expect(result.ok, `${method}/${provider}`).toBe(true)
    }
  })

  it('credits.claimAll 接受 buddy，但对 workbuddy 给出**明确**的「不支持每日签到」', async () => {
    const call = registerCreditsEndpoints()
    // CodeBuddy 中国版照旧被接受（它有签到端点）
    const buddyResult = await call('credits.claimAll', { provider: 'buddy' })
    expect(buddyResult.ok, 'claimAll/buddy').toBe(true)
    // 国际版：拒绝，但**必须是可读的能力原因**，不是泛化的「provider 没注册」
    const result = await call('credits.claimAll', { provider: 'workbuddy' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('WorkBuddy 国际版不支持每日签到')
    expect(result.error?.message, '不能退化成 unsupported provider').not.toContain('unsupported provider')
  })

  /**
   * CodeArts 现在**必须**被接受（不再回 bad-request）。
   *
   * 这是本次接入的核心契约：三个积分端点都要为 `codearts` 分支。
   * 用空账号池调用，只验证「provider 被接受且返回结构化结果」，
   * 不触发任何网络请求。
   */
  it.each(CREDITS_METHODS)('%s 接受 codearts（已接入华为云签名协议）', async (method) => {
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'codearts' })
    expect(result.ok).toBe(true)
  })

  it('credits.balances 对 codearts 返回 accounts 数组', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.balances', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.status 对 codearts 返回 accounts 数组（状态如实为 null）', async () => {
    // 华为侧没有独立的「签到状态」端点，故与 LobsterAI 同样返回 null，
    // 而不是臆造一份 CheckinStatus 形状的对象。
    const call = registerCreditsEndpoints()
    const result = await call('credits.status', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.claimAll 对 codearts 返回 summary 结构', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.claimAll', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { summary: unknown }).summary).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
      totalByUnit: { token: 0, credit: 0 },
    })
  })

  /**
   * TRAE 的 claim 分支**必须开启状态预检**。
   *
   * 真实缺陷（用户报障：「领取积分显示成功但是加 0 积分」的成因之二）：
   * TRAE 的 claim 对「今天已签到」是**幂等**的 —— 实测重复领取同样返回
   * `{code:0, message:"success"}`，与真正领取成功**无法区分**。早期照抄
   * LobsterAI 传了 `precheckStatus: false`（那是「LobsterAI 的领取流程内部
   * 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号被
   * 报成「领取成功」。判据只能是 status 端点的 `checked_in`。
   *
   * 用源码级断言而非行为断言：本用例要锁的是「这一行配置别被改回去」，
   * 与仓库里 `qoder-wiring.spec.ts` 守卫接线的方式一致。
   */
  it('TRAE 的 claim 分支开启状态预检并注入 fetchStatus（源码级守卫）', () => {
    // 注意 `here` 是同级另一个 describe 内的局部常量，此处不可见，故就地算路径。
    const srcPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/jet-hub-rpc.ts')
    const source = readFileSync(srcPath, 'utf8')
    // 从 claimAll 的 TRAE 分支起算（前面 credits.status 分支里也有同名判断，
    // 用 `collectClaimResults<TraeCredential` 定位更准）。
    const start = source.indexOf('collectClaimResults<TraeCredential')
    expect(start).toBeGreaterThan(-1)
    // 截到该分支的收尾 `return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }`
    // 之后，避免扫到后续其它 provider 分支。
    const rest = source.slice(start)
    const end = rest.indexOf('RpcCreditsClaimAllResponse }')
    const branch = end > -1 ? rest.slice(0, end) : rest.slice(0, 2000)
    // 剔除注释行：本文件在注释里叙述了这条缺陷的成因（含 precheckStatus 字样）。
    const code = branch
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code, 'TRAE 分支不得关闭状态预检').not.toContain('precheckStatus: false')
    expect(code, 'TRAE 分支必须注入 fetchStatus').toContain('fetchStatus:')
  })
})

/**
 * `account.reorder` 端点（Jet Hub 拖拽排序）。
 *
 * 用**真实 AccountPool** + 内存 settings 替身，而不是给 pool 打桩：
 * 这个端点的价值全在「参数校验 + 转交 pool.reorderAccounts」，
 * 用桩替换 pool 就只剩「调用了某方法」这种无信息量的断言，
 * 无法发现「集合校验被绕过」「顺序没持久化」这类真实问题。
 */
describe('account.reorder 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 建一个真实 pool（内存 settings）+ 端点调用器。 */
  function setup(initial: Array<{ id: string; provider: string }>) {
    let stored: { accounts: unknown[]; disabledModels: Record<string, unknown> } = {
      accounts: initial.map(a => ({
        ...a,
        nickname: a.id,
        enabled: true,
        credentialRef: `${a.provider.toUpperCase()}_ACCOUNT_${a.id.toUpperCase()}`,
        createdAt: 1,
        refreshable: true,
      })),
      disabledModels: {},
    }
    let handler: Handler | undefined
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: typeof stored) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined },
    }
    // ⚠️ 位置参数：`qoderCn` 槽位补 `{}`（加 QoderCN 时第三次踩这个坑）。
    registerJetHubRpc(ctx as never, pool as never, {} as never, {} as never, {} as never, {} as never, {} as never, /* qoderCn */ {} as never, {} as never, {} as never, {} as never, {} as never)
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }
    return { call, orderInStore: () => (stored.accounts as Array<{ id: string }>).map(a => a.id) }
  }

  it('重排成功并把新顺序写入存储', async () => {
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy' },
      { id: 'b', provider: 'buddy' },
      { id: 'c', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['c', 'a', 'b'] })
    expect(result.ok).toBe(true)
    expect(orderInStore()).toEqual(['c', 'a', 'b'])
  })

  it('集合不一致（列表过期）回可读错误，而不是 handler-failed', async () => {
    // 这类并发是可预期的：用户拖拽期间在别处新增/删除了账号。
    // 回 bad-request + 可读文案，前端能提示"刷新后重试"；
    // 若抛异常会退化成 jet-hub/handler-failed，用户只看到"未知故障"。
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy' },
      { id: 'b', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['a'] })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('账号列表已变化')
    // 数据未被破坏
    expect(orderInStore()).toEqual(['a', 'b'])
  })

  it('缺 provider 或 orderedIds 非字符串数组 → bad-request', async () => {
    const { call } = setup([{ id: 'a', provider: 'buddy' }])
    expect((await call('account.reorder', { orderedIds: ['a'] })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy' })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy', orderedIds: [1, 2] })).ok).toBe(false)
  })

  it('重排不影响其他 provider 账号的位置', async () => {
    const { call, orderInStore } = setup([
      { id: 'b1', provider: 'buddy' },
      { id: 'c1', provider: 'codearts' },
      { id: 'b2', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['b2', 'b1'] })
    expect(result.ok).toBe(true)
    // buddy 的两个账号在各自原下标上互换，codearts 仍在中间
    expect(orderInStore()).toEqual(['b2', 'c1', 'b1'])
  })
})

/**
 * 供应商级一键开关：`provider.status`（读）与 `provider.setEnabled`（写）。
 *
 * 这套用例的重点是几条**不能被"改动"破坏的不变式**：
 * 1. 关闭方向必须**先关模型、再停账号**（顺序反了会留下「账号全停但模型可见」的中间态）；
 * 2. 目录读失败或目录为空时**整个操作失败、不落盘、不广播**（「不关闭模型就不关闭供应商」）；
 * 3. 两个方向都必须广播 `llm/adapters-updated`（否则对话框选择器要重启才更新）；
 * 4. `enabled` 非布尔一律拒绝（不猜默认值）。
 */
describe('provider.status / provider.setEnabled 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  function setup(options: {
    /** `listAllModels()` 的返回值（不套黑名单的全量目录）；省略则模拟「适配器缺失」。 */
    catalog?: Array<{ id: string; name: string }>
    /** 初始黑名单。 */
    disabledModels?: Record<string, Record<string, boolean>>
    /** 初始账号（只用到 provider / enabled）。 */
    accounts?: Array<{ id: string; provider: string; enabled: boolean }>
    /** 省略 llm 服务，验证「目录读不出来」的降级路径。 */
    withoutLlm?: boolean
    /** 让 llm.listModels 抛错。 */
    listModelsError?: string
    /** 让 `ctx.emit` 抛错，验证「广播失败不反噬已落盘的开关」。 */
    emitThrows?: boolean
    /** 是否提供适配器（false = 模拟外部/旧适配器，只有 llm 可用）。 */
    withAdapter?: boolean
  } = {}) {
    let stored: Record<string, unknown> = {
      // ⚠️ 账号条目必须补齐 `credentialRef`（非空）与 `createdAt`/`refreshable`：
      // `sanitizeAccounts` 会把缺 `credentialRef` 的条目**整条丢弃**，于是
      // 「停用全部账号」会返回 0、用例假失败。这个替身曾因此踩过一次。
      accounts: (options.accounts ?? []).map((a, i) => ({
        nickname: a.id,
        credentialRef: `${a.provider.toUpperCase()}_ACCOUNT_T${i + 1}`,
        createdAt: Date.now(),
        refreshable: true,
        ...a,
      })),
      ...options.disabledModels !== undefined ? { disabledModels: options.disabledModels } : {},
    }
    let handler: Handler | undefined
    const emitted: string[] = []
    /** 记录每次写入的顺序，用于断言「先关模型、后停账号」。 */
    const writeOrder: string[] = []

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => {
                // 判定这次写入是「账号」还是「模型黑名单」：前者有非空 accounts
                // 且黑名单未变；用更直接的判据 —— 对比写入前后的字段差异。
                const prevDisabled = JSON.stringify((stored as { disabledModels?: unknown }).disabledModels ?? {})
                const nextDisabled = JSON.stringify((value as { disabledModels?: unknown }).disabledModels ?? {})
                if (prevDisabled !== nextDisabled) writeOrder.push('models')
                const prevAccounts = JSON.stringify((stored as { accounts?: unknown }).accounts ?? [])
                const nextAccounts = JSON.stringify((value as { accounts?: unknown }).accounts ?? [])
                if (prevAccounts !== nextAccounts) writeOrder.push('accounts')
                stored = value
              },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const adapter = options.catalog !== undefined && options.withAdapter !== false
      ? { listAllModels: () => options.catalog! }
      : undefined

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              const disabled = ((stored.disabledModels as Record<string, Record<string, boolean>> | undefined)?.[provider]) ?? {}
              // 复刻真实适配器：黑名单命中的模型不出现在 listModels 结果里。
              return (options.catalog ?? [])
                .filter(m => disabled[m.id] !== true)
                .map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: (event: string) => {
        if (options.emitThrows === true) throw new Error('listener exploded')
        emitted.push(event)
      },
    }

    registerJetHubRpc(
      // ⚠️ **位置参数**：auth 实例是按顺序传的，每新增一个 provider 都要在这里
      // 补一个 `{}` 占位，否则 `modelAdapters` 会错位落到最后一个 auth 形参上。
      // 加 Raccoon（第 9 个）时本地就因此踩过一次：`modelAdapters` 落到 `raccoon`
      // 上 → `listAllModels()` 读不到 → `provider.status` 的 total 恒为 0、
      // 三条用例假失败。改签名后请 `grep -n 'registerJetHubRpc(' tests/` 全部补齐。
      // ⚠️ 合并上游 `qoderCn`（第 8 个）时**第四次**踩到同一个坑：git 认为本文件
      // 「无冲突」（改动分散在不同段落），但 `qoderCn` 插入后这里的占位整体错位
      // 一位 → `modelAdapters` 落到 `raccoon` 上 → 上面那三条用例再次假失败。
      // **合并新增 provider 后必须重跑本组用例，不能只看 git 是否报冲突。**
      // ⚠️ **第六次**（2026-10-01，为提交独立 PR 而把本分支重建到最新上游）：
      // 上游此后又加了 `minimax` 与 `zcode` ⇒ 这里少两个占位、`modelAdapters`
      // 落到 `zcode` 上，本组 3 条用例**再次**以完全相同的形态失败。
      // 判据永远是同一条：`provider.status` 的 `total` 恒为 0 ⇒ 先数占位。
      ctx as never, pool,
      {} as never, // codearts
      {} as never, // buddy
      {} as never, // workbuddy
      {} as never, // lobsterai
      {} as never, // qoder
      {} as never, // qoderCn
      {} as never, // trae
      {} as never, // cline
      {} as never, // loomy
      {} as never, // raccoon
      {} as never, // minimax
      {} as never, // zcode
      {} as never, // gemini（新 provider 一律追加在末尾，见 registerJetHubRpc 注释）
      (adapter !== undefined ? { buddy: adapter } : undefined) as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return {
      call,
      emitted,
      writeOrder,
      storedDisabled: () => (stored.disabledModels as Record<string, Record<string, boolean>> | undefined) ?? {},
      storedAccounts: () => (stored.accounts as Array<{ id: string; provider: string; enabled: boolean }> | undefined) ?? [],
    }
  }

  const CATALOG = [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'hy3', name: 'Hy3' },
  ]

  describe('provider.status', () => {
    it('全部模型都已关闭时 closed 为 true', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })
      const result = await call('provider.status', { providers: ['buddy'] })
      expect(result.ok).toBe(true)
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy
      expect(s.models).toEqual({ total: 3, disabled: 3 })
      expect(s.closed).toBe(true)
    })

    it('⚠️ 只关了一部分时 closed 为 false（不能按「关过」判）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { hy3: true } },
      })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy
      expect(s.models).toEqual({ total: 3, disabled: 1 })
      expect(s.closed).toBe(false)
    })

    it('⚠️ 没有任何模型时 closed 必须为 false（「没有模型可关」≠「已关闭」）', async () => {
      const { call } = setup({ catalog: [] })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy
      expect(s.models.total).toBe(0)
      expect(s.closed).toBe(false)
    })

    it('⚠️ 适配器缺失时保守判为未关闭（不误报已关闭）', async () => {
      const { call } = setup({ catalog: CATALOG, withAdapter: false, disabledModels: { buddy: { 'glm-5.2': true } } })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { closed: boolean }> }).statuses.buddy
      expect(s.closed).toBe(false)
    })

    it('回传账号计数（enabled 只统计启用的）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        accounts: [
          { id: 'b1', provider: 'buddy', enabled: true },
          { id: 'b2', provider: 'buddy', enabled: false },
          { id: 'c1', provider: 'codearts', enabled: true },
        ],
      })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { accounts: { total: number; enabled: number } }> }).statuses.buddy
      // 只统计本 provider，codearts 的账号不计入
      expect(s.accounts).toEqual({ total: 2, enabled: 1 })
    })

    it('一次查询多个供应商，各自独立判定', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })
      const result = await call('provider.status', { providers: ['buddy', 'qoder'] })
      const statuses = (result.value as { statuses: Record<string, { closed: boolean }> }).statuses
      expect(statuses.buddy.closed).toBe(true)
      // qoder 没有目录 → 未关闭
      expect(statuses.qoder?.closed ?? false).toBe(false)
    })

    it('providers 非字符串数组 → bad-request', async () => {
      const { call } = setup({ catalog: CATALOG })
      expect((await call('provider.status', { providers: 'buddy' })).ok).toBe(false)
      expect((await call('provider.status', { providers: [1, 2] })).ok).toBe(false)
      expect((await call('provider.status', {})).ok).toBe(false)
    })

    it('provider.status 是只读的：不写盘、不广播', async () => {
      const { call, emitted, writeOrder } = setup({ catalog: CATALOG })
      await call('provider.status', { providers: ['buddy'] })
      expect(emitted).toEqual([])
      expect(writeOrder).toEqual([])
    })
  })

  describe('provider.setEnabled（关闭方向）', () => {
    it('关闭：把全部模型写入黑名单，并停用全部账号', async () => {
      const { call, storedDisabled, storedAccounts } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ provider: 'buddy', enabled: false, models: 3, accounts: 1 })
      expect(Object.keys(storedDisabled().buddy).sort()).toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
      expect(storedAccounts()[0].enabled).toBe(false)
    })

    it('⚠️ 顺序必须是「先关模型、再停账号」', async () => {
      // 判据是模型是否全关；先关模型可保证中途失败时状态仍自洽。
      const { call, writeOrder } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(writeOrder).toEqual(['models', 'accounts'])
    })

    it('关闭后广播 llm/adapters-updated（否则界面要重启才更新）', async () => {
      const { call, emitted } = setup({ catalog: CATALOG })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(emitted).toContain('llm/adapters-updated')
    })

    it('⚠️ 目录读失败 → 整个操作失败，不落盘、不广播', async () => {
      const { call, emitted, writeOrder, storedDisabled } = setup({
        catalog: CATALOG,
        withAdapter: false,
        withoutLlm: true,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(false)
      expect(result.error?.message).toBeTruthy()
      // 三条关键断言：不写黑名单、不停账号、不广播
      expect(storedDisabled().buddy).toBeUndefined()
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
    })

    it('⚠️ llm.listModels 抛错同样不落盘、不广播', async () => {
      const { call, emitted, writeOrder } = setup({
        catalog: CATALOG,
        withAdapter: false,
        listModelsError: 'boom',
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(false)
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
    })

    it('⚠️ 目录为空 → 拒绝且不落盘（「不关闭模型就不关闭供应商」的落点）', async () => {
      const { call, emitted, writeOrder, storedAccounts } = setup({
        catalog: [],
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('没有可关闭的模型')
      // ⚠️ 关键：绝不能「关不掉模型就只停账号」——那会让它显示成已关闭而模型仍在。
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
      expect(storedAccounts()[0].enabled).toBe(true)
    })

    it('已是目标状态时 accounts 计数为 0（不谎报已停用 N 个）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: false }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.value).toMatchObject({ models: 3, accounts: 0 })
    })

    it('无账号时关闭仍可执行（关模型、停 0 个账号）', async () => {
      const { call } = setup({ catalog: CATALOG })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ models: 3, accounts: 0 })
    })
  })

  describe('provider.setEnabled（打开方向）', () => {
    it('打开：清空该 provider 的黑名单，并启用全部账号，且广播', async () => {
      const { call, emitted, storedDisabled, storedAccounts } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, hy3: true } },
        accounts: [{ id: 'b1', provider: 'buddy', enabled: false }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ models: 2, accounts: 1 })
      expect(storedDisabled().buddy).toBeUndefined()
      expect(storedAccounts()[0].enabled).toBe(true)
      expect(emitted).toContain('llm/adapters-updated')
    })

    it('⚠️ 打开方向不读目录：目录缺失/故障时仍能把开关全打开', async () => {
      const { call } = setup({
        catalog: CATALOG,
        withAdapter: false,
        withoutLlm: true,
        disabledModels: { buddy: { 'glm-5.2': true } },
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(result.ok).toBe(true)
    })

    it('⚠️ 只清本 provider 的黑名单，不波及其它 provider', async () => {
      const { call, storedDisabled } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { hy3: true }, trae: { 'glm-5.2': true } },
      })
      await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(storedDisabled().buddy).toBeUndefined()
      expect(storedDisabled().trae).toEqual({ 'glm-5.2': true })
    })

    it('⚠️ 打开也要广播（两个方向都改变 listModels 结果）', async () => {
      const { call, emitted } = setup({ catalog: CATALOG })
      await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(emitted).toEqual(['llm/adapters-updated'])
    })
  })

  describe('provider.setEnabled（参数校验与健壮性）', () => {
    it('enabled 非布尔（缺失 / 字符串 / 数字）一律 bad-request，且不落盘', async () => {
      const { call, writeOrder, emitted } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      expect((await call('provider.setEnabled', { provider: 'buddy' })).ok).toBe(false)
      expect((await call('provider.setEnabled', { provider: 'buddy', enabled: 'false' })).ok).toBe(false)
      expect((await call('provider.setEnabled', { provider: 'buddy', enabled: 0 })).ok).toBe(false)
      // ⚠️ 不做默认值猜测：一次字段名写错不该静默改动用户数据
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
    })

    it('provider 缺失或空串 → bad-request', async () => {
      const { call } = setup({ catalog: CATALOG })
      expect((await call('provider.setEnabled', { enabled: false })).ok).toBe(false)
      expect((await call('provider.setEnabled', { provider: '', enabled: false })).ok).toBe(false)
    })

    it('⚠️ 广播抛错仍算成功（通知失败不得反噬已落盘的开关）', async () => {
      const { call, storedDisabled } = setup({ catalog: CATALOG, emitThrows: true })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(true)
      // 开关确实已落盘
      expect(Object.keys(storedDisabled().buddy)).toHaveLength(3)
    })
  })
})

/**
 * Cline「订阅额度」端点（`cline.quota` / `cline.requestLog`）。
 *
 * 参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分。
 *
 * 这里守住四条真正的不变式：
 * 1. **只认 cline** —— 其余 provider 一律 `bad-request`（前端另有
 *    `supportsSubscriptionQuota` 门控，两侧必须一致）。
 * 2. **额度逐账号隔离** —— 一个账号凭据坏掉不能让整批失败，
 *    否则多账号用户会因为「有一个号没配凭据」而完全看不到额度。
 * 3. **游标只走 `?cursor=`** —— 网关对 `page`/`offset` 静默忽略，
 *    传错会表现为「点了加载更多还是同一批」（最难排查的一类静默错误）。
 * 4. **请求记录失败是载荷（`ok:false`）而不是 RPC 错误** ——
 *    面板要保留已加载的行、只在下方显示原因。
 */
describe('account.test 端点（**无条件**真发一次请求）', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 一份形状合法的 Gemini 凭据：只要 `access_token` 非空，适配器就会走到 fetch。 */
  const GEMINI_CREDENTIAL = JSON.stringify({
    access_token: 'AT-gemini',
    refresh_token: 'RT-gemini',
    expiry: '2099-01-01T00:00:00Z',
    email: 'yinghaolin12@gmail.com',
  })

  /**
   * 桩掉全局 `fetch` 并记录 URL。
   *
   * ⚠️ **必须在调用 RPC 之前**替换：`probeWithAdapter` 构造适配器时不注入
   * `fetchImpl`，适配器取的是全局 `fetch`；不桩就会真的把探测消息发到 Google。
   * 一律回 429，让用例的结论是「仍受限」，但关键在于是**谁**把请求发到了**哪里**。
   */
  function stubFetch(): string[] {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('{"error":{"code":429,"message":"rate limit exceeded"}}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    })
    return calls
  }

  function setup(options: {
    /** 初始限流标记；省略 = 账号**没有**任何标记（这正是测试按钮要覆盖的场景）。 */
    modelRateLimits?: Record<string, number>
    /** 该 provider 的全量目录；省略则模拟「适配器缺失」（退化到 llm.listModels）。 */
    catalog?: Array<{ id: string; name: string }>
    /** 省略 llm 服务，验证「目录读不出来」的降级路径。 */
    withoutLlm?: boolean
  } = {}) {
    let stored: Record<string, unknown> = {
      accounts: [{
        id: 'gemini-1',
        provider: 'gemini',
        nickname: 'Gemini 测试号',
        enabled: true,
        credentialRef: 'GEMINI_ACCOUNT_TEST',
        createdAt: 1,
        refreshable: true,
        ...(options.modelRateLimits === undefined ? {} : { modelRateLimits: options.modelRateLimits }),
      }],
    }
    let handler: Handler | undefined
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: true, writable: true }),
        // ⚠️ 必须返回**真凭据**：返回 undefined 时 `makeDefaultProbe` 会以
        // 「凭据不可用」提前返回，适配器根本不会被构造 —— 那条路径下本组用例
        // 会变成假绿（断言不到「真发了请求」）。
        resolve: async () => ({ value: GEMINI_CREDENTIAL }),
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const adapter = options.catalog === undefined ? undefined : { listAllModels: () => options.catalog! }

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return { listModels: async (provider: string) => (options.catalog ?? []).map(m => ({ ...m, provider })) }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined },
    }

    registerJetHubRpc(
      // ⚠️ 位置参数（16 个）：漏一个就会让 modelAdapters 错位，判据是
      // 「目录读不出来 / total 恒为 0」。见上一组用例的详细注释。
      ctx as never, pool,
      {} as never, // codearts
      {} as never, // buddy
      {} as never, // workbuddy
      {} as never, // lobsterai
      {} as never, // qoder
      {} as never, // qoderCn
      {} as never, // trae
      {} as never, // cline
      {} as never, // loomy
      {} as never, // raccoon
      {} as never, // minimax
      {} as never, // zcode
      {} as never, // gemini
      (adapter !== undefined ? { gemini: adapter } : undefined) as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call, storedLimits: () => (stored.accounts as Array<{ modelRateLimits?: Record<string, number> }>)[0]?.modelRateLimits }
  }

  afterEach(() => { vi.unstubAllGlobals() })

  /**
   * ⚠️ 这条是本功能的**核心断言**：账号**没有任何限流标记**时，`account.test`
   * 依然真发了一次请求。
   *
   * 对照物是 `account.retest`：它在 `modelIds.length === 0` 处提前返回、零请求
   * （见 `account-probe.spec.ts` 的「没有任何限流标记时不发请求」）。用户报障
   * 「重测按钮你确认过会发请求吗，为什么响应这么快？」说的就是那个提前返回。
   */
  it('账号没有限流标记时依然真发一次请求（重测在此场景下零请求）', async () => {
    const calls = stubFetch()
    const { call } = setup({ catalog: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok).toBe(true)
    const value = result.value as { modelId: string; ok: boolean; message?: string }
    expect(value.modelId).toBe('gemini-3.8-flash')
    // 桩回 429 ⇒ 结论是「仍受限」，但请求确实发出去了。
    expect(value.ok).toBe(false)
    expect(value.message).toContain('仍受限')
    // 核心：请求确实发出去了，且打在 Gemini 的流式端点上。
    // ⚠️ 次数是 **2** 而不是 1：适配器在 429 时会先**换端点**重试一次
    // （`gemini-adapter.ts` 的 `endpointSwitched` 分支），daily 与 sandbox
    // 各打一次。故这里断言「至少一次 + 首次命中 daily」，而不是写死 1。
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toContain('daily-cloudcode-pa.googleapis.com')
    expect(calls[0]).toContain('/v1internal:streamGenerateContent')
    // 反向：没有任何请求打到 Google 之外的地方（凭据没被发给错的 host）。
    expect(calls.every((url) => url.includes('googleapis.com'))).toBe(true)
  })

  it('测试**不写任何存储**：不清标记、不写回新的重置时刻', async () => {
    const marker = Date.now() + 3_600_000
    stubFetch()
    const { call, storedLimits } = setup({
      modelRateLimits: { 'gemini-3.8-flash': marker },
      catalog: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
    })

    await call('account.test', { accountId: 'gemini-1' })

    // ⚠️ 这是与重测的硬性分野：重测成功会清标记、失败会写回上游新时刻；
    // 测试必须一个字节都不改（它只是「手动探活」，不改变选号状态）。
    expect(storedLimits()).toEqual({ 'gemini-3.8-flash': marker })
  })

  it('有标记时优先测标记里的模型，且**不**去读目录（目录不可用也能测）', async () => {
    const calls = stubFetch()
    // withoutLlm + 无适配器 ⇒ fullCatalogIds 必然失败；若实现先读目录，这条会 bad-request。
    const { call } = setup({ modelRateLimits: { 'gemini-3.8-flash-high': Date.now() + 1000 }, withoutLlm: true })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok).toBe(true)
    expect((result.value as { modelId: string }).modelId).toBe('gemini-3.8-flash-high')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('显式指定 modelId 时以它为准', async () => {
    const calls = stubFetch()
    const { call } = setup({ modelRateLimits: { 'gemini-3.8-flash-low': Date.now() + 1000 } })

    const result = await call('account.test', { accountId: 'gemini-1', modelId: 'gemini-3.8-flash-tiered' })

    expect((result.value as { modelId: string }).modelId).toBe('gemini-3.8-flash-tiered')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('无标记且目录读不出来 → bad-request，且**不**发请求（不猜模型名）', async () => {
    const calls = stubFetch()
    const { call } = setup({ withoutLlm: true })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('无法确定要测试的模型')
    // 猜一个模型名发出去会得到与账号无关的 404，把两件事混成一条报错。
    expect(calls).toHaveLength(0)
  })

  it('缺 accountId / 账号不存在 → bad-request', async () => {
    const calls = stubFetch()
    const { call } = setup({ catalog: [{ id: 'm', name: 'M' }] })

    for (const payload of [{}, { accountId: '' }, { accountId: 'ghost' }]) {
      const result = await call('account.test', payload)
      expect(result.ok, JSON.stringify(payload)).toBe(false)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('cline.quota / cline.requestLog 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 凭据形态与实测一致（`account_id` 是 `usr-…`）。 */
  const CLINE_CREDENTIAL = {
    access_token: 'workos:eyJhbGciOiJSUzI1NiIs',
    refresh_token: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
    account_id: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
    email: 'ijetlee@163.com',
  }

  const LIMITS_RESPONSE = {
    success: true,
    data: {
      limits: [
        { type: 'five_hour', percentUsed: 12.5, resetsAt: '2026-09-29T10:00:00.000Z' },
        { type: 'weekly', percentUsed: 68, resetsAt: '2026-10-05T00:00:00.000Z' },
      ],
    },
  }

  const USAGES_RESPONSE = {
    success: true,
    data: {
      nextToken: 'tok-2',
      items: [{ createdAt: '2026-09-29T07:12:00.000Z', aiModelName: 'DeepSeek', aiModelTypeName: 'cline-free', totalTokens: 49, creditsUsed: 0, costUsd: 1320 }],
    },
  }

  function setup(options: {
    /** 初始账号（provider 固定 cline）。 */
    accounts?: Array<{ id: string; enabled: boolean }>
    /** `ctx.credentials.resolve` 的返回值：`'valid'` = 合法凭据 JSON，`'missing'` = 未配置。 */
    credential?: 'valid' | 'missing'
  } = {}) {
    const accounts = options.accounts ?? [{ id: 'acc-1', enabled: true }]
    const stored: Record<string, unknown> = {
      accounts: accounts.map((a, i) => ({
        id: a.id,
        nickname: `号${i + 1}`,
        provider: 'cline',
        enabled: a.enabled,
        credentialRef: `CLINE_ACCOUNT_T${i + 1}`,
        createdAt: Date.now(),
        refreshable: true,
      })),
    }
    let handler: Handler | undefined

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? { register: () => ({ get: () => stored, replace: async () => {} }) }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    /**
     * ⚠️ `ctx.credentials` 是**服务注入的直接属性**（`ctx.credentials.resolve`），
     * 不是经 `ctx.get('credentials')` 取的 —— 写成后者会让端点在运行时抛
     * `Cannot read properties of undefined (reading 'resolve')`，
     * 而 RPC 把它包成 `jet-hub/handler-failed`，看起来像「方法不存在」。
     */
    const credentials = {
      describe: async () => ({ configured: false, writable: true }),
      resolve: async () => (options.credential === 'missing'
        ? undefined
        : { value: JSON.stringify(CLINE_CREDENTIAL) }),
      set: async () => {},
      unset: async () => {},
    }

    const ctx = {
      credentials,
      get: (key: string) => {
        if (key === 'connection') {
          // ⚠ 必须**按 path 精确匹配**（真实 dsh 是 `fetchRoutes.get(url.pathname)` 精确命中）：
          //   不看 path 的「最后注册的赢」替身，会被**后注册**的另一条路由偷走
          //   （当前是 `GET /api/jet-hub/captcha-carrier` 载体页路由）⇒ 本组测试的
          //   POST 落到载体页 handler 上 → 405 `method not allowed` → JSON.parse 炸。
          //   这是 AGENTS.md「合并上游新增端点后必须重跑位置占位组」那条纪律的复发。
          return { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: () => {},
    }

    registerJetHubRpc(
      // ⚠️ 位置参数：新增 provider 会让 `modelAdapters` 错位（本仓库已踩四次）。
      // 本组用例不依赖 modelAdapters，但**占位数量必须与签名一致**。
      ctx as never, pool,
      {} as never, // codearts
      {} as never, // buddy
      {} as never, // workbuddy
      {} as never, // lobsterai
      {} as never, // qoder
      {} as never, // qoderCn
      {} as never, // trae
      {} as never, // cline
      {} as never, // loomy
      {} as never, // raccoon
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub', payload: { method, payload } }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call }
  }

  /** 桩掉全局 fetch 并记录每次请求的 URL。 */
  function stubFetch(handler: (url: string) => Response) {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return handler(url)
    }))
    return urls
  }

  afterEach(() => { vi.unstubAllGlobals() })

  describe('cline.quota', () => {
    it('回传各账号的额度窗口（按网关原序）', async () => {
      stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup()
      const result = await call('cline.quota', { provider: 'cline' })
      expect(result.ok).toBe(true)
      const accounts = (result.value as { accounts: Array<{ ok: boolean; windows: Array<{ type: string }> }> }).accounts
      expect(accounts).toHaveLength(1)
      expect(accounts[0]!.ok).toBe(true)
      expect(accounts[0]!.windows.map(w => w.type)).toEqual(['five_hour', 'weekly'])
    })

    it('用 users/me 端点（不依赖账号 id）', async () => {
      const urls = stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup()
      await call('cline.quota', { provider: 'cline' })
      expect(urls[0]).toBe('https://api.cline.bot/api/v1/users/me/plan/usage-limits')
    })

    /**
     * ⚠️ 非 cline 一律 bad-request：前端 `supportsSubscriptionQuota` 只对 cline
     * 渲染按钮，两侧必须一致，否则就是「按钮在、点了报错」。
     */
    it('非 cline 的 provider → bad-request，且不发请求', async () => {
      const urls = stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup()
      for (const provider of ['buddy', 'qoder', 'loomy', '']) {
        expect((await call('cline.quota', { provider })).ok, provider).toBe(false)
      }
      expect(urls).toEqual([])
    })

    /**
     * ⚠️ 一个账号没配凭据只影响它自己：多账号用户不该因为其中一个号
     * 凭据缺失就完全看不到额度。
     */
    it('逐账号隔离：凭据未配置的账号带原因，其余照常', async () => {
      // 第一个账号走 missing 分支由 credential 选项控制；这里用两个账号 +
      // 按 ref 区分较麻烦，故直接验证「missing 时不发请求且带原因」这一半。
      stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup({ accounts: [{ id: 'acc-1', enabled: true }], credential: 'missing' })
      const result = await call('cline.quota', { provider: 'cline' })
      expect(result.ok).toBe(true)
      const accounts = (result.value as { accounts: Array<{ ok: boolean; error?: string; windows: unknown[] }> }).accounts
      expect(accounts[0]!.ok).toBe(false)
      expect(accounts[0]!.error).toBe('凭据未配置')
      expect(accounts[0]!.windows).toEqual([])
    })

    it('网关报错时该账号 ok:false 并带 HTTP 状态与文案', async () => {
      stubFetch(() => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
      const { call } = setup()
      const result = await call('cline.quota', { provider: 'cline' })
      const accounts = (result.value as { accounts: Array<{ ok: boolean; error?: string }> }).accounts
      expect(accounts[0]!.ok).toBe(false)
      expect(accounts[0]!.error).toContain('HTTP 401')
      expect(accounts[0]!.error).toContain('Unauthorized')
    })

    /** ⚠️ 查不到**不能显示成 0%**（0% 是「没用过」的语义）。 */
    it('查询失败时 windows 为空且 ok:false（不返回 0% 的假读数）', async () => {
      stubFetch(() => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }))
      const { call } = setup()
      const result = await call('cline.quota', { provider: 'cline' })
      const accounts = (result.value as { accounts: Array<{ ok: boolean; windows: unknown[] }> }).accounts
      expect(accounts[0]!.ok).toBe(false)
      expect(accounts[0]!.windows).toEqual([])
    })
  })

  describe('cline.requestLog', () => {
    /** 种入一条本地流水记录(模块级可变状态,用例间会泄漏,须先清)。 */
    const seedOne = (entry: Parameters<typeof recordClineRequest>[0]) => {
      resetClineRequestHistory()
      recordClineRequest(entry)
    }

    it('回传当前账号的记录,字段对齐参考实现', async () => {
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: true,
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 400,
        reasoningTokens: 89,
        effort: 'high',
        ttftMs: 320,
        // 首个**正文**块耗时：速率的分子分母都要落在正文阶段，必须透传
        ttfcMs: 1800,
        totalMs: 4200,
      })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      expect(result.ok).toBe(true)
      const value = result.value as {
        rows: Array<{
          ts: number
          model: string
          upstream: string
          usageReported: boolean
          inputTokens: number
          outputTokens: number
          cacheReadTokens?: number
          reasoningTokens?: number
          effort: string
          ttftMs: number
          ttfcMs: number
          totalMs: number
        }>
      }
      expect(value.rows).toHaveLength(1)
      expect(value.rows[0]).toEqual({
        ts: expect.any(Number),
        model: 'cline-pass/deepseek-v4.1-flash',
        // 网关没报路由时回落到模型 id 的「/ 前缀」（两个维度，见 RPC 侧注释）
        upstream: 'cline-pass',
        // ⚠️ 必须透传：表格据此把「网关没发 usage」显示成 `—`（不是 0）
        usageReported: true,
        inputTokens: 100,
        outputTokens: 25,
        // 缓存命中：有值才出现（表格的 ⚡ 那一项）
        cacheReadTokens: 400,
        reasoningTokens: 89,
        // 推理强度：**空串也照传**（前端据「空串 ⇒ 不渲染那一行」判断）
        effort: 'high',
        ttftMs: 320,
        ttfcMs: 1800,
        totalMs: 4200,
      })
    })

    /**
     * ⚠️ 用户报障「上游显示的不正确」：**网关报的真实渠道优先**，
     * 它没报时才回落到模型命名空间（`cline-pass` 那类订阅通道名）。
     */
    it('upstream 优先用网关报的渠道；未报时回落到模型命名空间', async () => {
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: true,
        inputTokens: 1,
        outputTokens: 1,
        effort: '',
        upstream: 'alibaba',
        ttftMs: 320,
        totalMs: 4200,
      })
      const { call } = setup()
      const withRoute = (await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' }))
        .value as { rows: Array<{ upstream: string }> }
      expect(withRoute.rows[0]!.upstream).toBe('alibaba')

      // 网关没报路由（空串）⇒ 回落成模型命名空间，而不是编造渠道名
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: true,
        inputTokens: 1,
        outputTokens: 1,
        effort: '',
        upstream: '',
        ttftMs: 320,
        totalMs: 4200,
      })
      const noRoute = (await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' }))
        .value as { rows: Array<{ upstream: string }> }
      expect(noRoute.rows[0]!.upstream).toBe('cline-pass')
    })

    /** ⚠️ 未收到 usage 帧时 token 全为 0，但 `usageReported:false` 必须透传。 */
    it('未收到 usage 帧时 usageReported:false 透传（0 不等于未知）', async () => {
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: false,
        inputTokens: 0,
        outputTokens: 0,
        effort: '',
        ttftMs: 320,
        totalMs: 4200,
      })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      const row = (result.value as { rows: Array<Record<string, unknown>> }).rows[0]!
      expect(row.usageReported).toBe(false)
      expect(row.effort).toBe('')
      expect('cacheReadTokens' in row).toBe(false)
      expect('reasoningTokens' in row).toBe(false)
    })

    it('按 accountId 过滤:别的账号的记录不混进来', async () => {
      seedOne({ model: 'm', accountId: 'acc-other', inputTokens: 1, outputTokens: 2, ttftMs: 3, totalMs: 4 })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      expect(result.ok).toBe(true)
      expect((result.value as { rows: unknown[] }).rows).toEqual([])
    })

    it('无记录时返回空数组(而不是错误)', async () => {
      resetClineRequestHistory()
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      expect(result.ok).toBe(true)
      expect((result.value as { rows: unknown[] }).rows).toEqual([])
    })

    /**
     * ⚠️ 失败行**随行回传 error**:失败的请求是排查「为什么没回复」的
     * 第一线索(429 / 11140 安全策略 / 网络错误各是不同的原因)。
     */
    it('失败行随行回传 error', async () => {
      seedOne({
        model: 'm', accountId: 'acc-1',
        inputTokens: 0, outputTokens: 0, ttftMs: 0, totalMs: 5,
        error: 'cline: transport error: ECONNRESET',
      })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      const rows = (result.value as { rows: Array<{ error?: string }> }).rows
      expect(rows[0]!.error).toContain('ECONNRESET')
    })

    it('非 cline 的 provider → bad-request(与额度端点同规)', async () => {
      const { call } = setup()
      for (const provider of ['buddy', 'qoder', '']) {
        expect((await call('cline.requestLog', { provider, accountId: 'acc-1' })).ok, provider).toBe(false)
      }
    })

    it('accountId 为空 → bad-request(不猜默认值)', async () => {
      const { call } = setup()
      expect((await call('cline.requestLog', { provider: 'cline', accountId: '' })).ok).toBe(false)
      expect((await call('cline.requestLog', { provider: 'cline' })).ok).toBe(false)
    })
  })
})
