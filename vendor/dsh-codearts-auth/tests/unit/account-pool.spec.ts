import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 伪造的 MockContext。
 *
 * `staleReads` 选项模拟 DSH settings 服务的真实行为：`scope.get()` 返回的是
 * 服务内部的 resolved 快照，`replace()` 之后该快照未必立即更新。开启后
 * get() 会返回上一次 replace() 之前的值——用于复现"连续记录限流互相覆盖"。
 */
function createMockContext(
  initialAccounts: ProviderAccountEntry[] = [],
  options: {
    staleReads?: boolean
    initialDisabledModels?: Record<string, Record<string, boolean>>
    /**
     * 初始的 Loomy 永久积分锁定状态 —— 模拟**升级前**落盘的老状态文档
     * （只有镜像字段、没有独立文档），用于验证一次性迁移。
     *
     * ⚠️ 锁定表本体不在这里：它住在 `$DSH_HOME/jet-hub/permanent-locks.json`
     * （由 `DSH_JET_HUB_STATE_DIR` 指到临时目录），测试用 `readLockDoc()` 读。
     */
    initialLoomyPermanentLocked?: boolean
    /**
     * 让 `replace()` 变成**可乱序的异步写**（模拟 `SettingsStore` 的真实后端）。
     *
     * 入参是本次要写的载荷，返回延迟毫秒数：延迟大的那次 `replace` 会**后**
     * 完成，从而用它**更早**的快照覆盖磁盘。`undefined` = 立即完成
     * （`FileStore` 的同步行为）。
     *
     * ⚠ 这是「磁盘级竞态」用例的唯一复现手段：内存副本总是收敛的，
     * 分叉只发生在 `await store.save(...)` 的**完成顺序**上。
     */
    replaceDelayOf?: (value: { accounts?: ProviderAccountEntry[] }) => number | undefined
    /**
     * 让某次 `replace()` 抛错（模拟落盘失败）。判据是**调用序号**（0 基）。
     *
     * ⚠ 与 `replaceDelayOf` 的区别：这个决定「这次写失不失败」，用于验证
     * 写队列**不被一次失败打断**（见对应用例）。
     */
    failReplaceOf?: (call: number) => boolean
  } = {},
) {
  let stored: {
    accounts?: ProviderAccountEntry[]
    disabledModels?: Record<string, Record<string, boolean>>
    loomyPermanentLocked?: boolean
  } = {
    accounts: initialAccounts,
    ...options.initialDisabledModels !== undefined ? { disabledModels: options.initialDisabledModels } : {},
    ...options.initialLoomyPermanentLocked !== undefined
      ? { loomyPermanentLocked: options.initialLoomyPermanentLocked }
      : {},
  }
  // 滞后读：get() 返回的这个值只在"下一次 replace 之后"才追平
  let visible = stored
  const replaceCalls: Array<ProviderAccountEntry[]> = []
  // 每次 replace 的完整载荷：用于断言「写账号时没有把黑名单抹掉」这类
  // 整体替换语义带来的数据丢失。
  const replacePayloads: Array<Record<string, unknown>> = []
  let replaceCount = 0
  /**
   * 真正「落盘」的那份文档 —— 与 `stored` 的区别是它只被**完成**的写更新。
   *
   * `replaceDelayOf` 未配置时两者恒等（同步后端）；配置后它就是
   * 「进程重启后会读到什么」，也就是竞态的可观测结果。
   */
  let onDisk: typeof stored = stored
  const mockSettings = {
    register: (_ns: string, _schema: unknown) => ({
      get: () => (options.staleReads ? visible : stored),
      replace: async (value: {
        accounts?: ProviderAccountEntry[]
        disabledModels?: Record<string, Record<string, boolean>>
        loomyPermanentLocked?: boolean
      }) => {
        const call = replaceCount
        replaceCount += 1
        if (options.failReplaceOf?.(call) === true) throw new Error('disk full')
        const delay = options.replaceDelayOf?.(value)
        if (delay !== undefined) {
          await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
        }
        if (options.staleReads) {
          // 模拟滞后：get() 始终慢一拍，本次写入要等下一次 replace 才可见
          visible = stored
        }
        stored = value
        // ⚠ 只有**完成**的写才落到"磁盘"上。乱序完成时后写的旧快照会覆盖新快照。
        onDisk = value
        replaceCalls.push(value.accounts ?? [])
        replacePayloads.push(value as Record<string, unknown>)
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: stored }],
  }
  const mockCredentials = new Map<string, string>()
  return {
    replaceCalls,
    replacePayloads,
    /** 已经**完成**的写最后落成的那份文档（= 模拟重启后读到的内容）。 */
    diskAccounts: (): ProviderAccountEntry[] => onDisk.accounts ?? [],
    /**
     * 直接改写「后端里的文档」，用于模拟**同机另一条工作区里的旧版本代码**
     * 全量重写账号池文档（只带它认识的那几个键）。
     */
    overwriteStored(value: Record<string, unknown>): void {
      stored = value as typeof stored
      onDisk = stored
      if (options.staleReads) visible = stored
    },
    logger: { warn: () => {}, info: () => {} },
    get: (key: string) => key === 'settings' ? mockSettings : undefined,
    credentials: {
      describe: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        return { configured: mockCredentials.has(key), source: 'test' as const, writable: true }
      },
      resolve: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        const value = mockCredentials.get(key)
        return value ? { value, source: 'test' as const } : undefined
      },
      set: async (ref: ReturnType<typeof credentialRef>, value: string) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.set(key, value)
      },
      unset: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.delete(key)
      },
    },
  }
}

/**
 * ⚠️ **本文件所有用例都必须把 dsh home 隔离到临时目录**，且必须注册在**模块顶层**。
 *
 * 原因：AccountPool 现在会把「锁定永久积分」写到
 * `$DSH_HOME/jet-hub/permanent-locks.json`（与账号池文档分开，见
 * `src/permanent-lock-store.ts`），而后端定位 home 的顺序是
 * `DSH_JET_HUB_STATE_DIR` → profileContext → `DSH_HOME` → `~/.dsh`。
 * 本文件里多个**平级**的顶层 describe 各自 new AccountPool，钩子挂在某一个
 * describe 内部时其余 describe 拿不到它 —— 那些用例会直接读写**用户真实的
 * `~/.dsh/jet-hub/`**（污染真实锁定状态，且让"默认未锁定"的用例读到用户的
 * 实际值而莫名失败）。
 */
let isolatedHome: string | undefined
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.DSH_JET_HUB_STATE_DIR
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-account-pool-'))
  process.env.DSH_JET_HUB_STATE_DIR = isolatedHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousHome
  if (isolatedHome !== undefined) rmSync(isolatedHome, { recursive: true, force: true })
})

const LOCK_DOC = (): string => join(isolatedHome!, 'jet-hub', 'permanent-locks.json')

beforeEach(() => {
  // 每个用例从干净的锁定文档开始：残留会让「首次迁移」路径被跳过，
  // 于是本应验证迁移的用例其实测的是「读已有文档」。
  rmSync(LOCK_DOC(), { force: true })
})

/** 读临时 home 里的锁定表文档（不存在返回 undefined）。 */
function readLockDoc(): { schema?: string; locks?: Record<string, boolean> } | undefined {
  const file = LOCK_DOC()
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as { schema?: string; locks?: Record<string, boolean> }
}

/**
 * 模拟**另一条工作区里的旧版本代码**全量重写账号池文档：只带它认识的那三个键
 * （旧代码读 `loomyPermanentLocked` 并原样写回，但不认识任何新字段）。
 *
 * 这正是本次改造要防的场景 —— 断言锁定态在重写后依然成立。
 */
function simulateLegacyRewrite(
  ctx: { overwriteStored(value: Record<string, unknown>): void },
  legacyLoomyLocked: boolean,
): void {
  ctx.overwriteStored({ accounts: [], disabledModels: {}, loomyPermanentLocked: legacyLoomyLocked })
}

describe('AccountPool', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  /** 每次通过工厂返回新对象，避免测试间 Object.assign 污染共享引用 */
  function makeMockAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'buddy-001',
      provider: 'buddy',
      nickname: 'test-user',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as any)
  })

  it('should add and list accounts', async () => {
    await pool.addAccount(makeMockAccount())
    const list = await pool.listAccounts('buddy')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('buddy-001')
  })

  it('should filter by provider', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const buddyAccounts = await pool.listAccounts('buddy')
    const codeartsAccounts = await pool.listAccounts('codearts')
    expect(buddyAccounts).toHaveLength(1)
    expect(codeartsAccounts).toHaveLength(1)
  })

  it('should update account', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.updateAccount('buddy-001', { enabled: false })
    const list = await pool.listAccounts('buddy')
    expect(list[0].enabled).toBe(false)
  })

  it('should throw on update for non-existent account', async () => {
    await expect(pool.updateAccount('nonexistent', { enabled: false })).rejects.toThrow('Account nonexistent not found')
  })

  it('should remove account and credential', async () => {
    await pool.addAccount(makeMockAccount())
    // 先设一个凭据，确认删除时清理
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.removeAccount('buddy-001')
    const list = await pool.listAccounts('buddy')
    expect(list).toHaveLength(0)
    const resolved = await ctx.credentials.resolve(credentialRef('BUDDY_ACCOUNT_T1'))
    expect(resolved).toBeUndefined()
  })

  it('should return available account for model', async () => {
    // 为两个账号都设置凭据
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test1' }))
    await pool.addAccount(makeMockAccount())
    // 为第二个账号设置模型限流
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T2'), JSON.stringify({ access_token: 'test2' }))
    await pool.addAccount(makeMockAccount({
      id: 'buddy-002',
      credentialRef: 'BUDDY_ACCOUNT_T2',
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).not.toBeNull()
    expect(result!.entry.id).toBe('buddy-001')
  })

  it('should return null when all accounts rate-limited', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when no accounts at all', async () => {
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential resolve fails', async () => {
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential JSON parse fails', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), 'not-json')
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should update model rate limit', async () => {
    await pool.addAccount(makeMockAccount())
    const resetAt = Date.now() + 7200000
    await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', resetAt)
    const list = await pool.listAccounts('buddy')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(resetAt)
  })

  // ⚠️ 「只接受更长者」是 cline「永远 60 分钟」的**最后一道防线**：各 provider 的解析
  // 末端都有一个短的兜底值（cline 是 1 小时，真值可能是 19h39m），无脑覆盖会让
  // 并发请求里「先写真值、后写兜底」的那个赢，于是每次失败都从当下重算一小时。
  describe('updateModelRateLimit 只接受更长的解禁时刻', () => {
    it('★ 兜底的短值不得覆盖已有的长标记', async () => {
      await pool.addAccount(makeMockAccount())
      const real = Date.now() + 19 * 3600_000 + 39 * 60_000   // 报文里的 19h39m
      const fallback = Date.now() + 3600_000                   // 解析失败的 1 小时兜底
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', real)
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', fallback)
      const list = await pool.listAccounts('buddy')
      expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(real)
    })

    it('更长的值仍能覆盖（兜底先到、真值后到是正常顺序）', async () => {
      await pool.addAccount(makeMockAccount())
      const fallback = Date.now() + 3600_000
      const real = Date.now() + 19 * 3600_000
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', fallback)
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', real)
      const list = await pool.listAccounts('buddy')
      expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(real)
    })

    it('相等时跳过写盘（语义无差别，省一次 IO）', async () => {
      await pool.addAccount(makeMockAccount())
      const at = Date.now() + 3600_000
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', at)
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', at)
      const list = await pool.listAccounts('buddy')
      expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(at)
    })

    it('★ NaN/Infinity 必须被忽略（写进去 = 该模型被永久限流，且 sweep 清不掉）', async () => {
      await pool.addAccount(makeMockAccount())
      const real = Date.now() + 19 * 3600_000
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', real)
      // 三个都不得动既有标记，也不得把非法值写进去
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', Number.NaN)
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', Number.POSITIVE_INFINITY)
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-pro', Number.NaN)
      const list = await pool.listAccounts('buddy')
      const a1 = list.find(a => a.id === 'buddy-001')!
      expect(a1.modelRateLimits?.['deepseek-v4-flash']).toBe(real)
      expect(a1.modelRateLimits?.['deepseek-v4-pro']).toBeUndefined()
    })

    it('现值是非有限的坏数据时，新值应当把它修掉', async () => {
      await pool.addAccount(makeMockAccount({ modelRateLimits: { 'deepseek-v4-flash': Number.NaN } }))
      const t = Date.now() + 3600_000
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', t)
      const list = await pool.listAccounts('buddy')
      expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(t)
    })

    it('不影响别的模型与别的账号', async () => {
      await pool.addAccount(makeMockAccount())
      await pool.addAccount(makeMockAccount({ id: 'buddy-002' }))
      const t = Date.now() + 19 * 3600_000
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', t)
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-pro', t + 1000)
      await pool.updateModelRateLimit('buddy-002', 'deepseek-v4-flash', t + 2000)
      await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', Date.now() + 1000)
      const list = await pool.listAccounts('buddy')
      const a1 = list.find(a => a.id === 'buddy-001')!
      const a2 = list.find(a => a.id === 'buddy-002')!
      expect(a1.modelRateLimits?.['deepseek-v4-pro']).toBe(t + 1000)
      expect(a1.modelRateLimits?.['deepseek-v4-flash']).toBe(t)
      expect(a2.modelRateLimits?.['deepseek-v4-flash']).toBe(t + 2000)
    })
  })

  it('should sweep expired rate limits', async () => {
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() - 1000, 'deepseek-v4-pro': Date.now() + 3600000 },
    }))
    await pool.sweepExpiredRateLimits()
    const list = await pool.listAccounts('buddy')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBeUndefined()
    expect(list[0].modelRateLimits?.['deepseek-v4-pro']).toBeDefined()
  })

  // ── 手动排序（Jet Hub 拖拽）──
  // 顺序即 getAvailableAccount 的候选优先级，故这些用例同时守「持久化」与
  // 「真的影响选号」两件事 —— 只测前者会让拖拽退化成 UI 装饰。
  describe('reorderAccounts', () => {
    /** 建三个同 provider 账号，凭据齐备，便于验证选号结果。 */
    async function seedThree(ids: string[]): Promise<void> {
      for (const id of ids) {
        const ref = `BUDDY_ACCOUNT_${id.toUpperCase()}`
        await ctx.credentials.set(credentialRef(ref), JSON.stringify({ access_token: id }))
        await pool.addAccount(makeMockAccount({ id, credentialRef: ref }))
      }
    }

    it('重排后 listAccounts 顺序随之改变', async () => {
      await seedThree(['a', 'b', 'c'])
      await pool.reorderAccounts('buddy', ['c', 'a', 'b'])
      const list = await pool.listAccounts('buddy')
      expect(list.map(a => a.id)).toEqual(['c', 'a', 'b'])
    })

    it('重排真正影响 getAvailableAccount 的选号结果', async () => {
      await seedThree(['a', 'b', 'c'])
      // 默认顺序取第一个
      expect((await pool.getAvailableAccount('buddy', ''))?.entry.id).toBe('a')
      // 把 c 拖到首位后，自动选号应改用 c
      await pool.reorderAccounts('buddy', ['c', 'b', 'a'])
      expect((await pool.getAvailableAccount('buddy', ''))?.entry.id).toBe('c')
    })

    it('手动顺序优先于「限流重置时间更早」的账号', async () => {
      // 这是本次改动的**核心语义**。早期实现按「重置时间最早到期」重排候选，
      // 会让手动顺序形同虚设。
      //
      // ⚠️ 构造要点（前两版都写错了，说明保留于此）：
      // 1. 查询的 modelId 必须**正是**账号带限流标记的那个模型 ——
      //    否则 `ra - rb` 恒为 0，旧排序根本不换位，测试恒通过；
      // 2. 两个账号都必须**已过限流期**（`Date.now() >= resetAt`），
      //    否则会被候选过滤掉，根本进不了排序。
      const past = Date.now() - 10_000
      const pastLater = Date.now() - 5_000
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_A'), JSON.stringify({ access_token: 'a' }))
      await pool.addAccount(makeMockAccount({
        id: 'a', credentialRef: 'BUDDY_ACCOUNT_A',
        // a 的限流重置时间**更晚**（但都已过期）
        modelRateLimits: { 'deepseek-v4-flash': pastLater },
      }))
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B'), JSON.stringify({ access_token: 'b' }))
      await pool.addAccount(makeMockAccount({
        id: 'b', credentialRef: 'BUDDY_ACCOUNT_B',
        // b 更早 → 旧排序会把 b 排到 a 前面
        modelRateLimits: { 'deepseek-v4-flash': past },
      }))

      // 两者限流均已过期 → 都进候选。手动顺序 a→b，故应取 a；
      // 旧排序按重置时间升序会把 b 提到前面。
      expect((await pool.getAvailableAccount('buddy', 'deepseek-v4-flash'))?.entry.id).toBe('a')
      await pool.reorderAccounts('buddy', ['b', 'a'])
      expect(
        (await pool.getAvailableAccount('buddy', 'deepseek-v4-flash'))?.entry.id,
        '手动顺序未生效：选号仍按限流重置时间重排',
      ).toBe('b')
    })

    it('限流期内的账号被跳过，即使它排在最前（限流豁免）', async () => {
      const limited = Date.now() + 3600000
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_A'), JSON.stringify({ access_token: 'a' }))
      await pool.addAccount(makeMockAccount({
        id: 'a', credentialRef: 'BUDDY_ACCOUNT_A',
        modelRateLimits: { 'deepseek-v4-flash': limited },
      }))
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B'), JSON.stringify({ access_token: 'b' }))
      await pool.addAccount(makeMockAccount({ id: 'b', credentialRef: 'BUDDY_ACCOUNT_B' }))

      // a 排首位但对目标模型限流中 → 应跳到 b
      await pool.reorderAccounts('buddy', ['a', 'b'])
      expect((await pool.getAvailableAccount('buddy', 'deepseek-v4-flash'))?.entry.id).toBe('b')
    })

    it('不影响其他 provider 账号的相对位置与下标', async () => {
      // 账号存在一个全局数组里，而设置页按 provider 分组渲染。
      // 拖 CodeArts 不应顺带改动 Buddy 账号的位置。
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B1'), JSON.stringify({ access_token: 'b1' }))
      await pool.addAccount(makeMockAccount({ id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' }))
      await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_C1'), JSON.stringify({ access_key_id: 'c1' }))
      await pool.addAccount(makeMockAccount({
        id: 'c1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1',
      }))
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B2'), JSON.stringify({ access_token: 'b2' }))
      await pool.addAccount(makeMockAccount({ id: 'b2', credentialRef: 'BUDDY_ACCOUNT_B2' }))

      await pool.reorderAccounts('codearts', ['c1'])
      const all = await pool.listAllAccounts()
      // Buddy 两个账号仍在各自原本的下标（0 与 2），未被挪动
      expect(all.map(a => a.id)).toEqual(['b1', 'c1', 'b2'])
    })

    it('id 集合不一致时抛错且不改动数据（前端列表过期）', async () => {
      await seedThree(['a', 'b', 'c'])
      // 少一个
      await expect(pool.reorderAccounts('buddy', ['a', 'b'])).rejects.toThrow()
      // 多一个未知 id
      await expect(pool.reorderAccounts('buddy', ['a', 'b', 'c', 'zzz'])).rejects.toThrow()
      // 重复 id
      await expect(pool.reorderAccounts('buddy', ['a', 'a', 'b'])).rejects.toThrow()
      // 数据未被破坏
      const list = await pool.listAccounts('buddy')
      expect(list.map(a => a.id)).toEqual(['a', 'b', 'c'])
    })

    it('重排只写账号字段，不抹掉模型黑名单', async () => {
      // writeAccounts 是整体 replace，漏带 disabledModels 会把它清空。
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      await seedThree(['a', 'b', 'c'])
      await pool.reorderAccounts('buddy', ['c', 'b', 'a'])
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    })
  })


  it('should list all accounts', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const all = await pool.listAllAccounts()
    expect(all).toHaveLength(2)
  })

  // ── 停用账号绝不参与自动选择 ──
  // `getAvailableAccount` 是 provider 的凭据入口。停用只意味着"不自动参与
  // 轮换"，因此任何情况下都不能返回停用账号——包括 modelId 为空串时
  //（此时无法做限流过滤，最容易误把停用账号当成候选）。
  describe('停用账号不参与自动选择', () => {
    it('modelId 为空串时也不返回停用账号', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on', provider: 'codearts', enabled: true, credentialRef: 'CA_ON',
      }))

      const result = await pool.getAvailableAccount('codearts', '')
      expect(result).not.toBeNull()
      expect(result!.entry.id).toBe('codearts-on')
    })

    it('仅剩停用账号时返回 null（空 modelId 同样如此）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })

    it('空 modelId 会跳过限流过滤，但启用账号仍被返回', async () => {
      // 空 modelId 的语义：调用方还不知道目标模型，只能退化为"任取一个
      // 启用账号"。此处记录该既有行为，避免日后被误改成"一并过滤"。
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on',
        provider: 'codearts',
        enabled: true,
        credentialRef: 'CA_ON',
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3_600_000 },
      }))

      expect((await pool.getAvailableAccount('codearts', ''))?.entry.id).toBe('codearts-on')
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })
  })

  // ── 限流标记清除（重测/重置的底层能力）──
  describe('clearModelRateLimits', () => {
    it('清空后删除 modelRateLimits 字段本身，不留空对象', async () => {
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 1000 },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001')
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy'))[0].modelRateLimits).toBeUndefined()
    })

    it('只清除指定的模型，其余保留', async () => {
      const keep = Date.now() + 3_600_000
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': keep },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001', ['model-a'])
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy'))[0].modelRateLimits).toEqual({ 'model-b': keep })
    })

    it('对无标记的账号返回 0 且不写盘', async () => {
      await pool.addAccount(makeMockAccount())
      expect(await pool.clearModelRateLimits('buddy-001')).toBe(0)
    })

    it('对不存在的账号返回 0', async () => {
      expect(await pool.clearModelRateLimits('nonexistent')).toBe(0)
    })
  })

  describe('resolveCredentialForAccount（含停用账号）', () => {
    it('停用账号凭据仍可按 id 解析（重测需要）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      const credential = await pool.resolveCredentialForAccount('codearts-off')
      expect(credential).toMatchObject({ access_key_id: 'off' })
      // 但自动选择必须仍然排除它
      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
    })

    it('账号不存在或凭据不可用时返回 undefined', async () => {
      expect(await pool.resolveCredentialForAccount('missing')).toBeUndefined()
      await pool.addAccount(makeMockAccount())  // 未设置凭据
      expect(await pool.resolveCredentialForAccount('buddy-001')).toBeUndefined()
    })
  })

  it('listAccountsByProvider 含停用账号', async () => {
    await pool.addAccount(makeMockAccount({ id: 'on', enabled: true }))
    await pool.addAccount(makeMockAccount({ id: 'off', enabled: false, credentialRef: 'BUDDY_ACCOUNT_T2' }))
    await pool.addAccount(makeMockAccount({ id: 'ca', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))

    expect(pool.listAccountsByProvider('buddy').map(a => a.id).sort()).toEqual(['off', 'on'])
    expect(pool.findAccount('off')?.enabled).toBe(false)
  })

  it('should handle removeAccount of non-existent account gracefully', async () => {
    await pool.removeAccount('nonexistent')
    const list = await pool.listAllAccounts()
    expect(list).toHaveLength(0)
  })

  /**
   * ⚠ **删除与添加并发时不得丢账号**（审查发现）。
   *
   * 原实现是：`const accounts = this.readAccounts()` → `await credentials.unset(...)`
   * → `writeAccounts(accounts.filter(...))` —— 那个 `await` 期间并发的
   * `addAccount` 已经把新条目写进了 `cache` 与磁盘，而回写用的是**await 之前**
   * 的快照 ⇒ 新账号被静默丢弃。`account.create`（登录成功即 addAccount）与
   * `account.delete` 在这台机器上天然可并发（用户点了添加又点删除）。
   *
   * 修复：`await` 之后**重新读一次**再 filter（读到 write 之间没有 await，
   * 这一段是原子的）。
   */
  it('★ removeAccount 与 addAccount 并发时不丢新增的账号', async () => {
    await pool.addAccount(makeMockAccount({ id: 'keep', credentialRef: 'REF_KEEP' }))
    await pool.addAccount(makeMockAccount({ id: 'victim', credentialRef: 'REF_VICTIM' }))

    // 让 unset 真的让出到微任务队列之后（模拟真实 IO），期间插入一次 addAccount。
    const removal = pool.removeAccount('victim')
    await pool.addAccount(makeMockAccount({ id: 'added-later', credentialRef: 'REF_ADDED' }))
    await removal

    const ids = (await pool.listAllAccounts()).map(a => a.id).sort()
    expect(ids).toEqual(['added-later', 'keep'])
  })

  /**
   * ★ **磁盘级**竞态（审查发现的 Blocking；`writeAccounts` 里重读快照修不掉它）。
   *
   * 根因：`SettingsStore.save` 是 `await scope.replace(...)`，**完成顺序可与
   * 发起顺序不同**。上面那条用例只看 `listAllAccounts()`（= `this.cache`，
   * 内存总是收敛），故它在旧实现下也会绿 —— 磁盘分叉是**静默**的。
   *
   * 这里的后端让**第 0 次**写慢 30 ms、第 1 次写立即完成 ⇒ 先发起的删除
   * 最后才落地，把后发起的添加覆盖掉。实测形态（旧实现）：
   * `cache=["added","keep"]` 而 `disk=["keep"]`。
   *
   * 修复后写被 {@link AccountPool} 的 `queueStoreSave` 串行化，磁盘必然
   * 收敛到最后一次排队的快照。
   */
  it('★ 磁盘级：异步后端下并发的删除与添加不得乱序覆盖（模拟 SettingsStore）', async () => {
    /**
     * 让**先发起**的那次写慢 40 ms ⇒ 它后完成，用它更早的快照覆盖磁盘。
     *
     * 判据用载荷内容（而非调用序号），这样无论实现怎么变，被拖慢的恒是
     * 「含 victim 的那一份」= 旧快照。
     */
    const racingCtx = createMockContext([], {
      replaceDelayOf: (value) =>
        (value.accounts ?? []).some(a => a.id === 'victim') ? 40 : undefined,
    })
    const racingPool = new AccountPool(racingCtx as never)

    await racingPool.addAccount(makeMockAccount({ id: 'keep', credentialRef: 'REF_KEEP' }))
    await racingPool.addAccount(makeMockAccount({ id: 'victim', credentialRef: 'REF_VICTIM' }))

    const removal = racingPool.removeAccount('victim')
    await racingPool.addAccount(makeMockAccount({ id: 'added-later', credentialRef: 'REF_ADDED' }))
    await removal

    const memory = (await racingPool.listAllAccounts()).map(a => a.id).sort()
    const disk = racingCtx.diskAccounts().map(a => a.id).sort()
    // ★ 关键断言：磁盘必须与内存一致（旧实现这里 disk 会含 victim 而缺 added-later）。
    expect(disk).toEqual(memory)
    expect(disk).toEqual(['added-later', 'keep'])
  })

  /**
   * ★ 并发的**两个删除**不得让已删账号在磁盘上复活。
   *
   * 旧实现实测：`cache=["keep"]` 而 `disk=["b","keep"]` —— 进程重启后
   * 用户删掉的账号又回来了。
   */
  it('★ 磁盘级：并发删除两个账号时，磁盘上不得残留任何一个', async () => {
    // 拖慢「还含 b」的那一份（= 较旧的快照），让它最后落地。
    const racingCtx = createMockContext([], {
      replaceDelayOf: (value) =>
        (value.accounts ?? []).some(a => a.id === 'b') ? 40 : undefined,
    })
    const racingPool = new AccountPool(racingCtx as never)

    await racingPool.addAccount(makeMockAccount({ id: 'keep', credentialRef: 'REF_KEEP' }))
    await racingPool.addAccount(makeMockAccount({ id: 'a', credentialRef: 'REF_A' }))
    await racingPool.addAccount(makeMockAccount({ id: 'b', credentialRef: 'REF_B' }))

    const first = racingPool.removeAccount('a')
    const second = racingPool.removeAccount('b')
    await Promise.all([first, second])

    const memory = (await racingPool.listAllAccounts()).map(a => a.id).sort()
    const disk = racingCtx.diskAccounts().map(a => a.id).sort()
    expect(disk).toEqual(memory)
    expect(disk).toEqual(['keep'])
  })

  /**
   * ★ 一次落盘失败不得让后续写全部拒绝（写队列的"断链"回归）。
   *
   * 若把队列直接串在会 reject 的 Promise 上，第一次失败后链上所有后续写都会
   * 立刻以同一个错误拒绝 ⇒ 账号池进入**永不落盘**状态（且用户看到的是
   * 「每次都失败」而找不到原因）。
   */
  it('★ 一次落盘失败之后，后续写仍能正常落盘（写队列不得断链）', async () => {
    const ctx = createMockContext([], { failReplaceOf: (call) => call === 0 })
    const brokenPool = new AccountPool(ctx as never)

    // 第一次写必须**照旧抛给调用方**（登录成功后落盘失败不能假装成功）。
    await expect(brokenPool.addAccount(makeMockAccount({ id: 'first', credentialRef: 'REF_1' })))
      .rejects.toThrow('disk full')
    // ★ 第二次必须能成功（若把队列直接串在会 reject 的 Promise 上，这里会永远失败）。
    await brokenPool.addAccount(makeMockAccount({ id: 'second', credentialRef: 'REF_2' }))
    const ids = (await brokenPool.listAllAccounts()).map(a => a.id).sort()
    expect(ids).toEqual(['first', 'second'])
    expect(ctx.diskAccounts().map(a => a.id)).toEqual(['first', 'second'])
  })

  it('should handle updateModelRateLimit for non-existent account gracefully', async () => {
    await pool.updateModelRateLimit('nonexistent', 'deepseek-v4-flash', Date.now() + 3600000)
    // 不会抛出
  })

  /**
   * 回归：settings scope 的 get() 滞后于 replace() 时，连续记录多个账号的
   * 限流不能互相覆盖。
   *
   * 曾经的实现每次都以 scope.get() 为读源，若快照滞后，第二次写入会基于
   * 不含第一次记录的旧快照整体 replace，把前一条限流抹掉——表现为
   * "多个账号都触发过限流，settings.yaml 里却一条 modelRateLimits 都没有"。
   */
  it('keeps earlier rate limits when recording several accounts under a stale scope', async () => {
    const staleCtx = createMockContext([], { staleReads: true })
    const stalePool = new AccountPool(staleCtx as never)

    await stalePool.addAccount(makeMockAccount({ id: 'acct-1', credentialRef: 'BUDDY_ACCOUNT_T1' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-2', credentialRef: 'BUDDY_ACCOUNT_T2' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-3', credentialRef: 'BUDDY_ACCOUNT_T3' }))

    const t1 = Date.now() + 3_600_000
    const t2 = Date.now() + 7_200_000
    const t3 = Date.now() + 10_800_000
    await stalePool.updateModelRateLimit('acct-1', 'deepseek-v4.1-flash', t1)
    await stalePool.updateModelRateLimit('acct-2', 'deepseek-v4.1-flash', t2)
    await stalePool.updateModelRateLimit('acct-3', 'deepseek-v4.1-flash', t3)

    const list = await stalePool.listAllAccounts()
    const limits = list.map(a => a.modelRateLimits?.['deepseek-v4.1-flash'])
    // 三条记录都必须留存（fix 前这里会是 [undefined, undefined, t3] 或类似）
    expect(limits).toEqual([t1, t2, t3])
  })

  describe('getStateSnapshot / replaceAll（备份导入用）', () => {
    it('getStateSnapshot 返回账号与黑名单副本（与进程内解耦）', async () => {
      await pool.addAccount(makeMockAccount())
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      const snapshot = pool.getStateSnapshot()
      expect(snapshot.accounts.map(a => a.id)).toEqual(['buddy-001'])
      expect(snapshot.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
      // 修改快照不应污染进程内权威副本
      snapshot.accounts.push(makeMockAccount({ id: 'buddy-002' }))
      snapshot.disabledModels.buddy!['glm-5.3'] = true
      expect((await pool.listAllAccounts()).map(a => a.id)).toEqual(['buddy-001'])
      expect(pool.disabledModelsFor('buddy').has('glm-5.3')).toBe(false)
    })

    it('replaceAll 整体替换账号与黑名单', async () => {
      await pool.addAccount(makeMockAccount())
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      const incoming = [
        makeMockAccount({ id: 'codearts-9', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_9' }),
      ]
      await pool.replaceAll(incoming, { trae: { 'qwen3.8-flash': true } })
      // 旧账号与旧黑名单被整体清掉
      expect((await pool.listAllAccounts()).map(a => a.id)).toEqual(['codearts-9'])
      expect(pool.disabledModelsFor('buddy').size).toBe(0)
      expect(pool.disabledModelsFor('trae').has('qwen3.8-flash')).toBe(true)
    })

    it('replaceAll 归一化坏条目（丢弃缺 id/provider/credentialRef 的账号）', async () => {
      await pool.addAccount(makeMockAccount())
      // 手工编辑的备份可能带残缺条目：缺 credentialRef 的应被丢弃
      const incoming = [
        makeMockAccount(),
        { id: 'broken', provider: 'buddy' } as ProviderAccountEntry,
      ]
      await pool.replaceAll(incoming, {})
      const list = await pool.listAllAccounts()
      expect(list.map(a => a.id)).toEqual(['buddy-001'])
    })
  })
})

describe('findAccountIdByCredential 的 provider 字段选择', () => {
  it('workbuddy 按 access_token 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_T1'), JSON.stringify({
      access_token: 'WB-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-1', provider: 'workbuddy', nickname: 'WB', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_T1', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('workbuddy', 'WB-TOKEN')).toBe('workbuddy-1')
  })

  it('workbuddy 不会误用 access_key_id 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_T2'), JSON.stringify({
      access_token: 'WB-TOKEN', access_key_id: 'SOMETHING-ELSE', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-2', provider: 'workbuddy', nickname: 'WB', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_T2', createdAt: Date.now(), refreshable: true,
    })
    // 传入 access_token 值应命中
    expect(await pool.findAccountIdByCredential('workbuddy', 'WB-TOKEN')).toBe('workbuddy-2')
    // 传入 access_key_id 值不应命中（说明用的确实是 access_token 字段）
    expect(await pool.findAccountIdByCredential('workbuddy', 'SOMETHING-ELSE')).toBe('')
  })

  it('codearts 仍按 access_key_id 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_T3'), JSON.stringify({
      access_key_id: 'AK-1', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-12-31T00:00:00Z',
    }))
    await pool.addAccount({
      id: 'codearts-1', provider: 'codearts', nickname: 'CA', enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_T3', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('codearts', 'AK-1')).toBe('codearts-1')
  })

  it('buddy 仍按 access_token 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T4'), JSON.stringify({
      access_token: 'BD-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'buddy-4', provider: 'buddy', nickname: 'BD', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T4', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('buddy', 'BD-TOKEN')).toBe('buddy-4')
  })
})

describe('pruneAccountsWithForeignDomain', () => {
  /** WorkBuddy 国际版的判定目标：域名是 www.workbuddy.ai */
  const product = { id: 'workbuddy', apiDomain: 'www.workbuddy.ai' } as never

  it('删除 domain 指向旧端点（中国版）的 WorkBuddy 账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_OLD'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'workbuddy-old', provider: 'workbuddy', nickname: '旧', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_OLD', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual(['workbuddy-old'])
    expect(await pool.listAllAccounts()).toHaveLength(0)
  })

  it('保留 domain 与新端点一致的 WorkBuddy 账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_NEW'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'www.workbuddy.ai',
    }))
    await pool.addAccount({
      id: 'workbuddy-new', provider: 'workbuddy', nickname: '新', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_NEW', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('不触碰其他 provider 的账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    // CodeBuddy 账号的 domain 也是 copilot.tencent.com，但不该被 WorkBuddy 的清理波及
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_KEEP'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'buddy-keep', provider: 'buddy', nickname: 'CB', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_KEEP', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('domain 为空的历史凭据保守保留（无法判定）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_NODOMAIN'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: '',
    }))
    await pool.addAccount({
      id: 'workbuddy-nodomain', provider: 'workbuddy', nickname: '?', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_NODOMAIN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('凭据缺失时不删除（交给正常的「凭据未配置」报错路径）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'workbuddy-nocred', provider: 'workbuddy', nickname: '无', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_MISSING', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('凭据 JSON 损坏时不删除且不抛异常', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_BROKEN'), '{not json')
    await pool.addAccount({
      id: 'workbuddy-broken', provider: 'workbuddy', nickname: '坏', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_BROKEN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('混合场景：只删失配的，保留其余', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    for (const [ref, domain] of [
      ['WORKBUDDY_ACCOUNT_A', 'copilot.tencent.com'],
      ['WORKBUDDY_ACCOUNT_B', 'www.workbuddy.ai'],
      ['WORKBUDDY_ACCOUNT_C', 'copilot.tencent.com'],
    ] as const) {
      await ctx.credentials.set(credentialRef(ref), JSON.stringify({
        access_token: 'AT', refresh_token: 'RT',
        expires_at: String(Date.now() + 3_600_000), domain,
      }))
      await pool.addAccount({
        id: ref.toLowerCase(), provider: 'workbuddy', nickname: ref, enabled: true,
        credentialRef: ref, createdAt: Date.now(), refreshable: true,
      })
    }

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed.sort()).toEqual(['workbuddy_account_a', 'workbuddy_account_c'])
    const left = await pool.listAllAccounts()
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe('workbuddy_account_b')
  })
})

/**
 * 模型黑名单（Jet Hub 的「显示列表」开关）。
 *
 * 语义核心是**黑名单制**：只有被显式关闭的模型会隐藏，未记录的模型
 * 一律默认打开。这保证服务端新增模型时不需要任何配置就能出现在选择器里
 * —— 白名单制会把新模型静默挡在门外，是这套开关最容易踩的坑。
 */
describe('AccountPool 模型黑名单', () => {
  it('未配置时没有任何模型被关闭（默认全开）', () => {
    const pool = new AccountPool(createMockContext() as never)
    expect(pool.disabledModelsFor('buddy').size).toBe(0)
    expect(pool.listDisabledModels('buddy')).toEqual({})
  })

  it('关闭模型后该模型进入黑名单，其余模型不受影响', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)

    const disabled = pool.disabledModelsFor('buddy')
    expect(disabled.has('glm-5.2')).toBe(true)
    // 没被关掉的模型默认打开 —— 黑名单制的关键断言
    expect(disabled.has('deepseek-v4-flash')).toBe(false)
    expect(disabled.has('hy3')).toBe(false)
  })

  it('重新打开时删除条目，而不是写入 false', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.setModelDisabled('buddy', 'glm-5.2', false)

    expect(pool.disabledModelsFor('buddy').size).toBe(0)
    // 打开后 provider 表变空，应当整体从配置里消失（不留 { buddy: {} } 噪音）
    const last = ctx.replacePayloads.at(-1)!
    expect(last.disabledModels).toEqual({})
  })

  it('不同 provider 的黑名单互不影响', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.setModelDisabled('workbuddy', 'gpt-5.4', true)

    expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    expect([...pool.disabledModelsFor('workbuddy')]).toEqual(['gpt-5.4'])
    expect(pool.disabledModelsFor('codearts').size).toBe(0)
  })

  it('关闭多个模型后全部保留', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.setModelDisabled('buddy', 'hy3', true)
    await pool.setModelDisabled('buddy', 'kimi-k2.6', true)

    expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['glm-5.2', 'hy3', 'kimi-k2.6'])
  })

  /**
   * 批量开关（Jet Hub 模型列表的「打开全部 / 关闭全部」）。
   *
   * 两个方向的语义**刻意不对称**，这是需求明确规定的：
   * - 关闭全部（`setModelsDisabled`）：按**当前列表**逐项写入黑名单；
   * - 打开全部（`clearDisabledModels`）：直接**删除该 provider 的全部关闭项**，
   *   不需要模型目录。
   *
   * 拆成两个方法而不是「一个带 disabled 布尔的方法」的理由：两者需要的入参本就
   * 不同（关闭要 id 列表、打开不要），合并只会让调用方传一个打开时被忽略的参数。
   * 不对称还有实质好处：打开全部若也按列表走，那些「曾被关闭、后来从服务端目录
   * 里下线」的历史遗留键永远清不掉 —— 黑名单会积累死键，且残留键将来若被同名
   * 模型复用会莫名隐藏它。
   */
  describe('批量开关（打开全部 / 关闭全部）', () => {
    it('关闭全部：把给定 id 全部写入黑名单', async () => {
      const pool = new AccountPool(createMockContext() as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3', 'kimi-k2.6'])

      expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['glm-5.2', 'hy3', 'kimi-k2.6'])
    })

    it('关闭全部只写一次（不逐条落盘）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3', 'kimi-k2.6'])

      // 逐条写会产生 3 次 replace；批量必须只写一次，否则 30 个模型就是
      // 30 次整体重写 + 30 次目录广播。
      expect(ctx.replacePayloads).toHaveLength(1)
      expect(ctx.replacePayloads[0]!.disabledModels).toEqual({
        buddy: { 'glm-5.2': true, hy3: true, 'kimi-k2.6': true },
      })
    })

    it('关闭全部保留该 provider 原有的其它关闭项', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { buddy: { 'old-model': true } },
      }) as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2'])

      expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['glm-5.2', 'old-model'])
    })

    it('打开全部：清空该 provider 的全部关闭项', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { buddy: { 'glm-5.2': true, hy3: true } },
      }) as never)
      await pool.clearDisabledModels('buddy')

      expect(pool.disabledModelsFor('buddy').size).toBe(0)
    })

    /**
     * 打开全部**不看模型目录**：目录里已下线的历史遗留键同样要清掉。
     *
     * 若按当前目录删除，`gone-model` 这类「曾被关闭、如今已不在目录里」的键会
     * 永远留在黑名单中，用户点「打开全部」却仍有残留。
     */
    it('打开全部：清掉不在当前目录里的历史遗留键', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { buddy: { 'glm-5.2': true, 'gone-model': true } },
      }) as never)
      await pool.clearDisabledModels('buddy')

      expect(pool.listDisabledModels('buddy')).toEqual({})
    })

    it('打开全部后 provider 表整体消失（不留 { buddy: {} } 噪音）', async () => {
      const ctx = createMockContext([], {
        initialDisabledModels: { buddy: { 'glm-5.2': true } },
      })
      const pool = new AccountPool(ctx as never)
      await pool.clearDisabledModels('buddy')

      expect(ctx.replacePayloads.at(-1)!.disabledModels).toEqual({})
    })

    it('批量操作不影响其它 provider 的黑名单', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { workbuddy: { 'gpt-5.4': true } },
      }) as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3'])
      await pool.clearDisabledModels('buddy')

      expect(pool.disabledModelsFor('buddy').size).toBe(0)
      expect([...pool.disabledModelsFor('workbuddy')]).toEqual(['gpt-5.4'])
    })

    it('批量写黑名单不会抹掉账号列表（整体写入语义）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.addAccount({
        id: 'buddy-bulk', provider: 'buddy', nickname: 'B', enabled: true,
        credentialRef: 'BUDDY_ACCOUNT_BULK', createdAt: Date.now(), refreshable: true,
      })
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3'])

      expect(ctx.replacePayloads.at(-1)!.accounts).toHaveLength(1)
      expect(await pool.listAllAccounts()).toHaveLength(1)
    })

    it('关闭全部传空列表时不写盘（没有变更就不该惊动落盘）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setModelsDisabled('buddy', [])

      expect(ctx.replacePayloads).toHaveLength(0)
    })

    it('打开全部在本就为空时不写盘', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.clearDisabledModels('buddy')

      expect(ctx.replacePayloads).toHaveLength(0)
    })
  })

  it('从已有配置载入黑名单', () => {
    const pool = new AccountPool(createMockContext([], {
      initialDisabledModels: { buddy: { 'glm-5.2': true } },
    }) as never)
    const disabled = pool.disabledModelsFor('buddy')
    expect(disabled.has('glm-5.2')).toBe(true)
    expect(disabled.size).toBe(1)
  })

  /**
   * 回归：settings 的 replace() 是**整体替换**。写账号列表时若不带上
   * disabledModels，用户刚设置的模型开关会被下一次账号操作（新增/删除/
   * 限流标记）静默清空。
   */
  it('写账号列表时不会抹掉已有的黑名单', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.addAccount({
      id: 'buddy-x', provider: 'buddy', nickname: 'X', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_X', createdAt: Date.now(), refreshable: true,
    })

    expect(ctx.replacePayloads.at(-1)!.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
    expect(pool.disabledModelsFor('buddy').has('glm-5.2')).toBe(true)
  })

  /** 反向回归：写黑名单时若丢掉账号列表，账号池会被清空。 */
  it('写黑名单时不会抹掉账号列表', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'buddy-y', provider: 'buddy', nickname: 'Y', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_Y', createdAt: Date.now(), refreshable: true,
    })
    await pool.setModelDisabled('buddy', 'glm-5.2', true)

    expect(ctx.replacePayloads.at(-1)!.accounts).toHaveLength(1)
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  /**
   * ⚠️ **永久积分锁定 —— Loomy 那一项**（用户最初要求「需要支持持久化」）。
   *
   * 现在它是 `permanentLocks` 表里的一个键（CodeBuddy / WorkBuddy 各占另一个键，
   * 见下一段）。这里保留 loomy 视角是因为**它是第一个被实现的**，且
   * `loomyPermanentLocked` 那个兼容字段因它而存在。
   *
   * ⚠️ 这是**第三个**整体写入的数据，与 `disabledModels` 当年踩过的坑同型：
   * 任何一处写入漏带它，就会被静默抹掉（用户看到「锁自己解开了」）。
   */
  describe('永久积分锁定（Loomy 那一项）', () => {
    it('默认解锁（未设置时为 false）', () => {
      const pool = new AccountPool(createMockContext() as never)
      expect(pool.permanentLocked('loomy')).toBe(false)
    })

    it('设置后可读回，并落盘到 replace 载荷', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('loomy', true)

      expect(pool.permanentLocked('loomy')).toBe(true)
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
    })

    it('可再解锁', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('loomy', true)
      await pool.setPermanentLocked('loomy', false)
      expect(pool.permanentLocked('loomy')).toBe(false)
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(false)
    })

    /** ⚠️ 新增账号不得抹掉锁定（与黑名单那次同型缺陷）。 */
    it('新增账号不会抹掉锁定', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('loomy', true)
      await pool.addAccount({
        id: 'loomy-x', provider: 'loomy', nickname: 'X', enabled: true,
        credentialRef: 'LOOMY_ACCOUNT_X', createdAt: Date.now(), refreshable: false,
      })

      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
      expect(pool.permanentLocked('loomy')).toBe(true)
    })

    /** ⚠️ 改模型黑名单不得抹掉锁定。 */
    it('写黑名单不会抹掉锁定', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('loomy', true)
      await pool.setModelDisabled('loomy', 'spark-x', true)

      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
      expect(pool.permanentLocked('loomy')).toBe(true)
    })

    /** ⚠️ 反向：写锁定不得抹掉账号与黑名单。 */
    it('写锁定不会抹掉账号列表与黑名单', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.addAccount({
        id: 'buddy-z', provider: 'buddy', nickname: 'Z', enabled: true,
        credentialRef: 'BUDDY_ACCOUNT_Z', createdAt: Date.now(), refreshable: true,
      })
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      await pool.setPermanentLocked('loomy', true)

      const last = ctx.replacePayloads.at(-1)!
      expect(last.accounts).toHaveLength(1)
      expect(last.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
    })

    it('跨实例读回（模拟重启）', async () => {
      const ctx1 = createMockContext()
      await new AccountPool(ctx1 as never).setPermanentLocked('loomy', true)
      // 用第一实例落盘的载荷作为「新进程」的初始状态
      const persisted = ctx1.replacePayloads.at(-1) as { loomyPermanentLocked?: boolean }

      const ctx2 = createMockContext([], {
        initialLoomyPermanentLocked: persisted.loomyPermanentLocked,
      })
      expect(new AccountPool(ctx2 as never).permanentLocked('loomy')).toBe(true)
    })

    it('初始状态为已锁定时可读回（模拟重启后首次载入）', () => {
      const pool = new AccountPool(createMockContext([], {
        initialLoomyPermanentLocked: true,
      }) as never)
      expect(pool.permanentLocked('loomy')).toBe(true)
    })
  })

  /**
   * ⚠️ **按 provider 的永久积分锁定**（用户需求：为 CodeBuddy 与 WorkBuddy
   * 各加一个开关，粒度与 Loomy 一致）。
   *
   * 关键约定：
   * - 三个 provider **各自独立**（两站账号池本就分开，一个的锁定不得影响另一个）；
   * - 表里**只记录已锁定的**（缺键 = 未锁定），故解锁是删键而不是写 false；
   * - `loomyPermanentLocked` 是同一值的兼容副本，必须与表**同源**。
   */
  describe('按 provider 的永久积分锁定', () => {
    it('默认全部解锁（未设置时都是 false）', () => {
      const pool = new AccountPool(createMockContext() as never)
      expect(pool.permanentLocked('loomy')).toBe(false)
      expect(pool.permanentLocked('buddy')).toBe(false)
      expect(pool.permanentLocked('workbuddy')).toBe(false)
      expect(pool.listPermanentLocked()).toEqual([])
    })

    it('锁定一个 provider 不影响其余两个', async () => {
      const pool = new AccountPool(createMockContext() as never)
      await pool.setPermanentLocked('buddy', true)
      expect(pool.permanentLocked('buddy')).toBe(true)
      expect(pool.permanentLocked('workbuddy')).toBe(false)
      expect(pool.permanentLocked('loomy')).toBe(false)
      expect(pool.listPermanentLocked()).toEqual(['buddy'])
    })

    /**
     * ⚠️ **本方案的核心**：锁定表落**独立文档**，账号池文档只带 Loomy 镜像字段。
     *
     * 因为账号池文档是同机多 profile 共享的，旧版本代码全量重写它时不会携带
     * 自己不认识的键 —— 表若住在那儿就会被抹掉，解锁的后果是真烧永久积分。
     */
    it('锁定表落独立文档，账号池文档只带镜像字段', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('workbuddy', true)

      expect(readLockDoc()?.locks).toEqual({ workbuddy: true })
      // 账号池文档里绝不该出现表本体（出现了就等于把它放在会被抹掉的位置）
      const last = ctx.replacePayloads.at(-1)!
      expect('permanentLocks' in last).toBe(false)
      // 表里没有 loomy → 镜像必须是 false，不能跟着一起锁上
      expect(last.loomyPermanentLocked).toBe(false)

      await pool.setPermanentLocked('loomy', true)
      expect(readLockDoc()?.locks).toEqual({ workbuddy: true, loomy: true })
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
    })

    /**
     * ⚠️ 回归用户真实风险的用例：另一条工作区的**旧代码**把账号池文档整体
     * 重写一遍（只带它认识的三个键）之后，本侧的锁定必须**一个都不丢**。
     *
     * 这正是把表拆到独立文档要解决的问题 —— 拆之前，这一步会让
     * buddy / workbuddy 静默解锁（而 Loomy 因镜像字段仍在而侥幸存活）。
     */
    it('旧版本代码全量重写账号池文档后，锁定不丢', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('buddy', true)
      await pool.setPermanentLocked('loomy', true)

      // 旧代码接手：它只认 loomyPermanentLocked，其余按自己的形状写回
      simulateLegacyRewrite(ctx, true)

      const reopened = new AccountPool(ctx as never)
      expect(reopened.permanentLocked('buddy')).toBe(true)
      // Loomy 走镜像也仍然为真
      expect(reopened.permanentLocked('loomy')).toBe(true)

      // 反向：本侧解锁 Loomy 后，旧文档里那个陈旧的 true 不得把它拉回锁定
      await reopened.setPermanentLocked('loomy', false)
      expect(new AccountPool(ctx as never).permanentLocked('loomy')).toBe(false)
    })

    it('解锁是删键（文档里不留 false）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('buddy', true)
      await pool.setPermanentLocked('buddy', false)

      expect(pool.permanentLocked('buddy')).toBe(false)
      expect(readLockDoc()?.locks).toEqual({})
    })

    it('空 provider 名被忽略（不写入无意义的键）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('', true)
      expect(ctx.replacePayloads).toHaveLength(0)
      expect(readLockDoc()).toBeUndefined()
      expect(pool.permanentLocked('')).toBe(false)
    })

    /** ⚠️ 新增账号不得抹掉锁定（与当年 `disabledModels` 同型缺陷）。 */
    it('新增账号不会抹掉 buddy 的锁定', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('buddy', true)
      await pool.addAccount({
        id: 'buddy-x', provider: 'buddy', nickname: 'X', enabled: true,
        credentialRef: 'BUDDY_ACCOUNT_X', createdAt: Date.now(), refreshable: true,
      })

      expect(readLockDoc()?.locks).toEqual({ buddy: true })
      expect(pool.permanentLocked('buddy')).toBe(true)
    })

    /** ⚠️ 改模型黑名单不得抹掉锁定。 */
    it('写黑名单不会抹掉锁定', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('workbuddy', true)
      await pool.setModelDisabled('workbuddy', 'glm-5.2', true)

      expect(readLockDoc()?.locks).toEqual({ workbuddy: true })
      expect(pool.permanentLocked('workbuddy')).toBe(true)
    })

    /** ⚠️ 反向：写锁定不得抹掉账号与黑名单（镜像同步走的是全量写入）。 */
    it('写锁定不会抹掉账号列表与黑名单', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.addAccount({
        id: 'buddy-z', provider: 'buddy', nickname: 'Z', enabled: true,
        credentialRef: 'BUDDY_ACCOUNT_Z', createdAt: Date.now(), refreshable: true,
      })
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      await pool.setPermanentLocked('buddy', true)

      const last = ctx.replacePayloads.at(-1)!
      expect(last.accounts).toHaveLength(1)
      expect(last.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
      expect(last.loomyPermanentLocked).toBe(false)
    })

    /**
     * ⚠️ **只有老字段**的状态文档（升级前落盘的）必须仍能读到锁定。
     * 判错的后果不是显示问题而是**行为**问题：锁定静默失效 → 继续消耗
     * 永久积分 → 用户的损失不可撤回。
     *
     * 迁移同时要**固化到独立文档**：否则每次冷启动都重新读镜像，
     * 而镜像随时可能被另一条工作区改回旧值。
     */
    it('老状态文档只有 loomyPermanentLocked 时迁移并固化', async () => {
      const ctx = createMockContext([], { initialLoomyPermanentLocked: true })
      const pool = new AccountPool(ctx as never)
      expect(pool.permanentLocked('loomy')).toBe(true)
      expect(pool.permanentLocked('buddy')).toBe(false)
      expect(pool.listPermanentLocked()).toEqual(['loomy'])
      // 让迁移的落盘微任务完成（ensureLoaded 里是尽力而为的 void 调用）
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(readLockDoc()?.locks).toEqual({ loomy: true })
    })

    /**
     * ⚠️ 迁移**只在新文档不存在时**生效。
     * 一旦新文档写了（哪怕内容是空表 = 用户明确解锁），镜像字段里残留的
     * `true` 就不能再把锁定打开 —— 否则会出现"解不掉的开关"。
     */
    it('新文档存在后不再回看镜像字段', async () => {
      const ctx = createMockContext([], { initialLoomyPermanentLocked: true })
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('buddy', true)
      await pool.setPermanentLocked('loomy', false)

      // 镜像此刻是 false；把它强行改回 true（模拟另一条工作区写的旧值）
      simulateLegacyRewrite(ctx, true)
      const reopened = new AccountPool(ctx as never)
      expect(reopened.permanentLocked('loomy')).toBe(false)
      expect(reopened.permanentLocked('buddy')).toBe(true)
    })

    it('跨实例读回（模拟重启，含两个 provider）', async () => {
      const pool1 = new AccountPool(createMockContext() as never)
      await pool1.setPermanentLocked('buddy', true)
      await pool1.setPermanentLocked('workbuddy', true)
      expect(readLockDoc()?.locks).toEqual({ buddy: true, workbuddy: true })

      const pool2 = new AccountPool(createMockContext() as never)
      expect(pool2.permanentLocked('buddy')).toBe(true)
      expect(pool2.permanentLocked('workbuddy')).toBe(true)
      expect(pool2.permanentLocked('loomy')).toBe(false)
    })

    /**
     * ⚠️ Loomy 那一项必须**同时写进镜像字段**：老版本宿主只读这一个字段，
     * 缺了它另一条工作区的面板就会显示错的锁定态（而它读它、也原样写回它）。
     */
    it('表里的 Loomy 项同步落到镜像字段，且不被别的 provider 带起来', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setPermanentLocked('loomy', true)
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
      await pool.setPermanentLocked('loomy', false)
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(false)
      await pool.setPermanentLocked('buddy', true)
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(false)
      expect(readLockDoc()?.locks).toEqual({ buddy: true })
    })

    /**
     * ⚠️ 状态快照**不带**表（它在独立文档里）—— 备份导出必须改用
     * `permanentLocksSnapshot()`，漏改会让备份里的锁定永远是空表。
     */
    it('状态快照不带表，锁定另有快照方法', async () => {
      const pool = new AccountPool(createMockContext() as never)
      await pool.setPermanentLocked('buddy', true)
      const snapshot = pool.getStateSnapshot()
      expect('permanentLocks' in snapshot).toBe(false)
      expect(snapshot.loomyPermanentLocked).toBe(false)
      expect(pool.permanentLocksSnapshot()).toEqual({ buddy: true })
    })


    /**
     * ⚠️ 备份导入的三态（与 `backup.ts` 的 `locksFromPayload` 对接）：
     * 给表 = 整体替换；不给（undefined）= **保持当前值**，否则导入一份
     * 老备份会静默解锁用户的永久积分。
     */
    it('replaceAll 给表时整体替换，不给时保持当前值', async () => {
      const pool = new AccountPool(createMockContext() as never)
      await pool.setPermanentLocked('buddy', true)

      await pool.replaceAll([], {}, { workbuddy: true })
      expect(pool.permanentLocked('buddy')).toBe(false)
      expect(pool.permanentLocked('workbuddy')).toBe(true)

      await pool.replaceAll([], {})
      expect(pool.permanentLocked('workbuddy')).toBe(true)
    })

    it('replaceAll 过滤表里的脏值', async () => {
      const pool = new AccountPool(createMockContext() as never)
      await pool.replaceAll([], {}, { buddy: 'yes', workbuddy: true } as never)
      expect(pool.permanentLocked('buddy')).toBe(false)
      expect(pool.permanentLocked('workbuddy')).toBe(true)
    })
  })

  it('配置文件里的脏数据被忽略而不是抛错', () => {
    // 模拟手工编辑过的/老版本的配置文件：数组、字符串、false 都应被丢弃
    const pool = new AccountPool(createMockContext([], {
      initialDisabledModels: {
        buddy: { 'glm-5.2': true, 'hy3': false, 'bad': 'yes' } as never,
        broken: ['glm-5.2'] as never,
      },
    }) as never)

    // 只有显式 true 的条目生效
    expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    // 结构非法的 provider 整层丢弃
    expect(pool.disabledModelsFor('broken').size).toBe(0)
  })

  it('无 settings scope 时降级为内存态，不抛错', async () => {
    const pool = new AccountPool({ get: () => undefined, logger: { warn: () => {}, info: () => {} } } as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    expect(pool.disabledModelsFor('buddy').has('glm-5.2')).toBe(true)
  })

})

/**
 * Gitee issue IKI7WT 的回归：DSH 0.1.7-rc.1 把 `ctx.settings` 换成
 * `SettingsForms`（**没有 `register`**，命名空间只能是 profile 条目 id）。
 * 旧实现因此把账号列表与模型黑名单退化成纯内存 —— 重启即丢。
 * 这里锁死「settings 无 register 时仍要落盘并跨实例存活」。
 */
describe('AccountPool · 0.1.7 契约（settings 无 register）', () => {
  let stateDir: string
  let previousDir: string | undefined

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'account-pool-017-'))
    previousDir = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = stateDir
  })

  afterEach(() => {
    if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
    else process.env.DSH_JET_HUB_STATE_DIR = previousDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  /** 0.1.7 的 SettingsForms 形状：有 describe/configure，但没有 register。 */
  function make017Context() {
    return {
      get: (key: string) => key === 'settings'
        ? { describe: () => [], configure: () => () => {} }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: true, writable: true, source: 'test' as const }),
      },
    }
  }

  it('账号列表与黑名单跨实例存活（本 issue 的核心断言）', async () => {
    const first = new AccountPool(make017Context() as never)
    await first.addAccount({
      id: 'buddy-01700001',
      provider: 'buddy',
      nickname: '0.1.7 用例',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_01700001',
      createdAt: Date.now(),
      refreshable: true,
    })
    await first.setModelDisabled('buddy', 'glm-5.2', true)

    // 新实例 = 模拟重启：必须从磁盘读回，而不是空列表。
    const second = new AccountPool(make017Context() as never)
    expect((await second.listAccounts('buddy')).map(a => a.id)).toEqual(['buddy-01700001'])
    expect(second.disabledModelsFor('buddy').has('glm-5.2')).toBe(true)
  })

  it('写黑名单时不会抹掉账号列表（整体写入语义）', async () => {
    const pool = new AccountPool(make017Context() as never)
    await pool.addAccount({
      id: 'buddy-01700002',
      provider: 'buddy',
      nickname: 'x',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_01700002',
      createdAt: Date.now(),
      refreshable: true,
    })
    await pool.setModelDisabled('buddy', 'hy3', true)

    const reloaded = new AccountPool(make017Context() as never)
    expect((await reloaded.listAccounts('buddy')).map(a => a.id)).toEqual(['buddy-01700002'])
    expect(reloaded.disabledModelsFor('buddy').has('hy3')).toBe(true)
  })
})

describe('AccountPool · TRAE 签到设备轮换代次', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  function makeTraeAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'trae-1',
      provider: 'trae',
      nickname: 'trae-user',
      enabled: true,
      credentialRef: 'TRAE_ACCOUNT_T1',
      createdAt: Date.now(),
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as never)
  })

  it('默认代次为 0（既有账号行为不变）', async () => {
    await pool.addAccount(makeTraeAccount())
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(0)
  })

  it('写入后读回新代次', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 3)
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(3)
  })

  it('只接受更大的代次（防止乱序回调把代次写回小值）', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 5)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 2)
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(5)
  })

  it('非法代次（0 / 负数 / NaN）被忽略', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 0)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', -1)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', Number.NaN)
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(0)
  })

  it('账号不存在时不抛错', async () => {
    await expect(pool.updateTraeCheckinDeviceGeneration('nope', 1)).resolves.toBeUndefined()
    expect(pool.traeCheckinDeviceGenerationFor('nope')).toBe(0)
  })

  it('不破坏同一账号条目的其它字段（modelRateLimits 等）', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateModelRateLimit('trae-1', 'glm-5.2', Date.now() + 60_000)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 2)

    const entry = (await pool.listAccounts('trae')).find(a => a.id === 'trae-1')!
    expect(entry.traeCheckinDeviceGeneration).toBe(2)
    expect(entry.modelRateLimits?.['glm-5.2']).toBeGreaterThan(0)
  })

  /**
   * `hasLoggedInAccount` —— 「没有已登录账号就不显示该 provider 的模型」的判据。
   *
   * 必须由这个测试锁死三条语义（都容易被改错）：
   * 1. 判据是**凭据能否解析**，不是「有没有条目」（`logout()` 只清凭据、留条目）；
   * 2. **不看 `enabled`**（停用只影响自动选号，与是否已登录无关）；
   * 3. CodeArts 的**单凭据 ref** 必须能作为额外判据传入。
   */
  describe('hasLoggedInAccount（模型目录门控判据）', () => {
    it('没有账号条目时返回 false', async () => {
      expect(await pool.hasLoggedInAccount('trae')).toBe(false)
    })

    it('有账号且凭据可解析时返回 true', async () => {
      await pool.addAccount(makeTraeAccount())
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_T1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
    })

    it('⚠️ 有条目但凭据读不到（已登出）时返回 false', async () => {
      // `Auth.logout()` 只 unset 凭据、**保留账号条目**，故不能只看「有条目」，
      // 否则用户登出后模型仍然显示，门控形同虚设。
      await pool.addAccount(makeTraeAccount())
      // 故意不写凭据（等价于 logout 之后的状态）
      expect(await pool.hasLoggedInAccount('trae')).toBe(false)
    })

    it('⚠️ 账号被停用（enabled=false）但凭据仍在时**仍返回 true**', async () => {
      // 停用只影响「自动选号」，不代表「未登录」。若这里返回 false，
      // 把所有账号停用的用户会发现整个 provider 的模型凭空消失 ——
      // 与「续期只看 refreshable、不看 enabled」是同一条既有约定。
      await pool.addAccount(makeTraeAccount({ enabled: false }))
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_T1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
    })

    it('只统计本 provider 的账号（不串号）', async () => {
      await pool.addAccount(makeTraeAccount())
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_T1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
      expect(await pool.hasLoggedInAccount('lobsterai')).toBe(false)
    })

    it('多账号时任一凭据可用即为 true', async () => {
      await pool.addAccount(makeTraeAccount())
      await pool.addAccount(makeTraeAccount({ id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' }))
      // 只有第二个账号的凭据可用
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_2'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
    })

    it('⚠️ 只认账号池条目，不再有「单凭据 ref」例外', async () => {
      // CodeArts 早期的单凭据模式（固定 ref `CODEARTS_ACCESS_TOKEN`）已移除：
      // 即便该 ref 下有凭据，账号池为空时也应返回 false —— 六个 provider 判据一致。
      await ctx.credentials.set(credentialRef('CODEARTS_ACCESS_TOKEN'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('codearts')).toBe(false)
      // 在账号池里登记后才是「已登录」。
      await pool.addAccount({
        id: 'codearts-1',
        provider: 'codearts',
        nickname: 'ca',
        enabled: true,
        credentialRef: 'CODEARTS_ACCOUNT_1',
        createdAt: Date.now(),
        refreshable: true,
      })
      await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('codearts')).toBe(true)
    })
  })
})

/**
 * 供应商级一键开关的账号侧实现：`setAccountsEnabled`。
 *
 * 用「跨实例读回」验证真实落盘（而不只是内存副本）：本类的读源是进程内
 * 权威副本，若只断言同实例的读回，一个「没写磁盘」的实现也能骗过用例。
 *
 * ⚠️ 本节是**独立顶层 describe**（自带 ctx/pool 与工厂）：早期把它追加在
 * `TRAE 签到设备轮换代次` 那个 describe 内部，引用了该作用域不存在的
 * `makeMockAccount`，于是 8 条用例全部以 ReferenceError 失败 —— 追加段落时
 * 必须确认自己落在哪个作用域里。
 */
describe('AccountPool · setAccountsEnabled（供应商级批量启停）', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  /** 本地工厂（与文件顶部同构；不跨 describe 复用，避免作用域耦合）。 */
  function makeMockAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'buddy-001',
      provider: 'buddy',
      nickname: 'test-user',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as never)
  })

  describe('setAccountsEnabled', () => {
    it('停用该 provider 的全部账号，返回实际变更数', async () => {
      await pool.addAccount(makeMockAccount())
      await pool.addAccount(makeMockAccount({ id: 'buddy-002', credentialRef: 'BUDDY_ACCOUNT_T2' }))
      expect(await pool.setAccountsEnabled('buddy', false)).toBe(2)
      const accounts = await pool.listAccounts('buddy')
      expect(accounts.every(a => a.enabled === false)).toBe(true)
    })

    it('启用该 provider 的全部账号', async () => {
      await pool.addAccount(makeMockAccount({ enabled: false }))
      await pool.addAccount(makeMockAccount({ id: 'buddy-002', credentialRef: 'BUDDY_ACCOUNT_T2', enabled: false }))
      expect(await pool.setAccountsEnabled('buddy', true)).toBe(2)
      const accounts = await pool.listAccounts('buddy')
      expect(accounts.every(a => a.enabled === true)).toBe(true)
    })

    it('⚠️ 只改本 provider，不波及其它 provider（账号同存一个全局数组）', async () => {
      await pool.addAccount(makeMockAccount())
      await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
      await pool.setAccountsEnabled('buddy', false)
      const buddy = await pool.listAccounts('buddy')
      const codearts = await pool.listAccounts('codearts')
      expect(buddy[0].enabled).toBe(false)
      expect(codearts[0].enabled).toBe(true)
    })

    it('⚠️ 已是目标状态时返回 0 且**不落盘**（避免无意义的文档重写）', async () => {
      await pool.addAccount(makeMockAccount({ enabled: false }))
      // 每次 replace 都记录载荷；这里断言调用次数不增加。
      const before = ctx.replacePayloads.length
      expect(await pool.setAccountsEnabled('buddy', false)).toBe(0)
      expect(ctx.replacePayloads.length).toBe(before)
    })

    it('该 provider 无账号时返回 0，不抛错', async () => {
      expect(await pool.setAccountsEnabled('qoder', false)).toBe(0)
    })

    it('⚠️ 写账号时不得抹掉模型黑名单（整体替换语义）', async () => {
      await pool.addAccount(makeMockAccount())
      // 先用「关闭全部」写一条黑名单，再改账号状态
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), '{"access_token":"AT"}')
      await pool.setModelsDisabled('buddy', ['glm-5.2'])
      await pool.setAccountsEnabled('buddy', false)
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    })

    it('⚠️ 首次访问即写也必须先载入（否则覆盖磁盘已有账号）', async () => {
      // 构造一个「磁盘上已有账号」的上下文，再用**全新实例**直接写入 ——
      // 若写路径不调 ensureLoaded()，cache 还是空数组，写回会把磁盘账号全抹掉。
      const seeded = createMockContext([
        makeMockAccount(),
        makeMockAccount({ id: 'buddy-002', credentialRef: 'BUDDY_ACCOUNT_T2' }),
      ])
      const first = new AccountPool(seeded as never)
      // 触发一次载入并落盘（写入目标状态）
      await first.setAccountsEnabled('buddy', false)
      const raw = seeded.replacePayloads.at(-1) as { accounts?: ProviderAccountEntry[] }
      expect(raw.accounts).toHaveLength(2)
      expect(raw.accounts?.every(a => a.enabled === false)).toBe(true)
    })

    it('enabled 字段缺失的历史条目视为启用（与适配器的 enabled !== false 一致）', async () => {
      // 老文档可能没有 enabled 字段；关闭时它应被计入变更。
      const legacy = makeMockAccount()
      delete (legacy as { enabled?: boolean }).enabled
      await pool.addAccount(legacy)
      expect(await pool.setAccountsEnabled('buddy', false)).toBe(1)
      const accounts = await pool.listAccounts('buddy')
      expect(accounts[0].enabled).toBe(false)
    })

    it('跨实例读回：确实落盘（不是只改了内存副本）', async () => {
      const seeded = createMockContext([makeMockAccount()])
      const writer = new AccountPool(seeded as never)
      await writer.setAccountsEnabled('buddy', false)
      // 新实例从同一后端载入，应读到停用状态
      const reader = new AccountPool(seeded as never)
      const accounts = await reader.listAccounts('buddy')
      expect(accounts[0].enabled).toBe(false)
    })
  })

  /**
   * 本机 OpenAI 网关开关（`src/openai-gateway/` 的启用态）。
   *
   * 关键约定：缺键语义是**启用**。与永久积分锁定的「缺键 = 解锁」同向，
   * 但判据必须分开 —— 网关开关丢键的后果是「回到默认启用」，绝不能反过来
   * 把一次读取失败变成「网关被静默关掉」。
   */
  describe('本机网关开关', () => {
    it('默认启用（老用户升级后行为不变）', () => {
      expect(new AccountPool(createMockContext() as never).gatewayEnabled()).toBe(true)
    })

    it('关闭后可读回，且跨实例落盘', async () => {
      const seeded = createMockContext([makeMockAccount()])
      const writer = new AccountPool(seeded as never)
      expect(writer.gatewayEnabled()).toBe(true)
      await writer.setGatewayEnabled(false)
      expect(writer.gatewayEnabled()).toBe(false)

      // 新实例从同一后端载入 —— 证明不是只改了内存副本。
      expect(new AccountPool(seeded as never).gatewayEnabled()).toBe(false)
    })

    it('重新打开后可读回 true', async () => {
      const seeded = createMockContext()
      const pool = new AccountPool(seeded as never)
      await pool.setGatewayEnabled(false)
      await pool.setGatewayEnabled(true)
      expect(pool.gatewayEnabled()).toBe(true)
    })

    it('⚠️ 改开关不得抹掉同一文档里的账号与黑名单', async () => {
      // 整体写入语义下，只写开关会把另两份数据抹掉（与 writeAccounts 同约定）。
      const seeded = createMockContext([makeMockAccount()])
      const pool = new AccountPool(seeded as never)
      await pool.setGatewayEnabled(false)

      const raw = seeded.replacePayloads.at(-1) as
        { accounts?: ProviderAccountEntry[]; disabledModels?: Record<string, unknown> }
      expect(raw.accounts).toHaveLength(1)
      expect(raw.disabledModels).toBeDefined()
    })
  })

  /**
   * 账号入库的**观察点**（Gitee issue IKJOZB）。
   *
   * 该 issue 的根因是「冷启动空池 ⇒ 续期调度器不武装 ⇒ 之后登录的账号永不续期」。
   * 修法之一是「账号入库时补武装」，因此 `addAccount` 必须**有一个通知出口**。
   *
   * ⚠️ **为什么钩子挂在 `addAccount` 而不是逐个登录流程**：全仓库有十几处
   * `pool.addAccount(...)` 调用点（每个 provider 的 auth、opencode、RPC 的
   * 导入/恢复分支），逐处接线必然漏 —— 而漏掉的那个 provider 会**静默**地
   * 不被续期，正是本 issue 的形态。`addAccount` 是唯一的入库收口点。
   */
  describe('账号入库通知（issue IKJOZB：登录后必须能重新武装续期调度）', () => {
    it('注册后每次 addAccount 都回调一次，且带上新增的条目', async () => {
      const seeded = createMockContext()
      const pool = new AccountPool(seeded as never)
      const added: ProviderAccountEntry[] = []
      pool.onAccountAdded((entry) => added.push(entry))

      await pool.addAccount(makeMockAccount())
      await pool.addAccount(makeMockAccount({ id: 'buddy-002' }))

      expect(added).toHaveLength(2)
      expect(added[0]?.id).toBe('buddy-001')
      expect(added[1]?.id).toBe('buddy-002')
    })

    it('未注册回调时 addAccount 照常工作（不因缺少订阅者而失败）', async () => {
      const pool = new AccountPool(createMockContext() as never)
      await expect(pool.addAccount(makeMockAccount())).resolves.toBeUndefined()
      expect(await pool.listAllAccounts()).toHaveLength(1)
    })

    it('⚠️ 落盘失败时通知仍要发出（凭据已存在于凭据存储，调度不该被磁盘问题连坐）', async () => {
      const seeded = createMockContext([], { failReplaceOf: () => true })
      const pool = new AccountPool(seeded as never)
      let notified = 0
      pool.onAccountAdded(() => { notified += 1 })

      await expect(pool.addAccount(makeMockAccount())).rejects.toThrow('disk full')
      expect(notified).toBe(1)
    })

    it('⚠️ 回调抛错不得让 addAccount 失败（登录不能因为订阅者写坏了而报错）', async () => {
      const seeded = createMockContext()
      const pool = new AccountPool(seeded as never)
      pool.onAccountAdded(() => { throw new Error('subscriber boom') })

      await expect(pool.addAccount(makeMockAccount())).resolves.toBeUndefined()
      expect(await pool.listAllAccounts()).toHaveLength(1)
    })

    it('多个订阅者都被调用（池与调度器可各自订阅）', async () => {
      const pool = new AccountPool(createMockContext() as never)
      const seen: string[] = []
      pool.onAccountAdded(() => seen.push('a'))
      pool.onAccountAdded(() => seen.push('b'))
      await pool.addAccount(makeMockAccount())
      expect(seen).toEqual(['a', 'b'])
    })
  })

  /**
   * 供应商自定义显示顺序（「供应商开关」弹窗拖拽排序，2026-10-06）。
   *
   * 与网关开关同级的「可逆展示偏好」：丢键 = 回到声明顺序，用户重拖一次即恢复，
   * 故住 state.json 即可、无需独立文档。⚠️ 与 gatewayEnabled 同一红线：
   * 写顺序不得抹掉同一文档里的账号与黑名单（整体写入语义）。
   */
  describe('供应商自定义显示顺序', () => {
    it('默认空数组（未自定义 = 按声明顺序渲染）', () => {
      expect(new AccountPool(createMockContext() as never).providerOrder()).toEqual([])
    })

    it('写入后可读回，且跨实例落盘', async () => {
      const seeded = createMockContext([makeMockAccount()])
      const writer = new AccountPool(seeded as never)
      await writer.setProviderOrder(['zcode', 'buddy', 'codearts'])
      expect(writer.providerOrder()).toEqual(['zcode', 'buddy', 'codearts'])

      // 新实例从同一后端载入 —— 证明不是只改了内存副本。
      expect(new AccountPool(seeded as never).providerOrder()).toEqual(['zcode', 'buddy', 'codearts'])
    })

    it('相同顺序重复写入不触发落盘', async () => {
      const seeded = createMockContext([makeMockAccount()])
      const pool = new AccountPool(seeded as never)
      await pool.setProviderOrder(['buddy', 'zcode'])
      const writes = seeded.replacePayloads.length
      await pool.setProviderOrder(['buddy', 'zcode'])
      expect(seeded.replacePayloads.length).toBe(writes)
    })

    it('⚠️ 写顺序不得抹掉同一文档里的账号与黑名单', async () => {
      const seeded = createMockContext([makeMockAccount()])
      const pool = new AccountPool(seeded as never)
      await pool.setProviderOrder(['buddy', 'zcode'])

      const raw = seeded.replacePayloads.at(-1) as
        { accounts?: ProviderAccountEntry[]; disabledModels?: Record<string, unknown>; providerOrder?: string[] }
      expect(raw.accounts).toHaveLength(1)
      expect(raw.disabledModels).toBeDefined()
      expect(raw.providerOrder).toEqual(['buddy', 'zcode'])
    })
  })
})
