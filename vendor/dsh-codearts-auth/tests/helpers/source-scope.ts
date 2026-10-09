/**
 * 源码契约测试的公共助手：按 **AST 节点**取函数 / 类方法的源码。
 *
 * ## ⚠ 为什么不能用「找下一个列 0（或某缩进）的 `}`」这类字符串切片
 *
 * 本仓库踩过两次同型缺陷（Gitee issue IKJMG1），两个方向都会错：
 *
 * | 行尾 | `indexOf('\n}\n', start)` | 后果 |
 * |---|---|---|
 * | **CRLF**（`core.autocrlf=true` 检出，Windows 默认） | **永远匹配不到**，返回 `-1` | `slice(start, -1)` 吐出**整个文件尾部** ⇒ 断言全绿，但**分不清命中的是不是这个函数**；别的函数里出现同名字符串就能让完全正确的实现误红 |
 * | **LF**（`autocrlf=false` / Linux / macOS 检出） | 命中**函数体内**第一个列 0 的 `}` | 截到一小截 ⇒ 源码契约用例**假失败**（`hideWindowWindows` 内联 C# 的类体闭合括号正好落在列 0） |
 *
 * ⇒ 交给 TypeScript 解析器（已是 devDependency，`tsc` 也在用它）：按声明节点
 * 取 `getText()`，深度、模板串、注释、**正则字面量**都不可能骗过它，
 * 且结果与行尾无关 —— LF / CRLF 检出行为完全一致。
 *
 * ⚠ 注意 `getText()` 从 `getStart()` 起（**跳过**前置 JSDoc），起点与
 * 旧的 `indexOf('function NAME')` 一致，故「函数体里引用了 JSDoc 才提到的
 * 词」这类断言仍会失败 —— 那是**应有**的行为，别靠把注释包进来绕开。
 */
import ts from 'typescript'

export interface SourceScope {
  /** 文件全文 —— 给「整个文件都该有某串」这类断言用。 */
  readonly text: string
  /**
   * 取某个具名函数或类方法的源码 —— **恰好是它自己**。
   *
   * 同名声明**必须唯一**：按源码出现顺序取第一个（与旧的 `indexOf` 语义一致）。
   * 找不到会抛错，而不是静默返回空串。
   */
  fn(name: string): string
}

/**
 * 把一份源码文本包成 {@link SourceScope}。
 *
 * @param text 源码全文（由调用方自己 `readFileSync`，各 spec 的相对路径不同）
 * @param fileName 仅用于报错信息
 */
export function sourceScope(text: string, fileName = 'source.ts'): SourceScope {
  /** 懒解析一次并缓存 —— 同一个 spec 里通常要取好几个函数。 */
  let parsed: ts.SourceFile | undefined
  const sf = (): ts.SourceFile =>
    (parsed ??= ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true))

  const find = (name: string): ts.Node | undefined => {
    let hit: ts.Node | undefined
    const visit = (node: ts.Node): void => {
      if (hit !== undefined) return
      const named = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      if (named && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name) {
        hit = node
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(sf())
    return hit
  }

  return {
    text,
    fn(name: string): string {
      const node = find(name)
      if (node === undefined) {
        throw new Error(
          `${fileName} 里找不到 function/method \`${name}\` —— ` +
          '它可能被改名/删除了，或同名声明不止一处（此时按出现顺序取第一个）',
        )
      }
      const out = node.getText(sf())
      // 轻量归属自检：解析器已保证边界精确，这里只挡「取到明显不是它」的低级错误。
      if (!out.includes(name)) {
        throw new Error(`切出来的不是 \`${name}\`：${JSON.stringify(out.slice(0, 80))}`)
      }
      return out
    },
  }
}
