/**
 * 从源码里取 `registerJetHubRpc` 的 **auths 命名对象**（调用点）与
 * **`JetHubAuths` 接口**（类型声明）的键集合。
 *
 * ## ⚠ 为什么必须按 AST 取，不能用正则（复审 Finding 2）
 *
 * `registerJetHubRpc` 的 13 个 auth 实例从**位置参数**改成**命名对象**之后，
 * **键与键之间的相邻关系没有任何语义**：对象字面量可以任意重排、可以在中间
 * 插入新键，行为逐字节不变。
 *
 * 于是 `/\bminimax,\s*zcode,\s*gemini,/` 这类**相邻性正则**守错了东西：
 * - 把 `… zcode, gemini, minimax,` 重排（语义等价）⇒ **假失败**；
 * - 在两者之间插入任何一个新键 ⇒ **假失败**；
 * - 而它真正想守的「`minimax` 键在 auths 对象里」**与顺序无关**。
 *
 * ⇒ 本助手按 TypeScript AST 取**调用点第三个实参**（对象字面量）的属性名：
 * 重排、插键、换行、注释都不可能影响结果，而「键漏了」必然变红。
 *
 * ⚠ 取**调用点**而不是只取接口：接口（`JetHubAuths`）在运行时**没有表示**
 *（类型被擦除），而调用点是运行时真正传进去的那个对象 —— 键名即语义。
 * 接口一侧由 {@link jetHubAuthsInterfaceKeys} 负责，两者交叉验证
 *（见 `tests/unit/zcode-wiring.spec.ts`）。
 */
import ts from 'typescript'

/** 取属性名（标识符 / 字符串字面量 / 数字字面量都归一成字符串）。 */
function propertyNameOf(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  // 计算属性名（`[x]: y`）在本项目里不存在；出现即说明写法变了，报错比静默漏键好。
  throw new Error(`不支持的属性名形态：${name.getText()}`)
}

/**
 * 取 `registerJetHubRpc(ctx, pool, { … }, …)` **第三个实参**的
 * 键 → 值源码文本（简写属性 `buddy,` 的值文本即键名本身）。
 *
 * ⚠ 找不到该调用 / 第三个实参不是对象字面量时**抛错**，不静默返回空表 ——
 * 否则所有 `toHaveProperty` 断言会退化成「表是空的」这种误导性失败。
 */
export function jetHubAuthsCallKeys(
  source: string,
  fileName = 'index.ts',
): Record<string, string> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true)
  let found: Record<string, string> | undefined

  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'registerJetHubRpc'
    ) {
      const authsArg = node.arguments[2]
      if (authsArg === undefined || !ts.isObjectLiteralExpression(authsArg)) {
        throw new Error(
          `${fileName} 里 registerJetHubRpc 的第三个实参不是对象字面量` +
          `（auths 命名对象形态变了？）：${authsArg?.getText(sf) ?? '<缺失>'}`,
        )
      }
      const out: Record<string, string> = {}
      for (const property of authsArg.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          // `buddy,` —— 键与值同名。
          out[propertyNameOf(property.name)] = propertyNameOf(property.name)
          continue
        }
        if (ts.isPropertyAssignment(property)) {
          // `qodercn: qoderCn,` —— 键是 provider id、值是变量名，两者不同名是刻意的。
          out[propertyNameOf(property.name)] = property.initializer.getText(sf)
          continue
        }
        // 展开（`...x`）等方法/访问器在本调用点都不存在：出现即报错，
        // 免得「键集合」在无人察觉时少掉一批。
        throw new Error(
          `${fileName} 里 registerJetHubRpc 的 auths 对象含不支持的成员形态：` +
          property.getText(sf),
        )
      }
      found = out
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  if (found === undefined) {
    throw new Error(`${fileName} 里找不到 registerJetHubRpc 调用点`)
  }
  return found
}

/**
 * 取 `export interface JetHubAuths { … }` 的**成员键**（按声明顺序）。
 *
 * ⚠ 接口是**类型层的独立权威**：它没有运行时表示，故源码文本是唯一可读形态。
 * 它守的是「13 个键都真的声明在接口上」—— 若删掉这条断言、改为从
 * `PROVIDER_REGISTRY` 派生键集合，就变成「registry 与自己对比」的**同义反复**
 *（客户端 id 集合本身已由 registry 派生）。
 */
export function jetHubAuthsInterfaceKeys(
  source: string,
  fileName = 'jet-hub-rpc.ts',
): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true)
  let found: string[] | undefined

  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (
      ts.isInterfaceDeclaration(node)
      && node.name.text === 'JetHubAuths'
    ) {
      found = node.members.map((member) => {
        if (!ts.isPropertySignature(member) || member.name === undefined) {
          throw new Error(
            `${fileName} 的 JetHubAuths 含非属性成员（只允许 readonly <key>: <Type>）：` +
            member.getText(sf),
          )
        }
        return propertyNameOf(member.name)
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  if (found === undefined) {
    throw new Error(`${fileName} 里找不到 interface JetHubAuths`)
  }
  return found
}
