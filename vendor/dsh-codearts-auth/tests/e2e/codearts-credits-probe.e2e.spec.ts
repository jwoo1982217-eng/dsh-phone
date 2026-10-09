/**
 * CodeArts 积分 e2e 探针：**只读**，绝不领取。
 *
 * ⚠️ 本文件**不调用** `/v1/ops/claim` 与 `/v1/ops/confirm` —— 那是写操作。
 * 它只做三件事：
 * 1. 解析已存凭据（验证 AK/SK/security_token 结构与过期时间可解析）；
 * 2. 查询账户/套餐信息 → **积分账户检测**（`is_credit_package`）；
 * 3. 查询活动列表（只读）→ 打印每日签到活动的 `claimable` / `status`。
 *
 * 因此它**不消耗任何积分、也不改动领取状态**，可安全重复运行。
 * 真正领取的探针见 `codearts-claim-probe.e2e.spec.ts`（带二次确认闸门）。
 *
 * ⚠️ **前置条件：凭据必须是新鲜的。** CodeArts 的 refresh_token 一次性轮换，
 * 本探针**不会**刷新它（见 `codearts-credential.ts` 的说明）。若凭据已过期，
 * 探针会如实报告签名请求失败 —— 此时请在 Jet Hub 重新登录，或等续期调度
 * 跑过一轮，而**不要**为此在探针里加刷新逻辑。
 *
 * 闸门：`DSH_CODEARTS_E2E=1`。未设置时整体 skip，不产生任何网络调用。
 * 前置：先在 Jet Hub 的 CodeArts 面板登录至少一个账号。
 */

import { describe, expect, it } from 'vitest'
import {
  CODEARTS_SNAP_ENGINE_URL,
  fetchCodeArtsAccountInfoDetailed,
  fetchCodeArtsOpsActivitiesDetailed,
  findDailyCheckinActivity,
} from '../../src/codearts-credits.js'
import {
  codeArtsCredentialExpiresAtMs,
  readCodeArtsCredentialsFromDshStore,
} from './codearts-credential.js'

const enabled = process.env.DSH_CODEARTS_E2E === '1'
const describeGate = enabled ? describe : describe.skip

describeGate('CodeArts 账户类型与积分活动探针（只读，不领取）', () => {
  const credentials = readCodeArtsCredentialsFromDshStore()

  it('至少有一个已登录的 CodeArts 账号', () => {
    // 前置条件缺失时给出可操作的提示，而不是一个费解的断言失败。
    expect(
      credentials.length,
      '未找到 CodeArts 凭据。请先在 Jet Hub 的 CodeArts 面板登录一个账号，'
      + '或确认 DSH profile 的 .credentials.yaml 路径正确。',
    ).toBeGreaterThan(0)
  })

  it('凭据结构完整（AK / SK / security_token）', () => {
    for (const { uid, credential } of credentials) {
      expect(credential.access_key_id, uid).toBeTruthy()
      expect(credential.secret_access_key, uid).toBeTruthy()
      expect(credential.security_token, uid).toBeTruthy()
    }
  })

  it('账户信息可查询，并给出积分账户判定', async () => {
    for (const { uid, ref, credential } of credentials) {
      const expiresAt = codeArtsCredentialExpiresAtMs(credential)
      const expired = expiresAt !== undefined && expiresAt <= Date.now()
      const result = await fetchCodeArtsAccountInfoDetailed(credential)

      if (!result.ok) {
        // 凭据过期时签名请求会失败，这是**预期内**的结果，不是实现缺陷。
        // 用清晰的断言消息把用户引向正确动作（重新登录），而不是让他去查代码。
        const hint = expired
          ? `（该凭据 expires_at=${credential.expires_at} 已过期；`
            + 'CodeArts 的 refresh_token 一次性轮换，请在 Jet Hub 重新登录）'
          : ''
        expect.fail(`${ref} 账户信息查询失败：${result.message}${hint}`)
      }

      const info = result.info
      // 把关键判据打印出来，便于人工核对（这也是探针的主要价值）。
      console.log(
        `[codearts-credits] ${uid} (${ref})\n`
        + `  套餐: ${info.packageName || '(未命名)'}\n`
        + `  spec_code: ${info.specCode || '(空)'}  status: ${info.packageStatus || '(空)'}\n`
        + `  is_credit_package: ${info.isCreditPackage}  is_token_package: ${info.isTokenPackage}\n`
        + `  积分余额: ${info.credit === undefined ? '(无积分口径)' : `${info.credit.total} (${info.credit.packages.length} 个包)`}`,
      )
      // 至少要有一种计费形态被识别出来；两者皆 false 说明响应结构与预期不符。
      expect(
        info.isCreditPackage || info.isTokenPackage,
        `${ref} 既非积分账户也非 Token 账户，响应结构可能与预期不符`,
      ).toBe(true)
    }
  })

  it('活动列表可查询（只读），并定位每日签到活动', async () => {
    for (const { uid, ref, credential } of credentials) {
      const result = await fetchCodeArtsOpsActivitiesDetailed(credential)
      if (!result.ok) {
        const hint = codeArtsCredentialExpiresAtMs(credential) !== undefined
          && codeArtsCredentialExpiresAtMs(credential)! <= Date.now()
          ? '（凭据已过期，请重新登录）'
          : ''
        expect.fail(`${ref} 活动列表查询失败：${result.message}${hint}`)
      }
      const daily = findDailyCheckinActivity(result.activities)
      console.log(
        `[codearts-credits] ${uid} 活动 ${result.activities.length} 项；`
        + `每日签到: ${daily === undefined
          ? '未找到 USER_LOGIN 活动'
          : `claimable=${daily.claimable} status=${daily.status} amount=${daily.amount}`}`,
      )
      // 活动列表本身可以为空（活动期外），但**能查到**才说明端点与签名正确。
      expect(Array.isArray(result.activities)).toBe(true)
    }
  })

  it('签名端点的基址与仓库既有 snap-access 端点同域', () => {
    // 防止有人把基址改成 portal（那条路径依赖浏览器 Cookie，本插件无法使用）。
    expect(CODEARTS_SNAP_ENGINE_URL).toBe('https://snap-access.cn-north-4.myhuaweicloud.com')
  })
})
