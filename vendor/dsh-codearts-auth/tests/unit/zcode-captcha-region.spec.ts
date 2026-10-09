/**
 * ★★ captcha 的 **region 必须与产 param 的那份配置同源**（真实缺陷，Gitee issue IKJNPS）。
 *
 * ## 缺陷本体（用户报障，z.ai 国际渠道账号 100% 复现）
 *
 * 阿里云验签把 `x-aliyun-captcha-verify-param` 与 `x-aliyun-captcha-verify-region`
 * **成对**校验，两者不是同一个 region 就必然 `400 / 3007`。
 * 而 region 是**服务端下发**的（`GET /api/v1/client/configs` → `data.configs.captcha.region`）：
 * 本仓库作者所在账号实测 `cn`，而报障账号实测 **`sgp`**。
 *
 * 修复前的形态是**两份真相**：
 * - param：`jet-hub-rpc.ts` 的注入回调**自己** `fetchCaptchaConfig()` 拉配置去产（拿到 `sgp`）；
 * - region：`claimDailyFor` 的**默认参数** `ZCODE_CAPTCHA_FALLBACK.region`（写死 `cn`）。
 *
 * ⇒ 发出的是「sgp 签的 param + cn 的 region 头」，与账号、浏览器、web/桌面环境
 * 全都无关；作者在 cn 区自测永远复现不到，**非 cn 区 100% 失败**（用户：15/15 全部 `3007`）。
 *
 * ## 本文件锁住的四件事
 * 1. ★ 领取路径：请求头 region **取自本次 mint 用的那份配置**，且注入回调拿到的
 *    **就是同一个对象**（不是「两边各拉一次、碰巧一致」）。
 * 2. ★ 配置拉不到时，region 与 mint 配置**一起**退回兜底值 —— 不允许出现
 *    「param 用兜底、region 却用远端」这种反向不一致。
 * 3. ★ **3007 换链重发**那一发仍然同源（换 param 不换 region）。
 * 4. ★ 推理路径（模型请求）是**同型第二个实例**：`zcode-adapter.ts` 组头时
 *    原来恒写 `options.captchaRegion ?? 'cn'`，而 param 来自远端配置。
 *
 * ## 反向验证（2026-10-05 实跑，逐条记在用例旁的注释里）
 * - 把 region 改回兜底常量 ⇒「sgp」「显式覆盖」「3007 重发」三条变红；
 * - 把适配器的 region 改回 `options.captchaRegion ?? 'cn'` ⇒ 推理那条变红；
 * - 把配置解析搬进 plan 循环 ⇒「只解析一次」那条**源码**断言变红。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ZCODE_CAPTCHA_FALLBACK } from '../../src/zcode-captcha.js'
import type { ZcodeCaptchaConfig } from '../../src/zcode-captcha.js'
import type { CarrierOutcome } from '../../src/captcha-carrier.js'
import {
  putSuppliedParam,
  resetCaptchaSupply,
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
const rpcSource = readFileSync(resolve(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')

/** 服务端为**非 cn 区**账号下发的配置（issue IKJNPS 的实测值）。 */
const SGP: ZcodeCaptchaConfig = { region: 'sgp', prefix: 'pf-sgp', sceneId: '11xygtvd' }
/** cn 区配置（与兜底值同 region，但 prefix/sceneId 不同 —— 用来证明用的是「那份配置」）。 */
const CN: ZcodeCaptchaConfig = { region: 'cn', prefix: 'pf-cn', sceneId: '11xygtvd' }

const CREDENTIAL: ZcodeCredential = { zcode_jwt: 'a.b.c', device_mid: 'mid-A', source: 'plugin' }

/**
 * 内存凭据存储。
 *
 * ⚠ 凭据**只有插件自存这一条来源**（`ctx.credentials`）：2026-10-05 起不再读本机
 * 官方客户端文件，也**不再有** `ZcodeAuthOptions.readCredential` 测试注入点 ⇒
 * 想给某个用例一份凭据，只能把它写进这个存储。
 * 样板见 `tests/unit/zcode-credential-resolution.spec.ts`。
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

/** 注册内存凭据存储并写入一份可用的凭据（`current()` 据此解析）。 */
async function seedCredential(ctx: Context): Promise<FakeCredentials> {
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(CREDENTIAL))
  return credentials
}

/** 过 `validateCaptchaParam` 的假 param（长度 ≥200 + 可解出 JSON + certifyId + 长 token）。 */
function fakeParam(tag: string, sceneId = SGP.sceneId): string {
  const body = JSON.stringify({ certifyId: tag, sceneId, securityToken: `${tag}-${'t'.repeat(128)}` })
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  if (encoded.length < 200) throw new Error(`假 param 太短（${String(encoded.length)}）`)
  return encoded
}

/**
 * 领取路径的上游桩：按 URL 分派。
 *
 * ⚠ `/client/configs` 这条路由会被断言**值**（region/prefix）而不只是次数 ——
 * 见下面 `configCalls` 那条注释：次数判据在这个链路上**没有网**
 * （`TtlCache` 连 `undefined` 都缓存，失败重拉也命中缓存）。
 */
function makeFetch(options: {
  plans: readonly string[]
  config?: ZcodeCaptchaConfig | 'fail'
  firstClaimRejected?: boolean
}): {
  fetchImpl: typeof fetch
  claimRegions: string[]
  claimParams: string[]
} {
  const claimRegions: string[] = []
  const claimParams: string[] = []
  let claimCalls = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const sent = (init.headers ?? {}) as Record<string, string>
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
      claimRegions.push(sent['x-aliyun-captcha-verify-region'])
      claimParams.push(sent['x-aliyun-captcha-verify-param'])
      claimCalls += 1
      if (options.firstClaimRejected === true && claimCalls === 1) {
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
    if (url.includes('/client/configs')) {
      if (options.config === 'fail') {
        return new Response('{"code":5000}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      const captcha = options.config ?? SGP
      return new Response(JSON.stringify({ data: { configs: { captcha } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`桩 fetch 收到未预期的 URL：${url}`)
  }) as unknown as typeof fetch

  return { fetchImpl, claimRegions, claimParams }
}

/** 造一个只服务领取用例的 `ZcodeAuth`（零真实浏览器：注入回调自己产 param）。 */
async function makeAuth(fetchImpl: typeof fetch): Promise<ZcodeAuth> {
  const ctx = new Context()
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  await seedCredential(ctx)
  return new ZcodeAuth(ctx, { fetchImpl })
}

beforeEach(() => {
  resetCaptchaSupply()
  resetCaptchaRequirementMemory()
})

describe('★ 领取路径：region 与 param 同源（issue IKJNPS）', () => {
  it('★ 服务端下发 `sgp` ⇒ 请求头写 `sgp`，且注入回调拿到的就是**同一份配置**', async () => {
    const net = makeFetch({ plans: ['zcode-v3-start-plan-trust-1004'], config: SGP })
    const auth = await makeAuth(net.fetchImpl)
    const seen: ZcodeCaptchaConfig[] = []
    // ⚠ 与 `jet-hub-rpc.ts` 的注入**同形**：原样把 config 透传给 mintCaptcha。
    const outcomes = await auth.claimDaily(async (config) => {
      seen.push(config)
      return fakeParam('sgp-param', config.sceneId)
    })

    expect(outcomes[0]?.kind).toBe('claimed')
    expect(net.claimRegions).toEqual(['sgp'])
    /**
     * ⚠ 这里断言的是**值**而不是引用：`fetchZcodeCaptchaConfig` 从响应 JSON
     * **重建**了一个对象，`toBe(SGP)` 天然不成立，写上去只会逼人改实现。
     * 「只有一份配置」由下面「配置只解析一次」那条（`configCalls === 1`）锁。
     * `prefix` 特意取 `pf-sgp`（≠ 兜底常量的 `no8xfe`）⇒ 用的是服务端那份，
     * 不是本地兜底值碰巧同 region。
     */
    expect(seen[0]).toEqual(SGP)
    expect(seen[0]?.prefix).toBe('pf-sgp')
  })

  it('★★ 配置拉不到 ⇒ region 与 mint 配置**一起**退回兜底值（不得反向不一致）', async () => {
    const net = makeFetch({ plans: ['p1'], config: 'fail' })
    const auth = await makeAuth(net.fetchImpl)
    const seen: ZcodeCaptchaConfig[] = []

    const outcomes = await auth.claimDaily(async (config) => {
      seen.push(config)
      return fakeParam('fallback-param', config.sceneId)
    })

    expect(outcomes[0]?.kind).toBe('claimed')
    // 两边**都**是兜底值：`cn`。最坏形态是「param 用远端、region 用兜底」——
    // 那正是本 issue；而「param 用兜底、region 用远端」同样错，必须一起退。
    expect(net.claimRegions).toEqual([ZCODE_CAPTCHA_FALLBACK.region])
    expect(seen[0]).toBe(ZCODE_CAPTCHA_FALLBACK)
  })

  it('显式传 `captchaRegion` 时以传入为准（覆盖语义仍然可用，未被改死）', async () => {
    const net = makeFetch({ plans: ['p1'], config: CN })
    const auth = await makeAuth(net.fetchImpl)

    const outcomes = await auth.claimDaily(async (config) => fakeParam('p', config.sceneId), 'sgp')

    expect(outcomes[0]?.kind).toBe('claimed')
    expect(net.claimRegions).toEqual(['sgp'])
  })

  it('★★ 配置**只解析一次**（结构锁：解析在 plan 循环**之前**，逐 plan 复用）', () => {
    /**
     * ⚠ 为什么是**源码断言**而不是数请求次数：
     * `TtlCache` 把 `undefined` **也缓存**（`get()` 无条件 `write(value)`），
     * 而 `fetchZcodeCaptchaConfig` 自己吞掉全部异常返回 `undefined`
     * ⇒ 无论循环里再拉几次，桩只会被打中一次。实测过「把解析搬进 for 循环」
     * 这条用例**仍然全绿** —— 计数判据在这里根本没有网。
     * （「TtlCache 失败不缓存」那句只对 load **抛错**的路径成立，不是这里。）
     */
    const start = authSource.indexOf('private async claimDailyWith(')
    expect(start).toBeGreaterThan(-1)
    const body = authSource.slice(start, authSource.indexOf('\n  private async retryClaimWithInjectedChain('))
    const resolveAt = body.indexOf('const captchaConfig = await this.fetchCaptchaConfig()')
    const loopAt = body.indexOf('for (const plan of plans)')
    expect(resolveAt).toBeGreaterThan(-1)
    expect(loopAt).toBeGreaterThan(resolveAt)
    // region 必须从那份配置取，而不是另找来源
    expect(body).toMatch(/const region = captchaRegion \?\? captchaConfig\.region/)
  })

  it('★★ 3007 换链重发那一发**仍然同源**（换 param 不换 region）', async () => {
    const net = makeFetch({ plans: ['p1'], config: SGP, firstClaimRejected: true })
    const auth = await makeAuth(net.fetchImpl)
    // 槽里放一个新鲜 param ⇒ `carrier.mint()` 命中它，`source='internal'`
    // ⇒ 第一次 claim 走的是内部载体那一腿，才有「换注入链重发」这条分支。
    expect(putSuppliedParam(fakeParam('internal'), Date.now())).toBe(true)
    const seen: ZcodeCaptchaConfig[] = []

    const outcomes = await auth.claimDaily(async (config) => {
      seen.push(config)
      return fakeParam('retry-param', config.sceneId)
    })

    expect(outcomes[0]?.kind).toBe('claimed')
    // 两次 claim（首发 + 重发）都必须是 `sgp`，且重发拿到的仍是同一份配置。
    expect(net.claimRegions).toEqual(['sgp', 'sgp'])
    expect(seen.length).toBe(1)
    expect(seen[0]).toEqual(SGP)
    expect(net.claimParams[0]).not.toBe(net.claimParams[1])
  })
})

describe('★ 推理路径：同一个缺陷的第二个实例', () => {
  it('★★ 补产重发那一发的 region 取自**本次 mint 的配置**，不是写死的 `cn`', async () => {
    const T0 = 1_700_000_000_000
    const ACCOUNT = 'acct-A'
    const MODEL = 'GLM-5.3-Flash'
    const ctx = new Context()
    ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

    const sentRegions: Array<string | undefined> = []
    const queue: Response[] = [okSse()]
    let adapter!: ZcodeAdapter
    adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => CREDENTIAL,
      refresh: async () => {},
      // ⚠ 照抄 `index.ts` 的接线形态：mint 前解析配置并 `setCaptchaConfig`。
      mintCaptcha: async () => fakeParam('infer'),
      mintCaptchaParam: async (): Promise<CarrierOutcome> => {
        adapter.setCaptchaConfig(SGP)
        return { param: fakeParam('infer-param'), source: 'chromium' }
      },
      mintCaptchaAfterRejection: async (): Promise<CarrierOutcome> => {
        adapter.setCaptchaConfig(SGP)
        return { param: fakeParam('infer-retry'), source: 'chromium' }
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const sent = (init.headers ?? {}) as Record<string, string>
        sentRegions.push(sent['x-aliyun-captcha-verify-region'])
        const next = queue.shift()
        if (next === undefined) throw new Error('桩响应已用尽')
        return next
      }) as never,
      gate: new ModelGate({ sleep: async () => {} }),
      sleep: async () => {},
      now: () => T0,
      product: ZCODE,
      currentAccountId: () => ACCOUNT,
    })

    // 让第一轮就带上 param（等价「上一次被 3007 拒过」= `knownRequired`）。
    noteCaptchaRequired(captchaRequirementKey(ACCOUNT, MODEL), T0)

    for await (const _chunk of adapter.stream({
      provider: 'zcode', model: MODEL, messages: [{ role: 'user', content: 'hi' }],
    } as never)) {
      // 只需把流跑完
    }

    expect(sentRegions).toEqual(['sgp'])
  })
})

describe('★ 源码级防回归', () => {
  it('`jet-hub-rpc.ts` 的 zcode 领取分支**不得**再自己去拉 captcha 配置', () => {
    /**
     * ⚠ 那正是本缺陷的形态：回调里自取配置 + region 走默认值 = 两份真相。
     * 配置由 `claimDailyWith` 解析一次并经实参下发，回调只负责「拿这份配置去产 param」。
     *
     * ⚠ 断言**只作用在 claim 分支切片上**：`captcha.carrierUrl` 那条
     * （载体页渲染）也调 `fetchCaptchaConfig()`，那是**另一个合法用途**，
     * 全局 `not.toContain` 会误伤它 —— 本仓库在 Qoder 那次就吃过
     * 「用一个过宽的源码断言把合法代码判成违规」的亏。
     */
    const start = rpcSource.indexOf('if (req.provider === ZCODE.id) {')
    expect(start).toBeGreaterThan(-1)
    const end = rpcSource.indexOf('const product = productById(req.provider)', start)
    expect(end).toBeGreaterThan(start)
    const branch = rpcSource.slice(start, end)

    expect(branch).not.toContain('fetchCaptchaConfig()')
    expect(branch).toMatch(/claimDailyFor\(credential, async \(config\) => \{[\s\S]{0,120}?mintCaptcha\(config\)/)
  })

  it('`claimDailyFor` / `claimDaily` 的 region 参数**没有** `cn` 兜底默认值', () => {
    /**
     * 默认参数写死 `ZCODE_CAPTCHA_FALLBACK.region` 时，省略实参就等于「选 cn」——
     * 而这正是 issue 里调用方的写法。任何时候都不该有那个默认值。
     */
    expect(authSource).not.toMatch(/captchaRegion = ZCODE_CAPTCHA_FALLBACK\.region/)
    expect(authSource).not.toMatch(/captchaRegion = 'cn'/)
  })
})

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
