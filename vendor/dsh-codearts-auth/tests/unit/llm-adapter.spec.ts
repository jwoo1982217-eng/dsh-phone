import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  CHAT_API_BASE,
  CodeArtsAdapter,
  codeartsQuotaExhaustedMessage,
  formatResetIn,
  isSseQueueErrorCode,
  isSseQuotaExhaustedErrorCode,
  QUEUE_STATUS_BASE,
  RATE_LIMIT_FALLBACK_MS,
} from '../../src/llm-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'
import { setBenefitMemoryCache } from '../../src/models.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: 'GLM-5.2',
  messages: [],
  signal: new AbortController().signal,
} as never

function makeAdapter(overrides: {
  credential?: CodeArtsCredential | undefined
  refresh?: () => Promise<void>
  fetchImpl?: typeof fetch
  fetchRemoteModels?: () => Promise<Array<{ id: string; name: string }>>
  /** 多账号池替身；本文件只用到模型黑名单（listModels 的过滤输入）。 */
  accountPool?: unknown
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : validCredential
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => { await refresh(); credential = validCredential },
    fetchImpl,
    fetchRemoteModels: overrides.fetchRemoteModels,
    ...overrides.accountPool !== undefined ? { accountPool: overrides.accountPool as never } : {},
  })
  return adapter
}

/** 只实现 listModels 所需方法的账号池替身：对指定 provider 报告黑名单。 */
function poolWithDisabled(provider: string, ids: string[]) {
  const disabled = new Set(ids)
  return {
    disabledModelsFor: (value: string) => (value === provider ? disabled : new Set<string>()),
  }
}

/**
 * 目录门控替身。
 *
 * `loggedInRefs` = 账号池里**凭据可解析**的 ref（空数组表示没有已登录账号）。
 * 替身只关心「账号池里有没有可用凭据」这一件事 —— 单凭据例外已移除，
 * 故不再需要额外 ref 参数。
 */
function poolWithCredentials(loggedInRefs: readonly string[]) {
  const pool = new Set(loggedInRefs)
  return {
    disabledModelsFor: () => new Set<string>(),
    hasLoggedInAccount: async (_provider: string) => pool.size > 0,
  }
}

describe('CodeArtsAdapter', () => {
  it('providerInfo identifies the codearts route', () => {
    expect(makeAdapter().providerInfo('codearts')).toMatchObject({ id: 'codearts', name: 'CodeArts Agent' })
  })

  it('listModels advertises the openpangu-2.0 and deepseek-v4 models alongside the GLM family', async () => {    // 对齐 deveco-code-rust 参考实现 codearts.rs：新增盘古模型
    // openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
    // 后端 /v1/default/models 下发的 model_id 为全小写。
    // DeepSeek V4（对齐 deveco-code 62834ff6）：CodeArts Agent 模型列表新增
    // deepseek-v4-flash / deepseek-v4-pro（UI 标注每日 1000 万免费 Tokens 福利）。
    // ⚠️ 早期注释称「deepseek-v4-flash-0731 后端未注册」，该结论**有误**
    // （2026-09-23 修正，对齐 deveco-code-rust fb1b4a2）：它返回 404 的真实原因是
    // **缺少 maas_type: benefit 头**，带上即成功；带日期后缀与无后缀是后端上两个
    // 不同的模型，不能互相替代。
    const models = await makeAdapter().listModels('codearts')
    const ids = models.map(model => model.id)
    expect(ids).toContain('openpangu-2.0-flash')
    expect(ids).toContain('openpangu-2.0-pro')
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).toContain('deepseek-v4.1-flash')
    const flash = models.find(model => model.id === 'openpangu-2.0-flash')
    const pro = models.find(model => model.id === 'openpangu-2.0-pro')
    const dsFlash = models.find(model => model.id === 'deepseek-v4-flash')
    const dsPro = models.find(model => model.id === 'deepseek-v4-pro')
    expect(flash).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-flash' })
    expect(pro).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-pro' })
    expect(dsFlash).toMatchObject({ provider: 'codearts', name: 'deepseek-v4-flash' })
    expect(dsPro).toMatchObject({ provider: 'codearts', name: 'deepseek-v4-pro' })
    // 默认模型仍是 GLM-5.2（新增模型不应改变默认模型）。
    expect(ids[0]).toBe('GLM-5.2')
  })

  it('resolveModel discloses contextWindow for GLM-5.2 and deepseek-v4 models', async () => {
    // GLM-5.2：202752；glm-5.3-flash：1048576（1M，对齐 deveco-code-rust 90aeb17d）；
    // deepseek-v4-flash/pro：1048576（1M）；deepseek-v4.1-flash：1000000
    // （对齐 IDE 下发的 inferhub-provider 模型配置，2026-09 kernel 日志）。
    // 其余模型（GLM-5.1/GLM-5/openpangu-*）未公开容量，context 应为 undefined。
    const adapter = makeAdapter()
    const glm52 = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(glm52.context).toEqual({ contextWindow: 202752 })
    const glm53flash = await adapter.resolveModel('codearts', 'glm-5.3-flash')
    expect(glm53flash.context).toEqual({ contextWindow: 1_048_576 })
    const dsFlash = await adapter.resolveModel('codearts', 'deepseek-v4-flash')
    expect(dsFlash.context).toEqual({ contextWindow: 1048576 })
    const dsPro = await adapter.resolveModel('codearts', 'deepseek-v4-pro')
    expect(dsPro.context).toEqual({ contextWindow: 1048576 })
    const dsV41Flash = await adapter.resolveModel('codearts', 'deepseek-v4.1-flash')
    expect(dsV41Flash.context).toEqual({ contextWindow: 1_000_000 })
    const glm51 = await adapter.resolveModel('codearts', 'GLM-5.1')
    expect(glm51.context).toBeUndefined()
    const pangu = await adapter.resolveModel('codearts', 'openpangu-2.0-pro')
    expect(pangu.context).toBeUndefined()
  })

  // 回归：dsh-llm 0.1.1-rc.2 的 LlmRuntime.prepareCall() 会直接调用
  // registration.adapter.prepareCall()，而本仓库链接的副本（0.1.0-rc.6）
  // 的 LlmAdapter 基类没有该方法——缺少时每轮请求都以
  // `registration.adapter.prepareCall is not a function` 失败。
  it('prepareCall resolves the model and binds its stream', async () => {
    const adapter = makeAdapter()
    expect(typeof adapter.prepareCall).toBe('function')
    const call = await adapter.prepareCall('codearts', 'GLM-5.2')
    expect(call.model).toMatchObject({
      provider: 'codearts',
      id: 'GLM-5.2',
      context: { contextWindow: 202752 },
      inputModalities: ['text'],
    })
    expect(typeof call.stream).toBe('function')
  })

  // 回归（2026-09-29）：CodeArts 此前**从不声明** `reasoning`，故模型选择器里
  // 没有思考档位可选。实测该网关唯一真正生效的思考控制是顶层 `thinking.type`：
  //   - `{type:'disabled'}` → `reasoning_tokens` 3/3 全为 0、正文仍正确；
  //   - `{type:'enabled'}` 与不传等价（服务端默认就开着）。
  // 而 `reasoning_effort`（low/high/none/minimal）与嵌套 `reasoning.effort`
  // **都被接受但完全无效果**（落在基线噪声内，`none` 也照常思考）。
  // 故只声明「开启 / 关闭」两档，**不得**臆造 low/high/max 强度阶梯。
  it('resolveModel declares the thinking on/off switch for every model', async () => {
    const adapter = makeAdapter()
    for (const model of ['GLM-5.2', 'glm-5.3-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'openpangu-2.0-pro']) {
      const resolved = await adapter.resolveModel('codearts', model)
      expect({ model, efforts: resolved.reasoning?.efforts.map(e => e.id) }).toEqual({
        model, efforts: ['on', 'off'],
      })
      // 展示名必须是中文（DSH 直接渲染 name，不本地化）。
      expect(resolved.reasoning?.efforts.map(e => e.name)).toEqual(['开启', '关闭'])
      // ⚠️ defaultEffort 必须落在 efforts 内，否则 DSH 会抛
      // UNSUPPORTED_REASONING_EFFORT（dsh-llm 的 resolveCallWithInfo 校验）。
      expect(resolved.reasoning?.defaultEffort).toBe('on')
      expect(resolved.reasoning!.efforts.some(e => e.id === resolved.reasoning!.defaultEffort)).toBe(true)
    }
  })

  it('maps the "off" effort onto top-level thinking.type=disabled, and sends nothing for "on"', async () => {
    // ⚠️ 必须断言「开启档不发该字段」：`enabled` 与服务端默认等价，发了只是噪声；
    // 更重要的是不能把它写成 raccoon 那种 `extra_body.thinking` 嵌套方言
    // （两者是不同网关的方言，混用会静默无效）。
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const run = async (reasoningEffort?: string) => {
      const opts = {
        provider: 'codearts',
        model: 'deepseek-v4-flash',
        messages: [],
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        signal: new AbortController().signal,
      } as never
      for await (const _ of adapter.stream(opts)) { /* drain */ }
      return seen.at(-1)!
    }

    const off = await run('off')
    expect(off.thinking).toEqual({ type: 'disabled' })
    // 顶层字段，不是嵌套方言。
    expect(off.extra_body).toBeUndefined()

    const on = await run('on')
    expect(on.thinking).toBeUndefined()

    const unset = await run(undefined)
    expect(unset.thinking).toBeUndefined()
  })

  /**
   * ⚠️ 输出上限必须在**出站 body** 上锁死，不能只测网关层的归一化函数。
   *
   * 真实缺陷（PR !70 审计发现）：钳制原先只做在
   * `openai-gateway/messages.ts` 的 `normalizeMaxTokens`，而
   * `maxTokens` 是 agent 的一等构造参数（`dsh-agent-loop` 只校验
   * 「正安全整数」、**无上限校验**）⇒ **不经过网关的直连路径完全绕过那道判据**，
   * 128000 会原样发往华为云（上游回 `The request param is invalid`）。
   * 这与 TRAE 的 `clampTraeMaxTokens`、Cline 的 `clampClineMaxTokens` 同因。
   *
   * ⇒ 回归用例必须经 `stream()` 的真实链路、断言**实际发出去的** `max_tokens`；
   * 直接调纯函数会像本仓库既往教训（AGENTS.md「包装适配器」）那样全绿而测不到生产路径。
   */
  describe('输出上限钳制（最后一道防线）', () => {
    /** 跑一次真实 stream()，返回出站请求体。 */
    const sentBody = async (maxTokens: unknown, model = 'deepseek-v4-flash') => {
      const seen: Array<Record<string, unknown>> = []
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const adapter = makeAdapter({ fetchImpl })
      const opts = {
        provider: 'codearts', model, messages: [], maxTokens,
        signal: new AbortController().signal,
      } as never
      for await (const _ of adapter.stream(opts)) { /* drain */ }
      return seen.at(-1)!
    }

    it('显式传入超大 maxTokens 时收敛到 65536（修复前是原样透传 128000）', async () => {
      expect((await sentBody(128_000)).max_tokens).toBe(65_536)
      expect((await sentBody(131_072)).max_tokens).toBe(65_536)
      expect((await sentBody(999_999)).max_tokens).toBe(65_536)
    })

    it('较小的请求值原样保留（钳制只往下压，不往上抬）', async () => {
      expect((await sentBody(32_000)).max_tokens).toBe(32_000)
      expect((await sentBody(64)).max_tokens).toBe(64)
      expect((await sentBody(65_536)).max_tokens).toBe(65_536)
    })

    it('未传 / 非法值回落到默认 65536（不编造别的数值）', async () => {
      expect((await sentBody(undefined)).max_tokens).toBe(65_536)
      expect((await sentBody(0)).max_tokens).toBe(65_536)
      expect((await sentBody(-1)).max_tokens).toBe(65_536)
      expect((await sentBody(Number.NaN)).max_tokens).toBe(65_536)
      expect((await sentBody(Number.POSITIVE_INFINITY)).max_tokens).toBe(65_536)
    })

    it('对**每一个** CodeArts 模型都生效 —— 适配器层是统一边界，不逐模型开洞', async () => {
      for (const model of ['GLM-5.2', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'openpangu-2.0-pro']) {
        expect((await sentBody(128_000, model)).max_tokens, model).toBe(65_536)
      }
    })
  })

  it('streams text deltas from an OpenAI-compatible SSE response', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":" there"}}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const chunks: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
    }
    expect(chunks).toEqual(['hi', ' there'])
  })

  it('refreshes an expired credential before streaming and signs the request', async () => {
    let refreshed = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(String(input)).toBe(`${CHAT_API_BASE}/chat/completions`)
      expect(headers.get('Authorization')).toMatch(/^SDK-HMAC-SHA256 Access=AK/)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(headers.get('Chat-Id')).toBeTruthy()
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      credential: { ...validCredential, expires_at: '2020-01-01T00:00:00Z' },
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['ok'])
  })

  it('listModels advertises glm-5.3-flash with the GLM family', async () => {
    // 对齐 deveco-code-rust 90aeb17d：CodeArts Agent 后端新增 GLM-5.3 Flash
    // （benefit 免费额度模型，后端注册 id 为全小写 glm-5.3-flash）。
    const models = await makeAdapter().listModels('codearts')
    expect(models.map((model) => model.id)).toContain('glm-5.3-flash')
    // 默认模型仍是 GLM-5.2（新增模型不应改变默认模型）。
    expect(models[0]!.id).toBe('GLM-5.2')
  })

  it('signs glm-5.3-flash requests with the maas_type: benefit header', async () => {
    // glm-5.3-flash 是 benefit（免费额度）模型：maas_type: benefit 必须
    // 参与 SDK-HMAC-SHA256 签名并随请求发送，否则后端返回
    // InferHub.002002009.404 "model is not registered"。
    // （逆向自 CodeArts Agent IDE mitmproxy 抓包，对齐 deveco-code-rust 90aeb17d。）
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('maas_type')).toBe('benefit')
      const auth = headers.get('Authorization') ?? ''
      expect(auth).toContain('maas_type')
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream({ ...streamOptions, model: 'glm-5.3-flash' } as never)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['ok'])
  })

  it('does not send maas_type for other models', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('maas_type')).toBeNull()
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('signs deepseek-v4.1-flash with maas_type: benefit（真实缺陷回归）', async () => {
    // 真实缺陷（用户报障，2026-09-23）：deepseek-v4.1-flash 是 benefit 模型，
    // 必须带 maas_type: benefit，而早期实现把该集合硬编码为只有 glm-5.3-flash
    // → 发消息后调用失败（实测不带该头返回 InferHub.002002009.404
    // "The model is not registered"，带上即成功）。
    // 对齐 deveco-code-rust fb1b4a2 的动态判定。
    setBenefitMemoryCache([]) // 隔离磁盘缓存，只走静态兜底集合
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        expect(headers.get('maas_type')).toBe('benefit')
        // 必须参与 SDK-HMAC-SHA256 签名（出现在 SignedHeaders 中），
        // 否则服务端验签失败。
        expect(headers.get('Authorization') ?? '').toContain('maas_type')
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
      })
      const adapter = makeAdapter({ fetchImpl })
      const texts: string[] = []
      for await (const chunk of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
      }
      expect(texts).toEqual(['ok'])
    } finally {
      setBenefitMemoryCache(undefined)
    }
  })

  it('does not send maas_type for the suffix-less deepseek-v4-flash', async () => {
    // 无后缀 deepseek-v4-flash 是**非 benefit** 模型（带 maas_type 反而
    // `unsupported model`）；它是 gateway 的 -0731 形态经归一化后的 id，
    // 而 -0731 才是 benefit —— 两者是后端上不同的模型，不能混为一谈。
    setBenefitMemoryCache([])
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('maas_type')).toBeNull()
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
      })
      const adapter = makeAdapter({ fetchImpl })
      for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4-flash' } as never)) { /* drain */ }
      expect(fetchImpl).toHaveBeenCalled()
    } finally {
      setBenefitMemoryCache(undefined)
    }
  })

  it('refreshes the credential once when the chat request fails with APIG.0602 and retries successfully', async () => {
    // CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
    // APIG.0602 "Invalid token"。入口的 expires_at 预判无法覆盖后端提前
    // 吊销或时钟偏差，stream() 应在收到该错误后触发一次静默 refresh，
    // 用新凭据重试 chat 请求；最多 refresh 一次，避免死循环。
    let refreshed = false
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      if (chatCalls === 1) {
        return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
      }
      // 第二次请求在 refresh 后发出，应使用刷新后的凭据（makeAdapter 的
      // refresh() 会把 credential 恢复为 validCredential）。
      const headers = new Headers(init?.headers)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(chatCalls).toBe(2)
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['recovered'])
  })

  it('does not refresh more than once on repeated auth errors', async () => {
    // 连续两次 APIG.0602：第一次触发 refresh+重试，第二次仍失败应直接抛 AUTH，
    // 不再刷新，避免死循环。
    let refreshCount = 0
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshCount += 1 },
      fetchImpl,
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'AUTH' })
    expect(chatCalls).toBe(2)
    expect(refreshCount).toBe(1)
  })

  it('throws MISSING_CREDENTIAL when no credential is available', async () => {
    // 直接构建适配器：makeAdapter 的 refresh() 会恢复
    // 有效凭据，因此"刷新后仍无凭据"需要用原始适配器。
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchImpl: async () => new Response('not found', { status: 404 }),
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('normalizes a non-2xx response to an LlmError', async () => {
    const adapter = makeAdapter({ fetchImpl: async () => new Response('nope', { status: 500 }) })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toBeInstanceOf(LlmError)
  })

  it('retries the chat request after a queue error even when the queue status is working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求，不轮询等待
    // working。状态端点仅在每次重试前查一次（此处 working 非终态，
    // 不抛错），等待 10s 后重试 chat 成功。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'working', queue_position: 1, message: 'admitted' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // 第一次 chat 调用被并发上限限流。
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"queued-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['queued-ok'])
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('directly retries the chat request while queued instead of waiting for working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求（10s 一次），
    // 不轮询等待状态端点 working。状态端点仅在每次重试前查一次，
    // 用于检测终态（error/queue_full）提前抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"finally"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['finally'])
    expect(calls.chat).toBe(2)
    // 排队中不轮询状态端点：仅重试前查一次。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('retries the chat request when the SSE stream carries the TPM limit error (81111.429)', async () => {
    // CodeArts 以 HTTP 200 + SSE 内嵌 error_code 返回 TPM 限流
    // （InferHub.ModelArts.81111.429），而非 4xx。适配器必须把它当成排队
    // 处理（延迟后重试 chat），而不是静默当成 [DONE] 流结束吞掉——否则
    // 用户看到"思考后无输出"。本用例：第一次请求 SSE 返回该错误，重试后
    // 第二次返回正常文本。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // HTTP 200 + SSE 内嵌排队/限流错误（e2e 实测的真实响应形态）。
        return new Response(
          'data:{"text":"[DONE]","error_code":"InferHub.ModelArts.81111.429","error_msg":"The model TPM limit has been significantly exceeded. Please reduce the request rate and retry later."}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 81111.429 被识别为排队错误：重试 chat 后成功输出正文。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
    // 排队/限流期间零产出：只有重试成功后的正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('emits no content blocks while waiting for queue admission', async () => {
    // 排队期间适配器不得产出任何内容块：StreamChunk 协议没有瞬态状态通道，
    // reasoning/text 块都会被组装进 assistant 消息并持久化（reasoning 还会
    // 显示在 web 的 Think 区域，visible 回退可能把推理文本回传给模型），
    // 因此排队提示既不显示也不留痕，web 显示 harness 自身的"运行中"状态。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 排队期间零产出：放行后只有正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('never leaks queue notices into the visible text fallback when the model returns reasoning only', async () => {
    // GLM 特性：模型可能只返回 reasoning_content 而 content 为空，适配器
    // 回退把推理作为可见文本。排队提示必须被排除在该回退之外——否则排队
    // 文本会作为正文持久化并在后续调用中作为上下文发送给模型。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue === 1 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"real-reasoning"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textEnds: string[] = []
    const reasoningEnds: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') textEnds.push(chunk.block.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') reasoningEnds.push(chunk.block.text)
    }
    // 可见文本回退只包含模型真实推理；排队期间零产出，故绝无"排队中"字样。
    expect(textEnds.some(text => text.includes('排队中'))).toBe(false)
    expect(textEnds).toEqual(['real-reasoning'])
    // reasoning 块只有模型真实推理，不持久化任何排队文本。
    expect(reasoningEnds.every(text => !text.includes('排队中'))).toBe(true)
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('enters the queue path for non-TM.00001041 errors when the queue endpoint reports waiting (openpangu)', async () => {
    // openpangu 等模型的并发限流错误码/HTTP 状态可能与 GLM 的
    // TM.00001041 不同（例如 HTTP 429 + 其他错误码），但只要排队状态
    // 端点确认会话在排队，适配器就必须进入排队逻辑而不是立即抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue <= 2 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001042', error_msg: '并发请求过多，请稍后重试。' }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const reasoning: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 探测一次（确认排队）+ 重试前查一次状态端点（终态检测），重试 chat 成功。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(2)
    // 排队期间零产出：不放行后正文之前没有任何块（无"排队中"字样）。
    expect(reasoning).toEqual([])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('surfaces the queue error message when the queue status is terminal', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(
          JSON.stringify({ status: 'error', queue_position: -1, message: 'peak hours, try later' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toThrow(/peak hours, try later/)
  })

  it('throws a normal HTTP error when the failure is not a queue error', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error_code: 'OTHER', error_msg: 'bad request' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  /**
   * 回归（行为级）：**空体 429** 在 CodeArts 的换号入口必须换号并写入限流标记。
   *
   * ## 真实缺陷
   *
   * 「账号池里明明还有可用账号，插件却直接报错、也不换号」—— 本可自愈的限流
   * 变成硬失败。
   *
   * 该入口原本有两道各自独立的判据，**必须同时带上 `response.status`**：
   *
   * ```ts
   * if (accountPool && isRateLimited(errorText, response.status)) {   // 外层
   *   const parsed = parseRateLimitError(errorText, options.model)     // 内层
   *   if (parsed) { ...写标记 + 换号 + continue... }
   * }
   * ```
   *
   * 只补外层、漏掉内层时，空体 429 的后果是：外层判真放行 → 内层因体为空
   * （`JSON.parse('')` 抛错，且没有状态码可兜底）返回 `null` → `if (parsed)`
   * 把**整块**（写标记 + 换号 + `continue`）一起跳过 → 最终按原错误抛出。
   * 与 buddy 侧最初那个缺陷同源，只是第三条调用点漏了。
   *
   * ## 本用例的响应体刻意是**空串**
   *
   * 换任何含限流措辞的正文（如 `TM.00001042` /「请稍后重试」），外层与内层
   * 都会命中，缺陷根本不会暴露 —— 那正是既有的 429 队列用例（:548）覆盖不到
   * 它的原因：那个用例的正文本身就能被判为排队/限流。
   *
   * ⚠️ 断言刻意落在**chat 请求逐个帐号的凭据**（`chatKeys`）而不是「fetch 总
   * 调用次数」：修复前的路径会去探测排队状态端点（`queryQueueStatus`），
   * 那也是一次 `fetch`，`mock.calls.length > 1` 在缺陷下同样成立 —— 写成
   * 「次数 > 1」就是一条永远为真的假断言。
   */
  it('空体 429 在 CodeArts 换号入口同样换号并写入限流标记（状态码必须传进 parseRateLimitError）', async () => {
    // 账号池替身：只实现 `CodeArtsAdapter.stream` 真正走到的三个方法。
    // - findAccountIdByCredential：把首个凭据 AK 归属到 acct-1（决定写标记的账号）；
    // - getAvailableAccount：返回**另一个**账号 acct-2 及其凭据 AK2；
    // - updateModelRateLimit：记录标记，供断言兜底时长。
    const marked: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const pool = {
      findAccountIdByCredential: async (provider: string, identity: string) =>
        (provider === 'codearts' && identity === 'AK' ? 'acct-1' : ''),
      getAvailableAccount: async () => ({
        entry: { id: 'acct-2' },
        credential: {
          access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
          expires_at: '2099-01-01T00:00:00Z',
        },
      }),
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marked.push({ accountId, modelId, resetAtMs })
      },
    }

    // 只统计 **chat/completions** 请求（按 Authorization 里的 Access=<AK> 区分账号）；
    // 排队状态端点的探测请求不参与，避免假断言（见用例注释）。
    const chatKeys: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const key = /Access=([^,\s]+)/.exec(headers.get('Authorization') ?? '')?.[1] ?? ''
      if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
      if (key === 'AK2') {
        // 换号后成功：SSE 形状照抄既有用例（'streams text deltas…'）。
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      // 首个账号返回**空体 429**：没有任何可识别文案，只剩状态码可判。
      return new Response('', { status: 429 })
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }

    // ① 换号后确实重试了（请求数多于一次）。
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
    // ② 第二/后续请求用的是**另一个账号**的凭据：['AK'] 表示只试了当前账号就放弃。
    expect(chatKeys).toEqual(['AK', 'AK2'])
    // ③ 失败账号被写入限流标记；空体无时刻可解析 → 必须是兜底时长（≈ 1 小时）。
    expect(marked.map(entry => entry.accountId)).toEqual(['acct-1'])
    expect(marked[0]!.modelId).toBe((streamOptions as { model: string }).model)
    const fallbackDelta = marked[0]!.resetAtMs - Date.now()
    expect(fallbackDelta).toBeGreaterThan(RATE_LIMIT_FALLBACK_MS - 60_000)
    expect(fallbackDelta).toBeLessThanOrEqual(RATE_LIMIT_FALLBACK_MS)
    // ④ 最终拿到内容，而不是把 429 抛给用户。
    expect(texts).toEqual(['ok'])
  })

  it('translates tool_calls deltas into tool-call blocks so the harness can run them', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const seen: string[] = []
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      seen.push(chunk.type)
      if (chunk.type === 'tool-call-delta') {
        expect(chunk.id).toBe('call-1')
        expect(chunk.name).toBe('bash')
        expect(chunk.argumentsDelta).toContain('ls')
      }
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'bash' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls' })
    expect(finishKind).toBe('tool-calls')
  })

  // 回归：tool_stream 分段传输时，参数续分片会带回 `"function":{"name":""}`。
  // 空串不是 undefined，原先的 `!== undefined` 判断会用它覆盖首个分片解析出
  // 的真实工具名，最终 block-end 输出 name:""，harness 报 `unknown tool ""`。
  it('ignores an empty function name on tool_calls argument continuation fragments', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":""}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"command\\":\\"ls -"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"la\\"}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'tool-call-delta') expect(chunk.name).toBe('bash')
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
    }
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'bash' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls -la' })
  })

  // 回归（严重，2026-09-29）：后端**完全不返回** tool_call id（或返回空串）时，
  // 早期实现把它落成 `id:''`。后果不是「这一轮失败」而是**整条会话报废**：
  //   1. `tool/call` 带 `callId:''` 落库；
  //   2. 写 `tool/result` 时 DSH 的格式 v4 校验（`assertV4ToolResultMessage`）
  //      要求 `message.toolCallId === source.callId` 且**都非空**（判 `length === 0`），
  //      于是抛
  //      `format v4 tool/result at seq N requires toolCallId matching its tool source`；
  //   3. 日志停在 `tool/call`，崩溃恢复 `interruptedTurnClosers` 按空 callId
  //      合成修补结果时**再次**命中同一校验 —— 既写不进也修不好。
  // 线上实证：唯一命中的 provider 就是 codearts（31 个会话里 codearts 的
  // 3 个 tool-call 块 100% 是空 id，其余 provider 共 1.4 万个全为 0）。
  // 兄弟适配器（openai-compat / buddy / lobsterai / trae）都有 `toolIds` 兜底，
  // 只有本文件漏了 —— 这就是该缺陷只在 codearts 复现的原因。
  it('synthesizes a stable non-empty call id when the backend omits tool_call id', async () => {
    // ⚠️ 三个分片**都没有** `id` 字段（真实形态），且是跨分片续传的同一调用。
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"pwsh","arguments":"{\\"command\\":"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"\\"ls\\"}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const deltaIds: unknown[] = []
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'tool-call-delta') deltaIds.push(chunk.id)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
    }
    // 核心判据：id 必须非空。空串会被格式 v4 校验直接拒绝。
    expect(toolCallBlock?.id).toBeTruthy()
    expect(typeof toolCallBlock?.id).toBe('string')
    expect(toolCallBlock!.id.length).toBeGreaterThan(0)
    // 同一次响应内必须**稳定**：所有分片同一个 id，且与 block-end 一致
    // （否则 tool/result 无法与 tool/call 配对）。
    expect(new Set(deltaIds).size).toBe(1)
    expect(deltaIds[0]).toBe(toolCallBlock!.id)
    // 工具名与参数不受影响。
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', name: 'pwsh' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls' })
  })

  // 反向用例：id 只出现在**首个**分片、且后续分片带空串 id 时，
  // 不能被空串覆盖（与 `function.name` 同因）。空串会通过 `!== undefined`
  // 判断，故 `if (call.id !== undefined)` 那种写法会在这里失败。
  it('keeps the real call id when a later fragment carries an empty id', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-real","function":{"name":"pwsh","arguments":"{}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"","arguments":""}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const deltaIds: unknown[] = []
    let toolCallBlock: { id: string } | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'tool-call-delta') deltaIds.push(chunk.id)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
    }
    // 真实 id 必须被保留，不能被后续空串抹掉。
    expect(toolCallBlock?.id).toBe('call-real')
    expect(deltaIds.every(id => id === 'call-real')).toBe(true)
  })

  it('serializes harness tool schemas into the request tools field', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
        tool_stream?: boolean
      }
      expect(sent.model).toBe('GLM-5.2')
      // 对齐 CodeArts Agent IDE：tool_stream=true 让后端对超大工具
      // 调用参数（如大文件 file_write）分段流式传输，避免单次 SSE 事件
      // 过大导致连接被掐断（error decoding response body）。
      expect(sent.tool_stream).toBe(true)
      expect(sent.tools).toEqual([{
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      }])
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [],
      tools: [{
        name: 'bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('hides vision-only (VL) models from listModels so they cannot be used as the agent model', async () => {
    // VL 多模态模型（如 Qwen3-VL-235B）上下文小、不支持工具调用，不适合当
    // agent 主模型，从模型列表屏蔽。它们只通过 analyzeImage 工具间接调用。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
        { id: 'Qwen3.6-27B-VL', name: 'Qwen3.6-27B-VL' },
        { id: 'Qwen3.5-397B-A17B-VL', name: 'Qwen3.5-397B-A17B-VL' },
      ],
    })
    const models = await adapter.listModels('codearts')
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('Qwen3.6-27B-VL')
    expect(ids).not.toContain('Qwen3.5-397B-A17B-VL')
    // 普通模型不受影响。
    expect(ids).toContain('GLM-5.2')
  })

  /**
   * 模型黑名单：Jet Hub 的「显示列表」开关关闭某模型后，它必须从
   * listModels 的播报里消失 —— 对话框模型选择器读的正是这份数据。
   */
  it('hides models the user disabled from listModels', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
        { id: 'openpangu-2.0-pro', name: 'openpangu-2.0-pro' },
      ],
      accountPool: poolWithDisabled('codearts', ['GLM-5.2']),
    })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).not.toContain('GLM-5.2')
    // 未关闭的模型保持原样与原有顺序
    expect(ids).toEqual(['deepseek-v4-flash', 'openpangu-2.0-pro'])
  })

  it('an empty disabled set leaves listModels untouched', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('codearts', []) })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('deepseek-v4-flash')
  })

  it('blacklist is keyed by provider: another route\'s entries do not leak in', async () => {
    // 池里只有 buddy 的黑名单，codearts 路由不该被它影响
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', ['GLM-5.2']) })
    expect((await adapter.listModels('codearts')).map((m) => m.id)).toContain('GLM-5.2')
  })

  it('a disabled model still resolves and remains requestable (catalog is advisory)', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('codearts', ['GLM-5.2']) })
    expect((await adapter.listModels('codearts')).map((m) => m.id)).not.toContain('GLM-5.2')
    // DSH 契约：listModels 的结果仅供参考，缺省不构成请求拒绝。
    const resolved = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(resolved.id).toBe('GLM-5.2')
    expect(resolved.context?.contextWindow).toBe(202752)
  })

  // ── 目录门控：没有已登录账号就不显示该 provider 的模型 ──
  //
  // ⚠️ **CodeArts 不再有「单凭据模式」例外**：登录入口只有 Jet Hub 设置页，
  // 凭据一律写账号池条目（`CODEARTS_ACCOUNT_XXX`）。固定的
  // `CODEARTS_ACCESS_TOKEN` 不会再被写入或读取，判据与其余五个 provider 一致。
  describe('无已登录账号时隐藏整个 provider 目录', () => {
    it('没有已登录账号 → 返回空数组', async () => {
      const adapter = makeAdapter({ accountPool: poolWithCredentials([]) })
      expect(await adapter.listModels('codearts')).toEqual([])
    })

    it('⚠️ 单凭据 ref 有值但账号池为空 → 仍隐藏（单凭据模式已移除）', async () => {
      // 这是本次变更的核心断言：老用户若只用固定 ref 登录过，模型会消失、
      // 需要在 Jet Hub 重新登录一次（用户已确认接受该行为）。
      const adapter = makeAdapter({ accountPool: poolWithCredentials([]) })
      expect(await adapter.listModels('codearts')).toEqual([])
    })

    it('账号池里有已登录账号 → 正常返回目录', async () => {
      const adapter = makeAdapter({ accountPool: poolWithCredentials(['CODEARTS_ACCOUNT_1']) })
      expect((await adapter.listModels('codearts')).map((m) => m.id)).toContain('GLM-5.2')
    })

    it('未提供 accountPool 时保守放行（headless / CLI 场景）', async () => {
      expect((await makeAdapter().listModels('codearts')).length).toBeGreaterThan(0)
    })
  })

  it('switches deepseek-v4 to DSML tool mode: no tools field, schema injected into system', async () => {
    // deepseek-v4 大文件写入修复（实测 2026-08-22）：标准 tool_calls 参数
    // 一次性打包生成，SSE 静默 >60s 被 APIG 网关掐断且后端不发心跳；
    // 当工具列表含大参数写文件类工具（write）时改为不发送 tools 字段、
    // 把 function schema 注入 system 提示，让模型以原生 DSML 流式输出
    // 工具调用（delta.content 走流式通道，全程有数据）。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: unknown[]
        messages?: Array<Record<string, unknown>>
      }
      expect(sent.model).toBe('deepseek-v4-flash')
      // deepseek-v4 的 DSML 工具模式下不得发送 tools 字段（发送会触发
      // 标准 tool_calls 一次性打包路径）。
      expect(sent.tools).toBeUndefined()
      const wire = sent.messages ?? []
      const system = wire.find(message => message.role === 'system') as Record<string, unknown> | undefined
      // DSML 指令 + 工具 schema 注入 system 消息。
      expect(system?.content).toContain('DSML')
      expect(system?.content).toContain('工具名')
      expect(String(system?.content)).toContain('write')
      expect(String(system?.content)).toContain('Write content to a file')
      // harness 原始 user 消息保留在 system 之后。
      expect(wire.some(message => message.role === 'user')).toBe(true)
      // 模型以 DSML 格式输出工具调用，适配器解析为结构化 tool-call。
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="write">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="content" string="true">export const x = 1;</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{
        name: 'write',
        description: 'Write content to a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['filePath', 'content'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('write')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts', content: 'export const x = 1;' })
    expect(finishKind).toBe('tool-calls')
  })

  it('mints a unique callId for DSML tool calls so harness pairing and web UI work', async () => {
    // DSML 语法没有 provider 签发的 call id。空 id 会让同一响应的多个
    // 工具调用（tool/call ↔ tool/result 配对、web UI 工具行 key）冲突，
    // UI 只能回退为泛化的 "Tool call" 而丢失 read/write 专属控件。
    // 适配器必须为每个 DSML 调用生成非空且互不相同的 callId。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls>'
        + '<｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke>'
        + '<｜DSML｜invoke name="write"><｜DSML｜parameter name="filePath" string="true">/tmp/b.ts</｜DSML｜parameter><｜DSML｜parameter name="content" string="true">x</｜DSML｜parameter></｜DSML｜invoke>'
        + '</｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const deltas: Array<{ id: string; name?: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'do both' }],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
        { name: 'write', description: 'Write', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'tool-call-delta') {
        deltas.push({ id: String(chunk.id), ...chunk.name !== undefined ? { name: chunk.name } : {} })
      }
    }
    expect(deltas).toHaveLength(2)
    // 两个 DSML 调用的 callId 非空且互不相同。
    expect(deltas[0].id).not.toBe('')
    expect(deltas[1].id).not.toBe('')
    expect(deltas[0].id).not.toBe(deltas[1].id)
    expect(deltas.map(d => d.name)).toEqual(['read', 'write'])
  })

  it('parses DSML tool calls embedded in reasoning_content (deepseek-v4 quirk)', async () => {
    // 实测 2026-08-22：deepseek-v4-flash 有时把完整回答（含 DSML 块）输出在
    // reasoning_content 而 content 为空。旧实现把 reasoning_content 直接追加
    // 到 reasoning 块、从不走 DSML 提取器，导致 DSML 块被当推理文本吞掉
    // （任务 completed 但工具未执行，text 与 reasoning 内容重复）。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="write">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="content" string="true">export const x = 1;</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      // 模型把正文+DSML 全放在 reasoning_content。
      const reasoning = '用户要求写入文件，我需要调用 write 工具。\n' + dsml
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const textDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{
        name: 'write',
        description: 'Write content to a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['filePath', 'content'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('write')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts', content: 'export const x = 1;' })
    expect(finishKind).toBe('tool-calls')
    // reasoning_content 中的 DSML 已解析为工具调用，不再泄漏到正文。
    expect(textDeltas.join('')).not.toContain('DSML')
    expect(textDeltas.join('')).not.toContain('<｜DSML｜')
  })

  it('routes reasoning_content thinking into the reasoning block, never the text body', async () => {
    // 实测 2026-08-22：deepseek-v4-flash 的 reasoning_content 通常没有
    // <thought> 标签（如 "The user wants me to:..."）。旧实现把提取器返回
    // 的 `text`（开标签前思考）发给正文块，导致思考泄漏到 TUI 正文
    // （The user wants me to... 跑到正文、没有 Think）。修复后
    // reasoning_content 的 text+reasoning 必须全部进入 reasoning 块。
    const fetchImpl = vi.fn(async () => {
      // 模型把思考（无 <thought> 标签）+ DSML 工具调用全放 reasoning_content。
      const reasoning = 'The user wants me to read the file and write it.\nLet me do that step by step.'
        + '<｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read and write a file' }],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
        { name: 'write', description: 'Write', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name })
      }
    }
    // 思考进入 Think 区域。
    const reasoningText = reasoningDeltas.join('')
    expect(reasoningText).toContain('The user wants me to read the file')
    expect(reasoningText).toContain('Let me do that step by step.')
    // 正文不泄漏思考。
    expect(textDeltas.join('')).not.toContain('The user wants me')
    // DSML 工具调用正常解析。
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
  })

  it('parses DSML in reasoning_content even when content channel has an unclosed <thought> (independent extractors)', async () => {
    // 回归 session-067dcf78 turn1 step13 / turn2 step3：deepseek-v4 在
    // content 通道输出 <thought> 开标签（提取器进入 in-thought 状态）后，
    // 把推理与完整 DSML 工具调用写到 reasoning_content 通道。旧实现共用
    // 单个 DSML 提取器，content 的 <thought> 污染提取器状态为 in-thought，
    // reasoning_content 的 DSML 块被当作 thought 内容吞掉、不解析为
    // tool-call，残留 DSML 标签经 visible 回退泄漏到正文 text 块
    // （reasoning 与 text 内容完全相同、均含 <｜DSML｜...>，任务中断）。
    // 修复后 content 与 reasoning_content 使用独立提取器，互不污染。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls>'
        + '<｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke>'
        + '</｜DSML｜tool_calls>'
      // content 通道：<thought> 开标签 + 思考片段，无闭标签（提取器进入 in-thought）。
      const content = '<thought>用户要求读取文件，我需要调用 read 工具。'
      // reasoning_content 通道：推理 + 完整 DSML 块。
      const reasoning = '让我先读取文件内容。\n' + dsml
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(content)},"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const textDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // reasoning_content 的 DSML 块被独立提取器解析为 tool-call。
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts' })
    expect(finishKind).toBe('tool-calls')
    // DSML 标签不泄漏到正文。
    expect(textDeltas.join('')).not.toContain('DSML')
    expect(textDeltas.join('')).not.toContain('<｜DSML｜')
  })

  it('does not leak DSML tags from reasoning to text via visible fallback (reasoning references DSML syntax)', async () => {
    // 回归 session-a69fa289 turn2 step26：deepseek-v4 在推理中引用 DSML 语法
    // （仅含闭合标签片段，非完整工具调用块），提取器正确不解析（无开标签），
    // 整段作为 reasoning。但 visible 回退把含 DSML 标签的推理复制到正文，
    // 导致 DSML 标签泄漏到正文、任务终止。修复后 visible 回退检查推理是否
    // 含 DSML 标签，含则不复制为正文（推理仍在 Think 区域可见）。
    const fetchImpl = vi.fn(async () => {
      const reasoning = 'Let me read protocol/mod.rs to see the current SseTimeoutConfig.\n'
        + '</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'continue' }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // 推理在 Think 区域可见。
    expect(reasoningDeltas.join('')).toContain('SseTimeoutConfig')
    // DSML 标签不泄漏到正文（visible 回退不复制含 DSML 标签的推理）。
    expect(textDeltas.join('')).toBe('')
    expect(finishKind).toBe('stop')
  })

  it('coerces numeric-looking DSML string params (offset="1304") to number', async () => {
    // 实测 2026-08-22：deepseek-v4 对 read 的 offset 误标 string="true"，
    // 输出 offset="1304"。旧实现保持字符串，工具 schema 校验报
    // `"offset" must be a number`。修复后数字字面量字符串按原始类型解析。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset" string="true">1304</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit" string="true">2000</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.filePath).toBe('/tmp/big.ts')
    // 数字字符串参数被转换为 number。
    expect(args.offset).toBe(1304)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(2000)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces quoted numeric DSML string params (offset string="true" value "840", pro quirk) to number', async () => {
    // 实测 deepseek-v4-pro：pro 模型常把数字参数值用 JSON 字符串引号包裹
    // 输出（如 "840"），即便标记了 string="true"。旧实现 tryParseScalar
    // 不处理带引号的字面量——"840"（含引号字符）不匹配数字正则、保持
    // 字符串，schema 校验报 "offset" must be a number。flash 输出纯数字
    // 不带引号故不受影响，这是 pro 出错多、flash 不出错的根因。修复后
    // tryParseScalar 先 JSON.parse 解码外层引号再递归标量转换。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset" string="true">"840"</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit" string="true">"40"</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.filePath).toBe('/tmp/big.ts')
    expect(args.offset).toBe(840)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(40)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces quoted numeric DSML params without string attr (pro quirk) to number', async () => {
    // deepseek-v4-pro 另一种形态：数字参数不加 string="true"，但值仍用
    // JSON 字符串引号包裹（"840"）。走非 string 路径 JSON.parse('"840"')
    // 得到字符串 "840"，旧实现直接使用导致 schema 校验失败。修复后非
    // string 路径对 JSON.parse 得到的字符串结果再走 tryParseScalar 还原。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset">"840"</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit">"40"</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.offset).toBe(840)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(40)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces array-looking DSML string params (todos string="true") to array', async () => {
    // 实测 session-59e52486 turn1 step3：deepseek-v4 对 todo_write 的 todos
    // 数组参数误标 string="true"，把 JSON 编码的数组当作字符串输出。旧实现
    // tryParseScalar 只解析 number/boolean/null 标量，不解析 JSON 数组，
    // todos 保持字符串，工具 schema 校验报 `"todos" must be an array`。
    // 修复后 tryParseScalar 对 [ / { 开头的合法 JSON 还原为原始类型。
    const todosJson = JSON.stringify([
      { content: '了解项目结构', status: 'in_progress' },
    ])
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="todo_write">'
      + `<｜DSML｜parameter name="todos" string="true">${todosJson}</｜DSML｜parameter>`
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'plan the work' }],
      tools: [{
        name: 'todo_write',
        description: 'Write a todo list',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
              },
            },
          },
          required: ['todos'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { todos: unknown }
    // todos 被还原为数组，而非保持字符串。
    expect(Array.isArray(args.todos)).toBe(true)
    expect(args.todos).toEqual([
      { content: '了解项目结构', status: 'in_progress' },
    ])
  })

  it('forwards GenerateOptions.system as a system message (session title fix)', async () => {
    // 标题生成等辅助请求通过 GenerateOptions.system 传入系统提示。旧实现
    // 丢弃了 options.system，模型只看到 user prompt 本身，于是把
    // "Generate the session title from this JSON array..." 回显成标题
    // （实测 2026-08-22：session 标题显示为 prompt 文本）。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>
      }
      const systems = (sent.messages ?? []).filter(m => m.role === 'system')
      expect(systems).toHaveLength(1)
      expect(systems[0].content).toContain('Create a concise title')
      return new Response(
        'data: {"choices":[{"delta":{"content":"Fix DSML parsing"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[...]' }],
      system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line.',
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts.join('')).toBe('Fix DSML parsing')
  })

  it('switches deepseek-v4 to DSML tool mode even with small-parameter-only tools (read/bash)', async () => {
    // deepseek-v4 模型始终走 DSML 模式（不论工具列表）：标准 tool_calls 模式下
    // `subagent` 工具的长 prompt 参数生成期间 SSE 无数据，APIG 网关 ~60s 空闲超时
    // 必然掐断连接。DSML 模式让工具调用通过 delta.content 流式输出，全程有数据流。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: unknown[]
        messages?: Array<Record<string, unknown>>
      }
      expect(sent.model).toBe('deepseek-v4-flash')
      // DSML 模式：不发送 tools 字段（对齐 IDE 请求体），schema 注入 system 消息。
      expect(sent.tools).toBeUndefined()
      const wire = sent.messages ?? []
      expect(wire.some(message => message.role === 'system' && typeof message.content === 'string'
        && message.content.includes('<｜DSML｜tool_calls>'))).toBe(true)
      // 模型以 DSML 格式输出，适配器从 delta.content 解析。
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [{
        name: 'read',
        description: 'Read a file at the given path.',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string', description: 'Absolute file path' } },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts' })
  })

  it('replays assistant tool_calls and tool results back to the model', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      // 助手消息携带其 tool_calls；随后用户消息的
      // tool-result 块展开为 role:'tool' 传输消息。
      const assistant = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(assistant?.tool_calls).toEqual([{
        id: 'call-9',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }])
      const tool = wire.find(message => message.role === 'tool') as Record<string, unknown> | undefined
      expect(tool?.tool_call_id).toBe('call-9')
      expect(tool?.content).toContain('src/')
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'src/ lib/' }] },
        ] },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  // 回归（严重）：工具执行失败时 assistant 的 tool_calls 留在会话历史里，
  // 但结果消息从未写回——形成孤儿 tool_calls。坏历史随每次请求重放，后端
  // 对之后**每一条**用户消息都返回 400，表现为"任务中断后发送任何内容都
  // 没有回复"。适配器必须在发出请求前剔除。
  it('drops orphan tool_calls that never received a tool result', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      const assistant = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(assistant?.tool_calls).toBeUndefined()
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
        // 工具执行失败，没有对应的 tool-result 写回历史。
        { role: 'user', content: 'continue' },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('drops orphan tool result messages with no matching tool_call', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      expect(wire.some(message => message.role === 'tool')).toBe(false)
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] },
        ] },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('replays assistant reasoning blocks as reasoning_content for the model', async () => {
    // deepseek-v4 等推理模型后端校验：回传历史时 assistant 消息必须携带
    // reasoning_content 字段，缺失会 400 "Missing `reasoning_content` field"。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      const first = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(first?.content).toBe('visible-answer')
      expect(first?.reasoning_content).toBe('hidden-thought')
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'summarize' },
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'hidden-thought' },
          { type: 'text', text: 'visible-answer' },
        ] },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('classifies an SSE transport "terminated" error as retryable TRANSPORT, not UNKNOWN', async () => {
    // CodeArts 网关在 SSE 空闲 ~60s 后掐断连接，Node undici reader.read() 抛
    // TypeError: terminated。该错误非 HarnessError，会被归为 UNKNOWN（不可重试）
    // 导致 harness 直接失败。适配器须把它映射为可重试的 TRANSPORT。
    let pullCalls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 第一次 pull：发送一个 chunk；第二次 pull（数据已被消费后）让流
        // error 模拟对端掐断。用计数器确保先消费再 error。
        pullCalls++
        if (pullCalls === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        } else {
          controller.error(new TypeError('terminated'))
        }
      },
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const adapter = makeAdapter({ fetchImpl })
    const chunks: string[] = []
    let caught: LlmError | undefined
    try {
      for await (const chunk of adapter.stream(streamOptions)) {
        if (chunk.type === 'text-delta') chunks.push(chunk.text)
      }
    } catch (error) {
      if (error instanceof LlmError) caught = error
    }
    expect(chunks).toEqual(['hi'])
    expect(caught?.code).toBe('TRANSPORT')
  })

  it('reports a retryable TIMEOUT when the SSE stream goes idle beyond the chunk threshold', async () => {
    // 模型生成长推理时两次 chunk 间静默超过 chunk 超时窗口：适配器应主动以
    // 可重试 TIMEOUT 失败（而非被动等网关掐断后变成 UNKNOWN）。
    // 用短超时环境变量避免真实等待 600s。
    const prev = process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS
    process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS = '200'
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
          // 永不发送更多数据——触发空闲超时
        },
      })
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      const adapter = makeAdapter({ fetchImpl })
      const chunks: string[] = []
      let caught: LlmError | undefined
      try {
        for await (const chunk of adapter.stream(streamOptions)) {
          if (chunk.type === 'text-delta') chunks.push(chunk.text)
        }
      } catch (error) {
        if (error instanceof LlmError) caught = error
      }
      expect(chunks).toEqual(['hi'])
      expect(caught?.code).toBe('TIMEOUT')
      expect(caught?.message).toContain('chunk timeout')
    } finally {
      if (prev === undefined) delete process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS
      else process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS = prev
    }
  }, 10_000)

  it('reports a retryable TIMEOUT when no first token arrives in time', async () => {
    // 首 token 超时：连接建立后模型长时间不输出任何数据（如排队中、
    // 模型冷启动）。适配器应以可重试 TIMEOUT 失败，phase=first-token。
    const prev = process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS
    process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS = '200'
    try {
      const body = new ReadableStream<Uint8Array>({
        start() {
          // 永不 enqueue 任何数据——触发首 token 超时
        },
      })
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      const adapter = makeAdapter({ fetchImpl })
      let caught: LlmError | undefined
      try {
        for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
      } catch (error) {
        if (error instanceof LlmError) caught = error
      }
      expect(caught?.code).toBe('TIMEOUT')
      expect(caught?.message).toContain('first-token timeout')
    } finally {
      if (prev === undefined) delete process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS
      else process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS = prev
    }
  }, 10_000)

  it('extracts DSML tool_calls embedded in delta.content into structured tool-call blocks', async () => {
    // 某些模型（如 deepseek-v4）在工具模式不匹配时会把工具调用以原生
    // DSML XML 风格直接写入 delta.content，适配器须识别并解析为结构化
    // tool-call，避免原始 <｜DSML｜...> token 泄漏到 web UI。
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '<｜DSML｜parameter name="description" string="true">list files</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // DSML 内容不应作为文本泄漏
    expect(textDeltas.join('')).toBe('')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls', description: 'list files' })
    expect(finishKind).toBe('tool-calls')
  })

  it('extracts DSML tool_calls streamed across multiple chunks', async () => {
    // DSML 块可能跨多个 SSE chunk 分片到达，提取器须缓冲未完成部分
    // 直到闭标签到达才解析，期间不产出任何文本。
    const parts = [
      '<｜DSML｜tool_calls><｜DSML｜invoke name="pwsh">',
      '<｜DSML｜parameter name="command" string="true">ls "D:\\jet"',
      '</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    ]
    const sse = parts.map(p => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('')
      + 'data: [DONE]\n\n'
    const fetchImpl = vi.fn(async () => new Response(
      sse,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(textDeltas.join('')).toBe('')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('pwsh')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls "D:\\jet"' })
  })

  it('passes through plain text alongside DSML tool_calls', async () => {
    // 模型可能在同一段输出中先写普通文本再写 DSML 工具调用，
    // 提取器须放行文本部分并解析 DSML 部分。
    const text = '查看providers目录\n'
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(text + dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(textDeltas.join('')).toBe(text)
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
  })

  it('flushes incomplete DSML as text when the stream ends without a closing tag', async () => {
    // 若模型输出被 max_tokens 截断，DSML 块可能不完整（无闭标签）。
    // 提取器 flush() 须把残留作为纯文本放行，避免吞掉内容；同时
    // finish_reason='length' 路径触发 harness max-tokens 续写。
    const incomplete = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(incomplete)}},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // 不完整 DSML 作为文本放行（用户可见），finish 报 max-tokens 触发续写
    expect(textDeltas.join('')).toBe(incomplete)
    expect(finishKind).toBe('max-tokens')
  })

  it('extracts <thought> blocks as reasoning instead of leaking to visible text', async () => {
    // DeepSeek-V4 Thinking 模式：模型把推理过程包裹在 <thought>...</thought>
    // 中写入 delta.content。适配器须把 <thought> 内容作为 reasoning-delta
    // 输出（显示在 Think 区域），而非作为 text-delta 泄漏到正文。
    const thought = '<thought>我需要先查看目录结构，再决定如何操作。</thought>'
    const visible = '查看完成，开始操作。'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(thought + visible)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    // <thought> 内容作为 reasoning 输出，不泄漏到正文
    expect(textDeltas.join('')).toBe(visible)
    expect(reasoningDeltas.join('')).toBe('我需要先查看目录结构，再决定如何操作。')
  })

  it('streams <thought> reasoning incrementally across multiple chunks', async () => {
    // <thought> 块跨多个 SSE chunk 分片到达，提取器须流式输出 reasoning
    // 增量（与 delta.reasoning_content 行为一致），不等到块结束才输出。
    const parts = [
      '<thought>第一步：分析需求',
      '。第二步：制定计划。',
      '</thought>开始执行。',
    ]
    const sse = parts.map(p => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('')
      + 'data: [DONE]\n\n'
    const fetchImpl = vi.fn(async () => new Response(
      sse,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    expect(textDeltas.join('')).toBe('开始执行。')
    expect(reasoningDeltas.join('')).toBe('第一步：分析需求。第二步：制定计划。')
  })

  it('handles <thought> followed by DSML tool_calls in the same content stream', async () => {
    // Thinking 模式 + 工具调用：模型先输出 <thought> 推理，再输出
    // DSML tool_calls。适配器须分别路由到 reasoning 和 tool-call 块。
    const thought = '<thought>需要列出目录内容。</thought>'
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(thought + dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(textDeltas.join('')).toBe('')
    expect(reasoningDeltas.join('')).toBe('需要列出目录内容。')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls' })
    expect(finishKind).toBe('tool-calls')
  })

  it('flushes incomplete <thought> as reasoning when the stream ends without closing tag', async () => {
    // 不完整的 <thought> 块（被 max_tokens 截断）：flush() 须把残留
    // 作为 reasoning 放行，避免推理泄漏到正文。
    const incompleteThought = '<thought>我正在思考'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(incompleteThought)}},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    // 不完整 thought 作为 reasoning 放行，不泄漏到正文
    expect(textDeltas.join('')).toBe('')
    expect(reasoningDeltas.join('')).toBe('我正在思考')
  })

  /**
   * 额度用尽（`InferHub.4291.200`）必须与「排队/限流」**彻底分开**。
   *
   * ## 真实缺陷（用户报障 2026-10-02）
   *
   * 用户报「插件 dsh-codearts-auth 里的 CodeArts Agent 没反应了」—— 实际是
   * 该账号唯一启用的模型 `deepseek-v4.1-flash`（benefit / 免费额度通道）额度
   * 用尽，后端以 **HTTP 200 + SSE** 下发：
   * ```
   * data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota",…}
   * ```
   * 而 `isSseQueueErrorCode` 的判据 `/…|429|…/` 是**无边界子串**匹配，
   * `4291` 命中了 `429` 前缀 → 被当成「可重试的排队」→ 进入每 10 秒重试、
   * 上限 180 次（30 分钟）的循环。
   *
   * ⚠️ 后果是**界面完全无输出**（不是报错）：排队期间适配器刻意不产出任何
   * 内容块，而它误以为自己在排队。实测真实适配器 25 秒内发 4 次 chat 请求 +
   * 3 次排队探测、**产出 0 个 chunk**，最终由用户手动中止 —— 会话记录里是
   * `turn/end aborted` + `stream: []`，**没有任何 error 事件**。
   */
  describe('额度用尽（InferHub.4291.200）与排队分流', () => {
    it('把 InferHub.4291.200 判为额度用尽，而 81111.429 仍判为可重试排队', () => {
      // ① 额度码：命中额度判据、**不再**被裸 `429` 子串吃掉。
      expect(isSseQuotaExhaustedErrorCode('InferHub.4291.200', 'insufficient quota')).toBe(true)
      // ② 排队码：仍走排队（回归保护 —— 修 429 边界不能把真排队一起修坏）。
      expect(isSseQuotaExhaustedErrorCode('InferHub.ModelArts.81111.429', 'TPM limit')).toBe(false)
      // ③ 文案兜底：码值换了也能认出来。
      expect(isSseQuotaExhaustedErrorCode('InferHub.9999.200', 'insufficient quota')).toBe(true)
      // ④ 尾号变体：服务端若改尾号，`4291` 子串仍命中。
      expect(isSseQuotaExhaustedErrorCode('InferHub.4291.999', 'whatever')).toBe(true)
    })

    it('429 的边界判据：4291 不再命中，而 81111.429 / 「429 Too Many Requests」仍命中', () => {
      // ⚠️ 本用例直接测**生产函数**，不复制正则字面量 —— 复制的话就是同义反复，
      // 把边界改回裸子串也不会变红（第一版真的这么错过，反向验证时发现了）。
      //
      // 额度码：修复前这里返回 `true`（被裸 `429` 子串吃掉），是缺陷的直接根因。
      expect(isSseQueueErrorCode('InferHub.4291.200')).toBe(false)
      // 真排队码不受影响（修边界不能把排队一起修坏）：
      expect(isSseQueueErrorCode('InferHub.ModelArts.81111.429')).toBe(true)
      expect(isSseQueueErrorCode('TM.00001041')).toBe(true)
      expect(isSseQueueErrorCode('HTTP 429 Too Many Requests')).toBe(true)
      // 429 出现在中间也要认（前后都是非数字）。
      expect(isSseQueueErrorCode('err 429 rate limited')).toBe(true)
      // 但含 429 的更长数字串不认。
      expect(isSseQueueErrorCode('InferHub.14290')).toBe(false)
    })

    it('额度用尽时立即失败（不静默重试），并在报错里给出解禁时间', async () => {
      // 账号池替身：只有一个账号，且它就是失败的那个 → 无号可换，应如实抛出。
      const marked: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
      const pool = {
        findAccountIdByCredential: async () => 'acct-1',
        getAvailableAccount: async () => null,
        updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
          marked.push({ accountId, modelId, resetAtMs })
        },
      }
      let chatCalls = 0
      const fetchImpl = vi.fn(async () => {
        chatCalls += 1
        return new Response(
          'data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      })

      const adapter = makeAdapter({ fetchImpl, accountPool: pool })
      const chunks: unknown[] = []
      let thrown: unknown
      try {
        for await (const chunk of adapter.stream(streamOptions)) chunks.push(chunk)
      } catch (error) {
        thrown = error
      }

      // ① 立刻失败，且归为**不可重试**的 QUOTA（不在 harness 的可重试集合里）。
      expect(thrown).toBeInstanceOf(LlmError)
      expect((thrown as LlmError).code).toBe('QUOTA')
      // ② 报错必须**带解禁时间**（用户明确要求：「其它渠道限额到了会提示多少时间
      //    后会解除限额，这个 codearts 的也加上吧」）。
      expect((thrown as LlmError).message).toMatch(/预计 .*后重置/)
      expect((thrown as LlmError).message).toMatch(/UTC\+8 自然日结算/)
      // ③ **不能**静默重试：修复前这里会是 4+ 次（每 10 秒一轮）。
      //    修复后只发 1 次就抛出。
      expect(chatCalls).toBe(1)
      // ④ 零内容块（不把额度错误伪装成"正在思考"）。
      expect(chunks).toEqual([])
      // ⑤ 失败账号 + 该模型被写入标记，且时限是 UTC+8 当日 24:00。
      expect(marked.map(entry => entry.accountId)).toEqual(['acct-1'])
      expect(marked[0]!.modelId).toBe((streamOptions as { model: string }).model)
      const delta = marked[0]!.resetAtMs - Date.now()
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBeLessThanOrEqual(86_400_000)
    })

    it('额度用尽时切换到池中下一个账号重试', async () => {
      const marked: Array<{ accountId: string; modelId: string }> = []
      const pool = {
        findAccountIdByCredential: async () => 'acct-1',
        getAvailableAccount: async () => ({
          entry: { id: 'acct-2' },
          credential: {
            access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
            expires_at: '2099-01-01T00:00:00Z',
          },
        }),
        updateModelRateLimit: async (accountId: string, modelId: string) => {
          marked.push({ accountId, modelId })
        },
      }
      const chatKeys: string[] = []
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = /Access=([^,\s]+)/.exec(new Headers(init?.headers).get('Authorization') ?? '')?.[1] ?? ''
        if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
        if (key === 'AK2') {
          return new Response(
            'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(
          'data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      })

      const adapter = makeAdapter({ fetchImpl, accountPool: pool })
      const texts: string[] = []
      for await (const chunk of adapter.stream(streamOptions)) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
      }

      // 换到第二个账号后成功拿到内容。
      expect(chatKeys).toEqual(['AK', 'AK2'])
      expect(texts).toEqual(['recovered'])
      // 失败的那个账号被标记（不是被换上的那个）。
      expect(marked.map(entry => entry.accountId)).toEqual(['acct-1'])
    })

    it('额度用尽也可能走 HTTP 4xx：同样立即失败并带解禁时间', async () => {
      // 两条通道都接（`AGENTS.md` 的既有铁律）：实测该码走 SSE（HTTP 200），
      // 但服务端同样可能以 4xx 下发。若不接这条，哪天改了形态就会退回
      // 「重试可自愈」的错误分类。
      let chatCalls = 0
      const fetchImpl = vi.fn(async () => {
        chatCalls += 1
        // 4xx 形态：报文字段名与 SSE 不同，靠文案兜底命中。
        return new Response(
          JSON.stringify({ error_code: 'InferHub.4291.200', error_msg: 'insufficient quota' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      })
      const adapter = makeAdapter({ fetchImpl })
      let thrown: unknown
      try {
        for await (const _ of adapter.stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(LlmError)
      expect((thrown as LlmError).code).toBe('QUOTA')
      expect((thrown as LlmError).message).toMatch(/预计 .*后重置/)
      // 立即失败，**不**落入排队重试（修复前会被当限流/排队）。
      expect(chatCalls).toBe(1)
    })

    it('标记时限按 UTC+8 当日 24:00 取，而不是 parseRateLimitError 的「1 小时后」', () => {
      // ⚠️ 不能复用 `parseRateLimitError`：它解析不到时间时退回
      // `Date.now() + RATE_LIMIT_FALLBACK_MS`（1 小时），对**按自然日**结算的
      // 免费额度会让标记过早失效 —— 用户 1 小时后再撞一次同样的墙。
      // （与 qoder / zcode 的额度处理同一口径。）
      const now = Date.UTC(2026, 9, 2, 12, 0, 0) // 2026-10-02T12:00Z = 20:00 UTC+8
      const reset = nextUtc8DayStartMs(now)
      // 距 UTC+8 次日 00:00 还有 4 小时。
      expect(reset - now).toBe(4 * 3_600_000)
      // 明显长于 1 小时兜底（正是不能复用的原因）。
      expect(reset - now).toBeGreaterThan(RATE_LIMIT_FALLBACK_MS)
    })

    it('解禁时间文案按时长量级给出可读单位', () => {
      const now = Date.UTC(2026, 9, 2, 12, 0, 0)
      expect(formatResetIn(now + 30_000, now)).toBe('不到 1 分钟')
      expect(formatResetIn(now + 20 * 60_000, now)).toBe('20 分钟')
      expect(formatResetIn(now + 4 * 3_600_000, now)).toBe('4 小时')
      expect(formatResetIn(now + 90 * 60_000, now)).toBe('1.5 小时')
      expect(formatResetIn(now - 1, now)).toBe('即将重置')
    })

    it('完整文案含模型名、预计时长与 UTC 时刻', () => {
      const now = Date.UTC(2026, 9, 2, 12, 0, 0)
      const msg = codeartsQuotaExhaustedMessage('deepseek-v4.1-flash', nextUtc8DayStartMs(now), now)
      expect(msg).toContain('deepseek-v4.1-flash')
      expect(msg).toContain('免费额度')
      expect(msg).toContain('4 小时后重置')
      expect(msg).toContain('2026-10-02T16:00:00.000Z') // UTC+8 次日 00:00
      expect(msg).toContain('Jet Hub')
    })
  })
})
