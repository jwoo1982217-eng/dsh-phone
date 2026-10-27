/**
 * `officeace-real-account-switch.e2e.spec.ts` —— **真实登录两个不同的华为账号**，
 * 验证「换账号登录」真的换出了**两个不同的号**（Gitee issue IKM741 的验收方式）。
 *
 * ## 为什么必须真机跑（单测锁不住这一条）
 *
 * 单测能锁「无痕窗口被调起」「占位条目与凭据的收口判据」「读数与凭据绑定」，
 * 但锁不住**一个事实**：换了无痕窗口之后，用户登进去的**第二个号到底是不是
 * 另一个号**。那只能由人真的登进去、再由**云侧下发的账号身份**来判。
 *
 * ## 判据（核心）
 *
 * `completeLogin` → `fetchModelInfo` 从云侧 `client-permission-validate` 拿回
 * `account_id` 并写进凭据。**同一个华为账号的多次登录，该 id 恒相同**
 * ——issue 正文实测：4 次登录的 `accountId` 与 `modelAppKey` 指纹**逐字节相同**
 * （`accountId` 去重后 1 个值）⇒
 *
 * ⇒ **两个不同的号 ⇒ 两个 `accountId` 必须不同**。
 *
 * ⚠️⚠️ **`refreshToken` 不同不可作为判据**：每次 OAuth 都会下发新的 token，
 * 即使无痕隔离失效、登的还是同一个号，它也**必然不同** ⇒ 拿它判会得到**假绿**。
 * 本探针因此把它**只打印、不断言**。
 *
 * ## 怎么跑
 *
 * ```bash
 * pnpm test:e2e:officeace-switch        # 闸门 DSH_OFFICEACE_SWITCH_E2E=1
 * ```
 *
 * ⚠️ 会**依次弹出两个无痕窗口**：
 * 1. 窗口 1 → 请用**第一个**华为账号登录；
 * 2. 登录成功后自动弹出窗口 2 → 请用**第二个（不同）**华为账号登录。
 *
 * ⚠️ 若窗口 2 **没有显示登录框**而是直接放行（自动登录），说明无痕隔离失效 ——
 * 那时两个 `accountId` 会相同，本用例**会红并点名该症状**（这正是 issue 的核心）。
 *
 * ## 两条安全检查（本探针真的会登录，故必须有）
 *
 * 1. **凭据只落内存 + 隔离目录**：`DSH_OFFICEACE_HOME` 指向临时目录 ⇒
 *    `persistLogin` 的兼容文件写入不会碰用户真实的 `~/.dsh-officeace/session.json`；
 *    且**全程哈希对拍**确认那份真实文件未被改写（本仓库既有纪律）。
 * 2. **TTL 归零后两个账号都必须存活**：登完之后把
 *    `DSH_OFFICEACE_PENDING_TTL_MS` 设成 0（= 「任何中间态都算已中止」）再刷新
 *    账号列表 ⇒ 两条条目都必须在。**这是拿真实凭据验证 IKM741 修法 ④ 的安全闸**
 *    ——「凭据已落库 ⇒ 绝不能被收口」。
 */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import * as officeaceAuth from '../../src/officeace-auth.js'

/** 闸门：本探针需要**人工登录两个真实账号**，故独立于其它 officeace e2e。 */
const E2E = process.env.DSH_OFFICEACE_SWITCH_E2E === '1'

/** 每次登录给人工留的窗口（5 分钟；客户端自己的轮询上限也是 5 分钟）。 */
const LOGIN_WINDOW_MS = 300_000
/** 轮询间隔（真实客户端是 1 秒；探针放慢以免把云侧打得太密）。 */
const POLL_INTERVAL_MS = 2_500

/**
 * ⚠️ **凭据目录必须隔离**：本探针会用**真实账号**走完整登录链，
 * 而 `persistLogin` 会顺手写一份兼容文件（`~/.dsh-officeace/session.json`）
 * —— 那是用户真实的华为云凭据所在。指向临时目录后，它写的副本与用户那份无关。
 *
 * ⚠️ 该 env 在本文件进程内设置（vitest 每个测试文件各一个 worker 进程），
 * 作用域仅限本探针。
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-officeace-switch-e2e-'))
process.env.DSH_OFFICEACE_HOME = isolatedHome

/**
 * 用户**真实**的兼容文件（路径直接按 `os.homedir()` 算，**不受**上面的 env 影响）
 * —— 用于事后哈希对拍，证明本探针没碰它。
 */
const realSessionFile = join(homedir(), '.dsh-officeace', 'session.json')
const realSessionHashBefore = existsSync(realSessionFile)
  ? createHash('sha256').update(readFileSync(realSessionFile)).digest('hex')
  : undefined

afterAll(() => {
  delete process.env.DSH_OFFICEACE_PENDING_TTL_MS
  try {
    rmSync(isolatedHome, { recursive: true, force: true })
  } catch { /* 清理失败不影响结论 */ }
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 造一个能注册 RPC 的最小 ctx；凭据用**可观测的内存 Map**（不碰真实凭据库）。 */
function makeCtx(): {
  ctx: Context
  credentials: Map<string, string>
  handler: () => ((req: Request) => Promise<Response>) | undefined
} {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'e2e-memory' }
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
    describe() { return [] },
  } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject =
    (_deps: string[], cb: (c: unknown) => void) => cb(ctx)
  return { ctx, credentials: store, handler: () => handler }
}

/** sha256 前 16 位（**只打印指纹，不落任何明文密钥**）。 */
function sha16(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '(空)'
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** 凭据里的 `maasBaseUrl` 主机（华为**按账号下发专属网关** ⇒ 不同号常常不同）。 */
function maasHostOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '(空)'
  try {
    return new URL(value).host
  } catch {
    return String(value)
  }
}

interface LoginOutcome {
  accountId: string
  credentialRef: string
  credential: Record<string, unknown>
  /**
   * 云侧下发的账号身份（`account_id`）**原值**。**这是判定「是不是两个号」的权威依据**。
   *
   * ⚠️⚠️ **只许在内存里比对，绝不许打印 / 不许进断言消息**（见
   * {@link cloudAccountIdPrefix} 与文件头的脱敏说明）。
   */
  cloudAccountId: string
  /**
   * {@link cloudAccountId} 的 **sha256 前 16 位**（打印与断言消息**只用这个**）。
   *
   * ⚠️ `account_id` 是**用户华为云账号的稳定标识**（32 位 hex）：它不能用来认证，
   * 但它是**持久标识符** —— 而本用例每跑一次就会把它打进终端 / CI 日志，
   * 任何开发者在自己机器上跑都会打**自己的**号。同文件里 `modelAppKey` /
   * `refreshToken` 早就走 `sha16` 脱敏，账号 id 当初漏了（同一文件里两套口径）。
   *
   * ⚠️ 指纹**不损失判据**：相等 ⇒ 原值相等，而「两个号」要证的正是**不等**，
   * 指纹不等几乎必然意味着原值不等（碰撞概率 2⁻⁶⁴，可忽略）。
   */
  cloudAccountIdPrefix: string
  modelAppKeyPrefix: string
  maasHost: string
  refreshPrefix: string
  elapsedMs: number
}

describe.runIf(E2E)('officeace e2e：真实登录两个不同的华为账号（换账号登录是否真的换号）', () => {
  it('两个无痕窗口各登一个号 ⇒ 云侧 accountId 必须不同', async () => {
    const { ctx, credentials, handler } = makeCtx()
    const pool = new AccountPool(ctx)
    // ⚠️ 用**真实**的 auth 模块（不是桩）——本探针验的就是真实登录链。
    registerJetHubRpc(ctx, pool, {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, minimax: {} as never, zcode: {} as never,
      gemini: {} as never,
      officeace: officeaceAuth as never,
    } as never, undefined)
    const h = handler()
    if (h === undefined) throw new Error('handler 未注册')
    const call = async (method: string, payload: unknown) => {
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = (await res.json()) as {
        result: { ok: boolean; value?: Record<string, unknown>; error?: { code: string; message: string } }
      }
      return body.result
    }

    /** 走一次完整登录：`account.create`（开无痕窗）→ 轮询 `login.poll` 到终态。 */
    const loginOne = async (label: string, ordinal: number): Promise<LoginOutcome> => {
      console.log(
        `\n[switch-e2e] ===== ${label} =====\n`
        + `[switch-e2e] 即将以**无痕窗口**打开华为云授权页（第 ${ordinal} 个窗口）。\n`
        + `[switch-e2e] 👉 请用**${label}**登录，并在窗口里完成授权。\n`
        + `[switch-e2e] ⚠️ 若窗口里**没有登录框**而是直接放行 ⇒ 无痕隔离失效，本用例会红。\n`,
      )
      const created = await call('account.create', { provider: 'officeace' })
      if (created.ok !== true) {
        throw new Error(
          `${label} 的 account.create 失败：`
          + `${created.error?.code ?? '?'} ${created.error?.message ?? '（无原因）'}`,
        )
      }
      const accountId = created.value?.accountId as string
      const incognitoOpened = created.value?.incognitoOpened
      expect(
        incognitoOpened,
        `${label}：宿主未能以无痕方式打开授权页（读不到默认浏览器 / spawn 失败）—— `
        + '此时客户端会回退到共享 cookie 的 window.open，换账号登录必然失效',
      ).toBe(true)
      console.log(`[switch-e2e] ${label}：窗口已打开（accountId=${accountId}），等待你在窗口里完成授权…`)

      const startedAt = Date.now()
      const deadline = startedAt + LOGIN_WINDOW_MS
      let settled: { done: boolean; success?: boolean; error?: string } | undefined
      let lastNotice = 0
      while (Date.now() < deadline) {
        const polled = await call('login.poll', { accountId })
        if (polled.ok !== true) {
          // `login.poll` 自身失败（宿主异常）⇒ 不打断轮询，但必须留痕。
          console.log(`[switch-e2e] ${label}：login.poll 报错（继续轮询）：${polled.error?.message ?? '?'}`)
          await sleep(POLL_INTERVAL_MS)
          continue
        }
        const value = polled.value as { done?: boolean; success?: boolean; error?: string } | undefined
        // ⚠️ 先判业务终态失败（`success === false`），再判 `done`（与客户端同序）。
        if (value?.success === false) {
          settled = { done: true, success: false, error: value.error }
          break
        }
        if (value?.done === true) {
          settled = { done: true, success: true }
          break
        }
        const waited = Date.now() - startedAt
        if (waited - lastNotice >= 30_000) {
          lastNotice = waited
          console.log(`[switch-e2e] ${label}：仍在等待授权（已等 ${Math.round(waited / 1000)} 秒）…`)
        }
        await sleep(POLL_INTERVAL_MS)
      }

      if (settled === undefined) {
        throw new Error(
          `${label}：${LOGIN_WINDOW_MS / 1000} 秒内未完成授权（或你关掉了窗口）。`
          + '请重新运行，并在窗口里完成登录授权。',
        )
      }
      if (settled.success !== true) {
        throw new Error(
          `${label} 登录失败（云侧给出的原因）：${settled.error ?? '（宿主未给出原因）'}`,
        )
      }

      const entry = pool.listAccountsByProvider('officeace').find((a) => a.id === accountId)
      const raw = entry === undefined ? undefined : credentials.get(entry.credentialRef)
      if (raw === undefined) {
        throw new Error(`${label}：登录报成功，但凭据没落地（凭据库键数=${credentials.size}）`)
      }
      const credential = JSON.parse(raw) as Record<string, unknown>
      return {
        accountId,
        credentialRef: entry!.credentialRef,
        credential,
        cloudAccountId: typeof credential.accountId === 'string' ? credential.accountId : '',
        // ⚠️ 打印与断言消息**只用指纹**；原值仅留在内存里做「云侧是否下发」的判定。
        cloudAccountIdPrefix: sha16(credential.accountId),
        modelAppKeyPrefix: sha16(credential.modelAppKey),
        maasHost: maasHostOf(credential.maasBaseUrl),
        refreshPrefix: sha16(credential.refreshToken),
        elapsedMs: Date.now() - startedAt,
      }
    }

    // ── 第 1 个号 ──────────────────────────────────────────────
    const first = await loginOne('第一个华为账号', 1)
    console.log(
      `\n[switch-e2e] ✅ 第一个号登录完成（耗时 ${Math.round(first.elapsedMs / 1000)} 秒）\n`
      + `[switch-e2e]   云侧 accountId : ${first.cloudAccountIdPrefix}（sha256 前 16 位，脱敏）\n`
      + `[switch-e2e]   modelAppKey    : ${first.modelAppKeyPrefix}\n`
      + `[switch-e2e]   MaaS 网关 host : ${first.maasHost}\n`
      + `[switch-e2e]   refreshToken   : ${first.refreshPrefix}\n`,
    )

    // 给人工一点准备时间，再开第二个窗口。
    console.log('[switch-e2e] 8 秒后打开**第二个**无痕窗口…\n')
    await sleep(8_000)

    // ── 第 2 个（必须不同的）号 ────────────────────────────────
    const second = await loginOne('第二个华为账号（必须与第一个不同）', 2)
    console.log(
      `\n[switch-e2e] ✅ 第二个号登录完成（耗时 ${Math.round(second.elapsedMs / 1000)} 秒）\n`
      + `[switch-e2e]   云侧 accountId : ${second.cloudAccountIdPrefix}（sha256 前 16 位，脱敏）\n`
      + `[switch-e2e]   modelAppKey    : ${second.modelAppKeyPrefix}\n`
      + `[switch-e2e]   MaaS 网关 host : ${second.maasHost}\n`
      + `[switch-e2e]   refreshToken   : ${second.refreshPrefix}\n`,
    )

    // ── 结论：对照表 ───────────────────────────────────────────
    const same = (a: string, b: string): string => (a === b ? '**相同**' : '不同')
    console.log(
      '\n[switch-e2e] ================= 两个号的对照 =================\n'
      + `[switch-e2e] 云侧 accountId : ${first.cloudAccountIdPrefix}  vs  ${second.cloudAccountIdPrefix}`
      + `   ⇒ ${same(first.cloudAccountIdPrefix, second.cloudAccountIdPrefix)}（指纹，脱敏）\n`
      + `[switch-e2e] modelAppKey    : ${first.modelAppKeyPrefix}  vs  ${second.modelAppKeyPrefix}`
      + `   ⇒ ${same(first.modelAppKeyPrefix, second.modelAppKeyPrefix)}\n`
      + `[switch-e2e] MaaS host      : ${first.maasHost}  vs  ${second.maasHost}`
      + `   ⇒ ${same(first.maasHost, second.maasHost)}\n`
      + `[switch-e2e] refreshToken   : ${first.refreshPrefix}  vs  ${second.refreshPrefix}`
      + `   ⇒ ${same(first.refreshPrefix, second.refreshPrefix)}（**不可作判据**，见文件头）\n`
      + '[switch-e2e] =====================================================\n',
    )

    // ⚠️ 凭据本身的隔离（多账号共存的根）：两条条目必须各有自己的 ref。
    expect(
      first.credentialRef,
      '两个号共用了同一个 credentialRef ⇒ 凭据会互相覆盖（多账号不成立）',
    ).not.toBe(second.credentialRef)
    expect(credentials.size, '两条凭据都必须在（各自一份）').toBe(2)

    /**
     * ⚠️⚠️ **核心判据**：两个不同的华为账号必须给出两个不同的云侧 `accountId`。
     *
     * 若相等（或都为空到无法区分）⇒ 说明**无痕隔离没生效**、两次登录其实是
     * **同一个号**（issue 的核心症状：`accountId` 去重后只有 1 个值）。
     */
    if (first.cloudAccountId.length > 0 && second.cloudAccountId.length > 0) {
      expect(
        second.cloudAccountId,
        `两个号给出了**同一个**云侧 accountId（${second.cloudAccountIdPrefix}）⇒ `
        + '无痕窗口没有隔离会话，第二次登录实际复用/命中了同一个华为账号 '
        + '（issue IKM741 的核心症状；请确认窗口 2 里是否显示了登录框）',
      ).not.toBe(first.cloudAccountId)
    } else {
      // 云侧没下发 account_id 时无法据此判定 ⇒ 如实报告，并退到「网关/密钥对」这条旁证。
      console.log(
        '[switch-e2e] ⚠️ 云侧未下发 account_id（无法用它判定）⇒ 退到旁证：'
        + 'modelAppKey 与 MaaS 网关 host 至少一项必须不同。',
      )
      expect(
        first.modelAppKeyPrefix !== second.modelAppKeyPrefix
        || first.maasHost !== second.maasHost,
        '云侧 account_id 缺失，而 modelAppKey 与网关 host 又完全相同 ⇒ '
        + '两次登录无法区分为两个号（请人工核对窗口 2 里登的是不是另一个号）',
      ).toBe(true)
    }

    // ── 安全检查 ①：hash 对拍，证明用户真实凭据文件未被改写 ──────
    const realSessionHashAfter = existsSync(realSessionFile)
      ? createHash('sha256').update(readFileSync(realSessionFile)).digest('hex')
      : undefined
    expect(
      realSessionHashAfter,
      '本探针改写了用户**真实**的 ~/.dsh-officeace/session.json —— '
      + '隔离失效（DSH_OFFICEACE_HOME 未生效）',
    ).toBe(realSessionHashBefore)
    console.log(`[switch-e2e] ✅ 用户真实 session.json 未被改写（哈希 ${realSessionHashBefore ?? '(不存在)'}）`)

    // ── 安全检查 ②：TTL 归零后两条都必须存活（验证 IKM741 修法 ④ 的安全闸）──
    process.env.DSH_OFFICEACE_PENDING_TTL_MS = '0'
    await call('account.list', { provider: 'officeace' })
    const survived = pool.listAccountsByProvider('officeace')
    expect(
      survived.map((a) => a.id).sort(),
      '「TTL 已过」只是**推断**用户不会再来；这两个号**凭据已落库** ⇒ '
      + '收口必须放行它们（漏掉这条安全闸 = 把刚登好的账号连凭据一起销毁，不可逆）',
    ).toEqual([first.accountId, second.accountId].sort())
    console.log('[switch-e2e] ✅ TTL 归零后两个账号都存活（安全闸生效）')
    console.log('\n[switch-e2e] 🎉 结论：换账号登录确实换出了两个不同的号。\n')
  }, 900_000)
})
