/**
 * Qoder e2e 探针（**只读**）：凭据结构 + 令牌有效性 + 模型目录，不发模型请求。
 *
 * ⚠️ **不消耗模型积分** —— 本文件只做：
 * 1. 解析已存凭据（验证结构完整、machine_id 已持久化）；
 * 2. `GET /api/v1/userinfo` 验证令牌确实有效（**只读**，不计费）；
 * 3. 校验静态兜底模型表（不发网络请求）。
 *
 * 因此它可安全重复运行。真正发模型请求的探针见
 * `qoder-chat-probe.e2e.spec.ts`（带二次确认闸门）。
 *
 * 闸门：`DSH_QODER_E2E=1`。未设置时整体 skip，不产生任何网络调用。
 * 前置：先在 Jet Hub 的 Qoder 面板登录至少一个账号。
 */

import { describe, expect, it } from 'vitest'
import { QODER } from '../../src/qoder-product.js'
import { QODER_USERINFO_PATH, isQoderRefreshable, qoderBearerToken } from '../../src/qoder.js'
import { readQoderCredentialsFromDshStore } from './qoder-credential.js'

const enabled = process.env.DSH_QODER_E2E === '1'
const describeGate = enabled ? describe : describe.skip

describeGate('Qoder 认证探针（不消耗模型积分）', () => {
  const credentials = readQoderCredentialsFromDshStore()

  it('至少有一个已登录的 Qoder 账号', () => {
    // 前置条件缺失时给出可操作的提示，而不是一个费解的断言失败。
    expect(
      credentials.length,
      '未找到 Qoder 凭据。请先在 Jet Hub 的 Qoder 面板登录一个账号，'
      + '或确认 DSH profile 的 .credentials.yaml 路径正确。',
    ).toBeGreaterThan(0)
  })

  it('凭据结构完整（access_token / machine_id）', () => {
    for (const { uid, credential } of credentials) {
      expect(credential.access_token, uid).toBeTruthy()
      // machine_id 缺失会让**续期**失败（它随续期请求体发出），必须持久化。
      expect(credential.machine_id, `${uid} 缺少 machine_id，续期会失败`).toBeTruthy()
      // 双写字段必须一致（取用顺序是 security_oauth_token ?? access_token）。
      expect(credential.security_oauth_token, uid).toBe(credential.access_token)
    }
  })

  it('能判定是否可静默续期', () => {
    for (const { uid, credential } of credentials) {
      // 只做判定，不打印 token 本体。
      expect(typeof isQoderRefreshable(credential), uid).toBe('boolean')
    }
  })

  it('令牌对 /api/v1/userinfo 有效（只读，不计费）', async () => {
    for (const { uid, credential } of credentials) {
      const response = await fetch(`${QODER.openApiBase}${QODER_USERINFO_PATH}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${qoderBearerToken(credential)}`,
          Accept: 'application/json',
        },
      })
      expect(
        response.status,
        `${uid} 的令牌被拒（HTTP ${response.status}）。`
        + '若为 401，请在 Jet Hub 重新登录或点「刷新」。',
      ).toBe(200)
      const body = await response.json() as Record<string, unknown>
      // 只断言「有用户标识」，不打印邮箱等个人信息。
      const id = body.id ?? body.user_id ?? body.uid
      expect(typeof id === 'string' && id.length > 0, `${uid} 的 userinfo 缺少用户 id`).toBe(true)
    }
  })

  it('静态兜底模型表可用于 resolveModel', () => {
    // 本插件不发远端模型列表请求（需 WASM 签名），故这里校验表本身可用。
    expect(QODER.fallbackModels.length).toBeGreaterThan(0)
    for (const model of QODER.fallbackModels) {
      expect(model.id, '模型 id 不能为空').toBeTruthy()
      expect(model.contextWindow, `${model.id} 的 contextWindow 必须为正`).toBeGreaterThan(0)
    }
  })
})
