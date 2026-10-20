/**
 * 回归：**正文引用 `</think>` 导致对话中断**（用户报障，2026-09-27）。
 *
 * ## 缺陷机制
 *
 * 上游（Qwen 系，实测 `qoder/qfmodel`）把 **`</think>` 当停止串**。模型在正文里
 * 写这个标签（哪怕包在反引号里，如 `` `</think>` ``）会被服务端**掐断生成**，
 * 但随后仍报 `finish_reason:"stop"` —— 我们据此判「模型正常答完」→
 * harness 认为本轮已完成 → **没有任何报错就停住**。
 *
 * ## 三条真实证据（本会话，正文尾部 + outputTokens）
 *
 * | 行 | 正文尾部 | outTok | 正要写 |
 * |---|---|---|---|
 * | 5378 | ``…清洗器只认 ` `` | 369 | `` `</think:hex>` `` |
 * | 5412 | ``…多吐了一个孤立的裸 ` `` | 643 | `` `</think>` `` |
 * | 5600 | `` 找到了，`trae-adapter.ts` 还没补 ` `` | **37** | `` `</think>` `` |
 *
 * ## 判据（`isProseTruncatedByStopString`）
 *
 * ```
 * 反引号总数为奇数（有未闭合行内代码）  且  以未闭合的开引号收尾
 * ```
 *
 * ⚠️ 不用「以反引号结尾」单独判定：`` 运行 `pnpm test` `` 也以反引号结尾但配对完整。
 * 实测粗判据命中 9 处（6 处假阳性），本判据命中 3 处**全部**为真截断。
 *
 * ## 本文件锁定的四件事
 *
 * 1. 纯函数判据的真/假阳性边界；
 * 2. `finish_reason=stop` + 未闭合正文 + **无工具调用** → 报 `max-tokens`；
 * 3. **有**工具调用时不得误报（模型写完就去调工具是正常的）；
 * 4. 反引号配对完整的正常正文 → 仍是 `stop`（不回归）。
 */
import { describe, expect, it } from 'vitest'
import { consumeOpenAiSse } from '../../src/openai-compat.js'
import { isProseTruncatedByStopString } from '../../src/sse.js'

const BT = '`'
/** 用原始 SSE 文本构造响应。 */
const asResponse = (text: string): Response =>
  new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

/** 构造一个正文帧。 */
const textFrame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }] })}\n\n`

/** 显式 finish_reason 帧。 */
const finishFrame = (reason: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason, index: 0 }] })}\n\n`

/** 构造一个工具调用帧（name + 完整参数）。 */
const toolFrame = (): string =>
  `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id: 'call_1', type: 'function',
          function: { name: 'read', arguments: '{"file_path":"a.ts"}' },
        }],
      },
      index: 0,
    }],
  })}\n\n`

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

const finishOf = (chunks: Array<Record<string, unknown>>) => chunks.at(-1)

// ══════════════════════════════════════════════════════════════════════════
describe('isProseTruncatedByStopString — 纯函数判据', () => {
  it('真实截断形态：止于未闭合的开引号 → true', () => {
    // 三条实测证据的尾部（都是「正要写 `</think>`」）
    expect(isProseTruncatedByStopString('找到了，`trae-adapter.ts` 还没补 `')).toBe(true)
    expect(isProseTruncatedByStopString('…**但你的怀疑指向一个真实存在、这次没触发的漏洞**：清洗器只认 `')).toBe(true)
    expect(isProseTruncatedByStopString('**⇒ 结论：模型在 `content` 通道多吐了一个孤立的裸 `')).toBe(true)
  })

  it('止于半个标签（服务端已吐出 `<` 的一部分）→ true', () => {
    expect(isProseTruncatedByStopString('正文 `</think')).toBe(true)
    expect(isProseTruncatedByStopString('正文 `</think>')).toBe(false) // 标签完整则反引号只有 1 个？见下
  })

  it('反引号配对完整 → false（不误伤正常正文）', () => {
    // 这是**关键**假阳性防线：正常行内代码也以反引号结尾
    expect(isProseTruncatedByStopString('运行 `pnpm test`')).toBe(false)
    expect(isProseTruncatedByStopString('见 `src/sse.ts` 的实现')).toBe(false)
    expect(isProseTruncatedByStopString('已修复 `stripBareThinkCloseTag`')).toBe(false)
    // 完整引用标签（用户看到的正常形态）
    expect(isProseTruncatedByStopString('清洗器只认 `</think:hex>`')).toBe(false)
    expect(isProseTruncatedByStopString('我处理 `</think>` 标签')).toBe(false)
  })

  it('无未闭合行内代码 → false', () => {
    expect(isProseTruncatedByStopString('这是一段没有反引号的正常正文。')).toBe(false)
    expect(isProseTruncatedByStopString('')).toBe(false)
    expect(isProseTruncatedByStopString('   ')).toBe(false)
    // 以标签结尾但反引号成对
    expect(isProseTruncatedByStopString('标签是 `</think>`')).toBe(false)
  })

  it('奇数反引号但不以反引号收尾 → false（未闭合在中间，判据不可证）', () => {
    // 末字符不是反引号 → 无法证明「最后一个开引号未闭合」
    expect(isProseTruncatedByStopString('`开头 中间 结束')).toBe(false)
    expect(isProseTruncatedByStopString('a ` b ` c ` 正文')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('正文被停止串截断 → 报 max-tokens 而非 stop（真实缺陷）', () => {
  it('finish=stop + 未闭合正文 + 无工具调用 → max-tokens', async () => {
    // 复刻行 5600：正文止于未闭合开引号，上游报 stop
    const chunks = await collect(asResponse(
      textFrame('找到了，`trae-adapter.ts` 还没补 `') + finishFrame('stop'),
    ))
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('正文分多帧到达、末帧收尾于开引号 → 仍能识别', async () => {
    // 真实流式形态：`</think>` 的前缀分多帧（`<` / `/thi` / `nk>`）
    const chunks = await collect(asResponse(
      textFrame('找到了，`trae-adapter.ts` 还没补 ') + textFrame('`') + finishFrame('stop'),
    ))
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('**有**工具调用时不得误报（模型写完就去调工具是正常的）', async () => {
    // 正文止于开引号，但同时产出了完整工具调用 → 应报 tool-calls
    const chunks = await collect(asResponse(
      textFrame('现在读文件：`') + toolFrame() + finishFrame('tool_calls'),
    ))
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('反引号配对完整的正常正文 → 仍是 stop（不回归）', async () => {
    const chunks = await collect(asResponse(
      textFrame('已完成修复，见 `src/sse.ts`。') + finishFrame('stop'),
    ))
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('正常引用 `</think>` 标签（配对完整）→ 仍是 stop', async () => {
    // 这正是本会话最常见的形态：模型在正文里讨论这个标签
    const chunks = await collect(asResponse(
      textFrame('清洗器只认 `</think:hex>`，裸 `</think>` 会漏。') + finishFrame('stop'),
    ))
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('纯裸标签块 → 解析器把标签切走（**不依赖过滤开关**）', async () => {
    // 行 21908 形态：整块就是 `\n</think>\n\n`。
    //
    // ⚠️ 2026-09-27 起**过滤默认关闭**（用户决定：过滤会掩盖解析失败），
    // 但**解析器仍独立生效** —— 它把标签当作分界切走，落盘只剩空白：
    //   text-delta（流式）  = "\n</think>\n\n"  ← 用户实时可见，便于观测
    //   block-end（权威）   = "\n\n"            ← 标签已被解析器切走
    //
    // 这正是「解析做对 + 过滤关闭」的预期形态：**标签不落盘，且过程可观测**。
    const chunks = await collect(asResponse(
      textFrame('\n</think>\n\n') + finishFrame('stop'),
    ))
    let finalText: string | undefined
    for (const c of chunks) {
      if (c.type === 'block-end') {
        const b = c.block as { type?: string; text?: string } | undefined
        if (b?.type === 'text') finalText = b.text
      }
    }
    expect(finalText).toBe('\n\n')
    expect(finalText?.includes('</think>')).toBe(false)
  })

  it('`DSH_THINK_LEAK_STRIP=1` 时纯标签块被兜底剥离成空 → 不发 text 块', async () => {
    // 应急开关打开时才走兜底：标签块被清成空串 → 不发射 text 块
    process.env.DSH_THINK_LEAK_STRIP = '1'
    try {
      const chunks = await collect(asResponse(
        textFrame('\n</think>\n\n') + finishFrame('stop'),
      ))
      let sawText = false
      for (const c of chunks) {
        if (c.type === 'block-end') {
          const b = c.block as { type?: string } | undefined
          if (b?.type === 'text') sawText = true
        }
      }
      expect(sawText).toBe(false)
    } finally {
      delete process.env.DSH_THINK_LEAK_STRIP
    }
  })

  it('finish=length 优先（不被本判据覆盖）', async () => {
    const chunks = await collect(asResponse(
      textFrame('正文 `') + finishFrame('length'),
    ))
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

// ══════════════════════════════════════════════════════════════════════════
/**
 * 跨帧归位回归 —— **标签被切成任意片段时都必须正确切分**。
 *
 * ## 为什么单列一段（2026-09-27 审计发现的真实缺陷）
 *
 * 原实现用一个 `proseHasThinkTag` 布尔量当**门禁**：逐帧判
 * `textDelta.includes('</think>')`，命中才在收尾切分。该判据要求**完整**标签，
 * 而标签**必然跨帧**（上游按 token 切分，`思考<` + `/think>正文` 是常态）。
 *
 * 实测（`scripts/probe-think-flag-split.mjs`，枚举全部分帧方式）：
 *
 * | 文本 | 分 2 帧时漏判 |
 * |---|---|
 * | `思考</think>正文` | **7/11** |
 * | `<think>思考</think>正文` | 7/18 |
 * | `思考</think:6124c78e>正文` | 5/20 |
 *
 * 漏判 ⇒ 收尾不切分 ⇒ 标签原样落盘泄漏给用户。这与该变量自己的注释
 * （「标签可能跨帧到达，必须缓冲到收尾」）**自相矛盾** —— 门禁本身就是那个
 * 不该存在的逐帧判定。现改为**收尾无条件解析**（无标签时返回 undefined，
 * 普通响应逐字节不变）。
 *
 * ⚠️ 本段用例**必须**在删掉门禁后通过；若有人重新引入逐帧门禁，这些用例会红。
 */
describe('跨帧归位：标签被切开也必须正确解析（不得用逐帧门禁）', () => {
  /** 取最终落盘的 text 块。 */
  const textBlockOf = (chunks: Array<Record<string, unknown>>): string | undefined => {
    let out: string | undefined
    for (const c of chunks) {
      if (c.type === 'block-end') {
        const b = c.block as { type?: string; text?: string } | undefined
        if (b?.type === 'text') out = b.text
      }
    }
    return out
  }
  /** 取最终落盘的 reasoning 块。 */
  const reasoningBlockOf = (chunks: Array<Record<string, unknown>>): string | undefined => {
    let out: string | undefined
    for (const c of chunks) {
      if (c.type === 'block-end') {
        const b = c.block as { type?: string; text?: string } | undefined
        if (b?.type === 'reasoning') out = b.text
      }
    }
    return out
  }

  it('裸闭标签被切成 `思考<` + `/think>正文` → 仍正确归位', async () => {
    const chunks = await collect(asResponse(
      textFrame('思考<') + textFrame('/think>正文') + finishFrame('stop'),
    ))
    expect(reasoningBlockOf(chunks)).toBe('思考')
    expect(textBlockOf(chunks)).toBe('正文')
  })

  it('裸闭标签被切成 `思考</thi` + `nk>正文` → 仍正确归位', async () => {
    const chunks = await collect(asResponse(
      textFrame('思考</thi') + textFrame('nk>正文') + finishFrame('stop'),
    ))
    expect(reasoningBlockOf(chunks)).toBe('思考')
    expect(textBlockOf(chunks)).toBe('正文')
  })

  it('hex 闭标签被切成 `思考</think:61` + `24c78e>正文` → 仍正确归位', async () => {
    // 这是**原有注释自己举的例子**，此前靠 `think:` 子串恰好能命中；
    // 但裸标签没有这样的「安全子串」，故必须去掉门禁。
    const chunks = await collect(asResponse(
      textFrame('思考</think:61') + textFrame('24c78e>正文') + finishFrame('stop'),
    ))
    expect(reasoningBlockOf(chunks)).toBe('思考')
    expect(textBlockOf(chunks)).toBe('正文')
  })

  it('配对形态被切开（开标签一处、闭标签另一处）→ 仍正确归位', async () => {
    const chunks = await collect(asResponse(
      textFrame('<think>思考') + textFrame('内容</think>真正文') + finishFrame('stop'),
    ))
    expect(reasoningBlockOf(chunks)).toBe('思考内容')
    expect(textBlockOf(chunks)).toBe('真正文')
  })

  it('逐字符分帧（最坏情况）→ 仍正确归位', async () => {
    // 极端形态：上游每个 token 一帧。逐帧门禁在此必漏。
    const parts = ['思', '考', '<', '/', 't', 'h', 'i', 'n', 'k', '>', '正', '文']
    let sse = ''
    for (const p of parts) sse += textFrame(p)
    const chunks = await collect(asResponse(sse + finishFrame('stop')))
    expect(reasoningBlockOf(chunks)).toBe('思考')
    expect(textBlockOf(chunks)).toBe('正文')
  })

  it('普通正文（无标签）→ 不受影响，逐字节不变', async () => {
    const chunks = await collect(asResponse(
      textFrame('普通正文') + textFrame('，没有标签。') + finishFrame('stop'),
    ))
    expect(textBlockOf(chunks)).toBe('普通正文，没有标签。')
    expect(reasoningBlockOf(chunks)).toBeUndefined()
  })

  it('引用语境跨帧到达 → 不误切分', async () => {
    // 模型讨论标签：`` `</think>` `` 被切开，但仍处于反引号内
    const chunks = await collect(asResponse(
      textFrame('清洗器只认 `') + textFrame('</think>') + textFrame('` 这个字面量。') + finishFrame('stop'),
    ))
    // 引用语境 → 不切分 → 全部留在正文
    expect(reasoningBlockOf(chunks)).toBeUndefined()
    expect(textBlockOf(chunks)).toBe('清洗器只认 `</think>` 这个字面量。')
  })
})
