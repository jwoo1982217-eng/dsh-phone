/**
 * Qoder 探针的凭据读取工具。
 *
 * 复用 `workbuddy-credential.ts` 里已经过实测的 YAML 解析（折行还原、
 * 引号转义、双引号硬续行的奇偶性判定）—— 那套逻辑处理的是 **DSH 的 YAML
 * writer 行为**，与 provider 无关，重写一遍只会引入新的偏差。
 *
 * 本模块只做三件事：
 * 1. 从 `.credentials.yaml` 里找出全部 `QODER_ACCOUNT_*` ref；
 * 2. 逐个解析成 `QoderCredential`；
 * 3. 返回 `{uid, ref, credential}` 列表，供探针遍历多账号。
 */

import {
  CREDENTIALS_PATH,
  extractYamlScalar,
  readCredentialsFile,
} from './workbuddy-credential.js'
import type { QoderCredential } from '../../src/qoder.js'

/**
 * 账号 ref 前缀。
 *
 * ⚠️ 默认 `QODER`（国际版）：派生出的三类名字必须与参数化之前**逐字节相同**
 * （`QODER_ACCOUNT_*` / `QODER_ACCESS_TOKEN` / `DSH_QODER_*`），
 * 否则本改动会静默改掉国际版全部 e2e 探针的凭据来源。
 */
const DEFAULT_REF_PREFIX = 'QODER'

/**
 * 按前缀构造账号 ref 的匹配式。
 *
 * ⚠️ 前缀**不能**直接插进正则字面量（那是模块级常量时的写法），
 * 因为 `QODER` 与 `QODERCN` 有前缀包含关系 —— 用 `QODER` 匹配时
 * 必须确保不会把 `QODERCN_ACCOUNT_X` 一起捞走。这里靠 `_ACCOUNT_`
 * 这个分隔段天然区分开（`QODERCN_ACCOUNT_` 不含 `QODER_ACCOUNT_`），
 * 单测 `qodercn 与 qoder 的 ref 不互相串` 锁住这一点。
 */
function accountRefPattern(prefix: string): RegExp {
  return new RegExp(`^[ \\t]*(${prefix}_ACCOUNT_[A-Z0-9]+):`, 'gm')
}

/** 一条可用的 Qoder 凭据。 */
export interface QoderCredentialEntry {
  /** 账号标识（优先取凭据内 nickname，缺失时用 ref 名兜底）。 */
  uid: string
  /** 凭据在存储中的 ref 名。 */
  ref: string
  credential: QoderCredential
}

/** `readQoderCredentialsFromDshStore` 的可选覆盖项。 */
export interface ReadOptions {
  /** 指定 ref；缺省读取全部 `<prefix>_ACCOUNT_*`（无则回退默认 ref）。 */
  ref?: string
  /** 覆盖凭据文件路径。 */
  path?: string
  /**
   * ref 前缀；默认 `QODER`（国际版），中国版传 `QODERCN`。
   *
   * 同时决定两个环境变量名（`DSH_<prefix>_CREDENTIAL_JSON`、
   * `DSH_<prefix>_ACCOUNT_REF`）与回退 ref（`<prefix>_ACCESS_TOKEN`）。
   */
  refPrefix?: string
}

/** 把 JSON 文本解析为 Qoder 凭据；结构不符时给出带来源的清晰错误。 */
function parseQoderCredentialJson(raw: string, source: string): QoderCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} 应为 JSON 对象`)
  }
  const credential = parsed as Partial<QoderCredential>
  if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
    throw new Error(`${source} 缺少非空的 access_token 字段`)
  }
  return credential as QoderCredential
}

/**
 * 从 DSH 凭据存储读取 Qoder 系凭据（国际版与中国版共用一套实现）。
 *
 * 优先级：`DSH_<refPrefix>_CREDENTIAL_JSON`（直接给 JSON）→
 * `DSH_<refPrefix>_ACCOUNT_REF`（指定 ref）→ 文件里全部 `<prefix>_ACCOUNT_*`
 * → 默认 ref `<prefix>_ACCESS_TOKEN`。
 *
 * 中国版传 `refPrefix: 'QODERCN'`（ref 前缀与两个环境变量名随之切换）。
 *
 * 单个账号解析失败**不让整批失败**：跳过并继续（探针的目的是尽可能多地
 * 验证账号，一个损坏条目不该挡住其余账号的诊断信息）。
 */
export function readQoderCredentialsFromDshStore(options: ReadOptions = {}): QoderCredentialEntry[] {
  const prefix = options.refPrefix ?? DEFAULT_REF_PREFIX
  const jsonEnv = `DSH_${prefix}_CREDENTIAL_JSON`
  const refEnv = `DSH_${prefix}_ACCOUNT_REF`

  const fromEnv = process.env[jsonEnv]
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const credential = parseQoderCredentialJson(fromEnv, jsonEnv)
    return [{ uid: credential.nickname ?? 'env', ref: jsonEnv, credential }]
  }

  let text: string
  try {
    text = readCredentialsFile(options.path ?? CREDENTIALS_PATH)
  } catch {
    // 凭据文件不存在：返回空列表，让 spec 的「至少一个账号」断言给出可操作提示，
    // 而不是在这里抛一个与用户操作无关的 ENOENT。
    return []
  }

  const declared = [...text.matchAll(accountRefPattern(prefix))].map((m) => m[1])
  const refs = options.ref !== undefined
    ? [options.ref]
    : (process.env[refEnv] ?? (declared.length > 0 ? declared : [`${prefix}_ACCESS_TOKEN`]))

  const entries: QoderCredentialEntry[] = []
  for (const ref of refs) {
    try {
      const credential = parseQoderCredentialJson(extractYamlScalar(text, ref), `凭据 ${ref}`)
      entries.push({ uid: credential.nickname ?? ref, ref, credential })
    } catch {
      // 单账号损坏不应中断整批（见函数注释）。
      continue
    }
  }
  return entries
}
