/**
 * LobsterAI 探针的凭据读取工具。
 *
 * 复用 `workbuddy-credential.ts` 里已经过实测的 YAML 解析（折行还原、
 * 引号转义、双引号硬续行的奇偶性判定）—— 那套逻辑处理的是 **DSH 的 YAML
 * writer 行为**，与 provider 无关，重写一遍只会引入新的偏差。
 *
 * 本模块只做三件事：
 * 1. 从 `.credentials.yaml` 里找出全部 `LOBSTERAI_ACCOUNT_*` ref；
 * 2. 逐个解析成 `LobsteraiCredential`；
 * 3. 返回 `{uid, ref, credential}` 列表，供探针遍历多账号。
 */

import {
  CREDENTIALS_PATH,
  extractYamlScalar,
  readCredentialsFile,
} from './workbuddy-credential.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

/** ref 匹配模式：Jet Hub 多账号登录生成的 `LOBSTERAI_ACCOUNT_XXXXXXXX`。 */
const LOBSTERAI_ACCOUNT_REF = /^[ \t]*(LOBSTERAI_ACCOUNT_[A-Z0-9]+):/gm
/** 单账号回退 ref（无账号池时的默认入口）。 */
const LOBSTERAI_DEFAULT_REF = 'LOBSTERAI_ACCESS_TOKEN'

/** 一条可用的 LobsterAI 凭据。 */
export interface LobsteraiCredentialEntry {
  /** 账号标识（优先取凭据内 uid，缺失时用 ref 名兜底）。 */
  uid: string
  /** 凭据在存储中的 ref 名。 */
  ref: string
  credential: LobsteraiCredential
}

/** `readLobsteraiCredentialsFromDshStore` 的可选覆盖项。 */
export interface ReadOptions {
  /** 指定 ref；缺省读取全部 `LOBSTERAI_ACCOUNT_*`（无则回退默认 ref）。 */
  ref?: string
  /** 覆盖凭据文件路径。 */
  path?: string
}

/** 把 JSON 文本解析为 LobsterAI 凭据；结构不符时给出带来源的清晰错误。 */
function parseLobsteraiCredentialJson(raw: string, source: string): LobsteraiCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} 应为 JSON 对象`)
  }
  const credential = parsed as Partial<LobsteraiCredential>
  if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
    throw new Error(`${source} 缺少非空的 access_token 字段`)
  }
  return credential as LobsteraiCredential
}

/**
 * 从 DSH 凭据存储读取 LobsterAI 凭据。
 *
 * 优先级：`DSH_LOBSTERAI_CREDENTIAL_JSON`（直接给 JSON）→
 * `DSH_LOBSTERAI_ACCOUNT_REF`（指定 ref）→ 文件里全部 `LOBSTERAI_ACCOUNT_*`
 * → 默认 ref `LOBSTERAI_ACCESS_TOKEN`。
 *
 * 单个账号解析失败**不让整批失败**：跳过并继续（探针的目的是尽可能多地
 * 验证账号，一个损坏条目不该挡住其余账号的诊断信息）。
 */
export function readLobsteraiCredentialsFromDshStore(options: ReadOptions = {}): LobsteraiCredentialEntry[] {
  const fromEnv = process.env.DSH_LOBSTERAI_CREDENTIAL_JSON
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const credential = parseLobsteraiCredentialJson(fromEnv, 'DSH_LOBSTERAI_CREDENTIAL_JSON')
    return [{ uid: credential.uid ?? 'env', ref: 'DSH_LOBSTERAI_CREDENTIAL_JSON', credential }]
  }

  let text: string
  try {
    text = readCredentialsFile(options.path ?? CREDENTIALS_PATH)
  } catch {
    // 凭据文件不存在：返回空列表，让 spec 的「至少一个账号」断言给出可操作提示，
    // 而不是在这里抛一个与用户操作无关的 ENOENT。
    return []
  }

  const declared = [...text.matchAll(LOBSTERAI_ACCOUNT_REF)].map((m) => m[1])
  const refs = options.ref !== undefined
    ? [options.ref]
    : (process.env.DSH_LOBSTERAI_ACCOUNT_REF ?? (declared.length > 0 ? declared : [LOBSTERAI_DEFAULT_REF]))

  const entries: LobsteraiCredentialEntry[] = []
  for (const ref of refs) {
    try {
      const credential = parseLobsteraiCredentialJson(extractYamlScalar(text, ref), `凭据 ${ref}`)
      entries.push({ uid: credential.uid ?? ref, ref, credential })
    } catch {
      // 单账号损坏不应中断整批（见函数注释）。
      continue
    }
  }
  return entries
}
