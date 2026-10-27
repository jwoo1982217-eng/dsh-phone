/**
 * 剥掉注释 —— **接线类源码断言的共用前置**。
 *
 * ## ⚠️ 为什么这是「断言的前置」而不是可选的清理
 *
 * 本仓库反复记录过的同一族假绿：`if (false)` 这类**短路禁用**对源码文本断言
 * 完全无感 —— 字面量在死分支里、在注释里都照样能被正则命中。IKLTZ2 的两次
 * 独立审计实测到两种形态：
 *
 * - M09：把 `fetchFor: geminiFetchForAccount,` 整行删掉、只把字面量塞进
 *   **注释** ⇒ 判据 `/fetchFor:\s*geminiFetchForAccount/` 依然全绿；
 * - M29：把 `if (method.startsWith('gemini.'))` 改成
 *   `if (globalThis.X === true && method.startsWith('gemini.'))`（**字面量完整保留
 *   在死条件里**）⇒ 只做 `indexOf` + 位置比较的判据同样全绿。
 *
 * ⇒ 任何 `toMatch` / `indexOf` 型接线断言都必须先过这个函数。
 *
 * ## ⚠️ 它**不能**替代行为用例
 *
 * 剥注释只解决「注释诱饵」，**解决不了「分支恒不执行」**（上例 M29 的死条件
 * 里没有注释）。那种形态只能用**行为**断言守（真的调一次端点，看它有没有生效）。
 * 本文件因此在每个 spec 里都保留了若干条**行为**用例，源码断言只用来守
 * 「接线点在不在」这一较弱的不变式。
 */

/** 剥掉块注释与行注释（保留字符串字面量里的 `//`，本仓库无此用法）。 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
