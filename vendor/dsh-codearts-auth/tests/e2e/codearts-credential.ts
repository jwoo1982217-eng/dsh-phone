/**
 * CodeArts 积分探针的凭据读取工具。
 *
 * 复用 `workbuddy-credential.ts` 里已经过实测的 YAML 解析（折行还原、
 * 引号转义、双引号硬续行的奇偶性判定）—— 那套逻辑处理的是 **DSH 的 YAML
 * writer 行为**，与 provider 无关，重写一遍只会引入新的偏差。
 *
 * ⚠️ 与 LobsterAI 的凭据读取有一个**关键差异**：CodeArts 的 refresh_token
 * 是**一次性轮换**的（用一次即作废，服务端回 `STS5.1806 the refresh token
 * has been used`）。因此本模块**只读凭据、绝不刷新** —— 探针需要有效凭据时
 * 应由 Jet Hub 的正常续期流程（每 30 分钟一次）保持其新鲜，而不是在这里
 * 消耗掉它。这个坑在实现本功能时已经真实踩过一次。
 */

import {
  CREDENTIALS_PATH,
  extractYamlScalar,
  readCredentialsFile,
} from './workbuddy-credential.js'
import type { CodeArtsCredential } from '../../src/types.js'

/** ref 匹配模式：Jet Hub 多账号登录生成的 `CODEARTS_ACCOUNT_XXXXXXXX`。 */
const CODEARTS_ACCOUNT_REF = /^[ \t]*(CODEARTS_ACCOUNT_[A-Z0-9]+):/gm
/** 单账号回退 ref（无账号池时的默认入口）。 */
const CODEARTS_DEFAULT_REF = 'CODEARTS_ACCESS_TOKEN'

/** 一条可用的 CodeArts 凭据。 */
export interface CodeArtsCredentialEntry {
  /** 账号标识（优先取凭据内 user_name，缺失时用 ref 名兜底）。 */
  uid: string
  /** 凭据在存储中的 ref 名。 */
  ref: string
  credential: CodeArtsCredential
}

/** `readCodeArtsCredentialsFromDshStore` 的可选覆盖项。 */
export interface ReadOptions {
  /** 指定 ref；缺省读取全部 `CODEARTS_ACCOUNT_*`（无则回退默认 ref）。 */
  ref?: string
  /** 覆盖凭据文件路径。 */
  path?: string
}

/** 把 JSON 文本解析为 CodeArts 凭据；结构不符时给出带来源的清晰错误。 */
function parseCodeArtsCredentialJson(raw: string, source: string): CodeArtsCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} 应为 JSON 对象`)
  }
  const credential = parsed as Partial<CodeArtsCredential>
  // AK/SK 是签名请求的必需材料；缺任何一个都无法发请求。
  if (typeof credential.access_key_id !== 'string' || credential.access_key_id.length === 0) {
    throw new Error(`${source} 缺少非空的 access_key_id 字段`)
  }
  if (typeof credential.secret_access_key !== 'string' || credential.secret_access_key.length === 0) {
    throw new Error(`${source} 缺少非空的 secret_access_key 字段`)
  }
  return credential as CodeArtsCredential
}

/**
 * 从 DSH 凭据存储读取 CodeArts 凭据（**只读，不刷新**）。
 *
 * 优先级：`DSH_CODEARTS_CREDENTIAL_JSON`（直接给 JSON）→
 * `DSH_CODEARTS_ACCOUNT_REF`（指定 ref）→ 文件里全部 `CODEARTS_ACCOUNT_*`
 * → 默认 ref `CODEARTS_ACCESS_TOKEN`。
 *
 * 单个账号解析失败**不让整批失败**：跳过并继续（探针的目的是尽可能多地
 * 验证账号，一个损坏条目不该挡住其余账号的诊断信息）。
 */
export function readCodeArtsCredentialsFromDshStore(options: ReadOptions = {}): CodeArtsCredentialEntry[] {
  const fromEnv = process.env.DSH_CODEARTS_CREDENTIAL_JSON
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const credential = parseCodeArtsCredentialJson(fromEnv, 'DSH_CODEARTS_CREDENTIAL_JSON')
    return [{ uid: credential.user_name ?? 'env', ref: 'DSH_CODEARTS_CREDENTIAL_JSON', credential }]
  }

  let text: string
  try {
    text = readCredentialsFile(options.path ?? CREDENTIALS_PATH)
  } catch {
    // 凭据文件不存在：返回空列表，让 spec 的「至少一个账号」断言给出可操作提示，
    // 而不是在这里抛一个与用户操作无关的 ENOENT。
    return []
  }

  const declared = [...text.matchAll(CODEARTS_ACCOUNT_REF)].map((m) => m[1])
  const refs = options.ref !== undefined
    ? [options.ref]
    : (process.env.DSH_CODEARTS_ACCOUNT_REF ?? (declared.length > 0 ? declared : [CODEARTS_DEFAULT_REF]))

  const entries: CodeArtsCredentialEntry[] = []
  for (const ref of refs) {
    try {
      const credential = parseCodeArtsCredentialJson(extractYamlScalar(text, ref), `凭据 ${ref}`)
      entries.push({ uid: credential.user_name ?? ref, ref, credential })
    } catch {
      // 单账号损坏不应中断整批（见函数注释）。
      continue
    }
  }
  return entries
}

/** 凭据的过期时间戳（毫秒）；无法解析时返回 undefined。 */
export function codeArtsCredentialExpiresAtMs(credential: CodeArtsCredential): number | undefined {
  if (typeof credential.expires_at !== 'string' || credential.expires_at.length === 0) return undefined
  const parsed = Date.parse(credential.expires_at)
  return Number.isNaN(parsed) ? undefined : parsed
}
