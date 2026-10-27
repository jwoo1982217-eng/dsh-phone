import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyOpencodeError, isFreeOpencodeModel, isReachableOpencodeModel, OPENCODE, OPENCODE_FALLBACK_MODELS } from '../../src/opencode-product.js'

const here = dirname(fileURLToPath(import.meta.url))

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
    //
    // ⚠️ 2026-10-17 更新（Issue IKM9LR）：
    //  · 新增 3 条 —— `deepseek-v4.1-flash-free` / `glm-5.3-flash-free` /
    //    `nemotron-3.5-super-vl-free`（远端早已下发，被硬编码表挡掉）。
    //  · 移除 2 条 —— `mimo-v2.5-free`（实测 **410 ModelDeprecated**，上游点名
    //    改用 `mimo-v2.6-flash-free`）与 `nemotron-3-ultra-free`（远端已不下发，
    //    实测 503 过载）。**这两条恰恰证明可达性不能只靠本地表**。
    // ⚠️ 判据用 `toEqual` 全量列举（而不是 `toContain`）：删条目的事故正是
    //   「没人注意到它从表里消失了」—— 列举式断言才会跟着响。
    const free = OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id)
    expect(free).toEqual([
      'big-pickle',
      'space-bunny-free',
      'longcat-2.5-preview-free',
      'mimo-v2.6-flash-free',
      'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free',
      'deepseek-v4.1-flash-free',
      'glm-5.3-flash-free',
      'nemotron-3.5-super-vl-free',
    ])
  })

  it('⚠️⚠️ 已废弃的条目不得回到表里（实测 410 / 远端已撤）', () => {
    // 这两条在 2026-10-17 被移除：mimo-v2.5-free 回 410 ModelDeprecated，
    // nemotron-3-ultra-free 远端不再下发且实测 503。
    // ⚠️ **刻意不锁死为「永远不许有」**：上游若复活它们，重新实测通过后
    //   应当能加回来（真实缺陷是「点下去必然失败」，不是「它们曾经存在」）。
    // 本条锁的只是「移除这件事发生过，且有据可查」。
    const src = readFileSync(join(here, '../../src/opencode-product.ts'), 'utf8')
    expect(src, '移除理由必须留在注释里，否则下次会有人「顺手加回来」').toMatch(/mimo-v2\.5-free/)
    expect(src).toMatch(/ModelDeprecated/)
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
    expect(OPENCODE.baseUrl).toBe('https://opencode.ai/inference')
    expect(OPENCODE.chatPath).toBe('/v1/chat/completions')
    expect(OPENCODE.anonymousKey).toBe('public')
  })
})
