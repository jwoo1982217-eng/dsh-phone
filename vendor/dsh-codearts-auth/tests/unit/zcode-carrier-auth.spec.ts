/**
 * 二期 Task 5：**把内部载体接进生产路径**的接线用例。
 *
 * ## 本文件锁住的五件事（都是「原语对但没接上」的高发区）
 * 1. ★ **需求位归 claim（领取）路径**（本任务的核心验收物，2026-09-29 修正）：
 *    ZCode **3.14.4 起上游不再对模型请求校验 captcha**（6 个采样点：不带验证头也
 *    HTTP 200，官方更新说明同口径），而 `/zcode-plan/billing/claim` **始终强制索要**
 *    （带非法 captcha 与不带 captcha 都回 `400/3007`，校验前置于 plan 校验）
 *    ⇒ 置位点在推理侧是**死触发点**（永远不撞 `3007` ⇒ 需求位恒假 ⇒ client 永不产
 *    ⇒ 内部载体接了个空壳），必须跟着 claim 走。
 *    行为用例锁「进入领取窗口就把 param 吃进槽」+「窗口结束即清位」；
 *    源码用例锁「`try` 里置、`finally` 里清」这一对（漏清位是**白烧设备配额**的最坏形态）。
 * 2. ★ **反向看守**：`src/zcode-adapter.ts` 里**不得**再出现 `setCaptchaDemand(` ——
 *    推理侧置位会让 client 在上游根本不索要验证的窗口里空转产出
 *    （阿里云同设备每小时 150 次，见 `src/captcha-backoff.ts`）。
 * 3. ★ **`isZcodeCaptchaRejected` 的防御分支不许被删**：当前版本走不到，但上游随时
 *    可以再开启校验，那时没有它就是「消息发不出去 + 一次 RATE_LIMIT 退避」。
 * 4. **归因纪律**：只有**内部来源**的 param 被拒才记 `internalRejected`；
 *    chromium 的 param 被拒是「时效/信誉」问题，与载体无关（见 `captcha-carrier.ts` 文件头）。
 * 5. **`DSH_ZCODE_INTERNAL_CARRIER=0`** ⇒ 既不等待也不取内部槽（等价一期行为）。
 *
 * ## ⚠ 凭据来源只有一处（2026-10-05 起）
 *
 * 本文件的 `ZcodeAuth` 早期靠构造选项 `readCredential` 注入凭据，那条注入点的
 * 语义是「回退去读本机官方 ZCode 客户端的凭据」，已随「不读本机 ZCode 数据」
 * 的用户决策**整体删除**（连同 `adoptOfficialCredential` / `adoptIntoOrphanAccount`
 * 那套「把本机凭据收编进账号池」的自愈链路）。⇒ 凭据改由**真实的
 * `ctx.credentials`** 供给（`makeWired` 里的 `FakeCredentials`，见其注释），
 * 防回退的锁在 `tests/unit/zcode-no-local-credential-read.spec.ts`。
 *
 * ## 反向验证（2026-10-02 实跑，逐组记录见报告）
 * - 去掉 `DSH_ZCODE_INTERNAL_CARRIER=0` 的短路 ⇒ 见报告；
 * - 删掉 claim 入口 `finally` 里的清位 ⇒ 见报告；
 * - 把需求位又挪回 `src/zcode-adapter.ts` ⇒ 第 2 条反向看守变红（见报告）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { internalCarrierEnabledFromEnv, ZcodeAuth } from '../../src/zcode-auth.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { CARRIER_REJECT_DISABLE_THRESHOLD } from '../../src/captcha-carrier.js'
import type { CarrierOutcome } from '../../src/captcha-carrier.js'
import {
  captchaDemand,
  PARAM_MAX_AGE_MS,
  putSuppliedParam,
  resetCaptchaSupply,
  setCaptchaDemand,
} from '../../src/captcha-supply.js'
import {
  captchaRequirementKey,
  noteCaptchaRequired,
  resetCaptchaRequirementMemory,
} from '../../src/captcha-requirement.js'
import { ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { ZcodeCredential } from '../../src/zcode.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const authSource = readFileSync(resolve(HERE, '../../src/zcode-auth.ts'), 'utf8')
const adapterSource = readFileSync(resolve(HERE, '../../src/zcode-adapter.ts'), 'utf8')
const indexSource = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')

/** 需求记忆的基准时刻（注入给适配器的 `now`；**只**给记忆用，见 `ZcodeAdapterOptions.now`）。 */
const T0 = 1_700_000_000_000
const MODEL = 'GLM-5.3-Flash'
const ACCOUNT = 'acct-A'
const CONFIG = { region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' }
const CREDENTIAL: ZcodeCredential = { zcode_jwt: 'a.b.c', device_mid: 'mid-A', source: 'plugin' }

/**
 * 内存凭据存储（`ctx.credentials` 的等价桩）。
 *
 * ⚠ 2026-10-05 起凭据**只有一个来源**：插件自己写进 `ctx.credentials` 的那份
 * （`ZcodeAuthOptions.readCredential` 那个「回退读本机官方客户端」的注入点已随
 * 「不读本机 ZCode 数据」的决策整体删除）。`claimDaily` 等领取路径走
 * `current()` 拿凭据 ⇒ 取不到就整条早退成 `failed` ⇒ 本文件所有 claim 用例
 * 都必须先把一份**可用的**凭据放进这个 store（`zcode_jwt` 与 `device_mid`
 * 都非空，`isUsableZcodeCredential` 的两条判据，见 `src/zcode.ts`）。
 *
 * 形态照抄 `tests/unit/zcode-credential-resolution.spec.ts` 的同名桩。
 */
class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/**
 * 过 `validateCaptchaParam` 的假 param（长度 ≥200 + base64 解出 JSON +
 * `certifyId` + `securityToken`≥50，三条判据见 `src/zcode-captcha.ts`）。
 *
 * ⚠ 供给槽本身只判「非空」（`putSuppliedParam`），这里仍造合法形状：
 * 让「内部 param 被误当成降级产物丢掉」这类漂移不会以假乱真地放过用例。
 */
function fakeParam(tag: string): string {
  const body = JSON.stringify({ certifyId: tag, sceneId: CONFIG.sceneId, securityToken: `${tag}-${'t'.repeat(128)}` })
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  if (encoded.length < 200) throw new Error(`假 param 太短（${String(encoded.length)}）`)
  return encoded
}

/** 一个能正常结束的 Anthropic SSE 响应（与 `zcode-captcha-lazy.spec.ts` 同形）。 */
function okSse(): Response {
  const text = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 上游索要验证（`3007`）。 */
function captchaRequiredError(): Response {
  return new Response('{"code":3007,"msg":"captcha verify failed"}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 真实的 `ZcodeAuth` + 真实的 `CaptchaCarrier` + 真实的供给槽 + 真实的 `ZcodeAdapter`，
 * 只把**最外层的两台设备**换成桩：
 * - chromium 浏览器（`captchaBrowser` 私有字段，同 `zcode-captcha-guard.spec.ts` 的换法）；
 * - 上游 `fetch`（桩响应队列，**用尽即抛**，见 `zcode-captcha-lazy.spec.ts` 的理由）。
 *
 * ⚠ 为什么不打桩 `CaptchaCarrier`：本任务要验的正是「**接上了没有**」，
 * 桩掉载体链就变成「我调用了我自己写的桩」——同义反复。
 *
 * ⚠ 退避闸门 / `captchaQueue` / 预取池全是真的 ⇒ 「绕过 captchaQueue」那条变异有网。
 */
/**
 * 领取路径的上游桩：按 URL 分派（激活上报 ×2 → preview → 逐 plan claim）。
 *
 * ⚠ 逐 plan 记下两样东西，用于锁「每个 plan 各拿一个 param」与「需求位在窗口内为真」：
 *   - 发给 `/billing/claim` 的 `x-aliyun-captcha-verify-param`；
 *   - 那一刻的需求位快照。
 * ⚠ **零网络**：URL 不在三条已知路由里就直接抛 —— 静默回 200 会让「以为走了 claim
 *   其实没走」的用例变成同义反复。
 */
function makeClaimFetch(
  planIds: readonly string[],
  seen: { params: string[]; demandAtClaim: boolean[] },
  options: { firstClaimRejected?: boolean; alwaysRejectClaims?: boolean } = {},
): typeof fetch {
  let claimCalls = 0
  return (async (url: string, init: RequestInit) => {
    const sent = (init.headers ?? {}) as Record<string, string>
    if (url.includes('/event/report')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/billing/preview')) {
      const plans = planIds.map((plan_id, index) => ({ plan_id, priority: index }))
      return new Response(JSON.stringify({ data: { plans } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/billing/claim')) {
      seen.params.push(sent['x-aliyun-captcha-verify-param'])
      seen.demandAtClaim.push(captchaDemand())
      claimCalls += 1
      // ★ 评审 C4 用：第一次 claim 回 3007（模拟「内部 param 被拒」），
      //   后面的照常成功 ⇒ 能验出「当次换注入链重发」真的发出去了。
      if (options.alwaysRejectClaims === true
        || (options.firstClaimRejected === true && claimCalls === 1)) {
        return new Response('{"code":3007,"msg":"captcha verify failed"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{"code":0,"msg":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // 载体链的 chromium 腿会在串行队列内现拉一次 captcha 配置（`mintWithChromium`）
    if (url.includes('/client/configs')) {
      return new Response(
        JSON.stringify({ data: { configs: { captcha: CONFIG } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`桩 fetch 收到未预期的 URL：${url}`)
  }) as unknown as typeof fetch
}

function makeWired(options: {
  responses: Response[]
  env?: Record<string, string>
  /** chromium 腿抛错（模拟退避冷却）。 */
  chromiumThrows?: boolean
  /**
   * chromium 产出里睡多少毫秒（并发重叠用）。
   * 传 `0` 则**完全不设 timer** —— 用假时钟的用例要靠它，
   * 否则 `await` 会卡在永远不会被推进的 `setTimeout` 上。
   */
  mintSleepMs?: number
  /**
   * 给了就**装上领取路径的上游桩**（`ZcodeAuth` 的 `fetchImpl`），可领 plan 一一对应；
   * 不给则保持「任何请求都抛错」的强守卫（推理用例据此保证零网络）。
   */
  claimPlans?: readonly string[]
  /** 第一次 `/billing/claim` 回 `3007`（评审 C4：内部 param 被拒那一支）。 */
  firstClaimRejected?: boolean
  /** **每次**带 param 的 claim 都回 `3007`（验「重发上限一次」）。 */
  alwaysRejectClaims?: boolean
  log?: (message: string) => void
} = { responses: [] }) {
  const ctx = new Context()
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

  /**
   * ⚠ 必须把 `credentials` 装到 ctx 上并**预置一份可用凭据**。
   *
   * `claimDaily` → `current()` 现在**只**读 `ctx.credentials`（账号池 → 单凭据
   * ref），不再有「回退读本机官方客户端凭据文件」那条路（2026-10-05 删除）⇒
   * 缺这一步时 `current()` 回 `undefined`，`claimDailyWith` 开头就早退，
   * 本文件每条 claim 用例都会拿到 `failed`（实测：8 条全红）。
   *
   * ⚠ 这里**同步**写 `store`（`makeWired` 是同步工厂，30 来个调用点都直接
   *   `const wired = makeWired(...)` 拿结果用，改成 async 要动所有调用点）。
   *   写的是真实 ref（`ZCODE.defaultCredentialRef`），不是硬编码字符串。
   */
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  credentials.store.set(ZCODE.defaultCredentialRef, JSON.stringify(CREDENTIAL))

  // env 只在**构造期**生效（与 `captchaQueueEnabledFromEnv` 同一读取点），读过即还原，
  // 免得污染同一 worker 里的其它用例。
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(options.env ?? {})) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
  /** 领取时逐 plan 记下的 param 与需求位快照（见 `makeClaimFetch`）。 */
  const claimSeen = { params: [] as string[], demandAtClaim: [] as boolean[] }
  const auth = new ZcodeAuth(ctx, {
    fetchImpl: options.claimPlans === undefined
      ? (async () => { throw new Error('单测不发网络请求') }) as never
      : makeClaimFetch(options.claimPlans, claimSeen, {
          ...(options.firstClaimRejected === undefined ? {} : { firstClaimRejected: options.firstClaimRejected }),
          ...(options.alwaysRejectClaims === undefined ? {} : { alwaysRejectClaims: options.alwaysRejectClaims }),
        }),
    // ⚠ 这里**不再**有 `readCredential` 选项：它随「读本机 ZCode 数据」整条删除
    //   （见 `tests/unit/zcode-no-local-credential-read.spec.ts` 的防回退锁）。
    //   凭据改由上面的 `ctx.credentials` 供给，其余选项（`fetchImpl` / `carrierLog`）
    //   一个都没少。
    ...(options.log === undefined ? {} : { carrierLog: options.log }),
  })
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  let chromiumCalls = 0
  let inFlight = 0
  let maxInFlight = 0
  let lastSignal: AbortSignal | undefined

  /**
   * ⚠ **把浏览器桩装回 `auth.captchaBrowser`**。
   *
   * ## 为什么需要是可重复的（2026-10-02 的真实行为变化）
   *
   * `claimDailyWith` 的 `finally` 现在会调 `closeChromium()` ——
   * 把 `auth.captchaBrowser` **置空**（用户报障：领取完 chromium 留在任务栏闪烁）。
   *
   * ⇒ 每次 `claimDaily()` 之后，那个桩就被丢掉了。若不重新装回去，
   * 下一次落到 chromium 腿时 `captchaBrowser ??= new ZcodeCaptchaBrowser()`
   * 会建一个**真实浏览器**（本文件在单测里绝不允许）——表现为
   * `chromiumCalls()` 不再增长（实测：期望 `+1` 得到 `+0`）。
   *
   * 故装桩动作抽成函数，**每次领取后都要重装**。
   */
  const installBrowserStub = (): void => {
    ;(auth as unknown as { captchaBrowser: unknown }).captchaBrowser = {
      mintWithOutcome: async (
        _config: unknown,
        // ⚠ 名字**不能**叫 `options`：外层 `makeWired(options)` 会被遮住（本文件踩过一次）
        mintOptions?: { signal?: AbortSignal },
      ) => {
        chromiumCalls += 1
        lastSignal = mintOptions?.signal
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        // 让并发调用真的有时间重叠（串行队列绕过时这里会看到 >1）；0 = 不留 timer
        const sleepMs = options.mintSleepMs ?? 5
        if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
        inFlight -= 1
        if (options.chromiumThrows === true) {
          throw new Error('zcode: captcha 产出处于冷却中（连续 3 次失败）')
        }
        return { param: fakeParam(`chromium-${String(chromiumCalls)}`), interactive: false }
      },
      mint: async () => 'unused',
      dispose: () => {},
    }
  }
  installBrowserStub()

  const headers: Array<string | undefined> = []
  const demandAtSend: boolean[] = []
  const demandAtMint: boolean[] = []
  const queue = [...options.responses]

  const adapter = new ZcodeAdapter({
    credentialRef: 'R' as never,
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    // 一期的那条 chromium 链（载体不可用时适配器仍会走它）。
    mintCaptcha: async (opts?: { signal?: AbortSignal }) =>
      await auth.mintCaptcha(CONFIG, opts),
    // ★ 二期：走载体链的产出 + 被拒后的当次回退（`index.ts` 注入的同两条）。
    mintCaptchaParam: async (opts?: { signal?: AbortSignal }) => {
      demandAtMint.push(captchaDemand())
      return await auth.mintCaptchaParam(CONFIG, opts)
    },
    mintCaptchaAfterRejection: async (
      outcome: CarrierOutcome,
      opts?: { signal?: AbortSignal },
    ) => await auth.mintCaptchaAfterRejection(outcome, CONFIG, opts),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const sent = (init.headers ?? {}) as Record<string, string>
      headers.push(sent['x-aliyun-captcha-verify-param'])
      demandAtSend.push(captchaDemand())
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(`桩响应已用尽（第 ${String(headers.length)} 次请求）⇒ 实际请求数超出预期`)
      }
      return next
    }) as never,
    gate: new ModelGate({ sleep: async () => {} }),
    sleep: async () => {},
    now: () => T0,
    product: ZCODE,
    currentAccountId: () => ACCOUNT,
  })

  /** 模拟 client：内部载体产好了一个 param 并回传（`captcha.contribute` 的等价动作）。 */
  const contribute = (tag: string): string => {
    const param = fakeParam(tag)
    // ⚠ 槽用**真实时钟**算年龄（载体链的 `now` 是 `Date.now`），故这里不能用 T0。
    putSuppliedParam(param, Date.now())
    return param
  }

  return {
    auth,
    adapter,
    headers,
    demandAtSend,
    demandAtMint,
    chromiumCalls: () => chromiumCalls,
    maxInFlight: () => maxInFlight,
    lastChromiumSignal: () => lastSignal,
    contribute,
    /**
     * ⚠ **每次 `claimDaily()` 之后都要调它**（本文件里凡是在领取后再断言
     * chromium 行为的用例）。
     *
     * 原因：`claimDailyWith` 的 `finally` 会 `closeChromium()` 把
     * `auth.captchaBrowser` 置空（用户报障：领取完 chromium 留在任务栏闪烁）。
     * 不重装桩，下一次落到 chromium 腿就会建**真实浏览器**（单测里绝不允许），
     * 且 `chromiumCalls()` 不再增长 —— 表现为「期望 +1 得到 +0」的假失败。
     */
    reinstallBrowser: installBrowserStub,
    /** 领取时逐 plan 用掉的 param（`makeClaimFetch` 记的）。 */
    claimParams: claimSeen.params,
    /** 领取时逐 plan 的需求位快照（窗口内恒为真）。 */
    claimDemandAt: claimSeen.demandAtClaim,
    carrierStats: () => auth.captchaObservability().carrier,
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of iterable) out.push(item)
  return out
}

function streamOptions(): never {
  return { provider: 'zcode', model: MODEL, messages: [{ role: 'user', content: 'hi' }] } as never
}

/** 直接往进程级记忆里注入一条（= 上一请求被 3007 拒过的效果）。 */
function noteRequiredForTest(): void {
  noteCaptchaRequired(captchaRequirementKey(ACCOUNT, MODEL), T0)
}

beforeEach(() => {
  resetCaptchaSupply()
  resetCaptchaRequirementMemory()
})

describe('★ 推理侧：3007 自愈仍在，但**不再**驱动内部载体（需求位归 claim）', () => {
  it('★ 首次被拒 ⇒ 当次补产 chromium 且重发成功；需求位**全程为假**（不空转产出）', async () => {
    const wired = makeWired({ responses: [captchaRequiredError(), okSse(), okSse()] })

    await drain(wired.adapter.stream(streamOptions()))
    // ① 先探那一发不带 param 被拒 ⇒ 当次补产的是 **chromium** 的 param
    expect(wired.headers[0]).toBeUndefined()
    expect(wired.headers[1]).toBeDefined()
    expect(wired.chromiumCalls()).toBe(1)
    expect(wired.carrierStats().internalUsed).toBe(0)
    /**
     * ② ★ 判定「上游要验证」的那一刻**不再**置需求位。
     * 3.14.4 起模型请求本来就不校验，推理侧置位 = client 在一个永不索要验证的
     * 窗口里每 25 秒白产一个（成功冷却），空耗阿里云「同设备每小时 150 次」。
     */
    expect(captchaDemand()).toBe(false)
    expect(wired.demandAtSend).toEqual([false, false])
    expect(wired.demandAtMint).toEqual([false])
    // ③ 本机从未收到贡献 ⇒ 这次**没有**白等那 1.5 秒（web 版逐字不变的同一条防线）
    expect(wired.carrierStats().supply.waitTimeouts).toBe(0)

    // ④ 防御分支仍然把**第二次**请求救回来了（这一条 3.14.4 之后走不到，但不许被删）
    wired.contribute('internal-1')
    await drain(wired.adapter.stream(streamOptions()))
    expect(wired.headers[2]).toBeDefined()
    // ⚠ 取槽**不看需求位**（`CaptchaCarrier.mint` 出口 1 的既定纪律：client 既然已经
    //   产出了，为「统一走等待」把它留在槽里过期等于白烧一份配额）—— 所以这一发是
    //   内部载体命中，本条**不**断言「推理侧绝不碰槽」，只断言需求位一路为假。
    expect(wired.carrierStats().internalUsed).toBe(1)
    // ⑤ ★ 需求位自始至终为假 ⇒ client 不会为一个不索要验证的窗口空转产出
    expect(captchaDemand()).toBe(false)
    expect(wired.demandAtSend).toEqual([false, false, false])
    expect(wired.demandAtMint).toEqual([false, false])
  })

  it('内部 param 被上游拒 ⇒ 记一次拒绝并当次改用 chromium 重发（用户看不到失败）', async () => {
    noteRequiredForTest()
    const wired = makeWired({ responses: [captchaRequiredError(), okSse()] })
    const internal = wired.contribute('internal-bad')
    setCaptchaDemand(true)

    await drain(wired.adapter.stream(streamOptions()))
    expect(wired.headers[0]).toBe(internal)
    expect(wired.headers[1]).toBeDefined()
    expect(wired.headers[1]).not.toBe(internal)
    expect(wired.chromiumCalls()).toBe(1)
    expect(wired.carrierStats().internalRejected).toBe(1)
    expect(wired.carrierStats().internalUsed).toBe(1)
    expect(wired.auth.carrier.internalDisabled()).toBe(false)
  })

  it('★ 累计拒绝到阈值 ⇒ 本次运行禁用内部载体（之后槽里有货也不取）', async () => {
    noteRequiredForTest()
    // 每轮：带内部 param 被拒 → 当场换 chromium 重发成功（2 发）；最后一轮只用 1 发，
    // 验证「禁用后槽里有货也不取」。
    const responses: Response[] = []
    for (let i = 0; i < CARRIER_REJECT_DISABLE_THRESHOLD; i += 1) {
      responses.push(captchaRequiredError(), okSse())
    }
    responses.push(okSse())
    const wired = makeWired({ responses })
    for (let i = 0; i < CARRIER_REJECT_DISABLE_THRESHOLD; i += 1) {
      wired.contribute(`internal-reject-${String(i)}`)
      setCaptchaDemand(true)
      await drain(wired.adapter.stream(streamOptions()))
      expect(wired.carrierStats().internalRejected).toBe(i + 1)
    }
    expect(wired.auth.carrier.internalDisabled()).toBe(true)
    // 禁用后：槽里放着新鲜的也不用，直接 chromium（不再多付一次上游往返）
    const unused = wired.contribute('after-disable')
    setCaptchaDemand(true)
    await drain(wired.adapter.stream(streamOptions()))
    expect(wired.headers[wired.headers.length - 1]).not.toBe(unused)
    expect(wired.chromiumCalls()).toBe(CARRIER_REJECT_DISABLE_THRESHOLD + 1)
    // 禁用后仍计数，但**不再**多取一次内部 param
    expect(wired.carrierStats().internalUsed).toBe(CARRIER_REJECT_DISABLE_THRESHOLD)
  })
})

/**
 * ★ 核心验收（2026-09-29 修正后的真正落点）：**需求位跟 claim 走**。
 *
 * 依据：模型请求自 3.14.4 起不校验 captcha（6 个采样点 + 官方更新说明），
 * 而 `/zcode-plan/billing/claim` 始终强制索要（`400/3007`，校验前置于 plan 校验）。
 */
describe('★ 核心验收：claim（领取）窗口驱动内部载体，窗口结束即清位', () => {
  it('★ 进入领取窗口就置位；逐 plan 从槽里取 param；领取完毕**必**清位', async () => {
    const wired = makeWired({ responses: [], claimPlans: ['p1', 'p2'] })
    // 领取前：需求位是假（没人索要验证 ⇒ client 不会产）
    expect(captchaDemand()).toBe(false)

    // client 在窗口内产好了一个 param 放进槽（真实耗时约 2–4 秒，这里直接投放）
    const internal = wired.contribute('claim-internal-1')
    // 闩锁因此打开（本进程真的收到过贡献）

    const outcomes = await wired.auth.claimDaily(async () => fakeParam('injected-chromium'))

    // ① 领取成功（两个 plan 各回一条 claimed）
    expect(outcomes.map((o) => o.kind)).toEqual(['claimed', 'claimed'])
    // ② ★ 需求位**窗口内为真**：逐 plan 发出请求那一刻都提着（client 有理由产）
    expect(wired.claimDemandAt).toEqual([true, true])
    // ③ ★ 第一个 plan 用的是**内部载体**的 param，一次 chromium 都没多付
    expect(wired.claimParams[0]).toBe(internal)
    expect(wired.carrierStats().internalUsed).toBe(1)
    // ④ 一次性：槽里那个 param 被取走即清 ⇒ 第二个 plan **必须另拿一个**（复用必 3007）
    expect(wired.claimParams[1]).not.toBe(internal)
    expect(wired.claimParams[1]).toBeDefined()
    expect(wired.carrierStats().supply.used).toBe(1)
    // ⑤ 第二个 plan 等不到新的贡献 ⇒ 落 chromium 腿（等价「客户端没跟上」的现实）
    expect(wired.chromiumCalls()).toBe(1)
    // ⑥ ★ 窗口结束**必**清位：漏清就是「client 无限定地产、白烧设备配额」的最坏形态
    expect(captchaDemand()).toBe(false)
  })

  it('★ 未置位时不取槽：位为假 ⇒ claim 的产出直接落注入的链（不碰槽、不白等）', async () => {
    /**
     * `mintClaimCaptcha` 的第三条判据：需求位为假时**既不取槽也不等**，直接用注入的链。
     *
     * 真实触发场景：需求位是**进程级布尔**（不是计数器），并发领取时一个窗口的
     * `finally` 会把另一个窗口的位一起收掉。把那个已知取舍锁成可观测行为，
     * 而不是留成暗坑 —— 领取照样成功，只是那一个 plan 走 chromium。
     *
     * ⚠ 直呼私有方法（与本文件换掉 `captchaBrowser` 私有字段同一手法）：走
     *   `claimDaily` 无法确定性地制造「窗口内位被收掉」，而这条要验的正是那个闸本身。
     * ⚠ `CaptchaCarrier.mint` 的出口 1（槽里有货就取，**不看需求位**）在这里
     *   必须被 claim 侧的闸挡在前面 —— 否则窗口外会把为下一次窗口备的货提前烧掉。
     */
    const wired = makeWired({ responses: [], claimPlans: ['p1'] })
    const injected = vi.fn(async () => fakeParam('injected-chromium'))
    const internal = wired.contribute('claim-internal-1')
    const mintClaim = (wired.auth as unknown as {
      mintClaimCaptcha: (cb: (() => Promise<string>) | undefined) => Promise<CarrierOutcome>
    }).mintClaimCaptcha.bind(wired.auth)

    // ① 位为真 ⇒ 吃槽里的内部 param（**来源标成 internal**），注入的桩一次都没被叫
    setCaptchaDemand(true)
    const fromCarrier = await mintClaim(injected)
    expect(fromCarrier).toEqual({ param: internal, source: 'internal' })
    expect(injected).not.toHaveBeenCalled()
    expect(wired.carrierStats().internalUsed).toBe(1)

    // ② 位为假 ⇒ 不取槽，直接落注入的链（槽里的货留给下一次真正的窗口）
    const parked = wired.contribute('claim-internal-2')
    setCaptchaDemand(false)
    const fallback = await mintClaim(injected)
    expect(fallback.param).not.toBe(parked)
    expect(fallback.source).toBe('chromium')   // ★ 评审 C4：来源必须如实标，3007 归因靠它
    expect(injected).toHaveBeenCalledTimes(1)
    expect(wired.carrierStats().internalUsed).toBe(1)
    expect(wired.carrierStats().supply.used).toBe(1)
    // 载体链的等待分支**没有**被触发（需求位为假 ⇒ 不白等那 1.5 秒）
    expect(wired.carrierStats().supply.waitTimeouts).toBe(0)
  })

  it('★ web 版 / env=0（闩锁关着）⇒ 逐字走注入的链，领取窗口仍然置位并清位', async () => {
    const wired = makeWired({ responses: [], claimPlans: ['p1'], env: { DSH_ZCODE_INTERNAL_CARRIER: '0' } })
    const internal = wired.contribute('env-off-must-not-be-used')

    const outcomes = await wired.auth.claimDaily(async () => fakeParam('injected-chromium'))

    expect(outcomes.map((o) => o.kind)).toEqual(['claimed'])
    expect(wired.claimParams[0]).not.toBe(internal)
    // env=0 ⇒ 载体链一个数都不动（连「用过一次内部 param」都不该有）
    expect(wired.carrierStats().internalUsed).toBe(0)
    expect(wired.carrierStats().chromiumUsed).toBe(0)
    expect(captchaDemand()).toBe(false)
  })

  it('★ 领取失败（无可领 plan / 缺浏览器）也**必**清位：所有出口都在 finally 里', async () => {
    // ① 无可领 plan：`claimDailyWith` 提前 return（early return 也得走 finally）
    const empty = makeWired({ responses: [], claimPlans: [] })
    const skipped = await empty.auth.claimDaily(async () => fakeParam('never'))
    expect(skipped[0]?.kind).toBe('already-claimed')
    expect(captchaDemand()).toBe(false)

    // ② 缺浏览器：连注入回调都没有，那条更早的 return 同样不得把位留在真
    const noBrowser = makeWired({ responses: [], claimPlans: ['p1'] })
    const failed = await noBrowser.auth.claimDaily(undefined)
    expect(failed[0]?.kind).toBe('failed')
    expect(captchaDemand()).toBe(false)
  })

  it('★ claim 置位后 carrier 能从槽里取到 param（用 putSuppliedParam 造槽，桩 mint 不参与）', async () => {
    // 行为与上面那条同源，但把「取槽」这一步单独拎出来验：置位 ⇒ 载体链真的在槽里
    // 拿到了货，注入的桩一次都没被叫（若 mintClaimCaptcha 漏了载体优先，这里会变红）。
    const wired = makeWired({ responses: [], claimPlans: ['only'] })
    const injected = vi.fn(async () => fakeParam('injected'))
    const internal = wired.contribute('carrier-take')

    const outcomes = await wired.auth.claimDaily(injected)

    expect(outcomes.map((o) => o.kind)).toEqual(['claimed'])
    expect(wired.claimParams[0]).toBe(internal)
    expect(injected).not.toHaveBeenCalled()
    expect(wired.carrierStats().internalUsed).toBe(1)
  })
})

/**
 * ★ 评审 C4：claim 接上 `3007` 降级链。
 *
 * 领取端点 `/zcode-plan/billing/claim` **始终**索要 captcha，且校验**前置于** plan 校验
 * （实测：带非法与不带 captcha 都回 `400/3007`）⇒ 内部 param 在这条路径上被拒的概率
 * 比推理路径高得多，而这条降级链此前**只存在于推理路径**（`ZcodeAdapter` 里），
 * 领取上等于没有：用户点一次「一键领取」就看到一个干巴巴的 `3007`。
 */
describe('★ 评审 C4：claim 撞上 3007 ⇒ 当次换注入链重发 + 记一次 internalRejected', () => {
  it('★ 内部 param 被拒 ⇒ 记一次拒绝、用注入链重发**一次**、用户只看到成功', async () => {
    const logs: string[] = []
    const wired = makeWired({ responses: [], claimPlans: ['p1'], firstClaimRejected: true, log: (m) => { logs.push(m) } })
    const injected = vi.fn(async () => fakeParam('chromium-retry'))
    const internal = wired.contribute('claim-internal-3007')

    const outcomes = await wired.auth.claimDaily(injected)

    // ① 第一发带的是**内部** param，第二发带的是**注入链**新产的
    expect(wired.claimParams).toHaveLength(2)
    expect(wired.claimParams[0]).toBe(internal)
    expect(wired.claimParams[1]).toBe(fakeParam('chromium-retry'))
    expect(injected).toHaveBeenCalledTimes(1)
    // ② 用户看到的是成功（自愈对用户不可见）
    expect(outcomes.map((o) => o.kind)).toEqual(['claimed'])
    // ③ ★ 归因：只记一次 internalRejected（按 captcha-carrier.ts 的既有语义）
    expect(wired.carrierStats().internalRejected).toBe(1)
    expect(wired.auth.carrier.internalDisabled()).toBe(false)
    expect(logs.some((line) => line.includes('3007'))).toBe(true)
    // ④ 需求位仍必清（降级链不能把 finally 绕掉）
    expect(captchaDemand()).toBe(false)
  })

  it('★ 重发**只有一次**：chromium 的 param 也被拒 ⇒ 如实失败，不再试第三次', async () => {
    // 桩：每一次带 param 的 claim 都回 3007 ⇒ 如果实现里是「while 重试」，
    // 这里会一直发下去（注入链被无限调用）；正确实现是「重发一次就收工」。
    const wired = makeWired({ responses: [], claimPlans: ['p1'], alwaysRejectClaims: true })
    const injected = vi.fn(async () => fakeParam('chromium-retry-2'))
    wired.contribute('claim-internal-3007-again')

    const outcomes = await wired.auth.claimDaily(injected)

    // ① 只重发一次 ⇒ 注入链只被叫一次、claim 只发两发
    expect(injected).toHaveBeenCalledTimes(1)
    expect(wired.claimParams).toHaveLength(2)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].kind).toBe('failed')
    // ② ★ 文案能区分「换了 chromium 仍被拒」——那意味着设备信誉问题，不是随手一次
    expect(outcomes[0].message).toContain('浏览器链路重试')
    expect(outcomes[0].message).not.toBe('captcha 校验失败（p1），请重试')
    expect(wired.carrierStats().internalRejected).toBe(1)
  })

  it('★ chromium 来源的 param 被拒 ⇒ **不**记 internalRejected（归因纪律）', async () => {
    // 位为假 ⇒ 产出直接落注入链 ⇒ 来源是 chromium ⇒ 被拒不关载体的事
    const wired = makeWired({ responses: [], claimPlans: ['p1'], firstClaimRejected: true })
    setCaptchaDemand(false)
    const injected = vi.fn(async () => fakeParam('chromium-only'))

    const outcomes = await wired.auth.claimDaily(injected)

    expect(outcomes.map((o) => o.kind)).toEqual(['failed'])
    expect(wired.carrierStats().internalRejected).toBe(0)
    expect(injected).toHaveBeenCalledTimes(1)   // 不重发（没有「换一条腿」可换）
    expect(wired.auth.carrier.internalDisabled()).toBe(false)
  })

  it('★ 累计被拒到阈值 ⇒ 本次运行禁用内部载体（与推理路径同一套阈值语义）', async () => {
    const logs: string[] = []
    const wired = makeWired({ responses: [], claimPlans: ['p1'], firstClaimRejected: true, log: (m) => { logs.push(m) } })
    // 先把计数推到阈值前一格（模拟此前已有两次被拒；槽一次只放一个，
    // 靠「每个 plan 各塞一个」是造不出三次的 —— 所以直接调公开的记账方法）。
    wired.auth.carrier.noteInternalRejection()
    wired.auth.carrier.noteInternalRejection()
    expect(wired.auth.carrier.internalDisabled()).toBe(false)

    wired.contribute('claim-internal-threshold')
    const outcomes = await wired.auth.claimDaily(async () => fakeParam('chromium-threshold'))

    expect(outcomes[0].kind).toBe('claimed')
    expect(wired.carrierStats().internalRejected).toBe(CARRIER_REJECT_DISABLE_THRESHOLD)
    // ★ 阈值判定与推理路径**共用**同一个方法（不会漂移成两处真相）
    expect(wired.auth.carrier.internalDisabled()).toBe(true)
    expect(logs.some((line) => line.includes('本次运行禁用内部载体'))).toBe(true)

    // 禁用之后：槽里**再有货也不取**（否则被拒过 3 次的东西还能再被发出去）。
    // ⚠ 禁用时 `CaptchaCarrier.mint()` 落的是**它自己那条 chromium 腿**（不是注入回调），
    //   所以这里盯的是「槽里那个 param 压根没被发出去」。
    const chromiumBefore = wired.chromiumCalls()
    const parked = wired.contribute('must-not-be-used-after-disable')
    const injectedAfter = vi.fn(async () => fakeParam('injected-after-disable'))
    /**
     * ⚠ **必须先重装浏览器桩**：上面的 `claimDaily()` 已在 `finally` 里
     * `closeChromium()`（用户报障：领取完 chromium 留在任务栏闪烁），桩随之被丢弃。
     * 不重装就会建真实浏览器，`chromiumCalls()` 也不再增长
     * （实测表现为「期望 +1 得到 +0」的假失败）。
     */
    wired.reinstallBrowser()
    const after = await wired.auth.claimDaily(injectedAfter)
    expect(after[0].kind).toBe('claimed')
    expect(wired.claimParams[2]).not.toBe(parked)
    expect(wired.chromiumCalls()).toBe(chromiumBefore + 1)
  })
})

describe('★ 评审 C1/C2：载体页小服务随 ZcodeAuth 启停', () => {
  it('★ carrierPageUrl() 懒起一个独立回环端口，回 http://127.0.0.1:<具体端口>/carrier', async () => {
    const wired = makeWired({ responses: [], claimPlans: [] })
    try {
      const url = await wired.auth.carrierPageUrl()
      expect(url).not.toBeNull()
      const parsed = new URL(String(url))
      expect(parsed.protocol).toBe('http:')
      expect(parsed.hostname).toBe('127.0.0.1')
      expect(parsed.pathname).toBe('/carrier')
      // ⚠ 端口必须**具体**且**非 0**（0 拼出来的地址根本不可达）
      expect(Number(parsed.port)).toBeGreaterThan(0)
      // 幂等：再问一次是同一条（不重起监听器）
      expect(await wired.auth.carrierPageUrl()).toBe(url)
      // 页面真的能取到（现渲染，含三段表达式）
      const html = await (await fetch(String(url))).text()
      expect(html).toContain('window.__zcodeCaptcha')
    } finally {
      wired.auth.stop()
    }
  })

  it('★ stop() 之后端口释放（插件卸载 ⇒ 不留常驻监听器）', async () => {
    const wired = makeWired({ responses: [], claimPlans: [] })
    const url = String(await wired.auth.carrierPageUrl())
    expect((await fetch(url)).status).toBe(200)
    wired.auth.stop()
    await expect(fetch(url)).rejects.toThrow()
    // 重复 stop 不许抛（幂等）
    expect(() => { wired.auth.stop() }).not.toThrow()
  })

  it('★ env=0 ⇒ carrierPageUrl() 直接回 null（不开端口，也不给 client 一个假地址）', async () => {
    const wired = makeWired({ responses: [], claimPlans: [], env: { DSH_ZCODE_INTERNAL_CARRIER: '0' } })
    expect(await wired.auth.carrierPageUrl()).toBeNull()
    wired.auth.stop()
  })
})

describe('需求位：只在「上游要验证」时置真，不校验的窗口保持假', () => {
  it('★ 上游不校验（先探即成功）⇒ 一次都不产、需求位也不会被置真（不白耗设备配额）', async () => {
    const wired = makeWired({ responses: [okSse()] })
    await drain(wired.adapter.stream(streamOptions()))
    expect(captchaDemand()).toBe(false)
    expect(wired.chromiumCalls()).toBe(0)
    expect(wired.demandAtMint).toHaveLength(0)
  })

  it('槽里的 param 超过时效 ⇒ 丢弃并回退 chromium（宁可不发，也不去吃一次 3007）', async () => {
    const wired = makeWired({ responses: [okSse()] })
    // 到达时刻往前推过 `PARAM_MAX_AGE_MS` ⇒ 取的时候已超龄
    putSuppliedParam(fakeParam('too-old'), Date.now() - PARAM_MAX_AGE_MS - 1)
    /**
     * ⚠ 直接打 `auth.mintCaptchaParam`，不经适配器：适配器每轮都会按
     *   「这一发要不要 param」重算需求位（`setCaptchaDemand(knownRequired || probeRejected)`），
     *   本条要锁的是**超龄即丢弃**这道闸，不是「丢弃后再等 1.5 秒」那一层
     *   （等待层已用注入的 `waitMs` 在 `zcode-captcha-carrier.spec.ts` 里锁过）。
     */
    const outcome = await wired.auth.mintCaptchaParam(CONFIG)
    expect(outcome.source).toBe('chromium')
    expect(outcome.param).not.toContain('too-old')
    expect(wired.chromiumCalls()).toBe(1)
    expect(wired.carrierStats().internalUsed).toBe(0)
    expect(wired.carrierStats().supply.stale).toBe(1)
  })

  it('★ signal 一路透传到 chromium 产出（载体链不许半路吞掉它）', async () => {
    const wired = makeWired({ responses: [okSse()] })
    const controller = new AbortController()
    const outcome = await wired.auth.mintCaptchaParam(CONFIG, { signal: controller.signal })
    expect(outcome.source).toBe('chromium')
    // 恒等：载体链 → `mintWithChromium` → 串行队列 → 池 → 浏览器，一路**同一个** signal。
    // captcha 侧历史上出过无超时的等待（2026-09-29 真实缺陷：漏传 signal 之后
    // 「点了停止也没反应」），中途换成新建的 controller 就等于把它摘掉了。
    expect(wired.lastChromiumSignal()).toBe(controller.signal)
  })

  it('★ 已中止的 signal 不许把产出挂住（走「有界等待」那条路时要立刻退出）', async () => {
    const wired = makeWired({ responses: [okSse()] })
    // 先把闩锁打开、再把槽抽干 ⇒ 下一次取 param 必然落在「需求位为真 + 槽空」的等待分支
    wired.contribute('drain-me')
    setCaptchaDemand(true)
    expect((await wired.auth.mintCaptchaParam(CONFIG)).source).toBe('internal')

    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const failure = await wired.auth
      .mintCaptchaParam(CONFIG, { signal: controller.signal })
      .catch((error: unknown) => error)
    // ① 不许挂死：远小于 1.5 秒的满等待（`waitForFreshParam` 的 abort 出口在
    //    接了生产路径之后仍然存在，不是只在 `captcha-supply.spec.ts` 里对）
    expect(Date.now() - started).toBeLessThan(1_000)
    // ② 如实抛出既有语义：串行队列**不吞中断**（`SerialQueue` 的 `QueueAbortedError`）
    expect(String(failure)).toContain('已取消')
    // ③ 中止的这一次**一个 param 都没产**（既没启动 chromium，也没把坏 param 发出去）
    expect(wired.chromiumCalls()).toBe(0)
  })
})

describe('DSH_ZCODE_INTERNAL_CARRIER 开关', () => {
  it('★ 只有显式 `0` 关掉（`0` 是合法值，不许被 `parseInt(x) || 默认` 那类判断吃掉）', () => {
    expect(internalCarrierEnabledFromEnv({})).toBe(true)
    expect(internalCarrierEnabledFromEnv({ DSH_ZCODE_INTERNAL_CARRIER: '' })).toBe(true)
    expect(internalCarrierEnabledFromEnv({ DSH_ZCODE_INTERNAL_CARRIER: '1' })).toBe(true)
    expect(internalCarrierEnabledFromEnv({ DSH_ZCODE_INTERNAL_CARRIER: '0' })).toBe(false)
    expect(internalCarrierEnabledFromEnv({ DSH_ZCODE_INTERNAL_CARRIER: ' 0 ' })).toBe(false)
  })

  it('★ env=0 ⇒ 既不等待也**不取内部槽**（槽里有新鲜 param 也照样走 chromium）', async () => {
    noteRequiredForTest()
    const wired = makeWired({
      responses: [okSse()],
      env: { DSH_ZCODE_INTERNAL_CARRIER: '0' },
    })
    const internal = wired.contribute('must-not-be-used')
    setCaptchaDemand(true)
    await drain(wired.adapter.stream(streamOptions()))
    expect(wired.headers[0]).toBeDefined()
    expect(wired.headers[0]).not.toBe(internal)
    expect(wired.chromiumCalls()).toBe(1)
    // 载体链一个数都没动（连「用过一次内部 param」都不该有）
    expect(wired.carrierStats().internalUsed).toBe(0)
    expect(wired.carrierStats().chromiumUsed).toBe(0)
    // 槽里那个 param 没被取走 ⇒ 仍在槽里（超龄后自然作废）
    expect(wired.carrierStats().supply.used).toBe(0)
  })
})

describe('归因纪律：3007 撞上 chromium 冷却', () => {
  it('★ chromium 的 param 被 3007 拒 ⇒ **不**记 internalRejected（时效/信誉，不是载体的锅）', async () => {
    noteRequiredForTest()
    const wired = makeWired({ responses: [captchaRequiredError(), okSse()] })
    // ⚠ 需求位在这里其实**会被适配器重新置真**（`knownRequired` 为真），
    //   本条之所以不白等 1.5 秒，是因为**本机从未收到过贡献** ⇒ 闩锁关着 ⇒
    //   直接落 chromium（这条走的正是 web 版那条路径）。
    setCaptchaDemand(false)
    await drain(wired.adapter.stream(streamOptions()))
    expect(wired.chromiumCalls()).toBe(2)
    expect(wired.carrierStats().internalRejected).toBe(0)
    expect(wired.auth.carrier.internalDisabled()).toBe(false)
  })

  it('★ 补产撞上退避冷却而抛错 ⇒ 保持既有抛出语义（不吞错、不退化成不带 param）', async () => {
    noteRequiredForTest()
    const wired = makeWired({ responses: [okSse()], chromiumThrows: true })
    await expect(drain(wired.adapter.stream(streamOptions()))).rejects.toThrow('冷却')
    // 抛出前没有发出任何一发：错误若在适配器里被吞掉，桩就会收到请求并回 200
    expect(wired.headers).toHaveLength(0)
  })

  it('★ 冷却抛错时**不许**把失败记成内部载体的拒绝', async () => {
    /**
     * 真实场景：先探那一发**没带任何 param**就被 `3007` 拒（判定上游要验证），
     * 补产时又撞上 chromium 退避冷却 ⇒ 抛出。两处都**不是**内部载体的锅：
     * 前者根本没发 param，后者是本机产出失败的信誉问题（归 `CaptchaBackoff` 数）。
     */
    const wired = makeWired({
      responses: [captchaRequiredError(), okSse()],
      chromiumThrows: true,
    })
    await expect(drain(wired.adapter.stream(streamOptions()))).rejects.toThrow()
    expect(wired.headers).toHaveLength(1)
    expect(wired.headers[0]).toBeUndefined()
    expect(wired.carrierStats().internalRejected).toBe(0)
    expect(wired.auth.carrier.internalDisabled()).toBe(false)
  })

  it('★ 载体链的 chromium 腿仍被**全局串行队列**包住（绕过去就是白耗设备配额）', async () => {
    /**
     * ⚠ 必须让**载体链自己**去落 chromium（而不是走 `mintCaptchaParam` 的「闩锁关着」
     *   短路）：短路那条直接进 `mintWithChromium`，测不到注入进载体的那一条腿。
     *   先用一次贡献把闩锁打开、并把槽里的货取干净，之后三次并发才真的从载体链落下来。
     */
    const wired = makeWired({ responses: [okSse()] })
    wired.contribute('drain-the-slot')
    expect((await wired.auth.mintCaptchaParam(CONFIG)).source).toBe('internal')
    // 需求位保持假 ⇒ 不等待，直接落 chromium 腿
    await Promise.all([
      wired.auth.mintCaptchaParam(CONFIG),
      wired.auth.mintCaptchaParam(CONFIG),
      wired.auth.mintCaptchaParam(CONFIG),
    ])
    expect(wired.chromiumCalls()).toBe(3)
    // 串行队列在 `mintWithChromium` 里：绕过它这里就是 3
    expect(wired.maxInFlight()).toBe(1)
  })

  it('★ 载体链的 chromium 腿仍被**退避闸门**挡住（冷却中一次浏览器都不许再碰）', async () => {
    const wired = makeWired({ responses: [okSse()], chromiumThrows: true })
    wired.contribute('drain-the-slot')
    expect((await wired.auth.mintCaptchaParam(CONFIG)).source).toBe('internal')
    for (let i = 0; i < 3; i += 1) {
      await expect(wired.auth.mintCaptchaParam(CONFIG)).rejects.toThrow()
      expect(wired.chromiumCalls()).toBe(i + 1)
    }
    expect(wired.auth.captchaObservability().cooldownRemainingMs).toBeGreaterThan(0)
    // 冷却中：第四次经载体链取 param ⇒ 闸门直接抛，**不再**发起真实产出
    await expect(wired.auth.mintCaptchaParam(CONFIG)).rejects.toThrow(/冷却/)
    expect(wired.chromiumCalls()).toBe(3)
    // 且这声抛出**不许**记到内部载体头上（那是信誉账，归 `CaptchaBackoff`）
    expect(wired.carrierStats().internalRejected).toBe(0)
  })

  it('全部产出失败会计入退避（既有护栏没被载体链接线弄坏）', async () => {
    const wired = makeWired({ responses: [], chromiumThrows: true })
    for (let i = 0; i < 3; i += 1) {
      await expect(wired.auth.mintCaptchaParam(CONFIG)).rejects.toThrow()
    }
    expect(wired.auth.captchaObservability().failureStreak).toBe(3)
    expect(wired.auth.captchaObservability().cooldownRemainingMs).toBeGreaterThan(0)
  })
})

describe('观测与接线', () => {
  it('captchaObservability() 暴露 carrier（含供给槽快照）', async () => {
    const wired = makeWired({ responses: [okSse()] })
    wired.contribute('obs-1')
    const before = wired.auth.captchaObservability()
    expect(before.carrier).toBeDefined()
    expect(before.carrier.supply.supplied).toBe(1)
    expect(before.carrier.internalUsed).toBe(0)
    expect(before.carrier.disabledAfter).toBe(CARRIER_REJECT_DISABLE_THRESHOLD)
  })

  it('★ ZcodeAuth 持有载体实例，且它的 chromium 腿注回**既有那条链**', () => {
    expect(authSource).toMatch(/new CaptchaCarrier\(/)
    expect(authSource).toMatch(/this\.carrier\.mint\(/)
    // 载体链的 chromium 腿必须是 `mintWithChromium`，而它里面仍是「闸门 → 串行队列 → 池」
    expect(authSource).toMatch(/mintWithChromium:[\s\S]*this\.mintWithChromium\(/)
    expect(authSource).toMatch(/private async mintWithChromium\([\s\S]*this\.captchaQueue\.run\(/)
    expect(authSource).toMatch(/const remainMs = this\.captchaBackoff\.remainingMs\(\)/)
  })

  it('★ stats 里带 carrier 计数（面板看不到就等于没接）', () => {
    expect(authSource).toMatch(/carrier:\s*this\.carrier\.stats\(\)/)
  })

  it('★ 需求位的置位/清位在 claim 入口的 `try/finally` 里（源码结构锁）', () => {
    // 领取窗口 = `claimDailyWith` 的函数体（claimDaily 与 claimDailyFor 都走它，
    // 见方法注释里「为什么落在这里而不是 RPC 编排层」）。
    const start = authSource.indexOf('private async claimDailyWith(')
    expect(start).toBeGreaterThan(-1)
    const body = authSource.slice(start)
    // ① `try` 里置位，且**在任何网络往返之前**（给 client 产出提前量）
    const tryAt = body.indexOf('try {')
    const setTrue = body.indexOf('setCaptchaDemand(true)')
    const activation = body.indexOf('await reportZcodeActivation(')
    expect(tryAt).toBeGreaterThan(-1)
    expect(setTrue).toBeGreaterThan(tryAt)
    expect(setTrue).toBeLessThan(activation)
    // ② ★ `finally` 里清位（漏掉就是白烧设备级配额的最坏形态）
    expect(body).toMatch(/finally \{[\s\S]{0,200}?setCaptchaDemand\(false\)/)
    // ③ 逐 plan 的产出走「内部载体优先」那一层，而不是裸的注入回调
    //    （评审 C4：返回值带 `source`，claim 才知道 3007 该不该记到载体头上）。
    //    ⚠ 第二个实参 `captchaConfig` 是**同源约束**的一部分（issue IKJNPS）：
    //    param 与 region 必须用同一份配置，少传/多拉一次都会让非 cn 区账号恒 `3007`。
    expect(body).toMatch(/const minted = await this\.mintClaimCaptcha\(mintCaptcha, captchaConfig\)/)
  })

  it('★ 反向看守：`zcode-adapter.ts` 里**不得**再出现 `setCaptchaDemand(`', () => {
    /**
     * 3.14.4 起**模型请求**不再校验 captcha（6 个采样点不带验证头也 HTTP 200，
     * 官方更新说明同口径）⇒ 推理侧置位是**死触发点**：需求位恒假、内部载体接了个空壳。
     * 反过来若哪天它又出现在适配器里，就是让 client 在**不需要验证**的窗口里空转产出，
     * 白耗阿里云「同设备每小时 150 次」的设备级配额（`src/captcha-backoff.ts`）。
     *
     * ⚠ 一并看守：那道「空闲一个 TTL 自动落下」的看门狗（`markCaptchaDemand`）也一并
     *   没了 —— 领取窗口是**有界**的，`finally` 比 TTL 强（claim 卡住时 TTL 会先落）。
     */
    expect(adapterSource).not.toContain('setCaptchaDemand(')
    expect(adapterSource).not.toContain('markCaptchaDemand')
    expect(adapterSource).not.toContain('demandWatchdog')
  })

  it('★ 推理的 `isZcodeCaptchaRejected` 防御分支仍在（当前版本走不到，但不许被删）', async () => {
    // 源码层：分支头 + 「当次补产重发」+ 记需求记忆 + `continue`（不把失败抛给用户）
    expect(adapterSource).toMatch(/isZcodeCaptchaRejected\(response\.status, text\)/)
    const branchStart = adapterSource.indexOf('isZcodeCaptchaRejected(response.status, text)')
    const branch = adapterSource.slice(branchStart, adapterSource.indexOf('// ④ 其余错误'))
    expect(branch).toContain('noteCaptchaRequired(requirementKey, this.nowImpl())')
    expect(branch).toMatch(/probeRejected = true\s*\n\s*continue/)
    // 行为层：上游若重新开启校验，被拒的那一发**当次自愈**，用户看不到失败
    const wired = makeWired({ responses: [captchaRequiredError(), okSse()] })
    const chunks = await drain(wired.adapter.stream(streamOptions()))
    expect(wired.headers[0]).toBeUndefined()
    expect(wired.headers[1]).toBeDefined()
    expect(chunks.length).toBeGreaterThan(0)
  })
  it('env 关掉时不做有界等待（短路写在使用处，不是 parseInt(x) || 默认）', () => {
    expect(authSource).toMatch(/DSH_ZCODE_INTERNAL_CARRIER/)
    expect(authSource).not.toMatch(/parseInt\([^)]*DSH_ZCODE_INTERNAL_CARRIER/)
  })

  it('★ index.ts 给载体接上 log（走 ctx.logger，两级可选链）', () => {
    expect(indexSource).toMatch(/carrierLog:\s*\(message: string\) => \{[^}]*ctx\.logger\?\.warn\?\./)
    expect(indexSource).toMatch(/mintCaptchaParam: [\s\S]*zcode\.mintCaptchaParam\(/)
    expect(indexSource).toMatch(/mintCaptchaAfterRejection: [\s\S]*zcode\.mintCaptchaAfterRejection\(/)
  })

  it('停止路径要清需求位（否则 client 在插件卸载后仍白产 param 烧配额）', async () => {
    /**
     * server 侧只剩 **一个** owner 有资格清这个进程级位：`ZcodeAuth.stop()`
     * （`index.ts` 的 cleanup 统一调；它还是「领取窗口进行中就被卸载」时的兜底 ——
     * `finally` 要等 promise 落定才跑）。
     * `ZcodeAdapter.stop()` 刻意**不再**清：需求位归 claim 所有，适配器不持有它，
     * 留着只会让「谁在写这个进程级状态」多出一个无主的来源。
     */
    const wired = makeWired({ responses: [okSse()], claimPlans: ['p1'] })
    setCaptchaDemand(true)
    wired.auth.stop()
    expect(captchaDemand()).toBe(false)
  })
})
