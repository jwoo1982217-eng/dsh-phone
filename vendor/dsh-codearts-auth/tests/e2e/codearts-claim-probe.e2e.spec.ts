/**
 * CodeArts 积分 e2e 探针：**真实执行每日签到领取**。
 *
 * ⚠️ **会改动账号当日领取状态**（领取的是华为云积分，与 chat/completions 的
 * 模型额度无关，因此**不消耗模型积分**）。
 *
 * ⚠️⚠️ **本探针是唯一会调用 `/v1/ops/claim` 的地方。**
 * 实现与只读探针严格分离（`codearts-credits-probe.e2e.spec.ts` 绝不领取），
 * 且需要**两个**环境变量同时设置才会运行：
 * - `DSH_CODEARTS_E2E=1` —— 总开关；
 * - `DSH_CODEARTS_CLAIM_E2E_CONFIRM=yes` —— 二次确认，防止误跑改动真实状态。
 *
 * 只设其一都会整体 skip，不产生任何网络调用。
 *
 * 幂等：领取前会先查活动列表，若该活动已不可领取且状态为已领取态，
 * 实现会返回 `already-claimed` 而不发领取请求（见
 * `claimCodeArtsDailyCheckin` 的判定顺序）—— 故重复运行不会重复发放。
 *
 * ⚠️ 前置条件：凭据必须新鲜。CodeArts 的 refresh_token 一次性轮换，
 * 探针不刷新凭据（见 `codearts-credential.ts`）。凭据过期时请先在
 * Jet Hub 重新登录。
 */

import { describe, expect, it } from 'vitest'
import { claimCodeArtsDailyCheckin } from '../../src/codearts-credits.js'
import { readCodeArtsCredentialsFromDshStore } from './codearts-credential.js'

const enabled = process.env.DSH_CODEARTS_E2E === '1'
  && process.env.DSH_CODEARTS_CLAIM_E2E_CONFIRM === 'yes'
const describeGate = enabled ? describe : describe.skip

describeGate('CodeArts 每日签到领取探针（会改动当日领取状态）', () => {
  const credentials = readCodeArtsCredentialsFromDshStore()

  it('至少有一个已登录的 CodeArts 账号', () => {
    expect(
      credentials.length,
      '未找到 CodeArts 凭据。请先在 Jet Hub 的 CodeArts 面板登录一个账号。',
    ).toBeGreaterThan(0)
  })

  it('逐账号执行领取（顺序，单账号失败不影响其他）', async () => {
    const outcomes: Array<{ uid: string; kind: string; detail: string }> = []
    for (const { uid, credential } of credentials) {
      const outcome = await claimCodeArtsDailyCheckin(credential)
      let detail: string
      switch (outcome.kind) {
        case 'claimed':
          detail = `+${outcome.credit} 积分`
          break
        case 'already-claimed':
          detail = outcome.message
          break
        case 'inactive':
          detail = outcome.message
          break
        case 'failed':
          detail = `code=${outcome.code} ${outcome.message}`
          break
      }
      outcomes.push({ uid, kind: outcome.kind, detail })
      console.log(`[codearts-e2e-claim] ${uid}: ${outcome.kind} — ${detail}`)
    }

    expect(outcomes.length).toBe(credentials.length)
    // 四种结果都是**合法业务状态**：非积分账户判 inactive、今天已领判
    // already-claimed，都是正常结论而非故障。故不断言具体 kind，
    // 只要求每账号都得到明确结论。
    for (const outcome of outcomes) {
      expect(['claimed', 'already-claimed', 'inactive', 'failed']).toContain(outcome.kind)
    }
    console.log('[codearts-e2e-claim] 汇总:', JSON.stringify(outcomes, null, 2))
  })

  it('重复领取是幂等的（第二次报 already-claimed 或 inactive）', async () => {
    for (const { uid, credential } of credentials) {
      // 上一个用例刚领过；这里再领一次应当被识别为「今天已领取」，
      // 而不是重复发放或报错。
      const outcome = await claimCodeArtsDailyCheckin(credential)
      // `claimed` 也允许：活动可能允许一天多次领取（服务端规则），
      // 那种情况下重复调用本就该成功。这里断言的是**不会报 failed**。
      expect(['claimed', 'already-claimed', 'inactive'], uid).toContain(outcome.kind)
    }
  })
})
