import { describe, it, expect } from 'vitest'
import { isRateLimited, parseRateLimitError } from '../../src/llm-adapter.js'

/**
 * 限流判定的中英文双语契约。
 *
 * 历史缺陷（用户报障，**仅国际版暴露**）：判定与解析都只认中文文案，而
 * 国际版 WorkBuddy（www.workbuddy.ai）返回英文 —— `isRateLimited` 恒为 false，
 * 适配器因此跳过整个账号切换分支，直接抛原始 6004 JSON。国内版返回中文，
 * 所以缺陷长期潜伏。这里把两种语言都锁死。
 */

/** 国内版（CodeBuddy）真实响应体。 */
const CN_BODY = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"xyz"}'

/** 国际版（WorkBuddy）真实响应体 —— 用户报障原文。 */
const EN_BODY = JSON.stringify({
  code: 6004,
  msg: "usage exceeds frequency limit, but don't worry, your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, you can switch to the other models to continue using it.",
  requestId: 'ffb5bd97-2036-48a0-baba-a56c6ab13c9c',
})

describe('rate limit parser', () => {
  it('should detect rate limit error', () => {
    expect(isRateLimited(CN_BODY)).toBe(true)
  })

  it('should not detect normal error', () => {
    const body = '{"error":{"message":"model not found"}}'
    expect(isRateLimited(body)).toBe(false)
  })

  it('should parse reset time from buddy error', () => {
    const result = parseRateLimitError(CN_BODY, 'deepseek-v4-flash')
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe('deepseek-v4-flash')
    // 验证解析的时间戳大致正确
    const expected = Date.parse('2026-09-11 18:08:17 UTC+8')
    expect(result!.resetTimeMs).toBe(expected)
  })

  // ── 国际版（英文）契约 ──
  // 用户报障：国际版碰到 6004 后完全没有切换账号，错误以原始 JSON 抛给用户。

  it('国际版英文 6004 必须被识别为限流（否则不会切换账号）', () => {
    expect(isRateLimited(EN_BODY)).toBe(true)
  })

  it('国际版英文 6004 必须解析出服务端给出的真实重置时间', () => {
    const result = parseRateLimitError(EN_BODY, 'gpt-5.6-sol')
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe('gpt-5.6-sol')
    // 不能退化成 fallback 的「1 小时后」——必须与服务端 UTC+8 09:09:36 一致
    expect(result!.resetTimeMs).toBe(Date.parse('2026-09-17 09:09:36 UTC+8'))
  })

  it('裸英文文案（无 JSON 包裹）也能兜底识别', () => {
    // SSE 流内错误 / 网关裸文本场景：拿不到结构化 code，只能靠文案。
    expect(isRateLimited('usage exceeds frequency limit, please try later')).toBe(true)
    expect(isRateLimited('Too Many Requests')).toBe(true)
  })

  it('裸露的业务码 JSON 即使文案无法解析也应判为限流并兜底', () => {
    // 服务端改文案时，结构化 code 仍能兜住（这是优先用 code 判定的意义）。
    const body = '{"code":6004,"msg":"something entirely new","requestId":"abc"}'
    expect(isRateLimited(body)).toBe(true)
    const result = parseRateLimitError(body, 'm')
    expect(result).not.toBeNull()
    expect(result!.resetTimeMs).toBeGreaterThan(Date.now())
  })

  it('字符串形式的 code 同样识别（编码兼容）', () => {
    expect(isRateLimited('{"code":"6004","msg":"x"}')).toBe(true)
  })

  it('普通错误不得被误判为限流（防误伤，避免无谓切换账号）', () => {
    const negatives = [
      '{"error":{"message":"model not found"}}',
      '{"code":401,"msg":"invalid token"}',
      '{"error":{"type":"invalid_request_error","message":"unsupported parameter"}}',
      // 11102 是「service info not found」，与 6004 是完全不同的失败
      '{"code":11102,"msg":"service info not found"}',
      '{"error":{"message":"context length exceeded"}}',
      '{"error":{"message":"internal server error"}}',
    ]
    for (const body of negatives) {
      expect(isRateLimited(body), `不应判为限流: ${body}`).toBe(false)
      expect(parseRateLimitError(body, 'm'), `不应解析出重置时间: ${body}`).toBeNull()
    }
  })

  it('非 JSON 且无限流措辞时返回 null（不抛错）', () => {
    expect(parseRateLimitError('<html>502 Bad Gateway</html>', 'm')).toBeNull()
    expect(isRateLimited('<html>502 Bad Gateway</html>')).toBe(false)
  })

  it('尊重捕获到的真实时区（不硬编码 UTC+8）', () => {
    const body = '{"code":6004,"msg":"your usage will reset at 2026-09-17 09:09:36 UTC+0"}'
    const result = parseRateLimitError(body, 'm')!
    expect(result.resetTimeMs).toBe(Date.parse('2026-09-17 09:09:36 UTC+0'))
  })

  // ── HTTP 429 状态码兜底 ──
  //
  // 真实缺陷（用户报障）：「账号池里明明还有可用账号，插件却直接报错、也不换号」。
  //
  // 根因：`isRateLimited` 原先**只接收响应体**，判据是「结构化业务码 6004」或
  // 「中英文限流文案」。而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的
  // 429 —— 两个判据双双不命中 → 返回 false → 适配器里
  //
  //     if (accountPool && isRateLimited(errorText)) { ...记录重置时间 + 换号... }
  //
  // 这整块逻辑被跳过：既不切换账号、也不写 modelRateLimits 标记，而是把原始 429
  // 直接抛给用户。本可自愈的限流于是变成硬失败。
  //
  // 429 是 HTTP 语义上**唯一**的限流信号，无需也不应再去猜文案；文案 / 业务码兜底
  // 保留，服务于「状态码不是 429、但正文表达限流」的场景（6004、SSE 流内错误、
  // 网关包装过的 200/400）。

  it('空体 429 必须判为限流（只看正文时会漏判）', () => {
    // 先固定「只看正文」的旧行为确实是漏判，防止本用例退化成同义反复。
    expect(isRateLimited('')).toBe(false)
    expect(isRateLimited('', 429)).toBe(true)
  })

  it('任何无法识别正文的 429 都靠状态码兜底', () => {
    const bodies = [
      '',                                // 完全空体（真实缺陷的形态）
      '   ',                             // 仅空白
      '<html><body>429</body></html>',   // CDN 错误页：无「too many requests」字样
      '{"requestId":"abc"}',             // 有 JSON 但无 code/msg
    ]
    for (const body of bodies) {
      expect(isRateLimited(body, 429), `429 应判为限流: ${JSON.stringify(body)}`).toBe(true)
    }
  })

  it('状态码兜底不得把非 429 的普通错误误判为限流（防误伤）', () => {
    // 这是该修复的主要风险：多传一个 status 参数后，绝不能变成「有状态码就算限流」，
    // 否则 404「模型不存在」这类**换号无益**的错误会被吞成「所有账号均受限」。
    const body = '{"error":{"message":"model not found"}}'
    for (const status of [400, 401, 403, 404, 500, 502]) {
      expect(isRateLimited(body, status), `status=${status} 不应判为限流`).toBe(false)
    }
  })

  it('429 之外仍保留既有文案 / 业务码兜底（状态码不是唯一判据）', () => {
    expect(isRateLimited('usage exceeds frequency limit', 200)).toBe(true)
    expect(isRateLimited('{"code":6004}', 400)).toBe(true)
  })
})
