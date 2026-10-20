import { describe, expect, it } from 'vitest'
import {
  RACCOON_DEFAULT_EFFORT,
  RACCOON_EFFORT_NAMES,
  RACCOON_EFFORT_OFF,
  RACCOON_EFFORT_ON,
  RACCOON_REASONING_EFFORTS,
} from '../../src/raccoon-product.js'
import { RaccoonAdapter, raccoonReasoningInfo, raccoonThinkingExtraBody } from '../../src/raccoon-adapter.js'
import type { RaccoonCredential } from '../../src/raccoon.js'

/**
 * 小浣熊的思考档位（**两态：开 / 关**）。
 *
 * ## 为什么不是「high / 关闭」
 *
 * 用户的要求：「如果参数指定 high 和 enable 同时 = 只有 enable，
 * 那就显示 high 和关闭 2 档；如果不能指定 high、只能指定 enable，
 * 那就显示开和关 2 档。」
 *
 * 实测结论是**后者**：`reasoning_effort` 虽被服务端 JSON schema 接受
 *（8 个枚举值 `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`ultra`/`max`），
 * 但**不产生任何可观测效果** —— 8 轮配对实验（`temperature=0`）里
 * `max - minimal` 的差值**正 4 次 / 负 4 次**（纯随机）。
 *
 * 唯一有效的是 `extra_body.thinking.type`（枚举 `adaptive`/`enabled`/`disabled`），
 * 实测 `disabled` 8/8 次 `reasoning_tokens` 全为 0。
 *
 * ⚠️ 本文件的用例锁的是**上述实测结论**。若哪天服务端让 `reasoning_effort`
 * 生效了，应重新做配对实验再改这里，**不要**凭直觉加档位。
 */
describe('raccoonThinkingExtraBody', () => {
  it('档位 off → thinking.type = disabled（唯一能真正关闭的写法）', () => {
    expect(raccoonThinkingExtraBody(RACCOON_EFFORT_OFF))
      .toEqual({ thinking: { type: 'disabled' } })
  })

  it('档位 on → thinking.type = enabled', () => {
    expect(raccoonThinkingExtraBody(RACCOON_EFFORT_ON))
      .toEqual({ thinking: { type: 'enabled' } })
  })

  it('不传档位 → undefined（不发该字段，保持服务端默认）', () => {
    expect(raccoonThinkingExtraBody(undefined)).toBeUndefined()
    expect(raccoonThinkingExtraBody('')).toBeUndefined()
  })

  /**
   * ⚠️ 未知档位一律按**开启**处理。
   *
   * 方向取保守：多思考最多费点额度；**静默关掉**会让用户看到模型突然不思考了
   * 却没有任何提示，比多花额度难排查得多。
   */
  it('未知档位按开启处理（不静默关闭思考）', () => {
    expect(raccoonThinkingExtraBody('high'))
      .toEqual({ thinking: { type: 'enabled' } })
    expect(raccoonThinkingExtraBody('zzz'))
      .toEqual({ thinking: { type: 'enabled' } })
  })

  it('**不产生 reasoning_effort**（实测无效，不得写进请求体）', () => {
    const result = raccoonThinkingExtraBody(RACCOON_EFFORT_ON)
    expect(JSON.stringify(result)).not.toContain('reasoning_effort')
    const off = raccoonThinkingExtraBody(RACCOON_EFFORT_OFF)
    expect(JSON.stringify(off)).not.toContain('reasoning_effort')
  })

  it('**不产生 enable_thinking**（实测无效的另一种写法）', () => {
    for (const effort of [RACCOON_EFFORT_ON, RACCOON_EFFORT_OFF]) {
      expect(JSON.stringify(raccoonThinkingExtraBody(effort))).not.toContain('enable_thinking')
    }
  })

  it('不产生双层 extra_body（实测双层不生效）', () => {
    const result = raccoonThinkingExtraBody(RACCOON_EFFORT_OFF)
    expect(result).not.toHaveProperty('extra_body')
  })
})

describe('raccoonReasoningInfo', () => {
  it('**恰好两档**：开与关（不是 high/minimal/... 多档）', () => {
    const info = raccoonReasoningInfo()
    expect(info.efforts).toHaveLength(2)
    expect(info.efforts.map((e) => String(e.id))).toEqual([RACCOON_EFFORT_ON, RACCOON_EFFORT_OFF])
  })

  it('档位 id 不含 high（避免让用户以为能选强度）', () => {
    expect(RACCOON_REASONING_EFFORTS).not.toContain('high')
    expect(JSON.stringify(raccoonReasoningInfo())).not.toContain('"high"')
  })

  it('展示名用「开启 / 关闭」（用户要求：如实表达只有开关一个维度）', () => {
    const info = raccoonReasoningInfo()
    expect(info.efforts[0]?.name).toBe('开启')
    expect(info.efforts[1]?.name).toBe('关闭')
    // 与常量表一致
    for (const e of info.efforts) {
      expect(e.name).toBe(RACCOON_EFFORT_NAMES[String(e.id)])
    }
  })

  it('默认档是 on（实测服务端默认即开启）', () => {
    const info = raccoonReasoningInfo()
    expect(String(info.defaultEffort)).toBe(RACCOON_EFFORT_ON)
  })

  /**
   * ⚠️ `defaultEffort` **必须落在 `efforts` 内** —— DSH 会直接拿它发请求，
   * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`（整轮对话起不来）。
   * 这是 `trae-adapter.ts` 记录过的教训。
   */
  it('⚠️ defaultEffort 必须落在 efforts 内（否则 DSH 抛错）', () => {
    const info = raccoonReasoningInfo()
    const ids = info.efforts.map((e) => String(e.id))
    expect(ids).toContain(String(info.defaultEffort))
    expect(ids).toContain(RACCOON_DEFAULT_EFFORT)
  })

  it('每次调用返回独立数组（调用方改动不污染常量）', () => {
    const a = raccoonReasoningInfo()
    const b = raccoonReasoningInfo()
    expect(a.efforts).not.toBe(b.efforts)
    expect(a.efforts).toEqual(b.efforts)
  })
})

/**
 * 端到端：档位真的写进了**请求体**（不是只声明了 `reasoning`）。
 *
 * ⚠️ 只测纯函数不够 —— 声明了 `reasoning` 但 `stream()` 忘了用它，
 * 用户选了档位却毫无作用，而纯函数测试**全绿**。
 * 这正是 Qoder 那条缺陷的形态（声明与 wire 脱节）。
 */
describe('raccoon 档位写入请求体（端到端）', () => {
  const CRED = {
    access_token: 'a.b.c',
    refresh_token: 'r',
  } as unknown as RaccoonCredential

  /** 造一个能抓到请求体的 adapter。 */
  function makeAdapter(captured: { body?: Record<string, unknown> }): RaccoonAdapter {
    const fetcher = (async (_url: string, init?: { body?: string }) => {
      captured.body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
    return new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    })
  }

  /** 消费一次 stream（触发请求）。 */
  async function consume(adapter: RaccoonAdapter, reasoningEffort?: string): Promise<void> {
    const stream = adapter.stream({
      provider: 'raccoon',
      model: 'sn-deepseek-v4-1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as never },
    } as never)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream) { /* 消费到底 */ }
  }

  it('档位 off → 请求体带 extra_body.thinking.type = disabled', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter(captured)
    await consume(adapter, RACCOON_EFFORT_OFF)
    expect(captured.body?.extra_body).toEqual({ thinking: { type: 'disabled' } })
  })

  it('档位 on → 请求体带 extra_body.thinking.type = enabled', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter(captured)
    await consume(adapter, RACCOON_EFFORT_ON)
    expect(captured.body?.extra_body).toEqual({ thinking: { type: 'enabled' } })
  })

  it('不传档位 → 请求体**没有** extra_body 字段（保持服务端默认）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter(captured)
    await consume(adapter)
    expect(captured.body).not.toHaveProperty('extra_body')
  })

  it('⚠️ 请求体**不含** reasoning_effort / enable_thinking（实测无效的字段）', async () => {
    for (const effort of [RACCOON_EFFORT_ON, RACCOON_EFFORT_OFF]) {
      const captured: { body?: Record<string, unknown> } = {}
      const adapter = makeAdapter(captured)
      await consume(adapter, effort)
      const wire = JSON.stringify(captured.body)
      expect(wire, `档位 ${effort} 不应发出 reasoning_effort`).not.toContain('reasoning_effort')
      expect(wire, `档位 ${effort} 不应发出 enable_thinking`).not.toContain('enable_thinking')
    }
  })

  it('⚠️ thinking 必须在 extra_body 内，不能在顶层（顶层被服务端忽略）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter(captured)
    await consume(adapter, RACCOON_EFFORT_OFF)
    // 顶层不能有 thinking
    expect(captured.body).not.toHaveProperty('thinking')
    // 必须在 extra_body 里
    expect(captured.body?.extra_body).toHaveProperty('thinking')
  })

  it('声明与 wire 一致：resolveModel 的档位 id 能被 stream 消费', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter(captured)
    const resolved = await adapter.resolveModel('raccoon', 'sn-deepseek-v4-1-flash')
    const ids = (resolved.reasoning?.efforts ?? []).map((e) => String(e.id))
    expect(ids.length).toBeGreaterThan(0)
    // 用声明里的每个 id 各发一次，都应被接受（不抛错）
    for (const id of ids) {
      const c: { body?: Record<string, unknown> } = {}
      const a = makeAdapter(c)
      await expect(consume(a, id)).resolves.toBeUndefined()
      expect(c.body?.extra_body).toHaveProperty('thinking')
    }
  })
})
