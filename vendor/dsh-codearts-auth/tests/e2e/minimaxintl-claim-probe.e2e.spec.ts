/**
 * MiniMax Code **国际版**「真实领取」E2E 探针。
 *
 * ⚠️⚠️ **本探针会真实调用 `POST /minimax-cloud/api/v1/signin/claim`，消耗账号
 * 当天唯一一次领取机会**。故与只读探针（`minimaxintl-probe.e2e.spec.ts`）**分离**，
 * 且默认关闭、需**双闸门**：
 *
 * ```
 * DSH_MINIMAXINTL_E2E=1                          # 与只读探针共用的总闸门
 * DSH_MINIMAXINTL_CLAIM_E2E_CONFIRM=yes          # 本文件独有的二次确认
 * ```
 *
 * 用 `pnpm test:e2e:minimaxintl-claim` 运行。
 *
 * ## 幂等与「绝不虚报成功」
 *
 * - 先查状态：`todayCheckedIn === true` ⇒ **跳过 claim 调用**（不消耗机会），
 *   这与国内站探针同款，且是「今天已领」的**唯一可靠判据**；
 * - `claim_result` 是幂等判据（`1` = 真领取、`2` = 已领过），**不是** HTTP 状态码
 *   （重复领取同样 200）；
 * - `failed` / `inactive` 一律如实报出，**绝不**把「没领到」说成成功。
 *
 * ⚠️ 凭据读**插件自己**的 `MINIMAXINTL_*`（国际站没有本机客户端可读）。
 * ⚠️ 绝不打印 token。
 */
import { describe, expect, it } from 'vitest'
import {
  claimMinimaxDailyCheckin,
  fetchMinimaxCreditBalance,
  fetchMinimaxSigninStatus,
} from '../../src/minimax-credits.js'
import { MINIMAX_INTL } from '../../src/minimax-product.js'
import { readMinimaxPluginCredential } from './minimax-credential.js'

const enabled = process.env.DSH_MINIMAXINTL_E2E === '1'
  && process.env.DSH_MINIMAXINTL_CLAIM_E2E_CONFIRM === 'yes'
const describeIf = enabled ? describe : describe.skip

describeIf('MiniMax 国际版领取探针（⚠️ 真实领取，消耗当天机会）', () => {
  const probe = enabled ? readMinimaxPluginCredential({ refPrefix: 'MINIMAXINTL' }) : undefined
  const credential = probe?.credential

  it('本机存在插件存的国际站凭据', () => {
    expect(
      probe,
      '未找到 MINIMAXINTL_* 凭据 —— 请先在 Jet Hub 的「MiniMax Code (国际版)」'
      + '面板登录一个账号。',
    ).toBeDefined()
    console.log(`[minimaxintl-claim] 插件凭据：${probe!.describe}`)
    expect(credential?.access_token).toBeTruthy()
  })

  it('先查状态；已领则跳过（不消耗机会）', async (ctx) => {
    if (probe?.expired !== false) {
      console.log('[minimaxintl-claim] 凭据已过期，跳过领取'
        + '（请在 Jet Hub 面板点该账号的「刷新」续期后重跑）。')
      ctx.skip()
    }
    const before = await fetchMinimaxSigninStatus(credential!, undefined, MINIMAX_INTL)
    if (before === null) {
      console.log('[minimaxintl-claim] ⚠️ 签到状态读到 null —— 请先确认凭据有效；'
        + '该端点形态**已实测可用**（2026-10-15 真机验证），读到 null 多半是凭据失效'
        + '或上游故障，而不是「端点形状不同」。**本次不执行 claim**（避免白烧当天机会）。')
      return
    }
    console.log(`[minimaxintl-claim] 领取前：今日已领=${before.todayCheckedIn}`
      + ` 连续=${before.streakDays}`)
    if (before.todayCheckedIn) {
      console.log('[minimaxintl-claim] 今日已领取，跳过 claim 调用（状态先行；不消耗机会）。')
      return
    }

    const balanceBefore = await fetchMinimaxCreditBalance(credential!, undefined, MINIMAX_INTL)
    console.log(`[minimaxintl-claim] 领取前余额：${balanceBefore?.total ?? 'null'}`)

    const outcome = await claimMinimaxDailyCheckin(credential!, undefined, MINIMAX_INTL)
    switch (outcome.kind) {
      case 'claimed':
        console.log(`[minimaxintl-claim] claimed — +${outcome.credit} 积分`
          + `（连续 ${outcome.streakDays} 天）`)
        break
      case 'already-claimed':
        console.log(`[minimaxintl-claim] already-claimed — ${outcome.message}（幂等，符合预期）`)
        break
      case 'inactive':
        console.log(`[minimaxintl-claim] inactive — ${outcome.message}`)
        break
      default:
        console.log(`[minimaxintl-claim] failed — code=${outcome.code} ${outcome.message}`)
        break
    }
    // ⚠️ 判据是「拿到了一个可解读的 outcome」，不是「一定 claimed」——
    //    已领 / 活动未开都是**合法结果**。真正的失败（failed）已打印原因。
    expect(['claimed', 'already-claimed', 'inactive']).toContain(outcome.kind)

    const after = await fetchMinimaxSigninStatus(credential!, undefined, MINIMAX_INTL)
    console.log(`[minimaxintl-claim] 领取后：今日已领=${after?.todayCheckedIn}`)
    const balanceAfter = await fetchMinimaxCreditBalance(credential!, undefined, MINIMAX_INTL)
    console.log(`[minimaxintl-claim] 领取后余额：${balanceAfter?.total ?? 'null'}`)
  })
})
