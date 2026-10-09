import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  BILLING_GROUPS,
  METERED_GROUP_KEY,
  billingGroupOf,
  groupBulkStateFor,
  groupExpanded,
  groupModelsForDisplay,
} from '../../plugin-src/client/model-groups.js'

/**
 * 模型列表的「计费/来源」分组（用户 2026-10-01 选定：订阅 / 免费 / Cloud / 按量计费）。
 *
 * 与 `model-filter.spec.ts` 同理：组件无法在本仓库单测里渲染（react 不在依赖内），
 * 故把判定抽成纯函数才能用真实断言覆盖，而不是靠源码字符串去间接验证。
 *
 * 这组用例锁的核心是三条**真实踩过/会踩**的坑：
 * 1. **免费必须用目录下发的 `isFree`**，不能按前缀猜 —— `stealth/*` 那两条
 *    确实在远端 `free` 数组里，但**不在** `cline-free/` 命名空间下；
 * 2. **分组不能吞模型**：任何一条 id 都必须落在某一组里（并集 = 全集）；
 * 3. **筛选后空的组要整组隐藏**，否则搜一个词会看到一排空标题。
 */
describe('billingGroupOf（单条归组）', () => {
  it('按命名空间归组：cline-pass → 订阅，cline-cloud → Cloud，其余 → 按量计费', () => {
    expect(billingGroupOf({ id: 'cline-pass/deepseek-v4.1-flash' })).toBe('subscription')
    expect(billingGroupOf({ id: 'cline-cloud/glm-5.3' })).toBe('cloud')
    expect(billingGroupOf({ id: 'openai/gpt-6-astra' })).toBe(METERED_GROUP_KEY)
    expect(billingGroupOf({ id: 'deepseek/deepseek-v4.1-flash' })).toBe(METERED_GROUP_KEY)
  })

  /**
   * ⚠️ **这是本模块最容易被写错的一处**：`stealth/*` 不在 `cline-free/` 前缀下，
   * 但它在远端 `free` 数组里 —— 只按前缀判会把两条**免费模型错归进「按量计费」**，
   * 用户以为要花钱而不敢用。
   */
  it('免费看 isFree 而不是前缀（stealth/* 也属于免费）', () => {
    expect(billingGroupOf({ id: 'stealth/pixel-canary', isFree: true })).toBe('free')
    expect(billingGroupOf({ id: 'cline-free/mimo-v2.6-flash', isFree: true })).toBe('free')
    // `:free` 后缀那条同样靠 isFree（它不在任何 cline-* 命名空间下）
    expect(billingGroupOf({ id: 'nvidia/foo-reasoning:free', isFree: true })).toBe('free')
  })

  /**
   * ⚠️ `isFree` **缺失**（老/外部适配器不报）时保守归入按量计费：那是兜底桶，
   * 「没说免费」比「谎称免费」安全（与全仓「未知不编造」一致）。
   */
  it('isFree 缺失或为 false 时按命名空间归组（不谎称免费）', () => {
    expect(billingGroupOf({ id: 'stealth/pixel-canary' })).toBe(METERED_GROUP_KEY)
    expect(billingGroupOf({ id: 'cline-free/x', isFree: false })).toBe(METERED_GROUP_KEY)
  })

  it('垃圾输入归入兜底桶而不抛错', () => {
    for (const bad of [undefined, null, {}, { id: 42 }, 'str']) {
      expect(billingGroupOf(bad), JSON.stringify(bad)).toBe(METERED_GROUP_KEY)
    }
  })
})

describe('groupModelsForDisplay（分组 + 组内筛选）', () => {
  const catalog = [
    { id: 'cline-pass/a', name: 'A', disabled: false },
    { id: 'cline-pass/b', name: 'B', disabled: true },
    { id: 'cline-free/c', name: 'C · 免费', disabled: false, isFree: true },
    { id: 'stealth/d', name: 'D · 免费', disabled: false, isFree: true },
    { id: 'openai/e', name: 'E', disabled: true },
    { id: 'deepseek/f', name: 'F', disabled: true },
  ]

  it('按固定顺序返回非空分组（空组不出现）', () => {
    const groups = groupModelsForDisplay(catalog)
    // 没有 cline-cloud 条目 ⇒ 该组不出现
    expect(groups.map(g => g.key)).toEqual(['subscription', 'free', METERED_GROUP_KEY])
    expect(groups.map(g => g.label)).toEqual(['订阅额度', '免费额度', '按量计费'])
  })

  /** ⚠️ 并集必须等于全集：任何一条都不能因为分组而消失。 */
  it('分组是并集：所有条目都出现在某一组里，且不重复', () => {
    const groups = groupModelsForDisplay(catalog)
    const ids = groups.flatMap(g => g.models.map(m => m.id))
    expect(ids.sort()).toEqual(catalog.map(m => m.id).sort())
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('组内保持目录原序（不重排）', () => {
    const groups = groupModelsForDisplay([
      { id: 'openai/1' }, { id: 'openai/2' }, { id: 'openai/3' },
    ])
    expect(groups[0]!.models.map(m => m.id)).toEqual(['openai/1', 'openai/2', 'openai/3'])
  })

  it('统计：total 是筛选前条数，shown 是筛选后条数，disabled 是其中的关闭数', () => {
    const groups = groupModelsForDisplay(catalog)
    const sub = groups.find(g => g.key === 'subscription')!
    expect(sub.counts).toEqual({ total: 2, shown: 2, disabled: 1 })
    const metered = groups.find(g => g.key === METERED_GROUP_KEY)!
    expect(metered.counts).toEqual({ total: 2, shown: 2, disabled: 2 })
  })

  it('搜索与状态筛选就地生效（组内过滤，计数同步）', () => {
    const groups = groupModelsForDisplay(catalog, { query: 'a', status: 'all' })
    // `a` 命中 cline-pass/a、stealth/d（name 含 · 免费？不）—— 只断言被筛的组还在
    expect(groups.every(g => g.models.length === g.counts.shown)).toBe(true)
    expect(groups.flatMap(g => g.models).length).toBeLessThan(catalog.length)
  })

  /** ⚠️ 搜索命中某组时，其余组整组隐藏（否则一排空标题看着像坏了）。 */
  it('筛选后无命中的组整组隐藏', () => {
    const groups = groupModelsForDisplay(catalog, { query: 'deepseek' })
    expect(groups.map(g => g.key)).toEqual([METERED_GROUP_KEY])
    expect(groups[0]!.models.map(m => m.id)).toEqual(['deepseek/f'])
    expect(groups[0]!.counts).toEqual({ total: 2, shown: 1, disabled: 1 })
  })

  it('状态筛选只影响 shown/disabled，不改 total', () => {
    const groups = groupModelsForDisplay(catalog, { status: 'enabled' })
    const metered = groups.find(g => g.key === METERED_GROUP_KEY)
    // 按量计费那 3 条全关 ⇒ 「已打开」筛选下整组隐藏
    expect(metered).toBeUndefined()
    const sub = groups.find(g => g.key === 'subscription')!
    expect(sub.counts).toEqual({ total: 2, shown: 1, disabled: 0 })
  })

  it('空目录与垃圾输入返回空数组', () => {
    for (const bad of [undefined, null, [], 'str', 42]) {
      expect(groupModelsForDisplay(bad), JSON.stringify(bad)).toEqual([])
    }
  })
})

describe('groupExpanded（默认展开策略）', () => {
  const sub = { key: 'subscription' }
  const metered = { key: METERED_GROUP_KEY }

  it('默认：合并计费/免费/Cloud 展开，按量计费折叠', () => {
    expect(groupExpanded(sub, {})).toBe(true)
    expect(groupExpanded({ key: 'free' }, {})).toBe(true)
    expect(groupExpanded({ key: 'cloud' }, {})).toBe(true)
    expect(groupExpanded(metered, {})).toBe(false)
  })

  /** ⚠️ 有搜索/筛选时一律展开：否则搜到的结果藏在折叠组里，看起来像「没搜到」。 */
  it('有筛选时一律展开（含按量计费）', () => {
    expect(groupExpanded(metered, { filterActive: true })).toBe(true)
  })

  it('用户点过就以用户为准（两个方向都算数）', () => {
    expect(groupExpanded(metered, { toggled: true })).toBe(true)
    expect(groupExpanded(sub, { toggled: false })).toBe(false)
    // 用户显式折叠时，即使有筛选也不自动展开（那是他刚做的选择）
    expect(groupExpanded(sub, { toggled: false, filterActive: true })).toBe(false)
  })
})

describe('groupBulkStateFor（本组全开/全关的可用性）', () => {
  it('已经是目标状态时对应按钮禁用（与顶部批量同一套判据）', () => {
    const allOn = { models: [{ disabled: false }, { disabled: false }] }
    expect(groupBulkStateFor(allOn, false)).toEqual({ openAllDisabled: true, closeAllDisabled: false })
    const allOff = { models: [{ disabled: true }] }
    expect(groupBulkStateFor(allOff, false)).toEqual({ openAllDisabled: false, closeAllDisabled: true })
  })

  it('提交中或空组一律全禁用', () => {
    const mixed = { models: [{ disabled: true }, { disabled: false }] }
    expect(groupBulkStateFor(mixed, true)).toEqual({ openAllDisabled: true, closeAllDisabled: true })
    expect(groupBulkStateFor({ models: [] }, false)).toEqual({ openAllDisabled: true, closeAllDisabled: true })
    expect(groupBulkStateFor(null, false)).toEqual({ openAllDisabled: true, closeAllDisabled: true })
  })
})

/**
 * 接线断言（源码级）：本仓库无法渲染组件，故用源码锁住「面板确实按分组渲染、
 * 且本组批量确实走**按子集**的端点」—— 这两条一旦被改回去，用例就该红。
 */
describe('Jet Hub 面板的分组接线', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const client = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

  it('面板按分组渲染（不再是平铺 filtered.map）', () => {
    expect(client).toMatch(/const groups = groupModelsForDisplay\(all, \{ query, status: statusFilter \}\)/)
    expect(client).toMatch(/groups\.map\(group => \{/)
    // 平铺渲染必须已被替换
    expect(client).not.toMatch(/filtered\.map\(model => React\.createElement\(ModelToggle/)
  })

  it('组头带折叠、计数与「本组全开/全关」', () => {
    expect(client).toMatch(/dim-jh-modelGroupHead/)
    expect(client).toMatch(/dim-jh-modelGroupToggle/)
    expect(client).toMatch(/'全开'/)
    expect(client).toMatch(/'全关'/)
    expect(client).toMatch(/onClick: \(\) => toggleGroup\(group\)/)
  })

  /**
   * ⚠️ 本组批量**必须**走 `model.setDisabledMany`（按子集）：用
   * `model.setAllDisabled` 会把用户特意关着的其它分组一起打开/关闭。
   */
  it('本组批量走按子集的端点（不是 setAllDisabled）', () => {
    expect(client).toMatch(/rpcCall\('model\.setDisabledMany', \{ provider, modelIds: ids, disabled \}\)/)
    expect(client).toMatch(/const setGroupDisabled = async \(group, disabled\) => \{/)
    // 关闭方向要二次确认（一次误点会关掉一整组）
    expect(client).toMatch(/if \(disabled && !confirm\(/)
  })

  /** 分组批量也算「批量」：提交期间单条开关必须禁用（黑名单是整体写入）。 */
  it('分组提交期间单条开关一并禁用', () => {
    expect(client).toMatch(/busy: busyIds\.has\(model\.id\) \|\| bulkBusy \|\| groupBusy !== null/)
  })
})
