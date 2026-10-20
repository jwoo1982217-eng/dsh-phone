/**
 * 「**没有任何报错就中断**」的回归测试（用户报障，2026-09-23）。
 *
 * ## 现象
 *
 * 用 `qoder` 的 `qfmodel`（Qwen3.8-Flash）执行任务时，最后一条助手消息
 * **只有正文、没有工具调用**，文本还以冒号「：」结尾（模型正要说「让我验证…」），
 * 随后 `turn/end` 是 `{kind:'completed'}` —— UI 上就是「没有错误，直接停了」。
 *
 * 实测会话证据（`~/.dsh/sessions/--D-jet-code-rust-zed--/session-3735ba4a…`，
 * 已解压 `session.v3.jsonl.zstd` 逐帧核对）：该步骤记录的原始 chunk 流是
 *
 * ```
 * block-start(text) → text-chunks → usage → block-end(text) → finish{kind:'stop'}
 * ```
 *
 * 全程**没有任何 tool-call 分片**，且 `usage.outputTokens=319`（远未触上限）。
 *
 * ## 根因（本文件锁定）
 *
 * `consumeOpenAiSse` 把「**没收到 `finish_reason`** 且**没有工具调用**」直接判成
 * `{kind:'stop'}` —— 而 `stop` 是「模型正常答完」的信号。于是**被掐断的连接
 * 伪装成正常结束**：harness 认为这一轮已经完成，任务就此中断，且没有任何报错。
 *
 * ⚠️ 注意既有实现**已经**处理了「中途掐断」，只是**多加了 `toolOrder.length > 0`
 * 这个前提**：
 *
 * ```ts
 * finishReason === undefined && toolOrder.length > 0   // 只有带工具调用时才判为截断
 * ```
 *
 * 也就是说：断在**工具调用参数**上会被重试，断在**正文/即将调用工具**时被静默接受。
 *
 * 判据必须是「**连接结束的方式**」，而不是「有没有工具调用」：
 * - 收到 `[DONE]` → 上游明确宣告结束，`stop` 合法；
 * - 收到显式 `finish_reason` → 同上；
 * - **两者都没有** → 连接被掐断 → 报 `max-tokens`（不完整，可重试），
 *   绝不能报 `stop`。
 *
 * ## 同时锁定：错误帧不得被静默忽略
 *
 * 另有网关形态的错误帧既没有 `code` 也没有 `choices`，早期解析器**整帧丢弃**，
 * 同样表现为「干净地停止」。见 `docs/qoder-encryption-notes.md` §4：
 *
 * ```
 * event:error
 * data:{"stackTrace":[...],"message":"...","statusCodeValue":400}
 * ```
 */
import { describe, expect, it } from 'vitest'
import { consumeOpenAiSse } from '../../src/openai-compat.js'

/** 用原始 SSE 文本构造响应。 */
function asResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集全部 chunk。 */
async function collect(response: Response): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeOpenAiSse(response, {}, {
    label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
  })) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

/** 一个只带正文的帧。 */
const textFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: '让我验证一下：' }, index: 0 }] })}\n\n`

describe('流被掐断不得伪装成正常结束（真实缺陷）', () => {
  it('无 finish_reason 且无 [DONE] → 报 max-tokens（可重试），**不是** stop', async () => {
    // 这正是用户会话里那一帧的形态：正文产出后连接直接结束。
    const chunks = await collect(asResponse(textFrame))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('正文为空、连接即断 → 同样是 max-tokens', async () => {
    // 一个 data: 帧都没有、body 为空：属于不完整响应。
    const chunks = await collect(asResponse(''))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('收到 [DONE] 但无 finish_reason → stop（上游已宣告结束，合法）', async () => {
    const chunks = await collect(asResponse(`${textFrame}data: [DONE]\n\n`))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('显式 finish_reason=stop → stop（不回归）', async () => {
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`
    const chunks = await collect(asResponse(`${textFrame}${finish}`))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('显式 finish_reason=length → max-tokens（不回归）', async () => {
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length', index: 0 }] })}\n\n`
    const chunks = await collect(asResponse(`${textFrame}${finish}`))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('网关形态的错误帧不得被静默忽略（真实缺陷）', () => {
  it('{message, statusCodeValue:400}（无 code、无 choices）必须抛错', async () => {
    // 既有实现只认 {error:{...}} 与「顶层 code + message」，这一形态会被整帧丢弃。
    const frame = 'event:error\ndata: {"stackTrace":["a","b"],"message":"upstream boom","statusCodeValue":400}\n\n'
    await expect(collect(asResponse(frame))).rejects.toThrow(/upstream boom/)
  })

  it('{message, statusCodeValue:500} 也要抛错（不能只看 4xx）', async () => {
    const frame = 'data: {"message":"gateway exploded","statusCodeValue":500}\n\n'
    await expect(collect(asResponse(frame))).rejects.toThrow(/gateway exploded/)
  })

  it('没有 choices 但也没有错误信号 → 不抛错，判为可重试的 EMPTY_RESPONSE', async () => {
    // 例如只带 usage 的收尾帧：**不应抛错**（那不是服务端错误）。
    //
    // ⚠️ 但它确实是**零内容块**的响应 —— 上游已用 `[DONE]` 宣告结束（合法
    // 结束方式），却一个块都没产出。按 DSH 的 `EMPTY_RESPONSE` 契约，这种
    // 「terminal stop with zero output」必须归类为该失败，而**不能**报 `stop`
    // 让 harness 认为「模型正常答完」—— 那会让本轮静默结束、什么都没有留给
    // 用户或循环去处理（与本文件上半部分那条「无报错中断」同族）。
    //
    // 官方适配器 `dsh-llm-deepseek` 的 `translate()` 正是这个语义：
    // `[DONE]` 且 `order.length === 0` ⇒ `EMPTY_RESPONSE`（与 usage 无关）。
    const usageOnly = `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`
    const chunks = await collect(asResponse(usageOnly))
    expect(chunks.find((c) => c.type === 'usage')).toBeDefined()
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'model returned a completed response with no content',
          code: 'EMPTY_RESPONSE',
        },
      },
    })
  })
})

describe('非 SSE 响应必须报错，而不是静默空结束（真实缺陷）', () => {
  it('整个 body 是 JSON（无任何 data: 帧）→ 抛错并带上原文片段', async () => {
    // 网关/网关错误页常直接回一个 JSON，既没有 data: 前缀也没有 SSE 结构。
    const body = JSON.stringify({ message: 'rate limited by gateway', statusCodeValue: 429 })
    const error = await collect(asResponse(body)).catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/不是 SSE|no data/i)
    // 必须带原文片段，便于用户/排查定位（否则又是一个「无原因」的失败）。
    expect(error.message).toContain('rate limited by gateway')
  })
})

/**
 * 回归（真实缺陷，2026-09-23 用户报障）：**名称为空的 tool-call 不得产出块**。
 *
 * ## 现象
 *
 * 用户在 zed 会话里贴图给 `workbuddy/deepseek-v4.1-flash` 发任务，**每次**都报：
 *
 * ```json
 * {"code":11133,"msg":"the request parameters were rejected by the model provider",
 *  "extError":{"code":"model_param_invalid","param":"","StatusCode":400}}
 * ```
 *
 * 文案只说「请求参数不符合当前模型要求」，**不指出是哪个字段**。
 *
 * ## 根因（本文件锁定，全部有实测证据）
 *
 * 源头就在本模块：qoder 偶发一个**完全没有 `name` 字段**的 tool-call 分片
 * （实测 seq=693 的原始流：`{index:2, id:'call_25e9…', args:[""]}`）。
 * 早期 `block-end` 处 `name: block.name ?? ''` 把它落成 **`name:''` 的块**，
 * 于是 ① harness 执行得到 `unknown tool ""`；② 该坏块被**持久化进会话历史**；
 * ③ 用户切到 workbuddy 后坏块被每次请求原样重放 → **400 code 11133**。
 *
 * 实测最小复现（wire 上的 `function.name` → 上游结果）：
 * `"read"` / `"unknown_tool"` → 200（**只校验非空，不校验存在性**）；
 * `""` / `null` / 缺失 → **400 code 11133**。
 *
 * ⚠️ **只跳过收尾的 `block-end` 是不够的**：上游 `BlockAssembler.assemble()`
 * 对没有 `block-end` 的 partial 同样会组装出 `name: partial.toolCallName ?? ''`。
 * 必须让该块**一个 chunk 都不产出**（连同 `block-start`），assembler 才会看不见它。
 */
describe('名称为空的 tool-call 不得产出任何 chunk（真实缺陷，跨 provider 传染）', () => {
  /** 一个只带 id/args、**完全没有 name** 的 tool-call 分片（线上实测形态）。 */
  const unnamedFrame = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 2, id: 'call_25e97a78849f449da444fc72', type: 'function', function: { arguments: '' } }] } }],
  })}\n\n`

  it('没有 name 的分片不产出 block-start / tool-call-delta / block-end', async () => {
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
    const chunks = await collect(asResponse(`${unnamedFrame}${finish}data: [DONE]\n\n`))
    // 整条流里不得出现任何 tool-call 块 —— 连 block-start 都不能有，
    // 否则 BlockAssembler 会为它建 partial 并组装出 name:''。
    expect(chunks.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call')).toEqual([])
    expect(chunks.filter((c) => c.type === 'tool-call-delta')).toEqual([])
    expect(chunks.filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')).toEqual([])
    // 丢弃了唯一的工具调用 → 不能静默 stop（那又是一次「无报错中断」）。
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('name 稍后才到的分片：先到的参数不得丢失（延迟发射后一次性补发）', async () => {
    // 首片只有 args 没有 name，第二片才带 name —— 常见于并行工具调用。
    const lateName = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { arguments: '{"command":' } }] } }],
    })}\n\n`
    const nameArrives = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'pwsh', arguments: '"ls"}' } }] } }],
    })}\n\n`
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
    const chunks = await collect(asResponse(`${lateName}${nameArrives}${finish}data: [DONE]\n\n`))
    const ends = chunks.filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({
      block: { type: 'tool-call', id: 'call_x', name: 'pwsh', arguments: '{"command":"ls"}' },
    })
    // 名字可用前不得发射任何 tool-call 块。
    const startIndex = chunks.findIndex((c) => c.type === 'block-start' && c.blockType === 'tool-call')
    expect(startIndex).toBeGreaterThan(-1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('一个无名 + 一个合法调用：保留合法者，照常报 tool-calls', async () => {
    // 线上真实形态就是「无名 call + 合法 pwsh」并存 —— 不能因坏块作废好块。
    const mixed = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_bad', function: { arguments: '{}' } },
        { index: 1, id: 'call_good', function: { name: 'pwsh', arguments: '{"command":"ls"}' } },
      ] } }],
    })}\n\n`
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
    const chunks = await collect(asResponse(`${mixed}${finish}data: [DONE]\n\n`))
    const ends = chunks.filter((c) => c.type === 'block-end' && (c.block as { type?: string }).type === 'tool-call')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ block: { id: 'call_good', name: 'pwsh' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})
