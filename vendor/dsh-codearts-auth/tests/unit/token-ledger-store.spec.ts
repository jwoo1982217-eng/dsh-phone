/**
 * 「Token 账本日聚合持久化」的单测（第 2 期）。
 *
 * ⚠️ 用**内存后端的等价物**（临时目录里的 FileLedgerStore）跑真实读写，
 * 而不是 mock 掉 fs —— 落盘格式（`{schema, days}`）与载入钳制才是本文件
 * 要锁的契约。
 */
import { mkdtempSync, existsSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTokenLedgerStore } from '../../src/token-ledger-store.js'
import type { TokenLedgerEntry } from '../../src/token-ledger.js'

function makeEntry(over: Partial<Omit<TokenLedgerEntry, 'ts'>> = {}): Omit<TokenLedgerEntry, 'ts'> {
  return {
    channel: 'direct',
    provider: 'codearts',
    model: 'GLM-5.2',
    usageReported: true,
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 100,
    ...over,
  }
}

describe('createTokenLedgerStore（文件后端）', () => {
  it('append 后 flush 落盘；新实例 load 读回一致', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const store = createTokenLedgerStore({ logger: undefined, get: () => undefined } as never)
    // ⚠️ createTokenLedgerStore 走 resolveJetHubHome(ctx)：无 profileContext 时
    // 落 ~/.dsh —— 绝不能让测试写真实用户目录。这里用 env 隔离（与全局 setup 同理）。
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store2 = createTokenLedgerStore({ logger: undefined } as never)
      store2.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry() })
      store2.flush()
      const file = join(home, 'jet-hub', 'token-ledger.json')
      expect(existsSync(file)).toBe(true)
      // 落盘格式带 schema 标记
      const doc = JSON.parse(readFileSync(file, 'utf-8')) as { schema?: string; days?: unknown }
      expect(doc.schema).toContain('token-ledger/v1')

      // 新实例读回：累计值一致
      const store3 = createTokenLedgerStore({ logger: undefined } as never)
      const days = store3.load()
      const buckets = days.get('2026-10-05')!
      expect(buckets.get('direct|codearts||GLM-5.2')!.inputTokens).toBe(10)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
    void store
  })

  it('append 持续合并到同一日桶（多次 append 不增行）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store = createTokenLedgerStore({ logger: undefined } as never)
      for (let i = 0; i < 5; i++) {
        store.append({ ts: Date.UTC(2026, 9, 5, 3, i, 0), ...makeEntry({ inputTokens: 1 }) })
      }
      store.flush()
      const days = store.load()
      const bucket = days.get('2026-10-05')!.get('direct|codearts||GLM-5.2')!
      expect(bucket.requests).toBe(5)
      expect(bucket.inputTokens).toBe(5)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  it('文档损坏按空表处理（不抛错、不阻断启动）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      mkdirSync(join(home, 'jet-hub'), { recursive: true })
      writeFileSync(join(home, 'jet-hub', 'token-ledger.json'), '{broken json', 'utf-8')
      const store = createTokenLedgerStore({ logger: { warn: () => {} } } as never)
      expect(store.load().size).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ★ 回归（复审发现的真实缺陷）：**重启后第一次落盘不得抹掉盘上的历史日**。
   *
   * 原实现 `createTokenLedgerStore` 建实例时**从不读盘**，`index.ts` 也没先读，
   * 于是新进程的 `this.days` 是空表，`flush()` 用空表**整体覆盖**文档 ⇒ 每次重启
   * DSH 历史日聚合归零，与 README 承诺的「重启保留 90 天」正好相反。
   *
   * ⚠️ 这条必须**两个实例**才照得出来：原有用例每条只建一个 store，永远不会
   * 出现「空表覆盖盘上数据」的窗口。
   */
  it('★ 重启：新实例首次落盘不得抹掉盘上历史日（构造时必须先读盘）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-restart-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const readDays = (): Record<string, Record<string, { inputTokens: number }>> =>
        (JSON.parse(readFileSync(file, 'utf-8')) as { days?: Record<string, Record<string, { inputTokens: number }>> }).days ?? {}

      // ── 会话 1：历史日 10-01 记一笔并落盘 ──
      const first = createTokenLedgerStore({ logger: undefined } as never)
      first.append({ ts: Date.UTC(2026, 9, 1, 2, 0, 0), ...makeEntry() })
      first.flush()
      const key = 'direct|codearts||GLM-5.2'
      expect(readDays()['2026-10-01']![key]!.inputTokens).toBe(10)

      // ── 模拟进程重启：全新实例（**不手工读盘**，复现 index.ts 的真实路径）──
      const second = createTokenLedgerStore({ logger: undefined } as never)
      second.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ inputTokens: 7 }) })
      second.flush()

      // 历史日必须仍在（修复前这里整个日键消失）
      expect(Object.keys(readDays())).toContain('2026-10-01')
      expect(readDays()['2026-10-01']![key]!.inputTokens).toBe(10)
      // 新写入的日也在
      expect(readDays()['2026-10-05']![key]!.inputTokens).toBe(7)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ★ 回归（复审发现的真实缺陷）：**运行中读取日聚合不得覆盖尚未落盘的计数**。
   *
   * RPC 的历史视图每次打开弹窗 / 切窗口都会取一次日聚合表。原实现把它接成
   * 「每次重新读盘」，而读盘对**桶**是整体替换（`target.set(key, {…})`）⇒ 防抖
   * 窗口（2 秒）内累加过的桶被打回盘上的旧值，并被随后的自动 flush **固化到磁盘**。
   *
   * 契约：读盘**只在构造时发生一次**；此后 `load()` 是纯内存读。
   */
  it('★ 运行中读取不得覆盖未落盘的计数（读盘只在构造时一次）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-read-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store = createTokenLedgerStore({ logger: undefined } as never)
      const key = 'direct|codearts||GLM-5.2'
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const mem = (): number => store.load().get(today)?.get(key)?.inputTokens ?? 0

      // 3 笔 → 落盘
      for (let i = 0; i < 3; i++) store.append({ ts: Date.now(), ...makeEntry() })
      store.flush()
      expect(mem()).toBe(30)

      // 再记 3 笔（防抖窗口内，尚未落盘）
      for (let i = 0; i < 3; i++) store.append({ ts: Date.now(), ...makeEntry() })
      expect(mem()).toBe(60)

      // 读侧再取一次（模拟打开历史视图）—— 修复前这里被盘上旧值打回 30
      expect(mem()).toBe(60)
      expect(store.load().get(today)?.get(key)?.requests).toBe(6)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ★ 回归（审计发现的真实缺陷，上游首轮修复未覆盖）：**两个实例并存时，
   * 后 flush 者不得抹掉先者的数据** —— `flush()` 必须是**增量合并写**。
   *
   * 场景来自 fiber 重启交错（旧 store 未 dispose、新 store 已 apply）。首轮修复
   * 只做到「新实例构造时读盘」（解决**顺序**：新实例是旧数据的超集），但两个实例
   * **并存**时各自内存视图独立，整体覆盖会互相抹掉。实测双向丢失：
   *
   * ```
   * O 记 100（未 flush）        : 盘 = 0
   * N 记 1 并 flush             : 盘 = 1
   * O.flush()（旧 fiber dispose）: 盘 = 100   ← N 的 1 被抹掉
   * N 再记 5 并 flush           : 盘 = 6     ← O 的 100 也丢（期望 106）
   * ```
   */
  it('★ 两实例并存：后 flush 者不得抹掉先者的数据（增量合并写）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-clobber-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const key = 'direct|codearts||GLM-5.2'
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const disk = (): number => {
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days?: Record<string, Record<string, { inputTokens: number }>> }
        return doc.days?.[today]?.[key]?.inputTokens ?? 0
      }

      // 旧 fiber 的 store（O）与新 fiber 的 store（N）并存
      const older = createTokenLedgerStore({ logger: undefined } as never)
      older.append({ ts: Date.now(), ...makeEntry({ inputTokens: 100 }) }) // 尚未 flush

      const newer = createTokenLedgerStore({ logger: undefined } as never)
      newer.append({ ts: Date.now(), ...makeEntry({ inputTokens: 1 }) })
      newer.flush()
      expect(disk()).toBe(1)

      // 旧 fiber 的 dispose：不得抹掉 N 刚写进去的 1
      older.flush()
      expect(disk(), '旧实例 flush 后不得抹掉新实例的数据').toBe(101)

      // 新实例继续记账：两边的数据都要在（不是互相覆盖）
      newer.append({ ts: Date.now(), ...makeEntry({ inputTokens: 5 }) })
      newer.flush()
      expect(disk(), '双向都不得丢').toBe(106)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ★ 回归（审计发现）：**跨进程可见性** —— 另一实例在本次构造之后写盘的数据，
   * 必须能被本次 flush 合并进去，而不是被自己的滞后视图覆盖。
   *
   * 这是同机多 profile 共享同一 home 的真实场景（`permanent-lock-store.ts` 开篇
   * 与本文档模块头均已记载该共享关系）。
   */
  it('★ 别实例后写的数据不被本实例覆盖（跨实例可见性）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-visible-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const key = 'direct|codearts||GLM-5.2'
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const disk = (): number => {
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days?: Record<string, Record<string, { inputTokens: number }>> }
        return doc.days?.[today]?.[key]?.inputTokens ?? 0
      }

      const a = createTokenLedgerStore({ logger: undefined } as never)
      a.append({ ts: Date.now(), ...makeEntry({ inputTokens: 100 }) })
      a.flush()

      const b = createTokenLedgerStore({ logger: undefined } as never) // B 构造时看到 100
      a.append({ ts: Date.now(), ...makeEntry({ inputTokens: 50 }) })
      a.flush() // 盘 = 150

      // B 自己的内存视图滞后，但它 flush 时必须把 A 的 50 合并保留
      b.append({ ts: Date.now(), ...makeEntry({ inputTokens: 7 }) })
      b.flush()
      expect(disk(), 'A 后写的 50 不得被 B 抹掉').toBe(157)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /** 合并写不得重复计数：反复 flush 幂等（基线前移后增量应为 0）。 */
  it('★ 反复 flush 不重复计数（增量基线正确前移）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-idem-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const key = 'direct|codearts||GLM-5.2'
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const disk = (): number => {
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days?: Record<string, Record<string, { inputTokens: number }>> }
        return doc.days?.[today]?.[key]?.inputTokens ?? 0
      }
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.now(), ...makeEntry({ inputTokens: 10 }) })
      store.flush()
      expect(disk()).toBe(10)
      store.flush()
      store.flush()
      expect(disk(), '重复 flush 不得累加').toBe(10)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ★ 回归（审计发现并原样复现：R1「幽灵日」）：**外部删除的日键不得被重建为全 0 桶**。
   *
   * 场景：盘上某日键被外部删除（手工编辑 / 另一工作区的**旧版本整体覆盖** /
   * 从备份恢复 —— 后者在 `permanent-lock-store.ts` 开篇有同类记载），而本实例
   * 内存里仍留着它。若 flush 全量遍历、delta=0 也写入，该日会被**重建为全 0 桶**：
   * 内存里还是真值（被掩盖），**重启后变成 0 且不可恢复**。
   *
   * 判据：零增量的桶必须**完全不碰**盘上那一格。
   */
  it('★ 幽灵日：外部删除的日键不得被零增量重建（否则重启后真值变 0）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-ghost-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const key = 'direct|codearts||GLM-5.2'
      const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const today = shifted.toISOString().slice(0, 10)
      const yesterday = new Date(shifted.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      type Doc = { schema?: string; days?: Record<string, Record<string, Record<string, unknown>>> }
      const readDoc = (): Doc => JSON.parse(readFileSync(file, 'utf-8')) as Doc

      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.now() - 24 * 60 * 60 * 1000, ...makeEntry({ inputTokens: 20 }) })
      store.append({ ts: Date.now(), ...makeEntry({ inputTokens: 30 }) })
      store.flush()
      expect(readDoc().days![yesterday]).toBeDefined()

      // 外部删掉「昨天」日键
      const doc = readDoc()
      delete doc.days![yesterday]
      writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')

      // 本实例再记一笔（内存里昨天仍是 20）并 flush
      store.append({ ts: Date.now(), ...makeEntry({ inputTokens: 1 }) })
      store.flush()

      expect(readDoc().days![yesterday], '被外部删除的日键不得被重建').toBeUndefined()
      // 今天的数据照常累加（不能因跳过零增量而漏记）
      expect(readDoc().days![today]![key]!.inputTokens).toBe(31)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /** 零增量时不得重写文件（内容与 mtime 都不该变）—— 幽灵日的另一面。 */
  it('★ 无增量时 flush 不重写文件', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-noop-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.now(), ...makeEntry({ inputTokens: 5 }) })
      store.flush()
      const before = readFileSync(file, 'utf-8')
      const mtimeBefore = statSync(file).mtimeMs
      // 不再 append，直接再 flush：应无增量可写
      store.flush()
      expect(readFileSync(file, 'utf-8'), '内容不该变').toBe(before)
      expect(statSync(file).mtimeMs, '不该重写文件').toBe(mtimeBefore)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ★ 回归（审计变异测试发现真缺口）：**纯失败请求必须落盘**。
   *
   * 一笔 `usageReported: false` 的失败请求，其 token 字段**全为 0**，但
   * `requests` / `errors` 各为 1。若 `isZeroBucket` 的判据被收窄成「只看 token」
   * 它就会被当成「零增量」跳过 ⇒ **失败次数永远不入盘**（UI 的失败行与错误计数
   * 静默丢失）。
   *
   * ⚠️ 本用例守护的正是 `isZeroBucket` 的**全字段**判据：实测把该函数改成
   * 「只查 inputTokens/outputTokens」后，其余 11 条用例**全部仍绿**，只有本条变红。
   */
  it('★ 纯失败请求（token 全 0 但 requests/errors 为 1）必须落盘', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-failed-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const key = 'direct|codearts||GLM-5.2'
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      type Bucket = { requests: number; errors: number; reportedRequests: number; inputTokens: number }
      const bucket = (): Bucket | undefined => {
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days?: Record<string, Record<string, Bucket>> }
        return doc.days?.[today]?.[key]
      }
      const failed = {
        ...makeEntry({ inputTokens: 0, outputTokens: 0 }),
        usageReported: false,
        error: 'upstream 502',
      }

      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.now(), ...failed })
      store.flush()
      expect(bucket()?.requests, '失败请求必须计入 requests').toBe(1)
      expect(bucket()?.errors, '失败请求必须计入 errors').toBe(1)
      expect(bucket()?.inputTokens).toBe(0)

      // 第二笔纯失败：增量必须继续累加（不是被"看起来全 0"吞掉）
      store.append({ ts: Date.now(), ...failed })
      store.flush()
      expect(bucket()?.requests).toBe(2)
      expect(bucket()?.errors).toBe(2)
      expect(bucket()?.reportedRequests, '未报 usage 的请求不计入 reportedRequests').toBe(0)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  it('account 维度进入桶键（第 2 期）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-store-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ accountId: 'acct-9' }) })
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 1, 0), ...makeEntry({ accountId: 'acct-9', inputTokens: 3 }) })
      const bucket = store.load().get('2026-10-05')!.get('direct|codearts|acct-9|GLM-5.2')!
      expect(bucket.requests).toBe(2)
      expect(bucket.inputTokens).toBe(13)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })
})

afterEach(() => {
  // 每条用例后不再有共享状态（store 按用例新建，env 在用例内恢复）。
})
