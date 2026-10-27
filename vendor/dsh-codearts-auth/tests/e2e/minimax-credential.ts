/**
 * MiniMax 探针的凭据读取工具。
 *
 * ⚠️ **读的是 MiniMax Code 客户端自己的登录态**，而**不是**本插件的凭据存储
 * —— 与其余九个 provider 的 `*-credential.ts`（读 `ctx.credentials` 落盘的
 * YAML）**刻意不同**。理由：
 *
 * 1. 本 provider 尚**未在任何机器上完成过一次插件登录**（Task 3 的登录流程
 *    只有单测覆盖），故插件凭据存储里根本没有 `MINIMAX_ACCOUNT_*` 条目；
 * 2. 客户端登录态（`~/.minimax/auth/...`）是**现成可用**的真实凭据，
 *    用它验证「模型目录 / 签到 / 余额」三条只读链路最直接。
 *
 * ⚠️ **本模块绝不写入该文件**（只读打开），也**绝不打日志打印 token 值**。
 *
 * ⚠️⚠️ **一个刻意的安全取舍：过期的 token 不做刷新。**
 *
 * MiniMax 的 refresh 走 `grant_type=refresh_token`。客户端实现
 * （`.minimax-forensics/oauth-core/oauth-client.js` 的 `refreshToken()`）
 * 调 `parseTokenGrant(body, refreshToken)` —— 把**旧 refresh_token 作为回退**，
 * 说明服务端**可能不下发新 refresh_token**（那沿用旧的）。但它**没有排除**
 * 「服务端轮换 refresh_token」的可能。
 *
 * 若真轮换而我们在这里刷一次**却不把新值写回**客户端文件，用户的
 * MiniMax Code 登录态就会**被我们弄坏**（旧 refresh_token 失效 ⇒
 * 客户端下次续期失败 ⇒ 必须重新登录）。这个代价远大于「探针跑不起来」。
 *
 * ⇒ 故：token 过期时**直接给出可操作的指引**，让用户去客户端登录一次
 *（客户端自己续期/重登，凭据文件随之更新），而不是由探针代劳。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MinimaxCredential } from '../../src/minimax.js'
import {
  CREDENTIALS_PATH,
  extractYamlScalar,
  readCredentialsFile,
} from './workbuddy-credential.js'

/** 客户端登录态路径（Windows / macOS / Linux 同构，均在 home 下）。 */
export function minimaxClientAuthPath(): string {
  return join(homedir(), '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json')
}

/** 客户端 auth.json 里的一条 OAuth 记录。 */
interface MinimaxClientAuthRecord {
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  expiresAtMs?: number
}

/** 读取结果：凭据 + 是否已过期（过期时由调用方决定跳过还是提示）。 */
export interface MinimaxProbeCredential {
  credential: MinimaxCredential
  /** token 是否已过期（`expiresAtMs` 缺失时视为**未知**，按已过期处理）。 */
  expired: boolean
  /** 供日志使用的可读状态（**不含 token**）。 */
  describe: string
}

/**
 * 读本机 MiniMax Code 的 OAuth 登录态（**只读、不落盘、不打印 token**）。
 *
 * 抛错时给出可操作指引（不是一句「读不到」）。
 */
export function readMinimaxProbeCredential(): MinimaxProbeCredential {
  const path = minimaxClientAuthPath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `未找到 MiniMax Code 登录态：${path}\n`
      + '请先在 MiniMax Code 客户端登录一次（本探针只读该文件，绝不代它续期/写入）。',
    )
  }

  const store = JSON.parse(raw) as { records?: Record<string, MinimaxClientAuthRecord> }
  const records = store.records ?? {}
  // ⚠️ 记录键形如 `com.minimax.mcode.oauth.prod.cn\0<指纹>`，同一时刻通常只有一条；
  // 取**最后一个**（客户端按序写入，后者更新）。
  const values = Object.values(records)
  const record = values[values.length - 1]
  if (record === undefined) throw new Error(`MiniMax 登录态里没有任何记录：${path}`)

  const accessToken = record.accessToken
  const refreshToken = record.refreshToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('MiniMax 登录态缺少 accessToken，请在客户端重新登录。')
  }

  const expiresAtMs = typeof record.expiresAtMs === 'number' ? record.expiresAtMs : undefined
  const expired = expiresAtMs === undefined || expiresAtMs <= Date.now()
  const remainingMin = expiresAtMs === undefined
    ? undefined
    : Math.round((expiresAtMs - Date.now()) / 60_000)

  return {
    credential: {
      access_token: accessToken,
      ...typeof refreshToken === 'string' && refreshToken.length > 0 ? { refresh_token: refreshToken } : {},
      token_type: typeof record.tokenType === 'string' ? record.tokenType : 'Bearer',
      // ⚠️ 上游存的是**毫秒数字**，本插件的 `expires_at` 约定是**毫秒时间戳字符串**
      // （见 Global Constraints 与 `minimaxCredentialExpiresAtMs`）。
      ...expiresAtMs === undefined ? {} : { expires_at: String(expiresAtMs) },
    },
    expired,
    describe: expired
      ? `已过期（${expiresAtMs === undefined ? '未记录到期时间' : `${-remainingMin!} 分钟前`}）`
      : `有效（剩余约 ${remainingMin} 分钟）`,
  }
}

// ── 下面这一段读的是**插件自己的**凭据存储（供国际站探针用） ──────────────
//
// ⚠️ 与上面 `readMinimaxProbeCredential`（读客户端登录态）**刻意分开**：
//
// - **中国版**探针读客户端登录态：那是本机现成可用的真实凭据，而该 provider
//   早期「尚未在任何机器上完成过插件登录」；
// - **国际版**探针没有客户端可读（本机未装国际站客户端）⇒ 只能读**插件自己**
//   的凭据（先在 Jet Hub 面板登录一个国际站账号）。
//
// 两段共用 `workbuddy-credential.ts` 那套**已实测的 YAML 解析**（折行还原、
// 引号转义、双引号硬续行的奇偶性判定）—— 它处理的是 DSH 的 YAML writer 行为，
// 与 provider 无关，重写一遍只会引入新偏差。

/** 默认的 ref 前缀（国际站）。 */
const MINIMAXINTL_ACCOUNT_REF = /^[ \t]*(MINIMAXINTL_ACCOUNT_[A-Z0-9]+):/gm
/** 国际站的单账号回退 ref。 */
const MINIMAXINTL_DEFAULT_REF = 'MINIMAXINTL_ACCESS_TOKEN'

/** 从插件凭据存储读国际站（或任意 prefix）凭据的选项。 */
export interface ReadPluginCredentialOptions {
  /**
   * ref 前缀（`'MINIMAXINTL'` 国际版 / `'MINIMAX'` 中国版）。
   *
   * ⚠️ 必传且**必须精确**：`MINIMAX` 是 `MINIMAXINTL` 的前缀，用宽松匹配会把
   * 两站账号混在一起（本仓库 `QODER` / `QODERCN` 同款坑）。
   */
  refPrefix: string
  /** 覆盖凭据文件路径。 */
  path?: string
}

/**
 * 从 DSH 凭据存储读**插件自己**的 MiniMax 凭据（供国际站探针）。
 *
 * 优先级：`DSH_<PREFIX>_CREDENTIAL_JSON`（直接给 JSON）→
 * `DSH_<PREFIX>_ACCOUNT_REF`（指定 ref）→ 文件里全部 `<PREFIX>_ACCOUNT_*`
 * → 默认 ref `<PREFIX>_ACCESS_TOKEN`。
 *
 * ⚠️ 读不到时**返回 undefined 而不是抛错**：探针据此打印「请先登录」的可操作
 * 指引，而不是抛一个与用户操作无关的 ENOENT。
 */
export function readMinimaxPluginCredential(
  options: ReadPluginCredentialOptions,
): MinimaxProbeCredential | undefined {
  const prefix = options.refPrefix
  const fromEnv = process.env[`DSH_${prefix}_CREDENTIAL_JSON`]
  /** 命中的 ref 名（供日志显示；env 直给 JSON 时是一个标记串）。 */
  let ref = `DSH_${prefix}_CREDENTIAL_JSON`
  const raw = (() => {
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
    let text: string
    try {
      text = readCredentialsFile(options.path ?? CREDENTIALS_PATH)
    } catch {
      return undefined
    }
    // ⚠️ 前缀必须**逐字**匹配账号 ref 形态：`(MINIMAXINTL|MINIMAX)_ACCOUNT_…`。
    //    用宽松匹配会因 `MINIMAX` ⊂ `MINIMAXINTL` 而误捞另一站的账号
    //（本仓库 `QODER` / `QODERCN` 同款坑）。
    const accountRef = new RegExp(`^[ \\t]*(${prefix}_ACCOUNT_[A-Z0-9]+):`, 'gm')
    const declared = [...text.matchAll(accountRef)].map((m) => m[1]!)
    const explicit = process.env[`DSH_${prefix}_ACCOUNT_REF`]
    ref = explicit !== undefined && explicit.length > 0
      ? explicit
      : (declared.length > 0 ? declared[declared.length - 1]! : `${prefix}_ACCESS_TOKEN`)
    try {
      return extractYamlScalar(text, ref)
    } catch {
      return undefined
    }
  })()
  if (raw === undefined) return undefined

  let credential: MinimaxCredential
  try {
    const parsed = JSON.parse(raw) as MinimaxCredential
    if (typeof parsed?.access_token !== 'string' || parsed.access_token.length === 0) return undefined
    credential = parsed
  } catch {
    return undefined
  }

  const expiresAt = credential.expires_at === undefined ? undefined : Number(credential.expires_at)
  const expired = !Number.isFinite(expiresAt) || (expiresAt as number) <= Date.now()
  const remainingMin = Number.isFinite(expiresAt)
    ? Math.round(((expiresAt as number) - Date.now()) / 60_000)
    : undefined

  return {
    credential,
    expired,
    // ⚠️ 只打印有效期状态与 **ref 名**，绝不打印 token。
    describe: `${ref} · `
      + (expired
        ? `已过期（${remainingMin === undefined ? '未记录到期时间' : `${-remainingMin!} 分钟前`}）`
        : `有效（剩余约 ${remainingMin} 分钟）`),
  }
}
