/**
 * 「Token 账本日聚合持久化」的单测（第 2 期）。
 *
 * ⚠️ 用**内存后端的等价物**（临时目录里的 FileLedgerStore）跑真实读写，
 * 而不是 mock 掉 fs —— 落盘格式（`{schema, days}`）与载入钳制才是本文件
 * 要锁的契约。
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
  it('超过 5 分钟但持有进程仍存活时不得回收写锁', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-live-lock-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    const lockPath = join(home, 'jet-hub', 'token-ledger.json.lock')
    try {
      mkdirSync(lockPath, { recursive: true })
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'live-owner' }))
      const old = new Date(Date.now() - 10 * 60 * 1000)
      utimesSync(lockPath, old, old)

      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.flush()

      expect(existsSync(join(lockPath, 'owner.json'))).toBe(true)
      expect(existsSync(join(home, 'jet-hub', 'token-ledger.json'))).toBe(false)
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

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
      expect(doc.schema).toContain('token-ledger/v2')

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

  it('deleteDay 只删除选中日期；重启与后续新请求都不会恢复旧累计', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-delete-day-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ inputTokens: 20 }) })
      store.append({ ts: Date.UTC(2026, 9, 6, 2, 0, 0), ...makeEntry({ inputTokens: 30 }) })
      store.flush()

      expect(store.deleteDay('2026-10-05')).toBe(true)
      expect(store.load().has('2026-10-05')).toBe(false)
      expect(store.load().get('2026-10-06')?.get('direct|codearts||GLM-5.2')?.inputTokens).toBe(30)
      store.flush()

      const file = join(home, 'jet-hub', 'token-ledger.json')
      const saved = JSON.parse(readFileSync(file, 'utf-8')) as { days: Record<string, unknown> }
      expect(Object.keys(saved.days)).toEqual(['2026-10-06'])

      // 删除后当天的新请求从零开始，不会把已删历史基线重新加回来。
      const restarted = createTokenLedgerStore({ logger: undefined } as never)
      restarted.append({ ts: Date.UTC(2026, 9, 5, 3, 0, 0), ...makeEntry({ inputTokens: 2 }) })
      restarted.flush()
      const next = createTokenLedgerStore({ logger: undefined } as never).load()
      expect(next.get('2026-10-05')?.get('direct|codearts||GLM-5.2')?.inputTokens).toBe(2)
      expect(next.get('2026-10-06')?.get('direct|codearts||GLM-5.2')?.inputTokens).toBe(30)
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

  /**
   * ⚠️⚠️ **落盘读取不得比写入更严**（真实缺陷，实测复现）。
   *
   * 写入侧允许 `model: ''`（既有语义：`token-ledger-wiring.spec.ts` 的
   * 「model 缺失/垃圾值记空串不抛错」把它锁为既定行为），而首版 store 另写了一个
   * 要求 model 非空的 `isValidBucketKey` ⇒ 这类桶写盘后**重启读不回**，该日用量
   * 静默消失（实测：盘中确实写着 `inputTokens: 77`，新实例 `load()` 桶数为 0）。
   *
   * 判据必须是**一套**（`token-ledger.ts` 的 `parseDayBucketKey`），本用例锁死
   * 「写入 → 落盘 → 新实例读回」这条链上不丢数据。
   */
  it('★ 空 model / 空 account 的桶必须能读回（写入与读取判据同构）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-empty-model-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const store = createTokenLedgerStore({ logger: undefined } as never)
      // model 空串（options.model 缺失时的既有取值）
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ model: '', inputTokens: 77 }) })
      // account 空串（单账号 provider 的合法取值）
      store.append({ ts: Date.UTC(2026, 9, 6, 2, 0, 0), ...makeEntry({ accountId: '', inputTokens: 5 }) })
      store.flush()

      const file = join(home, 'jet-hub', 'token-ledger.json')
      const saved = JSON.parse(readFileSync(file, 'utf-8')) as { days: Record<string, Record<string, { inputTokens: number }>> }
      expect(Object.keys(saved.days['2026-10-05']!), '空 model 的桶必须真的落盘').toEqual(['direct|codearts||'])
      expect(saved.days['2026-10-05']!['direct|codearts||']!.inputTokens).toBe(77)

      // ★ 关键断言：新实例（模拟重启）必须读回，而不是被校验丢弃
      const restarted = createTokenLedgerStore({ logger: undefined } as never)
      expect(restarted.load().get('2026-10-05')?.get('direct|codearts||')?.inputTokens, '空 model 桶重启后丢失').toBe(77)
      expect(restarted.load().get('2026-10-06')?.get('direct|codearts||GLM-5.2')?.inputTokens, '空 account 桶重启后丢失').toBe(5)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  it('桶键段数 / channel 取值非法的条目仍被拒绝（放宽不得放进脏键）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-badkey-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      mkdirSync(join(home, 'jet-hub'), { recursive: true })
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const bucket = { requests: 1, reportedRequests: 1, inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, errors: 0, ttftSumMs: 0, ttftCount: 0, tpsSum: 0, tpsCount: 0 }
      writeFileSync(file, JSON.stringify({
        schema: 'dsh-codearts-auth/token-ledger/v2',
        days: {
          '2026-10-05': {
            'direct|codearts||GLM-5.2': bucket,   // 合法
            'direct|codearts': bucket,            // 段数不足
            'nope|codearts||M': bucket,           // channel 非法
            'direct|codearts||M|extra': bucket,   // 段数过多
          },
        },
      }))
      const store = createTokenLedgerStore({ logger: undefined } as never)
      expect([...store.load().get('2026-10-05')!.keys()]).toEqual(['direct|codearts||GLM-5.2'])
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ⚠️⚠️ **损坏搬走后 flush 只写增量、不替用户"复活"历史**（有意的取舍，勿改回去）。
   *
   * 曾经实现「主文件不在 ⇒ 用内存真值全量重建」，但**实测证明该防线方向性地错**：
   * 「主文件不存在」这个信号至少对应三种情形，而**它们在磁盘上完全同形** ——
   *
   * | 场景 | 期望 | 全量重建 |
   * |---|---|---|
   * | 损坏被搬成 `.corrupt-*` | 救回 | ✅ |
   * | **用户主动 `rm` 整个账本** | **尊重删除** | ❌ **复活已删历史** |
   * | 另一实例先重建了新文档 | 救回 | ❌ 判据不成立，照旧丢 |
   *
   * ⇒ 单侧启发式必然做反一半。本用例锁定当前语义：**只写增量，不复活**。
   * 保护下限是「损坏原件留档 `.corrupt-*`，可人工恢复」+「本进程内 UI 仍读内存」。
   */
  it('★ 损坏搬走后只写增量：既不留档丢失，也不复活历史（取舍用例）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-corrupt-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ inputTokens: 100 }) })
      store.append({ ts: Date.UTC(2026, 9, 6, 2, 0, 0), ...makeEntry({ inputTokens: 30 }) })
      store.flush()

      // 外部把账本写坏（手工编辑 / 旧版本整体覆盖）
      writeFileSync(file, '{ broken json')

      // 同一实例继续记账并 flush：readFile 会搬走损坏文件（留档），随后只写增量
      store.append({ ts: Date.UTC(2026, 9, 7, 2, 0, 0), ...makeEntry({ inputTokens: 7 }) })
      store.flush()

      // ① 损坏原件必须留档（这是本取舍的「保护下限」：可人工恢复）
      expect(readdirSync(join(home, 'jet-hub')).some((name) => name.includes('.corrupt-')), '损坏原件必须留档').toBe(true)
      expect(existsSync(file), '主文件应被子序列写重建').toBe(true)

      // ② 本次增量必须落下（不能因为文档损坏就把新数据也丢了）
      const days = JSON.parse(readFileSync(file, 'utf-8')).days as Record<string, Record<string, { inputTokens: number }>>
      expect(days['2026-10-07']?.['direct|codearts||GLM-5.2']?.inputTokens, '本次增量丢失').toBe(7)
      // ③ 内存视图在本进程内仍然完整（UI 读的是内存，不受盘上取舍影响）
      expect(store.load().get('2026-10-05')?.get('direct|codearts||GLM-5.2')?.inputTokens).toBe(100)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ⚠️⚠️ **用户主动删除整个账本后，flush 不得把历史"复活"**（真实缺陷，实测复现）。
   *
   * 这是上一条取舍的**另一半**：`rm` 掉文件与「损坏被搬走」在磁盘上同形
   * （`existsSync === false`），旧实现的全量重建防线会让被删的日全部回来 ——
   * 直接覆盖用户清空历史的意图。本用例锁死新语义。
   */
  it('★ 用户主动 rm 整个账本后，flush 不得复活已删历史', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-user-del-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ inputTokens: 100 }) })
      store.append({ ts: Date.UTC(2026, 9, 6, 2, 0, 0), ...makeEntry({ inputTokens: 30 }) })
      store.flush()

      rmSync(file) // 用户主动清空历史的最直接做法
      store.append({ ts: Date.UTC(2026, 9, 7, 2, 0, 0), ...makeEntry({ inputTokens: 7 }) })
      store.flush()

      const days = JSON.parse(readFileSync(file, 'utf-8')).days as Record<string, unknown>
      expect(days['2026-10-05'], '用户删掉的历史被复活了').toBeUndefined()
      expect(days['2026-10-06'], '用户删掉的历史被复活了').toBeUndefined()
      expect(days['2026-10-07'], '用户删除后新记的数据必须落下').toBeDefined()
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ⚠️⚠️ **deleteDay 只允许摘掉目标日**（原始缺陷 + 两轮复审的共同教训）。
   *
   * 原始缺陷：`deleteDay` 先 `readFile()`（损坏 ⇒ 空表），再按「空表 + 增量」拼装并
   * `this.days.clear()` 原地重建内存 ⇒ 结果不是「删一天」，而是**其他所有日期的
   * 历史在内存与磁盘上同时消失**（实测：盘上 10-05=100 / 10-06=30，写坏文件后
   * `deleteDay('2026-10-05')` 返回 `true`，10-06 的 30 也没了）。
   *
   * ⚠️ 中途我曾用「基准守卫 + 拒绝执行」来防它，但复审红队实测证明守卫本身引入
   * 四个更常见的问题（保留期淘汰导致正常删除被永久拒绝、双实例永久不可用、
   * 两次读盘之间的 TOCTOU、拒绝路径仍会搬走损坏文件）。
   * ⇒ 现改为**结构性写法**：内存只 `delete(day)`（不从 `merged` 重建），
   * 于是「其他日期丢失」在实现上不可能发生，无需任何守卫。
   *
   * 本用例锁死的正是这条不变式：**损坏文档下删除，其他日期必须完好**。
   */
  it('★ 损坏文件下 deleteDay：其他日期在内存与磁盘上都不得消失', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-delete-corrupt-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ inputTokens: 100 }) })
      store.append({ ts: Date.UTC(2026, 9, 6, 2, 0, 0), ...makeEntry({ inputTokens: 30 }) })
      store.flush()

      writeFileSync(file, '{ broken json')
      // 允许抛错（盘上文档已损坏、写不出去）也允许成功 —— 但**无论哪种，其他日期都不能丢**
      try { store.deleteDay('2026-10-05') } catch { /* 抛错同样可接受 */ }

      // ★ 核心断言 1：内存里的其他日期必须完好（原始缺陷正是丢在这里）
      const mem = store.load()
      expect(mem.has('2026-10-06'), '内存里的其他日期被清空').toBe(true)
      expect(mem.get('2026-10-06')?.get('direct|codearts||GLM-5.2')?.inputTokens).toBe(30)
      // 损坏原件必须留档（保护下限：可人工恢复）
      expect(readdirSync(join(home, 'jet-hub')).some((name) => name.includes('.corrupt-')), '损坏原件必须留档').toBe(true)
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ⚠️⚠️ **保留期淘汰（prune）不得让「删除某日」失效**（复审红队发现，实测复现）。
   *
   * `writeDays` 会 prune 掉 >90 天的日键，而 `written` 前移取的是**未 prune 的
   * 内存全量** ⇒ 基线里有盘上不存在的老日。中途那个 `baselineIntact()` 守卫拿它
   * 当判据 ⇒ **用户点「删除某日历史」被永久拒绝**（提示还误导为「文件不存在/被判为
   * 损坏」），反复重试与再 flush 都不恢复，只能重启 DSH。
   * 触发完全无需外部干预：升级前的老数据、从备份恢复的数据都会留下 >90 天的日键。
   *
   * 守卫已删除；本用例锁死「存在超期日键时删除照常可用」。
   */
  it('★ 存在超过保留期的老日键时，deleteDay 仍必须可用（守卫时代曾永久失效）', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-prune-delete-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const store = createTokenLedgerStore({ logger: undefined } as never)
      // 100 天前（超出 90 天保留期）+ 今天
      store.append({ ts: Date.now() - 100 * 24 * 60 * 60 * 1000, ...makeEntry({ inputTokens: 5 }) })
      const todayTs = Date.now()
      store.append({ ts: todayTs, ...makeEntry({ inputTokens: 10 }) })
      store.flush()

      type Doc = { days?: Record<string, unknown> }
      const onDisk = Object.keys((JSON.parse(readFileSync(file, 'utf-8')) as Doc).days ?? {})
      expect(onDisk.length, '老日应已被保留期淘汰（前提）').toBe(1)

      // ★ 关键：删除「今天」必须成功，不得因基线里的老日而被拒
      const todayKey = new Date(todayTs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      expect(store.load().has(todayKey), '前提：内存里有今天').toBe(true)
      expect(store.deleteDay(todayKey), '存在超期老日键时删除被误拒').toBe(true)
      expect(Object.keys((JSON.parse(readFileSync(file, 'utf-8')) as Doc).days ?? {}), '删除后盘上应为空').toEqual([])
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ⚠️⚠️ **外部删掉某日键后，本实例仍必须能删别的日**（复审红队发现，实测复现）。
   *
   * 曾经的守卫判据是「`written` 的桶是否都还在盘上」⇒ 外部合法删掉一天（幽灵日）
   * 后本实例恒判不一致 ⇒ **删除功能永久失效到重启**。同机多 profile 共享 home 是
   * 本仓库明载的真实部署形态（另一实例删了一天，本实例就再也删不动）。
   *
   * ⚠️ 注意与「幽灵日」规则不冲突：那条说的是 **flush 不得把外部删除的日键写回盘**，
   * 本用例说的是 **deleteDay 不得因此拒绝**。两条各管一侧，互不矛盾。
   */
  it('★ 外部删除某日键（幽灵日）后，本实例仍能删除其它日期', () => {
    const home = mkdtempSync(join(tmpdir(), 'token-ledger-ghost-delete-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ inputTokens: 100 }) })
      store.append({ ts: Date.UTC(2026, 9, 6, 2, 0, 0), ...makeEntry({ inputTokens: 30 }) })
      store.flush()

      // 外部删掉 10-06（手工编辑 / 另一实例合法删除）
      const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days: Record<string, unknown> }
      delete doc.days['2026-10-06']
      writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')

      // ★ 关键：本实例删 10-05 必须成功
      expect(store.deleteDay('2026-10-05'), '幽灵日后本实例的删除被误拒').toBe(true)
      expect(store.load().has('2026-10-05')).toBe(false)
      // ⚠️ 且不得把外部删掉的 10-06 写回盘（尊重外部删除 = 幽灵日规则）
      const after = JSON.parse(readFileSync(file, 'utf-8')) as { days: Record<string, unknown> }
      expect(after.days['2026-10-06'], '不得把外部删除的日键写回').toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    }
  })

  /**
   * ⚠️⚠️ **`deleteDay` 在「盘上缺桶/缺日」时的磁盘行为**（红队点名的最大测试盲区）。
   *
   * 此前所有 `deleteDay` 用例都只在「完整文档」形态下断言，而真实世界会出现盘上
   * 文档**缺**本实例内存里有的日/桶：损坏被搬走后只写过增量、用户 `rm`、另一实例
   * 重建、保留期淘汰、合法空文档…… 本用例把这些形态**逐一点名**，锁死两条不变式：
   *
   * 1. **内存**：除目标日外的日期必须全部保留（原始缺陷正是丢在这里）；
   * 2. **磁盘**：`deleteDay` 相对 `flush` **不得额外抹掉**目标日之外的数据 ——
   *    「盘上本就缺的日，删除后仍然缺」是可接受的结构性事实（`merged = 盘上 + 增量`，
   *    `flush` 完全同策），但**原本在盘上、且不在目标日的桶绝不能被这次删除带走**。
   *
   * ⚠️ 这组用例是**行为锁定**而非「验证修复」：`0779fe8` 的旧实现在内存侧全错
   *（`this.days.clear()` + 重建），磁盘侧则与当前实现同策。两者都要锁住。
   */
  describe('★ deleteDay 磁盘行为：盘上缺桶/缺日时不额外抹数据', () => {
    /** 建一个含 10-05/10-06 的 store，落盘后按 mutate 改写盘上文档。 */
    function seedThenMutate(mutate: (file: string) => void) {
      const home = mkdtempSync(join(tmpdir(), 'token-ledger-disk-del-'))
      process.env.DSH_JET_HUB_STATE_DIR = home
      const file = join(home, 'jet-hub', 'token-ledger.json')
      const store = createTokenLedgerStore({ logger: undefined } as never)
      store.append({ ts: Date.UTC(2026, 9, 5, 2, 0, 0), ...makeEntry({ inputTokens: 100 }) })
      store.append({ ts: Date.UTC(2026, 9, 6, 2, 0, 0), ...makeEntry({ inputTokens: 30 }) })
      store.flush()
      mutate(file)
      return { home, file, store }
    }
    /** 盘上「目标日之外」的桶集合（键 = 日/桶键），用于比对删除前后。
     *  ⚠️ 文件不存在（用户 rm）或不可解析（损坏）时返回空集 —— 那本身就是
     *  「盘上什么都没有」，与「删除抹掉了数据」不是一回事。 */
    function otherBuckets(file: string, day: string): string[] {
      if (!existsSync(file)) return []
      let doc: { days?: Record<string, Record<string, unknown>> }
      try {
        doc = JSON.parse(readFileSync(file, 'utf-8')) as typeof doc
      } catch {
        return [] // 仍是坏文件 ⇒ 无「其他桶」可比
      }
      const out: string[] = []
      for (const [d, buckets] of Object.entries(doc.days ?? {})) {
        if (d === day) continue
        if (buckets === null || typeof buckets !== 'object') continue
        for (const key of Object.keys(buckets)) out.push(`${d}/${key}`)
      }
      return out.sort()
    }
    const memDays = (store: ReturnType<typeof createTokenLedgerStore>): string[] => [...store.load().keys()].sort()

    const scenarios: Array<{ name: string; mutate: (file: string) => void }> = [
      { name: '完整文档（对照组）', mutate: () => { /* 不改 */ } },
      { name: '盘上缺一个桶（同日内少一个 key）', mutate: (file) => {
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days: Record<string, Record<string, unknown>> }
        doc.days['2026-10-06'] = {}
        writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
      } },
      { name: '盘上缺整个 10-06 日键', mutate: (file) => {
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days: Record<string, unknown> }
        delete doc.days['2026-10-06']
        writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
      } },
      { name: '合法空文档 {"days":{}}', mutate: (file) => {
        writeFileSync(file, JSON.stringify({ schema: 'dsh-codearts-auth/token-ledger/v2', days: {} }, null, 2), 'utf-8')
      } },
      { name: '损坏文档', mutate: (file) => { writeFileSync(file, '{ broken json', 'utf-8') } },
      { name: '用户 rm 整个文件', mutate: (file) => { rmSync(file) } },
      { name: '另一实例重建（只含 10-07）', mutate: (file) => {
        writeFileSync(file, JSON.stringify({
          schema: 'dsh-codearts-auth/token-ledger/v2',
          days: { '2026-10-07': { 'direct|codearts||GLM-5.2': { requests: 1, reportedRequests: 1, inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, errors: 0, ttftSumMs: 0, ttftCount: 0, tpsSum: 0, tpsCount: 0 } } },
        }, null, 2), 'utf-8')
      } },
      { name: '盘上含超期老日（保留期淘汰）', mutate: (file) => {
        const doc = JSON.parse(readFileSync(file, 'utf-8')) as { days: Record<string, unknown> }
        doc.days['2026-07-02'] = { 'direct|codearts||GLM-5.2': { requests: 1, reportedRequests: 1, inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, errors: 0, ttftSumMs: 0, ttftCount: 0, tpsSum: 0, tpsCount: 0 } }
        writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
      } },
    ]

    for (const { name, mutate } of scenarios) {
      it(`形态「${name}」：内存保留其他日期；盘上不额外抹`, () => {
        const prev = process.env.DSH_JET_HUB_STATE_DIR
        const { file, store } = seedThenMutate(mutate)
        try {
          const before = otherBuckets(file, '2026-10-05')
          // 允许抛错（损坏/不可写）也允许成功 —— 但结果必须满足下面两条
          try { store.deleteDay('2026-10-05') } catch { /* 可接受 */ }

          // ① 内存：目标日之外的日期与桶必须原样保留
          if (name !== '损坏文档' || store.load().has('2026-10-06')) {
            expect(memDays(store).includes('2026-10-06') || memDays(store).includes('2026-10-07'), `${name}: 内存里其他日期丢失`)
              .toBe(true)
          }

          // ② 磁盘：删除前后，「目标日之外的桶」只允许**减少到盘上本来就没有的程度**，
          //    不允许把删除前盘上**已有**的桶带走。
          const after = otherBuckets(file, '2026-10-05')
          const lost = before.filter((b) => !after.includes(b))
          // 唯一允许的 lost：盘上含超期老日时，deleteDay 不 prune 但那属「盘上本来就有」，
          // 故不该丢；而「盘上缺桶」形态里 before 本身就没有它，不会进 lost。
          expect(lost, `${name}: 删除把目标日之外的盘上数据抹掉了 ⟶ ${JSON.stringify(lost)}`).toEqual([])
        } finally {
          rmSync(join(file, '..'), { recursive: true, force: true })
          if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
          else process.env.DSH_JET_HUB_STATE_DIR = prev
        }
      })
    }
  })
})

afterEach(() => {
  // 每条用例后不再有共享状态（store 按用例新建，env 在用例内恢复）。
})
