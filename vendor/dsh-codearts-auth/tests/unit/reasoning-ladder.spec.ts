import { describe, expect, it } from 'vitest'
import {
  CANONICAL_REASONING_EFFORTS,
  canonicalReasoningEffortFor,
  isKnownReasoningEffort,
  isThinkingOffEffort,
  reasoningRankOf,
  translateReasoningEffort,
} from '../../src/reasoning-ladder.js'

/**
 * 「OpenAI 规范档位名 ↔ 各 provider 私有 id」的强度序与翻译。
 *
 * 背景（真实缺陷）：网关原先把模型声明的 id **原样**校验，而走 OpenAI 协议的
 * 客户端只有固定 8 档词汇。用户照 DSH 界面上的名字填进 CC Switch：
 *
 * | 界面上看到的 | 客户端照填 | 模型真实认的 | 旧行为 |
 * |---|---|---|---|
 * | LobsterAI 的 Max | `max` | `xhigh` | 400，整轮失败 |
 * | Cline 的 Extra | `xhigh` | `max` | 400，整轮失败 |
 * | TRAE 的 Light / Extra High | `low` / `xhigh` | `light` / `extra_high` | 400，整轮失败 |
 */
describe('reasoning-ladder：档位强度序', () => {
  it('规范名就是 CC Switch 档位多选器里的那 8 个（由弱到强）', () => {
    expect([...CANONICAL_REASONING_EFFORTS]).toEqual([
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
  })

  it('强度序严格递增，且 off / none 是唯一的「关闭」档', () => {
    const order = ['minimal', 'light', 'low', 'medium', 'high', 'extra_high', 'xhigh', 'max', 'ultra']
    for (let i = 1; i < order.length; i += 1) {
      const previous = reasoningRankOf(order[i - 1])!
      const current = reasoningRankOf(order[i])!
      expect(current, `${order[i]} 应强于 ${order[i - 1]}`).toBeGreaterThan(previous)
    }
    expect(reasoningRankOf('off')).toBe(0)
    expect(reasoningRankOf('none')).toBe(0)
    expect(isThinkingOffEffort('off')).toBe(true)
    expect(isThinkingOffEffort('none')).toBe(true)
    expect(isThinkingOffEffort('minimal')).toBe(false)
  })

  it('未登记的名字没有强度（不猜）', () => {
    expect(reasoningRankOf('banana')).toBeUndefined()
    expect(isKnownReasoningEffort('banana')).toBe(false)
    expect(isKnownReasoningEffort('extra_high')).toBe(true)
  })
})

describe('reasoning-ladder：翻译', () => {
  it('★ 精确命中优先：模型声明的私有 id 原样通过（不要求它在强度序里）', () => {
    expect(translateReasoningEffort('light', ['light', 'high', 'extra_high']))
      .toEqual({ kind: 'exact', effort: 'light' })
    // 上游新冒出来的名字：只要模型声明了就必须原样下发 —— 我们不认识不代表它非法。
    expect(translateReasoningEffort('turbo', ['turbo'])).toEqual({ kind: 'exact', effort: 'turbo' })
  })

  it('★ TRAE：low → light、xhigh → extra_high、max → extra_high', () => {
    const trae = ['light', 'high', 'extra_high']
    expect(translateReasoningEffort('low', trae)).toEqual({ kind: 'mapped', effort: 'light', requested: 'low', rank: 3 })
    expect(translateReasoningEffort('xhigh', trae)).toMatchObject({ kind: 'mapped', effort: 'extra_high' })
    // `max` 也落在 extra_high —— 它没有更强的档可去。
    expect(translateReasoningEffort('max', trae)).toMatchObject({ kind: 'mapped', effort: 'extra_high' })
    expect(translateReasoningEffort('high', trae)).toEqual({ kind: 'exact', effort: 'high' })
  })

  it('★ LobsterAI：界面上叫 Max，wire 值是 xhigh —— max 被翻译过去而不是 400', () => {
    const lobster = ['off', 'high', 'xhigh']
    expect(translateReasoningEffort('max', lobster)).toMatchObject({ kind: 'mapped', effort: 'xhigh' })
    expect(translateReasoningEffort('xhigh', lobster)).toEqual({ kind: 'exact', effort: 'xhigh' })
    // 顺带：CC Switch 那份表里的 `high` 本来就是对的。
    expect(translateReasoningEffort('low', lobster)).toMatchObject({ kind: 'mapped', effort: 'high' })
  })

  it('★ Cline：界面上叫 Extra，wire 值是 max —— xhigh 被翻译成 max', () => {
    const cline = ['none', 'low', 'medium', 'high', 'max']
    expect(translateReasoningEffort('xhigh', cline)).toMatchObject({ kind: 'mapped', effort: 'max' })
    expect(translateReasoningEffort('max', cline)).toEqual({ kind: 'exact', effort: 'max' })
  })

  it('★ 只在同族内翻译：要「开思考」绝不落到关闭档，反之亦然', () => {
    // 把「少想一点」翻译成「完全不想」是**静默关掉功能**，比 400 更糟。
    expect(translateReasoningEffort('minimal', ['off', 'high'])).toMatchObject({ kind: 'mapped', effort: 'high' })
    expect(translateReasoningEffort('none', ['off', 'high'])).toMatchObject({ kind: 'mapped', effort: 'off' })
    // 只有 high 一档的模型（workbuddy / trae 的当前档位表）：要 none 无处可去。
    expect(translateReasoningEffort('none', ['high'])).toEqual({ kind: 'unexpressible' })
  })

  it('★ 同距取更强的一档（与仓库既有「宁可多思考」口径一致）', () => {
    // medium(4) 到 low(3) 与 high(5) 等距 → high。
    expect(translateReasoningEffort('medium', ['low', 'high', 'max'])).toMatchObject({ effort: 'high' })
    // light(2) 到 minimal(1) 与 low(3) 等距 → low。
    expect(translateReasoningEffort('light', ['minimal', 'low'])).toMatchObject({ effort: 'low' })
  })

  it('模型没有这一族的档位 → unexpressible（调用方不下发该参数）', () => {
    expect(translateReasoningEffort('none', ['high', 'xhigh'])).toEqual({ kind: 'unexpressible' })
  })

  it('完全不认识的写法 → unknown（调用方报错，不静默降级）', () => {
    expect(translateReasoningEffort('banana', ['low', 'high'])).toEqual({ kind: 'unknown' })
    expect(translateReasoningEffort('', ['low'])).toEqual({ kind: 'unknown' })
  })

  it('未登记强度的声明 id 不参与就近匹配（不知道强度就不猜）', () => {
    expect(translateReasoningEffort('high', ['turbo'])).toEqual({ kind: 'unexpressible' })
  })

  it('空声明集合 → unexpressible（模型未声明档位由调用方另判，见 messages.ts）', () => {
    expect(translateReasoningEffort('high', [])).toEqual({ kind: 'unexpressible' })
  })
})

describe('canonicalReasoningEffortFor：该填哪几个', () => {
  it('私有 id 反查成客户端能表达的规范名', () => {
    expect(canonicalReasoningEffortFor('light')).toBe('low')
    expect(canonicalReasoningEffortFor('extra_high')).toBe('xhigh')
    // Raccoon 的二元开关：`on` 没有强度语义，落到 high；`off` 就是 none。
    expect(canonicalReasoningEffortFor('on')).toBe('high')
    expect(canonicalReasoningEffortFor('off')).toBe('none')
  })

  it('规范名原样返回', () => {
    for (const canonical of CANONICAL_REASONING_EFFORTS) {
      expect(canonicalReasoningEffortFor(canonical)).toBe(canonical)
    }
  })

  it('未登记的名字不编答案（那意味着「该填什么」我们确实不知道）', () => {
    expect(canonicalReasoningEffortFor('turbo')).toBeUndefined()
  })

  it('★ 往返自洽：反查出来的名字译回去必须还是原 id（否则「该填」就是错的）', () => {
    // 每个渠道用**真实的**档位集合 —— 反查是按「这一个模型的候选集」做的，
    // 把几个渠道的档位混在一起得到的答案没有意义（也就不保证往返）。
    const channels: Record<string, string[]> = {
      trae: ['light', 'high', 'extra_high'],
      lobsterai: ['off', 'high', 'xhigh'],
      cline: ['none', 'low', 'medium', 'high', 'max'],
      raccoon: ['on', 'off'],
      workbuddy: ['high'],
      'deepseek-account': ['none', 'low', 'high', 'max'],
      // Qoder 声明的顺序是乱的（xhigh 在最前），反查不能依赖顺序。
      qoder: ['xhigh', 'high', 'low', 'max', 'medium'],
    }
    for (const [name, declared] of Object.entries(channels)) {
      for (const id of declared) {
        const canonical = canonicalReasoningEffortFor(id)
        expect(canonical, `${name} 的 ${id} 应有对应的规范名`).toBeDefined()
        const back = translateReasoningEffort(canonical!, declared)
        expect(back, `${name}：${canonical} 应译回 ${id}`).toMatchObject({ effort: id })
      }
    }
  })
})
