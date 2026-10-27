import type { AccountPool } from './account-pool.js'
import type { ProviderAccountEntry } from './types.js'
import { REFRESH_LEAD_MS } from './refresh.js'

/**
 * 账号池「有效期」的共享回写与 lead-time 判据。
 *
 * ## 为什么需要这个模块（issue !IKIRTT 的真实缺陷）
 *
 * UI 账号卡片的「有效期：已过期」读的是**账号池的 `expiresAt`**
 * （`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`），
 * 而不是凭据里 access_token 的真实 `exp`。于是只要凭据被更新过而**索引没跟上**，
 * 就会出现「显示已过期、但发消息完全正常」的数据源分叉。
 *
 * 这条分叉有两条产生路径，都真实发生过：
 *
 * 1. **按需续期不回写**：`refreshAccountCredential`（RPC `account.refresh` 走的
 *    路径）原先只有 raccoon 记得 `pool.updateAccount({ expiresAt })`，
 *    其余七个 provider 只 `credentials.set` —— 续期成功了、凭据换新了，
 *    UI 却纹丝不动，且没有任何自救手段（「重测」按钮的 refresh 是刻意的 no-op）。
 * 2. **定时器首轮要等满一个周期**：`src/index.ts` 的多账号续期只有 `setInterval`、
 *    没有启动时首轮，短寿命 provider（cline 1h / codearts 2h / raccoon 3h）
 *    在宿主关闭期间到期后，最长要等 30 分钟才第一次被处理。
 *
 * 本模块把 raccoon 已经验证过的写法抽成一份实现，让九个 provider 共用 ——
 * 与 AGENTS.md「差异收敛到产品配置、缺陷只修一遍」的一贯做法一致。
 */

/** 池内条目的现值（用于「变了才写盘」的短路）。 */
export interface ExpiryCurrentValue {
  expiresAt?: number
  refreshable?: boolean
}

/**
 * 回写有效期所需的**最小**账号池能力。
 *
 * 刻意不依赖整个 `AccountPool` 类：本模块只做「反查 + 打补丁」两件事，
 * 与账号池的缓存、落盘、模型黑名单等无关。收窄到接口也让单测可以直接
 * 传一个结构替身，而不必先构造真池。
 */
export interface ExpirySyncPool {
  updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'expiresAt' | 'refreshable'>>,
  ): Promise<void>
  findAccountIdByCredential(provider: string, identity: string): Promise<string>
}

/** 从各家凭据取过期信息的能力（各 provider 凭据类型不同，故以提取器注入）。 */
export interface ExpiryAccessors<TCredential> {
  /** access_token 的过期时刻（毫秒）；`undefined` 表示凭据里读不到。 */
  expiresAtOf: (credential: TCredential) => number | undefined
  /**
   * 凭据是否仍可续期。
   *
   * ⚠️ **不提供时只同步 `expiresAt`、绝不碰 `refreshable`**。Loomy 必须走这条：
   * 它的 `isLoomyRefreshable` **恒为 `false`**（服务端没有任何 refresh 端点，
   * 这是诚实标记），若让共享实现据此把池里写 `false`，反而会把账号池改成
   * 与该产品实际行为不符的状态。
   */
  refreshableOf?: (credential: TCredential) => boolean
  /**
   * **refresh_token 本身的到期时刻**（毫秒）。
   *
   * ## 这条腿是为谁加的（CodeArts 30 天硬上限，2026-10-18 实测）
   *
   * ⚠️ lead-time 判据原本**只读 access_token 的到期**，在 refresh_token 寿命
   * **更短**时会于死线之后才放行 ⇒ 那一轮续期必然失败。
   *
   * 华为 STS 的实测行为（解开全部历史凭据的 JWT 逐个核对得出）：
   * `refresh_token.exp` **恒等于「登录时刻 + 30 天」，续期不会延长它** ——
   * 续期只会**缩短**剩余寿命。而 access_token 寿命恒为 2 小时。于是最后一天：
   * access 剩 2 小时、refresh 只剩约 50 分钟，按 lead-time 算净窗口仅 6~9 分钟，
   * 而调度周期是 30 分钟 ⇒ **必然错过**，账号在 access 到期后彻底不可用
   * （该日实测两个账号同时报废，且池内 `refreshable` 仍是 `true`）。
   *
   * 提供本腿后，剩余寿命不足 lead 时会**提前放行**（在死线前把 access 换新，
   * 顺带把 refresh 的剩余寿命重新拉满到 access 之后）。
   *
   * ⚠️ **不提供时行为与从前逐字节一致**（`shouldRefreshNow` 退化成单腿判据）：
   * 其余八家的 refresh_token 寿命均长于 access_token（buddy 14 天 / cline 30 天
   * / minimax 30 天 …），补这条腿对它们**无任何行为变化**，故刻意不给它们加。
   */
  refreshExpiresAtOf?: (credential: TCredential) => number | undefined
  /**
   * `AccountPool.findAccountIdByCredential` 的凭据身份。
   *
   * ⚠️ 该参数的语义是「**凭据内容**」（通常是 access_token）而**不是 ref 名**，
   * 传 ref 名会恒匹配失败且**静默无报错**（raccoon 踩过，见其方法注释）。
   */
  identityOf: (credential: TCredential) => string
}

/** 容差：毫秒时间戳来自 JWT 的秒级 `exp`，换算后可能有 1 秒内的舍入。 */
const EXPIRY_TOLERANCE_MS = 1000

/**
 * 本轮是否需要为该凭据发一次续期请求（lead-time 语义）。
 *
 * 与单凭据时代 `computeFirstRefreshDelayMs` 的 `expiresAt - now <= REFRESH_LEAD_MS`
 * 同一判据：**距过期不足 1 小时（或已过期、或读不到过期时间）才刷**。
 *
 * ## 为什么判据用**凭据的**过期时间而不是账号池的 `expiresAt`
 *
 * 池值正是本缺陷里可能陈旧的那份数据（按需续期不回写、老版本从未回写）。
 * 拿它当判据会让「凭据其实快过期」的账号被跳过；而凭据本体是权威值，
 * 读它只是一次本地存储访问，不花网络也不花模型额度。
 *
 * @param expiresAtMs 凭据 access_token 的过期时刻；`undefined` 一律视为需要刷。
 */
export function shouldRefreshNow(expiresAtMs: number | undefined, nowMs = Date.now()): boolean {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return true
  return expiresAtMs - nowMs <= REFRESH_LEAD_MS
}

/**
 * 本轮是否需要为该凭据发一次续期请求：**access 与 refresh 两条腿取或**。
 *
 * ⚠️ 这是 {@link shouldRefreshNow} 的**带 refresh 寿命腿**版本，只有 CodeArts
 * 走它（其余八家不提供 `refreshExpiresAtOf`，行为与旧版逐字节相同）。
 *
 * ## 为什么必须取「或」而不是「与」
 *
 * 取「与」（两条腿都满足才续）会**制造**一个新缺陷：refresh 剩 3 天、access
 * 剩 2 小时（正常态）时反而**不续**，access 一过期账号就报废 —— 而此刻 refresh
 * 明明还好好活着。取「或」的语义才是对的：**任一条腿进入告警区间就续期**，
 * 两条腿都能因此被拉满。
 *
 * ## 为什么 refresh 已过期时也要放行（而不是直接判定失败）
 *
 * `refreshExpiresAt < now` 时本函数返回 `true`，让调用方**真去发一次**请求：
 * 上游可能已经续发过（多端登录会重签 refresh），本地这一份过期不代表云端不接受。
 * 让真实报文来否决，比凭本地过期时间猜要可靠 —— 且调用方对 `invalid_grant`
 * 已有终态处理（写 `refreshable: false` 并提示重新登录）。
 *
 * ⚠️ 但**读不到**（`undefined` / NaN）时**必须当「不知」而非「已过期」**：
 * CodeArts 的 refresh 是 JWT，`exp` 明文可读，读不到只可能是旧版 ticket 凭据
 * （没有 refresh_token），那种情况由 `isCodeArtsRefreshable` 拦下；若在这里
 * fail-closed 成 `true`，会让所有读不到腿的凭据每 30 分钟被无谓刷一次。
 */
export function shouldRefreshNowWithRefreshExpiry<TCredential>(params: {
  /** access_token 的到期时刻（毫秒）。 */
  expiresAtMs: number | undefined
  /** refresh_token 的到期时刻（毫秒）；`undefined` = 读不到（当作不知）。 */
  refreshExpiresAtMs: number | undefined
  nowMs?: number
}): boolean {
  const nowMs = params.nowMs ?? Date.now()
  // 主腿：access 进入 lead 窗口（含已过期 / 读不到）。
  if (shouldRefreshNow(params.expiresAtMs, nowMs)) return true
  // refresh 这条腿：读不到就**放弃这条腿**（fail-open 到「按 access 判」）。
  const r = params.refreshExpiresAtMs
  if (r === undefined || !Number.isFinite(r)) return false
  // 已过期 → 放行（让真实请求去否决，见上方注释）。
  if (r <= nowMs) return true
  // 剩余不足一个 lead 周期 → 提前续，别等到 access 的窗口才发现来不及。
  return r - nowMs <= REFRESH_LEAD_MS
}

/**
 * 把凭据的过期信息同步回账号池（UI 读的就是这里）。
 *
 * 三条从 raccoon 既有实现继承下来的硬规矩，改动时必须保持：
 *
 * 1. **失败只记日志、绝不上抛**：调用点是「凭据已经续期成功」之后，
 *    此时因为写索引失败而报错，会让用户以为续期失败、甚至触发无谓的重新登录。
 *    索引是展示层数据，不该反噬凭据本身。
 * 2. **优先用调用方给的 `accountId`**：`refreshAll` 手里本来就有 entry，
 *    无需反查；只有在缺失时才退化为按凭据身份遍历账号池比对。
 * 3. **现值一致时不写盘**：账号列表是整体落盘的，否则定时器每 30 分钟
 *    会把 39 条记录全量重写一遍，白耗 I/O。
 *
 * ⚠️ `expiresAt` 取不到时**不覆盖**池内旧值：`updateAccount` 做的是
 * `{ ...entry, ...patch }`，把字段写成 `undefined` 后落盘会被 `JSON.stringify`
 * 整个丢弃，UI 于是显示「未知」—— 保留旧信息比抹掉它更有价值。
 */
export async function syncAccountExpiry<TCredential>(params: {
  /** 账号池；未提供时静默跳过（兼容不传 pool 的既有调用方）。 */
  pool: ExpirySyncPool | undefined
  /** 账号池里该 provider 的 id，如 `'cline'` / `'codearts'`。 */
  provider: string
  /** 已从凭据算好的过期信息。 */
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 调用方已知的账号 id；缺失时按凭据身份反查。 */
  accountId?: string
  /** 池内现值，提供时启用「变了才写盘」短路。 */
  current?: ExpiryCurrentValue
  /** 日志前缀，如 `'[cline]'`。 */
  tag: string
  warn?: (message: string) => void
}): Promise<void> {
  const { pool, provider, credential, accessors, accountId, current, tag } = params
  if (pool === undefined) return
  try {
    let id = accountId
    if (id === undefined || id.length === 0) {
      id = await pool.findAccountIdByCredential(provider, accessors.identityOf(credential))
    }
    if (id === undefined || id.length === 0) return

    const expiresAt = accessors.expiresAtOf(credential)
    const refreshable = accessors.refreshableOf?.(credential)
    if (expiresAt === undefined && refreshable === undefined) return
    const expiryChanged = expiresAt !== undefined
      && (current?.expiresAt === undefined
        || Math.abs(current.expiresAt - expiresAt) > EXPIRY_TOLERANCE_MS)
    const refreshableChanged = refreshable !== undefined
      && (current === undefined || current.refreshable !== refreshable)
    if (!expiryChanged && !refreshableChanged) return

    await pool.updateAccount(id, {
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(refreshable === undefined ? {} : { refreshable }),
    })
  } catch (error) {
    params.warn?.(
      `${tag} 凭据处理成功但回写账号池的有效期失败（不影响使用）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * `refreshAll` 的单账号编排：需要刷就刷、不需要就把池值对账。
 *
 * 「不需要续期」的分支**不是**一句 `continue` 就完事 —— 存量账号的凭据早已在
 * 别处（IDE / 上一轮定时续期）续好了，只有池里还是旧值；若跳过时对账缺失，
 * UI 会**永远**显示「已过期」，正是本 issue 里最难自愈的那一半。
 *
 * @returns 是否真的发了一次续期请求（供调用方计数/日志）。
 */
export async function refreshAccountWithReconcile<TCredential>(params: {
  pool: ExpirySyncPool
  provider: string
  tag: string
  accountId: string
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 池内现值（通常就是 `entry` 本身）。 */
  current?: ExpiryCurrentValue
  /** 执行真正的续期并**落盘凭据**；失败应抛错。 */
  refresh: (credential: TCredential) => Promise<TCredential>
  /** 续期成功后写回凭据存储。 */
  save: (credential: TCredential) => Promise<void>
  warn?: (message: string) => void
  info?: (message: string) => void
}): Promise<boolean> {
  const { pool, provider, tag, accountId, credential, accessors, current, refresh, save } = params
  const expiresAt = accessors.expiresAtOf(credential)

  if (!shouldRefreshNowWithRefreshExpiry({
    expiresAtMs: expiresAt,
    refreshExpiresAtMs: accessors.refreshExpiresAtOf?.(credential),
  })) {
    // 凭据仍在有效期内：只把池值对账，不发请求。
    await syncAccountExpiry({
      pool,
      provider,
      credential,
      accessors,
      accountId,
      current,
      tag,
      warn: params.warn,
    })
    return false
  }

  const refreshed = await refresh(credential)
  // ⚠️ 续期响应缺访问令牌时**绝不能**把 `undefined` 落盘：那会把一份好凭据
  // 覆盖成 `"undefined"` 字符串，账号直接报废（只能重新登录）。
  if (refreshed === undefined) {
    throw new Error(`${tag} 续期响应缺少访问令牌，凭据未更新`)
  }
  await save(refreshed)
  await syncAccountExpiry({
    pool,
    provider,
    credential: refreshed,
    accessors,
    accountId,
    current,
    tag,
    warn: params.warn,
  })
  params.info?.(`${tag} 账号 ${accountId} 已续期`)
  return true
}
