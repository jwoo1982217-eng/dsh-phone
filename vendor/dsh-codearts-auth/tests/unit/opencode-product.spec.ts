import { describe, expect, it } from 'vitest'
import { classifyOpencodeError, isFreeOpencodeModel, isReachableOpencodeModel, OPENCODE, OPENCODE_FALLBACK_MODELS } from '../../src/opencode-product.js'

describe('classifyOpencodeError', () => {
  it('FreeUsageLimitError 归为 free_usage_limit（不依赖状态码）', () => {
    const r = classifyOpencodeError(400, '{"error":{"message":"FreeUsageLimitError: free usage exceeded"}}')
    expect(r.kind).toBe('free_usage_limit')
  })

  it('GoUsageLimitError 优先读 retry-after 秒数', () => {
    const r = classifyOpencodeError(429, '{"error":{"message":"GoUsageLimitError"}}', { 'retry-after': '900' })
    expect(r.kind).toBe('go_usage_limit')
    expect(r.retryAfterMs).toBe(900_000)
  })

  it('GoUsageLimitError 的 retry-after 支持 HTTP 日期', () => {
    const when = new Date(Date.now() + 120_000).toUTCString()
    const r = classifyOpencodeError(429, 'GoUsageLimitError', { 'retry-after': when })
    expect(r.kind).toBe('go_usage_limit')
    expect(r.retryAfterMs).toBeGreaterThan(0)
  })

  it('裸 429 归为 rate_limit', () => {
    expect(classifyOpencodeError(429, 'too many requests').kind).toBe('rate_limit')
  })

  it('FreeTierError（形状门禁）单独识别，不与 403 认证失败混淆', () => {
    expect(classifyOpencodeError(403, 'FreeTierError: free tier can only be used from within OpenCode').kind)
      .toBe('free_tier')
  })

  it('401/403 且无类型名归为 auth', () => {
    expect(classifyOpencodeError(401, 'invalid api key').kind).toBe('auth')
    expect(classifyOpencodeError(403, 'forbidden').kind).toBe('auth')
  })

  it('5xx 归为 server', () => {
    expect(classifyOpencodeError(503, 'unavailable').kind).toBe('server')
  })

  it('传输类错误（无状态码）归为 transport', () => {
    expect(classifyOpencodeError(0, 'fetch failed').kind).toBe('transport')
  })

  it('缺省时给出可读 detail（不让用户只看到裸 JSON）', () => {
    expect(classifyOpencodeError(500, '{"error":{"message":"boom"}}').detail).toContain('boom')
  })
})

describe('isFreeOpencodeModel', () => {
  it('命中兜底表中的 free 模型', () => {
    expect(isFreeOpencodeModel('big-pickle')).toBe(true)
    expect(isFreeOpencodeModel('mimo-v2.6-flash-free')).toBe(true)
  })
  it('付费模型为 false', () => {
    expect(isFreeOpencodeModel('claude-opus-4-5')).toBe(false)
  })
  it('未知模型保守为 false（不给匿名槽放行未证实的模型）', () => {
    expect(isFreeOpencodeModel('some-unknown-model')).toBe(false)
  })
})

describe('兜底目录', () => {
  it('全部条目的 contextWindow 为安全正整数', () => {
    for (const m of OPENCODE_FALLBACK_MODELS) {
      expect(Number.isSafeInteger(m.contextWindow)).toBe(true)
      expect(m.contextWindow).toBeGreaterThan(0)
    }
  })
  it('⚠️ chat 端点的免费模型全部在表内（匿名实测可用）', () => {
    // 依据：docs/superpowers/specs/2026-10-02-opencode-zen-endpoint-matrix.md
    // （每条都对应一次成功的真实请求）。`ling-3.0-flash-fin-free` 已被移除 ——
    // 它唯一可用的 /v1/messages 端点当前对匿名与付费 key 都返回 500。
    const free = OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id)
    expect(free).toEqual([
      'big-pickle',
      'space-bunny-free',
      'longcat-2.5-preview-free',
      'mimo-v2.6-flash-free',
      'mimo-v2.5-free',
      'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free',
    ])
  })

  it('⚠️ ling-3.0-flash-fin-free 不得进表（唯一端点 /v1/messages 已 500）', () => {
    // 真实报障 2026-10-01：用户在选择器里点到它 → 必然失败。
    expect(OPENCODE_FALLBACK_MODELS.map((m) => m.id)).not.toContain('ling-3.0-flash-fin-free')
    expect(isReachableOpencodeModel('ling-3.0-flash-fin-free')).toBe(false)
  })

  it('⚠️ 远端 84 个模型里未实测的一律不可达（不能进目录）', () => {
    // claude/qwen 系走已坏的 /v1/messages；gpt/grok/gemini 走我们未实现的协议面；
    // muse-spark 是 403 RegionError。
    for (const id of ['claude-opus-4-5', 'gpt-5-nano', 'grok-4.6', 'gemini-3.8-flash', 'qwen3.8-flash', 'muse-spark-1.3-contributor-free']) {
      expect(isReachableOpencodeModel(id), `${id} 应判为不可达`).toBe(false)
    }
  })

  it('实测可达的模型都在表内', () => {
    for (const id of ['big-pickle', 'nemotron-3-ultra-free', 'glm-5.2']) {
      expect(isReachableOpencodeModel(id), `${id} 应判为可达`).toBe(true)
    }
  })

  it('⚠️ 非 chat 协议的自由模型不得进表（锁住设计决定）', () => {
    const ids = OPENCODE_FALLBACK_MODELS.map((m) => m.id)
    expect(ids).not.toContain('muse-spark-1.3-contributor-free')
    expect(ids).not.toContain('jev-1.13-free')
  })
  it('id 不重复', () => {
    const ids = OPENCODE_FALLBACK_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('OPENCODE', () => {
  it('端点指向官方 Zen 通道', () => {
    expect(OPENCODE.baseUrl).toBe('https://opencode.ai/zen')
    expect(OPENCODE.chatPath).toBe('/v1/chat/completions')
    expect(OPENCODE.anonymousKey).toBe('public')
  })
})
