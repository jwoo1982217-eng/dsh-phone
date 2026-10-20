import { describe, expect, it } from 'vitest'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  collectOpenAiCompletion,
  failureToOpenAiError,
  toOpenAiSse,
} from '../../src/openai-gateway/stream.js'
import { GATEWAY_FALLBACK_STATUS, upstreamStatusOrFallback } from '../../src/openai-gateway/model-errors.js'

/**
 * 网关「上游状态码穿透」对**全部 14 个 provider** 的影响面。
 *
 * ## 为什么这份文件独立于 `openai-gateway-stream.spec.ts`
 *
 * 后者是用 gemini 的措辞写的，只锁住「gemini 的 404 能穿透」。但
 * `failureToOpenAiError` 是**全 provider 共用**的出口，而**几乎每个既有适配器
 * 都已经在抛 `{ status: … }`** —— buddy / cline / codearts / lobsterai / loomy /
 * qoder / raccoon / trae / zcode / minimax / opencode 共 **11 个**（2026-10-04 核对）。
 *
 * ⇒ 这条修复的真实影响面不是「一个 provider」，而是**所有上游 4xx 都不再被退化成
 * 502**（502 在 OpenAI 客户端眼里是「服务端故障」⇒ 白重试 5 次）。本文件把这条
 * 影响面按「既有 provider 的真实状态码」逐条钉死，并锁住两个**不能**被穿透的边界。
 */

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* values
}

/** 造一个带状态的终止分片 —— 这是 harness 归一化后的真实形状。 */
function failing(status: number | undefined, code = 'SERVER', message = 'upstream exploded'): StreamChunk {
  const failure: LlmFailure = { code, message, ...status === undefined ? {} : { status } }
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/** 从 SSE 输出里取出第一个错误帧的 `error` 对象。 */
async function firstErrorFrame(values: StreamChunk[]): Promise<Record<string, unknown>> {
  const output: string[] = []
  for await (const item of toOpenAiSse(chunks(values), 'req-x', 'p/m')) output.push(item)
  const frame = output.find((item) => item.includes('"error"'))
  expect(frame, '应当产出一个错误帧').toBeDefined()
  return JSON.parse(frame!.slice('data: '.length)).error as Record<string, unknown>
}

describe('状态码穿透 · 既有 provider 的真实状态码（不再退化成 502）', () => {
  /**
   * 逐条取自各适配器的真实 `throw new LlmError(..., { status })` 形态。
   * ⚠️ 每条都必须**原样穿透** —— 修复前它们全被读成 502，客户端白重试。
   */
  const CASES: ReadonlyArray<readonly [string, string, number]> = [
    // [来源, message, status]
    ['codearts 模型未注册', 'codearts: The model is not registered, please request other model', 404],
    ['buddy 凭据失效', 'buddy: credential expired and refresh failed', 401],
    ['buddy 参数非法', 'buddy: Invalid parameter: max_tokens', 400],
    ['qoder 排队额度', 'qoder: 今日额度已用尽', 429],
    ['cline 凭据失效', 'cline: credential expired and refresh failed', 401],
    ['lobsterai 积分不足', 'lobsterai（余额不足）', 402],
    ['loomy 上游拒绝', 'loomy: invalid request', 400],
    ['raccoon 限流', 'raccoon: 频率限制', 429],
    ['trae 积分不足', 'trae: 积分不足（余额不足）', 402],
    ['zcode 上游拒绝', 'zcode: upstream rejected', 400],
    ['minimax 上游拒绝', 'minimax: upstream rejected', 400],
    ['opencode 通道被拒', 'opencode: 通道被拒绝', 403],
  ]

  for (const [label, message, status] of CASES) {
    it(`${label} → ${status}`, () => {
      const error = new LlmError(message, 'INVALID_REQUEST', { status })
      expect('status' in error, '前提：顶层没有 status，只在 failure 上').toBe(false)
      expect(failureToOpenAiError(error).status).toBe(status)
    })
  }

  it('流式与非流式两条路径给出同一个状态码（不得一条 404 一条 502）', async () => {
    const status = 404
    const viaSse = await firstErrorFrame([failing(status, 'INVALID_REQUEST', 'codearts: The model is not registered')])
    const thrown = await collectOpenAiCompletion(
      chunks([failing(status, 'INVALID_REQUEST', 'codearts: The model is not registered')]),
      'req-y', 'codearts/GLM-5.3',
    ).then(() => undefined, (error: unknown) => error)
    expect(viaSse.status).toBe(status)
    expect(failureToOpenAiError(thrown).status).toBe(status)
  })
})

describe('⚠️ 边界一：5xx 必须仍然是 5xx（可重试故障不能被改成 4xx）', () => {
  /**
   * 门禁是 `400 ≤ status ≤ 599`，所以**上游的 5xx 会原样穿透**。
   *
   * ⚠️ 这是**刻意**的，不是漏网：502 兜底的语义是「拿不到可用状态码 ⇒ 当成
   * 网关自己的可重试故障」。一旦上游给出了 500/503/504，原样透传比统一改成 502
   * **更准**（503 与 502 在客户端的退避策略里甚至可能不同），且两者都可重试。
   *
   * 本组锁的是反向风险：**别有人把「5xx 也别穿透」当修复** —— 那会把上游的
   * 503 Service Unavailable 降级成 4xx 语义，让本该重试的故障失去重试机会。
   */
  const CASES: ReadonlyArray<readonly [number, number]> = [
    [500, 500],
    [502, 502],
    [503, 503],
    [504, 504],
    [599, 599],
  ]

  for (const [status, expected] of CASES) {
    it(`上游 ${status} → ${expected}（保持 5xx，可重试）`, async () => {
      expect(failureToOpenAiError(new LlmError('boom', 'SERVER', { status })).status).toBe(expected)
      expect((await firstErrorFrame([failing(status)])).status).toBe(expected)
    })
  }

  it('无状态码的普通错误 → 502（兜底语义）', async () => {
    expect(failureToOpenAiError(new Error('boom')).status).toBe(502)
    expect(failureToOpenAiError(new LlmError('boom', 'SERVER')).status).toBe(502)
    expect((await firstErrorFrame([failing(undefined)])).status).toBe(502)
  })

  it('排队类失败（无状态码）仍是 502 —— codearts / qoder 都要继续等', async () => {
    // 这两条是真实形态：排队超时/取消**不带** status（src/llm-adapter.ts:1345、qoder-adapter.ts:976）。
    for (const message of [
      'codearts: queue wait timed out after 30 minutes',
      'qoder: 排队等待超时',
    ]) {
      expect(failureToOpenAiError(new LlmError(message, 'QUEUE')).status, message).toBe(502)
      expect((await firstErrorFrame([failing(undefined, 'QUEUE', message)])).status, message).toBe(502)
    }
  })

  it('超出 100–599 的状态码不可达（LlmError 构造器与宿主归一化都会拒）', () => {
    // 这条是**记录边界**：门禁下界写 400 是因为上界 599 已由宿主保证，
    // 本组不需要（也不应该）再测 99 / 600 —— 它们根本进不来。
    expect(() => new LlmError('boom', 'SERVER', { status: 99 })).toThrow()
    expect(() => new LlmError('boom', 'SERVER', { status: 600 })).toThrow()
  })
})

describe('★ 边界二：非错误状态码（2xx/3xx）不得原样穿透', () => {
  /**
   * ## 真实来源
   *
   * `src/llm-adapter.ts`（codearts）有**三处**故意用 `{ status: 200 }` 表示
   * 「HTTP 是 200，但流里的内容是业务失败」：
   * `QUOTA_EXCEEDED`（:1218）、`BENEFIT_NOT_FOUND`（:1657）、`INVALID_REQUEST`（:1659）。
   * 这是为了**不丢信息**（上游真的回了 200），而 `normalizeLlmFailure` 也会如实
   * 保留它 —— 实测宿主 `failureSnapshot()` 只校验 `100 ≤ status ≤ 599`，不过滤 2xx。
   *
   * ## 为什么必须挡住
   *
   * 一条**错误**帧里带 `"status": 200` 是自相矛盾的：客户端若读 `error.status`
   * 判成败，会把「额度用尽」读成成功。而网关自己的 HTTP 状态在流式下**改不了**
   * （流已发出 200），这个字段是唯一的错误信号载体。
   *
   * ⚠️ 三处出口必须**一致**：`failureToOpenAiError` 与 `collectOpenAiCompletion`
   * 都有 `400 ≤ status ≤ 599` 的门禁，只有 `toOpenAiSse` 曾漏掉 —— 于是同一条
   * codearts 配额错误，走非流式得 502（对），走流式得 200（错）。
   */
  const SUCCESS_LIKE: ReadonlyArray<readonly [string, number]> = [
    ['200（codearts 业务失败的真实取值）', 200],
    ['201', 201],
    ['204', 204],
    ['301', 301],
    ['302', 302],
    ['399', 399],
  ]

  for (const [label, status] of SUCCESS_LIKE) {
    it(`${label} → 429（三处出口保留额度业务语义）`, async () => {
      const message = 'codearts: Billing daily count exceeded'
      // ① 抛错出口（catch 路径）
      expect(
        failureToOpenAiError(new LlmError(message, 'QUOTA_EXCEEDED', { status })).status,
        'failureToOpenAiError',
      ).toBe(429)
      // ② 非流式
      const thrown = await collectOpenAiCompletion(
        chunks([failing(status, 'QUOTA_EXCEEDED', message)]), 'req-z', 'codearts/glm-5.3-flash',
      ).then(() => undefined, (error: unknown) => error)
      expect(failureToOpenAiError(thrown).status, 'collectOpenAiCompletion').toBe(429)
      // ③ 流式（流已发 200，status 字段是唯一载体）
      expect((await firstErrorFrame([failing(status, 'QUOTA_EXCEEDED', message)])).status, 'toOpenAiSse').toBe(429)
    })
  }

  it('门禁函数本身逐值验收（下界 400 / 上界 599）', () => {
    // 直接测真实导出的门禁，而不是在用例里复刻一份 —— 复刻版只能证明
    // 「复刻逻辑自洽」，证明不了仓库里的实现。
    expect(GATEWAY_FALLBACK_STATUS).toBe(502)
    for (const status of [400, 404, 429, 500, 502, 503, 599]) {
      expect(upstreamStatusOrFallback(status), String(status)).toBe(status)
    }
    for (const status of [100, 200, 302, 399, 600, 700]) {
      expect(upstreamStatusOrFallback(status), String(status)).toBe(GATEWAY_FALLBACK_STATUS)
    }
    for (const status of [undefined, null, NaN, '404', {}, []]) {
      expect(upstreamStatusOrFallback(status), String(status)).toBe(GATEWAY_FALLBACK_STATUS)
    }
  })

  it('⚠️ 已做反向验证：下界从 400 放回 100，上面这批用例会红 6 条', () => {
    // 记录本组用例的有效性来源（2026-10-04 实测）：把 `upstreamStatusOrFallback`
    // 的下界改成 100（等价于修复前的 `typeof === 'number' ? status : 502`）后，
    // 本文件 `2xx/3xx` 六条全部变红；改回 400 后全绿。
    expect(upstreamStatusOrFallback(200)).toBe(GATEWAY_FALLBACK_STATUS)
  })
})
