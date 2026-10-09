/**
 * ★★ 领取路径的 `3012` 文案与可观测诊断（Gitee issue IKJOQB）。
 *
 * ## 缺陷本体（issue 原文的实测）
 *
 * 一次「一键领取」6 个账号，5 个走通、只有 1 个被上游风控拦截：
 *
 * ```
 * ZCode <账号已脱敏>：失败 — zcode-v3-start-plan-trust-1005:
 * request has been blocked due to unusual activity.
 * ```
 *
 * 这条裸上游串有**两个信息缺失，且第二个有实际代价**：
 * ① 看不出这是**风控**而非普通失败；
 * ② **看不到冷却警告** —— 而 `3012` 有账号冷却惩罚（30 分钟起步，反复触发
 *   升级到 24 小时乃至停用），「请勿连续重试」是用户**唯一正确的动作**。
 *   issue 作者原话：「我就是不知道有冷却，看到裸文案后以为还有别的问题，
 *   差点连续重试」。
 *
 * 同一时刻**推理路径**的 `describeUpstreamError` 却有这段警告 ——
 * 因为文案在两边**各写一份**，这就是漂移。
 *
 * ## 本文件锁住的四件事
 * 1. ★ 领取路径的 `3012` 带上**风控 + 冷却警告 + planId**（不再是裸上游串）；
 * 2. ★★ 两条路径的文案**同源**（改一处即两处都变，防再次漂移）；
 * 3. ★ 领取路径接上了 `noteZcodeRequest*` 埋点，且 `3012` 附**诊断行**；
 * 4. ★★ 命中 `3012` **短路**后续 plan —— 否则一次点击会连续触发 N 次风控，
 *    亲手把 30 分钟推成 24 小时。
 *
 * ## 反向验证（实跑记录）
 * - 去掉 `toClaimOutcome` 的 `3012` 特判 ⇒ 第 1、2 组共 4 条变红；
 * - 去掉 `claimDailyWith` 里的 `isClaimUnusualActivity` 短路 ⇒ 短路那 2 条变红；
 * - 去掉 `noteZcodeRequestSent/Ok/Failed` ⇒ 埋点那 2 条变红；
 * - 让 `formatZcodeDiagnostic` 在缺 `shape` 时返回空串 ⇒ 诊断那 2 条变红。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ZcodeAuth, isClaimUnusualActivity, toClaimOutcome } from '../../src/zcode-auth.js'
import {
  describeUpstreamError,
  httpErrorCodeForZcode,
  isZcodeCaptchaRejected,
  isZcodeConcurrencyLimited,
  isZcodeQuotaExhausted,
} from '../../src/zcode-adapter.js'
import { shouldFallbackToOtherChannel } from '../../src/zcode-transport.js'
import {
  formatZcodeDiagnostic,
  formatZcodeUnusualActivityMessage,
  hasZcodeUnusualActivity,
  isZcodeUnusualActivityCode,
  looksLikeZcodeHtmlPage,
  looksLikeZcodeUnusualActivity,
  mentionsZcodeUnusualActivity,
  noteZcodeRequestOk,
  noteZcodeRequestSent,
  parseZcodeBusinessCode,
  readZcodeBusinessCodeFromBody,
  resetZcodeDiagnostics,
} from '../../src/zcode-diagnostics.js'
import {
  putSuppliedParam,
  resetCaptchaSupply,
} from '../../src/captcha-supply.js'
import { resetCaptchaRequirementMemory } from '../../src/captcha-requirement.js'
import { claimZcodePlan } from '../../src/zcode-upstream.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { ZcodeCredential } from '../../src/zcode.js'
import type { ZcodeClaimOutcome } from '../../src/zcode-upstream.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const authSource = readFileSync(resolve(HERE, '../../src/zcode-auth.ts'), 'utf8')

/** issue 里贴的那条上游响应（逐字）。 */
const BODY_3012 = '{"code":3012,"msg":"request has been blocked due to unusual activity."}'

const CREDENTIAL: ZcodeCredential = {
  zcode_jwt: 'a.b.c',
  device_mid: 'mid-A',
  app_version: '3.14.4',
  user_id: '4544177',
  source: 'plugin',
} as ZcodeCredential

/** 一份 `3012` 的 `ZcodeClaimOutcome`（`claimZcodePlan` 解析后的形状）。 */
function outcome3012(planId: string): ZcodeClaimOutcome {
  return {
    planId,
    ok: false,
    code: 3012,
    httpStatus: 405,
    message: 'request has been blocked due to unusual activity.',
  }
}

/** 一个能过 `validateCaptchaParam` 的假 param。 */
function fakeParam(tag: string): string {
  const body = JSON.stringify({
    certifyId: tag,
    sceneId: '11xygtvd',
    securityToken: `${tag}-${'t'.repeat(128)}`,
  })
  return Buffer.from(body, 'utf8').toString('base64')
}

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
 * 领取链路的桩 fetch。
 *
 * ⚠ `claimCodes` 是**按序**下发的一串响应（每发取一个，用尽后取最后一个）——
 * 用来构造「首发 3007 ⇒ 换链重发 ⇒ 重发撞 3012」这类**跨发的**场景，
 * 单值形态表达不了它。
 */
function makeClaimFetch(options: {
  plans: readonly string[]
  claimCodes?: readonly { code: number; status: number }[]
  claimCode?: number
  claimStatus?: number
  /**
   * 直接指定 claim 的**原始响应体**（绕过 `claimCodes` 的拼装）。
   *
   * ⚠ 用途：构造 `claimZcodePlan` 的 `code` 为 `undefined` 的形态 ——
   * 例如**合法 JSON 但没有 `code` 字段**（审计 F1 的关键形态），
   * 或**字符串码** `{"code":"3012"}`（审计 F2）。这两类用 `code:+msg` 拼不出来。
   */
  rawBody?: string
}): {
  fetchImpl: typeof fetch
  claimCalls: () => number
} {
  let claimCalls = 0
  const codes = options.claimCodes ?? [{
    code: options.claimCode ?? 3012,
    status: options.claimStatus ?? 405,
  }]
  const fetchImpl = (async (url: string) => {
    if (url.includes('/event/report')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/billing/preview')) {
      const plans = options.plans.map((plan_id, index) => ({ plan_id, priority: index }))
      return new Response(JSON.stringify({ data: { plans } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/billing/claim')) {
      const step = codes[Math.min(claimCalls, codes.length - 1)] ?? { code: 3012, status: 405 }
      claimCalls += 1
      const body = options.rawBody ?? JSON.stringify({
        code: step.code,
        msg: step.code === 3007
          ? 'captcha verify failed'
          : 'request has been blocked due to unusual activity.',
      })
      return new Response(body, {
        status: step.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/client/configs')) {
      return new Response(JSON.stringify({
        data: { configs: { captcha: { region: 'sgp', prefix: 'pf-sgp', sceneId: '11xygtvd' } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, claimCalls: () => claimCalls }
}

async function makeAuth(fetchImpl: typeof fetch): Promise<ZcodeAuth> {
  const ctx = new Context()
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(CREDENTIAL))
  return new ZcodeAuth(ctx, { fetchImpl })
}

/**
 * 把 `ZcodeAuth` 的内部载体换成**快返回的假实现**。
 *
 * ## 为什么需要它（写用例时实测踩到的坑）
 *
 * 要让首发走**内部载体**那一腿（`minted.source === 'internal'`，这是触发
 * 3007 换链重发的唯一入口），必须让 `carrier.mint()` 返回 `internal`。
 * 而真载体的 `mint()` 在供给槽为空时会**有界等待**一个永不到来的 param
 * ⇒ 用例挂在 5 秒超时上，且**报错形状是超时而不是断言失败**（更难排查）。
 *
 * ⚠ 直接投槽（`putSuppliedParam`）不够：槽是**一次性**的，首发取走之后
 * 第二发（下一个 plan 或重发）又会落回等待。故这里整体替换载体。
 * ⚠ `carrier` 是公开 `readonly` 字段，替换是测试专用手法（生产写入者只有构造函数）。
 *
 * ## ⚠⚠ 还必须投一次槽，否则 `source` 根本不会是 `internal`
 *
 * `internalCarrierAvailable()` 的判据是 **`DSH_ZCODE_INTERNAL_CARRIER` 没关
 * 且 `captchaSupplyStats().supplied > 0`**（见 `zcode-auth.ts`）——
 * 换掉载体**不改变**这个判据。不投槽 ⇒ 判据为假 ⇒ `mintClaimCaptcha`
 * 走注入链、`source === 'chromium'` ⇒ **3007 换链重发根本不会发生**，
 * 用例会以「claims=1」这种看不出原因的形态失败（写这条时实测踩到）。
 * 假载体不消费槽，故投一次即可让本次领取全程为 `internal`。
 */
function installFakeCarrier(auth: ZcodeAuth, source: 'internal' | 'chromium' = 'internal'): void {
  // 抬「收到过贡献」这个闩锁（判据见上），使 `source` 真的是 `internal`。
  putSuppliedParam(fakeParam('carrier-latch'), Date.now())
  ;(auth as unknown as { carrier: unknown }).carrier = {
    mint: async () => ({ param: fakeParam('carrier-mint'), source }),
    mintWithFallbackAfterRejection: async () => ({ param: fakeParam('carrier-retry'), source: 'chromium' }),
    noteInternalRejection: () => {},
    stats: () => ({}),
  }
}

beforeEach(() => {
  resetZcodeDiagnostics()
  resetCaptchaSupply()
  resetCaptchaRequirementMemory()
})

// ───────────────────────── 1. 文案 ─────────────────────────

describe('IKJOQB 问题一：领取路径的 3012 文案', () => {
  it('★★ 不再输出裸上游串，而是风控 + 冷却警告 + planId', () => {
    const planId = 'zcode-v3-start-plan-trust-1005'
    const outcome = toClaimOutcome(outcome3012(planId), planId)

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    // ★ 修复前的形态（下面的断言正是它曾经的样子）：只有裸上游串
    expect(outcome.message).not.toBe(
      `${planId}: request has been blocked due to unusual activity.`,
    )
    expect(outcome.code).toBe(3012)
    expect(outcome.message).toContain('上游风控拦截')
    expect(outcome.message).toContain('unusual activity')
    // ★ 这三样是 issue 说的「第二个信息缺失，且有实际代价」
    expect(outcome.message).toContain('冷却')
    expect(outcome.message).toContain('30 分钟')
    expect(outcome.message).toContain('请勿连续重试')
    // 定位信息（哪个 plan）不能丢
    expect(outcome.message).toContain(planId)
  })

  it('★ 诊断行附在 3012 文案里（issue 的第二个诉求）', () => {
    const planId = 'plan-1'
    const outcome = toClaimOutcome(outcome3012(planId), planId, {
      accountId: 'acct-A',
      sentAt: 1_000,
      status: 405,
    })
    if (outcome.kind !== 'failed') throw new Error('应当是 failed')
    expect(outcome.message).toContain('本机诊断：')
    expect(outcome.message).toContain('账号#1')
    expect(outcome.message).toContain('HTTP 405')
  })

  it('★ 没给诊断现场时**不出现空壳**「本机诊断：」', () => {
    const outcome = toClaimOutcome(outcome3012('plan-1'), 'plan-1')
    if (outcome.kind !== 'failed') throw new Error('应当是 failed')
    expect(outcome.message).not.toContain('本机诊断')
    // 但风控与冷却警告仍必须在（诊断只是附加项）
    expect(outcome.message).toContain('请勿连续重试')
  })

  /**
   * ★★ **对抗性审计打出的同义反复**（2026-10-05 修）。
   *
   * 这条用例原名「字符串码 `"3012"` 同样识别」，但它传的是 `3012 as number`
   * —— **TS 断言不改变运行时值**（`typeof` 仍是 `number`），所以它测的是
   * 数字码、**从未覆盖字符串分支**。而那个分支在领取路径上恰恰是**死代码**：
   * 上游的 `{"code":"3012"}` 在更上游被 `num()` 吃掉，传到这里已是 `undefined`。
   * ⇒ 该盲区永远不会变红（审计用 `typeof` 实测确认）。
   *
   * ⇒ 现在从**真实解析路径**（`claimZcodePlan`，桩 fetch 回上游原始响应体）
   * 验证字符串码，并断言它**没有**退回 issue 的裸上游串。
   */
  it('★★ 字符串码 "3012" 从真实解析路径也能识别（不得退回裸上游串）', async () => {
    const body = '{"code":"3012","msg":"request has been blocked due to unusual activity."}'
    const fetchStub = (async () => new Response(body, {
      status: 405,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    // ① 解析层：字符串码必须被归一成数字（此前被 num() 丢弃 ⇒ undefined）
    const parsed = await claimZcodePlan(
      { zcode_jwt: 'j', device_mid: 'm' } as never,
      'zcode-v3-start-plan-trust-1005',
      { param: 'p', region: 'cn' },
      fetchStub,
    )
    expect(parsed.code).toBe(3012)
    // ② 判据层
    expect(isClaimUnusualActivity(parsed)).toBe(true)
    // ③ 文案层：必须带风控与冷却警告，**不是** issue 的裸上游串
    const mapped = toClaimOutcome(parsed, 'zcode-v3-start-plan-trust-1005')
    if (mapped.kind !== 'failed') throw new Error('应当是 failed')
    expect(mapped.message).not.toBe(
      'zcode-v3-start-plan-trust-1005: request has been blocked due to unusual activity.',
    )
    expect(mapped.message).toContain('上游风控拦截')
    expect(mapped.message).toContain('请勿连续重试')
  })

  it('数字码与字符串码的判据等价（纯函数侧）', () => {
    expect(isZcodeUnusualActivityCode(3012)).toBe(true)
    expect(isZcodeUnusualActivityCode('3012')).toBe(true)
    expect(isZcodeUnusualActivityCode(3007)).toBe(false)
    expect(isZcodeUnusualActivityCode(13012)).toBe(false)
    // ⚠ 顺带钉住「TS 断言不改运行时值」这个陷阱本身
    expect(typeof (3012 as number)).toBe('number')
  })

  /**
   * ★★ **F2 修复的附带收益**：字符串码此前不只在风控分支丢失，
   * **幂等（`1003`）与成功（`0`）两个分支同样被 `num()` 吃掉** ——
   * 那会把「今天已领取过」误报成**失败**，把「领取成功」也误报成失败。
   * 修好解析层后这两条一并成立，故一并钉住（否则将来只回退一半又要重犯）。
   */
  it('★★ 字符串码的幂等（1003）与成功（0）分支也要成立', async () => {
    const stub = (b: string, s = 200) => (async () => new Response(b, {
      status: s, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const cred = { zcode_jwt: 'j', device_mid: 'm' } as never

    // `"1003"` = 已领取过（幂等成功，**不是**错误）
    const idem = await claimZcodePlan(cred, 'p', { param: 'x', region: 'cn' }, stub('{"code":"1003","msg":"done"}'))
    expect(idem.code).toBe(1003)
    expect(idem.ok).toBe(true)
    expect(toClaimOutcome(idem, 'p').kind).toBe('already-claimed')

    // `"0"` = 成功领取
    const ok = await claimZcodePlan(cred, 'p', { param: 'x', region: 'cn' }, stub('{"code":"0"}'))
    expect(ok.code).toBe(0)
    expect(ok.ok).toBe(true)
    expect(toClaimOutcome(ok, 'p').kind).toBe('claimed')
  })

  it('解析层的边界：只认纯数字串，不把任意文本变成业务码', () => {
    expect(parseZcodeBusinessCode(' 3012 ')).toBe(3012)
    expect(parseZcodeBusinessCode('abc')).toBeUndefined()
    expect(parseZcodeBusinessCode('12x')).toBeUndefined()
    expect(parseZcodeBusinessCode('')).toBeUndefined()
    expect(parseZcodeBusinessCode(null)).toBeUndefined()
    expect(parseZcodeBusinessCode({})).toBeUndefined()
    expect(parseZcodeBusinessCode(Number.NaN)).toBeUndefined()
    expect(parseZcodeBusinessCode(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  /**
   * ★★ **审计 N1 打出的真实缺陷**（2026-10-05 修）。
   *
   * `claimZcodePlan` 对非 JSON 正文做 `text.slice(0, 200)` 供**展示**，
   * 而下游判据读的正是 `message` ⇒ 当网关噪声 >200 字符、风控短语落在
   * 截断点之后时，判据看到的是**被截掉的串**：
   *
   * ```
   * 完整 body 长度=230，hasZcodeUnusualActivity(全body)=true
   * → message 长度=200、含风控短语=false ⇒ 真风控被降级成通用失败
   * ```
   *
   * 症状**正是本 issue 的原症状**。⇒ 判据移到**能看到完整正文**的解析层：
   * 命中即把 `code` 归一成 `3012`，下游统一走「有码只信码」。
   */
  it('★★ N1：正文比 200 字符长时，真风控仍要识别（截断不得吃掉判据）', async () => {
    const body = `${'x'.repeat(180)} request has been blocked due to unusual activity.`
    // 前置事实：完整正文能被判据认出，但截断到 200 后短语就没了
    expect(hasZcodeUnusualActivity(body)).toBe(true)
    expect(body.slice(0, 200).includes('unusual activity')).toBe(false)

    const parsed = await claimZcodePlan(
      { zcode_jwt: 'j', device_mid: 'm' } as never,
      'p',
      { param: 'x', region: 'cn' },
      (async () => new Response(body, {
        status: 405, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    )
    // ★ 解析层已把正文里的风控归一成 code
    expect(parsed.code).toBe(3012)
    expect(isClaimUnusualActivity(parsed)).toBe(true)
    const mapped = toClaimOutcome(parsed, 'p')
    if (mapped.kind !== 'failed') throw new Error('应当是 failed')
    expect(mapped.message).toContain('上游风控拦截')
    expect(mapped.message).toContain('请勿连续重试')
  })

  it('★ N1 的边界：上游给了权威业务码时不得被正文覆盖', async () => {
    // code=1005（额度）正文里恰好含风控短语 ⇒ 必须仍是 1005
    const parsed = await claimZcodePlan(
      { zcode_jwt: 'j', device_mid: 'm' } as never,
      'p',
      { param: 'x', region: 'cn' },
      (async () => new Response('{"code":1005,"msg":"unusual activity"}', {
        status: 429, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    )
    expect(parsed.code).toBe(1005)
    expect(isClaimUnusualActivity(parsed)).toBe(false)
  })

  /**
   * ★★ **覆盖矩阵**：把「应当命中」与「应当不命中」的变体一次性钉住。
   *
   * 判据经两轮收紧（`includes` → 词边界 → 词边界+语义共现），每次收紧都有
   * **反向风险**：修误判时容易把真风控一起漏掉。故两个方向都要有样本 ——
   * 尤其「`unusual activity` 原文**不含数字**」这一点，是我第一版语义判据
   * 用「独立词 3012」当门禁时**反过来漏掉**的形态（写用例时实测到）。
   */
  describe('★★ 判据覆盖矩阵（两个方向都钉住）', () => {
    const shouldHit: readonly string[] = [
      'request has been blocked due to unusual activity.',          // 上游 msg 原文
      '{"code":3012}',                                              // 有码无文案
      '{"code":"3012","msg":"…"}',                                  // 字符串码
      'blocked due to unusual activity',
      'Unusual activity detected',
      '3012 blocked by waf',                                        // 无码 + 数字 + block
    ]
    const shouldMiss: readonly string[] = [
      'too many requests, retry after 3012 ms',                     // 限流（审计 F1）
      '<h1>Error 3012</h1>upstream connect timeout',                // 网关瞬断（审计 F1）
      '{"code":3007,"msg":"captcha failed"}',                       // 3007 可重试
      '{"code":1005,"msg":"exceed quota limit"}',                   // 1005 额度
      'plan plan-3012 not found',                                   // 标识符含 3012
      'upstream error 13012',                                       // 数字片段
    ]

    it('应当命中：真风控六种形态', () => {
      for (const body of shouldHit) {
        expect(hasZcodeUnusualActivity(body), `漏判：${body}`).toBe(true)
      }
    })

    it('应当不命中：六种非风控形态（误判会让用户做反的事）', () => {
      for (const body of shouldMiss) {
        expect(hasZcodeUnusualActivity(body), `误判：${body}`).toBe(false)
      }
    })

    /**
     * ★★ **一致性不变量**：两个消费者（文案侧 `hasZcodeUnusualActivity` 与
     * 可重试性侧 `httpErrorCodeForZcode`）对同一正文必须给出**同一判断**。
     *
     * ⚠ 这正是审计 F3 的病根：两处**各写一份**判据，改一处就会漂移
     * （`describeUpstreamError` 收窄了、`httpErrorCodeForZcode` 没跟上）。
     * 现在它们共用 helper，本用例把「不分叉」这件事本身钉住。
     */
    it('★★ 两个消费者对同一正文必须一致（防再次只改一半）', () => {
      for (const body of [...shouldHit, ...shouldMiss]) {
        const classifiedAsWindControl = httpErrorCodeForZcode(405, body) === 'PERMISSION'
        expect(
          classifiedAsWindControl,
          `判据分叉：helper=${String(hasZcodeUnusualActivity(body))} vs PERMISSION=${String(classifiedAsWindControl)} | ${body}`,
        ).toBe(hasZcodeUnusualActivity(body))
      }
    })

    /**
     * ★★ **审计 N2 打出的真实缺陷**（2026-10-05 修）。
     *
     * 语义兜底原写成「独立词 `3012` **且** 全文含 `block`」⇒ 含 `blocked`
     * 字样的**限流**正文被误判成风控。两者动作相反（限流：稍后重试；
     * 风控：**别重试**）。
     *
     * ⚠ 修的时候还踩了一次：第一版用 **40 字符窗口**判「邻近」，实测
     *   `blocked, retry after 3012`（距 14）与 `blocked; see error 3012`
     *   （距 12）**仍然命中** ⇒ 收紧到 10 才把两个反例排除。
     */
    it('★★ N2：含 blocked 字样的限流正文不得被判成风控', () => {
      expect(hasZcodeUnusualActivity('rate limited: request blocked, retry after 3012 ms')).toBe(false)
      expect(hasZcodeUnusualActivity('temporarily blocked; see error 3012')).toBe(false)
      expect(httpErrorCodeForZcode(429, 'rate limited: request blocked, retry after 3012 ms')).toBe('RATE_LIMIT')
      // 而紧邻形态仍要命中
      expect(hasZcodeUnusualActivity('3012 blocked by waf')).toBe(true)
    })
  })

  /**
   * ★★ **对抗性审计 F1 打出的真实缺陷**（2026-10-05 修）。
   *
   * `code` 缺失时（**合法 JSON 但没有 `code` 字段**也算，不只是非 JSON），
   * 初版仅凭「正文含独立 `3012`」就判风控 ⇒ 把**限流**误判成**账号级风控**：
   *
   * | 正文（无码） | 后果 |
   * |---|---|
   * | `too many requests, retry after 3012 ms` | 限流（稍后重试）被改写成风控（**别重试**）—— 动作完全相反 |
   * | `<h1>Error 3012</h1>upstream connect timeout` | 网关瞬断被改写成风控 |
   *
   * 且领取路径据此**短路**（审计实测：3 个 plan 只发了 1 发）。
   * ⇒ 收紧为「词边界 + **风控语义共现**」（`mentionsZcodeUnusualActivity`）。
   */
  it('★★ 限流正文里的毫秒数 3012 不得被误判成风控', () => {
    expect(isClaimUnusualActivity({
      planId: 'p', ok: false, message: 'too many requests, retry after 3012 ms',
    })).toBe(false)
    expect(isClaimUnusualActivity({
      planId: 'p', ok: false, message: '<h1>Error 3012</h1><p>upstream connect timeout</p>',
    })).toBe(false)
    // 而**真正的**风控正文（语义共现）仍要命中
    expect(isClaimUnusualActivity({
      planId: 'p', ok: false, message: 'request has been blocked due to unusual activity.',
    })).toBe(true)
  })

  it('★★ 误判的短路后果：限流形态下必须继续发后续 plan', async () => {
    /**
     * 上游回 HTTP 429 + `{"msg":"too many requests, retry after 3012 ms"}`
     * —— **合法 JSON 但没有 `code` 字段**（审计指出的关键形态）。
     */
    const net = makeClaimFetch({
      plans: ['p1', 'p2', 'p3'],
      claimCodes: [{ code: -1, status: 429 }],
      rawBody: '{"msg":"too many requests, retry after 3012 ms"}',
    })
    const auth = await makeAuth(net.fetchImpl)
    const outcomes = await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))

    // ★ 三个 plan 都要发（没有被误判短路）
    expect(net.claimCalls()).toBe(3)
    expect(outcomes.length).toBe(3)
    for (const o of outcomes) {
      if (o.kind === 'failed') {
        expect(o.message).not.toContain('风控')
        expect(o.message).not.toContain('请勿连续重试')
      }
    }
  })

  it('无码时靠正文词边界识别（非 JSON 响应体形态）', () => {
    // ⚠ 现在还要过「风控语义共现」这一关（见上面的误判防线）
    expect(isClaimUnusualActivity({
      planId: 'p1', ok: false,
      message: '{"code":3012,"msg":"blocked due to unusual activity"}',
    })).toBe(true)
    expect(looksLikeZcodeUnusualActivity('{"code":3012}')).toBe(true)
    expect(looksLikeZcodeUnusualActivity('error: 3012 unusual activity')).toBe(true)
  })

  /**
   * ★★ **自审抓出来的第三个真实缺陷**（2026-10-05 修）。
   *
   * 初版判据是「`code === 3012` **或** `message` 含 `3012`」—— 那个「或」是错的：
   * `code` 一旦解析出来就是**权威**，再去扫 `message` 的自由文本会误判。
   * 实测被误判的形态：`plan plan-3012 not found`、`quota 3012 exceeded`、
   * 以及**任何含 `3012` 数字片段的其它码**（如 `13012`）。
   *
   * ⚠ 后果**不是文案问题**：领取路径据此短路，会**跳过本可领取的 plan**，
   * 并把真实业务码改写成 `3012` —— 而 `1005`（等额度重置）与 `3012`
   * （别重试）的用户动作完全相反。
   */
  describe('★★ 误判防线：code 明确时只信 code', () => {
    it('planId 里含 3012 的普通失败**不得**被判成风控', () => {
      const outcome: ZcodeClaimOutcome = {
        planId: 'plan-3012',
        ok: false,
        code: 1001,
        message: 'plan plan-3012 not found',
      }
      expect(isClaimUnusualActivity(outcome)).toBe(false)
      const mapped = toClaimOutcome(outcome, outcome.planId)
      if (mapped.kind !== 'failed') throw new Error('应当是 failed')
      // ★ 业务码必须**原样**是 1001，不能被改写成 3012
      expect(mapped.code).toBe(1001)
      expect(mapped.message).not.toContain('风控')
      expect(mapped.message).not.toContain('请勿连续重试')
    })

    it('额度用尽（1005）的正文里含 3012 也**不得**被判成风控', () => {
      const outcome: ZcodeClaimOutcome = {
        planId: 'p1',
        ok: false,
        code: 1005,
        message: 'quota 3012 exceeded',
      }
      /** ⚠ 这条尤其危险：`1005` 要「等额度重置」，`3012` 要「别重试」—— 动作相反。 */
      expect(isClaimUnusualActivity(outcome)).toBe(false)
      const mapped = toClaimOutcome(outcome, 'p1')
      if (mapped.kind !== 'failed') throw new Error('应当是 failed')
      expect(mapped.code).toBe(1005)
    })

    it('词边界：13012 / 2003012 / plan-3012 里的数字片段**不得**命中', () => {
      expect(looksLikeZcodeUnusualActivity('upstream error 13012')).toBe(false)
      expect(looksLikeZcodeUnusualActivity('err 2003012')).toBe(false)
      expect(looksLikeZcodeUnusualActivity('plan-3012-trust')).toBe(false)
      expect(isZcodeUnusualActivityCode(13012)).toBe(false)
      // 而真正独立的 3012 要命中
      expect(looksLikeZcodeUnusualActivity('code 3012 blocked')).toBe(true)
      expect(looksLikeZcodeUnusualActivity('{"code":3012}')).toBe(true)
    })

    it('★★ 误判会短路掉本可领取的 plan —— 用真实领取路径验', async () => {
      /**
       * 首发返回 `1001` + `plan-3012 not found`（**非风控**）。
       * 修复前：判成风控 ⇒ 短路 ⇒ 只发 1 发；
       * 修复后：如实失败 ⇒ 继续 ⇒ 发 2 发。
       */
      const net = makeClaimFetch({
        plans: ['p1', 'p2'],
        claimCodes: [{ code: 1001, status: 400 }],
      })
      const auth = await makeAuth(net.fetchImpl)
      const outcomes = await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))

      // ★ 两个 plan 都必须发出去（没有被误判短路）
      expect(net.claimCalls()).toBe(2)
      expect(outcomes.length).toBe(2)
      for (const o of outcomes) {
        if (o.kind === 'failed') {
          expect(o.message).not.toContain('风控')
          expect(o.message).not.toContain('请勿连续重试')
        }
      }
    })
  })

  it('★ 3007 不得被误判成风控（两者处置**方向相反**）', () => {
    const outcome: ZcodeClaimOutcome = { planId: 'p1', ok: false, code: 3007, message: 'captcha verify failed' }
    expect(isClaimUnusualActivity(outcome)).toBe(false)
    const mapped = toClaimOutcome(outcome, 'p1')
    if (mapped.kind !== 'failed') throw new Error('应当是 failed')
    expect(mapped.message).toContain('captcha')
    expect(mapped.message).not.toContain('风控')
    expect(mapped.message).not.toContain('请勿连续重试')
  })
})

// ───────────────────────── 2. 两路同源 ─────────────────────────

describe('IKJOQB：两条路径的 3012 文案同源（防再次漂移）', () => {
  it('★★ 领取侧与推理侧引用**同一份**措辞', () => {
    const planId = 'plan-1'
    const claim = toClaimOutcome(outcome3012(planId), planId)
    const infer = describeUpstreamError(405, BODY_3012)
    if (claim.kind !== 'failed') throw new Error('应当是 failed')

    /**
     * ⚠ 断言的是**共用实现的完整首句与警告句**，而不是零散关键词 ——
     * 零散关键词无法发现「两边各写一半」的漂移。
     */
    const core = '上游风控拦截（3012 unusual activity）'
    const warning = '⚠ 该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），请勿连续重试。'
    expect(claim.message).toContain(core)
    expect(infer).toContain(core)
    expect(claim.message).toContain(warning)
    expect(infer).toContain(warning)
  })

  it('★ 源码层：`zcode-adapter.ts` 不再自带一份 3012 措辞（只有一个出处）', () => {
    const adapter = readFileSync(resolve(HERE, '../../src/zcode-adapter.ts'), 'utf8')
    // 推理侧改为调用共用函数
    expect(adapter).toMatch(/formatZcodeUnusualActivityMessage\(/)
    // ⚠ 硬编码的那句话**只能**出现在 zcode-diagnostics.ts 里
    expect(adapter).not.toMatch(/该错误有账号冷却惩罚（30 分钟/)
    // 领取侧同样只引用共用函数
    expect(authSource).toMatch(/formatZcodeUnusualActivityMessage\(/)
    expect(authSource).not.toMatch(/该错误有账号冷却惩罚（30 分钟/)
  })

  /**
   * ★★ **对抗性审计 F3 打出的真实缺陷**（2026-10-05 修）。
   *
   * `zcode-adapter.ts` 里两个判据**只改了一半**：`describeUpstreamError` 当时已
   * 改用收窄的 helper，而**同一个文件**的 `httpErrorCodeForZcode` 仍是裸
   * `trimmed.includes('3012')`。
   *
   * 后果**不是文案**：正文含 `13012` 的**瞬断 5xx** 被归成 `PERMISSION`，
   * 而 `PERMISSION` **不在** harness 的 `DEFAULT_RETRYABLE_CODES` 里
   * ⇒ 本该自愈的重试被**放弃**（`13012` 根本不是 3012）。
   *
   * ⇒ 现在两处都走 `hasZcodeUnusualActivity`（同一份判据）。
   */
  describe('★★ 同一文件里的兄弟判据必须同源（F3）', () => {
    it('正文含 13012 的瞬断 5xx 必须是 SERVER（可重试），不是 PERMISSION', () => {
      expect(httpErrorCodeForZcode(500, 'upstream error 13012')).toBe('SERVER')
      expect(httpErrorCodeForZcode(503, 'backend 13012 unavailable')).toBe('SERVER')
      // 对照：不含 3012 的 5xx 本来就是 SERVER
      expect(httpErrorCodeForZcode(503, 'backend unavailable')).toBe('SERVER')
    })

    it('★ 真 3012 仍必须是 PERMISSION（不可重试）—— 收紧不得变成漏判', () => {
      expect(httpErrorCodeForZcode(405, '{"code":3012,"msg":"request has been blocked"}')).toBe('PERMISSION')
      // 无码形态：正文含风控语义 + 独立 3012
      expect(httpErrorCodeForZcode(405, 'blocked due to unusual activity (3012)')).toBe('PERMISSION')
      // ⚠ 且不在可重试集合里（这是「不可重试」的判据本身）
      expect(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
        .not.toContain(httpErrorCodeForZcode(405, '{"code":3012}'))
    })

    it('源码层：两处判据都引用同一个 helper（防再次只改一半）', () => {
      const adapter = readFileSync(resolve(HERE, '../../src/zcode-adapter.ts'), 'utf8')
      // httpErrorCodeForZcode 里不得再有裸的 includes('3012')
      const fnStart = adapter.indexOf('export function httpErrorCodeForZcode')
      const fnBody = adapter.slice(fnStart, adapter.indexOf('\n}', fnStart))
      expect(fnBody).not.toMatch(/includes\('3012'\)/)
      expect(fnBody).toMatch(/hasZcodeUnusualActivity/)
    })
  })

  it('推理侧不传 subject ⇒ 首句与历史输出**逐字一致**（老用例不受影响）', () => {
    const infer = describeUpstreamError(405, BODY_3012)
    expect(infer.startsWith('上游风控拦截（3012 unusual activity）。')).toBe(true)
    // 而领取侧传了 subject ⇒ 首句带定位信息
    const claim = formatZcodeUnusualActivityMessage({ subject: 'plan-9' })
    expect(claim.startsWith('上游风控拦截（3012 unusual activity） · plan-9。')).toBe(true)
  })

  /**
   * ★★ **反向验证抓出来的真实回归**（改共用文案时引入，当场修掉）。
   *
   * `describeUpstreamError` 原先在**自己**这层把诊断拼成 `本机诊断：…\n`，
   * 抽走文案后若把这个**已拼好的**串传给共用函数，前缀会被加**两次** ⇒
   * 用户看到 `本机诊断：本机诊断：账号#1 · …`。
   *
   * ⚠ 为什么既有的 `toContain('本机诊断：')` 抓不到它：子串判定对
   * 「前缀重复」是**恒真**的 —— 重复一次、两次、十次都通过。
   * ⇒ 这里改成**计数**判据（`matchAll`），这才是能抓住重复的那种断言。
   */
  it('★★ 诊断前缀**只出现一次**（计数判据，防前缀重复）', () => {
    const diagnostic = '账号#1 · 本进程 成功 3/失败 1'
    const infer = describeUpstreamError(405, BODY_3012, diagnostic)
    const claim = formatZcodeUnusualActivityMessage({ diagnostic, rawResponse: 'blocked' })

    for (const text of [infer, claim]) {
      const hits = [...text.matchAll(/本机诊断/g)].length
      expect(hits, `本机诊断 出现了 ${String(hits)} 次：\n${text}`).toBe(1)
      expect(text).not.toContain('本机诊断：本机诊断')
    }
    // 且诊断内容本身完整（不是被截了一半）
    expect(infer).toContain(diagnostic)
    expect(claim).toContain(diagnostic)
  })
})

// ───────────────────────── 3. 诊断埋点 ─────────────────────────

describe('IKJOQB 问题二：领取路径接上诊断模块', () => {
  it('★ 源码层：领取侧 import 了诊断模块（此前零命中）', () => {
    expect(authSource).toMatch(/from '\.\/zcode-diagnostics\.js'/)
    expect(authSource).toMatch(/noteZcodeRequestSent/)
    expect(authSource).toMatch(/noteZcodeRequestOk/)
    expect(authSource).toMatch(/noteZcodeRequestFailed/)
  })

  it('★★ 缺 shape 时**只少两项**，账号画像与频率照常输出', () => {
    /**
     * 领取请求体只有 `{ plan_id }`，没有 `system` / `messages`
     * ⇒ 不能照搬推理侧的 `describeZcodeRequestShape`（那会得到
     * 「身份块 0 字符」，**把一条正常请求误报成身份块缺失**）。
     */
    const line = formatZcodeDiagnostic({
      accountId: 'acct-A',
      sentAt: 2_000,
      status: 405,
      now: 2_000,
    })
    // 五项与请求形态无关的照常输出 —— 它们才是 3012 排查里最有价值的
    expect(line).toContain('账号#')
    expect(line).toContain('本进程 成功')
    expect(line).toContain('最近成功')
    expect(line).toContain('距上条')
    expect(line).toContain('HTTP 405')
    // 两项形态相关的**整组消失**（而不是显示 0）
    expect(line).not.toContain('身份块')
    expect(line).not.toContain('日期块')
  })

  it('★★ 领取路径真实记账：每发都记 sent，并按结果记 ok/failed', async () => {
    const net = makeClaimFetch({ plans: ['p1'], claimCode: 0, claimStatus: 200 })
    const auth = await makeAuth(net.fetchImpl)
    expect(putSuppliedParam(fakeParam('internal'), Date.now())).toBe(true)

    const outcomes = await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))
    expect(outcomes[0]?.kind).toBe('claimed')

    /**
     * ⚠ 账号标识取「池条目 id」，而本用例没有账号池 ⇒ 反查降级为
     * `undefined`（诊断里归一成 `-`）。这里断言的是**计数确实被记上了**。
     * 与推理侧同一个 key（`-`）也说明两条路径的画像不会各记一份。
     */
    const line = formatZcodeDiagnostic({ accountId: undefined, sentAt: 1, status: 200, now: 1 })
    expect(line).toContain('本进程 成功 1/失败 0')
  })

  it('★ 3012 的那一发记成 failed（不是 ok）', async () => {
    const net = makeClaimFetch({ plans: ['p1'] })
    const auth = await makeAuth(net.fetchImpl)
    expect(putSuppliedParam(fakeParam('internal'), Date.now())).toBe(true)

    await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))
    const line = formatZcodeDiagnostic({ accountId: undefined, sentAt: 1, status: 405, now: 1 })
    expect(line).toContain('本进程 成功 0/失败 1')
  })

  /**
   * ★★ **反向验证抓出来的真实缺陷**（2026-10-05 修）。
   *
   * `retryClaimWithInjectedChain`（3007 换链重发那一发）最初**沿用首发**的
   * `sentAt` 去调 `noteZcodeRequestSent`。而该参数的语义是「**本次**出发时刻」，
   * `previousSentAt` 才是「上一条」的分母 ⇒ 旧值下沉时被写成首发时刻 == 本次
   * ⇒ 诊断的「距上条」**恒定算出 `0ms`**，这一项永久失去信息量。
   *
   * 实测（探针输出，修复前）：
   * ```
   * 账号#1 · 本进程 成功 1/失败 2 · 最近成功 16分39秒前 · 距上条 0ms · HTTP 405
   * ```
   *
   * ⚠ 本仓库在**推理侧**为同一个坑写过专门用例（`zcode-diagnostics.spec.ts`
   * 的「距上条算的是**上一条**请求」）—— 而那条是**纯函数**用例，
   * 覆盖不到领取路径的调用顺序。这正是「纯函数测了、装配没测」的盲区。
   *
   * ⇒ 这里按**领取路径的真实调用顺序**验：先有真实历史，再走 3007 换链重发，
   * 断言重发之后「距上条」**不是 0ms**。
   */
  it('★★ 重发的「距上条」不得退化成 0ms（沿用首发时刻就会）', async () => {
    /**
     * 构造「首发 3007 ⇒ 换链重发 ⇒ 重发撞 3012」：
     * 这样重发那一发的诊断行会**直接出现在用户可见的文案里**，
     * 于是「距上条」的值可以被外部断言 —— 否则 `sentAt` 是内部取的，观测不到。
     */
    const net = makeClaimFetch({
      plans: ['p1'],
      claimCodes: [
        { code: 3007, status: 400 },   // 首发：captcha 被拒 ⇒ 触发换链重发
        { code: 3012, status: 405 },   // 重发：撞风控 ⇒ 带诊断的文案
      ],
    })
    const auth = await makeAuth(net.fetchImpl)
    /**
     * ⚠ 换成快返回的假载体（`source='internal'`）⇒ 首发才走换链重发那条分支。
     * 投槽的老写法不够：槽是一次性的，重发那一发会落回载体的**有界等待**。
     */
    installFakeCarrier(auth)

    /**
     * ⚠⚠ **注入链必须真的耗时**，否则本用例测不出东西。
     *
     * 首发的 param 取自供给槽（`carrier.mint()`），**不调注入链**；
     * 只有**重发**走注入链（`retryClaimWithInjectedChain` 的 `await injected(...)`）。
     * 而真实的注入链要「建 guest → 导航载体页 → 加载 SDK → 无感验证」约 2–4 秒。
     *
     * 桩 fetch 是零延迟的：若注入链也零延迟，首发与重发会落在**同一毫秒**，
     * 于是「取自己的时刻」与「沿用首发时刻」两种实现**都**得到 `0ms` ——
     * 这条用例就变成了恒真断言（我第一版正是这么写错的，实测两边都是 0ms）。
     * ⇒ 让注入链等 25ms，两种实现才被区分开。
     */
    const injectedMint = async (config: { sceneId: string }): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return fakeParam(`x-${config.sceneId}`)
    }

    /**
     * ⚠ 铺一条**更早的**历史（同一个 key：本用例没有账号池 ⇒ 归一成 `-`）。
     */
    const EPOCH = Date.now() - 90_000
    noteZcodeRequestSent(undefined, EPOCH)
    noteZcodeRequestOk(undefined, EPOCH + 10)

    const outcomes = await auth.claimDaily(injectedMint)

    // 两次上游请求都发出去了（首发 + 重发）
    expect(net.claimCalls()).toBe(2)
    const failed = outcomes.find((o) => o.kind === 'failed')
    expect(failed, '应当有一条 failed（重发撞 3012）').toBeDefined()
    if (failed?.kind !== 'failed') throw new Error('应当是 failed')

    // 文案里带诊断行 ⇒ 可以直接断言「距上条」
    console.log('[重发撞 3012 的完整文案]\n' + failed.message)
    expect(failed.message).toContain('本机诊断：')
    /**
     * ★ 关键断言：**不是 `0ms`**。
     *
     * - 「沿用首发时刻」（缺陷版）：`previousSentAt` == 诊断的 `sentAt`
     *   ⇒ 数学上**恒为 0ms**，与本用例的 25ms 延迟无关；
     * - 「取自己的时刻」（修复版）：`previousSentAt` = 首发时刻，
     *   而重发时刻在其后 ≥25ms ⇒ 显示 `2x ms`。
     */
    expect(failed.message).not.toContain('距上条 0ms')
    const gap = /距上条 (\d+)ms/.exec(failed.message)
    expect(gap, `未匹配到毫秒级间隔：${failed.message}`).not.toBeNull()
    expect(Number(gap?.[1])).toBeGreaterThanOrEqual(25)
  })
})

// ───────────────────────── 4. 短路 ─────────────────────────

describe('IKJOQB 延伸：命中 3012 必须短路，不再加重冷却惩罚', () => {
  it('★★ 多个 plan 时只发**一发**（首发 3012 即终止）', async () => {
    /**
     * ⚠ **不投槽**（`putSuppliedParam`）：投了就使 `internalCarrierAvailable()`
     * 为真，短路一旦失效，第二发会落到载体链的**有界等待**（等一个永不到来的
     * param）⇒ 用例以**超时**变红而不是以断言变红，反向验证的说服力更弱。
     * 不投 ⇒ `source === 'chromium'`，`mintClaimCaptcha` 直接走注入链、不等待，
     * 于是「有几个 plan 就发几发」，断言能精确命中。
     */
    const net = makeClaimFetch({ plans: ['p1', 'p2', 'p3'] })
    const auth = await makeAuth(net.fetchImpl)

    const outcomes = await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))

    // ★ 关键断言：3 个 plan 只打了一次 claim
    expect(net.claimCalls()).toBe(1)
    // 且只产出一条 outcome（被拦的那条），其余 plan 如实跳过
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.kind).toBe('failed')
    if (outcomes[0]?.kind === 'failed') {
      expect(outcomes[0].code).toBe(3012)
      expect(outcomes[0].message).toContain('请勿连续重试')
    }
  })

  it('★ 对照组：3007（captcha）**不**短路 —— 它是要换新 param 重试的', async () => {
    /**
     * ⚠ **不投槽**：`internalCarrierAvailable()` 判据含「本进程收到过贡献」，
     * 一投就为真，第二发会落到载体链的**有界等待**（等一个永不到来的 param），
     * 用例会挂在超时上而不是断言上。
     * 不投 ⇒ `source === 'chromium'`，正是要验的「没有第二条链可换」形态：
     * 首发 3007 如实失败，**不换链**，且**继续**打 p2。
     */
    const net = makeClaimFetch({ plans: ['p1', 'p2'], claimCode: 3007, claimStatus: 400 })
    const auth = await makeAuth(net.fetchImpl)

    const outcomes = await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))

    // ★ 两个 plan 都发了（与 3012 的「恰好 1」形成对照）
    expect(net.claimCalls()).toBe(2)
    expect(outcomes.length).toBe(2)
    // 且文案里**不得**出现风控措辞
    for (const outcome of outcomes) {
      if (outcome.kind === 'failed') {
        expect(outcome.message).not.toContain('风控')
        expect(outcome.message).not.toContain('请勿连续重试')
      }
    }
  })

  it('★ 短路只跳「剩余 plan」，不抛错、不影响调用方拿到结果', async () => {
    const net = makeClaimFetch({ plans: ['p1', 'p2'] })
    const auth = await makeAuth(net.fetchImpl)

    // 不抛错，如实返回一条 failed（其余账号由 RPC 的逐账号循环继续）
    const outcomes = await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))
    expect(Array.isArray(outcomes)).toBe(true)
    expect(outcomes.length).toBe(1)
    expect(net.claimCalls()).toBe(1)
  })

  /**
   * ★★★ **对抗性审计打出的最严重缺陷**（2026-10-05 修）。
   *
   * 短路检查原先位于 3007 分支**之前**，而 3007 换链重发的结果是**直接 push
   * 并 `continue`** 的 ⇒ 重发那一发**绕过了**短路检查。
   *
   * 桩测实测（修复前，两个 plan，首发 3007 ⇒ 重发 3012）：
   * ```
   * claims=3 outcomes=2
   * → 被风控的账号**继续发了下一个 plan 并成功领取**
   * ```
   *
   * ⚠ 这意味着「一次点击连续触发风控」这条**恰在最需要它的场景下失效**：
   * 上游先因 captcha 拒一次、再因风控拒一次，正说明它已经在盯这个账号了。
   * 而 `3012` 有冷却惩罚（30 分钟 → 24 小时 → 停用）。
   *
   * ⇒ 修法：让重发结果**写回 `outcome`**（而非 push），首发与重发**汇流到
   * 同一个短路判断点**，结构上不可能再漏任何返回路径。
   */
  it('★★★ 重发撞 3012 也必须短路（不得绕过）', async () => {
    const net = makeClaimFetch({
      plans: ['p1', 'p2'],
      claimCodes: [
        { code: 3007, status: 400 },   // 首发：captcha 被拒
        { code: 3012, status: 405 },   // 重发：撞风控 ⇒ 必须在此终止
        { code: 0, status: 200 },      // p2（**不应**被发出去）
      ],
    })
    const auth = await makeAuth(net.fetchImpl)
    /**
     * ⚠ 必须换成**快返回**的假载体：首发要走内部载体（`source='internal'`）
     * 才会触发 3007 换链重发，而真载体在槽被取空后会**有界等待**一个永不到来的
     * param ⇒ 用例挂在超时上而不是断言上（写这条时实测踩到）。
     */
    installFakeCarrier(auth)

    const outcomes = await auth.claimDaily(async (config) => fakeParam(`x-${config.sceneId}`))

    /** ★ 只发 2 发（首发 + 重发），**没有** p2 那一发。 */
    expect(net.claimCalls()).toBe(2)
    // ★ 只产出一条 outcome
    expect(outcomes.length).toBe(1)
    const failed = outcomes[0]
    expect(failed?.kind).toBe('failed')
    if (failed?.kind !== 'failed') throw new Error('应当是 failed')
    expect(failed.code).toBe(3012)
    expect(failed.message).toContain('请勿连续重试')
  })

  /**
   * ★★ **自审抓出来的第二个真实缺陷**（2026-10-05 修）。
   *
   * `noteZcodeRequestSent` 最初写在 `mintClaimCaptcha` **之前**。而 mint 会**抛错**
   * （注入链撞退避冷却时如实上抛）⇒ 留下**一次没有对应上游请求的 `sent`**：
   * ① 失败计数少记（异常直接跳 `catch`）；
   * ② 「距上条」的分母被一个**从未发出**的请求占用，污染「是否频率风控」这个判据。
   *
   * ⇒ `sent` 必须记在 **mint 之后**（与 `retryClaimWithInjectedChain` 的顺序一致）。
   * 本用例断言：mint 抛错时，「距上条」仍是 `—`（没有凭空多出一条记录）。
   */
  it('★★ captcha 产出抛错时不得留下「未发出的请求」记录（顺序纪律）', async () => {
    const net = makeClaimFetch({ plans: ['p1'] })
    const auth = await makeAuth(net.fetchImpl)

    /**
     * ⚠⚠ **必须先铺一条更早的真实历史**，否则本用例是同义反复。
     *
     * 这是本用例的第二个版本：第一版**只**跑一次 mint 抛错，断言 `距上条 —`。
     * 但**第一次**请求时 `previousSentAt` 本来就是 `undefined` ⇒ 无论
     * sent 记在 mint 之前还是之后，渲染结果**都是** `—` ——
     * 缺陷版与修复版输出完全相同，反向验证时**不会变红**（实测确认）。
     *
     * 铺一条 90 秒前的历史之后两种实现才被区分开：
     * - 缺陷版（sent 在 mint 之前）：抛错也记了一次 sent ⇒
     *   `previousSentAt` 变成 90 秒前那条 ⇒ 显示成 `1分30秒`；
     * - 修复版（sent 在 mint 之后）：抛错**不**记 sent ⇒
     *   `previousSentAt` 仍是 `undefined`（那条历史自己没有前驱）⇒ 显示 `—`。
     */
    const EPOCH = Date.now() - 90_000
    noteZcodeRequestSent(undefined, EPOCH)
    noteZcodeRequestOk(undefined, EPOCH + 10)

    // 注入链恒抛错（模拟 `mintWithChromium` 撞上退避冷却）
    const outcomes = await auth.claimDaily(async () => {
      throw new Error('退避冷却中')
    })

    // 如实失败，不抛给调用方
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.kind).toBe('failed')
    // ★ 一次上游请求都没发出
    expect(net.claimCalls()).toBe(0)

    /**
     * ★ 关键断言：「距上条」仍是 `—` —— 说明那次**抛错没有记进 sent**。
     * ⚠ 缺陷版这里会显示成 90 秒量级的间隔（被一次从未发出的请求占了分母）。
     */
    const line = formatZcodeDiagnostic({ accountId: undefined, sentAt: Date.now(), status: 0, now: Date.now() })
    expect(line).toContain('距上条 —')
    expect(line).not.toContain('距上条 1分')
  })

  /**
   * ★ 上一条用例的**前提**必须成立，否则那条的推理不成立。
   *
   * 我把 `sent` 移到 `mint` 之后，依赖的是「**mint 之后不会再抛**」——
   * 即 `claimZcodePlan` 把所有网络/读体异常都兜成 `ok:false` 的**返回**
   * （见 `zcode-upstream.ts` 的 `catch` 与 `.catch(() => '')`）。
   * 若它哪天改成上抛，`sent` 记了但 `failed` 没记，计数又会失衡。
   * ⇒ 这条把那个前提本身钉住。
   */
  it('★ 前提：claimZcodePlan 在网络/读体异常时**不抛**，只回 ok:false', async () => {
    const cred = { zcode_jwt: 'j', device_mid: 'm' } as never
    // ① fetch 本身抛错
    const boom = (async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch
    await expect(claimZcodePlan(cred, 'p1', { param: 'x', region: 'cn' }, boom))
      .resolves.toMatchObject({ ok: false })
    // ② 体流中断（read 阶段抛错）
    const streamErr = (async () => new Response(
      new ReadableStream({ start(c) { c.error(new Error('stream aborted')) } }),
      { status: 200 },
    )) as unknown as typeof fetch
    await expect(claimZcodePlan(cred, 'p1', { param: 'x', region: 'cn' }, streamErr))
      .resolves.toMatchObject({ ok: false })
  })
})

/**
 * ★★ 边缘 CDN 的 HTML 错误页不得泄漏到用户可见文案里（Gitee issue IKJRM4 相关）。
 *
 * ## 缺陷本体（2026-10-07 实测，与会话日志逐字一致）
 *
 * 走边缘拦截时上游返回的是**阿里云 ESA 的 HTML 错误页**（`text/html`），
 * 而 `describeUpstreamError` 的非 JSON 兜底是 `trimmed.slice(0, 200)`
 * ⇒ 前 200 字符是 `<!doctypehtml>…<style>a,body,div,h2,html,p{m`，
 * **CSS 选择器被当错误文案倒给用户**：
 *
 * ```
 * zcode: HTTP 405：<!doctypehtml><html lang="zh-cn">…<title>405</title>…
 * ```
 *
 * 三条代价：
 * 1. HTML 里没有业务信息，用户读完不知道发生了什么；
 * 2. 归因方向错 —— 边缘拦截属上游/网络层，与「额度」「凭据」无关，
 *    按额度/凭据指引会让用户去充值或重新登录，白跑一趟；
 * 3. 边缘页内容随 CDN 配置变化，把它的片段写进错误文案 ⇒ 将来无法复现。
 *
 * ## 与既有 3012 用例的分工
 *
 * 上面那些用例守的是「**业务层 JSON** 的 3012 要按风控报」；
 * 本段守的是「**非 JSON 的 HTML 页**不能当业务错误报」。
 * 两者互不覆盖：同一个 `405` + 不同的 `content-type` 必须给出不同结论。
 */
describe('边缘 CDN 的 HTML 错误页：不得当业务错误报（2026-10-07 实测）', () => {
  /** 实测拿到的阿里云 ESA 错误页（截取前段，形态与真响应一致）。 */
  const ESA_HTML =
    '<!doctypehtml><html lang="zh-cn"><meta charset="utf-8">'
    + '<meta http-equiv="X-UA-Compatible"content="IE=edge,chrome=1">'
    + '<meta name="data-spm"content="a3c0e"><title>405</title>'
    + '<style>a,body,div,h2,html,p{margin:0;padding:0}a{text-decoration:none;color:#3b6ea3}</style>'

  it('ESA 页：文案不含任何 HTML 标签或 CSS 噪声', () => {
    const msg = describeUpstreamError(405, ESA_HTML)
    expect(msg).not.toMatch(/<!doctype|<html|<style|doctypehtml|<head|<body/i)
    // 反向验证护栏：判据本身要真能命中（否则上面那条会「因为什么都没查到」而恒绿）
    expect(msg).toContain('HTML')
  })

  it('ESA 页：说清「未到达服务端」且指明换账号无效', () => {
    const msg = describeUpstreamError(405, ESA_HTML)
    expect(msg).toContain('未到达')
    // 方向性断言：换账号 / 重新登录对边缘拦截无效，必须写出来
    expect(msg).toContain('更换账号无效')
    // 反向断言：不得把边缘拦截说成额度或凭据问题
    expect(msg).not.toContain('额度')
    expect(msg).not.toContain('凭据失效')
  })

  it('各状态码一视同仁（400/403/404/429/5xx 都不该泄漏 HTML）', () => {
    for (const status of [400, 403, 404, 405, 429, 500, 502, 503]) {
      expect(describeUpstreamError(status, ESA_HTML), `status=${status}`)
        .not.toMatch(/<!doctype|<html|<style/i)
    }
  })

  it('通用 HTML 错误页（非 ESA）同样不被当业务错误', () => {
    // 无 data-spm 特征，但确实是 HTML 页
    const generic = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>…</body></html>'
    const msg = describeUpstreamError(502, generic)
    expect(msg).not.toMatch(/<!doctype|<html|<head|<body/i)
    expect(msg).toContain('HTML')
  })

  it('★ 业务层 JSON 的既有行为逐字未变（回归护栏）', () => {
    // 3012：仍按风控报，且带冷却警告
    const r3012 = describeUpstreamError(405, '{"code":3012,"msg":"request has been blocked due to unusual activity."}')
    expect(r3012).toContain('3012')
    expect(r3012).toContain('冷却')
    expect(r3012).not.toMatch(/<!doctype|<html/i)

    // 1005：仍按额度用尽报
    const r1005 = describeUpstreamError(429, '{"code":1005,"msg":"daily limit exceeded"}')
    expect(r1005).toContain('额度')
    expect(r1005).not.toMatch(/<!doctype|<html/i)

    // 401：仍指向 Jet Hub 面板
    expect(describeUpstreamError(401, '{"code":1001,"msg":"unauthorized"}')).toContain('Jet Hub')
  })

  it('短的非 JSON 文本仍按原样截断（不回归既有兜底）', () => {
    expect(describeUpstreamError(401, 'not json but short')).toContain('not json but short')
  })
})

/**
 * ★★★ 审计补漏：上面那组用例只覆盖了**文案侧**，且其中两条是恒真的同义反复
 * （业务 JSON 走 `message` 分支时 `looksLikeHtmlPage` 根本不参与；
 *  `'not json but short'` 不以 `<` 开头 ⇒ 恒走旧分支）。
 *
 * ## 本组锁的是真正的危害：边缘页会**误伤账号**（2026-10-07 端到端实测）
 *
 * 上面那组「文案不含 HTML」全绿时，**下面这些仍然成立**（修复前的真实行为）：
 *
 * ```
 * status=429, body=<!doctypehtml>…<title>1005</title><style>a{width:1005px}</style>
 *   stream() → isZcodeQuotaExhausted = true   （body.includes('1005') 裸子串）
 *            → switchAccountOnQuota() 连换两个号
 *            → pool.updateModelRateLimit(id, model, 次日 0 点)  ← 两个可用账号被封到次日
 *   文案 = 「额度用尽…请更换账号。…：**更换账号无效**」  ← 自相矛盾
 * ```
 *
 * ⇒ 判据侧（{@link isZcodeQuotaExhausted} / {@link shouldFallbackToOtherChannel} /
 * {@link httpErrorCodeForZcode}）与文案侧**必须共用同一份** HTML 判据，
 * 且 HTML 页必须在**分类之前**短路。
 *
 * ⚠ 判据与文案的**唯一出处**是 `zcode-diagnostics.ts` 的
 * {@link looksLikeZcodeHtmlPage} / {@link formatZcodeEdgePageHint} ——
 * 改那一处时这里必须跟着复核（少改一处就是又一次「只改了一半」）。
 */
describe('边缘 HTML 页：判据侧必须一并豁免（2026-10-07 端到端实测）', () => {
  const ESA = '<!doctypehtml><html lang="zh-cn"><meta name="data-spm"content="a3c0e">'
    + '<title>405</title><style>a,body,div{margin:0}</style></html>'
  /** 边缘页里**恰好含 `1005`** —— CSS 值 / `<title>` / hash 都很容易撞上。 */
  const ESA_1005 = `${ESA.replace('<title>405</title>', '<title>1005</title>')}<style>a{width:1005px}</style>`

  describe('判据侧：HTML 页不得被当成任何业务码', () => {
    it('★ `1005` 边缘页不得被判成额度用尽（否则换号 + 封账号到次日）', () => {
      // ⚠ 这条是**封号**的根因：`isZcodeQuotaExhausted` 为真 ⇒ `switchAccountOnQuota()`
      // ⇒ `updateModelRateLimit(id, model, nextUtc8DayStartMs())`。
      // 拿掉这条 HTML 短路，下面 `describeUpstreamError` 的用例仍会全绿。
      expect(isZcodeQuotaExhausted(429, ESA_1005)).toBe(false)
      // ⚠ 同一个裸子串在换腿判据里也有一份
      expect(shouldFallbackToOtherChannel(429, ESA_1005)).toBe(false)
    })

    it('`3007` 边缘页不得触发「补产 captcha 并重发」（白烧设备级验证配额）', () => {
      const with3007 = `${ESA}<style>b{height:3007px}</style>`
      expect(isZcodeCaptchaRejected(400, with3007)).toBe(false)
      expect(isZcodeConcurrencyLimited(429, with3007)).toBe(false)
    })

    it('★ 错误码映射：HTML 页一律 `SERVER`（可退避重试，契合「稍后重试」）', () => {
      /**
       * ⚠ 最严重的一格是 `500`：修复前 `httpErrorCodeForZcode(500, 含1005的页)`
       * 返回 `QUOTA_EXCEEDED`（**不在** `DEFAULT_RETRYABLE_CODES` 里），
       * 于是一个本该自动退避重试 5 次的**瞬断 5xx** 只报一次错。
       */
      for (const status of [400, 401, 403, 404, 405, 429, 500, 502, 503]) {
        expect(httpErrorCodeForZcode(status, ESA_1005), `status=${status}`).toBe('SERVER')
      }

      /**
       * ⚠⚠ 加固（2026-10-07 变异审计 A4 打出的缺口）：上面那条在
       * **去掉 HTML 短路后仍然全绿** —— 因为 `status >= 500` 的兜底也返回
       * `SERVER`，把断言「喂饱」了 ⇒ 它**没有真正锁住**那处短路。
       *
       * ⇒ 这里额外锁住**兜底到不了**的档位，并顺带证明「页面里的业务码数字
       * 不会把映射带偏」：
       * - `405`：去掉短路后会走末尾 `return 'SERVER'`……仍相同 ⇒ 改用
       *   **能被业务码劫持**的断言（见下），才能真正区分。
       */
      // ① 去掉短路后 `400` 会变成 `INVALID_REQUEST`（末尾兜底给的是它，不是 SERVER）
      expect(httpErrorCodeForZcode(400, ESA_1005)).toBe('SERVER')
      // ② `401`：去掉短路后会变 `AUTH`（业务分支先命中）
      expect(httpErrorCodeForZcode(401, ESA_1005)).toBe('SERVER')
      // ③ `429`：去掉短路后会变 `QUOTA_EXCEEDED`（`includes('1005')` 先命中，
      //    因为 ESA_1005 里带 `1005`）—— 这是最尖锐的一格
      expect(httpErrorCodeForZcode(429, ESA_1005)).toBe('SERVER')
      // ④ `200` + 含 `3007` 的页：去掉短路后会变 `RATE_LIMIT`（captcha 分支）
      expect(httpErrorCodeForZcode(200, `${ESA}<style>b{height:3007px}</style>`)).toBe('SERVER')
    })
  })

  describe('文案侧：HTML 页不得进入任何业务分支的前缀', () => {
    it('★ 401 边缘页：不得输出「凭据失效 / 重新添加登录」', () => {
      /**
       * ⚠ 修复前实测输出（**互斥指令**）：
       * ```
       * 凭据失效（401）。请在 Jet Hub 的 ZCode 面板删除该账号后重新添加登录。
       * 上游返回的是边缘CDN 的 HTML 错误页…**更换账号无效**，建议稍后重试…
       * ```
       * 且该分支实测 `calls=1, marks=[]` ⇒ 删号纯属白跑，
       * 用户会真去删掉一个完全健康的凭据。
       */
      const msg = describeUpstreamError(401, ESA)
      expect(msg).not.toContain('凭据失效')
      expect(msg).not.toContain('重新添加登录')
      expect(msg).toContain('更换账号无效')
    })

    it('★ 页面里的 `1005` 不得把文案劫持成「额度用尽 / 请更换账号」', () => {
      // 方向性断言：与「更换账号无效」**相反**的指令一律不得出现。
      for (const status of [400, 401, 403, 404, 405, 429, 500, 502, 503]) {
        const msg = describeUpstreamError(status, ESA_1005)
        expect(msg, `status=${status}`).not.toContain('额度用尽')
        expect(msg, `status=${status}`).not.toContain('余额不足')
        expect(msg, `status=${status}`).not.toContain('凭据失效')
      }
    })

    it('★ 状态码必须出现在文案里（逐档可对照，便于排查）', () => {
      // ⚠ 通用分支把 `status` 写进了文案 —— 这条锁住它不被后续重构弄丢。
      expect(describeUpstreamError(502, '<title>x</title><html><body>502</body></html>')).toContain('HTTP 502')
      expect(describeUpstreamError(504, '<title>x</title><html><body>504</body></html>')).toContain('HTTP 504')
    })

    it('ESA 分支与通用分支必须可区分（防 ESA 分类退化成通用分支）', () => {
      // 只断言 `toContain('HTML')` 是**恒真**的：两条分支文案都含「HTML」。
      // 这里锁 ESA 专属措辞。
      expect(describeUpstreamError(405, ESA)).toContain('边缘CDN')
      expect(describeUpstreamError(405, '<html><body>502</body></html>')).not.toContain('边缘CDN')
    })

    it('页面标题过长时必须截断（标题由远端控制，别把它变成新的泄漏面）', () => {
      const longTitle = 'x'.repeat(500)
      const msg = describeUpstreamError(500, `<html><head><title>${longTitle}</title></head></html>`)
      expect(msg).not.toContain(longTitle)
      expect(msg.length).toBeLessThan(300)
    })
  })

  describe('判据覆盖面：不能只认 <!doctype> 与 <html>', () => {
    /**
     * ⚠ 这六个形态在真实 CDN / 网关错误页里都常见。修复前的判据
     * （三条枚举：`<!doctype|html|head|body` 前缀 / `<?xml` / `contains('<html')`）
     * **全部漏判**它们 ⇒ 标签噪声原样倒给用户，且完全绕过新提示。
     */
    it.each([
      ['<title> 开头', '<title>405 Not Allowed</title>'],
      ['<meta> 开头', '<meta charset="utf-8">'],
      ['<div> 开头', '<div class="err">504</div>'],
      ['XML Error 文档（AWS/S3 形态）', '<Error><Code>AccessDenied</Code></Error>'],
      ['JSON 包在 <pre> 里', '<pre>{"code":1005,"msg":"quota"}</pre>'],
      ['<script> 开头', '<script>window.x=1</script><html><body>err</body></html>'],
    ])('%s 不得泄漏标签', (_name, body) => {
      const msg = describeUpstreamError(500, body)
      expect(msg).not.toMatch(/<!doctype|<html|<head|<body|<title|<meta|<div|<Error|<pre|<script/i)
      expect(msg).toContain('更换账号无效')
    })

    it.each([
      ['BOM 前缀', '﻿<!doctype html><html><title>502</title></html>'],
      ['注释开头', '<!-- cached --><!doctype html><html>'],
      ['前导换行空白', '\n\n  <html>\n<head><title>502</title>'],
      ['XML 声明', '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>'],
    ])('%s 必须被识别为页面', (_name, body) => {
      expect(describeUpstreamError(500, body)).toContain('更换账号无效')
    })

    it('★ 方向不得反：带尖括号的**纯文本**不是页面', () => {
      /**
       * ⚠ 判据放宽容易走到另一个极端：用 `^<[a-z]+` 通配会把
       * `<service unavailable, retry later>` 这种**带尖括号的服务端文本**
       * 误判成页面 ⇒ 用户看不到上游的真实原因。
       */
      const msg = describeUpstreamError(503, '<service unavailable, retry later>')
      expect(msg).toContain('<service unavailable, retry later>')
      expect(msg).not.toContain('更换账号无效')
    })

    it('★ 业务层 JSON 恒不被当成页面（JSON 不能以 `<` 开头）', () => {
      // 含 `<` 的 JSON 字符串也必须照常走业务分支。
      const msg = describeUpstreamError(405, '{"code":3012,"msg":"blocked <script>"}')
      expect(msg).toContain('3012')
      expect(msg).toContain('冷却')
    })

    /**
     * ⚠⚠ **优先级护栏：可解析出业务码时绝不按页面处理**（2026-10-07 复核实测）。
     *
     * 实测踩到的坑：短路写在业务码解析**之前**，于是
     * `<Error><Code>Blocked</Code>…` 这类「既像页面又带权威码」的报文
     * 被降级成 `SERVER`（**稍后重试**），而它本该是 `PERMISSION`（**别重试**，
     * 有冷却惩罚）—— 两个用户动作**完全相反**，反复重试会把 30 分钟推成 24 小时。
     *
     * ⇒ 判据必须与 {@link hasZcodeUnusualActivity} 的「**有码 ⇒ 只信码**」一致。
     */
    it('★ 有权威业务码时报文不得被降级成「稍后重试」', () => {
      for (const [body, expected] of [
        ['{"code":3012,"msg":"request has been blocked due to unusual activity."}', 'PERMISSION'],
        ['{"code":"3012","msg":"blocked"}', 'PERMISSION'],
        ['{"code":1005,"msg":"exceed quota limit"}', 'QUOTA_EXCEEDED'],
      ] as const) {
        expect(readZcodeBusinessCodeFromBody(body), body).toBeDefined()
        expect(httpErrorCodeForZcode(405, body), body).toBe(expected)
      }
      // 3012 必须仍带「别重试」的冷却警告
      expect(describeUpstreamError(405, '{"code":3012,"msg":"request has been blocked due to unusual activity."}'))
        .toContain('冷却')
    })

    it('无权威码、无风控语义的标签形态才按页面处理（三条判据的分工）', () => {
      /**
       * ⚠ 这条与上面「标签包裹的风控报文」是一**对**：
       * 前者带 `unusual activity` ⇒ 业务语义优先；本条**不带** ⇒ 页面优先。
       * 两者必须同时成立，否则就是「一律按页面」或「一律按业务」——
       * 那两种极端都会在真实流量上出错。
       *
       * ⚠ 举例刻意**避开** `<Error><Code>Blocked</Code><Message>unusual activity…`
       * ——它带风控语义，归业务分支（见上面那条）。
       */
      const page = '<Error><Code>AccessDenied</Code><Message>Forbidden</Message></Error>'
      expect(readZcodeBusinessCodeFromBody(page)).toBeUndefined()
      expect(looksLikeZcodeHtmlPage(page)).toBe(true)
      expect(httpErrorCodeForZcode(405, page)).toBe('SERVER')
    })

    /**
     * ⚠⚠ **标签包裹的业务报文：不得被降级成「稍后重试」**（2026-10-07 变异审计打出）。
     *
     * 上游会把业务码包在零散标签里下发：
     *
     * ```
     * <h1>Error 3012</h1> request has been blocked due to unusual activity.
     * ```
     *
     * 它含 `</h1>` ⇒ {@link looksLikeZcodeHtmlPage} 判它**是**页面；
     * 而若 HTML 短路不看业务语义，它就被降级成 `SERVER`（**稍后重试**），
     * 但这形态本该是 `PERMISSION`（**别重试**，有冷却惩罚）。
     *
     * ⇒ 判据层只答「像不像页面」，**优先级必须由消费层决定**：
     * 「有码 ⇒ 只信码；无码但有业务语义 ⇒ 也不是页面」。
     */
    it.each([
      ['<h1>Error 3012</h1> request has been blocked due to unusual activity.'],
      ['<h1>Error 3012</h1>upstream connect timeout and unusual activity detected'],
      ['<Error><Code>Blocked</Code><Message>unusual activity</Message></Error>'],
    ])('标签包裹的风控报文必须仍是 PERMISSION：%s', (body) => {
      expect(looksLikeZcodeHtmlPage(body)).toBe(true)
      expect(readZcodeBusinessCodeFromBody(body)).toBeUndefined()
      expect(httpErrorCodeForZcode(405, body)).toBe('PERMISSION')
      expect(describeUpstreamError(405, body)).toContain('冷却')
    })

    it('剥标签不得破坏既有的反例保护', () => {
      // ⚠ 这条锁的是**不引入**剥标签兜底后的边界：限流不得被误判成风控
      // （两个用户动作相反，见 mentionsZcodeUnusualActivity 的反例表）。
      expect(hasZcodeUnusualActivity('too many requests, retry after 3012 ms')).toBe(false)
      expect(hasZcodeUnusualActivity('<h1>429</h1> too many requests, retry after 3012 ms')).toBe(false)
      // 带尖括号的纯文本恒不命中
      expect(hasZcodeUnusualActivity('<service unavailable, retry later>')).toBe(false)
    })

    it('★ 标签包裹的风控：靠主判据命中，不靠剥标签', () => {
      /**
       * ⚠ 实测记录（2026-10-07）：曾给 {@link hasZcodeUnusualActivity} 加一条
       * 「剥掉标签再判一遍」的兜底，**实测证明是多余的** ——
       * 8 种标签形态全都靠主判据（`unusual activity` / `blocked due to`）命中，
       * 剥不剥标签结果完全一样；而剥标签会把相邻文本粘在一起
       * （`blocked</b><i>3012` → `blocked3012`）从而**破坏词边界**，
       * 即「为一条用不上的兜底制造新的漏判」。故已删除那段代码。
       *
       * ⇒ 本用例锁住「不靠剥标签也判得对」这个事实，
       * 免得后人再把那段冗余兜底加回来。
       */
      for (const body of [
        '<h1>Error 3012</h1> request has been blocked due to unusual activity.',
        '<Error><Code>Blocked</Code><Message>unusual activity</Message></Error>',
      ]) {
        // 主判据直接命中，未剥标签
        expect(mentionsZcodeUnusualActivity(body), body).toBe(true)
        expect(hasZcodeUnusualActivity(body), body).toBe(true)
      }
      // 而**不带**风控语义的同类形态不该命中（否则会把普通网关页判成风控）
      expect(hasZcodeUnusualActivity('<h1>Error 3012</h1>upstream connect timeout')).toBe(false)
    })

    it('★ 极简错误页只有一个标题标签时也必须识别为页面', () => {
      /**
       * ⚠ 这条是**收窄判据时的实测退步**：`chunks.every(...)`（要求整篇都是标签）
       * 会把 `<h1>Gateway Timeout</h1>` 判成非页面 ⇒ `429` 下走进
       * 「并发限流」分支。真实 CDN/网关的极简错误页正是这个形态。
       */
      for (const page of ['<h1>Gateway Timeout</h1>', '<h1> 502 Bad Gateway </h1>', '<hgroup>content</hgroup>']) {
        expect(looksLikeZcodeHtmlPage(page), page).toBe(true)
        expect(describeUpstreamError(429, page)).toContain('更换账号无效')
      }
    })
  })

  describe('共享判据本身（判据与文案同源，两侧都必须改）', () => {
    it('判据与调用方同口径：`describeUpstreamError` 认的，它必须也认', () => {
      /**
       * ⚠ 这条是**防漂移**的闸门：判据住在 `zcode-diagnostics.ts`，调用方在
       * `zcode-adapter.ts` / `zcode-transport.ts`。两边一旦各自写一份判据，
       * 就会重演 `3012` 那次「文案侧收窄了、映射侧没跟上」（同型第三次）。
       */
      const bodies = [ESA, ESA_1005, '<title>405</title>', '<Error><Code>X</Code></Error>']
      for (const body of bodies) {
        expect(looksLikeZcodeHtmlPage(body)).toBe(true)
        expect(describeUpstreamError(500, body)).toContain('更换账号无效')
      }
    })

    it('判据对「带尖括号纯文本」恒为 false（不得反向误伤）', () => {
      expect(looksLikeZcodeHtmlPage('<service unavailable, retry later>')).toBe(false)
      expect(looksLikeZcodeHtmlPage('not json at all')).toBe(false)
      expect(looksLikeZcodeHtmlPage('{"code":1005}')).toBe(false)
      expect(looksLikeZcodeHtmlPage('')).toBe(false)
    })

    it('★ 判据③：非白名单根标签、但有闭合标签 ⇒ 必须被兜住', () => {
      /**
       * ⚠ 判据③ 的**唯一存在理由**就是兜住白名单没收的根标签。
       * 实测删掉判据③ 后**全部既有用例仍绿**（白名单把常见形态都盖住了），
       * ⇒ 这条用例就是为「有人删掉判据③」而加的锁。
       */
      expect(looksLikeZcodeHtmlPage('<Blocked><Reason>WAF</Reason></Blocked>')).toBe(true)
      expect(looksLikeZcodeHtmlPage('<x-custom-thing>denied</x-custom-thing>')).toBe(true)
    })

    it('★ `startsWith('<')` 守卫：不以 `<` 开头即便含闭合标签也不得判成页面', () => {
      /**
       * ⚠ 这条守的是**误判方向**：上游纯文本里偶尔带 `</h1>` 这类残留片段，
       * 去掉守卫它就会被当成页面 ⇒ 用户看不到上游的真实原因。
       * 实测删掉守卫后既有用例同样全绿，故必须显式锁定。
       */
      expect(looksLikeZcodeHtmlPage('upstream connect timeout</h1>')).toBe(false)
      expect(looksLikeZcodeHtmlPage('blocked</Error>')).toBe(false)
    })

    it('标题截断必须带省略号（否则 40 与 41 字符输出完全一样）', () => {
      const msg40 = describeUpstreamError(500, `<html><head><title>${'B'.repeat(40)}</title></head></html>`)
      const msg41 = describeUpstreamError(500, `<html><head><title>${'B'.repeat(41)}</title></head></html>`)
      expect(msg40).not.toContain('…')
      expect(msg41).toContain('…')
    })

    it('★ 白名单的**唯一不可替代**职责：无闭合标签的页面形态', () => {
      /**
       * ⚠ 实测（变异验证）：清空整个白名单后，`<title>405</title>` / `<div>…</div>` /
       *   `<script>` / `<pre>` / `<Error>` 这些用例**仍然全绿** —— 它们全靠
       *   判据③的「存在闭合标签」兜住。
       * ⇒ 白名单真正被锁住的只有**没有闭合标签**的形态（判据③对它们无效）。
       *
       * ⚠ 若哪天有人删掉白名单，下面的用例会红；不补的话就是**静默降级**
       * （边缘页漏判 ⇒ 账号被封到次日，正是本次修的那个缺陷）。
       */
      for (const page of [
        '<meta charset="utf-8">',
        '<link rel="stylesheet" href="/x.css">',
        '<base href="/">',
      ]) {
        expect(looksLikeZcodeHtmlPage(page), page).toBe(true)
        // 不止判据为真，消费侧也必须真的走页面分支
        expect(describeUpstreamError(500, page), page).toContain('更换账号无效')
      }
    })
  })

  /**
   * ★★★ **领取路径**必须与推理侧同口径（2026-10-07 审计打出的同型漏网）。
   *
   * `zcode-upstream.ts` 的 `claimZcodePlan` 里有一份**同形**的判据与文案兜底，
   * 它此前既没豁免 HTML、又把 `slice(0,200)` 的 HTML 噪声当文案。
   *
   * 危害实测（比文案难看严重得多）：
   * `<html><body>request has been blocked due to unusual activity.</body></html>`
   * ⇒ `hasZcodeUnusualActivity` 为真 ⇒ `code` 被归一成 `3012`
   * ⇒ `zcode-auth.ts` 的 `isClaimUnusualActivity` 命中 ⇒ **短路本账号剩余 plan**，
   *   文案写「冷却惩罚 30 分钟→24 小时→停用」。
   *
   * ⇒ 一次**边缘拦截**被报成「账号风控、别重试」，还跳过了本可领取的 plan。
   */
  describe('领取路径：与推理侧共用同一份判据与文案', () => {
    const ESA =
      '<!doctypehtml><html lang="zh-cn"><meta name="data-spm"content="a3c0e">'
      + '<title>405</title><style>a{color:red}</style></html>'

    it('★ 边缘页不得被归一成 3012 风控', async () => {
      const outcome = await claimZcodePlan(
        { zcode_jwt: 'jwt', device_mid: 'mid' } as never,
        'plan-1',
        { param: 'p', region: 'cn' },
        (async () => new Response(ESA, { status: 405, headers: { 'content-type': 'text/html' } })) as never,
      )
      expect(outcome.code).toBeUndefined()
      expect(isClaimUnusualActivity(outcome)).toBe(false)
    })

    it('★ 含风控语义短语的边缘页同样不得归一成 3012（剥标签会命中语义，必须先豁免）', async () => {
      const body = '<html><body>request has been blocked due to unusual activity.</body></html>'
      // ⚠ 先证明「剥标签后语义判据确实会命中」—— 否则本用例是恒真的
      expect(hasZcodeUnusualActivity(body.replace(/<[^>]*>/g, ''))).toBe(true)
      const outcome = await claimZcodePlan(
        { zcode_jwt: 'jwt', device_mid: 'mid' } as never,
        'plan-1',
        { param: 'p', region: 'cn' },
        (async () => new Response(body, { status: 405, headers: { 'content-type': 'text/html' } })) as never,
      )
      expect(outcome.code).toBeUndefined()
      expect(isClaimUnusualActivity(outcome)).toBe(false)
    })

    it('★ 展示侧不得再泄漏 HTML 噪声', async () => {
      const outcome = await claimZcodePlan(
        { zcode_jwt: 'jwt', device_mid: 'mid' } as never,
        'plan-1',
        { param: 'p', region: 'cn' },
        (async () => new Response(ESA, { status: 405, headers: { 'content-type': 'text/html' } })) as never,
      )
      expect(outcome.message).not.toMatch(/<!doctype|<html|<style/i)
      expect(outcome.message).toContain('更换账号无效')
    })

    it('业务 JSON 路径逐字未变（回归护栏）', async () => {
      const outcome = await claimZcodePlan(
        { zcode_jwt: 'jwt', device_mid: 'mid' } as never,
        'plan-1',
        { param: 'p', region: 'cn' },
        (async () => new Response(
          '{"code":3012,"msg":"request has been blocked due to unusual activity."}',
          { status: 405, headers: { 'content-type': 'application/json' } },
        )) as never,
      )
      expect(outcome.code).toBe(3012)
      expect(isClaimUnusualActivity(outcome)).toBe(true)
    })
  })
})
