/**
 * Raccoon 探针的凭据读取工具。
 *
 * 复用 `workbuddy-credential.ts` 里已经过实测的 YAML 解析（折行还原、
 * 引号转义、双引号硬续行的奇偶性判定）—— 那套逻辑处理的是 **DSH 的 YAML
 * writer 行为**，与 provider 无关，重写一遍只会引入新的偏差。
 *
 * 本模块只做三件事：
 * 1. 从 `.credentials.yaml` 里找出全部 `RACCOON_ACCOUNT_*` ref；
 * 2. 逐个解析成 `RaccoonCredential`；
 * 3. 返回 `{uid, ref, credential}` 列表，供探针遍历多账号。
 *
 * ⚠️ 这里读的是**本插件的凭据存储**（`ctx.credentials` 落盘的 YAML），
 * **不是**商汤客户端的数据（`%APPDATA%\office-raccoon` 或
 * `~/.box-agent/config/auth.json`）。那是本 provider 的硬约束：
 * 运行时零客户端依赖，见 `tests/unit/raccoon-client-independence.spec.ts`。
 */

import {
  CREDENTIALS_PATH,
  extractYamlScalar,
  readCredentialsFile,
} from './workbuddy-credential.js'
import type { RaccoonCredential } from '../../src/raccoon.js'

/** ref 匹配模式：Jet Hub 多账号登录生成的 `RACCOON_ACCOUNT_XXXXXXXX`。 */
const RACCOON_ACCOUNT_REF = /^[ \t]*(RACCOON_ACCOUNT_[A-Z0-9]+):/gm
/** 单账号回退 ref（无账号池时的默认入口）。 */
const RACCOON_DEFAULT_REF = 'RACCOON_ACCESS_TOKEN'

/** 一条可用的 Raccoon 凭据。 */
export interface RaccoonCredentialEntry {
  /** 账号标识（优先取昵称/用户 id，缺失时用 ref 名兜底）。 */
  uid: string
  /** 凭据在存储中的 ref 名。 */
  ref: string
  credential: RaccoonCredential
}

/** `readRaccoonCredentialsFromDshStore` 的可选覆盖项。 */
export interface ReadOptions {
  /** 指定 ref；缺省读取全部 `RACCOON_ACCOUNT_*`（无则回退默认 ref）。 */
  ref?: string
  /** 覆盖凭据文件路径。 */
  path?: string
}

/** 把 JSON 文本解析为 Raccoon 凭据；结构不符时给出带来源的清晰错误。 */
function parseRaccoonCredentialJson(raw: string, source: string): RaccoonCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} 应为 JSON 对象`)
  }
  const credential = parsed as Partial<RaccoonCredential>
  if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
    throw new Error(`${source} 缺少非空的 access_token 字段`)
  }
  return credential as RaccoonCredential
}

/**
 * 从 DSH 凭据存储读取 Raccoon 凭据。
 *
 * 优先级：`DSH_RACCOON_CREDENTIAL_JSON`（直接给 JSON）→
 * `DSH_RACCOON_ACCOUNT_REF`（指定 ref）→ 文件里全部 `RACCOON_ACCOUNT_*`
 * → 默认 ref `RACCOON_ACCESS_TOKEN`。
 *
 * 单个账号解析失败**不让整批失败**：跳过并继续（探针的目的是尽可能多地
 * 验证账号，一个损坏条目不该挡住其余账号的诊断信息）。
 */
export function readRaccoonCredentialsFromDshStore(options: ReadOptions = {}): RaccoonCredentialEntry[] {
  const fromEnv = process.env.DSH_RACCOON_CREDENTIAL_JSON
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const credential = parseRaccoonCredentialJson(fromEnv, 'DSH_RACCOON_CREDENTIAL_JSON')
    return [{ uid: credential.nickname ?? 'env', ref: 'DSH_RACCOON_CREDENTIAL_JSON', credential }]
  }

  let text: string
  try {
    text = readCredentialsFile(options.path ?? CREDENTIALS_PATH)
  } catch {
    // 凭据文件不存在：返回空列表，让 spec 的「至少一个账号」断言给出可操作提示，
    // 而不是在这里抛一个与用户操作无关的 ENOENT。
    return []
  }

  const declared = [...text.matchAll(RACCOON_ACCOUNT_REF)].map((m) => m[1]!)
  const refs = options.ref !== undefined
    ? [options.ref]
    : (process.env.DSH_RACCOON_ACCOUNT_REF ?? (declared.length > 0 ? declared : [RACCOON_DEFAULT_REF]))

  const entries: RaccoonCredentialEntry[] = []
  for (const ref of refs) {
    try {
      const credential = parseRaccoonCredentialJson(extractYamlScalar(text, ref), `凭据 ${ref}`)
      entries.push({ uid: credential.nickname ?? credential.user_id ?? ref, ref, credential })
    } catch {
      // 单账号损坏不应中断整批（见函数注释）。
      continue
    }
  }
  return entries
}
