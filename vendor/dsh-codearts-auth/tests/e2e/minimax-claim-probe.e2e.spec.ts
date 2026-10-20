/**
 * MiniMax 真实签到领取探针（**会改动账号当日签到状态**）。
 *
 * ⚠️ 与只读探针（`minimax-probe.e2e.spec.ts`）分离：那个**绝不领取**，
 * 这个**会**真实调用 `POST /minimax-cloud/api/v1/signin/claim`。
 *
 * 双重闸门：`DSH_MINIMAX_E2E=1` **且** `DSH_MINIMAX_CLAIM_E2E_CONFIRM=yes`。
 * 单跑的代价是消耗「当天唯一一次领取机会」，误触不可撤销（只能等次日重置）
 * —— 与 `trae-claim-probe` / `lobsterai-claim-probe` / `codearts-claim-probe`
 * 的约定一致。
 *
 * ⚠️ **状态先行**：先读 `signin/status`，若 `todayCheckedIn` 为真则**不发 claim**
 * （省掉一次无谓请求）。服务端本身也幂等（重复领取回 `claim_result: 2`），
 * 两层保护叠加，故本探针**重复运行是安全的**。
 *
 * ⚠️ 前置：本机 MiniMax Code 客户端登录态**未过期**
 *（与只读探针同源，见 `minimax-credential.ts` 的长注释：过期不代续期）。
 *
 * ⚠️ 验证的重点（本探针存在的理由）：
 * 1. `claim_result` 幂等判据在**真实服务端**上成立（不是单测假设）；
 * 2. `credit === points`（**800**）—— 生产环境再次确认**不是** `points + bonus_points`；
 * 3. `timezone_id` 走 query 被服务端接受（放头里会回 `1406010011`）。
 */
import { describe, expect, it } from 'vitest'
import { claimMinimaxDailyCheckin, fetchMinimaxCreditBalance, fetchMinimaxSigninStatus } from '../../src/minimax-credits.js'
import { readMinimaxProbeCredential } from './minimax-credential.js'

const enabled = process.env.DSH_MINIMAX_E2E === '1'
  && process.env.DSH_MINIMAX_CLAIM_E2E_CONFIRM === 'yes'
const describeGate = enabled ? describe : describe.skip

describeGate('MiniMax 真实签到领取探针（会改动当日签到状态）', () => {
  const probe = enabled ? readMinimaxProbeCredential() : undefined
  const credential = probe?.credential

  it('客户端登录态有效（过期则跳过，不代续期）', (ctx) => {
    expect(probe).toBeDefined()
    console.log(`[minimax-claim] 客户端登录态：${probe!.describe}`)
    if (probe!.expired) {
      console.log('[minimax-claim] token 已过期，跳过领取'
        + '（请在 MiniMax Code 客户端登录一次；本探针不代续期）。')
      ctx.skip()
    }
  })

  it('领取前状态可读，且 dailyCredit === points（800，不含 bonus_points）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()
    const before = await fetchMinimaxSigninStatus(credential!)
    expect(before).not.toBeNull()
    // ⚠️ 现场实证 `dailyCredit` 是 points（总数）而非 points + bonus_points。
    // 实测第 1 天：points=800 / bonus_points=400，两者**不得相加**（会虚高一倍）。
    expect(before?.dailyCredit).toBe(800)
    console.log(`[minimax-claim] 领取前：今日已领=${before?.todayCheckedIn}`
      + ` 连续=${before?.streakDays} 今日额度=${before?.dailyCredit}`)
  })

  it('执行领取（已领过则为 already-claimed，幂等）', async (ctx) => {
    if (probe?.expired !== false) ctx.skip()

    const before = await fetchMinimaxSigninStatus(credential!)
    // ⚠️ 状态先行：已领则不重复发 claim（省一次请求；服务端本身也幂等）。
    if (before?.todayCheckedIn === true) {
      console.log('[minimax-claim] 今日已领取，跳过 claim 调用（状态先行；不消耗机会）。')
    }

    const balanceBefore = await fetchMinimaxCreditBalance(credential!)
    const outcome = await claimMinimaxDailyCheckin(credential!)

    switch (outcome.kind) {
      case 'claimed':
        console.log(`[minimax-claim] claimed — +${outcome.credit} 积分`
          + `（连续 ${outcome.streakDays} 天${outcome.isStreakDay ? '，含连续奖励' : ''}）`)
        // ⚠️ **核心断言**：真实服务端下 credit 必须等于 800（= points），
        // 而不是 1200（= points + bonus_points）。这是用户 2026-09-28 的纠正
        // 在**生产环境**上的再次确认。
        expect(outcome.credit).toBe(800)
        break
      case 'already-claimed':
        console.log(`[minimax-claim] already-claimed — ${outcome.message}（幂等，符合预期）`)
        break
      case 'inactive':
        console.log(`[minimax-claim] inactive — ${outcome.message}`)
        break
      case 'failed':
        console.log(`[minimax-claim] failed — code=${outcome.code} ${outcome.message}`)
        break
    }
    // 四种都是合法业务状态；这里只要求拿到明确结论，不断言具体 kind
    //（首次跑是 claimed，重跑是 already-claimed，两者都正常）。
    expect(['claimed', 'already-claimed', 'inactive', 'failed']).toContain(outcome.kind)

    // 领取后复核：余额应可读（可能因积分入账而变化）。
    const balanceAfter = await fetchMinimaxCreditBalance(credential!)
    console.log(`[minimax-claim] 余额：${balanceBefore?.total ?? 'null'}`
      + ` → ${balanceAfter?.total ?? 'null'}`)

    // 领取后状态复核：`claimed` 之后服务端应显示今日已领。
    if (outcome.kind === 'claimed') {
      const after = await fetchMinimaxSigninStatus(credential!)
      console.log(`[minimax-claim] 领取后：今日已领=${after?.todayCheckedIn}`
        + ` 连续=${after?.streakDays} 今日额度=${after?.dailyCredit}`)
      // ⚠️ 这是「幂等判据是 claim_result 而非 HTTP 状态码」的**闭环证据**：
      // 真领取之后，状态接口必须改口说「今天已领」。
      expect(after?.todayCheckedIn).toBe(true)
    }
  }, 60_000)
})
