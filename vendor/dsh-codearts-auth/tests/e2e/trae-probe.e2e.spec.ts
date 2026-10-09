/**
 * TRAE e2e 探针：只走**认证**与**积分/签到状态**，不发模型请求。
 *
 * ⚠️ **不消耗模型积分、也不改动签到状态** —— 本文件只做：
 * 1. 解析已存凭据（验证 machine_id / device_id 等关键字段完整）；
 * 2. 拉取远端模型列表（`get_detail_param`，只读）；
 * 3. 查询积分余额（`ide_user_ent_usage`，只读）。
 *
 * 因此它可安全重复运行。真正签到的探针见 `trae-claim-probe.e2e.spec.ts`
 * （带二次确认闸门）。
 *
 * 闸门：`DSH_TRAE_E2E=1`。未设置时整体 skip，不产生任何网络调用。
 * 前置：先在 Jet Hub 的 TRAE 面板登录至少一个账号。
 */

import { describe, expect, it } from 'vitest'
import { TRAE } from '../../src/trae-product.js'
import {
  TRAE_BATCH_MODELS_PATH,
  isTraeModelUsable,
  isTraeRefreshable,
  parseTraeBatchModelList,
  traeCredentialExpiresAtMs,
  traeSOLOHeaders,
  traeUgHeaders,
} from '../../src/trae.js'
import { fetchTraeCreditBalance, fetchTraeCheckinStatus } from '../../src/trae-credits.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'

const enabled = process.env.DSH_TRAE_E2E === '1'
const describeGate = enabled ? describe : describe.skip

describeGate('TRAE 认证与积分探针（不消耗模型积分）', () => {
  const credentials = readTraeCredentialsFromDshStore()

  it('至少有一个已登录的 TRAE 账号', () => {
    // 前置条件缺失时给出可操作的提示，而不是一个费解的断言失败。
    expect(
      credentials.length,
      '未找到 TRAE 凭据。请先在 Jet Hub 的 TRAE 面板登录一个账号，'
      + '或确认 DSH profile 的 .credentials.yaml 路径正确，'
      + '也可设置 DSH_TRAE_CREDENTIAL_JSON 直接提供凭据。',
    ).toBeGreaterThan(0)
  })

  it('凭据结构完整（access_token / refresh_token / machine_id / device_id）', () => {
    for (const { uid, credential } of credentials) {
      expect(credential.access_token, uid).toBeTruthy()
      expect(isTraeRefreshable(credential), uid).toBe(true)
      // 这两个字段缺失会分别导致：对话请求缺 X-Machine-Id、签到报 9004。
      expect(credential.machine_id, `${uid} 缺少 machine_id`).toBeTruthy()
      expect(credential.device_id, `${uid} 缺少 device_id`).toBeTruthy()
    }
  })

  it('machine_id 与 device_id 均为 32 位 hex（格式与生成器一致）', () => {
    for (const { uid, credential } of credentials) {
      expect(credential.machine_id, uid).toMatch(/^[0-9a-f]{32}$/)
      // device_id 也是 hex32（对齐 login.sh 的 openssl rand -hex 16）——
      // 早期实现误用「16 位纯数字」（CodeBuddy 的格式），此处锁死正确格式。
      expect(credential.device_id, uid).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('过期时间可解析', () => {
    for (const { uid, credential } of credentials) {
      const expiresAt = traeCredentialExpiresAtMs(credential)
      // 允许为 undefined（JWT 不可解析时上层按 401 处理），
      // 但**若能**解析出值则必须是正数。
      if (expiresAt !== undefined) expect(expiresAt, uid).toBeGreaterThan(0)
    }
  })

  it('积分余额可查询（ide_user_ent_usage）', async () => {
    for (const { uid, credential } of credentials) {
      const balance = await fetchTraeCreditBalance(credential, TRAE)
      if (balance === null) {
        // 凭据失效时如实报告，而不是 fail —— 探针的价值在于给出诊断信息。
        // eslint-disable-next-line no-console
        console.log(`[trae-e2e] ${uid}: 余额查询失败（凭据可能已失效）`)
        continue
      }
      expect(typeof balance.total, uid).toBe('number')
      // eslint-disable-next-line no-console
      console.log(
        `[trae-e2e] ${uid}: 余额=${balance.total} 包数=${balance.packages.length}`,
      )
    }
  })

  it('签到状态可查询（checkin_credits/status，只读不领取）', async () => {
    for (const { uid, credential } of credentials) {
      const status = await fetchTraeCheckinStatus(credential, TRAE)
      if (status === null) {
        // eslint-disable-next-line no-console
        console.log(`[trae-e2e] ${uid}: 签到状态查询失败（凭据可能已失效）`)
        continue
      }
      expect(typeof status.todayCheckedIn, uid).toBe('boolean')
      // eslint-disable-next-line no-console
      console.log(
        `[trae-e2e] ${uid}: 今日已签到=${status.todayCheckedIn} 活动开启=${status.active}`,
      )
    }
  })

  it('远端模型列表可拉取（batch_get_detail_param，只读）', async () => {
    // 该端点需要 SOLO 头（Cloud-IDE-JWT + X-Ide-Version 等）。
    // 用**批量**端点一次拿全部通道的目录（真实 CN IDE 用法）：每个 function
    // 各自一套模型目录，而**模型只在列出它的通道里可调用**。
    for (const { uid, credential } of credentials) {
      const response = await fetch(`${TRAE.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
        method: 'POST',
        headers: traeSOLOHeaders(credential, TRAE, false) as Record<string, string>,
        body: JSON.stringify({
          functions: [...TRAE.channels],
          agent_type: '',
          current_config_info: { config_name: '', is_custom_model: false },
          mode_type: 0,
          access_type: 0,
          ab_force_vids: '',
          ab_autotest_advanced_mode: 0,
          show_custom_model: true,
        }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined)

      if (response === undefined || !response.ok) {
        // eslint-disable-next-line no-console
        console.log(`[trae-e2e] ${uid}: 模型列表拉取失败（HTTP ${response?.status ?? 'network'}）`)
        continue
      }
      const all = parseTraeBatchModelList(await response.json() as unknown)
      const usable = all.filter((model) => isTraeModelUsable(model))
      // eslint-disable-next-line no-console
      console.log(
        `[trae-e2e] ${uid}: 通道=${TRAE.channels.join('+')} 合并=${all.length} 可用=${usable.length}`,
      )
      if (usable.length > 0) {
        // 可用条目必须都带非空 id 与所属通道（否则发送时无法路由）。
        for (const model of usable) {
          expect(model.id.length, uid).toBeGreaterThan(0)
          expect(model.function, `${uid}/${model.id} 缺少所属通道`).toBeTruthy()
        }
      }
    }
  })

  it('签到请求头含 X-User-Region: CN（区域标识）', () => {
    // 纯本地断言：确保 Ug 头的区域标识没有被误删。
    for (const { uid, credential } of credentials) {
      const headers = traeUgHeaders(credential, TRAE)
      expect(headers['X-User-Region'], uid).toBe('CN')
    }
  })
})
