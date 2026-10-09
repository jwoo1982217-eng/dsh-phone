/**
 * Cline **只读**探针。
 *
 * 验证单测无法证明的远端事实（不发任何模型请求）：
 * 1. 凭据结构（含 `account_id` 与 **`workos:` 前缀**）；
 * 2. 令牌对 `/api/v1/users/me` 的有效性 —— 这是「前缀不可剥」的现场证据；
 * 3. 积分余额（`/api/v1/users/{accountId}/balance`），并**打印原始数值**
 *    以便核对 {@link CLINE_BALANCE_SCALE} 这个唯一的不确定点；
 * 4. 模型目录两个端点：`recommended-models`（**free 集合**）与 `/models`；
 * 5. **免费集合的远端下发内容**是否仍与实现假设一致（截图那 5 个）。
 *
 * 闸门：`DSH_CLINE_E2E=1`（用 `pnpm test:e2e:cline` 运行）。
 *
 * ⚠️ 本用例**不续期**（避免消耗/轮换 refresh_token），
 * 也**不发任何模型请求**（零 token 消耗）。
 */

import { describe, expect, it } from 'vitest'
import { CLINE } from '../../src/cline-product.js'
import { clineAuthHeaders, clineBearerValue } from '../../src/cline.js'
import {
  CLINE_BALANCE_SCALE,
  fetchClineCreditBalance,
  parseClineBalanceResponse,
} from '../../src/cline-credits.js'
import { isClineFreeModel, loadClineModels, parseClineRecommendedModels } from '../../src/cline-models.js'
import { readClineCredentialsFromDshStore } from './cline-credential.js'

const RUN = process.env.DSH_CLINE_E2E === '1'
const suite = RUN ? describe : describe.skip

suite('Cline 只读探针（不发模型请求、不续期）', () => {
  const entries = readClineCredentialsFromDshStore()

  it('至少有一个已登录的 Cline 账号', () => {
    expect(
      entries.length,
      '未找到 Cline 凭据。请先在 Jet Hub 的 Cline 面板登录一个账号，'
      + '或设置 DSH_CLINE_CREDENTIAL_JSON。',
    ).toBeGreaterThan(0)
  })

  it('凭据结构含 account_id 与 workos: 前缀', () => {
    const { credential, ref } = entries[0]!
    console.log('\n===== 凭据结构 =====')
    console.log(`  ref            = ${ref}`)
    console.log(`  account_id     = ${credential.account_id ?? '(缺失)'}`)
    console.log(`  email          = ${credential.email ?? '(缺失)'}`)
    console.log(`  expire_time    = ${credential.expire_time ?? '(缺失)'}`)
    console.log(`  前缀           = ${credential.access_token.startsWith(CLINE.tokenPrefix) ? 'workos: ✓' : '✗ 缺前缀'}`)
    console.log(`  refresh_token  = ${credential.refresh_token !== undefined ? '有' : '无'}`)

    expect(credential.access_token.length).toBeGreaterThan(0)
    // ⚠️ 余额端点必须用 account_id（不是 JWT 的 sub）
    expect(credential.account_id, '凭据缺少 account_id，余额查询会失败').toBeTruthy()
  })

  /**
   * ⚠️ 这是「`workos:` 前缀不可剥」的**现场证据**：
   * 带前缀 200、剥掉前缀 401。单测只能锁死我们**发**的是带前缀的值，
   * 无法证明服务端真的这样要求。
   */
  it('带前缀的令牌有效，剥掉前缀即 401（前缀不可剥的现场证据）', async () => {
    const { credential } = entries[0]!
    const withPrefix = await fetch(`${CLINE.apiBase}/api/v1/users/me`, {
      headers: clineAuthHeaders(credential.access_token, CLINE),
      signal: AbortSignal.timeout(20_000),
    })
    console.log('\n===== 令牌前缀验证 =====')
    console.log(`  带 workos: 前缀 → HTTP ${withPrefix.status}`)

    const stripped = credential.access_token.replace(/^workos:/, '')
    const withoutPrefix = await fetch(`${CLINE.apiBase}/api/v1/users/me`, {
      headers: { ...clineAuthHeaders(stripped, CLINE), Authorization: `Bearer ${stripped}` },
      signal: AbortSignal.timeout(20_000),
    })
    console.log(`  剥掉前缀        → HTTP ${withoutPrefix.status}`)
    if (withoutPrefix.status === 401) {
      console.log('  → 证实：前缀必须保留（剥掉即 401）')
    }

    expect(withPrefix.status, '带前缀应能通过认证').toBe(200)
    // 若某天剥掉前缀也能通过，说明服务端放宽了 —— 那时可简化实现，
    // 但不该让本探针失败（故只记录，不断言）。
  })

  it('积分余额可查（并打印原始数值供核对单位）', async () => {
    const { credential } = entries[0]!
    const result = await fetchClineCreditBalance(credential, CLINE)
    console.log('\n===== 积分余额 =====')
    console.log(`  rawBalance（服务端原始值） = ${result.rawBalance ?? '(未返回)'}`)
    console.log(`  CLINE_BALANCE_SCALE        = ${CLINE_BALANCE_SCALE}`)
    console.log(`  换算后                     = ${result.balance?.total ?? '(查询失败)'}`)
    if (result.error !== undefined) console.log(`  error                      = ${result.error}`)
    console.log(
      '  ⚠️ 请核对上面的原始值与本插件展示值是否符合预期；\n'
      + '     单位是本实现唯一的不确定点（见 src/cline-credits.ts 的模块注释）。',
    )

    // 不断言具体数值（账号间不同），只要求查询链路可用。
    if (result.balance === null) {
      throw new Error(`余额查询失败：${result.error ?? '未知原因'}`)
    }
    expect(result.balance.total).toBeGreaterThanOrEqual(0)
  })

  /**
   * ⚠️ 本用例回答**最关键的产品问题**：远端下发的免费集合是否仍与实现一致。
   * 免费资格是服务端动态状态，随时可能变化 —— 探针把真实内容打出来，
   * 便于与 `src/cline-product.ts` 的兜底表和截图对照。
   */
  it('远端 recommended-models 的 free 数组（免费模型权威来源）', async () => {
    const response = await fetch(`${CLINE.apiBase}/api/v1/ai/cline/recommended-models`, {
      headers: { Accept: 'application/json', ...CLINE.clientHeaders },
      signal: AbortSignal.timeout(20_000),
    })
    expect(response.status, 'recommended-models 应可匿名访问').toBe(200)
    const parsed = parseClineRecommendedModels(await response.json())

    console.log('\n===== 远端 free 数组（免费模型）=====')
    for (const entry of parsed.free) {
      console.log(`  ${entry.id.padEnd(42)} ${entry.name ?? ''}`)
    }
    console.log(`  （共 ${parsed.free.length} 个）`)
    console.log('\n===== clinePass（订阅制，**不是**免费）=====')
    console.log(`  ${parsed.clinePass.length} 个：${parsed.clinePass.slice(0, 4).map((e) => e.id).join(', ')}…`)

    expect(parsed.free.length, '远端应至少下发一个免费模型').toBeGreaterThan(0)
    // ⚠️ **与兜底表联动断言，不再硬编码清单**。
    //
    // 本用例的职责是**发现兜底表落后于远端**（兜底表里的免费条目被上游下架）。
    // 硬编码清单会让「上游下架 → 同步兜底表」这一个动作同时弄红**两处**
    // （清单本身 + 下面的目录断言），排查时无法区分「探针该更新了」与
    // 「实现坏了」。故清单来源单一化：只认 `CLINE.fallbackModels`。
    //
    // 已发生两次：`gemini-3.8-flash`（2026-10-03）、`deepseek-v4.1-flash`
    // （2026-10-05，直连回 `404 {"error":"model not found"}`）。
    const freeIds = new Set(parsed.free.map((entry) => entry.id))
    for (const model of CLINE.fallbackModels.filter((entry) => entry.isFree === true)) {
      expect(
        freeIds.has(model.id),
        `兜底表里的免费模型 ${model.id} 已不在远端 free 数组中`
        + '（上游已下架，需同步兜底表与文档）',
      ).toBe(true)
    }
    // `clinePass` 不得被误判为免费
    for (const entry of parsed.clinePass) {
      expect(isClineFreeModel(entry.id, freeIds), `${entry.id} 是订阅制，不该判为免费`).toBe(false)
    }
  })

  it('远端 /models 返回全量 id，且其中**没有** cline-free/*（免费模型只走 recommended）', async () => {
    const { credential } = entries[0]!
    const response = await fetch(`${CLINE.apiBase}/api/v1/models`, {
      headers: clineAuthHeaders(credential.access_token, CLINE),
      signal: AbortSignal.timeout(20_000),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { data?: Array<{ id?: string }> }
    const ids = (payload.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string')

    console.log('\n===== 远端 /models =====')
    console.log(`  条目数 = ${ids.length}`)
    const clineFree = ids.filter((id) => id.startsWith('cline-free/'))
    console.log(`  其中 cline-free/* = ${clineFree.length}（预期 0 —— 免费模型只由 recommended 下发）`)
    console.log(`  含 :free 后缀     = ${ids.filter((id) => id.endsWith(':free')).length}`)

    expect(ids.length).toBeGreaterThan(0)
    // 锁死「免费模型只在 recommended 里」这一事实 —— 它正是必须打两个端点的原因。
    // 若某天 /models 也开始下发 cline-free/*，本断言会失败并提示可简化实现。
    expect(clineFree, '/models 里出现了 cline-free/*，实现可简化（见 cline-models.ts 注释）').toHaveLength(0)
  })

  it('合并后的目录：免费模型带标记、付费模型不误标', async () => {
    const { credential } = entries[0]!
    const { models, warnings } = await loadClineModels(CLINE, { credential })

    const free = models.filter((model) => model.isFree)
    console.log('\n===== 合并目录 =====')
    console.log(`  总计 ${models.length} 个，其中免费 ${free.length} 个`)
    console.log(`  免费清单：${free.map((m) => m.id).join(', ')}`)
    if (warnings.length > 0) console.log(`  ⚠️ 来源告警：${warnings.join('; ')}`)

    expect(models.length).toBeGreaterThan(0)
    expect(free.length).toBeGreaterThan(0)

    // 核心不变式：`cline-free/*`（免费）与同名不带前缀的（按量计费）是
    // **两个不同实体**，绝不可混判。
    //
    // ⚠️ 免费侧改用仍在册的 `cline-free/mimo-v2.6-flash`：原先用的
    // `cline-free/deepseek-v4.1-flash` 已于 2026-10-05 被上游下架
    // （直连回 `404 {"error":"model not found"}`）并从兜底表删除，而
    // `mergeClineModels` 现在会丢弃「远端已不认识」的兜底条目 ⇒ 取不到它。
    const byId = new Map(models.map((model) => [model.id, model]))
    expect(byId.get('cline-free/mimo-v2.6-flash')?.isFree).toBe(true)
    if (byId.has('deepseek/deepseek-v4.1-flash')) {
      expect(byId.get('deepseek/deepseek-v4.1-flash')?.isFree, '付费同名模型被误标为免费').toBe(false)
    }
  })

  /**
   * ⚠️ **现场回归**：已下架模型不得被兜底表「复活」。
   *
   * 真实报障（2026-10-05）：`cline-free/deepseek-v4.1-flash` 被移出远端 `free`
   * 数组后，仍以「免费」出现在模型列表里，用户选中即回 `404 model not found`。
   *
   * 本条用**真实远端响应**验证修复（单测用的是构造输入，这里补现场证据）。
   */
  it('已下架模型不再被兜底表复活（真实远端目录）', async () => {
    const { credential } = entries[0]!
    const { models } = await loadClineModels(CLINE, { credential })
    const byId = new Map(models.map((model) => [model.id, model]))

    const removed = 'cline-free/deepseek-v4.1-flash'
    console.log('\n===== 已下架模型检查 =====')
    console.log(`  ${removed} → ${byId.has(removed) ? '❌ 仍在列表中' : '✅ 不在列表中'}`)
    console.log(`  isClineFreeModel 仍认它（前缀分支）= ${isClineFreeModel(removed)}`)
    console.log(`  兜底表是否仍含它 = ${CLINE.fallbackModels.some((m) => m.id === removed)}`)

    expect(
      byId.has(removed),
      `已下架模型 ${removed} 仍在目录中（兜底表复活了它，用户选中会回 404）`,
    ).toBe(false)
  })

  it('余额响应解析对 401 保留服务端原因（而非「缺少 data 字段」）', () => {
    // 真实缺陷回归：HTTP 401 的响应体是 `{error:"…"}`（**没有 success 字段**），
    // 早期只判 `success === false`，于是把有用的鉴权提示替换成了误导性的
    // 「响应缺少 data 字段」。
    const parsed = parseClineBalanceResponse({
      error: "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.",
    })
    expect(parsed.rawBalance).toBeUndefined()
    expect(parsed.error).toContain('Unauthorized')
  })

  it('clineBearerValue 幂等（探针自身的前缀处理正确）', () => {
    const { credential } = entries[0]!
    expect(clineBearerValue(credential.access_token, CLINE)).toBe(credential.access_token)
  })
})
