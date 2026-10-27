/**
 * `createCredentialResolver` 与旧闭包的**逐 provider 对拍**（等价性验收）。
 *
 * ## 为什么要有这份文件（设计文档 §3.7.1）
 *
 * 本 Task 的第一条约束是**零行为变更**：13 个 `resolveCredential` 闭包收敛成
 * 一个参数化编排，而选号语义（`modelId` 透传、限流报错顺序、锁定不回落、
 * 兜底形状校验、账本回报时机）**一条都不能动**。
 *
 * 光靠「新实现自己的用例」证明不了这一点 —— 那些用例是我按新实现的理解写的，
 * 理解错了就一起错。故这里把**旧闭包逐字复刻**成参照实现（不 import 生产代码），
 * 与新实现喂**同一批输入**、断言**逐字段相等**（返回值 + 回报序列 + 池调用序列）。
 *
 * ⚠️ 参照实现是从 `git show d35d9e3:src/index.ts` 抄下来的原文骨架，不是
 * 「我以为的旧行为」。**改参照实现 = 改判据**，必须给出理由。
 *
 * ## 骨架分四类（实测：13 个闭包按骨架分组）
 *
 * | 骨架 | 家数 | 特征 |
 * |---|---|---|
 * | A 池选号 + 限流判定 + 单凭据回退 | 10 | raccoon / minimax / gemini / qoder / qodercn / cline / lobsterai / trae / buddy / workbuddy |
 * | B 池选号 + **自定义**兜底 + **刻意不判**限流 | 1 | zcode |
 * | C 余额分档（buddy 协议）+ 免费短路 + 锁定抛错 | 4 | buddy / workbuddy / lobsterai / trae |
 * | D 余额分档（loomy 协议，**不回落池**） | 1 | loomy |
 *
 * A 与 C 在同一家上首尾相接（buddy 系 = C 的编排 + A 的尾巴），故按**编排段**
 * 对拍，而不是按家数机械地抄 13 遍（抄 13 遍等于把同一判据写 13 次，改一处漏
 * 十二处 —— 本仓库已记录过这类事故）。
 */
import { describe, expect, it } from 'vitest'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CreditBalance } from '../../src/credits.js'
import type { LoomyCredential } from '../../src/loomy.js'
import type { LoomyNoAccountReason, LoomySelectionResult } from '../../src/loomy-balance-selector.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 池里的一个账号（只带编排真正读到的字段）。 */
interface Entry {
  id: string
  provider: string
  credentialRef: string
  enabled: boolean
  modelRateLimits?: Record<string, number>
}

/**
 * 复刻 `AccountPool` 被编排用到的那三件事，**判据与真实实现逐字一致**
 * （含「空 modelId 不过滤」与「逐个尝试、跳过解析不了的」）。
 *
 * ⚠️ 真实池解析池内凭据用的是**裸 `JSON.parse`**（`account-pool.ts` 的
 * `getAvailableAccount`）—— 这里也照抄裸 parse，否则测不出 C4 那格差异。
 */
function makePool(config: {
  entries: Entry[]
  /** ref → 凭据原文。缺该键 = 「凭据未配置」。 */
  credentials: Record<string, string>
  locked?: boolean
}) {
  const calls: Array<{ provider: string; modelId: string; exclude: string[] }> = []
  return {
    calls,
    /** 从第 n 条起的新调用（对拍要分开看「参照实现」与「新实现」各自的调用）。 */
    callsSince: (n: number) => calls.slice(n),
    listAccountsByProvider: (provider: string) =>
      config.entries.filter(e => e.provider === provider),
    permanentLocked: () => config.locked === true,
    getAvailableAccount: async (
      provider: string, modelId: string, exclude?: ReadonlySet<string>,
    ) => {
      calls.push({ provider, modelId, exclude: [...(exclude ?? [])] })
      const candidates = config.entries
        .filter(e => e.provider === provider && e.enabled)
        .filter(e => exclude === undefined || !exclude.has(e.id))
        .filter((e) => {
          if (modelId.length === 0) return true
          if (e.modelRateLimits === undefined) return true
          const resetAt = e.modelRateLimits[modelId]
          return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
        })
      for (const entry of candidates) {
        const raw = config.credentials[entry.credentialRef]
        if (raw === undefined) continue
        try {
          return { entry, credential: JSON.parse(raw) as unknown }
        } catch {
          continue
        }
      }
      return null
    },
  }
}

type Pool = ReturnType<typeof makePool>

/** 一个账号（默认启用）。 */
function account(id: string, provider: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    provider,
    credentialRef: `${provider.toUpperCase()}_ACCOUNT_${id.toUpperCase()}`,
    enabled: true,
    ...extra,
  }
}

const REF = (provider: string) => `${provider.toUpperCase()}_ACCESS_TOKEN`

describe('createCredentialResolver 与旧闭包对拍', () => {
  /**
   * 骨架 A：**池选号 → 回报账号 → 限流判定 → 单凭据回退**。
   *
   * 十家的差异只在三处：product 常量、单凭据 ref、以及「取不到号时要不要把
   * 回报置为 `undefined`」。故按三种组合各钉一条，而不是把十家逐一抄一遍。
   */
  describe('骨架 A：池选号 + 限流判定 + 单凭据回退', () => {
    function pair(config: {
      provider: string
      displayName: string
      entries: Entry[]
      /** 池内凭据（ref → 原文）。 */
      credentials: Record<string, string>
      /** 单凭据 ref 的原文；不给 = 该 ref 不存在。 */
      fallbackRaw?: string
      /** 限流判定是否抛错。 */
      rateLimited?: Error
      /**
       * 取不到池账号时是否把回报置为 `undefined`。
       * qoder / qodercn / cline / zcode 为 true（清空「当前账号」标记），其余为 false。
       */
      reportMiss?: boolean
      /** 该家是否做凭据**形状校验**（trae / lobsterai 那份解析器为 true）。 */
      shapeChecked?: boolean
    }) {
      const product = { id: config.provider, displayName: config.displayName }
      const fallbackRef = REF(config.provider)
      const pool = makePool({
        entries: config.entries,
        credentials: {
          ...config.credentials,
          ...config.fallbackRaw === undefined ? {} : { [fallbackRef]: config.fallbackRaw },
        },
      })
      const throwIfRateLimited = (): void => { if (config.rateLimited !== undefined) throw config.rateLimited }
      /** 与 `resolveTraeCredentialByRef` 同口径：形状不对返回 undefined。 */
      const readCredential = async (ref: string): Promise<unknown> => {
        const raw = config.credentials[ref] ?? (ref === fallbackRef ? config.fallbackRaw : undefined)
        if (raw === undefined) return undefined
        try {
          const parsed = JSON.parse(raw) as { access_token?: unknown }
          if (config.shapeChecked !== true) return parsed
          return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined
        } catch {
          return undefined
        }
      }
      /**
       * ⚠️ **策略在回调里**（见 `CredentialResolverDeps.reportAccount` 的契约）：
       * 工厂一律以「池的决策结果」调用一次（未命中时是 `undefined`），
       * 各家在回调里决定要不要理它。旧闭包对应的写法就在这里。
       */
      const sink = (
        report: (id: string | undefined) => void,
      ): ((id: string | undefined) => void) => config.reportMiss === true
        ? report
        : (id) => { if (id !== undefined) report(id) }

      /** 旧闭包（逐字复刻）。 */
      const legacy = async (report: (id: string | undefined) => void): Promise<unknown> => {
        const available = await pool.getAvailableAccount(product.id, 'model-x')
        sink(report)(available?.entry.id)
        if (available !== null) return available.credential
        throwIfRateLimited()
        return await readCredential(fallbackRef)
      }
      const next = (report: (id: string | undefined) => void) => createCredentialResolver(
        { pool: pool as never, reportAccount: sink(report) },
        {
          product,
          readCredential,
          fallback: { kind: 'ref', refName: fallbackRef },
          throwIfAllRateLimited: throwIfRateLimited,
        },
      )('model-x')
      return { pool, legacy, next }
    }

    it('池里有可用账号 ⇒ 同一凭据 / 同一回报 / 同一池调用形态', async () => {
      const { pool, legacy, next } = pair({
        provider: 'raccoon', displayName: 'Raccoon (商汤)',
        entries: [account('a1', 'raccoon')],
        credentials: { RACCOON_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
      })
      const legacyReports: Array<string | undefined> = []
      const legacyValue = await legacy((id) => legacyReports.push(id))
      const legacyCalls = pool.callsSince(0)
      const reports: Array<string | undefined> = []
      const value = await next((id) => reports.push(id))
      const nextCalls = pool.callsSince(legacyCalls.length)

      expect(value).toEqual(legacyValue)
      expect(value).toEqual({ access_token: 'tok-a1' })
      expect(reports).toEqual(legacyReports)
      expect(reports).toEqual(['a1'])
      expect(nextCalls).toEqual(legacyCalls)
      expect(legacyCalls).toEqual([{ provider: 'raccoon', modelId: 'model-x', exclude: [] }])
    })

    it('池里没有可用账号 ⇒ 都退单凭据、结果相同；不回报（buddy 系语义）', async () => {
      const { pool, legacy, next } = pair({
        provider: 'raccoon', displayName: 'Raccoon (商汤)',
        entries: [],
        credentials: {},
        fallbackRaw: JSON.stringify({ access_token: 'single' }),
      })
      const legacyReports: Array<string | undefined> = []
      const legacyValue = await legacy((id) => legacyReports.push(id))
      const legacyCalls = pool.callsSince(0)
      const reports: Array<string | undefined> = []
      const value = await next((id) => reports.push(id))

      expect(value).toEqual(legacyValue)
      expect(value).toEqual({ access_token: 'single' })
      expect(reports).toEqual([])
      expect(reports).toEqual(legacyReports)
      // 空池也要问一次池，且 `modelId` 原样透传
      expect(pool.callsSince(legacyCalls.length)).toEqual(legacyCalls)
      expect(legacyCalls).toEqual([{ provider: 'raccoon', modelId: 'model-x', exclude: [] }])
    })

    it('⚠️ 取不到号时**仍以 `undefined` 回报**（qoder / cline / zcode 靠它清空「当前账号」标记）', async () => {
      // 变异：把工厂里 `deps.reportAccount?.(available?.entry.id ?? undefined)`
      // 改成 `if (available !== null) deps.reportAccount?.(…)` ⇒ 本条红。
      const { legacy, next } = pair({
        provider: 'qoder', displayName: 'Qoder',
        entries: [],
        credentials: {},
        reportMiss: true,
      })
      const legacyReports: Array<string | undefined> = []
      await legacy((id) => legacyReports.push(id))
      const reports: Array<string | undefined> = []
      await next((id) => reports.push(id))

      expect(legacyReports, '旧闭包确实会回报 undefined（= 清空标记）').toEqual([undefined])
      expect(reports, '新实现必须同样回报 undefined').toEqual(legacyReports)
    })

    it('回退凭据形状校验失败 ⇒ 两者都 undefined（不得退化成裸 parse）', async () => {
      // `{"broken":1}` 是**合法 JSON、错误形状**：裸 parse 会当成有效凭据返回，
      // 形状校验会拒。变异：把 `readCredential` 换成裸 `JSON.parse` ⇒ 本条红。
      const { legacy, next } = pair({
        provider: 'trae', displayName: 'TRAE',
        entries: [],
        credentials: { TRAE_ACCESS_TOKEN: '{"broken":1}' },
        shapeChecked: true,
      })
      expect(await legacy(() => {})).toBeUndefined()
      expect(await next(() => {})).toBeUndefined()
    })

    it('形状正确的回退凭据 ⇒ 两者都返回它（校验不得过严）', async () => {
      const { legacy, next } = pair({
        provider: 'trae', displayName: 'TRAE',
        entries: [],
        credentials: { TRAE_ACCESS_TOKEN: JSON.stringify({ access_token: 'AT' }) },
        shapeChecked: true,
      })
      expect(await legacy(() => {})).toEqual({ access_token: 'AT' })
      expect(await next(() => {})).toEqual({ access_token: 'AT' })
    })

    it('回退 ref 不存在 ⇒ 两者都 undefined（不抛错）', async () => {
      const { legacy, next } = pair({
        provider: 'minimax', displayName: 'MiniMax Code',
        entries: [],
        credentials: {},
      })
      expect(await legacy(() => {})).toBeUndefined()
      expect(await next(() => {})).toBeUndefined()
    })

    it('⚠️ 全部账号被该模型限流 ⇒ 两者抛**同一条**错误（顺序：先问池、再判限流、最后回退）', async () => {
      // 变异：把 `config.throwIfAllRateLimited?.(…)` 移到池调用**之前** ⇒
      // 「池里还有号时限流判定不得触发」那条红；把整行删掉 ⇒ 本条红。
      const limited = new Error('限流：模型 model-x 的可用账号均在限流中')
      const { legacy, next } = pair({
        provider: 'cline', displayName: 'Cline',
        entries: [account('a1', 'cline', { modelRateLimits: { 'model-x': Date.now() + HOUR } })],
        credentials: {},
        rateLimited: limited,
      })
      await expect(legacy(() => {})).rejects.toBe(limited)
      await expect(next(() => {})).rejects.toBe(limited)
    })

    it('⚠️ 池里还有号时限流判定不得触发（否则会把正常取号报成限流）', async () => {
      const limited = new Error('不该抛')
      const { legacy, next } = pair({
        provider: 'gemini', displayName: 'Gemini',
        entries: [account('a1', 'gemini')],
        credentials: { GEMINI_ACCOUNT_A1: JSON.stringify({ access_token: 'ok' }) },
        rateLimited: limited,
      })
      await expect(legacy(() => {})).resolves.toEqual({ access_token: 'ok' })
      await expect(next(() => {})).resolves.toEqual({ access_token: 'ok' })
    })

    it('⚠️ modelId 必须透传给 getAvailableAccount（空串会让模型级限流过滤整体短路）', async () => {
      // 变异：把 `getAvailableAccount(providerId, modelId ?? '', tried)` 的
      // `modelId ?? ''` 改成 `''` ⇒ 本条红。
      const { pool, next } = pair({
        provider: 'raccoon', displayName: 'Raccoon (商汤)',
        entries: [],
        credentials: {},
      })
      await next(() => {})
      expect(pool.calls[0]?.modelId, '必须原样透传 modelId').toBe('model-x')
    })

    it('⚠️ 不传 throwIfAllRateLimited ⇒ 取不到号时静默回退（zcode 刻意不判限流）', async () => {
      const pool = makePool({
        entries: [],
        credentials: { ZCODE_CREDENTIAL: JSON.stringify({ access_token: 'single' }) },
      })
      const resolve = createCredentialResolver(
        { pool: pool as never },
        {
          product: { id: 'zcode', displayName: 'ZCode (智谱)' },
          readCredential: async (ref) => {
            const raw = ref === 'ZCODE_CREDENTIAL'
              ? JSON.stringify({ access_token: 'single' })
              : undefined
            return raw === undefined ? undefined : JSON.parse(raw) as unknown
          },
          fallback: { kind: 'ref', refName: 'ZCODE_CREDENTIAL' },
        },
      )
      await expect(resolve('model-x')).resolves.toEqual({ access_token: 'single' })
    })
  })

  /**
   * 骨架 B：**zcode**。
   *
   * 与 A 的两处差异都是**刻意的**（各有长注释与回归用例）：
   * ① 兜底是 `zcode.current()`（会**再读一次账号池**），不是单凭据 ref；
   * ② **不接**限流判定 —— 其余各家的兜底读的是从不被写入的 `*_ACCESS_TOKEN`，
   *    池被筛空必然降级成「请先登录」；zcode 的兜底会再读池，本就不会误报，
   *    加判定反而会把「能跑通」变成硬失败。
   */
  describe('骨架 B：zcode（自定义兜底 + 刻意不判限流）', () => {
    function pair(config: {
      entries: Entry[]
      credentials: Record<string, string>
      current: () => Promise<unknown>
    }) {
      const product = { id: 'zcode', displayName: 'ZCode (智谱)' }
      const pool = makePool({ entries: config.entries, credentials: config.credentials })
      const legacy = async (report: (id: string | undefined) => void): Promise<unknown> => {
        const available = await pool.getAvailableAccount('zcode', 'model-x')
        if (available !== null) {
          report(available.entry.id)
          return available.credential
        }
        report(undefined)
        return await config.current()
      }
      const next = (report: (id: string | undefined) => void) => createCredentialResolver(
        { pool: pool as never, reportAccount: report },
        {
          product,
          readCredential: async () => undefined,
          fallback: { kind: 'custom', resolve: async () => await config.current() as never },
        },
      )('model-x')
      return { pool, legacy, next }
    }

    it('池里有号 ⇒ 同一凭据 / 同一回报', async () => {
      const { legacy, next } = pair({
        entries: [account('a1', 'zcode')],
        credentials: { ZCODE_ACCOUNT_A1: JSON.stringify({ access_token: 'A' }) },
        current: async () => { throw new Error('不该走到兜底') },
      })
      const legacyReports: Array<string | undefined> = []
      expect(await legacy((id) => legacyReports.push(id))).toEqual({ access_token: 'A' })
      const reports: Array<string | undefined> = []
      expect(await next((id) => reports.push(id))).toEqual({ access_token: 'A' })
      expect(reports).toEqual(legacyReports)
    })

    it('⚠️ 池里没号（被限流）⇒ 落到自定义兜底，且**不**判限流', async () => {
      // 变异：给这条 config 补上 `throwIfAllRateLimited` ⇒ 本条红（会抛）。
      const { legacy, next } = pair({
        entries: [account('a1', 'zcode', { modelRateLimits: { 'model-x': Date.now() + HOUR } })],
        credentials: { ZCODE_ACCOUNT_A1: JSON.stringify({ access_token: 'A' }) },
        current: async () => ({ access_token: 'from-current' }),
      })
      const legacyReports: Array<string | undefined> = []
      expect(await legacy((id) => legacyReports.push(id))).toEqual({ access_token: 'from-current' })
      const reports: Array<string | undefined> = []
      expect(await next((id) => reports.push(id))).toEqual({ access_token: 'from-current' })
      expect(legacyReports).toEqual([undefined])
      expect(reports).toEqual(legacyReports)
    })
  })

  /**
   * 骨架 C：**余额分档编排**（buddy 协议）。
   *
   * 参照实现 = 旧 buddy 系编排闭包的函数体 + 旧调用方闭包的尾巴。
   * ⚠️ 该闭包已在 Task 6 删除，故此处**不复写它的符号名**（「锚点已消失」类核对
   * 会 grep 到注释而假命中；名字见 git 历史 `d35d9e3`）。
   * 用**真实** `BuddyBalanceSelector`（注入 `fetchBalance`），因为
   * `pickBuddyAccount` 是共享实现，对拍必须覆盖它。
   */
  describe('骨架 C：余额分档 + 免费短路 + 锁定抛错（buddy / workbuddy / lobsterai / trae）', () => {
    const PRODUCT = { id: 'buddy', displayName: 'CodeBuddy' }
    const FALLBACK = 'BUDDY_ACCESS_TOKEN'

    /** 「N 天后到期、余额 R」的余额（days < 15 ⇒ 临时积分档）。 */
    function balance(remaining: number, days = 9): CreditBalance {
      return {
        total: remaining,
        expiredTotal: 0,
        packages: [{
          name: 'Bonus Pack', unit: 'credits', remaining, total: remaining, used: 0, active: true,
          cycleStartTime: '', cycleEndTime: '', expiredTime: '',
          deductionEndTime: Date.now() + days * DAY,
        }],
      }
    }

    /** 与 `src/index.ts` 逐字一致的锁定文案（含 `buddyExpiringWindowDays()` = 15）。 */
    function lockedError(reason: { kind: string; errors?: string[] }): Error {
      const days = 15
      if (reason.kind === 'unknown') {
        return new Error(
          `${PRODUCT.displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${(reason.errors ?? []).slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 Jet Hub 对应面板检查凭据是否失效。',
        )
      }
      return new Error(
        `${PRODUCT.displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分都已用尽。请在 Jet Hub 的 '
        + `${PRODUCT.displayName} 面板解锁永久积分，或等待资源包到期后重新发放额度。`,
      )
    }

    function pair(config: {
      entries: Entry[]
      balances: Record<string, CreditBalance | null>
      /** 池内凭据（ref → 原文）。 */
      credentials: Record<string, string>
      /** 单凭据 ref 的原文。 */
      fallbackRaw?: string
      /** 该家是否做凭据**形状校验**（trae / lobsterai 为 true）。 */
      shapeChecked?: boolean
      locked?: boolean
      isFreeModel?: boolean
      /** 分档选中时是否回报（buddy / workbuddy 旧闭包为 false）。 */
      reportOnPick?: boolean
    }) {
      const pool = makePool({
        entries: config.entries,
        credentials: {
          ...config.credentials,
          ...config.fallbackRaw === undefined ? {} : { [FALLBACK]: config.fallbackRaw },
        },
        ...config.locked === undefined ? {} : { locked: config.locked },
      })
      const selector = new BuddyBalanceSelector({
        product: { id: 'buddy' } as never,
        resolveCredential: async (ref: string) => ({ access_token: ref }) as unknown as BuddyCredential,
        fetchBalance: async (credential) => config.balances[credential.access_token] ?? null,
      })
      /** 与 `resolveTraeCredentialByRef` 同口径；`shapeChecked` 为假时退化为裸 parse。 */
      const readCredential = async (ref: string): Promise<BuddyCredential | undefined> => {
        const raw = config.credentials[ref] ?? (ref === FALLBACK ? config.fallbackRaw : undefined)
        if (raw === undefined) return undefined
        try {
          const parsed = JSON.parse(raw) as BuddyCredential
          if (config.shapeChecked !== true) return parsed
          return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
            ? parsed
            : undefined
        } catch {
          return undefined
        }
      }
      const reportOnPick = config.reportOnPick !== false

      /**
       * 旧 buddy 系编排闭包的逐字复刻（该符号已删除，名字见 git 历史 `d35d9e3`）。
       *
       * @returns `{ credential, accountId }`（选中）或 `{ tried }`（未选中）。
       */
      const legacyPick = async (
        reports: Array<string | undefined>,
      ): Promise<{ credential: BuddyCredential; accountId: string } | { tried: Set<string> }> => {
        const tried = new Set<string>()
        const candidates = pool
          .listAccountsByProvider(PRODUCT.id)
          .filter(a => a.enabled)
          .filter((a) => {
            const key = 'model-x'
            if (key.length === 0) return true
            if (!a.modelRateLimits) return true
            const resetAt = a.modelRateLimits[key]
            return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
          })
          .map(a => ({ id: a.id, credentialRef: a.credentialRef }))

        if (config.isFreeModel === true) {
          for (const candidate of candidates) {
            const credential = await readCredential(candidate.credentialRef)
            if (credential !== undefined) {
              if (reportOnPick) reports.push(candidate.id)
              return { credential, accountId: candidate.id }
            }
            tried.add(candidate.id)
          }
        }

        const allowPermanent = !pool.permanentLocked(PRODUCT.id)
        const { pickBuddyAccount } = await import('../../src/buddy-balance-selector.js')
        const picked = await pickBuddyAccount(selector, candidates, {
          allowPermanent,
          resolveCredential: readCredential,
        })
        if (picked.kind === 'account') {
          if (reportOnPick) reports.push(picked.account.id)
          return { credential: picked.credential, accountId: picked.account.id }
        }
        for (const id of picked.tried) tried.add(id)
        if (picked.kind === 'locked') throw lockedError(picked.reason ?? { kind: 'exhausted' })
        return { tried }
      }

      /** 旧调用方闭包的尾巴（编排之后那半段）。 */
      const legacy = async (reports: Array<string | undefined>): Promise<BuddyCredential | undefined> => {
        const picked = await legacyPick(reports)
        if ('credential' in picked) return picked.credential
        const available = await pool.getAvailableAccount(PRODUCT.id, 'model-x', picked.tried)
        if (available !== null) {
          reports.push(available.entry.id)
          return available.credential as unknown as BuddyCredential
        }
        return await readCredential(FALLBACK)
      }

      const next = (reports: Array<string | undefined>) => createCredentialResolver(
        { pool: pool as never, reportAccount: (id) => { if (id !== undefined) reports.push(id) } },
        {
          product: PRODUCT,
          readCredential,
          balance: {
            kind: 'buddy',
            selector,
            lockedError,
            reportPickedAccount: reportOnPick,
            ...config.isFreeModel === undefined
              ? {}
              : { isFreeModel: async () => config.isFreeModel === true },
          },
          fallback: { kind: 'ref', refName: FALLBACK },
        },
      )('model-x')
      return { pool, selector, legacy, next }
    }

    it('分档选中首位 ⇒ 同一凭据 / 同一回报序列', async () => {
      const { legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250) },
        credentials: { BUDDY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        reportOnPick: true,
      })
      const legacyReports: Array<string | undefined> = []
      const legacyValue = await legacy(legacyReports)
      const reports: Array<string | undefined> = []
      const value = await next(reports)

      expect(value).toEqual(legacyValue)
      expect(value).toEqual({ access_token: 'tok-a1' })
      expect(reports).toEqual(legacyReports)
      expect(reports).toEqual(['a1'])
    })

    it('⚠️ 首位凭据损坏 ⇒ 两者都换下一个候选（分档编排的循环语义）', async () => {
      // 变异：把 `pickBuddyAccount` 换成 `selector.select` + 单次 resolve ⇒ 本条红。
      const { legacy, next } = pair({
        entries: [account('a1', 'buddy'), account('a2', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250), BUDDY_ACCOUNT_A2: balance(100, 10) },
        credentials: { BUDDY_ACCOUNT_A2: JSON.stringify({ access_token: 'tok-a2' }) },
        reportOnPick: true,
      })
      const legacyReports: Array<string | undefined> = []
      expect(await legacy(legacyReports)).toEqual({ access_token: 'tok-a2' })
      const reports: Array<string | undefined> = []
      expect(await next(reports)).toEqual({ access_token: 'tok-a2' })
      expect(reports).toEqual(legacyReports)
      expect(reports).toEqual(['a2'])
    })

    it('⚠️ 锁定 + 只剩永久积分 ⇒ 两者抛**同一条**文案，且绝不回落池', async () => {
      // 变异：把 `throw plan.lockedError(…)` 改成 `return undefined` ⇒ 本条红
      //（会回落池并返回 a1 的凭据，于是 pool.calls 非空）。
      const { pool, legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(100, 3008) },
        credentials: { BUDDY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        locked: true,
        reportOnPick: true,
      })
      const legacyError = await legacy([]).then(() => undefined, (e: Error) => e)
      const legacyCalls = pool.callsSince(0)
      const nextError = await next([]).then(() => undefined, (e: Error) => e)
      expect(legacyError?.message, '参照实现必须抛错').toBeDefined()
      expect(nextError?.message, '锁定文案必须逐字相同').toBe(legacyError?.message)
      expect(legacyCalls, '锁定时参照实现也不问池').toEqual([])
      expect(pool.callsSince(legacyCalls.length), '锁定时不该再问池（回落会绕过锁定）').toEqual([])
    })

    it('⚠️ 锁定 + 余额查询失败 ⇒ 两者报「无法确认」而不是「额度已用尽」', async () => {
      const { legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: null },
        credentials: { BUDDY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        locked: true,
        reportOnPick: true,
      })
      const legacyError = await legacy([]).then(() => undefined, (e: Error) => e)
      const nextError = await next([]).then(() => undefined, (e: Error) => e)
      expect(legacyError?.message).toContain('无法确认是否有可用账号')
      expect(nextError?.message).toBe(legacyError?.message)
    })

    it('未锁定 + 编排没选到 ⇒ 两者都带 `tried` 回落池（否则原地打转）', async () => {
      // 变异：去掉 `for (const accountId of picked.tried) tried.add(accountId)` ⇒ 本条红。
      const { pool, legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250) },
        // 该账号凭据损坏 ⇒ 分档排除它 ⇒ 候选耗尽 ⇒ 回落池
        credentials: {},
        reportOnPick: true,
      })
      await legacy([])
      const legacyCalls = pool.callsSince(0)
      await next([])
      const nextCalls = pool.callsSince(legacyCalls.length)
      expect(nextCalls, '新实现的兜底必须排除凭据损坏的账号').toEqual(legacyCalls)
      expect(legacyCalls).toEqual([{ provider: 'buddy', modelId: 'model-x', exclude: ['a1'] }])
    })

    it('⚠️ 免费模型 + 凭据**形状损坏** ⇒ 两者都 undefined（C4：不得退化成裸 parse）', async () => {
      // `{"broken":1}` 是**合法 JSON、错误形状**：池内裸 parse 会当成有效凭据返回，
      // 形状校验会拒。这是 C4 指出的真实行为变更 —— 本条把它钉死。
      // 变异：把免费分支改成 `pool.getAvailableAccount` ⇒ 本条红（会返回 {broken:1}）。
      const { legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250) },
        credentials: { BUDDY_ACCOUNT_A1: '{"broken":1}' },
        shapeChecked: true,
        isFreeModel: true,
        reportOnPick: true,
      })
      expect(await legacy([]), '旧行为：形状校验拒绝该凭据').toBeUndefined()
      expect(await next([]), '新实现必须同样拒绝（不得走池的裸 parse）').toBeUndefined()
    })

    it('⚠️ 免费模型 + 凭据损坏 ⇒ 损坏账号必须进排除集，兜底不得把它选回来', async () => {
      const { pool, legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250) },
        credentials: { BUDDY_ACCOUNT_A1: '{"broken":1}' },
        shapeChecked: true,
        isFreeModel: true,
        reportOnPick: true,
      })
      await legacy([])
      const legacyCalls = pool.callsSince(0)
      await next([])
      expect(pool.callsSince(legacyCalls.length)).toEqual(legacyCalls)
      expect(legacyCalls).toEqual([{ provider: 'buddy', modelId: 'model-x', exclude: ['a1'] }])
    })

    it('⚠️ 免费模型命中 ⇒ 两者都**不查余额**（免费没有「该烧哪个包」的问题）', async () => {
      const { selector, legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250) },
        credentials: { BUDDY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        isFreeModel: true,
        reportOnPick: true,
      })
      let legacyBalanceCalls = 0
      let nextBalanceCalls = 0
      const realBalanceOf = selector.balanceOf.bind(selector)
      selector.balanceOf = async (a) => { legacyBalanceCalls++; return await realBalanceOf(a) }
      await legacy([])
      selector.balanceOf = async (a) => { nextBalanceCalls++; return await realBalanceOf(a) }
      await next([])
      expect(legacyBalanceCalls, '旧免费路径不查余额').toBe(0)
      expect(nextBalanceCalls, '新免费路径也不得查余额').toBe(0)
    })

    it('⚠️ reportOnPick=false ⇒ 分档选中时**不**回报（buddy / workbuddy 旧闭包的既有形态）', async () => {
      // ⚠️ 这不是「正确行为」的背书，而是**钉住现状**：buddy 系旧闭包只在池兜底
      // 那一支回报账本，分档选中那一支没有。零行为变更要求原样保留。
      const { legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250) },
        credentials: { BUDDY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        reportOnPick: false,
      })
      const legacyReports: Array<string | undefined> = []
      expect(await legacy(legacyReports)).toEqual({ access_token: 'tok-a1' })
      const reports: Array<string | undefined> = []
      expect(await next(reports)).toEqual({ access_token: 'tok-a1' })
      expect(legacyReports, '旧 buddy 闭包在分档选中时不回报').toEqual([])
      expect(reports).toEqual(legacyReports)
    })

    it('⚠️ reportOnPick=true ⇒ 分档选中时回报（lobsterai / trae 旧闭包的既有形态）', async () => {
      const { legacy, next } = pair({
        entries: [account('a1', 'buddy')],
        balances: { BUDDY_ACCOUNT_A1: balance(250) },
        credentials: { BUDDY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        reportOnPick: true,
      })
      const legacyReports: Array<string | undefined> = []
      await legacy(legacyReports)
      const reports: Array<string | undefined> = []
      await next(reports)
      expect(legacyReports, '旧 lobsterai / trae 闭包在分档选中时回报').toEqual(['a1'])
      expect(reports).toEqual(legacyReports)
    })
  })

  /**
   * 骨架 D：**loomy**。
   *
   * ⚠️ 与骨架 C 的**关键差异**（裁定 3：loomy 走自己的适配分支）：
   * loomy 的余额分档**自己就是完整的选号** —— 选中的账号凭据坏掉时它
   * **不换号、也不问池**，直接退单凭据。旧闭包里根本没有池取号调用。
   * 把 loomy 并进 `pickBuddyAccount` 会同时引入 ① 换号重试、② 池兜底
   * 两个行为变更，故它必须走自己的分支。
   */
  describe('骨架 D：loomy（自己的分档协议 + 不回落池）', () => {
    const PRODUCT = { id: 'loomy', displayName: 'Loomy (讯飞)' }
    const FALLBACK = 'LOOMY_ACCESS_TOKEN'

    function loomyLockedError(reason: LoomyNoAccountReason): Error {
      if (reason.kind === 'unknown') {
        return new Error(
          'Loomy：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败'
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**今日额度 —— `
          + '请重试，或在 Jet Hub 的 Loomy 面板检查凭据是否失效。',
        )
      }
      return new Error(
        'Loomy：没有可用账号。已锁定永久积分，而所有账号的今日赠送额度都已用尽。'
        + '请在 Jet Hub 的 Loomy 面板解锁永久积分，或等待明日额度刷新。',
      )
    }

    function pair(config: {
      entries: Entry[]
      credentials: Record<string, string>
      result: LoomySelectionResult
      locked?: boolean
      fallbackRaw?: string
      rateLimited?: Error
    }) {
      const pool = makePool({
        entries: config.entries,
        credentials: {
          ...config.credentials,
          ...config.fallbackRaw === undefined ? {} : { [FALLBACK]: config.fallbackRaw },
        },
        ...config.locked === undefined ? {} : { locked: config.locked },
      })
      const selectCalls: Array<{ ids: string[]; allowPermanent: boolean | undefined }> = []
      const selector = {
        selectCalls,
        select: async (
          candidates: readonly { id: string; credentialRef: string }[],
          options?: { allowPermanent?: boolean },
        ): Promise<LoomySelectionResult> => {
          selectCalls.push({ ids: candidates.map(c => c.id), allowPermanent: options?.allowPermanent })
          return config.result
        },
      }
      const readCredential = async (ref: string): Promise<LoomyCredential | undefined> => {
        const raw = config.credentials[ref] ?? (ref === FALLBACK ? config.fallbackRaw : undefined)
        if (raw === undefined) return undefined
        try {
          return JSON.parse(raw) as LoomyCredential
        } catch {
          return undefined
        }
      }
      const throwIfRateLimited = (): void => { if (config.rateLimited !== undefined) throw config.rateLimited }

      /** 旧 loomy 闭包的逐字复刻。 */
      const legacy = async (reports: Array<string | undefined>): Promise<LoomyCredential | undefined> => {
        const candidates = pool
          .listAccountsByProvider(PRODUCT.id)
          .filter(a => a.enabled)
          .filter((a) => {
            const key = 'model-x'
            if (key.length === 0) return true
            if (!a.modelRateLimits) return true
            const resetAt = a.modelRateLimits[key]
            return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
          })
          .map(a => ({ id: a.id, credentialRef: a.credentialRef }))

        const allowPermanent = !pool.permanentLocked(PRODUCT.id)
        if (candidates.length > 0) {
          const picked = await selector.select(candidates, { allowPermanent })
          if (picked.ok) {
            const credential = await readCredential(picked.account.credentialRef)
            if (credential !== undefined) {
              reports.push(picked.account.id)
              return credential
            }
          } else if (!allowPermanent) {
            throw loomyLockedError(picked.reason)
          }
        }
        throwIfRateLimited()
        return await readCredential(FALLBACK)
      }

      const next = (reports: Array<string | undefined>) => createCredentialResolver(
        { pool: pool as never, reportAccount: (id) => { if (id !== undefined) reports.push(id) } },
        {
          product: PRODUCT,
          readCredential,
          balance: { kind: 'loomy', selector, lockedError: loomyLockedError },
          ...config.rateLimited === undefined
            ? {}
            : { throwIfAllRateLimited: throwIfRateLimited },
          fallback: { kind: 'ref', refName: FALLBACK },
        },
      )('model-x')
      return { pool, selector, legacy, next }
    }

    const OK_A1: LoomySelectionResult = {
      ok: true,
      account: { id: 'a1', credentialRef: 'LOOMY_ACCOUNT_A1' },
      balance: { id: 'a1', ok: true },
    }

    it('分档选中 ⇒ 同一凭据 / 同一回报 / 同一候选与 allowPermanent', async () => {
      const { selector, legacy, next } = pair({
        entries: [account('a1', 'loomy')],
        credentials: { LOOMY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        result: OK_A1,
      })
      const legacyReports: Array<string | undefined> = []
      expect(await legacy(legacyReports)).toEqual({ access_token: 'tok-a1' })
      const reports: Array<string | undefined> = []
      expect(await next(reports)).toEqual({ access_token: 'tok-a1' })
      expect(reports).toEqual(legacyReports)
      expect(reports).toEqual(['a1'])
      expect(selector.selectCalls[0]?.ids).toEqual(['a1'])
      expect(selector.selectCalls[0]?.allowPermanent).toBe(true)
    })

    it('⚠️ 选中的账号凭据坏掉 ⇒ 两者**都不换号、也不问池**，直接退单凭据', async () => {
      // 变异：把 loomy 分支换成 buddy 分支（`pickBuddyAccount`）⇒ 本条红
      //（会换号选中 a2、且会多调一次 select）。
      const { pool, selector, legacy, next } = pair({
        entries: [account('a1', 'loomy'), account('a2', 'loomy')],
        credentials: { LOOMY_ACCOUNT_A2: JSON.stringify({ access_token: 'tok-a2' }) },
        result: OK_A1,
        fallbackRaw: JSON.stringify({ access_token: 'single' }),
      })
      expect(await legacy([])).toEqual({ access_token: 'single' })
      const afterLegacy = selector.selectCalls.length
      expect(await next([])).toEqual({ access_token: 'single' })
      expect(selector.selectCalls.length - afterLegacy, '不得换号重试').toBe(1)
      expect(pool.calls, 'loomy 的兜底不经过 getAvailableAccount').toEqual([])
    })

    it('⚠️ 锁定 + 分档报 unknown ⇒ 两者抛同一条「无法确认」文案', async () => {
      const { legacy, next } = pair({
        entries: [account('a1', 'loomy')],
        credentials: { LOOMY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        result: { ok: false, reason: { kind: 'unknown', errors: ['网络抖动'] } },
        locked: true,
      })
      const legacyError = await legacy([]).then(() => undefined, (e: Error) => e)
      const nextError = await next([]).then(() => undefined, (e: Error) => e)
      expect(legacyError?.message).toContain('无法确认是否有可用账号')
      expect(nextError?.message).toBe(legacyError?.message)
    })

    it('⚠️ 锁定 + 分档报 exhausted ⇒ 两者抛同一条「今日额度用尽」文案（与 unknown 分开报）', async () => {
      const { legacy, next } = pair({
        entries: [account('a1', 'loomy')],
        credentials: { LOOMY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        result: { ok: false, reason: { kind: 'exhausted' } },
        locked: true,
      })
      const legacyError = await legacy([]).then(() => undefined, (e: Error) => e)
      const nextError = await next([]).then(() => undefined, (e: Error) => e)
      expect(legacyError?.message).toContain('今日赠送额度都已用尽')
      expect(nextError?.message).toBe(legacyError?.message)
      expect(nextError?.message).not.toContain('无法确认')
    })

    it('未锁定 + 分档没选出 ⇒ 两者静默退单凭据（不抛错）', async () => {
      const { legacy, next } = pair({
        entries: [account('a1', 'loomy')],
        credentials: { LOOMY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        result: { ok: false, reason: { kind: 'exhausted' } },
        fallbackRaw: JSON.stringify({ access_token: 'single' }),
      })
      expect(await legacy([])).toEqual({ access_token: 'single' })
      expect(await next([])).toEqual({ access_token: 'single' })
    })

    it('⚠️ 候选被模型限流筛空 ⇒ 两者都判限流并抛同一条错误（且都不调 select）', async () => {
      const limited = new Error('Loomy：模型 model-x 的可用账号均在限流中')
      const { selector, legacy, next } = pair({
        entries: [account('a1', 'loomy', { modelRateLimits: { 'model-x': Date.now() + HOUR } })],
        credentials: { LOOMY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        result: OK_A1,
        rateLimited: limited,
      })
      await expect(legacy([])).rejects.toBe(limited)
      await expect(next([])).rejects.toBe(limited)
      expect(selector.selectCalls, '候选空集时连 select 都不该调').toEqual([])
    })

    it('⚠️ 候选筛法一致：停用账号不进候选、别的模型限流也不进候选', async () => {
      const { selector, legacy, next } = pair({
        entries: [
          account('a1', 'loomy'),
          account('off', 'loomy', { enabled: false }),
          account('other', 'loomy', { modelRateLimits: { '别的模型': Date.now() + HOUR } }),
        ],
        credentials: { LOOMY_ACCOUNT_A1: JSON.stringify({ access_token: 'tok-a1' }) },
        result: OK_A1,
      })
      await legacy([])
      const afterLegacy = selector.selectCalls.length
      await next([])
      const nextCalls = selector.selectCalls.slice(afterLegacy)
      expect(selector.selectCalls[0]?.ids).toEqual(['a1', 'other'])
      expect(nextCalls[0]?.ids).toEqual(selector.selectCalls[0]?.ids)
    })
  })
})
