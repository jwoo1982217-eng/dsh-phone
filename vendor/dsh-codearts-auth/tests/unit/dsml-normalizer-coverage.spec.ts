/**
 * `dsml-normalizer-coverage.spec.ts` —— 防回归：**每个**正文出口都必须接归一化。
 *
 * ## 为什么需要这个测试（2026-10-13 真实事故）
 *
 * 首批归一化只接了 `openai-compat.ts` 与 `buddy-adapter.ts` 两个出口，自测
 * 12 条全绿、全量 7413 绿 —— 但**重启后会话里仍有 270 处坏标记**。
 * 原因：`text-delta` 出口共 **8 处**，另外 6 处（含 codearts 走的
 * `llm-adapter.ts` 主路径）**根本没接**。单测只验证了「归一化器自己是对的」，
 * 没验证「每个出口都用上了它」—— 于是覆盖缺口被完整放过。
 *
 * 这是「测试测了实现、没测接线」的典型盲区。本文件锁的就是**接线**。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(process.cwd(), 'src')

/** src 下所有 .ts（不含测试与声明文件）。 */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => ({ f, p: join(SRC_DIR, f) }))
    .filter(({ p }) => !readFileSync(p, 'utf8').includes("from 'vitest'"))
    .map(({ f }) => f)
}

/**
 * 找出所有发射 `text-delta` 的文件。
 *
 * 判据：`yield { type: 'text-delta'` 或 `yield {...text-delta...}` 形态。
 */
function textDeltaEmitters(): string[] {
  return sourceFiles().filter((f) => {
    const c = readFileSync(join(SRC_DIR, f), 'utf8')
    return /type:\s*'text-delta'/.test(c)
  })
}

describe('DSML 归一化接线覆盖（防回归）', () => {
  const emitters = textDeltaEmitters()

  it('① 出口数量必须被显式登记 —— 新增出口要同步补接线', () => {
    // ⚠️ 这个数字变动**必须**意味着有人新增/删减了正文出口。
    //    新增时请把该出口也接上归一化，并把本数字改到新值 —— 故意让它「红一次」，
    //    逼接线的动作发生（不能无脑改数字）。
    expect(
      emitters.sort(),
      `正文出口清单变了（${emitters.length} 个）：${emitters.join(', ')}。若新增出口，必须同时接入 DSML 归一化。`,
    ).toEqual([
      'buddy-adapter.ts',
      'gemini-messages.ts',
      'llm-adapter.ts',
      'lobsterai-adapter.ts',
      'minimax-messages.ts',
      'openai-compat.ts',
      'opencode-local-adapter.ts',
      'orcaterm-adapter.ts',
      'trae-adapter.ts',
      'zcode-anthropic.ts',
    ])
  })

  it('② **每个**出口都必须真正调用 dsmlFix（缺一即红）', () => {
    const uncovered = emitters.filter((f) => {
      const c = readFileSync(join(SRC_DIR, f), 'utf8')
      return !/dsmlFix/.test(c)
    })
    expect(
      uncovered,
      `以下正文出口未接入 DSML 归一化（2026-10-13 事故根因）：${uncovered.join(', ')}`,
    ).toEqual([])
  })

  it('③ 每个出口都必须 flush 待定缓冲（否则尾部字符丢失）', () => {
    const noFlush = emitters.filter((f) => {
      const c = readFileSync(join(SRC_DIR, f), 'utf8')
      return !/dsmlFix\.flush\(\)/.test(c)
    })
    expect(noFlush, `以下出口没有 flush（流尾字符会丢）：${noFlush.join(', ')}`).toEqual([])
  })

  it('④ 归一化实现必须只有 sse.ts 一处（不得各写各的）', () => {
    const definers = sourceFiles().filter((f) => {
      const c = readFileSync(join(SRC_DIR, f), 'utf8')
      return /function (fixDsmlMarkers|createDsmlMarkerNormalizer)/.test(c)
    })
    expect(definers, `实现散落多处：${definers.join(', ')}`).toEqual(['sse.ts'])
  })
})
