/**
 * AStudio 「一键领取积分」为什么总说「今天已领取」—— 判据字段的守卫
 * （2026-10-20 用户报障，真机取证）
 *
 * ## 缺陷与取证
 *
 * 用户症状：AStudio 客户端里明明写着「限时每日福利 · 今日可领 100 积分」（**未领**），
 * 插件点「一键领取积分」却说**已领过**、分数不动（1100）。
 *
 * 只读探针（`tests/e2e/astudio-popups-probe.e2e.spec.ts`）实测到的 `pending` 响应：
 * ```json
 * { "flag": true, "code": 0, "desc": "成功",
 *   "data": [{ "popupId": 3, "popupCode": "DAILY_LOGIN_REWARD_V1", "popupType": "BANNER",
 *              "componentType": "DAILY_REWARD_DIALOG", "priority": 100,
 *              "instanceKey": "…", "payload": { "confirmText": "…", "title": "…", "content": "…" } }] }
 * ```
 * ⇒ **弹窗类型在 `componentType` 上，响应里根本没有 `type` 键**；而原实现读 `record.type`
 *   ⇒ `String(record.type ?? '')` 恒 `''` ⇒ 识别不出任何可领弹窗 ⇒ 走 `already-claimed`
 *   ⇒ 「今天已领取」而积分不动。
 *
 * ⚠️ 判据打在**行为**上：走真实 `claimDaily`，断言它**真的**去 POST 了 `complete`
 *    （只断言 `kind` 不变红是不够的 —— 「识别到了但没领」同样会让积分不动）。
 */
import { describe, expect, it, vi } from 'vitest'
import { claimDaily } from '../../src/astudio-credits.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import type { AstudioCredential } from '../../src/astudio.js'

const CRED = { sso_session_id: 'sso-x', account_id: 'acct-x', token: 'tok-x' } as AstudioCredential

/** 固定的实测 `pending` 形状（无 `type` 键，类型在 `componentType` 上）。 */
const PENDING_MEASURED = {
  flag: true,
  code: 0,
  desc: '成功',
  count: null,
  data: [{
    popupId: 3,
    popupCode: 'DAILY_LOGIN_REWARD_V1',
    popupType: 'BANNER',
    componentType: 'DAILY_REWARD_DIALOG',
    priority: 100,
    instanceKey: 'abcdefgh',
    payload: { confirmText: '领取', title: '限时每日福利', content: '今日可领100积分' },
  }],
  traceId: 'trace-x',
}

/** 按 URL 分派的假 fetcher；记录所有请求 URL。 */
function makeFetcher(pending: unknown, complete: unknown = { flag: true, code: 0, desc: '成功', data: null }) {
  const urls: string[] = []
  const fetcher = vi.fn(async (url: unknown) => {
    const u = String(url)
    urls.push(u)
    const body = u.includes('/client-popups/complete') ? complete : pending
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, urls }
}

describe('★★ 领取判据必须读**真实字段** `componentType`（修前读不存在的 `type`）', () => {
  it('★★ 实测形状（有 componentType、无 type）⇒ 必须识别并**真的发起**领取', async () => {
    const { fetcher, urls } = makeFetcher(PENDING_MEASURED)
    const outcome = await claimDaily(CRED, { fetcher, product: ASTUDIO })
    expect(
      outcome.kind,
      '实测形状必须被识别为「有可领弹窗」—— 判 already-claimed 就是修前那个 bug',
    ).not.toBe('already-claimed')
    expect(
      urls.some((u) => u.includes('/client-popups/complete')),
      '★ 必须真的 POST 了 complete（只断言 kind 不够：「识别到了却没领」同样让积分不动）',
    ).toBe(true)
  })

  it('★ 反向兼容：旧形态（只有 `type`）仍必须被识别 —— 不得改成只认 componentType', async () => {
    const legacy = {
      flag: true, code: 0, desc: '成功', count: null, traceId: 't',
      data: [{
        popupId: 7, instanceKey: 'ijklmnop', type: 'DAILY_REWARD_DIALOG',
        payload: { title: '限时每日福利' },
      }],
    }
    const { fetcher, urls } = makeFetcher(legacy)
    const outcome = await claimDaily(CRED, { fetcher, product: ASTUDIO })
    expect(outcome.kind).not.toBe('already-claimed')
    expect(urls.some((u) => u.includes('/client-popups/complete'))).toBe(true)
  })

  it('⚠️ 反向：data 为空数组 ⇒ 必须判 already-claimed（别把「真没有」也当成可领）', async () => {
    const empty = { flag: true, code: 0, desc: '成功', count: null, data: [], traceId: 't' }
    const { fetcher, urls } = makeFetcher(empty)
    const outcome = await claimDaily(CRED, { fetcher, product: ASTUDIO })
    expect(outcome.kind).toBe('already-claimed')
    expect(
      urls.some((u) => u.includes('/client-popups/complete')),
      '没有可领弹窗时**不得**发领取请求',
    ).toBe(false)
  })

  it('⚠️ 反向：类型不认识（如 `SOME_OTHER_DIALOG`）⇒ 不得当成可领', async () => {
    const other = {
      flag: true, code: 0, desc: '成功', count: null, traceId: 't',
      data: [{ popupId: 9, instanceKey: 'zzzzzzzz', componentType: 'SOME_OTHER_DIALOG' }],
    }
    const { fetcher, urls } = makeFetcher(other)
    const outcome = await claimDaily(CRED, { fetcher, product: ASTUDIO })
    expect(outcome.kind).toBe('already-claimed')
    expect(urls.some((u) => u.includes('/client-popups/complete'))).toBe(false)
  })
})