/**
 * AStudio 积分弹窗 · **只读探针**（零构建，直接读本机会话，不碰 dsh web）
 *
 * ## 为什么需要它（2026-10-20 用户报障）
 *
 * 症状：AStudio 客户端里「限时每日福利 · 今日可领 100 积分」**还没领**，
 * 而插件里点「一键领取积分」显示**已领过**、分数不变（1100）。
 *
 * asar 取证（`resources/app.asar`）得到两个**待确认**的差异：
 * 1. **字段名**：客户端消费弹窗读的是 **`componentType`**
 *    （`Mc = { CLIENT_DOWNLOAD_REWARD_DIALOG:0, NEW_USER_DIALOG:1, DAILY_REWARD_DIALOG:2 }`），
 *    而我们的解析读的是 **`record.type`**（`src/astudio-credits.ts:369/393/419`）⇒
 *    若服务端只给 `componentType`，我们**一个可领弹窗都识别不出来** ⇒ 走
 *    `already-claimed` ⇒ 界面「今天已领取」而积分不动。
 * 2. **路径**：我们用 `/client-popups/pending`，客户端用
 *    `/api/astron-client-popups/pending`。
 *
 * ⇒ 本探针把两个候选路径**都试一遍**，打印 HTTP 状态、**键名树**与信封状态，
 *    从而定论是「字段名」「路径」还是别的问题。
 *
 * ## ⚠️ 只读承诺
 *
 * **只发 GET**，**绝不**调用 `complete` / `claim` ⇒ 不会消耗用户那 100 积分
 * （所以可以放心在「还没领」的状态下跑）。
 *
 * ## 用法
 *
 * ```powershell
 * $env:DSH_ASTUDIO_POPUPS_E2E='1'; $env:DSH_ASTUDIO_POPUPS_E2E_CONFIRM='yes'
 * pnpm vitest run --config vitest.e2e.config.ts tests/e2e/astudio-popups-probe.e2e.spec.ts
 * ```
 *
 * ⚠️ 只打印**结构**：`uid` / `token` / `instanceKey` 等一律只给类型与长度；
 *    只有**信封与弹窗类型字段**（`flag`/`code`/`desc`/`type`/`componentType`/
 *    `popupType`/`popupCode`/`priority`/`points`）直出值 —— 它们不含账号标识，
 *    而正是本次要看的字段。
 */
import { describe, expect, it } from 'vitest'
import { readAstudioDiskCredential } from '../../src/astudio-auth.js'
import { astudioCookieHeader, astudioControlHeaders } from '../../src/astudio.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import { ASTUDIO_CLIENT_POPUPS_PENDING_PATH } from '../../src/astudio-credits.js'

const GATE = process.env['DSH_ASTUDIO_POPUPS_E2E'] === '1'
  && process.env['DSH_ASTUDIO_POPUPS_E2E_CONFIRM'] === 'yes'

/** 可直出值的键（**不含账号标识**；正是本次要对照的字段）。 */
const SAFE_KEYS = new Set([
  'flag', 'code', 'desc', 'message', 'msg', 'status', 'count', 'success',
  'type', 'componentType', 'popupType', 'popupCode', 'priority', 'points',
])

/** 把任意 JSON 压成**结构描述**；`SAFE_KEYS` 上的标量直出值。 */
function shapeOf(value: unknown, depth = 0, key = ''): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) {
    return value.length === 0
      ? 'array(0)'
      : `array(${value.length})[${shapeOf(value[0], depth + 1, key)}]`
  }
  if (typeof value === 'object') {
    if (depth >= 4) return 'object(…)'
    const o = value as Record<string, unknown>
    return `{ ${Object.keys(o).map((k) => `${k}: ${shapeOf(o[k], depth + 1, k)}`).join(', ')} }`
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return SAFE_KEYS.has(key)
      ? `${typeof value}(${JSON.stringify(value)})`
      : `${typeof value}(len=${String(value).length})`
  }
  return typeof value
}

const describeProbe = GATE ? describe : describe.skip

describeProbe('AStudio 积分弹窗探针（**只读**：只发 GET）', () => {
  it('用本机会话逐一试候选路径，打印结构与信封状态', async () => {
    const credential = readAstudioDiskCredential()
    expect(credential, '本机读不到 AStudio 会话 —— 请先在 AStudio 客户端登录').toBeDefined()
    const cookie = astudioCookieHeader(credential!)
    console.log(`[探针] Cookie 键：${cookie.split('; ').map((s) => s.split('=')[0]).join(', ') || '(空)'}`)
    expect(cookie.length, 'Cookie 拼不出来（缺 sso_session_id / account_id / token？）').toBeGreaterThan(0)

    const base = ASTUDIO.authBaseUrl.replace(/\/+$/, '')
    const candidates = [
      { label: '我们现用', path: ASTUDIO_CLIENT_POPUPS_PENDING_PATH },
      { label: '客户端用', path: '/api/astron-client-popups/pending' },
      // ⚠️ 顺带查一次余额：确认**逐包到期字段**（`*NextExpireTime`）真的下发 ——
      //    那是「hover 能看到**没过期的**资源包」的前提：只有包名而没有到期时间的话，
      //    hover 只会显示「永久」，仍不满足用户诉求（故 `creditPackages` 那条声明
      //    必须配合「到期字段确实存在」才成立）。
      { label: '积分余额', path: '/points/balance' },
    ]

    for (const { label, path } of candidates) {
      const url = `${base}${path}`
      console.log(`\n========== [${label}] GET ${url} ==========`)
      try {
        const headers = {
          Accept: 'application/json',
          ...astudioControlHeaders(credential!, ASTUDIO),
        }
        console.log(`  请求头键：${Object.keys(headers).join(', ')}`
          + `  (clientType=${String((headers as Record<string, unknown>)['clientType'])}`
          + ` studioVersion=${String((headers as Record<string, unknown>)['studioVersion'])})`)
        const res = await fetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(20_000),
        })
        const text = await res.text()
        console.log(`  HTTP ${res.status}  响应长度 ${text.length}`)
        let body: unknown
        try {
          body = JSON.parse(text) as unknown
        } catch {
          console.log(`  ⚠️ 不是 JSON，前 200 字符：${text.slice(0, 200)}`)
          continue
        }
        console.log(`  键名树：${shapeOf(body)}`)
        const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
        console.log(`  信封：flag=${String(rec.flag)} code=${String(rec.code)} desc=${JSON.stringify(rec.desc)}`)
        const data = rec.data
        if (Array.isArray(data)) {
          console.log(`  data 是数组，长度 ${data.length}`)
          data.slice(0, 3).forEach((item, i) => {
            console.log(`    [${i}] ${shapeOf(item)}`)
          })
        } else {
          console.log(`  data 不是数组：${shapeOf(data)}`)
        }
      } catch (error) {
        console.log(`  ❌ 网络异常：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, 120_000)
})