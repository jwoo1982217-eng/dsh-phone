/**
 * MiniMax Code 只读 E2E 探针：模型目录 + 签到状态 + 积分余额。
 *
 * ⚠️ **全链路只读**：
 * - 模型目录 `GET /mavis/api/v1/models`
 * - 签到状态 `GET /minimax-cloud/api/v1/signin/status`
 * - 积分余额 `GET /minimax-cloud/api/v1/credit/details`
 *
 * **不执行 claim**（`POST …/signin/claim`）—— 那会消耗账号当天唯一一次领取机会
 *（与 raccoon / trae 探针同款约束）。
 *
 * ⚠️ 闸门默认关闭：需 `DSH_MINIMAX_E2E=1`（用 `pnpm test:e2e:minimax`）。
 * 未设环境变量时**全部 skipped，不发任何网络请求**。
 *
 * ⚠️ token 不落盘、不打印；日志只出现签到状态与余额数字。
 *
 * ⚠️ **token 过期时的行为**（本机实测确实会过期，约 1 小时寿命）：
 * 三条用例**skip 并打印指引**，而不是失败、也**不代客户端续期**
 *（代续期有弄坏用户客户端登录态的风险 —— 详见 `minimax-credential.ts` 的长注释）。
 */
import { describe, expect, it } from 'vitest'
import { fetchMinimaxCreditBalance, fetchMinimaxSigninStatus } from '../../src/minimax-credits.js'
import { parseMinimaxModelsPayload } from '../../src/minimax-auth.js'
import { MINIMAX, MINIMAX_MODELS_PATH } from '../../src/minimax-product.js'
import { readMinimaxProbeCredential } from './minimax-credential.js'

const enabled = process.env.DSH_MINIMAX_E2E === '1'
const describeIf = enabled ? describe : describe.skip

describeIf('MiniMax 只读探针（不领取、不写任何状态）', () => {
  // ⚠️ 惰性读取：`describe.skip` 时**根本不会执行**到 read（否则无凭据的机器上
  // 会在「收集用例」阶段就抛错，而不是干净地 skip）。
  const probe = enabled ? readMinimaxProbeCredential() : undefined
  const credential = probe?.credential

  it('本机存在 MiniMax Code 登录态', () => {
    expect(probe).toBeDefined()
    // ⚠️ 只打印**有效期状态**，绝不打印 token。
    console.log(`[minimax] 客户端登录态：${probe!.describe}`)
    expect(credential?.access_token).toBeTruthy()
  })

  it('远端模型目录含 4 个模型，且只有 M3.1 有档位', async (ctx) => {
    if (probe?.expired !== false) {
      console.log('[minimax] access token 已过期，跳过网络验证'
        + '（请在 MiniMax Code 客户端登录一次以刷新，本探针不代续期）。')
      ctx.skip()
    }
    const url = new URL(`${MINIMAX.apiHost}${MINIMAX_MODELS_PATH}`)
    url.searchParams.set('region', MINIMAX.region)
    url.searchParams.set('buildEnv', MINIMAX.buildEnv)
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credential!.access_token}`,
        Accept: 'application/json',
      },
    })
    expect(response.ok, `模型目录 HTTP ${response.status}`).toBe(true)
    const models = parseMinimaxModelsPayload(await response.json())
    expect(models.map((m) => m.id)).toEqual([
      'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7',
    ])
    const m31 = models.find((m) => m.id === 'MiniMax-M3.1-Flash-Preview')
    // 只有 M3.1 有档位（其余三个远端不下载 effort_options）。
    expect(m31?.effortOptions).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(m31?.contextWindow).toBe(1_000_000)
    console.log('[minimax] 模型目录：'
      + models.map((m) => `${m.id}(${m.contextWindow / 1000}K)`).join(' / '))
  })

  it('签到状态可读（**不领取**）', async (ctx) => {
    if (probe?.expired !== false) {
      console.log('[minimax] access token 已过期，跳过签到状态验证。')
      ctx.skip()
    }
    const status = await fetchMinimaxSigninStatus(credential!)
    expect(status).not.toBeNull()
    // ⚠️ `active` 恒 true（拿到响应即 true）—— 不按「列表非空」判。
    expect(status?.active).toBe(true)
    console.log(`[minimax] 签到状态：今日已领=${status?.todayCheckedIn}`
      + ` 连续=${status?.streakDays} 今日额度=${status?.dailyCredit}`)
  })

  it('积分余额可读', async (ctx) => {
    if (probe?.expired !== false) {
      console.log('[minimax] access token 已过期，跳过余额验证。')
      ctx.skip()
    }
    const balance = await fetchMinimaxCreditBalance(credential!)
    // ⚠️ `null` 表示**查不到**（网络/业务码异常），与「余额为 0」不同。
    // 本机实测 `total_count: 0` 且无 `details` 字段 —— 那**是**有效结果。
    expect(balance).not.toBeNull()
    console.log(`[minimax] 积分余额：${balance?.total}`)
  })
})
