import { describe, expect, it, vi } from 'vitest'
import {
  CLINE_USAGE_LIMITS_PATH,
  fetchClineUsageLimits,
  parseClineUsageLimits,
} from '../../src/cline-quota.js'
import { CLINE } from '../../src/cline-product.js'
import type { ClineCredential } from '../../src/cline.js'
/**
 * ⚠️ fixture 的**形状**取自参考实现
 * `github.com/codeOct/dsh-cline-pass`（额度管理部分），并已在
 * **2026-09-29 用本机真实 Cline 账号实发核对**过：端点、信封、字段名与下面
 * 解析层读的完全一致（`data.limits[].{type,percentUsed,resetsAt}`）。
 *
 * 实测另有两个形态值得记住，已各自写进用例：
 * - `resetsAt` 带**纳秒**精度（9 位小数），如实测的 `2026-09-29T15:41:02.244817775Z`；
 * - 用量为 0 的窗口 `resetsAt` 是**空串**。
 *
 * 若将来实测发现字段又变了，**改解析层 + 本 fixture 一起改**，不要只改一边。
 */
const LIMITS_FIXTURE = {
  success: true,
  data: {
    limits: [
      { type: 'five_hour', percentUsed: 12.5, resetsAt: '2026-09-29T10:00:00.000Z' },
      { type: 'weekly', percentUsed: 68, resetsAt: '2026-10-05T00:00:00.000Z' },
      { type: 'monthly', percentUsed: 120, resetsAt: '2026-10-31T00:00:00.000Z' },
    ],
  },
}

/** 凭据形态与实测一致（`account_id` 是 `usr-…`、令牌带 `workos:` 前缀）。 */
const CRED: ClineCredential = {
  access_token: 'workos:eyJhbGciOiJSUzI1NiIs',
  refresh_token: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
  account_id: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
  email: 'ijetlee@163.com',
}

describe('parseClineUsageLimits', () => {
  it('解析实测形状的三个窗口', () => {
    const result = parseClineUsageLimits(LIMITS_FIXTURE)
    expect(result.error).toBeUndefined()
    expect(result.windows).toHaveLength(3)
    expect(result.windows[0]).toEqual({
      type: 'five_hour',
      percentUsed: 12.5,
      resetsAt: '2026-09-29T10:00:00.000Z',
    })
  })

  /**
   * ⚠️ 窗口按网关原序透传、未知类型保留：这样网关新增窗口（如 `daily`）时
   * 面板立刻多一行，**不需要**为它发一个插件版本。
   */
  it('未知窗口类型原样保留，且顺序不变', () => {
    const result = parseClineUsageLimits({
      success: true,
      data: { limits: [{ type: 'daily', percentUsed: 1, resetsAt: '' }, { type: 'five_hour', percentUsed: 2, resetsAt: '' }] },
    })
    expect(result.windows.map(w => w.type)).toEqual(['daily', 'five_hour'])
  })

  /**
   * ⚠️ 百分比**不夹取**：120 表示超额，夹到 100 会把「已超限」显示成
   * 「刚好用完」 —— 那正是最该看见的信息。
   */
  it('percentUsed 超额时如实透传 120（不夹取到 100）', () => {
    const result = parseClineUsageLimits(LIMITS_FIXTURE)
    expect(result.windows[2]!.percentUsed).toBe(120)
  })

  /**
   * ⚠️ 实发核对（2026-09-29，真实 Cline 账号）发现 `resetsAt` 是**纳秒**精度
   * （9 位小数）：`2026-09-29T15:41:02.244817775Z`。解析层必须**原样保留**
   * （不要截断或归一化 —— 那会掩盖上游改动），且 `Date.parse` 能认它，
   * 客户端据此算「N 小时后重置」。
   */
  it('resetsAt 纳秒精度原样保留，且 Date.parse 能解析', () => {
    const iso = '2026-09-29T15:41:02.244817775Z'
    const result = parseClineUsageLimits({
      success: true,
      data: { limits: [{ type: 'five_hour', percentUsed: 4, resetsAt: iso }] },
    })
    expect(result.windows[0]!.resetsAt).toBe(iso)
    expect(Number.isFinite(Date.parse(iso))).toBe(true)
  })

  /**
   * ⚠️ 实测形态：用量为 0 的窗口 `resetsAt` 是**空串**。
   * 必须当成「没有重置时刻」而不是错误 —— 客户端据此**不渲染**那一行
   * （显示空白的「重置」反而让人以为读取失败）。
   */
  it('resetsAt 为空串时保留空串且不算失败', () => {
    const result = parseClineUsageLimits({
      success: true,
      data: { limits: [{ type: 'five_hour', percentUsed: 0, resetsAt: '' }] },
    })
    expect(result.windows[0]!.resetsAt).toBe('')
    expect(result.error).toBeUndefined()
  })

  it('缺 type 的行被丢弃（无法归属到任何窗口）', () => {
    const result = parseClineUsageLimits({
      success: true,
      data: { limits: [{ percentUsed: 5 }, { type: 'weekly', percentUsed: 6 }] },
    })
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]!.type).toBe('weekly')
  })

  it('percentUsed 缺省记 0（合法语义：该窗口没用过）', () => {
    const result = parseClineUsageLimits({ success: true, data: { limits: [{ type: 'weekly' }] } })
    expect(result.windows[0]!.percentUsed).toBe(0)
    expect(result.windows[0]!.resetsAt).toBe('')
  })

  it('信封缺失时把顶层当载荷（网关不保证有 data 包装）', () => {
    const result = parseClineUsageLimits({ limits: [{ type: 'weekly', percentUsed: 3 }] })
    expect(result.windows).toHaveLength(1)
  })

  it('success:false 时回传服务端文案', () => {
    const result = parseClineUsageLimits({ success: false, error: 'Unauthorized' })
    expect(result.windows).toEqual([])
    expect(result.error).toBe('Unauthorized')
  })

  /**
   * ⚠️ 余额端点实测过这种形态：**HTTP 401 的响应体没有 `success` 字段**，
   * 只在 `error` 里说明原因。订阅额度走同一个网关，必须同样认。
   */
  it('网关层失败（无 success 字段、只有 error）也认', () => {
    const result = parseClineUsageLimits({ error: 'Unauthorized: re-authenticate' })
    expect(result.windows).toEqual([])
    expect(result.error).toContain('Unauthorized')
  })

  it('缺 limits 字段时给出明确原因', () => {
    expect(parseClineUsageLimits({ success: true, data: {} }).error).toBe('响应缺少 limits 字段')
  })

  it('垃圾输入返回错误而不抛错', () => {
    for (const value of [undefined, null, 'str', 42, []]) {
      expect(parseClineUsageLimits(value).error, String(value)).toBeDefined()
    }
  })
})
describe('fetchClineUsageLimits', () => {
  it('用 users/me 拼 URL，并保留 workos: 前缀', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify(LIMITS_FIXTURE), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchClineUsageLimits(CRED, CLINE, fetcher)
    expect(calls[0]!.url).toBe(`https://api.cline.bot${CLINE_USAGE_LIMITS_PATH}`)
    expect(calls[0]!.url).toContain('/users/me/plan/usage-limits')
    expect(calls[0]!.headers.Authorization).toBe('Bearer workos:eyJhbGciOiJSUzI1NiIs')
    expect(result.ok).toBe(true)
    expect(result.windows).toHaveLength(3)
  })

  /** ⚠️ 额度端点用 `users/me`，故**不要求**凭据里有 account_id。 */
  it('缺 account_id 也能查额度（路径是 me，不依赖账号 id）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(LIMITS_FIXTURE), { status: 200 })) as unknown as typeof fetch
    const result = await fetchClineUsageLimits({ access_token: 'workos:a' }, CLINE, fetcher)
    expect(fetcher).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('非 2xx 时带上 HTTP 状态码与服务端文案', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch
    const result = await fetchClineUsageLimits(CRED, CLINE, fetcher)
    expect(result.ok).toBe(false)
    expect(result.windows).toEqual([])
    expect(result.error).toContain('HTTP 401')
    expect(result.error).toContain('Unauthorized')
  })

  /**
   * ⚠️ 网关出错时可能回 HTML（`Unexpected token '<'` 那类），必须把前缀带上，
   * 否则排查者只知道「解析失败」而不知道拿到的是登录页。
   */
  it('响应不是 JSON 时给出可读原因（含响应体前缀）', async () => {
    const fetcher = vi.fn(async () => new Response('<html>sign in</html>', { status: 200 })) as unknown as typeof fetch
    const result = await fetchClineUsageLimits(CRED, CLINE, fetcher)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不是 JSON')
    expect(result.error).toContain('<html>')
  })

  it('网络失败不抛错，返回带原因的空结果', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await fetchClineUsageLimits(CRED, CLINE, fetcher)
    expect(result.ok).toBe(false)
    expect(result.windows).toEqual([])
    expect(result.error).toContain('网络失败')
    expect(result.error).toContain('ECONNREFUSED')
  })

  /** ⚠️ 查不到**不能显示成 0%**：0% 是「没用过」的语义。 */
  it('成功但缺少 limits 时 ok 为 false 而非给一个空窗口列表', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })) as unknown as typeof fetch
    const result = await fetchClineUsageLimits(CRED, CLINE, fetcher)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('limits')
  })
})

