/**
 * WorkBuddy 签到领取探针。
 *
 * ⚠️ 本用例会真实调用签到接口，**改动账号的当日签到状态**（领了今天就没了）。
 *
 * 用途：验证状态查询与领取的完整闭环，并打印每步原始响应，便于排查
 * 服务端字段变动。需要真实凭据。
 *
 * 双重闸门（缺一不可，防止误跑）：
 *   DSH_WORKBUDDY_CLAIM_E2E=1
 *   DSH_WORKBUDDY_CLAIM_E2E_CONFIRM=yes
 *
 * 用 `pnpm test:e2e:workbuddy-claim` 运行（两个变量已内置）。
 * 凭据来源：环境变量 DSH_WORKBUDDY_CREDENTIAL_JSON，或本地
 * ~/.dsh/.credentials.yaml 中的 WORKBUDDY_ACCOUNT_* 条目。
 */
import { describe, expect, it } from 'vitest'
import { claimDailyCheckin, fetchCheckinStatus } from '../../src/credits.js'
import { WORKBUDDY } from '../../src/product.js'
import { loadWorkBuddyCredential } from './workbuddy-credential.js'

const RUN = process.env.DSH_WORKBUDDY_CLAIM_E2E === '1'
  && process.env.DSH_WORKBUDDY_CLAIM_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

suite('WorkBuddy 签到领取探针', () => {
  it('查询状态 → 领取 → 复查状态', async () => {
    // 解析失败会抛出带 ref 名 / 文件路径的清晰中文错误（YAML 折行已还原）。
    const credential = loadWorkBuddyCredential()
    console.log('\n===== 凭据 =====')
    console.log(`  nickname   = ${JSON.stringify(credential.nickname)}`)
    console.log(`  user_id    = ${JSON.stringify(credential.user_id)}`)
    console.log(`  has access = ${credential.access_token.length > 0}`)

    console.log('\n===== 1. 领取前状态 =====')
    const before = await fetchCheckinStatus(credential, WORKBUDDY)
    console.log('  ', JSON.stringify(before, null, 2))
    expect(before).not.toBeNull()

    console.log('\n===== 2. 执行领取 =====')
    const outcome = await claimDailyCheckin(credential, WORKBUDDY)
    console.log('  ', JSON.stringify(outcome))
    // 今日已领取是合法结果（幂等），不应视为失败
    expect(['claimed', 'already-claimed', 'inactive']).toContain(outcome.kind)

    console.log('\n===== 3. 领取后状态 =====')
    const after = await fetchCheckinStatus(credential, WORKBUDDY)
    console.log('  ', JSON.stringify(after, null, 2))
    expect(after).not.toBeNull()

    if (outcome.kind === 'claimed') {
      // 领取成功后状态必须翻转
      expect(after!.todayCheckedIn).toBe(true)
      expect(after!.todayCredit).toBeGreaterThan(0)
    }

    console.log('\n===== 摘要 =====')
    console.log(`  领取结果   : ${outcome.kind}`)
    console.log(`  今日已签到 : ${String(after!.todayCheckedIn)}`)
    console.log(`  连续天数   : ${after!.streakDays}`)
    console.log(`  活动名     : ${after!.activityName}`)
    console.log(`  累计积分   : ${after!.totalCredits}`)
  }, 120_000)
})
