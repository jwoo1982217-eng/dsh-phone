import { describe, expect, it, vi } from 'vitest'
import { LOOMY } from '../../src/loomy-product.js'
import {
  LOOMY_ONBOARDING_TOTAL,
  LOOMY_TASK_POINTS,
  claimAllLoomyOnboardingTasks,
  completeLoomyTask,
  computeLoomyEarned,
  fetchLoomyOnboardingTasks,
} from '../../src/loomy-onboarding.js'
import type { LoomyCredential } from '../../src/loomy.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '13011112222',
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: '000000', desc: '成功', trace_id: 't', data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}
function bizError(code: string, desc: string): Response {
  return new Response(JSON.stringify({ code, desc, trace_id: 't', data: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

describe('任务积分表', () => {
  it('8 个任务、合计 10000（与官方注册表一致）', () => {
    const keys = Object.keys(LOOMY_TASK_POINTS)
    expect(keys).toHaveLength(8)
    expect(keys.reduce((sum, k) => sum + LOOMY_TASK_POINTS[k]!, 0)).toBe(10000)
    expect(LOOMY_ONBOARDING_TOTAL).toBe(10000)
  })

  it('逐项积分与官方一致', () => {
    expect(LOOMY_TASK_POINTS).toEqual({
      first_message: 500, pick_skill: 1000, generate_ppt: 1500, set_schedule: 1000,
      install_skill: 1500, configure_remote: 1000, create_soul: 1500, share_soul: 2000,
    })
  })
})

describe('computeLoomyEarned', () => {
  it('按本地表现算（不采信服务端 earned）', () => {
    expect(computeLoomyEarned({ first_message: true, create_soul: true })).toBe(2000)
    expect(computeLoomyEarned({})).toBe(0)
    expect(computeLoomyEarned({ unknown_key: true })).toBe(0)
  })
})

describe('fetchLoomyOnboardingTasks', () => {
  it('GET /onboarding/tasks，用 token 头，earned 本地现算', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({
      tasks: { first_message: true, create_soul: true },
      // 故意给一个与服务端不一致的 earned，验证我们不采信它
      earned: 999,
      total: 10000,
    }))
    const state = await fetchLoomyOnboardingTasks(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(state.earned).toBe(2000) // 500 + 1500，而不是 999
    expect(state.total).toBe(10000)
    // 缺失的 key 补 false
    expect(state.tasks.share_soul).toBe(false)
    expect(Object.keys(state.tasks)).toHaveLength(8)

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://loomyad.xunfei.cn/api/v1/onboarding/tasks')
    expect((init.headers as Record<string, string>).token).toBe(CRED.access_token)
  })

  it('100002 抛认证错误（不重试）', async () => {
    const fetcher = vi.fn().mockResolvedValue(bizError('100002', '登录已失效，请重新登录'))
    await expect(fetchLoomyOnboardingTasks(CRED, LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/登录已失效/)
  })
})

describe('completeLoomyTask', () => {
  it('POST body 恰为 { key }（不带任何设备指纹）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ alreadyCompleted: false, balance: 500 }))
    const result = await completeLoomyTask(CRED, 'first_message', LOOMY, fetcher as unknown as typeof fetch)

    expect(result).toEqual({ alreadyCompleted: false, balance: 500 })
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://loomyad.xunfei.cn/api/v1/onboarding/tasks/complete')
    expect(init.method).toBe('POST')
    // ⚠️ 实测 body 只有 key —— 服务端不校验前置行为
    expect(JSON.parse(String(init.body))).toEqual({ key: 'first_message' })
  })

  it('alreadyCompleted=true 视为成功（幂等）', async () => {
    const fetcher = vi.fn().mockResolvedValue(envelope({ alreadyCompleted: true, balance: 2000 }))
    const result = await completeLoomyTask(CRED, 'first_message', LOOMY, fetcher as unknown as typeof fetch)
    expect(result.alreadyCompleted).toBe(true)
  })

  it('100001（未知 key）抛错，不静默', async () => {
    const fetcher = vi.fn().mockResolvedValue(bizError('100001', '未知的 task key: __nope__'))
    await expect(completeLoomyTask(CRED, '__nope__', LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/未知的 task key/)
  })
})

describe('claimAllLoomyOnboardingTasks', () => {
  it('全部为 false 时逐个串行完成 8 个任务', async () => {
    const allFalse = Object.fromEntries(Object.keys(LOOMY_TASK_POINTS).map((k) => [k, false]))
    const fetcher = vi.fn()
      // 第一次 GET 列表
      .mockResolvedValueOnce(envelope({ tasks: allFalse, earned: 0, total: 10000 }))
    // 之后 8 次 POST 全部成功
    let balance = 0
    for (const key of Object.keys(LOOMY_TASK_POINTS)) {
      balance += LOOMY_TASK_POINTS[key]!
      fetcher.mockResolvedValueOnce(envelope({ alreadyCompleted: false, balance }))
    }

    const result = await claimAllLoomyOnboardingTasks(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(result.claimed).toHaveLength(8)
    expect(result.skipped).toHaveLength(0)
    expect(result.earned).toBe(10000)
    // 1 次 GET + 8 次 POST
    expect(fetcher).toHaveBeenCalledTimes(9)
  })

  it('部分已完成时只补差额（已完成的跳过，不发请求）', async () => {
    const tasks = Object.fromEntries(Object.keys(LOOMY_TASK_POINTS).map((k) => [k, false]))
    tasks.first_message = true
    tasks.create_soul = true
    const fetcher = vi.fn().mockResolvedValueOnce(envelope({ tasks, earned: 2000, total: 10000 }))
    for (let i = 0; i < 6; i += 1) {
      fetcher.mockResolvedValueOnce(envelope({ alreadyCompleted: false, balance: 2000 + i * 1000 }))
    }

    const result = await claimAllLoomyOnboardingTasks(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(result.claimed).toHaveLength(6)
    expect([...result.skipped].sort()).toEqual(['create_soul', 'first_message'])
    // 1 次 GET + 6 次 POST（两个已完成的不发请求）
    expect(fetcher).toHaveBeenCalledTimes(7)
  })

  it('全部已完成时不发任何 complete 请求', async () => {
    const allTrue = Object.fromEntries(Object.keys(LOOMY_TASK_POINTS).map((k) => [k, true]))
    const fetcher = vi.fn().mockResolvedValueOnce(envelope({ tasks: allTrue, earned: 10000, total: 10000 }))

    const result = await claimAllLoomyOnboardingTasks(CRED, LOOMY, fetcher as unknown as typeof fetch)

    expect(result.claimed).toHaveLength(0)
    expect(result.skipped).toHaveLength(8)
    expect(result.earned).toBe(10000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('alreadyCompleted=true 计入 claimed（幂等重放也算成功）', async () => {
    const allFalse = Object.fromEntries(Object.keys(LOOMY_TASK_POINTS).map((k) => [k, false]))
    const fetcher = vi.fn().mockResolvedValueOnce(envelope({ tasks: allFalse, earned: 0, total: 10000 }))
    for (let i = 0; i < 8; i += 1) {
      fetcher.mockResolvedValueOnce(envelope({ alreadyCompleted: true, balance: 0 }))
    }

    const result = await claimAllLoomyOnboardingTasks(CRED, LOOMY, fetcher as unknown as typeof fetch)
    expect(result.claimed).toHaveLength(8)
  })

  it('100002 认证失败时立即抛出（不继续对后续任务发请求）', async () => {
    const allFalse = Object.fromEntries(Object.keys(LOOMY_TASK_POINTS).map((k) => [k, false]))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(envelope({ tasks: allFalse, earned: 0, total: 10000 }))
      .mockResolvedValueOnce(bizError('100002', '登录已失效，请重新登录'))

    await expect(claimAllLoomyOnboardingTasks(CRED, LOOMY, fetcher as unknown as typeof fetch))
      .rejects.toThrow(/登录已失效/)
    // 1 次 GET + 1 次 POST 就停了
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
