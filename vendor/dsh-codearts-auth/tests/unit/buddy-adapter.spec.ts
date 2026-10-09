import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_API_BASE, BuddyAdapter, DEFAULT_MODEL, policyBlockResetAtMs, registerBuddyLlm,
} from '../../src/buddy-adapter.js'
import type { BuddyCredential, BuddyRemoteModel } from '../../src/buddy.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from '../../src/product.js'

const CREDENTIAL_REF = credentialRef('BUDDY_ACCESS_TOKEN')

/** 构造一个未过期的凭据。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: DEFAULT_MODEL,
  messages: [],
  signal: new AbortController().signal,
} as never

/** 将 SSE 文本包装为流式 Response。 */
function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/**
 * 上下文超限的 400 响应体（用户报障原文，国际版 WorkBuddy + deepseek-v4.1-flash）。
 *
 * 关键字段：`msg` 用「prompt is too long」措辞、`extError.code` 为
 * `context_length_exceeded`。两者都是 DSH `isContextWindowExceededError` 的
 * 识别依据，适配器必须据此把它归为 CONTEXT_WINDOW_EXCEEDED 而非 INVALID_REQUEST。
 */
const CONTEXT_OVERFLOW_BODY = JSON.stringify({
  code: 11115,
  msg: 'prompt is too long: 1061554 tokens > 1048576 maximum',
  requestId: '9dc0e856-3dae-431c-a8bd-87a2ab63e8d9',
  extError: {
    code: 'context_length_exceeded',
    message: 'prompt is too long: 1061554 tokens > 1048576 maximum',
    param: '',
    type: 'invalid_request_error',
    StatusCode: 400,
    Request: null,
    Response: null,
  },
  displayMsg: {
    en: 'The request exceeds the model context limit. Please shorten the conversation or remove attachments.',
    zh: '对话内容超出模型长度上限，请精简对话或减少附件后重试。',
  },
})

function makeAdapter(overrides: {
  credential?: BuddyCredential | undefined
  refresh?: () => Promise<void>
  /** refresh() 之后 resolveCredential 应返回的值；默认刷新成功（恢复为有效凭据）。 */
  postRefreshCredential?: BuddyCredential | undefined
  fetchImpl?: typeof fetch
  fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
  /**
   * 刻意比生产类型宽松（允许多返回 `undefined`）：用于模拟「旧版桥接」
   * 或版本错配时传入的 readImage——适配器的运行时守卫必须能挡住它，
   * 而不是依赖类型系统保证。生产侧 `BuddyAdapterOptions.readImage`
   * 已不含 undefined。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；不传时由 BuddyAdapter 回退到 CodeBuddy。 */
  product?: BuddyProduct
  /** 目录闸门时钟（验证「距上次拉取 ≥10 秒」这条基于时间的契约）。 */
  now?: () => number
  /** 多账号池替身；本文件只用到模型黑名单（listModels 的过滤输入）。 */
  accountPool?: unknown
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : makeCredential()
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  return new BuddyAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => {
      await refresh()
      credential = 'postRefreshCredential' in overrides ? overrides.postRefreshCredential : makeCredential()
    },
    fetchImpl,
    ...overrides.fetchRemoteModels !== undefined ? { fetchRemoteModels: overrides.fetchRemoteModels } : {},
    ...overrides.readImage !== undefined ? { readImage: overrides.readImage } : {},
    ...overrides.product !== undefined ? { product: overrides.product } : {},
    ...overrides.now !== undefined ? { now: overrides.now } : {},
    ...overrides.accountPool !== undefined ? { accountPool: overrides.accountPool as never } : {},
  })
}

describe('BuddyAdapter', () => {
  it('providerInfo identifies the buddy route', () => {
    // 展示名改由产品配置驱动（this.product.displayName）。CodeBuddy 的
    // displayName 在 Task 1 定稿为 'CodeBuddy (腾讯)'（与 Jet Hub 前端
    // PROVIDERS 的 label 一致），故不再断言旧字面量 'CodeBuddy (Tencent)'。
    expect(makeAdapter().providerInfo('buddy')).toMatchObject({ id: 'buddy', name: CODEBUDDY.displayName })
  })

  it('listModels falls back to the product catalog when no remote source is configured', async () => {
    // CodeBuddy 现在自带 fallbackModels（实测可用的 14 个），故兜底不再是通用 DEFAULT_MODELS。
    const models = await makeAdapter().listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(models.map((m) => m.id)).toContain('glm-5.3')
    expect(models.every((m) => m.provider === 'buddy')).toBe(true)
  })

  it('listModels prefers the remote catalog and caches it', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls++
        return [{ id: 'remote-model', name: 'Remote Model' }]
      },
    })
    const first = await adapter.listModels('buddy')
    const second = await adapter.listModels('buddy')
    // 产品兜底表是权威白名单：远端多出的 remote-model 被丢弃，
    // 兜底表声明的模型被补齐。重复调用不应再触发远端拉取。
    expect(first.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(second.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(calls).toBe(1, '远端列表只应拉取一次')
  })

  it('listModels falls back to the product catalog when the remote fetch fails', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
  })

  it('兜底表白名单保留「被 agent 引用」的模型（真实缺陷回归：hy4-preview-f）', async () => {
    // ⚠️ 真实缺陷（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）：
    // 两个端点下发的 id 集合不同，而「限时免费」促销只挂在
    // `/v3/config` 独有的 `hy4-preview-f` 上，它**不在产品兜底表**里。
    // 白名单式重建会把它丢弃 → 用户看不到那个免费变体，而 IDE 里能看到。
    //
    // 判据用 `agentReferenced`（服务端自己的「可选」信号），
    // 而不是猜 id 后缀（`-f`/`-x`/`-sg` 含义各异，猜错会放进不可用的模型）。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        // 不在兜底表、但服务端说可选 → 必须保留
        { id: 'hy4-preview-f', name: 'Hy4 preview', creditsRate: 'x0.29', discountedCreditsRate: '免费', agentReferenced: true },
        // 不在兜底表、服务端也没说可选（内部别名）→ 仍应丢弃
        { id: 'internal-alias', name: 'Internal' },
      ],
    })
    const ids = (await adapter.listModels('buddy')).map((m) => m.id)
    expect(ids).toContain('hy4-preview-f')
    expect(ids).not.toContain('internal-alias')
    // 追加在末尾，不打乱兜底表原有顺序
    expect(ids.slice(0, CODEBUDDY.fallbackModels!.length))
      .toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(ids.at(-1)).toBe('hy4-preview-f')
    // 展示名带促销价与变体标记（与既有 hy3/hy3-x 同款消歧）
    const name = (await adapter.listModels('buddy')).find((m) => m.id === 'hy4-preview-f')?.name
    expect(name).toContain('免费')
    expect(name).toContain('F')
  })

  // ── 计费倍率与同名区分（写进 name）──
  //
  // ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单只渲染
  // `name`（见 dsh-client-ui-model-selection 的 ModelSelect：`children: model.name`），
  // `description` 仅用于 `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型
  // 列表的后面」正是因为早期版本放在了 `description`。
  //
  // 安全性：`name` 纯属展示 —— DSH 的选择与持久化只用 `id`
  // （`selectionOf` 返回 `model: model.id`）。
  describe('listModels 的计费倍率与同名区分', () => {
    it('把 credits 追加到 name 后面', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'glm-5.3', name: 'GLM-5.3', creditsRate: 'x0.79' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models[0]?.name).toBe('GLM-5.3 · x0.79')
    })

    it('有促销时显示 原价→促销价', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4-flash', name: 'DS', creditsRate: 'x0.17', discountedCreditsRate: 'x0.50' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models[0]?.name).toBe('DS · x0.17→x0.50')
    })

    it('无倍率信息时 name 保持原样', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'mystery', name: 'M' }],
      })
      const models = await adapter.listModels('buddy')
      expect(models[0]?.name).toBe('M')
    })

    // 真实问题（用户报障）：国际版 `deepseek-v4.1-flash` 与
    // `deepseek-v4.1-flash-sg` 的远端 name **完全相同**，而 IDE 只显示一个。
    // 两者是不同区域/计费的实体（credits x0.00 vs x0.03），不能简单丢弃其一，
    // 故对撞车的 name 追加变体标记。
    it('同名模型追加变体标记以区分', async () => {
      const adapter = makeAdapter({
        product: { ...WORKBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', creditsRate: 'x0.00' },
          { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', creditsRate: 'x0.03' },
        ],
      })
      const models = await adapter.listModels('workbuddy')
      expect(models.map((m) => m.name)).toEqual([
        'Deepseek-V4.1-Flash · x0.00',
        'Deepseek-V4.1-Flash · x0.03 SG',
      ])
      // 唯一性：选择器里不会再出现两个无法区分的条目。
      expect(new Set(models.map((m) => m.name)).size).toBe(2)
    })

    // 实测另有 hy3/hy3-x 与 hy4-preview-f/hy4-preview 两组撞车，
    // 硬编码 `-sg` 会漏掉它们，故用公共前缀的通用算法。
    it('非 -sg 的同名组同样被区分（公共前缀算法）', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'hy3', name: 'Hy3' },
          { id: 'hy3-x', name: 'Hy3' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models.map((m) => m.name)).toEqual(['Hy3', 'Hy3 · X'])
    })

    it('三个以上同名 id 仍能全部区分', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'gpt-5.6', name: 'GPT-5.6' },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6' },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(new Set(models.map((m) => m.name)).size).toBe(3)
    })

    it('不同名的模型不追加变体标记', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models.map((m) => m.name)).toEqual(['GPT-5.6-Sol', 'GPT-5.6-Luna'])
    })

    // 真实回归：初版把倍率与变体标记写进 description，导致
    // 「计费 x0.00 · 」（孤立分隔符）与重复的「SG」，而且**在切换模型列表里
    // 根本看不到**（用户报障）。
    it('倍率不进 description（否则切换菜单看不到）', async () => {
      const adapter = makeAdapter({
        product: { ...WORKBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'a', name: 'Same', creditsRate: 'x0.10' },
          { id: 'a-sg', name: 'Same', creditsRate: 'x0.20' },
        ],
      })
      const models = await adapter.listModels('workbuddy')
      for (const model of models) expect(model).not.toHaveProperty('description')
      expect(models[0]?.name).toBe('Same · x0.10')
      expect(models[1]?.name).toBe('Same · x0.20 SG')
    })
  })

  it('resolveModel reports the known context window', async () => {
    const resolved = await makeAdapter().resolveModel('buddy', 'deepseek-v4-flash')
    expect(resolved).toMatchObject({ provider: 'buddy', id: 'deepseek-v4-flash', context: { contextWindow: 1_000_000 } })
  })

  it('resolveModel matches the Rust fallback table for glm and hy models', async () => {
    // 对齐 deveco-code-rust BuddyProvider::context_limit 静态 fallback：
    // glm-5.3-flash 1M（此前误配 200k，导致 web 上下文表显示 ~200K）。
    const adapter = makeAdapter()
    expect((await adapter.resolveModel('buddy', 'glm-5.3-flash')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.3')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.2')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.1')).context).toEqual({ contextWindow: 200_000 })
    expect((await adapter.resolveModel('buddy', 'minimax-m3')).context).toEqual({ contextWindow: 512_000 })
    expect((await adapter.resolveModel('buddy', 'kimi-k2.6')).context).toEqual({ contextWindow: 256_000 })
  })

  // ── 单次输出上限（maxOutputTokens）──
  //
  // 用户报障：deepseek-v4.1-flash 在 32000 token 处被截断，turn/end 为
  // `{kind:'max-tokens'}`。根因是适配器**从未下发 max_tokens**，上限完全由
  // 网关默认值决定（实测网关对 auto 等模型正是 32000）；而远端早已下发权威的
  // maxOutputTokens（实测 deepseek-v4.1-flash = 128000）。
  describe('单次输出上限', () => {
    it('远端 maxOutputTokens 映射为 defaultMaxTokens', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'DS', maxOutputTokens: 128_000 },
        ],
      })
      expect((await adapter.resolveModel('buddy', 'deepseek-v4.1-flash')).defaultMaxTokens).toBe(128_000)
    })

    it('远端与兜底表都没有该值时保持 undefined（不编造）', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'mystery', name: 'M' }],
      })
      expect((await adapter.resolveModel('buddy', 'mystery')).defaultMaxTokens).toBeUndefined()
    })

    it('远端缺失时用产品兜底表的实测值补位', async () => {
      // deepseek-v4.1-flash 在 CodeBuddy 兜底表中已按实测填 128000。
      const resolved = await makeAdapter().resolveModel('buddy', 'deepseek-v4.1-flash')
      expect(resolved.defaultMaxTokens).toBe(128_000)
    })

    it('stream 把上限写进请求体的 max_tokens', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(128_000)
    })

    it('调用方显式给出的 maxTokens 优先于远端与兜底表', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4_096,
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(4_096)
    })

    it('远端下发的值优先于兜底表', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'DS', maxOutputTokens: 7_000 },
        ],
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(7_000)
    })

    it('workbuddy 的 deepseek-v4.1-flash 同样默认 128000', async () => {
      // 国际版实测 /v3/config 下发 128000，兜底表与之对齐。
      const adapter = makeAdapter({ product: WORKBUDDY })
      expect((await adapter.resolveModel('workbuddy', 'deepseek-v4.1-flash')).defaultMaxTokens).toBe(128_000)
    })

    it('非法/非正的远端值被忽略', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'zero', name: 'Z', maxOutputTokens: 0 },
          { id: 'neg', name: 'N', maxOutputTokens: -5 },
        ],
      })
      expect((await adapter.resolveModel('buddy', 'zero')).defaultMaxTokens).toBeUndefined()
      expect((await adapter.resolveModel('buddy', 'neg')).defaultMaxTokens).toBeUndefined()
    })
  })

  it('resolveModel prefers the remote maxInputTokens over the static table', async () => {
    // /v3/config data.models[].maxInputTokens 是权威来源（对齐 Rust
    // context_limit_for_model 两级查找）：远端下发值覆盖静态 fallback。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_048_576 }],
    })
    const resolved = await adapter.resolveModel('buddy', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  it('resolveModel falls back to the static table when the remote value is absent', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' }],
    })
    const resolved = await adapter.resolveModel('buddy', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('resolveModel omits context for unknown models', async () => {
    const resolved = await makeAdapter().resolveModel('buddy', 'unknown-model')
    expect(resolved.context).toBeUndefined()
  })

  // ── 图片能力声明 ──
  // 权威来源是 /v3/config 的 supportsImages。此前硬编码 ['text']，会话控制器
  // 直接在附件准入处拒绝图片（MODEL_DOES_NOT_SUPPORT_IMAGES），用户表现为
  // "设置里需要声明才能用图片"。
  describe('图片能力声明', () => {
    it('远端 supportsImages=true 时声明 image 模态', async () => {
      // 用无兜底表的产品：本节测「远端字段如何生效」，而兜底表会充当
      // 白名单把这类临时 id 滤掉（另见「产品兜底模型目录校正」一节）。
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'vision', name: 'V', supportsImages: true }],
      })
      expect((await adapter.resolveModel('buddy', 'vision')).inputModalities).toEqual(['text', 'image'])
    })

    it('远端显式 supportsImages=false 时保持 text-only', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'plain', name: 'P', supportsImages: false }],
      })
      expect((await adapter.resolveModel('buddy', 'plain')).inputModalities).toEqual(['text'])
    })

    it('远端未下发该字段时回退静态表', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'DS' }],
      })
      expect((await adapter.resolveModel('buddy', 'deepseek-v4.1-flash')).inputModalities).toEqual(['text', 'image'])
    })

    // ── issue IKJQ3M ──
    //
    // 「远端下发了完整能力元数据、但模型不在编译期兜底表里」这一档，
    // 修复前会被 reconcileWithFallback 的白名单式重建整个丢弃（连同它
    // 自带的 supportsImages: true），于是 inputModalitiesFor 三级 ?? 全落空
    // ⇒ 贴图报 `does not accept image input`，而真实网关完全支持图片。
    //
    // ⚠️ 这**不是**瞬时状态：远端目录即使拉取成功也照样误判（issue 里
    // 「重启即自愈」的结论只在模型恰好被 agent 引用时成立）。
    it('远端下发能力元数据、模型不在兜底表时仍保留该模型并声明 image', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{
          id: 'space-bunny', name: 'Space-Bunny', supportsImages: true, contextWindow: 1_000_000,
        }],
      })
      const models = await adapter.listModels('buddy')
      const spaceBunny = models.find((m) => m.id === 'space-bunny')
      expect(spaceBunny, '远端声明了能力的模型不该被白名单丢弃').toBeDefined()
      expect(spaceBunny?.inputModalities).toEqual(['text', 'image'])
      expect((await adapter.resolveModel('buddy', 'space-bunny')).inputModalities).toEqual(['text', 'image'])
    })

    // ⚠️ 放宽白名单**不得**放宽到「什么都能进」：远端既没下发能力元数据、
    // 也没说它可选（无 agentReferenced）的内部别名仍必须被丢弃
    // （既有 `hy4-preview-f` 回归用例守住 agentReferenced 这一条，这里守另一半）。
    it('远端未声明能力也未被 agent 引用的模型仍被白名单丢弃', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'internal-alias-probe', name: 'Internal' }],
      })
      expect((await adapter.listModels('buddy')).map((m) => m.id))
        .not.toContain('internal-alias-probe')
    })

    // ⚠️⚠️ **反向护栏：放宽不得把「实测不可调用」的模型放回选择器**。
    //
    // 上一版把追加判据写成「有任一能力元数据就保留」，其中包含
    // `maxOutputTokens` / `contextWindow` —— 而实测「11102 service info not
    // found」的模型（glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5、hunyuan-* …）
    // **恰好也带这两个字段**（src/product.ts 的 CODEBUDDY_FALLBACK_MODELS
    // 注释明确记录了它们被排除的理由）。⇒ 放宽会把它们放回模型选择器，
    // 用户选中后才报错 —— **这是修复引入的新缺陷，比原缺陷更糟**。
    //
    // ✅ 判据必须是「**图片能力**这一项」，即该模型正是本 issue 要解决的那类。
    it('实测不可调用的模型（带窗口/输出上限但无图片能力）不得被放回选择器', async () => {
      const unusable = ['glm-4.6', 'glm-4.7', 'glm-5.0', 'minimax-m2.5', 'kimi-k2.5', 'hunyuan-chat']
      const adapter = makeAdapter({
        fetchRemoteModels: async () => unusable.map((id) => ({
          id, name: id, contextWindow: 256_000, maxOutputTokens: 24_000,
        })),
      })
      const ids = (await adapter.listModels('buddy')).map((m) => m.id)
      for (const id of unusable) {
        expect(ids, `${id} 实测 11102 不可调用，不该进模型选择器`).not.toContain(id)
      }
    })

    // ⚠️ 反向验证的另一半：**带图片能力的模型仍然要被保留**（别把上面的
    // 收窄做过头 —— 那会把 issue 的正题重新修坏）。
    it('带图片能力的模型被保留（确认上一条不是「一律丢弃」）', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [
          { id: 'usable-vision', name: 'Vision', supportsImages: true, maxOutputTokens: 24_000 },
        ],
      })
      expect((await adapter.listModels('buddy')).map((m) => m.id)).toContain('usable-vision')
    })

    // ⚠️ **两站都要覆盖**（复审 M4）：`BuddyAdapter` 一个类同时服务
    // `buddy`（CodeBuddy 中国版）与 `workbuddy`（国际版），两站的兜底表
    // 差异很大（19 条、含 GPT 系 vs 16 条、含 hy4-preview-f），
    // 「白名单放宽」在任一站失效都不会被上面的 CODEBUDDY 用例发现。
    it('workbuddy 国际版同样适用（白名单放宽 + 不可调用模型仍被挡）', async () => {
      const adapter = makeAdapter({
        product: WORKBUDDY,
        fetchRemoteModels: async () => [
          { id: 'space-bunny', name: 'Space-Bunny', supportsImages: true, maxOutputTokens: 128_000 },
          // 国际版同样实测有 11102 不可调用条目（见 product.ts 的注释）
          { id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 256_000, maxOutputTokens: 24_000 },
        ],
      })
      const listed = await adapter.listModels('workbuddy')
      const ids = listed.map((m) => m.id)
      expect(ids).toContain('space-bunny')
      expect(ids).not.toContain('glm-4.6')
      expect(listed.find((m) => m.id === 'space-bunny')?.inputModalities).toEqual(['text', 'image'])
    })
  })

  // ── 「能力未知」不等于「不支持」：贴图门禁的三态语义（issue IKJQ3M）──
  //
  // 修复前 `inputModalitiesFor` 把「远端没拉到」与「远端说不支持」压成同一个
  // 结果（都是 ['text']），于是：远端拉取失败 ⇒ 实际支持图片的模型被误杀，
  // 且错误文案误导（说「模型不支持图片」，实际是「暂时不知道」）。
  //
  // 三态契约（本次修复的权威定义）：
  //   - 明确支持 → ['text','image']
  //   - 明确不支持（远端显式 supportsImages=false）→ ['text']
  //   - **未知**（远端没拉到 / 目录未就绪）→ **不声明** inputModalities
  //
  // ⚠️ 未知必须**省略字段**而不是报 ['text']：宿主 DSH 见到 ['text'] 会按
  // 「确认是纯文本模型」把图片静默投影成占位文本（dsh-llm `lib/index.js`
  // 的 projectImagesForTextModel），用户既看不到图也拿不到原因。
  describe('贴图门禁：能力未知时的行为（issue IKJQ3M）', () => {
    /**
     * harness 的默认可重试错误码集合，**从 dsh-llm 源码原文里读出来**。
     *
     * ⚠️ 该常量在 `lib/types/*.d.ts` 里**未导出**，只能读源码。
     *
     * ⚠️⚠️ **为什么读源码而不是写死字面量**（初版的推理是反的，复审指出）：
     * 两条路的保护方向**相反**，各有各的失效模式：
     * - **写死字面量**：宿主若把某个码加进可重试集合，这条用例**不会变红**
     *   —— 我们对「哪个码可重试」的认知已与宿主脱钩，而错误码的选取正是
     *   为了利用宿主的重试语义，认知脱钩＝修复静默失效。
     * - **读源码**：宿主改集合时断言自动跟随，看起来「不会报警」，但那正是
     *   它要表达的**事实**（此码此刻确实可重试 ⇒ 我们选它就是错的）。
     *
     * ✅ 真正需要防的「同义反复」是**另一种**：把判据原样抄进断言
     * （断言复述实现，而不是独立事实）。本例断言的是**宿主的事实**，
     * 与被测代码无引用关系 —— 不是同义反复。
     *
     * ⚠️ 初版（09fe2eb）选 `TRANSPORT` 时，本条**实测变红**
     * （`expected [...] to not include 'TRANSPORT'`）—— 保护机制已实证有效。
     */
    const DEFAULT_RETRYABLE_CODES: readonly string[] = (() => {
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
        'utf8',
      )
      const body = /const DEFAULT_RETRYABLE_CODES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)?.[1]
      if (body === undefined) throw new Error('dsh-llm 未声明 DEFAULT_RETRYABLE_CODES，断言口径失效')
      // 去掉 `EMPTY_RESPONSE_CODE` 这类引用名，统一取字符串字面量。
      const codes = [...body.matchAll(/["']([A-Z_]+)["']/g)].map((m) => m[1]!)
      // `EMPTY_RESPONSE` 由同文件里另一个常量名给出，补上它以免漏判。
      if (!codes.includes('EMPTY_RESPONSE')) codes.push('EMPTY_RESPONSE')
      return codes
    })()

    /** 构造一个「远端目录永远拿不到」的适配器，并统计拉取次数。 */
    function makeUnreadyAdapter(options: {
      fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
      now?: () => number
    } = {}): { adapter: BuddyAdapter; calls: () => number } {
      let calls = 0
      const adapter = makeAdapter({
        readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
        fetchRemoteModels: options.fetchRemoteModels ?? (async () => {
          calls++
          throw new Error('catalog endpoint is down')
        }),
        fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
      })
      return { adapter, calls: () => calls }
    }

    const UNKNOWN_MODEL = 'space-bunny'

    it('远端目录未就绪时贴图不再谎报「模型不支持图片」', async () => {
      // 修复前抛 `UNSUPPORTED_CONTENT: model "..." does not accept image input`，
      // 把「暂时不知道」说成「确认不支持」。
      const { adapter } = makeUnreadyAdapter()
      const error = await collectChunks(adapter, {
        model: UNKNOWN_MODEL,
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      // 仍拒绝（不能把未知当成支持），但**错误码与文案必须可区分**。
      expect((error as LlmError).code).not.toBe('UNSUPPORTED_CONTENT')
      expect(String((error as LlmError).message)).not.toContain('does not accept image input')
      expect(String((error as LlmError).message)).toContain(UNKNOWN_MODEL)

      // ⚠️⚠️ **错误码绝不能是 `TRANSPORT`**（反向验证时踩过）：
      // harness 的 `DEFAULT_RETRYABLE_CODES` 是
      // `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
      // —— `TRANSPORT` **在里面**（dsh-llm `lib/index.js` 实测），
      // 于是这条「请稍后重试」会被 harness 白重试 5 次
      // （500/1000/2000/4000/8000 ms），而每次重试都重走一遍
      // `stream()` → `refreshCatalog()`，把一次用户报错放大成 6 次目录拉取
      // ＋6 次凭据解析。方向取反：用**明确不可重试**的码，让用户自己决定
      // 何时重试（那时目录通常已恢复）。
      expect(DEFAULT_RETRYABLE_CODES).not.toContain((error as LlmError).code)
    })

    it('远端目录未就绪时 resolveModel 不声明 inputModalities（宿主因此不投影图片）', async () => {
      const { adapter } = makeUnreadyAdapter()
      const resolved = await adapter.resolveModel('buddy', UNKNOWN_MODEL)
      // ⚠️ 关键：必须是 undefined（宿主才不把图片投影成占位文本），
      // 报 ['text'] 等于告诉宿主「这是纯文本模型」。
      expect(resolved.inputModalities).toBeUndefined()
    })

    it('远端目录未就绪时 listModels 里该模型也不声明 inputModalities', async () => {
      const { adapter } = makeUnreadyAdapter()
      const models = await adapter.listModels('buddy')
      // 兜底表里的模型已知支持图片，仍应正常声明。
      expect(models.find((m) => m.id === 'deepseek-v4.1-flash')?.inputModalities).toEqual(['text', 'image'])
      // 未被任何表覆盖的模型：能力未知 ⇒ 不声明。
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()
    })

    it('远端目录恢复后能力判定随之恢复（重新拉取并声明 image）', async () => {
      // ⚠️ 刻意**不用** `vi.useFakeTimers()`/`vi.setSystemTime`：它们会污染
      // 同文件其余用例（真实计时器用例被挂起，实测 `fails fast with a retryable
      // TIMEOUT` 变成时序敏感、单独跑却绿）。这里改为**注入一个可控时钟**
      // —— 闸门的 `now` 本就是构造参数（`RemoteCatalogGateOptions.now`），
      // 用它既无全局副作用，又让「10 秒」这条契约直接可观测。
      let clock = 1_000_000
      let calls = 0
      const adapter = makeAdapter({
        readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
        // 让适配器的闸门与测试共用同一个时钟。
        now: () => clock,
        fetchRemoteModels: async () => {
          calls++
          if (calls === 1) throw new Error('catalog endpoint is down')
          return [{ id: UNKNOWN_MODEL, name: 'Space-Bunny', supportsImages: true }]
        },
        fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
      })
      // 第一次：未知
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()

      // ⚠️ 用户定的重试规则（issue IKJQ3M）：**距上次失败不足 10 秒不重拉**。
      // 目录端点超时上限 60s（src/buddy.ts 的 REQUEST_TIMEOUT_MS），无节流的
      // 「贴图就重拉」会把每个模型的每次请求都放大成一次远端拉取
      // —— 那正是 RemoteCatalogGate 当初要挡的放大。
      await adapter.refreshCatalog()
      expect(calls, '10 秒内不得重复拉取').toBe(1)
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()

      // ⚠️ 反向验证的另一半：过够时间后**必须真的重拉并重新判能力**，
      // 否则用户永远停留在「未知」，问题只是被推迟而不是被修复。
      clock += 11_000
      await adapter.refreshCatalog()
      expect(calls, '超过 10 秒后应重新拉取目录').toBe(2)
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toEqual(['text', 'image'])
    })

    it('远端显式声明 supportsImages=false 时仍照旧拒绝（不得放宽真失败）', async () => {
      // 白名单放宽 + 「未知不谎报」都不能把「远端说不支持」也放行。
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
        fetchRemoteModels: async () => [{ id: 'text-only-probe', name: 'P', supportsImages: false }],
        fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
      })
      const error = await collectChunks(adapter, {
        model: 'text-only-probe',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)
      expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
      expect(String((error as LlmError).message)).toContain('does not accept image input')
    })

    // ⚠️⚠️ **本修复的核心承诺：贴图时先重看一次目录，恢复了就当没事发生**
    // （对抗审计 MUT5 实测：把 `stream()` 里那段 `refreshCatalog()` 整块删掉，
    //  当时 144 条用例**全绿** ⇒ 核心行为零覆盖。这条把它锁住。）
    //
    // 场景：能力未知的**那一刻**目录没拉到，但只要「距上次拉取 ≥10 秒」，
    // 用户贴的**这一轮**就应重新拉一次；目录此时已恢复 ⇒ 图片正常发出，
    // 用户根本看不到那句「请稍后重试」。
    it('贴图这一轮会自动重看目录；目录已恢复则图片正常发出（不报错）', async () => {
      let clock = 1_000_000
      let catalogCalls = 0
      let sentBody: Record<string, unknown> | undefined
      const adapter = makeAdapter({
        now: () => clock,
        readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
        fetchRemoteModels: async () => {
          catalogCalls++
          // 第一次失败（此刻能力未知）；此后成功并声明支持图片。
          if (catalogCalls === 1) throw new Error('catalog endpoint is down')
          return [{ id: UNKNOWN_MODEL, name: 'Space-Bunny', supportsImages: true }]
        },
        fetchImpl: async (_url, init) => {
          sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: [DONE]\n\n')
        },
      })
      // 先让能力进入「未知」态。
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()

      // 越过 10 秒节流窗口（用户定的规则）。
      clock += 11_000

      // ⚠️ 关键：这一次 stream() 内部必须自己重看目录，而不是报错。
      await collectChunks(adapter, {
        model: UNKNOWN_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这是什么颜色？' },
            { type: 'image', attachment: { attachmentId: 'a' } },
          ],
        }],
        signal: new AbortController().signal,
      } as never)

      // 不抛错（这就是与「报错让用户重试」的本质差别）。
      expect(catalogCalls, '贴图这一轮必须自动重看目录').toBe(2)
      // ⚠️ 且图片**真的进了请求体** —— 只断言「不抛错」是同义反复：
      // 一条把图片静默丢掉的实现同样不抛错（TRAE/lobsterai 都踩过这个坑）。
      const user = (sentBody?.messages as Array<Record<string, unknown>> | undefined)
        ?.find((m) => m.role === 'user')
      expect(user?.content).toEqual([
        { type: 'text', text: '这是什么颜色？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ])
    })
  })

  // ── 思考强度声明 ──
  // composer 的模型选择器读取 resolveModel().reasoning.efforts；不声明该字段
  // 就显示"当前模型未提供推理等级"。
  describe('思考强度声明', () => {
    it('按远端 supportedEfforts 暴露等级与默认值', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{
          id: 'deepseek-v4.1-flash',
          name: 'DS',
          reasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        }],
      })
      const resolved = await adapter.resolveModel('buddy', 'deepseek-v4.1-flash')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
      expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['Low', 'High', 'Max'])
      expect(resolved.reasoning?.defaultEffort).toBe('high')
    })

    it('远端未下发等级时回退静态表', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'deepseek-v4-pro', name: 'DS' }],
      })
      expect((await adapter.resolveModel('buddy', 'deepseek-v4-pro')).reasoning?.efforts.map((e) => e.id))
        .toEqual(['low', 'high', 'xhigh'])
    })

    it('无可选等级的模型不暴露选择器', async () => {
      // 远端与产品兜底表都未声明 reasoningEfforts 时不暴露选择器。
      // （兜底表会给部分模型补上等级，故这里用无兜底表的产品测本行为）
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'glm-5.1', name: 'GLM' }],
      })
      expect((await adapter.resolveModel('buddy', 'glm-5.1')).reasoning).toBeUndefined()
    })

    it('产品兜底表声明的等级在远端缺失时生效', async () => {
      // glm-5.1 在 CodeBuddy 兜底表里声明了 medium 等级。
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'glm-5.1', name: 'GLM' }],
      })
      const resolved = await adapter.resolveModel('buddy', 'glm-5.1')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['medium'])
    })

    // ── issue IKJQSH 回归 ──
    //
    // 实测（2026-10-06）：国际版 `/v3/config` 对 deepseek-v4.1-flash / -sg
    // **不下发 supportedEfforts**，只给单值 `reasoning: {effort:"high"}`，
    // 而 `parseModelMeta` 不认 `effort` ⇒ 远端表态被静默忽略。
    //
    // ⚠️ 这意味着兜底表**不是**「远端不可用时的备胎」，而是这两个模型的
    // **唯一**档位来源 —— 远端正常时也一样。所以这条用例必须锁死「远端下发
    // 不带档位的条目」这个**正常**形态，而不是只测远端失败（那测不到真实现状）。
    it('远端下发条目但不带 supportedEfforts 时，兜底表是对外唯一声明（workbuddy）', async () => {
      const adapter = makeAdapter({
        product: WORKBUDDY,
        // ⚠️ 复刻实测的远端形态：有 id/name/maxOutputTokens，**无** reasoningEfforts。
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxOutputTokens: 128_000 },
          { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', maxOutputTokens: 128_000 },
        ],
      })
      for (const id of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg']) {
        const resolved = await adapter.resolveModel('workbuddy', id)
        // 用户界面上能选到的档位 = 兜底表声明的那一组。
        expect(resolved.reasoning?.efforts.map((e) => e.id), id)
          .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        // max 必须真的进得来，否则 UI 选 max 会被 dsh-llm 抛 UNSUPPORTED_REASONING_EFFORT。
        expect(resolved.reasoning?.efforts.some((e) => e.id === 'max'), `${id} 缺 max`).toBe(true)
        expect(resolved.reasoning?.defaultEffort, id).toBe('high')
      }
    })

    it('⚠️ 兜底表缩水会直接削掉用户的可选档位（反向验证：改回 ["high"] 用例必红）', async () => {
      // 锁住「兜底表即唯一来源」这个因果：把产品配置换成单档后，max 必须消失。
      // 只断言「声明了什么」是同义反复 —— 任何实现都能过。
      const adapter = makeAdapter({
        product: {
          ...WORKBUDDY,
          fallbackModels: WORKBUDDY.fallbackModels!.map((m) =>
            m.id === 'deepseek-v4.1-flash'
              ? { ...m, reasoningEfforts: ['high'] as const, defaultReasoningEffort: 'high' }
              : m),
        } as never,
        fetchRemoteModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'DS' }],
      })
      const resolved = await adapter.resolveModel('workbuddy', 'deepseek-v4.1-flash')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['high'])
      expect(resolved.reasoning?.efforts.some((e) => e.id === 'max')).toBe(false)
    })
  })

  // 回归：dsh-llm 0.1.1-rc.2 的 LlmRuntime.prepareCall() 会直接调用
  // registration.adapter.prepareCall()，而本仓库链接的副本（0.1.0-rc.6）
  // 的 LlmAdapter 基类没有该方法——缺少时每轮请求都以
  // `registration.adapter.prepareCall is not a function` 失败。
  it('exposes prepareCall for the runtime adapter contract', async () => {
    const adapter = makeAdapter()
    expect(typeof adapter.prepareCall).toBe('function')
    const call = await adapter.prepareCall('buddy', 'hy4-preview')
    expect(call.model).toMatchObject({
      provider: 'buddy',
      id: 'hy4-preview',
      context: { contextWindow: 1_000_000 },
      inputModalities: ['text', 'image'],
    })
    expect(typeof call.stream).toBe('function')
  })

  it('prepareCall binds its stream to the same adapter instance', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const call = await adapter.prepareCall('buddy', DEFAULT_MODEL)
    const chunks: Array<Record<string, any>> = []
    for await (const chunk of call.stream(streamOptions as never)) {
      chunks.push(chunk as unknown as Record<string, any>)
    }
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })
})

describe('BuddyAdapter credential handling', () => {
  it('stream throws MISSING_CREDENTIAL when no credential is configured', async () => {
    // credential 缺失且刷新也拿不到凭据（postRefreshCredential: undefined）。
    const adapter = makeAdapter({ credential: undefined, postRefreshCredential: undefined })
    await expect(collectChunks(adapter, streamOptions)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('stream refreshes first when the credential is expired', async () => {
    let refreshed = false
    const adapter = makeAdapter({
      credential: makeCredential({ expires_at: String(Date.now() - 60_000) }),
      refresh: async () => { refreshed = true },
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
    })
    await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(true)
  })

  it('stream refreshes once and retries on HTTP 401', async () => {
    let refreshed = 0
    let calls = 0
    const adapter = makeAdapter({
      refresh: async () => { refreshed++ },
      fetchImpl: async () => {
        calls++
        return calls === 1
          ? new Response('unauthorized', { status: 401 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(1, '401 只应触发一次刷新')
    expect(calls).toBe(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  /**
   * 账号池替身：只实现 401/403 换号路径用到的方法。
   *
   * `findAccountIdByCredential` 必须真实工作 —— 适配器靠它把当前凭据归属到
   * 账号条目，归属不到（返回 `''`）时换号会先拿回刚失败的那个账号。
   */
  function makePool(accounts: Array<{ id: string; credential: BuddyCredential }>) {
    /** 记录 `updateModelRateLimit` 的调用，供「安全策略拦截冷却标记」用例断言。 */
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      findAccountIdByCredential: async (_provider: string, token: string) =>
        accounts.find(a => a.credential.access_token === token)?.id ?? '',
      getAvailableAccount: async (
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) => {
        const entry = accounts.find(a => exclude === undefined || !exclude.has(a.id))
        return entry === undefined ? null : { entry, credential: entry.credential }
      },
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  it('401 时刷新失败也会换号重试（账号池完好时不得整轮失败）', async () => {
    // 真实缺陷场景（2026-09-26，用户报障）：refresh 抛「未配置凭据，请先登录」
    // （接线刷错了单凭据 ref），而账号池里第 2 个账号完全可用。
    // 修复前：异常直接冒泡 → 整轮失败，且下一轮复现（自锁）。
    const second = makeCredential({ access_token: 'AT2' })
    const usedTokens: string[] = []
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      // 刷新「失败」：模拟刷错 ref 的旧接线（此时适配器必须仍能靠换号完成请求）。
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: second },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) => {
        const token = init.headers.get('Authorization') ?? ''
        usedTokens.push(token)
        return token.includes('AT1')
          ? new Response('unauthorized', { status: 401 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(usedTokens.some(t => t.includes('AT2'))).toBe(true, '应换到池内第二个账号重试')
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('401 且池内所有账号都认证失败时报 AUTH（不再谎称未配置凭据）', async () => {
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('AUTH')
    // 文案必须指向真实原因（全部账号被拒绝），而不是「请先登录」。
    expect((error as LlmError).message).not.toContain('未配置凭据')
  })

  it('换号耗尽时错误必须带上服务端响应体（403 在腾讯侧不等于认证失败）', async () => {
    // 真实回归（修复自身引入的，2026-09-27）：换号耗尽后只报「所有账号均认证失败」，
    // 把服务端真正说的原因丢掉了 —— 而 403 也可能是额度耗尽 / 模型无权限 /
    // 安全策略。实测那批 403 之后逐账号复验，5 个 token 全部有效。
    const body = JSON.stringify({ code: 8003, msg: 'insufficient balance' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => new Response(body, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    const message = (error as LlmError).message
    expect(message).toContain('403')
    expect(message).toContain('insufficient balance')
    // 403 不得断言成「请重新登录」——那会把额度问题引向错误的修复动作。
    expect(message).not.toContain('重新登录')
  })

  it('安全策略拦截（11140）会逐个换号，全部试完才报错', async () => {
    // ⚠️ **结论修正（2026-09-27 实测）**：早期实现断言「安全审核是内容问题，
    // 换号毫无意义 → 一次都不多发」。逐账号对照实测推翻了它：
    // **同一份请求体**（system + 两个字）发往池里 7 个账号，得到
    // 「2 个 200 / 4 个 403·11140 / 1 个 429」——拦截**按账号生效**，与内容无关。
    //
    // 用户侧现象吻合：连「你好」都被拦，且换新会话照样被拦（排除上下文累积）。
    // 因此正确行为是**换号**（与 401/403 认证失败同一条路径）：坏账号可能排在
    // 池里任何位置，不换号就等于让池中可用账号永远闲置。
    const body = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      requestId: '5b2240b4-efdf-40e0-94e4-cfee1aa80585',
      displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
    })
    let calls = 0
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => { calls++; return new Response(body, { status: 403 }) },
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    // 错误码取 PERMISSION_DENIED（**不是** AUTH）：DSH 的聊天 UI 是
    // `code === "AUTH" ? "API 密钥无效" : message`
    // （取证：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234`），
    // 取 AUTH 会把整条 message 换成「API 密钥无效」——下面那些为「指向账号」
    // 而写的文案一个字都到不了用户眼前，且把用户引向检查密钥（实测 token 全有效）。
    // PERMISSION_DENIED 也不在 harness 的 DEFAULT_RETRYABLE_CODES 里 → 不白重试。
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    // 文案必须指向**账号**，不再断言「请调整内容后重试」把用户引向错误方向。
    expect((error as LlmError).message).toContain('安全策略')
    expect((error as LlmError).message).toContain('账号')
    expect((error as LlmError).message).not.toContain('请调整内容')
    // 关键：**必须换号**——两个账号各试一次（首发 acc-1 + 换号 acc-2）。
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('安全策略拦截在换号途中被剔除：换到可用账号即成功', async () => {
    // 本用例对应真实故障场景：池首账号被安全策略拦下，池尾账号可用。
    // 修复前「不换号」会让这次请求必然失败（正是用户连续多轮失败的原因）。
    const safety = JSON.stringify({ code: 11140, msg: 'request illegal' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      // AT1 → 安全策略拦截；AT2 → 正常 SSE。
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response(safety, { status: 403 })
          : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    // 换到 acc-2 后成功产出内容，而不是抛错。
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('换号途中撞上的安全策略同样报专门的提示（不混入其他 403 文案）', async () => {
    const safety = JSON.stringify({ code: 11140, msg: 'request illegal' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      // 首发 401（真认证失败）→ 换号后拿到 403 安全策略拦截。
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response('unauthorized', { status: 401 })
          : new Response(safety, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    // 走的是安全策略专用文案（指向账号），而不是泛化的「所有账号均被拒绝」。
    expect((error as LlmError).message).toContain('安全策略')
    // ⚠️ 文案里的 HTTP 状态必须是**拦截那一次**的 403，而不是首发的 401 ——
    // 早先这里传的是首发的 authStatus，「HTTP 401」会把排查引向「token 过期」，
    // 而实际被拦的是换号后的那个账号（它回的是 403）。
    expect((error as LlmError).message).toContain('HTTP 403')
    expect((error as LlmError).message).not.toContain('HTTP 401')
  })

  it('错误提示只取服务端 displayMsg.zh，不倾倒整段 JSON 原文', async () => {
    // 真实缺陷（2026-09-27 用户报障）：腾讯系用 `msg` + `displayMsg.{zh,en}`
    // 报错，**没有**标准 `message` 字段。早期 errorDetail 只读 `data.message`，
    // 于是全部落空、退化成返回整段 JSON —— 实测把 291 字符的原始报文糊进提示，
    // 而服务端早已备好中文说明，被白白埋掉。
    const raw = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      requestId: 'b1fd90ae-0c5f-45b6-9209-002f3ab3c4a3',
      displayMsg: {
        en: 'The content did not pass the safety review. Please adjust and retry.',
        zh: '内容未通过安全审核，请调整后重试。',
        'zh-hant': '內容未通過安全審核，請調整後重試。',
      },
      actions: ['SUBMIT_FEEDBACK', 'COPY_ERROR', 'EDIT_INPUT'],
    })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      // 两个账号都被拦 → 走到「全部账号均被安全策略拦截」这条报错路径。
      fetchImpl: async () => new Response(raw, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    const message = (error as LlmError).message
    // 服务端的中文说明必须**出现**（此前被丢弃）。
    expect(message).toContain('内容未通过安全审核')
    // 原始 JSON 的噪声字段不应被倾倒进来。
    expect(message).not.toContain('SUBMIT_FEEDBACK')
    expect(message).not.toContain('zh-hant')
    expect(message).not.toContain('requestId')
  })

  it('401 换号不会无限循环：每个账号最多试一次', async () => {
    let calls = 0
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => { calls++; return new Response('unauthorized', { status: 401 }) },
    })
    await expect(collectChunks(adapter, streamOptions)).rejects.toBeInstanceOf(LlmError)
    // AT1（首发）+ 刷新后重试（无新凭据则不发）+ AT1/AT2 各一次换号尝试
    expect(calls).toBeLessThanOrEqual(4)
  })

  it('换号途中遇到非认证类错误时交给既有分类逻辑，而不是报 AUTH', async () => {
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response('unauthorized', { status: 401 })
          : new Response('{"error":{"message":"boom"}}', { status: 500 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('SERVER')
  })

  it('stream maps HTTP 429 to RATE_LIMIT and 5xx to SERVER', async () => {    for (const [status, code] of [[429, 'RATE_LIMIT'], [500, 'SERVER'], [400, 'INVALID_REQUEST']] as const) {
      const adapter = makeAdapter({ fetchImpl: async () => new Response(`{"error":{"message":"boom"}}`, { status }) })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe(code)
    }
  })

  /**
   * 上下文超限必须归为 CONTEXT_WINDOW_EXCEEDED，而不是笼统的 INVALID_REQUEST。
   *
   * 为什么这条错误码至关重要：DSH 的自动压缩恢复（dsh-compaction-basic）监听
   * `agent/request-error`，**只对 `failure.code === CONTEXT_WINDOW_EXCEEDED`**
   * 的失败压缩上下文并重试。若标成 INVALID_REQUEST，长会话一旦越过窗口就会把
   * 裸错误直接抛给用户，用户看到的是：
   *
   *   buddy: {"code":11115,"msg":"prompt is too long: 1061554 tokens > 1048576 maximum", ...}
   *
   * 这正是用户报障的现象（国际版 WorkBuddy，deepseek-v4.1-flash）。CodeArts
   * 适配器早已做此归类（llm-adapter.ts 的 httpErrorCode），buddy 此前遗漏。
   *
   * 报文取自真实报障原文：`msg` 为「prompt is too long」措辞、
   * `extError.code` 为 `context_length_exceeded`，两者都应被识别。
   */
  it('stream 把上下文超限的 400 归为 CONTEXT_WINDOW_EXCEEDED（触发自动压缩）', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => new Response(CONTEXT_OVERFLOW_BODY, { status: 400 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 错误消息仍须保留可读原因（用户/日志据此定位），不能被错误码改写掉
    expect((error as LlmError).message).toContain('prompt is too long')
  })

  it('上下文超限的 400 不被误判为限流（不触发账号切换）', async () => {
    // 区分「窗口超限」与「用量限流」很重要：前者换账号也没用（同样的上下文
    // 会再次超限），必须走压缩；后者才该切换账号。若误判为限流，适配器会白试
    // 一遍所有账号，最后仍以 QUOTA_EXCEEDED 掩盖真实原因。
    //
    // 这里用自包含的 pool 替身（该 describe 内的 makePool 定义在另一块中）。
    const recorded: Array<{ accountId: string }> = []
    const sentTokens: string[] = []
    const pool = {
      async findAccountIdByCredential() { return 'acct-1' },
      async updateModelRateLimit(accountId: string) { recorded.push({ accountId }) },
      async getAvailableAccount() {
        return { entry: { id: 'acct-2' }, credential: makeCredential({ access_token: 'AT2' }) }
      },
    }
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(CONTEXT_OVERFLOW_BODY, { status: 400 })
      },
    })

    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 只发了当前账号：没有因误判限流而去轮询其余账号
    expect(sentTokens).toEqual(['AT1'])
    // 也不应写入任何限流标记
    expect(recorded).toEqual([])
  })

  /**
   * 对照：同为中国版/国际版常见的 400 错误，只要不含超限措辞，仍须是
   * INVALID_REQUEST —— 避免为了修上下文超限而把所有 400 都当成可压缩错误
   * （那会让真正的请求错误被反复压缩重试，浪费额度且掩盖原因）。
   */
  it('普通 400（模型不存在 / 参数非法）仍归为 INVALID_REQUEST', async () => {
    const cases = [
      '{"error":{"message":"model not found"}}',
      '{"code":11102,"msg":"service info not found"}',
      '{"error":{"type":"invalid_request_error","message":"unsupported parameter"}}',
    ]
    for (const body of cases) {
      const adapter = makeAdapter({ fetchImpl: async () => new Response(body, { status: 400 }) })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect((error as LlmError).failure.code, body).toBe('INVALID_REQUEST')
    }
  })

  /**
   * 判定必须看**完整 body**，不能只看 errorDetail 归一化后的短文本。
   *
   * `errorDetail` 在能提取到 `error.*` / `data.message` 时会返回拼接文本，
   * 从而丢掉 `extError` / `displayMsg`。若把判定建立在它之上，服务端一旦
   * 把 `msg` 改名成 `message`（或补上 `error.code`），`extError.code =
   * context_length_exceeded` 这个最强信号就会被丢弃，超限随即漏判成
   * INVALID_REQUEST、自动压缩再次失效。
   *
   * 这里构造「error.code 为字符串 + msg 为超限措辞」的变体：errorDetail 会
   * 返回 `"some_error prompt is too long: ..."`（丢失 extError），但完整 body
   * 仍含 `context_length_exceeded`，故必须仍判为超限。
   */
  it('判定基于完整 body：extError 在 errorDetail 中被丢弃时仍能识别超限', async () => {
    const variant = JSON.stringify({
      error: { code: 'some_error', message: 'prompt is too long: 1061554 tokens > 1048576 maximum' },
      extError: { code: 'context_length_exceeded' },
    })
    const adapter = makeAdapter({ fetchImpl: async () => new Response(variant, { status: 400 }) })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('stream sends the required CodeBuddy headers', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('Authorization')).toBe('Bearer AT')
    expect(seen!.get('X-Domain')).toBe('copilot.tencent.com')
    expect(seen!.get('X-Product-Code')).toBe('codebuddy')
    expect(seen!.get('User-Agent')).toBe('CodeBuddyIDE/1.106.1')
  })

  /**
   * 回归：凭据 domain 为**空串**时 X-Domain 必须回退到产品域名。
   *
   * `parseTokenData` → `readStringField` 在字段缺失时返回空串，故这是真实可达
   * 的凭据形态。修复前 `??` 对空串不生效，这里发出的头是空值（已实测复现）。
   *
   * ⚠️ 上一条用例的凭据 domain 是 `'copilot.tencent.com'`（等于产品域名），
   * 对「取谁的值」不敏感，故必须另写两条才能分别锁住空串与优先级两个子问题。
   */
  it('凭据 domain 为空串时 X-Domain 回退到产品域名', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      credential: makeCredential({ domain: '' }),
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('X-Domain')).toBe('copilot.tencent.com')
  })

  /**
   * 回归：X-Domain 以**产品**为准，不跟随凭据里的历史域名。
   *
   * 真实场景——早期 workbuddy 指向中国版 `copilot.tencent.com`，改造为国际版后
   * 旧凭据的 domain 仍是老域名。若 X-Domain 取凭据值，请求会打到
   * `www.workbuddy.ai` 却声明自己属于 `copilot.tencent.com`，身份标识与 baseURL
   * 自相矛盾；且同一账号的**聊天**（本处）与**积分**（`src/credits.ts` 的
   * `checkinHeaders`，早已是「以产品为准」）会声明不同的 X-Domain。
   * 本用例与 `tests/unit/credits.spec.ts` 的「凭据 domain 与产品不符时，以产品
   * 配置为准」成对，锁死两条链路判定一致。
   */
  it('凭据 domain 与产品不符时，X-Domain 以产品配置为准', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      product: WORKBUDDY,
      credential: makeCredential({ domain: 'copilot.tencent.com' }),
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('X-Domain')).toBe('www.workbuddy.ai')
  })

  /** 抓取一次 stream() 实际发出的请求体；overrides 同时用于 adapter 与请求。 */
  async function captureBody(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {}
    const adapter = makeAdapter({
      ...overrides,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      ...overrides,
    } as never)
    return body
  }

  // 实测：reasoning_effort=low/high/max 会显著改变返回的 reasoning_content
  // 长度，是服务端真实生效的参数。
  it('stream forwards a supported reasoning effort as reasoning_effort', async () => {
    expect(await captureBody({ reasoningEffort: 'max' })).toMatchObject({ reasoning_effort: 'max' })
  })

  // 实测（2026-09，直连 workbuddy 国际/中国 UA 与 codebuddy 三站点对照）：
  //   - 裸请求（无 reasoning_effort、无 thinking）→ reasoning_content 恒为 0；
  //   - 仅 reasoning_effort:high → 返回思考；仅 thinking:{type:'enabled'} → 仍为 0；
  //   - 两者都带 → 返回思考。
  // 即 reasoning_effort 才是真正开关，thinking 单独不生效（保留以对齐官方形态）。
  it('stream enables thinking for deepseek models', async () => {
    expect(await captureBody()).toMatchObject({ thinking: { type: 'enabled' } })
  })

  // 真实缺陷回归（会话 session-03b4d1f2 "测试思考过程显示"）：workbuddy 的
  // deepseek-v4.1-flash 未声明 defaultReasoningEffort，composer 因而未预选档位，
  // 请求体里只剩 thinking 而没有 reasoning_effort → 上游按不思考应答 → UI 看不到
  // 思考块。适配器必须在此情形补档，保证任何 deepseek 请求都带 reasoning_effort。
  it('stream backfills reasoning_effort for deepseek when none is selected or unsupported', async () => {
    // composer 未选等级（options.reasoningEffort === undefined）时补默认档。
    expect(await captureBody()).toMatchObject({ reasoning_effort: 'high' })
    // 会话历史里可能残留切换模型前的旧等级（如 glm-5.2 的 xhigh），
    // 不被该模型支持时也要补成合法档位，而非丢弃导致静默不思考。
    const body = await captureBody({ reasoningEffort: 'xhigh' })
    expect(body).toHaveProperty('reasoning_effort')
    expect(['low', 'high', 'max']).toContain(body.reasoning_effort)
  })

  it('stream does not enable thinking or backfill effort for non-deepseek models', async () => {
    // glm 等其他模型走各自 thinkingFormat（默认开或 enable_thinking），
    // 不注入 thinking 开关、不补默认档。
    const body = await captureBody({ model: 'glm-5.2' })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  // CodeBuddy 只接受 OpenAI 多模态 parts 形态的图片；
  // {type:'image'} 会被服务端以 `unsupported content type ... image` 400。
  it('stream sends user images as inline image_url parts', async () => {
    const body = await captureBody({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    })
    const user = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'user')!
    expect(user.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ])
  })

  it('stream rejects images for a model that declares text-only', async () => {
    // 用无兜底表的产品，使远端声明的 supportsImages=false 直接生效
    // （兜底表会充当白名单）。模型 id 用兜底表之外的临时值。
    const textOnly = 'text-only-probe'
    const adapter = makeAdapter({
      product: { ...CODEBUDDY, fallbackModels: undefined } as never,
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      fetchRemoteModels: async () => [{ id: textOnly, name: 'M', supportsImages: false }],
      fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, {
      model: textOnly,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('stream keeps image-free requests on the plain string content path', async () => {
    // 无图请求的线上格式必须不变，否则整体破坏前缀缓存命中。
    const body = await captureBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    const user = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'user')!
    expect(user.content).toBe('hello')
  })

  // 「静默丢图」回归护栏：readImage 表示读不到时，必须抛错。
  // 旧实现会 `continue` 丢掉整张图，线上请求退化成纯文本，
  // 模型只能答「我看不到图片」，用户拿不到任何错误原因。
  it('stream fails loudly when readImage reports it cannot read the bytes', async () => {
    let body: Record<string, unknown> | undefined
    const adapter = makeAdapter({
      readImage: async () => undefined,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: [DONE]\n\n')
      },
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', attachment: { attachmentId: 'att-missing' } },
        ],
      }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    // 关键：请求根本没有发出，图片不可能被静默丢弃。
    expect(body).toBeUndefined()
  })

  it('stream preserves the cause when readImage throws', async () => {
    const cause = new Error('attachment object is gone')
    const adapter = makeAdapter({
      readImage: async () => { throw cause },
      fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }] }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    expect((error as LlmError).message).toContain('attachment object is gone')
  })
})

describe('BuddyAdapter stream parsing', () => {
  it('emits text and reasoning on separate blocks', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'reasoning')).toBeDefined()
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'text')).toBeDefined()
    const text = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(text[0]).toMatchObject({ block: { type: 'text', text: 'hello world' } })
    const reasoning = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
    expect(reasoning[0]).toMatchObject({ block: { type: 'reasoning', text: 'thinking...' } })
  })

  it('reports stop when no tool calls occur', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 回归：CodeBuddy 流式响应仅首个分片携带真实 id（chatcmpl-tool-xxx），
  // 后续参数分片只有 index。若按 index 生成 call_{index} 而非沿用真实 id，
  // 跨轮（每轮都从 call_0 重新编号）会导致 tool/result 配对到错误的历史条目。
  it('keeps one stable id across argument fragments of the same tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-abc","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\": \\"ls\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas).not.toHaveLength(0)
    // 所有分片（含首个空参数分片）都必须使用后端签发的真实 id。
    for (const delta of deltas) {
      expect((delta as { id: string }).id).toBe('chatcmpl-tool-abc')
    }
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-abc', name: 'shell', arguments: '{"command": "ls"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  // 回归：并行工具调用各自拥有独立 id，参数分片不得混淆到同一个工具上。
  it('distinguishes parallel tool calls by id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"shell","arguments":""}},{"index":1,"id":"chatcmpl-tool-2","function":{"name":"file_read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}},{"index":1,"function":{"arguments":"{\\"b\\":2}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(ends).toHaveLength(2)
    const byId = new Map(ends.map((c) => [(c as { block: { id: string } }).block.id, c]))
    expect(byId.get('chatcmpl-tool-1')).toMatchObject({ block: { name: 'shell', arguments: '{"a":1}' } })
    expect(byId.get('chatcmpl-tool-2')).toMatchObject({ block: { name: 'file_read', arguments: '{"b":2}' } })
  })

  // 回归：CodeBuddy 的参数续分片会带回 `"function":{"name":""}`。空串不是
  // undefined，原先的 `!== undefined` 判断会用它覆盖首个分片解析出的真实
  // 工具名，最终 block-end 输出 name:""，harness 报 `unknown tool ""`。
  it('ignores an empty function name on argument continuation fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"command\\":\\"ls -"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"la\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-1', name: 'shell', arguments: '{"command":"ls -la"}' },
    })
    // 续分片的空名不得传播到 delta 上。
    for (const delta of chunks.filter((c) => c.type === 'tool-call-delta')) {
      expect((delta as { name?: string }).name).toBe('shell')
    }
  })

  it('falls back to call_{index} when the backend sends no id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]).toMatchObject({ block: { type: 'tool-call', id: 'call_0', name: 'shell' } })
  })

  // 'length'（输出被 max_tokens 截断）必须优先于 tool_calls：否则 harness 会执行
  // 被截断的非法 JSON 参数，并把脏参数持久化进会话历史。
  it('reports max-tokens over tool-calls when the stream is truncated', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('surfaces SSE-embedded errors as SERVER failures', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"error":{"message":"internal error"}}\n\ndata: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(String((error as LlmError).message)).toContain('internal error')
  })

  // 回归：无参数工具（如 list_dir / get_cwd）只下发一个空的 arguments
  // 分片，拼接结果为空串。harness 解析时报
  // `invalid arguments: "arguments" must be an object`，会话卡在错误态，
  // web 端发送按钮置灰、后续指令无响应。空参数必须归一化为 {}。
  it('normalizes empty arguments of a zero-parameter tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"list_dir","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ block: { name: 'list_dir', arguments: '{}' } })
  })

  // 回归：SSE 流被网关掐断（无 finish_reason、无 [DONE]）时，工具参数是
  // 半截 JSON。原实现把它报告为 tool-calls，harness 执行不完整参数报
  // INVALID_ARGS 并把脏参数持久化进历史。此时应报告 max-tokens，让 dsh
  // 丢弃残缺调用并触发续写。
  it('reports max-tokens instead of executing a half-streamed tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
    // 残缺参数必须原样保留，交由 max-tokens 触发重试。绝不能补成 {}——
    // 那会让 harness 报 `missing required property` 而非重试。
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]!.block.arguments).not.toBe('{}')
  })

  // 回归（核心）：hy4-preview 并行下发多个工具调用时会丢参数分片，两个调用
  // 都只剩残缺片段（实测 session-23851745 turn1 step4）。此前适配器把残缺
  // JSON 补成 {}，伪造出合法外观，harness 执行时报
  // `missing required property "file_path"`，模型收到莫名其妙的参数错误并
  // 陷入重试循环。现在必须判定为截断、报告 max-tokens 触发 dsh 重试。
  it('reports max-tokens when parallel tool calls lose argument fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        // 两个并行 read：参数开头的 `{"file_path": "D:\\...` 前缀丢失。
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-a","function":{"name":"read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"\\\\deveco-code-rust\\\\cr"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"ates\\\\deveco"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"tool-b","function":{"name":"read","arguments":"o-llm\\\\src\\\\provider\\\\buddy.rs\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    // 后端声明 finish_reason=tool_calls，但参数残缺——必须覆盖为 max-tokens，
    // 否则 harness 会执行这两个缺参调用。
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  // 回归：后端掐断连接但既不发数据也不关连接（半开连接）时，裸
  // reader.read() 永久挂起——generator 不返回，harness 步骤既不出结果
  // 也不报错，会话永远停在"运行中"，web 端发送按钮置灰、"继续"无响应。
  // 必须主动超时并抛可重试的 TIMEOUT，把控制权交还给用户。
  it('fails fast with a retryable TIMEOUT when the stream stalls', async () => {
    // 默认 firstTokenTimeout 为 120s，测试里缩短到 20ms 触发超时路径。
    // 环境变量在每次 stream() 调用时读取，因此这里设置即时生效。
    process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS = '20'
    try {
      const adapter = makeAdapter({
        fetchImpl: async () => new Response(
          new ReadableStream<Uint8Array>({ start() { /* 永不产出数据 */ } }),
          { status: 200 },
        ),
      })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe('TIMEOUT')
    } finally {
      delete process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS
    }
  })

  it('skips malformed SSE lines', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('BuddyAdapter message serialization', () => {
  it('sends assistant reasoning_content and null content for tool-only turns', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'let me check' },
          { type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    const assistant = payload.messages[0]
    expect(assistant.role).toBe('assistant')
    // 正文为空且带 tool_calls 时 content 必须为 null（对齐 openai_chat.rs）。
    expect(assistant.content).toBeNull()
    // 推理模型要求 assistant 消息始终携带 reasoning_content 字段。
    expect(assistant.reasoning_content).toBe('let me check')
    expect(assistant.tool_calls).toMatchObject([{ id: 'call_1', type: 'function', function: { name: 'shell' } }])

    // 工具结果展开为独立的 role:'tool' 消息。
    const tool = payload.messages[1]
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file.txt' })
  })

  // 回归（严重）：工具执行失败时，assistant 的 tool_calls 会留在会话历史里，
  // 但对应的 tool 结果消息从未写入——形成孤儿 tool_calls。OpenAI 兼容后端
  // 要求带 tool_calls 的 assistant 消息必须紧跟对应 tool 消息，否则每次
  // 请求都 400。由于坏历史被持久化并随每次请求重放，**后续所有消息都会
  // 石沉大海**，整个会话永久报废。适配器是最后一道防线，必须清理。
  it('drops orphan tool_calls that have no tool result', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'list the files' },
        // 助手发起了 Grep 调用，但参数非法导致执行失败，结果从未写回历史。
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'Grep', arguments: '' },
        ] },
        // 用户随后发的消息中没有对应的 tool-result。
        { role: 'user', content: 'continue' },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // 孤儿 tool_calls 必须被剥离，否则后端永久 400、会话报废。
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：只有部分工具调用拿到结果时同样不合法——后端要求 tool_calls 中
  // 的每一个 id 都有对应 tool 消息，缺一个就整体拒绝。
  it('drops a whole tool_calls batch when only part of it has results', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        // 只有 call_1 拿到结果；call_2 是孤儿。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：孤儿的 role:'tool' 消息（没有对应的前置 tool_call）同样会被后端
  // 拒绝。assistant 消息被丢弃时可能出现，必须一并清理。
  it('drops orphan tool result messages', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'hi' },
        // 没有任何 assistant tool_call 与之对应。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    expect(payload.messages.some((m) => m.role === 'tool')).toBe(false)
  })

  // 保序回归：正常的工具往返（每个 tool_call 都有结果）必须原样保留，
  // 清理逻辑不得误伤健康会话。
  it('keeps well-formed tool round-trips intact', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'A' }] },
          { type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'B' }] },
        ] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toHaveLength(2)
    expect(payload.messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('sends tools and the system prompt', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }] as never,
      tools: [{ name: 'shell', description: 'run a command', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
    } as never)
    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>>; tools?: unknown[] }
    expect(payload.messages[0]).toMatchObject({ role: 'system', content: 'You are helpful' })
    expect(payload.tools).toMatchObject([{ type: 'function', function: { name: 'shell' } }])
  })
})

/** 收集流中所有 chunk；流抛错时 reject。 */
async function collectChunks(adapter: BuddyAdapter, options: never): Promise<Array<Record<string, any>>> {
  const chunks: Array<Record<string, any>> = []
  for await (const chunk of adapter.stream(options as never)) {
    chunks.push(chunk as unknown as Record<string, any>)
  }
  return chunks
}

/**
 * 账号池限流切换。
 *
 * 覆盖的关键行为：一个账号触发用量限制后，应逐个尝试其余可用账号，
 * **每个失败账号都要记录其限流重置时间**（UI 据此展示限流标记），
 * 只有真正试完全部候选才报"所有账号均受限"。此前实现只试一个账号
 * 就下结论，导致"UI 上还有未限流账号，对话却报全部受限"。
 */
describe('BuddyAdapter 账号池限流切换', () => {
  /** 构造 6004 频率限制响应体。resetAt 用远未来时间，避免测试随时钟漂移。 */
  function rateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置，您也可以切换其他模型继续使用。',
    })
  }

  /**
   * 国际版（WorkBuddy）英文 6004 响应体 —— 用户报障原文。
   *
   * 与 {@link rateLimitBody} 的唯一差别是语言（以及句式）。两者都必须能
   * 触发账号切换：服务端对同一业务码返回哪种语言，取决于请求落在哪个区域。
   */
  function intlRateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: "usage exceeds frequency limit, but don't worry, your usage will reset at "
        + '2099-12-31 23:59:59 UTC+8, alternatively, you can switch to the other models to continue using it.',
      requestId: 'ffb5bd97-2036-48a0-baba-a56c6ab13c9c',
    })
  }

  /**
   * 记录 updateModelRateLimit / getAvailableAccount 调用的轻量 AccountPool 替身。
   * @param current - 会话开始时就已启用的当前账号（token 与 resolveCredential 一致）
   * @param candidates - 切换时按顺序返回的候选账号
   */
  function makePool(
    current: { id: string; token: string },
    candidates: Array<{ id: string; token: string }>,
  ) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const known = [current, ...candidates]
    const queue = [...candidates]
    return {
      recorded,
      /** 适配器用凭据内容反查账号 id。 */
      async findAccountIdByCredential(_provider: string, identity: string) {
        return known.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount() {
        const next = queue.shift()
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
      },
    }
  }

  it('逐个尝试所有账号，每个失败账号都被记录限流', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 与 AT2 都限流，AT3 成功 —— 三个账号各试一次
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 三个账号都被尝试过，最终由 AT3 成功返回内容
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言：失败的两个账号都被记录了限流时间（UI 才能显示标记）
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    expect(pool.recorded.every((r) => r.resetAtMs > Date.now())).toBe(true)
  })

  /**
   * 回归：**空体 429** 必须同样触发换号，并写入限流标记。
   *
   * ## 真实缺陷（用户报障）
   *
   * 「账号池里明明还有可用账号，插件却直接报错、也不换号」——本可自愈的限流变成
   * 硬失败。
   *
   * 根因：`isRateLimited` 原先只接收响应体（判据是业务码 6004 或中英文限流文案），
   * 而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的 429 —— 两个判据双双
   * 不命中 → 返回 false → `if (accountPool && isRateLimited(errorText))` 这整块被
   * 跳过，既不切账号、也不写 `modelRateLimits`。
   *
   * ⚠️ 本用例的响应体刻意是**空串**：换任何含限流措辞的正文，缺陷就不会暴露
   * （那正是上面那些 6004 用例覆盖不到它的原因）。
   *
   * ⚠️ 空体 429 的另一个必然后果是「没有重置时间可解析」（`parseRateLimitError`
   * 拿不到 `msg`），所以标记必须走**兜底时长**而不是静默跳过 —— 否则 UI 上不会
   * 出现任何限流标记，「重测 / 重置」两条人工解禁路径也就无从操作
   * （与 `lobsterai-adapter` 对纯文本 429 的兜底同一口径）。
   */
  it('空体 429 也触发换号，并写入限流标记（状态码兜底，不只认正文）', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [{ id: 'acct-2', token: 'AT2' }],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 返回**空体 429**（无线索可判），AT2 成功 —— 必须换到 AT2。
        if (token === 'AT2') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response('', { status: 429 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 关键断言 1：换号确实发生了。修复前这里只有 ['AT1']，随后直接抛原始 429。
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    // 关键断言 2：最终拿到内容，而不是把 429 抛给用户。
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言 3：失败账号被写入限流标记（空体无时间可解析 → 用兜底时长），
    // 否则 UI 既不显示限流、用户也无法用「重测 / 重置」人工解禁。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
    expect(pool.recorded[0]!.modelId).toBe(DEFAULT_MODEL)
    expect(pool.recorded[0]!.resetAtMs).toBeGreaterThan(Date.now())
  })

  it('全部账号限流后才报错，且错误码为不可重试的 QUOTA_EXCEEDED', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    // 两个账号都被记录了限流
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })

  it('切换到的新账号以非限流错误失败时，抛出原始错误而非"全部受限"', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        if (token === 'AT2') {
          return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 不应被吞成 QUOTA_EXCEEDED —— 这是模型/请求错误，需要如实上报
    expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
    expect((error as LlmError).message).toContain('model not found')
  })

  /**
   * 国际版（WorkBuddy）英文 6004 必须同样触发账号切换。
   *
   * 历史缺陷（用户报障）：限流判定与重置时间解析都只认中文文案，而国际版
   * 返回的是英文 `usage exceeds frequency limit ... reset at <时间> UTC+8`。
   * 于是 `isRateLimited` 恒为 false，适配器**只试了当前账号就抛原始 JSON**
   * （用户看到的正是 `buddy: {"code":6004,...}`），既没切换账号，也没记录
   * 限流标记。国内版返回中文，故该缺陷只在国际版复现。
   *
   * 本用例锁死「英文 6004 → 逐个尝试其余账号 → 成功账号产出内容」的完整链路。
   */
  it('国际版英文 6004 同样触发账号切换，并记录限流标记', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      product: WORKBUDDY,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 与 AT2 都被英文 6004 拒绝，AT3 成功
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response(intlRateLimitBody(), { status: 400 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 关键断言 1：确实换了账号（旧实现只会发 AT1 一次）
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    // 关键断言 2：最终拿到内容，而不是把 6004 抛给用户
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言 3：失败账号都被记录限流（UI 才能显示标记），且用的是真实重置时间
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    // 英文报文里的重置时间是 2099 年（远未来），不能是 fallback 的「1 小时后」
    expect(pool.recorded.every((r) => r.resetAtMs > Date.parse('2090-01-01'))).toBe(true)
  })

  it('国际版英文 6004 全部账号受限时报 QUOTA_EXCEEDED（而非原始 400）', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      product: WORKBUDDY,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(intlRateLimitBody(), { status: 400 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 关键：错误码必须是不可重试的 QUOTA_EXCEEDED。
    // 旧实现因 HTTP 400 退化成 INVALID_REQUEST，且两个账号都被试过（证明切换生效）
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })

  /**
   * 限流换号途中撞上安全策略拦截（11140）。
   *
   * ## 真实缺陷（用户报障 2026-09-28「本轮运行失败 · API 密钥无效」）
   *
   * 适配器有**两条**换号路径，早期实现只在认证路径（首发 401/403）里识别
   * 11140；限流路径（首发 429/6004）遇到非限流错误就**直接抛**，于是：
   *
   * - 池里前几个账号恰是被 11140 拦截的坏账号 → 换号在第 1 个坏账号处**中断**，
   *   后面的可用账号永远试不到（实测复刻：中断于 #1，不中断则 #4 即成功）；
   * - 错误码取 `httpErrorCode(403)` = `AUTH` → UI 渲染成「API 密钥无效」，
   *   把用户引向检查密钥，而 7 个 token 实测**全部有效**（2027-09 才过期）。
   *
   * 修复后两条路径语义一致：11140 与 401/403 一样只是「这个账号不可用」，
   * 继续换号；全部试完才报专门的「安全策略」提示。
   */
  function safetyBody(): string {
    return JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      requestId: '5b2240b4-efdf-40e0-94e4-cfee1aa80585',
      displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
    })
  }

  it('限流换号途中撞上安全策略（11140）时继续换号，换到可用账号即成功', async () => {
    // 复刻真实池顺序：AT1 限流 → AT2 被 11140 拦 → AT3 可用。
    // 修复前换号在 AT2 处中断并抛 AUTH（UI 显示「API 密钥无效」）。
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        // AT1 限流（触发限流换号路径）；AT2 安全策略拦截（HTTP 403）。
        if (token === 'AT1') return new Response(rateLimitBody(), { status: 400 })
        return new Response(safetyBody(), { status: 403 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 关键：三个账号都被试过 —— AT2 的 11140 没有中断换号。
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // AT1 的限流被记录；AT2 的安全拦截**另记一条冷却**（ !16 之前这里完全不记，
    // 于是那个坏账号下一轮仍排第一、每轮重撞 —— 见 `markPolicyBlockedAccount`）。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    // 两条记录必须能区分开：acct-1 是**服务端给的**重置时刻（2099-12-31），
    // acct-2 是**我们自己定的** 30 分钟冷却。绝不能把 11140 冒充成服务端限流，
    // 也不能复用 `parseRateLimitError` 解析不到时那个 1 小时兜底。
    const rl = pool.recorded.find((r) => r.accountId === 'acct-1')
    const blocked = pool.recorded.find((r) => r.accountId === 'acct-2')
    expect(rl?.resetAtMs).toBeGreaterThan(Date.parse('2090-01-01'))
    expect(Math.abs((blocked?.resetAtMs ?? 0) - policyBlockResetAtMs(Date.now()))).toBeLessThanOrEqual(5_000)
    // 只标该模型（同 qoder 额度那条口径）：11140 是否跨模型无实测依据，
    // 标全部模型会误伤该账号本可用的组合。
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
  })

  it('限流换号途中撞上安全策略且全部试完：报「安全策略」而非 QUOTA_EXCEEDED', async () => {
    // AT1 限流 → AT2 被 11140 拦 → 候选耗尽。此时真实原因是安全策略拦截
    // （账号不可用），不是「所有账号都限流」，文案必须指向账号。
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        return auth.includes('AT1')
          ? new Response(rateLimitBody(), { status: 400 })
          : new Response(safetyBody(), { status: 403 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 不得吞成「所有账号均受限」——那会把账号拦截误报成限流。
    expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
    expect((error as LlmError).message).toContain('安全策略')
    expect((error as LlmError).message).toContain('账号')
    // 不再断言「请调整内容后重试」把用户引向错误方向。
    expect((error as LlmError).message).not.toContain('请调整内容')
  })

  it('限流换号途中遇到真正的认证失败（401）同样继续换号', async () => {
    // 与上一条同源：限流路径此前只认「限流」，401/403 都会中断换号。
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        if (token === 'AT1') return new Response(rateLimitBody(), { status: 400 })
        return new Response(JSON.stringify({ error: { message: 'token expired' } }), { status: 401 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })

  /**
   * 模型饱和（14003）—— **不换号、不标记、留在本账号退避重试**
   * （真实缺陷，用户报障 2026-10-05）
   *
   * ## 为什么这一组是「行为级」而非「纯函数级」
   *
   * `isModelSaturationError` 的纯函数用例（`buddy-model-saturation.spec.ts`）
   * 只证明判据本身对。但**缺陷的成因是判据顺序**：
   * `14003` **也是 HTTP 429**，而 `isRateLimited` 对 429 无条件为 true ——
   * 只要饱和判定晚于限流分支一步，整池就会被写上 1 小时标记。
   * 所以必须在**真实 `stream()` 调用流**里断言
   * 「`updateModelRateLimit` 一次都没被调用」+「`getAvailableAccount` 没被调用」。
   *
   * 用户症状：第一次用 `buddy/space-bunny` 就报「所有账号均受限」，
   * 而 4 个账号凭据全部有效、服务端实测完全可用。
   */
  describe('模型饱和（14003）不换号、不标记', () => {
    /** 实测原文（4 MB 输入逼出，`scripts/probe-buddy-error-catalog.mjs`）。 */
    function saturationBody(): string {
      return JSON.stringify({
        code: 14003,
        msg: 'too many requests',
        requestId: 'ac2ff1af-6d6b-49b4-8614-14981aed34d8',
        displayMsg: { en: 'Model busy. Please switch models or retry later', zh: '模型繁忙，请换模型或稍后重试' },
        displayTips: {
          en: 'This model is currently saturated. It is not a network issue.',
          zh: '这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。',
        },
        actions: ['SWITCH_MODEL', 'SUBMIT_FEEDBACK', 'RETRY'],
      })
    }

    /**
     * 记录「换号 / 标记」两类副作用的轻量池替身。
     *
     * ⚠️ 与上面 `makePool` 的差别：这里两个副作用各自计数，因为本组用例的
     * **核心断言就是「两者都必须为 0」** —— 只记录标记会漏掉「白换号」
     * （那也是缺陷的一面：换号会让 4 个可用账号被逐个浪费）。
     */
    function makeCountingPool(current: { id: string; token: string }, candidates: Array<{ id: string; token: string }>) {
      const known = [current, ...candidates]
      const queue = [...candidates]
      return {
        marked: [] as Array<{ accountId: string; modelId: string; resetAtMs: number }>,
        rotations: 0,
        async findAccountIdByCredential(_provider: string, identity: string) {
          return known.find((a) => a.token === identity)?.id ?? ''
        },
        async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
          this.marked.push({ accountId, modelId, resetAtMs })
        },
        async getAvailableAccount() {
          this.rotations += 1
          const next = queue.shift()
          if (next === undefined) return null
          return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
        },
      }
    }

    it('⚠️ 饱和重试用尽后：**不写限流标记**，且**不切换账号**（缺陷本体）', async () => {
      // 退避压到 0 毫秒，让用例毫秒级完成（0 是合法值，见 buddySaturationDelayMs）。
      process.env.DSH_BUDDY_SATURATION_DELAY_MS = '0'
      try {
        const pool = makeCountingPool(
          { id: 'acct-1', token: 'AT1' },
          [{ id: 'acct-2', token: 'AT2' }, { id: 'acct-3', token: 'AT3' }],
        )
        const sentTokens: string[] = []
        const adapter = new BuddyAdapter({
          credentialRef: CREDENTIAL_REF,
          resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool as never,
          fetchImpl: async (_url, init) => {
            const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
            sentTokens.push(auth.replace('Bearer ', ''))
            // 始终饱和 —— 复刻「所有账号撞同一堵墙」的真实形态。
            return new Response(saturationBody(), { status: 429 })
          },
        })

        let thrown: unknown
        try {
          await collectChunks(adapter, {
            model: 'space-bunny',
            messages: [{ role: 'user', content: 'hi' }] as never,
            signal: new AbortController().signal,
          } as never)
        } catch (error) { thrown = error }

        // ① 关键断言：**一次标记都没写**（写一条就锁 1 小时，写 N 条就锁整池）
        expect(pool.marked, '饱和绝不能写限流标记 —— 那会把整池锁 1 小时').toEqual([])
        // ② 关键断言：**没有换号**（饱和是模型级，换号无益，只会白烧可用账号）
        expect(pool.rotations, '饱和绝不能换号 —— 池里账号会撞同一堵墙').toBe(0)
        // ③ 只在本账号重试：1 次首发 + 2 次退避重试，token 始终是 AT1
        expect(sentTokens).toEqual(['AT1', 'AT1', 'AT1'])
        // ④ 报错必须指向「换模型」这个唯一有效动作，且**不许**说成账号额度受限
        const message = String((thrown as Error | undefined)?.message ?? '')
        expect(message).toContain('请求量饱和')
        expect(message).toContain('换')          // 「请改用其它模型」
        expect(message).toContain('无需重新登录')
        expect(message).not.toContain('所有账号均受限')
        // ⑤ 错误码用 RATE_LIMIT（可重试），不是 QUOTA_EXCEEDED（= 账号额度用尽，确定性）
        expect((thrown as { code?: string } | undefined)?.code).toBe('RATE_LIMIT')
      } finally {
        delete process.env.DSH_BUDDY_SATURATION_DELAY_MS
      }
    })

    it('饱和后**恢复**：重试期间转好则正常产出内容（不换号、不标记）', async () => {
      process.env.DSH_BUDDY_SATURATION_DELAY_MS = '0'
      try {
        const pool = makeCountingPool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
        let attempt = 0
        const adapter = new BuddyAdapter({
          credentialRef: CREDENTIAL_REF,
          resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool as never,
          fetchImpl: async () => {
            attempt += 1
            // 第 1 发饱和，第 2 发（退避后）已恢复 —— 与真实「瞬时背压」一致。
            if (attempt === 1) return new Response(saturationBody(), { status: 429 })
            return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          },
        })

        const chunks = await collectChunks(adapter, {
          model: 'space-bunny',
          messages: [{ role: 'user', content: 'hi' }] as never,
          signal: new AbortController().signal,
        } as never)

        expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
        expect(pool.marked).toEqual([])
        expect(pool.rotations).toBe(0)
        expect(attempt).toBe(2)
      } finally {
        delete process.env.DSH_BUDDY_SATURATION_DELAY_MS
      }
    })

    it('⚠️ 额度限流 6004 的既有行为**不许**被本修复改回退（换号 + 标记仍然生效）', async () => {
      // 反向保护：饱和判定若写得太宽，会把这个用例吃掉 —— 那意味着
      // 「账号额度用完」不再换号，用户永远等不到其它可用账号。
      const pool = makeCountingPool(
        { id: 'acct-1', token: 'AT1' },
        [{ id: 'acct-2', token: 'AT2' }],
      )
      const sentTokens: string[] = []
      const adapter = new BuddyAdapter({
        credentialRef: CREDENTIAL_REF,
        resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool as never,
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          const token = auth.replace('Bearer ', '')
          sentTokens.push(token)
          if (token === 'AT2') {
            return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          }
          return new Response(rateLimitBody(), { status: 429 })
        },
      })

      const chunks = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)

      // 6004 必须仍然换号，并为失败账号留下标记
      expect(sentTokens).toEqual(['AT1', 'AT2'])
      expect(pool.marked.length).toBeGreaterThan(0)
      expect(pool.marked[0]?.accountId).toBe('acct-1')
      expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    })
  })
})

/** 端点常量供测试断言引用（避免硬编码字符串漂移）。 */
export { CHAT_API_BASE }

describe('产品参数化', () => {
  it('默认构造时 providerInfo 返回 buddy', () => {
    expect(makeAdapter().providerInfo('buddy')).toMatchObject({
      id: 'buddy', name: 'CodeBuddy (腾讯)',
    })
  })

  it('传入 WorkBuddy 配置时 providerInfo 返回 workbuddy', () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    const info = adapter.providerInfo('workbuddy')
    // DSH 强制校验 info.id === 传入的 provider
    expect(info.id).toBe('workbuddy')
    expect(typeof info.name).toBe('string')
    expect(info.name.length).toBeGreaterThan(0)
  })

  it('WorkBuddy 适配器的 listModels 使用 workbuddy 作为 provider 字段', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.provider === 'workbuddy')).toBe(true)
  })

  it('WorkBuddy 适配器请求带 X-Product-Code: workbuddy', async () => {
    let productCode: string | null = null
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
      fetchImpl: async (_url, init) => {
        productCode = (init?.headers as Headers).get('X-Product-Code')
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(productCode).toBe('workbuddy')
  })

  /**
   * ⚠️ **真实缺陷**（本轮 e2e 实测发现）：同一个类的错误文案里前缀**混用** ——
   * 12 处硬编码 `buddy:`、7 处用 `${this.product.id}`。于是 WorkBuddy 用户
   * 看到的报错自称「buddy: …」，日志与 UI 都指错产品，排查时容易找错面板
   *（实测原话：`buddy: 对话内容超出模型长度上限，请精简对话或减少附件后重试。`）。
   *
   * 这里对**两个产品**都断言，因为只测写死的那一个就发现不了这种混用 ——
   * 只有对比才看得出前缀没跟着产品走。
   *
   * ⚠️ 边界：本用例只走得到**「非换号路径」的那一处**（无账号池时 `stream()`
   * 在首次请求失败后直接抛）。其余 11 处散在换号重试 / SSE / transport /
   * 附件读取等分支上，逐个造场景代价很高且脆弱 —— 那部分交给下面那条
   * 源码级不变量兜底（已反向验证：本用例对换号路径的变异**抓不到**）。
   */
  it('错误文案的前缀跟随产品（workbuddy 不得自称 buddy）', async () => {
    for (const [product, expected] of [
      [CODEBUDDY, 'buddy'],
      [WORKBUDDY, 'workbuddy'],
    ] as const) {
      const adapter = new BuddyAdapter({
        credentialRef: credentialRef(product.defaultCredentialRef),
        resolveCredential: async () => makeCredential(),
        refresh: async () => {},
        product,
        fetchImpl: async () => new Response(JSON.stringify({ code: 1, msg: 'boom' }), { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      expect(
        (error as LlmError).message.startsWith(`${expected}: `),
        `${expected} 的报错前缀错了，实际是：${(error as LlmError).message}`,
      ).toBe(true)
    }
  })

  /**
   * ⚠️ **源码级不变量**：`buddy-adapter.ts` 里**不允许**再出现硬编码的
   * `buddy:` 错误前缀 —— 它必须写成 `${this.product.id}: `。
   *
   * 为什么不能只用行为用例：那 12 处散在「首次请求 / 换号重试 / 限流耗尽 /
   * SSE / transport / 附件读取」六条互不相同的路径上，行为用例一次只能覆盖
   * 一条。**已反向验证过这个缺陷**：把第 1539 行（换号路径）改回 `buddy: `
   * 后，上面那条行为用例仍然全绿 —— 所以它挡不住其余 11 处。
   *
   * 这也是本仓库既有的取舍（见 `tests/unit/image-budget.spec.ts` 的
   * 「五处同形代码」注释）：为这种重复形状搭多套适配器桩的成本，远高于
   * 一条源码断言的维护成本，而共享实现本身已有行为用例。
   */
  it('源码里没有硬编码的 buddy: 错误前缀（必须跟随 product.id）', () => {
    const file = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../src/buddy-adapter.ts')
    const source = readFileSync(file, 'utf8')
    // 注释里会引用这句错误文案作证据（如实测原文），必须排除掉，
    // 否则用例会因为「注释提到了 buddy:」而假失败。
    //
    // ⚠️ 块注释**替换成等量空白**而不是整体删除：直接删会把行数压掉，
    // 于是下面报出的行号指向源文件里另一个位置（实测偏了 600+ 行，
    // 排障时会被引到完全无关的代码上）。保留 `\n`、其余字符换成空格，
    // 行号就与源文件一致了。`//` 行注释不含换行，直接删是安全的。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/\/\/.*$/gm, '')

    const offenders = [...code.matchAll(/(`|')buddy: /g)].map((m) => {
      const line = code.slice(0, m.index).split('\n').length
      return `第 ${line} 行：${source.split('\n')[line - 1]?.trim().slice(0, 80)}`
    })
    expect(
      offenders,
      '这些位置的错误前缀写死了 buddy:，WorkBuddy 用户会看到错的产品名；'
      + '改成 ${this.product.id}: ',
    ).toEqual([])
  })

  // ── 以下为补充用例：brief 的 4 条未能覆盖 UA、注册路由与默认回退 ──

  it('默认构造的适配器使用 CodeBuddy 的产品码与 User-Agent', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('X-Product-Code')).toBe(CODEBUDDY.productCode)
    expect(seen!.get('User-Agent')).toBe(CODEBUDDY.userAgent)
    // X-Product 是**归属名**（产品名），不是部署类型。
    expect(seen!.get('X-Product')).toBe('CodeBuddy')
    // 归属头族：后台「使用端」列按这组头归因。
    expect(seen!.get('X-Agent-Purpose')).toBe('conversation')
    expect(seen!.get('X-IDE-Name')).toBe('CodeBuddy')
    expect(seen!.get('X-IDE-Type')).toBe('CodeBuddy')
    expect(seen!.get('X-IDE-Version')).toBe(CODEBUDDY.clientVersion)
  })

  it('WorkBuddy 适配器使用自身 product 的 productCode、User-Agent 与 providerInfo 展示名', async () => {
    // deepseek-v4-flash 不命中任何模型族规则 → 回落到 product.userAgent，
    // 故注入自定义 UA 的 product 仍能被观测到。
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/7.7.7' }
    let seen: Headers | undefined
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('X-Product-Code')).toBe('workbuddy')
    expect(seen!.get('User-Agent')).toBe('WorkBuddy/7.7.7')
    expect(seen!.get('X-Product')).toBe('WorkBuddy')
    expect(seen!.get('X-IDE-Name')).toBe('WorkBuddy')
    expect(adapter.providerInfo('workbuddy').name).toBe(WORKBUDDY.displayName)
  })

  it('send() 的 User-Agent 取自 product 而非固定常量', async () => {
    // 反向验证：默认 CodeBuddy 的 UA 与注入值必须不同，否则该断言无意义。
    const custom: BuddyProduct = { ...CODEBUDDY, userAgent: 'CustomAgent/9.9.9' }
    expect(custom.userAgent).not.toBe(CODEBUDDY.userAgent)
    let seen: Headers | undefined
    const adapter = makeAdapter({
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('User-Agent')).toBe('CustomAgent/9.9.9')
  })

  // ── 按模型族分档的 User-Agent ──

  it('WorkBuddy 的 UA 按模型族分档：GPT 系走国际版形态，GLM 系走国内形态', async () => {
    const uaFor = async (model: string): Promise<string | null> => {
      let seen: Headers | undefined
      const adapter = new BuddyAdapter({
        credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
        resolveCredential: async () => makeCredential(),
        refresh: async () => {},
        product: WORKBUDDY,
        fetchImpl: async (_url, init) => {
          seen = new Headers(init?.headers as HeadersInit)
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)
      return seen!.get('User-Agent')
    }

    // 国际版独有模型线 → 国际版形态（平台段为 `WorkBuddy AI`）。
    expect(await uaFor('gpt-5.6-sol')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    expect(await uaFor('gemini-3.5-flash')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    // 国内系模型 → 国内客户端形态（平台段为 `WorkBuddy`）。
    expect(await uaFor('glm-5.2')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    expect(await uaFor('hy3')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    expect(await uaFor('kimi-k3')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    // 未命中任何模型族规则 → 回落到 product.userAgent（默认国际版形态）。
    expect(await uaFor('deepseek-v4.1-flash')).toBe(WORKBUDDY.userAgent)
  })

  it('分档后的 UA 仍含产品品牌字样，不会退化成框架的 harness UA', async () => {
    // 归因前提：腾讯后台按出站 UA 归因「使用端」，UA 必须含 WorkBuddy/CodeBuddy 字样。
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/9.9.9' }
    let seen: Headers | undefined
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    const ua = seen!.get('User-Agent')!
    expect(ua).toContain('WorkBuddy')
    expect(ua).not.toContain('deepseek-harness')
  })

  it('providerInfo 对非字符串入参回退到本产品的 id', () => {    // 上游传入 undefined 时不得让 deriveKeyRef 的 toUpperCase 崩在客户端。
    const workbuddy = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    expect(workbuddy.providerInfo(undefined as never).id).toBe('workbuddy')
    expect(makeAdapter().providerInfo('' as never).id).toBe(CODEBUDDY.id)
  })

  /** 记录注册入参的假 llm 服务。 */
  function makeLlm() {
    const providers: Array<{ provider: string; displayName: string; settingsNs: string }> = []
    const adapters: string[][] = []
    const instances: unknown[] = []
    return {
      providers,
      adapters,
      instances,
      llm: {
        registerConfigurableProviders(entries: Array<{ provider: string; displayName: string; settingsNs: string }>) {
          providers.push(...entries)
          return { replace: () => {} }
        },
        registerAdapter(names: string[], adapter: unknown) {
          adapters.push(names)
          instances.push(adapter)
          return { replace: () => {} }
        },
      },
    }
  }

  it('registerBuddyLlm 默认只注册 buddy 路由（不声明可配置 provider）', () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
    })
    // ⚠️ 2026-10-01（用户要求）：不再向「设置 → 模型 → 提供商」声明配置行 ——
    // 账号与模型开关都在 Jet Hub 设置页管理（见 src/llm-register-compat.ts 模块头）。
    expect(fake.providers).toEqual([])
    expect(fake.adapters).toEqual([['buddy']])
  })

  it('registerBuddyLlm 传入 WorkBuddy 时只注册 workbuddy 路由（不声明可配置 provider）', () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    expect(fake.providers).toEqual([])
    expect(fake.adapters).toEqual([['workbuddy']])
  })

  it('registerBuddyLlm 注册的适配器与其路由使用同一产品', async () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    // 注册进 llm 的适配器实例必须自己就是 WorkBuddy 产品（而非 CodeBuddy），
    // 否则路由名为 workbuddy 却发 codebuddy 的身份标识。
    const adapter = fake.instances[0] as BuddyAdapter
    expect(adapter.providerInfo('workbuddy')).toMatchObject({ id: 'workbuddy', name: WORKBUDDY.displayName })
    expect((await adapter.listModels('workbuddy')).every((m) => m.provider === 'workbuddy')).toBe(true)
  })
})

/**
 * 账号池 provider 实参。
 *
 * 适配器调用账号池时必须传「本适配器所属产品的 id」，而不是写死的 'buddy'。
 * AccountPool 内部先按 `entry.provider !== provider` 过滤账号，WorkBuddy 账号的
 * provider 是 'workbuddy'，传 'buddy' 会永远匹配不到：
 *   - findAccountIdByCredential 恒返回 '' → 限流重置时间无法归属账号 → UI 永不显示限流标记；
 *   - getAvailableAccount 恒返回 null → 限流后无法自动切换账号。
 * 即 WorkBuddy 的账号池功能（限流归属 + 自动切换）会完全失效。
 */
describe('BuddyAdapter 向账号池传递的 provider', () => {
  /** 6004 频率限制响应体（resetAt 取远未来，避免测试随时钟漂移）。 */
  function rateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置',
    })
  }

  /**
   * 记录被查询 provider 的账号池替身。
   * @returns queried - 按调用顺序记录 findAccountIdByCredential / getAvailableAccount 收到的 provider
   */
  function makeRecordingPool() {
    const queried: string[] = []
    return {
      queried,
      async listAccounts() {
        return []
      },
      async findAccountIdByCredential(provider: string) {
        queried.push(provider)
        return 'acct-current'
      },
      async updateModelRateLimit() {},
      async getAvailableAccount(provider: string) {
        queried.push(provider)
        return null
      },
    }
  }

  it('WorkBuddy 适配器以 workbuddy 作为 provider 查询账号池', async () => {
    const pool = makeRecordingPool()
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })

    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch(() => {})

    // 两条路径都被走到；且都必须是 'workbuddy'，出现 'buddy' 即为回归。
    expect(pool.queried.length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.filter((p) => p === 'workbuddy').length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.every((p) => p === 'workbuddy')).toBe(true)
  })

  it('CodeBuddy 适配器仍以 buddy 作为 provider 查询账号池', async () => {
    const pool = makeRecordingPool()
    // 不传 product：适配器回退到 CodeBuddy，provider 应为 'buddy'。
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })
    expect(adapter.providerInfo('buddy').id).toBe(CODEBUDDY.id)

    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch(() => {})

    // 对称性防守：修 WorkBuddy 时不得把 CodeBuddy 也改成 workbuddy。
    expect(pool.queried.length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.every((p) => p === 'buddy')).toBe(true)
  })
})

describe('产品兜底模型目录校正', () => {
  /** 造一个只有 2 个模型的假产品，便于精确断言校正行为。 */
  const fakeProduct = {
    ...WORKBUDDY,
    fallbackModels: [
      { id: 'wanted-a', name: 'Wanted A', contextWindow: 111_000 },
      { id: 'wanted-b', name: 'Wanted B', contextWindow: 222_000 },
    ],
  }

  it('远端多出来的条目被丢弃（只保留兜底表声明的）', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      // 远端返回的是残缺/错误的集合（多出的 junk 与缺失的 wanted-b）
      fetchRemoteModels: async () => [{ id: 'junk', name: 'Junk' }, { id: 'wanted-a', name: 'Wanted A' }],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
  })

  it('兜底表声明但远端缺失的条目被补进来', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [{ id: 'wanted-a', name: 'Wanted A' }],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
    // 补齐的条目用兜底表的名称
    expect(models[1]!.name).toBe('Wanted B')
  })

  it('远端元数据优先于兜底表（远端更权威）', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [
        { id: 'wanted-a', name: 'Remote A', contextWindow: 999_000 },
      ],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models[0]!.name).toBe('Remote A')
    const resolved = await adapter.resolveModel('workbuddy', 'wanted-a')
    expect(resolved.name).toBe('Remote A')
    expect(resolved.context?.contextWindow).toBe(999_000)
  })

  it('远端不可用时用兜底表的名称与上下文窗口', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
    const resolved = await adapter.resolveModel('workbuddy', 'wanted-b')
    expect(resolved.name).toBe('Wanted B')
    expect(resolved.context?.contextWindow).toBe(222_000)
  })

  it('没有兜底表的产品不受影响（保持既有远端行为）', async () => {
    const noFallback = { ...WORKBUDDY, fallbackModels: undefined }
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: noFallback as never,
      fetchRemoteModels: async () => [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['x', 'y'])
  })
})

/**
 * 模型黑名单对 listModels 的过滤。
 *
 * 这是「关闭开关 → 对话框不再显示该模型」这条链路的关键一环：
 * /api/session 的模型目录正是通过 ctx.llm.listModels() → 适配器 listModels()
 * 构建的。此处断言适配器确实把黑名单里的模型摘掉了。
 */
describe('BuddyAdapter 模型黑名单', () => {
  /** 只实现 listModels 所需方法的账号池替身。 */
  function poolWithDisabled(provider: string, ids: string[]) {
    const disabled = new Set(ids)
    return {
      disabledModelsFor: (value: string) => (value === provider ? disabled : new Set<string>()),
    } as never
  }

  it('被关闭的模型从列表中消失，其余保持原有顺序', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', ['glm-5.2', 'hy3']) })
    const models = await adapter.listModels('buddy')
    const ids = models.map((m) => m.id)

    expect(ids).not.toContain('glm-5.2')
    expect(ids).not.toContain('hy3')
    // 未关闭的模型一个都不能少，且顺序不变（顺序即选择器的展示顺序）
    expect(ids).toEqual(
      CODEBUDDY.fallbackModels!.map((m) => m.id).filter((id) => id !== 'glm-5.2' && id !== 'hy3'),
    )
  })

  it('空黑名单不改变列表（默认全开）', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', []) })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
  })

  it('没有账号池时不过滤（适配器可脱离账号池使用）', async () => {
    const models = await makeAdapter().listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
  })

  it('黑名单按产品 id 隔离：workbuddy 的关闭项不影响 buddy', async () => {
    const adapter = makeAdapter({
      accountPool: {
        // 只对 workbuddy 报告黑名单
        disabledModelsFor: (value: string) => (value === 'workbuddy' ? new Set(['glm-5.2']) : new Set<string>()),
      } as never,
    })
    const ids = (await adapter.listModels('buddy')).map((m) => m.id)
    expect(ids).toContain('glm-5.2')
  })

  it('关闭不影响 resolveModel/stream 的路由能力（目录只是建议性的）', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', ['glm-5.2']) })
    // listModels 里已消失……
    expect((await adapter.listModels('buddy')).map((m) => m.id)).not.toContain('glm-5.2')
    // ……但仍可解析元数据（DSH 契约要求目录缺省不构成请求拒绝）
    const resolved = await adapter.resolveModel('buddy', 'glm-5.2')
    expect(resolved.id).toBe('glm-5.2')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })
})

// ── 目录门控：没有已登录账号就不显示该 provider 的模型 ──
//
// DSH 的 `buildModelCatalog` 显式 `.filter(group => group.models.length > 0)`，
// 故返回空数组即让整个 provider 分组消失（用户需求：减少模型选择列表臃肿）。
describe('BuddyAdapter 目录门控（无已登录账号时隐藏）', () => {
  /** 账号池替身：报告是否有已登录账号。 */
  function poolWithLogin(loggedIn: boolean) {
    return {
      disabledModelsFor: () => new Set<string>(),
      hasLoggedInAccount: async () => loggedIn,
    } as never
  }

  it('没有已登录账号 → 返回空数组', async () => {
    const adapter = makeAdapter({ accountPool: poolWithLogin(false) })
    expect(await adapter.listModels('buddy')).toEqual([])
  })

  it('有已登录账号 → 正常返回目录', async () => {
    const adapter = makeAdapter({ accountPool: poolWithLogin(true) })
    expect((await adapter.listModels('buddy')).length).toBeGreaterThan(0)
  })

  it('accountPool 缺失时保守放行（判定不可用 ≠ 无账号）', async () => {
    const adapter = makeAdapter()
    expect((await adapter.listModels('buddy')).length).toBeGreaterThan(0)
  })

  it('未实现 hasLoggedInAccount 的替身同样保守放行', async () => {
    // 门控是展示优化而非安全边界：判定不可用时宁多勿少。
    const adapter = makeAdapter({
      accountPool: { disabledModelsFor: () => new Set<string>() } as never,
    })
    expect((await adapter.listModels('buddy')).length).toBeGreaterThan(0)
  })
})

/**
 * 安全策略拦截（11140）的两项补修。
 *
 * ## ① 被拦账号的冷却标记
 *
 * !15 / !16 让「有可用账号就一定能用上」成立，但**每轮都要重撞坏账号**：
 * 候选顺序是用户在 Jet Hub 拖拽定的（`getAvailableAccount` 不再按重置时间重排），
 * 实测那个池是「前 4 个被 11140 拦、后 3 个可用」——每次请求都固定先发 4 次失败，
 * 白烧额度、白等往返，且下一轮一模一样。
 *
 * ## ② HTTP 200 + SSE 流内的 11140
 *
 * 这形态**实测存在**（同一报文在 CodeArts 侧就以流内错误帧下发），而 buddy 的
 * 帧类型原先没有 `code` / `msg` 字段：既没内容也没报错，UI 表现成「干净地停止」。
 */
describe('安全策略拦截（11140）：账号冷却 + 流内错误帧', () => {
  /**
   * 记录 `updateModelRateLimit` 调用的账号池替身。
   *
   * ⚠️ `getAvailableAccount` **必须按 `exclude` 取号**（与 `AccountPool` 同语义）：
   * 直接返回第一个账号会让它等于「刚失败的那个」，命中适配器的 `tried.has` 而
   * 判成「没换到号」，于是走到 `credential expired and refresh failed` 那条早退 ——
   * 测出来的是桩的行为，不是被测代码的。
   */
  function recordingPool(accounts: Array<{ id: string; token: string }>) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      async findAccountIdByCredential(_provider: string, identity: string) {
        return accounts.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount(
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) {
        const next = accounts.find((a) => exclude === undefined || !exclude.has(a.id))
        if (next === undefined) return null
        return {
          entry: { id: next.id },
          credential: makeCredential({ access_token: next.token }),
        }
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  const safetyBodyText = JSON.stringify({
    code: 11140,
    msg: 'request illegal',
    requestId: '5b2240b4-efdf-40e0-94e4-cfee1aa80585',
    displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
  })

  it('冷却时长是 30 分钟，且**不等于**限流解析兜底的那 1 小时', () => {
    // 防回归：有人会把两者合并成一个常量（它们数值相近、都写进 modelRateLimits），
    // 但语义不同 —— 一个是「服务端不给时间」的策略拦截，一个是「解析不到限流时间」的兜底。
    // 合并之后调其中一个会静默改掉另一个。
    expect(policyBlockResetAtMs(0)).toBe(30 * 60_000)
    expect(policyBlockResetAtMs(0)).not.toBe(3_600_000)
  })

  it('认证路径：每个被拦账号都被标冷却，且只标本次要用的那个模型', async () => {
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: pool,
      fetchImpl: async () => new Response(safetyBodyText, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')

    // 两个账号都撞到拦截 → 都被标记（修复前一条都不记，下轮照样从 acct-1 开始重撞）。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    expect(pool.recorded.every(
      (r) => Math.abs(r.resetAtMs - policyBlockResetAtMs(Date.now())) <= 5_000,
    )).toBe(true)
  })

  it('单账号池 + 续期失败：不得把拦截报成 AUTH（早退分支也必须先看 11140）', async () => {
    // 写这批用例时**实测到**的缺陷（补修）：`refreshedCredential === undefined
    // && !rotated` 那条早退只看「续期失败 + 没换到号」——而单账号池必然满足它，
    // 于是真实原因是 11140 时，报出来的却是「credential expired and refresh failed」
    // + `AUTH` → UI 只显示「API 密钥无效」，把用户引向重新登录（token 实测有效）。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: pool,
      fetchImpl: async () => new Response(safetyBodyText, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).not.toContain('credential expired')
    expect((error as LlmError).message).toContain('安全策略')
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
  })

  it('认证路径：换到可用账号后只标坏账号，可用账号不被牵连', async () => {
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: pool,
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response(safetyBodyText, { status: 403 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 只有 acct-1 被标；acct-2 成功产出内容，绝不能被记成不可用。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
  })

  it('冷却标记写不进索引时不反噬：仍报准确的拦截错误', async () => {
    // 与 `src/expiry-sync.ts` 的回写惯例同口径：标记是**附带收益**，
    // 它失败不该把「安全策略拦截」顶替成一个无关的写入错误。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: {
        ...pool,
        updateModelRateLimit: async () => { throw new Error('settings 写入失败') },
      },
      fetchImpl: async () => new Response(safetyBodyText, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).toContain('安全策略')
    expect((error as LlmError).message).not.toContain('settings 写入失败')
  })

  it('流内 11140（HTTP 200 + 错误帧）：不再静默结束，报错并标冷却', async () => {
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      // HTTP 200，但流里第一帧就是 11140 —— 修复前它没有 error / choices 字段，
      // 被一路当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」。
      fetchImpl: async () => sseResponse(`data: ${safetyBodyText}\n\n`),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).toContain('安全策略')
    // 流内这条通道**不重发**（本轮不产出内容才允许重放是 trae 那套结构改造的
    // 前提，本次没做），所以文案如实说「当前账号」，不谎称「已逐个换号重试」。
    expect((error as LlmError).message).toContain('当前账号')
    expect((error as LlmError).message).not.toContain('已逐个换号重试')
    expect((error as LlmError).message).toContain('HTTP 200')
    // 标了冷却 → 下一轮选号就绕开它。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
  })

  it('流内判据必须窄：正文里出现 11140 / 安全审核字样不算拦截', async () => {
    // 模型在讨论审核策略时正常就会说这些词。判据若只看 payload 里的字样，
    // 一个合法回答会被判成「账号被拦」并连带标冷却 —— 那是把功能做没。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const text = '关于 code":11140、「request illegal」与安全审核 的说明'
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async () => sseResponse(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === text)).toBe(true)
    expect(pool.recorded).toEqual([])
  })

  it('没有账号池时流内 11140 仍准确报错（标记跳过、不得崩）', async () => {
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      fetchImpl: async () => sseResponse(`data: ${safetyBodyText}\n\n`),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
  })
})

/**
 * 内容级风控（`code 11128`）**不是账号级拦截** —— Gitee issue IKJNA1。
 *
 * ## 实测报文（本机 2026-10-05，workbuddy / CodeBuddy 双端点一致）
 *
 * ```json
 * {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 *  "requestId":"…","displayMsg":{"en":"The request was blocked by security policy…"}}
 * ```
 *
 * 触发条件是 **system 里的某个模板句**（ZCode 的 gitStatus 注入
 * `Main branch (you will usually use this for PRs)`），与账号无关：同一账号
 * 换掉那一句就通（HTTP 200）。
 *
 * ## 因此这批用例锁的是「**不要**把它认成账号拦截」
 *
 * 认成账号级会走 `isContentRejection` → 换号 + 标 30 分钟冷却
 * （`policyBlockResetAtMs`）。而换号对内容级拦截**完全无效**：池里每个账号
 * 都会在同一句上被拦，等于把整个账号池白锁 30 分钟，用户的整轮 agent 对话
 * 在这半小时内全废 —— 故障从「一句话被拦」放大成「半小时不可用」。
 *
 * 真正的修法在网关出站方向把那一句改写掉，见
 * `tests/unit/openai-gateway-tencent-fingerprint.spec.ts`。
 */
describe('内容级风控（11128）：不得当成账号级拦截换号/冷却', () => {
  const unapprovedChannelBody = JSON.stringify({
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
    requestId: 'c888aa59-d5e0-4047-a74c-6b6999f3004f',
    displayMsg: {
      en: 'The request was blocked by security policy. Please retry later or contact support.',
      zh: '请求被安全策略拦截，请稍后重试或联系支持。',
    },
  })

  /** 与上面 11140 那组同构的账号池替身（记录冷却标记）。 */
  function recordingPool(accounts: Array<{ id: string; token: string }>) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      async findAccountIdByCredential(_provider: string, identity: string) {
        return accounts.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount(
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) {
        const next = accounts.find((a) => exclude === undefined || !exclude.has(a.id))
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  it('★ HTTP 400 + 11128：只发一次、不换号、不标 30 分钟冷却', async () => {
    // 这条是**行为锁**：400 在适配器里走的是「非法请求」早退分支，本来就
    // 不会进入换号/冷却那几条 —— 即便有人日后把 11128 加进
    // `isContentRejection`，这一条也不会红（真正会红的是下面那条流内用例，
    // 因为只有流内那条通道会真的调用该判据）。
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    let calls = 0
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('不该走到续期') },
      accountPool: pool,
      fetchImpl: async () => {
        calls += 1
        return new Response(unapprovedChannelBody, { status: 400 })
      },
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    // 错误必须**抛出来**：静默吞掉会让客户端只显示 reason=unknown（issue 报障原句）。
    expect(error).toBeInstanceOf(LlmError)
    // 只发一次：换号对内容级拦截毫无意义，多发只是白烧往返。
    expect(calls).toBe(1)
    // 关键判据：一个账号都不许被标冷却。
    expect(pool.recorded).toEqual([])
  })

  it('★ HTTP 200 + 流内 11128 帧：同样不得标账号冷却（这条才是判据真会被用到的地方）', async () => {
    // 判据 `isContentRejection` 在**流内**那条通道（HTTP 200 + 无 choices 的
    // 错误帧）会被直接调用。若把 11128 加进去，命中后走的是
    // `markPolicyBlockedAccount` —— 也就是「30 分钟账号冷却」。
    // 而 11128 是**内容级**拦截（同一账号换掉那一句就 200），冷却纯属误伤：
    // 池里每个账号都会在同一句上被拦，用户半小时内整池不可用。
    //
    // 期望：这一帧**不**被当成 11140 那样的账号级拦截，因此不标冷却。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async () => sseResponse(`data: ${unapprovedChannelBody}\n\n`),
    })
    await collectChunks(adapter, streamOptions).catch(() => undefined)
    expect(pool.recorded).toEqual([])
  })

  it('★ 11128 报文里出现「安全审核 / safety review」字样也**不**触发账号冷却', () => {
    // 11128 的 displayMsg 措辞（「blocked by security policy」）与 11140 极近。
    // 判据若被顺手放宽成「看到安全字样就算」，后果同上：整个池被锁 30 分钟。
    expect(unapprovedChannelBody).toContain('11128')
    expect(unapprovedChannelBody).not.toContain('11140')
    expect(unapprovedChannelBody).not.toContain('request illegal')
    // 措辞确实与 11140 高度相似 —— 这正是判据必须按 code 而非按文案收窄的原因。
    expect(unapprovedChannelBody).toMatch(/security policy/i)
  })
})
