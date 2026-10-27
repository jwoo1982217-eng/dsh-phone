/**
 * AutoClaw 认证服务。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  AUTOCLAW,
  type AutoclawProduct,
} from './autoclaw-product.js'
import {
  parseAutoclawCredential,
  isAutoclawRefreshable,
  isAutoclawTokenExpired,
  autoclawDisplayNickname,
  readUserIdFromJwt,
  type AutoclawCredential,
} from './autoclaw.js'
import {
  probeAutoclawLocalCredential,
  refreshAutoclawToken,
  testAutoclawConnection,
  sendAutoclawVerificationCode,
  loginAutoclawWithCode,
  startAutoclawSmsLoginFlow,
  buildAutoclawZaiAuthUrl,
  exchangeAutoclawZaiCode,
  type SendAutoclawCodeResult,
  type LoginAutoclawWithCodeResult,
  type StartedAutoclawSmsLoginFlow,
} from './autoclaw-oauth.js'
import { RefreshScheduler } from './refresh.js'
import {
  claimAutoclawDailyQuota,
  fetchAutoclawBalanceDetailed,
} from './autoclaw-credits.js'
import { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/**
 * 计算一条凭据的**账号身份**（同账号判据）。
 *
 * ⚠️ 抽成具名导出是为了让守卫能直接钉住它（`autoclawIdentityForTest` 同体）——
 *    这段逻辑踩过两次真机缺陷（同一账号被重复添加 3 次、积分重复累加），
 *    必须能被单测独立覆盖，而不是只能通过整条登录链路间接验证。
 *
 * ⚠️⚠️ **字段优先级**（2026-10-19 三次真机报障后定稿）：
 *      1. `credential.user_id` —— 服务端 `user-profile` 的 UUID 主键；
 *      2. `readUserIdFromJwt(access_token)` —— 老凭据没落该字段时兜底；
 *      3. `access_token` —— 两者都取不到时退化（宁可退化，不要「无身份」）。
 *
 *     ⚠️ 1 与 2 属**两个 id 空间**（UUID ↔ `numericUserId`）：同一账号可能
 *        一部分 ref 落在 1、另一部分落在 2 ⇒ 分裂成两组、去重白做
 *        （用户三次报障「怎么还是在啊」的直接原因）。
 *        彻底统一由 `autoclawSelfHeal` 在启动时调 `user-profile` 补 UUID 完成；
 *        本函数只在「来不及补齐」的窗口内保证不会没有身份。
 */
export function autoclawIdentityOf(credential: AutoclawCredential): string {
  const userId = credential.user_id ?? readUserIdFromJwt(credential.access_token)
  if (userId !== undefined && String(userId).trim() !== '') {
    // ⚠️ 加渠道前缀：不同渠道的 id 空间独立，裸值可能撞车。
    return `autoclaw:${String(userId).trim()}`
  }
  return credential.access_token ?? ''
}

/** @internal 守卫专用别名（与 {@link autoclawIdentityOf} 同一实现）。 */
export const autoclawIdentityForTest = autoclawIdentityOf

/**
 * AutoClaw 凭据 → 账号池有效期所需的提取器。
 *
 * ⚠️ `expiresAtOf` 只读 `credential.expires_at`，而该字段由
 * `parseAutoclawCredential` **以 JWT 的 `exp` 为准**归一（2026-10-19 P0，
 * 见 `src/autoclaw.ts` 的 `autoclawAccessTokenExpiresAtMs`）。
 * 这两个入口必须**同源**：它是 `refreshAll` 的 lead-time 判据与 UI 有效期
 * 的共同数据源 —— 曾因该字段是编造的 7 天而让整条自动续期链**静默跳过**。
 */
const AUTOCLAW_EXPIRY_ACCESSORS: ExpiryAccessors<AutoclawCredential> = {
  expiresAtOf: (credential) => credential.expires_at,
  refreshableOf: isAutoclawRefreshable,
  /**
   * **`findAccountIdByCredential` 用的身份**（`syncAccountExpiry` 的池内反查）。
   *
   * ⚠️⚠️ **它与上面的 `autoclawIdentityOf` 是两个不同用途，绝不能混用**
   *    （2026-10-20 审计 P1，真缺陷）：
   *
   * | 用途 | 消费者 | 判据 | 口径 |
   * |---|---|---|---|
   * | **同账号去重** | `findAccountIdByIdentityField` | `autoclawIdentityOf` | 带渠道前缀 `autoclaw:<id>` |
   * | **池内按凭据反查** | `findAccountIdByCredential` | **本行** | 裸 `access_token` |
   *
   * 原因：`AccountPool.findAccountIdByCredential` 的匹配字段是**写死的**
   *（`provider === 'codearts' ? 'access_key_id' : 'access_token'`，见该方法注释），
   * 它拿 `identityOf` 的返回值去和凭据里的 `access_token` **逐字比较**。
   * ⇒ 把带前缀的 `autoclaw:7c54a9a…` 喂进去**恒不命中**。
   *
   * 后果（实测）：`refreshAccountCredential(refName, pool)` 若调用方不传第三参，
   * 反查失败 ⇒ `syncAccountExpiry` 直接 return ⇒ **池内 `expiresAt` 永不更新**，
   * UI 一直显示旧有效期。这是 PR122 引入的行为回归
   *（改前 `identityOf` 返回裸 `access_token`，能命中）。
   *
   * ⚠️ 与 `accio-auth.ts` / `cline-auth.ts` / `buddy-auth.ts` 的
   *    `identityOf: (c) => c.access_token ?? ''` **同一口径** —— 那几家的注释
   *    都明写「必须是 access_token，因为 `findAccountIdByCredential` 就这么比」。
   */
  identityOf: (credential) => credential.access_token ?? '',
}

export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

export interface AutoclawAuthOptions {
  readonly product?: AutoclawProduct
  readonly serviceName?: string
  readonly fetcher?: typeof fetch
}

export interface AutoclawStatusResult {
  readonly loggedIn: boolean
  readonly expiresAt?: number
  readonly refreshable: boolean
  readonly lastError?: string
}

export class AutoclawAuth extends Service {
  readonly product: AutoclawProduct
  readonly credentialRefName: string

  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        this.markRefreshTokenInvalid()
        return
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
    },
  )

  private refreshTokenInvalid = false
  private lastRefreshError: string | undefined
  private active = true

  constructor(ctx: Context, private readonly options: AutoclawAuthOptions = {}) {
    const product = options.product ?? AUTOCLAW
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * 探测本地是否有有效凭据（一键导入）。
   *
   * ⚠️ **按产品选 userData 目录**（2026-10-20）：国内版与国际版是同一客户端的
   * 两份构建（`isOversea` 构建期常量），但 userData 目录名不同：
   * - 国内：`AutoClaw-official`
   * - 国际：`AutoClaw-oversea-official`
   *
   * 原实现硬编码国内目录 ⇒ **国际版永远导入不到自己的凭据**。
   *
   * ⚠️⚠️ 目录名**不再在这里拼**（2026-10-20 审计 P0 后收口）：它已进
   *    `product.userDataDirName`，因为同一个目录名有**三个读点**
   *    （本函数 / `resolveDeviceId` / 登录页 `/autoclaw/import-local`），
   *    原先各写一份 ⇒ PR 只修了本函数，另两处照旧读国内目录。
   */
  async probeLocal(): Promise<AutoclawCredential | undefined> {
    return probeAutoclawLocalCredential({ product: this.product })
  }

  /**
   * 刷新指定的凭据对象。
   */
  async refreshCredential(credential: AutoclawCredential): Promise<AutoclawCredential> {
    if (!isAutoclawRefreshable(credential)) {
      throw new RefreshTokenExpiredError('AutoClaw refresh_token 为空，无法续期')
    }
    try {
      const refreshed = await refreshAutoclawToken(credential.refresh_token, {
        product: this.product,
        fetchImpl: this.fetchImpl,
        deviceId: credential.device_id,
      })
      return refreshed
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Invalid token') || msg.includes('expired') || msg.includes('401')) {
        throw new RefreshTokenExpiredError(`AutoClaw refresh_token 已失效：${msg}`)
      }
      throw err
    }
  }

  /**
   * 按凭据 ref 续期指定账号的凭据。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseAutoclawCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    // ⚠️⚠️ **空 `refresh_token` 必须走到这里，而不是上一行**
    // （2026-10-17 审计 P1 修复）。上游不下发 refresh_token 时
    // `loginAutoclawWithCode` 会产出 `refresh_token: ''`，而解析过去把它
    // 判成「解析失败」⇒ 用户点「刷新」看到的是**误导文案**，
    // 真实原因（必须重新登录）就在下一行却永远不可达。
    // ⚠️ 这类「文案本身就是出路」的错误必须给准 —— 它告诉用户**去做什么**
    //   （重新登录），说错会让用户反复点刷新却始终找不到出路
    //   （本仓库 client-ui 笔记记载的复发形态）。
    if (!isAutoclawRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }

    const refreshed = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: refreshed,
      accessors: AUTOCLAW_EXPIRY_ACCESSORS,
      accountId,
      tag: '[autoclaw]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 批量续期本产品的所有账号。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseAutoclawCredential(resolved.value)
        if (!credential || !isAutoclawRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: '[autoclaw]',
          accountId: entry.id,
          credential,
          accessors: AUTOCLAW_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredential(c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[autoclaw] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
          )
        } else {
          this.ctx.logger?.warn?.(
            `[autoclaw] 账号 ${entry.id} 续期失败: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /**
   * 刷新单凭据路径下的当前凭据。
   */
  async refresh(): Promise<void> {
    if (!this.active) return
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) return

    const credential = parseAutoclawCredential(resolved.value)
    if (!credential || !isAutoclawRefreshable(credential)) return

    try {
      const refreshed = await this.refreshCredential(credential)
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      if (refreshed.expires_at) {
        this.scheduler.arm(refreshed.expires_at)
      }
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) {
        this.markRefreshTokenInvalid()
      } else {
        this.lastRefreshError = error instanceof Error ? error.message : String(error)
      }
      throw error
    }
  }

  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.scheduler.stop()
  }

  /**
   * 获取当前单凭据状态。
   */
  async status(): Promise<AutoclawStatusResult> {
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) {
      return { loggedIn: false, refreshable: false }
    }
    const credential = parseAutoclawCredential(resolved.value)
    if (!credential) {
      return { loggedIn: false, refreshable: false, lastError: '凭据格式无效' }
    }

    const expired = isAutoclawTokenExpired(credential, 0)
    return {
      loggedIn: !expired,
      expiresAt: credential.expires_at,
      refreshable: isAutoclawRefreshable(credential) && !this.refreshTokenInvalid,
      lastError: this.lastRefreshError,
    }
  }

  /**
   * **归属校验**：用**本产品自己的**基址探一次余额，确认这份凭据属于本站。
   *
   * ## 为什么必须存在（真实事故，2026-10-20）
   *
   * 旧代码把 `refName` 写死 `AUTOCLAW_ACCOUNT_*`、且读国内目录 ⇒ 国际版槽位里
   * 被塞进**国内版凭据**。用户看到的是「国际版卡片显示国内手机号、且已过期」
   * —— 而凭据本身能解出来、能落盘，**全流程无一处报错**。
   *
   * ⇒ 「能读到」不等于「读对了」。国内凭据打国际基址会 `410000 未登录`，
   *    反之亦然（实测）。
   *
   * ## ⚠️⚠️ 为什么抽成 public 方法（审计 P0 的直接产物）
   *
   * 凭据落盘有**两条腿**：
   * 1. `importLocalAccount()` —— 本类内部，原先就调它；
   * 2. `startLogin()` 的 `started.result` —— 登录页上的「⚡ 一键读取本机凭据」
   *    （`/autoclaw/import-local`）走这条，结果由 `jet-hub-rpc.ts` **直接
   *    `credentials.set`** ⇒ 原先把校验留在 `importLocalAccount` 里，
   *    这条腿**完全绕过**它。
   *
   * 审计实测：以 `product: AUTOCLAW_INTL` 起 flow 后请求该端点，被探测的
   * 路径是 `AutoClaw-official`（国内）⇒ 国内凭据进 `AUTOCLAWINTL_ACCOUNT_*`，
   * 零报错。
   *
   * ⇒ 校验必须**与落盘同址**、且能被两条腿各自调用。
   *
   * @param cred - 待落盘的凭据。
   * @throws 校验失败时抛出**指向性**错误（告诉用户去哪个客户端登录）。
   */
  async verifyCredentialSite(cred: AutoclawCredential): Promise<void> {
    try {
      const detail = await fetchAutoclawBalanceDetailed(cred, { product: this.product })
      if (detail.balance === null || detail.balance === undefined) {
        const site = this.product.id === 'autoclawintl' ? '国际版' : '国内版'
        throw new Error(
          `导入的凭据在 AutoClaw${site}校验失败（${detail.error ?? '未知原因'}）`
          + `——请确认你在 AutoClaw${site}客户端里登录的是${site}账号`,
        )
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('校验失败')) throw err
      const reason = err instanceof Error ? err.message : String(err)
      const site = this.product.id === 'autoclawintl' ? '国际版' : '国内版'
      throw new Error(
        `导入的凭据无法通过 AutoClaw${site}校验：${reason}`
        + `——请确认你在 AutoClaw${site}客户端里登录的是${site}账号`,
      )
    }
  }

  /**
   * 将本地探测到的凭据导入为账号。
   */
  async importLocalAccount(
    pool: AccountPool,
    options?: { accountId?: string; refName?: string },
  ): Promise<{ accountId: string; refName: string; credential: AutoclawCredential }> {
    const cred = await this.probeLocal()
    if (!cred) {
      throw new Error('未检测到本地 AutoClaw 桌面端有效登录凭据，请先在 AutoClaw 中登录')
    }

    // ⚠️⚠️ 归属校验（判据与文案见 {@link verifyCredentialSite} 的类注释）。
    //    失败即拒绝落盘，而不是把一条「永远查不到余额」的凭据写进去。
    await this.verifyCredentialSite(cred)

    const accountId = options?.accountId ?? `${this.product.id}-${Date.now().toString(36)}`
    // ⚠️⚠️ **refName 的前缀必须按产品派生**（2026-10-20 修）：
    //    原实现写死 `AUTOCLAW_ACCOUNT_${…}` ⇒ 国际版一键导入的凭据会
    //    **落进国内版命名空间**（`AUTOCLAW_*`），被 `REF_PREFIX_TO_PROVIDER`
    //    判成 `autoclaw` 账号 —— 用户看到的是「国际版导入后跑到国内面板、
    //    余额查不到（410000 未登录）」。
    //    ⇒ 从 `defaultCredentialRef`（`AUTOCLAW_ACCOUNT_DEFAULT` /
    //      `AUTOCLAWINTL_ACCOUNT_DEFAULT`）截掉 `_DEFAULT` 作为前缀，
    //      单一真相源，不新增第二份拼写。
    const refPrefix = this.product.defaultCredentialRef.replace(/_DEFAULT$/, '_')
    const refName = options?.refName ?? `${refPrefix}${Date.now().toString(16).toUpperCase()}`

    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(cred))

    const nickname = autoclawDisplayNickname(cred, accountId)

    await pool.addAccount({
      id: accountId,
      provider: this.product.id,
      nickname,
      enabled: true,
      credentialRef: refName,
      createdAt: Date.now(),
      expiresAt: cred.expires_at,
      refreshable: isAutoclawRefreshable(cred),
    })

    return { accountId, refName, credential: cred }
  }

  /**
   * 发送手机验证码（免桌面端快速登录模式）。
   */
  async sendVerificationCode(phone: string): Promise<SendAutoclawCodeResult> {
    return sendAutoclawVerificationCode(phone, {
      product: this.product,
      fetchImpl: this.fetchImpl,
    })
  }

  /**
   * 使用手机验证码登录并保存凭据（免桌面端快速登录模式）。
   */
  async loginWithCode(
    phone: string,
    code: string,
    refName?: string,
  ): Promise<LoginAutoclawWithCodeResult> {
    const res = await loginAutoclawWithCode(phone, code, {
      product: this.product,
      fetchImpl: this.fetchImpl,
    })
    if (res.ok && res.credential && refName) {
      const ref = credentialRef(refName)
      await this.ctx.credentials.set(ref, JSON.stringify(res.credential))
      // ⚠️⚠️ **登录成功后立刻领取每日积分**（2026-10-17，对齐桌面端）。
      //
      // 桌面端源码里有 `claimDailyCreditsOnSignIn(account, dailyCredits)`：
      // 它在账号状态**刚变为 `authenticated`** 时触发
      // `dailyCredits.claim()`（即 `POST /userapi/v1/user-info`）。
      // ⇒ 这就是「登录即领」的真实机制：**不是**登录的副作用，
      //   而是登录后**紧跟一次领取调用**。
      //
      // ⚠️ 用户实测过的症状：纯插件登录后新账号**没有积分**（推理回 402
      //   「积分不足,请充值」），而在 IDE 里登录同一账号就有 ——
      //   差别正是桌面端替用户调了这一次。
      //
      // ⚠️ **失败绝不反噬登录**：领取是附加动作，凭据已经落盘且可用
      //   ⇒ 这里吞掉一切错误（包括网络异常），只记一条 warn。
      //   若把领取失败上抛，用户会以为「登录失败」而重新登录，更糟。
      // ⚠️ 时机：必须在 `credentials.set` **之后** —— 领取要用刚写入的凭据，
      //   且此时 `resolveCredential` 才读得到。
      try {
        const outcome = await claimAutoclawDailyQuota(res.credential, {
          product: this.product,
          ...(this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher }),
        })
        if (outcome.kind === 'claimed') {
          this.ctx.logger?.info?.(
            `[autoclaw] 登录后自动领取每日积分：${outcome.credit > 0 ? `+${outcome.credit}` : '已领取（数量以上游为准）'}`,
          )
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[autoclaw] 登录后自动领取每日积分失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return res
  }

  /**
   * 启动 AutoClaw 登录授权流程（本地服务器承载独立登录页，支持短信验证码与一键本地导入）。
   */
  async startLogin(_options?: { refName?: string }): Promise<StartedAutoclawSmsLoginFlow> {
    return startAutoclawSmsLoginFlow({
      product: this.product,
      fetchImpl: this.fetchImpl,
    })
  }

  /**
   * 构造 **Z.ai OAuth** 授权 URL（仅国际版 `autoclawintl` 用）。
   *
   * ## 为什么国际版必须走 OAuth 而不是短信
   *
   * 国际版**后端也接受短信**（实测 `/userapi/v1/agent-send-code` 在国际基址回
   * `code=0 SUCCESS`），但国际版账号是**邮箱 + OAuth 创建、没绑手机号**
   * （`account-profile.json`: `phone: null`），且**没有绑手机的端点**
   * （`agent-bind-phone` / `bind-phone` 等全 404）⇒ 短信对国际账号不可用。
   *
   * ## `state` 的处理：**不生成，透传**
   *
   * 官方 `state` 是不透明串（`aosi.<base64url JWT>`，含 `dh` / `nh` 等字段），
   * 由远端登录页生成。`dh = SHA256(deviceId)` 已破解，但 **`nh` 来源未知**。
   *
   * ⚠️ 实测：用**瞎编的** `state` 打 `/userapi/overseasv1/zai-oauth-login`，
   *    服务端回 `631001 User login error`（= 进了登录逻辑、code 无效），
   *    **不是**「state 无效」⇒ 服务端不硬校验 `state` 内容。
   *
   * ⇒ 本方法**只拼 `client_id` / `redirect_uri` / `response_type`**，
   *   `state` 留给授权页填，回调时原样透传给 {@link loginWithZaiCode}。
   *
   * @param redirectUri - 回调地址（`http://localhost:<port>/auth/callback-zai`）。
   */
  buildZaiAuthUrl(redirectUri: string): string {
    return buildAutoclawZaiAuthUrl(redirectUri)
  }

  /**
   * 用 Z.ai 授权码换 token 并落盘（仅国际版）。
   *
   * ⚠️ 与 {@link loginWithCode}（短信）并列的**第二条登录腿**：
   *    - 短信：国内版；国际版短信端点通但账号没绑手机。
   *    - OAuth：国际版唯一可用路径。
   *
   * @param code - 回调 URL 里的 `code`。
   * @param state - 回调 URL 里的 `state`（**原样透传**，不解析）。
   * @param navigateUri - 与授权时**完全相同**的回调地址。
   * @param refName - 凭据 ref 名（登录成功后写它）。
   */
  async loginWithZaiCode(
    code: string,
    state: string,
    navigateUri: string,
    refName: string,
  ): Promise<LoginAutoclawWithCodeResult> {
    const res = await exchangeAutoclawZaiCode(code, state, navigateUri, {
      product: this.product,
      fetchImpl: this.fetchImpl,
    })
    if (res.ok && res.credential) {
      const ref = credentialRef(refName)
      await this.ctx.credentials.set(ref, JSON.stringify(res.credential))
      // 与短信登录同口径：登录后立刻领一次每日积分（失败不反噬登录）。
      try {
        await claimAutoclawDailyQuota(res.credential, { product: this.product })
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[autoclaw] OAuth 登录后自动领取每日积分失败（不影响登录）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return res
  }
}


