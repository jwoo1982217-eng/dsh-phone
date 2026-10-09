/**
 * Qoder **中国版**积分探针。
 *
 * 验证设计文档 §10：`/sash/` 那条链路整套复用是否成立。
 * E7 只证明了「端点存在且响应体同形」，**活动是否真的下发**必须实打一次。
 *
 * 三个动作：
 * 1. 查余额（`GET /sash/api/v2/me/usage`）—— 只读；
 * 2. 查活动（`GET /sash/api/v1/me/campaigns`）—— 只读；
 * 3. **真实领取一次**（`POST …/campaigns/{id}/claim`）—— 写操作，故需双闸门。
 *    领取后复读余额确认额度真的增加（国际版 2026-09-25 那次端到端修复
 *    用的就是这个验证方式）。
 *
 * ⚠️ 判据沿用国际版（AGENTS.md「Qoder 每日领取」章节），一条都不能松：
 * - `CheckinStatus.active` **恒为 true**（拿到响应即 true），它**不**由
 *   「列表非空」推导 —— 否则服务端回空列表时会被上层误报成「活动未开启」；
 * - 「今天已领」的判据是「存在 `CLAIM_BENEFIT` 且 `CLAIMED`」，
 *   **不是**列表为空（领取成功后列表仍非空，只是状态变了）；
 * - 幂等判据是响应体的 `replayed`，不是 HTTP 状态码（重复领也回 200）。
 *
 * 双重闸门（缺一不可）：
 *   DSH_QODERCN_E2E=1
 *   DSH_QODERCN_E2E_CONFIRM=yes
 * 用 `pnpm test:e2e:qodercn-credits` 运行。
 */
import { describe, expect, it } from 'vitest'
import { QODER_CN } from '../../src/qoder-product.js'
import {
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
  fetchQoderCreditBalance,
} from '../../src/qoder-credits.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const RUN = process.env.DSH_QODERCN_E2E === '1'
  && process.env.DSH_QODERCN_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

suite('QoderCN 积分探针（余额 + 活动 + 真实领取）', () => {
  const entries = readQoderCredentialsFromDshStore({ refPrefix: 'QODERCN' })

  it('至少有一个已登录的中国版账号', () => {
    expect(entries.length, '未找到 QODERCN 凭据，请先在面板登录。').toBeGreaterThan(0)
  })

  it('余额可查（只需 Bearer + Cosy-ClientType，无需 WASM 签名）', async () => {
    const { credential, uid } = entries[0]!
    const balance = await fetchQoderCreditBalance(credential, QODER_CN)
    console.log(`  ${uid} 余额 = ${JSON.stringify(balance)}`)
    // ⚠️ 企业版（`displayMode:"enterprise"`）不下发额度数字 → 返回 `null`
    // 而不是 0（UI 显示「查询失败」）。个人版应拿到对象。
    expect(balance, '余额查询失败 —— 凭据失效，或 CN 的 /sash/ 头要求与国际版不同')
      .not.toBeNull()
    expect(balance!.packages.length, '余额响应里没有任何资源包 —— 字段口径可能变了')
      .toBeGreaterThan(0)
    // 国际版的额度不只在 `userQuota`，还有 `addOnQuota` 与
    // `dedicatedResourcePackages`；若这里 total 为 0 而 packages 非空，
    // 说明 CN 多了一个未被累加的额度字段，需要回到 qoder-credits.ts 补。
    if (balance!.total === 0) {
      console.log('  ⚠️ total=0 而 packages 非空 —— 检查是否有 CN 独有的额度字段')
    }
  })

  it('活动列表可读，且 active 不由「列表非空」推导', async () => {
    const { credential, uid } = entries[0]!
    const status = await fetchQoderCheckinStatus(credential, QODER_CN)
    console.log(`  ${uid} 活动 = ${JSON.stringify(status)}`)
    if (status === null) {
      throw new Error(
        '活动查询失败（返回 null）。检查四个必需头是否齐全：Bearer + Cosy-ClientType '
        + '+ 成对的 Cosy-MachineToken/MachineType（见 qoder-machine.ts）。',
      )
    }
    // ⚠️ 拿到响应即 true。若这里为 false，说明实现退回了「按列表判 active」，
    // 那会让上层把「服务端没下发」误报成「签到活动未开启」（国际版真实缺陷）。
    expect(status.active, 'active 不应由「列表非空」推导').toBe(true)
    // `todayCheckedIn` 为 true 可能是**今天已领**，不能据此断定 CN 没有签到。
    console.log(`  todayCheckedIn=${status.todayCheckedIn} dailyCredit=${status.dailyCredit}`)
  })

  it('真实领取一次并确认额度增加（写操作）', async () => {
    const { credential, uid } = entries[0]!
    const before = await fetchQoderCreditBalance(credential, QODER_CN)
    console.log(`  ${uid} 领取前 total = ${before?.total ?? 'null'}`)

    const result = await claimQoderDailyCheckin(credential, QODER_CN)
    console.log(`  领取结果 = ${JSON.stringify(result)}`)

    const after = await fetchQoderCreditBalance(credential, QODER_CN)
    console.log(`  ${uid} 领取后 total = ${after?.total ?? 'null'}`)

    switch (result.kind) {
      case 'claimed': {
        // 唯一**不可接受**的情形：报成功但额度没变 —— 那是幂等判据（`replayed`）
        // 出了问题，把「服务端没真发额度」误报成了领取成功。
        expect(
          (after?.total ?? 0) > (before?.total ?? 0),
          '领取报成功但额度未增加 —— 检查 replayed 幂等判据',
        ).toBe(true)
        break
      }
      case 'already-claimed':
        // 可接受：今天已领（服务端幂等，回 `replayed:true`）。
        console.log(`  今天已领：${result.message}`)
        break
      case 'inactive':
        // ⚠️ 这条**不能**当成「CN 没有签到功能」的证据 —— 国际版正是那样误判过。
        // 但也别忽略 `actionRequired`：新注册账号可能尚未在 Qoder 侧开通领取，
        // 此时 message 是给用户的行动指引，必须醒目展示而不是混在计数里。
        console.log(`  活动未进行中：${result.message}${result.actionRequired ? '（需用户先操作）' : ''}`)
        break
      case 'failed':
        // 真失败：打印状态码与文案，交给人判断是头不全还是端点拒绝。
        throw new Error(`领取失败 code=${result.code} message=${result.message}`)
    }
  }, 120_000)
})
