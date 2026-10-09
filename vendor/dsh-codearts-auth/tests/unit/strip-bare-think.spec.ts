/**
 * 回归 `stripBareThinkCloseTag`（剥离裸 `</think>` 闭标签）+ 其**开关语义**。
 *
 * 根因（2026-09-27）：模型单独吐出一个 **纯 `</think>` 块**（`\n</think>\n\n`），
 * 既有正则只认 `</think:hex>` → 漏网之鱼。需要专门剥离“去掉首尾空白后等于 `</think>`"
 * 的整块内容。
 *
 * ## ⚠️ 本函数是**兜底**，且**默认不启用**（用户决定，2026-09-27）
 *
 * > 我们现在暂时不需要泄露过滤，代码可以保留，文档和注释记明白，后续再实际
 * > 使用中看是否还有泄露问题。**加了过滤可能有思考解析失败但是被过滤我们
 * > 发现不了。**
 *
 * 故分工是：
 * - **解析**（`splitThinkTaggedContent`）**恒开** —— 把配对/hex/裸闭标签格式做对；
 * - **过滤**（本函数）**默认关** —— 只在 `DSH_THINK_LEAK_STRIP=1` 时兜底，
 *   避免把「解析失败」静默掩盖掉。
 *
 * ## 实测形态
 *
 * | 形态 | 是否泄漏 | 处理 | 示例 |
 * |---|---|---|---|
 * | 纯裸闭标签 | 真泄漏 | 返回空串 | `\n</think>\n\n` |
 * | hex 标签 | 需切分 | 原样返回 | `思考</think:6124c78e>正文` |
 * | 引用语境 | 非泄漏 | 原样返回 | `` `</think>` `` |
 * | 正文 + 裸标签 | 复杂 | 原样返回 | `'前</think>后'` |
 * | 大小写变体 | 误伤风险 | 原样返回 | `</THINK>` |
 */
import { describe, expect, it } from 'vitest'
import { stripBareThinkCloseTag, stripBareThinkCloseTagIfEnabled, resolveThinkLeakStripFlag } from '../../src/sse.js'

describe('think 泄漏过滤的**开关语义**（默认关，用户决定）', () => {
  it('默认（环境变量未设）→ **关闭**，不剥离', () => {
    expect(process.env.DSH_THINK_LEAK_STRIP).toBeUndefined()
    // ⚠️ 与 `DSH_COURSE_LEAK_STRIP` / `DSH_REASONING_LOOP_GUARD` **语义相反**：
    // 那两个默认开、显式假值才关；本开关默认关、显式真值才开。
    expect(resolveThinkLeakStripFlag(undefined)).toBe(false)
    expect(stripBareThinkCloseTagIfEnabled('\n</think>\n\n')).toBe('\n</think>\n\n')
  })

  it('显式真值才开启（1/true/yes/on，大小写与空白不敏感）', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON', ' 1 ']) {
      expect(resolveThinkLeakStripFlag(v)).toBe(true)
    }
  })

  it('**任何其他值都视为关闭**（含 `0` 与空串）—— 与「默认开」的开关不可混用', () => {
    for (const v of ['0', 'false', 'no', 'off', '', '  ', 'banana', '2']) {
      expect(resolveThinkLeakStripFlag(v)).toBe(false)
    }
  })

  it('开启时纯标签块被剥离，关闭时原样返回', () => {
    process.env.DSH_THINK_LEAK_STRIP = '1'
    try {
      expect(stripBareThinkCloseTagIfEnabled('\n</think>\n\n')).toBe('')
    } finally {
      delete process.env.DSH_THINK_LEAK_STRIP
    }
    expect(stripBareThinkCloseTagIfEnabled('\n</think>\n\n')).toBe('\n</think>\n\n')
  })

  it('关闭时**含正文**的块也无条件原样返回（过滤不干预解析）', () => {
    // 解析由 `splitThinkTaggedContent` 负责，本函数无论开关都不该动含正文的块
    expect(stripBareThinkCloseTagIfEnabled('思考</think>正文')).toBe('思考</think>正文')
    process.env.DSH_THINK_LEAK_STRIP = '1'
    try {
      expect(stripBareThinkCloseTagIfEnabled('思考</think>正文')).toBe('思考</think>正文')
    } finally {
      delete process.env.DSH_THINK_LEAK_STRIP
    }
  })
})

describe('stripBareThinkCloseTag', () => {
  // ────────────────────────────────────────────────────────────────────────
  // 裸标签块：必须剥离（返回空串）
  // ────────────────────────────────────────────────────────────────────────
  it('纯裸闭标签（含前后空白）→ 空串', () => {
    expect(stripBareThinkCloseTag('\n</think>\n\n')).toBe('')
    expect(stripBareThinkCloseTag('\n\n</think>\n')).toBe('')
    expect(stripBareThinkCloseTag('    </think>   ')).toBe('')
    expect(stripBareThinkCloseTag('</think>')).toBe('')
  })

  // ────────────────────────────────────────────────────────────────────────
  // hex 标签：不剥离（交由 splitThinkTaggedContent 处理）
  // ────────────────────────────────────────────────────────────────────────
  it('带 hex 的后缀 → 原样返回', () => {
    expect(stripBareThinkCloseTag('</think:6124c78e>')).toBe('</think:6124c78e>')
    expect(stripBareThinkCloseTag('思考</think:6124c78e>正文')).toBe('思考</think:6124c78e>正文')
    expect(stripBareThinkCloseTag('</think:zzz>')).toBe('</think:zzz>') // hex 无效时也不剥
  })

  // ────────────────────────────────────────────────────────────────────────
  // 引用语境：必须保留（3/3 分离度，不可动）
  // ────────────────────────────────────────────────────────────────────────
  it('行内反引号包裹的裸标签 → 原样返回', () => {
    expect(stripBareThinkCloseTag('`</think>`')).toBe('`</think>`')
    expect(stripBareThinkCloseTag('文本 `</think>` 文本')).toBe('文本 `</think>` 文本')
  })

  it('代码块围栏内的裸标签 → 原样返回', () => {
    expect(stripBareThinkCloseTag('```\n</think>\n```')).toBe('```\n</think>\n```')
    expect(stripBareThinkCloseTag('```\n</think>\```\n\n正文')).toBe('```\n</think>\```\n\n正文')
  })

  // ────────────────────────────────────────────────────────────────────────
  // 其他尖括号文本：不误伤
  // ────────────────────────────────────────────────────────────────────────
  it('其他尖括号文本 → 原样返回', () => {
    expect(stripBareThinkCloseTag('a < b </div> c')).toBe('a < b </div> c')
    expect(stripBareThinkCloseTag('<thinking>')).toBe('<thinking>')
    expect(stripBareThinkCloseTag('</thinking>')).toBe('</thinking>')
  })

  // ────────────────────────────────────────────────────────────────────────
  // 大小写敏感：仅认小写
  // ────────────────────────────────────────────────────────────────────────
  it('大小写敏感：仅认小写', () => {
    expect(stripBareThinkCloseTag('</THINK>')).toBe('</THINK>')
    expect(stripBareThinkCloseTag('</Think>')).toBe('</Think>')
    expect(stripBareThinkCloseTag('</THink>')).toBe('</THink>')
  })

  // ────────────────────────────────────────────────────────────────────────
  // 正文混合：保持原样（由 caller 决定如何处理）
  // ────────────────────────────────────────────────────────────────────────
  it('含正文的裸标签块 → 原样返回', () => {
    expect(stripBareThinkCloseTag('正文</think>')).toBe('正文</think>')
    expect(stripBareThinkCloseTag('</think>正文')).toBe('</think>正文')
    expect(stripBareThinkCloseTag('前文</think>后文')).toBe('前文</think>后文')
  })

  // ────────────────────────────────────────────────────────────────────────
  // 边缘情况：多标签、混合标签
  // ────────────────────────────────────────────────────────────────────────
  it('同一块内的多个裸标签 → 仍视为纯裸标签块 → 空串', () => {
    expect(stripBareThinkCloseTag('</think></think>')).toBe('')
    expect(stripBareThinkCloseTag('\n</think>\n</think>\n')).toBe('')
  })
})
