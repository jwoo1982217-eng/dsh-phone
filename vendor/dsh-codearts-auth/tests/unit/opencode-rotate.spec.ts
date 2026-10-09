import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpencodeAdapter, clearOpencodeCatalogCache, opencodeRetryAfterMs,
} from '../../src/opencode-adapter.js'
import { listIdentitySlots, newAccountFingerprint, type IdentitySlot } from '../../src/opencode-auth.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

beforeEach(() => clearOpencodeCatalogCache())
afterEach(() => vi.unstubAllGlobals())

/**
 * 构造一个账号槽。
 *
 * ⚠️ 必须**按 key 派生自己的指纹**：真实接线（`index.ts`）就是这么做的
 * （`deriveProjectId(api_key, generation)`）。若像最初那版一样只 spread
 * 匿名槽再改掉 `apiKey`，所有账号槽会共用匿名槽的 project id ——
 * 表现为「两个账号的防关联指纹一模一样」（写这个用例时实测到）。
 */
function account(id: string, key: string): IdentitySlot {
  return {
    ...ANON(),
    id,
    kind: 'account',
    apiKey: key,
    fingerprint: newAccountFingerprint(key),
  }
}
/**
 * 一个匿名槽。
 *
 * ⚠️ 必须**显式造一条池内条目**（2026-10-02 起匿名通道是账号池里的普通条目，
 * 不再由 `listIdentitySlots` 进程内合成）—— 旧写法
 * `listIdentitySlots([], …).at(-1)` 会拿到 `undefined`。
 */
const ANON = (): IdentitySlot => listIdentitySlots([{
  id: 'opencode-anon-test',
  enabled: true,
  apiKey: 'public',
  fingerprint: undefined,
}], 'opencode/1.18.22')[0]!

function sseOk(): Response {
  const body = 'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n'
    + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * 跑完一次 stream 并收集 chunk。
 *
 * ⚠️ **必须在这里构造 options**（而不是给 `stream()` 传空对象）：
 * 适配器按 `options.model` 判「免费模型能否走匿名槽」，model 为 undefined
 * 时免费判定恒 false，匿名槽会被整条跳过 —— 表现为「一失败就报所有通道受限」。
 */
async function run(
  adapter: OpencodeAdapter,
  model = 'big-pickle',
  messages: unknown[] = [{ role: 'user', content: 'x' }],
): Promise<StreamChunk[]> {
  const options = {
    provider: 'opencode', model, messages, system: '', tools: [],
  } as unknown as GenerateOptions
  const out: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) out.push(chunk)
  return out
}

/** 只想断言「抛不抛」时用它。 */
async function attempt(adapter: OpencodeAdapter, model = 'big-pickle'): Promise<void> {
  await run(adapter, model)
}

describe('opencodeRetryAfterMs', () => {
  it('服务端给了 retry-after 就用它（0 是合法值，不是「未知」）', () => {
    expect(opencodeRetryAfterMs('go_usage_limit', 0, 1)).toBe(0)
    expect(opencodeRetryAfterMs('rate_limit', 30_000, 1)).toBe(30_000)
  })
  it('服务端给了超大值时封顶 30 分钟（不让单次阻塞数小时）', () => {
    expect(opencodeRetryAfterMs('rate_limit', 6 * 60 * 60_000, 1)).toBe(30 * 60_000)
  })
  it('没给时 rate_limit 指数退避，封顶 30 分钟', () => {
    expect(opencodeRetryAfterMs('rate_limit', undefined, 1)).toBe(60_000)
    expect(opencodeRetryAfterMs('rate_limit', undefined, 2)).toBe(120_000)
    expect(opencodeRetryAfterMs('rate_limit', undefined, 20)).toBe(30 * 60_000)
  })
  it('FreeUsageLimitError 无 reset 信息时按 24h 标记（当日额度）', () => {
    expect(opencodeRetryAfterMs('free_usage_limit', undefined, 1)).toBe(24 * 60 * 60_000)
  })
  it('⚠️ 余额不足（402）按 24h 标记 —— 钱不会在 60 秒内到账（真实报障 2026-10-01）', () => {
    expect(opencodeRetryAfterMs('quota', undefined, 1)).toBe(24 * 60 * 60_000)
  })
})

describe('轮换：成功路径', () => {
  it('首个槽成功时不发第二个请求', async () => {
    const spy = vi.fn(async () => sseOk())
    vi.stubGlobal('fetch', spy)
    const a = new OpencodeAdapter({ identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')] })
    const out = await run(a)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(out.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('轮换：限流与额度', () => {
  it('429 → 标记该槽 → 切下一槽重发（账号槽与匿名槽平权同列）', async () => {
    const bearers: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bearers.push((init.headers as Record<string, string>).authorization!)
      return bearers.length === 1 ? new Response('too many requests', { status: 429 }) : sseOk()
    })
    const limited: Array<[string, string, number]> = []
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), ANON()],
      markLimited: async (slot, model, at) => { limited.push([slot, model, at]) },
    })
    await run(a)
    expect(bearers).toEqual(['Bearer sk-a', 'Bearer public'])
    expect(limited[0]![0]).toBe('a')
    expect(limited[0]![1]).toBe('big-pickle')
    expect(limited[0]![2]).toBeGreaterThan(Date.now())
  })

  it('⚠️ tried 跨迭代保留：每个槽最多试一次（不会在 a/b 间无限来回）', async () => {
    let count = 0
    vi.stubGlobal('fetch', async () => { count += 1; return new Response('429', { status: 429 }) })
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')],
      markLimited: async () => {},
    })
    await expect(run(a)).rejects.toBeDefined()
    expect(count).toBe(2)
  })

  it('全部槽受限 → 抛 QUOTA_EXCEEDED（不在 harness 可重试集合内，立即失败）', async () => {
    vi.stubGlobal('fetch', async () => new Response('429', { status: 429 }))
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a')],
      markLimited: async () => {},
    })
    await expect(run(a)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('FreeUsageLimitError → 归为额度耗尽（不是 key 失效）并切槽', async () => {
    const bearers: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bearers.push((init.headers as Record<string, string>).authorization!)
      return bearers.length === 1
        ? new Response('{"error":{"message":"FreeUsageLimitError: free usage exceeded"}}', { status: 403 })
        : sseOk()
    })
    const kinds: string[] = []
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')],
      markLimited: async (slot) => { kinds.push(slot) },
    })
    await run(a)
    expect(bearers).toEqual(['Bearer sk-a', 'Bearer sk-b'])
    expect(kinds).toEqual(['a'])
  })

  it('GoUsageLimitError 的 retry-after 头被用于标记时长', async () => {
    const marks: number[] = []
    vi.stubGlobal('fetch', async () => new Response('GoUsageLimitError', {
      status: 429, headers: { 'retry-after': '600' },
    }))
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a')],
      markLimited: async (_s, _m, at) => { marks.push(at - Date.now()) },
    })
    await expect(run(a)).rejects.toBeDefined()
    // 600s 与实测时刻有毫秒级误差，放宽到 ±5s
    expect(marks[0]).toBeGreaterThan(590_000)
    expect(marks[0]).toBeLessThan(605_000)
  })
})

describe('轮换：认证与形状门禁', () => {
  it('401 → 标记后换下一槽（不无限重试同一 key）', async () => {
    const bearers: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bearers.push((init.headers as Record<string, string>).authorization!)
      return bearers.length === 1 ? new Response('invalid api key', { status: 401 }) : sseOk()
    })
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')],
      markLimited: async () => {},
    })
    await run(a)
    expect(bearers).toEqual(['Bearer sk-a', 'Bearer sk-b'])
  })

  it('⚠️ 402 余额不足 → 标记该槽并切下一个（不重试同一空钱包）', async () => {
    const bearers: string[] = []
    const marks: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bearers.push((init.headers as Record<string, string>).authorization!)
      return bearers.length === 1
        ? new Response('{"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}', { status: 402 })
        : sseOk()
    })
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')],
      markLimited: async (slot) => { marks.push(slot) },
    })
    await run(a)
    expect(bearers).toEqual(['Bearer sk-a', 'Bearer sk-b'])
    expect(marks).toContain('a')
  })

  it('⚠️ 402 全部账号余额不足 → QUOTA_EXCEEDED（不是 SERVER，harness 不会白重试）', async () => {
    vi.stubGlobal('fetch', async () => new Response('Insufficient account funds', { status: 402 }))
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a')],
      markLimited: async () => {},
    })
    await expect(run(a)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('⚠️⚠️ FreeTierError 是**形状门禁**、换槽无用（根因：session id 形状）', async () => {
    // 真实定位（2026-10-01）：session id 尾段写成 38 字符时全线 403；
    // 改成官方真实的 26 字符后同一请求立刻成功。
    // 形状没修好时**换 key / 换出口都无效**（每槽发的形状完全相同），
    // 故不重试也不切槽，只如实透传 + 提示形状线索。
    let count = 0
    vi.stubGlobal('fetch', async () => {
      count += 1
      return new Response(
        '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}',
        { status: 403 },
      )
    })
    const warns: string[] = []
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')],
      markLimited: async () => {},
      warn: (m) => warns.push(m),
    })
    await expect(run(a)).rejects.toThrow(/形状/)
    expect(count).toBe(1)
    expect(warns.join()).toContain('session id')
  })

  it('⚠️ 认证失败且只有一个槽时直接透传（不报「所有通道均受限」）', async () => {
    // 匿名槽就是唯一一个：报「所有通道均受限 / QUOTA_EXCEEDED」会让用户
    // 以为要等额度恢复，而真实原因是这条通道没被接受。
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }))
    const a = new OpencodeAdapter({
      identitySlots: async () => [ANON()],
      markLimited: async () => {},
    })
    await expect(run(a)).rejects.not.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })
})

describe('轮换：流已开始后不重放', () => {
  it('产出过内容后失败 → 不换槽、不重发（防重复输出）', async () => {
    const spy = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"part"},"index":0}]}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', spy)
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')],
      markLimited: async () => {},
    })
    const out = await run(a)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(out.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('收费模型的槽约束', () => {
  it('匿名槽被剔除，只用账号槽', async () => {
    let bearer = ''
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bearer = (init.headers as Record<string, string>).authorization!
      return sseOk()
    })
    const a = new OpencodeAdapter({ identitySlots: async () => [account('a', 'sk-a'), ANON()] })
    await run(a, 'claude-opus-4-5')
    expect(bearer).toBe('Bearer sk-a')
  })

  it('收费模型且无账号槽 → 直接报错（不落匿名通道）', async () => {
    const a = new OpencodeAdapter({ identitySlots: async () => [ANON()] })
    await expect(run(a, 'claude-opus-4-5'))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('请求指纹', () => {
  it('每个槽带自己的 project id（防关联的派生生效）', async () => {
    const seen: string[] = []
    let n = 0
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      n += 1
      seen.push((init.headers as Record<string, string>)['x-opencode-project']!)
      return n === 1 ? new Response('429', { status: 429 }) : sseOk()
    })
    const a = new OpencodeAdapter({
      identitySlots: async () => [account('a', 'sk-a'), account('b', 'sk-b')],
      markLimited: async () => {},
    })
    await run(a)
    expect(seen[0]).toMatch(/^[0-9a-f]{40}$/)
    expect(seen[0]).not.toBe(seen[1])
  })

  it('⚠️ 不发 x-session-affinity（真实 CLI 不发，多发是可检测差异）', async () => {
    let seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>
      return sseOk()
    })
    const a = new OpencodeAdapter({ identitySlots: async () => [account('a', 'sk-a')] })
    await run(a)
    expect(seen['x-session-affinity']).toBeUndefined()
    expect(seen['X-Session-Id']).toBeUndefined()
    expect(seen['x-opencode-session']).toMatch(/^ses_/)
    expect(seen['x-opencode-client']).toBe('cli')
  })

  it('body 恒带 stream:true 与 bash/read 门禁工具', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return sseOk()
    })
    const a = new OpencodeAdapter({ identitySlots: async () => [ANON()] })
    await run(a)
    expect(body.stream).toBe(true)
    const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toContain('bash')
    expect(names).toContain('read')
  })

  it('同一会话内 session id 稳定（跨请求不漂移）', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)['x-opencode-session']!)
      return sseOk()
    })
    const a = new OpencodeAdapter({ identitySlots: async () => [account('a', 'sk-a')] })
    const messages = [{ role: 'user', content: 'x' }]
    const options = { provider: 'opencode', model: 'big-pickle', messages, system: '', tools: [] } as unknown as GenerateOptions
    for await (const _ of a.stream(options)) { /* drain */ }
    for await (const _ of a.stream(options)) { /* drain */ }
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })
})

describe('代理出口', () => {
  it('配了代理的账号走 per-request dispatcher（不动全局）', async () => {
    let seen: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      seen = init as Record<string, unknown>
      return sseOk()
    })
    const withProxy: IdentitySlot = { ...account('p', 'sk-p'), proxy: { kind: 'http', url: 'http://127.0.0.1:7897', label: '' } }
    const a = new OpencodeAdapter({ identitySlots: async () => [withProxy] })
    await run(a)
    expect(seen.dispatcher).toBeDefined()
  })

  it('无代理的账号不带 dispatcher（走默认直连）', async () => {
    let seen: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      seen = init as Record<string, unknown>
      return sseOk()
    })
    const a = new OpencodeAdapter({ identitySlots: async () => [account('n', 'sk-n')] })
    await run(a)
    expect(seen.dispatcher).toBeUndefined()
  })
})
