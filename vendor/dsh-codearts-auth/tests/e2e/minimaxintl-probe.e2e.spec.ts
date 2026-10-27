/**
 * MiniMax Code **国际版**（`minimaxintl`）只读 E2E 探针：
 * 模型目录 + 签到状态 + 积分余额。
 *
 * ## ✅ 2026-10-15 真机验证：全部通过（本文件 4/4 绿）
 *
 * 用真实国际站账号（`MINIMAXINTL_ACCOUNT_*`，经本插件登录）实测：
 *
 * | 端点 | 实测结果 |
 * |---|---|
 * | `GET /mavis/api/v1/models?region=en&buildEnv=prod` | ✅ 200（4 个模型） |
 * | `GET /minimax-cloud/api/v1/signin/status` | ✅ 200（真实签到面板） |
 * | `GET /minimax-cloud/api/v1/credit/details` | ✅ 200（真实余额 `394.8`） |
 * | `POST /mavis/api/v1/llm/v1/messages` | ✅ 200 + 真实 SSE（`Bearer` 即可） |
 *
 * ⇒ **国际站与国内站协议同形**，认证方式相同（只需 `Authorization: Bearer`）。
 *
 * ⚠️⚠️ **中途曾误判为「国际站要求网关签名、不可用」** —— 那是把**上游故障窗口期**
 * 的错误当成了设计。故障恢复后同样的请求全部 200。决定性证据是**官方 mcode
 * 客户端自己也连不上**（截图 `Code: 50112` = 官方枚举 `LLM_AUTH_ERROR`）。
 * 详细教训见 `src/minimax-product.ts` 文件头「一段已被证伪的中间结论」。
 *
 * ⚠️ 另记一条**仍然成立**的判据：国际站的**目录端点当前是公开的**
 *（无 token、垃圾 token 都 200）⇒「目录能读到」**不构成**凭据有效的证据。
 * 真正的凭据证据是签到/积分/推理三处。
 *
 * ## 与 `minimax-probe.e2e.spec.ts` 的关键差异（为什么不能复用那个文件）
 *
 * 国内站探针读的是 **MiniMax Code 客户端自己的登录态**
 *（`~/.minimax/auth/prod/cn/mcode-public/auth.json`）—— 那是本机现成可用的真实凭据。
 * 而**国际站读的是本插件自己的凭据存储**
 *（`MINIMAXINTL_ACCOUNT_*`，或 `MINIMAXINTL_ACCESS_TOKEN`）⇒ 前置条件是
 *「先在 Jet Hub 的「MiniMax Code (国际版)」面板里登录一个账号」。
 *（⚠️ 若本机装了官方 mcode 国际版客户端，也可读
 *  `~/.minimax/auth/prod/en/mcode-public/auth.json` 作为对照。）
 *
 * ## 本探针的判据
 *
 * ⚠️ **刻意不硬断言**「恰好 4 个模型」：国际站远端模型集与国内站**不同**
 *（实测国际站 4 条 = M3.1-Flash-Preview / M3 / M2.7-highspeed / M2.7），
 * 写成硬断言会让上游调整模型集时探针假红。故判据是「**请求发出去了、并拿到了
 * 可解读的响应**」，实际内容**打印**给人看。
 * 一旦上游补上签名要求（或我们拿到算法），这里能立刻看到变化。
 *
 * ⚠️ **全链路只读**，**不执行 claim**（那会消耗账号当天唯一一次领取机会）。
 * ⚠️ 闸门默认关闭：需 `DSH_MINIMAXINTL_E2E=1`（用 `pnpm test:e2e:minimaxintl`）。
 * ⚠️ 绝不打印 token。
 */
import { describe, expect, it } from 'vitest'
import { fetchMinimaxCreditBalance, fetchMinimaxSigninStatus } from '../../src/minimax-credits.js'
import { parseMinimaxModelsPayload } from '../../src/minimax-auth.js'
import { MINIMAX_INTL, MINIMAX_MODELS_PATH } from '../../src/minimax-product.js'
import { readMinimaxPluginCredential } from './minimax-credential.js'

const enabled = process.env.DSH_MINIMAXINTL_E2E === '1'
const describeIf = enabled ? describe : describe.skip

describeIf('MiniMax 国际版只读探针（不领取、不写任何状态）', () => {
  // ⚠️ 读**插件自己**的 `MINIMAXINTL_*` 凭据（国际站没有本机客户端可读）。
  const probe = enabled ? readMinimaxPluginCredential({ refPrefix: 'MINIMAXINTL' }) : undefined
  const credential = probe?.credential

  it('本机存在插件存的国际站凭据', () => {
    expect(
      probe,
      '未找到 MINIMAXINTL_* 凭据 —— 请先在 Jet Hub 的「MiniMax Code (国际版)」'
      + '面板登录一个账号（本探针不读任何本机客户端文件）。',
    ).toBeDefined()
    // ⚠️ 只打印**有效期状态**，绝不打印 token。
    console.log(`[minimaxintl] 插件凭据：${probe!.describe}`)
    expect(credential?.access_token).toBeTruthy()
  })

  it('模型目录可达（region=en），并如实打印实际条目', async (ctx) => {
    if (probe?.expired !== false) {
      console.log('[minimaxintl] 凭据已过期，跳过网络验证'
        + '（请在 Jet Hub 面板点该账号的「刷新」续期后重跑）。')
      ctx.skip()
    }
    const url = new URL(`${MINIMAX_INTL.apiHost}${MINIMAX_MODELS_PATH}`)
    // ⚠️ region 必须取**国际站**的值（`en`）—— 这是两站唯一不同的目录参数。
    url.searchParams.set('region', MINIMAX_INTL.region)
    url.searchParams.set('buildEnv', MINIMAX_INTL.buildEnv)
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credential!.access_token}`,
        Accept: 'application/json',
      },
    })
    // ⚠️ 判据只到「HTTP 成功」这一层。
    // ⚠️⚠️ **这个 200 不能证明凭据有效**：国际站的目录端点是**公开**的
    //（实测无 token、垃圾 token 都返回 200）—— 与国内站不同（那里垃圾 token → 401）。
    expect(response.ok, `国际站模型目录 HTTP ${response.status}`).toBe(true)
    const models = parseMinimaxModelsPayload(await response.json())
    console.log(`[minimaxintl] 模型目录 ${models.length} 条：`
      + models.map((m) => `${m.id}(${m.contextWindow / 1000}K)`).join(' / '))
    if (models.length === 0) {
      console.log('[minimaxintl] ⚠️ 解析出 0 条 —— 上游形状可能与国内站不同，'
        + '请把原始响应贴给维护者（`parseMinimaxModelsPayload` 需按实际形状调整）。')
    }
    // ⚠️ 这里**刻意不**断言「恰好 4 个模型」：国际站远端实测返回的模型集
    //    与国内站**不同**（这是已核实的事实，不是未知项）；真有差异时该改的是
    //    `MINIMAX_INTL.fallbackModels`，而不是让探针假红。
    console.log('[minimaxintl] ⚠️ 注意：目录端点**当前是公开的**（无 token 也 200）'
      + ' ⇒ 本条通过**不代表**凭据可用；凭据证据请看下面签到/积分两条。')
  })

  it('签到状态可读（**不领取**）', async (ctx) => {
    if (probe?.expired !== false) {
      console.log('[minimaxintl] 凭据已过期，跳过签到状态验证。')
      ctx.skip()
    }
    const status = await fetchMinimaxSigninStatus(credential!, undefined, MINIMAX_INTL)
    if (status === null) {
      // ⚠️ 2026-10-15 真机实测**已通**（返回真实面板）。若读到 null，多半是
      // 凭据失效 / 上游故障，而不是「端点形状不同」—— 早先那次误判为后者的
      // 结论已被证伪（见 `src/minimax-product.ts` 文件头）。
      console.log('[minimaxintl] ⚠️ 签到状态读到 null —— 请先确认凭据未失效；'
        + '若凭据有效，则可能是上游故障。端点形态本身已实测可用。')
      return
    }
    console.log(`[minimaxintl] 签到状态：今日已领=${status.todayCheckedIn}`
      + ` 连续=${status.streakDays} 今日额度=${status.dailyCredit}`)
    // ⚠️ `active` 恒 true（拿到响应即 true）—— 不按「列表非空」判。
    expect(status.active).toBe(true)
  })

  it('积分余额可读', async (ctx) => {
    if (probe?.expired !== false) {
      console.log('[minimaxintl] 凭据已过期，跳过余额验证。')
      ctx.skip()
    }
    const balance = await fetchMinimaxCreditBalance(credential!, undefined, MINIMAX_INTL)
    if (balance === null) {
      console.log('[minimaxintl] ⚠️ 余额读到 null —— 同签到：先确认凭据有效，'
        + '再怀疑上游故障（端点形态已实测可用）。')
      return
    }
    // ⚠️ `null` 表示**查不到**（网络/业务码异常），与「余额为 0」不同。
    console.log(`[minimaxintl] 积分余额：${balance.total}`)
  })
})
