/**
 * 适配器侧的思考死循环中断回归（以 qoder 的 `consumeOpenAiSse` 为代表）。
 *
 * 验收四条：
 * 1. 命中后 reasoning 块只剩循环前的干净前缀（截断生效）；
 * 2. `finish` 报 **`error` + `REASONING_LOOP`**（**不是** `max-tokens`）——
 *    见下方「为什么改判」；
 * 3. 命中后**中止上游**（`reader.cancel()`），不把流读到底；
 * 4. 未命中时行为与现状完全一致。
 *
 * ## ⚠️ 为什么从 `max-tokens` 改判 `error`（真实缺陷，Gitee !IKIZNK）
 *
 * 用户报障：循环守卫中断后 UI 显示「**已达到输出 token 上限** / 回答被截断，
 * 已有输出保留在对话中。发送"继续"可让模型接着输出」。
 *
 * ⚠️ DSH 客户端对 `max-tokens` 只有这一句**固定 i18n 文案**
 * （`dsh-client-ui-chat` 的 `message.maxTokens`），**不读适配器的 message** ——
 * 于是「检测到死循环并主动止损」被误导成「token 用满了」，且建议的「继续」
 * 往往立刻再次进入同一循环。
 *
 * 全库取证（219 会话）：`finish=max-tokens` 的 35 步里 **25 步（71%）是守卫截断**，
 * 只有 5 步真烧满额度；且那 25 步**全部**由用户手动补「继续」才得以继续
 * （11× 「继续」、9×「继续上面未完成的任务」，2 次用户自己诊断出「陷入思考循环」）。
 *
 * ⚠️ **改判 error 的内容代价已实测为零**（`scripts/probe-guard-hit-block-mix.mjs`）：
 * 25/25 例守卫命中时该步**只有思考、零正文、零工具调用**，而 error 路径不落
 * `assistant/message` —— 丢的只是默认折叠的循环垃圾。
 * ⚠️ **故该判据带「无可见产出」门禁**：若某步真有正文/工具调用，仍报 `max-tokens`
 * 保住内容（见各适配器的 `reasoningLoopIsSoleOutput`）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { consumeOpenAiSse } from '../../src/openai-compat.js'
import { reasoningLoopFailure } from '../../src/sse.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import { WORKBUDDY } from '../../src/product.js'
import type { CodeArtsCredential } from '../../src/types.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures')

/** 把一段长文本切成 SSE reasoning 帧。 */
function reasoningFrames(text: string, chunkSize = 256): string {
  const frames: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    const delta = text.slice(i, i + chunkSize)
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: delta } }] })}\n\n`)
  }
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

/**
 * 收集全部 chunk。
 *
 * 接受 `Response` 以便传入 {@link countedResponse}（可观测上游被读取的帧数）。
 */
async function collect(sse: string | Response): Promise<Array<Record<string, unknown>>> {
  const response = typeof sse === 'string'
    ? new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    : sse
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeOpenAiSse(response, {}, {
    label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
  })) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

/**
 * 把帧数组包装成**可计数**的 `Response`：`consumed()` 返回上游实际被读取的帧数。
 *
 * 用途（终审 C1）：命中死循环后必须**中止上游**（`reader.cancel()`），否则读取
 * 循环仍把流读到底 —— 实测上游 200 帧被读 200 帧，128000 token 照烧。
 */
function countedResponse(frames: string[]): { response: Response; consumed: () => number } {
  const encoder = new TextEncoder()
  let index = 0
  let consumed = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= frames.length) { controller.close(); return }
      consumed += 1
      controller.enqueue(encoder.encode(frames[index]))
      index += 1
    },
  })
  return {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    consumed: () => consumed,
  }
}

/**
 * 构造「死循环 reasoning 帧 + 补足帧 + 收尾帧」的帧数组（OpenAI SSE 形态）。
 *
 * 总帧数刻意远多于判据命中所需（实测判据约在 2304 字符处命中，即第 ~9 帧），
 * 这样「是否提前止损」才有区分度：读到底 = 总帧数，止损 = 个位数。
 */
function openAiLoopFrames(totalFrames: number, finishFrames: string[]): string[] {
  const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
  const frames: string[] = []
  for (let i = 0; i < loop.length; i += 256) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
  }
  while (frames.length < totalFrames - finishFrames.length) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Let me write.\n\nGo.\n\nOK.\n\nWriting.\n\n' } }] })}\n\n`)
  }
  frames.push(...finishFrames)
  return frames
}

/** trae 专用：SOLO 自定义事件形态的同类帧数组（不能复用 OpenAI 帧）。 */
function soloLoopFrames(totalFrames: number, finishEvents: string[]): string[] {
  const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
  const frames: string[] = []
  for (let i = 0; i < loop.length; i += 256) {
    frames.push(`event:output\ndata:${JSON.stringify({ reasoning_content: loop.slice(i, i + 256) })}\n\n`)
  }
  while (frames.length < totalFrames - finishEvents.length) {
    frames.push(`event:output\ndata:${JSON.stringify({ reasoning_content: 'Let me write.\n\nGo.\n\nOK.\n\nWriting.\n\n' })}\n\n`)
  }
  frames.push(...finishEvents)
  return frames
}

/**
 * 死循环命中后的期望 finish reason（**有分辨力的 error**，不是 max-tokens）。
 *
 * 只断言 `kind` 与 `code`，不断言 message 全文 —— 文案会随额度信息变化，
 * 逐字锁死会让每次调整措辞都要改一堆用例（且文案里含估算出的 token 数）。
 */
function expectReasoningLoopFinish(chunks: Array<Record<string, unknown>>): void {
  const last = chunks.at(-1) as { type?: string; reason?: { kind?: string; failure?: { code?: string; message?: string } } }
  expect(last.type).toBe('finish')
  expect(last.reason?.kind).toBe('error')
  expect(last.reason?.failure?.code).toBe('REASONING_LOOP')
  // ⚠️ 文案必须**明确否定**「token 上限」这一误导说法（用户的核心诉求）。
  expect(String(last.reason?.failure?.message ?? '')).toContain('不是')
  expect(String(last.reason?.failure?.message ?? '')).toContain('token 上限')
}

/**
 * 终审 C1 的共用判据：命中后 ① 上游读取必须**提前停止**（远小于总帧数），
 * ② 截断仍保留干净前缀，③ `finish` 报**有分辨力的 error**（不得因止损
 * 变成传输错误或用户取消，也不得退回会误导的 `max-tokens`）。
 */
function expectUpstreamStopped(
  chunks: Array<Record<string, unknown>>,
  consumed: number,
  totalFrames: number,
): void {
  // ① 止损：读取帧数必须远小于总帧数（原实现恒等于总帧数）。
  expect(consumed).toBeLessThan(totalFrames / 2)
  // ② 截断仍生效（保留非空干净前缀）。
  const reasoningEnd = chunks.find(
    (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
  )
  expect(reasoningEnd).toBeDefined()
  expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBeGreaterThan(0)
  // ③ 报有分辨力的 REASONING_LOOP 错误（未被误判成传输错误 / 用户取消）。
  expectReasoningLoopFinish(chunks)
}

// ⚠️ 顶层 `beforeEach`（不是只在文件末尾放 `afterEach`）：若开发者 shell 里设了
// `DSH_REASONING_LOOP_GUARD=0`，**文件内首条用例**会继承该值而失败 ——
// 末尾的 afterEach 只能清掉后续用例的污染，救不了第一条（顺序依赖）。
beforeEach(() => {
  delete process.env.DSH_REASONING_LOOP_GUARD
})

afterEach(() => {
  delete process.env.DSH_REASONING_LOOP_GUARD
})

describe('思考死循环中断（真实缺陷回归）', () => {
  it('命中后截断思考并报有分辨力的 REASONING_LOOP 错误', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collect(reasoningFrames(loop))

    // 1) reasoning 块被截断：最终内容明显短于喂入的总量。
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(reasoningEnd).toBeDefined()
    const kept = String((reasoningEnd!.block as { text?: string }).text ?? '')
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(loop.length)

    // 2) 必须报有分辨力的 REASONING_LOOP 错误，不能是 stop，也不能退回 max-tokens。
    expectReasoningLoopFinish(chunks)
  })

  /**
   * 用户的核心诉求（Gitee !IKIZNK）：**文案必须有分辨力**，不能复用
   * 「已达到输出 token 上限」。
   */
  it('错误文案有分辨力：说明真实原因是死循环、否定 token 上限、并给出剩余额度', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const response = new Response(reasoningFrames(loop), {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of consumeOpenAiSse(response, {}, {
      label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
      // 显式给额度，才能断言「还剩多少」那一段。
      maxTokens: 128_000,
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    const failure = (chunks.at(-1) as {
      reason?: { kind?: string; failure?: { code?: string; message?: string } }
    }).reason?.failure
    expect(failure?.code).toBe('REASONING_LOOP')
    const message = String(failure?.message ?? '')
    // ① 说清真实原因（思考死循环），② 明确否定「token 上限」，
    // ③ 给出判据数值，④ 告知额度没占满、可以继续。
    expect(message).toContain('思考')
    expect(message).toContain('不是')
    expect(message).toContain('token 上限')
    expect(message).toContain('去重率')
    expect(message).toContain('额度')
    expect(message).toContain('继续')
    // ⑤ 额度充足时不得谎称「已达上限」。
    expect(message).not.toContain('已达到输出 token 上限')
  })

  it('拿不到 maxTokens 时不编造额度数字（只说明未占满）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    // 默认 collect() 不传 maxTokens。
    const chunks = await collect(reasoningFrames(loop))
    const message = String((chunks.at(-1) as {
      reason?: { failure?: { message?: string } }
    }).reason?.failure?.message ?? '')
    expect(message).toContain('额度没有占满')
    // 不得出现具体额度数字（无依据）。
    expect(message).not.toMatch(/额度 \d+ token/)
  })

  /**
   * ⚠️ **降级路径**：`reasoningLoopFailure` 必须容忍 `diagnostics === undefined`。
   *
   * 理由：调用点写的是 `loopGuard?.diagnostics`，而该函数在 **`finish` 路径**上执行
   * —— 那里抛错会把「有分辨力的错误」变成「连 finish 都没有」的更糟故障。
   * 当前实现下 `loopDetected === true` 蕴含 `diagnostics !== undefined`，
   * 故这条纯函数用例是**防御性**的（锁住「不得因此崩」的契约）。
   */
  it('纯函数：diagnostics 缺失时降级成不带数值的文案，而不是抛错', () => {
    const failure = reasoningLoopFailure(undefined, 128_000, 'reasoning')
    expect(failure.code).toBe('REASONING_LOOP')
    expect(failure.message).toContain('不是')
    expect(failure.message).toContain('token 上限')
    expect(failure.message).toContain('额度没有占满')
    // 无诊断信息时不得编造判据数值。
    expect(failure.message).not.toContain('去重率')
  })

  /**
   * ⚠️ **门禁判据**：只有「**只是**思考循环」（无正文、无工具调用）时才报 error。
   *
   * 依据（用户要求原文）：「**如果只是**陷入思考循环的出错，就要给出有分辨力的
   * 错误提示」。反向约束同样重要：本步若还有可见产出，报 error 会让
   * `dsh-agent-loop` 的 error 分支不落 `assistant/message`（实测 219 会话里
   * 222 例），把用户可见内容整块丢掉。
   */
  it('循环命中但**另有工具调用**时仍报 max-tokens（不丢内容）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const frames: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    // 循环之后到达一个**有效**工具调用（实测正文/思考循环的 wire 顺序正是如此）。
    frames.push(`data: ${JSON.stringify({
      choices: [{
        delta: {
          reasoning_content: '还在循环还在循环',
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"file_path":"a"}' } }],
        },
      }],
    })}\n\n`)
    frames.push('data: [DONE]\n\n')
    const chunks = await collect(frames.join(''))
    // 有可用调用 ⇒ 不能报 error（会丢内容），也不能报 tool-calls（循环中的调用不可信）。
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('循环命中但**另有正文**时仍报 max-tokens（不丢内容）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const frames: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: '这里是用户可见的正文。' } }] })}\n\n`)
    frames.push('data: [DONE]\n\n')
    const chunks = await collect(frames.join(''))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('正常思考不受影响（零误报）', async () => {
    const normal = readFileSync(join(FIXTURES, 'reasoning-normal.txt'), 'utf8')
    const chunks = await collect(reasoningFrames(normal))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    // 完整保留，且按上游宣告正常结束。
    expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBe(normal.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('开关关闭时不干预（行为与现状一致）', async () => {
    process.env.DSH_REASONING_LOOP_GUARD = '0'
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collect(reasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(String((reasoningEnd!.block as { type?: string }).text ?? '').length).toBe(loop.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 回归（审查发现）：`continue` 会连带跳过同帧位于 reasoning 分支**之后**的
  // `usage`，导致 token 记账静默缺失。真实流量中不可达（27949 个 attempt 里
  // reasoning 与 usage 同帧 0 次），但用 if 守卫后行为才是正确的。
  it('命中后同帧的 usage 仍被处理（不得用 continue 连带跳过）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    // 最后一帧同时携带 reasoning_content 与 usage。
    const frames: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    frames.push(`data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: '还在循环还在循环' } }],
      usage: { prompt_tokens: 111, completion_tokens: 222 },
    })}\n\n`)
    frames.push('data: [DONE]\n\n')
    const chunks = await collect(frames.join(''))
    // usage 必须被产出（用 continue 时会丢失）。
    expect(chunks.filter((c) => c.type === 'usage')).toHaveLength(1)
    // 且死循环仍被正确判定为有分辨力的 REASONING_LOOP 错误。
    expectReasoningLoopFinish(chunks)
  })
})

/** 用真实适配器跑一段 reasoning SSE，返回全部 chunk。 */
async function collectBuddy(sse: string | Response): Promise<Array<Record<string, unknown>>> {
  const adapter = new BuddyAdapter({
    credentialRef: 'TEST_REF' as never,
    resolveCredential: async () => ({ access_token: 'stub', refresh_token: 'stub', expires_at: 0 }) as never,
    refresh: async () => {},
    product: WORKBUDDY,
    fetchImpl: (async () => typeof sse === 'string' ? new Response(sse, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }) : sse) as never,
  })
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream({
    model: 'deepseek-v4.1-flash', messages: [], reasoningEffort: 'high', maxTokens: 128_000,
  } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('思考死循环中断（workbuddy，用户实际报障路径）', () => {
  it('命中后截断思考并报有分辨力的 REASONING_LOOP 错误', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collectBuddy(reasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    const kept = String((reasoningEnd!.block as { text?: string }).text ?? '')
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(loop.length)
    expectReasoningLoopFinish(chunks)
  })

  it('正常思考不受影响', async () => {
    const normal = readFileSync(join(FIXTURES, 'reasoning-normal.txt'), 'utf8')
    const chunks = await collectBuddy(reasoningFrames(normal))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBe(normal.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 同 `consumeOpenAiSse` 的回归：命中后**不得**用 `continue` 跳过同帧的 usage
  // （reasoning 分支在 usage 之前，`continue` 会连带丢弃 token 记账）。
  it('命中后同帧的 usage 仍被处理（不得用 continue 连带跳过）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const frames: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    frames.push(`data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: '还在循环还在循环' } }],
      usage: { prompt_tokens: 111, completion_tokens: 222 },
    })}\n\n`)
    frames.push('data: [DONE]\n\n')
    const chunks = await collectBuddy(frames.join(''))
    expect(chunks.filter((c) => c.type === 'usage')).toHaveLength(1)
    expectReasoningLoopFinish(chunks)
  })
})

/**
 * 用真实 CodeArtsAdapter 跑一段 SSE，返回全部 chunk。
 *
 * 构造方式照抄 `tests/unit/llm-adapter.spec.ts` 的 `makeAdapter`：注入
 * `fetchImpl` 返回预置 SSE，凭据用永不过期的桩值（否则 `stream()` 会先走
 * `refresh()` 而拿到 `undefined` 凭据直接抛 MISSING_CREDENTIAL）。
 */
async function collectCodeArts(sse: string | Response): Promise<Array<Record<string, unknown>>> {
  const adapter = new CodeArtsAdapter({
    credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
    resolveCredential: async () => ({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2099-01-01T00:00:00Z',
    }) as CodeArtsCredential,
    refresh: async () => {},
    fetchImpl: (async () => typeof sse === 'string' ? new Response(sse, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }) : sse) as never,
  })
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream({
    model: 'GLM-5.2',
    messages: [],
    signal: new AbortController().signal,
  } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('思考死循环中断（codearts）', () => {
  it('命中后截断思考并报有分辨力的 REASONING_LOOP 错误', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collectCodeArts(reasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    const kept = String((reasoningEnd!.block as { text?: string }).text ?? '')
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(loop.length)
    expectReasoningLoopFinish(chunks)
  })

  it('正常思考不受影响', async () => {
    const normal = readFileSync(join(FIXTURES, 'reasoning-normal.txt'), 'utf8')
    const chunks = await collectCodeArts(reasoningFrames(normal))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBe(normal.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 同 `consumeOpenAiSse` / buddy 的回归：命中后**不得**用 `continue` 跳过同帧的
  // usage（本适配器的 reasoning 分支同样在 usage 之前）。
  it('命中后同帧的 usage 仍被处理（不得用 continue 连带跳过）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const frames: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    frames.push(`data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: '还在循环还在循环' } }],
      usage: { prompt_tokens: 111, completion_tokens: 222 },
    })}\n\n`)
    frames.push('data: [DONE]\n\n')
    const chunks = await collectCodeArts(frames.join(''))
    expect(chunks.filter((c) => c.type === 'usage')).toHaveLength(1)
    expectReasoningLoopFinish(chunks)
  })

  // 第一处 reasoning 出口：`delta.content` 里的 `<thought>` 经
  // `dsmlContentExtractor` 解析为 `reasoning`，再走 `emitDsmlFeed(...)` 的
  // `if (reasoning.length > 0)` 分支。若只接 `delta.reasoning_content` 那条
  // 出口，这条路径会漏（下面的用例正是为了锁死它）。
  it('第一处出口（content 通道 <thought> → emitDsmlFeed）同样被截断', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const frames: string[] = ['data: ' + JSON.stringify({ choices: [{ delta: { content: '<thought>' } }] }) + '\n\n']
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    frames.push('data: [DONE]\n\n')
    const chunks = await collectCodeArts(frames.join(''))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    const kept = String((reasoningEnd!.block as { text?: string }).text ?? '')
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(loop.length)
    expectReasoningLoopFinish(chunks)
  })

  // self-review 发现：本适配器独有 `visible` 回退（正文为空且无工具调用时用
  // 推理文本填充正文，GLM 端点偶尔把整段回答作为 reasoning_content 发出）。
  //
  // ⚠️ **命中死循环时必须关闭该回退**（`!loopDetected` 门禁），两个理由：
  //   1. 回退会把**循环文本**复制进正文块并持久化，下次重放又要把病态文本吃一遍
  //      （正是本守卫要根除的问题）；
  //   2. 回退一旦生效，`visible !== ''` 会让「只是思考循环」的判据恒为假 →
  //      永远落回误导性的 `max-tokens`，「有分辨力的错误提示」在 codearts 这条
  //      路径上**静默失效**。
  // 故本用例锁死：命中后**不产出正文块**，且报 REASONING_LOOP。
  it('命中后 visible 回退被关闭（不把循环文本复制进正文）且报 REASONING_LOOP', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collectCodeArts(reasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    const kept = String((reasoningEnd!.block as { text?: string }).text ?? '')
    // 思考块仍保留干净前缀（截断生效，未被截空）。
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(loop.length)
    // 正文块**不得**被回填（否则循环文本会落盘，且判据失效）。
    const textEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'text',
    )
    expect(textEnd).toBeUndefined()
    expectReasoningLoopFinish(chunks)
  })
})

/**
 * 用真实 `LobsteraiAdapter` 跑一段 SSE，返回全部 chunk。
 *
 * 构造方式照抄 `tests/unit/lobsterai-adapter.spec.ts` 的 `makeAdapter` +
 * `generateOptions`：本 provider 是 **OpenAI 格式**，故 `reasoningFrames()`
 * 可直接复用（与 trae 的 SOLO 事件完全不同）。
 */
async function collectLobsterai(sse: string | Response): Promise<Array<Record<string, unknown>>> {
  const adapter = new LobsteraiAdapter({
    credentialRef: 'LOBSTERAI_ACCOUNT_TEST' as never,
    resolveCredential: async () => ({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1', user_id: 'yid-1', nickname: '测试账号', uuid: 'uuid-1',
      first_keyfrom: '1700000000000', latest_keyfrom: '1700000000000',
    }) as never,
    refresh: async () => {},
    fetchImpl: (async () => typeof sse === 'string' ? new Response(sse, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }) : sse) as never,
    resolveClientVersion: async () => '2026.9.4',
    product: LOBSTERAI,
  })
  const options = {
    provider: 'lobsterai',
    model: 'glm-5.2',
    messages: [{ role: 'user', content: '你好' }],
  } as unknown as GenerateOptions
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream(options)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('思考死循环中断（lobsterai）', () => {
  it('命中后截断思考并报有分辨力的 REASONING_LOOP 错误', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collectLobsterai(reasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(reasoningEnd).toBeDefined()
    const kept = String((reasoningEnd!.block as { text?: string }).text ?? '')
    // 既不能截空（`cutAt=0` 是已知的截空风险），也不能保留循环全文。
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(loop.length)
    expectReasoningLoopFinish(chunks)
  })

  it('正常思考不受影响', async () => {
    const normal = readFileSync(join(FIXTURES, 'reasoning-normal.txt'), 'utf8')
    const chunks = await collectLobsterai(reasoningFrames(normal))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBe(normal.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 同其余三个适配器的回归：命中后**不得**用 `continue` 跳过同帧的 usage
  // （本适配器的 reasoning 分支同样位于 usage 之前）。
  it('命中后同帧的 usage 仍被处理（不得用 continue 连带跳过）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const frames: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    frames.push(`data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: '还在循环还在循环' } }],
      usage: { prompt_tokens: 111, completion_tokens: 222 },
    })}\n\n`)
    frames.push('data: [DONE]\n\n')
    const chunks = await collectLobsterai(frames.join(''))
    expect(chunks.filter((c) => c.type === 'usage')).toHaveLength(1)
    expectReasoningLoopFinish(chunks)
  })

  it('开关关闭时不干预（行为与现状一致）', async () => {
    process.env.DSH_REASONING_LOOP_GUARD = '0'
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collectLobsterai(reasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBe(loop.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

/**
 * 用真实 `TraeAdapter` 跑一段 **SOLO 自定义 SSE**，返回全部 chunk。
 *
 * 构造方式照抄 `tests/unit/trae-adapter.spec.ts` 的 `makeAdapter` + `collect`：
 * 注入 `responses` 桩（`fetchImpl` 依次弹出），模型取兜底表里的 `glm-5.2`。
 */
async function collectTrae(sse: string | Response): Promise<Array<Record<string, unknown>>> {
  const responses: Response[] = [typeof sse === 'string' ? new Response(sse, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }) : sse]
  const adapter = new TraeAdapter({
    credentialRef: 'TRAE_ACCESS_TOKEN' as never,
    resolveCredential: async () => ({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1', nickname: '测试账号',
      machine_id: 'a'.repeat(32), device_id: 'c'.repeat(32),
    }) as never,
    refresh: async () => {},
    fetchImpl: (async () => {
      const next = responses.shift()
      if (next === undefined) throw new Error('unexpected fetch call')
      return next
    }) as never,
    product: TRAE,
  })
  const options = {
    model: 'glm-5.2',
    messages: [{ role: 'user', content: '你好' }],
  } as unknown as GenerateOptions
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream(options)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('思考死循环中断（trae）', () => {
  /**
   * trae 是 **SOLO 自定义事件格式**（不是 OpenAI），故不能复用
   * `reasoningFrames()` —— 必须用 `event:output` + `data:{reasoning_content}`
   * 逐段喂 reasoning，收尾发 `event:done`（照抄既有 `soloSse` 的形态）。
   */
  function soloReasoningFrames(text: string, chunkSize = 256): string {
    const events: string[] = []
    for (let i = 0; i < text.length; i += chunkSize) {
      events.push(`event:output\ndata:${JSON.stringify({ reasoning_content: text.slice(i, i + chunkSize) })}\n\n`)
    }
    events.push(`event:done\ndata:${JSON.stringify({ finish_reason: 'stop' })}\n\n`)
    return events.join('')
  }

  it('命中后截断思考并报有分辨力的 REASONING_LOOP 错误', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collectTrae(soloReasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(reasoningEnd).toBeDefined()
    const kept = String((reasoningEnd!.block as { text?: string }).text ?? '')
    // 既不能截空（`cutAt=0` 是已知的截空风险），也不能保留循环全文。
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(loop.length)
    expectReasoningLoopFinish(chunks)
  })

  it('正常思考不受影响', async () => {
    const normal = readFileSync(join(FIXTURES, 'reasoning-normal.txt'), 'utf8')
    const chunks = await collectTrae(soloReasoningFrames(normal))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBe(normal.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 同其余适配器的回归：命中后**不得**用 `continue` 跳过同帧的处理。
  //
  // ⚠️ trae 的 `usage` 走**独立**的 `token_usage` 事件，故「同帧 usage」这条
  // 判据在本 provider 不可达 —— 真正会被 `continue` 连带丢弃的是**同一个
  // `output` 事件里位于 reasoning 分支之后的 `tool_calls`**（该分支确实同时
  // 携带两者）。这里用「循环中的一帧同时带 reasoning_content 与 tool_calls」
  // 锁死它，并顺带确认流被消费到 `token_usage` / `done`。
  it('命中后同帧的 tool_calls 仍被处理（不得用 continue 连带跳过）', async () => {
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const events: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      events.push(`event:output\ndata:${JSON.stringify({ reasoning_content: loop.slice(i, i + 256) })}\n\n`)
    }
    // 循环中的一帧**同时**带 reasoning_content 与 tool_calls —— 用 `continue`
    // 时后者会被整帧跳过。
    events.push(`event:output\ndata:${JSON.stringify({
      reasoning_content: '还在循环还在循环',
      tool_calls: [{ index: 0, id: 'c1', function_call: { name: 'read', arguments: '{"file_path":"a"}' } }],
    })}\n\n`)
    events.push(`event:token_usage\ndata:${JSON.stringify({ prompt_tokens: 111, completion_tokens: 222 })}\n\n`)
    events.push(`event:done\ndata:${JSON.stringify({ finish_reason: 'stop' })}\n\n`)
    const chunks = await collectTrae(events.join(''))
    // 同帧的 tool_calls 必须产出（用 continue 时会丢失）。
    const toolEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call',
    )
    expect(toolEnd).toBeDefined()
    // 收尾的 token_usage 也必须被读到（证明流被消费完，没有提前 break）。
    expect(chunks.filter((c) => c.type === 'usage')).toHaveLength(1)
    // ⚠️ 本步**另有工具调用**，故不满足「只是思考循环」的判据 —— 必须仍报
    // max-tokens（保住该步的 text/reasoning 落盘）。
    // 若改报 error，`dsh-agent-loop` 的 error 分支不落 `assistant/message`，
    // 这一步的内容会被整块丢弃（实测 219 会话里 222 例）。
    // 死循环优先级仍最高：即便有工具调用也不报 tool-calls
    //（循环中生成的调用参数不可信）。
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('开关关闭时不干预（行为与现状一致）', async () => {
    process.env.DSH_REASONING_LOOP_GUARD = '0'
    const loop = readFileSync(join(FIXTURES, 'reasoning-loop.txt'), 'utf8')
    const chunks = await collectTrae(soloReasoningFrames(loop))
    const reasoningEnd = chunks.find(
      (c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'reasoning',
    )
    expect(String((reasoningEnd!.block as { text?: string }).text ?? '').length).toBe(loop.length)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

/**
 * 回归（终审 C1）：命中后必须**中止上游**，否则 128000 token 照烧。
 *
 * 原实现只跳过下行累积/发射，`for (;;)` 仍把流读到底 —— 实测上游 200 帧被读
 * 200 帧（守卫在 ~2304 字符即命中，99.5% 的额度仍被消耗）。
 *
 * 判据用**逐帧 pull 的可计数流**（每帧一次 `reader.read()`），否则「是否提前
 * 停止读取」不可观测：把整个 SSE 拼成一个 `Response` 时全部帧在一次读取里到达，
 * 读到底与提前停止无法区分。
 *
 * ⚠️ 每个适配器都必须单独验证 —— 五处读取循环结构各不相同（外层 `for (;;)` /
 * `while`、变量名各异），漏接任何一处都等于漏一条路径。
 */
describe('命中后 cancel 上游：真正止损（终审 C1 回归）', () => {
  /** 上游以 `length` 收尾（报障真实形态）。 */
  const openAiTail = [
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const soloTail = [
    `event:done\ndata:${JSON.stringify({ finish_reason: 'length' })}\n\n`,
  ]

  it('qoder/consumeOpenAiSse：命中后 cancel 上游，不再把流读到底', async () => {
    const frames = openAiLoopFrames(200, openAiTail)
    const { response, consumed } = countedResponse(frames)
    // 显式传入调用方信号：止损**不得** abort 它（abort 会被上层报成「用户取消」
    // 而非可重试的 max-tokens）。
    const controller = new AbortController()
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of consumeOpenAiSse(response, { signal: controller.signal }, {
      label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    expectUpstreamStopped(chunks, consumed(), frames.length)
    // 只 cancel reader，绝不 abort 调用方信号。
    expect(controller.signal.aborted).toBe(false)
  })

  it('buddy/workbuddy：命中后 cancel 上游，不再把流读到底', async () => {
    const frames = openAiLoopFrames(200, openAiTail)
    const { response, consumed } = countedResponse(frames)
    const chunks = await collectBuddy(response)
    expectUpstreamStopped(chunks, consumed(), frames.length)
  })

  it('codearts：命中后 cancel 上游，不再把流读到底', async () => {
    const frames = openAiLoopFrames(200, openAiTail)
    const { response, consumed } = countedResponse(frames)
    const chunks = await collectCodeArts(response)
    expectUpstreamStopped(chunks, consumed(), frames.length)
  })

  it('lobsterai：命中后 cancel 上游，不再把流读到底', async () => {
    const frames = openAiLoopFrames(200, openAiTail)
    const { response, consumed } = countedResponse(frames)
    const chunks = await collectLobsterai(response)
    expectUpstreamStopped(chunks, consumed(), frames.length)
  })

  it('trae：命中后 cancel 上游，不再把流读到底', async () => {
    const frames = soloLoopFrames(200, soloTail)
    const { response, consumed } = countedResponse(frames)
    const chunks = await collectTrae(response)
    expectUpstreamStopped(chunks, consumed(), frames.length)
  })

  // 命中后**同一 chunk** 内、位于命中点**之后**的帧仍必须被处理（插入位置在
  // 内层行循环之后、外层循环末尾的理由）。若把止损塞进内层行循环（在
  // `observe` 返回 true 处直接 `break`），同一 chunk 里后到的 `usage` 与
  // `[DONE]` 会被整块跳过 —— token 记账静默丢失，正是此前 `continue` 那条
  // 回归的同族问题。
  it('命中帧所在 chunk 内后到的 usage/[DONE] 仍被处理（插入位置正确性）', async () => {
    const frames = openAiLoopFrames(200, openAiTail)
    // 判据实测在约第 15 帧命中，故取 24 帧确保本 chunk 内已发生命中；
    // 其后紧跟 usage 帧与 [DONE]，二者都必须被处理。
    const merged = frames.slice(0, 24).join('')
      + `data: ${JSON.stringify({ usage: { prompt_tokens: 111, completion_tokens: 222 } })}\n\n`
      + 'data: [DONE]\n\n'
    const { response, consumed } = countedResponse([merged, ...frames.slice(24)])
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of consumeOpenAiSse(response, {}, {
      label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    // 命中点之后的 usage 与 [DONE] 都处理了（用 `continue`/提前 break 会丢）。
    expect(chunks.filter((c) => c.type === 'usage')).toHaveLength(1)
    // 仍提前止损（没有把剩余帧读完）。
    expect(consumed()).toBeLessThan(frames.length / 2)
    // 行为不变：截断 + max-tokens。
    expectReasoningLoopFinish(chunks)
  })
})
