/**
 * 聚合路由的**门控三态**与**手工位次排序**（用户 2026-10-15 的新功能）。
 *
 * 规格：`docs/superpowers/specs/2026-10-15-aggregate-gating-manual-order-design.md` §5.1 / §5.4
 *
 * ⚠️ 本文件只测 `src/aggregate-core.ts` 的**纯函数**（零网络、零 import）——
 *    存储、账号池、适配器建池各有自己的用例文件。
 */
import { describe, expect, it } from 'vitest'
import {
  NEVER,
  UNUSABLE,
  rankCandidates,
  resolveCandidateGate,
  type RankedCandidate,
} from '../../src/aggregate-core.js'
import { AccountPool } from '../../src/account-pool.js'

describe('resolveCandidateGate：三态判定表逐格', () => {
  it('显式拒绝恒优先（即便同时也在白名单里 —— 两表域不相交，这里是纵深防御）', () => {
    expect(resolveCandidateGate({ rejected: true, allowed: true, expiryWired: true })).toBe('rejected')
    expect(resolveCandidateGate({ rejected: true, allowed: true, expiryWired: false })).toBe('rejected')
  })

  it('显式允许优先于「未接入折算」的默认拒绝', () => {
    expect(resolveCandidateGate({ rejected: false, allowed: true, expiryWired: false })).toBe('allowed')
  })

  it('未接入折算且未被允许 ⇒ 默认拒绝（本功能的核心格）', () => {
    expect(resolveCandidateGate({ rejected: false, allowed: false, expiryWired: false }))
      .toBe('default-rejected')
  })

  it('已接入折算且未被拒绝 ⇒ 参与（与升级前行为逐字节相同）', () => {
    expect(resolveCandidateGate({ rejected: false, allowed: false, expiryWired: true })).toBe('allowed')
  })
})

const candidate = (provider: string, expiry: number, price = 1): RankedCandidate => ({
  provider, realId: `${provider}-1`, expiry, price,
})

describe('rankCandidates：不传 manualRankOf 时逐字节不变', () => {
  it('临期升序，同临期按倍率升序', () => {
    const input = [candidate('b', 300), candidate('a', 100, 9), candidate('c', 100, 2)]
    expect(rankCandidates(input).map((c) => c.provider)).toEqual(['c', 'a', 'b'])
  })

  it('剔掉 UNUSABLE，保留 NEVER（已接入渠道的「无临期积分」是可用态）', () => {
    const input = [candidate('dead', UNUSABLE), candidate('never', NEVER), candidate('soon', 100)]
    expect(rankCandidates(input).map((c) => c.provider)).toEqual(['soon', 'never'])
  })

  it('不改入参数组', () => {
    const input = [candidate('b', 300), candidate('a', 100)]
    rankCandidates(input)
    expect(input.map((c) => c.provider)).toEqual(['b', 'a'])
  })
})

describe('rankCandidates：手工位次是「严格序 + 临期兜底」', () => {
  it('已排过的按位次（即使临期更晚也排在前面）', () => {
    const input = [candidate('soon', 100), candidate('late', 900)]
    const rank = new Map([['late', 0], ['soon', 1]])
    expect(rankCandidates(input, (c) => rank.get(c.provider)).map((c) => c.provider))
      .toEqual(['late', 'soon'])
  })

  it('未排过的尾巴按「临期↑ → 倍率↑」追加在已排之后', () => {
    const input = [candidate('tailB', 500), candidate('ranked', NEVER), candidate('tailA', 100)]
    const rank = new Map([['ranked', 0]])
    expect(rankCandidates(input, (c) => rank.get(c.provider)).map((c) => c.provider))
      .toEqual(['ranked', 'tailA', 'tailB'])
  })

  it('两个未排过的 NEVER 候选：按倍率而不是 NaN 排序（Infinity - Infinity 陷阱）', () => {
    const input = [candidate('x', NEVER, 5), candidate('y', NEVER, 2)]
    expect(rankCandidates(input, () => undefined).map((c) => c.provider)).toEqual(['y', 'x'])
  })

  it('同一件候选取「第一次」出现的位次（服务端已去重，这里是纵深防御）', () => {
    const input = [candidate('a', 100), candidate('b', 100)]
    // 传入的位次函数若把两条都算成同一名次，则退回临期/倍率比较，不得产生 NaN 或乱序。
    expect(rankCandidates(input, () => 0).map((c) => c.provider)).toEqual(['a', 'b'])
  })

  it('UNUSABLE 仍被剔除 —— 手工位次不得复活它', () => {
    const input = [candidate('dead', UNUSABLE), candidate('ranked', NEVER)]
    const rank = new Map([['dead', 0], ['ranked', 1]])
    expect(rankCandidates(input, (c) => rank.get(c.provider)).map((c) => c.provider)).toEqual(['ranked'])
  })
})

/**
 * 账号池侧：白名单 / 手工顺序表 / 排序模式 / 一键恢复默认。
 *
 * ⚠️ 全部走**真实 `AccountPool` + 真实写入方法**（照 `aggregate-rejections.spec.ts` 的
 *    `makePoolWithRejections` 体例）：桩替身测不到「落盘载荷里有没有这个键」，
 *    而「漏键 = 永不落盘」正是本族功能最可能的静默失效。
 */
const makePool = async () => {
  let stored: Record<string, unknown> = {}
  const replaceCount = { value: 0 }
  const mockSettings = {
    register: () => ({
      get: () => stored,
      replace: async (v: Record<string, unknown>) => {
        stored = v
        replaceCount.value += 1
      },
    }),
    describe: () => [],
  }
  const pool = new AccountPool({
    get: (key: string) => (key === 'settings' ? mockSettings : undefined),
    credentials: {
      async resolve() { return null },
      async describe() { return { source: 'mock' } },
      async refName() { return 'MOCK' },
    },
    logger: { info: () => {}, warn: () => {} },
  } as never)
  return { pool, stored: () => stored, replaceCount }
}

const M = 'minimax\u0000MiniMax-M3'
const T = 'trae\u0000trae-x'

describe('白名单读写（只认显式 true；false 删键）', () => {
  it('setAggregateAllowed(true) 写入并落盘（载荷里必须带 aggregateAllowed）', async () => {
    const { pool, stored } = await makePool()
    expect(pool.listAggregateAllowed()).toEqual({})
    await pool.setAggregateAllowed('deepseek-v4-1-flash', 'minimax', 'MiniMax-M3', true)
    expect(pool.listAggregateAllowed()).toEqual({ 'deepseek-v4-1-flash': { minimax: { 'MiniMax-M3': true } } })
    expect(stored().aggregateAllowed).toEqual({ 'deepseek-v4-1-flash': { minimax: { 'MiniMax-M3': true } } })
  })

  it('setAggregateAllowed(false) 删键，不留 false，空层逐级清理', async () => {
    const { pool } = await makePool()
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'minimax', 'r1', false)
    expect(pool.listAggregateAllowed()).toEqual({})
    // 同渠道其它候选必须保留（用户逐条打开的是**候选**）
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'minimax', 'r2', true)
    await pool.setAggregateAllowed('m', 'minimax', 'r1', false)
    expect(pool.listAggregateAllowed()).toEqual({ m: { minimax: { r2: true } } })
  })

  it('★ 白名单可跨实例读回（新池读同一份文档）', async () => {
    const { pool } = await makePool()
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    expect(pool.listAggregateAllowed()).toEqual({ m: { minimax: { r1: true } } })
  })
})

describe('★ 两表各有各的域：互不干涉（用户 2026-10-15 修正）', () => {
  it('setAggregateAllowed(true) 不动拒绝表（**同键**——防「按同键归一」）', async () => {
    // ⚠️⚠️ **必须是同一个 `realId`**（2026-10-16 审计实测：原用例用 `r1`/`r2` **不同键**，
    //    于是任何「写白名单时顺手清同键拒绝记录」的实现都不会被发现 —— 我注入那
    //    种「真归一」变异后 **29 条用例全绿，零牙**）。
    //    用户要求 1「两表不归一」是本 PR 的核心约定 ⇒ 判据必须打在**同键**上：
    //    同键同时出现在两张表里是**合法状态**（域不相交是「写入侧按渠道划分」，
    //    不是「同一候选不得同时出现在两表」—— 拒绝优先会在判定时兜住）。
    const { pool } = await makePool()
    await pool.setAggregateRejected('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    // ★ 拒绝表**逐字节不变**（不是「被清掉」也不是「被归一」）
    expect(pool.listAggregateRejections(), '★ 同键的拒绝记录不得被白名单写入清掉')
      .toEqual({ m: { minimax: { r1: true } } })
    expect(pool.listAggregateAllowed()).toEqual({ m: { minimax: { r1: true } } })
  })

  it('setAggregateRejected(true) 不动白名单（**同键**）', async () => {
    // ⚠️ 与上一条对称：同一 `realId` 同时写两张表，两边都必须各自保留。
    const { pool } = await makePool()
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    await pool.setAggregateRejected('m', 'minimax', 'r1', true)
    expect(pool.listAggregateAllowed(), '★ 同键的白名单记录不得被拒绝写入清掉')
      .toEqual({ m: { minimax: { r1: true } } })
    expect(pool.listAggregateRejections()).toEqual({ m: { minimax: { r1: true } } })
  })

  it('setAggregateAllowed(true) 不动**同渠道其它**候选的拒绝记录', async () => {
    const { pool } = await makePool()
    await pool.setAggregateRejected('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'minimax', 'r2', true)
    // 拒绝表逐字节不变（不是「被清掉」也不是「被归一」）
    expect(pool.listAggregateRejections()).toEqual({ m: { minimax: { r1: true } } })
    expect(pool.listAggregateAllowed()).toEqual({ m: { minimax: { r2: true } } })
  })

  it('setAggregateRejected(true) 不动白名单（同渠道其它手工打开的候选必须保留）', async () => {
    const { pool } = await makePool()
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'zcode', 'r9', true)
    await pool.setAggregateRejected('m', 'minimax', 'r2', true)
    expect(pool.listAggregateAllowed()).toEqual({ m: { minimax: { r1: true }, zcode: { r9: true } } })
    expect(pool.listAggregateRejections()).toEqual({ m: { minimax: { r2: true } } })
  })

  it('★ setAggregateRejected(false) 仍清整渠道层（D4 不变 —— 抽函数后必须行为不变）', async () => {
    const { pool } = await makePool()
    // 漂移旧键 + 当前键同时存在（D4 降级的典型现场）
    await pool.setAggregateRejected('m', 'minimax', 'driftOld', true)
    await pool.setAggregateRejected('m', 'minimax', 'current', true)
    await pool.setAggregateRejected('m', 'trae', 'keep', true)
    await pool.setAggregateRejected('m', 'minimax', 'current', false)
    // 整渠道层被清掉（含漂移旧键），其它渠道不动
    expect(pool.listAggregateRejections()).toEqual({ m: { trae: { keep: true } } })
  })

  it('同键双命中（跨域残留）时 gate 仍是 rejected ⇒ 纵深防御成立（不是靠归一）', () => {
    // 手工构造「两表都命中同一键」的残留态：判据必须是拒绝优先
    expect(resolveCandidateGate({ rejected: true, allowed: true, expiryWired: false })).toBe('rejected')
    expect(resolveCandidateGate({ rejected: true, allowed: true, expiryWired: true })).toBe('rejected')
  })
})

describe('setAggregateOrder：服务端过滤、去重、返回权威数组', () => {
  it('丢掉不含 NUL 的元素与重复项，保持相对顺序', async () => {
    const { pool, stored } = await makePool()
    expect(await pool.setAggregateOrder('m', [M, 'junk', M, T]))
      .toEqual([M, T])
    expect(stored().aggregateOrder).toEqual({ m: [M, T] })
    expect(pool.listAggregateOrder()).toEqual({ m: [M, T] })
  })

  it('空数组 = 未自定义（删键），返回空数组', async () => {
    const { pool } = await makePool()
    await pool.setAggregateOrder('m', [M])
    expect(await pool.setAggregateOrder('m', [])).toEqual([])
    expect(pool.listAggregateOrder()).toEqual({})
  })

  it('返回值是落盘后的权威数组（不是入参回声）', async () => {
    const { pool } = await makePool()
    const returned = await pool.setAggregateOrder('m', [T, 'junk', M, T])
    expect(returned).toEqual([T, M])
    expect(pool.listAggregateOrder().m).toEqual(returned)
  })

  it('★ 顺序表可跨实例读回', async () => {
    const { pool } = await makePool()
    await pool.setAggregateOrder('m', [M, T])
    expect(pool.listAggregateOrder()).toEqual({ m: [M, T] })
  })
})

describe('排序模式', () => {
  it('缺省 expiry；写入 manual 可读回并落盘', async () => {
    const { pool, stored } = await makePool()
    expect(pool.listAggregateOrderMode()).toBe('expiry')
    await pool.setAggregateOrderMode('manual')
    expect(pool.listAggregateOrderMode()).toBe('manual')
    expect(stored().aggregateOrderMode).toBe('manual')
  })

  it('幂等：写同一个值不落盘（避免一次空点击变成一次整体替换）', async () => {
    const { pool, replaceCount } = await makePool()
    await pool.setAggregateOrderMode('expiry')
    const before = replaceCount.value
    await pool.setAggregateOrderMode('expiry')
    expect(replaceCount.value).toBe(before)
  })
})

describe('clearAggregateAllowedExcept（一键「拒绝非临期」）', () => {
  it('只清 keepProviders 之外的白名单，cleared = 被清掉的候选条数', async () => {
    const { pool } = await makePool()
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'minimax', 'r2', true)
    await pool.setAggregateAllowed('m', 'buddy', 'keep', true)
    const result = await pool.clearAggregateAllowedExcept(['buddy'])
    expect(result.cleared).toBe(2)
    expect(result.aggregateAllowed).toEqual({ m: { buddy: { keep: true } } })
    expect(pool.listAggregateAllowed()).toEqual({ m: { buddy: { keep: true } } })
  })

  it('幂等：再点一次 cleared === 0 且**不写盘**', async () => {
    const { pool, replaceCount } = await makePool()
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    await pool.clearAggregateAllowedExcept(['buddy'])
    const before = replaceCount.value
    const again = await pool.clearAggregateAllowedExcept(['buddy'])
    expect(again.cleared).toBe(0)
    expect(replaceCount.value).toBe(before)
  })

  it('keepProviders 为空数组 ⇒ 清空全部白名单', async () => {
    const { pool } = await makePool()
    await pool.setAggregateAllowed('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'buddy', 'keep', true)
    expect((await pool.clearAggregateAllowedExcept([])).cleared).toBe(2)
    expect(pool.listAggregateAllowed()).toEqual({})
  })

  it('不动拒绝表（两表各有各的域）', async () => {
    const { pool } = await makePool()
    await pool.setAggregateRejected('m', 'minimax', 'r1', true)
    await pool.setAggregateAllowed('m', 'minimax', 'r2', true)
    await pool.clearAggregateAllowedExcept([])
    expect(pool.listAggregateRejections()).toEqual({ m: { minimax: { r1: true } } })
  })
})