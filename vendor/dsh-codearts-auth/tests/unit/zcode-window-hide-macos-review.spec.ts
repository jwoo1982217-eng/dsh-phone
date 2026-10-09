/**
 * PR !54 review 提出的两处问题的回归锁。
 *
 * ## 问题①（中）：进程名兜底会**最小化用户自己的浏览器**
 *
 * `buildMacosMiniaturizeFallbackArgs()` 生成
 * `first process whose name is "Google Chrome"` —— 匹配**任意**同名进程。
 * 用户在用 Chrome 时兜底一旦触发，其真实窗口会被全部最小化。
 *
 * ⚠ 触发路径比看起来更容易：`hideWindowMacos` 以「osascript 非零退出」触发兜底，
 * 而 `stdio: 'ignore'` 丢掉了 stderr ⇒ **分不清「pid 落空」与「辅助功能未授权」**。
 * 后者（-1719）恰恰是最常见的失败原因。
 *
 * ## 问题②（低）：AppleScript 字符串未转义
 *
 * 探针实测（真实输出）：
 * ```
 * 输入: evil".do shell script "id
 * 输出: … (first process whose name is "evil".do shell script "id") to true
 *                           ↑ 字面量被撑开
 * ```
 *
 * ## 修法：两条一起消掉 —— 删掉整个进程名兜底
 *
 * macOS 藏窗**只按 pid 匹配**。pid 落空就不做 ⇒ 窗口短暂可见（= 修复前行为），
 * 绝不冒「最小化用户真实浏览器」的风险。连带地，**不再有任何字符串插值进
 * AppleScript**，问题②随之一并消失（无插值 ⇒ 无注入面）。
 *
 * 代价要说清：Chrome re-exec 换 pid 时最小化会失效。但那是「少一个优化」，
 * 不是功能回退 —— 修复前的行为本来就是窗口可见。
 */
import { describe, expect, it } from 'vitest'
import * as captcha from '../../src/zcode-captcha.js'

describe('ZCode 窗口隐藏 · macOS（PR !54 review 修正）', () => {
  it('★ 不得再导出按进程名匹配的构造器（问题①的契约锁）', () => {
    expect(Object.keys(captcha)).not.toContain('buildMacosMiniaturizeFallbackArgs')
  })

  it('★ 无论传入什么宿主名，产出的 AppleScript 里都不出现 name is（问题②）', () => {
    // pid 路径的数字插值是唯一允许的插值；名字插值必须彻底不存在。
    // ⚠ 刻意不含空串：`expect(s).not.toContain('')` 对任何 s 都为假，测不出东西。
    for (const hostile of [
      'Google Chrome',
      'evil".do shell script "id',
      'back\\slash',
      '"',
    ]) {
      const script = (captcha as unknown as {
        buildMacosMiniaturizeFallbackArgs?: (n: string) => string[]
      }).buildMacosMiniaturizeFallbackArgs?.(hostile)?.[1] ?? ''
      expect(script).not.toContain('name is')
      expect(script).not.toContain(hostile)
    }
  })

  it('★ pid 路径的脚本里只有 unix id，匹配不到就什么都不做', () => {
    const args = captcha.buildMacosMiniaturizeArgs(4242)
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain('first process whose unix id is 4242')
    expect(args[1]).not.toContain('whose name is')
  })

  it('★ pid 是唯一插值，且为整数时不含任何引号/反斜杠', () => {
    for (const pid of [0, 1, 4242, 2147483647]) {
      const script = captcha.buildMacosMiniaturizeArgs(pid)[1] ?? ''
      expect(script).toContain(`unix id is ${pid}`)
      // 除 System Events 自身的成对引号外不应出现引号
      expect(script.match(/"/g)?.length ?? 0).toBe(2)
      expect(script).not.toContain('\\')
    }
  })
})