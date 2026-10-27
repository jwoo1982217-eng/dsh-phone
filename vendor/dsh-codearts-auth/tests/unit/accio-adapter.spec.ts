/**
 * Accio LLM 适配器单元测试。
 *
 * 覆盖 `src/accio-adapter.ts` 的模型目录与流式转换：
 * - `displayNameOfAccioModel` 的倍率后缀（倍率必须进 `name`）；
 * - `listModels` 的远端/兜底切换与「倍率进 name」；
 * - `resolveModel` 的 `contextWindow` 与 **`inputModalities` 三态**（省略 = 未知）；
 * - `stream()` 的信封构造（token 进 body、`system_instruction` 是字符串、
 *   `max_output_tokens` 必须下发）、流内 402 归额度、工具调用**分片合并**；
 * - `prepareCall` 与 DSH 0.1.7 消息双形状兼容。
 *
 * 全部使用注入的 fetch 桩，不发真实网络请求。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ACCIO_PROVIDER,
  AccioAdapter,
  accioModelCodeOf,
  accioModelIdOf,
  accioReasoningOf,
  displayNameOfAccioModel,
  normalizeAccioModel as adapterNormalizeAccioModel,
} from '../../src/accio-adapter.js'
// ⚠️ 目录解析的**唯一实现**在 accio-auth.ts（adapter 只再导出）。
import { normalizeAccioModel } from '../../src/accio-auth.js'
import { ACCIO } from '../../src/accio-product.js'
import type { AccioCredential } from '../../src/accio.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

function makeCredential(overrides: Partial<AccioCredential> = {}): AccioCredential {
  return {
    access_token: 'TOK',
    refresh_token: 'RT',
    expires_at: Date.now() + 3_600_000,
    region: 'cn',
    ...overrides,
  }
}

/** 上游真实帧形状：`content` 在**顶层**（不包 `candidates`）。 */
function frame(parts: unknown[]): Record<string, unknown> {
  return { content: { role: 'model', parts }, partial: true }
}

function textPart(text: string): Record<string, unknown> {
  return { text }
}

function thoughtPart(text: string): Record<string, unknown> {
  return { text, thought: true }
}

function callPart(id: string, name: string, argsJson?: string): Record<string, unknown> {
  const call: Record<string, unknown> = { id, name }
  if (argsJson !== undefined) call.args_json = argsJson
  return { function_call: call }
}

function accioSse(...frames: unknown[]): string {
  return `${frames.map((f) => `data: ${JSON.stringify(f)}\n`).join('')}data: [DONE]\n`
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

interface AdapterHarness {
  adapter: AccioAdapter
  fetcher: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

function makeAdapter(options: {
  /** 传 `null` 表示「解析不到凭据」。 */
  credential?: AccioCredential | null
  /**
   * 调用 `refresh()` **之后**才生效的凭据（缺省恒返回 `credential`）。
   *
   * ⚠️ 必须有这个缝：本用例要验证「401 重试带的是**新** token」，
   * 而 refresh 前后返回同一个 `'TOK'` 的桩**结构上抓不到**该缺陷
   * （旧实现在这种桩下照样通过 —— 这正是初版用例漏掉它的原因）。
   */
  credentialAfterRefresh?: AccioCredential | null
  responses?: Array<Response | (() => Response | Promise<Response>)>
  remoteModels?: Array<{
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    supportsImage?: boolean
    multiple?: number
  }>
  /** 传 `'throw'` 模拟远端目录整体失败。 */
  remote?: 'throw'
  accountPool?: unknown
  /**
   * 附件字节桥接（issue IKLR7V）。
   *
   * ⚠️ 默认**不提供** ⇒ 带图请求会走「需要附件服务」的显式报错分支；
   * 要测真正的内联通路必须显式注入（或用 `readImage` 覆盖具体行为）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  readImageRequest?: (
    attachment: unknown,
    target: { width: number; height: number; maxBytes: number },
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
} = {}): AdapterHarness {
  const credential = options.credential === undefined ? makeCredential() : options.credential ?? undefined
  let refreshedOnce = false
  const responses = [...(options.responses ?? [])]
  const fetcher = vi.fn(async () => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected fetch call')
    return typeof next === 'function' ? await next() : next
  })
  const refresh = vi.fn(async () => { refreshedOnce = true })
  const adapter = new AccioAdapter({
    resolveCredential: async () => {
      if (!refreshedOnce) return credential
      return options.credentialAfterRefresh === undefined
        ? credential
        : options.credentialAfterRefresh ?? undefined
    },
    refresh,
    fetchImpl: fetcher as unknown as typeof fetch,
    ...options.remote === 'throw'
      ? { fetchRemoteModels: async () => { throw new Error('目录不可用') } }
      : options.remoteModels === undefined
        ? {}
        : { fetchRemoteModels: async () => options.remoteModels! },
    ...options.accountPool === undefined ? {} : { accountPool: options.accountPool as never },
    ...options.readImage === undefined ? {} : { readImage: options.readImage },
    ...options.readImageRequest === undefined ? {} : { readImageRequest: options.readImageRequest },
  })
  return { adapter, fetcher, refresh }
}

/** 收集 `stream()` 产出的全部 chunk。 */
async function collect(adapter: AccioAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** 取出 fetch 桩实际发出的请求体。 */
function sentBody(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((fetcher.mock.calls[call] as [string, { body: string }])[1].body) as Record<string, unknown>
}

/** 取出 fetch 桩实际发出的 URL 与请求头。 */
function sentInit(fetcher: ReturnType<typeof vi.fn>, call = 0): { url: string; init: RequestInit } {
  const [url, init] = fetcher.mock.calls[call] as [string, RequestInit]
  return { url, init }
}

const BASIC_OPTIONS: GenerateOptions = {
  model: '1Drift-N8kP2Q7wR5mX',
  messages: [{ role: 'user', content: '你好' }],
} as unknown as GenerateOptions

/**
 * 一个最小的「正常回复」响应**工厂**。
 *
 * ⚠️ 必须是工厂而不是常量：`Response` 的 body 只能被读一次，多个用例共享
 * 同一个实例会让后续用例读到空流（表现为「模型未返回任何内容块」的假失败）。
 */
function okResponse(): Response {
  return sseResponse(accioSse(frame([textPart('好')])))
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('ACCIO_PROVIDER', () => {
  it('是纯小写字母且无连字符', () => {
    expect(ACCIO_PROVIDER).toBe('accio')
    expect(ACCIO_PROVIDER).toMatch(/^[a-z]+$/)
  })

  it('与产品配置的 id 同形', () => {
    expect(ACCIO_PROVIDER).toBe(ACCIO.id)
  })
})

/**
 * ⚠️⚠️ **对外 id 必须是「人话」（用户要求，2026-10-13）**。
 *
 * 用户原话（附模型自报截图的追问）：「为什么现在还是回复中的模型不是标准模型 id」。
 *
 * ## 背景：上游 `modelCode` 是**故意不可读**的内部代号
 *
 * 实测 38 条目录里 id 形如 `1Drift-N8kP2Q7wR5mX` / `1Chronos-…` / `1Orbit-…`，
 * 真名只在 `modelDisplayName` 里。而 DSH 把 **`CatalogEntry.id`** 注入给模型当
 * 身份 ⇒ 模型自报的是一串乱码（用户看到的正是这个）。
 *
 * ## 判据：**对外 id 用 slug，上行仍用 `modelCode`**
 *
 * | 流向 | 用什么 |
 * |---|---|
 * | `listModels` / `resolveModel` 的 `id`、注入给模型的身份 | **slug**（如 `qwen-3-8-flash`） |
 * | `POST /api/adk/llm/generateContent` 的 body `model` | **上游 `modelCode`**（必须） |
 *
 * ⚠️ 上行**绝不能**发 slug —— 服务端只认 `modelCode`（发错即请求打空）。
 * ⇒ 两者必须由映射函数（{@link accioModelCodeOf}）桥接，这是本组的核心不变式。
 */
describe('⭐ 对外 id = slug（人话），上行仍用 modelCode', () => {
  it('★ `accioModelIdOf`：展示名 → 人话 slug（与聚合的归一同一套规则）', () => {
    expect(accioModelIdOf({ id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash' }))
      .toBe('qwen-3-8-flash')
    expect(accioModelIdOf({ id: '1Orbit-Q7hN3xR6cP2m', name: 'Ultimate' })).toBe('ultimate')
    // ⚠️ 点号转连字符（`V4.1` → `v4-1`），与 `normalizeModelKey` 同口径。
    expect(accioModelIdOf({ id: '1Nova-Q3xM8vJ1rH6z', name: 'DeepSeek V4.1 Flash' }))
      .toBe('deepseek-v4-1-flash')
  })

  it('★ slug 不含任何非 [a-z0-9-] 字符（上游展示名带空格/点号/大小写）', () => {
    for (const name of ['Qwen 3.8 27B', 'GLM-5.3', 'MiniMax M3', 'Kimi K2.6', 'Professional']) {
      expect(accioModelIdOf({ id: 'X', name }), name).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('⚠️ 兜底：名字归一后为空时回退到原始 id（绝不产出空 id）', () => {
    // 空 id 会让 DSH 的目录校验抛 INVALID_CATALOG，整个 provider 不可用。
    expect(accioModelIdOf({ id: '1Abc-Def123', name: '   ' })).toBe('1Abc-Def123')
    expect(accioModelIdOf({ id: '1Abc-Def123', name: '·' })).toBe('1Abc-Def123')
  })

  it('★ 双向映射：slug → modelCode 必须能回查（上行靠它）', () => {
    const models = [
      { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash' },
      { id: '1Orbit-Q7hN3xR6cP2m', name: 'Ultimate' },
    ]
    expect(accioModelCodeOf(models, 'qwen-3-8-flash')).toBe('1Drift-F8hS3mK7pL2n')
    expect(accioModelCodeOf(models, 'ultimate')).toBe('1Orbit-Q7hN3xR6cP2m')
  })

  it('⚠️ 回查不到时**原样返回入参**（不抛错、不返回空）', () => {
    // 判据：用户可能手填一个 id；未知 id 必须原样透传给上游（由它报错），
    // 而不是在这里静默变成空串（那会让请求发到一个空模型名）。
    const models = [{ id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash' }]
    expect(accioModelCodeOf(models, 'unknown-thing')).toBe('unknown-thing')
  })

  it('★ 行为级：`listModels` 吐出的 id 是 slug，**不是** 上游 modelCode', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
      ],
    })
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models.map((m) => m.id)).toEqual(['qwen-3-8-flash'])
    // ⚠️ 上游代号**不得**再出现在对外 id 里（这正是用户报障的形态）。
    expect(models.map((m) => m.id)).not.toContain('1Drift-F8hS3mK7pL2n')
  })

  it('★⚠️ 行为级：请求体里的 `model` 仍是**上游 modelCode**（不是 slug）', async () => {
    // ⚠️ 这是本组最关键的判据：改 id 时若忘了映射，请求会打到 slug
    //（服务端不认）—— 功能整体失效，且症状是「模型不回复」这种误导性形态。
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [
        { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
      ],
      responses: [sseResponse(accioSse({ content: { role: 'model', parts: [{ text: 'ok' }] } }))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, model: 'qwen-3-8-flash' } as GenerateOptions)
    expect(sentBody(fetcher).model).toBe('1Drift-F8hS3mK7pL2n')
  })
})

describe('displayNameOfAccioModel —— ⚠️ 倍率必须进 name，不是 description', () => {
  // composer 的模型切换菜单**只渲染 `name`**（`description` 完全不读），
  // 故倍率写进 description 等于没写（用户报障的原始成因）。
  it('有倍率时拼上 x 后缀', () => {
    expect(displayNameOfAccioModel({ name: 'Qwen 3.8 Flash', multiple: 0.03 }))
      .toBe('Qwen 3.8 Flash · x0.03')
  })

  it('倍率为 1 也照拼（1 不是「无」）', () => {
    expect(displayNameOfAccioModel({ name: 'Professional', multiple: 1 }))
      .toBe('Professional · x1')
  })

  it('无倍率时不拼后缀', () => {
    expect(displayNameOfAccioModel({ name: 'X' })).toBe('X')
  })

  it('倍率为 0 是合法值（免费），不得与「无倍率」混同', () => {
    // 上游 `effectiveMultiple` 可能为 0；`0` 与 `undefined` 语义不同，
    // 用 `if (multiple)` 会把免费模型显示成「没有倍率」。
    expect(displayNameOfAccioModel({ name: 'Free', multiple: 0 })).toBe('Free · x0')
  })

  it('跨度大（0.013 vs 2.8）时必须可区分', () => {
    expect(displayNameOfAccioModel({ name: 'A', multiple: 0.013 })).toContain('x0.013')
    expect(displayNameOfAccioModel({ name: 'B', multiple: 2.8 })).toContain('x2.8')
  })

  it('非有限倍率不拼（不产出 xNaN）', () => {
    expect(displayNameOfAccioModel({ name: 'A', multiple: Number.NaN })).toBe('A')
    expect(displayNameOfAccioModel({ name: 'A', multiple: Number.POSITIVE_INFINITY })).toBe('A')
  })
})

/**
 * ⚠️⚠️ **思考档位声明**（2026-10-13，用户要求「即使只有一档也要显示」）。
 *
 * ## 为什么这一层必须有独立用例（而不是只测 `normalizeAccioModel`）
 *
 * `normalizeAccioModel` 只负责**接住**远端字段；**「怎么声明给 DSH」是另一套判据**：
 * - `efforts` 非空 ⇒ 全列，但 `defaultEffort` **必须落在集合内**（否则 DSH 会丢弃
 *   整个档位声明，`model-catalog.ts` 里有那段 `legal` 检查）；
 * - `efforts` 空 + `defaultEffort` 有值 ⇒ **单档**（用户明确要求的那一格）；
 * - 两者都无 ⇒ 不声明。
 *
 * ⇒ 这三格若只在 `normalizeAccioModel` 测，**永远测不到**。
 */
describe('accioReasoningOf —— 把远端档位映射成 DSH 声明', () => {
  it('★ 有数组：全列 + default 落在集合内时带上', () => {
    const r = accioReasoningOf({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' })
    expect(r?.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(r?.defaultEffort).toBe('high')
  })

  it('★ 有数组但 default 不在集合内 ⇒ **丢弃 default**，档位本身照给', () => {
    // ⚠️ DSH 会校验 `defaultEffort ∈ efforts`，指到集合外会让**整条档位声明**
    //    被丢弃（`model-catalog.ts` 的 `legal` 检查）—— 那比「少一个默认档」更糟。
    const r = accioReasoningOf({ efforts: ['low', 'high'], defaultEffort: 'max' })
    expect(r?.efforts.map((e) => e.id)).toEqual(['low', 'high'])
    expect(r?.defaultEffort).toBeUndefined()
  })

  it('★⚠️ 关键格：数组为空 + default 有值 ⇒ **单档**（用户要求的「只有一档也要显示」）', () => {
    // 真机形态：GLM-5.3 / MiniMax M3 等的 `reasoningEfforts` 是 null，但 default 有值。
    // 实测把该值发过去**服务端接受**（max / adaptive 都返回正常正文）⇒ 它是真档位。
    for (const def of ['max', 'adaptive', 'high']) {
      const r = accioReasoningOf({ defaultEffort: def })
      expect(r?.efforts.map((e) => e.id), def).toEqual([def])
      expect(r?.defaultEffort, def).toBe(def)
    }
  })

  it('★ 两者都无 ⇒ 不声明（返回 undefined，不编造档位）', () => {
    expect(accioReasoningOf({})).toBeUndefined()
    expect(accioReasoningOf({ efforts: [] })).toBeUndefined()
    expect(accioReasoningOf({ efforts: [], defaultEffort: undefined })).toBeUndefined()
  })

  it('★ 档位 id 原样当展示名（不翻译成中文 —— 排查时要能对上日志）', () => {
    const r = accioReasoningOf({ efforts: ['low', 'high'], defaultEffort: 'low' })
    expect(r?.efforts.map((e) => e.name)).toEqual(['low', 'high'])
  })

  it('★ 单档那格的名字也是原样 id（不是「默认」之类自造文案）', () => {
    expect(accioReasoningOf({ defaultEffort: 'adaptive' })?.efforts[0]?.name).toBe('adaptive')
  })
})

/**
 * ⚠️⚠️ **风控拦截页**（2026-10-13 真机实测发现的静默失效）。
 *
 * ## 真实形态（本轮探测逐字留下的原文）
 *
 * 请求缺 `utdid`（或只放 header、不放 `properties.utdid`）时，阿里网关回：
 * **HTTP `200`** + `content-type: text/html;charset=UTF-8`，body 是一段跳转脚本：
 * `<a id="a-link" href="https://bixi-intl.alicdn.com/punish/…">` +
 * `window._config_ = {"action":"deny",…}` + `<!--rgv587_flag:sm-->`。
 *
 * ## 不识别时的后果
 *
 * 这段 HTML 被喂给 SSE 解析器 ⇒ **零帧** ⇒ 最终报「模型未返回任何内容块」。
 * 用户看到「模型不回复」，真因却是**风控** —— 排查方向完全错。
 * ⚠️ 本轮的档位探测就**被它误导过一轮**（「思考字符恒为 0」被误读成「档位无效」）。
 */
describe('⚠️ 风控拦截页（HTTP 200 + text/html）必须报明确错误', () => {
  /** 真机抓到的拦截页形态（截断，字段保真）。 */
  const BLOCK_PAGE = '\n\n<a id="a-link"\n    href="https://bixi-intl.alicdn.com/punish/punish:resource:template:ICBUSpace:default_447831.html?qrcode=X"'
    + '></a>\n<script>\nvar host = location.host;\n</script>\n window._config_ = {"action":"deny"};\n<!--rgv587_flag:sm-->'

  it('★ HTTP 200 + text/html ⇒ 抛 SERVER（不重试），且带服务端原文', async () => {
    const { adapter } = makeAdapter({
      responses: [new Response(BLOCK_PAGE, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } })],
    })
    await expect(collect(adapter, BASIC_OPTIONS)).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('★ 错误文案必须点出「风控 / 未返回事件流」，而不是「没有内容块」', async () => {
    const { adapter } = makeAdapter({
      responses: [new Response(BLOCK_PAGE, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } })],
    })
    // ⚠️ 判据是**真因可见**：只说「模型没返回内容」会把排查引向模型侧。
    await expect(collect(adapter, BASIC_OPTIONS)).rejects.toThrow(/风控|未返回事件流/)
  })

  it('★ 服务端原文必须进错误信息（诊断的硬证据）', async () => {
    // ⚠️ 断言用页面**开头**就能看到的特征：实现按前 200 字符截断
    //（尾部的 `rgv587_flag` 可能被截掉）—— 断言「截断后必然还在」的那部分，
    //  否则这条用例会因截断长度变化而假失败。
    const { adapter } = makeAdapter({
      responses: [new Response(BLOCK_PAGE, { status: 200, headers: { 'content-type': 'text/html' } })],
    })
    await expect(collect(adapter, BASIC_OPTIONS)).rejects.toThrow(/bixi-intl|a-link|服务端原文/)
  })

  it('★ 正常 SSE（text/event-stream）不得被这条判据误伤', async () => {
    // ⚠️ 反向守卫：判据是 `content-type` 而不是「响应里有 HTML 字样」。
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse({ content: { role: 'model', parts: [{ text: 'ok' }] } }))],
    })
    await expect(collect(adapter, BASIC_OPTIONS)).resolves.toBeDefined()
  })
})

describe('目录解析只有一份实现（adapter 只再导出）', () => {  it('⚠️ adapter 导出的 normalizeAccioModel 与 accio-auth 的是同一个函数', () => {
    // 「同一语义两套判据」是本仓库首条红线：adapter 不得自带第二份解析器。
    expect(adapterNormalizeAccioModel).toBe(normalizeAccioModel)
  })

  it('从 modelList 条目取字段', () => {
    const m = normalizeAccioModel({
      modelCode: '1X', modelDisplayName: 'X', contextWindow: 512000,
      multimodal: true, effectiveMultiple: 0.013, visible: true,
    })
    expect(m?.id).toBe('1X')
    expect(m?.name).toBe('X')
    expect(m?.contextWindow).toBe(512000)
    expect(m?.supportsImage).toBe(true)
    expect(m?.multiple).toBe(0.013)
  })

  it('⚠️ visible !== true 一律剔除（不可见模型不该进目录）', () => {
    expect(normalizeAccioModel({ modelCode: 'A', visible: false })).toBeUndefined()
    expect(normalizeAccioModel({ modelCode: 'A' })).toBeUndefined()
  })

  it('缺 modelCode 时剔除', () => {
    expect(normalizeAccioModel({ visible: true })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

describe('AccioAdapter · providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    const { adapter } = makeAdapter()
    expect(adapter.providerInfo(ACCIO_PROVIDER)).toEqual({
      id: ACCIO_PROVIDER,
      name: ACCIO.displayName,
    })
  })

  it('provider 非字符串时回退产品 id（防御 undefined.toUpperCase 崩溃）', () => {
    const { adapter } = makeAdapter()
    expect((adapter.providerInfo(undefined as never) as { id: string }).id).toBe(ACCIO_PROVIDER)
  })
})

describe('AccioAdapter · listModels', () => {
  it('远端目录可用时采信远端，且**倍率拼进 name**', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, multiple: 0.03 }],
    })
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models).toHaveLength(1)
    // ⚠️ **对外 id 是 slug，不是上游 `modelCode`**（2026-10-13，用户要求）——
    // 理由见 `accioModelIdOf`：DSH 会把 id 注入给模型当身份。
    expect(models[0]!.id).toBe('qwen-3-8-flash')
    expect(models[0]!.name).toBe('Qwen 3.8 Flash · x0.03')
  })

  it('远端目录失败时回退 ACCIO.fallbackModels（且同样带倍率）', async () => {
    const { adapter } = makeAdapter({ remote: 'throw' })
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models).toHaveLength(ACCIO.fallbackModels.length)
    // 兜底表首条：Qwen 3.8 27B，倍率 0.013。
    expect(models[0]!.id).toBe(accioModelIdOf(ACCIO.fallbackModels[0]!))
    expect(models[0]!.name).toBe(`${ACCIO.fallbackModels[0]!.name} · x${ACCIO.fallbackModels[0]!.multiple}`)
  })

  it('远端未提供时不拉取（无 fetchRemoteModels 时直接用兜底表）', async () => {
    const { adapter, fetcher } = makeAdapter()
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models).toHaveLength(ACCIO.fallbackModels.length)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('应用账号池的模型黑名单（关闭的模型不出现在目录里）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'a', name: 'Model A', multiple: 0.1 },
        { id: 'b', name: 'Model B', multiple: 0.2 },
      ],
      // ⚠️ 黑名单的键是**对外 id**（= slug），故这里用 `model-a`。
      accountPool: { disabledModelsFor: () => new Set(['model-a']) },
    })
    expect((await adapter.listModels(ACCIO_PROVIDER)).map((m) => m.id)).toEqual(['model-b'])
  })

  it('listAllModels 不受黑名单影响（设置页要能重新打开已关闭的模型）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'a', name: 'Model A', multiple: 0.1 },
        { id: 'b', name: 'Model B', multiple: 0.2 },
      ],
      accountPool: { disabledModelsFor: () => new Set(['model-a']) },
    })
    await adapter.listModels(ACCIO_PROVIDER)
    expect(adapter.listAllModels().map((m) => m.id).sort()).toEqual(['model-a', 'model-b'])
  })
})

describe('AccioAdapter · resolveModel', () => {
  it('已知模型解析出 contextWindow（来自目录）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: '1Nova-Q3xM8vJ1rH6z', name: 'DeepSeek V4.1 Flash', contextWindow: 512_000, multiple: 0.013 }],
    })
    // ⚠️ `resolveModel` 收的也是**对外 id**（slug）。
    const resolved = await adapter.resolveModel(ACCIO_PROVIDER, 'deepseek-v4-1-flash')
    expect(resolved.id).toBe('deepseek-v4-1-flash')
    expect(resolved.context?.contextWindow).toBe(512_000)
  })

  it('resolveModel 的 name **不带倍率**（价格只属于选择列表语境）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: '1Nova-Q3xM8vJ1rH6z', name: 'Qwen', contextWindow: 512_000, multiple: 0.013 }],
    })
    expect((await adapter.resolveModel(ACCIO_PROVIDER, 'qwen')).name).toBe('Qwen')
  })

  /**
   * ⚠️⚠️ **本段是「已推翻的判据」的第二次修订**（2026-10-14，issue IKLR7V）——
   * 读它之前先看这段历史，别再改回去。
   *
   * | 时期 | 判据 | 依据 |
   * |---|---|---|
   * | 初版 | **恒省略**（= 未知） | 图片通路整体未实测 |
   * | 2026-10-14 起（现行） | `supportsImage ? ['text','image'] : ['text']` | 真机实测：上游原生收图 |
   *
   * 实测证据（四象限色块图，`multimodal` 逐个对照）：
   * - `multimodal: true` 的 3 个模型 **3/3 四色全对**；
   * - `multimodal: false` 的 3 个模型 **3/3 未认图**（两家明说「没看到图片」，
   *   **GLM 5.1 幻觉**出一份答案）。
   *
   * ⇒ `false` 必须写 **`['text']`（明确不支持）**，不能省略：省略 = 未知 ⇒ DSH 放行
   * 图片 ⇒ 上游**静默忽略** ⇒ 用户拿到一份**基于幻觉的、看起来正常的回答**。
   */
  it('⚠️⚠️ supportsImage=true ⇒ [text,image]；false ⇒ [text]（明确不支持，不是省略）', async () => {
    // ⚠️⚠️ **`resolveModel` 收的是对外 slug（展示名归一），不是上游 `modelCode` 原始 id**
    //     —— 这条差异使本用例的初版**恒真**：它原先用 `id`（'img'）去查，而目录里的
    //     条目 id 是 slug（'vision'）⇒ **两次都落到「未知 id」分支**，于是
    //     「true 也 undefined、false 也 undefined」双双通过 —— 恰好掩盖了
    //     「已知模型的能力根本没被断言」这个空洞。改用展示名可预测的 ASCII 名后
    //     才真正测到已知模型分支（下面的 slug 断言就是防这个陷阱的）。
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'code-vision', name: 'Vision', contextWindow: 1_000_000, supportsImage: true, multiple: 0.1 },
        { id: 'code-plain', name: 'Plain', contextWindow: 1_000_000, supportsImage: false, multiple: 0.2 },
      ],
    })
    // 正例：确认 slug 确实是展示名归一后的结果（不是上游 id）——否则上面那条
    // 「已知模型」的断言又会在未知分支上空转。
    expect(accioModelIdOf({ id: 'code-vision', name: 'Vision' }), 'slug 取自展示名').toBe('vision')
    const img = await adapter.resolveModel(ACCIO_PROVIDER, 'vision')
    const txt = await adapter.resolveModel(ACCIO_PROVIDER, 'plain')
    expect(img.inputModalities, '声明 multimodal:true ⇒ 实测真收图，如实声明').toEqual(['text', 'image'])
    // ⚠️ 这一条是**本 issue 最重要的结论**：false 若是省略，图片会一路走到上游，
    // 被**静默忽略**（GLM 5.1 实测据此幻觉出答案），属最难排查的失败形态。
    expect(txt.inputModalities, '声明 multimodal:false ⇒ 必须明确报 [text]，不得省略').toEqual(['text'])
  })

  it('listModels 与 resolveModel 同源（模态按逐模型 supportsImage）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'm1', name: 'Qwen', contextWindow: 1_000_000, supportsImage: true, multiple: 0.1 }],
    })
    const models = await adapter.listModels(ACCIO_PROVIDER)
    expect(models[0]!.inputModalities).toEqual(['text', 'image'])
  })

  it('未知模型 id 保守报 [text]（不编造能力；与 stream() 的保守拒绝同向）', async () => {
    // ⚠️ 两处必须**同向**：目录报 [text] 让 DSH 在准入阶段拒图，而 `stream()` 同样拒绝。
    //    若目录省略（放行）而适配器拒绝，就会退化成「每次带图白撞一轮」的形态
    //    （正是本 issue 描述的缺陷）。
    const { adapter } = makeAdapter()
    const resolved = await adapter.resolveModel(ACCIO_PROVIDER, 'no-such-model')
    expect(resolved.name).toBe('no-such-model')
    expect(resolved.inputModalities, '未知 id 的能力无从得知 ⇒ 保守报 [text]').toEqual(['text'])
    expect(resolved.context).toBeUndefined()
  })

  /**
   * ⚠️⚠️ **本 issue 的第二个症状的守卫**：聚合带图时 accio 曾被整体剔出候选集。
   *
   * issue 把机制描述为「本机给 accio 打了个 `NO_IMAGE` 硬标记」，但实测（全仓搜
   * `NO_IMAGE` **零命中**）真实机制是：`inputModalities` 恒省略 ⇒ 聚合的
   * `capabilityOf` 里 `imageCapable = inputModalities?.includes('image') === true`
   * 折算成 `false` ⇒ `imageTargets` 把它的每个模型都过滤掉。
   *
   * ⇒ 本用例直接按**聚合的那条判据**求值（不 mock 聚合，只复用同一个表达式），
   * 锁死「视觉模型进候选、纯文本模型被剔」这个方向。
   */
  it('⚠️⚠️ 聚合折算：multimodal:true 的模型 imageCapable=true（否则带图时 accio 整体被剔）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'code-vision', name: 'Vision', contextWindow: 1_000_000, supportsImage: true, multiple: 0.1 },
        { id: 'code-plain', name: 'Plain', contextWindow: 1_000_000, supportsImage: false, multiple: 0.2 },
      ],
    })
    // ⚠️ 与 `aggregate-adapter.ts` 的 `capabilityOf` **逐字同一个表达式**。
    //    两处若分叉，就会出现「目录说支持、聚合却剔掉它」的静默缺口。
    const imageCapableOf = (m: { inputModalities?: readonly string[] }): boolean =>
      m.inputModalities?.includes('image') === true
    expect(imageCapableOf(await adapter.resolveModel(ACCIO_PROVIDER, 'vision')),
      '⚠️ 接线后 accio 的视觉模型必须进带图候选表').toBe(true)
    expect(imageCapableOf(await adapter.resolveModel(ACCIO_PROVIDER, 'plain')),
      '声明 false 的模型必须仍被剔出带图候选（上游会静默忽略它的图）').toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

describe('AccioAdapter · stream 请求构造', () => {
  it('打到 generateContent 端点，sg_k = md5(request_id)', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    const { url } = sentInit(fetcher)
    expect(url.startsWith(`${ACCIO.gatewayBaseUrl}/api/adk/llm/generateContent?sg_k=`)).toBe(true)
    const body = sentBody(fetcher)
    const requestId = String(body.request_id)
    const sgK = url.slice(url.indexOf('sg_k=') + 5)
    const { createHash } = await import('node:crypto')
    expect(sgK).toBe(createHash('md5').update(requestId, 'utf8').digest('hex'))
  })

  it('⚠️ token 必须在 body，且**不得**出现在 Authorization 头', async () => {
    // 放 Authorization 头恒得 HTTP 200 + 流内 402（实测四格矩阵）。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(sentBody(fetcher).token).toBe('TOK')
    const headers = new Headers(sentInit(fetcher).init.headers)
    expect(headers.get('Authorization')).toBeNull()
  })

  it('恒带 Content-Type / Accept / utdid / version / appKey，且无 SecurityGuard 头', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    const headers = new Headers(sentInit(fetcher).init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('text/event-stream')
    expect(headers.get('appKey')).toBe(ACCIO.appKey)
    for (const [key] of headers) expect(key.startsWith('pctb-')).toBe(false)
  })

  it('empid / tenant / iai_tag 恒空串', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    const body = sentBody(fetcher)
    expect(body.empid).toBe('')
    expect(body.tenant).toBe('')
    expect(body.iai_tag).toBe('')
  })

  it('⚠️ maxOutputTokens **必须下发**（不能只用来过滤）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, maxTokens: 4096 } as GenerateOptions)
    expect(sentBody(fetcher).max_output_tokens).toBe(4096)
  })

  it('未指定 maxTokens 时不发该字段（不编造数值）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(Object.hasOwn(sentBody(fetcher), 'max_output_tokens')).toBe(false)
  })

  it('temperature 透传', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, temperature: 0.3 } as GenerateOptions)
    expect(sentBody(fetcher).temperature).toBe(0.3)
  })

  it('tools 转成 { name, description, parameters_json } 下发', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      tools: [{
        name: 'read_file',
        description: '读文件',
        // ⚠️ 刻意用**驼峰参数名**：下面两条反向断言要证明它不被递归改写。
        parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      }],
    } as unknown as GenerateOptions)
    const tools = sentBody(fetcher).tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('read_file')
    // ⚠️ 键名经 `accioToSnake` 变成 `parameters_json`。形状是**实测**的扁平形态
    //    （**不是** Gemini 的 `{function_declarations:[…]}`）：
    //    · 证据来源：Task 6 的真机探针 `probe-tool-shards.mjs` / `probe-tool-merge.mjs`
    //      下发的就是这个形态，上游回了真实 `function_call` 帧（`task-6-report.md` §4.2
    //      的 frame#8/#9/#10）。
    //    · ⚠️ **已验证但证据未留存**：探针在 gitignore 的 `.tmp-accio/`、无日志入库
    //      ⇒ 结论照用，但没有可复核的产物（agent-notes §10 的 U-F）。
    //    · ⚠️ 参数名安全的原因：schema 被 `JSON.stringify` 成**字符串**，而
    //      `accioToSnake` **不下钻字符串** ⇒ `filePath` 这类驼峰参数名是「数据」、
    //      不在改写路径上。见 `src/accio.ts` 的 `buildAccioBody` tools 区域警告。
    expect(typeof tools[0]!.parameters_json).toBe('string')
    // ⚠️⚠️ 反向守卫：schema 里出现**驼峰参数名**时，它必须逐字节保留在字符串里，
    //    绝不能被 `accioToSnake` 递归改写（那会让参数名与调用方按原 schema 消费的
    //    那份定义失配，且没有任何报错）。
    expect(tools[0]!.parameters_json).toContain('"filePath"')
    expect(tools[0]!.parameters_json).not.toContain('"file_path"')
    // 且**不得**退化成 Gemini 的包装形态（那是未实测的形状，且会激活上面的隐患）。
    expect(tools[0]).not.toHaveProperty('function_declarations')
    expect(tools[0]).not.toHaveProperty('functionDeclarations')
  })

  it('无 tools 时不发该字段', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(Object.hasOwn(sentBody(fetcher), 'tools')).toBe(false)
  })

  it('⚠️⚠️ system_instruction 必须是**字符串**（对象形态实测恒流内 400）', async () => {
    // 实测（2026-10-13，唯一变量对照，各 3 轮）：
    //   system_instruction = "…"                ⇒ 200 ✅
    //   system_instruction = {parts:[{text}]}   ⇒ 200 + 流内 400 Invalid request format ❌
    // 而 `buildAccioBody` 产出的正是**对象**形态 ⇒ 适配器必须改写成字符串。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, system: '你是助手' } as GenerateOptions)
    const sent = sentBody(fetcher).system_instruction
    expect(typeof sent, 'system_instruction 必须是字符串').toBe('string')
    expect(sent).toBe('你是助手')
  })

  it('无 system 时不发 system_instruction', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, BASIC_OPTIONS)
    expect(Object.hasOwn(sentBody(fetcher), 'system_instruction')).toBe(false)
  })

  it('会话命名请求（purpose=session-title）把预算抬到兜底下限', async () => {
    // Accio **关不掉思考**（实测四类字段全部无效）⇒ 只能走 `planSessionTitleThinking`
    // 的抬预算兜底；DSH 默认发 64 token 会被思考吃满、正文零产出（issue IKKVDH）。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS, purpose: 'session-title', maxTokens: 64,
    } as GenerateOptions)
    expect(sentBody(fetcher).max_output_tokens).toBe(512)
  })

  it('普通请求的预算不被抬高（逐字段原样透传）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, { ...BASIC_OPTIONS, maxTokens: 64 } as GenerateOptions)
    expect(sentBody(fetcher).max_output_tokens).toBe(64)
  })
})

// ---------------------------------------------------------------------------
// 消息序列化（DSH 0.1.7 双形状）
// ---------------------------------------------------------------------------

describe('AccioAdapter · 消息序列化', () => {
  it('system 抽到 system_instruction，用户消息进 contents', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [{ role: 'user', content: '你好' }],
      system: 'SYS',
    } as GenerateOptions)
    const body = sentBody(fetcher)
    expect(body.system_instruction).toBe('SYS')
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
  })

  it('⚠️ 工具历史（0.1.7 一等 role:tool）必须下发为 functionResponse', async () => {
    // 真实缺陷形态：不归一化时 `tool-result` 判据恒不命中 ⇒ 工具输出被静默丢弃
    // ⇒ 模型看不到工具结果，表现为提前结束或循环思考。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '读文件' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }],
        },
        // 0.1.7：工具结果是一等消息，toolCallId 在**顶层**。
        { role: 'tool', toolCallId: 'c1', content: '文件内容' },
      ],
    } as unknown as GenerateOptions)

    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const assistant = contents.find((c) => c.role === 'model') as { parts: Array<Record<string, unknown>> }
    expect(assistant, 'assistant 的 tool_calls 不得被剔除').toBeDefined()
    // ⚠️ 断言的是**真实 wire 形状**：`buildAccioBody` 会走 `accioToSnake`，
    // 故 `functionCall` → `function_call`、`argsJson` → `args_json`（实测如此）。
    const call = assistant.parts.find((p) => p.function_call !== undefined) as {
      function_call: { id: string; name: string; args_json: string }
    }
    expect(call, 'assistant 必须下发 function_call').toBeDefined()
    expect(call.function_call.name).toBe('read_file')
    expect(call.function_call.id).toBe('c1')
    expect(JSON.parse(call.function_call.args_json)).toEqual({ file_path: 'a.txt' })

    // ⚠️ 工具结果必须真的下发，且带上 **id 与 name**（上游按 name 配对）。
    const resultPart = contents
      .flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .find((p) => p.function_response !== undefined) as
      | { function_response: { id: string; name: string; response_json: string } }
      | undefined
    expect(resultPart, '工具结果不得被静默丢弃').toBeDefined()
    expect(resultPart!.function_response.id).toBe('c1')
    expect(resultPart!.function_response.name).toBe('read_file')
    expect(resultPart!.function_response.response_json).toBe('文件内容')
  })

  it('0.1.5 包裹形态（tool-result 块）与 0.1.7 形态序列化结果一致', async () => {
    const legacy = {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }] }],
        },
      ],
    } as unknown as GenerateOptions
    const modern = {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: '文件内容' },
      ],
    } as unknown as GenerateOptions

    const a = makeAdapter({ responses: [okResponse()] })
    await collect(a.adapter, legacy)
    const b = makeAdapter({ responses: [okResponse()] })
    await collect(b.adapter, modern)

    // ⚠️ 逐字节等价：比逐个断言字段更强，且对实现方式中立。
    const norm = (body: Record<string, unknown>): unknown => {
      const contents = body.contents as Array<Record<string, unknown>>
      // name 在 0.1.5 形态下由 assistant 的 tool-call 回填，两条路径都必须有。
      return contents
    }
    expect(norm(sentBody(b.fetcher))).toEqual(norm(sentBody(a.fetcher)))
  })

  it('孤儿 tool-call 被剔除（无结果时不下发，避免上游 400）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'orphan', name: 'read_file', arguments: '{}' }] },
      ],
    } as unknown as GenerateOptions)
    // ⚠️⚠️ 判据必须是 **snake_case** 的 `function_call`：`buildAccioBody` 会走
    // `accioToSnake`，wire 上没有 `functionCall` 这个键。初版按驼峰过滤
    // ⇒ 过滤结果恒为 `[]` ⇒ 断言恒真、**什么都没锁住**（本用例当时是空转的）。
    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const calls = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_call !== undefined)
    expect(calls, '孤儿 tool-call 不得下发').toHaveLength(0)
  })

  it('⚠️ 正向对照：配对完整的 tool-call **必须**在 body 里（否则上面的过滤器恒空也照样通过）', async () => {
    // 没有这条对照，`filter(p => p.function_call !== undefined)` 即使写成
    // 恒不命中的键名也能「通过」—— 那是同义反复，不是守卫。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"file_path":"a.txt"}' }] },
        { role: 'tool', toolCallId: 'c1', content: '文件内容' },
      ],
    } as unknown as GenerateOptions)
    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const calls = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_call !== undefined)
    // 必须恰好一条：既证明过滤器能命中，也证明配对完整的调用没被误剔。
    expect(calls, '配对完整的 tool-call 必须下发').toHaveLength(1)
    expect((calls[0]!.function_call as { id: string }).id).toBe('c1')
    // 结果侧同样要有对照（孤儿剔除不能把合法结果也剔掉）。
    const results = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_response !== undefined)
    expect(results, '配对完整的工具结果必须下发').toHaveLength(1)
  })

  it('孤儿 tool-result 同样被剔除（有结果但无对应调用）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', toolCallId: 'no-such-call', content: '文件内容' },
      ],
    } as unknown as GenerateOptions)
    const contents = sentBody(fetcher).contents as Array<Record<string, unknown>>
    const results = contents.flatMap((c) => (c.parts ?? []) as Array<Record<string, unknown>>)
      .filter((p) => p.function_response !== undefined)
    expect(results, '孤儿 tool-result 不得下发').toHaveLength(0)
  })

  it('developer 消息被丢弃（它只承载工具增删元数据）', async () => {
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'developer', content: 'tool-addition metadata' },
        { role: 'user', content: 'hi' },
      ],
    } as unknown as GenerateOptions)
    const text = JSON.stringify(sentBody(fetcher).contents)
    expect(text).not.toContain('tool-addition metadata')
  })
})

// ---------------------------------------------------------------------------
// 图片：明确报错，不静默丢弃
// ---------------------------------------------------------------------------

describe('AccioAdapter · 图片（issue IKLR7V 接线）', () => {
  /** 一张 1×1 PNG 的字节（内容无关紧要 —— 探针验的是**形状与位置**）。 */
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  /** 带图的 BASIC_OPTIONS（模型走兜底表的 multimodal:true 条目）。 */
  function imageOptions(extra: Partial<GenerateOptions> = {}): GenerateOptions {
    return {
      ...BASIC_OPTIONS,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', attachment: { attachmentId: 'att-1', width: 16, height: 16 } },
        ],
      }],
      ...extra,
    } as unknown as GenerateOptions
  }

  it('⚠️⚠️ 带图请求必须把图片内联成 parts[].inline_data（实测形状）', async () => {
    // 上游形状（2026-10-14 真机实测四色全对）：Gemini 风格的
    // `parts[].inline_data = { mime_type, data }`，与既有 contents 信封同构。
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: PNG_BYTES, mediaType: 'image/png' }),
    })
    await collect(adapter, imageOptions())

    const contents = sentBody(fetcher).contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    const user = contents.find((c) => c.role === 'user')!
    expect(user, '带图请求必须有 user 消息').toBeDefined()
    const imagePart = user.parts.find((p) => p.inline_data !== undefined) as
      | { inline_data: { mime_type: string; data: string } }
      | undefined
    expect(imagePart, '⚠️ 图片必须内联成 inline_data（不得静默丢弃）').toBeDefined()
    expect(imagePart!.inline_data.mime_type).toBe('image/png')
    expect(imagePart!.inline_data.data).toBe(Buffer.from(PNG_BYTES).toString('base64'))
    // 文本与图片必须在**同一条** parts 里（分成两条会让模型看到一张没有上下文的图）。
    expect(user.parts.some((p) => p.text !== undefined), '文本与图片同条消息').toBe(true)
  })

  it('⚠️⚠️ multimodal:false 的模型收到图片必须显式报错（上游会静默忽略，甚至幻觉）', async () => {
    // 实测（issue IKLR7V）：`multimodal: false` 的模型**不报错**，而是静默忽略图片
    // —— GLM 5.1 甚至据此**幻觉**出一份答案。故本地必须显式拒绝。
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: PNG_BYTES, mediaType: 'image/png' }),
      remoteModels: [
        { id: '1Nexus-R3wF8qJ5vB6h', name: 'Standard', contextWindow: 1_000_000, supportsImage: true, multiple: 0.13 },
        { id: '1Chronos-dX3cV9sA2mK7', name: 'GLM 5.1', contextWindow: 200_000, supportsImage: false, multiple: 0.12 },
      ],
    })
    // 用**声明 false** 的那个模型的 slug（'glm-5-1'）。
    const error = await collect(adapter, imageOptions({ model: 'glm-5-1' } as Partial<GenerateOptions>))
      .catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(fetcher, '不得把图发到一个会静默忽略它的模型上').not.toHaveBeenCalled()
  })

  it('⚠️ 附件服务未接线时显式报错（绝不静默退化成纯文本）', async () => {
    // 静默退化会让用户以为模型看到了图。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    const error = await collect(adapter, imageOptions()).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    // ⚠️ 断言必须**锚定本分支独有**的措辞（`readImage / readImageRequest 均未提供`）：
    //    泛泛断言「附件服务」会**放行** —— 下游还有另一条同样含该词的报错
    //    （「图片附件读取不到内容…附件服务可能未就绪」）。实测把本守卫整条删掉、
    //    只留下游那条时，「附件服务」断言**照样通过**（本用例初版就是这种假绿）。
    expect((error as Error).message).toContain('readImage / readImageRequest 均未提供')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('⚠️ 优先用「请求版本」（按 ACCIO_IMAGE_PIXEL_BUDGET 缩放），拿不到才回退原图', async () => {
    // `ACCIO_IMAGE_PIXEL_BUDGET` 原先只是「无引用的预留常量」，接线后必须真的生效。
    const seen: Array<{ width: number; height: number; maxBytes: number }> = []
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImageRequest: async (_attachment, target) => {
        seen.push(target)
        return { data: PNG_BYTES, mediaType: 'image/webp' }
      },
    })
    await collect(adapter, imageOptions())
    expect(seen.length, '必须走请求版本投影').toBe(1)
    // 16×16 的图小于预算 ⇒ 尺寸原样（`fitImageToPixelBudget` 不放大）。
    expect(seen[0]).toMatchObject({ width: 16, height: 16 })
    expect(seen[0]!.maxBytes).toBeGreaterThan(0)
    // 且上行用的是投影后的 mediaType（不是原图的）。
    const contents = sentBody(fetcher).contents as Array<{ parts: Array<Record<string, unknown>> }>
    const part = contents.flatMap((c) => c.parts).find((p) => p.inline_data !== undefined) as
      | { inline_data: { mime_type: string } }
      | undefined
    expect(part!.inline_data.mime_type).toBe('image/webp')
  })

  it('⚠️⚠️ 工具结果内嵌图片必须排到 role:tool **之后**（不得挤在它前面）', async () => {
    // `functionResponse` 只吃字符串、没有承载图的位置 ⇒ 内嵌图只能挂到 tool 消息之后。
    // 排在前面会违反 role:'tool' 的协议约束（trae 记过 4027 事故）。
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: PNG_BYTES, mediaType: 'image/png' }),
    })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '看图' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{}' }],
        },
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: '截图如下' },
            { type: 'image', attachment: { attachmentId: 'att-nested', width: 16, height: 16 } },
          ],
        },
      ],
    } as unknown as GenerateOptions)

    const contents = sentBody(fetcher).contents as Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }>
    const toolIdx = contents.findIndex((c) => c.parts.some((p) => p.function_response !== undefined))
    const imageIdx = contents.findIndex((c) => c.parts.some((p) => p.inline_data !== undefined))
    expect(toolIdx, '工具结果必须下发').toBeGreaterThanOrEqual(0)
    expect(imageIdx, '⚠️ 内嵌图片不得被静默丢弃').toBeGreaterThanOrEqual(0)
    expect(imageIdx, '⚠️ 图片必须排在 tool 消息之后').toBeGreaterThan(toolIdx)
    // 图片所在消息必须带那句上下文说明（否则模型看到一张没有来路的图）。
    expect(JSON.stringify(contents[imageIdx]!.parts)).toContain('tool result')
  })

  it('⚠️⚠️ 0.1.5 包裹形态里**第二层**的嵌套图片也必须被提升（递归的判别用例）', async () => {
    // ⚠️ 这条是**判别用例**：图片在 `tool-result` 块的 `content` 里（真正的第二层），
    // 且该块被包在一条 **user** 消息里（0.1.5 形状）。只扫顶层 `message.content` 的
    // 实现会漏掉它 ⇒ 图片被静默丢弃。
    //
    // ⚠️ **必须带上配对的 assistant `tool-call`**：没有它，`resolveToolPairing` 会
    // 把这个工具结果判成**孤儿**而整体丢弃（那是对的 —— 孤儿工具结果会被上游 400）。
    // 初版用例漏了这一点，于是它测的是「孤儿被丢」而不是「第二层图片被提升」，
    // 得到的失败是**假阳性**。
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: PNG_BYTES, mediaType: 'image/png' }),
    })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{}' }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'c1',
            content: [
              { type: 'text', text: '截图如下' },
              { type: 'image', attachment: { attachmentId: 'att-nested', width: 16, height: 16 } },
            ],
          }],
        },
      ],
    } as unknown as GenerateOptions)

    const contents = sentBody(fetcher).contents as Array<{ parts: Array<Record<string, unknown>> }>
    const imagePart = contents.flatMap((c) => c.parts).find((p) => p.inline_data !== undefined)
    expect(imagePart, '⚠️ 第二层的嵌套图片被静默丢弃了（递归没做）').toBeDefined()
  })

  it('⚠️⚠️ 「只有图片 + 工具结果、没有正文」的消息不得把图片静默丢掉', async () => {
    // ## 真实缺陷（本文件的「洞探针」抓到，2026-10-14）
    //
    // `toAccioWireMessages` 的 user 分支初版是
    // `if (text.length > 0 || toolResults.length === 0)`，于是
    // `content: [image, tool-result]`（**无正文**）这种消息两腿**同时为假**
    // ⇒ 整条消息被跳过 ⇒ **图片被静默丢弃**，且没有任何报错。
    //
    // ⚠️ 这比「一开始就没收图」更隐蔽：`collectImages`（`stream()` 的守卫）
    // **收得到**它，所以上层认为「本次带图」，而 wire 上根本没有那张图 ——
    // 正是本仓库首条红线所指的「收了却发不出去」。
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: PNG_BYTES, mediaType: 'image/png' }),
    })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{}' }],
        },
        {
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: 'att-1', width: 16, height: 16 } },
            { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      ],
    } as unknown as GenerateOptions)

    const contents = sentBody(fetcher).contents as Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }>
    expect(contents.flatMap((c) => c.parts).some((p) => p.inline_data !== undefined),
      '⚠️ 「只有图片 + 工具结果」的消息把图片静默丢掉了').toBe(true)
  })

  it('⚠️⚠️ 带工具结果时，本消息的正文/图片必须**排在 role:tool 之后**', async () => {
    // Accio 是 Gemini 风格：`functionResponse` 必须**紧跟**发起该调用的 model 消息，
    // 中间插任何东西都会破坏配对（trae 的 4027 事故是这条约束在另一协议下的爆炸：
    // 坏报文落进历史后**每轮原样重放**，只能换 provider 才能恢复）。
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: PNG_BYTES, mediaType: 'image/png' }),
    })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{}' }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是截图' },
            { type: 'image', attachment: { attachmentId: 'att-1', width: 16, height: 16 } },
            { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      ],
    } as unknown as GenerateOptions)

    const contents = sentBody(fetcher).contents as Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }>
    const toolIdx = contents.findIndex((c) => c.parts.some((p) => p.function_response !== undefined))
    const imageIdx = contents.findIndex((c) => c.parts.some((p) => p.inline_data !== undefined))
    expect(toolIdx, '工具结果必须下发').toBeGreaterThanOrEqual(0)
    expect(imageIdx, '图片不得被静默丢弃').toBeGreaterThanOrEqual(0)
    expect(imageIdx, '⚠️ 带图的本消息必须排在 tool 消息之后（否则破坏 functionResponse 配对）')
      .toBeGreaterThan(toolIdx)
  })

  it('无图片时不误报（纯文本与纯文本工具结果照常放行）', async () => {
    // 反向对照：收集器不能把「没有图片」判成「有图片」，
    // 否则所有带工具结果的会话都会被这条守卫拒掉。
    const { adapter, fetcher } = makeAdapter({ responses: [okResponse()] })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }] },
      ],
    } as unknown as GenerateOptions)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // ⚠️ 且无图时必须**仍然产出字符串 content**（不升级成多模态 parts）——
    // 线上格式逐字节不变，避免破坏前缀缓存。
    const contents = sentBody(fetcher).contents as Array<{ parts: Array<Record<string, unknown>> }>
    expect(contents.flatMap((c) => c.parts).some((p) => p.inline_data !== undefined)).toBe(false)
  })

  it('读取抛错时冒泡成可读的 LlmError（不静默丢图）', async () => {
    const { adapter } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => { throw new Error('附件已损坏') },
    })
    const error = await collect(adapter, imageOptions()).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect((error as Error).message).toContain('附件已损坏')
  })

  it('读取到空字节同样报错（不得发出一个空图 part）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: new Uint8Array(0), mediaType: 'image/png' }),
    })
    const error = await collect(adapter, imageOptions()).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('⚠️ 未知模型 id 带图时保守拒绝（能力无从得知，发过去会被静默忽略）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [okResponse()],
      readImage: async () => ({ data: PNG_BYTES, mediaType: 'image/png' }),
    })
    const error = await collect(adapter, imageOptions({ model: 'hand-typed-unknown' } as Partial<GenerateOptions>))
      .catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SSE → StreamChunk
// ---------------------------------------------------------------------------

describe('AccioAdapter · SSE 转换', () => {
  it('正文与思考各自成块（thought 不得混入正文）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([thoughtPart('想想')]),
        frame([textPart('你好')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const kinds = chunks.filter((c) => c.type === 'block-start').map((c) => (c as { blockType: string }).blockType)
    expect(kinds).toEqual(['reasoning', 'text'])
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(reasoning).toBe('想想')
    expect(text).toBe('你好')
  })

  it('usage 与 finish 正常收尾', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([textPart('好')]),
        { content: { role: 'model', parts: [] }, usage_metadata: { prompt_token_count: 3, candidates_token_count: 1, total_token_count: 4 } },
        { turn_complete: true, finish_reason: 'stop' },
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.some((c) => c.type === 'usage')).toBe(true)
    const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('stop')
  })
})

describe('AccioAdapter · 工具调用分片合并（实测缺陷回归）', () => {
  /**
   * 实测（2026-10-13，三轮取样）上游把**一次**工具调用拆成多帧：
   * 首帧 `{id,name}`（无 `args_json`），后续帧**重复完整的** `args_json`。
   * `consumeAccioSse` 不跨帧合并 ⇒ 会产出 N 个独立 tool-call 块
   * （首块参数 `{}`，后续块参数完整）⇒ harness 会执行 **3 次**同一个工具调用。
   * 合并职责归适配器（设计如此）。
   */
  const SHARDED = [
    frame([callPart('call_1', 'read_file')]),
    frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
    frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
  ]

  it('⚠️ 三帧分片合并成**恰好一个** tool-call 块，且参数完整', async () => {
    const { adapter } = makeAdapter({ responses: [sseResponse(accioSse(...SHARDED))] })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const toolEnds = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolEnds, '分片必须合并成一个调用').toHaveLength(1)
    const block = (toolEnds[0] as { block: { name: string; arguments: string } }).block
    expect(block.name).toBe('read_file')
    expect(JSON.parse(block.arguments)).toEqual({ file_path: 'a.txt' })
    const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('tool-calls')
  })

  it('两个**参数不同**的并行调用不被误合并', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([callPart('call_a', 'read_file')]),
        frame([callPart('call_a', 'read_file', '{"file_path":"a.txt"}')]),
        frame([callPart('call_a', 'read_file', '{"file_path":"a.txt"}')]),
        frame([callPart('call_b', 'read_file')]),
        frame([callPart('call_b', 'read_file', '{"file_path":"b.txt"}')]),
        frame([callPart('call_b', 'read_file', '{"file_path":"b.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const args = chunks
      .filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
      .map((c) => JSON.parse((c as { block: { arguments: string } }).block.arguments) as Record<string, unknown>)
    expect(args).toHaveLength(2)
    expect(args.map((a) => a.file_path).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('单个完整帧（无分片）原样透传', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const toolEnds = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolEnds).toHaveLength(1)
    expect(JSON.parse((toolEnds[0] as { block: { arguments: string } }).block.arguments))
      .toEqual({ file_path: 'a.txt' })
  })

  it('工具调用与正文并存时，正文块不受合并影响', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([textPart('让我看看')]),
        frame([callPart('call_1', 'read_file')]),
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('让我看看')
    expect(chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')).toHaveLength(1)
  })

  it('⚠️ 同一帧里 text 与 function_call 并存时，正文不得被吞掉', async () => {
    // 真实缺陷（自审抓到）：合并层若把**整帧**吸收进缓冲，同一帧里的
    // `text` part 会**静默消失** —— 模型写的话凭空不见，且没有任何报错。
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([textPart('我要读文件'), callPart('call_1', 'read_file')]),
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text, '同帧正文不得被静默丢弃').toBe('我要读文件')
    const toolEnds = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolEnds).toHaveLength(1)
    expect(JSON.parse((toolEnds[0] as { block: { arguments: string } }).block.arguments))
      .toEqual({ file_path: 'a.txt' })
  })

  it('⚠️ 同帧里的 thought part 也不得被吞掉', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(accioSse(
        frame([thoughtPart('需要读文件'), callPart('call_1', 'read_file')]),
        frame([callPart('call_1', 'read_file', '{"file_path":"a.txt"}')]),
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { text: string }).text).join('')
    expect(reasoning, '同帧思考不得被静默丢弃').toBe('需要读文件')
  })
})

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

describe('AccioAdapter · 错误分类', () => {
  it('⚠️ 流内 402 ⇒ QUOTA_EXCEEDED（不得归 SERVER，否则白重试 5 次）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse('data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n')],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('流内 402 的文案逐字保留服务端原文（便于排障）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse('data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n')],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { message: string }).message).toContain('unauthorized')
  })

  it('HTTP 402 ⇒ QUOTA_EXCEEDED', async () => {
    const { adapter } = makeAdapter({
      responses: [new Response('{"error":"insufficient balance"}', { status: 402 })],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('HTTP 401 ⇒ AUTH（且刷新一次凭据后重试）', async () => {
    const { adapter, fetcher, refresh } = makeAdapter({
      responses: [
        new Response('unauthorized', { status: 401 }),
        sseResponse(accioSse(frame([textPart('好了')]))),
      ],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(refresh).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('⚠️⚠️ 401 重试必须带**刷新后的新 token**（旧 token 在 body 里，不是请求头）', async () => {
    // 真实缺陷（本轮修复）：令牌在 `body.token`，而 `send()` 只从 `credential`
    // 取 `sgcookie` **请求头** ⇒ 刷新后沿用同一个 `body` 就是「重发旧 token」，
    // 该分支结构性失效，且 `AUTH` 不在 harness 的可重试集合里 ⇒ 本可自愈的
    // 凭据退化成硬失败 + 白烧一次 refresh_token。
    //
    // ⚠️ 本用例的关键是 `credentialAfterRefresh`：若 refresh 前后都返回 `'OLD'`
    // （既有那条用例的桩），**旧实现照样通过** —— 那样的用例抓不到这个缺陷。
    const { adapter, fetcher, refresh } = makeAdapter({
      credential: makeCredential({ access_token: 'OLD' }),
      credentialAfterRefresh: makeCredential({ access_token: 'NEW' }),
      responses: [
        new Response('unauthorized', { status: 401 }),
        sseResponse(accioSse(frame([textPart('好了')]))),
      ],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    // 断言**两次真实请求体**（不是断言实现细节）。
    expect(sentBody(fetcher, 0).token, '首次必须用刷新前的 token').toBe('OLD')
    expect(sentBody(fetcher, 1).token, '重试必须用刷新后的 token').toBe('NEW')
    // ⚠️ 同一次逻辑请求：`message_id` / `request_id` 不得因重试而改变
    // （重建 body 会经 `accioMessageId()` 掺入新随机量，等于换了请求身份）。
    expect(sentBody(fetcher, 1).message_id).toBe(sentBody(fetcher, 0).message_id)
    expect(sentBody(fetcher, 1).request_id).toBe(sentBody(fetcher, 0).request_id)
    // 重试成功后照常产出内容（证明它真的能自愈）。
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('HTTP 403 同样刷新后带新 token 重试（与 401 同一分支）', async () => {
    const { adapter, fetcher } = makeAdapter({
      credential: makeCredential({ access_token: 'OLD' }),
      credentialAfterRefresh: makeCredential({ access_token: 'NEW' }),
      responses: [
        new Response('forbidden', { status: 403 }),
        sseResponse(accioSse(frame([textPart('好了')]))),
      ],
    })
    await collect(adapter, BASIC_OPTIONS)
    expect(sentBody(fetcher, 0).token).toBe('OLD')
    expect(sentBody(fetcher, 1).token).toBe('NEW')
  })

  it('HTTP 500 ⇒ SERVER（可重试类）', async () => {
    const { adapter } = makeAdapter({ responses: [new Response('boom', { status: 500 })] })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('SERVER')
  })

  it('HTTP 429 ⇒ RATE_LIMIT', async () => {
    const { adapter } = makeAdapter({ responses: [new Response('slow down', { status: 429 })] })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('RATE_LIMIT')
  })

  it('无可用凭据 ⇒ MISSING_CREDENTIAL', async () => {
    const { adapter } = makeAdapter({ credential: null })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('MISSING_CREDENTIAL')
  })

  it('凭据过期时先静默续期再发请求', async () => {
    const expired = makeCredential({ expires_at: Date.now() - 1000 })
    const { adapter, refresh } = makeAdapter({
      credential: expired,
      responses: [sseResponse(accioSse(frame([textPart('好')])))],
    })
    await collect(adapter, BASIC_OPTIONS)
    expect(refresh).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// prepareCall
// ---------------------------------------------------------------------------

describe('AccioAdapter · prepareCall', () => {
  it('返回模型信息与绑定的 stream 函数（PR !66：必须包 prepareCall）', async () => {
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [{ id: '1Nova-Q3xM8vJ1rH6z', name: 'Qwen', contextWindow: 512_000, multiple: 0.013 }],
      responses: [sseResponse(accioSse(frame([textPart('好')])))],
    })
    const prepared = await adapter.prepareCall(ACCIO_PROVIDER, 'qwen')
    expect(prepared.model.id).toBe('qwen')
    expect(prepared.model.context?.contextWindow).toBe(512_000)
    expect(typeof prepared.stream).toBe('function')
    // 经 prepareCall 返回的 stream 必须真能发请求（不是空壳）。
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...BASIC_OPTIONS, model: 'qwen' } as GenerateOptions)) chunks.push(chunk)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // ⚠️ **上行必须是上游 `modelCode`**（不是 slug）—— `prepareCall` 路径同样走
    //    `stream`，若那条缝里漏了映射，这里的断言会红。
    expect(sentBody(fetcher).model).toBe('1Nova-Q3xM8vJ1rH6z')
  })
})
