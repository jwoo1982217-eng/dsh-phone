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
 * ## ⚠️⚠️ 当前**零客户端调用者**（2026-10-15 起）—— 这是**有意**的，不要删
 *
 * 它原先驱动模型头那个「⚠️ 全部被拒」徽标；本 PR 之后面板改走**三态**
 *（{@link rotationBlockerOf} 读宿主下发的 `state`），因为「全部不能轮换」现在有
 * **三个**来源（被拒 / 无临期积分 / 两者混合），二进制判据表达不了。
 *
 * 保留它的三条理由：
 *  ① **规格 §5.2 明文要求这条判据存在**，且它的文案（「全部被拒」）在面板里**逐字保留**；
 *  ② `aggregate-panel-logic.spec.ts` 有一组用例**逐格锁定**它（含「只拒一部分」「无候选」
 *     这些边界）—— 删掉会连带删掉那组回归；
 *  ③ 它是 {@link rotationBlockerOf} 里 `'all-rejected'` 那一档的**语义来源**
 *    （两者对「全被拒」必须同时成立，有一条用例专门锁这个一致性）。
 *
 * ⚠️ 判据：**规格要求 ≠ 死代码**（与 `jet-hub-rpc.ts` 的 `aggregate.clearRejected`
 * 同款登记 —— 那里也是零客户端调用者但刻意保留）。
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
 * 一条候选的**三态**，带**老宿主回退**。
 *
 * ## ⚠️⚠️ 为什么需要它（真实缺口，2026-10-15 自查发现）
 *
 * 三态由宿主下发（`candidate.state`），而升级期可能出现「**新客户端 + 老宿主**」
 *（宿主还没更新，响应里没有 `state`）。那时若直接读 `candidate.state`：
 *  - `describeCandidateState` 会显示「状态未知」（用户看不懂）；
 *  - `rotationBlockerOf` 会判成 `'none'`（**不给任何提示**）；
 *  - 逐条开关会按「未知 ⇒ 打开」发出 `setAllowed`，而老宿主**没有那个端点**
 *    ⇒ 报「未知方法」错误。
 *
 * ⇒ 必须有回退判据：老宿主下唯一可判的事实是「该候选在不在终端的**显式拒绝表**里」
 *（`rejectionsFromCatalog` 已按老格式摊平）⇒ 在 ⇒ `'rejected'`，不在 ⇒ `'allowed'`。
 * 这与老宿主的真实语义**逐格一致**：老宿主下所有列出 `rejected: false` 的候选
 * **都是**参与轮换的（它当时有「只广告已接入渠道」的过滤，不存在「默认不参与」态）。
 *
 * ⚠️ 这也让 {@link isRejected} 成为**生产判据**（否则新客户端里它只剩用例调用者）。
 *
 * @param {string} canonicalId
 * @param {{ state?: string, provider?: string, realId?: string }} candidate
 * @param {Record<string, Record<string, Record<string, boolean>>>} rejections
 * @returns {'allowed'|'rejected'|'default-rejected'}
 */
export function candidateStateOf(canonicalId, candidate, rejections) {
  // ⚠️ 只认**字符串**（畸形值走回退），与 `rejectionsFromCatalog` 的闸门同口径。
  if (typeof candidate?.state === 'string') return candidate.state
  return isRejected(rejections, canonicalId, candidate?.provider, candidate?.realId)
    ? 'rejected'
    : 'allowed'
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
 * ⚠️⚠️ **2026-10-15 起还要看 `state`**（三态门控）：见函数体内那段长注释 ——
 * `rejected` 的语义已收窄为「当前不参与轮换」（含「未接入折算 ⇒ 默认不参与」），
 * 只有 `state === 'rejected'` 才是**用户显式拒绝**。老宿主（无 `state`）回退旧判据。
 *
 * @param {Array<{ canonicalId?: string, candidates?: Array<{ provider?: string, realId?: string, rejected?: boolean, state?: string }> }>} models
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
      // ⚠️⚠️ **`state` 是权威**（2026-10-15，用户 2026-10-15 的门控功能）：
      //    宿主把 `rejected` 的语义**收窄**为「当前不参与轮换」—— 它现在**也**为
      //    「未接入临期折算 ⇒ 默认不参与」的候选返回 `true`。若这里只看 `rejected`，
      //    那些**用户从没点过**的条目会被摊进客户端拒绝表 ⇒ 面板显示「已拒绝」，
      //    而真相是「默认不参与」—— **面板撒谎**（且用户点「参与轮换」时会发出
      //    `rejected: false`，对未接入渠道而言语义错位）。
      //    ⇒ 判据：`state === 'rejected'` 才算用户显式拒绝。
      //
      // ⚠️ **兼容老宿主**（响应里没有 `state`）：那时 `rejected` 的旧语义**就是**
      //    「用户显式拒绝」⇒ 必须回退到只看 `rejected`，否则升级期「新客户端 + 老宿主」
      //    会让用户存过的拒绝状态**全部消失**（界面显示全部参与）。
      //    判据用一个明确的「是字符串」闸门，而不是 `state !== 'default-rejected'`
      //   （后者对畸形值没有立场）。
      if (typeof candidate.state === 'string') {
        if (candidate.state !== 'rejected') continue
      }
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
 * - `UNUSABLE`（`-1`，**查不到**）也排**最后**（⚠️ 见下）；
 * - 相同 `expiry` 按 `provider` 升序（结果稳定，便于断言与面板顺序稳定）；
 * - 缺 `expiry` 视为 `Infinity`（畸形数据不抛错、也不抢到前面）。
 *
 * ## ⚠️⚠️ `UNUSABLE`（`-1`）必须排最后（真实缺陷，用户验收 2026-10-16）
 *
 * 用户报障原话：「有 2 个模型显示**查不到**排前面了，为什么查不到，查不到应该
 * 当做没临期不会放在前面」。
 *
 * 根因：本函数原先用 `Number.isFinite(value)` 判「是不是有效到期时刻」，而
 * **`Number.isFinite(-1) === true`** ⇒ `UNUSABLE` 算出的排序键是 **`-1`**，
 * 比任何真实毫秒时间戳（约 1.7e12）都小 ⇒ **排到最前面**。用户看到的正是
 * accio / officeace 两个「查不到」的候选被排到了 buddy（`4 天`）之前。
 *
 * ⚠️ `-1` 是**哨兵**，不是时间戳：语义是「**这次查不到**」（无启用账号 / 探测失败），
 * 与「明天过期」完全是两件事。宿主的 `rankCandidates` 对它是**直接剔除**
 *（`filter(c => c.expiry !== UNUSABLE)`）；面板这边**保留可见**（用户要看得到它们、
 * 以及为什么没参与），但**必须排最后** —— 与「长期（`Infinity`）」同一位置。
 *
 * ⚠️ 判据只留一份：这里用**显式哨兵判定**，**不得**退回 `Number.isFinite`
 *（那正是本缺陷）。两处（宿主剔除 / 面板排尾）语义一致：`UNUSABLE` 绝不排前面。
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
    // ⚠️⚠️ 先排除**哨兵** `UNUSABLE = -1`（见上方长注释：`Number.isFinite(-1)` 为真，
    //    照原写法它会算出 -1 并排到最前 —— 那正是用户报障的现象）。
    if (value === -1) return Number.POSITIVE_INFINITY
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
  return [...rows].sort((a, b) => {
    const expiryA = of(a)
    const expiryB = of(b)
    // ⚠️⚠️ **必须先判 `!==` 再相减**（真实缺陷，2026-10-16 对抗审计实测）：
    //    原先写的是 `const byExpiry = of(a) - of(b); if (byExpiry !== 0) return byExpiry`，
    //    而两个 `Infinity`（「长期」）或两个 `-1`（「查不到」）相减得 **`NaN`** ——
    //    `NaN !== 0` 为 **真** ⇒ 直接把 `NaN` 当比较器返回值 ⇒ 引擎按 `0` 处理
    //    ⇒ **第二档 `localeCompare` 永不执行** ⇒ 同档内顺序退化成**输入顺序**
    //    （随目录返回顺序漂移），与函数头写下的「相同 expiry 按 provider 升序」不符。
    //    实测：`[officeace(-1), accio(-1)]` 输出 `officeace, accio`（应为 `accio, officeace`）；
    //    两个 `Infinity` 同样失效（那一格早于本 PR 存在）。
    //    ⇒ 判据与同文件的 `rankCandidatesForPanel`（:573 一带）**逐格同构**。
    if (expiryA !== expiryB) return expiryA - expiryB
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

/**
 * 候选的**键**（`` `${provider}\u0000${realId}` ``）。
 *
 * ⚠️ 分隔符必须与宿主的顺序表约定**逐字相同**（`jet-hub-store.ts` 的 `AggregateOrderMap`
 * 与 `aggregate-adapter.ts` 的 `manualRankOf`）：客户端拼的键、服务端去重的键、
 * 宿主排序时查的键**三处必须同为 NUL**。不一致的症状是**静默**：
 * 顺序表看着有内容、拖了没反应。
 *
 * @param {{ provider?: string, realId?: string }} candidate
 * @returns {string}
 */
export function candidateKeyOf(candidate) {
  const provider = typeof candidate?.provider === 'string' ? candidate.provider : ''
  const realId = typeof candidate?.realId === 'string' ? candidate.realId : ''
  return `${provider}\u0000${realId}`
}

/**
 * 点击这一条候选时**该写哪张表** —— 「点哪张表」的唯一判据（用户 2026-10-15 的四行表）。
 *
 * ## 四行表（规格 §5.1）
 *
 * | 当前 `state` | 目标 | 写哪张表 |
 * |---|---|---|
 * | `rejected` | 参与 | `aggregate.setRejected(false)`（既有 D4 恢复路径：清整渠道层） |
 * | `default-rejected` | 参与 | `aggregate.setAllowed(true)` |
 * | `allowed` + `expiryWired` | 不参与 | `aggregate.setRejected(true)` |
 * | `allowed` + 未接入 | 不参与 | `aggregate.setAllowed(false)`（回默认态） |
 *
 * ⚠️⚠️ **最后一格最容易写错**：未接入渠道的「不参与」与「拒绝」**同义**，
 * 若写 `setRejected(true)`，拒绝表里会留下一批**永不起作用**的条目（该渠道默认就不参与），
 * 且会污染「拒绝非临期」的 `cleared` 计数与「恢复默认」的语义。
 *
 * ⚠️ `expiryWired` 只在这一格上参与判断（决定「关掉时写哪张表」），**不参与**任何三态推导
 *（三态一律读 `state`）⇒ 客户端**没有**第二套门控判据（本仓库红线）。
 *
 * ⚠️ 判据**只留这一份**：面板渲染代码里**不得**再出现第二处 `expiryWired` 分支。
 *
 * @param {string} canonicalId
 * @param {{ provider?: string, realId?: string, state?: string, expiryWired?: boolean }} candidate
 * @param {{ state?: string }} [resolved] 可选的**已回退**三态（由 {@link candidateStateOf} 算出）。
 *   ⚠️ 老宿主**没有** `aggregate.setAllowed` 端点 ⇒ 回退态的候选会是 `'allowed'`/`'rejected'`，
 *   于是本函数只会发出 `setRejected`（老宿主认识的那个）—— 这正是我们要的行为。
 * @returns {{ rpc: string, payload: Record<string, unknown> }}
 */
export function candidateToggleAction(canonicalId, candidate, resolved) {
  const state = typeof resolved?.state === 'string' ? resolved.state : candidate?.state
  const payload = {
    canonicalId,
    provider: candidate?.provider,
    realId: candidate?.realId,
  }
  if (state === 'rejected') {
    return { rpc: 'aggregate.setRejected', payload: { ...payload, rejected: false } }
  }
  if (state === 'allowed') {
    // ⚠️ 老宿主回退下 `expiryWired` 缺失 ⇒ 走 `setRejected(true)`（老宿主认识的端点），
    //    这是正确的：老宿主下所有候选都是已接入渠道（当时有「只广告已接入」的过滤）。
    return candidate?.expiryWired === false
      ? { rpc: 'aggregate.setAllowed', payload: { ...payload, allowed: false } }
      : { rpc: 'aggregate.setRejected', payload: { ...payload, rejected: true } }
  }
  // 其余（`default-rejected` 与任何未知/畸形值）一律按「当前未参与 ⇒ 可打开」处理：
  // ⚠️ 未知值不能沿用上面的 `allowed` 分支（那会发出 `allowed:false`，把一个
  //    「我们读不懂的状态」写成用户明确不允许）。
  return { rpc: 'aggregate.setAllowed', payload: { ...payload, allowed: true } }
}

/**
 * 一条候选的**显示态**（按钮文案 / title / 按压态）。
 *
 * ⚠️ 三态来自**宿主下发的** `state` 字段 —— 客户端**只渲染、不判定**
 *（本仓库「同一语义两套判据」的红线）。`expiryWired` 同样读宿主下发的值。
 *
 * ⚠️⚠️ **`allowed` + 未接入**必须**额外说明它在轮换里排在最后**：它的 `expiry` 是 `NEVER`
 *（与已接入渠道的「无临期积分」**同值**）⇒ 它排在所有能算出临期的候选**之后**。
 * 只显示「参与轮换」会让用户以为「我明明打开了却没优先用它」是缺陷 ——
 * 本仓库对面板的成文要求是「必须说真话」。
 *
 * @param {{ state?: string, expiryWired?: boolean }} candidate
 * @param {{ state?: string, expiryWired?: boolean }} [resolved]
 *   可选的**已回退**三态（由 {@link candidateStateOf} 算出）—— 传了就用它，
 *   不传则只读 `candidate.state`（老宿主下会显示「状态未知」）。
 * @returns {{ label: string, title: string, pressed: boolean }}
 */
export function describeCandidateState(candidate, resolved) {
  const state = typeof resolved?.state === 'string' ? resolved.state : candidate?.state
  if (state === 'rejected') {
    return {
      label: '已拒绝',
      title: '你拒绝了这个渠道参与该模型的轮换。点击恢复参与。',
      pressed: false,
    }
  }
  if (state === 'default-rejected') {
    return {
      label: '无临期积分 · 未参与',
      title: '该渠道没有临期积分折算，默认不参与轮换。点击手工打开'
        + '（打开后它会排在所有能算出临期的候选之后）。',
      pressed: false,
    }
  }
  if (state === 'allowed') {
    if (candidate?.expiryWired === false) {
      return {
        label: '参与（无临期信息）',
        title: '该渠道没有临期积分折算，但你已经手工打开它参与轮换。'
          + '它没有临期值，故排在所有能算出临期的候选之后（手工模式下可拖动调整它在前面的位置）。',
        pressed: true,
      }
    }
    return { label: '参与轮换', title: '该渠道参与这个模型的轮换。点击可拒绝。', pressed: true }
  }
  // 未知状态：如实说「未知」而不是假装参与（面板不说假话）。
  return {
    label: '状态未知',
    title: '宿主返回的候选状态无法识别（可能是版本不匹配）。点击将按「手工打开」处理。',
    pressed: false,
  }
}

/**
 * 该虚拟模型**为什么**没有候选可路由（面板要给显式提示，别让用户以为模型坏了）。
 *
 * ⚠️ 与既有的 {@link isAllCandidatesRejected} **并存**（不替换）：那条判据
 *（「候选**全部**在显式拒绝表里」）是规格 §5.2 的成文要求、被既有用例逐字锁定；
 * 本函数只**扩展**原因分类（新增「未接入折算 ⇒ 默认不参与」这一态）。
 *
 * @param {{ candidates?: Array<{ state?: string, provider?: string, realId?: string }> } | null | undefined} model
 * @param {Record<string, Record<string, Record<string, boolean>>>} [rejections]
 *   终端的显式拒绝表 —— **只为老宿主回退**用（见 {@link candidateStateOf}）。
 *   新宿主下每个候选都有 `state`，本参数不影响任何判定。
 * @returns {'none'|'all-rejected'|'all-default'|'mixed'}
 *   `none` = 有候选在轮换（或没有候选）；`all-rejected` = 全被用户拒绝；
 *   `all-default` = 全是「无临期积分 ⇒ 默认不参与」；`mixed` = 两种都有。
 */
export function rotationBlockerOf(model, rejections) {
  const candidates = model?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return 'none'
  const canonicalId = model?.canonicalId
  // ⚠️ 走 `candidateStateOf`（带老宿主回退）—— 直接读 `candidate.state` 会让
  //    「新客户端 + 老宿主」下**一个提示都不给**（全部候选都判成未知 ⇒ `'none'`），
  //    而那时用户明明把候选全拒了。
  const states = candidates.map((candidate) => candidateStateOf(canonicalId, candidate, rejections))
  if (states.some((state) => state === 'allowed')) return 'none'
  const hasRejected = states.some((state) => state === 'rejected')
  const hasDefault = states.some((state) => state === 'default-rejected')
  // ⚠️ 未知状态既不算「被拒」也不算「默认不参与」⇒ 若全是未知状态，如实回 `'none'`
  //    （提示「全部被拒」会是谎话）。这与上面的「任一 allowed ⇒ none」同一取向：
  //    宁可不说，也不说错。
  if (hasRejected && hasDefault) return 'mixed'
  if (hasDefault) return 'all-default'
  if (hasRejected) return 'all-rejected'
  return 'none'
}

/**
 * 面板侧的候选排序：与宿主 `aggregate-core.ts` 的 `rankCandidates` **逐格同构**。
 *
 * ## ⚠️⚠️ 为什么允许存在第二份比较器，以及它的守卫
 *
 * 面板必须按**真实轮换顺序**展示（否则用户拖了排序却按别的顺序走 —— 本仓库红线）。
 * 客户端 bundle 是**独立 entry、不 import 宿主模块**（见 `build.mjs`）⇒ 无法直接复用
 * 宿主实现。⇒ **跨层一致性用例**（`aggregate-panel-logic.spec.ts` 的
 * 「与宿主 rankCandidates 同序」）是本函数唯一的守卫，**改动它先跑那条**。
 *
 * 判据（与宿主逐格相同）：手工位次严格优先 → 临期升序 → 倍率升序。
 *
 * @param {Array<{ provider?: string, realId?: string, price?: number }>} candidates
 * @param {Map<string, number> | null | undefined} rankMap - 候选键 → 手工位次（`null` = 临期模式）
 * @param {(provider: string) => number | undefined} [expiryOf] - 渠道 → 到期时刻（缺省视为 `NEVER`）
 * @returns {Array<unknown>}
 */
export function rankCandidatesForPanel(candidates, rankMap, expiryOf) {
  if (!Array.isArray(candidates)) return []
  const rankOf = (candidate) => {
    const index = rankMap?.get?.(candidateKeyOf(candidate))
    return typeof index === 'number' ? index : Number.POSITIVE_INFINITY
  }
  const expiryOfCandidate = (candidate) => {
    const value = expiryOf?.(candidate?.provider)
    // ⚠️⚠️ **必须显式排除哨兵 `UNUSABLE = -1`**（真实缺陷，2026-10-16 审计实测）：
    //    本行原先是 `typeof value === 'number' && !Number.isNaN(value)`，而
    //    **`-1` 满足那个条件** ⇒ 它算出的排序键是 `-1`，比任何真实毫秒时间戳
    //   （约 1.7e12）都小 ⇒ 「**查不到**」的候选排到**最前**
    //   ⇒ 面板显示「第 1 名」而宿主 `rankCandidates` **根本不会用它**（它对
    //    `UNUSABLE` 是**剔除**）—— 面板与真实轮换序分叉（本仓库红线）。
    //
    // ⚠️ 同文件的 `sortCandidatesByExpiry` **有**这一支（且它的注释记录了同一个
    //    真缺陷）—— 本函数是后来新增的，**漏抄了那一格**。⇒ 两处必须逐格同构。
    if (value === -1) return Number.POSITIVE_INFINITY
    return typeof value === 'number' && !Number.isNaN(value) ? value : Number.POSITIVE_INFINITY
  }
  return [...candidates].sort((a, b) => {
    const rankA = rankOf(a)
    const rankB = rankOf(b)
    if (rankA !== rankB) return rankA - rankB
    const expiryA = expiryOfCandidate(a)
    const expiryB = expiryOfCandidate(b)
    // ⚠️ **必须保留 `!==` 这一格**：两个 `Infinity` 相减得 `NaN`（非法比较器返回值，
    //    `sort` 会把它当 0 ⇒ 顺序随引擎实现漂移）。宿主那边有同款守卫。
    if (expiryA !== expiryB) return expiryA - expiryB
    const priceA = typeof a?.price === 'number' ? a.price : Number.POSITIVE_INFINITY
    const priceB = typeof b?.price === 'number' ? b.price : Number.POSITIVE_INFINITY
    return priceA - priceB
  })
}

/**
 * 手工模式下的**两段式**列表：`participating`（参与轮换，可拖动排序）与
 * `inactive`（未参与，打开后才加入）。
 *
 * ⚠️ **只有参与的候选可拖动排序**：「把一条不参与轮换的候选拖到最前」是**无意义的操作**
 *（它根本不进候选池），允许它会造出「顺序表里有它、轮换里没它」的困惑。
 *
 * ⚠️ 拖动顺序**不是**「只排参与段」的私有约定，而是与宿主同一份语义：
 * 提交的数组是**参与候选的完整顺序**，未排到的由宿主按临期兜底追加
 *（见 `AggregateOrderMap` 与 `manualRankOf`）。
 *
 * @param {{ candidates?: unknown[] }} model
 * @param {Map<string, number> | null | undefined} rankMap
 * @param {(provider: string) => number | undefined} [expiryOf]
 * @param {Record<string, Record<string, Record<string, boolean>>>} [rejections]
 *   只为老宿主回退（见 {@link candidateStateOf}）。
 * @returns {{ participating: Array<unknown>, inactive: Array<unknown> }}
 */
export function rotationRosterOf(model, rankMap, expiryOf, rejections) {
  const all = Array.isArray(model?.candidates) ? model.candidates : []
  const canonicalId = model?.canonicalId
  const isParticipating = (candidate) =>
    candidateStateOf(canonicalId, candidate, rejections) === 'allowed'
  const participating = rankCandidatesForPanel(
    all.filter(isParticipating),
    rankMap,
    expiryOf,
  )
  const inactive = all.filter((candidate) => !isParticipating(candidate))
  return { participating, inactive }
}

/**
 * 把 `key` 在 `order` 里移动 `delta` 位（上移 = `-1`）。
 *
 * ⚠️ 越界（首位上移 / 末位下移）与「键不在数组里」一律**原样返回副本** ——
 * **不得**返回空数组或 `undefined`（那会让用户点一下「上移」就把整份顺序弄丢）。
 * ⚠️ **纯函数**：返回新数组，不改入参（React 靠引用变化重渲染）。
 *
 * @param {string[]} order
 * @param {string} key
 * @param {number} delta
 * @returns {string[]}
 */
export function moveCandidate(order, key, delta) {
  const list = Array.isArray(order) ? order : []
  const index = list.indexOf(key)
  if (index < 0) return [...list]
  return moveCandidateTo(list, key, index + (Number.isFinite(delta) ? delta : 0))
}

/**
 * 把 `key` 移到 `targetIndex`（越界目标被**夹到** `[0, length-1]`）。
 *
 * ⚠️ 键不在数组里 ⇒ 原样返回副本（调用方应先用 {@link rotationRosterOf} 补位）。
 * ⚠️ **纯函数**：返回新数组，不改入参。
 *
 * @param {string[]} order
 * @param {string} key
 * @param {number} targetIndex
 * @returns {string[]}
 */
export function moveCandidateTo(order, key, targetIndex) {
  const list = Array.isArray(order) ? order : []
  const index = list.indexOf(key)
  if (index < 0) return [...list]
  const next = [...list]
  const target = Number.isFinite(targetIndex) ? targetIndex : index
  const clamped = Math.max(0, Math.min(next.length - 1, target))
  if (clamped === index) return next
  const [moved] = next.splice(index, 1)
  next.splice(clamped, 0, moved)
  return next
}

/**
 * 由当前**显示**的参与列表拼出要提交给 `aggregate.setOrder` 的数组。
 *
 * ⚠️ 提交的是**整份顺序**（不是「只提交被移动的那一条」）：碎片化追加需要服务端做插入
 * 位置推断，判据会立刻分叉（见 `AggregateOrderMap` 的设计取舍）。
 * ⚠️ 含「用户没拖过的尾巴」是**有意**的：宿主对数组里没出现的候选按临期兜底追加，
 * 故提交完整顺序能让「拖动结果」完全确定。
 *
 * @param {Array<{ provider?: string, realId?: string }>} participating
 * @returns {string[]}
 */
export function pendingOrderFromRoster(participating) {
  if (!Array.isArray(participating)) return []
  return participating.map(candidateKeyOf)
}

/**
 * 「按临期」模式的重探定时器：**该不该在这一轮发探测**。
 *
 * ## 为什么要有这个纯函数（而不是内联在 `React.useEffect` 里）
 *
 * 本文件顶部的模块注释写着：「单测环境没有 react ⇒ 必须抽成纯函数才能覆盖」。
 * 而这段定时器原先**内联在 `jet-hub.js` 的 `AggregatePanel` 里**，测试够不到它
 * ⇒ 「按临期每 5 分钟重探」这条**长期零用例**（2026-10-16 核实：全仓库对
 * `AGG_EXPIRY_REPROBE_MS` 的断言数为 **0**）。而那三条约束（只在按临期 /
 * 隐藏时跳过 / 卸载清定时器）都是**真实会打上游请求**的行为，正是最该有守卫的地方。
 *
 * ## 判据（与 `jet-hub.js` 的 effect 逐格同构）
 *
 * | 情形 | 返回值 | 依据 |
 * |---|---|---|
 * | 不是「按临期」模式 | `false` | 手工模式下用户已定的位次不受临期影响，轮询纯属浪费上游请求 |
 * | 页面隐藏（`document.hidden === true`） | `false` | 后台标签页持续打上游不可接受；且 `setInterval` 在后台被节流、恢复时会**补跑一串** |
 * | 其余 | `true` | 正常轮询 |
 *
 * ⚠️ `hidden` 用**真值判断**（`=== true`）：缺失/`undefined`（非浏览器环境）视为
 * **不隐藏** —— 与内联版的 `typeof document !== 'undefined' && document.hidden === true`
 * 同语义（没有 document 时不该拦住探测）。
 *
 * ⚠️ **纯函数**：零副作用、不读全局，便于假定时器用例直接驱动。
 *
 * @param {{ orderMode?: string, hidden?: boolean }} [input]
 * @returns {boolean}
 */
export function shouldReprobeExpiry(input) {
  const orderMode = input?.orderMode
  if (orderMode !== 'expiry') return false
  if (input?.hidden === true) return false
  return true
}

/**
 * 挂上「按临期重探」定时器，返回**清理函数**。
 *
 * ## 为什么把 `schedule` / `cancel` 做成参数（而不是直接调 `setInterval`）
 *
 * 这样单测能用 vitest 的**假定时器**真跑「5 分钟」而**不真等**，
 * 且能断言最要紧的一条：**清理函数真的把定时器停了**
 *（真实缺陷形态：面板反复进出会叠加 N 个定时器 ⇒ 上游请求量 ×N，
 * 且只在长时间挂着时才看得出来 —— 这是本函数存在的核心理由）。
 *
 * ⚠️ 生产调用点必须传**真的** `setInterval` / `clearInterval`
 *（`jet-hub.js` 的 effect 如此），否则定时器永不触发。
 *
 * ⚠️ `isHidden` 是**取值函数**而非布尔快照：隐藏状态会在两轮之间变化，
 * 快照会让「切到后台再切回来」判错。
 *
 * ⚠️ **非「按临期」模式返回 no-op 清理函数**（而不是 `undefined`）：
 * 调用方（React effect 的 cleanup）可以无条件调用它，不必再判一次模式
 * —— 少一个判据分叉点。
 *
 * @param {{
 *   orderMode?: string,
 *   intervalMs: number,
 *   isHidden?: () => boolean,
 *   probe: () => unknown,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 * }} options
 * @returns {() => void} 清理函数（幂等，可重复调用）
 */
export function startExpiryReprobe(options) {
  const {
    orderMode,
    intervalMs,
    isHidden = () => false,
    probe,
    schedule = (fn, ms) => setInterval(fn, ms),
    cancel = (handle) => clearInterval(handle),
  } = options ?? {}
  // ⚠️ 非按临期模式：**不挂定时器**（这正是「切手工即停」那条判据的实现处）。
  if (orderMode !== 'expiry') return () => {}
  if (typeof probe !== 'function') return () => {}
  const handle = schedule(() => {
    if (!shouldReprobeExpiry({ orderMode, hidden: isHidden() === true })) return
    probe()
  }, intervalMs)
  let stopped = false
  // ⚠️ 幂等：React 严格模式下 cleanup 可能被调用多次，重复 cancel 不得抛错。
  return () => {
    if (stopped) return
    stopped = true
    cancel(handle)
  }
}
