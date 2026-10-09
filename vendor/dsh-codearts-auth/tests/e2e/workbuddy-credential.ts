/**
 * WorkBuddy 探针的凭据读取工具。
 *
 * 单独成模块（而非内联在 spec 里）的原因：这段解析逻辑需要被一次性验证脚本
 * 直接调用，而 spec 文件在顶层就会执行 vitest 的 `describe`。
 *
 * ## 为什么不用 `yaml` 库
 *
 * `yaml` 只在 DSH 自身的 profile 目录里（`~/.dsh/profiles/web/node_modules/yaml`），
 * 本项目既未声明该依赖、项目内及其所有上层目录也都没有它，`import 'yaml'` 在
 * e2e 运行时抛 ERR_MODULE_NOT_FOUND（已实测）。因此这里按 YAML 规范自行还原。
 *
 * ## 为什么要还原折行
 *
 * DSH 的 YAML writer 会把超长标量折行 —— 在 JSON 字符串**内部**插入真实的
 * 换行 + 缩进。按 YAML 规范，流式标量中的折行语义上等价于**一个空格**，
 * 所以把续行按空格拼回即可还原 writer 写入前的原文。
 *
 * 旧实现用逐字符花括号配对直接切 JSON 切片，会把折行换行当成字符串正文，
 * 于是 `JSON.parse` 抛裸 `SyntaxError: Bad control character in string literal`。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BuddyCredential } from '../../src/buddy.js'

/** 凭据文件路径（DSH 默认位置）。 */
export const CREDENTIALS_PATH = join(homedir(), '.dsh', '.credentials.yaml')

/** 凭据不可用时的统一提示后缀。 */
const HINT = '请先登录该账号，或设置 DSH_WORKBUDDY_CREDENTIAL_JSON'

/** 取出错误消息（抛出物可能是任意值）。 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读取凭据文件；文件不存在时给出清晰中文提示，而不是裸 ENOENT。 */
export function readCredentialsFile(path: string = CREDENTIALS_PATH): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`未找到凭据文件 ${path}（${reason(error)}）；${HINT}`)
  }
}

/** 还原 YAML 引号标量的定界引号与转义。 */
function unfoldQuotes(raw: string, ref: string): string {
  if (raw.startsWith("'")) {
    // 单引号标量：内容里的单引号写作 ''，定界引号是首尾各一个
    const closed = raw.length > 1 && raw.endsWith("'")
    const inner = closed ? raw.slice(1, -1) : raw.slice(1)
    return inner.replace(/''/g, "'")
  }
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) {
    // 双引号标量的转义与 JSON 兼容；此处失败说明格式异常，给出带 ref 名的提示
    try {
      return JSON.parse(raw) as string
    } catch (error) {
      throw new Error(`凭据 ${ref} 的 YAML 双引号标量无法解码：${reason(error)}`)
    }
  }
  return raw
}

/**
 * 从 `.credentials.yaml` 文本里取出 `ref` 对应的标量原文。
 *
 * 折行还原规则分两种形态：
 *
 * - **单引号 / 普通标量**：`换行 + 缩进` 在 YAML 流式标量中等价于**一个空格**，
 *   续行按空格拼接。
 * - **双引号标量 + 行尾 `\` 硬续行**：当正文含撇号 `'`（writer 会避开单引号形态）
 *   或控制字符（NEL `\u0085` 等，强制双引号）且超长折行时，writer 改用双引号
 *   形态并在折行处追加行尾 `\`；`\` 表示**删除换行、不插空格**，故须去掉反斜杠
 *   后直接拼接。已用 `yaml@2.9.1` 的真实 writer 输出实测交叉验证。
 *
 * 形态守卫的理由：单引号 / 普通标量的行尾反斜杠只是正文内容（`FOLD_FLOW` 只在
 * 空格处折行，不会插入续行标记），若也按硬续行处理会吞掉正文并漏掉空格。
 */
export function extractYamlScalar(text: string, ref: string): string {
  const lines = text.split(/\r?\n/)
  // ref 虽然约定为 POSIX 标识符，仍转义以防调用方传入带正则元字符的名字
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^(\\s*)${escaped}:[ \\t]*(.*)$`)
  for (let index = 0; index < lines.length; index++) {
    const match = pattern.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const doubleQuoted = match[2].trimStart().startsWith('"')
    let scalar = match[2].trimEnd()
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next]
      // 折行不会产生空行；跳过空行以免拼出连续空格
      if (line.trim().length === 0) continue
      // 缩进回到键的层级，说明该标量已结束
      if (line.length - line.trimStart().length <= indent) break
      const piece = line.trim()
      // 仅双引号标量的行尾反斜杠可能是 writer 插入的硬续行标记。判据是末尾连续
      // 反斜杠的**奇偶性**：双引号标量里正文的每个字面反斜杠都转义为 `\\`（偶数），
      // writer 只在此基础上再追加一个续行标记，故奇数个即硬续行 —— 去掉一个反斜杠后
      // 直接拼接（删除换行、不插空格）；偶数个是正文自身的转义反斜杠，在空格处正常
      // 折行，须按空格拼接。单引号 / 普通标量绝不插续行标记，行尾反斜杠只是正文内容。
      const trailing = /\\+$/.exec(scalar)?.[0].length ?? 0
      scalar = doubleQuoted && trailing % 2 === 1 ? scalar.slice(0, -1) + piece : `${scalar} ${piece}`
    }
    return unfoldQuotes(scalar.trim(), ref)
  }
  throw new Error(`未找到凭据 ${ref}；${HINT}`)
}

/** 解析 JSON 形式的凭据；失败时给出带来源名的清晰错误，不抛裸 SyntaxError。 */
export function parseCredentialJson(raw: string, source: string): BuddyCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${reason(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} 应为 JSON 对象`)
  }
  const credential = parsed as Partial<BuddyCredential>
  if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
    throw new Error(`${source} 缺少非空的 access_token 字段`)
  }
  return credential as BuddyCredential
}

/** `loadWorkBuddyCredential` 的可选覆盖项（便于一次性验证脚本注入固定输入）。 */
export interface LoadOptions {
  /** 直接提供凭据 JSON（优先级最高）。 */
  env?: string
  /** 指定要读取的 ref；缺省取文件里首个 `WORKBUDDY_ACCOUNT_*`。 */
  ref?: string
  /** 覆盖凭据文件路径。 */
  path?: string
}

/** 读取凭据：优先环境变量，其次本地 credentials.yaml 中的 WorkBuddy 账号。 */
export function loadWorkBuddyCredential(options: LoadOptions = {}): BuddyCredential {
  const fromEnv = options.env ?? process.env.DSH_WORKBUDDY_CREDENTIAL_JSON
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return parseCredentialJson(fromEnv, 'DSH_WORKBUDDY_CREDENTIAL_JSON')
  }

  const text = readCredentialsFile(options.path)
  const declared = [...text.matchAll(/^[ \t]*(WORKBUDDY_ACCOUNT_[A-Z0-9]+):/gm)].map((m) => m[1])
  if (declared.length === 0) {
    throw new Error(`未找到 WORKBUDDY_ACCOUNT_* 凭据；${HINT}`)
  }
  const ref = options.ref ?? process.env.DSH_WORKBUDDY_ACCOUNT_REF ?? declared[0]
  return parseCredentialJson(extractYamlScalar(text, ref), `凭据 ${ref}`)
}
