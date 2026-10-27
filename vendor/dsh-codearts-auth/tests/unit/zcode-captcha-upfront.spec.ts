/**
 * ★★ 读上游的「推理请求是否要 captcha」开关，据此**跳过注定失败的先探**。
 *
 * ## 背景：官方 3.14.5 起架构上支持推理带 captcha（逆向 `app.asar` 实证，2026-10-12）
 *
 * 用户更新到闭源版 **3.14.5.7961** 后要求核实「推理过程是不是又要 captcha 了」。
 * 逆向 `resources/app.asar` 得到的**官方判据链**（`out/renderer/assets/styles-*.js`）：
 *
 * ```js
 * // ① 准入：只有智谱积分账号走这条
 * function xnn(e){ return e?.access?.type==='zhipu-account' && e.access.mode==='start-plan' }
 *
 * // ② 索要 captcha（model-request 与 captcha-retry 两种 reason 都走这里）
 * async function Lnn(e){
 *   if (!xnn(e.providerConfig)) return
 *   if (t?.enabled===false || t?.skipModelRequest===true) return {headers:{}}   // ← 跳过
 *   const n = await Pnn(t, {...})
 *   return { headers: unn({captchaVerifyParam:n, captchaRegion:t.region}) }
 * }
 * ```
 *
 * 且 host 侧新增 `interaction/requestProviderRuntimeHeaders` RPC，其 `reason`
 * 取值域是 `["model-request","captcha-retry"]` —— **推理请求真的会走 captcha**，
 * 被拒后还有 `captcha-retry` 重试一轮。
 *
 * ## 而服务端**当前**把开关关着（本机实测，只发 GET、零额度）
 *
 * ```json
 * "captcha": { "enabled": true, "prefix": "no8xfe", "region": "cn",
 *              "sceneId": "11xygtvd", "skip_model_request": true }
 * ```
 *
 * `skip_model_request: true` ⇒ 官方 `Lnn` 在第二行就 `return {headers:{}}`，
 * 不产 param、不注头 ⇒ **现在推理仍然不要 captcha**。
 *
 * ## 我们要修的是什么（缺陷本体）
 *
 * `fetchZcodeCaptchaConfig` 此前**只读** `region`/`prefix`/`sceneId`，
 * 把 `skip_model_request` 与 `enabled` **整体丢弃** ⇒ 「上游要不要验证」这个
 * 信号在我们这边**不可读**。
 *
 * 后果是**门控只能靠猜**：我们一律「先探后取」（不带 param 先发一发，
 * 被 `3007` 拒了才补产）。这在 `skip_model_request: true` 时是最优的
 * （那一发必然成功、零成本），但一旦服务端翻成 **`false`**，
 * 先探就**必然**被 `3007` 拒 ⇒ **每一次用户请求都白吃一发往返**，
 * 再在适配器内部补产重发。用户感知是「每轮多一次固定延迟」。
 *
 * ⚠⚠ **方向别写反**：能省的是 `skipModelRequest === false`（明确要 ⇒ 直接带），
 * 不是 `true`。`true` 表示上游不校验，先探本来就零成本、无可省。
 *
 * ## 三态语义（本文件的核心判据）
 *
 * | 字段 | 动作 | 依据 |
 * |---|---|---|
 * | `skipModelRequest === false`（且 `enabled !== false`） | **首发直接带 param** | 上游明确要 ⇒ 先探必被拒 |
 * | `skipModelRequest === true` | 仍**先探** | 上游不校验 ⇒ 先探零成本且更省（不 mint） |
 * | **字段缺席 / 读不到** | 仍**先探** | **不知道就不猜**（同 zcode 额度桶那条纪律） |
 * | `enabled === false` | 仍**先探** | 上游把 captcha 整个关了 ⇒ 一票否决 |
 *
 * ⚠ **缺席必须与 `false` 区分**：源码里 `typeof r === 'boolean'` 才写字段
 * （官方 `getCaptchaConfig()` 逐字如此），若我们把它读成 `undefined ?? false`
 * 就会在**老配置 / 字段漂移**时误判成「上游明确要验证」，
 * 于是每个请求白发一个 param（白扣设备级配额 150/小时，见 `captcha-backoff.ts`）。
 * 这正是本仓库记过的「读不到就不猜」那条原则。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import {
  captchaRequirementObservability,
  resetCaptchaRequirementMemory,
} from '../../src/captcha-requirement.js'
import { fetchZcodeCaptchaConfig } from '../../src/zcode-upstream.js'
import { ZCODE_CAPTCHA_FALLBACK } from '../../src/zcode-captcha.js'
import type { ZcodeCaptchaConfig } from '../../src/zcode-captcha.js'
import { ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { ZcodeCredential } from '../../src/zcode.js'

const CREDENTIAL: ZcodeCredential = { zcode_jwt: 'a.b.c', device_mid: 'mid-A', source: 'plugin' }

/** 源码接线断言用（与 `zcode-captcha-region.spec.ts` 同一套定位法）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/* ───────────── 一、把上游下发的两个开关读出来（三态） ───────────── */

/** 用给定 `captcha` 原文造一个只回 `/client/configs` 的 fetch。 */
function configFetch(captcha: Record<string, unknown>): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ data: { configs: { captcha } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

describe('fetchZcodeCaptchaConfig：把 enabled / skip_model_request 读出来', () => {
  it('★ `skip_model_request: true` ⇒ `skipModelRequest === true`（上游当前的真实值）', async () => {
    const config = await fetchZcodeCaptchaConfig(
      CREDENTIAL,
      configFetch({ enabled: true, prefix: 'no8xfe', region: 'cn', sceneId: '11xygtvd', skip_model_request: true }),
    )
    expect(config?.skipModelRequest).toBe(true)
    expect(config?.enabled).toBe(true)
    // 既有三个字段不受影响。
    expect(config?.region).toBe('cn')
    expect(config?.sceneId).toBe('11xygtvd')
  })

  it('★ `skip_model_request: false` ⇒ `skipModelRequest === false`（翻开关后能自愈）', async () => {
    const config = await fetchZcodeCaptchaConfig(
      CREDENTIAL,
      configFetch({ enabled: true, prefix: 'pf', region: 'sgp', sceneId: 'sc', skip_model_request: false }),
    )
    expect(config?.skipModelRequest).toBe(false)
  })

  it('★★ 字段**缺席** ⇒ `undefined`，**不得**退化成 `false`（否则老配置下每请求白烧一个 param）', async () => {
    const config = await fetchZcodeCaptchaConfig(
      CREDENTIAL,
      configFetch({ enabled: true, prefix: 'pf', region: 'cn', sceneId: 'sc' }),
    )
    expect(config?.skipModelRequest).toBeUndefined()
    expect(config?.enabled).toBe(true)
  })

  it('★ 下划线→camelCase 必须映射（官方 `getCaptchaConfig()` 的 `skip_model_request` → `skipModelRequest`）', async () => {
    const config = await fetchZcodeCaptchaConfig(
      CREDENTIAL,
      configFetch({ enabled: false, skip_model_request: true, prefix: 'pf', region: 'cn', sceneId: 'sc' }),
    )
    // `enabled: false` 同样要被读到（一票否决用）。
    expect(config?.enabled).toBe(false)
    expect(config?.skipModelRequest).toBe(true)
  })
})

/* ───────────── 二、适配器按这个信号决定「首发带不带」 ───────────── */

/** 能正常结束的 Anthropic SSE 响应。 */
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

/** 上游索要验证（`3007`）—— `skip_model_request: false` 时先探必然撞到它。 */
function captchaRequiredError(): Response {
  return new Response('{"code":3007,"msg":"captcha verify failed"}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 记录每次请求验证头与 mint 次数的适配器桩。
 *
 * ⚠ 桩响应**用尽即抛**（同 `zcode-captcha-lazy.spec.ts` 的写法）：静默回一个
 * 成功响应会掩盖「实际多发了一发」这类真实回归，而「多发一发先探」
 * 恰恰是本文件要防的那个缺陷。
 */
function makeAdapter(responses: Response[]) {
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
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(`桩响应已用尽（第 ${String(captchaHeaders.length)} 次请求）⇒ 实际请求数超出用例预期`)
      }
      return next
    }) as never,
    gate: new ModelGate({ sleep: async () => {} }),
    sleep: async () => {},
    product: ZCODE,
    currentAccountId: () => 'acct-A',
  })
  return { adapter, mintCalls: () => mintCount, headers: captchaHeaders }
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

/** 只放两个开关的配置（region 等用兜底值，与本文件无关）。 */
function config(over: Partial<ZcodeCaptchaConfig>): ZcodeCaptchaConfig {
  return { ...ZCODE_CAPTCHA_FALLBACK, ...over }
}

describe('ZCode 首发是否直接带 captcha（读上游开关）', () => {
  beforeEach(() => {
    resetCaptchaRequirementMemory()
  })

  it('★★ `skipModelRequest: false` ⇒ 首发**直接带** param，只发 1 发、不白吃那次 3007', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([okSse()])
    adapter.setCaptchaConfig(config({ skipModelRequest: false }))
    await drain(adapter.stream(streamOptions()))
    // 关键：**只发了一发**。旧行为会是 [undefined, 'param-1'] 两发（先探撞 3007 再补产）。
    expect(headers).toEqual(['param-1'])
    expect(mintCalls()).toBe(1)
  })

  it('★ `skipModelRequest: true` ⇒ 仍**先探**（上游不校验，先探零成本且不多 mint）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([okSse()])
    adapter.setCaptchaConfig(config({ skipModelRequest: true }))
    await drain(adapter.stream(streamOptions()))
    expect(headers).toEqual([undefined])
    expect(mintCalls()).toBe(0)
  })

  it('★★ 字段**缺席** ⇒ 仍**先探**（不知道就不猜：不得白烧设备级 captcha 配额）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([okSse()])
    adapter.setCaptchaConfig(config({}))
    await drain(adapter.stream(streamOptions()))
    expect(headers).toEqual([undefined])
    expect(mintCalls()).toBe(0)
  })

  it('★ `enabled: false` **一票否决**：即便 `skipModelRequest: false` 也先探（上游关了 captcha）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([okSse()])
    adapter.setCaptchaConfig(config({ enabled: false, skipModelRequest: false }))
    await drain(adapter.stream(streamOptions()))
    expect(headers).toEqual([undefined])
    expect(mintCalls()).toBe(0)
  })

  it('★ 没注入过配置（`undefined`）⇒ 先探（与引入本机制之前逐字一致）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([okSse()])
    await drain(adapter.stream(streamOptions()))
    expect(headers).toEqual([undefined])
    expect(mintCalls()).toBe(0)
  })

  it('★ 首发带上仍被 3007 拒 ⇒ 走既有补产自愈（用户看不到失败）', async () => {
    const { adapter, mintCalls, headers } = makeAdapter([captchaRequiredError(), okSse()])
    adapter.setCaptchaConfig(config({ skipModelRequest: false }))
    const chunks = await drain(adapter.stream(streamOptions()))
    // 首发带 param-1 被拒 ⇒ 补产 param-2 重发成功。
    expect(headers).toEqual(['param-1', 'param-2'])
    expect(mintCalls()).toBe(2)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('★ 观测：主动带的那一发记在 `upfrontCaptchaCount`，**不**混进 probeFirst / knownRequired', async () => {
    const { adapter } = makeAdapter([okSse()])
    adapter.setCaptchaConfig(config({ skipModelRequest: false }))
    await drain(adapter.stream(streamOptions()))
    const snap = captchaRequirementObservability()
    expect(snap.upfrontCaptchaCount).toBe(1)
    expect(snap.probeFirstCount).toBe(0)
    expect(snap.knownRequiredCount).toBe(0)
  })
})

/* ───────────── 三、接线：`fetchCaptchaConfig` 真的把字段带出来 ───────────── */

describe('★ 接线：ZcodeAuth.fetchCaptchaConfig 把两个开关一路带出来', () => {
  /** 内存凭据存储（样板同 `zcode-captcha-region.spec.ts`）。 */
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

  it('★ 上游 `skip_model_request: false` ⇒ auth 读回来就是 `false`（不被中间层抹掉）', async () => {
    const ctx = new Context()
    ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(CREDENTIAL))

    const auth = new ZcodeAuth(ctx, {
      fetchImpl: configFetch({ enabled: true, prefix: 'pf', region: 'cn', sceneId: 'sc', skip_model_request: false }),
    })
    const got = await auth.fetchCaptchaConfig()
    expect(got?.skipModelRequest).toBe(false)
  })
})

/* ───────────── 四、接线守卫：原语写好了，必须真的接上 ───────────── */

/**
 * ⚠ 本仓库历史上**多次**栽在「原语写好了但没接上」（AGENTS.md 的
 * 「三类静默失效」段：`zcode-upstream.ts` 的 `fetchImpl` 曾是**死参数**）。
 *
 * 上面第三段证明了「配置能带出两个开关」，第二段证明了「适配器认得这个信号」——
 * 但**都不证明** `index.ts` 那条编排真的把**带开关的那份配置**交给了适配器。
 * 少了本段，「`setCaptchaConfig` 收到一份只有三个字段的对象」这种退化
 * 会让上面所有用例继续全绿，而生产行为退回改动前。
 */
describe('★ 接线守卫：index.ts 必须把「带开关的配置」交给适配器', () => {
  const indexSource = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')

  it('★ `resolveZcodeCaptchaConfig` 把 `fetchCaptchaConfig()` 的原样结果交给 `setCaptchaConfig`', () => {
    // 剥注释后再断言：本仓库记过「把接线改成注释后源码正则仍全绿」那类假绿。
    const code = indexSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    /**
     * ⚠ 判据必须锚定**同一个返回值**：若写成「存在 `fetchCaptchaConfig` 调用」
     * 加「存在 `setCaptchaConfig` 调用」两条独立断言，中间插一层
     * 「重建一个只有 region/prefix/sceneId 的对象」照样能通过。
     * 故这里直接要求 `setCaptchaConfig(remote)` —— `remote` 就是
     * `await zcode.fetchCaptchaConfig()` 的返回值本身。
     */
    expect(code).toMatch(/const\s+remote\s*=\s*await\s+zcode\.fetchCaptchaConfig\(\)/)
    expect(code).toMatch(/setCaptchaConfig\(\s*remote\s*\)/)
  })

  it('★ 适配器的门控真的读了 `requiresCaptchaUpfront`（不是只 import 了没用）', () => {
    const adapterSource = readFileSync(resolve(HERE, '../../src/zcode-adapter.ts'), 'utf8')
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toMatch(/requiresCaptchaUpfront\(this\.captchaConfig\)/)
    // 且它必须进 mint 的门控，而不是只算出来放着。
    expect(code).toMatch(/knownRequired\s*\|\|\s*probeRejected\s*\|\|\s*upfrontCaptcha/)
  })
})
