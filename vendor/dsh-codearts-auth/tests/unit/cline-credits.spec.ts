import { describe, expect, it, vi } from 'vitest'
import {
  CLINE_BALANCE_SCALE,
  fetchClineCreditBalance,
  parseClineBalanceResponse,
  toClineCreditBalance,
} from '../../src/cline-credits.js'
import { CLINE } from '../../src/cline-product.js'
import type { ClineCredential } from '../../src/cline.js'

/** 实测的余额响应（2026-09-25）。 */
const BALANCE_FIXTURE = {
  data: { userId: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM', balance: 500000 },
  success: true,
}

const CRED: ClineCredential = {
  access_token: 'workos:eyJhbGciOiJSUzI1NiIs',
  refresh_token: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
  account_id: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
  email: 'ijetlee@163.com',
}

describe('parseClineBalanceResponse', () => {
  it('解析实测响应', () => {
    expect(parseClineBalanceResponse(BALANCE_FIXTURE)).toEqual({ rawBalance: 500000 })
  })

  it('success:false 时返回服务端的 error 文案', () => {
    expect(parseClineBalanceResponse({ success: false, error: 'Unauthorized' }))
      .toEqual({ error: 'Unauthorized' })
  })

  it('缺 data / 缺 balance 都报明确原因', () => {
    expect(parseClineBalanceResponse({ success: true })).toEqual({ error: '响应缺少 data 字段' })
    expect(parseClineBalanceResponse({ success: true, data: {} })).toEqual({ error: '响应缺少 balance 字段' })
  })

  it('接受数字字符串形态的 balance', () => {
    expect(parseClineBalanceResponse({ success: true, data: { balance: '12345' } }))
      .toEqual({ rawBalance: 12345 })
  })

  it('垃圾输入返回错误而不抛错', () => {
    for (const value of [undefined, null, 'str', 42, []]) {
      expect(parseClineBalanceResponse(value).error, String(value)).toBeDefined()
    }
  })
})

describe('toClineCreditBalance', () => {
  it('按 CLINE_BALANCE_SCALE 换算为积分口径', () => {
    const balance = toClineCreditBalance(500000)
    expect(balance.total).toBe(500000 / CLINE_BALANCE_SCALE)
    expect(balance.total).toBe(5)
  })

  it('产出 UI 契约要求的 {total, packages, expiredTotal} 形状', () => {
    // plugin-src/client/jet-hub.js 的 CreditBalanceRow 直接读这三个字段；
    // 缺 packages 会让 tooltip 明细为空，缺 expiredTotal 会让 `> 0` 判定报错。
    const balance = toClineCreditBalance(500000)
    expect(balance).toHaveProperty('total')
    expect(balance).toHaveProperty('packages')
    expect(balance).toHaveProperty('expiredTotal')
    expect(balance.expiredTotal).toBe(0)
    expect(balance.packages).toHaveLength(1)
    expect(balance.packages[0]!.active).toBe(true)
    expect(balance.packages[0]!.remaining).toBe(balance.total)
  })

  it('换算系数是唯一的（改单位只需改这一个常量）', () => {
    expect(CLINE_BALANCE_SCALE).toBe(100_000)
  })
})

describe('fetchClineCreditBalance', () => {
  it('用 account_id 拼 URL（不是 JWT 的 sub）', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify(BALANCE_FIXTURE), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchClineCreditBalance(CRED, CLINE, fetcher)
    expect(calls[0]).toBe(
      'https://api.cline.bot/api/v1/users/usr-01M3BCV4FYCGJKAWD3MJG3DBQM/balance',
    )
    expect(result.rawBalance).toBe(500000)
    expect(result.balance?.total).toBe(5)
  })

  it('鉴权头保留 workos: 前缀（剥掉即 401）', async () => {
    const headers: Record<string, string>[] = []
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>)
      return new Response(JSON.stringify(BALANCE_FIXTURE), { status: 200 })
    }) as unknown as typeof fetch

    await fetchClineCreditBalance(CRED, CLINE, fetcher)
    expect(headers[0]!.Authorization).toBe('Bearer workos:eyJhbGciOiJSUzI1NiIs')
    expect(headers[0]!['X-CLIENT-TYPE']).toBe('cline-sdk')
  })

  it('缺 account_id 时给出可操作的原因（不发请求）', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const result = await fetchClineCreditBalance({ access_token: 'workos:a' }, CLINE, fetcher)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('凭据缺少账号 id')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('401 时带上 HTTP 状态码与服务端文案（而不是笼统的「查询失败」）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.",
    }), { status: 401 })) as unknown as typeof fetch

    const result = await fetchClineCreditBalance(CRED, CLINE, fetcher)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('HTTP 401')
    expect(result.error).toContain('Unauthorized')
  })

  it('网络失败不抛错，返回带原因的空结果', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await fetchClineCreditBalance(CRED, CLINE, fetcher)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('网络失败')
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('响应不是 JSON 时给出可读原因', async () => {
    const fetcher = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    const result = await fetchClineCreditBalance(CRED, CLINE, fetcher)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('不是 JSON')
  })

  /**
   * ⚠️ 查不到**不能显示成 0**：0 是「已用光」的语义，会把「凭据失效」误导成
   * 「余额为零」。与其余五个 provider 同约定。
   */
  it('查不到时返回 null 而非 0', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })) as unknown as typeof fetch
    const result = await fetchClineCreditBalance(CRED, CLINE, fetcher)
    expect(result.balance).toBeNull()
    expect(result.balance).not.toBe(0)
  })
})
