import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  ClineAdapter,
  isClineRotatableFailure,
  sanitizeClineToolParameters,
} from '../../src/cline-adapter.js'
import { recordsClineRateLimit } from '../../src/cline-rate-limit.js'
import { CLINE } from '../../src/cline-product.js'
import { mergeClineModels, type ClineModel } from '../../src/cline-models.js'
import type { ClineCredential } from '../../src/cline.js'
import {
  readClineRequestHistory,
  resetClineRequestHistory,
} from '../../src/cline-request-log.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 账号池里的账号 id。
 *
 * ⚠️ 它与 {@link cred} 里的 `account_id`（`usr-…`）是**两个 id 空间** ——
 * 「请求记录中数据空白」这个真实缺陷的根因就是两者被混用。
 */
const POOL_ACCOUNT_ID = 'cline-bb211a53'

/** 实测凭据形态（access_token 自带 workos: 前缀）。 */
const cred: ClineCredential = {
  access_token: 'workos:eyJhbGciOiJSUzI1NiIs',
  refresh_token: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
  expire_time: Date.now() + 3_600_000,
  account_id: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
  email: 'ijetlee@163.com',
  nickname: 'ijetlee@163.com',
}

/**
 * 固定目录（离线；含免费与付费条目）。
 *
 * ⚠️ 远端列表**必须覆盖兜底表的全部 id**：`mergeClineModels` 会丢弃「远端已不认识」
 * 的兜底条目（修「已下架模型被复活」，见 `src/cline-models.ts` 第 2 步）——
 * 若这里只列历史条目，兜底表其余条目会被过滤掉，下游用例就拿不到它们的元数据。
 * 真实远端本来就覆盖兜底表（兜底表正是按远端实测同步的），故这样写也更贴近生产。
 */
const MODELS: ClineModel[] = mergeClineModels(CLINE, {
  freeIds: [
    ...CLINE.fallbackModels.map((m) => m.id),
    'cline-free/deepseek-v4.1-flash',
    'cline-free/gemini-3.8-flash',
  ],
  remoteIds: ['deepseek/deepseek-v4.1-flash', 'openai/gpt-6-luna'],
  entries: [
    ...CLINE.fallbackModels.map((m) => ({ id: m.id })),
    { id: 'cline-free/deepseek-v4.1-flash', name: 'Deepseek-v4.1-Flash' },
    { id: 'cline-free/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  ],
})

/** 构造适配器（默认注入凭据 + 固定目录，完全离线）。 */
function makeAdapter(overrides: Partial<ConstructorParameters<typeof ClineAdapter>[0]> = {}): ClineAdapter {
  return new ClineAdapter({
    credentialRef: { name: 'CLINE_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: CLINE,
    loadModels: async () => ({ models: MODELS, warnings: [] }),
    // ⚠️ models.dev 目录也必须注入：默认加载器会去拉真实网络。
    // 空表 = 「没读到」，各用例按需覆盖。
    loadModelsDev: async () => new Map(),
    ...overrides,
  })
}

/** 标准 OpenAI SSE 帧。 */
function sseResponse(frames: string[]): Response {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * **逐帧延迟**下发的 SSE —— 用来把 `ttft`（首块）与 `ttfc`（首个正文块）
 * 在时间上分开。`sseResponse` 一次性给完，两者会落在同一毫秒上，测不出区别。
 */
function slowSseResponse(frames: Array<{ delayMs: number; payload: string }>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      for (const frame of frames) {
        await new Promise((resolve) => setTimeout(resolve, frame.delayMs))
        controller.enqueue(encoder.encode(`data: ${frame.payload}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(
  adapter: ClineAdapter,
  options: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream({
    model: 'cline-free/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...options,
  } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('ClineAdapter 模型目录', () => {
  it('免费模型在 name 里标出（远端 free 集合驱动）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))
    // 展示名优先取**兜底表**（内嵌目录的正式名，与 Cline IDE 显示一致），
    // 而非由 id 派生的 slug（`MiMo-V2.6-Flash` vs `Mimo V2.6 Flash`）。
    // 标记统一由 clineDisplayName 拼。
    //
    // ⚠️ 原先这里用 `cline-free/deepseek-v4.1-flash`；它已于 2026-10-05 被 Cline
    // 下架、随之从兜底表删除，故改用仍在册的免费条目（否则断言的是远端 slug，
    // 测不到「兜底表名优先」这条规则）。
    expect(byId.get('cline-free/mimo-v2.6-flash')?.name).toBe('MiMo-V2.6-Flash · 免费')
    expect(byId.get('cline-free/gemini-3.8-flash')?.name).toBe('Gemini 3.8 Flash · 免费')
  })

  it('付费模型不标免费（同名但不同命名空间）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))
    // ⚠️ 核心不变式：`deepseek/deepseek-v4.1-flash` 是**另一个**计费实体
    expect(byId.get('deepseek/deepseek-v4.1-flash')?.name).not.toContain('免费')
    expect(byId.get('openai/gpt-6-luna')?.name).not.toContain('免费')
  })

  it('目录含远端全部模型（用户要求「全部列出」）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const ids = models.map((m) => m.id)
    expect(ids).toContain('cline-free/deepseek-v4.1-flash')
    expect(ids).toContain('deepseek/deepseek-v4.1-flash')
    expect(ids).toContain('openai/gpt-6-luna')
  })

  it('listAllModels 也带免费标记（设置页能看到正确展示名）', () => {
    const adapter = makeAdapter()
    const models = adapter.listAllModels()
    // ⚠️ 这条走的是**同步兜底表**路径（没有前置 await，`remoteModels` 尚未落地），
    // 故只能用**兜底表里存在**的条目断言。`cline-free/deepseek-v4.1-flash` 已于
    // 2026-10-05 被 Cline 下架、随之从兜底表删除。
    const entry = models.find((m) => m.id === 'cline-free/mimo-v2.6-flash')
    expect(entry?.name).toBe('MiMo-V2.6-Flash · 免费')
  })

  it('未加载完成时 listAllModels 回退兜底表（含全部兜底免费模型）', () => {
    const adapter = makeAdapter({ loadModels: async () => { throw new Error('offline') } })
    const models = adapter.listAllModels()
    expect(models.length).toBe(CLINE.fallbackModels.length)
    // 与表联动断言，不写死数字：上游每次撤免费模型都要同步这张表，
    // 写死会让「同步表」这个动作连带弄红一个无关用例（本文件此前正是 4）。
    expect(models.filter((m) => m.name.includes('免费'))).toHaveLength(CLINE.fallbackModels.length)
  })

  it('远端目录两个端点都失败时仍返回兜底表', async () => {
    const adapter = makeAdapter({
      loadModels: async () => ({ models: [], warnings: ['recommended-models boom', 'models boom'] }),
    })
    const models = await adapter.listModels('cline')
    expect(models.length).toBe(CLINE.fallbackModels.length)
    expect(models.filter((m) => m.name.includes('免费'))).toHaveLength(CLINE.fallbackModels.length)
  })

  it('黑名单过滤只作用于 listModels，不影响 listAllModels', async () => {
    const disabled = new Set(['cline-free/deepseek-v4.1-flash'])
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => disabled,
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const listed = await adapter.listModels('cline')
    expect(listed.map((m) => m.id)).not.toContain('cline-free/deepseek-v4.1-flash')
    // 设置页必须仍能看到它（否则无法重新打开）
    expect(adapter.listAllModels().map((m) => m.id)).toContain('cline-free/deepseek-v4.1-flash')
  })

  it('没有任何已登录账号时返回空数组（目录门控）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect(await adapter.listModels('cline')).toEqual([])
  })

  it('目录门控不可用（替身未实现 hasLoggedInAccount）时保守放行', async () => {
    const adapter = makeAdapter({ accountPool: { disabledModelsFor: () => new Set<string>() } as never })
    expect((await adapter.listModels('cline')).length).toBeGreaterThan(0)
  })
})

describe('ClineAdapter resolveModel', () => {
  // ⚠️ 本组原先统一用 `cline-free/deepseek-v4.1-flash` 作「有完整元数据的模型」，
  // 它已于 2026-10-05 被 Cline 下架、随之从兜底表删除 ⇒ 元数据不再来自兜底表。
  // 改用仍在册的免费条目 `cline-free/mimo-v2.6-flash`（兜底表里的
  // contextWindow / maxTokens / supportsImage 与原条目取值相同，断言不变）。
  const METADATA_MODEL = 'cline-free/mimo-v2.6-flash'

  it('name 不带免费标记（标记只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', METADATA_MODEL)
    expect(resolved.name).toBe('MiMo-V2.6-Flash')
    expect(resolved.name).not.toContain('免费')
  })

  it('声明 defaultMaxTokens（否则上限永久退回网关默认值）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', METADATA_MODEL)
    expect(resolved.defaultMaxTokens).toBe(131_072)
  })

  it('声明 context（内嵌目录的 contextWindow）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', METADATA_MODEL)
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('未知模型不编造 context / defaultMaxTokens', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
    expect(resolved.name).toBe('unknown/model-x')
  })

  it('inputModalities 按模型判定（图片能力）', async () => {
    const adapter = makeAdapter()
    const withImage = await adapter.resolveModel('cline', METADATA_MODEL)
    expect(withImage.inputModalities).toContain('image')
    const unknown = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(unknown.inputModalities).toEqual(['text'])
  })

  it('声明 5 档思考强度（顺序与展示名对齐 Cline IDE）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    // ⚠️ id 是发给上游的 wire 值，name 是 IDE 上的展示名，两者**刻意不同**：
    // 最高档 wire 是 `max`，展示是 `Extra`（xhigh 实测与 high 无差异，故跳过）。
    expect(resolved.reasoning?.efforts).toEqual([
      { id: 'none', name: 'None' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Extra' },
    ])
  })

  it('默认档位是 high（对齐 IDE 截图的选中态）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('未知模型同样有 5 档（覆盖范围决策：统一给，不按目录细分）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(resolved.reasoning?.efforts).toHaveLength(5)
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })
})

describe('ClineAdapter 请求构造', () => {
  it('POST 到 OpenAI 兼容端点，鉴权头保留 workos: 前缀', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const adapter = makeAdapter({
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(calls[0]!.url).toBe('https://api.cline.bot/api/v1/chat/completions')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer workos:eyJhbGciOiJSUzI1NiIs')
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk')
    expect(headers.Accept).toBe('text/event-stream')
  })

  it('请求体是标准 OpenAI 形状（model / messages / stream）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>
    expect(body.model).toBe('cline-free/deepseek-v4.1-flash')
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('system 提示并入 messages 顶部', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { system: 'be terse' })
    const body = JSON.parse(bodies[0]!) as { messages: Array<{ role: string }> }
    expect(body.messages[0]!.role).toBe('system')
  })

  it('工具定义真的下发（顶层 tools，OpenAI 风格）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, {
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
    })
    const body = JSON.parse(bodies[0]!) as { tools: Array<{ type: string; function: { name: string } }> }
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.type).toBe('function')
    expect(body.tools[0]!.function.name).toBe('read_file')
  })

  it('工具 schema 的空串 enum 被清洗（否则 Gemini 系 400）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    // 复刻真实报障：harness 下发的 permission 参数 enum 含空串成员（第 4 项）。
    // 上游原话：GenerateContentRequest.tools[0].function_declarations[34]
    //           .parameters.properties[permission].enum[3]: cannot be empty
    await collect(adapter, {
      tools: [{
        name: 'set_permission',
        description: 'switch preset',
        parameters: {
          type: 'object',
          properties: {
            permission: { type: 'string', enum: ['read', 'write', 'execute', ''] },
          },
        },
      }],
    })
    const body = JSON.parse(bodies[0]!) as {
      tools: Array<{ function: { parameters: { properties: { permission: { enum: string[] } } } } }>
    }
    expect(body.tools[0]!.function.parameters.properties.permission.enum)
      .toEqual(['read', 'write', 'execute'])
  })

  it('enum 清洗的三条边界（只删空串 / 保留数值 / 全空则丢弃键 / 递归下钻）', () => {
    // ① 数值枚举不能被「只留字符串」的过滤整段丢掉
    expect(sanitizeClineToolParameters({
      properties: { level: { enum: [1, 2, 3] } },
    })).toEqual({ properties: { level: { enum: [1, 2, 3] } } })
    // ② 纯空白同样算空；③ 过滤后为空则整个 enum 键消失（空 enum 同样非法）
    expect(sanitizeClineToolParameters({ mode: { enum: ['   ', 'ok'] } }))
      .toEqual({ mode: { enum: ['ok'] } })
    expect(sanitizeClineToolParameters({ mode: { enum: ['', '  '] } }))
      .toEqual({ mode: {} })
    // ④ 嵌套层（properties / items）里的 enum 同罪
    expect(sanitizeClineToolParameters({
      properties: { nested: { items: { enum: ['a', ''] } } },
    })).toEqual({ properties: { nested: { items: { enum: ['a'] } } } })
    // ⑤ 非对象原样透传
    expect(sanitizeClineToolParameters('plain')).toBe('plain')
    expect(sanitizeClineToolParameters(null)).toBe(null)
  })

  it('max_tokens 收敛到安全上限（不编造、不超界）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { maxTokens: 9_999_999 })
    const body = JSON.parse(bodies[0]!) as { max_tokens: number }
    expect(body.max_tokens).toBe(943_718)
  })

  it('reasoningEffort 透传为 reasoning_effort', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { reasoningEffort: 'high' })
    expect((JSON.parse(bodies[0]!) as { reasoning_effort: string }).reasoning_effort).toBe('high')
  })

  it('不在请求构造处过滤档位（上游新增档位不能被静默丢弃）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    // `xhigh` 是内嵌目录里有、但本插件档位表未收录的 wire 值（实测与 high 无差异）。
    // 即便如此也必须原样发出：白名单校验会把上游未来新增的档位变成静默丢弃。
    await collect(adapter, { reasoningEffort: 'xhigh' })
    expect((JSON.parse(bodies[0]!) as { reasoning_effort: string }).reasoning_effort).toBe('xhigh')
  })

  it('无凭据时报 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toThrow(/no usable credential/)
  })

  it('凭据过期时先续期再取新凭据', async () => {
    let refreshed = false
    const adapter = makeAdapter({
      resolveCredential: async () => (refreshed
        ? { ...cred, access_token: 'workos:new-token' }
        : { ...cred, expire_time: 1 }),
      refresh: async () => { refreshed = true },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer workos:new-token')
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(refreshed).toBe(true)
  })
})

describe('ClineAdapter SSE 消费', () => {
  /**
   * ⚠️ **Cline 的思考字段是 `delta.reasoning`**，不是 `reasoning_content`。
   * 实测形态：`{"delta":{"reasoning":"The","reasoning_details":[…]}}`。
   * 只认后者会让思考内容被静默丢弃（用户看到「模型不思考」）。
   */
  it('消费 delta.reasoning 为 reasoning 块（Cline 特有字段名）', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning: 'Let me think', reasoning_details: [{ type: 'reasoning.text', text: 'Let me think' }] } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'PONG' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    expect(reasoning).toBe('Let me think')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    expect(text).toBe('PONG')
  })

  it('仍然消费 reasoning_content（Qoder / buddy 形态不回归）', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')).toBe('thinking')
  })

  it('工具调用按 index 合并', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    const end = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string })?.type === 'tool-call')
    expect(end).toBeDefined()
    expect((end!.block as { name: string }).name).toBe('read_file')
  })
})

describe('ClineAdapter 限流与换号判定', () => {
  it('429 / 402 可换号', () => {
    expect(isClineRotatableFailure(429, '')).toBe(true)
    expect(isClineRotatableFailure(402, '')).toBe(true)
  })

  it('额度文案命中可换号（中英双通道）', () => {
    expect(isClineRotatableFailure(400, 'insufficient credit')).toBe(true)
    expect(isClineRotatableFailure(400, '积分不足')).toBe(true)
  })

  it('400 请求格式错 / 5xx 服务端故障不换号（换号无用）', () => {
    expect(isClineRotatableFailure(400, 'invalid request format')).toBe(false)
    expect(isClineRotatableFailure(500, 'internal error')).toBe(false)
  })

  it('★ 只有 429 记限流徽章 —— 402（额度耗尽）没有「多久后重置」可言', () => {
    // 徽章的含义是「受限，某时刻后可能自动解禁」。402 是 Cline 官方文档里的
    // `Insufficient credits`（去 app.cline.bot 充值），记成 60 分钟倒计时会让用户白等
    // ——真实报障：「倒计时结束了我再去连为什么还是失败了，显示要 60 分钟后？」
    // 与 `recordsLobsteraiRateLimit` 同约定：不写徽章 **≠** 不换号（402 仍会换号）。
    expect(recordsClineRateLimit(429, '')).toBe(true)
    expect(recordsClineRateLimit(402, '')).toBe(false)
    expect(recordsClineRateLimit(400, 'insufficient credit')).toBe(false)
    // 换号判据不受影响：402 仍值得试下一个账号（它可能有余额）。
    expect(isClineRotatableFailure(402, '')).toBe(true)
  })

  it('地域限制（403 not available in your region）不被误判为凭据问题，且不白跑续期', async () => {
    let refreshed = 0
    const adapter = makeAdapter({
      refresh: async () => { refreshed += 1 },
      fetchImpl: (async () => new Response(
        JSON.stringify({ error: 'access forbidden: cline-free/muse-spark-1.3-contributor is not available in your region', success: false }),
        { status: 403 },
      )) as unknown as typeof fetch,
    })
    await expect(collect(adapter)).rejects.toThrow(/region|不可用/)
    // ⚠️ 该 403 与凭据无关，续期一次都是浪费 —— 修复前会白跑一次
    expect(refreshed).toBe(0)
  })

  it('地域限制的错误码不是 AUTH（否则 UI 会显示「API 密钥无效」掩盖真实原因）', async () => {
    // ⚠️ 客户端的 failureMessage() 是 `code === "AUTH" ? "API 密钥无效" : message`
    // —— 只要被归成 AUTH，真实原因就彻底丢失。故这里断言**错误码**，
    // 只断言 message 是恒真的（旧代码原样透传错误体，文案也匹配）。
    const adapter = makeAdapter({
      fetchImpl: (async () => new Response(
        JSON.stringify({ error: 'access forbidden: x is not available in your region' }),
        { status: 403 },
      )) as unknown as typeof fetch,
    })
    let code = ''
    try {
      await collect(adapter)
    } catch (error) {
      code = String((error as { code?: string }).code ?? '')
    }
    expect(code).not.toBe('AUTH')
    expect(code).toBe('PERMISSION_DENIED')
  })

  it('真正的 401 仍然会续期重试（地域判定不能误伤认证路径）', async () => {
    let refreshed = 0
    let call = 0
    const adapter = makeAdapter({
      resolveCredential: async () => (refreshed > 0
        ? { ...cred, access_token: 'workos:new-token' }
        : cred),
      refresh: async () => { refreshed += 1 },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        call += 1
        // 第一次 401（凭据问题），第二次用新凭据成功
        if (call === 1) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(refreshed).toBe(1)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('限流时换到下一个账号并成功', async () => {
    let call = 0
    const adapter = makeAdapter({
      resolveCredential: async () => cred,
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => true,
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => ({
          entry: { id: 'acc-2', credentialRef: 'CLINE_ACCOUNT_2' },
          credential: { ...cred, access_token: 'workos:second' },
        }),
      } as never,
      fetchImpl: (async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(call).toBe(2)
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
  })
})

/**
 * 限流标记**写多长**、以及全部账号失败时**报什么**。
 *
 * ## 真实报障（2026-10-03）
 *
 * 用户：「倒计时结束了我再去连为什么还是失败了，显示要 60 分钟后？」
 *
 * 两处根因：① 标记写的一直是 `Date.now() + 60 分钟`（**忽略了 Cline 在 429 上
 * 给出的真实 `retry-after`**），而且每次失败都从当下重新计一遍 —— 用户等完再试，
 * 只要上游仍拒绝就还是「60 分钟后」；② 402（额度耗尽）被一视同仁地记成 60 分钟，
 * 而它**永远**不会因为等而恢复。③ 全部账号失败时的报错把状态码与上游文案都丢了，
 * 用户（与排障的人）分不出该等还是该去充值。
 */
describe('Cline 限流标记：用服务端给的时间，402 不倒数', () => {
  type MarkCall = { accountId: string; model: string; resetAtMs: number }

  /** 桩池：记录标记调用，且**永不**给出下一个账号（让失败路径直接走到最终报错）。 */
  function poolStub(calls: MarkCall[]) {
    return {
      disabledModelsFor: () => new Set<string>(),
      hasLoggedInAccount: async () => true,
      updateModelRateLimit: async (accountId: string, model: string, resetAtMs: number) => {
        calls.push({ accountId, model, resetAtMs })
      },
      getAvailableAccount: async () => null,
    } as never
  }

  const responds = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch

  it('★ 429 带 retry-after → 标记用服务端给的秒数（不再是写死的 1 小时）', async () => {
    const calls: MarkCall[] = []
    const before = Date.now()
    const adapter = makeAdapter({
      currentAccountId: () => 'acc-1',
      accountPool: poolStub(calls),
      fetchImpl: responds(429, { error: { message: 'rate limit exceeded' } }, { 'retry-after': '600' }),
    })
    await expect(collect(adapter)).rejects.toThrow(/429/)
    expect(calls).toHaveLength(1)
    expect(calls[0].accountId).toBe('acc-1')
    expect(calls[0].model).toBe('cline-free/deepseek-v4.1-flash')
    // 600 秒（± 执行耗时）；关键是**远小于** 1 小时，即真的读了响应头。
    expect(calls[0].resetAtMs - before).toBeGreaterThan(590_000)
    expect(calls[0].resetAtMs - before).toBeLessThan(610_000)
  })

  it('429 没给 retry-after → 退到快照式兜底（1 小时，与 buddy 同口径）', async () => {
    const calls: MarkCall[] = []
    const before = Date.now()
    const adapter = makeAdapter({
      currentAccountId: () => 'acc-1',
      accountPool: poolStub(calls),
      fetchImpl: responds(429, { error: 'too many requests' }),
    })
    await expect(collect(adapter)).rejects.toThrow(/429/)
    expect(calls).toHaveLength(1)
    expect(calls[0].resetAtMs - before).toBeGreaterThan(3_500_000)
    expect(calls[0].resetAtMs - before).toBeLessThan(3_700_000)
  })

  it('retry-after 是 HTTP 日期时同样采用', async () => {
    const calls: MarkCall[] = []
    const before = Date.now()
    const adapter = makeAdapter({
      currentAccountId: () => 'acc-1',
      accountPool: poolStub(calls),
      fetchImpl: responds(429, { error: 'slow down' }, { 'retry-after': new Date(before + 120_000).toUTCString() }),
    })
    await expect(collect(adapter)).rejects.toThrow(/429/)
    expect(calls[0].resetAtMs - before).toBeGreaterThan(110_000)
    expect(calls[0].resetAtMs - before).toBeLessThan(130_000)
  })

  /**
   * ⚠️ **实测报文**（2026-10-03 23:10 直连 Cline，见 `probe-cline-live.mjs`）：
   * 只有 429 + `no-retry: true`，**没有 `retry-after` 头**，等待时长写在英文
   * 句子里（`Try again in 19h 39m`）。用户第二次报障「还是 60 分钟」就是这条。
   */
  const REAL_DAILY_FREE = {
    error: {
      code: 'INFERENCE_CAP_ERROR',
      message: 'Error 429: Daily free limit reached on model deepseek/deepseek-v4.1-flash. Try again in 19h 39m',
    },
  }

  it('★ 实测的「当日免费额度」429 → 标记写服务端给的 19 小时 39 分，且文案简短、不复述原文', async () => {
    const calls: MarkCall[] = []
    const before = Date.now()
    const adapter = makeAdapter({
      currentAccountId: () => 'acc-1',
      accountPool: poolStub(calls),
      fetchImpl: responds(429, REAL_DAILY_FREE),
    })
    const error = await collect(adapter).catch((e: Error) => e as Error)
    expect(calls).toHaveLength(1)
    const waitMs = calls[0].resetAtMs - before
    expect(waitMs).toBeGreaterThan(((19 * 60) + 39) * 60_000 - 1_000)
    expect(waitMs).toBeLessThan(((19 * 60) + 39) * 60_000 + 1_000)
    // ⚠️ **不再复述上游英文原文**（用户 2026-10-03 报障「比其它供应商长太多」）：
    // 语义由我们的文案表达，原文复述会与中文解释重复一遍。判据反过来断言。
    expect(error.message).not.toContain('Daily free limit reached')
    expect(error.message).toContain('当日免费额度已用尽')
    // 动作必须说清：等不到头（按天结算 + 按模型单独计）+ 换另一个免费模型。
    expect(error.message).toContain('按天结算')
    expect(error.message).toContain('按模型单独计')
    // ⚠️ **不能**建议 cline-pass：实测本账号 403 ENTITLEMENT_ERROR（有余额、无订阅）。
    expect(error.message).not.toContain('cline-pass')
    // 解禁时刻（本地时钟）与「预计 N 小时后重置」都要有。
    expect(error.message).toMatch(/预计 \d+(\.\d)? 小时后重置（\d{4}\/\d{1,2}\/\d{1,2}/)
    // ⚠️ 长度上限：这条消息原先 ≈ 270 字符，是其它 provider 的两三倍。
    expect(error.message.length).toBeLessThan(150)
  })

  it('★ 换号预算用尽时，**最后**一个账号也必须被标记（否则下一轮又选回它）', async () => {
    // 原实现把标记写在**下一轮的开头**，于是「轮次用尽而退出」时最后一个账号
    // 永远不会被标记 —— 本机 cline 只有一个账号，这条尤其致命：失败后它仍被
    // 判定为可用，下一次请求立刻再撞一次同样的墙。
    const calls: MarkCall[] = []
    let next = 0
    const accounts = ['acc-2', 'acc-3']
    const adapter = makeAdapter({
      currentAccountId: () => 'acc-1',
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => true,
        updateModelRateLimit: async (accountId: string, model: string, resetAtMs: number) => {
          calls.push({ accountId, model, resetAtMs })
        },
        getAvailableAccount: async () => {
          const id = accounts[next]
          next += 1
          return id === undefined ? null : { entry: { id }, credential: cred }
        },
      } as never,
      fetchImpl: responds(429, { error: { message: 'rate limit exceeded' } }),
    })
    await expect(collect(adapter)).rejects.toThrow(/429/)
    expect(calls.map((c) => c.accountId)).toEqual(['acc-1', 'acc-2', 'acc-3'])
  })

  it('★ 402（额度耗尽）**不写**任何倒计时标记 —— 等多久都不会好', async () => {
    const calls: MarkCall[] = []
    const adapter = makeAdapter({
      currentAccountId: () => 'acc-1',
      accountPool: poolStub(calls),
      fetchImpl: responds(402, { error: { message: 'Insufficient credits' } }),
    })
    const error = await collect(adapter).catch((e: Error) => e as Error & { code?: string })
    expect(calls).toEqual([])
    expect(error.code).toBe('QUOTA_EXCEEDED')
    // 唯一有效的动作必须出现在文案里，否则用户只会去等。
    expect(error.message).toContain('402')
    expect(error.message).toContain('充值')
  })

  it('★ 全部账号失败时，报错带上真实状态码与上游文案（否则分不出「等」还是「充值」）', async () => {
    const adapter = makeAdapter({
      currentAccountId: () => 'acc-1',
      accountPool: poolStub([]),
      fetchImpl: responds(429, { error: { message: 'rate limit exceeded' } }),
    })
    const error = await collect(adapter).catch((e: Error) => e as Error)
    expect(error.message).toContain('HTTP 429')
    expect(error.message).toContain('rate limit exceeded')
    expect(error.message).toContain('限流')
    expect(error.message).toContain('cline-free/deepseek-v4.1-flash')
  })

  it('没有池账号（currentAccountId 为空）时不写标记，但仍如实报错', async () => {
    // ⚠️ 标记是按**池账号**记的（`modelRateLimits` 挂在账号条目上）：
    // 走单凭据 ref 的老模式没有账号条目，写标记会落到一个不存在的键上。
    const calls: MarkCall[] = []
    const adapter = makeAdapter({
      accountPool: poolStub(calls),
      fetchImpl: responds(429, { error: 'rate limit' }, { 'retry-after': '60' }),
    })
    await expect(collect(adapter)).rejects.toThrow(/429/)
    expect(calls).toEqual([])
  })
})

describe('Cline 接线（源码级回归）', () => {
  const root = resolve(here, '../..')
  const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

  it('index.ts 注册 cline 服务、适配器与续期', () => {
    const source = read('src/index.ts')
    expect(source).toContain('registerClineLlm')
    expect(source).toContain('new ClineAuth(ctx)')
    // 只断言「cline 在续期调度里、且真的被传了池」—— 用 `(pool|p)` 同时接受
    // 逐个 await 与表驱动两种写法，避免每次重构调度器都假失败。
    expect(source).toMatch(/cline\.refreshAll\((?:pool|p)\)/)
    expect(source).toContain('cline.stop()')
    // Jet Hub「显示列表」需要适配器实例
    expect(source).toMatch(/cline: pruned\([^)]*,\s*clineAdapter\)/)
    // ⚠️ 形参是**位置参数**，新增 provider 会插在 cline 与 modelAdapters 之间。
    // 只断言「cline 在 modelAdapters 之前」，**不要**写死整串前缀
    // —— 那会让每加一个 provider 都假失败（加 Loomy、Raccoon、QoderCN 时各踩一次）。
    // 之前的正则把 `…lobsterai, qoder, trae, cline,` 整段写死了，与这条注释矛盾，
    // 故改为只检查「cline 出现在 modelAdapters 之前」这一不变式。
    expect(source).toMatch(
      /registerJetHubRpc\([\s\S]*?cline,[\s\S]*?modelAdapters\)/,
    )
    // 老契约下的 settings namespace
    expect(source).toContain("'llm-cline'")
  })

  it('jet-hub-rpc.ts 为 cline 接上登录、续期与余额三个分派点', () => {
    const source = read('src/jet-hub-rpc.ts')
    expect(source).toContain('cline.startLogin({ refName })')
    // `[^)]*` 容忍签名扩展：续期成功后要把新 `expiresAt` 写回账号池，
    // 故调用点带着 `pool, entry.id`（issue !IKIRTT）—— 写死整串会一改签名就假失败。
    expect(source).toMatch(/cline\.refreshAccountCredential\(entry\.credentialRef[^)]*\)/)
    expect(source).toContain('fetchClineCreditBalance(credential, CLINE)')
    // 签到必须显式拒绝（而不是落到 unsupported provider 的泛化文案）
    expect(source).toContain('Cline 不支持每日签到')
  })

  it('客户端 PROVIDERS 含 cline 且有图标', () => {
    const source = read('plugin-src/client/jet-hub.js')
    expect(source).toMatch(/\{\s*id:\s*'cline',\s*label:\s*'Cline'/)
    expect(source).toContain('const CLINE_ICON')
  })

  /**
   * ⚠️ 这条原先断言**整段字面量** `{ balance: true, dailyCheckin: false }`，
   * 于是任何新增能力字段（如 `subscriptionQuota`）都会让它假失败 ——
   * 与上面那条「不要写死整串前缀」是同一类脆断言。
   * 改为逐字段断言，容忍新增字段与格式变化；而「订阅额度**只**给 cline」
   * 这条真正的不变式由 `credits-capabilities.spec.ts` 的行为级用例守住。
   */
  /**
   * ⚠️ 请求记录的**接线完整性**：stream() 有**两个**消费出口
   * （换号成功后的 consume 与正常路径的 consume），漏掉任何一个，
   * 那条路径上的请求就不会出现在「订阅额度 → 请求记录」里。
   * 两个出口都必须走 consumeWithLog（它内部再调 this.consume）。
   */
  it('推理流在两个消费出口都记录请求流水', () => {
    const source = read('src/cline-adapter.ts')
    expect(source.match(/yield\* this\.consumeWithLog\(/g)).toHaveLength(2)
    // 不得有绕过记录的消费出口（记录失败不反噬推理，但漏记会丢数据）
    expect(source).not.toMatch(/yield\* this\.consume\(/)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障「请求记录中数据空白，没有记录下来」）：
   * 请求记录的「账号」必须是**账号池 id**（`cline-bb211a53`），
   * **不是**凭据里的 `account_id`（`usr-…`）。
   *
   * 面板用 `cline.quota` 下发的**池 id** 去过滤记录（`cline.requestLog` 的
   * `accountId`），而成功路径原先记的是 `credential.account_id` ——
   * 两个 id 空间不一致 ⇒ `readClineRequestHistory({ accountId })` 恒返回空
   * ⇒ **表格永远空白**（换号路径记的却是池 id，两条路径口径还不一致，
   * 属同一缺陷的两半）。
   *
   * ⚠️ **反向验证**：把适配器改回 `credential.account_id ?? …` → 本用例变红。
   */
  it('请求记录归属「账号池 id」（不是凭据里的 usr- 用户 id）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      currentAccountId: () => POOL_ACCOUNT_ID,
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter)

    const rows = readClineRequestHistory()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.accountId).toBe(POOL_ACCOUNT_ID)
    // 关键：**不能**是凭据里的 `usr-…` —— 那正是空白的原因
    expect(rows[0]!.accountId).not.toBe(cred.account_id)
    // 面板用的过滤条件（池 id）必须能查到这一行，且用 usr-… 查不到
    expect(readClineRequestHistory({ accountId: POOL_ACCOUNT_ID })).toHaveLength(1)
    expect(readClineRequestHistory({ accountId: cred.account_id! })).toHaveLength(0)
  })

  /**
   * 没有池账号（回退到单凭据 `CLINE_ACCESS_TOKEN` 模式）时仍要记一行，
   * 只是退回凭据里的 `account_id` —— 那种模式下 `cline.quota` 同样没有账号
   * 可翻页，记录查不到但至少不丢数据、也不会张冠李戴。
   */
  it('无池账号时退回记凭据的 account_id（单凭据模式不丢记录）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(readClineRequestHistory()[0]!.accountId).toBe(cred.account_id)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障 2026-09-30）：「这个插件中支持图片的模型
   * 发送不了图片」。
   *
   * 根因：图片能力原先**只看本地兜底表**（全表只有寥寥几条 `cline-free/*`），
   * 于是 `cline-pass/*` 一律被播报成纯文本 ⇒ DSH 根本不把图片送进来。
   * 修复后补上 models.dev 这一级（见 `src/cline-modalities.ts`）。
   *
   * ⚠️ **反向验证**：注释掉 `inputModalitiesFor` 里 `remoteModalities` 那一行
   * → 本用例变红（抛 `不支持图片输入`）。
   */
  it('图片能力取自 models.dev：cline-pass/* 也能发图（不再被误判纯文本）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      loadModelsDev: async () => new Map([
        ['cline-pass/deepseek-v4.1-flash', { id: 'cline-pass/deepseek-v4.1-flash', supportsImage: true }],
      ]),
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ])
      }) as unknown as typeof fetch,
    })

    await collect(adapter, {
      model: 'cline-pass/deepseek-v4.1-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    })

    expect(bodies).toHaveLength(1)
    // 图片真的被内联成 data URL 发出去了
    expect(bodies[0]).toContain('"image_url"')
    expect(bodies[0]).toContain('data:image/png;base64,')
    expect(bodies[0]).not.toContain('[image unavailable]')
  })

  /** 模态表说「不支持」时照旧拒绝（不能为了修缺陷就无条件放行）。 */
  it('模态表明确不支持时仍拒绝图片（保守方向未失守）', async () => {
    const adapter = makeAdapter({
      loadModelsDev: async () => new Map([
        ['cline-pass/glm-5.3', { id: 'cline-pass/glm-5.3', supportsImage: false }],
      ]),
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      fetchImpl: (async () => sseResponse([])) as unknown as typeof fetch,
    })
    await expect(collect(adapter, {
      model: 'cline-pass/glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
    })).rejects.toThrow(/不支持图片输入/)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户两次报障：「上游显示的不正确」/「上游显示的还是错误的」）。
   *
   * 「上游」原先取模型 id 的 `/` 前缀（`cline-pass`），那是**订阅通道**、
   * 甚至可能是厂商名，不是 serving channel。修复后取网关下发的路由元数据
   * （`provider_metadata.gateway.routing.finalProvider`，参考实现同源）。
   *
   * ⚠️ **本用例的 fixture 必须用实测的真实形状**：第一版把路由写成**帧顶层**，
   * 而真实流式响应挂在 **`choices[0].delta`** 上 —— 于是用例绿、功能坏，
   * 用户第二次报障才暴露。**这就是「fixture 写错等于没有测试」的活例**：
   * 凡外部载荷的层级，只能照实测写（探针 `probe-cline-routing-live.mjs`）。
   */
  it('请求记录记下网关报的真实上游渠道（而不是模型前缀）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        // 实测量到的位置：`choices[0].delta.provider_metadata.gateway.routing.finalProvider`
        // （modelAttempts 是真实帧里同时存在的嵌套字段，防止解析器误取嵌套 provider）
        JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              provider_metadata: {
                gateway: {
                  routing: {
                    finalProvider: 'deepseek',
                    modelAttempts: [{ providerAttempts: [{ provider: 'deepseek' }] }],
                  },
                },
              },
            },
          }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })

    const row = readClineRequestHistory()[0]!
    expect(row.upstream).toBe('deepseek')
    // 关键：**不能**是模型命名空间
    expect(row.upstream).not.toBe('cline-pass')
  })

  /** 另一种形态（帧顶层）保留兼容 —— 参考实现抓到过它，但**不是**主流式链路。 */
  it('路由挂在帧顶层时同样读得到（兼容形态）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ provider_metadata: { gateway: { routing: { finalProvider: 'baseten' } } } }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })
    expect(readClineRequestHistory()[0]!.upstream).toBe('baseten')
  })

  /** 网关没报路由时留空串 —— 由 RPC 侧回落到模型命名空间，**不在适配器里编造**。 */
  it('网关未报路由时 upstream 留空串（不编造渠道名）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })
    expect(readClineRequestHistory()[0]!.upstream).toBe('')
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障 2026-09-30）：「输出速率 11814.8 t/s」。
   *
   * 速率必须让**分子分母落在同一段时间**：`outputTokens` 含思考 token
   * （本仓库已实测 `reasoning_tokens` 计入 `completion_tokens`），而思考
   * 产生于首字之前 ⇒ 适配器必须**单独**记「首个**正文**块耗时」。
   *
   * ⚠️ **反向验证**：把 `ttfcMs` 的赋值改成与 `ttftMs` 相同（即任何块都算）
   * → 本用例的 `ttfcMs > ttftMs` 断言变红。
   */
  it('分开记录「首块」与「首个正文块」（思考块不算正文）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => slowSseResponse([
        { delayMs: 40, payload: JSON.stringify({ choices: [{ delta: { reasoning: '想一会儿…' } }] }) },
        { delayMs: 60, payload: JSON.stringify({ choices: [{ delta: { content: '答' } }] }) },
        { delayMs: 10, payload: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })

    const row = readClineRequestHistory()[0]!
    expect(row.ttftMs).toBeGreaterThan(0)
    expect(row.ttfcMs).toBeGreaterThan(0)
    // 关键：正文块**晚于**首块（首块是思考增量）—— 这条断言就是本次修复的判据
    expect(row.ttfcMs).toBeGreaterThan(row.ttftMs)
  })

  /** 只有思考、没有正文时 `ttfcMs` 为 0 ⇒ 展示层把速率显示成 `—` 而不是编一个值。 */
  it('纯思考响应没有正文块：ttfcMs 为 0', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning: '只想不说' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })
    expect(readClineRequestHistory()[0]!.ttfcMs).toBe(0)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障 2026-09-30）：「cline-pass 部分模型列表不全」。
   *
   * 实测对账：网关 `recommended-models` 的 `clinePass` **只下发 14 条**，
   * 而 models.dev 的 `cline-pass` 块有 **18 条** —— 差的 4 条
   * （`kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`）
   * 在本插件里**根本不存在**，用户既看不到也选不到。
   * 另外网关给 `cline-pass/*` 的 `name` 就是 id 本身，列表里全是裸 id。
   *
   * ⚠️ **反向验证**：把 `ensureRemoteModels` 里的 `applyModelsDevCatalog(...)`
   * 换回 `models` → 本用例「补进来的模型在目录里」断言变红。
   */
  it('models.dev 补全 cline-pass 目录（网关没下发的模型 + 可读名）', async () => {
    const adapter = makeAdapter({
      loadModelsDev: async () => new Map([
        ['cline-pass/kimi-k2.7-code', {
          id: 'cline-pass/kimi-k2.7-code', name: 'Kimi K2.7 Code', supportsImage: true,
        }],
        ['cline-pass/deepseek-v4.1-flash', {
          id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', supportsImage: true,
        }],
      ]),
    })
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))

    // ① 网关目录里没有的模型被补进来（这是「列表不全」的修复点）
    expect(byId.has('cline-pass/kimi-k2.7-code')).toBe(true)
    // ② 名字是可读的，不是裸 id
    expect(byId.get('cline-pass/kimi-k2.7-code')?.name).toBe('Kimi K2.7 Code')
    expect(byId.get('cline-pass/deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash')
    // ③ 图片能力随之播报 —— DSH 据此才会把图片送进适配器
    expect(byId.get('cline-pass/kimi-k2.7-code')?.inputModalities).toEqual(['text', 'image'])
    // ④ 本地兜底表的策展条目不受影响
    expect(byId.get('cline-free/mimo-v2.6-flash')?.inputModalities).toEqual(['text', 'image'])
  })

  it('能力矩阵登记 cline 为「有余额、无签到、有订阅额度」', () => {
    const source = read('plugin-src/client/credits-capabilities.js')
    const entry = /cline:\s*Object\.freeze\(\{([^}]*)\}\)/.exec(source)
    expect(entry, '未找到 cline 的能力登记').not.toBeNull()
    const body = entry![1]!
    expect(body).toMatch(/balance:\s*true/)
    expect(body).toMatch(/dailyCheckin:\s*false/)
    expect(body).toMatch(/subscriptionQuota:\s*true/)
  })
})

/**
 * ⚠ **「这次到底拿到远端目录没有」的判据必须是 warnings / remote，不能是 `models.length`**
 * （审查发现的死代码）。
 *
 * `mergeClineModels` 会**无条件**把兜底表并进 `models`（这是展示需要 —— 目录服务
 * 抖动时用户的模型列表不该整个消失），实测两个端点全挂时 `models.length` 仍等于兜底表条数。
 * 故 `if (models.length === 0) return false` 永远不命中 ⇒ 冷却永不触发，
 * 兜底表被当成远端结果永久缓存（`if (this.remoteModels !== undefined) return` 短路），
 * 网络恢复后也不会重拉，只能重启 DSH。
 *
 * ⚠️ 补：兜底表并入已改为**有条件**（远端下发目录时丢弃「远端已不认识」的条目，
 * 修「已下架模型被复活」，见 `cline-models.ts` 第 2 步）——但**本组的判据不变**：
 * 两个端点全挂时 `remote.entries` 为空 ⇒ 兜底表整表保留 ⇒ `models.length` 仍非零，
 * 依旧**不能**用它判「有没有拿到远端目录」。
 */
describe('ClineAdapter 目录失败判据（★ 不能看 models.length）', () => {
  it('★ 真接线：两个端点全挂 ⇒ models 里仍有兜底表（非空）但绝不落缓存', async () => {
    // ★ 不覆盖 loadModels：**走真实接线** `loadClineModels`（两个端点各一次请求），
    //   这才是生产形态 —— 注入式 loadModels 可以省略 `remote`，从而掩盖这个缺陷。
    const adapter = makeAdapter({
      loadModels: undefined,
      fetchImpl: (async () => { throw new Error('network down') }) as never,
    })
    const listed = await adapter.listModels('cline')
    // 兜底表被并进来了（展示需要：目录抖动不该让模型列表整个消失）。
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.length).toBe(CLINE.fallbackModels.length)
    // ★ 但它**不是**远端目录，绝不能当成「已加载」缓存下来。
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('★ 真接线：失败后再次 listModels 不再重拉（冷却挡住放大）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      loadModels: undefined,
      fetchImpl: (async (url: string | URL | Request) => {
        calls += 1
        void url
        throw new Error('network down')
      }) as never,
    })
    await adapter.listModels('cline')
    await adapter.listModels('cline')
    await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    // 真实接线有两个端点（recommended-models + models）⇒ 首次失败最多 2 次请求。
    // 关键：**不随调用次数增长**（旧实现看 models.length，每次都会重来一遍）。
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('★ warnings 非空且 models 非空时仍只拉一次（冷却生效）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      loadModels: async () => {
        calls += 1
        return {
          models: CLINE.fallbackModels.map((m) => ({ ...m, isFree: m.isFree === true })) as never,
          warnings: ['boom'],
        }
      },
    })
    await adapter.listModels('cline')
    await adapter.listModels('cline')
    await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    // 旧实现（看 models.length）每次都会返回 true，calls 会变成 3。
    expect(calls).toBe(1)
  })

  it('★ 显式给了 remote（真接线形态）时按其内容判定：有远端 ⇒ 落缓存', async () => {
    let calls = 0
    const adapter = makeAdapter({
      loadModels: async () => {
        calls += 1
        return {
          models: MODELS,
          warnings: [],
          remote: { freeIds: ['cline-free/deepseek-v4.1-flash'], remoteIds: [], entries: [] },
        }
      },
    })
    await adapter.listModels('cline')
    await adapter.listModels('cline')
    expect(calls).toBe(1)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeDefined()
  })

  it('★ 显式给了 remote 但远端全空 ⇒ 不落缓存，且冷却挡住后续重试', async () => {
    let calls = 0
    const adapter = makeAdapter({
      loadModels: async () => {
        calls += 1
        // `models` 里有兜底表（非空），但 `remote` 说明远端一条都没拿到。
        return {
          models: MODELS,
          warnings: ['recommended-models boom', 'models boom'],
          remote: { freeIds: [], remoteIds: [], entries: [] },
        }
      },
    })
    await adapter.listModels('cline')
    await adapter.listModels('cline')
    expect(calls).toBe(1)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })
})
