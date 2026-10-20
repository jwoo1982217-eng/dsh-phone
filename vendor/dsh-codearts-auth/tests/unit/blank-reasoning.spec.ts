/**
 * 「纯空白思考抑制器」的回归测试。
 *
 * ## 真实缺陷（用户报障）
 *
 * UI 上出现**空的思考（Think）块**。
 *
 * ## 实测证据（控制方实证）
 *
 * 模型 `deepseek-v4.1-flash` 偶发**只输出一个空格当思考**（实测 **2232 次**，
 * `usage.reasoningTokens = 1`）。该空格被落成 reasoning 块、画成空 Think 块，
 * 并作为 `reasoning_content: " "` 发回模型。
 *
 * ## 为什么必须「延后建块」而不是在出口过滤
 *
 * `BlockAssembler` 在**没有 `block-end`** 时会用 `partial.text` 组装出块 ——
 * 故只在收尾处过滤是不够的：块照样会凭空出现。必须**从一开始就不发任何 chunk**。
 * 这与本项目「空名字 `tool_call`」的修法**同型**（先例：`src/sse.ts` 的
 * `hasUsableToolName`）。
 *
 * ## 判据是「整块」而非「单片」
 *
 * 只有**整块** `trim()` 为空才丢弃。`["a", " "]` 的整块是 `'a '`（**非空**）
 * ⇒ 必须保留，不能因为最后一片是空白就丢掉。
 */
import { describe, expect, it } from 'vitest'
import { createBlankReasoningSuppressor } from '../../src/sse.js'

describe('createBlankReasoningSuppressor', () => {
  // ────────────────────────────────────────────────────────────────────────
  // brief 行为表（8 行）
  //
  // | 输入序列 | `feed` 逐次返回 | `text()` |
  // |---|---|---|
  // | `[" "]` | `[undefined]` | `' '`（trim 空 ⇒ 丢弃） |
  // | `[" "]` × 3 | `[undefined, undefined, undefined]` | `'   '`（丢弃） |
  // | `["", " "]` | `[undefined, undefined]` | `' '`（丢弃） |
  // | `["我需要", "确认"]` | `['我需要', '确认']` | `'我需要确认'` |
  // | `[" ", "我需要"]` | `[undefined, ' 我需要']` | `' 我需要'` ← 补发已累积 |
  // | `["  ", "a"]` | `[undefined, '  a']` | `'  a'` |
  // | `["a", " "]` | `['a', ' ']` | `'a '` ← 非空，保留 |
  // | `[]`（从未 feed） | `[]` | `''`（丢弃） |
  // ────────────────────────────────────────────────────────────────────────

  /**
   * 跑一遍输入序列，返回逐次 `feed` 的返回值与末态 `text()`。
   * 用 `undefined` 明确表达「本片不发任何 chunk」。
   */
  function run(inputs: readonly string[]): { feeds: (string | undefined)[]; text: string } {
    const suppressor = createBlankReasoningSuppressor()
    const feeds = inputs.map(input => suppressor.feed(input))
    return { feeds, text: suppressor.text() }
  }

  // 行为表第 1 行：单片纯空格 ⇒ 必须返回 undefined（调用方因此不发任何 chunk）。
  it('[" "]: 单片纯空格不发 chunk，但 text() 记录原样空格', () => {
    const { feeds, text } = run([' '])
    expect(feeds).toEqual([undefined])
    // 原样记录：判据留给调用方按 text().trim() === '' 决定丢弃。
    expect(text).toBe(' ')
  })

  // 行为表第 2 行：连续三片空格 ⇒ 每一片都不发，累积为三个空格。
  it('[" "] × 3: 每一片都不发 chunk，累积为三个空格', () => {
    const { feeds, text } = run([' ', ' ', ' '])
    expect(feeds).toEqual([undefined, undefined, undefined])
    expect(text).toBe('   ')
  })

  // 行为表第 3 行：空串不是「转正」信号 —— 空串后接空格仍应整块丢弃。
  it('["", " "]: 空串与空格都不算非空白，全部不发', () => {
    const { feeds, text } = run(['', ' '])
    expect(feeds).toEqual([undefined, undefined])
    expect(text).toBe(' ')
  })

  // 行为表第 4 行：正常响应（首片即非空白）—— 首片发全量，其后只发本片增量，
  // 保证「首片非空白时逐 chunk 行为与改动前完全一致」。
  it('["我需要", "确认"]: 正常响应逐片发出，文本完整累积', () => {
    const { feeds, text } = run(['我需要', '确认'])
    expect(feeds).toEqual(['我需要', '确认'])
    expect(text).toBe('我需要确认')
  })

  // 行为表第 5 行：**关键行** —— 从空白转为非空白的那一次必须**补发已累积的全部文本**，
  // 因为此前一片都没发过（只发增量会丢掉前导空格，调用方拿到的块内容与 wire 不符）。
  it('[" ", "我需要"]: 转正时补发已累积的全部文本', () => {
    const { feeds, text } = run([' ', '我需要'])
    expect(feeds).toEqual([undefined, ' 我需要'])
    expect(text).toBe(' 我需要')
  })

  // 行为表第 6 行：两片空格后转正，补齐的是「两个空格 + 本片」。
  it('["  ", "a"]: 两个空格后转正，补发两个空格加本片', () => {
    const { feeds, text } = run(['  ', 'a'])
    expect(feeds).toEqual([undefined, '  a'])
    expect(text).toBe('  a')
  })

  // 行为表第 7 行：**判据是整块而非单片** —— 整块 `'a '` 的 trim() 非空 ⇒ 保留；
  // 已发过之后，尾部空白片按普通增量原样发出（绝不能因为「本片 trim 为空」而吞掉）。
  it('["a", " "]: 整块非空故保留，尾部空白片照常发出', () => {
    const { feeds, text } = run(['a', ' '])
    expect(feeds).toEqual(['a', ' '])
    expect(text).toBe('a ')
  })

  // 行为表第 8 行：从未 feed ⇒ 未产出任何文本，text() 为 ''，调用方据此不建块。
  it('[]（从未 feed）: 不产出任何文本', () => {
    const { feeds, text } = run([])
    expect(feeds).toEqual([])
    expect(text).toBe('')
  })

  describe('接口语义与调用方约定', () => {
    it('text() 始终是整块迄今的完整文本（含未被发出的部分）', () => {
      const suppressor = createBlankReasoningSuppressor()
      expect(suppressor.text()).toBe('')
      suppressor.feed(' ')
      expect(suppressor.text()).toBe(' ')
      suppressor.feed('  ')
      expect(suppressor.text()).toBe('   ')
      suppressor.feed('x')
      expect(suppressor.text()).toBe('   x')
    })

    it('每个实例状态独立（6 个适配器各持一个，互不串味）', () => {
      const a = createBlankReasoningSuppressor()
      const b = createBlankReasoningSuppressor()
      a.feed(' ')
      // b 未被喂入任何内容 ⇒ 不能因 a 的累积而提前转正。
      expect(b.feed(' ')).toBeUndefined()
      expect(b.text()).toBe(' ')
      expect(a.text()).toBe(' ')
    })

    it('转正之后不再回退：后续空片仍是普通增量，不会把块判回空白', () => {
      const suppressor = createBlankReasoningSuppressor()
      expect(suppressor.feed('a')).toBe('a')
      // 已发过内容 ⇒ text() 里一定有非空白字符，调用方不会丢弃整块。
      // 断言写足值而非 `.not.toBe('')`：后者是弱形态，把 `text()` 误改成
      // `.trim()` 也仍然通过（已用变异测试证实），锁不住真实契约。
      expect(suppressor.feed('')).toBe('')
      expect(suppressor.text()).toBe('a')
      expect(suppressor.text().trim()).not.toBe('')
    })
  })

  /**
   * 锁死 brief 里那套「调用方固定写法」的核心后果：**纯空白块不占用 `index`**。
   *
   * 这是「必须延后建块」的收益所在 —— 若空白块也 `nextIndex++`，后续 text 块
   * 的下标就会平白前移一格，与正常响应（首片非空白）不一致。
   * 此处按 brief 的伪代码复刻调用方逻辑，确认它可直接落地。
   */
  it('按 brief 的调用方写法：纯空白块不建块、不消耗 index', () => {
    type Block = { index: number; kind: string; text: string }
    const blocks: Block[] = []
    let nextIndex = 0
    const emitted: { type: string; index: number; text?: string }[] = []
    const suppressor = createBlankReasoningSuppressor()

    const consume = (reasoningDelta: string): void => {
      const emit = suppressor.feed(reasoningDelta)
      if (emit === undefined) return
      let block = blocks.find(candidate => candidate.kind === 'reasoning')
      if (block === undefined) {
        block = { index: nextIndex++, kind: 'reasoning', text: '' }
        blocks.push(block)
        emitted.push({ type: 'block-start', index: block.index })
      }
      // 以 helper 为准回写，避免两处累积口径不一致。
      block.text = suppressor.text()
      emitted.push({ type: 'reasoning-delta', index: block.index, text: emit })
    }

    // 一片纯空白思考：不应产生任何块 / chunk / index 消耗。
    consume(' ')
    expect(blocks).toHaveLength(0)
    expect(emitted).toHaveLength(0)
    expect(nextIndex).toBe(0)

    // ⚠️ 这里**不单独**断言「正文块拿到 index 0」——那与上一行的
    // `nextIndex === 0` 恒等、无判别力。但**必须真的消耗一次 index**
    // （下面这行 `nextIndex++`），否则它就白白留着，下一个块拿到的仍是 0，
    // 下面的对照就失去意义（控制方第一版删掉它时正是这么坏的）。
    nextIndex++ // 模拟调用方为紧随其后的正文块分配 index 0

    // 对照：同一流程喂入**非空白**思考后，reasoning 块拿到的是 index **1**
    // （而非 0）—— 证明空白块确实没占下标。
    consume('我需要')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].index).toBe(1)
    // 补发的文本 = 已累积的全部文本，与 wire/块内容一致。
    expect(blocks[0].text).toBe(' 我需要')
    expect(emitted).toEqual([
      { type: 'block-start', index: 1 },
      { type: 'reasoning-delta', index: 1, text: ' 我需要' },
    ])
  })
})
