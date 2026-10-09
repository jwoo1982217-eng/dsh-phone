import { describe, expect, it } from 'vitest'
import { parseClineRouting } from '../../src/cline-routing.js'

/**
 * 「上游渠道」解析的回归。
 *
 * ⚠️ fixture 的形状分两类来源，别混：
 * - `choices[0].delta` 那条是**本机真实流式响应**（2026-10-01 实测，
 *   `cline-pass/deepseek-v4.1-flash`，逐帧打印命中路径的探针见 AGENTS.md）；
 * - `message` / 顶层 / `provider` 那几条取自参考实现的样例。
 *
 * 用户报障「上游显示的不正确」：原先展示层用的是**模型 id 的 `/` 前缀**
 * （`cline-pass` / `cline-free`，甚至是厂商名），不是 serving channel。
 *
 * ⚠️⚠️ **本文件存在的直接理由**：第一版实现只读 `message` 与**帧顶层**，
 * 而实测的真实链路把它挂在 `choices[0].delta` 上 —— 修复因此**在真实链路上
 * 完全没生效**（用户第二次报障「上游显示的还是错误的」）。故下面第一条用例
 * 锁的就是这个位置，改动解析顺序时**不许把它挪到后面去**。
 */
describe('parseClineRouting', () => {
  /**
   * ⚠️ **真实流式形状（本机实测）** —— 缺了这条，第一版的漏读就不会被发现。
   *
   * 实测原文（节选，只保留相关字段）：
   * `{"choices":[{"index":0,"delta":{"provider_metadata":{"gateway":{"routing":
   * {"finalProvider":"deepseek","modelAttempts":[{"providerAttempts":
   * [{"provider":"deepseek"}]}]}}}}}]}`
   */
  it('流式（真实链路）：读 choices[0].delta 上的 provider_metadata', () => {
    expect(parseClineRouting({
      id: 'gen-1759250000-abc',
      object: 'chat.completion.chunk',
      model: 'deepseek/deepseek-v4.1-flash',
      choices: [{
        index: 0,
        delta: {
          provider_metadata: {
            gateway: {
              routing: {
                finalProvider: 'deepseek',
                modelAttempts: [{ providerAttempts: [{ provider: 'deepseek' }] }],
              },
            },
          },
        },
      }],
    })).toBe('deepseek')
  })

  /** ⚠️ 真实帧里 `provider` 也出现在嵌套的 `providerAttempts[]` 里，不能被误取。 */
  it('流式：嵌套的 providerAttempts[].provider 不算「上游」（只认 routing.finalProvider）', () => {
    expect(parseClineRouting({
      choices: [{
        index: 0,
        delta: {
          provider_metadata: {
            gateway: {
              routing: {
                modelAttempts: [{ providerAttempts: [{ provider: 'deepseek' }] }],
              },
            },
          },
        },
      }],
    })).toBe('')
  })

  it('planner 管线：读 message 上的 provider_metadata（参考实现同款样例）', () => {
    expect(parseClineRouting({
      choices: [{
        message: {
          provider_metadata: {
            gateway: {
              routing: {
                finalProvider: 'alibaba',
                canonicalSlug: 'z-ai/glm-5.2',
                fallbacksAvailable: ['baseten'],
                planningReasoning: 'alibaba won tier 0 over baseten',
              },
            },
          },
        },
      }],
    })).toBe('alibaba')
  })

  it('帧顶层：读 provider_metadata（参考实现抓到的另一种形态，保留兼容）', () => {
    expect(parseClineRouting({
      provider_metadata: { gateway: { routing: { finalProvider: 'baseten' } } },
    })).toBe('baseten')
  })

  it('direct 管线：读顶层 provider（保留原始大小写）', () => {
    expect(parseClineRouting({ provider: 'GMICloud', choices: [{ message: {} }] })).toBe('GMICloud')
  })

  it('direct 管线（流式）：读 delta.provider', () => {
    expect(parseClineRouting({ choices: [{ delta: { provider: 'GMICloud' } }] })).toBe('GMICloud')
  })

  it('套了一层 data 信封也要认（参考实现的 unwrapEnvelope）', () => {
    expect(parseClineRouting({
      data: { provider: 'GMICloud', choices: [{ message: { content: 'hi' } }] },
    })).toBe('GMICloud')
  })

  /**
   * ⚠️ 本仓库另一处实测（AGENTS.md 的 Gemini-400 段）记的是 **camelCase**
   * `providerMetadata` —— 只认 snake_case 会在那种形态下静默读不到。
   */
  it('camelCase 拼写同样接受（本仓库错误体实测形态）', () => {
    expect(parseClineRouting({
      providerMetadata: { gateway: { routing: { finalProvider: 'vertex' } } },
    })).toBe('vertex')
  })

  it('读不到时返回空串（绝不编造渠道名）', () => {
    for (const frame of [undefined, null, {}, { choices: [] }, 'str', 42, { provider: '' }, { provider: 7 }]) {
      expect(parseClineRouting(frame), JSON.stringify(frame)).toBe('')
    }
  })

  it('空白字符串不算读数（否则会把空渠道写进记录）', () => {
    expect(parseClineRouting({ provider: '   ' })).toBe('')
    expect(parseClineRouting({ provider_metadata: { gateway: { routing: { finalProvider: '  ' } } } })).toBe('')
  })
})
