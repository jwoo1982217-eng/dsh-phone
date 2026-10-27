/**
 * CodeBuddy 限时补偿积分的**纯逻辑**（扫描汇总 / 领取编排 / 卡片文案）。
 *
 * ## 为什么必须独立成文件（本仓库的既有约束）
 *
 * 本仓库的单测环境**没有 react**（`react` 是宿主注入的 external，见 `jet-hub.js`
 * 文件头）⇒ 组件无法渲染 ⇒ 判定与文案必须抽成纯函数才能被覆盖。
 * 先例：`aggregate-panel-logic.js` / `provider-toggle.js` / `model-bulk.js` /
 * `credits-capabilities.js` 都因此独立成文件。
 *
 * ## ⚠️⚠️ 本模块存在的**首要**理由：`rpcCall` 的真实契约（P0 缺陷的修复面）
 *
 * `plugin-src/client/index.js` 的 `rpcCall` 是 `unwrapRpcResult(callManagementRpc(...))`，
 * 而 `unwrapRpcResult`（`plugin-src/management-rpc.mjs:37`）的契约是：
 *
 * - `ok === true`  ⇒ **返回 `result.value`**（一个**没有 `ok` 字段**的对象）
 * - `ok === false` ⇒ **抛 `Error(error.message)`**
 *
 * ⇒ **判 `res.ok === true` 恒假**（解包后的对象没有 `ok`），而**判 `res.ok !== true` 恒真**。
 *
 * ⚠️ 这是本仓库**已登记的复发形态**，同一陷阱已踩过两次：
 * `jet-hub.js` 的 `AggregatePanel` 处有一条长注释（"真实缺陷，第二次报障"）
 * 逐字写着「写 `res.ok === true` 判断**永远为假**」，并列出的既有调用点正确写法是
 * 「直接用 `res.models`，错误一律走 `catch`」。PR !106 初版在此处踩了**第三次**：
 * 状态查询恒得「0 待领」、按钮永不渲染、领取循环恒 `continue`，
 * 而 **26 条测试全绿**（面板 spec 是纯源码文本断言，从不执行逻辑）。
 *
 * ⇒ 本模块的每条判据都**只用解包后的字段**，失败一律**由调用方 try/catch 承接**。
 *
 * ## 逐账号容错是**硬要求**，不是优化
 *
 * 补偿是 per-account 的：某个账号凭据失效 / 上游返业务码（活动已结束）都**不该**
 * 让其余账号查不到。若把 `await` 裸放在循环里，一次抛错就掀掉整批 ——
 * 而 `rpcCall` 的失败形态恰恰是抛错（见上）。
 *
 * @module plugin-src/client/compensation-panel-logic.js
 */

/**
 * 单条状态是否**可领取**。
 *
 * ⚠️ 三个条件缺一不可，且**顺序有讲究**：
 * `active` 先判（活动已结束时上游可能仍回 `credit_num` 的历史值），
 * `claimed` 次判，最后才看额度。
 *
 * @param {unknown} status 解包后的状态对象（**没有 `ok` 字段**）
 * @returns {boolean}
 */
export function isClaimable(status) {
  return status?.active === true
    && status?.claimed !== true
    && Number(status?.creditNum) > 0
}

/**
 * 是否**已领取**（用于「已领取 N 个」的汇总文案）。
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isClaimed(status) {
  return status?.claimed === true
}

/**
 * 逐账号扫描补偿状态并汇总。
 *
 * ⚠️ **逐账号独立 try/catch** —— 失败只记 `errorCount` 与 `firstError`，
 *    **绝不影响其余账号**，也**绝不**中断循环（这正是初版的缺陷：它以为
 *    `rpcCall` 失败会返回 `{ok:false}`，于是把 await 裸放在循环里，
 *    实际第一次抛错就把整批掀掉了）。
 *
 * ⚠️ `onStatus` 抛错**不计入** `errorCount`：那是宿主侧的 RPC 故障，
 *    与「这个账号没有补偿」是两件事，混进同一张表会让文案说谎。
 *
 * @param {Array<{ id: string, nickname?: string }>} accounts
 * @param {(accountId: string) => Promise<unknown>} onStatus 逐账号取状态（**解包后**的对象）
 * @returns {Promise<{ scanned: number, claimableCount: number, claimedCount: number,
 *                     total: number, endTime: string|null, errorCount: number,
 *                     firstError: string|null }>}
 */
export async function scanCompensation(accounts, onStatus) {
  let total = 0
  let claimableCount = 0
  let claimedCount = 0
  let endTime = null
  let errorCount = 0
  let firstError = null

  for (const account of accounts) {
    let status
    try {
      status = await onStatus(account.id)
    } catch (caught) {
      errorCount += 1
      if (firstError === null) firstError = caught?.message || '未知错误'
      continue
    }
    if (isClaimable(status)) {
      claimableCount += 1
      total += Number(status.creditNum)
      if (endTime === null && typeof status.endTime === 'string') endTime = status.endTime
    } else if (isClaimed(status)) {
      claimedCount += 1
    }
  }

  return { scanned: accounts.length, claimableCount, claimedCount, total, endTime, errorCount, firstError }
}

/**
 * 汇总 → 面板 state 的那一格。
 *
 * ⚠️ **`error` 只在「一个都没查到」时才透出**：部分失败时把卡片打成红色
 * 会让用户以为整批都失败了，而实际上大部分账号的结论是可靠的。
 * 部分失败只体现在 `scan.errorCount`（可另行提示），不抢占卡片主文案。
 *
 * @param {Awaited<ReturnType<typeof scanCompensation>>} scan
 * @returns {{ scanned: number, claimableCount: number, claimedCount: number,
 *             total: number, endTime: string|null, error: string|null,
 *             errorCount: number }}
 */
export function toCompensationState(scan) {
  const allFailed = scan.scanned > 0 && scan.claimableCount === 0 && scan.claimedCount === 0 && scan.errorCount > 0
  return {
    scanned: scan.scanned,
    claimableCount: scan.claimableCount,
    claimedCount: scan.claimedCount,
    total: scan.total,
    endTime: scan.endTime,
    error: allFailed ? scan.firstError : null,
    errorCount: scan.errorCount,
  }
}

/**
 * 领取前复核 + 逐账号领取，返回失败明细。
 *
 * ⚠️ **领取前必须重新查一次状态**（`onStatus`），不能拿 `loadCompensation`
 *    的旧汇总当判据 —— 那是**面板挂载时**的读数，用户可能开着面板过了几小时。
 *    拿陈旧读数去发写操作，最坏情况是对已领账号再打一次领取请求。
 *
 * ⚠️ 「状态查不到」**不算失败**：查不到就不能确认它可领，宁可不领。
 *    这一点与初版不同（初版在状态查询抛错时也会静默跳过，但没有把
 *    「领取请求本身失败」与「状态不可知」分开计数）。
 *
 * @param {Array<{ id: string, nickname?: string }>} accounts
 * @param {(accountId: string) => Promise<unknown>} onStatus
 * @param {(accountId: string) => Promise<unknown>} onClaim
 * @returns {Promise<{ claimed: string[], failures: string[] }>}
 */
export async function claimAllCompensation(accounts, onStatus, onClaim) {
  const claimed = []
  const failures = []

  for (const account of accounts) {
    let status
    try {
      status = await onStatus(account.id)
    } catch {
      // 状态不可知 ⇒ 不发写操作（宁可不领，不可盲领）。
      continue
    }
    if (!isClaimable(status)) continue

    try {
      await onClaim(account.id)
      claimed.push(account.nickname || account.id)
    } catch (caught) {
      failures.push(`${account.nickname || account.id}：${caught?.message || '未知错误'}`)
    }
  }

  return { claimed, failures }
}

/**
 * 补偿卡片的**主文案**（如实展示，不做任何推断）。
 *
 * @param {ReturnType<typeof toCompensationState>} state
 * @returns {string}
 */
export function compensationHeadline(state) {
  if (state === null) return ''
  if (state.error) return `补偿积分状态查询失败：${state.error}`
  if (state.total > 0) {
    return `DeepSeek 模型服务异常补偿：${state.total} 积分待领取`
      + (state.endTime ? `（${state.endTime} 截止）` : '')
  }
  if (state.claimedCount > 0) return '补偿积分已领取'
  if (state.scanned === 0) return '尚未添加 CodeBuddy 账号'
  return '当前没有可领取的补偿积分'
}

/**
 * 补偿卡片的**副文案**。
 *
 * @param {ReturnType<typeof toCompensationState>} state
 * @returns {string}
 */
export function compensationHint(state) {
  if (state === null) return ''
  if (state.total > 0) {
    const partial = state.errorCount > 0 ? `（另有 ${state.errorCount} 个账号查询失败，未计入）` : ''
    return `可领取账号 ${state.claimableCount} / ${state.scanned} 个（按账号独立，每账号限领一次）${partial}`
  }
  if (state.error) return '该能力为附加信息，不影响账号列表的使用。'
  return '限时活动，过期后上游会返回「活动已结束」。'
}