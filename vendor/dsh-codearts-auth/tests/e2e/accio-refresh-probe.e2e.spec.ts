/**
 * Accio（阿里）**续期轮换语义**探针 —— 回答 `docs/agent-notes/providers-accio.md` §10 U-A。
 *
 * ## ⚠️⚠️ 三条硬规矩（本文件存在的全部理由）
 *
 * ### 1. 只碰**我们自己**的凭据，绝不碰用户 IDE 的会话
 *
 * 参考实现明确记录「**刷新会轮换 `refresh_token`**」。若拿用户 Accio 桌面端
 * 的会话去试，轮换后那份 `refresh_token` 即失效 ⇒ **用户桌面端的登录被弄坏**。
 *
 * ⇒ 本探针**从不读取**用户的 Accio 桌面端数据（`credentials.enc` / DPAPI），
 * 也**从不读取**账号池里的 `ACCIO_ACCOUNT_*`（那可能是用户在 Jet Hub 登录的
 * 真实账号，轮换掉同样会打断它）。它**现场跑一次自己的 PKCE 登录**拿到一份
 * 凭据，且那份凭据只写进**内存**凭据提供者（`MemoryCredentials`），
 * **一个字节都不落盘** —— 轮换掉它不破坏任何东西。
 *
 * ### 2. 无法确认「凭据是插件自己取得的」⇒ **skip，不运行**
 *
 * `ownershipProven()` 是唯一的门禁，判据有**三条，缺一不可**：
 * - 凭据来自 `AccioAuth.startLogin` 的**内存**落点（不是环境变量、不是文件）；
 * - `DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON` **未设置** —— 环境变量可以装一份
 *   从 IDE 复制来的令牌，那种来源**结构上无法证明**归属；
 * - 凭据带 `region` 字段（只有本插件的 `finishLogin` 会写它）。
 *
 * 任一不成立就 `ctx.skip()` 并打印原因 —— **宁可什么都不测，也不赌一把**。
 *
 * ### 3. 判「成功」不能只看 HTTP 200
 *
 * 与另两个探针同款：上游的认证/额度失败是 **HTTP 200 + 流内 `error_code: 402`**。
 * 本探针的对应形态是**续期信封**：`{success:false, code, message}`
 * —— `unwrapTokenEnvelope` 对 `success !== true` 抛错，故**成功必须拿到
 * `success:true` 且 `data` 里有 `accessToken` / `refreshToken` / `expiresAt`
 * 三样**，而不是「HTTP 200 就算过」。
 *
 * ## 要回答的三个问题（§10 U-A）
 *
 * | # | 问题 | 判据 |
 * |---|---|---|
 * | Q1 | 续期是否**轮换** `refresh_token`（新 != 旧）？ | 逐字节比对两份令牌 |
 * | Q2 | 旧的 `refresh_token` 轮换后是否**立即失效**？ | 拿旧的再试一次，按 `isAccioTerminalRefreshError` 归类 |
 * | Q3 | 续期是否**顺带**触发当日额度发放？ | 续期前后各读一次订阅的 `daily` 桶 |
 *
 * ## ⚠️ Q3 的固有局限（如实登记，不要把它读成否定结论）
 *
 * 本探针在续期**之前**先做了一次登录，而「每日 200 积分由**登录**触发发放、
 * 24 小时一次、不累积」（笔记 §6）⇒ 那一刻当天的额度**很可能已经发过了**。
 * 因此「续期前后 `daily` 不变」**推不出**「续期不会触发发放」——
 * 它只说明「本次续期没有让 `daily` 增加」。真要把这条答死，需要等一次跨日窗口，
 * 或用一个当天尚未发放的账号。故 Q3 是**诊断性观测**（打印 + 断言结构不变式），
 * **不**断言「一定不发放」。
 *
 * 闸门：`DSH_ACCIO_REFRESH_E2E=1` **且** `DSH_ACCIO_REFRESH_E2E_CONFIRM=yes`。
 * 用 `pnpm test:e2e:accio-refresh` 运行（两个变量已内置）。
 *
 * ⚠️ 本探针**不发任何模型请求**（零积分消耗），但会**真实消费一次
 * `refresh_token`**（这正是被测对象）。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccioAuth, isAccioTerminalRefreshError } from '../../src/accio-auth.js'
import { openBrowser, refreshAccioCredential } from '../../src/accio-oauth.js'
import { ACCIO, ACCIO_REQUEST_TIMEOUT_MS, ACCIO_SUBSCRIPTION_PATH } from '../../src/accio-product.js'
import { isAccioRefreshable, type AccioCredential } from '../../src/accio.js'

const RUN = process.env.DSH_ACCIO_REFRESH_E2E === '1'
  && process.env.DSH_ACCIO_REFRESH_E2E_CONFIRM === 'yes'
const suite = RUN ? describe : describe.skip

/** 本次现场登录的凭据 ref（**只写进内存**，永不落盘）。 */
const PROBE_REF = 'ACCIO_E2E_REFRESH_PROBE'

/**
 * 内存凭据提供者（形状与 `ctx.credentials` 一致）。
 *
 * ⚠️ 这是「不碰用户凭据」这条硬规矩的**实现手段**，不是便利设施：
 * 用真实凭据存储的话，一次续期探针就会把轮换后的新凭据写进用户的
 * `.credentials.yaml`，等于**静默替换掉用户账号的登录态**。
 */
class MemoryCredentials {
  private readonly store = new Map<string, string>()

  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'accio-e2e-memory' }
  }

  async describe(ref: string) {
    return { configured: this.store.has(ref), writable: true }
  }

  async set(ref: string, value: string) {
    this.store.set(ref, value)
  }

  async unset(ref: string) {
    this.store.delete(ref)
  }
}

/**
 * 一次现场登录的结果（跨用例共享；`it` 在同一个文件里顺序执行）。
 *
 * ⚠️ 它是**模块级可变状态**，因为「续期会轮换 refresh_token」这条被测语义
 * 天然要求 Q1/Q2/Q3 共用**同一份**凭据链 —— 每个用例各登录一次会让轮换
 * 语义根本观察不到。
 */
interface ProbeState {
  /** 登录取得的原始凭据（`refresh_token` 记作「旧」）。 */
  original?: AccioCredential
  /** 第一次续期的结果（`refresh_token` 记作「新」）。 */
  refreshed?: AccioCredential
  /** 归属证明失败的原因（非空 ⇒ 后续用例一律 skip）。 */
  ownershipFailure?: string
}

const state: ProbeState = {}

/**
 * ⚠️ **唯一的归属门禁**：证明这份凭据是**本插件自己**取得的。
 *
 * 三条判据缺一不可（见文件头）：
 * 1. `DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON` 未设置 —— 环境变量可以装一份从
 *    用户 IDE 复制来的令牌，那种来源**结构上无法证明**归属；
 * 2. 凭据带 `region` —— 只有本插件的 `finishLogin` 会写这个字段
 *    （`AccioCredential` 的其余字段 IDE 令牌也有）；
 * 3. 凭据可续期（`refresh_token` 非空）—— 否则本探针无事可做。
 *
 * @returns 失败原因；`undefined` 表示归属已证明。
 */
function ownershipFailureOf(credential: AccioCredential | undefined): string | undefined {
  const fromEnv = process.env.DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return '检测到 DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON —— 环境变量里的凭据'
      + '**结构上无法证明**是本插件取得的（可能是从 Accio 桌面端复制来的）。'
      + '本探针会轮换 refresh_token，绝不对来源不明的凭据运行。请取消该变量。'
  }
  if (credential === undefined) return '现场登录没有拿到凭据'
  // ⚠️ 按 `unknown` 读：类型上 `region` 是必填的 `AccioRegion`，但**运行时**
  // 一份从别处复制来的令牌可能根本没有这个键 —— 类型标注不是运行时证据。
  const region: unknown = (credential as { region?: unknown }).region
  if (typeof region !== 'string' || region === '') {
    return '凭据缺 `region` 字段 —— 那是本插件 finishLogin 独有的字段，'
      + '缺它说明这份凭据不是本插件的 PKCE 登录产物。'
  }
  if (!isAccioRefreshable(credential)) return '凭据没有 refresh_token，本探针无事可做'
  return undefined
}

/**
 * 现场跑一次**本插件的 PKCE 登录**，凭据只落进内存。
 *
 * ⚠️ 刻意**不**读账号池、**不**读环境变量、**不**读 Accio 桌面端数据。
 */
async function loginOwnCredential(): Promise<{ credential?: AccioCredential; failure?: string }> {
  const ctx = new Context()
  const credentials = new MemoryCredentials()
  ctx.provide('credentials', credentials as never)
  const auth = new AccioAuth(ctx)
  try {
    const started = await auth.startLogin({ refName: PROBE_REF })
    console.log('[accio-refresh] ⚠️ 本探针会**轮换** refresh_token，因此只用下面这次'
      + '**本插件自己的 PKCE 登录**取得的凭据（只进内存，不落盘）：')
    console.log(started.loginUrl)
    openBrowser(started.loginUrl)
    try {
      await started.result
    } finally {
      started.close()
    }
    const resolved = await credentials.resolve(PROBE_REF)
    if (resolved === undefined) return { failure: '登录回调已到达，但内存里没有凭据' }
    return { credential: JSON.parse(resolved.value) as AccioCredential }
  } catch (error) {
    return { failure: `现场登录失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    auth.stop()
  }
}

/** 一次订阅读数里与「每日额度」有关的部分（读不到就是 `undefined`，**不编造 0**）。 */
interface DailyReading {
  dailyTotal?: number
  dailyRemaining?: number
  failure?: string
}

/** 读一次订阅信封（**只读**，零额度）。 */
async function readDailyBucket(credential: AccioCredential): Promise<DailyReading> {
  try {
    const response = await fetch(
      `${ACCIO.gatewayBaseUrl}${ACCIO_SUBSCRIPTION_PATH}`
      + `?${new URLSearchParams({ accessToken: credential.access_token }).toString()}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      },
    )
    const text = await response.text()
    const envelope = JSON.parse(text) as {
      success?: unknown
      // ⚠️ 类型里**显式带上 `null`**：JSON 的 `null` 是合法取值，不写进来
      // 下一行的 `data === null` 判据会被 TS 判为「无重叠比较」。
      data?: { entitlement?: { daily?: { total?: unknown; remaining?: unknown } } } | null
    }
    // ⚠️ 判据不能只看 HTTP 200：信封 `success:false` 是失败（见文件头）。
    if (envelope.success === false) {
      return { failure: `订阅信封 success:false：${text.slice(0, 200)}` }
    }
    // ⚠️ **`null` 也要拦**：`typeof null === 'object'`，只判 `undefined` 会让
    // `data: null` 落到下一行、在 `envelope.data.entitlement` 上抛 `TypeError`，
    // 被下面的 `catch` 转成一条「订阅查询异常」——判据本身就被绕过了。
    // （`accio-probe` 的同一处判据已带 `not.toBeNull()`，两处必须同构。）
    if (envelope.data === undefined || envelope.data === null) {
      return { failure: `订阅响应没有 data：${text.slice(0, 200)}` }
    }
    const daily = envelope.data.entitlement?.daily
    const out: DailyReading = {}
    if (typeof daily?.total === 'number' && Number.isFinite(daily.total)) out.dailyTotal = daily.total
    if (typeof daily?.remaining === 'number' && Number.isFinite(daily.remaining)) {
      out.dailyRemaining = daily.remaining
    }
    return out
  } catch (error) {
    return { failure: `订阅查询异常：${error instanceof Error ? error.message : String(error)}` }
  }
}

suite('Accio 续期轮换语义探针（只用本插件自己的凭据；不发模型请求）', () => {
  it('取得一份**我们自己的**凭据（现场 PKCE 登录，只进内存）', async (ctx) => {
    const { credential, failure } = await loginOwnCredential()
    const ownershipFailure = failure ?? ownershipFailureOf(credential)
    if (ownershipFailure !== undefined) {
      state.ownershipFailure = ownershipFailure
      // ⚠️ **skip 而不是 fail**：无法证明归属时正确的动作是「什么都不做」。
      console.log(`[accio-refresh] ⚠️ 无法证明凭据归属，跳过全部续期验证：${ownershipFailure}`)
      ctx.skip()
    }
    state.original = credential
    console.log(`[accio-refresh] 已取得本插件自己的凭据：region=${String(credential!.region)}`
      + ` access_token 长度=${credential!.access_token.length}`
      + ` refresh_token 长度=${credential!.refresh_token.length}`
      + ` expires_at=${new Date(credential!.expires_at).toISOString()}`)
    // ⚠️ 只打印**长度**，绝不打印令牌本体。
    expect(credential!.refresh_token.length).toBeGreaterThan(0)
  }, 660_000)

  it('Q1：续期是否轮换 refresh_token（新 != 旧）', async (ctx) => {
    if (state.ownershipFailure !== undefined) return ctx.skip()
    const original = state.original
    if (original === undefined) return ctx.skip()

    // ⚠️ 直接调 `src/accio-oauth.ts` 的续期实现（不经 `AccioAuth` 的 lead-time
    // 门禁 —— 刚登录的凭据远未临期，走服务层会被「本轮不刷」短路掉，什么也测不到）。
    //
    // ⚠️ **这一次失败刻意让它抛出去**（不 catch、不 skip）：Q1 是本探针的**首要**
    // 问题，而该端点此前**从未被实测过**（`docs/agent-notes/providers-accio.md` §2.8）。
    // 「续期端点不接受我们的请求形状」正是一条必须被看见的结论，不该被静默跳过。
    const refreshed = await refreshAccioCredential({ credential: original })
    state.refreshed = {
      ...original,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
      ...refreshed.sgcookie === undefined ? {} : { sgcookie: refreshed.sgcookie },
    }

    // ⚠️ 判据一：成功必须是 `success:true` + 三样字段齐全 ——
    // `refreshAccioCredential` 内部已按信封判过（`unwrapTokenEnvelope` 对
    // `success !== true` 抛错），这里再逐条钉住返回值的形状。
    expect(refreshed.access_token, '续期响应缺 accessToken').toBeTruthy()
    expect(refreshed.refresh_token, '续期响应缺 refreshToken').toBeTruthy()
    expect(refreshed.expires_at, '续期响应缺 expiresAt').toBeGreaterThan(0)

    const rotated = refreshed.refresh_token !== original.refresh_token
    const accessRotated = refreshed.access_token !== original.access_token
    console.log('[accio-refresh] Q1 答案：'
      + `refresh_token ${rotated ? '**被轮换**（新 != 旧）' : '未轮换（新 == 旧）'}；`
      + `access_token ${accessRotated ? '被轮换' : '未轮换'}；`
      + `expires_at ${new Date(original.expires_at).toISOString()}`
      + ` → ${new Date(refreshed.expires_at).toISOString()}`)

    // ⚠️ 这里**只记录答案，不断言方向**：Q1 问的就是「是否轮换」，
    // 把「必须轮换」写成断言会让一个「上游改了签名」的发现变成红用例，
    // 而不是一份可读的实测结论。真正的判据在 Q2（旧的是否立即失效）——
    // 那一条才是决定 `SerialQueue` 是否必需的依据。
    //
    // ⚠️ **也不断言「新 expires_at 不早于旧的」**：续期与登录下发的 TTL
    // 完全可能不同（续期给一个更短的窗口是常见做法），把它写成断言会得到一个
    // 与「轮换语义」无关的假阴性。过期时间只**打印**，由人判读。
  }, 60_000)

  it('Q2：旧的 refresh_token 在轮换后是否立即失效（拿旧的再试一次）', async (ctx) => {
    if (state.ownershipFailure !== undefined) return ctx.skip()
    const original = state.original
    // ⚠️ **必须确认 Q1 真的续过一次**：否则下面拿的「旧」令牌其实从未被消费，
    // 「仍被接受」会被读成「轮换后不失效」——一个纯粹由跳过造成的假答案。
    if (original === undefined || state.refreshed === undefined) {
      console.log('[accio-refresh] Q2 跳过：Q1 没有完成过一次真实续期，'
        + '此刻的「旧」令牌从未被消费，测它得不到任何结论。')
      return ctx.skip()
    }

    // ⚠️ 这一步会**消费**旧令牌（它此刻已因 Q1 的续期而失效）。
    // 这正是被测对象 —— 但必须**捕获**结果，不能让它把用例打红：
    // 「旧的仍可用」是一个**合法答案**，不是测试失败。
    let outcome: 'rejected' | 'accepted'
    let detail = ''
    try {
      const second = await refreshAccioCredential({ credential: original })
      outcome = 'accepted'
      detail = `新的 access_token 长度=${second.access_token.length}`
    } catch (error) {
      outcome = 'rejected'
      detail = error instanceof Error ? error.message : String(error)
    }

    // ⚠️ 归类复用**生产判据** `isAccioTerminalRefreshError`（终态 = 服务端明确说
    // 「这份 refresh_token 不认了」），不在这里另写一套字符串匹配
    // ——「同一份语义两套判据」是本仓库首条红线。
    const terminal = outcome === 'rejected' && isAccioTerminalRefreshError(new Error(detail))
    console.log('[accio-refresh] Q2 答案：拿**旧**的 refresh_token 再试一次 → '
      + `${outcome === 'accepted' ? '⚠️ **仍被接受**（未立即失效）' : '被拒绝'}`
      + `${outcome === 'accepted' ? '' : `；是否终态错误=${terminal}`}`
      + `${detail === '' ? '' : `；服务端原文：${detail.slice(0, 300)}`}`)

    if (outcome === 'rejected') {
      // 被拒时**必须**是「指向 refresh_token 本身」的终态错误，而不是
      // 网关抖动 / 403 / 超时。判据窄是刻意的：把抖动读成终态会把好账号标死
      // （codearts 的真实事故形态）。
      expect(
        terminal,
        `⚠️ 旧的 refresh_token 被拒，但服务端原文**不匹配**任何终态标记`
        + `（说明那可能是网关抖动而非令牌失效，不该据此标死账号）：${detail}`,
      ).toBe(true)
    }
    // ⚠️ 「仍被接受」这条分支**刻意不失败**：它恰恰是「不需要 SerialQueue」的
    // 反证。答案写进日志，由人读；把观测项写成断言会让探针无法报告新发现。
    //
    // ⚠️ 这里**刻意没有** `expect(['rejected','accepted']).toContain(outcome)` ——
    // `outcome` 的类型就是那个字面量联合，那条断言恒真、零判别力。
    // 本用例真正的判据是上面 `outcome === 'rejected'` 分支里的 `terminal`。
  }, 60_000)

  it('Q3：续期是否顺带触发当日额度发放（诊断性观测，见文件头的局限）', async (ctx) => {
    if (state.ownershipFailure !== undefined) return ctx.skip()
    const refreshed = state.refreshed
    if (refreshed === undefined) return ctx.skip()

    // 续期**之前**的读数只能取「第一次续期刚完成」那一刻的近似 ——
    // 因为 Q1 已经发过续期了。这里改成：拿新凭据读一次，再续期一次，再读一次。
    // 两次读数之间唯一的变量就是「一次续期」，故它是一次**干净的对照**。
    const before = await readDailyBucket(refreshed)
    if (before.failure !== undefined) {
      console.log(`[accio-refresh] Q3 无法判定：续期前读数失败（${before.failure}）`)
      return ctx.skip()
    }

    // ⚠️ 这一次续期**捕获失败**：Q3 是**诊断性观测**（见文件头局限），
    // 而 Q2 可能刚消费过一份令牌（若服务端按「令牌族」轮换，`refreshed` 也可能
    // 被牵连失效）。把一次与 Q3 问题无关的续期失败变成红用例，只会掩盖真正的答案。
    let rotatedAgain: AccioCredential
    try {
      const second = await refreshAccioCredential({ credential: refreshed })
      rotatedAgain = {
        ...refreshed,
        access_token: second.access_token,
        refresh_token: second.refresh_token,
        expires_at: second.expires_at,
        ...second.sgcookie === undefined ? {} : { sgcookie: second.sgcookie },
      }
    } catch (error) {
      console.log('[accio-refresh] Q3 无法判定：对照用的续期失败（'
        + `${error instanceof Error ? error.message : String(error)}）`)
      return ctx.skip()
    }
    state.refreshed = rotatedAgain

    const after = await readDailyBucket(rotatedAgain)
    if (after.failure !== undefined) {
      console.log(`[accio-refresh] Q3 无法判定：续期后读数失败（${after.failure}）`)
      return ctx.skip()
    }

    const deltaTotal = (after.dailyTotal ?? 0) - (before.dailyTotal ?? 0)
    const deltaRemaining = (after.dailyRemaining ?? 0) - (before.dailyRemaining ?? 0)
    const increased = deltaTotal > 0 || deltaRemaining > 0
    console.log('[accio-refresh] Q3 答案：'
      + `daily.total ${String(before.dailyTotal)} → ${String(after.dailyTotal)}（Δ${deltaTotal}）；`
      + `daily.remaining ${String(before.dailyRemaining)} → ${String(after.dailyRemaining)}（Δ${deltaRemaining}）`
      + `；判定=${increased
        ? '**续期触发了发放**'
        : '本次续期未让 daily 增加（⚠️ 推不出「续期不发放」—— 见文件头局限：'
          + '本探针之前刚登录过，当天额度很可能已发放且 24h 内不累积）'}`)

    // ⚠️ 只断言**结构不变式**：续期不该**消耗**积分。
    // 不断言「一定增加」：当天额度已发放时它本就不会增加，断言会得到假阴性。
    expect(deltaTotal, '续期后 daily.total 变小了 —— 续期不该消耗额度').toBeGreaterThanOrEqual(0)
    expect(deltaRemaining, '续期后 daily.remaining 变小了 —— 续期不该消耗额度')
      .toBeGreaterThanOrEqual(0)
  }, 120_000)

  it('⚠️ 归属证明的门禁本身有判别力（三条判据各自能拦住）', () => {
    const base: AccioCredential = {
      access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000, region: 'cn',
    }
    // 正例：完整的自有凭据必须**通过**（否则上面的门禁恒拦，整份探针永远 skip）。
    expect(ownershipFailureOf(base), '正例不该被拦').toBeUndefined()
    // 判据 2：缺 region（IDE 令牌就没有这个字段）。
    expect(ownershipFailureOf({ ...base, region: undefined as never })).toContain('region')
    // 判据 3：没有 refresh_token。
    expect(ownershipFailureOf({ ...base, refresh_token: '' })).toContain('refresh_token')
    // 判据 1：环境变量里的凭据来源无法证明 —— 必须被拦。
    const previous = process.env.DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON
    process.env.DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON = '{"access_token":"x"}'
    try {
      expect(ownershipFailureOf(base), '⚠️ 环境变量提供的凭据必须被拦').toContain(
        'DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON',
      )
    } finally {
      if (previous === undefined) delete process.env.DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON
      else process.env.DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON = previous
    }
  })
})
