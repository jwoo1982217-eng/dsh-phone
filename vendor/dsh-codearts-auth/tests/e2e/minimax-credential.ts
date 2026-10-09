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
