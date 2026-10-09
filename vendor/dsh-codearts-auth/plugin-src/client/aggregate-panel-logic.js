/**
 * 聚合设置面板的**纯逻辑**（模型排序 / 候选行文案 / 拒绝开关判据）。
 *
 * ## 为什么必须独立成文件（本仓库的既有约束）
 *
 * 本仓库的单测环境**没有 react** ⇒ 组件无法渲染 ⇒ 判定与文案必须抽成纯函数才能被
 * 覆盖。先例：`provider-toggle.js` / `model-bulk.js` / `credits-capabilities.js` /
 * `openai-gateway-panel.js` 都因此独立成文件。
 *
 * ## 拒绝状态以 `true` 为准
 *
 * 与宿主 `sanitizeAggregateRejections` 同口径（只有**显式 `true`** 算拒绝）。
 *
 * ## ⚠️ 曾经有「按厂商分组」，已按用户要求删除（2026-10-07）
 *
 * 用户原话：「聚合模型中显示 8 个聚合模型下面不需要再显示渠道了，因为渠道在每个
 * 模型的展开展示参与轮换的子列表中显示了」。
 *
 * ⇒ 面板不再显示「华为云 (2) / 腾讯 (5)」这类**分组标题**，模型直接平铺，
 * 全局按候选渠道数降序（`sortModelsForPanel`）。厂商信息仍可在每个模型**展开后的
 * 子列表**里逐条看到 —— 那里显示的才是用户真正要看的渠道维度信息。
 *
 * ⚠️ 随之删除了 `vendorOf` / `groupByVendor` / `VENDOR_OF`：去掉分组后它们
 * **零调用者**，而本仓库对死代码有明确红线（第 2 轮审计正是把 `AGGREGATE_TTL_MS`
 * 死配置列为 Important 缺陷）。需要时 git 历史里可找回。
 */

/**
 * 面板模型列表的排序：**全局按候选渠道数降序**（渠道多的在前 —— 冗余度高、
 * 最不容易挂），候选数相同时按 `canonicalId` 升序（结果稳定，便于断言与
 * 面板顺序稳定）。
 *
 * ## ⚠️ 与旧的「先按厂商分组再组内排序」的行为差异
 *
 * 旧实现会先按厂商分段，于是「华为云 6 个候选」可能排在「腾讯 2 个候选」**后面**
 *（因为厂商之间按厂商名升序）。去掉分组后是**全局**降序 —— 这正是本函数存在的原因，
 * 有一条用例专门锁住这个差异。
 *
 * ⚠️ **纯函数**：返回新数组，不改入参（React 靠引用变化重渲染）。
 * ⚠️ 畸形输入一律退化为空数组，不抛错（面板渲染不能因一条坏数据整体崩掉）。
 *
 * @param {Array<{ canonicalId: string, name?: string, candidates?: unknown[] }>} models
 * @returns {Array<unknown>}
 */
export function sortModelsForPanel(models) {
  if (!Array.isArray(models)) return []
  return [...models].sort((a, b) => {
    const byCount = (b?.candidates?.length ?? 0) - (a?.candidates?.length ?? 0)
    if (byCount !== 0) return byCount
    return String(a?.canonicalId ?? '').localeCompare(String(b?.canonicalId ?? ''))
  })
}

/**
 * 该虚拟模型的候选是否**全部被拒**。
 *
 * ## ⚠️ 为什么需要它（规格 §5.2 末段的成文要求）
 *
 * 规格原文：「把某虚拟模型的候选**全部**拒绝（L3）**不等于**关闭该虚拟模型 ——
 * 前者仍然出现在目录里（只是无候选可用，请求时如实报错），后者从目录消失。
 * **面板需对「候选全部被拒」给出显式提示，避免用户以为模型坏了。**」
 *
 * ⚠️ 没有提示时用户选了这个模型 → 请求抛
 * `MISSING_CREDENTIAL |「xxx」当前没有任何可用候选（渠道被关闭、模型被关、或所有
 * 渠道都无可用账号）` —— 那句话**不会**提到「是你自己全部拒绝的」，
 * 于是用户以为模型坏了 / 以为没登录，而真实原因就在面板里。
 *
 * @param {{ canonicalId?: string, candidates?: Array<unknown> } | null | undefined} model
 * @param {Record<string, Record<string, Record<string, boolean>>>} rejections
 * @returns {boolean} 有候选、且**每一条**都被拒 ⇒ `true`（无候选时 `false`）
 */
export function isAllCandidatesRejected(model, rejections) {
  if (typeof model !== 'object' || model === null) return false
  const candidates = model.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return false
  return candidates.every((candidate) => isRejected(
    rejections,
    model.canonicalId,
    candidate?.provider,
    candidate?.realId,
  ))
}

/**
 * 把 `aggregate.catalog` 的响应**摊平**成拒绝表（`canonicalId → provider → realId → true`）。
 *
 * ## ⚠️⚠️ 为什么需要它（真实缺陷，对抗审计探针实测证伪）
 *
 * 宿主在 `aggregate.catalog` 的**每个候选**上返回 `rejected: boolean`
 *（`src/aggregate-adapter.ts:343`、`src/types.ts:933`），而客户端**从不读它** ——
 * 组件读的是本地 `rejections` 状态，那个状态的初值是 `{}` 且 `load()` **从不回填**。
 *
 * ⇒ **刷新页面后每条开关都显示「参与轮换」**（即使该候选已被拒绝）。
 * 用户无法通过界面判断自己拒绝过什么；而一旦点击，发出的语义与**宿主真实状态**
 * 可能相反（界面说「参与轮换」而宿主是「已拒绝」）⇒ 静默改变轮换行为。
 *
 * ⇒ `load()` 必须用本函数回填：把宿主返回的 `rejected: true` 摊成三层结构。
 *
 * ⚠️ **摊平逻辑必须是纯函数**（单测环境没有 react）且与 {@link isRejected} 的
 * 三层结构**逐层一致**（`canonicalId → provider → realId → true`）—— 两处结构
 * 不一致会让回填静默失效（`isRejected` 查不到 ⇒ 界面仍显示「参与轮换」）。
 *
 * ⚠️ 只收**显式 `true`**（与宿主 `sanitizeAggregateRejections` 同口径）：
 * 畸形数据不得让它建出空层。
 *
 * @param {Array<{ canonicalId?: string, candidates?: Array<{ provider?: string, realId?: string, rejected?: boolean }> }>} models
 * @returns {Record<string, Record<string, Record<string, boolean>>>}
 */
export function rejectionsFromCatalog(models) {
  const out = {}
  if (!Array.isArray(models)) return out
  for (const model of models) {
    const canonicalId = model?.canonicalId
    if (typeof canonicalId !== 'string' || canonicalId.length === 0) continue
    if (!Array.isArray(model.candidates)) continue
    for (const candidate of model.candidates) {
      if (candidate?.rejected !== true) continue
      const provider = candidate.provider
      const realId = candidate.realId
      if (typeof provider !== 'string' || provider.length === 0) continue
      if (typeof realId !== 'string' || realId.length === 0) continue
      if (!Object.hasOwn(out, canonicalId)) out[canonicalId] = {}
      if (!Object.hasOwn(out[canonicalId], provider)) out[canonicalId][provider] = {}
      out[canonicalId][provider][realId] = true
    }
  }
  return out
}

/**
 * 候选行按**临期**升序排（最早到期的排最前）；到期时刻相同按渠道名升序（稳定）。
 *
 * ## ⚠️ 为什么是「可选」而不是默认
 *
 * 临期顺序需要**逐候选探测余额**（真实上游 GET）。而规格 §8.3 要求
 * `aggregate.catalog` **零余额查询** —— 否则面板一打开就打十几次上游请求。
 * ⇒ 面板默认按渠道名字母序（零探测），用户**显式点「按临期排序」**才探测并重排。
 *
 * ## ⚠️ 这也修掉一处「面板没说真话」
 *
 * 面板标题原写「临期优先」，但候选列表来自 `aggregate-catalog.ts` 的
 * `candidates.sort(...)`，那是按 `provider` **字母序**（用户 2026-10-07 报障：
 * 「codearts 的 4.1 flash 没有显示在最后」—— 因为字母序恰好让 codearts 居中）。
 * ⇒ 两者矛盾。现在排序由用户显式触发，且顺序**真的**是临期序。
 *
 * ## 判据
 *
 * - `expiry` 越小越前；`Infinity`（长期/无到期）排最后；
 * - 相同 `expiry` 按 `provider` 升序（结果稳定，便于断言与面板顺序稳定）；
 * - 缺 `expiry` 视为 `Infinity`（畸形数据不抛错、也不抢到前面）。
 *
 * ⚠️ **纯函数**：返回新数组，不改入参（React 靠引用变化重渲染）。
 *
 * @param {Array<{ provider?: string, expiry?: number }>} rows
 * @returns {Array<unknown>}
 */
export function sortCandidatesByExpiry(rows) {
  if (!Array.isArray(rows)) return []
  const of = (row) => {
    const value = row?.expiry
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
  return [...rows].sort((a, b) => {
    const byExpiry = of(a) - of(b)
    if (byExpiry !== 0) return byExpiry
    return String(a?.provider ?? '').localeCompare(String(b?.provider ?? ''))
  })
}

/**
 * 一个到期时刻的**可读文案**（「按临期排序」后显示在候选行右侧）。
 *
 * ## 判据
 *
 * - `-1`（`UNUSABLE`，查不到）⇒ `'查不到'` —— **不写「已过期」**：查不到与过期
 *   是两件事（与 `zcodeExpiry` 的「`undefined` 表示查不到，不是没有余额」同一原则）；
 * - 非有限值（`Infinity`）⇒ `'长期'` —— 有余额但没有到期概念；
 * - 否则显示**相对时间**（`3 天`/`5 小时`/`12 分钟`），已过期显示 `'已过期'`。
 *   ⚠️ 用相对而非绝对时间：用户关心的是「还有多久作废」，而绝对时刻还要心算。
 *
 * ⚠️ 畸形入参不抛错（返回 `'?'`）：面板渲染不能因一条坏数据整体崩掉。
 *
 * @param {number} expiry - 毫秒时间戳；`-1` = 查不到；`Infinity` = 长期
 * @param {number} [nowMs] - 当前时刻（注入以便单测）
 * @returns {string}
 */
export function expiryLabel(expiry, nowMs = Date.now()) {
  if (typeof expiry !== 'number' || Number.isNaN(expiry)) return '?'
  if (expiry === -1) return '查不到'
  if (!Number.isFinite(expiry)) return '长期'
  if (expiry <= 0) return '?'
  const diff = expiry - nowMs
  if (diff <= 0) return '已过期'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/**
 * 一条候选的展示文案（如 `buddy · deepseek-v4.1-flash · x0.15`）。
 *
 * ⚠️ **倍率为 `Infinity` 时不显示倍率**（那是「无标注」的哨兵，直接拼进文案会让
 * 用户看到 `xInfinity` —— 明显的渲染缺陷）。倍率 `0` 显示「免费」（本仓库既有口径）。
 * ⚠️ 畸形入参不抛错：面板渲染不能因一条坏数据整体崩掉。
 *
 * @param {{ provider?: string, realId?: string, price?: number, viaPatch?: boolean }} candidate
 * @returns {string}
 */
export function candidateRowLabel(candidate) {
  const provider = typeof candidate?.provider === 'string' ? candidate.provider : '?'
  const realId = typeof candidate?.realId === 'string' ? candidate.realId : '?'
  const parts = [provider, realId]
  const price = candidate?.price
  if (typeof price === 'number' && Number.isFinite(price)) {
    parts.push(price === 0 ? '免费' : `x${price}`)
  }
  let label = parts.join(' · ')
  if (candidate?.viaPatch === true) label += ' ⚠️补丁'
  return label
}

/**
 * 拒绝表的键（`canonicalId` + `provider` + `realId`）。
 *
 * ⚠️ 用 NUL（`\u0000`）分隔：provider id 与 realId 里都可能含斜杠
 *（如 `cline-free/deepseek-v4.1-flash`），用 `:` 或 `/` 会把
 * `a/b`+`c` 与 `a`+`b/c` 拼成同一个键而**误判**。
 *
 * @param {string} canonicalId
 * @param {string} provider
 * @param {string} realId
 * @returns {string}
 */
export function rejectionKey(canonicalId, provider, realId) {
  return `${canonicalId}\u0000${provider}\u0000${realId}`
}

/**
 * 该候选是否被拒绝参与轮换。
 *
 * ⚠️ 缺层 / 畸形一律返回 `false`（不抛错）；只有**显式 `true`** 才算拒绝
 *（与宿主 `sanitizeAggregateRejections` 同口径）。
 *
 * @param {Record<string, Record<string, Record<string, boolean>>>} rejections
 * @param {string} canonicalId
 * @param {string} provider
 * @param {string} realId
 * @returns {boolean}
 */
export function isRejected(rejections, canonicalId, provider, realId) {
  if (typeof rejections !== 'object' || rejections === null || Array.isArray(rejections)) return false
  const byProvider = rejections[canonicalId]
  if (typeof byProvider !== 'object' || byProvider === null || Array.isArray(byProvider)) return false
  const byRealId = byProvider[provider]
  if (typeof byRealId !== 'object' || byRealId === null || Array.isArray(byRealId)) return false
  return byRealId[realId] === true
}

/**
 * **纯函数**地改拒绝表：返回新表，不改入参。
 *
 * ## ⚠️ 为什么必须纯（不能原地改）
 *
 * 面板用 React 状态驱动。原地改会让「新旧引用相同」⇒ 组件**不重渲染** ⇒
 * 用户点了开关但界面不变（最典型的一类 UI 缺陷）。故每次返回**新对象**
 *（含沿途各层的新副本），并逐级清理空层（不留 `false` 噪音，与宿主同口径）。
 *
 * @param {Record<string, Record<string, Record<string, boolean>>>} rejections
 * @param {string} canonicalId
 * @param {string} provider
 * @param {string} realId
 * @param {boolean} rejected
 * @returns {Record<string, Record<string, Record<string, boolean>>>}
 */
export function toggleRejection(rejections, canonicalId, provider, realId, rejected) {
  const base = (typeof rejections === 'object' && rejections !== null && !Array.isArray(rejections))
    ? rejections
    : {}
  const next = { ...base }
  const perProvider = { ...(next[canonicalId] ?? {}) }
  const perRealId = { ...(perProvider[provider] ?? {}) }
  if (rejected === true) perRealId[realId] = true
  else delete perRealId[realId]
  if (Object.keys(perRealId).length === 0) delete perProvider[provider]
  else perProvider[provider] = perRealId
  if (Object.keys(perProvider).length === 0) delete next[canonicalId]
  else next[canonicalId] = perProvider
  return next
}
