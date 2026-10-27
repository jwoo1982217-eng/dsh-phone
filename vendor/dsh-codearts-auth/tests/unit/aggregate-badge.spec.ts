import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGGREGATE_PROVIDER_ID, resolveBadgeProvider } from '../../plugin-src/client/badge-model.js'

/**
 * 仓库根（源码级断言用）。
 *
 * ⚠️ **必须用 `fileURLToPath`，不能用 `URL.pathname`**（真实缺陷，Gitee issue
 * IKLBSH A3）：`pathname` 对路径里的空格做**百分号编码**（`D:\Vibe coding\…`
 * → `/D:/Vibe%20coding/…`），而原先只 `replace(/^\/([A-Za-z]:)/, '$1')` 修盘符
 * 前缀、**不修 `%20`** ⇒ `readFileSync` 对含空格路径恒 ENOENT，
 * 而 vitest 把它报成**整份 spec 收集失败**（不是单个用例失败），
 * 看起来像测试基建坏了而不是路径判据错了。
 * `fileURLToPath`（`node:url` 自带）做正确的百分号解码。
 *
 * ⚠️ 该修复的守卫在 `tests/unit/path-source-read.spec.ts`（结构性扫描）——
 * 因为**在本机无空格路径下把这里改回去仍全绿**（对抗审计实测 98 条绿），
 * 逐文件的变异验证测不出它。
 */
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

  it('★ 无历史时改为渲染「待首次请求」占位胶囊（2026-10-08 用户报障后改口径）', () => {
    // ⚠️ 原口径是「无历史 ⇒ 整体不渲染」（规格 §6.6：复用既有的空 provider 形态）。
    //    用户报障「也没胶囊了？」后改成本条 —— 理由见 `usage-badge.js` 里那段注释：
    //    徽标在本插件里是**止损工具**，整个消失会让用户分不清「聚合没在用」
    //    与「徽标坏了」。
    //
    // ⚠️ 但「**不预测渠道**」这条约束**仍然成立**（规格 §6.3 的 P4 核心）：占位文案
    //    只说「待首次请求」，不编造任何渠道名。下面同时断言两件事。
    expect(badgeCode).toMatch(/if \(isAggregate && provider === null\) \{/)
    // ⚠️ 实现必须仍是**就地赋回 `provider`**（不是新造 `const resolved = ...`）——
    //    因为那两行门控是既有断言**逐字钉住**的，换变量名会让
    //    `usage-badge-client.spec.ts` 的正则失配（实测撞过一次）。
    expect(badgeCode).toMatch(/provider = resolveBadgeProvider\(/)
    // 占位分支必须**在**空 provider 门控之前（否则 `provider === null` 会先被它 return null）。
    const pendingAt = badgeCode.indexOf('if (isAggregate && provider === null) {')
    const emptyGateAt = badgeCode.indexOf("typeof provider !== 'string' || provider.length === 0")
    expect(pendingAt).toBeGreaterThan(0)
    expect(emptyGateAt).toBeGreaterThan(0)
    expect(pendingAt).toBeLessThan(emptyGateAt)
    // 占位文案不得出现任何具体渠道名（那是「预测」）。
    const pendingBlock = badgeCode.slice(pendingAt, emptyGateAt)
    for (const p of ['buddy', 'codearts', 'zcode', 'loomy', 'workbuddy']) {
      expect(pendingBlock, `占位胶囊不得预测渠道「${p}」`).not.toContain(p)
    }
  })

  it('★ 非聚合的空 provider 仍然整体不渲染（既有正确行为不得被占位分支带跑）', () => {
    // ⚠️ 占位分支的判据是 `isAggregate && provider === null` —— 非聚合时
    //    `isAggregate` 为假 ⇒ 继续走下面的空 provider 门控 ⇒ 不渲染。
    //    「新会话尚未选模型」那条路径的行为**逐字不变**。
    expect(badgeCode).toMatch(/typeof provider !== 'string' \|\| provider\.length === 0/)
    expect(badgeCode).toContain('if (!supportsCreditBalance(provider)) return null;')
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

  it('★★ 必须把**当前模型 id** 传给端点（否则徽标显示别的模型走过的渠道）', () => {
    // ⚠️⚠️ **真实缺陷**（用户报障 2026-10-16）：「我们用 glm5.3 后徽标显示的 provider
    //    是腾讯 codebuddy，不是排序的第一个 OfficeAce」。
    //
    // 根因：本处原先调 `readActiveProvider()` **不传参数**，而宿主
    // `aggregate.activeProvider` 在**无参**时回 `lastActiveProvider` ——
    // 「**任意虚拟模型**最近一次成功」的渠道，**不是你当前选中的那个模型**。
    // ⇒ 用 GLM-5.3（手工序第一位 officeace）时，徽标显示的是**别的模型**
    //（如 DeepSeek V4.1 Flash）上次走成功的 buddy（腾讯）。
    //
    // ⚠️ 宿主**本来就**按模型分开记录（`activeProviderByModel`），端点的
    //   `canonicalId` 参数也一直存在 —— 只是客户端从来没传。
    expect(redirectBlock, '★ 取数必须传模型 id').toMatch(/readActiveProvider\(modelId\)/)
    expect(redirectBlock, '★ 不得退回无参调用（那正是本缺陷）')
      .not.toMatch(/readActiveProvider\(\)/)
    // ★ 且模型 id 必须真的来自目录快照的 `current.model`（不是另造一份来源）。
    expect(badge, 'modelId 必须取自 current.model')
      .toMatch(/const modelId = state\?\.current\?\.model/)
    // ★ effect 依赖必须含 `modelId`：用户切模型时要立刻按新模型重查，
    //   否则会一直显示旧模型的渠道（与「定时器常驻」那条需求同因）。
    expect(redirectBlock, '★ 依赖数组必须含 modelId')
      .toMatch(/\}, \[isAggregate, readActiveProvider, modelId\]\)/)
  })
})
