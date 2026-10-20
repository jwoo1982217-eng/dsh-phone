/**
 * LobsterAI e2e 探针：**真实执行每日签到领取**。
 *
 * ⚠️ **会改动账号当日签到状态**（但**不消耗模型积分** —— 签到走的是
 * `client-activities` 接口，与 chat/completions 无关）。
 * 重复运行是幂等的：第二步 `context` 会返回 `claimedToday: true`，
 * 探针据此报 `already-claimed` 而不再发领取请求。
 *
 * 闸门需要**两个**环境变量（与 `workbuddy-claim-probe.e2e.spec.ts` 同款）：
 * - `DSH_LOBSTERAI_E2E=1` —— 总开关；
 * - `DSH_LOBSTERAI_CLAIM_E2E_CONFIRM=yes` —— 二次确认，防止误跑改动真实状态。
 *
 * 只设其一都会整体 skip，不产生任何网络调用。
 */

import { describe, expect, it } from 'vitest'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { claimLobsteraiDailyCheckin } from '../../src/lobsterai-credits.js'
import { LobsteraiClientVersionResolver } from '../../src/lobsterai.js'
import { readLobsteraiCredentialsFromDshStore } from './lobsterai-credential.js'

const enabled = process.env.DSH_LOBSTERAI_E2E === '1'
  && process.env.DSH_LOBSTERAI_CLAIM_E2E_CONFIRM === 'yes'
const describeGate = enabled ? describe : describe.skip

describeGate('LobsterAI 每日签到领取探针（会改动当日签到状态）', () => {
  const credentials = readLobsteraiCredentialsFromDshStore()

  it('至少有一个已登录的 LobsterAI 账号', () => {
    expect(
      credentials.length,
      '未找到 LobsterAI 凭据。请先在 Jet Hub 的 LobsterAI 面板登录一个账号。',
    ).toBeGreaterThan(0)
  })

  it('逐账号执行签到（顺序，单账号失败不影响其他）', async () => {
    const resolver = new LobsteraiClientVersionResolver()
    const { version } = await resolver.resolve(LOBSTERAI)

    const outcomes: Array<{ uid: string; kind: string; detail: string }> = []
    for (const { uid, credential } of credentials) {
      const outcome = await claimLobsteraiDailyCheckin(credential, LOBSTERAI, version)
      switch (outcome.kind) {
        case 'claimed':
          outcomes.push({
            uid, kind: outcome.kind,
            detail: `+${outcome.credit} 积分${outcome.delayedMessage ? `（${outcome.delayedMessage}）` : ''}`,
          })
          break
        case 'already-claimed':
          outcomes.push({ uid, kind: outcome.kind, detail: outcome.message })
          break
        case 'inactive':
          outcomes.push({ uid, kind: outcome.kind, detail: outcome.message })
          break
        case 'failed':
          outcomes.push({ uid, kind: outcome.kind, detail: `code=${outcome.code} ${outcome.message}` })
          break
      }
      // eslint-disable-next-line no-console
      console.log(`[lobsterai-e2e-claim] ${uid}: ${outcome.kind} — ${outcomes.at(-1)!.detail}`)
    }

    expect(outcomes.length).toBe(credentials.length)
    // 四种结果都是**合法业务状态**（活动未开、今天已领都正常），
    // 故这里不断言具体 kind，只要求每账号都得到了明确结论。
    for (const outcome of outcomes) {
      expect(['claimed', 'already-claimed', 'inactive', 'failed']).toContain(outcome.kind)
    }
    // 汇总打印便于人工判读。
    // eslint-disable-next-line no-console
    console.log('[lobsterai-e2e-claim] 汇总:', JSON.stringify(outcomes, null, 2))
  })

  it('重复签到是幂等的（第二次报 already-claimed 或 inactive）', async () => {
    const resolver = new LobsteraiClientVersionResolver()
    const { version } = await resolver.resolve(LOBSTERAI)
    for (const { uid, credential } of credentials) {
      // 上一个用例刚领过；这里再领一次应当被识别为「今天已签到」，
      // 而不是重复发放或报错。
      const outcome = await claimLobsteraiDailyCheckin(credential, LOBSTERAI, version)
      expect(['already-claimed', 'inactive'], uid).toContain(outcome.kind)
    }
  })
})
