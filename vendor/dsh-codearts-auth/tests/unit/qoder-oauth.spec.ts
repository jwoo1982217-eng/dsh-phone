import { describe, expect, it, vi } from 'vitest'
import { startQoderLoginFlow, runQoderLoginFlow } from '../../src/qoder-oauth.js'
import { QODER } from '../../src/qoder-product.js'

/** 造一个「按序列返回响应」的 fetch。 */
function pollSequence(responses: Array<() => Response>): typeof fetch {
  let i = 0
  return vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!()) as unknown as typeof fetch
}

const okBody = JSON.stringify({ token: 'tok', refresh_token: 'ref' })

describe('Qoder 设备码登录流程', () => {
  it('startQoderLoginFlow 立即返回 loginUrl（不等用户授权）', async () => {
    // 这是浏览器 transient activation 的硬约束（AGENTS.md）
    const fetchImpl = pollSequence([() => new Response(okBody, { status: 200 })])
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
    })
    expect(started.loginUrl).toContain('/device/selectAccounts')
    // prod 用 J_a（见 qoder-product.ts 的 clientId 说明；读反会导致授权后报「参数无效」）
    expect(started.loginUrl).toContain('client_id=e883ade2')
    await started.result
    await started.close()
  })

  it('轮询遇到 404 继续重试，直到 200 拿到 token', async () => {
    // 404 = 用户尚未完成授权，不是错误（设计文档 §2.3 实测）
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls < 3) return new Response('{"errorCode":"NotFound"}', { status: 404 })
      return new Response(okBody, { status: 200 })
    }) as unknown as typeof fetch
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
    })
    const result = await started.result
    expect(calls).toBe(3)
    expect(JSON.parse(result.access).access_token).toBe('tok')
    expect(result.refreshable).toBe(true)
    await started.close()
  })

  it('轮询 2xx 但无 token 时继续重试', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls < 2) return new Response('{}', { status: 200 })
      return new Response(okBody, { status: 200 })
    }) as unknown as typeof fetch
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
    })
    await started.result
    expect(calls).toBe(2)
    await started.close()
  })

  it('轮询 5xx 直接抛错（服务端异常，不是待授权）', async () => {
    const fetchImpl = pollSequence([() => new Response('boom', { status: 500 })])
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
    })
    await expect(started.result).rejects.toThrow(/500/)
    await started.close()
  })

  it('超时抛错', async () => {
    const fetchImpl = pollSequence([() => new Response('{}', { status: 404 })])
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1, timeoutMs: 30,
    })
    await expect(started.result).rejects.toThrow(/超时/)
    await started.close()
  })

  it('连续网络失败达到上限后抛错', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
    })
    await expect(started.result).rejects.toThrow(/无法连接|网络/)
    await started.close()
  })

  it('runQoderLoginFlow 打开浏览器并返回结果', async () => {
    const fetchImpl = pollSequence([() => new Response(okBody, { status: 200 })])
    const opened: string[] = []
    const result = await runQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
      openBrowser: (url) => { opened.push(url) },
    })
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('/device/selectAccounts')
    expect(result.refreshable).toBe(true)
  })

  it('结果落定后 close 幂等可重复调用', async () => {
    const fetchImpl = pollSequence([() => new Response(okBody, { status: 200 })])
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
    })
    await started.result
    await started.close()
    await started.close()
  })

  it('结果里带出 machineId（需随凭据持久化）', async () => {
    const fetchImpl = pollSequence([() => new Response(okBody, { status: 200 })])
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 1,
    })
    const result = await started.result
    expect(result.machineId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(result.access).machine_id).toBe(result.machineId)
    await started.close()
  })

  it('close 会中止轮询（不泄漏挂起的请求）', async () => {
    const fetchImpl = pollSequence([() => new Response('{}', { status: 404 })])
    const started = await startQoderLoginFlow({
      product: QODER, fetcher: fetchImpl, pollIntervalMs: 5,
    })
    await started.close()
    await expect(started.result).rejects.toThrow(/取消/)
  })
})
