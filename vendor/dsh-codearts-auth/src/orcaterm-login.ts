/**
 * OrcaTerm 登录流程：打开内置浏览器 → 用户微信扫码 → 采集 cookie 落凭据。
 *
 * ## 为什么不能复用 CodeBuddy 的两步式
 *
 * CodeBuddy 系的登录是「POST `/v2/plugin/auth/state` 拿 state + authUrl → 弹窗
 * → 轮询到 ready → 拿 token」。OrcaTerm 没有这套端点：它的登录态是**腾讯云网页
 * cookie**（`uin`/`skey`），只能由用户在浏览器里扫码产生，然后从 cookie jar 读出来。
 *
 * 把 OrcaTerm 塞进 `productById()` 会走到 CodeBuddy 分支并拼出
 * `undefined/v2/plugin/auth/state?platform=undefined` —— 这正是 2026-10-14 的
 * 真机故障。因此本模块提供**独立分支**，由 `jet-hub-rpc.ts` 的 `account.create`
 * 在 `productById()` 之前判定。
 *
 * ## 流程
 *
 * 1. `account.create` 收到 `provider === 'orcaterm'` → 调本模块；
 * 2. 先用 `resolveOrcaTermCredential()` 试读已有 cookie（用户可能已登录过）；
 * 3. 读不到就返回「需要登录」，并给出内置浏览器登录入口 URL —— 客户端据此
 *    打开浏览器标签页让用户扫码；
 * 4. 用户扫码后客户端再次调 `account.create`（或轮询），此时 cookie jar 里已有
 *    `uin`/`skey`，凭据落库、账号进池。
 *
 * 这样**不需要用户手输任何凭据**，也不需要 OrcaTerm 提供 auth/state 端点。
 *
 * @module orcaterm-login
 */

import { ORCATerm } from './orcaterm-product.js'
import { resolveOrcaTermCredential } from './orcaterm-credential.js'
import type { OrcaTermCredential } from './orcaterm-adapter.js'

/** `account.create` 对 OrcaTerm 的返回：要么已有凭据，要么给出登录入口。 */
export type OrcaTermCreateResult =
  | { status: 'ready'; credential: OrcaTermCredential }
  | { status: 'login-required'; loginUrl: string; help: string }

/**
 * 尝试为一个新 OrcaTerm 账号取得凭据。
 *
 * 不产生副作用：只读 cookie jar / token 文件。凭据落库与账号入池由调用方
 * （`account.create`）在拿到 `ready` 后执行 —— 这样「探测」与「写入」分开，
 * 探测失败不需要回滚任何状态。
 *
 * @param options.cookieDb 自定义 cookie 库路径（测试用）
 * @param options.tokenFile 自定义 token 文件路径（测试用）
 */
export function createOrcaTermAccount(options: {
  cookieDb?: string
  tokenFile?: string
  /**
   * 是否允许用 `orcaterm_token.txt` 作为建号依据。默认 **false**。
   *
   * ⚠️ 为什么默认不允许（真机故障 2026-10-14）：测试期间在
   * `~/.dsh/orcaterm_token.txt` 留过一份 cookie，`account.create` 读到它就
   * 立刻建号 —— 用户点「添加账号」**没扫码就冒出一个账号**，看起来像假的
   * 登录态（凭据其实是有效的，但行为不可信、也无法区分「谁登的」）。
   *
   * 建号必须来自**用户刚刚完成的登录动作**（cookie jar 里出现新鲜凭据），
   * 而不是机器上恰好存在的某个文件。文件只作为**调用时**的兜底
   * （`resolveOrcaTermCredential` 在 adapter 里仍会读它），不参与建号判定。
   */
  allowTokenFile?: boolean
} = {}): OrcaTermCreateResult {
  // 只认 cookie jar：这是「用户刚用内置浏览器扫码」的唯一证据。
  const harvested = resolveOrcaTermCredential({ cookieDb: options.cookieDb })
  if (harvested !== null) return { status: 'ready', credential: harvested }
  if (options.allowTokenFile === true) {
    const fromFile = resolveOrcaTermCredential({
      cookieDb: options.cookieDb,
      tokenFile: options.tokenFile,
    })
    if (fromFile !== null) return { status: 'ready', credential: fromFile }
  }
  return {
    status: 'login-required',
    loginUrl: ORCATerm.loginUrl,
    help: '已打开腾讯云 OrcaTerm 登录页：请用微信扫码登录，登录完成后回到本面板点「重新读取」。',
  }
}

/**
 * 把凭据序列化成账号池里存的 JSON 形态。
 *
 * 与 `parseOrcaTermSecret`（index.ts）互逆：网页形态存 `{kind,uin,skey,userId}`，
 * 桌面形态存 `{kind,ot_session}`。存 `kind` 是为了让读取端不必靠字段猜形态
 * —— 两种形态的请求头规则不同（网页不能带 Bearer），猜错会直接 401。
 */
export function serializeOrcaTermCredential(credential: OrcaTermCredential): string {
  if (credential.kind === 'desktop') {
    return JSON.stringify({ kind: 'desktop', ot_session: credential.otSession })
  }
  return JSON.stringify({
    kind: 'web',
    uin: credential.uin,
    skey: credential.skey,
    userId: credential.userId,
  })
}

/** 账号昵称：网页形态用 userId（可读），桌面形态用固定串。 */
export function orcaTermNickname(credential: OrcaTermCredential): string {
  if (credential.kind === 'web') {
    return credential.userId ? `腾讯云 ${credential.userId}` : `腾讯云 ${credential.uin}`
  }
  return '腾讯云 OrcaTerm'
}
