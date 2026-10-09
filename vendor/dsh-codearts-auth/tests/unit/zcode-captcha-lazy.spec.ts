/**
 * 「要了才取」的判据与行为单测（四态状态机：先探 → `3007` 才取 → 按 `账号|模型`
 * 记 2 分钟 → 不带也成功就清记忆）。
 *
 * ## 反向验证（2026-10-01 实做，别写成同义反复）
 * - 把 `isZcodeCaptchaRejected` 改成要求 `status === 400` ⇒ 第 2 条判据用例变红
 *   （网关可能用别的状态包裹同一业务码，与本仓库 `isZcodeConcurrencyLimited` 同理）；
 * - 把 `zcode-adapter.ts` 内层循环的门控 `knownRequired || probeRejected` 改回
 *   **无条件 mint** ⇒ 行为段 5 条变红（「首发不带且 mint=0」「3007 补产」「清记忆」
 *   「TTL 过期回到先探」「换模型仍先探」）；
 * - 去掉 `clearCaptchaRequirement(requirementKey)` 那一行 ⇒
 *   **只有**「不带也能成功 ⇒ 清记忆」变红（故该条精确锁住了那一行）；
 * - 去掉 `3007` 那条分支（让它走到 ④ 的 `throw`）⇒ 「3007 补产」「记下需要」
 *   「TTL」「换模型」4 条变红（它们都靠「`3007` 不外抛」才跑得下去）。
 *
 * 观测段（本次追加）另做四组（共七次）变异，逐组实跑记录：
 * - 把 `captchaObservability()` 里的 `...captchaRequirementObservability()` **删掉**
 *   ⇒ **只有**「ZcodeAuth 展开这两个计数」变红；把它**挪到** `...this.captchaStats`
 *   **之前**（被形状占位的 0 盖掉）同样只红那一条 ⇒ 展开与**顺序**都被钉住了；
 * - 删掉 `noteProbeFirst()` 那一记（计数漏记）⇒ 观测段 **3** 条变红；
 *   去掉计数外层的 `attempt === 0` 门控（每轮都记）⇒ 「被 3007 拒后补产」那条变红
 *   （拿到 `{1,2}` —— 违反 `zcode-adapter.ts` 内层循环上方那句
 *   「计数**只在每个请求的开局那一发**记（`attempt === 0`）：两个计数因此互斥」）；
 * - 日志文案 `未带 captcha` → `不带 captcha` ⇒ 日志那条变红（格式漂移有人守）；
 * - `index.ts` 的 `log` 注入删掉，或写成 `ctx.logger.info(message)`（丢掉可选链）
 *   ⇒ 接线那条变红。
 *
 * 探测判据段（本次追加）另做一次变异，实跑核对：
 * - `httpErrorCodeForZcode` 里 `3007` 那一行改回 `SERVER` ⇒ **只有**「补产后仍 3007」
 *   那条变红（其余 16 条全绿 —— 它们从不让 `3007` 走到抛出，故看不见这个归类）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'

import { ZcodeAdapter, isZcodeCaptchaRejected } from '../../src/zcode-adapter.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import {
  captchaRequirementKey,
  captchaRequirementObservability,
  noteCaptchaRequired,
  resetCaptchaRequirementMemory,
} from '../../src/captcha-requirement.js'
import { ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'

/** 供「读 `src/index.ts` 源码」那条接线用例定位入口文件（同 `zcode-wiring.spec.ts`）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/* ──────────────────── 一、3007 判据 ──────────────────── */

describe('isZcodeCaptchaRejected（3007 判据）', () => {
  it('正文含 3007 或 captcha verify failed 即命中', () => {
    expect(isZcodeCaptchaRejected(400, '{"code":3007,"msg":"captcha verify failed"}')).toBe(true)
    expect(isZcodeCaptchaRejected(400, 'Captcha Verify Failed')).toBe(true)
  })

  it('★ 不要求状态码是 400：网关可能用别的码包裹同一业务码', () => {
    expect(isZcodeCaptchaRejected(403, '{"code":3007}')).toBe(true)
    expect(isZcodeCaptchaRejected(200, '{"code":3007}')).toBe(true)
  })

  it('其它业务码不得命中（尤其 3009 限流与 3012 风控，处置完全不同）', () => {
    expect(isZcodeCaptchaRejected(429, '{"code":3009,"msg":"model concurrency limit exceeded"}')).toBe(false)
    expect(isZcodeCaptchaRejected(400, '{"code":3012,"msg":"unusual activity"}')).toBe(false)
    expect(isZcodeCaptchaRejected(401, '{"code":1002}')).toBe(false)
    expect(isZcodeCaptchaRejected(500, 'boom')).toBe(false)
  })
})

/* ────────────────────── 二、先探后取的行为 ────────────────────── */

// 桩响应**在本文件自带一份**，不去 `zcode-throttle.spec.ts` 借：
// 那边没有导出，且跨 spec 共享桩会让两个文件互相拖着改（本仓库惯例是各 spec 自带）。

/** 一个能正常结束的 Anthropic SSE 响应。 */
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
 * 冻结的基准时刻 + 可推进的偏移（TTL 用例不许真等 2 分钟）。
 *
 * ⚠ 只有行为段用它；判据段是纯函数，不涉及时钟。
 */
const T0 = 1_700_000_000_000
let clockAdvance = 0

/**
 * 记录每次请求的验证头与 mint 次数的适配器桩。
 *
 * ⚠ 桩响应**用尽即抛**，不许静默回一个成功响应：静默成功会掩盖
 * 「实际发出的请求数超出用例预期」这类真实回归 —— 而「多发了请求」正是
 * 本期最容易犯的错（门控写漏就多 mint / 多发一轮）。
 *
 * ⚠ 第二个参数 `log` 是给 Task 5 的观测用例复用的：**不要**再复制一个
 * 同构工厂出来（逐字重复的逻辑块会被评审判为缺陷）。
 *
 * ⚠ 第三个参数 `beforeRequest` 是「**并发对手**」的模拟位：在第 `index` 次
 * 请求（0 起）的验证头快照之后、真正发出去之前跑一段副作用。
 * 只有「清记忆」那条用例用得上它 —— 单线程里「不带验证头发出去」与
 * 「记忆里已写着需要」不可能同时成立，见那里的说明。
 */
function makeAdapter(
  responses: Response[],
  log?: (message: string) => void,
  beforeRequest?: (index: number) => void,
) {
  const captchaHeaders: Array<string | undefined> = []
  let mintCount = 0
  const queue = [...responses]
  const adapter = new ZcodeAdapter({
    credentialRef: 'R' as never,
    resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A' }),
    refresh: async () => {},
    mintCaptcha: async () => {
      mintCount += 1
      return `param-${mintCount}`
    },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      captchaHeaders.push(headers['x-aliyun-captcha-verify-param'])
      beforeRequest?.(captchaHeaders.length - 1)
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(
          `桩响应已用尽（第 ${String(captchaHeaders.length)} 次请求）⇒ 实际请求数超出用例预期`,
        )
      }
      return next
    }) as never,
    gate: new ModelGate({ sleep: async () => {} }),
    sleep: async () => {},
    // clock 注入：TTL 用例不许真等 2 分钟。
    now: () => T0 + clockAdvance,
    ...(log === undefined ? {} : { log }),
    product: ZCODE,
    currentAccountId: () => 'acct-A',
  })
  return {
    adapter,
    mintCalls: () => mintCount,
    headers: captchaHeaders,
  }
}

/** 直接往进程级记忆里注入一条（TTL / 清记忆 / 一次性 param 用例的前提准备）。 */
function noteCaptchaRequiredForTest(accountId: string, model: string): void {
  noteCaptchaRequired(captchaRequirementKey(accountId, model), T0 + clockAdvance)
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of iterable) out.push(item)
  return out
}

function streamOptions(): never {
  return {
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hi' }],
  } as never
}

describe('ZCode 先探后取（要了才取）', () => {
  beforeEach(() => {
    resetCaptchaRequirementMemory()
    clockAdvance = 0
  })

  it('★ 未知态首发**不带**验证头，且一次 mint 都不发', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([okSse()])
    await drain(adapter.stream(streamOptions()))
    expect(headers).toHaveLength(1)
    expect(headers[0]).toBeUndefined()
    expect(mintCalls()).toBe(0)
  })

  it('★ 首发被 3007 拒 → 内部补产并重发，用户看不到失败（只 yield 内容）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([captchaRequiredError(), okSse()])
    const chunks = await drain(adapter.stream(streamOptions()))
    expect(headers[0]).toBeUndefined()
    expect(headers[1]).toBe('param-1')
    expect(mintCalls()).toBe(1)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('被 3007 拒后记下「需要」：下一请求直接带（不再白吃一次 3007）', async () => {
    const { adapter, headers } = makeAdapter([
      captchaRequiredError(), okSse(),   // 第一次请求：探 → 被拒 → 补产
      okSse(),                            // 第二次请求：应直接带
    ])
    await drain(adapter.stream(streamOptions()))
    await drain(adapter.stream(streamOptions()))
    expect(headers[2]).toBeTypeOf('string')
  })

  it('★ 不带也能成功 ⇒ 清记忆：下一次又回到先探', async () => {
    /**
     * ⚠ 与任务书给的写法**不同**（任务书是「先跑一轮 → 手工注入 → 再跑一轮」），
     * 那个前提在这套实现里**不成立**：注入了记忆 ⇒ 第二发按「已知需要」直接带
     * param ⇒ 成功时 `captchaParam !== undefined` ⇒ 不会清记忆（见
     * `src/captcha-requirement.ts` 的策略段第 3 步：清记忆只发生在**不带也成功**
     * 那一发上）。所以「清记忆」只在**并发窗口**里可观测，用 `beforeRequest` 造它：
     *
     * A 的先探那一发已经在飞（验证头快照为「不带」），此时 B 撞上 `3007`
     * 记下「这个账号×模型要验证」；A 随后**不带也**成功 ⇒ 上游此刻不要验证
     * ⇒ 必须把 B 记的那条清掉，否则之后每个请求都白 mint 一个 param
     * （白耗设备验证配额与信誉，正是本期要省掉的东西）。
     */
    const { adapter, headers, mintCalls } = makeAdapter(
      [okSse(), okSse()],
      undefined,
      (index) => {
        if (index === 0) noteCaptchaRequiredForTest('acct-A', 'GLM-5.3-Flash')
      },
    )
    await drain(adapter.stream(streamOptions()))   // 不带也成功 ⇒ 清掉 B 记的那条
    await drain(adapter.stream(streamOptions()))   // ⇒ 又回到先探
    expect(headers[0]).toBeUndefined()
    expect(headers[1]).toBeUndefined()
    expect(mintCalls()).toBe(0)
  })

  it('TTL 过期后回到先探（121 秒）', async () => {
    const { adapter, headers } = makeAdapter([captchaRequiredError(), okSse(), okSse()])
    await drain(adapter.stream(streamOptions()))   // 探 → 拒 → 记「需要」
    clockAdvance = 121_000                          // 越过 2 分钟
    await drain(adapter.stream(streamOptions()))
    expect(headers[2]).toBeUndefined()
  })

  it('记忆期内换模型 ⇒ 该模型仍先探（key 含模型）', async () => {
    const { adapter, headers } = makeAdapter([captchaRequiredError(), okSse(), okSse()])
    await drain(adapter.stream(streamOptions()))
    await drain(adapter.stream({ ...streamOptions(), model: 'GLM-5.2' } as never))
    expect(headers[2]).toBeUndefined()
  })

  it('★ 已知需要时，每轮仍用**新的** param（一次性：复用必 3007）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([
      okSse(), okSse(),   // 记忆由下面显式注入，不需要先跑一轮去建
    ])
    noteCaptchaRequiredForTest('acct-A', 'GLM-5.3-Flash')
    await drain(adapter.stream(streamOptions()))
    await drain(adapter.stream(streamOptions()))
    expect(mintCalls()).toBe(2)
    expect(headers[0]).toBe('param-1')
    expect(headers[1]).toBe('param-2')
  })

  it('已知需要时 mint 抛「冷却中」⇒ 错误原样上抛（适配器不吞、也不退化成先探）', async () => {
    // 前提：先注入记忆 ⇒ 适配器走「已知需要」分支，**确实调了** mintCaptcha，
    // 只是后者自己抛错。故本条验的是「mint 的错误原样上抛（既有行为不变）」，
    // 不是「连 mint 都不发」—— 真退化成不带 param 的先探的话，桩会回 200、
    // stream 正常结束，这条同样会变红。
    const blocked = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A' }),
      refresh: async () => {},
      mintCaptcha: async () => { throw new Error('captcha 产出处于冷却中') },
      fetchImpl: (async () => okSse()) as never,
      gate: new ModelGate({ sleep: async () => {} }),
      sleep: async () => {},
      now: () => T0 + clockAdvance,
      product: ZCODE,
      currentAccountId: () => 'acct-A',
    })
    noteCaptchaRequiredForTest('acct-A', 'GLM-5.3-Flash')
    await expect(drain(blocked.stream(streamOptions()))).rejects.toThrow('冷却')
  })
})

/* ────────────────────── 三、可观测 ────────────────────── */

describe('先探后取的可观测性', () => {
  beforeEach(() => {
    resetCaptchaRequirementMemory()
    clockAdvance = 0
  })

  it('★ 一次「先探即成功」的请求：probeFirst 计数 +1、命中计数 0、mint 0 次', async () => {
    const { adapter, mintCalls } = makeAdapter([okSse()])
    await drain(adapter.stream(streamOptions()))
    expect(captchaRequirementObservability()).toEqual({ probeFirstCount: 1, knownRequiredCount: 0 })
    expect(mintCalls()).toBe(0)
  })

  it('一次「被 3007 拒后补产」的请求：先探 +1、下一请求命中 +1', async () => {
    const { adapter } = makeAdapter([captchaRequiredError(), okSse(), okSse()])
    await drain(adapter.stream(streamOptions()))   // 探 + 拒
    await drain(adapter.stream(streamOptions()))   // 命中记忆
    expect(captchaRequirementObservability()).toEqual({ probeFirstCount: 1, knownRequiredCount: 1 })
  })

  it('日志给出三段前置耗时，且「未带 captcha」时 captcha 为 0ms', async () => {
    const lines: string[] = []
    const { adapter } = makeAdapter([okSse()], (m) => lines.push(m))
    await drain(adapter.stream(streamOptions()))
    expect(lines.some((l) => /前置耗时 captcha 0ms \+ 响应头 \d+ms（未带 captcha）/.test(l))).toBe(true)
  })

  /**
   * ★ 接线验证：计数**读自**进程级模块，`ZcodeAuth` 上不另存一份。
   *
   * 本条存在的原因：AGENTS.md 的 ZCode 章节 7.4 段把这类缺口写作
   * 「原语写好了但没接上」，而 `zcode-captcha-guard.spec.ts` 整份文件就是为它建的防线。
   * 上面三条只证明了 `captcha-requirement.ts` 里的数**在动**，证明不了
   * `captchaObservability()` 把它**读出来**了 —— 去掉那一行展开，三条全绿、
   * 外部读到的永远是 0（变异实跑核对过：只有本条变红）。
   *
   * ⚠ 断言放在「先跑一次先探」之后：若 `ZcodeAuth` 自己存了一份副本，
   * 副本永远是初始值 0 ⇒ 本条变红（这正是我们要抓的漂移）。
   */
  it('★ ZcodeAuth.captchaObservability() 展开这两个计数（读的是进程级那份）', async () => {
    const { adapter } = makeAdapter([okSse()])
    await drain(adapter.stream(streamOptions()))
    // ⚠ 必须用**真实的** `new Context()`：`ZcodeAuth extends Service`，构造期会调
    //   `ctx.provide(...)`，手写对象桩在构造期就抛 —— 同 `zcode-captcha-guard.spec.ts`。
    const ctx = new Context()
    ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
    const snap = new ZcodeAuth(ctx).captchaObservability()
    expect(snap.probeFirstCount).toBe(1)
    expect(snap.knownRequiredCount).toBe(0)
  })

  /**
   * ★ 接线验证：`index.ts` 真的把 `log` 接到了宿主 logger。
   *
   * ⚠ 为什么用**源码文本**断言而不是跑一遍 `apply(ctx)`：诊断日志的调用点在
   * 适配器内层循环里，要触发它得把整条 LLM 请求链路（含宿主 LLM 注册）
   * 都搭起来；而本仓库对 `index.ts` 的接线**既有做法**就是源码正则
   * （见 `zcode-wiring.spec.ts` 的「index.ts 把 zcode 接进 registerJetHubRpc」等三条）。
   * 少了这一条，「到底注入了没有」只能靠肉眼确认：`ZcodeAdapterOptions.log` 的注释
   * 只写着「缺省完全不输出」，接线掉回去时**没有任何用例会被惊动**。
   */
  it('★ index.ts 把诊断日志接到宿主 logger（缺了它线上永远看不到这三段耗时）', () => {
    const source = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')
    // 要求**可选链**形态：宿主某些形态不给 logger（同文件 `makeReadImageRequest`
    // 与 `refreshAllCredentials` 两处既有防御写法就是 `ctx.logger?.warn?.(...)`）。
    // 写成 `ctx.logger.info(...)` 会在每次**成功**的推理上抛一次 TypeError ——
    // 调用点在 `stream()` 的循环里，抛出来就是整条请求失败：
    // 观测通道绝不能变成故障源（变异实跑过：只把它改成点号直调，本条变红）。
    expect(source).toMatch(/log: \(message: string\) => \{[^}]*ctx\.logger\?\.info\?\./)
  })
})

/* ────────────────── 四、`3007` 交给探测侧时的判据（3007 ≠ 账号失效） ────────────────── */

describe('适配器抛出的 `3007` 必须是探测侧认的限流码', () => {
  beforeEach(() => {
    resetCaptchaRequirementMemory()
    clockAdvance = 0
  })

  /**
   * ★ 上游**持续**索要验证（每一发都回 `3007`）时，本请求最终抛出的错误码仍是
   * `RATE_LIMIT`，而不是 `AUTH` 之类「账号坏了」的码。
   *
   * ## 为什么这条必须存在（不是同义反复）
   *
   * 探测侧 `isRateLimitFailure()`（`src/account-probe.ts`）认的就是这个码 ——
   * 它的 doc 写着「只有限流才算『标记仍然有效』，其他失败说明『无法确认』」。
   * 反例**只举 `AUTH`**：`src/index.ts` 的 ZCode 段写着「失效时上游回 401/1002，
   * 适配器归为 `AUTH` 并提示用户重新登录」—— 归成 `AUTH` 会让用户白跑一次重新登录，
   * 而真相只是「这一会儿上游要验证，而我们补产后仍未通过」。
   * ⚠ **不**举 `QUOTA_EXCEEDED` 作反例：它**也在** `isRateLimitFailure` 认的白名单里，
   *   归成它同样判「仍受限」、**不会**标坏账号 —— 把它算成反例会与那条白名单自相矛盾。
   * 上面一、二、三段没有任何一条**因 3007 而抛出**错误，因此看不见这条判据。
   *
   * ⚠ 变异实跑过：把 `httpErrorCodeForZcode` 里 `3007` 那一行改成返回 `SERVER`
   *   ⇒ **只有本条变红**（其余 16 条全绿）。
   *
   * ⚠ 只喂 **3 发**桩响应，不是 4 发：`ZCODE.concurrencyRetryMax` 当前是 2，
   *   内层 `attempt` 取 0/1/2 —— 第 3 发（`attempt === concurrencyRetryMax`）
   *   不再满足 ③ 的门禁，于是走到 ④ 如实抛出。若将来提高那个常量，
   *   桩会因「响应已用尽」而红 —— **这是有意的**：它逼着改的人重看这条归类。
   */
  it('★ 补产后仍 3007 ⇒ 抛出的错误码仍是 RATE_LIMIT（探测侧归「仍受限」，不标坏账号）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([
      captchaRequiredError(), captchaRequiredError(), captchaRequiredError(),
    ])
    const seen: string[] = []
    try {
      await drain(adapter.stream(streamOptions()))
    } catch (error) {
      seen.push(error instanceof LlmError ? error.code : String(error))
    }
    expect(seen).toEqual(['RATE_LIMIT'])
    // 抛出前确实走完了「先探一发 + 两轮补产」：证明红的是**归类**，不是没发出去。
    expect(headers).toEqual([undefined, 'param-1', 'param-2'])
    expect(mintCalls()).toBe(2)
  })
})
