/**
 * `tests/helpers/source-scope.ts` 的回归测试。
 *
 * ## 守的是什么（Gitee issue IKJMG1 的成因）
 *
 * 源码契约测试取函数体，早期写法是「`indexOf` 找起点，再 `indexOf('\n}\n')` 找终点」。
 * 该写法在两种行尾下**都会错**，且错的方向相反：
 *
 * | 行尾 | 现象 | 后果 |
 * |---|---|---|
 * | CRLF（`core.autocrlf=true`，Windows 默认） | `indexOf('\n}\n')` 恒 **-1** | `slice(start, -1)` 吐出**整个文件尾部** ⇒ 断言恒假绿，且分不清命中的是不是这个函数 |
 * | LF | 命中函数体内第一个列 0 的 `}` | 截到一小截 ⇒ 用例**假失败** |
 *
 * 真实切片长度实测（同一个 `hideWindowWindows`，文件全长 65618/67656 字节）：
 * LF 切出 1178 字节；CRLF 切出 **39183 字节**（59% 的文件）⇒ 确认「切到尾部」。
 *
 * ⇒ 本文件把「切出来**恰好是它自己**」与「行尾无关」两条从文档承诺变成用例锁定。
 *
 * ## 为什么这些用例不是同义反复
 *
 * 每条都针对一个**具体的失败形态**，且都能单独红：
 *   - `fn('first')` 混入 `SECOND_ONLY` ⇒ 退回字符串切片（哪怕切对了边界也漏）
 *   - CRLF/LF 结果不一致 ⇒ 助手内部用了行尾敏感的定位
 *   - 模板串/正则里的 `}` 提前截断 ⇒ 只数括号、不走 AST
 */
import { describe, expect, it } from 'vitest'
import { sourceScope } from '../helpers/source-scope.js'

/** 只在第二个函数里出现的串：任何「切太宽」的实现都会把它带进来。 */
const SECOND_ONLY = 'SECOND_ONLY_MARKER'

/** 前置 JSDoc 里的词：`getText()` 从 `getStart()` 起，应**不含**它。 */
const JDOC_ONLY = 'JDOC_ONLY_MARKER'

/** 夹具刻意包含三种能让「数括号」翻车的构造。 */
const FIXTURE = `/**
 * 前置 JSDoc，含 ${JDOC_ONLY} 与一个 } 符号。
 */
export function first(n: number): string {
  if (n > 0) {
    return \`闭合符在模板串里：}\n}\n不该被当函数尾\`
  }
  return 'ok'
}

export function second(): void {
  const re = /}\\n}\\n/
  void re
  console.log('${SECOND_ONLY}')
}
`

/** 把 LF 文本转成 CRLF（其余字节不动）。 */
const toCrlf = (lf: string): string => lf.replace(/\n/g, '\r\n')

describe('source-scope：切出来恰好是它自己（issue IKJMG1）', () => {
  it('★ fn() 不得混入后一个函数的源码（字符串切片切太宽的形态）', () => {
    const out = sourceScope(FIXTURE).fn('first')
    expect(out).toContain('export function first')
    expect(out).not.toContain(SECOND_ONLY)
  })

  it('★ 模板串与正则里的 `}` 不得提前截断（只数括号会翻车）', () => {
    const out = sourceScope(FIXTURE).fn('first')
    expect(out).toContain('闭合符在模板串里')
    expect(out).toContain('if (n > 0)')
    // 完整函数体以 return 'ok' 收尾；被提前截断就拿不到它。
    expect(out).toContain("return 'ok'")
  })

  it('★ getText() 跳过前置 JSDoc（文档承诺的起点语义）', () => {
    const out = sourceScope(FIXTURE).fn('first')
    expect(out).not.toContain(JDOC_ONLY)
    expect(out.startsWith('export function first')).toBe(true)
  })

  it('★ fn(second) 能单独取到第二个，且不含第一个的模板串', () => {
    const out = sourceScope(FIXTURE).fn('second')
    expect(out).toContain(SECOND_ONLY)
    expect(out).not.toContain('闭合符在模板串里')
  })
})

describe('source-scope：行尾无关（CRLF 与 LF 行为一致）', () => {
  it('★ 同一份源码的 LF / CRLF 两种检出，fn() 结果逐字相同', () => {
    const lf = sourceScope(FIXTURE)
    const crlf = sourceScope(toCrlf(FIXTURE))
    for (const name of ['first', 'second']) {
      const a = lf.fn(name).replace(/\r\n/g, '\n')
      const b = crlf.fn(name).replace(/\r\n/g, '\n')
      expect(b).toBe(a)
    }
  })

  it('★ CRLF 下 fn() 仍不得混入后一个函数（这正是旧写法恒假绿的那一形态）', () => {
    const out = sourceScope(toCrlf(FIXTURE)).fn('first')
    expect(out).not.toContain(SECOND_ONLY)
    expect(out).toContain("return 'ok'")
  })

  it('★ 反证：旧写法在 CRLF 下确实会切到文件尾部（锁住本文件存在的理由）', () => {
    const src = toCrlf(FIXTURE)
    const start = src.indexOf('export function first')
    const end = src.indexOf('\n}\n', start)
    // 旧写法的 `end` 恒为 -1，slice(start, -1) 会一直吃到文件末尾。
    expect(end).toBe(-1)
    expect(src.slice(start, -1)).toContain(SECOND_ONLY)
  })
})

describe('source-scope：失败要响，不要静默返回空串', () => {
  it('★ 找不到函数名时抛错（不静默返回 "" 让断言假失败）', () => {
    expect(() => sourceScope(FIXTURE).fn('nope')).toThrow(/找不到 function\/method/)
  })

  it('★ text 透传全文，供「整个文件都该有某串」这类断言使用', () => {
    expect(sourceScope(FIXTURE).text).toBe(FIXTURE)
  })
})