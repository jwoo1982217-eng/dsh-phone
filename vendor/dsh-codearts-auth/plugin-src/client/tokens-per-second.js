/**
 * 输出速度（TPS）的**取值与格式化** —— 照抄 DeepSeek 官方口径。
 *
 * ## 出处（只读核对，2026-10-01）
 *
 * DeepSeek Harness 自己的聊天 UI：`@deepseek-ai/dsh-client-ui-chat` 的
 * `lib/client.js`（本机安装产物里可直接读到）：
 *
 * ```js
 * // assistantStepReading(node)：一「步」的读数
 * ttftMs   = firstTokenTime - stepStartTime      // 首个 token（任意块，含推理块）
 * decodeMs = completedTime  - firstTokenTime     // 首 token 之后 → 结束
 * outputTokens = usage.outputTokens              // 该步全部输出 token
 *
 * // TimePill()：显示
 * const tps = stats.decodeMs > 0
 *   ? t("message.tokensPerSecond", { tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) })
 *   : null;
 *
 * // formatTokensPerSecond()：取整规则
 * function formatTokensPerSecond(tps) {
 *   const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
 * }
 * ```
 *
 * 官方文案（i18n）：`message.tokensPerSecond = "{tps} tok/s"`，
 * 统计对话框那行标签是 `stats.dialog.speed = "输出速度（TPS）"`。
 *
 * ## 三条必须记住的官方语义
 *
 * 1. **分子是全部输出 token（含推理 token）**：`reasoning_tokens` 计入
 *    `completion_tokens`（本仓库已实测），官方不减它。
 *    ⚠️ 本插件曾在 2026-09-30 改成「正文 token ÷ 正文阶段」并加了 250ms 下限，
 *    **已被用户否掉**（用户 2026-10-01：按官方规则来）—— 别再改回去。
 * 2. **分母是「首 token 之后 → 结束」**（`decodeMs`），**不含**首字之前那段。
 * 3. **官方只有 `decodeMs > 0` 这一道门，没有最小窗口下限**：短窗口
 *    （响应几乎一次性到达）会得到一个很大的数，那是官方行为。
 *
 * ## 为什么单独成文件
 *
 * 与 `model-filter.js` / `model-groups.js` 同理：本仓库单测环境里 react 不在
 * 依赖内，组件无法渲染；而「≥10 取整、<10 一位小数」这种细节用源码字符串断言
 * 锁不住（写错比较符或漏掉乘以 10 都能骗过 `toMatch`）。抽成纯函数后可以
 * 用**真实断言**逐值覆盖。
 */

/** 官方文案里的单位后缀（`"{tps} tok/s"`）。 */
export const TOKENS_PER_SECOND_UNIT = 'tok/s'

/**
 * 官方 `formatTokensPerSecond`：先 clamp 负值，再**≥10 取整、<10 一位小数**。
 *
 * ⚠️ 这里是**两个分支两套精度**，不是统一的 `toFixed`：
 * 官方意图是「大数不需要小数位，小数才需要」。
 *
 * @param {number} tps 每秒 token 数（可为小数、负数；非有限值按 0 处理）
 * @returns {string} 不含单位的显示数字
 */
export function formatTokensPerSecond(tps) {
  const value = typeof tps === 'number' && Number.isFinite(tps) ? tps : 0
  const clamped = Math.max(0, value)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/**
 * 官方口径的 TPS 数值（不可测时返回 `null`）。
 *
 * @param {number} outputTokens 该次请求的**全部**输出 token（含推理 token）
 * @param {number} decodeMs 生成阶段时长 = `总耗时 − 首字`
 * @returns {number | null} `decodeMs > 0` 时才可测（官方同款门禁）
 */
export function tokensPerSecond(outputTokens, decodeMs) {
  if (!(typeof decodeMs === 'number' && Number.isFinite(decodeMs) && decodeMs > 0)) return null
  const tokens = typeof outputTokens === 'number' && Number.isFinite(outputTokens) ? outputTokens : 0
  return Math.max(0, tokens) / (decodeMs / 1000)
}

/**
 * 面板要显示的那一格（`112 tok/s`，不可测时 `—`）。
 *
 * ⚠️ **用量缺失时也不显示**：官方 `usageOutputTokens()` 拿不到用量就整项不参与
 * 统计，故这里要求 `usageReported === true`，否则显示 `—`
 * （`0 tok/s` 会被读成「输出是零」）。
 *
 * ⚠️ **`ttftMs === 0` 当「未知」而不是「t=0」**：官方数据模型里缺值是 `null`
 * （`timing.firstTokenTime !== null` 是它的门禁），而**我们的记录用 `0` 表示
 * 「没有任何块到达」**（见 `cline-adapter.ts` 的 `ttftMs` 注释）。若照字面算
 * `decodeMs = total - 0`，会把「首字时刻未知」当成「首字在 0ms」而报出一个
 * 假的速率。这里做一次显式映射：`0` ⇒ 不可测。
 *
 * @param {{ usageReported?: boolean, outputTokens?: number, ttftMs?: number, totalMs?: number }} row
 * @returns {string}
 */
export function formatRowTokensPerSecond(row) {
  if (row?.usageReported !== true) return '—'
  const total = Number(row?.totalMs ?? 0)
  const first = Number(row?.ttftMs ?? 0)
  // 见上：0 = 我们数据模型里的「未知」，不是「t=0」。
  if (!(first > 0)) return '—'
  const value = tokensPerSecond(Number(row?.outputTokens ?? 0), total - first)
  return value === null ? '—' : `${formatTokensPerSecond(value)} ${TOKENS_PER_SECOND_UNIT}`
}
