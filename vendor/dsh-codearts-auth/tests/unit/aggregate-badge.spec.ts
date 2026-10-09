import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AGGREGATE_PROVIDER_ID, resolveBadgeProvider } from '../../plugin-src/client/badge-model.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const read = (rel) => readFileSync(resolve(here, '../..', rel), 'utf8')

/**
 * 去掉注释后的源码。
 *
 * ⚠️ 反面断言必须基于它：本仓库的注释里**大量引用**被禁止/被说明的写法，
 * 直接对全文断言会把注释判成违规（既有 `usage-badge-client.spec.ts` 的
 * `codeOf` 同款，那里因这个坑红过两次）。
 */
const codeOf = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

describe('★ P3：resolveBadgeProvider —— 聚合重定向到「上次实际选中的渠道」', () => {
  it('非聚合 provider 原样返回（其余 15 家的行为必须逐字不变）', () => {
    for (const p of ['buddy', 'codearts', 'zcode', 'opencode', 'gemini']) {
      expect(resolveBadgeProvider(p, { provider: 'buddy' })).toBe(p)
    }
  })

  it('★ 聚合 + 有历史 ⇒ 重定向到那个真实渠道', () => {
    expect(resolveBadgeProvider('aggregate', { provider: 'buddy' })).toBe('buddy')
    expect(resolveBadgeProvider('aggregate', { provider: 'codearts' })).toBe('codearts')
  })

  it('★ 聚合 + 无历史 ⇒ 返回 null（**不渲染**，不做预测）', () => {
    // ⚠️ 规格 §6.3 的 P4：尚未发过任何请求 / 插件重启后内存清空 ⇒ 不渲染徽标。
    //    **不做预测** —— 用户明确选了「真实历史」，预测胜者可能因失败切换而未被使用，
    //    显示一个错的渠道比不显示更误导。
    expect(resolveBadgeProvider('aggregate', null)).toBe(null)
    expect(resolveBadgeProvider('aggregate', undefined)).toBe(null)
    expect(resolveBadgeProvider('aggregate', {})).toBe(null)
    expect(resolveBadgeProvider('aggregate', { provider: null })).toBe(null)
  })

  it('★ 空 / 畸形入参 ⇒ null（不抛错）', () => {
    expect(resolveBadgeProvider(undefined, { provider: 'buddy' })).toBe(null)
    expect(resolveBadgeProvider('', { provider: 'buddy' })).toBe(null)
    expect(resolveBadgeProvider(null, { provider: 'buddy' })).toBe(null)
    expect(resolveBadgeProvider('aggregate', 'not-an-object')).toBe(null)
    expect(resolveBadgeProvider('aggregate', { provider: 42 })).toBe(null)
    expect(resolveBadgeProvider('aggregate', { provider: '' })).toBe(null)
  })

  it('★ 宿主回传的渠道本身是 aggregate 时不得自指（否则无限重定向/门控失效）', () => {
    // ⚠️ 防御：若宿主误把 aggregate 当真实渠道记下，重定向会得到 `aggregate` 自己
    //    ⇒ 又走一遍重定向（或直接进门控并被判无余额能力而消失）。故显式拒绝自指。
    expect(resolveBadgeProvider('aggregate', { provider: 'aggregate' })).toBe(null)
  })

  it('聚合 provider id 常量与宿主一致', () => {
    expect(AGGREGATE_PROVIDER_ID).toBe('aggregate')
  })
})

describe('★ P3：usage-badge.js 的重定向必须在门控**之前**', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const badgeCode = codeOf(badge)

  it('★ 门控那两行逐字未变（规格 §6.6 的硬约束）', () => {
    // ⚠️ 这两条是**既有断言**（`usage-badge-client.spec.ts`）逐字钉住的，
    //    本任务**不得**修改它们 —— 重定向必须在它们之前完成。
    expect(badge).toContain('if (!supportsCreditBalance(provider)) return null;')
    expect(badge).toMatch(/typeof provider !== 'string' \|\| provider\.length === 0/)
  })

  it('★ 重定向调用出现在门控**之前**', () => {
    const redirectAt = badgeCode.indexOf('resolveBadgeProvider(')
    const gateAt = badgeCode.indexOf('if (!supportsCreditBalance(provider)) return null;')
    expect(redirectAt, 'usage-badge.js 必须调用 resolveBadgeProvider').toBeGreaterThan(0)
    expect(gateAt).toBeGreaterThan(0)
    // ⚠️ 顺序是**语义性**的：门控读的 `provider` 必须已是真实渠道，
    //    否则 `aggregate` 会因能力表登记为 `balance:false` 而被门控拦掉 ⇒ 徽标永不显示。
    expect(redirectAt).toBeLessThan(gateAt)
  })

  it('★ 无历史时整体不渲染（复用既有的空 provider 形态，不另造判据）', () => {
    // ⚠️ 规格 §6.6：徽标的「无历史 ⇒ 不渲染」应**复用** `typeof provider !== 'string'
    //    || provider.length === 0` 那一形态。重定向返回 null 后，`provider` 变成
    //    null ⇒ 该既有门控天然拦掉它 ⇒ **不需要**新增一条判据。
    // ⚠️ 实现是**就地赋回 `provider`**（不是新造 `const resolved = ...`）——
    //    因为那两行门控是既有断言**逐字钉住**的，换变量名会让
    //    `usage-badge-client.spec.ts` 的正则失配（实测撞过一次）。
    expect(badgeCode).toMatch(/provider = resolveBadgeProvider\(/)
    expect(badgeCode).toContain('typeof provider !== \'string\' || provider.length === 0')
  })

  it('★ 重定向后的真实渠道传给 UsageBadgeActive（X1：靠既有 useEffect([provider]) 重挂载）', () => {
    // ⚠️ 规格 §6.4 的 X1：把真实渠道 id 传给 `UsageBadgeActive`，则它的
    //    `useEffect([provider])` 天然在渠道变化时重挂载并重新 load
    //    ⇒ **零新订阅**即可满足「随切换更新」。
    expect(badgeCode).toMatch(/React\.createElement\(UsageBadgeActive,\s*\{\s*\.\.\.props,\s*provider\s*\}\)/)
  })

  it('★ 不得使用 pickCurrentAutoProvider（它是预测语义且要发网络请求）', () => {
    // ⚠️ 规格 §6.5：`src/auto-adapter.ts` 的 `pickCurrentAutoProvider` 是
    //    「预留但从未接线」的钩子，语义是**预测**（预检余额、算临期胜者），
    //    与用户选定的「真实历史」不符，且有自己的网络成本。
    expect(badgeCode).not.toContain('pickCurrentAutoProvider')
  })

  it('★ 门控真相源仍是能力表（不得改成 PROVIDERS 列表）', () => {
    expect(badgeCode).not.toContain('PROVIDERS.includes')
    expect(badgeCode).not.toContain('PROVIDERS.some')
  })
})

describe('★ P3：重定向取数必须能**反复**刷新（真实缺陷回归）', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const badgeCode = codeOf(badge)

  /**
   * 抽出**重定向取数那一段**源码。
   *
   * ⚠️ 必须切片断言，不能全文匹配：`clearInterval` / `BADGE_POLL_MS` 在本文件里
   * **本来就存在**（`UsageBadgeActive` 自己的 60 秒轮询），全文断言会恒真 ——
   * 那是比没有用例更糟的同义反复。
   */
  const redirectBlock = (() => {
    const start = badgeCode.indexOf('const readActiveProvider = props.readActiveProvider;')
    expect(start, '必须存在重定向取数段').toBeGreaterThan(0)
    const end = badgeCode.indexOf('if (isAggregate) {', start)
    expect(end, '必须存在重定向赋值').toBeGreaterThan(start)
    return badgeCode.slice(start, end)
  })()

  it('★ 真实缺陷：effect 只跑一次 ⇒ 发完消息后徽标仍不显示', () => {
    // ⚠️⚠️ **用户报障**（2026-10-07）：「用聚合模型发送信息前后都没有流量徽标显示」。
    //
    // 根因是我实现里的一个**设计错误**：取 `activeProvider` 的 effect 依赖数组是
    // `[isAggregate, readActiveProvider]`，而这两个值在「无历史」时都**稳定不变**
    //（`isAggregate` 由 `provider === 'aggregate'` 决定，而 `provider` 正是**等着
    //  这次取数才能变**的那一个）⇒ effect **只跑一次**，取到 `null` 之后永不重取。
    //
    // ⇒ 循环依赖：规格 §6.4 的 X1 假设「渠道变化会让 `provider` 变、进而重挂载」，
    //    但在**首次**拿到渠道之前，`provider` 恒为 `aggregate`、永远不会变。
    //    X1 只在「已经有过历史」之后才成立 —— 我照抄 X1 而没有验证这一点。
    expect(redirectBlock, '重定向取数必须有定时重试（否则无历史时永不刷新）')
      .toMatch(/setInterval\(/)
  })

  it('★ 定时器必须被清理（组件卸载后不得继续打 RPC）', () => {
    expect(redirectBlock, '重定向段的定时器必须在清理函数里 clearInterval')
      .toMatch(/clearInterval\(timer\)/)
  })

  it('★ 重试间隔必须用**独立**常量，且比余额轮询快得多', () => {
    // ⚠️ 不能沿用 `BADGE_POLL_MS`（60 秒）：那个常量管的是**余额读数**，
    //    要经宿主打上游（宿主 TTL 120s）；缩短它会让上游请求变密。
    //    而本查询是**纯内存读**（零网络），成本可忽略。
    // ⚠️ 更要紧的是**观感**：若用 60 秒，用户发完消息后最多等 60 秒才看到徽标出现
    //    —— 那仍然像「徽标坏了」。规格 §6.4 正是**因为「最长 60 秒才更新」而否决了
    //    「只靠轮询」的方案**，所以这里不能沿用那个节奏。
    expect(redirectBlock).toMatch(/setInterval\(refresh, ACTIVE_PROVIDER_POLL_MS\)/)
    expect(redirectBlock, '不得把两个常量合并（成本差几个数量级）')
      .not.toMatch(/setInterval\(refresh, BADGE_POLL_MS\)/)
    // 常量本身必须是独立导出，且显著小于 60 秒。
    expect(badge).toMatch(/export const ACTIVE_PROVIDER_POLL_MS = ([\d_]+);/)
    const value = Number(
      /export const ACTIVE_PROVIDER_POLL_MS = ([\d_]+);/.exec(badge)?.[1]?.replace(/_/g, '') ?? 'NaN',
    )
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeLessThan(10_000)
    expect(value).toBeGreaterThan(0)
  })

  it('★ 必须**持续**轮询，不能「取到值就停」（否则「随切换更新」失效）', () => {
    // ⚠️ 我一度想「取到渠道就 clearInterval」省一个空转定时器 —— 那会破坏需求：
    //    聚合层换候选后宿主记录变了，而**外层只有重新取数才会拿到新的 `provider`**；
    //    停了定时器，渠道就永远停在第一次那个值上（用户看到「徽标不跟着变」）。
    //    故清理**只能**出现在 effect 的 return 里，不能在 then 的成功分支里。
    const successBranches = redirectBlock.split('.then(').slice(1)
    expect(successBranches.length, '重定向段应有 then 分支').toBeGreaterThan(0)
    for (const branch of successBranches) {
      const body = branch.slice(0, branch.indexOf('})'))
      expect(body, '取数成功分支里不得 clearInterval（会破坏「随切换更新」）')
        .not.toMatch(/clearInterval/)
    }
  })
})
