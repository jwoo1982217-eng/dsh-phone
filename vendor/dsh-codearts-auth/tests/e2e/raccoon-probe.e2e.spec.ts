/**
 * Raccoon **只读**探针。
 *
 * 验证单测无法证明的远端事实：
 * 1. 凭据（JWT）对生产端点的有效性；
 * 2. 模型目录：`visible:true` 的 6 条，且**倍率来自
 *    `billing_effective_multiplier`**（不是猜的）；
 * 3. 积分余额与账单（**只读**）；
 * 4. 「Raccoon-Auto」**不在**远端目录里（它是客户端 UI 合成条目）。
 *
 * 闸门：`DSH_RACCOON_E2E=1`（用 `pnpm test:e2e:raccoon` 运行）。
 *
 * ⚠️ 本用例**不发任何模型请求**（零积分消耗）、
 * **不领取任何奖励**（`login/points/grant` 是写端点）—— 全部是 GET。
 */

import { describe, expect, it } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonOnboardingStatus,
} from '../../src/raccoon-credits.js'
import { parseRaccoonModelCatalog } from '../../src/raccoon-auth.js'
import { raccoonHeaders } from '../../src/raccoon.js'
import { readRaccoonCredentialsFromDshStore } from './raccoon-credential.js'

const RUN = process.env.DSH_RACCOON_E2E === '1'
const suite = RUN ? describe : describe.skip

suite('Raccoon 只读探针（不发模型请求、不领取奖励）', () => {
  const entries = readRaccoonCredentialsFromDshStore()

  it('至少有一个已登录的 Raccoon 账号', () => {
    expect(
      entries.length,
      '未找到 Raccoon 凭据。请先在 Jet Hub 的 Raccoon 面板用微信扫码或短信登录一个账号，'
      + '或设置 DSH_RACCOON_CREDENTIAL_JSON。',
    ).toBeGreaterThan(0)
  })

  it('模型目录：6 个 visible 模型，倍率来自 billing_effective_multiplier', async () => {
    const first = entries[0]
    expect(first).toBeDefined()
    if (first === undefined) return

    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/model_catalog`,
      { headers: raccoonHeaders(first.credential), signal: AbortSignal.timeout(30_000) },
    )
    expect(response.status, `HTTP ${response.status}`).toBe(200)

    const models = parseRaccoonModelCatalog(await response.json())
    expect(models.length, 'visible 模型数量').toBe(6)

    const ids = models.map((m) => m.id)
    expect(ids).toEqual([
      'sn-sensenova-6-8-flash',
      'sn-sensenova-6-8-flash-lite',
      'sn-glm-5-3',
      'sn-kimi-k3',
      'sn-glm-5-3-flash',
      'sn-deepseek-v4-1-flash',
    ])

    // 倍率必须真的来自 billing_effective_multiplier（逐条对照实测值）
    const byId = new Map(models.map((m) => [m.id, m]))
    expect(byId.get('sn-glm-5-3')?.name).toBe('GLM-5-3 · x0.75')
    // ⚠️ 1 倍也要显示（用户报障「为什么 Kimi-K3 没有倍率，ide 是 1 倍」）
    expect(byId.get('sn-kimi-k3')?.name).toBe('Kimi-K3 · x1')
    expect(byId.get('sn-glm-5-3-flash')?.name).toBe('GLM-5-3-Flash · x0.2→x0.1')
    expect(byId.get('sn-deepseek-v4-1-flash')?.name).toBe('DeepSeek-V4.1-Flash · x0.25')
    expect(byId.get('sn-sensenova-6-8-flash')?.name).toBe('SenseNova-6.8-Flash · 免费')
  })

  it('⚠️ Raccoon-Auto 不在远端目录里（它是客户端 UI 合成条目）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/model_catalog`,
      { headers: raccoonHeaders(first.credential), signal: AbortSignal.timeout(30_000) },
    )
    const models = parseRaccoonModelCatalog(await response.json())
    expect(models.some((m) => m.id.includes('raccoon-auto'))).toBe(false)
    expect(models.some((m) => m.name.includes('Raccoon-Auto'))).toBe(false)
    // 也不含 3 个 visible:false 的 raccoon-* 内部模型
    expect(models.some((m) => m.id.startsWith('raccoon-'))).toBe(false)
  })

  it('远端目录含 3 个 visible:false 的内部模型（证明过滤真的生效）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/model_catalog`,
      { headers: raccoonHeaders(first.credential), signal: AbortSignal.timeout(30_000) },
    )
    const payload = await response.json() as {
      data?: { categories?: Array<{ type?: string; models?: Array<{ name?: string; visible?: boolean }> }> }
    }
    const chat = payload.data?.categories?.find((c) => c.type === 'chat')
    const hidden = (chat?.models ?? []).filter((m) => m.visible === false)
    expect(hidden.length, 'visible:false 的模型数（应为 3 个 raccoon-* 内部模型）').toBe(3)
  })

  it('积分余额可查（只读）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const balance = await fetchRaccoonCreditBalance(RACCOON, first.credential)
    expect(balance, '余额查询失败（凭据可能已失效）').not.toBeNull()
    expect(typeof balance?.total).toBe('number')
    expect(balance?.total).toBeGreaterThanOrEqual(0)
    // 各池分开作 package（reward / daily / topup）
    expect((balance?.packages.length ?? 0)).toBeGreaterThan(0)
  })

  it('登录奖励状态可查（只读，不发写请求）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const status = await fetchRaccoonOnboardingStatus(RACCOON, first.credential)
    expect(typeof status.claimed).toBe('boolean')
    expect(status.points).toBeGreaterThan(0)
  })

  /**
   * ⚠️ **不发**写请求的证明：只检查函数存在与签名，不调用它。
   *
   * 本探针刻意不调 `claimRaccoonLoginReward` —— 那是 POST（写端点）。
   * 领取的真实性由 E2E 闸门外的 `raccoon-claim-probe` 覆盖（若将来需要）。
   */
  it('领取函数存在（但本探针不调用它 —— 那是写端点）', () => {
    expect(typeof claimRaccoonLoginReward).toBe('function')
  })
})
