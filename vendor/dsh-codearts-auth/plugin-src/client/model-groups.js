/**
 * 模型列表的**「计费/来源」分组**（纯逻辑）。
 *
 * ## 为什么按这个口径分组（用户 2026-10-01 选定）
 *
 * Cline 的目录实测约 **488 条**（67 个命名空间）—— 平铺没法看。用户真正关心的
 * 不是「哪个厂商」，而是**这条模型算哪种账**：
 *
 * | 组 | 判据 | 实测规模 |
 * |---|---|---|
 * | 订阅额度 | `cline-pass/*` | 18 |
 * | 免费额度 | **远端 free 集合**（`isFree === true`） | 7（5 `cline-free/*` + 2 `stealth/*`） |
 * | Cline Cloud | `cline-cloud/*` | 有则显示，无则该组不出现 |
 * | 按量计费 | 其余全部（走账户余额结算） | 460+ |
 *
 * ⚠️ **免费必须用目录下发的 `isFree`，不能在前端按前缀猜**：免费集合是远端
 * `recommended-models` 的 `free` 数组 + `:free` 后缀 + `cline-free/` 前缀的
 * **并集**（见 `src/cline-models.ts`），而且 `stealth/*` 这类**不在** `cline-free/`
 * 命名空间下的也属于免费 —— 按前缀猜会把它们错归进「按量计费」。
 *
 * ⚠️ `isFree` **缺失**（老/外部适配器不报）时保守归入「按量计费」：那是兜底桶，
 * 语义上「没说免费」比「谎称免费」安全（与全仓「未知不编造」一致）。
 *
 * ## 为什么放在独立文件
 *
 * 与 `model-filter.js` / `model-bulk.js` 同理：本仓库单测环境里 react 不在依赖内，
 * 组件无法渲染，只有把判定逻辑抽成纯函数才能用真实断言覆盖。
 */

import { filterModels } from './model-filter.js';
import { bulkButtonState } from './model-bulk.js';

/**
 * 分组的**固定展示顺序**：用户真正在用的层级在前，兜底大桶在后。
 *
 * `hint` 是组头 tooltip 的判据说明 —— 用户看到「免费额度」里有 `stealth/*`
 * 时不必怀疑分组错了。
 */
export const BILLING_GROUPS = Object.freeze([
  Object.freeze({ key: 'subscription', label: '订阅额度', hint: 'Cline Pass 订阅模型（cline-pass/*）' }),
  Object.freeze({ key: 'free', label: '免费额度', hint: 'Cline 远端 free 集合（含 cline-free/* 与 stealth/*）' }),
  Object.freeze({ key: 'cloud', label: 'Cline Cloud', hint: 'Cline Cloud 模型（cline-cloud/*）' }),
  Object.freeze({ key: 'metered', label: '按量计费', hint: '其余模型：走账户余额按量结算' }),
])

/** 兜底桶的 key（`billingGroupOf` 的最后一条分支，也是默认折叠的那一组）。 */
export const METERED_GROUP_KEY = 'metered'

/**
 * 一个模型属于哪一组。
 *
 * ⚠️ 顺序有意为之：**先看 `isFree`**（权威标记），再看命名空间。若上游哪天把
 * 某条 `cline-pass/*` 也标成免费，免费才是实话。
 *
 * @param {{ id?: string, isFree?: boolean } | null | undefined} model 目录条目
 * @returns {string} `subscription` / `free` / `cloud` / `metered`
 */
export function billingGroupOf(model) {
  if (model?.isFree === true) return 'free'
  const id = typeof model?.id === 'string' ? model.id : ''
  if (id.startsWith('cline-pass/')) return 'subscription'
  if (id.startsWith('cline-cloud/')) return 'cloud'
  return METERED_GROUP_KEY
}

/**
 * 把目录切成展示用的分组，并**就地应用搜索与状态筛选**。
 *
 * - 组内保持目录原序（不重排 —— 顺序本身就是适配器播报的顺序）；
 * - **空组不返回**（`cline-cloud/*` 目前就没有），避免界面上出现空标题；
 * - **筛选后无命中的组整组隐藏**，否则用户搜一个词会看到一堆空标题。
 *
 * @param {Array<{ id: string, name?: string, disabled?: boolean, isFree?: boolean }> | null} models 全量目录
 * @param {{ query?: string, status?: string }} [options] 搜索词与状态筛选（同 `filterModels`）
 * @returns {Array<{ key: string, label: string, hint: string, models: Array<object>,
 *   counts: { total: number, shown: number, disabled: number } }>}
 *   `counts.total` 是该组**未筛选前**的条数，`shown` 是筛选后的条数
 *   （无筛选时两者相等），`disabled` 是筛选后其中已关闭的条数。
 */
export function groupModelsForDisplay(models, options = {}) {
  const list = Array.isArray(models) ? models : []
  const buckets = new Map(BILLING_GROUPS.map(group => [group.key, []]))
  for (const model of list) {
    const key = billingGroupOf(model)
    const bucket = buckets.get(key)
    if (bucket === undefined) continue
    bucket.push(model)
  }
  const groups = []
  for (const definition of BILLING_GROUPS) {
    const total = buckets.get(definition.key) ?? []
    if (total.length === 0) continue
    const shown = filterModels(total, options)
    if (shown.length === 0) continue
    groups.push({
      key: definition.key,
      label: definition.label,
      hint: definition.hint,
      models: shown,
      counts: {
        total: total.length,
        shown: shown.length,
        disabled: shown.filter(model => model.disabled === true).length,
      },
    })
  }
  return groups
}

/**
 * 某一组此刻是否展开。
 *
 * 优先级（从高到低）：
 * 1. **用户显式点过**（`toggled` 是布尔）—— 用户的选择永远优先；
 * 2. **有生效中的搜索/筛选时一律展开** —— 否则搜到的结果藏在折叠组里，
 *    看起来像「没搜到」；
 * 3. 默认值：**「按量计费」折叠，其余展开**。
 *    按量计费是兜底大桶（实测 460+ 条、多数是关的），默认展开等于把列表撑到
 *    没法用；而订阅/免费/Cloud 是用户真正在用的层级，本就该一眼看到。
 *
 * @param {{ key?: string }} group 分组
 * @param {{ filterActive?: boolean, toggled?: boolean }} [options]
 * @returns {boolean}
 */
export function groupExpanded(group, options = {}) {
  const toggled = options.toggled
  if (toggled === true || toggled === false) return toggled
  if (options.filterActive === true) return true
  return group?.key !== METERED_GROUP_KEY
}

/**
 * 某一组「全开 / 全关」两个按钮的禁用状态。
 *
 * 直接复用 `bulkButtonState`（与顶部「打开全部 / 关闭全部」同一套判据）：
 * 已经是目标状态时按钮必须禁用，否则点了看不到变化、像是坏了。
 *
 * @param {{ models?: Array<{ disabled: boolean }> }} group 分组
 * @param {boolean} busy 是否有批量提交正在进行（含其它组的）
 */
export function groupBulkStateFor(group, busy) {
  return bulkButtonState(group?.models ?? null, busy)
}
