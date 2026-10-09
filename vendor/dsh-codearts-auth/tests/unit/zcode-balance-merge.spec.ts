/**
 * 余额展示：`balances` 为空但 `preview` 有 plan 时，仍要显示出额度。
 *
 * ## 为什么必须合（2026-10-03 实测）
 *
 * 同一账号、同一凭据：
 * ```
 * GET /api/v1/zcode-plan/billing/balance  → 200，data.balances = []      （0 个桶）
 * GET /api/v1/zcode-plan/billing/preview → 200，data.plans[0].plan_id
 *                                                = zcode-v3-start-plan-trust-1003
 * ```
 * ⇒ **每日赠送的 start-plan 额度不在 `balances` 桶里**，只在 `preview/plans` 里。
 * 只读 `balances` ⇒ Jet Hub 面板显示「Token 0.00M」，而用户实际能领 1 亿 tokens
 * —— 表现为"明明能领，插件却说没额度"。
 *
 * ⚠ 这不是 coding-plan 引入的问题（`start-plan` 就这样），
 *   但本设计要支持国际版账号（其 start-plan 同样是这个形态）⇒ 必须合。
 */
import { describe, expect, it } from 'vitest'
import { fetchZcodeBalance } from '../../src/zcode-upstream.js'
import type { ZcodeCredential } from '../../src/zcode.js'

const CRED = {
  zcode_jwt: 'jwt',
  device_mid: 'mid',
  app_version: '3.14.4',
} as ZcodeCredential

/** 按 URL 片段分派响应（顺序 = 实际调用顺序：balance → preview）。 */
function stubFetch(balanceBody: unknown, previewBody: unknown) {
  return (async (url: string) => {
    const body = String(url).includes('/preview') ? previewBody : balanceBody
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

describe('fetchZcodeBalance 合并 preview', () => {
  it('★ balances 空 + preview 有 plan ⇒ 仍带出 claimablePlans', async () => {
    const r = await fetchZcodeBalance(CRED, stubFetch(
      { code: 0, data: { balances: [] } },
      { code: 0, data: { plans: [{ plan_id: 'start-plan-x', name: 'GLM-5.3-Flash', priority: 1 }] } },
    ))
    expect(r?.claimablePlans?.length).toBe(1)
    expect(r?.claimablePlans?.[0]?.planId).toBe('start-plan-x')
    expect(r?.claimablePlans?.[0]?.showName).toBe('GLM-5.3-Flash')
  })

  it('★ 两边都空 ⇒ claimablePlans 为空数组（不抛错）', async () => {
    const r = await fetchZcodeBalance(CRED, stubFetch(
      { code: 0, data: { balances: [] } },
      { code: 0, data: { plans: [] } },
    ))
    expect(r?.claimablePlans).toEqual([])
  })

  it('★ ★ preview 失败**不影响** balance 的正常返回（余额仍照常）', async () => {
    const r = await fetchZcodeBalance(CRED, (async (url: string) => {
      if (String(url).includes('/preview')) return new Response('', { status: 500 })
      return new Response(JSON.stringify({
        code: 0,
        // ⚠ 断言 `remaining` 时必须给 `remaining_units`：实现是
        //   `available_units ?? remaining_units ?? 0`，**不是** `total - used`
        //   （上游给什么就是什么；第一版测试数据漏了它，期望 4 实际 0）。
        data: {
          balances: [{
            total_units: 5,
            used_units: 1,
            remaining_units: 4,
            available_units: 4,
            unit_type: 'token',
          }],
        },
      }), { status: 200 })
    }) as unknown as typeof fetch)
    expect(r?.total).toBe(5)
    expect(r?.remaining).toBe(4)
    expect(r?.claimablePlans).toEqual([])
  })

  it('★ preview 返回非 JSON ⇒ 同样不影响 balance', async () => {
    const r = await fetchZcodeBalance(CRED, (async (url: string) => {
      if (String(url).includes('/preview')) return new Response('not json', { status: 200 })
      return new Response(JSON.stringify({
        code: 0, data: { balances: [{ total_units: 7, used_units: 2, unit_type: 'token' }] },
      }), { status: 200 })
    }) as unknown as typeof fetch)
    expect(r?.total).toBe(7)
    expect(r?.claimablePlans).toEqual([])
  })

  it('★ plans 里缺 plan_id 的条目被跳过（不产半截数据）', async () => {
    const r = await fetchZcodeBalance(CRED, stubFetch(
      { code: 0, data: { balances: [] } },
      { code: 0, data: { plans: [{ name: 'no-id' }, { plan_id: '', name: 'empty' }, { plan_id: 'ok' }] } },
    ))
    expect(r?.claimablePlans?.map((p) => p.planId)).toEqual(['ok'])
  })

  it('★ enterprise 模式不额外发 preview 请求', async () => {
    let previewCalls = 0
    const r = await fetchZcodeBalance(CRED, (async (url: string) => {
      if (String(url).includes('/preview')) { previewCalls += 1; return new Response('{}', { status: 200 }) }
      return new Response(JSON.stringify({ code: 0, data: { displayMode: 'enterprise' } }), { status: 200 })
    }) as unknown as typeof fetch)
    expect(r?.enterprise).toBe(true)
    expect(previewCalls, 'enterprise 提前返回，不该发 preview').toBe(0)
  })
})
