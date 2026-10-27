/**
 * `plugin-src/client/registration-id-check.mjs` 的类型声明。
 *
 * 构建脚本是 JS（`build.mjs` 由 node 直接跑，不经 tsc），而引用它的用例是 TS；
 * 没有这份声明，`tsc -p tsconfig.tests.json` 会对 import 报
 * 「找不到声明文件，隐式为 any」—— 那样本次修复的**唯一行为守卫**就落在类型
 * 检查之外了（2026-10 审计 F10 登记的同一个缺口）。
 */

/** 判据输入：包名 + 两个载体的源码文本。 */
export interface RegistrationIdInput {
  /** `package.json` 的 `name`（唯一权威）；类型放宽成 `unknown` 以便守卫非字符串/null。 */
  loaderId: unknown
  /** `plugin-src/client/jet-hub-styles.js` 的源码文本。 */
  stylesSource: string
  /** `cordis.patch.yml` 的源码文本。 */
  patchSource: string
}

/** 三个身份载体在仓库里的相对路径（相对包根）。 */
export declare const IDENTITY_FILES: {
  manifest: string
  styles: string
  patch: string
}

/** 读一个「行首字面量声明」的值；读不到返回 `null`。 */
export declare function declaredValue(source: string, variableName: string): string | null

/** 剥掉 YAML 的行尾注释（引号内的 `#` 是值，不是注释）。 */
export declare function stripYamlComment(line: string): string

/** 收集 `cordis.patch.yml` 里所有「加载行 `name:`」的值（已剥注释）。 */
export declare function loadLineNames(patchSource: string): string[]

/** 从最终产物文本里回读注册 id（带引号）；读不到返回 `null`。 */
export declare function readRegisteredId(bundleText: string): string | null

/** 判据本体（纯函数）：返回问题清单，空数组 = 通过。 */
export declare function checkRegistrationId(input: RegistrationIdInput): string[]

/** 从仓库里读三个载体再判一次。 */
export declare function checkRegistrationIdFromFiles(input: { rootDir: string }): string[]

/** 安装期闸门：有问题就抛 `Error`。 */
export declare function assertRegistrationIdFromFiles(input: { rootDir: string }): void