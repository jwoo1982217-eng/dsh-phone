import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  TOKENS_PER_SECOND_UNIT,
  formatRowTokensPerSecond,
  formatTokensPerSecond,
  tokensPerSecond,
} from '../../plugin-src/client/tokens-per-second.js'

/**
 * 输出速度（TPS）= **DeepSeek 官方口径**（用户 2026-10-01 指定「按照官方速率
 * 显示规则来」）。规则只读核对自本机 DSH 的
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js`：
 *
 * ```
 * decodeMs = completedTime - firstTokenTime          // 首 token 之后 → 结束
 * tps      = outputTokens / (decodeMs / 1000)        // 分子含推理 token
 * format   : x >= 10 ? Math.round(x) : Math.round(x * 10) / 10
 * 文案     : "{tps} tok/s"
 * ```
 *
 * ⚠️ 这组用例锁的是**官方行为**，不是我们的偏好：
 * 分子**不**减推理 token、**没有**最小窗口下限 —— 官方就是如此，
 * 目的是与本 app 自己显示的 `NNN tok/s` 一致。
 */
describe('formatTokensPerSecond（官方取整规则）', () => {
  it('≥10 → 整数（四舍五入）', () => {
    expect(formatTokensPerSecond(10)).toBe('10')
    expect(formatTokensPerSecond(10.4)).toBe('10')
    expect(formatTokensPerSecond(10.5)).toBe('11')
    expect(formatTokensPerSecond(358.8)).toBe('359')
    // 用户当初报障的那个数量级：官方口径下同样取整，不再虚构小数位
    expect(formatTokensPerSecond(11814.8)).toBe('11815')
  })

  it('<10 → 一位小数（四舍五入）', () => {
    expect(formatTokensPerSecond(0)).toBe('0')
    expect(formatTokensPerSecond(7.34)).toBe('7.3')
    expect(formatTokensPerSecond(7.35)).toBe('7.4')
    expect(formatTokensPerSecond(9.94)).toBe('9.9')
  })

  /**
   * ⚠️ 官方实现的**边界怪癖**，照抄不"修正"：`<10` 分支先乘 10 再四舍五入，
   * 故 9.96 会得到 `'10'`（而不是进 `≥10` 分支）。
   */
  it('9.96 → "10"（官方 <10 分支乘 10 进的位，照抄）', () => {
    expect(formatTokensPerSecond(9.96)).toBe('10')
  })

  it('负值与非法值 clamp 到 0（官方 Math.max(0, …)）', () => {
    expect(formatTokensPerSecond(-5)).toBe('0')
    expect(formatTokensPerSecond(Number.NaN)).toBe('0')
    expect(formatTokensPerSecond(Number.POSITIVE_INFINITY)).toBe('0')
    expect(formatTokensPerSecond(undefined)).toBe('0')
  })

  it('单位后缀就是官方文案里的 tok/s', () => {
    expect(TOKENS_PER_SECOND_UNIT).toBe('tok/s')
  })
})

describe('tokensPerSecond（官方口径的数值）', () => {
  /**
   * 用**本机真实实测**的那笔请求做锚点（探针
   * `verify-cline-row-live.mjs`，`cline-pass/deepseek-v4.1-flash`）：
   * outputTokens=780、reasoningTokens=479、ttft=1746ms、total=4594ms。
   */
  it('真实实测锚点：780 tok ÷ (4594−1746)ms = 273.9 → 显示 274 tok/s', () => {
    const value = tokensPerSecond(780, 4594 - 1746)
    expect(value).toBeCloseTo(273.88, 1)
    expect(formatRowTokensPerSecond({
      usageReported: true, outputTokens: 780, ttftMs: 1746, totalMs: 4594,
    })).toBe('274 tok/s')
  })

  /** ⚠️ 分子**含**推理 token（官方不减）——「减推理」是被用户否掉的旧口径。 */
  it('推理 token 计入分子（与官方一致）', () => {
    // 100 output 中有 90 是推理：官方仍按 100 算
    expect(formatRowTokensPerSecond({
      usageReported: true, outputTokens: 100, reasoningTokens: 90, ttftMs: 1000, totalMs: 2000,
    })).toBe('100 tok/s')
  })

  it('decodeMs 必须 > 0（官方唯一门禁）', () => {
    expect(tokensPerSecond(100, 0)).toBeNull()
    expect(tokensPerSecond(100, -3)).toBeNull()
    expect(tokensPerSecond(100, Number.NaN)).toBeNull()
  })

  /** ⚠️ 官方**没有**最小窗口下限：极短窗口照样出数（那是官方行为）。 */
  it('短窗口不设下限（官方如此；不报 —）', () => {
    // 142 tok ÷ 12ms = 11833.3 → 官方取整 ⇒ 11833
    expect(formatRowTokensPerSecond({
      usageReported: true, outputTokens: 142, ttftMs: 5000, totalMs: 5012,
    })).toBe('11833 tok/s')
  })

  it('用量缺失 → —（官方拿不到 usage 就整项不参与）', () => {
    expect(formatRowTokensPerSecond({ outputTokens: 100, ttftMs: 0, totalMs: 5000 })).toBe('—')
    expect(formatRowTokensPerSecond({ usageReported: false, outputTokens: 100, ttftMs: 0, totalMs: 5000 })).toBe('—')
  })

  /**
   * ⚠️ `ttftMs === 0` 在我们的数据模型里是**「没有任何块到达」= 未知**，
   * 而官方用 `null` 表达缺值。必须做这次映射：照字面算 `total - 0` 会把
   * 「首字时刻未知」当成「首字在 0ms」，报出一个假速率（100/5s = 20 tok/s）。
   */
  it('缺首字时刻（ttft=0 = 未知）→ —（不按 t=0 算）', () => {
    expect(formatRowTokensPerSecond({
      usageReported: true, outputTokens: 100, ttftMs: 0, totalMs: 5000,
    })).toBe('—')
  })
})

/**
 * 口径出处必须留在代码里：用户 2026-09-30 让我改成「正文阶段」口径，
 * 2026-10-01 又要求「按官方来」—— 下一个人若只看 jet-hub.js 很容易再改回去。
 * 故注释里必须留下官方产物路径与函数名，作为**不可回退的凭据**。
 */
describe('口径出处（防止再被"好心纠正"）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const module = readFileSync(resolve(here, '../../plugin-src/client/tokens-per-second.js'), 'utf8')

  it('注明官方产物与函数名', () => {
    expect(module).toMatch(/dsh-client-ui-chat/)
    expect(module).toMatch(/formatTokensPerSecond/)
    expect(module).toMatch(/decodeMs = completedTime\s*-\s*firstTokenTime/)
    expect(module).toMatch(/message\.tokensPerSecond/)
  })

  it('注明「曾被改成正文阶段口径、已被用户否掉」这段历史', () => {
    expect(module).toMatch(/已被用户否掉|被用户否掉/)
    expect(module).toMatch(/不应减|不减/)
  })
})
