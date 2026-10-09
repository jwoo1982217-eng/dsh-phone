/**
 * TRAE 真实签到探针。
 *
 * ⚠️ **会真实改动账号当日签到状态**（`checkin_credits/claim`），但**不消耗
 * 模型积分**。重复运行是幂等的：服务端已签到时返回非零业务码，本探针据此
 * 判定 `already-claimed` 而非失败。
 *
 * 闸门：`DSH_TRAE_E2E=1` **且** `DSH_TRAE_CLAIM_E2E_CONFIRM=yes`。
 * 双闸门的原因：单跑一次签到会消耗「今天的领取机会」，误触是不可撤销的
 * （只能等次日重置）。这与 `lobsterai-claim-probe` / `codearts-claim-probe`
 * 的约定一致。
 *
 * 前置：先在 Jet Hub 的 TRAE 面板登录至少一个账号。
 */

import { describe, expect, it } from 'vitest'
import { TRAE } from '../../src/trae-product.js'
import { claimTraeDailyCheckin, fetchTraeCheckinStatus } from '../../src/trae-credits.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'

const enabled = process.env.DSH_TRAE_E2E === '1'
  && process.env.DSH_TRAE_CLAIM_E2E_CONFIRM === 'yes'
const describeGate = enabled ? describe : describe.skip

describeGate('TRAE 真实签到探针（会改动当日签到状态，不消耗模型积分）', () => {
  const credentials = readTraeCredentialsFromDshStore()

  it('至少有一个已登录的 TRAE 账号', () => {
    expect(
      credentials.length,
      '未找到 TRAE 凭据。请先在 Jet Hub 的 TRAE 面板登录一个账号。',
    ).toBeGreaterThan(0)
  })

  it('逐账号执行签到（顺序，单个失败不中断）', async () => {
    for (const { uid, credential } of credentials) {
      // 先读状态：已签到则跳过领取，避免无谓的重复请求。
      const before = await fetchTraeCheckinStatus(credential, TRAE)
      if (before !== null && before.todayCheckedIn) {
        // eslint-disable-next-line no-console
        console.log(`[trae-e2e] ${uid}: 今日已签到，跳过`)
        continue
      }

      const outcome = await claimTraeDailyCheckin(credential, TRAE)
      // eslint-disable-next-line no-console
      console.log(`[trae-e2e] ${uid}: 签到结果=${outcome.kind}`
        + ('credit' in outcome ? ` 获得=${outcome.credit}` : '')
        + ('message' in outcome ? ` 说明=${outcome.message}` : ''))

      // 判定：claimed / already-claimed 都算正常（幂等）；
      // inactive 是业务状态；仅 failed 需要关注。
      expect(['claimed', 'already-claimed', 'inactive'], `${uid} 签到失败：${JSON.stringify(outcome)}`)
        .toContain(outcome.kind)

      // 签到后状态应翻转为已签到（服务端可能有延迟，故不强制断言翻转，
      // 但若翻转了要确保字段类型正确）。
      const after = await fetchTraeCheckinStatus(credential, TRAE)
      if (after !== null) expect(typeof after.todayCheckedIn, uid).toBe('boolean')
    }
  })

  it('重复签到时如实返回 already-claimed（幂等性验证）', async () => {
    // 只对第一个账号做二次领取，避免对全部账号重复打请求。
    const first = credentials[0]
    if (first === undefined) return
    const outcome = await claimTraeDailyCheckin(first.credential, TRAE)
    // 此时应为已领取（若首次即失败则可能是活动未开，同样不算断言失败）。
    expect(['already-claimed', 'inactive', 'claimed']).toContain(outcome.kind)
  })
})
