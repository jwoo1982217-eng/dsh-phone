import { describe, expect, it, vi } from 'vitest'
import { fetchQoderCreditBalance, QODER_USAGE_PATH } from '../../src/qoder-credits.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

const cred: QoderCredential = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' })

/** 实测的真实响应形状（2026-09-19，真实凭据）。 */
function usageResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    displayMode: 'qoder',
    qoderUsage: {
      userId: '01a0b514-ad7c-7dca-ae92-70181beb532e',
      userType: 'personal_standard',
      usageType: 'credits',
      totalUsagePercentage: 0,
      isQuotaExceeded: false,
      expiresAt: 253402214400000,
      upgradeUrl: 'https://qoder.com/pricing?client=qoder',
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
      addOnQuota: {
        total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits',
        detailUrl: 'https://qoder.com/account/usage',
      },
      isPlanQuotaProrated: false,
      ...overrides,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('Qoder 积分余额', () => {
  it('读取 addOnQuota 的 100 积分（真实响应形状）', async () => {
    // 实测：userQuota.remaining=0 而 addOnQuota.remaining=100
    // —— 资源包余额在 addOnQuota 里，只读 userQuota 会得到 0（真实缺陷风险）
    const fetcher = vi.fn(async () => usageResponse()) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(100)
    expect(balance!.packages.length).toBeGreaterThan(0)
  })

  it('请求路径与鉴权头正确（Bearer + Cosy-ClientType，且不带签名）', async () => {
    const fetcher = vi.fn(async () => usageResponse()) as unknown as typeof fetch
    await fetchQoderCreditBalance(cred, QODER, fetcher)
    const call = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(String(call[0])).toBe(`https://openapi.qoder.sh${QODER_USAGE_PATH}`)
    const headers = (call[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['Cosy-ClientType']).toBe('10')
  })

  it('userQuota 与 addOnQuota 同时非零时相加', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 500, used: 200, remaining: 300, percentage: 0.4, unit: 'credits' },
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    // 300（套餐剩余）+ 100（资源包剩余）
    expect(balance!.total).toBe(400)
  })

  it('累加专用资源包（dedicatedResourcePackages）', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        { id: 'p1', name: '包A', total: 50, used: 10, remaining: 40, unit: 'credits' },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance!.total).toBe(140)
  })

  it('企业版（displayMode=enterprise）返回带原因的 null，而非 0', async () => {
    // 「查不到」与「余额为 0」必须严格区分（AGENTS.md 约定）
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      displayMode: 'enterprise',
      enterpriseUsage: { openMode: 'externalBrowser', detailUrl: 'https://qoder.com/x' },
    }), { status: 200 })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).toBeNull()
  })

  it('401 返回带原因的 null（凭据失效）', async () => {
    const fetcher = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).toBeNull()
  })

  it('网络失败返回 null（不抛错，与其它 provider 同语义）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(fetchQoderCreditBalance(cred, QODER, fetcher)).resolves.toBeNull()
  })

  it('响应形状非法时返回 null（不误报 0）', async () => {
    const fetcher = vi.fn(async () => new Response('{"displayMode":"qoder"}', { status: 200 })) as unknown as typeof fetch
    await expect(fetchQoderCreditBalance(cred, QODER, fetcher)).resolves.toBeNull()
  })
})
