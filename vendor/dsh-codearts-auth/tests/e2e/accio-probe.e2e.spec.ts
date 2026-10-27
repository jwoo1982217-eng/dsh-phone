/**
 * Accio（阿里）**只读**探针。
 *
 * ## 验证什么（单测证明不了的远端事实）
 *
 * 1. **登录**：账号池里已有凭据就直接用（只读）；没有则现场发起一次 PKCE 登录
 *    （人工在浏览器授权）。⚠️ 登录产物写进**内存**凭据提供者，
 *    **绝不落到用户的真实凭据存储**；
 * 2. **模型目录**：`POST /api/llm/config/v2` 的 `visible:true` 模型，
 *    且**倍率来自上游 `effectiveMultiple`**、按倍率升序（便宜在前）；
 * 3. **账号身份**：`POST /api/auth/userinfo`（token 在 **body**）；
 * 4. **积分**：`GET /api/entitlement/currentSubscription`（token 在 **query**）
 *    + `GET /api/entitlement/quota` 的重置倒计时。
 *
 * 闸门：`DSH_ACCIO_E2E=1`（用 `pnpm test:e2e:accio` 运行）。
 * 未设置时整体 skip，**零网络调用**。
 *
 * ⚠️ 本用例**不发任何模型请求**（零积分消耗）、
 * **不领取任何奖励**（Accio 根本没有签到端点）、**不续期**（不消费 refresh_token）。
 *
 * ## ⚠️ 判「成功」的口径：不能只看 HTTP 200
 *
 * 上游有两处「HTTP 200 但实际失败」的形态，本组探针**两处都显式判**：
 *
 * | 形态 | 出现在 | 判据 |
 * |---|---|---|
 * | 流内 `error_code: 402` | 推理端点（见 chat / tools 两个探针） | 帧里没有非 `'200'` 的 `error_code` |
 * | 信封 `{success:false, code:'401', message:'NOT_LOGIN'}` | 本文件的三个只读端点 | 信封 `success !== false` **且** `data` 是对象 |
 *
 * ⇒ 「拿到了 `data`」与「`success` 不为 false」必须**同时**成立；只看状态码会把
 * 一个未登录的账号读成「余额查询成功」。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ACCIO,
  ACCIO_CATALOG_PATH,
  ACCIO_REQUEST_TIMEOUT_MS,
  ACCIO_SUBSCRIPTION_PATH,
} from '../../src/accio-product.js'
import { AccioAuth, parseAccioCatalog } from '../../src/accio-auth.js'
import {
  fetchAccioBalanceDetailed,
  fetchAccioQuota,
  fetchAccioUserInfo,
} from '../../src/accio-credits.js'
import { openBrowser } from '../../src/accio-oauth.js'
import type { AccioCredential } from '../../src/accio.js'
// ⚠️ 复用**既有**的通用凭据读取（YAML 标量折行还原 + 账号池索引）。
// 它虽住在 `image-probe-shared.ts` 里，但 `credentialFor` / `enabledAccountRef`
// 与图片无关（一个读 `.credentials.yaml`、一个读 `jet-hub/state.json`）。
// 本任务的改动范围被限定在四个 accio spec + package.json + README，
// 故**不**另建 `accio-credential.ts`，而是复用这两条既有实现
// ——「同一份语义两套判据」是本仓库首条红线，重写一遍只会引入新的偏差。
import { credentialFor, enabledAccountRef } from './image-probe-shared.js'

const RUN = process.env.DSH_ACCIO_E2E === '1'
const suite = RUN ? describe : describe.skip

/** 现场登录时使用的凭据 ref（只写进内存，永不落盘）。 */
const PROBE_REF = 'ACCIO_E2E_PROBE'

/**
 * 内存凭据提供者（形状与 `ctx.credentials` 一致）。
 *
 * ⚠️ 它存在的**唯一**理由：让探针的登录产物留在内存里。
 * 若直接用真实凭据存储，一次只读探针就会往用户的 `.credentials.yaml` 里
 * 写入一条 `ACCIO_E2E_PROBE`（一个永远不会再被用到的幽灵账号）。
 */
class MemoryCredentials {
  private readonly store = new Map<string, string>()

  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'accio-e2e-memory' }
  }

  async describe(ref: string) {
    return { configured: this.store.has(ref), writable: true }
  }

  async set(ref: string, value: string) {
    this.store.set(ref, value)
  }

  async unset(ref: string) {
    this.store.delete(ref)
  }
}

/**
 * 从账号池读一份已登录的 Accio 凭据；读不到返回 `undefined`。
 *
 * ⚠️ **惰性调用**：`describe.skip` 的回调体仍会被执行（用于收集用例），
 * 故绝不能在模块级或 `describe` 回调体里直接读文件 —— 无凭据的机器上
 * 会变成「收集阶段抛错」而不是干净 skip（本仓库已有该教训）。
 */
let cachedStored: AccioCredential | undefined | null = null

function storedCredential(): AccioCredential | undefined {
  if (cachedStored === null) {
    try {
      const ref = enabledAccountRef(ACCIO.id)
      const parsed = credentialFor(ref) as unknown as AccioCredential
      cachedStored = typeof parsed.access_token === 'string' && parsed.access_token !== ''
        ? parsed
        : undefined
    } catch {
      // 账号池里没有启用的 accio 账号（或凭据缺失）：交给调用方决定是登录还是报错。
      cachedStored = undefined
    }
  }
  return cachedStored
}

/**
 * 取一份可用凭据：池里已有就直接用（**只读**）；
 * 没有则现场发起 PKCE 登录（**人工在浏览器授权**）。
 *
 * ⚠️ **结果必须缓存**：本文件有 5 条用例，不缓存就会**弹 5 次浏览器**
 * （用户得授权 5 遍），而且后面 4 次拿到的凭据还可能各不相同。
 */
let cachedResolved: AccioCredential | undefined | null = null

async function resolveProbeCredential(): Promise<AccioCredential> {
  if (cachedResolved !== null && cachedResolved !== undefined) return cachedResolved
  const stored = storedCredential()
  if (stored !== undefined) {
    cachedResolved = stored
    return stored
  }

  console.log('[accio-probe] 账号池里没有可用的 Accio 凭据，改为现场发起一次 PKCE 登录。')
  console.log('[accio-probe] ⚠️ 该次登录的产物只写进**内存**，不会落到任何存储。')
  const ctx = new Context()
  const credentials = new MemoryCredentials()
  ctx.provide('credentials', credentials as never)
  const auth = new AccioAuth(ctx)
  const started = await auth.startLogin({ refName: PROBE_REF })
  console.log('[accio-probe] 请在浏览器完成授权：')
  console.log(started.loginUrl)
  openBrowser(started.loginUrl)
  try {
    await started.result
  } finally {
    started.close()
    auth.stop()
  }
  const resolved = await credentials.resolve(PROBE_REF)
  expect(resolved, '登录回调已到达，但内存凭据提供者里没有凭据').toBeDefined()
  cachedResolved = JSON.parse(resolved!.value) as AccioCredential
  return cachedResolved
}

suite('Accio 只读探针（不发模型请求、不续期、不写任何存储）', () => {
  it('登录：池里已有凭据则直接用，否则现场 PKCE 登录（人工授权）', async () => {
    const fromPool = storedCredential() !== undefined
    const credential = await resolveProbeCredential()
    // 只打印**是否**有令牌，绝不打印令牌本体。
    console.log(`[accio-probe] 凭据来源=${fromPool ? '账号池' : '本次 PKCE 登录'}`
      + ` region=${String(credential.region)}`
      + ` refresh_token=${credential.refresh_token === '' ? '无' : '有'}`
      + ` expires_at=${new Date(credential.expires_at).toISOString()}`)
    expect(credential.access_token, 'access_token 必须非空').toBeTruthy()
  }, 660_000)

  it('模型目录：远端可见模型，倍率来自 effectiveMultiple 且按升序', async () => {
    const credential = await resolveProbeCredential()
    const response = await fetch(`${ACCIO.gatewayBaseUrl}${ACCIO_CATALOG_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: credential.access_token }),
      signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
    })
    expect(response.status, `HTTP ${response.status}`).toBe(200)
    const body = await response.json() as Record<string, unknown>
    // ⚠️ 判据一：HTTP 200 **不等于**成功 —— 信封 `success:false` 是失败。
    expect(body.success, `信封 success=${JSON.stringify(body.success)}（HTTP 200 但业务失败）`)
      .not.toBe(false)
    expect(body.data, '信封里没有 data（形状不认识 ⇒ 目录解析注定为空）').toBeDefined()

    const models = parseAccioCatalog(body)
    console.log(`[accio-probe] 远端可见模型 ${models.length} 个（兜底表 ${ACCIO.fallbackModels.length} 个）：`
      + models.map((m) => `${m.id}(x${String(m.multiple)})`).join(' / '))

    expect(models.length, '远端可见模型数量').toBeGreaterThanOrEqual(15)

    // ⚠️ 兜底表**不许腐坏**：离线回退表里的每个 id 都必须仍在远端目录里
    // （兜底表是实测得来的，上游下架模型必须被看见，而不是静默回退到一个死 id）。
    const remoteIds = new Set(models.map((m) => m.id))
    const missing = ACCIO.fallbackModels.filter((m) => !remoteIds.has(m.id)).map((m) => m.id)
    expect(missing, `⚠️ 兜底表里的模型已不在远端目录（兜底表需重新实测）：${missing.join(', ')}`)
      .toEqual([])

    // 倍率必须真的来自上游 `effectiveMultiple`（不是猜的），且按升序（便宜在前）。
    const multiples = models.map((m) => m.multiple).filter((v): v is number => v !== undefined)
    expect(multiples.length, '一个带倍率的模型都没有 ⇒ 倍率没被解析出来').toBeGreaterThan(0)
    expect(multiples).toEqual([...multiples].sort((a, b) => a - b))

    // ⚠️ 对话 / 工具探针「必须用最低倍率模型」这条硬规则的**前提**钉在这里：
    // 最便宜的那个必须就是兜底表首位（`ACCIO.fallbackModels[0]`）。
    const cheapest = ACCIO.fallbackModels[0]!
    expect(models[0]?.id, '最低倍率模型变了 ⇒ 另两个探针的选型前提失效').toBe(cheapest.id)
    expect(models[0]?.multiple).toBe(cheapest.multiple)
  }, 60_000)

  it('账号身份：POST /api/auth/userinfo（token 在 body）', async () => {
    const credential = await resolveProbeCredential()
    const info = await fetchAccioUserInfo(credential)
    expect(info, 'userinfo 查询失败（凭据可能已失效）').toBeDefined()
    console.log(`[accio-probe] 账号：userId=${info!.userId} userName=${info!.userName}`
      + ` routeRegion=${info!.routeRegion} userLevel=${info!.userLevel}`)
    expect(info!.userId, 'userId 为空').toBeTruthy()
    expect(info!.routeRegion, 'routeRegion 为空（区域由服务端按账号下发）').toBeTruthy()
    // ⚠️ **不能写 `expect(typeof info!.userLevel).toBe('string')`** —— `readString`
    // 对非字符串一律返回 `''`，所以那条断言恒真（它断言的是读取助手的返回类型，
    // 不是上游的事实），拦不住「上游改了字段名 ⇒ 等级静默丢失」。
    // 实测 `userLevel` 恒为 `freeMember`（见 `src/accio-credits.ts` 的
    // `AccioUserInfo.userLevel`），上游**没有**「某些账号不带等级」的已知形态 ⇒
    // 空串只可能意味着字段读不到（改名 / 被摘掉），必须被看见。
    // （若将来真跑出「某账号 legitimately 为空」，正确动作是删掉这条断言并说明，
    // 而不是把它退回成恒真的类型断言。）
    expect(info!.userLevel, 'userLevel 为空 ⇒ 上游字段改名/摘除（等级会静默丢失）').not.toBe('')
  }, 60_000)

  it('积分：订阅信封必须 success 且带 data（HTTP 200 不代表成功）', async () => {
    const credential = await resolveProbeCredential()
    // 直接读**原始信封**：`fetchAccioBalanceDetailed` 内部已经判过一遍，
    // 但本探针要的是原始证据 —— 只有原始信封能暴露「HTTP 200 + success:false」。
    const response = await fetch(
      `${ACCIO.gatewayBaseUrl}${ACCIO_SUBSCRIPTION_PATH}`
      + `?${new URLSearchParams({ accessToken: credential.access_token }).toString()}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      },
    )
    const text = await response.text()
    const envelope = JSON.parse(text) as {
      success?: unknown
      code?: unknown
      message?: unknown
      data?: unknown
    }
    console.log(`[accio-probe] currentSubscription：HTTP ${response.status}`
      + ` success=${JSON.stringify(envelope.success)} code=${JSON.stringify(envelope.code)}`
      + ` message=${JSON.stringify(envelope.message)}`)

    expect(response.status, `HTTP ${response.status}：${text.slice(0, 200)}`).toBe(200)
    // ⚠️ 两条判据缺一不可（见文件头）：信封没失败 **且** 拿到了 data **对象**。
    // ⚠️ 第二、三条必须分开写：`toBeDefined()` 对 `null` 是**通过**的，而
    // `typeof null === 'object'` 也成立 ⇒ 只写其中任一条，`data: null` 会被读成成功。
    expect(envelope.success, '⚠️ HTTP 200 但信封 success:false（正是要拦的形态）').not.toBe(false)
    expect(envelope.data, '信封里没有 data（形状不认识 ⇒ 目录解析注定为空）').toBeDefined()
    expect(envelope.data, 'data 是 null（不是对象）').not.toBeNull()
    expect(Array.isArray(envelope.data), 'data 是数组，不是对象').toBe(false)
    expect(typeof envelope.data).toBe('object')
  }, 60_000)

  it('积分：三类桶 + 重置倒计时（只读）', async () => {
    const credential = await resolveProbeCredential()
    const detail = await fetchAccioBalanceDetailed(credential)
    expect(detail.balance, `余额查询失败：${detail.error ?? '（无原因）'}`).not.toBeNull()
    const balance = detail.balance!
    expect(balance.total).toBeGreaterThanOrEqual(0)
    expect(balance.packages.length, '一个积分包都没有').toBeGreaterThan(0)

    // 展示名只允许三个已登记的值（未登记的桶会被原样展示 ⇒ 说明上游加了新桶）。
    const knownLabels = ['每日积分', '每月积分', '推荐积分']
    for (const pkg of balance.packages) {
      expect(knownLabels, `未登记的积分桶展示名：${pkg.name}`).toContain(pkg.name)
    }
    // ⚠️ 桶顺序固定 daily → monthly → referral：键序由服务端决定，按它排会「跳行」。
    if (balance.packages.some((p) => p.name === '每日积分')) {
      expect(balance.packages[0]!.name, '每日积分必须在首位（固定顺序）').toBe('每日积分')
    }

    const quota = await fetchAccioQuota(credential)
    expect(quota, 'quota 查询失败').toBeDefined()
    console.log(`[accio-probe] 积分 total=${balance.total} 包=${balance.packages
      .map((p) => `${p.name}:${p.remaining}/${p.total}`).join(' ')}`
      + ` 重置倒计时=${String(quota!.refreshCountdownSeconds)}s`
      + ` usagePercent=${String(quota!.usagePercent)}`)
    // 实测 `refreshCountdownSeconds` 是 86400（24h 周期）。读不到时不判死，
    // 但读到了就必须是正数 —— 否则「本周期至 …」那行会显示一个过去的时间。
    if (quota!.refreshCountdownSeconds !== undefined) {
      expect(quota!.refreshCountdownSeconds).toBeGreaterThan(0)
    }
  }, 60_000)

  /**
   * ⚠️ 本探针**绝不续期**（源码级守卫）。
   *
   * Accio 的续期会**轮换** `refresh_token`（参考实现记录，见 `accio-refresh-probe`）。
   * 只读探针一旦顺手续期，就会把用户账号的 `refresh_token` 消费掉。
   *
   * 判据取**续期函数的 import**：本文件需要 `accio-oauth.ts` 的
   * `openBrowser`（登录时开浏览器），所以「同一个 import 里出现了续期函数」
   * 正是这条守卫要拦的形态。⚠️ **必须同时做正例断言**（`openBrowser` 真的在
   * import 里），否则「import 语句没找到」会让这条守卫静默通过。
   */
  it('⚠️ 只读探针不得 import 续期函数（会轮换 refresh_token）', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const matched = /import \{([^}]*)\} from '\.\.\/\.\.\/src\/accio-oauth\.js'/.exec(source)
    expect(matched, '找不到 accio-oauth.js 的 import（片段取错 ⇒ 本守卫恒真）').not.toBeNull()
    expect(matched![1], '正例：登录要用的 openBrowser 必须在 import 里').toContain('openBrowser')
    expect(matched![1], '⚠️ 只读探针不得 import 续期函数').not.toContain('refresh')
  })
})
