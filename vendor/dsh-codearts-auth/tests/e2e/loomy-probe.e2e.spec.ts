/**
 * Loomy **只读**探针。
 *
 * 验证单测无法证明的远端事实：
 * 1. 凭据（`session` 是 32 位 hex）对生产端点的有效性；
 * 2. **两套认证头**的交叉验证 —— chat 只认 Bearer、业务只认 token；
 * 3. 模型目录：11 条中 `type==='chat'` 的 8 条，且倍率**在 name 字符串里**；
 * 4. 新手任务状态（**只读**，不领取）；
 * 5. 积分两池（永久 vs 每日）。
 *
 * 闸门：`DSH_LOOMY_E2E=1`（用 `pnpm test:e2e:loomy` 运行）。
 *
 * ⚠️ 本用例**不发任何模型请求**（零积分消耗）、
 * **不领取任何任务**、**不触发签到** —— 全部是 GET。
 */

import { describe, expect, it } from 'vitest'
import { LOOMY } from '../../src/loomy-product.js'
import {
  LOOMY_ONBOARDING_TOTAL,
  LOOMY_TASK_POINTS,
  fetchLoomyOnboardingTasks,
} from '../../src/loomy-onboarding.js'
import { fetchLoomyCreditDetail } from '../../src/loomy-credits.js'
import { loomyBusinessHeaders, parseLoomyEnvelope } from '../../src/loomy.js'
import { parseLoomyRemoteModels } from '../../src/loomy-adapter.js'
import { readLoomyCredentialsFromDshStore } from './loomy-credential.js'

const RUN = process.env.DSH_LOOMY_E2E === '1'
const suite = RUN ? describe : describe.skip

suite('Loomy 只读探针（不发模型请求、不领取任务、不签到）', () => {
  const entries = readLoomyCredentialsFromDshStore()

  it('至少有一个已登录的 Loomy 账号', () => {
    expect(
      entries.length,
      '未找到 Loomy 凭据。请先在 Jet Hub 的 Loomy 面板用短信登录一个账号，'
      + '或设置 DSH_LOOMY_CREDENTIAL_JSON。',
    ).toBeGreaterThan(0)
  })

  it('凭据结构正确（session 是 32 位 hex）', () => {
    const { credential } = entries[0]!
    console.log('\n===== 凭据结构 =====')
    console.log(`  phone        = ${credential.phone}`)
    console.log(`  userid       = ${credential.userid}`)
    console.log(`  expires_at   = ${credential.expires_at ?? '(缺失)'}`)
    console.log(`  session 长度 = ${credential.access_token.length}`)
    expect(credential.access_token).toMatch(/^[0-9a-f]{32}$/)
    expect(credential.userid.length).toBeGreaterThan(0)
  })

  /**
   * ⚠️ 这是「两套头」的**现场证据**：同一个 token，业务端点认 token、
   * chat 端点认 Bearer。写错任一个都会得到 `100002 缺少 token`。
   */
  it('业务端点认 token 头、Bearer 头被拒（两套头交叉验证）', async () => {
    const { credential } = entries[0]!
    const url = `${LOOMY.apiBase}/points/records?pageNo=1&pageSize=1&recordType=all`

    const withToken = await fetch(url, { headers: loomyBusinessHeaders(credential.access_token) })
    const tokenBody = parseLoomyEnvelope(await withToken.json())
    console.log(`\n  token 头   → code=${tokenBody.code}`)
    expect(tokenBody.ok, 'token 头应被业务端点接受').toBe(true)

    // 反向验证：Bearer 头应被拒（证明两套头确实不同）
    const withBearer = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential.access_token}` },
    })
    const bearerBody = parseLoomyEnvelope(await withBearer.json())
    console.log(`  Bearer 头  → code=${bearerBody.code} (${bearerBody.message})`)
    expect(bearerBody.ok, 'Bearer 头不应被业务端点接受').toBe(false)
    expect(bearerBody.code).toBe('100002')
  })

  it('模型目录：8 个 chat 模型，倍率在 name 里', async () => {
    const { credential } = entries[0]!
    const response = await fetch(`${LOOMY.apiBase}/models`, {
      headers: loomyBusinessHeaders(credential.access_token),
    })
    const payload = await response.json()
    const all = parseLoomyRemoteModels(payload)
    const rawCount = Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data.length
      : 0

    console.log('\n===== 模型目录 =====')
    console.log(`  远端总数   = ${rawCount}（含生图模型）`)
    console.log(`  chat 模型  = ${all.length}`)
    for (const model of all) {
      console.log(`    ${model.id.padEnd(24)} ${model.name.padEnd(36)} ctx=${model.contextWindow}`)
    }

    expect(all).toHaveLength(8)
    // 倍率必须已规范化（` · x{n}` 形态），不能残留全角括号
    for (const model of all) {
      expect(model.name, `${model.id} 的倍率未规范化`).not.toMatch(/[（(]x[\d.]+[)）]/)
    }
    expect(all.some((m) => m.name.includes(' · x'))).toBe(true)
  })

  it('新手任务状态可读，总分 10000（**只读，不领取**）', async () => {
    const { credential } = entries[0]!
    const state = await fetchLoomyOnboardingTasks(credential, LOOMY)

    console.log('\n===== 新手任务 =====')
    console.log(`  已领 = ${state.earned} / ${state.total}`)
    for (const [key, done] of Object.entries(state.tasks)) {
      console.log(`    ${done ? '[x]' : '[ ]'} ${key.padEnd(20)} +${LOOMY_TASK_POINTS[key]}`)
    }

    expect(state.total).toBe(LOOMY_ONBOARDING_TOTAL)
    expect(Object.keys(state.tasks)).toHaveLength(8)
    // earned 必须与本地现算一致（不采信服务端）
    const recomputed = Object.entries(state.tasks)
      .reduce((sum, [key, done]) => (done ? sum + (LOOMY_TASK_POINTS[key] ?? 0) : sum), 0)
    expect(state.earned).toBe(recomputed)
  })

  it('积分两池可读（永久 + 每日，只读）', async () => {
    const { credential } = entries[0]!
    const detail = await fetchLoomyCreditDetail(credential, LOOMY)

    console.log('\n===== 积分两池 =====')
    console.log(`  永久积分 = ${detail?.permanent}`)
    console.log(`  每日赠送 = ${detail?.daily}`)
    console.log(`  合计     = ${detail?.total}`)

    expect(detail).not.toBeNull()
    expect(detail!.permanent).toBeGreaterThanOrEqual(0)
    expect(detail!.daily).toBeGreaterThanOrEqual(0)
    // 合计应不小于永久（availableBalance = 永久 + 每日）
    expect(detail!.total).toBeGreaterThanOrEqual(detail!.permanent)
  })
})
